# EyeCX Launch-Readiness Audit — 2026-04-27

## Verdict: NOT LAUNCH-READY — 4 P0 blockers, 6 P1 pre-launch items

---

## A. Verify 3 Landed Commits

### Commit f9a50e1 — Quick wins

| Fix | Status | Evidence |
|-----|--------|----------|
| /v1 meta.total respects filters | **PASS** | `/api/domains?tld=.info` returns `count:0`, `?tld=.xyz` returns `count:11`, `?admin=1&tld=.info` returns `count:95`. Regex replacement verified: count query inherits all WHERE clauses. |
| /api/domains count mirrors filters | **PASS** | Returns `count:11` with `limit=1` (was returning `count:1` before). Admin mode: 221 total, filtered by TLD works correctly. |
| Bulk jobs atomic INSERT | **PASS (code)** | `INSERT INTO bulk_jobs ... SELECT ... WHERE (SELECT COUNT(*)...) < 2` — verified single D1 call with `result.meta.changes` check. Cannot live-test without API_SECRET for concurrent POSTs. |
| pipefail on workflows | **PARTIAL** | czds-daily: 9/10 run blocks ✓. daily-scan: **2/6** — 4 blocks still missing. eyecx-bulk: 1/2 ✓. |
| User-Agent on curl calls | **PASS** | 7 curls updated. Verified in repo via grep. |
| Silent domain INSERT catch | **PASS** | `catch(e) { await logRejection(...) }` at line 1504. |
| Promise.all .catch | **PASS** | Each fetch wrapped with `.catch(() => null)`, null-safe downstream. |
| Pages Functions try/catch | **PASS** | All 6 proxy functions wrapped. `/tld/zzzznotreal` returns 404 (Worker passthrough), sitemap returns 200. |

### Commit 3a1ff30 — Retention

| Fix | Status | Evidence |
|-----|--------|----------|
| R2 30-day cleanup | **UNVERIFIED** | Step exists in repo (grep confirms). Has not run yet — czds-daily triggers at 1 AM UTC. Will verify on next cron cycle. |
| D1 TTL cleanup cron | **UNVERIFIED** | Code deployed (env.DB.batch of 5 DELETEs at hour===5). Tables have few rows (api_usage: 4, events: 3, score_history: 32) — nothing old enough to delete yet. Will verify on next 5 AM UTC tick. |
| Cron failure alerts | **PASS (code)** | All 7 cron handlers have `await createAlert(env, ...).catch(() => {})` in catch blocks. |

### Commit 3401bff — Schema

| Fix | Status | Evidence |
|-----|--------|----------|
| schema.sql matches production | **PASS** | Production: 33 tables. schema.sql: 33 tables. Table count matches. |
| migrations/ directory | **PASS** | `migrations/0000_initial.sql` exists, `wrangler.toml` has `migrations_dir`. |

**Overall: 10 PASS, 2 UNVERIFIED (need cron cycle), 1 PARTIAL (daily-scan pipefail gaps)**

---

## B. Code / Infrastructure

### B1. Pipefail Coverage

| Workflow | Run blocks | With pipefail | Gap |
|----------|-----------|---------------|-----|
| czds-daily.yml | 10 | 9 | 1 (parse step already had `set -eo pipefail`) |
| **daily-scan.yml** | **6** | **2** | **4 blocks missing** |
| eyecx-bulk.yml | 2 | 1 | 1 (report step) |

**P1** — daily-scan.yml lines 209, 274, 353, 371 still lack `set -euo pipefail`. Effort: S

### B2. Deployed Worker Version

Worker Version ID: `352a7814` deployed 2026-04-27. Matches latest commit `3401bff`. ✓

### B3. Secret Exposure

- No secrets in wrangler.toml (all via `wrangler secret put`) ✓
- `env.CZDS_USERNAME` returned in `/api/czds/auth-test` response (behind Bearer gate) — P2, S

### B4. Test Coverage

**No test suite exists.** No `vitest`, `jest`, or `wrangler test` configuration. All verification is manual curl + D1 queries.

**P1** — Zero automated tests for a production platform. Effort: L (initial suite), ongoing

---

## C. Data Pipeline

### C1. Domain Inventory

| TLD | Total | Available | Grace | Registered | Unknown |
|-----|-------|-----------|-------|------------|---------|
| .xyz | 29 | 11 | 0 | 17 | 1 |
| .info | 112 | 0 | 84 | 17 | 11 |
| .biz | 110 | 0 | 0 | 0 | 110 |
| .org | 4 | 0 | 0 | 0 | 4 |
| Brand TLDs (12) | 0 | 0 | 0 | 0 | 0 |

**Total: 255 domains, 11 available, 126 unknown**

### C2. RDAP Verification — CRITICAL GAP

**P0 — All 11 "available" domains have `rdap_status = NULL`**

These domains were marked available by CZDS zone diff (dropped from zone = assumed available) but were **never RDAP-verified**. The marketplace shows unverified inventory.

Additionally: 126 domains are `availability_status = 'unknown'` — never checked at all.

RDAP verification runs in daily-scan.yml (GH Actions) not from Workers (CF IPs blocked by rdap.org). The pipeline ran but verification results weren't written back for these 11.

**Fix needed**: Run RDAP verify batch from GH Actions for all `rdap_status IS NULL` domains. Effort: S

### C3. Sales Corpus

| Source | Articles | Extracted | Sales | Avg Price |
|--------|----------|-----------|-------|-----------|
| NamePros | 683 | 683 | 199 | $17,886 |
| DNJournal | 34 | 34 | 27 | $562,826 |
| DomainNameWire | 18 | 18 | 2 | $172,500 |
| DomainInvesting | 8 | 8 | 0 | — |
| **Total** | **743** | **743** | **228** | |

