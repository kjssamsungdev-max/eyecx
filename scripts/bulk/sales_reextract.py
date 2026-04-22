#!/usr/bin/env python3
"""Bulk sales re-extraction from curated articles."""
import json, os, urllib.request

API = os.environ.get('EYECX_API_URL', 'https://eyecx-api.kjssamsungdev.workers.dev')
SECRET = os.environ['EYECX_API_SECRET']
JOB_ID = os.environ.get('JOB_ID', '')


def api_call(path, method='GET', data=None):
    req = urllib.request.Request(
        f'{API}{path}', data=json.dumps(data).encode() if data else None,
        headers={'Authorization': f'Bearer {SECRET}', 'Content-Type': 'application/json'},
        method=method)
    return json.loads(urllib.request.urlopen(req, timeout=120).read())


def main():
    print('=== Bulk Sales Re-extraction ===')
    login = api_call('/api/auth/login', 'POST', {
        'email': os.environ.get('ADMIN_EMAIL', 'admin@eyecx.com'),
        'password': os.environ.get('ADMIN_PASSWORD', 'EyeCX2026Admin!')
    })
    token = login.get('token', '')
    if not token:
        print('Admin login failed'); return

    total_extracted = 0
    total_processed = 0
    rounds = 0

    # Run extraction in batches (Worker processes 100 at a time)
    for _ in range(20):  # Max 20 rounds = 2000 articles
        req = urllib.request.Request(
            f'{API}/api/admin/sales/extract', method='POST',
            headers={'Authorization': f'Bearer {token}', 'Content-Type': 'application/json'})
        result = json.loads(urllib.request.urlopen(req, timeout=120).read())
        rounds += 1
        total_processed += result.get('processed', 0)
        total_extracted += result.get('extracted', 0)
        print(f'  Round {rounds}: {result.get("processed", 0)} processed, {result.get("extracted", 0)} extracted')
        if result.get('processed', 0) == 0:
            break

    summary = f'Processed {total_processed} articles in {rounds} rounds, extracted {total_extracted} sales'
    print(summary)

    if JOB_ID:
        api_call(f'/api/admin/jobs/{JOB_ID}/complete', 'POST', {'status': 'success', 'summary': summary})


if __name__ == '__main__':
    main()
