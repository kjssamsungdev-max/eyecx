# EyeCX v4.0 - Deployment & Operations Guide

## Business Model

### Revenue Streams
1. **Domain Flipping** - Buy diamonds ($10-15), sell for $500-5000
2. **Content Revival** - Restore Wayback content, add users, sell for $1000-10000
3. **Subscription Lists** - Sell curated lists to affiliates ($19-99/mo)
4. **Link Placements** - Sell contextual links on portfolio sites ($50-500/link)
5. **Affiliate Revenue** - Monetize restored sites with Amazon/affiliate links

---

## Distribution & SEO Strategy

### The Value Pipeline

```
┌─────────────────────────────────────────────────────────────────────┐
│                    EYECX VALUE PIPELINE                     │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  ACQUIRE        RESTORE         MONETIZE        DISTRIBUTE          │
│  ────────      ─────────       ──────────      ────────────         │
│                                                                     │
│  200K-500K  →  Wayback      →  Affiliate   →  Link Network          │
│  candidates    Download        Links          (PBN-lite)            │
│                                                                     │
│  50 diamonds   Clean HTML      Display Ads    Subscription          │
│  200 golds     Fix URLs        Email Capture  Lists API             │
│                                                                     │
│  Score 70+     Deploy to CF    Internal       Syndication           │
│                Pages           Linking        RSS/JSON              │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

### Phase 1: Acquire (EyeCX v4)
- Daily scan finds 50+ diamonds, 200+ golds
- Register best domains via Cloudflare ($10-15 each)
- Track in D1 database

### Phase 2: Restore (Distribution Engine)
```bash
python distribution_engine.py \
  --domain expired-tech-blog.com \
  --affiliate-tag your-amazon-tag \
  --adsense ca-pub-xxxxx \
  --email-form https://yourlist.beehiiv.com/subscribe
```

What it does:
1. Downloads all archived pages from Wayback Machine
2. Cleans archive.org artifacts from HTML
3. Detects niche (tech, finance, health, etc.)
4. Inserts affiliate links contextually
5. Adds 3 ad slots per page
6. Adds email capture form
7. Deploys to Cloudflare Pages

### Phase 3: Link Network
Every restored site becomes part of your network:
- Sites in same niche link to each other
- Spreads link equity across portfolio
- Creates topical authority clusters

```
    Tech Cluster              Finance Cluster
    ────────────              ───────────────
    tech-blog-1.com  ←→      money-tips-1.com
         ↕                        ↕
    dev-tools-2.com  ←→      invest-guide-2.com
         ↕                        ↕
    saas-news-3.com  ←→      credit-help-3.com
```

### Phase 4: Monetization Mix

| Source | Revenue | Effort |
|--------|---------|--------|
| Domain flip | $500-5000/domain | One-time |
| Affiliate links | $0.50-50/click | Passive |
| Display ads | $5-50/1K views | Passive |
| Email list | $1-5/subscriber | Ongoing |
| Link sales | $50-500/link | Per request |
| Subscription lists | $19-99/mo | Automated |

### Phase 5: Scale

```
Projections (unverified targets):
Month 1: 10 restored sites
Month 3: 50 sites across 5 niches
Month 6: 150 sites, link network active
Month 12: 500+ sites — revenue TBD
```

---

## Distribution Engine Usage

### Single Domain
```bash
python distribution_engine.py --domain expired-site.com
```

### Batch Processing
```bash
# Create list of diamonds
sqlite3 eyecx.db "SELECT domain FROM domains WHERE tier='diamond' LIMIT 10" > diamonds.txt

# Process all
python distribution_engine.py --domains-file diamonds.txt
```

### With Full Monetization
```bash
python distribution_engine.py \
  --domain site.com \
  --affiliate-tag domainhunter-20 \
  --adsense ca-pub-1234567890 \
  --email-form https://api.beehiiv.com/v2/lists/xxx/subscriptions \
  --output ./restored
