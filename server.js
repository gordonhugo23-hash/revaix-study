const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.ANTHROPIC_API_KEY || '';
const FAL_KEY = process.env.FAL_KEY || '';
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || '';
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || '';

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

const FREE_LIMIT = 3;

const MIME_TYPES = {
  '.html': 'text/html',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.css': 'text/css',
  '.js': 'application/javascript',
};

function serveFile(res, filePath, contentType) {
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
}

function proxyPost(res, hostname, pathname, headers, body) {
  const options = { hostname, path: pathname, method: 'POST', headers };
  const proxyReq = https.request(options, (proxyRes) => {
    res.writeHead(proxyRes.statusCode, { 'Content-Type': 'application/json' });
    proxyRes.pipe(res);
  });
  proxyReq.on('error', (e) => {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: e.message } }));
  });
  proxyReq.write(body);
  proxyReq.end();
}

function jsonResponse(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

// Collect request body as buffer
function collectBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// Verify Stripe webhook signature manually (no Express, no stripe package needed)
function verifyStripeSignature(payload, sigHeader, secret) {
  const crypto = require('crypto');
  const parts = sigHeader.split(',').reduce((acc, part) => {
    const [k, v] = part.split('=');
    acc[k] = v;
    return acc;
  }, {});

  const timestamp = parts['t'];
  const signature = parts['v1'];
  const signed = `${timestamp}.${payload}`;
  const expected = crypto.createHmac('sha256', secret).update(signed).digest('hex');
  return expected === signature;
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // --- Static pages ---
  if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
    serveFile(res, path.join(__dirname, 'landing.html'), 'text/html'); return;
  }
  if (req.method === 'GET' && req.url.startsWith('/app')) {
    serveFile(res, path.join(__dirname, 'stem-study-tool.html'), 'text/html'); return;
  }
  if (req.method === 'GET' && req.url.startsWith('/signup')) {
    serveFile(res, path.join(__dirname, 'signup.html'), 'text/html'); return;
  }
  if (req.method === 'GET' && req.url.startsWith('/login')) {
    serveFile(res, path.join(__dirname, 'login.html'), 'text/html'); return;
  }
  if (req.method === 'GET' && req.url === '/revaix_study_logo_v3.svg') {
    serveFile(res, path.join(__dirname, 'revaix_study_logo_v3.svg'), 'image/svg+xml'); return;
  }
  const ext = path.extname(req.url);
  if (req.method === 'GET' && MIME_TYPES[ext]) {
    serveFile(res, path.join(__dirname, req.url.split('?')[0]), MIME_TYPES[ext]); return;
  }

  // --- Sitemap ---
  if (req.method === 'GET' && req.url === '/sitemap.xml') {
    const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>https://revaixstudy.com/</loc>
    <changefreq>weekly</changefreq>
    <priority>1.0</priority>
  </url>
</urlset>`;
    res.writeHead(200, { 'Content-Type': 'application/xml' });
    res.end(sitemap);
    return;
  }

  // --- Anthropic API proxy ---
  if (req.method === 'POST' && req.url === '/api/messages') {
    const body = await collectBody(req);
    proxyPost(res, 'api.anthropic.com', '/v1/messages', {
      'Content-Type': 'application/json',
      'x-api-key': API_KEY,
      'anthropic-version': '2023-06-01',
      'Content-Length': body.length
    }, body);
    return;
  }

  // --- fal.ai image proxy ---
  if (req.method === 'POST' && req.url === '/api/generate-image') {
    if (!FAL_KEY) {
      jsonResponse(res, 503, { error: { message: 'Image generation not configured' } }); return;
    }
    const body = await collectBody(req);
    const parsed = JSON.parse(body.toString());
    const falBody = Buffer.from(JSON.stringify({
      prompt: parsed.prompt,
      image_size: 'landscape_4_3',
      num_inference_steps: 28,
      guidance_scale: 3.5,
      num_images: 1,
      enable_safety_checker: true
    }));
    proxyPost(res, 'fal.run', '/fal-ai/flux/schnell', {
      'Content-Type': 'application/json',
      'Authorization': `Key ${FAL_KEY}`,
      'Content-Length': falBody.length
    }, falBody);
    return;
  }

  // --- Check usage ---
  if (req.method === 'POST' && req.url === '/api/check-usage') {
    const body = await collectBody(req);
    const { user_id } = JSON.parse(body.toString());

    const { data: sub } = await supabase
      .from('subscriptions')
      .select('plan')
      .eq('user_id', user_id)
      .single();

    if (sub?.plan === 'pro') {
      return jsonResponse(res, 200, { allowed: true, plan: 'pro', remaining: null });
    }

    const { data: usage } = await supabase
      .from('usage')
      .select('total_count, notes_count, exam_count, mark_count')
      .eq('user_id', user_id)
      .single();

    const total = usage?.total_count ?? 0;
    return jsonResponse(res, 200, {
      allowed: total < FREE_LIMIT,
      plan: 'free',
      total_count: total,
      notes_count: usage?.notes_count ?? 0,
      exam_count: usage?.exam_count ?? 0,
      mark_count: usage?.mark_count ?? 0,
      remaining: Math.max(0, FREE_LIMIT - total)
    });
  }

  // --- Increment usage ---
  if (req.method === 'POST' && req.url === '/api/increment-usage') {
    const body = await collectBody(req);
    const { user_id, tool } = JSON.parse(body.toString()); // tool: 'notes' | 'exam' | 'mark'

    await supabase.rpc('increment_usage', { uid: user_id, tool });
    return jsonResponse(res, 200, { ok: true });
  }

  // --- Stripe webhook ---
  if (req.method === 'POST' && req.url === '/api/stripe-webhook') {
    const body = await collectBody(req);
    const sig = req.headers['stripe-signature'];

    if (!verifyStripeSignature(body.toString(), sig, STRIPE_WEBHOOK_SECRET)) {
      return jsonResponse(res, 400, { error: 'Invalid signature' });
    }

    const event = JSON.parse(body.toString());
    const obj = event.data.object;

    if (event.type === 'checkout.session.completed') {
      const userId = obj.client_reference_id;
      if (userId) {
        await supabase
          .from('subscriptions')
          .upsert({ user_id: userId, stripe_customer_id: obj.customer, plan: 'pro', updated_at: new Date() }, { onConflict: 'user_id' });
      }
    }

    if (['customer.subscription.updated', 'customer.subscription.deleted'].includes(event.type)) {
      const isActive = obj.status === 'active';
      await supabase
        .from('subscriptions')
        .update({ plan: isActive ? 'pro' : 'free', updated_at: new Date() })
        .eq('stripe_customer_id', obj.customer);
    }

    return jsonResponse(res, 200, { received: true });
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`\n✅ Revaix Study running at http://localhost:${PORT}`);
  console.log(`   Landing: http://localhost:${PORT}`);
  console.log(`   App:     http://localhost:${PORT}/app\n`);
  if (!API_KEY) console.warn('⚠️  ANTHROPIC_API_KEY not set');
  if (!SUPABASE_URL) console.warn('⚠️  SUPABASE_URL not set');
  if (!SUPABASE_SERVICE_KEY) console.warn('⚠️  SUPABASE_SERVICE_KEY not set');
  if (!STRIPE_SECRET_KEY) console.warn('⚠️  STRIPE_SECRET_KEY not set');
  if (!STRIPE_WEBHOOK_SECRET) console.warn('⚠️  STRIPE_WEBHOOK_SECRET not set');
});