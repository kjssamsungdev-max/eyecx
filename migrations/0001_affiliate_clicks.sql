-- Affiliate click tracking for monetization validation
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
