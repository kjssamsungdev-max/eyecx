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

    // ============ BEARER API_SECRET ROUTES (existing) ============

    // Auth required for all other endpoints
    if (!authenticate(request, env)) {
      return error('Unauthorized', 401);
    }

    try {
      // GET /api/domains
      if (path === '/api/domains' && request.method === 'GET') {
        return await getDomains(url, env);
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

  let query = `
    SELECT domain, tld, potential_score, tier, estimated_flip_value,
           page_rank, wayback_snapshots, estimated_age_years, backlinks,
           majestic_rank, tranco_rank, availability_status, first_seen
    FROM domains
    WHERE potential_score >= ?
  `;
  const params: any[] = [minScore];

  if (tier) {
    query += ' AND tier = ?';
    params.push(tier);
  }

  if (tld) {
    query += ' AND tld = ?';
    params.push(tld);
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

    const result = {
      domain,
      available: data.result?.available || false,
      price: data.result?.purchase_price?.amount,
      premium: data.result?.premium || false,
      checked_at: new Date().toISOString(),
    };

    // Update database
    await env.DB.prepare(`
      UPDATE domains 
      SET availability_status = ?, registration_price = ?
      WHERE domain = ?
    `).bind(
      result.available ? 'available' : 'registered',
      result.price,
      domain
    ).run();

    return json(result);
  } catch (e) {
    return error('Failed to check availability');
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
    LEFT JOIN community_users u ON t.author_id = u.id`;
  const params: any[] = [];

  if (category) {
    query += ' WHERE t.category = ?';
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
     WHERE c.parent_type = ? AND c.parent_id = ? AND c.deleted = 0
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
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '20'), 50);
  const offset = parseInt(url.searchParams.get('offset') || '0');

  const result = await env.DB.prepare(
    `SELECT id, source_name, title, url, excerpt, author, published_at, category, tags,
     views, featured FROM curated_content WHERE status = 'published' AND archived = 0
     ORDER BY published_at DESC LIMIT ? OFFSET ?`
  ).bind(limit, offset).all();

  return json({ articles: result.results || [], count: result.results?.length || 0 });
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
      const newItems = await fetchAndCurateFeed(source, env);
      fetched++;
      inserted += newItems;

      await env.DB.prepare(
        'UPDATE curated_sources SET last_fetched_at = datetime(\'now\'), total_items = total_items + ? WHERE id = ?'
      ).bind(newItems, source.id).run();
    } catch (e) {
      console.error(`RSS error for ${source.name}: ${e}`);
      errors++;
    }
  }

  return { sources: sources.results?.length || 0, fetched, inserted, errors };
}

async function fetchAndCurateFeed(source: CurationSource, env: Env): Promise<number> {
  const resp = await fetch(source.feed_url, {
    headers: { 'User-Agent': 'EyeCX/1.0 RSS Curator' },
    signal: AbortSignal.timeout(15000),
  });
  if (!resp.ok) return 0;

  const xml = await resp.text();
  const items = parseRssItems(xml, 50);
  let inserted = 0;

  for (const item of items) {
    if (!item.url || !item.title) continue;

    // Dedupe by URL
    const exists = await env.DB.prepare(
      'SELECT id FROM curated_content WHERE url = ?'
    ).bind(item.url).first();
    if (exists) continue;

    const slug = item.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 100);
    const excerpt = (item.description || '').slice(0, 500);
    const tags = extractTags(item.title + ' ' + excerpt);

    await env.DB.prepare(
      `INSERT INTO curated_content (source_id, source_name, title, url, excerpt, author,
       published_at, category, tags, slug, quality_score, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'published')`
    ).bind(
      source.id, source.name, item.title, item.url, excerpt,
      item.author || '', item.pubDate || new Date().toISOString(),
      source.category, JSON.stringify(tags), slug, 50
    ).run();
    inserted++;
  }

  return inserted;
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
