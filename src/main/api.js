const http = require('http');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

function tokenMatches(expected, given) {
  if (typeof given !== 'string') return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function requestToken(req, url) {
  const auth = req.headers.authorization || '';
  if (auth.startsWith('Bearer ')) return auth.slice(7);
  return url.searchParams.get('token');
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 64 * 1024) reject(new Error('body too large'));
    });
    req.on('end', () => {
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error('invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function send(res, status, payload) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(JSON.stringify(payload));
}

function startApi(config, windows) {
  const routes = [
    ['GET', /^\/windows$/, () => [200, windows.list()]],
    ['POST', /^\/windows$/, () => [201, { id: windows.create() }]],
    ['DELETE', /^\/windows\/(\d+)$/, (id) => windows.close(id)],
    ['POST', /^\/windows\/(\d+)\/close$/, (id) => windows.close(id)],
    ['POST', /^\/windows\/(\d+)\/reset-position$/, (id) => windows.resetPosition(id)],
    ['POST', /^\/windows\/(\d+)\/focus$/, (id) => windows.focus(id)],
    ['POST', /^\/windows\/(\d+)\/move-mode$/, (id, body) => windows.setMoveMode(id, body.enabled ?? true)],
  ];

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      });
      return res.end();
    }
    if (!tokenMatches(config.token, requestToken(req, url))) {
      return send(res, 401, { error: 'unauthorized' });
    }

    for (const [method, pattern, handler] of routes) {
      const match = url.pathname.match(pattern);
      if (!match || req.method !== method) continue;
      try {
        const body = method === 'POST' ? await readJson(req) : {};
        const result = handler(match[1], body);
        if (Array.isArray(result)) return send(res, result[0], result[1]);
        return result ? send(res, 200, { ok: true }) : send(res, 404, { error: 'no such window' });
      } catch (err) {
        return send(res, 400, { error: err.message });
      }
    }
    send(res, 404, { error: 'not found' });
  });

  // Live window-list updates: ws://host:port/events?token=...
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname !== '/events' || !tokenMatches(config.token, requestToken(req, url))) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      return socket.destroy();
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.send(JSON.stringify({ type: 'windows', windows: windows.list() }));
    });
  });
  windows.on('changed', (list) => {
    const msg = JSON.stringify({ type: 'windows', windows: list });
    for (const client of wss.clients) if (client.readyState === client.OPEN) client.send(msg);
  });

  server.on('error', (err) => console.error('API server error:', err.message));
  server.listen(config.port, config.host, () => {
    console.log(`LAN API listening on http://${config.host}:${config.port}`);
  });
  return server;
}

module.exports = { startApi };
