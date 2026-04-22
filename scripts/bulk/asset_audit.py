#!/usr/bin/env python3
"""Bulk asset audit — checks HTML/JS for broken src/href references."""
import json, os, re, urllib.request

API = os.environ.get('EYECX_API_URL', 'https://eyecx-api.kjssamsungdev.workers.dev')
SECRET = os.environ['EYECX_API_SECRET']
JOB_ID = os.environ.get('JOB_ID', '')
SITE = 'https://eyecx.com'

ASSET_RE = re.compile(r'(?:src|href)="(/[^"]*\.[a-z]{2,4})"', re.IGNORECASE)


def api_call(path, method='GET', data=None):
    req = urllib.request.Request(
        f'{API}{path}', data=json.dumps(data).encode() if data else None,
        headers={'Authorization': f'Bearer {SECRET}', 'Content-Type': 'application/json'},
        method=method)
    return json.loads(urllib.request.urlopen(req, timeout=30).read())


def main():
    print('=== Bulk Asset Audit ===')

    # Fetch the main page
    req = urllib.request.Request(SITE, headers={'User-Agent': 'EyeCX-Auditor'})
    html = urllib.request.urlopen(req, timeout=15).read().decode()

    # Extract all local asset references
    assets = set(ASSET_RE.findall(html))
    print(f'Found {len(assets)} local asset references')

    ok, broken = 0, 0
    broken_list = []

    for asset in sorted(assets):
        url = f'{SITE}{asset}'
        try:
            req = urllib.request.Request(url, method='HEAD', headers={'User-Agent': 'EyeCX-Auditor'})
            resp = urllib.request.urlopen(req, timeout=10)
            ct = resp.headers.get('Content-Type', '')
            # Check if it's returning HTML fallback instead of the actual asset
            if asset.endswith('.png') and 'text/html' in ct:
                broken += 1
                broken_list.append(f'{asset} (returns HTML, not image)')
            elif asset.endswith('.svg') and 'text/html' in ct:
                broken += 1
                broken_list.append(f'{asset} (returns HTML, not SVG)')
            else:
                ok += 1
        except Exception as e:
            broken += 1
            broken_list.append(f'{asset} ({e})')

    summary = f'Checked {len(assets)} assets: {ok} OK, {broken} broken'
    if broken_list:
        summary += f'. Broken: {"; ".join(broken_list[:10])}'
    print(summary[:500])

    if JOB_ID:
        api_call(f'/api/admin/jobs/{JOB_ID}/complete', 'POST', {'status': 'success', 'summary': summary[:2000]})


if __name__ == '__main__':
    main()
