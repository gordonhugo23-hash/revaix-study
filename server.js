const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.ANTHROPIC_API_KEY || '';

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // Serve HTML
  if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
    const filePath = path.join(__dirname, 'stem-study-tool.html');
    fs.readFile(filePath, (err, data) => {
      if (err) { res.writeHead(404); res.end('Not found'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(data);
    });
    return;
  }

  // ── Standard (non-streaming) proxy ──
  if (req.method === 'POST' && req.url === '/api/messages') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      const parsed = JSON.parse(body);
      const outBody = JSON.stringify(parsed);

      const options = {
        hostname: 'api.anthropic.com',
        path: '/v1/messages',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': API_KEY,
          'anthropic-version': '2023-06-01',
          'Content-Length': Buffer.byteLength(outBody)
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

      proxyReq.write(outBody);
      proxyReq.end();
    });
    return;
  }

  // ── Streaming proxy ──
  // Frontend sends POST to /api/stream
  // Server forwards to Anthropic with stream:true
  // Streams SSE events back to browser
  if (req.method === 'POST' && req.url === '/api/stream') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      let parsed;
      try { parsed = JSON.parse(body); } catch(e) {
        res.writeHead(400); res.end('Bad JSON'); return;
      }

      // Inject stream: true
      parsed.stream = true;
      const outBody = JSON.stringify(parsed);

      // SSE headers
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no'
      });

      const options = {
        hostname: 'api.anthropic.com',
        path: '/v1/messages',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': API_KEY,
          'anthropic-version': '2023-06-01',
          'Content-Length': Buffer.byteLength(outBody)
        }
      };

      const proxyReq = https.request(options, (proxyRes) => {
        let buffer = '';

        proxyRes.on('data', chunk => {
          buffer += chunk.toString();
          const lines = buffer.split('\n');
          buffer = lines.pop(); // keep incomplete line

          for (const line of lines) {
            if (line.startsWith('data: ')) {
              const data = line.slice(6).trim();
              if (data === '[DONE]') {
                res.write('data: [DONE]\n\n');
                res.end();
                return;
              }
              try {
                const evt = JSON.parse(data);
                // Extract text delta
                if (evt.type === 'content_block_delta' && evt.delta?.type === 'text_delta') {
                  const text = evt.delta.text;
                  res.write(`data: ${JSON.stringify({ text })}\n\n`);
                }
                // Signal message end
                if (evt.type === 'message_stop') {
                  res.write('data: [DONE]\n\n');
                  res.end();
                }
              } catch (_) {}
            }
          }
        });

        proxyRes.on('end', () => {
          if (!res.writableEnded) {
            res.write('data: [DONE]\n\n');
            res.end();
          }
        });
      });

      proxyReq.on('error', (e) => {
        res.write(`data: ${JSON.stringify({ error: e.message })}\n\n`);
        res.end();
      });

      req.on('close', () => {
        proxyReq.destroy();
      });

      proxyReq.write(outBody);
      proxyReq.end();
    });
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`\n✅ Revaix Study running at http://localhost:${PORT}`);
  console.log(`   Open your browser to http://localhost:${PORT}\n`);
  if (!API_KEY) {
    console.warn('⚠️  No API key found. Set it with:');
    console.warn('   PowerShell: $env:ANTHROPIC_API_KEY="your_key_here"; node server.js\n');
  }
});
