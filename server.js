const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const url = require('url');

let stripe = null;
try {
  stripe = require('stripe')(process.env.STRIPE_SECRET_KEY || '');
} catch (e) {
  // stripe module not available, will handle gracefully
}

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.ANTHROPIC_API_KEY || '';
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || '';
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';
const STRIPE_PRICE_STUDENT = process.env.STRIPE_PRICE_STUDENT || '';
const STRIPE_PRICE_SERIOUS = process.env.STRIPE_PRICE_SERIOUS || '';

// Rate limiting for API requests: 20 requests per minute per IP
const rateLimitMap = new Map();
const RATE_LIMIT_REQUESTS = 20;
const RATE_LIMIT_WINDOW = 60000; // 1 minute in ms

const MIME_TYPES = {
  '.html': 'text/html',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.eot': 'application/vnd.ms-fontobject',
};

// Cache control headers by extension
const CACHE_HEADERS = {
  '.html': 'public, max-age=3600', // 1 hour
  '.css': 'public, max-age=604800', // 1 week
  '.js': 'public, max-age=604800', // 1 week
  '.json': 'public, max-age=604800', // 1 week
  '.png': 'public, max-age=604800', // 1 week
  '.jpg': 'public, max-age=604800', // 1 week
  '.jpeg': 'public, max-age=604800', // 1 week
  '.gif': 'public, max-age=604800', // 1 week
  '.webp': 'public, max-age=604800', // 1 week
  '.svg': 'public, max-age=604800', // 1 week
  '.ico': 'public, max-age=604800', // 1 week
  '.woff': 'public, max-age=604800', // 1 week
  '.woff2': 'public, max-age=604800', // 1 week
  '.ttf': 'public, max-age=604800', // 1 week
};

function checkRateLimit(ip) {
  const now = Date.now();
  if (!rateLimitMap.has(ip)) {
    rateLimitMap.set(ip, []);
  }

  const requests = rateLimitMap.get(ip);
  // Remove requests outside the window
  const filtered = requests.filter(time => now - time < RATE_LIMIT_WINDOW);
  rateLimitMap.set(ip, filtered);

  if (filtered.length >= RATE_LIMIT_REQUESTS) {
    return false;
  }

  filtered.push(now);
  return true;
}

function getClientIP(req) {
  return (req.headers['x-forwarded-for'] || req.connection.remoteAddress || '').split(',')[0].trim();
}

function shouldCompress(contentType) {
  return contentType && (
    contentType.includes('text') ||
    contentType.includes('json') ||
    contentType.includes('javascript') ||
    contentType.includes('svg')
  );
}

function serveFile(res, filePath, contentType) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }

    const headers = {
      'Content-Type': contentType,
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'SAMEORIGIN',
    };

    const ext = path.extname(filePath);
    if (CACHE_HEADERS[ext]) {
      headers['Cache-Control'] = CACHE_HEADERS[ext];
    }

    // Add gzip compression for text-based content
    if (shouldCompress(contentType)) {
      const acceptEncoding = res.req?.headers?.['accept-encoding'] || '';
      if (acceptEncoding.includes('gzip')) {
        headers['Content-Encoding'] = 'gzip';
        res.writeHead(200, headers);
        zlib.gzip(data, (err, compressed) => {
          if (err) {
            res.end(data);
          } else {
            res.end(compressed);
          }
        });
        return;
      }
    }

    res.writeHead(200, headers);
    res.end(data);
  });
}

