/**
 * EyeCX API - Cloudflare Worker
 * 
 * Endpoints:
 * - GET /api/domains?tier=gold&limit=100 - Get domains by tier
 * - GET /api/domain/:domain - Get single domain details
 * - GET /api/stats - Get daily stats
 * - POST /api/subscribe - Generate subscription list
 * - POST /api/webhook/purchase - Handle purchase callbacks
 * 
 * Auth: Bearer token in Authorization header
 */

// Bindings
interface Env {
  DB: D1Database;
  ZONES: R2Bucket;
  API_SECRET: string;
  RESEND_API_KEY: string;
  CLOUDFLARE_API_TOKEN: string;
  CLOUDFLARE_ACCOUNT_ID: string;
  CZDS_USERNAME: string;
  CZDS_PASSWORD: string;
  GITHUB_TOKEN: string;
}

interface SessionUser {
  id: string;
  username: string;
  email: string;
  role: string;
  tier: string;
  email_verified: number;
  avatar_url: string;
  bio: string;
  karma: number;
  badges: string;
  created_at: string;
}

interface DomainRecord {
  domain: string;
  tld: string;
  potential_score: number;
  tier: string;
  estimated_flip_value: number;
  page_rank: number | null;
  wayback_snapshots: number;
  estimated_age_years: number | null;
  backlinks: number;
  majestic_rank: number | null;
  tranco_rank: number | null;
  availability_status: string;
  first_seen: string;
}

// Auth middleware
function authenticate(request: Request, env: Env): boolean {
  const auth = request.headers.get('Authorization');
  if (!auth || !auth.startsWith('Bearer ')) {
    return false;
  }
  const token = auth.slice(7);
  return token === env.API_SECRET;
}

// CORS headers
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, PATCH, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

// Response helpers
function json(data: any, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders,
    },
  });
}

function error(message: string, status = 400): Response {
  return json({ error: message }, status);
}

// ============ PASSWORD HASHING ============

function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function hashPassword(password: string): Promise<string> {
  const salt = toHex(crypto.getRandomValues(new Uint8Array(16)).buffer);
  const data = new TextEncoder().encode(salt + password);
  const hash = toHex(await crypto.subtle.digest('SHA-256', data));
  return `${salt}:${hash}`;
}

async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [salt, hash] = stored.split(':');
  if (!salt || !hash) return false;
  const data = new TextEncoder().encode(salt + password);
  const computed = toHex(await crypto.subtle.digest('SHA-256', data));
  return computed === hash;
}

function generateToken(): string {
  return toHex(crypto.getRandomValues(new Uint8Array(32)).buffer);
}

// ============ SESSION AUTH ============

const USER_COLUMNS = 'id, username, email, role, tier, email_verified, avatar_url, bio, karma, badges, created_at';

async function authenticateSession(request: Request, env: Env): Promise<SessionUser | null> {
  const auth = request.headers.get('Authorization');
  if (!auth || !auth.startsWith('Bearer ')) return null;
  const token = auth.slice(7);

  const session = await env.DB.prepare(
    'SELECT user_id FROM sessions WHERE token = ? AND expires_at > datetime(\'now\')'
  ).bind(token).first<{ user_id: string }>();
  if (!session) return null;

  const user = await env.DB.prepare(
    `SELECT ${USER_COLUMNS} FROM community_users WHERE id = ?`
  ).bind(session.user_id).first<SessionUser>();
  return user || null;
}

async function requireSession(request: Request, env: Env): Promise<[SessionUser | null, Response | null]> {
  const user = await authenticateSession(request, env);
  if (!user) return [null, error('Not authenticated', 401)];
  return [user, null];
}

async function requireAdmin(request: Request, env: Env): Promise<[SessionUser | null, Response | null]> {
  const user = await authenticateSession(request, env);
  if (!user) return [null, error('Not authenticated', 401)];
  if (user.role !== 'admin') return [null, error('Admin required', 403)];
  return [user, null];
}

// ============ EMAIL VIA RESEND ============

async function sendEmail(env: Env, to: string, subject: string, html: string): Promise<boolean> {
  if (!env.RESEND_API_KEY) return false;
  try {
    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'EyeCX <noreply@eyecx.com>',
        to,
        subject,
        html,
      }),
    });
    return resp.ok;
  } catch {
    return false;
  }
}

// Target TLDs to download from CZDS
const CZDS_TLDS = ['xyz', 'info', 'biz', 'net', 'org'];