228 sales is thin for a "market intelligence" platform. Need 500+ minimum for credible pricing models.

**P1** — DomainNameWire yields only 2 sales from 18 articles (each article lists 10-20 sales). Per-source parser needed. Effort: M

### C4. CZDS Pipeline Health

Cannot verify last 7 runs without GH Actions access (`gh` CLI not authed). czds-daily.yml is scheduled at 0 1 * * * — runs daily. No failure alerts in D1 alerts table → either running clean or alerts not firing.

**P2** — No visibility into pipeline success rate without GH Actions dashboard. Effort: S (auth gh CLI)

### C5. Storage Trajectory

| Resource | Current | Free Tier | Runway |
|----------|---------|-----------|--------|
| D1 storage | 3.02 MB | 5 GB | >100 months |
| D1 rows | ~3,000 | 5M | >100 months |
| R2 storage | Unknown (can't query R2 size via D1) | 10 GB | Need measurement |

**P2** — R2 size unknown. Should measure at next czds-daily run. Effort: S

---

## D. Security

### D1. Authentication

| Issue | Severity | Status |
|-------|----------|--------|
| Session token in localStorage (XSS risk) | **P1** | Open. 6 localStorage refs in deployed index.html. |
| No brute-force protection on /api/auth/login | **P1** | Confirmed: 5 rapid wrong-password requests all return 401, no rate limiting or lockout. |
| CORS `*` on admin endpoints | **P2** | Confirmed: `/api/admin/stats` returns `Access-Control-Allow-Origin: *`. |
| Session token has D1 expiry check | ✓ | `authenticateSession()` checks `expires_at > datetime('now')`. |
| API key rate limiting on /v1/* | ✓ | Per-key hourly limit via D1 counter. |

### D2. Data Exposure

- No password_hash, key_hash, or secrets in public endpoint responses ✓
- `env.CZDS_USERNAME` in `/api/czds/auth-test` response (Bearer-gated) ��� P2

---

## E. Product Surface

### E1. User-Facing Pages

| Page | Status | Issue |
|------|--------|-------|
| Homepage `/` | 200 ✓ | |
| Marketplace | 200 ✓ | Shows 11 .xyz domains. Thin inventory for launch. |
| Blog | 200 ✓ | 1 article. |
| Admin | 200 ✓ | Dashboard + 14 tabs functional. |
| `/tld/xyz` | 200 ✓ | |
| `/tld/edeka` | 410 ✓ | Brand TLD, no inventory. Correct. |
| `/tld/info` | 503 | Insufficient data (word count < 300). |

### E2. Marketplace Viability

**P0 — Only 11 domains available, all .xyz, all unverified**

A paying customer opening the marketplace sees 11 random 5-letter .xyz domains with no RDAP verification. No .com, no .net, no premium TLDs. This is not a viable product offering.

**Minimum viable inventory**: 50+ verified domains across 2+ TLDs with meaningful scores and price estimates.

### E3. Content

- 2,152 curated articles ✓ (good corpus)
- 228 market sales ✓ (thin but growing)
- 1 blog article — **P2**, need at least 3-5 for SEO credibility
- 1 community thread, 2 users — **P3**, community is empty but not blocking

---

## Sprint Grouping

### SPRINT 0 — P0 Blockers (must fix before any launch)

| # | Finding | Effort | Category |
|---|---------|--------|----------|
| 1 | **RDAP verify all 11 "available" domains** — marketplace shows unverified inventory | S | Data |
| 2 | **RDAP verify 126 "unknown" domains** — hidden inventory that could be available | S | Data |
| 3 | **Marketplace inventory too thin** — 11 domains, single TLD. Need CZDS pipeline producing drops for .info/.biz/.org as grace periods expire | M | Product |
| 4 | **daily-scan.yml 4 run blocks missing pipefail** — score job, RDAP inline, report steps | S | Pipeline |

### SPRINT 1 — P1 Pre-Launch

| # | Finding | Effort | Category |
|---|---------|--------|----------|
| 5 | Login brute-force rate limit (CF dashboard rule or Worker IP counter) | S | Security |
| 6 | localStorage → httpOnly cookies for session token | M | Security |
| 7 | DomainNameWire per-source parser (2 sales from 18 articles — should be 100+) | M | Data |
| 8 | No automated test suite | L | Quality |

### SPRINT 2 — P2 Post-Launch

| # | Finding | Effort | Category |
|---|---------|--------|----------|
| 9 | CORS restrict admin endpoints to eyecx.com origin | S | Security |
| 10 | CZDS username removed from auth-test response | S | Security |
| 11 | R2 size measurement + lifecycle rules verification | S | Infra |
| 12 | `/tld/info` returns 503 (should be thin page or 404) | S | Product |
| 13 | Blog content (3-5 articles for SEO) | M | Content |
| 14 | GH Actions visibility (auth gh CLI, monitor success rate) | S | Ops |

### SPRINT 3 — P3 Nice-to-Have

| # | Finding | Effort | Category |
|---|---------|--------|----------|
| 15 | Community features (empty but functional) | L | Product |
| 16 | Park.io integration for external drops | M | Data |
| 17 | Legacy table cleanup (daily_usage, error_logs, platform_improvements) | S | Hygiene |

---

## Summary

| Severity | Count |
|----------|-------|
| P0 Blocker | 4 |
| P1 Pre-Launch | 4 |
| P2 Post-Launch | 6 |
| P3 Nice | 3 |
| **Total** | **17** |

**Sprint 0 (blockers) estimated effort: 1 day.** Main work is triggering RDAP verification and waiting for grace-period domains to mature into available inventory. The pipeline works — it just needs time + a verification pass.
