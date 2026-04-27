-- EyeCX D1 Database Schema
-- Generated from production D1 on 2026-04-27.
-- Do not edit by hand — use wrangler d1 migrations going forward.
-- Initialize fresh: npx wrangler d1 execute eyecx --file=./schema.sql

-- ============ ALERTS ============

CREATE TABLE IF NOT EXISTS alerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL,
    severity TEXT NOT NULL DEFAULT 'warning',
    message TEXT NOT NULL,
    triggered_at TEXT NOT NULL DEFAULT (datetime('now')),
    resolved_at TEXT,
    resolved_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_alerts_type ON alerts(type);
CREATE INDEX IF NOT EXISTS idx_alerts_date ON alerts(triggered_at DESC);

-- ============ API KEYS ============

CREATE TABLE IF NOT EXISTS api_keys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    key_hash TEXT UNIQUE NOT NULL,
    key_prefix TEXT NOT NULL,
    label TEXT NOT NULL,
    owner_email TEXT NOT NULL,
    tier TEXT NOT NULL DEFAULT 'free',
    rate_limit_per_hour INTEGER NOT NULL DEFAULT 100,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now')),
    last_used_at TEXT,
    total_requests INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_keys_hash ON api_keys(key_hash);
CREATE INDEX IF NOT EXISTS idx_keys_active ON api_keys(active);

-- ============ AFFILIATE CLICKS ============

CREATE TABLE IF NOT EXISTS affiliate_clicks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    domain TEXT NOT NULL,
    tld TEXT NOT NULL,
    registrar TEXT NOT NULL DEFAULT 'cloudflare',
    referrer_page TEXT,
    user_id TEXT,
    clicked_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_aff_clicks_domain ON affiliate_clicks(domain);
CREATE INDEX IF NOT EXISTS idx_aff_clicks_date ON affiliate_clicks(clicked_at DESC);
CREATE INDEX IF NOT EXISTS idx_aff_clicks_registrar ON affiliate_clicks(registrar);

-- ============ API USAGE ============

CREATE TABLE IF NOT EXISTS api_usage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    key_id INTEGER NOT NULL,
    endpoint TEXT NOT NULL,
    status_code INTEGER NOT NULL,
    ts TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_usage_key_ts ON api_usage(key_id, ts DESC);

-- ============ ARTICLES ============

CREATE TABLE IF NOT EXISTS articles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    slug TEXT UNIQUE NOT NULL,
    excerpt TEXT DEFAULT '',
    body_md TEXT NOT NULL,
    author_id TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT 'News',
    tags TEXT DEFAULT '[]',
    thumbnail_url TEXT DEFAULT '',
    read_time INTEGER DEFAULT 5,
    views INTEGER DEFAULT 0,
    status TEXT DEFAULT 'draft',
    published_at TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_articles_slug ON articles(slug);
CREATE INDEX IF NOT EXISTS idx_articles_category ON articles(category);

-- ============ BULK JOBS ============

CREATE TABLE IF NOT EXISTS bulk_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_type TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued',
    params TEXT,
    result_summary TEXT,
    gh_run_id TEXT,
    created_by TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    started_at TEXT,
    completed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON bulk_jobs(status);

-- ============ COMMENTS ============

CREATE TABLE IF NOT EXISTS comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    body TEXT NOT NULL,
    author_id TEXT NOT NULL,
    parent_type TEXT NOT NULL,
    parent_id INTEGER NOT NULL,
    reply_to_id INTEGER,
    upvotes INTEGER DEFAULT 0,
    downvotes INTEGER DEFAULT 0,
    edited INTEGER DEFAULT 0,
    deleted INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    hidden INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_comments_parent ON comments(parent_type, parent_id);

-- ============ COMMUNITY USERS ============

CREATE TABLE IF NOT EXISTS community_users (
    id TEXT PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    email TEXT,
    avatar_url TEXT DEFAULT '',
    bio TEXT DEFAULT '',
    karma INTEGER DEFAULT 0,
    badges TEXT DEFAULT '[]',
    role TEXT DEFAULT 'member',
    created_at TEXT DEFAULT (datetime('now')),
    password_hash TEXT DEFAULT '',
    email_verified INTEGER DEFAULT 0,
    tier TEXT DEFAULT 'free'
);
CREATE INDEX IF NOT EXISTS idx_community_users_username ON community_users(username);

-- ============ CURATED CONTENT ============

