#!/usr/bin/env python3
"""
Score dropped domains from CZDS zone file diffs.
Reads a dropped-domains file (one FQDN per line), scores each domain,
RDAP-verifies availability, and outputs a CSV for upload_to_d1.py.

Usage:
  python scripts/score_dropped.py dropped.txt --output results/scored.csv
  python scripts/score_dropped.py dropped.txt --output results/scored.csv --opr-key KEY --limit 5000
"""

import argparse
import asyncio
import aiohttp
import csv
import json
import os
import sys
import time
from datetime import datetime

MAX_CONCURRENT = 20
MAX_TIMEOUT = 15
MAX_DOMAINS = 50000
RDAP_BATCH = 10
RDAP_DELAY = 1.0


async def check_wayback(session, domain):
    """Get Wayback snapshot count and age."""
    params = {'url': domain, 'output': 'json', 'fl': 'timestamp',
              'collapse': 'timestamp:6', 'limit': 200}
    try:
        async with session.get(
            'https://web.archive.org/cdx/search/cdx',
            params=params, timeout=aiohttp.ClientTimeout(total=MAX_TIMEOUT)
        ) as resp:
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
                    age = round((datetime.now() - oldest_date).days / 365.25, 1)
                except (ValueError, IndexError):
                    pass
            return len(snapshots), age
    except Exception:
        return 0, None


async def check_rdap(session, domain):
    """Check domain availability via RDAP."""
    try:
        async with session.get(
            f'https://rdap.org/domain/{domain}',
            timeout=aiohttp.ClientTimeout(total=MAX_TIMEOUT)
        ) as resp:
            if resp.status == 404:
                return 'available'
            if resp.status == 200:
                return 'registered'
            return 'unknown'
    except Exception:
        return 'unknown'


async def batch_check_opr(session, domains, api_key):
    """Batch check OpenPageRank."""
    if not api_key:
        return {}
    results = {}
    for i in range(0, min(len(domains), 50000), 100):
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


def calculate_score(pr, snapshots, age_years, tld):
    """Score a domain (0-100)."""
    score = 0
    if pr is not None:
        if pr >= 6: score += 30
        elif pr >= 5: score += 25
        elif pr >= 4: score += 20
        elif pr >= 3: score += 15
        elif pr >= 2: score += 10
        elif pr >= 1: score += 5
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
    return min(score, 100)


def tier_from_score(score):
    if score >= 85: return 'diamond'
    if score >= 70: return 'gold'
    if score >= 55: return 'silver'
    if score >= 40: return 'bronze'
    return 'lead'


def estimate_flip_value(score, tld, age):
    if score >= 85: base = 500.0
    elif score >= 70: base = 150.0
    elif score >= 55: base = 50.0
    elif score >= 40: base = 20.0
    else: base = 10.0
    tld_mult = {'.com': 2.0, '.io': 1.5, '.ai': 2.5, '.co': 1.3, '.org': 1.2, '.xyz': 0.8}.get(tld, 1.0)
    age_mult = min(1.0 + ((age or 0) * 0.05), 2.0)
    return round(base * tld_mult * age_mult, 2)


async def main():
    parser = argparse.ArgumentParser(description='Score dropped domains from CZDS')
    parser.add_argument('input', help='Dropped domains file (one FQDN per line)')
    parser.add_argument('--output', default='results/scored.csv', help='Output CSV path')
    parser.add_argument('--opr-key', help='OpenPageRank API key')
    parser.add_argument('--limit', type=int, default=MAX_DOMAINS, help='Max domains to process')
    parser.add_argument('--min-score', type=int, default=30, help='Minimum score to include in output')
    args = parser.parse_args()

    # Read domains
    domains = []
    with open(args.input) as f:
        for line in f:
            d = line.strip().lower()
            if d and '.' in d:
                domains.append(d)
                if len(domains) >= args.limit:
                    break
    print(f'Loaded {len(domains)} domains from {args.input}')

    if not domains:
        print('No domains to process')
        sys.exit(0)

    os.makedirs(os.path.dirname(args.output) or '.', exist_ok=True)
    start = time.time()
    connector = aiohttp.TCPConnector(limit=MAX_CONCURRENT)

    async with aiohttp.ClientSession(connector=connector) as session:
        # OPR batch check
        print('Checking OpenPageRank...')
        opr_key = args.opr_key or os.getenv('OPENPAGERANK_API_KEY', '')
        opr_results = await batch_check_opr(session, domains, opr_key)
        print(f'  OPR results: {len(opr_results)}')

        # Process in batches: Wayback + RDAP
        results = []
        for i in range(0, len(domains), RDAP_BATCH):
            batch = domains[i:i + RDAP_BATCH]

            # Parallel Wayback + RDAP for each domain
            tasks = []
            for d in batch:
                tasks.append(check_wayback(session, d))
                tasks.append(check_rdap(session, d))

            raw = await asyncio.gather(*tasks, return_exceptions=True)

            for j, domain in enumerate(batch):
                wb_result = raw[j * 2]
                rdap_result = raw[j * 2 + 1]

                snapshots = wb_result[0] if isinstance(wb_result, tuple) else 0
                age_years = wb_result[1] if isinstance(wb_result, tuple) else None
                availability = rdap_result if isinstance(rdap_result, str) else 'unknown'

                if availability == 'registered':
                    continue

                tld = '.' + domain.split('.')[-1]
                pr = opr_results.get(domain)
                score = calculate_score(pr, snapshots, age_years, tld)

                if score < args.min_score:
                    continue

                tier = tier_from_score(score)
                flip = estimate_flip_value(score, tld, age_years)

                results.append({
                    'domain': domain,
                    'tld': tld,
                    'potential_score': score,
                    'tier': tier,
                    'estimated_flip_value': flip,
                    'page_rank': pr,
                    'wayback_snapshots': snapshots,
                    'estimated_age_years': age_years,
                    'backlinks': 0,
                    'majestic_rank': None,
                    'tranco_rank': None,
                    'availability_status': availability,
                    'source': 'czds_dropped',
                    'first_seen': datetime.utcnow().isoformat(),
                })

            if (i + RDAP_BATCH) % 100 < RDAP_BATCH and i > 0:
                print(f'  Processed {min(i + RDAP_BATCH, len(domains))}/{len(domains)}, qualified: {len(results)}')

            await asyncio.sleep(RDAP_DELAY)

    # Write CSV
    if results:
        fields = list(results[0].keys())
        with open(args.output, 'w', newline='') as f:
            writer = csv.DictWriter(f, fieldnames=fields)
            writer.writeheader()
            writer.writerows(results)

    elapsed = int(time.time() - start)
    print(f'Done in {elapsed}s. Qualified: {len(results)} / {len(domains)} (score >= {args.min_score})')
    print(f'Output: {args.output}')

    # Print tier breakdown
    tiers = {}
    for r in results:
        tiers[r['tier']] = tiers.get(r['tier'], 0) + 1
    for t in ['diamond', 'gold', 'silver', 'bronze']:
        print(f'  {t}: {tiers.get(t, 0)}')


if __name__ == '__main__':
    asyncio.run(main())
