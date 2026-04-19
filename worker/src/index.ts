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
  CLOUDFLARE_API_TOKEN: string;
  CLOUDFLARE_ACCOUNT_ID: string;
  CZDS_USERNAME: string;
  CZDS_PASSWORD: string;
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

// Target TLDs to download from CZDS
const CZDS_TLDS = ['xyz', 'info', 'biz', 'net', 'org'];

// Main handler
export default {
  // Cron trigger: runs daily at 1 AM UTC
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    console.log('CZDS cron triggered:', new Date().toISOString());

    if (!env.CZDS_USERNAME || !env.CZDS_PASSWORD) {
      console.error('CZDS credentials not set. Run: npx wrangler secret put CZDS_USERNAME / CZDS_PASSWORD');
      return;
    }

    try {
      // 1. Authenticate with CZDS
      const token = await czdsAuthenticate(env.CZDS_USERNAME, env.CZDS_PASSWORD);
      if (!token) {
        console.error('CZDS authentication failed');
        return;
      }
      console.log('CZDS auth successful');

      // 2. Get list of approved zones
      const approvedZones = await czdsGetApprovedZones(token);
      console.log(`CZDS approved zones: ${approvedZones.length}`);

      // 3. Filter to our target TLDs
      const today = new Date().toISOString().split('T')[0];
      const targetZones = approvedZones.filter(url => {
        const tld = url.split('/').pop()?.replace('.zone', '') || '';
        return CZDS_TLDS.includes(tld);
      });
      console.log(`Target zones to download: ${targetZones.length}`);

      // 4. Stream each zone file to R2
      for (const zoneUrl of targetZones) {
        const tld = zoneUrl.split('/').pop()?.replace('.zone', '') || '';
        const r2Key = `raw/${tld}/${tld}_${today}.zone.gz`;

        // Skip if already downloaded today
        const existing = await env.ZONES.head(r2Key);
        if (existing) {
          console.log(`Already have ${r2Key}, skipping`);
          continue;
        }

        console.log(`Downloading ${tld} zone file...`);
        const ok = await czdsStreamToR2(zoneUrl, token, r2Key, env.ZONES);
        console.log(`${tld}: ${ok ? 'success' : 'failed'}`);
      }

      // 5. Log completion
      console.log('CZDS cron complete:', new Date().toISOString());
    } catch (e) {
      console.error('CZDS cron error:', e);
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
