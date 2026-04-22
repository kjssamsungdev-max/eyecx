#!/usr/bin/env python3
"""Bulk domain rescore via Worker API (Bearer auth)."""
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
    print('=== Bulk Rescore ===')
    result = api_call('/api/admin/rescore')

    summary = f"Total: {result.get('total', 0)}, Changed: {result.get('changed', 0)}, Avg delta: {result.get('avg_delta', 0)}"
    risers = result.get('top_risers', [])[:5]
    if risers:
        summary += f". Top risers: {', '.join(r['domain'] + '(+' + str(r['delta']) + ')' for r in risers)}"
    print(summary)

    if JOB_ID:
        api_call(f'/api/admin/jobs/{JOB_ID}/complete', data={'status': 'success', 'summary': summary})


if __name__ == '__main__':
    main()
