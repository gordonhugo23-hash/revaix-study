const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.ANTHROPIC_API_KEY || '';

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

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
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

  // API proxy
  if (req.method === 'POST' && req.url === '/api/messages') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
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

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`\n✅ Revaix Study running at http://localhost:${PORT}`);
  console.log(`   Landing page: http://localhost:${PORT}`);
  console.log(`   App: http://localhost:${PORT}/app\n`);
  if (!API_KEY) {
    console.warn('⚠️  No API key found. Set it with:');
    console.warn('   PowerShell: $env:ANTHROPIC_API_KEY="your_key_here"; node server.js\n');
  }
});
