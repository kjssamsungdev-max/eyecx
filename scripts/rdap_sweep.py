#!/usr/bin/env python3
"""RDAP sweep — verify availability_status for unverified domains.

Usage:
  python3 scripts/rdap_sweep.py

Env vars:
  EYECX_API_URL     — Worker API base URL
  EYECX_API_SECRET  — Bearer token for Worker API

Queries D1 via Worker API for domains needing verification, checks RDAP,
writes back results. Designed to run from GitHub Actions (CF Worker IPs
are blocked by rdap.org).
"""

import json
import os
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone

API = os.environ.get('EYECX_API_URL', 'https://eyecx-api.kjssamsungdev.workers.dev')
SECRET = os.environ.get('EYECX_API_SECRET', '')
UA = 'EyeCX/1.0 (https://eyecx.com)'

# RDAP bootstrap proxy — follows redirects to registry-specific servers
RDAP_BASE = 'https://rdap.org/domain/'

# Rate limit: 1 request per second
RATE_LIMIT_SEC = 1.0


def api_get(path: str) -> dict:
    req = urllib.request.Request(
        f'{API}{path}',
        headers={'Authorization': f'Bearer {SECRET}', 'User-Agent': UA, 'Accept': 'application/json'},
    )
    resp = urllib.request.urlopen(req, timeout=30)
    return json.loads(resp.read())


def api_post(path: str, data: list) -> dict:
    body = json.dumps(data).encode()
    req = urllib.request.Request(
        f'{API}{path}', data=body,
        headers={'Authorization': f'Bearer {SECRET}', 'Content-Type': 'application/json', 'User-Agent': UA},
        method='POST',
    )
    resp = urllib.request.urlopen(req, timeout=30)
    return json.loads(resp.read())


def rdap_check(domain: str) -> tuple:
    """Returns (availability_status, rdap_status).

    404 → ('available', 'available')
    200 + flags → ('registered'|'grace_period', flag_detail)
    error → ('unknown', 'rdap_error')
    """
    try:
        req = urllib.request.Request(f'{RDAP_BASE}{domain}', headers={'User-Agent': UA})
        resp = urllib.request.urlopen(req, timeout=10)
        data = json.loads(resp.read())
        flags = [s.lower() for s in data.get('status', [])]

        if any('redemption' in f for f in flags):
            return 'grace_period', 'redemption_period'
        elif any('pending delete' in f for f in flags):
            return 'grace_period', 'pending_delete'
        elif any('client hold' in f or 'auto renew' in f for f in flags):
            return 'registered', 'client_hold'
        else:
            return 'registered', 'registered'
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return 'available', 'available'
        return 'unknown', f'rdap_error_http_{e.code}'
    except Exception as e:
        return 'unknown', 'rdap_error'


def fetch_domains(query_filter: str) -> list:
    """Fetch domains from Worker API via admin domains endpoint."""
    all_domains = []
    offset = 0
    while True:
        data = api_get(f'/api/domains?admin=1&limit=500&offset={offset}')
        batch = data.get('domains', [])
        for d in batch:
            if query_filter == 'available_null' and d['availability_status'] == 'available' and not d.get('rdap_status'):
                all_domains.append(d)
            elif query_filter == 'unknown' and d['availability_status'] == 'unknown':
                all_domains.append(d)
        if len(batch) < 500:
            break
        offset += 500
    return all_domains