```

### API Integration (Cloudflare Worker)

Add endpoint for triggering restoration:
```typescript
// POST /api/restore
app.post('/restore', async (c) => {
  const { domain } = await c.req.json();
  // Trigger GitHub Action or direct restoration
  return c.json({ queued: true, domain });
});
```

### Subscription Tiers
| Tier | Price | Domains/Day | Min Score | Target Customer |
|------|-------|-------------|-----------|-----------------|
| Premium | $99/mo | 500 | 70+ | SEO agencies |
| Standard | $49/mo | 200 | 55+ | Affiliate marketers |
| Basic | $19/mo | 50 | 40+ | Individual flippers |

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                        EYECX v4.0                          │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  ┌──────────────┐     ┌──────────────┐     ┌──────────────┐       │
│  │  50 Seeds    │────▶│   Expander   │────▶│  200K-500K   │       │
│  │  (seeds.txt) │     │ (Common Crawl│     │  Candidates  │       │
│  └──────────────┘     │  + Wayback)  │     └──────────────┘       │
│                       └──────────────┘              │              │
│                                                     ▼              │
│  ┌──────────────────────────────────────────────────────────┐     │
│  │                    PARALLEL CHECKERS                      │     │
│  │  ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐        │     │
│  │  │ Wayback │ │   OPR   │ │Majestic │ │ Tranco  │        │     │
│  │  │   CDX   │ │  Batch  │ │ Million │ │  List   │        │     │
│  │  └─────────┘ └─────────┘ └─────────┘ └─────────┘        │     │
│  └──────────────────────────────────────────────────────────┘     │
│                              │                                     │
│                              ▼                                     │
│  ┌──────────────┐     ┌──────────────┐     ┌──────────────┐       │
│  │   Scoring    │────▶│   SQLite/D1  │────▶│   Outputs    │       │
│  │   Engine     │     │   Database   │     │  CSV + JSON  │       │
│  └──────────────┘     └──────────────┘     └──────────────┘       │
│                              │                                     │
│         ┌────────────────────┼────────────────────┐               │
│         ▼                    ▼                    ▼               │
│  ┌──────────────┐     ┌──────────────┐     ┌──────────────┐       │
│  │  Cloudflare  │     │ Subscription │     │   Purchase   │       │
│  │  Worker API  │     │    Lists     │     │    Queue     │       │
│  └──────────────┘     └──────────────┘     └──────────────┘       │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Deployment Steps

### 1. Repository Setup

```bash
# Create repo
gh repo create eyecx --private
cd eyecx

# Add all files
git add .
git commit -m "EyeCX v4.0 - Production pipeline"
git push origin main
```

### 2. GitHub Secrets

Add these secrets in GitHub → Settings → Secrets:

```
OPENPAGERANK_API_KEY    # Get free at domcop.com/openpagerank
CLOUDFLARE_API_TOKEN    # API token with D1 + Registrar permissions
CLOUDFLARE_ACCOUNT_ID   # Your account ID (dbaac4c99956159d7594d90033b0224d)
D1_DATABASE_ID          # Created in step 3
DISCORD_WEBHOOK_URL     # Optional: for notifications
```

### 3. Cloudflare D1 Database

```bash
# Login to Cloudflare
npx wrangler login

# Create D1 database
npx wrangler d1 create eyecx

# Note the database_id and add to wrangler.toml
# Also add as D1_DATABASE_ID secret in GitHub

# Initialize schema
npx wrangler d1 execute eyecx --file=./schema.sql
```

### 4. Deploy Worker API

```bash
cd worker

# Set secrets
npx wrangler secret put API_SECRET
npx wrangler secret put CLOUDFLARE_API_TOKEN
npx wrangler secret put CLOUDFLARE_ACCOUNT_ID

# Deploy
npx wrangler deploy

# Note the worker URL (e.g., eyecx-api.your-subdomain.workers.dev)
```

### 5. Custom Domain (Optional)

```bash
# Add custom domain in Cloudflare dashboard
# Workers → eyecx-api → Triggers → Custom Domains
# Add: api.eyecx.com

# Update DNS in Cloudflare
# CNAME api → eyecx-api.your-subdomain.workers.dev
```

### 6. Enable GitHub Actions

The workflow runs automatically at 2 AM UTC daily.

Manual trigger:
```bash
gh workflow run daily-scan.yml
```

---

## Operations

### Daily Workflow

1. **2:00 AM UTC** - GitHub Actions triggers daily scan
2. **2:00-5:00 AM** - Pipeline runs (3hr max)
   - Expands 50 seeds → 200K-500K candidates
   - Filters to new domains only
   - Batch checks OPR, Wayback, cross-references
   - Scores and classifies into tiers
3. **5:00 AM** - Results uploaded to D1
4. **5:05 AM** - Subscription lists generated
5. **5:10 AM** - Discord notification sent

### Manual Operations

```bash
# Run local scan
python eyecx.py --seeds seeds.txt --opr-key YOUR_KEY

# Query API for diamonds
curl -H "Authorization: Bearer YOUR_API_SECRET" \
  "https://api.eyecx.com/api/domains?tier=diamond&limit=50"

# Generate subscription list
curl -X POST -H "Authorization: Bearer YOUR_API_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"subscriber_id": "user123", "tier": "premium"}' \
  "https://api.eyecx.com/api/subscribe"

