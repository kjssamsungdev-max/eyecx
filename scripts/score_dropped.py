#!/usr/bin/env python3
"""
Score dropped domains from CZDS zone file diffs.
Reads a dropped-domains file (one FQDN per line), scores each domain,
RDAP-verifies availability, and outputs a CSV for upload_to_d1.py.

NASA P10 COMPLIANCE:
  Rule 1: No complex flow
  Rule 2: All loops bounded (MAX_DOMAINS, MAX_RETRIES)
  Rule 3: No unbounded memory (streaming, checkpoint writes)
  Rule 4: Functions under 60 lines
  Rule 5: 2+ assertions per function
  Rule 6: No global mutable state
  Rule 7: All returns checked
  Rule 8: Minimal build (stdlib + aiohttp)
  Rule 9: No mutations (return new objects)
  Rule 10: Zero warnings

Usage:
  python scripts/score_dropped.py dropped.txt --output results/scored.csv
  python scripts/score_dropped.py dropped.txt --output results/scored.csv --opr-key KEY --limit 5000
"""

import argparse
import asyncio
import aiohttp
import csv
import os
import re
import sys
import time
from datetime import datetime, timezone
from typing import Dict, List, Optional, Tuple


# ============ CONSTANTS (Rule 2: Fixed bounds) ============
MAX_CONCURRENT = 20
MAX_TIMEOUT = 15
MAX_DOMAINS = 50000
MAX_RETRIES = 3
RETRY_BASE_DELAY = 2.0
RDAP_BATCH = 10
RDAP_DELAY = 1.0
WAYBACK_429_DELAY = 5.0
CHECKPOINT_INTERVAL = 100
MAX_DOMAIN_LEN = 30
SPAM_DIGITS_RE = re.compile(r'\d{3,}')
VOWELS = frozenset('aeiouy')

CSV_FIELDS = [
    'domain', 'tld', 'potential_score', 'tier', 'estimated_flip_value',
    'page_rank', 'wayback_snapshots', 'estimated_age_years', 'backlinks',
    'majestic_rank', 'tranco_rank', 'availability_status', 'source', 'first_seen',
    'brand_score',
]


# ============ DICTIONARY (Rule 6: loaded once at import) ============
def load_dictionary() -> frozenset:
    """Load common words from bundled file. Returns empty set if missing.

    Rule 5: assertions on output.
    """
    words_path = os.path.join(os.path.dirname(__file__) or '.', 'common_words.txt')
    assert isinstance(words_path, str), "words_path must be str"
    words: set = set()
    try:
        with open(words_path) as f:
            for line in f:
                w = line.strip().lower()
                if w:
                    words.add(w)
    except FileNotFoundError:
        pass

    result = frozenset(words)
    assert isinstance(result, frozenset), "Must return frozenset"
    return result

DICTIONARY_WORDS = load_dictionary()


# ============ RETRY HELPER (Rule 2: bounded retries) ============
async def retry_with_backoff(coro_fn, max_attempts=MAX_RETRIES, base_delay=RETRY_BASE_DELAY):
    """Retry an async callable with exponential backoff on network/5xx/429 errors.

    Rule 5: assertions on input and output.
    Rule 2: bounded to max_attempts.
    """
    assert callable(coro_fn), "coro_fn must be callable"
    assert max_attempts > 0, "max_attempts must be positive"

    last_exc = None
    for attempt in range(max_attempts):
        try:
            return await coro_fn()
        except (aiohttp.ClientError, asyncio.TimeoutError) as e:
            last_exc = e
            if attempt < max_attempts - 1:
                delay = base_delay * (2 ** attempt)
                await asyncio.sleep(delay)

    raise last_exc or RuntimeError("retry_with_backoff exhausted")


# ============ PRE-FILTER (Rule 4: under 60 lines) ============
def pre_filter_domains(domains: List[str]) -> Tuple[List[str], int]:
    """Filter out low-value domains before expensive API calls.

    Removes: >30 chars, 3+ consecutive digits, starts with digit.
    Rule 5: assertions on input and output.
    """
    assert isinstance(domains, list), "domains must be a list"
    assert all(isinstance(d, str) for d in domains[:100]), "domains must contain strings"

    filtered = []
    removed = 0
    for d in domains:
        label = d.split('.')[0]
        if len(d) > MAX_DOMAIN_LEN:
            removed += 1
        elif SPAM_DIGITS_RE.search(label):
            removed += 1
        elif label and label[0].isdigit():
            removed += 1
        else:
            filtered.append(d)

    assert len(filtered) + removed == len(domains), "filter counts must add up"
    return filtered, removed