def run_sweep():
    if not SECRET:
        print('ERROR: EYECX_API_SECRET not set')
        sys.exit(1)

    now = datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M UTC')
    print(f'=== EyeCX RDAP Sweep — {now} ===\n')

    # Phase 1: available with null RDAP
    print('Phase 1: Verifying "available" domains with rdap_status=NULL...')
    avail_domains = fetch_domains('available_null')
    print(f'  Found {len(avail_domains)} domains to verify\n')

    # Phase 2: unknown domains
    print('Phase 2: Verifying "unknown" domains...')
    unknown_domains = fetch_domains('unknown')
    print(f'  Found {len(unknown_domains)} domains to verify\n')

    all_domains = avail_domains + unknown_domains
    if not all_domains:
        print('Nothing to verify. All domains already have RDAP status.')
        return {'verified': 0, 'available': 0, 'registered': 0, 'grace': 0, 'errors': 0, 'corrections': 0}

    # Track per-TLD stats
    tld_stats = {}
    updates = []
    stats = {'available': 0, 'registered': 0, 'grace_period': 0, 'errors': 0, 'corrections': 0}

    for i, dom in enumerate(all_domains):
        domain = dom['domain']
        old_status = dom['availability_status']
        tld = dom.get('tld', '.' + domain.split('.')[-1])

        avail_status, rdap_status = rdap_check(domain)

        # Track correction (old status != new status)
        if old_status != avail_status:
            stats['corrections'] += 1
            print(f'  CORRECTED: {domain} {old_status} → {avail_status} (rdap: {rdap_status})')

        # Count
        if avail_status == 'available':
            stats['available'] += 1
        elif avail_status == 'registered':
            stats['registered'] += 1
        elif avail_status == 'grace_period':
            stats['grace_period'] += 1
        else:
            stats['errors'] += 1

        # Per-TLD tracking
        if tld not in tld_stats:
            tld_stats[tld] = {'checked': 0, 'available': 0, 'registered': 0, 'grace': 0, 'errors': 0}
        tld_stats[tld]['checked'] += 1
        tld_stats[tld][avail_status if avail_status in ('available', 'registered') else ('grace' if avail_status == 'grace_period' else 'errors')] += 1

        updates.append({
            'domain': domain,
            'availability_status': avail_status,
            'rdap_status': rdap_status,
        })

        # Progress
        if (i + 1) % 20 == 0 or i == len(all_domains) - 1:
            print(f'  Checked {i+1}/{len(all_domains)}: {stats["available"]} avail, {stats["registered"]} reg, {stats["grace_period"]} grace, {stats["errors"]} err')

        time.sleep(RATE_LIMIT_SEC)

    # Batch update via Worker API
    print(f'\nWriting {len(updates)} updates to D1...')
    for i in range(0, len(updates), 200):
        batch = updates[i:i + 200]
        try:
            result = api_post('/api/domains/verify-update', batch)
            print(f'  Batch {i//200+1}: {result.get("updated", 0)} updated')
        except Exception as e:
            print(f'  Batch {i//200+1} FAILED: {e}')

    # Summary
    print(f'\n=== RDAP Sweep Complete ===')
    print(f'Total verified: {len(all_domains)}')
    print(f'Available: {stats["available"]}')
    print(f'Registered: {stats["registered"]}')
    print(f'Grace period: {stats["grace_period"]}')
    print(f'Errors (retry tomorrow): {stats["errors"]}')
    print(f'Corrections: {stats["corrections"]}')
    print(f'\nPer-TLD breakdown:')
    for tld, s in sorted(tld_stats.items()):
        print(f'  {tld}: {s["checked"]} checked, {s["available"]} avail, {s["registered"]} reg, {s["grace"]} grace, {s["errors"]} err')

    # Write markdown summary for commit
    summary_path = os.environ.get('SUMMARY_PATH', '')
    if summary_path:
        with open(summary_path, 'w') as f:
            f.write(f'# Sprint 0 RDAP Sweep — {now}\n\n')
            f.write(f'## Results\n\n')
            f.write(f'| Metric | Count |\n|--------|-------|\n')
            f.write(f'| Verified | {len(all_domains)} |\n')
            f.write(f'| Available | {stats["available"]} |\n')
            f.write(f'| Registered | {stats["registered"]} |\n')
            f.write(f'| Grace Period | {stats["grace_period"]} |\n')
            f.write(f'| Errors | {stats["errors"]} |\n')
            f.write(f'| Corrections | {stats["corrections"]} |\n\n')
            f.write(f'## Per-TLD\n\n')
            f.write(f'| TLD | Checked | Available | Registered | Grace | Errors |\n')
            f.write(f'|-----|---------|-----------|------------|-------|--------|\n')
            for tld, s in sorted(tld_stats.items()):
                f.write(f'| {tld} | {s["checked"]} | {s["available"]} | {s["registered"]} | {s["grace"]} | {s["errors"]} |\n')
        print(f'\nSummary written to {summary_path}')

    # Write to GitHub step summary if available
    gh_summary = os.environ.get('GITHUB_STEP_SUMMARY', '')
    if gh_summary:
        with open(gh_summary, 'a') as f:
            f.write(f'## RDAP Sweep Results\n\n')
            f.write(f'Verified **{len(all_domains)}** domains: {stats["available"]} available, ')
            f.write(f'{stats["registered"]} registered, {stats["grace_period"]} grace, {stats["errors"]} errors\n')
            f.write(f'Corrections: **{stats["corrections"]}**\n')

    return stats


if __name__ == '__main__':
    run_sweep()
