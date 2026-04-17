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

// D1 Database binding
interface Env {
  DB: D1Database;
  API_SECRET: string;
  CLOUDFLARE_API_TOKEN: string;
  CLOUDFLARE_ACCOUNT_ID: string;
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
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
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

// Main handler
export default {
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
