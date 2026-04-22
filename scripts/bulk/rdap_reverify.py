#!/usr/bin/env python3
"""Bulk RDAP re-verification of unknown-status domains."""
import json, os, sys, time, urllib.request, urllib.error

API = os.environ.get('EYECX_API_URL', 'https://eyecx-api.kjssamsungdev.workers.dev')
SECRET = os.environ['EYECX_API_SECRET']
JOB_ID = os.environ.get('JOB_ID', '')


def rdap_check(domain, timeout=15, retries=2):
    """Check RDAP with retry + backoff."""
    for attempt in range(retries):
        try:
            req = urllib.request.Request(f'https://rdap.org/domain/{domain}')
            urllib.request.urlopen(req, timeout=timeout)
            return 'registered'
        except urllib.error.HTTPError as e:
            if e.code == 404: return 'available'
            if attempt < retries - 1: time.sleep(2 ** (attempt + 1))
        except Exception:
            if attempt < retries - 1: time.sleep(2 ** (attempt + 1))
    return 'unknown'


def api_call(path, method='GET', data=None):
    """Call Worker API."""
    req = urllib.request.Request(
        f'{API}{path}', data=json.dumps(data).encode() if data else None,
        headers={'Authorization': f'Bearer {SECRET}', 'Content-Type': 'application/json'},
        method=method)
    return json.loads(urllib.request.urlopen(req, timeout=30).read())


def main():
    print('=== Bulk RDAP Re-verification ===')
    # Fetch unknown domains via admin API
    domains_resp = api_call('/api/domains?admin=1&limit=500&min_score=0')
    all_doms = [d for d in domains_resp.get('domains', []) if d.get('availability_status') == 'unknown']
    print(f'Found {len(all_doms)} unknown-status domains')

    available, registered, still_unknown = 0, 0, 0
    updates = []

    for i, d in enumerate(all_doms):
        status = rdap_check(d['domain'])
        updates.append({'domain': d['domain'], 'availability_status': status})
        if status == 'available': available += 1
        elif status == 'registered': registered += 1
        else: still_unknown += 1

        if (i + 1) % 20 == 0:
            print(f'  Checked {i+1}/{len(all_doms)}: {available} avail, {registered} reg, {still_unknown} unk')
            time.sleep(1)

    # Batch update
    for i in range(0, len(updates), 200):
        batch = updates[i:i+200]
        api_call('/api/domains/verify-update', 'POST', batch)

    summary = f'Checked {len(all_doms)}: {available} available, {registered} registered, {still_unknown} still unknown'
    print(summary)

    if JOB_ID:
        api_call(f'/api/admin/jobs/{JOB_ID}/complete', 'POST', {'status': 'success', 'summary': summary})


if __name__ == '__main__':
    main()
