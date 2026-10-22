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

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0) out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
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
