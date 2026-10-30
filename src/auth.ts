import { randomBytes, randomInt, scryptSync, timingSafeEqual } from 'node:crypto';
import type { Store } from './db.ts';

const SESSION_DAYS = 60;

// Invite codes get read aloud and typed on a phone, so no 0/O, 1/I/L, no _ or -.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export function randomCode(len = 10): string {
  let out = '';
  for (let i = 0; i < len; i++) out += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return out;
}

export function hashPass(password: string, salt = randomBytes(16).toString('hex')): [string, string] {
  return [scryptSync(password, salt, 64).toString('hex'), salt];
}

export function verifyPass(password: string, hash: string, salt: string): boolean {
  const got = scryptSync(password, salt, 64);
  const want = Buffer.from(hash, 'hex');
  return got.length === want.length && timingSafeEqual(got, want);
}

export function newId(prefix: string): string {
  return `${prefix}_${randomBytes(9).toString('base64url')}`;
}

export function createSession(store: Store, userId: string): string {
  const token = randomBytes(32).toString('base64url');
  const now = Date.now();
  store.run(
    'insert into sessions (token, user_id, created_at, expires_at) values (?,?,?,?)',
    token, userId, now, now + SESSION_DAYS * 86400000,
  );
  store.run('delete from sessions where expires_at < ?', now);
  return token;
}

export function userByToken(store: Store, token: string | undefined) {
  if (!token) return null;
  const row = store.get(
    `select u.* from sessions s join users u on u.id = s.user_id
     where s.token = ? and s.expires_at > ?`, token, Date.now(),
  );
  return row ?? null;
}

const AGENT_TOKEN_PREFIX = 'cal_';
export const TOKEN_SCOPES = ['read', 'write', 'delete'] as const;
export type TokenScope = typeof TOKEN_SCOPES[number];

export function createAgentToken(store: Store, userId: string, name: string, scopes: string[] = [...TOKEN_SCOPES]): string {
  const token = AGENT_TOKEN_PREFIX + randomBytes(24).toString('base64url');
  store.run('insert into agent_tokens (token, user_id, name, scopes, created_at) values (?,?,?,?,?)',
    token, userId, name.slice(0, 60), scopes.join(','), Date.now());
  return token;
}

/** Resolves a bearer token to its user plus the scopes it was issued with. */
export function agentTokenAuth(store: Store, token: string | undefined): { user: any; scopes: string[] } | null {
  if (!token || !token.startsWith(AGENT_TOKEN_PREFIX)) return null;
  const row = store.get(
    `select u.*, a.scopes as token_scopes from agent_tokens a join users u on u.id = a.user_id
     where a.token = ? and a.revoked_at is null`, token,
  );
  if (!row) return null;
  store.run('update agent_tokens set last_used_at = ? where token = ?', Date.now(), token);
  const scopes = String(row.token_scopes ?? 'read,write,delete').split(',').map((s) => s.trim()).filter(Boolean);
  delete row.token_scopes;
  return { user: row, scopes };
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const key = part.slice(0, eq).trim();
    const raw = part.slice(eq + 1).trim();
    // A malformed escape must not 500 the request (same stance as decodeParam);
    // the raw text simply cannot match a session token.
    let val = raw;
    try { val = decodeURIComponent(raw); } catch { /* keep raw */ }
    out[key] = val;
  }
  return out;
}

export function sessionCookie(token: string): string {
  return `sid=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}`;
}

export function clearCookie(): string {
  return 'sid=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0';
}

export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a), bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}