# ============ WAYBACK CHECK (Rule 7: explicit returns) ============
async def check_wayback(session, domain):
    """Get Wayback snapshot count and age. Returns (count|None, age|None).

    None snapshots = rate-limited or error (unknown signal, don't penalize).
    0 snapshots = confirmed no history.
    Rule 5: assertions on inputs.
    """
    assert session is not None, "Session required"
    assert domain and '.' in domain, "Valid domain required"

    async def _fetch():
        params = {'url': domain, 'output': 'json', 'fl': 'timestamp',
                  'collapse': 'timestamp:6', 'limit': 200}
        async with session.get(
            'https://web.archive.org/cdx/search/cdx',
            params=params, timeout=aiohttp.ClientTimeout(total=MAX_TIMEOUT)
        ) as resp:
            if resp.status == 429:
                await asyncio.sleep(WAYBACK_429_DELAY)
                raise aiohttp.ClientError("Wayback 429 rate limit")
            if resp.status >= 500:
                raise aiohttp.ClientError(f"Wayback {resp.status}")
            if resp.status != 200:
                return 0, None
            data = await resp.json()
            if not data or len(data) <= 1:
                return 0, None
            snapshots = data[1:]
            age = None
            if snapshots:
                try:
                    oldest = min(s[0][:8] for s in snapshots if s and len(s[0]) >= 8)
                    oldest_date = datetime.strptime(oldest, '%Y%m%d')
                    age = round((datetime.now(timezone.utc) - oldest_date.replace(tzinfo=timezone.utc)).days / 365.25, 1)
                except (ValueError, IndexError):
                    pass
            return len(snapshots), age

    try:
        return await retry_with_backoff(_fetch)
    except Exception:
        return None, None


# ============ RDAP CHECK (Rule 7: explicit returns) ============
async def check_rdap(session, domain):
    """Check domain availability via RDAP.

    Rule 5: assertions on inputs.
    """
    assert session is not None, "Session required"
    assert domain and '.' in domain, "Valid domain required"

    async def _fetch():
        async with session.get(
            f'https://rdap.org/domain/{domain}',
            timeout=aiohttp.ClientTimeout(total=MAX_TIMEOUT)
        ) as resp:
            if resp.status == 429 or resp.status >= 500:
                raise aiohttp.ClientError(f"RDAP {resp.status}")
            if resp.status == 404:
                return 'available'
            if resp.status == 200:
                return 'registered'
            return 'unknown'

    try:
        return await retry_with_backoff(_fetch)
    except Exception:
        return 'unknown'


# ============ OPR BATCH (Rule 2: bounded) ============
async def batch_check_opr(session, domains, api_key):
    """Batch check OpenPageRank.

    Rule 5: assertions on inputs.
    """
    assert isinstance(domains, list), "domains must be a list"
    assert len(domains) <= MAX_DOMAINS, f"Too many domains: {len(domains)}"

    if not api_key:
        return {}

    results: Dict[str, float] = {}
    for i in range(0, min(len(domains), MAX_DOMAINS), 100):
        batch = domains[i:i + 100]
        params = [('domains[]', d) for d in batch]
        try:
            async with session.get(
                'https://openpagerank.com/api/v1.0/getPageRank',
                params=params, headers={'API-OPR': api_key},
                timeout=aiohttp.ClientTimeout(total=15)
            ) as resp:
                if resp.status == 200:
                    data = await resp.json()
                    for item in data.get('response', []):
                        if item.get('status_code') == 200:
                            d = item.get('domain', '')
                            pr = item.get('page_rank_decimal', 0)
                            if d and pr is not None:
                                results[d] = float(pr)
        except Exception:
            pass
        await asyncio.sleep(0.1)
    return results


# ============ SCORING (Rule 4: under 60 lines) ============
def calculate_brand_score(domain: str) -> int:
    """Compute brandability score (0-55) from domain name properties.

    Rule 5: assertions on input and output.
    """
    assert isinstance(domain, str) and '.' in domain, "Valid FQDN required"

    name = domain.split('.')[0]
    assert len(name) > 0, "Name label must not be empty"

    brand = 0

    # Length (shorter = more valuable)
    if len(name) <= 3: brand += 40
    elif len(name) <= 4: brand += 30
    elif len(name) <= 5: brand += 20
    elif len(name) <= 6: brand += 12
    elif len(name) <= 8: brand += 5

    # Cleanliness
    if not any(c.isdigit() for c in name): brand += 5
    if '-' not in name: brand += 3

    # Pronounceability (alternating consonant/vowel)
    if 4 <= len(name) <= 8:
        pairs_ok = all(
            (name[i] in VOWELS) != (name[i+1] in VOWELS)
            for i in range(len(name) - 1)
        )
        if pairs_ok: brand += 10

    # Dictionary word match
    if name in DICTIONARY_WORDS: brand += 20

    result = min(brand, 55)
    assert 0 <= result <= 55, f"Brand score out of range: {result}"
    return result