CREATE TABLE IF NOT EXISTS curated_content (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_id TEXT NOT NULL,
    source_name TEXT NOT NULL,
    title TEXT NOT NULL,
    url TEXT NOT NULL,
    excerpt TEXT NOT NULL,
    author TEXT DEFAULT '',
    published_at TEXT NOT NULL,
    curated_at TEXT DEFAULT (datetime('now')),
    category TEXT NOT NULL,
    tags TEXT DEFAULT '[]',
    word_count INTEGER DEFAULT 0,
    engagement INTEGER DEFAULT 0,
    meta_title TEXT DEFAULT '',
    meta_description TEXT DEFAULT '',
    slug TEXT NOT NULL,
    og_image TEXT DEFAULT '',
    schema_type TEXT DEFAULT 'Article',
    quality_score INTEGER DEFAULT 0,
    status TEXT DEFAULT 'published',
    featured INTEGER DEFAULT 0,
    views INTEGER DEFAULT 0,
    archived INTEGER DEFAULT 0,
    archived_at TEXT,
    hidden INTEGER DEFAULT 0,
    extracted_at TEXT,
    categories TEXT DEFAULT '[]'
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_curated_content_url ON curated_content(url);
CREATE INDEX IF NOT EXISTS idx_curated_content_slug ON curated_content(slug);
CREATE INDEX IF NOT EXISTS idx_curated_content_status ON curated_content(status);
CREATE INDEX IF NOT EXISTS idx_curated_content_category ON curated_content(category);

-- ============ CURATED SOURCES ============

CREATE TABLE IF NOT EXISTS curated_sources (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    url TEXT NOT NULL,
    feed_url TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'rss',
    category TEXT NOT NULL,
    priority INTEGER DEFAULT 5,
    min_da INTEGER DEFAULT 40,
    enabled INTEGER DEFAULT 1,
    last_fetched_at TEXT,
    total_items INTEGER DEFAULT 0,
    items_accepted INTEGER DEFAULT 0,
    items_rejected INTEGER DEFAULT 0,
    avg_quality REAL DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    last_item_at TEXT,
    health_status TEXT DEFAULT 'healthy',
    consecutive_failures INTEGER DEFAULT 0
);

-- ============ CURATION LOGS ============

CREATE TABLE IF NOT EXISTS curation_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL,
    source_id TEXT NOT NULL,
    url TEXT DEFAULT '',
    action TEXT NOT NULL,
    reason TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now'))
);

-- ============ DAILY USAGE (legacy) ============

CREATE TABLE IF NOT EXISTS daily_usage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    date TEXT NOT NULL,
    domain_views INTEGER DEFAULT 0,
    api_calls INTEGER DEFAULT 0,
    UNIQUE(user_id, date)
);
CREATE INDEX IF NOT EXISTS idx_daily_usage_user_date ON daily_usage(user_id, date);

-- ============ DOMAIN FEEDBACK ============

CREATE TABLE IF NOT EXISTS domain_feedback (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    domain TEXT NOT NULL,
    signal TEXT NOT NULL CHECK(signal IN ('saved','dismissed','bought','passed')),
    note TEXT,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_feedback_domain ON domain_feedback(domain);

-- ============ DOMAINS ============

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
    first_seen TEXT NOT NULL DEFAULT (datetime('now')),
    score_version INTEGER DEFAULT 0,
    last_rescored_at TEXT,
    brand_score INTEGER DEFAULT 0,
    predicted_price_usd REAL,
    price_low_usd REAL,
    price_high_usd REAL,
    price_confidence TEXT,
    price_comps_count INTEGER DEFAULT 0,
    price_computed_at TEXT,
    rdap_status TEXT,
    grace_until TEXT
);
CREATE INDEX IF NOT EXISTS idx_domains_score ON domains(potential_score DESC);
CREATE INDEX IF NOT EXISTS idx_domains_tier ON domains(tier);
CREATE INDEX IF NOT EXISTS idx_domains_tld ON domains(tld);
CREATE INDEX IF NOT EXISTS idx_domains_availability ON domains(availability_status);
CREATE INDEX IF NOT EXISTS idx_domains_first_seen ON domains(first_seen DESC);

-- ============ EMAIL VERIFICATIONS ============

CREATE TABLE IF NOT EXISTS email_verifications (
    token TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL
);

-- ============ ERROR LOGS (legacy) ============

CREATE TABLE IF NOT EXISTS error_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    method TEXT NOT NULL,
    path TEXT NOT NULL,
    error_message TEXT NOT NULL,
    error_stack TEXT DEFAULT '',
    ip TEXT DEFAULT '',
    user_id TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_error_logs_created ON error_logs(created_at DESC);

-- ============ EVENTS ============

CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL,
    target TEXT,
    message TEXT NOT NULL,
    ts TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts DESC);
CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);

-- ============ INGEST REJECTIONS ============

CREATE TABLE IF NOT EXISTS ingest_rejections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    table_name TEXT NOT NULL,
    domain_or_key TEXT,
    reason TEXT NOT NULL,
    payload_snippet TEXT,
    rejected_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_rejections_date ON ingest_rejections(rejected_at DESC);

-- ============ MARKET SALES ============

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

