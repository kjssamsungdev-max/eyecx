#!/usr/bin/env python3
"""Bulk domain rescore via Worker API."""
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
    print('=== Bulk Rescore ===')
    # Login as admin to get session token
    login = api_call('/api/auth/login', 'POST', {
        'email': os.environ.get('ADMIN_EMAIL', 'admin@eyecx.com'),
        'password': os.environ.get('ADMIN_PASSWORD', 'EyeCX2026Admin!')
    })
    token = login.get('token', '')
    if not token:
        print('Admin login failed')
        return

    # Call rescore with admin session
    req = urllib.request.Request(
        f'{API}/api/admin/rescore', method='POST',
        headers={'Authorization': f'Bearer {token}', 'Content-Type': 'application/json'})
    result = json.loads(urllib.request.urlopen(req, timeout=120).read())

    summary = f"Total: {result.get('total', 0)}, Changed: {result.get('changed', 0)}, Avg delta: {result.get('avg_delta', 0)}"
    risers = result.get('top_risers', [])[:5]
    if risers:
        summary += f". Top risers: {', '.join(r['domain'] + '(+' + str(r['delta']) + ')' for r in risers)}"
    print(summary)

    if JOB_ID:
        api_call(f'/api/admin/jobs/{JOB_ID}/complete', 'POST', {'status': 'success', 'summary': summary})


if __name__ == '__main__':
    main()
