#!/usr/bin/env python3
"""Bulk QA gate audit — runs gates on all existing rows, logs rejections without deleting."""
import json, os, re, urllib.request

API = os.environ.get('EYECX_API_URL', 'https://eyecx-api.kjssamsungdev.workers.dev')
SECRET = os.environ['EYECX_API_SECRET']
JOB_ID = os.environ.get('JOB_ID', '')

FQDN_RE = re.compile(r'^[a-z0-9]([a-z0-9-]*[a-z0-9])?\.[a-z]{2,}$')
VALID_TIERS = {'diamond', 'gold', 'silver', 'bronze', 'lead'}


def api_call(path, method='GET', data=None):
    req = urllib.request.Request(
        f'{API}{path}', data=json.dumps(data).encode() if data else None,
        headers={'Authorization': f'Bearer {SECRET}', 'Content-Type': 'application/json'},
        method=method)
    return json.loads(urllib.request.urlopen(req, timeout=60).read())


def audit_domain(d):
    """Returns list of issues (empty = passes)."""
    issues = []
    if not d.get('domain') or not FQDN_RE.match(d['domain']):
        issues.append(f"invalid FQDN: {d.get('domain')}")
    score = d.get('potential_score', -1)
    if not isinstance(score, (int, float)) or score < 0 or score > 100:
        issues.append(f"score out of range: {score}")
    tier = d.get('tier', '')
    if tier not in VALID_TIERS:
        issues.append(f"invalid tier: {tier}")
    status = d.get('availability_status', '')
    if not status:
        issues.append("empty availability_status")
    return issues


def main():
    print('=== Bulk QA Gate Audit ===')
    # Fetch all domains
    offset = 0
    total, passed, failed = 0, 0, 0
    all_issues = []

    while True:
        resp = api_call(f'/api/domains?admin=1&limit=500&offset={offset}&min_score=0')
        domains = resp.get('domains', [])
        if not domains:
            break

        for d in domains:
            total += 1
            issues = audit_domain(d)
            if issues:
                failed += 1
                all_issues.append({'domain': d.get('domain', '?'), 'issues': issues})
            else:
                passed += 1

        offset += 500
        if len(domains) < 500:
            break

    summary = f'Audited {total} domains: {passed} passed, {failed} failed'
    if all_issues:
        summary += f'. Top issues: {"; ".join(i["domain"] + ": " + ", ".join(i["issues"]) for i in all_issues[:10])}'
    print(summary[:500])

    if JOB_ID:
        api_call(f'/api/admin/jobs/{JOB_ID}/complete', 'POST', {'status': 'success', 'summary': summary[:2000]})


if __name__ == '__main__':
    main()
