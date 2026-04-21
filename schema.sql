-- EyeCX D1 Database Schema
-- Initialize with: npx wrangler d1 execute eyecx --file=./schema.sql

-- Main domains table
CREATE TABLE IF NOT EXISTS domains (
    domain TEXT PRIMARY KEY,
    tld TEXT NOT NULL,
    potential_score INTEGER DEFAULT 0,
    tier TEXT NOT NULL,
    estimated_flip_value REAL DEFAULT 0,
    page_rank REAL,
    wayback_snapshots INTEGER DEFAULT 0,
    estimated_age_years REAL,
    backlinks INTEGER DEFAULT 0,
    majestic_rank INTEGER,
    tranco_rank INTEGER,
    availability_status TEXT DEFAULT 'unknown',
    registration_price REAL,
    action_taken TEXT,
    purchased_at TEXT,
    source TEXT NOT NULL,
    first_seen TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_domains_score ON domains(potential_score DESC);
CREATE INDEX IF NOT EXISTS idx_domains_tier ON domains(tier);
CREATE INDEX IF NOT EXISTS idx_domains_tld ON domains(tld);
CREATE INDEX IF NOT EXISTS idx_domains_availability ON domains(availability_status);
CREATE INDEX IF NOT EXISTS idx_domains_first_seen ON domains(first_seen DESC);

-- Daily scan history
CREATE TABLE IF NOT EXISTS scan_history (
    scan_date TEXT PRIMARY KEY,
    total_scanned INTEGER DEFAULT 0,
    total_qualified INTEGER DEFAULT 0,
    diamonds INTEGER DEFAULT 0,
    golds INTEGER DEFAULT 0,
    silvers INTEGER DEFAULT 0,
    bronzes INTEGER DEFAULT 0,
    duration_sec INTEGER DEFAULT 0,
    seeds_used INTEGER DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Subscription delivery tracking
CREATE TABLE IF NOT EXISTS subscription_deliveries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    subscriber_id TEXT NOT NULL,
    tier TEXT NOT NULL,
    domain_count INTEGER DEFAULT 0,
    domains_json TEXT,
    delivered_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_deliveries_subscriber ON subscription_deliveries(subscriber_id);
CREATE INDEX IF NOT EXISTS idx_deliveries_date ON subscription_deliveries(delivered_at DESC);

-- Purchase queue
CREATE TABLE IF NOT EXISTS purchase_queue (
    domain TEXT PRIMARY KEY,
    score INTEGER NOT NULL,
    tier TEXT NOT NULL,
    estimated_price REAL,
    status TEXT DEFAULT 'pending',
    queued_at TEXT NOT NULL DEFAULT (datetime('now')),
    processed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_purchase_status ON purchase_queue(status);
CREATE INDEX IF NOT EXISTS idx_purchase_score ON purchase_queue(score DESC);

-- Domain feedback (admin learning loop)
CREATE TABLE IF NOT EXISTS domain_feedback (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    domain TEXT NOT NULL,
    signal TEXT NOT NULL CHECK(signal IN ('saved','dismissed','bought','passed')),
    note TEXT,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_feedback_domain ON domain_feedback(domain);

-- Note: curated_content table has additional columns added via ALTER TABLE:
-- hidden INTEGER DEFAULT 0  (added 2026-04-21)
-- extracted_at TEXT  (added 2026-04-21)
-- quality_score already existed in original schema

-- Note: domains table has additional columns added via ALTER TABLE:
-- score_version INTEGER DEFAULT 0  (added 2026-04-21)
-- last_rescored_at TEXT  (added 2026-04-21)
-- brand_score INTEGER DEFAULT 0  (added 2026-04-21)

-- Market sales (extracted from curated content)
CREATE TABLE IF NOT EXISTS market_sales (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    domain TEXT NOT NULL,
    tld TEXT NOT NULL,
    sale_price_usd REAL NOT NULL,
    sale_date TEXT,
    source_url TEXT NOT NULL,
    source_name TEXT,
    extracted_at TEXT DEFAULT (datetime('now')),
    UNIQUE(domain, source_url)
);

CREATE INDEX IF NOT EXISTS idx_sales_tld ON market_sales(tld);
CREATE INDEX IF NOT EXISTS idx_sales_price ON market_sales(sale_price_usd DESC);