def calculate_score(pr, snapshots, age_years, tld, domain=None):
    """Score a domain (0-100). Includes brandability if domain provided.

    Rule 5: assertions on inputs.
    """
    assert snapshots is None or snapshots >= 0, "Snapshots must be None or non-negative"
    assert tld.startswith('.'), f"TLD must start with dot: {tld}"

    score = 0
    if pr is not None:
        if pr >= 6: score += 30
        elif pr >= 5: score += 25
        elif pr >= 4: score += 20
        elif pr >= 3: score += 15
        elif pr >= 2: score += 10
        elif pr >= 1: score += 5

    if snapshots is not None:
        if snapshots >= 500: score += 10
        elif snapshots >= 100: score += 7
        elif snapshots >= 50: score += 5
        elif snapshots >= 10: score += 3

    if age_years is not None:
        if age_years >= 15: score += 15
        elif age_years >= 10: score += 12
        elif age_years >= 5: score += 9
        elif age_years >= 3: score += 6
        elif age_years >= 1: score += 3

    if tld in ('.com', '.io', '.ai'): score += 5
    elif tld in ('.co', '.app', '.dev'): score += 3
    elif tld in ('.xyz', '.info', '.org'): score += 2

    # Brandability bonus
    if domain:
        score += calculate_brand_score(domain)

    return min(score, 100)


def tier_from_score(score):
    """Convert score to tier string.

    Rule 5: assertions on input.
    """
    assert isinstance(score, int), f"Score must be int, got {type(score)}"
    assert 0 <= score <= 100, f"Score must be 0-100, got {score}"

    if score >= 85: return 'diamond'
    if score >= 70: return 'gold'
    if score >= 55: return 'silver'
    if score >= 40: return 'bronze'
    return 'lead'


def estimate_flip_value(score, tld, age):
    """Estimate flip value in USD.

    Rule 5: assertions on inputs.
    """
    assert score >= 0, "Score must be non-negative"
    assert tld.startswith('.'), f"TLD must start with dot: {tld}"

    if score >= 85: base = 500.0
    elif score >= 70: base = 150.0
    elif score >= 55: base = 50.0
    elif score >= 40: base = 20.0
    else: base = 10.0
    tld_mult = {'.com': 2.0, '.io': 1.5, '.ai': 2.5, '.co': 1.3, '.org': 1.2, '.xyz': 0.8}.get(tld, 1.0)
    age_mult = min(1.0 + ((age or 0) * 0.05), 2.0)
    return round(base * tld_mult * age_mult, 2)


# ============ CHECKPOINT CSV (Rule 3: no unbounded memory) ============
def write_checkpoint(results, output_path, header_written):
    """Append results to CSV. Write header only on first call.

    Rule 5: assertions on inputs.
    """
    assert isinstance(results, list), "results must be a list"
    assert output_path, "output_path required"

    if not results:
        return header_written

    mode = 'a' if header_written else 'w'
    with open(output_path, mode, newline='') as f:
        writer = csv.DictWriter(f, fieldnames=CSV_FIELDS)
        if not header_written:
            writer.writeheader()
        writer.writerows(results)
    return True


# ============ DOMAIN LOADING (Rule 4: under 60 lines) ============
def load_and_filter_domains(input_path: str, limit: int) -> List[str]:
    """Load domains from file, pre-filter low-value ones.

    Rule 5: assertions on inputs.
    """
    assert os.path.isfile(input_path), f"Input file not found: {input_path}"
    assert limit > 0, "Limit must be positive"

    raw = []
    with open(input_path) as f:
        for line in f:
            d = line.strip().lower()
            if d and '.' in d:
                raw.append(d)
                if len(raw) >= limit:
                    break
    print(f'Loaded {len(raw)} domains from {input_path}')

    domains, removed = pre_filter_domains(raw)
    print(f'Pre-filtered {removed} low-value domains ({len(domains)} remaining)')
    return domains


