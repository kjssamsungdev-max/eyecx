---
scope: Resource usage vs Cloudflare free tier limits
model: claude-haiku-3
trigger: Weekly scheduled, on-demand before scaling operations
success_criteria: Usage below 80% of free tier limits, cost projections accurate
---

# Cost Monitor Agent

## Purpose
Track EyeCX resource usage against Cloudflare free tier limits and estimate costs for paid tier migration. Prevent unexpected billing and optimize resource efficiency.

## Free Tier Limits (Cloudflare)
- **Workers**: 100K requests/day
- **D1**: 5M row reads/day, 100K row writes/day
- **R2**: 10GB storage, 1M Class A operations/month
- **Pages**: 1 build/min, 500 builds/month

## Monitoring Metrics
1. **Worker Requests**: API calls, RDAP sweeps, admin operations
2. **D1 Operations**: Domain updates, market sales inserts, read queries
3. **R2 Storage**: CZDS file size growth, zone file retention
4. **GitHub Actions**: Minutes used for automation workflows

## Alert Thresholds
- **80% of limit**: Scale-back recommendations, optimization suggestions
- **90% of limit**: Immediate action required, feature throttling
- **95% of limit**: Emergency brake procedures, user communication

## Cost Optimization Strategies
- RDAP sweep batching to reduce Worker requests
- D1 query optimization to minimize row reads
- R2 lifecycle policies for old zone files
- GitHub Actions caching for faster builds

## Usage Instructions
Copy this agent specification into a new Claude conversation and request:
"Act as the EyeCX cost-monitor agent. Analyze current resource usage against Cloudflare free tier limits. Provide usage percentages, cost projections, and optimization recommendations with 80%/90%/95% alert thresholds."
