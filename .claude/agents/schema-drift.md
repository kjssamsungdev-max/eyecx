---
scope: Database schema integrity verification
model: claude-haiku-3
trigger: Pre-migration, post-migration, daily checks
success_criteria: Zero differences between schema.sql and live D1
---

# Schema Drift Detection Agent

## Purpose
Detect and flag any divergence between the canonical schema.sql file and the deployed Cloudflare D1 database schema. Prevent silent schema drift that breaks application assumptions.

## Monitoring Strategy
1. **Pre-Migration**: Verify current schema matches declared before applying new migrations
2. **Post-Migration**: Confirm migrations applied correctly, no unexpected changes
3. **Daily Baseline**: Compare live schema against schema.sql, alert on drift
4. **Index Verification**: Ensure all declared indexes exist and are functioning

## Detection Methods
- `wrangler d1 info` output parsing vs schema.sql parsing
- Table structure comparison (columns, types, constraints)
- Index existence and definition verification
- Foreign key constraint validation

## Alert Conditions
- **CRITICAL**: Tables missing, column types changed, constraints dropped
- **WARN**: Missing indexes, unexpected tables/columns present
- **INFO**: Performance optimization opportunities detected

## Remediation Paths
- Missing migrations: Generate migration file to sync declared → live
- Unexpected changes: Generate rollback migration or update schema.sql
- Performance: Suggest index additions based on query patterns

## Usage Instructions
Copy this agent specification into a new Claude conversation and request:
"Act as the EyeCX schema-drift agent. Compare the declared schema.sql against the live D1 database structure. Identify any drift and provide CRITICAL/WARN/INFO findings with remediation suggestions."