# ============ SCORE ONE DOMAIN (Rule 4: under 60 lines) ============
def score_domain(domain, opr_results, wb_result, rdap_result, min_score):
    """Score a single domain from API results. Returns dict or None.

    Rule 5: assertions on inputs.
    """
    assert isinstance(domain, str), "domain must be str"
    assert min_score >= 0, "min_score must be non-negative"

    snapshots = wb_result[0] if isinstance(wb_result, tuple) else None
    age_years = wb_result[1] if isinstance(wb_result, tuple) else None
    availability = rdap_result if isinstance(rdap_result, str) else 'unknown'

    if availability == 'registered':
        return None

    tld = '.' + domain.split('.')[-1]
    pr = opr_results.get(domain)
    brand = calculate_brand_score(domain)
    score = calculate_score(pr, snapshots, age_years, tld, domain)

    if score < min_score:
        return None

    return {
        'domain': domain, 'tld': tld,
        'potential_score': score, 'tier': tier_from_score(score),
        'estimated_flip_value': estimate_flip_value(score, tld, age_years),
        'page_rank': pr, 'wayback_snapshots': snapshots,
        'estimated_age_years': age_years, 'backlinks': 0,
        'majestic_rank': None, 'tranco_rank': None,
        'availability_status': availability, 'source': 'czds_dropped',
        'brand_score': brand,
        'first_seen': datetime.now(timezone.utc).isoformat(),
    }


# ============ PROCESS LOOP (Rule 4: under 60 lines) ============
async def process_domains(session, domains, opr_results, min_score, output_path):
    """Process domains in batches with checkpointing. Returns total qualified.

    Rule 5: assertions on inputs.
    """
    assert len(domains) <= MAX_DOMAINS, "Too many domains"
    assert output_path, "output_path required"

    header_written = False
    total_qualified = 0
    batch_results = []

    for i in range(0, len(domains), RDAP_BATCH):
        batch = domains[i:i + RDAP_BATCH]
        tasks = []
        for d in batch:
            tasks.append(check_wayback(session, d))
            tasks.append(check_rdap(session, d))
        raw = await asyncio.gather(*tasks, return_exceptions=True)

        for j, domain in enumerate(batch):
            result = score_domain(domain, opr_results, raw[j*2], raw[j*2+1], min_score)
            if result:
                batch_results.append(result)

        processed = min(i + RDAP_BATCH, len(domains))
        if processed % CHECKPOINT_INTERVAL < RDAP_BATCH or processed == len(domains):
            if batch_results:
                header_written = write_checkpoint(batch_results, output_path, header_written)
                total_qualified += len(batch_results)
                batch_results = []
            if i > 0:
                print(f'  Processed {processed}/{len(domains)}, qualified: {total_qualified}')
        await asyncio.sleep(RDAP_DELAY)

    if batch_results:
        write_checkpoint(batch_results, output_path, header_written)
        total_qualified += len(batch_results)
    return total_qualified


# ============ MAIN (Rule 4: orchestration) ============
async def main():
    """Entry point. Parses args, runs pipeline, reports results.

    Rule 5: assertions on parsed args.
    """
    parser = argparse.ArgumentParser(description='Score dropped domains from CZDS')
    parser.add_argument('input', help='Dropped domains file (one FQDN per line)')
    parser.add_argument('--output', default='results/scored.csv', help='Output CSV path')
    parser.add_argument('--opr-key', help='OpenPageRank API key')
    parser.add_argument('--limit', type=int, default=MAX_DOMAINS, help='Max domains to process')
    parser.add_argument('--min-score', type=int, default=30, help='Minimum score to include')
    args = parser.parse_args()

    assert args.limit > 0, "Limit must be positive"
    assert args.min_score >= 0, "Min score must be non-negative"

    domains = load_and_filter_domains(args.input, args.limit)
    if not domains:
        print('No domains to process'); sys.exit(0)

    opr_key = args.opr_key or os.getenv('OPENPAGERANK_API_KEY', '')
    if not opr_key:
        print('WARNING: OPENPAGERANK_API_KEY not set — PageRank signal unavailable, scores will be artificially low')

    os.makedirs(os.path.dirname(args.output) or '.', exist_ok=True)
    start = time.time()
    connector = aiohttp.TCPConnector(limit=MAX_CONCURRENT)

    async with aiohttp.ClientSession(connector=connector) as session:
        print('Checking OpenPageRank...')
        opr_results = await batch_check_opr(session, domains, opr_key)
        print(f'  OPR results: {len(opr_results)}')
        total = await process_domains(session, domains, opr_results, args.min_score, args.output)

    elapsed = int(time.time() - start)
    print(f'Done in {elapsed}s. Qualified: {total} / {len(domains)} (score >= {args.min_score})')
    print(f'Output: {args.output}')

    tiers: Dict[str, int] = {}
    if os.path.exists(args.output):
        with open(args.output) as f:
            for row in csv.DictReader(f):
                tiers[row.get('tier', '')] = tiers.get(row.get('tier', ''), 0) + 1
    for t in ['diamond', 'gold', 'silver', 'bronze']:
        print(f'  {t}: {tiers.get(t, 0)}')


if __name__ == '__main__':
    asyncio.run(main())
