# Domain Hunter v3.0 - Data Sources Reference

## Free Data Sources (No API Key Required)

### 1. Wayback Machine CDX API
**URL:** `https://web.archive.org/cdx/search/cdx`
**Data:** Snapshot count, date range, URL patterns
**Rate Limit:** ~15 req/min (be respectful)
**Usage:**
```
GET https://web.archive.org/cdx/search/cdx?url=*.example.com/*&output=json&collapse=timestamp:8
```

### 2. Common Crawl Index
**URL:** `https://index.commoncrawl.org/`
**Data:** Pages crawled, can estimate backlinks from outbound links
**Rate Limit:** Generous, but don't hammer it
**Crawls:** Updated monthly, ~3-5 billion pages per crawl
**Usage:**
```
GET https://index.commoncrawl.org/CC-MAIN-2024-10-index?url=*.example.com/*&output=json
```

### 3. Majestic Million (Free Download)
**URL:** `https://downloads.majestic.com/majestic_million.csv`
**Data:** Top 1M domains by Trust Flow/Citation Flow
**Update:** Daily
**Fields:** GlobalRank, TrustFlow, CitationFlow, RefSubNets, RefIPs

### 4. Tranco List (Free Download)
**URL:** `https://tranco-list.eu/top-1m.csv.zip`
**Data:** Research-grade ranking combining Chrome UX, Cloudflare Radar, Majestic, Farsight
**Update:** Daily
**Size:** 1M domains (can request up to 7.5M full list)

### 5. Cisco Umbrella 1M
**URL:** `https://s3-us-west-1.amazonaws.com/umbrella-static/top-1m.csv.zip`
**Data:** DNS popularity ranking
**Update:** Daily

### 6. Google DNS over HTTPS (DoH)
**URL:** `https://dns.google/resolve?name=example.com&type=A`
**Data:** DNS resolution check (domain availability proxy)
**Rate Limit:** High

### 7. Whoxy Expiring Domains
**URL:** `https://s3.amazonaws.com/files.whoxy.com/expiring/YYYY-MM-DD.zip`
**Data:** Daily lists of expiring domains
**Format:** ZIP containing text file with domain names
**Note:** Replace YYYY-MM-DD with target date

---

## Free APIs (Requires Free Account/Key)

### 8. OpenPageRank API
**URL:** `https://openpagerank.com/api/v1.0/getPageRank`
**Sign Up:** https://www.domcop.com/openpagerank/
**Data:** PageRank score (0-10), rank position
**Rate Limit:** 4.3M domains/day (free tier)
**Batch:** Up to 100 domains per request
**Headers:** `API-OPR: YOUR_API_KEY`
**Example:**
```bash
curl -H "API-OPR: YOUR_KEY" \
  "https://openpagerank.com/api/v1.0/getPageRank?domains[]=google.com&domains[]=example.com"
```

### 9. ExpiredDomains.net (Free Account)
**URL:** `https://member.expireddomains.net/`
**Sign Up:** https://www.expireddomains.net/
**Data:** Backlinks, DomainPop, Archive entries, Status
**Requires:** Playwright browser automation (handles JS + login)
**Lists Available:**
- Deleted Domains (dropped, available)
- Pending Delete (dropping soon)
- Expired Domains (in redemption)
- Auction Domains (NameJet, DropCatch, etc.)

---

## Paid APIs (Pay-Per-Use)

### 10. backlinks.sh
**URL:** `https://api.backlinks.sh/v1/backlinks`
**Data:** Referring domains with authority scores (from Common Crawl Web Graph)
**Pricing:** $0.004-0.01 per request
**Includes:** Majestic, Tranco, OpenPageRank scores per backlink
**Example:**
```bash
curl -H "x-api-key: YOUR_KEY" \
  "https://api.backlinks.sh/v1/backlinks?target=stripe.com&sort=rank&limit=10"
```

### 11. DataForSEO Backlinks API
**URL:** `https://api.dataforseo.com/`
**Data:** Full backlink profiles, history, anchors
**Pricing:** Pay-as-you-go, competitive rates
**Coverage:** Billions of live backlinks

### 12. WhoisXML API
**URL:** `https://newly-registered-domains.whoisxmlapi.com/`
**Data:** 250K newly registered + 340K expired domains daily
**Pricing:** Subscription-based

### 13. SEO PowerSuite Backlinks API
**URL:** `https://www.link-assistant.com/backlink-api.html`
**Data:** Largest backlink index (claimed)
**Coverage:** Real-time + 12 months history

---

## Scraping Targets (Requires Browser Automation)

### 14. GoDaddy Auctions
**URL:** `https://auctions.godaddy.com/`
**Data:** Domain listings, bids, traffic estimates
**Method:** Playwright/Puppeteer required

### 15. NameJet
**URL:** `https://www.namejet.com/`
**Data:** Premium auction domains
**Method:** API available for partners

### 16. DropCatch
**URL:** `https://www.dropcatch.com/`
**Data:** Dropped domain auctions
**Method:** Account required

---

## Reference Data (Downloadable)

### 17. DomCop Top 10M
**URL:** `https://www.domcop.com/files/top/top10milliondomains.csv.zip`
**Data:** PageRank, Referring Domains, External Backlinks for top 10M

### 18. BuiltWith Top 1M
**URL:** `https://builtwith.com/dl/builtwith-top1m.zip`
**Data:** Technology detection ranking

---

## Scoring Weight Reference

| Source | Max Score | Weight | Notes |
|--------|-----------|--------|-------|
| Wayback Snapshots | 15 | High | Direct history indicator |
| Domain Age | 15 | High | Trust signal |
| PageRank (OPR) | 20 | Critical | Authority metric |
| Backlinks | 20 | Critical | Link equity |
| Majestic Rank | 10 | Medium | Trust/Citation flow |
| Tranco Rank | 10 | Medium | Popularity proxy |
| Content Hints | 10 | Low | Niche relevance |

**Total Maximum:** 100 points

---

## Environment Variables

```bash
# Required for enhanced scanning
export OPENPAGERANK_API_KEY="your_key_here"

# Optional - ExpiredDomains.net scraping
export EXPIREDDOMAINS_USERNAME="your_username"
export EXPIREDDOMAINS_PASSWORD="your_password"

# Optional - Pay-per-use backlink data
export BACKLINKS_SH_API_KEY="your_key_here"
```

---

## Rate Limiting Best Practices

1. **Wayback Machine:** 1 request per second
2. **Common Crawl:** 2-3 requests per second
3. **OpenPageRank:** Batch 100 domains, 1 batch per second
4. **ExpiredDomains.net:** 1 page per 2-3 seconds (they rate limit aggressively)
5. **DNS checks:** Up to 10 concurrent

---

## Data Freshness

| Source | Update Frequency |
|--------|------------------|
| Wayback Machine | Real-time (but historical) |
| Common Crawl | Monthly crawls |
| Majestic Million | Daily |
| Tranco | Daily |
| OpenPageRank | Quarterly |
| ExpiredDomains.net | Daily |
| Whoxy | Daily |

---

## Legal Notes

- All sources listed are publicly accessible or offer free tiers
- Respect robots.txt and rate limits
- ExpiredDomains.net requires account and prohibits commercial scraping
- Common Crawl data is CC0 (public domain)
- Majestic Million is free for non-commercial use
