// Shared harness for the "server is gone, device is fine" browser tests.
//
// Two servers, both on loopback, both disposable:
//   origin — the app's shell (client/dist) plus the handful of API routes the
//            client needs, serving the tiny fixtures in ../fixtures
//   proxy  — sits in front like Cloudflare does, and can be flipped into
//            "origin unreachable" mode: an HTML error page for every request
//            (as a 502, and optionally as a 200 — Cloudflare error pages can
//            arrive either way, and a status check alone would call the 200
//            variant "up")
//
// Nothing here talks to the real app, the real CDN or the network.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const E2E_DIR = path.resolve(HERE, '..');
export const REPO = path.resolve(HERE, '../../..');
export const DIST = path.join(REPO, 'client/dist');
export const SRC = path.join(REPO, 'client/src');
export const FIXTURES = path.join(E2E_DIR, 'fixtures');

/** Cloudflare's origin-down page, near enough: HTML, nothing to do with us. */
export const CF_PAGE = `<!doctype html><html><head><title>acnh.datahippo.top | 502: Bad gateway</title></head>
<body><h1>Bad gateway</h1><p>Error code 502</p><p>Visit cloudflare.com for more information.</p></body></html>`;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.wasm': 'application/wasm',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.txt': 'text/plain; charset=utf-8',
};

/** 1x1 transparent PNG, for /img/* requests. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);

function staticFile(urlPath) {
  const clean = decodeURIComponent(urlPath.split('?')[0]);
  const abs = path.join(DIST, path.normalize(clean));
  if (!abs.startsWith(DIST)) return null;
  try {
    if (fs.statSync(abs).isFile()) return abs;
  } catch {
    /* fall through to the SPA fallback */
  }
  if (!path.extname(clean)) return path.join(DIST, 'index.html');
  return null;
}

export function requireBuiltClient() {
  if (!fs.existsSync(path.join(DIST, 'index.html'))) {
    throw new Error(`client/dist is missing — run \`make client-build\` first (looked in ${DIST})`);
  }
}

function startOrigin() {
  const refRaw = fs.readFileSync(path.join(FIXTURES, 'reference.v1.db.gz'));
  const refSha = crypto.createHash('sha256').update(refRaw).digest('hex');
  const progressSeed = fs.readFileSync(path.join(FIXTURES, 'progress.db'));
  const version = fs.readFileSync(path.join(DIST, 'version.txt'), 'utf8').trim();

  const state = { progress: progressSeed, puts: 0, lastPut: null, requests: 0 };
  const server = http.createServer((req, res) => {
    state.requests++;
    const p = new URL(req.url, 'http://origin').pathname;
    const send = (status, type, body) => {
      res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
      res.end(body);
    };
    const authed = (req.headers.cookie || '').includes('sess=1');

    if (p === '/health') return send(200, 'application/json', JSON.stringify({ ok: 'true' }));
    if (p === '/version.txt') return send(200, 'text/plain', version);
    if (p === '/api/auth/config') return send(200, 'application/json', JSON.stringify({ mode: 'password' }));
    if (p === '/api/login' && req.method === 'POST') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': 'sess=1; Path=/; HttpOnly' });
      return res.end(JSON.stringify({ username: 'testuser' }));
    }
    if (p === '/api/logout') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': 'sess=; Path=/; Max-Age=0' });
      return res.end(JSON.stringify({ ok: true }));
    }
    if (p === '/api/me') {
      if (!authed) return send(401, 'application/json', JSON.stringify({ error: 'not signed in' }));
      return send(200, 'application/json', JSON.stringify({ username: 'testuser' }));
    }
    if (p === '/api/progress' && req.method === 'GET') {
      if (!authed) return send(401, 'application/json', JSON.stringify({ error: 'not signed in' }));
      return send(200, 'application/octet-stream', state.progress);
    }
    if (p === '/api/progress' && req.method === 'PUT') {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      return req.on('end', () => {
        if (!authed) return send(401, 'application/json', JSON.stringify({ error: 'not signed in' }));
        state.progress = Buffer.concat(chunks);
        state.puts++;
        state.lastPut = state.progress;
        send(200, 'application/json', JSON.stringify({ ok: 'saved', username: 'testuser' }));
      });
    }
    if (p === '/db/manifest.json') {
      return send(
        200,
        'application/json',
        JSON.stringify({
          latest: 1,
          imageHash: '',
          references: [{ version: 1, file: 'reference.v1.db.gz', size: refRaw.length, sha256: refSha }],
        }),
      );
    }
    if (p === '/db/reference.v1.db.gz') return send(200, 'application/gzip', refRaw);
    // No image bundle in this stub → the install offer never appears.
    if (p === '/img/manifest.json') return send(200, 'application/json', JSON.stringify({ hash: '' }));
    if (p.startsWith('/img/')) return send(200, 'image/png', PNG);

    const file = staticFile(req.url);
    if (!file) return send(404, 'text/plain', 'not found');
    return send(200, MIME[path.extname(file)] ?? 'application/octet-stream', fs.readFileSync(file));
  });
  return { server, state };
}

