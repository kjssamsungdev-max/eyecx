# EyeCX v4.2 - Competitive Analysis

> **Note:** EyeCX figures are self-reported estimates. Third-party benchmarking TBD.

## Market Landscape

| Tool | Monthly Cost | Domains/Day | Key Strength |
|------|-------------|-------------|--------------|
| **DomCop** | $64-184/mo | 200K+ | 90+ metrics, Majestic/Moz |
| **SpamZilla** | $37/mo | 350K+ | Spam detection, SZ Score |
| **ExpiredDomains.net** | Free | 1M+ | Free, huge database |
| **FreshDrop** | $49-99/mo | 50K+ | Auction focus |
| **EyeCX v4.2** | $0 (self-hosted) | 200K-500K | Full autonomy, owned infra |

---

## Feature Comparison Matrix

| Feature | DomCop | SpamZilla | ExpiredDomains | EyeCX |
|---------|--------|-----------|----------------|---------------|
| **Daily Volume** | 200K | 350K | 1M+ | 200K-500K |
| **Metrics Sources** | 90+ | 70+ | Basic | 6 (OPR, Majestic, Tranco, Wayback, CC, age) |
| **Spam Detection** | ❌ | ✅ SZ Score | ❌ | ⚠️ Basic |
| **Wayback Integration** | Export only | Snapshots | ❌ | ✅ Full restore + deploy |
| **Auto-Purchase** | ❌ | ❌ | ❌ | ✅ CF Registrar API |
| **Content Restoration** | ❌ | ❌ | ❌ | ✅ Automated |
| **Monetization Engine** | ❌ | ❌ | ❌ | ✅ Affiliate + Ads |
| **Link Network Mgmt** | ❌ | ❌ | ❌ | ✅ Built-in |
| **Subscription Lists** | ❌ | ❌ | ❌ | ✅ Tiered delivery |
| **Self-Hosted** | ❌ | ❌ | ❌ | ✅ Full ownership |
| **API Access** | ❌ | ❌ | ❌ | ✅ CF Worker |
| **CI/CD Pipeline** | ❌ | ❌ | ❌ | ✅ GitHub Actions |
| **Compliance Built-in** | ❌ | ❌ | ❌ | ✅ GDPR/CAN-SPAM |

---

## Scoring (1-10 scale)

### Discovery & Volume
| Criteria | DomCop | SpamZilla | ExpiredDomains | EyeCX |
|----------|--------|-----------|----------------|---------------|
| Daily domain volume | 8 | 9 | 10 | 9 |
| Data freshness | 9 | 9 | 8 | 8 |
| TLD coverage | 9 | 9 | 10 | 7 |
| Source diversity | 8 | 7 | 6 | 8 |
| **Subtotal** | **34** | **34** | **34** | **32** |

### Metrics & Analysis
| Criteria | DomCop | SpamZilla | ExpiredDomains | EyeCX |
|----------|--------|-----------|----------------|---------------|
| Metric breadth | 10 | 8 | 4 | 6 |
| Spam detection | 3 | 10 | 2 | 4 |
| Backlink analysis | 9 | 9 | 3 | 5 |
| Historical data | 7 | 9 | 5 | 8 |
| **Subtotal** | **29** | **36** | **14** | **23** |

### Automation & Integration
| Criteria | DomCop | SpamZilla | ExpiredDomains | EyeCX |
|----------|--------|-----------|----------------|---------------|
| Auto-purchase | 0 | 0 | 0 | 9 |
| Content restoration | 2 | 4 | 0 | 9 |
| Deployment pipeline | 0 | 0 | 0 | 10 |
| API/Programmatic | 3 | 2 | 0 | 10 |
| CI/CD ready | 0 | 0 | 0 | 10 |
| **Subtotal** | **5** | **6** | **0** | **48** |

### Monetization & Business
| Criteria | DomCop | SpamZilla | ExpiredDomains | EyeCX |
|----------|--------|-----------|----------------|---------------|
| Revenue generation | 0 | 0 | 0 | 9 |
| Subscription delivery | 0 | 0 | 0 | 9 |
| Link network mgmt | 0 | 0 | 0 | 8 |
| Affiliate integration | 0 | 0 | 0 | 8 |
| **Subtotal** | **0** | **0** | **0** | **34** |

### Cost & Ownership
| Criteria | DomCop | SpamZilla | ExpiredDomains | EyeCX |
|----------|--------|-----------|----------------|---------------|
| Monthly cost | 4 | 7 | 10 | 10 |
| Data ownership | 2 | 2 | 3 | 10 |
| Customizability | 2 | 2 | 1 | 10 |
| No vendor lock-in | 2 | 2 | 5 | 10 |
| **Subtotal** | **10** | **13** | **19** | **40** |