# Check domain availability
curl -X POST -H "Authorization: Bearer YOUR_API_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"domain": "example.com"}' \
  "https://api.eyecx.com/api/check-availability"
```

### Monitoring

```bash
# Check today's stats
curl -H "Authorization: Bearer YOUR_API_SECRET" \
  "https://api.eyecx.com/api/stats"

# View GitHub Actions logs
gh run list --workflow=daily-scan.yml
gh run view <run_id>

# Check D1 database
npx wrangler d1 execute eyecx --command "SELECT tier, COUNT(*) FROM domains GROUP BY tier"
```

---

## Scaling

### Current Capacity
- **50 seeds** × **10,000 domains/seed** = **500,000 candidates/day**
- **Processing**: ~3 hours on GitHub Actions runner
- **Storage**: D1 handles millions of rows

### To Increase Volume

1. **More Seeds**: Add seeds to `seeds.txt`
2. **Parallel Workers**: Split seeds across multiple GitHub Actions jobs
3. **Dedicated Runner**: Use self-hosted runner for more CPU/memory
4. **Multiple OPR Keys**: Get additional free API keys for higher throughput

### Rate Limits

| Service | Limit | Strategy |
|---------|-------|----------|
| OpenPageRank | 4.3M/day | Batch 100 domains/request |
| Wayback CDX | ~15 req/min | Monthly collapse, limit 500 |
| Common Crawl | Generous | Query by seed, not individual |
| Cloudflare D1 | 100K rows/day | Batch inserts |

---

## Costs

### Free Tier Coverage
- **OpenPageRank**: Free (4.3M domains/day)
- **Cloudflare Workers**: Free (100K requests/day)
- **Cloudflare D1**: Free (5GB storage, 100K rows/day writes)
- **GitHub Actions**: Free (2,000 min/month for private repos)

### Paid Costs (at scale)
- **Domain registrations**: $10-15/domain via Cloudflare
- **GitHub Actions**: $0.008/min beyond free tier
- **Cloudflare Workers**: $5/mo for 10M requests

### ROI Example (projection, unverified)
- *Assumes* daily scan finds 50 diamonds, 200 golds
- *Assumes* register 5 diamonds: $75
- *Assumes* flip 2 diamonds: $2,000
- *Projected* daily profit: ~$1,925 — actual results will vary

---

## Affiliate Subscription Delivery

### API Integration

Affiliates call your API daily:

```javascript
// Affiliate's code
const response = await fetch('https://api.eyecx.com/api/subscribe', {
  method: 'POST',
  headers: {
    'Authorization': 'Bearer AFFILIATE_API_KEY',
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    subscriber_id: 'affiliate_123',
    tier: 'premium'
  })
});

const { domains } = await response.json();
// domains = array of 500 high-value domains
```

### Webhook Delivery

Or push to affiliates via webhook:

```python
# Your daily job
for affiliate in affiliates:
    domains = generate_list(affiliate.tier)
    requests.post(affiliate.webhook_url, json={
        'domains': domains,
        'generated_at': datetime.now().isoformat()
    })
```

---

## Troubleshooting

### Scan fails
1. Check GitHub Actions logs: `gh run view <run_id> --log`
2. Verify secrets are set: `gh secret list`
3. Test locally: `python eyecx.py --seeds seeds.txt`

### Low domain count
1. Check seed quality (high-traffic seeds yield more)
2. Increase expansion depth in config
3. Lower score thresholds temporarily

### API errors
1. Check Worker logs: Cloudflare Dashboard → Workers → Logs
2. Verify D1 database exists and schema is initialized
3. Test with curl: `curl -v https://api.../api/health`

---

## Security

- **API_SECRET**: Random 64-char string, rotate monthly
- **CLOUDFLARE_API_TOKEN**: Minimal permissions (D1, Registrar only)
- **Rate limiting**: Worker has built-in limits
- **Affiliate keys**: Generate unique keys per affiliate

---

## Files Reference

```
eyecx/
├── eyecx.py                  # Main pipeline
├── eyecx_distribution.py     # Distribution engine
├── schema.sql                # D1 database schema
├── seeds.txt                 # 50 seed domains
├── seeds-expanded.txt        # Expanded niche seeds
├── requirements.txt          # Python deps
├── index.html                # Landing page
│
├── worker/
│   ├── src/index.ts          # Cloudflare Worker API
│   └── wrangler.toml         # Worker config
│
├── scripts/
│   ├── upload_to_d1.py       # CSV → D1 uploader
│   └── generate_subscription_lists.py
│
├── .github/workflows/
│   └── daily-scan.yml        # GitHub Actions automation
│
└── eyecx.db          # Local SQLite (dev)
```
