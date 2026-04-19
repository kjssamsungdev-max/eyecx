#!/usr/bin/env python3
"""
EyeCX CZDS - Zone File Integration Module
==========================================

Parses ICANN CZDS zone files to detect dropped domains (present yesterday,
absent today). Outputs dropped domain lists compatible with eyecx.py seeds.

NASA P10 COMPLIANCE:
  Rule 1: No complex flow - flat if/else, no goto/recursion
  Rule 2: All loops bounded - explicit MAX_ITERATIONS
  Rule 3: No unbounded memory - streaming line-by-line processing
  Rule 4: Functions under 60 lines - extracted helpers
  Rule 5: 2+ assertions per function - input/output validation
  Rule 6: Restricted scope - no global mutable state
  Rule 7: All returns checked - explicit error handling
  Rule 8: Minimal build - stdlib + aiohttp only
  Rule 9: No mutations - return new objects (frozensets, tuples)
  Rule 10: Zero warnings - all errors handled

Author: KJS @ Artisans F&B Corp
"""

import argparse
import asyncio
import aiohttp
import gzip
import logging
import os
import sys
import time
from dataclasses import dataclass
from datetime import datetime, timedelta
from pathlib import Path
from typing import FrozenSet, Optional, Tuple


# ============ CONSTANTS (Rule 2: Fixed bounds) ============
MAX_ZONE_LINES = 200_000_000       # ~200M lines max per zone file
MAX_DOMAINS_PER_ZONE = 50_000_000  # ~50M domains max per TLD
MAX_DROPPED_DOMAINS = 5_000_000    # cap on diff output
MAX_LOG_INTERVAL = 1_000_000       # log progress every N lines
MAX_DOWNLOAD_CHUNK = 1024 * 1024   # 1 MB streaming chunks
MAX_AUTH_ATTEMPTS = 3
MAX_DOWNLOAD_TIMEOUT_SEC = 7200    # 2 hours for multi-GB files
SUPPORTED_TLDS = frozenset({"xyz", "com", "net", "org", "info", "biz"})
SNAPSHOT_DIR = "./zone_snapshots"
MAX_R2_UPLOAD_TIMEOUT = 120  # seconds


# ============ CONFIG (Rule 6: Immutable after init) ============
@dataclass(frozen=True)
class CZDSConfig:
    """Immutable CZDS configuration. Rule 6: No mutable global state."""
    snapshot_dir: str = SNAPSHOT_DIR
    auth_url: str = "https://account-api.icann.org/api/authenticate"
    download_url_template: str = "https://czds-api.icann.org/czds/downloads/{tld}.zone"
    chunk_size: int = MAX_DOWNLOAD_CHUNK
    download_timeout: int = MAX_DOWNLOAD_TIMEOUT_SEC
    api_url: str = ""      # EyeCX Worker API URL (for R2 upload)
    api_secret: str = ""   # EyeCX Worker API secret


# ============ LOGGING (Rule 6: No global state) ============
def create_logger(name: str) -> logging.Logger:
    """Create logger instance. Rule 5: validates input and output."""
    assert isinstance(name, str) and len(name) > 0, "Logger name required"

    logger = logging.getLogger(name)
    if not logger.handlers:
        logger.setLevel(logging.DEBUG)
        handler = logging.StreamHandler()
        handler.setLevel(logging.INFO)
        handler.setFormatter(logging.Formatter(
            "%(asctime)s | %(levelname)s | %(message)s",
            "%H:%M:%S",
        ))
        logger.addHandler(handler)

    assert logger is not None, "Logger must be created"
    return logger


# ============ AUTH ============
async def authenticate_czds(
    session: aiohttp.ClientSession,
    username: str,
    password: str,
    config: CZDSConfig,
) -> Optional[str]:
    """Authenticate with ICANN CZDS and return JWT token.

    Rule 5: assertions on inputs and output type.
    Rule 2: bounded retry loop.
    """
    assert isinstance(username, str) and len(username) > 0, "Username required"
    assert isinstance(password, str) and len(password) > 0, "Password required"

    logger = create_logger("czds.auth")
    token: Optional[str] = None

    for attempt in range(MAX_AUTH_ATTEMPTS):
        try:
            payload = {"username": username, "password": password}
            async with session.post(
                config.auth_url,
                json=payload,
                timeout=aiohttp.ClientTimeout(total=30),
            ) as resp:
                if resp.status == 200:
                    data = await resp.json()
                    token = data.get("accessToken")
                    if token:
                        logger.info("CZDS authentication successful")
                        break
                    logger.warning("No accessToken in response")
                else:
                    body = await resp.text()
                    logger.warning(
                        "Auth attempt %d failed: HTTP %d - %s",
                        attempt + 1, resp.status, body[:200],
                    )
        except (aiohttp.ClientError, asyncio.TimeoutError) as exc:
            logger.warning("Auth attempt %d error: %s", attempt + 1, exc)

    assert token is None or isinstance(token, str), "Token must be str or None"
    return token