// Main handler
export default {
  // Cron triggers: CZDS at 1 AM UTC, RSS curation every 6 hours
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    const hour = new Date().getUTCHours();

    // RSS curation runs every 6 hours
    try {
      console.log('RSS curation starting...');
      const result = await runRssCuration(env);
      console.log(`RSS curation done: ${result.inserted} new, ${result.errors} errors`);
    } catch (e) {
      console.error('RSS curation error:', e);
    }

    // Sales extraction runs after curation
    try {
      console.log('Sales extraction starting...');
      const sales = await runSalesExtraction(env);
      console.log(`Sales extraction done: ${sales.extracted} sales from ${sales.processed} articles`);
    } catch (e) {
      console.error('Sales extraction error:', e);
    }

    // Nightly rescore at 4 AM UTC
    if (hour === 4) {
      try {
        console.log('Nightly rescore starting...');
        const result = await runDomainRescore(env);
        console.log(`Rescore done: ${result.total} domains, avg delta: ${result.avg_delta}`);

        // Log to scan_history
        await env.DB.prepare(
          `INSERT OR REPLACE INTO scan_history (scan_date, total_scanned, total_qualified, diamonds, golds, silvers, duration_sec)
           VALUES (DATE('now'), ?, ?, 0, 0, 0, 0)`
        ).bind(result.total, result.total).run();
      } catch (e) {
        console.error('Nightly rescore error:', e);
      }
    }

    // Self-tuning at 5 AM UTC (after rescore at 4 AM)
    if (hour === 5) {
      try {
        console.log('Self-tuning starting...');
        const result = await runSelfTuning(env);
        console.log(`Self-tuning done: ${result.tlds_processed} TLDs, ${result.changes} weight changes, ${result.tlds_skipped} skipped (insufficient data)`);
      } catch (e) {
        console.error('Self-tuning error:', e);
      }
    }

    // Source health check + alerts at 6 AM
    if (hour === 6) {
      try {
        const health = await runSourceHealthCheck(env);
        console.log(`Health check: ${health.healthy} healthy, ${health.stale} stale, ${health.dead} dead`);
        const alerts = await runAlertCheck(env);
        console.log(`Alert check: ${alerts.alerts_created} new alerts`);
        const discovery = await runSourceDiscovery(env);
        console.log(`Discovery: ${discovery.scanned} sites scanned, ${discovery.candidates} new candidates`);
      } catch (e) {
        console.error('Health/alerts/discovery error:', e);
      }
    }

    // CZDS only at 1 AM (note: ICANN blocks CF Worker IPs, so this is a no-op
    // in practice — CZDS downloads happen via GitHub Actions instead)
    if (hour === 1 && env.CZDS_USERNAME && env.CZDS_PASSWORD) {
      try {
        const token = await czdsAuthenticate(env.CZDS_USERNAME, env.CZDS_PASSWORD);
        if (token) {
          const approvedZones = await czdsGetApprovedZones(token);
          const today = new Date().toISOString().split('T')[0];
          const targetZones = approvedZones.filter(url => {
            const tld = url.split('/').pop()?.replace('.zone', '') || '';
            return CZDS_TLDS.includes(tld);
          });
          for (const zoneUrl of targetZones) {
            const tld = zoneUrl.split('/').pop()?.replace('.zone', '') || '';
            const r2Key = `raw/${tld}/${tld}_${today}.zone.gz`;
            if (!(await env.ZONES.head(r2Key))) {
              await czdsStreamToR2(zoneUrl, token, r2Key, env.ZONES);
            }
          }
        }
      } catch (e) {
        console.error('CZDS cron error:', e);
      }
    }
  },

  async fetch(request: Request, env: Env): Promise<Response> {
    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    // Public endpoints (no auth)
    if (path === '/api/health') {
      return json({ status: 'ok', timestamp: new Date().toISOString() });
    }

    // POST /api/waitlist - Public waitlist signup
    if (path === '/api/waitlist' && request.method === 'POST') {
      try {
        const { email } = await request.json() as { email: string };
        if (!email || !email.includes('@')) {
          return error('Valid email required', 400);
        }
        await env.DB.prepare(
          'INSERT OR IGNORE INTO waitlist (email, source, created_at) VALUES (?, ?, datetime(\'now\'))'
        ).bind(email, 'website').run();
        return json({ ok: true });
      } catch (e) {
        return error('Failed to join waitlist', 500);
      }
    }

    // ============ AUTH ROUTES (public) ============

    if (path === '/api/auth/register' && request.method === 'POST') {
      return await handleRegister(request, env);
    }
    if (path === '/api/auth/login' && request.method === 'POST') {
      return await handleLogin(request, env);
    }
    if (path === '/api/auth/logout' && request.method === 'POST') {
      return await handleLogout(request, env);
    }
    if (path === '/api/auth/me' && request.method === 'GET') {
      return await handleMe(request, env);
    }
    if (path === '/api/auth/verify-email' && request.method === 'GET') {
      return await handleVerifyEmail(url, env);
    }
    if (path === '/api/auth/forgot-password' && request.method === 'POST') {
      return await handleForgotPassword(request, env);
    }
    if (path === '/api/auth/reset-password' && request.method === 'POST') {
      return await handleResetPassword(request, env);
    }

    // ============ PUBLIC CONTENT ROUTES ============

    if (path === '/api/articles' && request.method === 'GET') {
      return await listArticles(url, env);
    }
    if (path.startsWith('/api/articles/') && request.method === 'GET') {
      const slug = path.split('/')[3];
      return await getArticle(slug, env);
    }
    if (path === '/api/curated' && request.method === 'GET') {
      return await listCurated(url, env);
    }
    if (path.match(/^\/api\/curated\/\d+$/) && request.method === 'GET') {
      const id = parseInt(path.split('/')[3]);
      return await getCuratedById(id, env);
    }
    // GET /api/domain/:domain/history - Score history for a domain
    if (path.match(/^\/api\/domain\/[^/]+\/history$/) && request.method === 'GET') {
      const domain = path.split('/')[3];
      const limit = Math.min(parseInt(url.searchParams.get('limit') || '50'), 100);
      const rows = await env.DB.prepare(
        `SELECT old_score, new_score, delta, old_tier, new_tier, base, brand,
         similarity_bonus, feedback_bonus, reason, rescored_at
         FROM score_history WHERE domain = ? ORDER BY rescored_at DESC LIMIT ?`
      ).bind(domain, limit).all();
      return json({ domain, history: rows.results || [] });
    }

    // GET /api/domain/:domain/comparables - Comparable market sales
    if (path.match(/^\/api\/domain\/[^/]+\/comparables$/) && request.method === 'GET') {
      const domain = path.split('/')[3];
      const tld = '.' + domain.split('.').pop();
      const nameLen = domain.split('.')[0].length;

      const rows = await env.DB.prepare(
        `SELECT domain, sale_price_usd, sale_date, source_name, extracted_at
         FROM market_sales WHERE tld = ?
         AND LENGTH(REPLACE(domain, tld, '')) - 1 BETWEEN ? AND ?
         ORDER BY sale_price_usd DESC LIMIT 5`
      ).bind(tld, nameLen - 2, nameLen + 2).all();

      const stats = await env.DB.prepare(
        `SELECT AVG(sale_price_usd) as avg_price, COUNT(*) as count
         FROM market_sales WHERE tld = ?
         AND LENGTH(REPLACE(domain, tld, '')) - 1 BETWEEN ? AND ?`
      ).bind(tld, nameLen - 2, nameLen + 2).first<{ avg_price: number; count: number }>();

      return json({
        domain, tld, name_length: nameLen,
        avg_price: Math.round(stats?.avg_price || 0),
        comparable_count: stats?.count || 0,
        sales: rows.results || [],
      });
    }

    if (path === '/api/threads' && request.method === 'GET') {
      return await listThreads(url, env);
    }
    if (path.match(/^\/api\/threads\/\d+$/) && request.method === 'GET') {
      const id = parseInt(path.split('/')[3]);
      return await getThread(id, env);
    }
    if (path.match(/^\/api\/threads\/\d+\/comments$/) && request.method === 'GET') {
      const id = parseInt(path.split('/')[3]);
      return await listComments('thread', id, url, env);
    }

    // ============ SESSION-AUTHED COMMUNITY ROUTES ============

    if (path === '/api/threads' && request.method === 'POST') {
      const [user, err] = await requireSession(request, env);
      if (err) return err;
      return await createThread(request, user!, env);
    }
    if (path.match(/^\/api\/threads\/\d+\/comments$/) && request.method === 'POST') {
      const [user, err] = await requireSession(request, env);
      if (err) return err;
      const id = parseInt(path.split('/')[3]);
      return await createComment(request, user!, 'thread', id, env);
    }
    if (path === '/api/votes' && request.method === 'POST') {
      const [user, err] = await requireSession(request, env);
      if (err) return err;
      return await handleVote(request, user!, env);
    }

    // ============ ADMIN CONTENT ROUTES ============

    if (path === '/api/articles' && request.method === 'POST') {
      const [user, err] = await requireAdmin(request, env);
      if (err) return err;
      return await createArticle(request, user!, env);
    }
    if (path.startsWith('/api/articles/') && request.method === 'PUT') {
      const [user, err] = await requireAdmin(request, env);
      if (err) return err;
      const slug = path.split('/')[3];
      return await updateArticle(slug, request, env);
    }
    if (path === '/api/admin/users' && request.method === 'GET') {
      const [user, err] = await requireAdmin(request, env);
      if (err) return err;
      return await listUsers(env);
    }
    if (path === '/api/admin/stats' && request.method === 'GET') {
      const [user, err] = await requireAdmin(request, env);
      if (err) return err;
      return await adminStats(env);
    }

    // POST /api/admin/feedback - Record domain feedback
    if (path === '/api/admin/feedback' && request.method === 'POST') {
      const [user, err] = await requireAdmin(request, env);
      if (err) return err;
      const { domain, signal, note } = await request.json() as { domain: string; signal: string; note?: string };
      if (!domain || !signal) return error('domain and signal required');
      if (!['saved', 'dismissed', 'bought', 'passed'].includes(signal)) return error('Invalid signal');
      await env.DB.prepare(
        'INSERT INTO domain_feedback (domain, signal, note, created_by) VALUES (?, ?, ?, ?)'
      ).bind(domain, signal, note || null, user!.id).run();
      return json({ ok: true, domain, signal });
    }

    // GET /api/admin/feedback/summary - Feedback summary
    if (path === '/api/admin/feedback/summary' && request.method === 'GET') {
      const [user, err] = await requireAdmin(request, env);
      if (err) return err;
      const counts = await env.DB.prepare(
        'SELECT signal, COUNT(*) as count FROM domain_feedback GROUP BY signal'
      ).all();
      const saved = await env.DB.prepare(
        `SELECT f.domain, d.potential_score, d.tier, d.estimated_flip_value, d.availability_status
         FROM domain_feedback f LEFT JOIN domains d ON f.domain = d.domain
         WHERE f.signal = 'saved' AND f.domain NOT IN (SELECT domain FROM domain_feedback WHERE signal = 'bought')
         ORDER BY f.created_at DESC LIMIT 20`
      ).all();
      return json({ counts: counts.results || [], saved_not_bought: saved.results || [] });
    }

    // POST /api/admin/curation/run - Manual trigger RSS curation
    if (path === '/api/admin/curation/run' && request.method === 'POST') {
      const [user, err] = await requireAdmin(request, env);
      if (err) return err;
      const result = await runRssCuration(env);
      return json(result);
    }

    // POST /api/admin/curated/:id/hide - Hide a curated item
    if (path.match(/^\/api\/admin\/curated\/\d+\/hide$/) && request.method === 'POST') {
      const [user, err] = await requireAdmin(request, env);
      if (err) return err;
      const id = parseInt(path.split('/')[4]);
      await env.DB.prepare('UPDATE curated_content SET hidden = 1 WHERE id = ?').bind(id).run();
      return json({ ok: true, id, hidden: true });
    }

    // POST /api/admin/curated/rescore - Rescore all curated content
    if (path === '/api/admin/curated/rescore' && request.method === 'POST') {
      const [user, err] = await requireAdmin(request, env);
      if (err) return err;
      const rows = await env.DB.prepare(
        'SELECT id, title, excerpt, published_at, category, source_name FROM curated_content'
      ).all<{ id: number; title: string; excerpt: string; published_at: string; category: string; source_name: string }>();
      let updated = 0;
      for (const row of (rows.results || [])) {
        const qs = computeQualityScore(row.title, row.excerpt, row.published_at, row.category, row.source_name);
        await env.DB.prepare('UPDATE curated_content SET quality_score = ? WHERE id = ?').bind(qs, row.id).run();
        updated++;
      }
      return json({ ok: true, updated });
    }

    // POST /api/admin/curated/recategorize - Classify curated content (batched)
    if (path === '/api/admin/curated/recategorize' && request.method === 'POST') {
      const [user, err] = await requireAdmin(request, env);
      if (err) return err;
      // Process only rows without categories (or with empty [])
      const rows = await env.DB.prepare(
        "SELECT id, title, excerpt FROM curated_content WHERE categories IS NULL OR categories = '[]' LIMIT 300"
      ).all<{ id: number; title: string; excerpt: string }>();
      let updated = 0;
      const dist: Record<string, number> = {};
      for (const row of (rows.results || [])) {
        const cats = classifyContent(row.title, row.excerpt);
        await env.DB.prepare('UPDATE curated_content SET categories = ? WHERE id = ?')
          .bind(JSON.stringify(cats), row.id).run();
        updated++;
        for (const c of cats) dist[c] = (dist[c] || 0) + 1;
      }
      const remaining = await env.DB.prepare(
        "SELECT COUNT(*) as c FROM curated_content WHERE categories IS NULL OR categories = '[]'"
      ).first<{ c: number }>();
      return json({ ok: true, updated, remaining: remaining?.c || 0, distribution: dist });
    }

    // POST /api/admin/rescore - Reweighted domain scoring
    if (path === '/api/admin/rescore' && request.method === 'POST') {
      const [user, err] = await requireAdmin(request, env);
      if (err) return err;
      const result = await runDomainRescore(env);
      return json(result);
    }

    // GET /api/admin/threads - Thread moderation list
    if (path === '/api/admin/threads' && request.method === 'GET') {
      const [user, err] = await requireAdmin(request, env);
      if (err) return err;
      const threads = await env.DB.prepare(
        `SELECT t.id, t.title, t.author_id, u.username, t.created_at, t.views, t.category, t.hidden,
         t.reply_count, t.upvotes, t.downvotes
         FROM threads t LEFT JOIN community_users u ON u.id = t.author_id
         ORDER BY t.created_at DESC LIMIT 100`
      ).all();
      const comments = await env.DB.prepare(
        `SELECT c.id, c.body, c.parent_id, c.created_at, c.hidden, u.username,
         t.title as thread_title
         FROM comments c
         LEFT JOIN community_users u ON u.id = c.author_id
         LEFT JOIN threads t ON c.parent_type = 'thread' AND c.parent_id = t.id
         WHERE c.deleted = 0 ORDER BY c.created_at DESC LIMIT 20`
      ).all();
      return json({ threads: threads.results || [], recent_comments: comments.results || [] });
    }

    // POST /api/admin/threads/:id/hide - Hide a thread
    if (path.match(/^\/api\/admin\/threads\/\d+\/hide$/) && request.method === 'POST') {
      const [user, err] = await requireAdmin(request, env);
      if (err) return err;
      const id = parseInt(path.split('/')[4]);
      await env.DB.prepare('UPDATE threads SET hidden = 1 WHERE id = ?').bind(id).run();
      return json({ ok: true, id, hidden: true });
    }

    // DELETE /api/admin/comments/:id - Soft-hide a comment
    if (path.match(/^\/api\/admin\/comments\/\d+$/) && request.method === 'DELETE') {
      const [user, err] = await requireAdmin(request, env);
      if (err) return err;
      const id = parseInt(path.split('/')[4]);
      await env.DB.prepare('UPDATE comments SET hidden = 1 WHERE id = ?').bind(id).run();
      return json({ ok: true, id, hidden: true });
    }

    // POST /api/admin/sales/extract - Run sales extraction
    if (path === '/api/admin/sales/extract' && request.method === 'POST') {
      const [user, err] = await requireAdmin(request, env);
      if (err) return err;
      const result = await runSalesExtraction(env);
      return json(result);
    }

    // GET /api/admin/sales/stats - Sales intelligence
    if (path === '/api/admin/sales/stats' && request.method === 'GET') {
      const [user, err] = await requireAdmin(request, env);
      if (err) return err;
      const totals = await env.DB.prepare(
        'SELECT COUNT(*) as total, SUM(sale_price_usd) as sum_price, AVG(sale_price_usd) as avg_price FROM market_sales'
      ).first<{ total: number; sum_price: number; avg_price: number }>();
      const top10 = await env.DB.prepare(
        'SELECT domain, tld, sale_price_usd, source_name, extracted_at FROM market_sales ORDER BY sale_price_usd DESC LIMIT 10'
      ).all();
      const byTld = await env.DB.prepare(
        'SELECT tld, COUNT(*) as count, AVG(sale_price_usd) as avg_price FROM market_sales GROUP BY tld ORDER BY count DESC'
      ).all();
      const recent = await env.DB.prepare(
        'SELECT domain, tld, sale_price_usd, source_name, extracted_at FROM market_sales ORDER BY extracted_at DESC LIMIT 20'
      ).all();
      return json({
        total_sales: totals?.total || 0,
        sum_price: Math.round(totals?.sum_price || 0),
        avg_price: Math.round(totals?.avg_price || 0),
        top_10: top10.results || [],
        by_tld: byTld.results || [],
        recent_extractions: recent.results || [],
      });
    }

    // POST /api/admin/scan/trigger - Trigger daily scan via GitHub Actions
    if (path === '/api/admin/scan/trigger' && request.method === 'POST') {
      const [user, err] = await requireAdmin(request, env);
      if (err) return err;
      if (!env.GITHUB_TOKEN) {
        return json({ ok: false, error: 'GITHUB_TOKEN not configured', github_status: 0, github_body: '' }, 400);
      }
      try {
        const ghUrl = 'https://api.github.com/repos/kjssamsungdev-max/eyecx/actions/workflows/daily-scan.yml/dispatches';
        const resp = await fetch(ghUrl, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${env.GITHUB_TOKEN}`,
            'Accept': 'application/vnd.github.v3+json',
            'User-Agent': 'EyeCX-Worker',
          },
          body: JSON.stringify({ ref: 'main' }),
        });
        if (resp.status === 204) {
          return json({ ok: true, triggered_at: new Date().toISOString(), github_status: 204 });
        }
        const body = await resp.text();
        return json({ ok: false, error: 'GitHub API rejected request', github_status: resp.status, github_body: body.slice(0, 500) });
      } catch (e) {
        return json({ ok: false, error: `Network error: ${e}`, github_status: 0, github_body: '' }, 500);
      }
    }

    // GET /api/scoring/weights - Public: current scoring weights
    if (path === '/api/scoring/weights' && request.method === 'GET') {
      const rows = await env.DB.prepare('SELECT tld, signal, weight FROM scoring_weights ORDER BY tld, signal').all();
      return json({ weights: rows.results || [] });
    }

    // POST /api/admin/scoring/tune - Run self-tuning
    if (path === '/api/admin/scoring/tune' && request.method === 'POST') {
      const [user, err] = await requireAdmin(request, env);
      if (err) return err;
      const result = await runSelfTuning(env);
      return json(result);
    }

    // GET /api/admin/scoring/history - Weight change history
    if (path === '/api/admin/scoring/history' && request.method === 'GET') {
      const [user, err] = await requireAdmin(request, env);
      if (err) return err;
      const rows = await env.DB.prepare(
        'SELECT tld, signal, old_weight, new_weight, delta, reason, changed_at FROM weight_history ORDER BY changed_at DESC LIMIT 50'
      ).all();
      return json({ changes: rows.results || [] });
    }

    // POST /api/admin/scoring/reset - Reset weights to defaults
    if (path === '/api/admin/scoring/reset' && request.method === 'POST') {
      const [user, err] = await requireAdmin(request, env);
      if (err) return err;
      await env.DB.prepare("DELETE FROM scoring_weights WHERE tld != '*'").run();
      return json({ ok: true, message: 'Per-TLD overrides cleared, defaults restored' });
    }

    // GET /api/admin/sources/health - Source health dashboard
    if (path === '/api/admin/sources/health' && request.method === 'GET') {
      const [user, err] = await requireAdmin(request, env);
      if (err) return err;
      const sources = await env.DB.prepare(
        `SELECT id, name, feed_url, enabled, health_status, last_fetched_at, last_item_at,
         consecutive_failures, total_items, items_accepted, items_rejected
         FROM curated_sources ORDER BY health_status DESC, name ASC`
      ).all();
      return json({ sources: sources.results || [] });
    }

    // POST /api/admin/sources/check-health - Manual health check
    if (path === '/api/admin/sources/check-health' && request.method === 'POST') {
      const [user, err] = await requireAdmin(request, env);
      if (err) return err;
      const result = await runSourceHealthCheck(env);
      return json(result);
    }

    // POST /api/admin/sources/:id/enable - Re-enable a source
    if (path.match(/^\/api\/admin\/sources\/[^/]+\/enable$/) && request.method === 'POST') {
      const [user, err] = await requireAdmin(request, env);
      if (err) return err;
      const id = path.split('/')[4];
      await env.DB.prepare(
        "UPDATE curated_sources SET enabled = 1, health_status = 'healthy', consecutive_failures = 0 WHERE id = ?"
      ).bind(id).run();
      return json({ ok: true, id, enabled: true });
    }

    // GET /api/admin/alerts - Active alerts
    // GET /api/admin/rejections - Recent ingest rejections
    if (path === '/api/admin/rejections' && request.method === 'GET') {
      const [user, err] = await requireAdmin(request, env);
      if (err) return err;
      const rows = await env.DB.prepare(
        'SELECT table_name, domain_or_key, reason, payload_snippet, rejected_at FROM ingest_rejections ORDER BY rejected_at DESC LIMIT 50'
      ).all();
      const counts = await env.DB.prepare(
        'SELECT table_name, COUNT(*) as c FROM ingest_rejections GROUP BY table_name'
      ).all();
      return json({ rejections: rows.results || [], counts: counts.results || [] });
    }

    if (path === '/api/admin/alerts' && request.method === 'GET') {
      const [user, err] = await requireAdmin(request, env);
      if (err) return err;
      const active = await env.DB.prepare(
        'SELECT * FROM alerts WHERE resolved_at IS NULL ORDER BY triggered_at DESC LIMIT 20'
      ).all();
      const resolved = await env.DB.prepare(
        'SELECT * FROM alerts WHERE resolved_at IS NOT NULL ORDER BY resolved_at DESC LIMIT 10'
      ).all();
      return json({ active: active.results || [], resolved: resolved.results || [] });
    }

    // POST /api/admin/alerts/check - Manual alert check
    if (path === '/api/admin/alerts/check' && request.method === 'POST') {
      const [user, err] = await requireAdmin(request, env);
      if (err) return err;
      const result = await runAlertCheck(env);
      return json(result);
    }

    // POST /api/admin/alerts/:id/resolve - Resolve an alert
    if (path.match(/^\/api\/admin\/alerts\/\d+\/resolve$/) && request.method === 'POST') {
      const [user, err] = await requireAdmin(request, env);
      if (err) return err;
      const id = parseInt(path.split('/')[4]);
      await env.DB.prepare(
        "UPDATE alerts SET resolved_at = datetime('now'), resolved_by = ? WHERE id = ?"
      ).bind(user!.id, id).run();
      return json({ ok: true, id, resolved: true });
    }

    // GET /api/admin/sources/candidates - Source discovery candidates
    if (path === '/api/admin/sources/candidates' && request.method === 'GET') {
      const [user, err] = await requireAdmin(request, env);
      if (err) return err;
      const rows = await env.DB.prepare(
        'SELECT * FROM source_candidates WHERE status = ? ORDER BY discovered_at DESC LIMIT 50'
      ).bind(url.searchParams.get('status') || 'pending').all();
      return json({ candidates: rows.results || [] });
    }

    // POST /api/admin/sources/discover - Manual discovery run
    if (path === '/api/admin/sources/discover' && request.method === 'POST') {
      const [user, err] = await requireAdmin(request, env);
      if (err) return err;
      const result = await runSourceDiscovery(env);
      return json(result);
    }

    // POST /api/admin/sources/candidates/:id/approve - Approve a candidate
    if (path.match(/^\/api\/admin\/sources\/candidates\/\d+\/approve$/) && request.method === 'POST') {
      const [user, err] = await requireAdmin(request, env);
      if (err) return err;
      const id = parseInt(path.split('/')[5]);
      const cand = await env.DB.prepare('SELECT * FROM source_candidates WHERE id = ?').bind(id).first<any>();
      if (!cand) return error('Candidate not found', 404);
      const srcId = cand.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 30);
      await env.DB.prepare(
        `INSERT OR IGNORE INTO curated_sources (id, name, url, feed_url, type, category, enabled)
         VALUES (?, ?, ?, ?, 'rss', 'Domain News', 1)`
      ).bind(srcId, cand.name, cand.url, cand.feed_url).run();
      await env.DB.prepare("UPDATE source_candidates SET status = 'approved', reviewed_by = ?, reviewed_at = datetime('now') WHERE id = ?")
        .bind(user!.id, id).run();
      return json({ ok: true, source_id: srcId });
    }

    // POST /api/admin/sources/candidates/:id/reject
    if (path.match(/^\/api\/admin\/sources\/candidates\/\d+\/reject$/) && request.method === 'POST') {
      const [user, err] = await requireAdmin(request, env);
      if (err) return err;
      const id = parseInt(path.split('/')[5]);
      await env.DB.prepare("UPDATE source_candidates SET status = 'rejected', reviewed_by = ?, reviewed_at = datetime('now') WHERE id = ?")
        .bind(user!.id, id).run();
      return json({ ok: true, id, rejected: true });
    }

    // ============ BULK JOBS ============

    // POST /api/admin/jobs/run - Create and dispatch a bulk job
    if (path === '/api/admin/jobs/run' && request.method === 'POST') {
      const [user, err] = await requireAdmin(request, env);
      if (err) return err;
      const { task_type, params } = await request.json() as { task_type: string; params?: string };
      const validTypes = ['rdap_reverify', 'rescore', 'sales_reextract', 'qa_audit', 'asset_audit'];
      if (!validTypes.includes(task_type)) return error(`Invalid task_type. Valid: ${validTypes.join(', ')}`);

      // Check max 2 concurrent
      const running = await env.DB.prepare(
        "SELECT COUNT(*) as c FROM bulk_jobs WHERE status IN ('queued','running')"
      ).first<{ c: number }>();
      if ((running?.c || 0) >= 2) return error('Max 2 concurrent jobs. Wait for current jobs to finish.', 429);

      // Insert job
      const result = await env.DB.prepare(
        'INSERT INTO bulk_jobs (task_type, params, created_by) VALUES (?, ?, ?)'
      ).bind(task_type, params || null, user!.id).run();
      const jobId = result.meta.last_row_id;

      // Dispatch GitHub Actions
      let ghRunId = '';
      if (env.GITHUB_TOKEN) {
        try {
          const resp = await fetch(
            'https://api.github.com/repos/kjssamsungdev-max/eyecx/actions/workflows/eyecx-bulk.yml/dispatches',
            {
              method: 'POST',
              headers: { 'Authorization': `Bearer ${env.GITHUB_TOKEN}`, 'Accept': 'application/vnd.github.v3+json', 'User-Agent': 'EyeCX-Worker' },
              body: JSON.stringify({ ref: 'main', inputs: { job_id: String(jobId), task_type, params: params || '' } }),
            }
          );
          if (resp.status === 204) {
            await env.DB.prepare("UPDATE bulk_jobs SET status = 'running', started_at = datetime('now') WHERE id = ?").bind(jobId).run();
          } else {
            const body = await resp.text();
            await env.DB.prepare("UPDATE bulk_jobs SET status = 'failed', result_summary = ? WHERE id = ?")
              .bind(`GH dispatch failed: ${resp.status} ${body.slice(0, 200)}`, jobId).run();
          }
        } catch (e) {
          await env.DB.prepare("UPDATE bulk_jobs SET status = 'failed', result_summary = ? WHERE id = ?")
            .bind(`Dispatch error: ${e}`, jobId).run();
        }
      } else {
        await env.DB.prepare("UPDATE bulk_jobs SET status = 'failed', result_summary = 'GITHUB_TOKEN not set' WHERE id = ?").bind(jobId).run();
      }

      return json({ job_id: jobId, task_type, status: 'dispatched' });
    }

    // GET /api/admin/jobs - List recent jobs
    if (path === '/api/admin/jobs' && request.method === 'GET') {
      const [user, err] = await requireAdmin(request, env);
      if (err) return err;
      const rows = await env.DB.prepare('SELECT * FROM bulk_jobs ORDER BY created_at DESC LIMIT 50').all();
      return json({ jobs: rows.results || [] });
    }

    // GET /api/admin/jobs/:id - Job detail
    if (path.match(/^\/api\/admin\/jobs\/\d+$/) && request.method === 'GET') {
      const [user, err] = await requireAdmin(request, env);
      if (err) return err;
      const id = parseInt(path.split('/')[4]);
      const job = await env.DB.prepare('SELECT * FROM bulk_jobs WHERE id = ?').bind(id).first();
      if (!job) return error('Job not found', 404);
      return json(job);
    }

    // POST /api/admin/jobs/:id/complete - Callback from GH Actions
    if (path.match(/^\/api\/admin\/jobs\/\d+\/complete$/) && request.method === 'POST') {
      // Accept admin session OR Bearer API_SECRET
      const sessionUser = await authenticateSession(request, env);
      const bearerOk = authenticate(request, env);
      if (!sessionUser && !bearerOk) return error('Auth required', 401);

      const id = parseInt(path.split('/')[4]);
      const { status, summary } = await request.json() as { status: string; summary: string };
      await env.DB.prepare(
        "UPDATE bulk_jobs SET status = ?, result_summary = ?, completed_at = datetime('now') WHERE id = ?"
      ).bind(status === 'success' ? 'success' : 'failed', (summary || '').slice(0, 2000), id).run();
      return json({ ok: true, id, status });
    }

    // POST /api/admin/jobs/:id/cancel - Cancel a running job
    if (path.match(/^\/api\/admin\/jobs\/\d+\/cancel$/) && request.method === 'POST') {
      const [user, err] = await requireAdmin(request, env);
      if (err) return err;
      const id = parseInt(path.split('/')[4]);
      await env.DB.prepare("UPDATE bulk_jobs SET status = 'failed', result_summary = 'Cancelled by admin', completed_at = datetime('now') WHERE id = ?").bind(id).run();
      return json({ ok: true, id, cancelled: true });
    }

    // GET /api/admin/content-stats - Aggregated content dashboard stats
    if (path === '/api/admin/content-stats' && request.method === 'GET') {
      const [user, err] = await requireAdmin(request, env);
      if (err) return err;

      const [volumeByDay, bySource, byCat, qualityDist, ageDist, salesStats, domainStats] = await Promise.all([
        env.DB.prepare(
          `SELECT date(curated_at) as d, COUNT(*) as c FROM curated_content
           WHERE curated_at > datetime('now', '-30 days') GROUP BY d ORDER BY d ASC`
        ).all(),
        env.DB.prepare(
          `SELECT s.name, s.health_status, s.enabled,
           COUNT(c.id) as total,
           SUM(CASE WHEN c.curated_at > datetime('now', '-7 days') THEN 1 ELSE 0 END) as last_7d,
           SUM(CASE WHEN c.curated_at > datetime('now', '-1 days') THEN 1 ELSE 0 END) as last_24h
           FROM curated_sources s LEFT JOIN curated_content c ON s.id = c.source_id
           GROUP BY s.id ORDER BY total DESC`
        ).all(),
        env.DB.prepare(
          `SELECT categories, COUNT(*) as c FROM curated_content
           WHERE hidden = 0 GROUP BY categories ORDER BY c DESC LIMIT 20`
        ).all(),
        env.DB.prepare(
          `SELECT CASE
             WHEN quality_score <= 20 THEN '0-20'
             WHEN quality_score <= 40 THEN '21-40'
             WHEN quality_score <= 60 THEN '41-60'
             WHEN quality_score <= 80 THEN '61-80'
             ELSE '81-100' END as bucket, COUNT(*) as c
           FROM curated_content GROUP BY bucket ORDER BY bucket`
        ).all(),
        env.DB.prepare(
          `SELECT CASE
             WHEN curated_at > datetime('now', '-7 days') THEN '<7d'
             WHEN curated_at > datetime('now', '-30 days') THEN '7-30d'
             WHEN curated_at > datetime('now', '-90 days') THEN '30-90d'
             ELSE '90d+' END as age, COUNT(*) as c
           FROM curated_content GROUP BY age`
        ).all(),
        env.DB.prepare(
          `SELECT COUNT(*) as total,
           SUM(CASE WHEN extracted_at > datetime('now', '-1 days') THEN 1 ELSE 0 END) as last_24h,
           (SELECT COUNT(*) FROM curated_content WHERE extracted_at IS NOT NULL) as attempted,
           (SELECT COUNT(*) FROM market_sales) as total_sales
           FROM market_sales`
        ).first(),
        env.DB.prepare(
          `SELECT 'tier' as dim, tier as val, COUNT(*) as c FROM domains GROUP BY tier
           UNION ALL
           SELECT 'status', availability_status, COUNT(*) FROM domains GROUP BY availability_status`
        ).all(),
      ]);

      // Flatten category counts
      const catCounts: Record<string, number> = {};
      for (const row of (byCat.results || []) as any[]) {
        try {
          const cats = JSON.parse(row.categories || '[]');
          for (const c of cats) catCounts[c] = (catCounts[c] || 0) + row.c;
        } catch {}
      }

      return json({
        volume_by_day: volumeByDay.results || [],
        by_source: bySource.results || [],
        by_category: catCounts,
        quality_distribution: qualityDist.results || [],
        age_distribution: ageDist.results || [],
        sales: {
          total: salesStats?.total_sales || 0,
          last_24h: salesStats?.last_24h || 0,
          attempted: salesStats?.attempted || 0,
        },
        domains: (domainStats.results || []),
      });
    }

    // GET /api/admin/movers?days=7 - Top score movers
    if (path === '/api/admin/movers' && request.method === 'GET') {
      const [user, err] = await requireAdmin(request, env);
      if (err) return err;
      const days = parseInt(url.searchParams.get('days') || '7');
      const since = `datetime('now', '-${days} days')`;

      const risers = await env.DB.prepare(
        `SELECT domain, SUM(delta) as total_delta, MIN(old_score) as from_score, MAX(new_score) as to_score
         FROM score_history WHERE rescored_at > ${since} AND delta > 0
         GROUP BY domain ORDER BY total_delta DESC LIMIT 10`
      ).all();
      const fallers = await env.DB.prepare(
        `SELECT domain, SUM(delta) as total_delta, MIN(new_score) as to_score, MAX(old_score) as from_score
         FROM score_history WHERE rescored_at > ${since} AND delta < 0
         GROUP BY domain ORDER BY total_delta ASC LIMIT 10`
      ).all();
      const stats = await env.DB.prepare(
        `SELECT COUNT(DISTINCT domain) as total_rescored, AVG(ABS(delta)) as avg_delta, MAX(rescored_at) as last_rescore
         FROM score_history WHERE rescored_at > ${since}`
      ).first<{ total_rescored: number; avg_delta: number; last_rescore: string }>();

      return json({
        days,
        total_rescored: stats?.total_rescored || 0,
        avg_delta: Math.round((stats?.avg_delta || 0) * 10) / 10,
        last_rescore_at: stats?.last_rescore || null,
        top_risers: risers.results || [],
        top_fallers: fallers.results || [],
      });
    }

    // GET /api/admin/scan/diagnose - Diagnostic info for scan trigger
    if (path === '/api/admin/scan/diagnose' && request.method === 'GET') {
      const [user, err] = await requireAdmin(request, env);
      if (err) return err;
      return json({
        github_token_set: !!env.GITHUB_TOKEN,
        workflow_file: 'daily-scan.yml',
        repo: 'kjssamsungdev-max/eyecx',
        cloudflare_api_token_set: !!env.CLOUDFLARE_API_TOKEN,
        account_id_set: !!env.CLOUDFLARE_ACCOUNT_ID,
      });
    }

    // POST /api/check-availability (session auth — for marketplace users)
    if (path === '/api/check-availability' && request.method === 'POST') {
      const user = await authenticateSession(request, env);
      if (user) {
        const body = await request.json() as { domain: string };
        return await checkAvailability(body.domain, env);
      }
      // Fall through to Bearer auth check below
    }

    // GET /api/admin/scan/history - Scan history + latest GH Actions run
    if (path === '/api/admin/scan/history' && request.method === 'GET') {
      const [user, err] = await requireAdmin(request, env);
      if (err) return err;
      const history = await env.DB.prepare(
        'SELECT * FROM scan_history ORDER BY scan_date DESC LIMIT 10'
      ).all();

      let latestRun: any = null;
      if (env.GITHUB_TOKEN) {
        try {
          const resp = await fetch(
            'https://api.github.com/repos/kjssamsungdev-max/eyecx/actions/workflows/daily-scan.yml/runs?per_page=1',
            { headers: { 'Authorization': `Bearer ${env.GITHUB_TOKEN}`, 'User-Agent': 'EyeCX-Worker' } }
          );
          if (resp.ok) {
            const data = await resp.json() as any;
            const run = data.workflow_runs?.[0];
            if (run) {
              latestRun = {
                id: run.id, status: run.status, conclusion: run.conclusion,
                created_at: run.created_at, html_url: run.html_url,
              };
            }
          }
        } catch {}
      }

      return json({ history: history.results || [], latest_run: latestRun });
    }

    // POST /api/admin/domains/verify-batch - RDAP verify unknown domains
    // Accepts admin session OR Bearer API_SECRET (for workflow use)
    if (path === '/api/admin/domains/verify-batch' && request.method === 'POST') {
      const sessionUser = await authenticateSession(request, env);
      const bearerOk = authenticate(request, env);
      if (!sessionUser && !bearerOk) return error('Admin or API auth required', 401);
      if (sessionUser && sessionUser.role !== 'admin') return error('Admin required', 403);

      const rows = await env.DB.prepare(
        "SELECT domain FROM domains WHERE availability_status IN ('unknown', '') ORDER BY potential_score DESC LIMIT 100"
      ).all<{ domain: string }>();

      const domains = (rows.results || []).map(r => r.domain);
      if (domains.length === 0) return json({ message: 'No unknown domains', checked: 0, available: 0, registered: 0 });

      let checked = 0, available = 0, registered = 0;

      for (let i = 0; i < domains.length; i += 10) {
        const batch = domains.slice(i, i + 10);
        const checks = batch.map(async (domain) => {
          try {
            const resp = await fetch(`https://rdap.org/domain/${domain}`, { signal: AbortSignal.timeout(10000) });
            if (resp.status === 404) return { domain, status: 'available' };
            if (resp.status === 200) return { domain, status: 'registered' };
            return { domain, status: 'unknown' };
          } catch { return { domain, status: 'unknown' }; }
        });
        const results = await Promise.allSettled(checks);
        for (const r of results) {
          if (r.status !== 'fulfilled') continue;
          const { domain, status } = r.value;
          checked++;
          if (status === 'registered') {
            registered++;
            await env.DB.prepare("UPDATE domains SET availability_status = 'registered' WHERE domain = ?").bind(domain).run();
          } else if (status === 'available') {
            available++;
            await env.DB.prepare("UPDATE domains SET availability_status = 'available' WHERE domain = ?").bind(domain).run();
          }
        }
        if (i + 10 < domains.length) await new Promise(r => setTimeout(r, 1000));
      }

      return json({ checked, available, registered, remaining: domains.length - checked });
    }

    // ============ PUBLIC DOMAIN LISTING (marketplace) ============

    // GET /api/domains - Public domain listing for marketplace
    if (path === '/api/domains' && request.method === 'GET') {
      return await getDomains(url, env);
    }

    // ============ BEARER API_SECRET ROUTES (existing) ============

    // Auth required for all other endpoints
    if (!authenticate(request, env)) {
      return error('Unauthorized', 401);
    }

    try {
      // POST /api/domains/verify-update - Update availability_status only
      if (path === '/api/domains/verify-update' && request.method === 'POST') {
        const updates = await request.json() as Array<{ domain: string; availability_status: string }>;
        if (!Array.isArray(updates)) return error('Array required');
        let updated = 0;
        for (const u of updates.slice(0, 1000)) {
          if (!u.domain || !u.availability_status) continue;
          await env.DB.prepare(
            'UPDATE domains SET availability_status = ? WHERE domain = ?'
          ).bind(u.availability_status, u.domain).run();
          updated++;
        }
        return json({ ok: true, updated });
      }

      // POST /api/domains/bulk - Bulk upsert domains (from daily scan pipeline)
      if (path === '/api/domains/bulk' && request.method === 'POST') {
        const rows = await request.json() as any[];
        if (!Array.isArray(rows) || rows.length === 0) return error('Array of domain objects required');
        if (rows.length > 1000) return error('Max 1000 per batch');

        let inserted = 0;
        let rejected = 0;
        for (const r of rows) {
          const score = r.potential_score || 0;
          const tier = r.tier || 'lead';
          const status = r.availability_status || 'unknown';
          const dGate = gateDomain(r.domain, score, tier, status);
          if (!dGate.ok) { await logRejection(env, 'domains', r.domain, dGate.reason); rejected++; continue; }
          try {
            await env.DB.prepare(
              `INSERT OR REPLACE INTO domains (domain, tld, potential_score, tier, estimated_flip_value,
               page_rank, wayback_snapshots, estimated_age_years, backlinks, majestic_rank, tranco_rank,
               availability_status, source, first_seen, brand_score)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
            ).bind(
              r.domain, r.tld, score, tier, r.estimated_flip_value || 0,
              r.page_rank || null, r.wayback_snapshots || 0, r.estimated_age_years || null,
              r.backlinks || 0, r.majestic_rank || null, r.tranco_rank || null,
              status, r.source || 'czds_dropped',
              r.first_seen || new Date().toISOString(), r.brand_score || 0
            ).run();
            inserted++;
          } catch {}
        }
        return json({ ok: true, inserted, rejected, total: rows.length });
      }

      // GET /api/domain/:domain
      if (path.startsWith('/api/domain/') && request.method === 'GET') {
        const domain = path.split('/')[3];
        return await getDomain(domain, env);
      }

      // GET /api/stats
      if (path === '/api/stats' && request.method === 'GET') {
        return await getStats(env);
      }

      // POST /api/subscribe
      if (path === '/api/subscribe' && request.method === 'POST') {
        const body = await request.json() as { subscriber_id: string; tier: string };
        return await generateSubscriptionList(body, env);
      }

      // POST /api/webhook/purchase
      if (path === '/api/webhook/purchase' && request.method === 'POST') {
        const body = await request.json();
        return await handlePurchaseWebhook(body, env);
      }

      // GET /api/purchase-queue
      if (path === '/api/purchase-queue' && request.method === 'GET') {
        return await getPurchaseQueue(env);
      }

      // POST /api/check-availability
      if (path === '/api/check-availability' && request.method === 'POST') {
        const body = await request.json() as { domain: string };
        return await checkAvailability(body.domain, env);
      }

      // POST /api/zones/diff - Diff two zone snapshots, return dropped domains
      if (path === '/api/zones/diff' && request.method === 'POST') {
        const body = await request.json() as { tld: string; yesterday: string; today: string };
        return await diffZoneSnapshots(body.tld, body.yesterday, body.today, env);
      }

      // Zone snapshot routes: /api/zones/:tld or /api/zones/:tld/:date
      if (path.startsWith('/api/zones/')) {
        const parts = path.split('/');
        const tld = parts[3];
        const date = parts[4];

        if (request.method === 'PUT' && tld && date) {
          return await uploadZoneSnapshot(request, tld, date, env);
        }
        if (request.method === 'GET' && tld && date) {
          return await getZoneSnapshot(tld, date, env);
        }
        if (request.method === 'GET' && tld && !date) {
          return await listZoneSnapshots(tld, env);
        }
        if (request.method === 'DELETE' && tld && date) {
          const key = `snapshots/${tld}/${tld}_${date}.domains.txt`;
          await env.ZONES.delete(key);
          const droppedKey = `dropped/${tld}/dropped_${tld}_${date}.txt`;
          await env.ZONES.delete(droppedKey);
          const rawKey = `raw/${tld}/${tld}_${date}.zone.gz`;
          await env.ZONES.delete(rawKey);
          return json({ deleted: [key, droppedKey, rawKey] });
        }
      }

      // POST /api/verify-domains - RDAP verify domains in D1, remove registered
      if (path === '/api/verify-domains' && request.method === 'POST') {
        return await verifyAllDomains(env);
      }

      // GET /api/czds/auth-test - Test CZDS authentication only
      if (path === '/api/czds/auth-test' && request.method === 'GET') {
        if (!env.CZDS_USERNAME || !env.CZDS_PASSWORD) {
          return error('CZDS credentials not configured', 400);
        }
        // Note: ICANN blocks CF Worker IPs (503). Auth works from GH Actions.
        const token = await czdsAuthenticate(env.CZDS_USERNAME, env.CZDS_PASSWORD);
        if (!token) {
          return json({
            status: 'failed',
            username: env.CZDS_USERNAME,
            message: 'Authentication failed (ICANN may block CF Worker IPs - use GitHub Actions instead)',
          }, 401);
        }
        const zones = await czdsGetApprovedZones(token);
        return json({
          status: 'success',
          username: env.CZDS_USERNAME,
          message: 'Authentication successful',
          approved_zones: zones.length,
          zone_tlds: zones.map(u => u.split('/').pop()?.replace('.zone', '')),
        });
      }

      // POST /api/czds/fetch - Manually trigger CZDS zone file download
      if (path === '/api/czds/fetch' && request.method === 'POST') {
        return await manualCzdsFetch(env);
      }

      // GET /api/czds/status - Check what zone files are in R2
      if (path === '/api/czds/status' && request.method === 'GET') {
        return await czdsStatus(env);
      }

      return error('Not found', 404);
    } catch (e) {
      console.error('Error:', e);
      return error('Internal server error', 500);
    }
  },
};

// GET /api/domains
async function getDomains(url: URL, env: Env): Promise<Response> {
  const tier = url.searchParams.get('tier');
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '100'), 500);
  const offset = parseInt(url.searchParams.get('offset') || '0');
  const minScore = parseInt(url.searchParams.get('min_score') || '0');
  const tld = url.searchParams.get('tld');
  const search = url.searchParams.get('search');

  let query = `
    SELECT domain, tld, potential_score, tier, estimated_flip_value,
           page_rank, wayback_snapshots, estimated_age_years, backlinks,
           majestic_rank, tranco_rank, availability_status, first_seen,
           score_version, last_rescored_at, brand_score
    FROM domains
    WHERE potential_score >= ?
  `;
  const params: any[] = [minScore];

  // Public callers only see verified-available domains
  // Admin callers pass ?admin=1 to see all (including unknown)
  const isAdmin = url.searchParams.get('admin') === '1';
  if (!isAdmin) {
    query += " AND availability_status = 'available'";
  } else {
    query += " AND availability_status != 'registered'";
  }

  if (tier) {
    query += ' AND tier = ?';
    params.push(tier);
  }

  if (tld) {
    query += ' AND tld = ?';
    params.push(tld);
  }

  if (search && search.length >= 2) {
    query += ' AND domain LIKE ?';
    params.push(`%${search}%`);
  }

  query += ' ORDER BY potential_score DESC, first_seen DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);

  const result = await env.DB.prepare(query).bind(...params).all();

  return json({
    count: result.results?.length || 0,
    offset,
    limit,
    domains: result.results || [],
  });
}

// GET /api/domain/:domain
async function getDomain(domain: string, env: Env): Promise<Response> {
  const result = await env.DB.prepare(`
    SELECT * FROM domains WHERE domain = ?
  `).bind(domain).first();

  if (!result) {
    return error('Domain not found', 404);
  }

  return json(result);
}

// GET /api/stats
async function getStats(env: Env): Promise<Response> {
  // Today's stats
  const today = await env.DB.prepare(`
    SELECT * FROM scan_history WHERE scan_date = DATE('now')
  `).first();

  // Tier counts
  const tiers = await env.DB.prepare(`
    SELECT tier, COUNT(*) as count FROM domains GROUP BY tier
  `).all();

  // Recent high-value finds
  const recent = await env.DB.prepare(`
    SELECT domain, potential_score, tier, estimated_flip_value
    FROM domains
    WHERE potential_score >= 70
    ORDER BY first_seen DESC
    LIMIT 10
  `).all();

  // Total stats
  const totals = await env.DB.prepare(`
    SELECT 
      COUNT(*) as total_domains,
      SUM(CASE WHEN tier = 'diamond' THEN 1 ELSE 0 END) as diamonds,
      SUM(CASE WHEN tier = 'gold' THEN 1 ELSE 0 END) as golds,
      AVG(potential_score) as avg_score
    FROM domains
  `).first();

  return json({
    today: today || {},
    tiers: tiers.results || [],
    recent_finds: recent.results || [],
    totals: totals || {},
  });
}

// POST /api/subscribe
async function generateSubscriptionList(
  body: { subscriber_id: string; tier: string },
  env: Env
): Promise<Response> {
  const { subscriber_id, tier } = body;

  // Tier limits
  const tierLimits: Record<string, { limit: number; minScore: number }> = {
    premium: { limit: 500, minScore: 70 },
    standard: { limit: 200, minScore: 55 },
    basic: { limit: 50, minScore: 40 },
  };

  const config = tierLimits[tier];
  if (!config) {
    return error('Invalid tier');
  }

  // Get domains not yet delivered to this subscriber
  const result = await env.DB.prepare(`
    SELECT domain, tld, potential_score, tier, estimated_flip_value,
           page_rank, wayback_snapshots, estimated_age_years
    FROM domains
    WHERE potential_score >= ?
    AND availability_status = 'available'
    AND domain NOT IN (
      SELECT json_extract(value, '$.domain')
      FROM subscription_deliveries, json_each(domains_json)
      WHERE subscriber_id = ?
      AND delivered_at > datetime('now', '-7 days')
    )
    ORDER BY potential_score DESC, first_seen DESC
    LIMIT ?
  `).bind(config.minScore, subscriber_id, config.limit).all();

  const domains = result.results || [];

  // Record delivery
  if (domains.length > 0) {
    await env.DB.prepare(`
      INSERT INTO subscription_deliveries (subscriber_id, tier, domain_count, domains_json)
      VALUES (?, ?, ?, ?)
    `).bind(subscriber_id, tier, domains.length, JSON.stringify(domains)).run();
  }

  return json({
    subscriber_id,
    tier,
    count: domains.length,
    domains,
    generated_at: new Date().toISOString(),
  });
}

// GET /api/purchase-queue
async function getPurchaseQueue(env: Env): Promise<Response> {
  const result = await env.DB.prepare(`
    SELECT * FROM purchase_queue
    WHERE status = 'pending'
    ORDER BY score DESC
    LIMIT 100
  `).all();

  return json({
    count: result.results?.length || 0,
    queue: result.results || [],
  });
}

// POST /api/check-availability
async function checkAvailability(domain: string, env: Env): Promise<Response> {
  // Check via Cloudflare Registrar API
  try {
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/registrar/domains/${domain}`,
      {
        headers: {
          Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`,
          'Content-Type': 'application/json',
        },
      }
    );

    const data = await response.json() as any;

    if (!response.ok) {
      return json({
        domain,
        error: data.errors?.[0]?.message || `CF API ${response.status}`,
        cf_errors: data.errors,
      }, response.status);
    }

    const result = {
      domain,
      available: data.result?.available || false,
      price: data.result?.purchase_price?.amount,
      premium: data.result?.premium || false,
      checked_at: new Date().toISOString(),
    };

    // Update database (if domain exists)
    await env.DB.prepare(`
      UPDATE domains
      SET availability_status = ?, registration_price = ?
      WHERE domain = ?
    `).bind(
      result.available ? 'available' : 'registered',
      result.price || null,
      domain
    ).run();

    return json(result);
  } catch (e) {
    return error(`Failed to check availability: ${e}`);
  }
}

// POST /api/webhook/purchase
async function handlePurchaseWebhook(body: any, env: Env): Promise<Response> {
  const { domain, status, price, transaction_id } = body;

  await env.DB.prepare(`
    UPDATE domains
    SET action_taken = ?, purchased_at = CURRENT_TIMESTAMP
    WHERE domain = ?
  `).bind(status === 'success' ? 'purchased' : 'failed', domain).run();

  await env.DB.prepare(`
    UPDATE purchase_queue
    SET status = ?, processed_at = CURRENT_TIMESTAMP
    WHERE domain = ?
  `).bind(status, domain).run();

  return json({ received: true, domain, status });
}

// ============ AUTH HANDLERS ============

async function handleRegister(request: Request, env: Env): Promise<Response> {
  const { username, email, password } = await request.json() as {
    username: string; email: string; password: string;
  };

  if (!username || !email || !password) return error('username, email, and password required');
  if (username.length < 3 || username.length > 30) return error('Username must be 3-30 characters');
  if (password.length < 8) return error('Password must be at least 8 characters');
  if (!email.includes('@')) return error('Valid email required');

  const existing = await env.DB.prepare(
    'SELECT id FROM community_users WHERE email = ? OR username = ?'
  ).bind(email, username).first();
  if (existing) return error('Email or username already taken', 409);

  const id = crypto.randomUUID();
  const passwordHash = await hashPassword(password);

  await env.DB.prepare(
    `INSERT INTO community_users (id, username, email, password_hash, role, tier, email_verified)
     VALUES (?, ?, ?, ?, 'member', 'free', 0)`
  ).bind(id, username, email, passwordHash).run();

  // Send verification email
  const verifyToken = generateToken();
  const expires = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  await env.DB.prepare(
    'INSERT INTO email_verifications (token, user_id, expires_at) VALUES (?, ?, ?)'
  ).bind(verifyToken, id, expires).run();

  await sendEmail(env, email, 'Verify your EyeCX account',
    `<h2>Welcome to EyeCX</h2>
     <p>Click the link below to verify your email:</p>
     <p><a href="https://eyecx.com/api/auth/verify-email?token=${verifyToken}">Verify Email</a></p>
     <p>This link expires in 24 hours.</p>`
  );

  const user = await env.DB.prepare(
    `SELECT ${USER_COLUMNS} FROM community_users WHERE id = ?`
  ).bind(id).first();

  return json({ user }, 201);
}

async function handleLogin(request: Request, env: Env): Promise<Response> {
  const { email, password } = await request.json() as { email: string; password: string };
  if (!email || !password) return error('email and password required');

  const user = await env.DB.prepare(
    'SELECT id, password_hash FROM community_users WHERE email = ?'
  ).bind(email).first<{ id: string; password_hash: string }>();
  if (!user) return error('Invalid credentials', 401);

  const valid = await verifyPassword(password, user.password_hash);
  if (!valid) return error('Invalid credentials', 401);

  // Create session
  const token = generateToken();
  const expires = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  await env.DB.prepare(
    'INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)'
  ).bind(token, user.id, expires).run();

  const profile = await env.DB.prepare(
    `SELECT ${USER_COLUMNS} FROM community_users WHERE id = ?`
  ).bind(user.id).first();

  return json({ token, user: profile });
}

async function handleLogout(request: Request, env: Env): Promise<Response> {
  const auth = request.headers.get('Authorization');
  if (!auth || !auth.startsWith('Bearer ')) return error('No session', 401);
  const token = auth.slice(7);
  await env.DB.prepare('DELETE FROM sessions WHERE token = ?').bind(token).run();
  return json({ ok: true });
}

async function handleMe(request: Request, env: Env): Promise<Response> {
  const user = await authenticateSession(request, env);
  if (!user) return error('Not authenticated', 401);
  return json({ user });
}

async function handleVerifyEmail(url: URL, env: Env): Promise<Response> {
  const token = url.searchParams.get('token');
  if (!token) return error('Token required');

  const record = await env.DB.prepare(
    'SELECT user_id FROM email_verifications WHERE token = ? AND expires_at > datetime(\'now\')'
  ).bind(token).first<{ user_id: string }>();
  if (!record) return error('Invalid or expired token', 400);

  await env.DB.prepare(
    'UPDATE community_users SET email_verified = 1 WHERE id = ?'
  ).bind(record.user_id).run();
  await env.DB.prepare('DELETE FROM email_verifications WHERE token = ?').bind(token).run();

  return new Response('<html><body><h2>Email verified!</h2><p>You can now <a href="https://eyecx.com">return to EyeCX</a>.</p></body></html>', {
    headers: { 'Content-Type': 'text/html', ...corsHeaders },
  });
}

async function handleForgotPassword(request: Request, env: Env): Promise<Response> {
  const { email } = await request.json() as { email: string };
  if (!email) return error('Email required');

  const user = await env.DB.prepare(
    'SELECT id FROM community_users WHERE email = ?'
  ).bind(email).first<{ id: string }>();

  // Always return success (don't leak whether email exists)
  if (!user) return json({ ok: true });

  const token = generateToken();
  const expires = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1 hour
  await env.DB.prepare(
    'INSERT INTO password_resets (token, user_id, expires_at) VALUES (?, ?, ?)'
  ).bind(token, user.id, expires).run();

  await sendEmail(env, email, 'Reset your EyeCX password',
    `<h2>Password Reset</h2>
     <p>Click the link below to reset your password:</p>
     <p><a href="https://eyecx.com/reset-password?token=${token}">Reset Password</a></p>
     <p>This link expires in 1 hour.</p>`
  );

  return json({ ok: true });
}

async function handleResetPassword(request: Request, env: Env): Promise<Response> {
  const { token, password } = await request.json() as { token: string; password: string };
  if (!token || !password) return error('Token and password required');
  if (password.length < 8) return error('Password must be at least 8 characters');

  const record = await env.DB.prepare(
    'SELECT user_id FROM password_resets WHERE token = ? AND expires_at > datetime(\'now\') AND used = 0'
  ).bind(token).first<{ user_id: string }>();
  if (!record) return error('Invalid or expired token', 400);

  const passwordHash = await hashPassword(password);
  await env.DB.prepare(
    'UPDATE community_users SET password_hash = ? WHERE id = ?'
  ).bind(passwordHash, record.user_id).run();
  await env.DB.prepare(
    'UPDATE password_resets SET used = 1 WHERE token = ?'
  ).bind(token).run();

  // Clear all sessions for this user
  await env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(record.user_id).run();

  return json({ ok: true });
}

// ============ THREAD HANDLERS ============

async function listThreads(url: URL, env: Env): Promise<Response> {
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '20'), 50);
  const offset = parseInt(url.searchParams.get('offset') || '0');
  const category = url.searchParams.get('category');

  let query = `SELECT t.*, u.username, u.avatar_url FROM threads t
    LEFT JOIN community_users u ON t.author_id = u.id WHERE (t.hidden IS NULL OR t.hidden = 0)`;
  const params: any[] = [];

  if (category) {
    query += ' AND t.category = ?';
    params.push(category);
  }
  query += ' ORDER BY t.pinned DESC, t.created_at DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);

  const result = await env.DB.prepare(query).bind(...params).all();
  return json({ threads: result.results || [], count: result.results?.length || 0 });
}

async function getThread(id: number, env: Env): Promise<Response> {
  const thread = await env.DB.prepare(
    `SELECT t.*, u.username, u.avatar_url FROM threads t
     LEFT JOIN community_users u ON t.author_id = u.id WHERE t.id = ?`
  ).bind(id).first();
  if (!thread) return error('Thread not found', 404);

  await env.DB.prepare('UPDATE threads SET views = views + 1 WHERE id = ?').bind(id).run();
  return json(thread);
}

async function createThread(request: Request, user: SessionUser, env: Env): Promise<Response> {
  const { title, body, category } = await request.json() as {
    title: string; body: string; category?: string;
  };
  if (!title || !body) return error('Title and body required');

  const result = await env.DB.prepare(
    `INSERT INTO threads (title, body, author_id, category) VALUES (?, ?, ?, ?)`
  ).bind(title, body, user.id, category || 'General Discussion').run();

  await env.DB.prepare('UPDATE community_users SET karma = karma + 1 WHERE id = ?').bind(user.id).run();

  return json({ id: result.meta.last_row_id, title, category: category || 'General Discussion' }, 201);
}

// ============ COMMENT HANDLERS ============

async function listComments(parentType: string, parentId: number, url: URL, env: Env): Promise<Response> {
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '50'), 100);
  const offset = parseInt(url.searchParams.get('offset') || '0');

  const result = await env.DB.prepare(
    `SELECT c.*, u.username, u.avatar_url FROM comments c
     LEFT JOIN community_users u ON c.author_id = u.id
     WHERE c.parent_type = ? AND c.parent_id = ? AND c.deleted = 0 AND (c.hidden IS NULL OR c.hidden = 0)
     ORDER BY c.created_at ASC LIMIT ? OFFSET ?`
  ).bind(parentType, parentId, limit, offset).all();

  return json({ comments: result.results || [], count: result.results?.length || 0 });
}

async function createComment(
  request: Request, user: SessionUser, parentType: string, parentId: number, env: Env
): Promise<Response> {
  const { body, reply_to_id } = await request.json() as { body: string; reply_to_id?: number };
  if (!body) return error('Body required');

  const result = await env.DB.prepare(
    `INSERT INTO comments (body, author_id, parent_type, parent_id, reply_to_id) VALUES (?, ?, ?, ?, ?)`
  ).bind(body, user.id, parentType, parentId, reply_to_id || null).run();

  if (parentType === 'thread') {
    await env.DB.prepare('UPDATE threads SET reply_count = reply_count + 1 WHERE id = ?').bind(parentId).run();
  }
  await env.DB.prepare('UPDATE community_users SET karma = karma + 1 WHERE id = ?').bind(user.id).run();

  return json({ id: result.meta.last_row_id }, 201);
}

// ============ VOTE HANDLER ============

async function handleVote(request: Request, user: SessionUser, env: Env): Promise<Response> {
  const { target_type, target_id, value } = await request.json() as {
    target_type: string; target_id: number; value: number;
  };
  if (!target_type || !target_id || (value !== 1 && value !== -1)) {
    return error('target_type, target_id, and value (1 or -1) required');
  }

  // Upsert vote
  await env.DB.prepare(
    `INSERT INTO votes (user_id, target_type, target_id, value) VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id, target_type, target_id) DO UPDATE SET value = ?`
  ).bind(user.id, target_type, target_id, value, value).run();

  // Update target counts
  const table = target_type === 'thread' ? 'threads' : target_type === 'comment' ? 'comments' : null;
  if (table) {
    const ups = await env.DB.prepare(
      'SELECT COUNT(*) as c FROM votes WHERE target_type = ? AND target_id = ? AND value = 1'
    ).bind(target_type, target_id).first<{ c: number }>();
    const downs = await env.DB.prepare(
      'SELECT COUNT(*) as c FROM votes WHERE target_type = ? AND target_id = ? AND value = -1'
    ).bind(target_type, target_id).first<{ c: number }>();

    await env.DB.prepare(
      `UPDATE ${table} SET upvotes = ?, downvotes = ? WHERE id = ?`
    ).bind(ups?.c || 0, downs?.c || 0, target_id).run();
  }

  return json({ ok: true, target_type, target_id, value });
}

// ============ ARTICLE HANDLERS ============

async function listArticles(url: URL, env: Env): Promise<Response> {
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '20'), 50);
  const offset = parseInt(url.searchParams.get('offset') || '0');
  const category = url.searchParams.get('category');

  let query = `SELECT id, title, slug, excerpt, author_id, category, tags, thumbnail_url,
    read_time, views, published_at, created_at FROM articles WHERE status = 'published'`;
  const params: any[] = [];

  if (category) {
    query += ' AND category = ?';
    params.push(category);
  }
  query += ' ORDER BY published_at DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);

  const result = await env.DB.prepare(query).bind(...params).all();
  return json({ articles: result.results || [], count: result.results?.length || 0 });
}

async function getArticle(slug: string, env: Env): Promise<Response> {
  const article = await env.DB.prepare(
    'SELECT * FROM articles WHERE slug = ? AND status = \'published\''
  ).bind(slug).first();
  if (!article) return error('Article not found', 404);

  await env.DB.prepare('UPDATE articles SET views = views + 1 WHERE slug = ?').bind(slug).run();
  return json(article);
}

async function createArticle(request: Request, user: SessionUser, env: Env): Promise<Response> {
  const { title, slug, excerpt, body_md, category, tags, thumbnail_url, status } = await request.json() as {
    title: string; slug: string; excerpt?: string; body_md: string;
    category?: string; tags?: string; thumbnail_url?: string; status?: string;
  };
  if (!title || !slug || !body_md) return error('title, slug, and body_md required');

  const wordCount = body_md.split(/\s+/).length;
  const readTime = Math.max(1, Math.ceil(wordCount / 200));
  const pubStatus = status || 'published';
  const publishedAt = pubStatus === 'published' ? new Date().toISOString() : null;

  const result = await env.DB.prepare(
    `INSERT INTO articles (title, slug, excerpt, body_md, author_id, category, tags, thumbnail_url, read_time, status, published_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(title, slug, excerpt || '', body_md, user.id, category || 'News', tags || '[]',
    thumbnail_url || '', readTime, pubStatus, publishedAt).run();

  return json({ id: result.meta.last_row_id, slug }, 201);
}

async function updateArticle(slug: string, request: Request, env: Env): Promise<Response> {
  const fields = await request.json() as Record<string, any>;
  const allowed = ['title', 'excerpt', 'body_md', 'category', 'tags', 'thumbnail_url', 'status'];
  const updates: string[] = [];
  const values: any[] = [];

  for (const key of allowed) {
    if (fields[key] !== undefined) {
      updates.push(`${key} = ?`);
      values.push(fields[key]);
    }
  }
  if (updates.length === 0) return error('No valid fields to update');

  updates.push('updated_at = datetime(\'now\')');
  if (fields.status === 'published') {
    updates.push('published_at = COALESCE(published_at, datetime(\'now\'))');
  }

  values.push(slug);
  await env.DB.prepare(
    `UPDATE articles SET ${updates.join(', ')} WHERE slug = ?`
  ).bind(...values).run();

  return json({ ok: true, slug });
}

// ============ CURATED CONTENT ============

async function listCurated(url: URL, env: Env): Promise<Response> {
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '30'), 50);
  const offset = parseInt(url.searchParams.get('offset') || '0');
  const all = url.searchParams.get('all') === '1';
  const catFilter = url.searchParams.get('cat');

  let where = "status = 'published' AND hidden = 0";
  if (!all) {
    where += " AND published_at > datetime('now', '-30 days')";
  }
  if (catFilter && catFilter !== 'all') {
    where += ` AND categories LIKE '%"${catFilter}"%'`;
  }

  const result = await env.DB.prepare(
    `SELECT id, source_name, title, url, excerpt, author, published_at, category, tags,
     quality_score, views, featured, categories FROM curated_content WHERE ${where}
     ORDER BY quality_score DESC, published_at DESC LIMIT ? OFFSET ?`
  ).bind(limit, offset).all();

  // Category counts for filter pills
  const counts = await env.DB.prepare(
    `SELECT categories FROM curated_content WHERE status = 'published' AND hidden = 0
     ${!all ? "AND published_at > datetime('now', '-30 days')" : ''}`
  ).all<{ categories: string }>();

  const catCounts: Record<string, number> = {};
  for (const row of (counts.results || [])) {
    try {
      const cats = JSON.parse(row.categories || '[]');
      for (const c of cats) catCounts[c] = (catCounts[c] || 0) + 1;
    } catch {}
  }

  return json({ articles: result.results || [], count: result.results?.length || 0, category_counts: catCounts });
}

// ============ CURATED DETAIL ============

async function getCuratedById(id: number, env: Env): Promise<Response> {
  if (!id || id < 1) return error('Valid ID required');

  const item = await env.DB.prepare(
    `SELECT id, source_id, source_name, title, url, excerpt, author,
     published_at, category, tags, quality_score, views
     FROM curated_content WHERE id = ?`
  ).bind(id).first();

  if (!item) return error('Curated item not found', 404);
  await env.DB.prepare('UPDATE curated_content SET views = views + 1 WHERE id = ?').bind(id).run();
  return json(item);
}

// ============ ADMIN HANDLERS ============

async function listUsers(env: Env): Promise<Response> {
  const result = await env.DB.prepare(
    `SELECT ${USER_COLUMNS} FROM community_users ORDER BY created_at DESC LIMIT 100`
  ).all();
  return json({ users: result.results || [] });
}

async function adminStats(env: Env): Promise<Response> {
  const users = await env.DB.prepare('SELECT COUNT(*) as c FROM community_users').first<{ c: number }>();
  const threads = await env.DB.prepare('SELECT COUNT(*) as c FROM threads').first<{ c: number }>();
  const articles = await env.DB.prepare('SELECT COUNT(*) as c FROM articles').first<{ c: number }>();
  const waitlist = await env.DB.prepare('SELECT COUNT(*) as c FROM waitlist').first<{ c: number }>();
  const comments = await env.DB.prepare('SELECT COUNT(*) as c FROM comments').first<{ c: number }>();
  const curated = await env.DB.prepare('SELECT COUNT(*) as c FROM curated_content').first<{ c: number }>();

  return json({
    users: users?.c || 0,
    threads: threads?.c || 0,
    articles: articles?.c || 0,
    comments: comments?.c || 0,
    curated: curated?.c || 0,
    waitlist: waitlist?.c || 0,
  });
}

// PUT /api/zones/:tld/:date - Upload snapshot to R2
async function uploadZoneSnapshot(
  request: Request,
  tld: string,
  date: string,
  env: Env
): Promise<Response> {
  const key = `snapshots/${tld}/${tld}_${date}.domains.txt`;
  const body = await request.text();
  const lines = body.trim().split('\n').filter(l => l.trim());

  await env.ZONES.put(key, body, {
    customMetadata: {
      tld,
      date,
      domain_count: String(lines.length),
      uploaded_at: new Date().toISOString(),
    },
  });

  return json({
    key,
    tld,
    date,
    domain_count: lines.length,
    uploaded_at: new Date().toISOString(),
  });
}

// GET /api/zones/:tld/:date - Download snapshot from R2
async function getZoneSnapshot(
  tld: string,
  date: string,
  env: Env
): Promise<Response> {
  const key = `snapshots/${tld}/${tld}_${date}.domains.txt`;
  const object = await env.ZONES.get(key);

  if (!object) {
    return error(`Snapshot not found: ${tld} ${date}`, 404);
  }

  const size = object.size;

  // For large files (>1MB), only return metadata to avoid OOM
  if (size > 1_000_000) {
    // Stream first 4KB and last 4KB
    const body = object.body;
    const reader = body.getReader();
    let firstChunk = '';
    let bytesRead = 0;

    while (bytesRead < 4096) {
      const { done, value } = await reader.read();
      if (done) break;
      firstChunk += new TextDecoder().decode(value);
      bytesRead += value.length;
    }
    reader.cancel();

    const firstLines = firstChunk.split('\n').filter(l => l.trim()).slice(0, 20);
    const totalEstimate = Math.round(size / (firstChunk.length / firstLines.length));

    return json({
      key,
      size_bytes: size,
      size_mb: (size / (1024 * 1024)).toFixed(1),
      estimated_domains: totalEstimate,
      first_20: firstLines,
      metadata: object.customMetadata,
    });
  }

  const text = await object.text();
  return new Response(text, {
    headers: {
      'Content-Type': 'text/plain',
      ...corsHeaders,
      'X-Domain-Count': object.customMetadata?.domain_count || '0',
      'X-Snapshot-Date': date,
    },
  });
}

// GET /api/zones/:tld - List snapshots for a TLD
async function listZoneSnapshots(tld: string, env: Env): Promise<Response> {
  const prefix = `snapshots/${tld}/`;
  const listed = await env.ZONES.list({ prefix, limit: 100 });

  const snapshots = listed.objects.map(obj => ({
    key: obj.key,
    date: obj.key.match(/_(\d{4}-\d{2}-\d{2})\./)?.[1] || 'unknown',
    size: obj.size,
    domain_count: obj.customMetadata?.domain_count || 'unknown',
    uploaded: obj.uploaded.toISOString(),
  }));

  return json({ tld, count: snapshots.length, snapshots });
}

// POST /api/zones/diff - Diff two snapshots, return dropped domains
async function diffZoneSnapshots(
  tld: string,
  yesterdayDate: string,
  todayDate: string,
  env: Env
): Promise<Response> {
  const yesterdayKey = `snapshots/${tld}/${tld}_${yesterdayDate}.domains.txt`;
  const todayKey = `snapshots/${tld}/${tld}_${todayDate}.domains.txt`;

  const [yesterdayObj, todayObj] = await Promise.all([
    env.ZONES.get(yesterdayKey),
    env.ZONES.get(todayKey),
  ]);

  if (!yesterdayObj) return error(`Yesterday snapshot not found: ${yesterdayDate}`, 404);
  if (!todayObj) return error(`Today snapshot not found: ${todayDate}`, 404);

  const yesterdayText = await yesterdayObj.text();
  const todayText = await todayObj.text();

  const yesterdaySet = new Set(yesterdayText.trim().split('\n').filter(l => l.trim()));
  const todaySet = new Set(todayText.trim().split('\n').filter(l => l.trim()));

  const dropped: string[] = [];
  const added: string[] = [];

  for (const d of yesterdaySet) {
    if (!todaySet.has(d)) dropped.push(d);
  }
  for (const d of todaySet) {
    if (!yesterdaySet.has(d)) added.push(d);
  }

  dropped.sort();
  added.sort();

  // Store dropped list in R2
  const droppedKey = `dropped/${tld}/dropped_${tld}_${todayDate}.txt`;
  const droppedContent = dropped.map(d => `${d}.${tld}`).join('\n');
  await env.ZONES.put(droppedKey, droppedContent, {
    customMetadata: {
      tld,
      date: todayDate,
      dropped_count: String(dropped.length),
      added_count: String(added.length),
    },
  });

  return json({
    tld,
    yesterday: yesterdayDate,
    today: todayDate,
    yesterday_count: yesterdaySet.size,
    today_count: todaySet.size,
    dropped_count: dropped.length,
    added_count: added.length,
    dropped_domains: dropped.slice(0, 500), // first 500 for preview
    dropped_file: droppedKey,
  });
}

// POST /api/verify-domains - RDAP verify all domains in D1, remove registered
async function verifyAllDomains(env: Env): Promise<Response> {
  // Get all domains that haven't been verified or are unknown
  const result = await env.DB.prepare(`
    SELECT domain FROM domains
    WHERE availability_status IN ('unknown', '')
    ORDER BY potential_score DESC
    LIMIT 500
  `).all();

  const domains = (result.results || []).map((r: any) => r.domain as string);
  if (domains.length === 0) {
    return json({ message: 'No domains to verify', verified: 0, removed: 0 });
  }

  let verified = 0;
  let removed = 0;
  let available = 0;
  const errors: string[] = [];

  // Process in batches of 10 with rate limiting
  for (let i = 0; i < domains.length; i += 10) {
    const batch = domains.slice(i, i + 10);
    const checks = batch.map(async (domain) => {
      try {
        const resp = await fetch(`https://rdap.org/domain/${domain}`, {
          signal: AbortSignal.timeout(10000),
        });
        if (resp.status === 200) {
          // Domain is registered - remove it
          await env.DB.prepare('DELETE FROM domains WHERE domain = ?').bind(domain).run();
          return 'registered';
        } else if (resp.status === 404) {
          // Domain is available - mark it
          await env.DB.prepare(
            'UPDATE domains SET availability_status = ? WHERE domain = ?'
          ).bind('available', domain).run();
          return 'available';
        }
        // Other status - mark unknown
        await env.DB.prepare(
          'UPDATE domains SET availability_status = ? WHERE domain = ?'
        ).bind('unknown', domain).run();
        return 'unknown';
      } catch {
        return 'error';
      }
    });

    const results = await Promise.allSettled(checks);
    for (const r of results) {
      if (r.status === 'fulfilled') {
        verified++;
        if (r.value === 'registered') removed++;
        if (r.value === 'available') available++;
      }
    }

    // Rate limit: ~10/sec
    if (i + 10 < domains.length) {
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }

  return json({
    total_checked: verified,
    removed_registered: removed,
    confirmed_available: available,
    remaining: domains.length - verified,
  });
}

// POST /api/czds/fetch - Manual trigger for CZDS download
async function manualCzdsFetch(env: Env): Promise<Response> {
  if (!env.CZDS_USERNAME || !env.CZDS_PASSWORD) {
    return error('CZDS credentials not configured. Set CZDS_USERNAME and CZDS_PASSWORD worker secrets.', 400);
  }

  const token = await czdsAuthenticate(env.CZDS_USERNAME, env.CZDS_PASSWORD);
  if (!token) {
    return error('CZDS authentication failed', 401);
  }

  const approvedZones = await czdsGetApprovedZones(token);
  const today = new Date().toISOString().split('T')[0];
  const results: Array<{ tld: string; status: string; key?: string }> = [];

  const targetZones = approvedZones.filter(url => {
    const tld = url.split('/').pop()?.replace('.zone', '') || '';
    return CZDS_TLDS.includes(tld);
  });

  for (const zoneUrl of targetZones) {
    const tld = zoneUrl.split('/').pop()?.replace('.zone', '') || '';
    const r2Key = `raw/${tld}/${tld}_${today}.zone.gz`;

    const existing = await env.ZONES.head(r2Key);
    if (existing) {
      results.push({ tld, status: 'already_exists', key: r2Key });
      continue;
    }

    const ok = await czdsStreamToR2(zoneUrl, token, r2Key, env.ZONES);
    results.push({ tld, status: ok ? 'downloaded' : 'failed', key: ok ? r2Key : undefined });
  }

  return json({
    date: today,
    approved_zones: approvedZones.length,
    target_zones: targetZones.length,
    results,
  });
}

// GET /api/czds/status - List raw zone files and snapshots in R2
async function czdsStatus(env: Env): Promise<Response> {
  const rawList = await env.ZONES.list({ prefix: 'raw/', limit: 50 });
  const snapList = await env.ZONES.list({ prefix: 'snapshots/', limit: 50 });
  const droppedList = await env.ZONES.list({ prefix: 'dropped/', limit: 50 });

  const format = (obj: R2Object) => ({
    key: obj.key,
    size_mb: (obj.size / (1024 * 1024)).toFixed(1),
    uploaded: obj.uploaded.toISOString(),
    metadata: obj.customMetadata,
  });

  return json({
    raw_zone_files: rawList.objects.map(format),
    snapshots: snapList.objects.map(format),
    dropped_lists: droppedList.objects.map(format),
  });
}

// ============ RSS CURATION ============

interface CurationSource {
  id: string;
  name: string;
  feed_url: string;
  category: string;
  enabled: number;
}

async function runRssCuration(env: Env): Promise<{ sources: number; fetched: number; inserted: number; errors: number }> {
  const sources = await env.DB.prepare(
    'SELECT id, name, feed_url, category, enabled FROM curated_sources WHERE enabled = 1'
  ).all<CurationSource>();

  let fetched = 0, inserted = 0, errors = 0;

  for (const source of (sources.results || [])) {
    try {
      const result = await fetchAndCurateFeed(source, env);
      fetched++;
      inserted += result.inserted;

      const lastItemClause = result.inserted > 0 ? ", last_item_at = datetime('now'), consecutive_failures = 0" : '';
      await env.DB.prepare(
        `UPDATE curated_sources SET last_fetched_at = datetime('now'),
         total_items = total_items + ?,
         items_accepted = items_accepted + ?,
         items_rejected = items_rejected + ?
         ${lastItemClause}
         WHERE id = ?`
      ).bind(result.inserted + result.skipped, result.inserted, result.skipped, source.id).run();
    } catch (e) {
      console.error(`RSS error for ${source.name}: ${e}`);
      errors++;
      await env.DB.prepare(
        'UPDATE curated_sources SET consecutive_failures = consecutive_failures + 1 WHERE id = ?'
      ).bind(source.id).run();
    }
  }

  return { sources: sources.results?.length || 0, fetched, inserted, errors };
}

async function fetchAndCurateFeed(source: CurationSource, env: Env): Promise<{ inserted: number; skipped: number }> {
  const resp = await fetch(source.feed_url, {
    headers: { 'User-Agent': 'EyeCX/1.0 RSS Curator' },
    signal: AbortSignal.timeout(15000),
  });
  if (!resp.ok) return { inserted: 0, skipped: 0 };

  const xml = await resp.text();
  const items = parseRssItems(xml, 50);
  let inserted = 0;
  let skipped = 0;

  for (const item of items) {
    if (!item.url || !item.title) continue;

    // Dedupe by URL
    const exists = await env.DB.prepare(
      'SELECT id FROM curated_content WHERE url = ?'
    ).bind(item.url).first();
    if (exists) { skipped++; continue; }

    const slug = item.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 100);
    const excerpt = (item.description || '').slice(0, 500);
    const pubDate = item.pubDate || new Date().toISOString();

    const cGate = gateCurated(item.title, item.url, pubDate, slug);
    if (!cGate.ok) { await logRejection(env, 'curated_content', item.url, cGate.reason, item.title?.slice(0, 100)); skipped++; continue; }

    // Dedupe by source+title within 7 days
    const dupTitle = await env.DB.prepare(
      "SELECT id FROM curated_content WHERE source_id = ? AND title = ? AND curated_at > datetime('now', '-7 days')"
    ).bind(source.id, item.title).first();
    if (dupTitle) { skipped++; continue; }

    const tags = extractTags(item.title + ' ' + excerpt);
    const qScore = computeQualityScore(item.title, excerpt, pubDate, source.category, source.name);

    const categories = classifyContent(item.title, excerpt);

    await env.DB.prepare(
      `INSERT INTO curated_content (source_id, source_name, title, url, excerpt, author,
       published_at, category, tags, slug, quality_score, status, categories)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'published', ?)`
    ).bind(
      source.id, source.name, item.title, item.url, excerpt,
      item.author || '', pubDate,
      source.category, JSON.stringify(tags), slug, qScore, JSON.stringify(categories)
    ).run();
    inserted++;
  }

  return { inserted, skipped };
}

function parseRssItems(xml: string, limit: number): Array<{
  title: string; url: string; description: string; author: string; pubDate: string;
}> {
  const items: Array<{ title: string; url: string; description: string; author: string; pubDate: string }> = [];

  // Simple RSS/Atom parser — extract items via regex (no XML lib in Workers)
  const isAtom = xml.includes('<feed') && xml.includes('<entry');

  if (isAtom) {
    const entries = xml.split('<entry').slice(1, limit + 1);
    for (const entry of entries) {
      items.push({
        title: extractTag(entry, 'title'),
        url: extractAtomLink(entry),
        description: extractTag(entry, 'summary') || extractTag(entry, 'content'),
        author: extractTag(entry, 'name'),
        pubDate: extractTag(entry, 'published') || extractTag(entry, 'updated'),
      });
    }
  } else {
    const rssItems = xml.split('<item').slice(1, limit + 1);
    for (const item of rssItems) {
      items.push({
        title: extractTag(item, 'title'),
        url: extractTag(item, 'link'),
        description: extractTag(item, 'description'),
        author: extractTag(item, 'dc:creator') || extractTag(item, 'author'),
        pubDate: extractTag(item, 'pubDate') || extractTag(item, 'dc:date'),
      });
    }
  }

  return items;
}

function extractTag(xml: string, tag: string): string {
  const match = xml.match(new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]></${tag}>|<${tag}[^>]*>([\\s\\S]*?)</${tag}>`));
  return (match?.[1] || match?.[2] || '').trim();
}

function extractAtomLink(entry: string): string {
  const match = entry.match(/<link[^>]*href="([^"]*)"[^>]*rel="alternate"/);
  if (match) return match[1];
  const fallback = entry.match(/<link[^>]*href="([^"]*)"/);
  return fallback?.[1] || '';
}

function extractTags(text: string): string[] {
  const words = text.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/);
  const stopwords = new Set(['the','a','an','is','are','was','were','be','been','to','of','in','for','on','with','at','by','from','it','this','that','and','or','but','not','no','has','have','had']);
  const freq: Record<string, number> = {};
  for (const w of words) {
    if (w.length > 3 && !stopwords.has(w)) freq[w] = (freq[w] || 0) + 1;
  }
  return Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([w]) => w);
}

// ============ SOURCE HEALTH ============

async function runSourceHealthCheck(env: Env): Promise<{ healthy: number; stale: number; dead: number; disabled: number }> {
  const sources = await env.DB.prepare(
    'SELECT id, name, enabled, last_fetched_at, last_item_at, consecutive_failures FROM curated_sources'
  ).all<{ id: string; name: string; enabled: number; last_fetched_at: string; last_item_at: string; consecutive_failures: number }>();

  let healthy = 0, stale = 0, dead = 0, disabled = 0;
  const now = Date.now();

  for (const s of (sources.results || [])) {
    if (!s.enabled) { disabled++; continue; }

    const lastItem = s.last_item_at ? new Date(s.last_item_at).getTime() : 0;
    const lastFetch = s.last_fetched_at ? new Date(s.last_fetched_at).getTime() : 0;
    const daysSinceItem = lastItem ? (now - lastItem) / 86400000 : (lastFetch ? (now - lastFetch) / 86400000 : 999);
    const failures = s.consecutive_failures || 0;

    let status = 'healthy';
    if (failures >= 5) {
      status = 'dead';
    } else if (daysSinceItem > 60 && lastItem > 0) {
      // Only auto-disable if we KNOW it had items before and stopped
      status = 'dead';
      await env.DB.prepare('UPDATE curated_sources SET enabled = 0, health_status = ? WHERE id = ?').bind('dead', s.id).run();
      disabled++; continue;
    } else if (daysSinceItem > 7 || failures >= 2) {
      status = 'stale';
    }

    await env.DB.prepare('UPDATE curated_sources SET health_status = ? WHERE id = ?').bind(status, s.id).run();
    if (status === 'healthy') healthy++;
    else if (status === 'stale') stale++;
    else dead++;
  }

  return { healthy, stale, dead, disabled };
}

// ============ ALERTS ============

async function runAlertCheck(env: Env): Promise<{ alerts_created: number }> {
  let created = 0;

  // Check 1: RSS produced 0 inserts in 12h
  const recentCurated = await env.DB.prepare(
    "SELECT COUNT(*) as c FROM curated_content WHERE curated_at > datetime('now', '-12 hours')"
  ).first<{ c: number }>();
  if ((recentCurated?.c || 0) === 0) {
    await createAlert(env, 'rss_dry', 'warning', 'RSS curation produced 0 new articles in the last 12 hours');
    created++;
  }

  // Check 2: daily-scan 0 qualified for 2 days
  const recentDomains = await env.DB.prepare(
    "SELECT COUNT(*) as c FROM domains WHERE first_seen > datetime('now', '-2 days')"
  ).first<{ c: number }>();
  if ((recentDomains?.c || 0) === 0) {
    await createAlert(env, 'scan_dry', 'warning', 'Daily scan produced 0 qualified domains in the last 2 days');
    created++;
  }

  // Check 3: sales extraction 0 in 48h
  const recentSales = await env.DB.prepare(
    "SELECT COUNT(*) as c FROM market_sales WHERE extracted_at > datetime('now', '-2 days')"
  ).first<{ c: number }>();
  if ((recentSales?.c || 0) === 0) {
    await createAlert(env, 'sales_dry', 'info', 'Sales extraction produced 0 new sales in the last 48 hours');
    created++;
  }

  return { alerts_created: created };
}

async function createAlert(env: Env, type: string, severity: string, message: string): Promise<void> {
  // Dedupe: don't create if unresolved alert of same type exists
  const existing = await env.DB.prepare(
    'SELECT id FROM alerts WHERE type = ? AND resolved_at IS NULL'
  ).bind(type).first();
  if (existing) return;

  await env.DB.prepare(
    'INSERT INTO alerts (type, severity, message) VALUES (?, ?, ?)'
  ).bind(type, severity, message).run();

  // Send email if RESEND_API_KEY is set
  if (env.RESEND_API_KEY) {
    await sendEmail(env, 'admin@eyecx.com', `EyeCX Alert: ${type}`,
      `<h3>${severity.toUpperCase()}: ${type}</h3><p>${message}</p><p><a href="https://eyecx.com/admin">View Dashboard</a></p>`
    );
  }
}

// ============ SOURCE AUTO-DISCOVERY ============

const FEED_LINK_RE = /<link[^>]*type="application\/(rss|atom)\+xml"[^>]*href="([^"]+)"/gi;
const FEED_LINK_RE2 = /<link[^>]*href="([^"]+)"[^>]*type="application\/(rss|atom)\+xml"/gi;

async function runSourceDiscovery(env: Env): Promise<{ scanned: number; candidates: number }> {
  // Find articles linked to high-value sales
  const articles = await env.DB.prepare(
    `SELECT DISTINCT c.url, c.source_name FROM curated_content c
     INNER JOIN market_sales m ON c.url = m.source_url
     WHERE m.sale_price_usd >= 50000 LIMIT 20`
  ).all<{ url: string; source_name: string }>();

  // Also scan recent high-quality curated content for outbound links
  const highQ = await env.DB.prepare(
    `SELECT url, title FROM curated_content WHERE quality_score >= 50
     ORDER BY curated_at DESC LIMIT 30`
  ).all<{ url: string; title: string }>();

  const allUrls = new Set<string>();
  for (const a of [...(articles.results || []), ...(highQ.results || [])]) {
    try {
      const domain = new URL(a.url).hostname;
      allUrls.add(`https://${domain}`);
    } catch {}
  }

  let scanned = 0, candidates = 0;

  for (const siteUrl of allUrls) {
    scanned++;
    try {
      const resp = await fetch(siteUrl, {
        headers: { 'User-Agent': 'EyeCX/1.0 Feed Discovery' },
        signal: AbortSignal.timeout(8000),
        redirect: 'follow',
      });
      if (!resp.ok) continue;
      const html = await resp.text();

      // Extract RSS/Atom feed links from <head>
      const feeds: string[] = [];
      let match: RegExpExecArray | null;
      for (const re of [FEED_LINK_RE, FEED_LINK_RE2]) {
        re.lastIndex = 0;
        for (let i = 0; i < 10; i++) {
          match = re.exec(html);
          if (!match) break;
          const href = match[2] || match[1];
          if (href.startsWith('http')) feeds.push(href);
          else feeds.push(new URL(href, siteUrl).href);
        }
      }

      for (const feedUrl of feeds.slice(0, 3)) {
        // Check not already a source or candidate
        const existsSource = await env.DB.prepare('SELECT id FROM curated_sources WHERE feed_url = ?').bind(feedUrl).first();
        const existsCand = await env.DB.prepare('SELECT id FROM source_candidates WHERE feed_url = ?').bind(feedUrl).first();
        if (existsSource || existsCand) continue;

        // Verify it's actually a feed
        try {
          const fResp = await fetch(feedUrl, {
            headers: { 'User-Agent': 'EyeCX/1.0 Feed Discovery' },
            signal: AbortSignal.timeout(5000),
          });
          if (!fResp.ok) continue;
          const fText = await fResp.text();
          if (!fText.includes('<item') && !fText.includes('<entry')) continue;

          const name = siteUrl.replace(/^https?:\/\//, '').replace(/\/$/, '');
          await env.DB.prepare(
            "INSERT OR IGNORE INTO source_candidates (url, feed_url, name, discovered_from) VALUES (?, ?, ?, ?)"
          ).bind(siteUrl, feedUrl, name, 'auto-discovery').run();
          candidates++;
        } catch {}
      }
    } catch {}
  }

  return { scanned, candidates };
}

// ============ SELF-TUNING ============

const TUNE_MIN_SALES = 20;
const TUNE_MIN_BUCKET = 5;
const TUNE_SHRINKAGE = 0.15;
const TUNE_SIGNALS = ['length_3','length_4','length_5','length_6','length_8',
  'clean_no_digits','clean_no_hyphen','pronounceable','dictionary'];
const TUNE_BOUNDS: Record<string, [number, number]> = {
  length_3: [20, 55], length_4: [15, 45], length_5: [10, 35],
  length_6: [5, 25], length_8: [2, 15],
  clean_no_digits: [2, 15], clean_no_hyphen: [1, 10],
  pronounceable: [3, 20], dictionary: [8, 35],
};

function domainHasSignal(name: string, signal: string): boolean {
  if (!name) return false;
  const vowels = new Set('aeiouy'.split(''));
  if (signal === 'length_3') return name.length <= 3;
  if (signal === 'length_4') return name.length === 4;
  if (signal === 'length_5') return name.length === 5;
  if (signal === 'length_6') return name.length === 6;
  if (signal === 'length_8') return name.length >= 7 && name.length <= 8;
  if (signal === 'clean_no_digits') return !/\d/.test(name);
  if (signal === 'clean_no_hyphen') return !name.includes('-');
  if (signal === 'pronounceable') {
    if (name.length < 4 || name.length > 8) return false;
    return name.split('').every((c, i) => i === 0 || (vowels.has(c) !== vowels.has(name[i-1])));
  }
  if (signal === 'dictionary') return false; // can't check without word list in Worker
  return false;
}

async function runSelfTuning(env: Env): Promise<{
  tlds_processed: number; tlds_skipped: number; changes: number; details: any[];
}> {
  // Get sales grouped by TLD
  const tldCounts = await env.DB.prepare(
    'SELECT tld, COUNT(*) as cnt FROM market_sales GROUP BY tld HAVING cnt >= ?'
  ).bind(TUNE_MIN_SALES).all<{ tld: string; cnt: number }>();

  const eligible = (tldCounts.results || []).map(r => r.tld);
  const allTlds = await env.DB.prepare(
    'SELECT DISTINCT tld FROM market_sales'
  ).all<{ tld: string }>();
  const skipped = (allTlds.results || []).length - eligible.length;

  let totalChanges = 0;
  const details: any[] = [];

  for (const tld of eligible) {
    const sales = await env.DB.prepare(
      'SELECT domain, sale_price_usd FROM market_sales WHERE tld = ? ORDER BY sale_price_usd DESC'
    ).bind(tld).all<{ domain: string; sale_price_usd: number }>();

    const rows = sales.results || [];
    if (rows.length < TUNE_MIN_SALES) continue;

    const median = rows[Math.floor(rows.length / 2)].sale_price_usd;
    const high = rows.filter(r => r.sale_price_usd >= median);
    const low = rows.filter(r => r.sale_price_usd < median);

    for (const signal of TUNE_SIGNALS) {
      const highHas = high.filter(r => domainHasSignal(r.domain.split('.')[0], signal)).length;
      const lowHas = low.filter(r => domainHasSignal(r.domain.split('.')[0], signal)).length;

      if (highHas < TUNE_MIN_BUCKET && lowHas < TUNE_MIN_BUCKET) continue;

      const highRate = high.length > 0 ? highHas / high.length : 0;
      const lowRate = low.length > 0 ? lowHas / low.length : 0;
      const lift = highRate - lowRate; // positive = signal predicts higher price

      // Get current weight
      const current = await env.DB.prepare(
        "SELECT weight FROM scoring_weights WHERE tld = ? AND signal = ?"
      ).bind(tld, signal).first<{ weight: number }>();
      const defaultW = await env.DB.prepare(
        "SELECT weight FROM scoring_weights WHERE tld = '*' AND signal = ?"
      ).bind(signal).first<{ weight: number }>();
      const oldWeight = current?.weight ?? defaultW?.weight ?? 10;

      // Compute new weight with shrinkage
      const rawDelta = lift * oldWeight;
      const delta = rawDelta * TUNE_SHRINKAGE;
      const bounds = TUNE_BOUNDS[signal] || [0, 50];
      const newWeight = Math.round(Math.max(bounds[0], Math.min(bounds[1], oldWeight + delta)) * 10) / 10;

      if (Math.abs(newWeight - oldWeight) < 0.1) continue; // idempotent: skip no-change

      const reason = `${tld} ${signal}: high=${highHas}/${high.length} low=${lowHas}/${low.length} lift=${lift.toFixed(2)} shrink=${TUNE_SHRINKAGE}`;

      await env.DB.prepare(
        "INSERT INTO scoring_weights (tld, signal, weight) VALUES (?, ?, ?) ON CONFLICT(tld, signal) DO UPDATE SET weight = ?, updated_at = datetime('now')"
      ).bind(tld, signal, newWeight, newWeight).run();

      await env.DB.prepare(
        'INSERT INTO weight_history (tld, signal, old_weight, new_weight, delta, reason) VALUES (?, ?, ?, ?, ?, ?)'
      ).bind(tld, signal, oldWeight, newWeight, Math.round((newWeight - oldWeight) * 10) / 10, reason).run();

      totalChanges++;
      details.push({ tld, signal, old: oldWeight, new: newWeight, reason: reason.slice(0, 120) });
    }
  }

  return {
    tlds_processed: eligible.length,
    tlds_skipped: skipped,
    changes: totalChanges,
    details,
  };
}

// ============ DOMAIN RESCORE ============

interface TldAggregates {
  avg_sale: Record<string, number>;
  feedback: Record<string, { saved: number; bought: number; dismissed: number }>;
}

async function precomputeAggregates(env: Env): Promise<TldAggregates> {
  const salesByTld = await env.DB.prepare(
    'SELECT tld, AVG(sale_price_usd) as avg_sale FROM market_sales GROUP BY tld'
  ).all<{ tld: string; avg_sale: number }>();

  const fbByTld = await env.DB.prepare(
    `SELECT CASE WHEN instr(domain,'.') > 0 THEN '.' || substr(domain, instr(domain,'.')+1) ELSE '' END as tld,
     signal, COUNT(*) as cnt FROM domain_feedback GROUP BY tld, signal`
  ).all<{ tld: string; signal: string; cnt: number }>();

  const avg_sale: Record<string, number> = {};
  for (const r of (salesByTld.results || [])) avg_sale[r.tld] = r.avg_sale;

  const feedback: Record<string, { saved: number; bought: number; dismissed: number }> = {};
  for (const r of (fbByTld.results || [])) {
    if (!feedback[r.tld]) feedback[r.tld] = { saved: 0, bought: 0, dismissed: 0 };
    if (r.signal === 'saved') feedback[r.tld].saved = r.cnt;
    if (r.signal === 'bought') feedback[r.tld].bought = r.cnt;
    if (r.signal === 'dismissed') feedback[r.tld].dismissed = r.cnt;
  }

  return { avg_sale, feedback };
}

function computeSimilarityBonus(tld: string, domainLen: number, agg: TldAggregates): number {
  const avg = agg.avg_sale[tld];
  if (!avg || avg <= 0) return 0;
  return Math.min(20, Math.max(0, Math.log(avg / 100) * 5));
}

function computeFeedbackBonus(tld: string, agg: TldAggregates): number {
  const fb = agg.feedback[tld];
  if (!fb) return 0;
  const raw = (fb.saved + fb.bought * 3 - fb.dismissed) * 0.5;
  return Math.min(15, Math.max(-10, raw));
}

function tierFromScore(score: number): string {
  if (score >= 85) return 'diamond';
  if (score >= 70) return 'gold';
  if (score >= 55) return 'silver';
  if (score >= 40) return 'bronze';
  return 'lead';
}

function buildReason(tld: string, simBonus: number, fbBonus: number, agg: TldAggregates): string {
  const parts: string[] = [];
  const avg = agg.avg_sale[tld];
  if (avg && simBonus !== 0) {
    parts.push(`avg ${tld} sale $${Math.round(avg)} → ${simBonus > 0 ? '+' : ''}${Math.round(simBonus)} similarity`);
  }
  const fb = agg.feedback[tld];
  if (fb && fbBonus !== 0) {
    parts.push(`${fb.saved}s ${fb.bought}b ${fb.dismissed}d on ${tld} → ${fbBonus > 0 ? '+' : ''}${fbBonus.toFixed(1)} feedback`);
  }
  return (parts.join('; ') || 'no bonus signals').slice(0, 200);
}

async function runDomainRescore(env: Env): Promise<{
  total: number; avg_delta: number; changed: number; top_risers: any[]; top_fallers: any[];
}> {
  const agg = await precomputeAggregates(env);

  const domains = await env.DB.prepare(
    'SELECT domain, tld, potential_score, brand_score FROM domains LIMIT 50000'
  ).all<{ domain: string; tld: string; potential_score: number; brand_score: number }>();

  const deltas: Array<{ domain: string; old_score: number; new_score: number; delta: number }> = [];
  let totalDelta = 0;
  let changed = 0;

  for (const d of (domains.results || [])) {
    const simBonus = computeSimilarityBonus(d.tld, d.domain.length, agg);
    const fbBonus = computeFeedbackBonus(d.tld, agg);
    const newScore = Math.min(100, Math.max(0, Math.round(d.potential_score + simBonus + fbBonus)));
    const newTier = tierFromScore(newScore);
    const delta = newScore - d.potential_score;

    await env.DB.prepare(
      `UPDATE domains SET potential_score = ?, tier = ?, score_version = score_version + 1,
       last_rescored_at = datetime('now') WHERE domain = ?`
    ).bind(newScore, newTier, d.domain).run();

    // Only record history when score actually changes (idempotent)
    if (delta !== 0) {
      const reason = buildReason(d.tld, simBonus, fbBonus, agg);
      await env.DB.prepare(
        `INSERT INTO score_history (domain, old_score, new_score, delta, old_tier, new_tier,
         base, brand, similarity_bonus, feedback_bonus, reason)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        d.domain, d.potential_score, newScore, delta,
        tierFromScore(d.potential_score), newTier,
        d.potential_score, d.brand_score || 0,
        Math.round(simBonus), Math.round(fbBonus * 10) / 10, reason
      ).run();
      changed++;
    }

    deltas.push({ domain: d.domain, old_score: d.potential_score, new_score: newScore, delta });
    totalDelta += Math.abs(delta);
  }

  deltas.sort((a, b) => b.delta - a.delta);
  const total = deltas.length;
  const avgDelta = total > 0 ? Math.round(totalDelta / total * 10) / 10 : 0;

  return {
    total,
    changed,
    avg_delta: avgDelta,
    top_risers: deltas.slice(0, 10),
    top_fallers: deltas.slice(-10).reverse(),
  };
}

// ============ INGEST GATES ============

const VALID_TIERS = new Set(['diamond', 'gold', 'silver', 'bronze', 'lead']);
const FQDN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?\.[a-z]{2,}$/;
const URL_RE = /^https?:\/\/.+/;

type GateResult = { ok: true } | { ok: false; reason: string };

function gateSale(domain: string, price: number, sourceUrl: string, saleDate?: string): GateResult {
  if (!domain || !FQDN_RE.test(domain)) return { ok: false, reason: `invalid FQDN: ${domain}` };
  if (typeof price !== 'number' || price < 50 || price > 10_000_000) return { ok: false, reason: `price out of range: ${price}` };
  if (sourceUrl && !URL_RE.test(sourceUrl)) return { ok: false, reason: `invalid source URL` };
  if (saleDate && new Date(saleDate).getTime() > Date.now() + 86400000) return { ok: false, reason: `sale date in future` };
  return { ok: true };
}

function gateCurated(title: string, url: string, publishedAt: string, slug: string): GateResult {
  if (!title || title.length < 10 || title.length > 300) return { ok: false, reason: `title length ${title?.length || 0} outside 10-300` };
  if (!url || !URL_RE.test(url)) return { ok: false, reason: `invalid URL` };
  if (publishedAt) {
    const ts = new Date(publishedAt).getTime();
    if (ts > Date.now() + 86400000) return { ok: false, reason: `published_at in future` };
    if (ts < Date.now() - 10 * 365.25 * 86400000) return { ok: false, reason: `published_at older than 10 years` };
  }
  return { ok: true };
}

function gateDomain(domain: string, score: number, tier: string, status: string): GateResult {
  if (!domain || !domain.includes('.')) return { ok: false, reason: `invalid domain: ${domain}` };
  if (typeof score !== 'number' || score < 0 || score > 100) return { ok: false, reason: `score out of range: ${score}` };
  if (!VALID_TIERS.has(tier)) return { ok: false, reason: `invalid tier: ${tier}` };
  if (!status || status === '') return { ok: false, reason: `empty availability_status` };
  return { ok: true };
}

async function logRejection(env: Env, tableName: string, key: string, reason: string, snippet?: string): Promise<void> {
  try {
    await env.DB.prepare(
      'INSERT INTO ingest_rejections (table_name, domain_or_key, reason, payload_snippet) VALUES (?, ?, ?, ?)'
    ).bind(tableName, key, reason, (snippet || '').slice(0, 200)).run();
  } catch {}
}

// ============ SALES EXTRACTION ============

const SALE_SOURCES = new Set(['DNJournal', 'NamePros', 'DomainInvesting', 'DomainNameWire', 'Domain Name Wire', 'Sedo']);
const SALE_PATTERN = /([a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.(?:com|net|org|io|ai|co|xyz|info|app|dev|me))\s*(?:[-–—]|sold\s+for|was\s+sold|acquired\s+for|for)\s*\$?([\d,]+(?:\.\d{2})?)/gi;

function extractSalesFromText(text: string): Array<{ domain: string; price: number }> {
  if (!text || text.length < 10) return [];

  const sales: Array<{ domain: string; price: number }> = [];
  const seen = new Set<string>();
  let match: RegExpExecArray | null;
  const re = new RegExp(SALE_PATTERN.source, SALE_PATTERN.flags);

  for (let i = 0; i < 200; i++) {
    match = re.exec(text);
    if (!match) break;
    const domain = match[1].toLowerCase();
    const price = parseFloat(match[2].replace(/,/g, ''));
    if (price >= 50 && price <= 100_000_000 && !seen.has(domain)) {
      seen.add(domain);
      sales.push({ domain, price });
    }
  }
  return sales;
}

async function runSalesExtraction(env: Env): Promise<{ processed: number; extracted: number; errors: number }> {
  const sources = Array.from(SALE_SOURCES).map(s => `'${s}'`).join(',');
  const rows = await env.DB.prepare(
    `SELECT id, title, excerpt, url, source_name FROM curated_content
     WHERE source_name IN (${sources}) AND extracted_at IS NULL
     ORDER BY published_at DESC LIMIT 100`
  ).all<{ id: number; title: string; excerpt: string; url: string; source_name: string }>();

  let processed = 0, extracted = 0, errors = 0;

  for (const row of (rows.results || [])) {
    try {
      const text = (row.title || '') + ' ' + (row.excerpt || '');
      const sales = extractSalesFromText(text);

      for (const sale of sales) {
        const tld = '.' + sale.domain.split('.').pop();
        const gate = gateSale(sale.domain, sale.price, row.url);
        if (!gate.ok) { await logRejection(env, 'market_sales', sale.domain, gate.reason, `$${sale.price}`); continue; }
        try {
          await env.DB.prepare(
            `INSERT OR IGNORE INTO market_sales (domain, tld, sale_price_usd, source_url, source_name)
             VALUES (?, ?, ?, ?, ?)`
          ).bind(sale.domain, tld, sale.price, row.url, row.source_name).run();
          extracted++;
        } catch {}
      }

      await env.DB.prepare(
        "UPDATE curated_content SET extracted_at = datetime('now') WHERE id = ?"
      ).bind(row.id).run();
      processed++;
    } catch (e) {
      console.error(`Sales extraction error for ID ${row.id}: ${e}`);
      errors++;
    }
  }

  return { processed, extracted, errors };
}

// ============ CONTENT CLASSIFIER ============

const CATEGORY_RULES: Array<{ cat: string; patterns: RegExp }> = [
  { cat: 'sale-report', patterns: /\$[\d,]+|sold\s+for|sold\s+at|sale\s+price|domain\s+sale|six.figure|seven.figure|million\s+dollar/i },
  { cat: 'market-analysis', patterns: /report|analysis|analysi[sz]|chart|trend|forecast|market\s+data|statistics|year.in.review|landscape/i },
  { cat: 'deal-news', patterns: /acquisition|acquired|merger|partnership|investment|funding|raised|series\s+[a-c]/i },
  { cat: 'opinion', patterns: /\bwhy\b|should|thoughts\s+on|opinion|editorial|commentary|unpopular|controversial|debate/i },
  { cat: 'tutorial', patterns: /how\s+to|guide|tutorial|step.by.step|beginner|getting\s+started|walkthrough|checklist/i },
];

function classifyContent(title: string, excerpt: string): string[] {
  if (!title) return ['uncategorized'];

  const text = (title + ' ' + (excerpt || '')).toLowerCase();
  const cats: string[] = [];

  for (const rule of CATEGORY_RULES) {
    if (rule.patterns.test(text)) cats.push(rule.cat);
  }

  return cats.length > 0 ? cats : ['uncategorized'];
}

// ============ QUALITY SCORING ============

const DOMAIN_KEYWORDS = /sold|sale|acquisition|acquired|\$|million|valuation|price|flip|aftermarket/i;
const TOP_SOURCES = new Set(['DNJournal', 'DomainNameWire', 'NamePros', 'DomainInvesting', 'ICANN']);
const NEWS_CATEGORIES = new Set(['Domain News', 'Market Analysis', 'Sales']);

function computeQualityScore(title: string, excerpt: string, publishedAt: string, category: string, sourceName: string): number {
  let score = 0;
  const daysSince = Math.floor((Date.now() - new Date(publishedAt).getTime()) / 86400000);
  if (daysSince <= 14) score += 20;
  if (DOMAIN_KEYWORDS.test(title)) score += 15;
  if (excerpt.length > 200) score += 10;
  if (NEWS_CATEGORIES.has(category)) score += 10;
  if (TOP_SOURCES.has(sourceName)) score += 5;
  return Math.min(score, 100);
}

// ============ CZDS HELPERS ============

// Authenticate with ICANN CZDS, return JWT token
async function czdsAuthenticate(username: string, password: string): Promise<string | null> {
  try {
    const resp = await fetch('https://account-api.icann.org/api/authenticate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });

    if (resp.status !== 200) {
      console.error(`CZDS auth HTTP ${resp.status}: ${await resp.text()}`);
      return null;
    }

    const data = await resp.json() as { accessToken?: string };
    return data.accessToken || null;
  } catch (e) {
    console.error('CZDS auth error:', e);
    return null;
  }
}

// Get list of approved zone download URLs
async function czdsGetApprovedZones(token: string): Promise<string[]> {
  try {
    const resp = await fetch('https://czds-api.icann.org/czds/downloads/links', {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (resp.status !== 200) {
      console.error(`CZDS links HTTP ${resp.status}`);
      return [];
    }

    const links = await resp.json() as string[];
    return Array.isArray(links) ? links : [];
  } catch (e) {
    console.error('CZDS links error:', e);
    return [];
  }
}

// Stream a zone file from CZDS directly to R2 (no memory buffering)
async function czdsStreamToR2(
  zoneUrl: string,
  token: string,
  r2Key: string,
  bucket: R2Bucket
): Promise<boolean> {
  try {
    const resp = await fetch(zoneUrl, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (resp.status !== 200 || !resp.body) {
      console.error(`CZDS download HTTP ${resp.status} for ${zoneUrl}`);
      return false;
    }

    const contentLength = resp.headers.get('Content-Length');
    const tld = zoneUrl.split('/').pop()?.replace('.zone', '') || 'unknown';

    // Stream directly from CZDS response to R2 — zero memory buffering
    await bucket.put(r2Key, resp.body, {
      httpMetadata: { contentType: 'application/gzip' },
      customMetadata: {
        tld,
        source_url: zoneUrl,
        content_length: contentLength || 'unknown',
        downloaded_at: new Date().toISOString(),
      },
    });

    console.log(`Streamed ${tld} zone to R2: ${r2Key} (${contentLength} bytes)`);
    return true;
  } catch (e) {
    console.error(`CZDS stream error for ${zoneUrl}:`, e);
    return false;
  }
}