-- ============ MUTED ALERT TYPES ============

CREATE TABLE IF NOT EXISTS muted_alert_types (
    type TEXT PRIMARY KEY,
    muted_by TEXT,
    muted_at TEXT DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL
);

-- ============ PASSWORD RESETS ============

CREATE TABLE IF NOT EXISTS password_resets (
    token TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL,
    used INTEGER DEFAULT 0
);

-- ============ PLATFORM IMPROVEMENTS (legacy) ============

CREATE TABLE IF NOT EXISTS platform_improvements (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    source_url TEXT DEFAULT '',
    source_name TEXT DEFAULT '',
    category TEXT NOT NULL DEFAULT 'feature',
    priority TEXT DEFAULT 'P2',
    keywords_matched TEXT DEFAULT '[]',
    competitor_mentioned TEXT DEFAULT '',
    status TEXT DEFAULT 'pending',
    dismissed INTEGER DEFAULT 0,
    roadmap INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_improvements_status ON platform_improvements(status);
CREATE INDEX IF NOT EXISTS idx_improvements_priority ON platform_improvements(priority);

-- ============ PURCHASE QUEUE ============

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

-- ============ SCAN HISTORY ============

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

-- ============ SCORE HISTORY ============

CREATE TABLE IF NOT EXISTS score_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    domain TEXT NOT NULL,
    old_score INTEGER NOT NULL,
    new_score INTEGER NOT NULL,
    delta INTEGER NOT NULL,
    old_tier TEXT,
    new_tier TEXT,
    base INTEGER,
    brand INTEGER,
    similarity_bonus INTEGER,
    feedback_bonus INTEGER,
    reason TEXT,
    rescored_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_history_domain ON score_history(domain);
CREATE INDEX IF NOT EXISTS idx_history_date ON score_history(rescored_at DESC);
CREATE INDEX IF NOT EXISTS idx_history_delta ON score_history(delta DESC);

-- ============ SCORING WEIGHTS ============

CREATE TABLE IF NOT EXISTS scoring_weights (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tld TEXT NOT NULL,
    signal TEXT NOT NULL,
    weight REAL NOT NULL,
    updated_at TEXT DEFAULT (datetime('now')),
    UNIQUE(tld, signal)
);

-- ============ SESSIONS ============

CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL
);

-- ============ SOURCE CANDIDATES ============

CREATE TABLE IF NOT EXISTS source_candidates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    url TEXT NOT NULL UNIQUE,
    feed_url TEXT,
    name TEXT,
    discovered_from TEXT,
    discovered_at TEXT DEFAULT (datetime('now')),
    status TEXT DEFAULT 'pending',
    reviewed_by TEXT,
    reviewed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_candidates_status ON source_candidates(status);

-- ============ SOURCE METRICS ============

CREATE TABLE IF NOT EXISTS source_metrics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_id TEXT NOT NULL,
    date TEXT NOT NULL,
    items_found INTEGER DEFAULT 0,
    items_accepted INTEGER DEFAULT 0,
    items_rejected INTEGER DEFAULT 0,
    avg_quality REAL DEFAULT 0,
    avg_engagement REAL DEFAULT 0,
    UNIQUE(source_id, date)
);

-- ============ SUBSCRIPTION DELIVERIES ============

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

-- ============ THREADS ============

CREATE TABLE IF NOT EXISTS threads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    author_id TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT 'General Discussion',
    upvotes INTEGER DEFAULT 0,
    downvotes INTEGER DEFAULT 0,
    reply_count INTEGER DEFAULT 0,
    views INTEGER DEFAULT 0,
    pinned INTEGER DEFAULT 0,
    locked INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    hidden INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_threads_category ON threads(category);

-- ============ VOTES ============

CREATE TABLE IF NOT EXISTS votes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    target_type TEXT NOT NULL,
    target_id INTEGER NOT NULL,
    value INTEGER NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(user_id, target_type, target_id)
);
CREATE INDEX IF NOT EXISTS idx_votes_target ON votes(target_type, target_id);

-- ============ WAITLIST ============

CREATE TABLE IF NOT EXISTS waitlist (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    plan TEXT DEFAULT 'pro',
    price TEXT DEFAULT '49',
    source TEXT DEFAULT 'upgrade_modal',
    created_at TEXT DEFAULT (datetime('now'))
);

-- ============ WEIGHT HISTORY ============

CREATE TABLE IF NOT EXISTS weight_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tld TEXT NOT NULL,
    signal TEXT NOT NULL,
    old_weight REAL NOT NULL,
    new_weight REAL NOT NULL,
    delta REAL NOT NULL,
    reason TEXT,
    changed_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_wh_tld ON weight_history(tld);
CREATE INDEX IF NOT EXISTS idx_wh_date ON weight_history(changed_at DESC);