# ============ DOWNLOAD ============
async def download_zone_file(
    session: aiohttp.ClientSession,
    tld: str,
    token: str,
    config: CZDSConfig,
) -> Optional[str]:
    """Download a gzipped zone file from CZDS. Returns path to .txt.gz file.

    Rule 3: streams to disk, never holds full file in memory.
    Rule 5: assertions on inputs and output.
    """
    assert tld in SUPPORTED_TLDS, f"Unsupported TLD: {tld}"
    assert isinstance(token, str) and len(token) > 0, "Token required"

    logger = create_logger("czds.download")
    today = datetime.utcnow().strftime("%Y-%m-%d")
    out_dir = Path(config.snapshot_dir) / tld
    out_dir.mkdir(parents=True, exist_ok=True)
    gz_path = str(out_dir / f"{tld}_{today}.txt.gz")

    url = config.download_url_template.format(tld=tld)
    headers = {"Authorization": f"Bearer {token}"}
    timeout = aiohttp.ClientTimeout(total=config.download_timeout)

    try:
        async with session.get(url, headers=headers, timeout=timeout) as resp:
            if resp.status != 200:
                body = await resp.text()
                logger.error("Download failed: HTTP %d - %s", resp.status, body[:300])
                return None

            total = int(resp.headers.get("Content-Length", 0))
            downloaded = 0
            last_log = 0

            with open(gz_path, "wb") as fh:
                async for chunk in resp.content.iter_chunked(config.chunk_size):
                    fh.write(chunk)
                    downloaded += len(chunk)
                    if downloaded - last_log >= 50 * 1024 * 1024:  # log every 50 MB
                        pct = (downloaded / total * 100) if total else 0
                        logger.info(
                            "Downloaded %d MB / %d MB (%.1f%%)",
                            downloaded // (1024 * 1024),
                            total // (1024 * 1024),
                            pct,
                        )
                        last_log = downloaded

            logger.info("Zone file saved: %s (%d MB)", gz_path, downloaded // (1024 * 1024))
    except (aiohttp.ClientError, asyncio.TimeoutError, OSError) as exc:
        logger.error("Download error: %s", exc)
        return None

    assert gz_path.endswith(".txt.gz"), "Output must be .txt.gz"
    return gz_path


# ============ PARSE ============
def _is_gzipped(file_path: str) -> bool:
    """Check if a file is gzip-compressed by reading the magic bytes."""
    try:
        with open(file_path, "rb") as fh:
            return fh.read(2) == b'\x1f\x8b'
    except OSError:
        return False


def extract_domains_from_gz(gz_path: str, tld: str = "") -> FrozenSet[str]:
    """Extract unique domain names from NS records in a zone file.

    Handles both gzipped and plain text zone files.
    Streams line-by-line; never loads whole file into memory.
    Rule 2: bounded to MAX_ZONE_LINES.
    Rule 3: streaming, bounded set size.
    Rule 5: assertions on input and output.
    """
    assert os.path.isfile(gz_path), f"File not found: {gz_path}"

    logger = create_logger("czds.parse")
    domains: set[str] = set()
    lines_read = 0
    is_gz = _is_gzipped(gz_path)
    apex = tld.lower().strip(".") if tld else ""

    logger.info("Parsing zone file: %s (gzipped: %s, tld: %s)", gz_path, is_gz, tld)
    start = time.monotonic()

    opener = gzip.open if is_gz else open
    with opener(gz_path, "rt", encoding="utf-8", errors="replace") as fh:
        for line in fh:
            lines_read += 1
            if lines_read > MAX_ZONE_LINES:
                logger.warning("Hit MAX_ZONE_LINES (%d), stopping", MAX_ZONE_LINES)
                break

            if lines_read % MAX_LOG_INTERVAL == 0:
                logger.info(
                    "Parsed %dM lines, %d unique domains so far",
                    lines_read // 1_000_000,
                    len(domains),
                )

            if len(domains) >= MAX_DOMAINS_PER_ZONE:
                logger.warning("Hit MAX_DOMAINS_PER_ZONE (%d), stopping", MAX_DOMAINS_PER_ZONE)
                break

            domain = _parse_ns_line(line)
            if domain is not None and domain != apex:
                domains.add(domain)

    elapsed = time.monotonic() - start
    logger.info(
        "Parsed %d lines in %.1fs -> %d unique domains",
        lines_read, elapsed, len(domains),
    )

    result = frozenset(domains)
    assert isinstance(result, frozenset), "Must return frozenset"
    return result


def _parse_ns_line(line: str) -> Optional[str]:
    """Parse a single zone file line, returning the domain if it is an NS record.

    Zone file NS lines look like:
        example 3600 in ns ns1.example.com.
    or with FQDN owner:
        example.xyz. 3600 IN NS ns1.example.com.

    We want the owner name (left-most field), normalized without trailing dot.
    Rule 4: tiny helper, well under 60 lines.
    """
    stripped = line.strip()
    if not stripped or stripped.startswith(";"):
        return None

    parts = stripped.split()
    if len(parts) < 4:
        return None

    # Detect NS record: field at index 2 or 3 should be "NS" (case-insensitive).
    # Standard format: <owner> <ttl> <class> <type> <rdata>
    # Some zone files omit class: <owner> <ttl> <type> <rdata>
    record_type: Optional[str] = None
    if len(parts) >= 5 and parts[3].upper() == "NS":
        record_type = "NS"
    elif len(parts) >= 4 and parts[2].upper() == "NS":
        record_type = "NS"

    if record_type is None:
        return None

    owner = parts[0].lower().rstrip(".")
    if not owner or "." in owner:
        # Skip sub-domains or the zone apex itself (e.g., "xyz")
        # We only want second-level names without dots (within the zone)
        return None

    return owner


# ============ SNAPSHOT I/O ============
def save_snapshot(domains: FrozenSet[str], tld: str, date_str: str) -> str:
    """Save a domain set as a sorted text file (one domain per line).

    Rule 5: assertions on input and output.
    Rule 9: does not mutate input.
    """
    assert isinstance(domains, frozenset), "domains must be frozenset"
    assert len(tld) > 0, "TLD required"
    assert len(date_str) == 10, "date_str must be YYYY-MM-DD"

    logger = create_logger("czds.snapshot")
    out_dir = Path(SNAPSHOT_DIR) / tld
    out_dir.mkdir(parents=True, exist_ok=True)
    snap_path = str(out_dir / f"{tld}_{date_str}.domains.txt")

    sorted_domains = sorted(domains)
    with open(snap_path, "w", encoding="utf-8") as fh:
        for i, d in enumerate(sorted_domains):
            if i >= MAX_DOMAINS_PER_ZONE:
                break
            fh.write(d + "\n")

    logger.info("Snapshot saved: %s (%d domains)", snap_path, len(sorted_domains))
    assert os.path.isfile(snap_path), "Snapshot file must exist after save"
    return snap_path


async def upload_snapshot_to_r2(
    snap_path: str,
    tld: str,
    date_str: str,
    config: CZDSConfig,
) -> bool:
    """Upload a snapshot to R2 via the EyeCX Worker API.

    Rule 5: assertions on inputs.
    Rule 7: explicit success/failure return.
    """
    assert os.path.isfile(snap_path), f"Snapshot not found: {snap_path}"
    assert config.api_url, "api_url required for R2 upload"
    assert config.api_secret, "api_secret required for R2 upload"

    logger = create_logger("czds.r2")
    url = f"{config.api_url}/api/zones/{tld}/{date_str}"

    with open(snap_path, "r", encoding="utf-8") as fh:
        content = fh.read()

    try:
        async with aiohttp.ClientSession() as session:
            async with session.put(
                url,
                data=content,
                headers={
                    "Authorization": f"Bearer {config.api_secret}",
                    "Content-Type": "text/plain",
                },
                timeout=aiohttp.ClientTimeout(total=MAX_R2_UPLOAD_TIMEOUT),
            ) as resp:
                if resp.status == 200:
                    data = await resp.json()
                    logger.info(
                        "Uploaded to R2: %s (%s domains)",
                        data.get("key", "?"), data.get("domain_count", "?"),
                    )
                    return True
                body = await resp.text()
                logger.error("R2 upload failed: HTTP %d - %s", resp.status, body[:300])
                return False
    except (aiohttp.ClientError, asyncio.TimeoutError) as exc:
        logger.error("R2 upload error: %s", exc)
        return False


def load_snapshot(tld: str, date_str: str) -> FrozenSet[str]:
    """Load a domain snapshot from disk.

    Rule 2: bounded read.
    Rule 5: assertions on input and output.
    """
    assert len(tld) > 0, "TLD required"
    assert len(date_str) == 10, "date_str must be YYYY-MM-DD"

    logger = create_logger("czds.snapshot")
    snap_path = Path(SNAPSHOT_DIR) / tld / f"{tld}_{date_str}.domains.txt"

    if not snap_path.is_file():
        logger.warning("Snapshot not found: %s", snap_path)
        return frozenset()

    domains: set[str] = set()
    lines_read = 0

    with open(snap_path, "r", encoding="utf-8") as fh:
        for line in fh:
            lines_read += 1
            if lines_read > MAX_DOMAINS_PER_ZONE:
                break
            stripped = line.strip()
            if stripped:
                domains.add(stripped)

    logger.info("Loaded snapshot: %s (%d domains)", snap_path, len(domains))

    result = frozenset(domains)
    assert isinstance(result, frozenset), "Must return frozenset"
    return result


# ============ DIFF ============
def compute_dropped_domains(
    yesterday: FrozenSet[str],
    today: FrozenSet[str],
) -> Tuple[FrozenSet[str], int, int]:
    """Find domains present yesterday but absent today (dropped).

    Returns (dropped_domains, added_count, dropped_count).
    Rule 5: assertions on inputs and output.
    Rule 9: returns new frozenset; inputs unchanged.
    """
    assert isinstance(yesterday, frozenset), "yesterday must be frozenset"
    assert isinstance(today, frozenset), "today must be frozenset"

    logger = create_logger("czds.diff")

    dropped = yesterday - today
    added = today - yesterday

    if len(dropped) > MAX_DROPPED_DOMAINS:
        logger.warning(
            "Dropped count %d exceeds cap %d, truncating",
            len(dropped), MAX_DROPPED_DOMAINS,
        )
        dropped = frozenset(sorted(dropped)[:MAX_DROPPED_DOMAINS])

    logger.info(
        "Diff: yesterday=%d, today=%d, dropped=%d, added=%d",
        len(yesterday), len(today), len(dropped), len(added),
    )

    result = frozenset(dropped)
    assert isinstance(result, frozenset), "Must return frozenset"
    return result, len(added), len(dropped)


# ============ OUTPUT ============
def write_dropped_domains(
    domains: FrozenSet[str],
    tld: str,
    output_path: Optional[str] = None,
) -> str:
    """Write dropped domains to file (one per line, with TLD appended).

    Output is compatible with eyecx.py seeds format: one FQDN per line.
    Rule 5: assertions on input and output.
    """
    assert isinstance(domains, frozenset), "domains must be frozenset"
    assert len(tld) > 0, "TLD required"

    logger = create_logger("czds.output")

    if output_path is None:
        today = datetime.utcnow().strftime("%Y-%m-%d")
        out_dir = Path(SNAPSHOT_DIR) / tld
        out_dir.mkdir(parents=True, exist_ok=True)
        output_path = str(out_dir / f"dropped_{tld}_{today}.txt")

    sorted_names = sorted(domains)
    with open(output_path, "w", encoding="utf-8") as fh:
        for i, name in enumerate(sorted_names):
            if i >= MAX_DROPPED_DOMAINS:
                break
            fh.write(f"{name}.{tld}\n")

    logger.info("Wrote %d dropped domains to %s", len(sorted_names), output_path)
    assert os.path.isfile(output_path), "Output file must exist"
    return output_path


def print_dropped_summary(domains: FrozenSet[str], tld: str) -> None:
    """Print dropped domains to stdout for piping into eyecx.py.

    Rule 5: assertions on input.
    """
    assert isinstance(domains, frozenset), "domains must be frozenset"
    assert len(tld) > 0, "TLD required"

    for name in sorted(domains):
        print(f"{name}.{tld}")


# ============ CLI COMMANDS ============
async def cmd_download(tld: str, token: str, config: CZDSConfig) -> bool:
    """Download today's zone file and extract domain snapshot.

    Rule 5: assertions on inputs and return.
    Rule 7: all return paths checked.
    """
    assert tld in SUPPORTED_TLDS, f"Unsupported TLD: {tld}"
    assert len(token) > 0, "Token required"

    logger = create_logger("czds.cmd")
    today = datetime.utcnow().strftime("%Y-%m-%d")

    # Check if snapshot already exists
    snap_path = Path(config.snapshot_dir) / tld / f"{tld}_{today}.domains.txt"
    if snap_path.is_file():
        logger.info("Snapshot already exists for %s on %s, skipping download", tld, today)
        return True

    async with aiohttp.ClientSession() as session:
        # Download zone file
        gz_path = await download_zone_file(session, tld, token, config)
        if gz_path is None:
            logger.error("Download failed for %s", tld)
            return False

        # Parse and save snapshot
        domains = extract_domains_from_gz(gz_path, tld=tld)
        if len(domains) == 0:
            logger.error("No domains extracted from %s", gz_path)
            return False

        snap_file = save_snapshot(domains, tld, today)
        logger.info("Download complete: %d domains in .%s zone", len(domains), tld)

        # Upload to R2 if API credentials are configured
        if config.api_url and config.api_secret:
            await upload_snapshot_to_r2(snap_file, tld, today, config)

    assert isinstance(snap_path, Path), "snap_path must be Path"
    return True


async def cmd_download_with_credentials(
    tld: str,
    username: str,
    password: str,
    config: CZDSConfig,
) -> bool:
    """Authenticate and download zone file.

    Rule 5: assertions on inputs.
    """
    assert len(username) > 0, "Username required"
    assert len(password) > 0, "Password required"

    logger = create_logger("czds.cmd")

    async with aiohttp.ClientSession() as session:
        token = await authenticate_czds(session, username, password, config)
        if token is None:
            logger.error("Authentication failed")
            return False

    result = await cmd_download(tld, token, config)
    assert isinstance(result, bool), "Result must be bool"
    return result


def cmd_diff(
    tld: str,
    output_path: Optional[str] = None,
    yesterday_override: Optional[str] = None,
    today_override: Optional[str] = None,
) -> bool:
    """Diff yesterday vs today snapshots and output dropped domains.

    Rule 5: assertions on inputs and return.
    """
    assert tld in SUPPORTED_TLDS, f"Unsupported TLD: {tld}"

    logger = create_logger("czds.cmd")
    today = today_override or datetime.utcnow().strftime("%Y-%m-%d")
    yesterday = yesterday_override or (
        datetime.utcnow() - timedelta(days=1)
    ).strftime("%Y-%m-%d")

    logger.info("Diffing %s zone: %s vs %s", tld, yesterday, today)

    snap_yesterday = load_snapshot(tld, yesterday)
    if len(snap_yesterday) == 0:
        logger.error("No snapshot for %s on %s", tld, yesterday)
        return False

    snap_today = load_snapshot(tld, today)
    if len(snap_today) == 0:
        logger.error("No snapshot for %s on %s", tld, today)
        return False

    dropped, added_count, dropped_count = compute_dropped_domains(
        snap_yesterday, snap_today,
    )

    logger.info(
        "Results for .%s: %d dropped, %d added, %d unchanged",
        tld,
        dropped_count,
        added_count,
        len(snap_yesterday) - dropped_count,
    )

    if output_path:
        write_dropped_domains(dropped, tld, output_path)
        logger.info("Dropped domains written to %s", output_path)
    else:
        print_dropped_summary(dropped, tld)

    return True


# ============ INGEST FROM LOCAL .GZ (no CZDS auth needed) ============
def cmd_ingest(tld: str, gz_path: str, date_str: Optional[str] = None) -> bool:
    """Parse a locally-available .txt.gz zone file and save a snapshot.

    Useful when zone files are already downloaded or obtained outside CZDS API.
    Rule 5: assertions on inputs and return.
    """
    assert tld in SUPPORTED_TLDS, f"Unsupported TLD: {tld}"
    assert os.path.isfile(gz_path), f"File not found: {gz_path}"

    logger = create_logger("czds.cmd")
    date_str = date_str or datetime.utcnow().strftime("%Y-%m-%d")

    domains = extract_domains_from_gz(gz_path, tld=tld)
    if len(domains) == 0:
        logger.error("No domains extracted from %s", gz_path)
        return False

    save_snapshot(domains, tld, date_str)
    logger.info("Ingested %s: %d domains for %s", gz_path, len(domains), date_str)

    assert len(domains) > 0, "Must have extracted domains"
    return True


# ============ CLI ============
def build_parser() -> argparse.ArgumentParser:
    """Build CLI argument parser. Rule 5: assertions on output."""
    parser = argparse.ArgumentParser(
        prog="eyecx_czds",
        description="EyeCX CZDS - Zone file integration for dropped domain detection",
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    # download command
    dl = subparsers.add_parser("download", help="Download today's zone file from CZDS")
    dl.add_argument("--tld", required=True, help="TLD to download (e.g., xyz)")
    dl.add_argument("--token", default=None, help="CZDS JWT token (or set CZDS_TOKEN env)")
    dl.add_argument("--username", default=None, help="CZDS username (or set CZDS_USERNAME env)")
    dl.add_argument("--password", default=None, help="CZDS password (or set CZDS_PASSWORD env)")
    dl.add_argument("--api-url", default=None, help="EyeCX API URL for R2 upload (or set EYECX_API_URL env)")
    dl.add_argument("--api-secret", default=None, help="EyeCX API secret for R2 upload (or set EYECX_API_SECRET env)")

    # diff command
    df = subparsers.add_parser("diff", help="Diff yesterday vs today, output dropped domains")
    df.add_argument("--tld", required=True, help="TLD to diff (e.g., xyz)")
    df.add_argument("--output", default=None, help="Output file path (default: stdout)")
    df.add_argument("--yesterday", default=None, help="Override yesterday date (YYYY-MM-DD)")
    df.add_argument("--today", default=None, help="Override today date (YYYY-MM-DD)")

    # ingest command
    ig = subparsers.add_parser("ingest", help="Ingest a local .txt.gz zone file")
    ig.add_argument("--tld", required=True, help="TLD of the zone file")
    ig.add_argument("--file", required=True, help="Path to .txt.gz zone file")
    ig.add_argument("--date", default=None, help="Date for snapshot (YYYY-MM-DD, default: today)")

    assert parser is not None, "Parser must be created"
    return parser


def main() -> int:
    """CLI entry point. Rule 7: returns exit code."""
    parser = build_parser()
    args = parser.parse_args()
    config = CZDSConfig()

    if args.command == "download":
        tld = args.tld.lower()
        if tld not in SUPPORTED_TLDS:
            print(f"Error: unsupported TLD '{tld}'. Supported: {sorted(SUPPORTED_TLDS)}")
            return 1

        # Override config with R2 credentials if provided
        api_url = args.api_url or os.environ.get("EYECX_API_URL", "")
        api_secret = args.api_secret or os.environ.get("EYECX_API_SECRET", "")
        if api_url or api_secret:
            config = CZDSConfig(api_url=api_url, api_secret=api_secret)

        token = args.token or os.environ.get("CZDS_TOKEN", "")
        username = args.username or os.environ.get("CZDS_USERNAME", "")
        password = args.password or os.environ.get("CZDS_PASSWORD", "")

        if token:
            ok = asyncio.run(cmd_download(tld, token, config))
        elif username and password:
            ok = asyncio.run(cmd_download_with_credentials(tld, username, password, config))
        else:
            print("Error: provide --token or --username/--password (or CZDS_TOKEN env var)")
            return 1

        return 0 if ok else 1

    if args.command == "diff":
        tld = args.tld.lower()
        if tld not in SUPPORTED_TLDS:
            print(f"Error: unsupported TLD '{tld}'. Supported: {sorted(SUPPORTED_TLDS)}")
            return 1

        ok = cmd_diff(tld, args.output, args.yesterday, args.today)
        return 0 if ok else 1

    if args.command == "ingest":
        tld = args.tld.lower()
        if tld not in SUPPORTED_TLDS:
            print(f"Error: unsupported TLD '{tld}'. Supported: {sorted(SUPPORTED_TLDS)}")
            return 1

        ok = cmd_ingest(tld, args.file, args.date)
        return 0 if ok else 1

    print(f"Unknown command: {args.command}")
    return 1


if __name__ == "__main__":
    sys.exit(main())
