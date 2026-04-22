#!/usr/bin/env python3
"""Bulk sales re-extraction from curated articles (Bearer auth)."""
import json, os, urllib.request

API = os.environ.get('EYECX_API_URL', 'https://eyecx-api.kjssamsungdev.workers.dev')
SECRET = os.environ['EYECX_API_SECRET']
JOB_ID = os.environ.get('JOB_ID', '')


def api_call(path, method='POST', data=None):
    """Call Worker API with Bearer API_SECRET."""
    req = urllib.request.Request(
        f'{API}{path}', data=json.dumps(data).encode() if data else None,
        headers={'Authorization': f'Bearer {SECRET}', 'Content-Type': 'application/json'},
        method=method)
    return json.loads(urllib.request.urlopen(req, timeout=120).read())


def main():
    print('=== Bulk Sales Re-extraction ===')
    total_extracted = 0
    total_processed = 0

    for round_num in range(20):
        result = api_call('/api/admin/sales/extract')
        total_processed += result.get('processed', 0)
        total_extracted += result.get('extracted', 0)
        print(f'  Round {round_num+1}: {result.get("processed", 0)} processed, {result.get("extracted", 0)} extracted')
        if result.get('processed', 0) == 0:
            break

    summary = f'Processed {total_processed} articles, extracted {total_extracted} sales'
    print(summary)

    if JOB_ID:
        api_call(f'/api/admin/jobs/{JOB_ID}/complete', data={'status': 'success', 'summary': summary})


if __name__ == '__main__':
    main()