function logAPIUsage(method, path, statusCode, ip) {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${method} ${path} - ${statusCode} - IP: ${ip}`);
}

function parseQueryString(queryString) {
  const params = {};
  if (!queryString) return params;
  queryString.split('&').forEach(pair => {
    const [key, value] = pair.split('=');
    params[key] = decodeURIComponent(value || '');
  });
  return params;
}

const server = http.createServer((req, res) => {
  const clientIP = getClientIP(req);

  // Security headers
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');

  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, stripe-signature');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // Health check
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
    return;
  }

  // Landing page at /
  if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
    serveFile(res, path.join(__dirname, 'landing.html'), 'text/html');
    return;
  }

  // App at /app
  if (req.method === 'GET' && req.url === '/app') {
    serveFile(res, path.join(__dirname, 'stem-study-tool.html'), 'text/html');
    return;
  }

  // Logo
  if (req.method === 'GET' && req.url === '/revaix_study_logo_v3.svg') {
    serveFile(res, path.join(__dirname, 'revaix_study_logo_v3.svg'), 'image/svg+xml');
    return;
  }

  // Static file serving with dynamic MIME types
  if (req.method === 'GET' && req.url.startsWith('/')) {
    const urlParts = url.parse(req.url);
    const filePath = path.join(__dirname, urlParts.pathname);

    // Security: prevent directory traversal
    if (!filePath.startsWith(__dirname)) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    // Only serve files if they exist and have known types (avoid serving arbitrary files)
    fs.stat(filePath, (err, stats) => {
      if (err || !stats.isFile()) {
        // Not a file, will fall through to 404
        return;
      }

      // Only serve certain file types
      if (contentType !== 'application/octet-stream' || ext === '') {
        serveFile(res, filePath, contentType);
        return;
      }

      // Unknown extension, skip
      res.writeHead(404);
      res.end('Not found');
    });
    return;
  }

  // Stripe Checkout endpoint
  if (req.method === 'POST' && req.url.startsWith('/api/checkout')) {
    if (!stripe || !STRIPE_SECRET_KEY) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Stripe is not configured' }));
      return;
    }

    const urlParts = url.parse(req.url, true);
    const plan = urlParts.query.plan || 'student';

    const STRIPE_PRICE_STUDENT_YEARLY = process.env.STRIPE_PRICE_STUDENT_YEARLY || '';
    const STRIPE_PRICE_SERIOUS_YEARLY = process.env.STRIPE_PRICE_SERIOUS_YEARLY || '';

    let priceId = STRIPE_PRICE_STUDENT;
    let amount = 5;

    if (plan === 'serious') {
      priceId = STRIPE_PRICE_SERIOUS;
      amount = 10;
    } else if (plan === 'student_yearly') {
      priceId = STRIPE_PRICE_STUDENT_YEARLY || STRIPE_PRICE_STUDENT;
      amount = 48;
    } else if (plan === 'serious_yearly') {
      priceId = STRIPE_PRICE_SERIOUS_YEARLY || STRIPE_PRICE_SERIOUS;
      amount = 96;
    }

    if (!priceId) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Price ID not configured for this plan' }));
      return;
    }

    const origin = req.headers.origin || `http://localhost:${PORT}`;

    stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [
        {
          price: priceId,
          quantity: 1,
        },
      ],
      mode: 'subscription',
      success_url: `${origin}/app?upgraded=true`,
      cancel_url: `${origin}/#pricing`,
    }, (err, session) => {
      logAPIUsage('POST', '/api/checkout', err ? 500 : 200, clientIP);

      if (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
        return;
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ sessionId: session.id, url: session.url }));
    });
    return;
  }

  // Stripe webhook endpoint
  if (req.method === 'POST' && req.url === '/api/webhook') {
    if (!STRIPE_WEBHOOK_SECRET) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Webhook secret not configured' }));
      return;
    }

    let body = '';
    req.on('data', chunk => {
      if (body.length > 10 * 1024 * 1024) {
        req.connection.destroy();
      }
      body += chunk;
    });

    req.on('end', () => {
      const sig = req.headers['stripe-signature'];

      try {
        const event = stripe?.webhooks?.constructEvent(body, sig, STRIPE_WEBHOOK_SECRET);

        if (event?.type === 'checkout.session.completed') {
          const session = event.data.object;
          console.log(`[${new Date().toISOString()}] Checkout session completed: ${session.id}`);
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ received: true }));
      } catch (err) {
        logAPIUsage('POST', '/api/webhook', 400, clientIP);
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // Status endpoint
  if (req.method === 'GET' && req.url === '/api/status') {
    logAPIUsage('GET', '/api/status', 200, clientIP);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', plan: 'free' }));
    return;
  }

  // API proxy to Anthropic with rate limiting
  if (req.method === 'POST' && req.url === '/api/messages') {
    if (!checkRateLimit(clientIP)) {
      logAPIUsage('POST', '/api/messages', 429, clientIP);
      res.writeHead(429, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Too many requests. Max 20 requests per minute.' }));
      return;
    }

    let body = '';
    const maxSize = 10 * 1024 * 1024; // 10MB

    req.on('data', chunk => {
      body += chunk;
      if (body.length > maxSize) {
        req.connection.destroy();
      }
    });

    req.on('end', () => {
      if (!API_KEY) {
        logAPIUsage('POST', '/api/messages', 503, clientIP);
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'API key not configured' } }));
        return;
      }

      logAPIUsage('POST', '/api/messages', 200, clientIP);

      const options = {
        hostname: 'api.anthropic.com',
        path: '/v1/messages',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': API_KEY,
          'anthropic-version': '2023-06-01',
          'Content-Length': Buffer.byteLength(body)
        }
      };

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
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`\n✅ Revaix Study running at http://localhost:${PORT}`);
  console.log(`   Landing page: http://localhost:${PORT}`);
  console.log(`   App: http://localhost:${PORT}/app`);
  console.log(`   Health: http://localhost:${PORT}/health\n`);

  if (!API_KEY) {
    console.warn('⚠️  No Anthropic API key found. Set it with:');
    console.warn('   PowerShell: $env:ANTHROPIC_API_KEY="your_key_here"; node server.js\n');
  }

  if (!STRIPE_SECRET_KEY) {
    console.warn('⚠️  No Stripe secret key found. Stripe endpoints will not work.');
    console.warn('   Set it with: $env:STRIPE_SECRET_KEY="your_key_here"\n');
  } else if (!STRIPE_PRICE_STUDENT || !STRIPE_PRICE_SERIOUS) {
    console.warn('⚠️  Stripe price IDs not fully configured:');
    if (!STRIPE_PRICE_STUDENT) console.warn('   STRIPE_PRICE_STUDENT not set');
    if (!STRIPE_PRICE_SERIOUS) console.warn('   STRIPE_PRICE_SERIOUS not set\n');
  }
});
