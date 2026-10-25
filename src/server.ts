import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { freshStore, type Store, type Row } from './db.ts';
import { parseCookies, sessionCookie, clearCookie, userByToken, agentTokenAuth } from './auth.ts';
import { routes } from './api.ts';

const HERE = resolve(fileURLToPath(new URL('.', import.meta.url)));
const PUBLIC = join(HERE, '..', 'public');
const MAX_BODY = 2 * 1024 * 1024;

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json; charset=utf-8', '.json': 'application/json; charset=utf-8',
};

// style-src needs 'unsafe-inline' because the UI colours chips with style attributes.
const SECURITY_HEADERS: Record<string, string> = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'content-security-policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};

type Handler = [string, string];
const HANDLERS: Handler[] = Object.entries(routes).map(([key, fn]) => {
  const [method, path] = key.split(' ');
  return [`${method} ${path}`, fn as unknown as Handler[1]];
});

function compile(path: string): [RegExp, string[]] {
  const names: string[] = [];
  const pattern = path.replace(/\/:([A-Za-z_]+)/g, (_m, n) => { names.push(n); return '/([^/]+)'; });
  return [new RegExp(`^${pattern.replace(/\./g, '\\.')}$`), names];
}

const COMPILED = HANDLERS.map(([key, fn]) => {
  const sp = key.indexOf(' ');
  return { method: key.slice(0, sp), regex: compile(key.slice(sp + 1)), fn };
});

function readBody(req: import('node:http').IncomingMessage): Promise<any> {
  return new Promise((res, rej) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) { rej(new HttpAbort()); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return res(undefined);
      const text = Buffer.concat(chunks).toString('utf8');
      try { res(JSON.parse(text)); } catch { res(text); }
    });
    req.on('error', rej);
  });
}

class HttpAbort extends Error {}

export function makeServer(store: Store) {
  return createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const method = req.method ?? 'GET';
    const send = (status: number, payload: unknown, headers: Record<string, string> = {}) => {
      const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...SECURITY_HEADERS, ...headers });
      res.end(body);
    };

    // Same-origin check for state-changing requests; the session cookie is Lax so
    // a cross-site form post would not even carry it, but we fail explicitly too.
    if (method !== 'GET' && method !== 'HEAD') {
      const origin = req.headers.origin;
      if (typeof origin === 'string' && origin !== `http://${req.headers.host}`) {
        send(403, { error: 'cross_origin' });
        return;
      }
    }

    const cookies = parseCookies(req.headers.cookie);
    const bearer = /^Bearer (.+)$/i.exec(String(req.headers.authorization ?? ''))?.[1];
    // A CLI/MCP agent authenticates with a long-lived agent token instead of a cookie.
    // `via` lets routes distinguish them: token management must be a browser session,
    // so a leaked agent token cannot mint replacements or revoke its siblings.
    const cookieUser = userByToken(store, cookies.sid) as Row | null;
    const tokenAuth = cookieUser ? null : agentTokenAuth(store, bearer);
    const via = cookieUser ? 'cookie' : tokenAuth ? 'token' : null;
    const scopes: string[] = tokenAuth?.scopes ?? [];
    let user: Row | null = (cookieUser ?? tokenAuth?.user ?? null) as Row | null;

    // Agent tokens are scoped: read covers GET, write covers POST/PUT, delete covers
    // DELETE. Browser sessions are unrestricted.
    if (via === 'token' && url.pathname.startsWith('/api/')) {
      const required = method === 'GET' || method === 'HEAD' ? 'read' : method === 'DELETE' ? 'delete' : 'write';
      if (!scopes.includes(required)) {
        send(403, { error: 'insufficient_scope', required, scopes });
        return;
      }
    }
    // Trust X-Forwarded-For only behind a proxy you control; otherwise a client can
    // rotate the header to dodge the per-IP login limit.
    const forwarded = process.env.TRUST_PROXY === '1'
      ? String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim()
      : '';
    const ip = forwarded || req.socket.remoteAddress || 'unknown';

    if (method === 'GET' && !url.pathname.startsWith('/api/') && !url.pathname.startsWith('/ics/')) {
      const rel = url.pathname === '/' ? 'index.html' : normalize(url.pathname).replace(/^(\.\.[/\\])+/, '').slice(1);
      try {
        const file = await readFile(join(PUBLIC, rel));
        res.writeHead(200, { 'content-type': MIME[extname(rel)] ?? 'application/octet-stream', ...SECURITY_HEADERS });
        res.end(file);
      } catch {
        res.writeHead(404); res.end('not found');
      }
      return;
    }

    for (const route of COMPILED) {
      if (route.method !== method) continue;
      const m = route.regex[0].exec(url.pathname);
      if (!m) continue;
      const params: Record<string, string> = {};
      route.regex[1].forEach((name, i) => { params[name] = decodeURIComponent(m[i + 1]); });

      let body: any;
      try { body = method === 'GET' ? undefined : await readBody(req); }
      catch (e) { if (e instanceof HttpAbort) send(413, { error: 'body_too_large' }); else send(400, { error: 'bad_body' }); return; }
      if (body !== undefined && typeof body !== 'object') { send(400, { error: 'json_object_required' }); return; }

      try {
        const result = await (route.fn as any)({ store, user, via, params, query: url.searchParams, body, ip, headers: req.headers });
        const headers: Record<string, string> = {};
        // Only an explicit `session` field sets the cookie. Inferring it from any
        // field named `token` once clobbered the session with an ICS token.
        if (result?.session) headers['set-cookie'] = sessionCookie(result.session);
        if (result?.raw) {
          res.writeHead(200, { 'content-type': result.contentType ?? 'text/plain; charset=utf-8', 'cache-control': 'public, max-age=60', ...SECURITY_HEADERS });
          res.end(result.raw);
          return;
        }
        send(200, result, headers);
      } catch (e: any) {
        const status = typeof e?.status === 'number' ? e.status : 500;
        if (status === 500) console.error('ERR', url.pathname, e);
        send(status, { error: e?.message ?? 'internal' });
      }
      return;
    }
    send(404, { error: 'no_route' });
  });
}

const PORT = Number(process.env.PORT ?? 8787);
const DATA = process.env.DATA_DIR ?? join(HERE, '..', 'data');

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const store = freshStore(DATA);
  makeServer(store).listen(PORT, '127.0.0.1', () => {
    console.log(`shared-calendar listening on http://127.0.0.1:${PORT}  (data: ${DATA})`);
  });
}

export { clearCookie };