function startProxy(originPort) {
  const state = { mode: 'up', putAttempts: 0 };
  const cloudflarePage = (res) => {
    res.writeHead(state.mode === 'down200' ? 200 : 502, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      Server: 'cloudflare',
    });
    res.end(CF_PAGE);
  };
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/__mode/')) {
      state.mode = req.url.slice('/__mode/'.length) || 'up';
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      return res.end(state.mode);
    }
    // Counted before the mode check: this is "the app tried to upload", whether
    // or not the CDN was willing to forward it.
    if (req.method === 'PUT' && req.url.startsWith('/api/progress')) state.putAttempts++;
    if (state.mode !== 'up') return cloudflarePage(res);
    const upstream = http.request(
      { host: '127.0.0.1', port: originPort, path: req.url, method: req.method, headers: req.headers },
      (up) => {
        res.writeHead(up.statusCode, up.headers);
        up.pipe(res);
      },
    );
    upstream.on('error', () => cloudflarePage(res));
    req.pipe(upstream);
  });
  return { server, state };
}

const listen = (server) =>
  new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));

/**
 * Boot the stub stack. `base` is the URL the browser should use (the proxy), so
 * the app talks to a "CDN" that can die on command.
 */
export async function startStack({ mode = 'up' } = {}) {
  requireBuiltClient();
  const origin = startOrigin();
  const originPort = await listen(origin.server);
  const proxy = startProxy(originPort);
  proxy.state.mode = mode;
  const proxyPort = await listen(proxy.server);
  const base = `http://127.0.0.1:${proxyPort}`;
  return {
    base,
    origin: origin.state,
    proxy: proxy.state,
    async setMode(next) {
      await fetch(`${base}/__mode/${next}`);
      proxy.state.mode = next;
    },
    close() {
      proxy.server.close();
      origin.server.close();
    },
  };
}

// --- Page helpers -----------------------------------------------------------

export const LIST = 'input[placeholder^="Search by name"]';

export async function login(page, base) {
  await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.fill('input[name=username]', 'testuser');
  await page.fill('input[name=password]', 'testpass');
  await page.click('button[type=submit]');
  await page.waitForSelector(LIST, { timeout: 30000 });
  await page.waitForSelector('text=Ace', { timeout: 30000 });
}

export async function badges(page) {
  return page.evaluate(() => ({
    local: document.querySelector('[data-save-local]')?.getAttribute('data-save-local'),
    network: document.querySelector('[data-save-network]')?.getAttribute('data-save-network'),
    connection: document.querySelector('[data-connection-status]')?.getAttribute('data-connection'),
  }));
}

export async function waitForConnection(page, expected, timeout = 30000) {
  await page.waitForFunction(
    (want) => document.querySelector('[data-connection-status]')?.getAttribute('data-connection') === want,
    expected,
    { timeout },
  );
}

/**
 * The gift log as the device has it: the exact record the app writes to
 * IndexedDB. `head` is the file signature, `text` the raw bytes as latin1 (good
 * enough to look for stored strings), `unsynced` the "server hasn't confirmed
 * this" flag.
 */
export async function readProgressRecord(page) {
  return page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      // No version pinned: the app owns the schema version, and a stale pin
      // here is exactly how a real regression once hid itself.
      const req = indexedDB.open('acnh');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    try {
      if (!db.objectStoreNames.contains('progress')) return { exists: false, reason: 'no progress store' };
      const rec = await new Promise((resolve) => {
        const q = db.transaction('progress', 'readonly').objectStore('progress').get('current');
        q.onsuccess = () => resolve(q.result);
        q.onerror = () => resolve(null);
      });
      if (!rec) return { exists: false };
      const bytes = new Uint8Array(rec.bytes ?? new ArrayBuffer(0));
      let text = '';
      for (let i = 0; i < bytes.length; i++) text += String.fromCharCode(bytes[i]);
      return {
        exists: true,
        unsynced: !!rec.unsynced,
        length: bytes.length,
        head: text.slice(0, 16),
        text,
      };
    } finally {
      db.close();
    }
  });
}

/** Store names + version of the shared app database. */
export async function readSchema(page) {
  return page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const req = indexedDB.open('acnh');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const out = { version: db.version, stores: [...db.objectStoreNames] };
    db.close();
    return out;
  });
}

/**
 * Open every collapsed section on a villager page and tap the first "mark as
 * gifted" button. The gift cards live inside <details>, and which one is open
 * depends on what the user did before.
 */
export async function markFirstGift(page) {
  await page.waitForSelector('text=Gift ideas', { timeout: 30000 });
  await page.evaluate(() => document.querySelectorAll('details').forEach((d) => (d.open = true)));
  const mark = page.locator('button[aria-label="Mark as gifted"]').first();
  await mark.waitFor({ state: 'visible', timeout: 15000 });
  await mark.click();
}

export function log(prefix) {
  return (...args) => console.log(`[${prefix}]`, ...args);
}

export function checker(logger) {
  const failures = [];
  const check = (name, ok, detail = '') => {
    logger(`${ok ? 'PASS' : 'FAIL'} — ${name}${detail ? ` (${detail})` : ''}`);
    if (!ok) failures.push(name);
  };
  return { check, failures };
}