---

## Final Scores

| Tool | Discovery | Metrics | Automation | Business | Cost | **TOTAL** |
|------|-----------|---------|------------|----------|------|-----------|
| **DomCop** | 34 | 29 | 5 | 0 | 10 | **78/200** |
| **SpamZilla** | 34 | 36 | 6 | 0 | 13 | **89/200** |
| **ExpiredDomains** | 34 | 14 | 0 | 0 | 19 | **67/200** |
| **EyeCX** | 32 | 23 | 48 | 34 | 40 | **177/200** |

---

## Visual Score Breakdown

```
                    COMPETITIVE POSITIONING
                    
  Discovery ████████████████░░░░  32/40  (Competitive)
  Metrics   ███████████░░░░░░░░░  23/40  (Gap: No Ahrefs/Moz direct)
  Automation████████████████████  48/50  (DOMINANT)
  Business  █████████████████░░░  34/40  (UNIQUE - No competitor)
  Cost      ████████████████████  40/40  (Free/Self-hosted)
            ─────────────────────────────
  TOTAL     █████████████████░░░  177/200 (88.5%)
```

---

## Competitive Position Summary

### EyeCX WINS on:
1. **Full Autonomy** - End-to-end pipeline, no manual steps
2. **Zero Recurring Cost** - Self-hosted, no $37-184/mo fees
3. **Revenue Generation** - Built-in monetization (competitors have zero)
4. **Data Ownership** - You own everything, no vendor lock-in
5. **Deployment Pipeline** - CF Pages + Workers integrated
6. **Business Model** - Subscription lists, link sales (unique to DH)

### EyeCX GAPS:
1. **Metric Breadth** - 6 sources vs DomCop's 90+
2. **Spam Detection** - Basic vs SpamZilla's proprietary SZ Score
3. **Backlink Depth** - No Ahrefs/Moz direct integration
4. **UI/UX** - CLI-only vs polished web dashboards

---

## Gap Mitigation Plan

### Critical (P0) - Add within 30 days:
| Gap | Solution | Effort |
|-----|----------|--------|
| Spam detection | Implement SZ-style scoring based on anchor text distribution, link velocity, drop count | 2 days |
| Ahrefs integration | Add Ahrefs API (user provides key) for DR/backlinks | 1 day |
| Moz integration | Add Moz API for DA/PA | 1 day |

### Important (P1) - Add within 60 days:
| Gap | Solution | Effort |
|-----|----------|--------|
| Web dashboard | React admin panel on CF Pages | 3 days |
| More TLDs | Expand to 60+ ccTLDs | 1 day |
| Email alerts | Discord/Slack webhooks for diamonds | 0.5 day |

### Nice-to-have (P2):
| Gap | Solution | Effort |
|-----|----------|--------|
| Mobile app | PWA wrapper | 2 days |
| Backlink miner | Crawl top 100 backlinks per domain | 3 days |

---

## ROI Comparison (12-month projection)

### Competitor Stack Cost:
```
SpamZilla:     $37/mo × 12 = $444/yr
DomCop:        $98/mo × 12 = $1,176/yr
Ahrefs:       $199/mo × 12 = $2,388/yr
───────────────────────────────────
Total:                       $4,008/yr
```

### EyeCX Cost:
```
Cloudflare:           $0 (free tier)
OpenPageRank:         $0 (free API)
GitHub Actions:       $0 (free tier)
Domain registration:  ~$100/yr (10 domains)
───────────────────────────────────
Total:                $100/yr
```

### Savings: **$3,908/yr** (97.5% reduction)

---

## Unique Value Proposition

```
┌─────────────────────────────────────────────────────────────────┐
│                                                                 │
│   COMPETITORS:     Find domains → Manual review → Manual buy   │
│                                                                 │
│   EYECX:   Find → Score → Buy → Restore → Monetize     │
│                    ─────────────────────────────────────────    │
│                              FULLY AUTOMATED                    │
│                                                                 │
│   + Generate subscription revenue ($19-99/mo per customer)     │
│   + Sell link placements ($50-500/link)                        │
│   + Flip domains ($500-5000/domain)                            │
│   + Earn affiliate commissions (ongoing)                       │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## Verdict

**EyeCX v4.2 scores 177/200 (88.5%)** vs market leader SpamZilla at 89/200 (44.5%).

The 2x score advantage comes from:
- **Automation** category where competitors score 0-6 and DH scores 48
- **Business** category where competitors score 0 and DH scores 34
- **Cost** category where DH is free vs $37-184/mo

**Gap closure priority**: Add Ahrefs/Moz API integration and spam scoring algorithm to reach parity on metrics. Everything else is already ahead.
