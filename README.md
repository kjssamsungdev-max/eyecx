# EyeCX — Drop Domain Intelligence Platform

Detects domains dropping from ICANN CZDS zone files daily, scores them across 7 signals, verifies availability via RDAP, and surfaces the best ones in a public marketplace. A self-learning loop reweights scoring based on real market sales extracted from domain industry news.

Live at [eyecx.com](https://eyecx.com). Admin at [eyecx.com/admin](https://eyecx.com/admin).

---

## Architecture

```
Frontend:   Single-file SPA (index.html) on Cloudflare Pages
Backend:    Cloudflare Worker (TypeScript) → D1 (SQLite) + R2 (object storage)
Pipeline:   GitHub Actions cron → Python scripts
Auth:       Session tokens (community) + Bearer API_SECRET (service)
```

**Key services:**
- **Worker API** — auth, domains, marketplace, admin, community, blog, CZDS, scoring, jobs
- **D1 Database** — domains, market_sales, curated_content, community_users, scoring_weights, bulk_jobs, alerts, score_history
- **R2 Bucket** — CZDS zone file snapshots (100-200MB per TLD per day)
- **GitHub Actions** — CZDS download, zone diff, domain scoring, RDAP verification, bulk upload

---

## Data Signals (7)

| Signal | Source | What it measures |
|--------|--------|-----------------|
| CZDS zone drops | ICANN zone files (.xyz, .info, .org + dynamic) | Domain removed from zone = potentially available |
| Wayback Machine | web.archive.org CDX API | Historical content, domain age |
| OpenPageRank | openpagerank.com API | Backlink authority (0-10) |
| RDAP | rdap.org | Registration status (available/registered) |
| Cloudflare Registrar | CF API | Purchase price, premium status |
| Brandability | Local dictionary + rules | Length, pronounceability, dictionary match |
| Market comparables | Extracted from DNJournal, NamePros, DomainInvesting | Recent sale prices for similar domains |

---

## Pipeline Flow

```
1 AM UTC    CZDS daily (GitHub Actions)
            ├── Auth with ICANN CZDS
            ├── Download zone files → R2 snapshots
            └── Parse NS records → domain lists

3 AM UTC    Daily scan (GitHub Actions)
            ├── Diff two most recent R2 snapshots per TLD
            ├── Score dropped domains (brandability + history)
            ├── Upload qualified domains via POST /api/domains/bulk
            ├── RDAP verify from GH runner → POST /api/domains/verify-update
            └── Only availability_status='available' shown publicly

4 AM UTC    Nightly rescore (Worker cron)
            ├── Precompute market_sales aggregates per TLD
            ├── Apply similarity_bonus + feedback_bonus
            ├── Log changes to score_history
            └── Compute price predictions from comparables

5 AM UTC    Self-tuning (Worker cron)
            ├── Compare signal presence in high vs low price sales
            ├── Adjust scoring_weights with 15% shrinkage
            └── Min 20 sales per TLD to tune

Every 6h    RSS curation + sales extraction (Worker cron)
            ├── Fetch 29 RSS/Atom feeds
            ├── Classify into categories (sale-report, analysis, etc.)
            ├── Extract domain sale prices via regex
            └── Feed into market_sales for rescore loop
```

---

## TLD Classes

TLDs are classified in `config/active_tlds.json`:

- **Open TLDs** (xyz, info, org): Public registration, high drop volume. Always visible in marketplace and sitemap.
- **Brand TLDs** (edeka, statefarm, chase, etc.): Single-registrant corporate TLDs approved via CZDS. Low/zero drop volume. Invisible in marketplace and sitemap until they actually produce available domains. `/tld/:tld` returns 410 Gone for brand TLDs with no inventory.

The pipeline processes all approved TLDs regardless of class. Brand TLDs have relaxed zone file size thresholds (100 bytes min, 1 domain min) since their zone files are tiny.

`GET /api/tlds?class=open|brand|all` filters by class (default: all).

## Adding a New TLD

When ICANN approves a new CZDS zone:

1. Add the TLD to `config/active_tlds.json` with appropriate class
2. Add it to the `czds-daily.yml` matrix (with `tld_class: open|brand`)
3. Mirror the entry in `ACTIVE_TLDS` in `worker/src/index.ts`
4. Deploy the Worker — `GET /api/tlds` returns it, frontend filters update automatically
5. `daily-scan.yml` discovers it from the API and includes it in diffs
6. Scoring works immediately (unknown TLDs get +1 base, brandability applies)
7. After 20+ sales accumulate, self-tuning adjusts weights for the TLD

---

## Scoring

Each domain receives a score (0-100) from four components:

**Base score (0-45):** PageRank (0-30) + Wayback snapshots (0-10) + domain age (0-15)

**Brandability (0-55):** Length bonus (3-char=40, 4=30, 5=20, 6=12, 8=5) + no digits (+5) + no hyphens (+3) + pronounceability (+10) + dictionary word (+20). Weights loaded from `scoring_weights` table and are per-TLD tunable.

**Similarity bonus (0-20):** `LOG(avg_sale_price_for_TLD / 100) * 5`. Precomputed from `market_sales`.

**Feedback bonus (-10 to +15):** `(saved + bought*3 - dismissed) * 0.5` per TLD. Driven by admin actions.

Scores are idempotent — two consecutive rescores with no new data produce zero changes.

---

## Price Prediction

For domains with >=3 comparable sales (same TLD, name length +/-2 chars):

```
predicted = MEDIAN(comps) * CLAMP(score/60, 0.5, 2.0)
low       = P25(comps) * multiplier
high      = P75(comps) * multiplier
confidence = high (>=30 comps) | medium (>=10) | low (>=3) | insufficient (<3)
```

---

## Admin Features

- **Domains tab** — filter/sort, check availability, save/dismiss feedback, run scan, verify batch
- **Curated tab** — RSS feeds, quality scores, category filter, hide, fetch now
- **Sales Intel** — extracted sale prices, top 10, TLD breakdown
- **Movers** — top score risers/fallers over configurable window
- **Tuning** — scoring weights matrix, self-tune trigger, reset
- **Jobs** — bulk job queue (RDAP re-verify, rescore, sales re-extract, QA audit, asset audit)
- **Content Stats** — volume charts, source health, quality distribution
- **Sources** — health dashboard, auto-discovery candidates, enable/disable
- **Threads** — community moderation, hide threads/comments
- **Marketplace** — public domain browse with price predictions

---

## Local Development

```bash
git clone https://github.com/kjssamsungdev-max/eyecx
cd eyecx

# Worker
cd worker && npx wrangler dev

# Deploy
npx wrangler deploy                              # Worker
npx wrangler pages deploy . --project-name eyecx # Pages
```

**Secrets (set via `npx wrangler secret put`):**
API_SECRET, RESEND_API_KEY, CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, CZDS_USERNAME, CZDS_PASSWORD, GITHUB_TOKEN

**GitHub Secrets:**
EYECX_API_SECRET, CZDS_USERNAME, CZDS_PASSWORD, CLOUDFLARE_ACCOUNT_ID, OPENPAGERANK_API_KEY, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY

---

## Contact

- **Website**: [eyecx.com](https://eyecx.com)
- **Email**: hello@eyecx.com
- **Built by**: [KJS Productions](https://kjs.productions)
