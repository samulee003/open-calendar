// Minimal HTTP client shared by the CLI and the MCP server. Zero dependencies.
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const CONFIG_PATH = join(homedir(), '.shared-calendar-agent.json');

export type ClientConfig = { base: string; token?: string; calendar?: string; tz?: string };

export function loadConfig(overrides: Partial<ClientConfig> = {}): ClientConfig {
  const file = readFileConfig();
  return {
    base: overrides.base ?? process.env.CAL_BASE ?? file.base ?? 'http://127.0.0.1:8787',
    token: overrides.token ?? process.env.CAL_TOKEN ?? file.token,
    calendar: overrides.calendar ?? process.env.CAL_CALENDAR ?? file.calendar,
    tz: overrides.tz ?? process.env.CAL_TZ ?? file.tz,
  };
}

function readFileConfig(): Partial<ClientConfig> {
  try { return JSON.parse(readFileSync(CONFIG_PATH, 'utf8')); } catch { return {}; }
}

export function saveConfig(patch: Partial<ClientConfig>): ClientConfig {
  // Never fold env vars into the file: CAL_TOKEN is per-invocation, the file is durable.
  const merged = { ...readFileConfig(), ...patch };
  writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2));
  return merged;
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

export class Client {
  base: string;
  token?: string;
  calendar?: string;
  tz?: string;
  private meCache?: Promise<{ id: string; email: string; name: string; tz: string }>;

  constructor(cfg: ClientConfig) {
    this.base = cfg.base.replace(/\/+$/, '');
    this.token = cfg.token;
    this.calendar = cfg.calendar;
    this.tz = cfg.tz;
  }

  me() {
    this.meCache ??= this.call('GET', '/api/me').catch((e) => { this.meCache = undefined; throw e; });
    return this.meCache;
  }

  async call<T = any>(method: string, path: string,
    opts: { query?: Record<string, string | number | undefined | null>; body?: unknown } = {}): Promise<T> {
    const url = new URL(path, this.base);
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
    const headers: Record<string, string> = {};
    if (this.token) {
      // Agent tokens are bearer; a session token from `login` rides in the cookie.
      if (this.token.startsWith('cal_')) headers.authorization = `Bearer ${this.token}`;
      else headers.cookie = `sid=${this.token}`;
    }
    let body: string | undefined;
    if (opts.body !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(opts.body);
    }
    const res = await fetch(url, { method, headers, body });
    const text = await res.text();
    let json: any;
    try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
    if (!res.ok) throw new ApiError(res.status, String(json?.error ?? `http_${res.status}`));
    return json as T;
  }
}
