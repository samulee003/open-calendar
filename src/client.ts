// Minimal HTTP client shared by the CLI and the MCP server. Zero dependencies.
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const CONFIG_PATH = join(homedir(), '.shared-calendar-agent.json');

export type ClientConfig = { base: string; token?: string; calendar?: string; tz?: string };

export function loadConfig(overrides: Partial<ClientConfig> = {}): ClientConfig {
  const file = readFileConfig();
  // An empty variable (very common in MCP host templates) must not shadow the file.
  const pick = (...vals: (string | undefined)[]) => vals.find((v) => typeof v === 'string' && v !== '');
  return {
    base: pick(overrides.base, process.env.CAL_BASE, file.base) ?? 'http://127.0.0.1:8787',
    token: pick(overrides.token, process.env.CAL_TOKEN, file.token),
    calendar: pick(overrides.calendar, process.env.CAL_CALENDAR, file.calendar),
    tz: pick(overrides.tz, process.env.CAL_TZ, file.tz),
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

export type ErrorExtra = { message?: string; hint?: string; field?: string; required?: string };

export class ApiError extends Error {
  status: number;
  code: string;
  hint?: string;
  field?: string;
  required?: string;
  constructor(status: number, code: string, extra: ErrorExtra = {}) {
    super(extra.message ?? code);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.hint = extra.hint;
    this.field = extra.field;
    this.required = extra.required;
  }

  /** The shape the CLI and MCP adapters hand back: a stable code plus next steps. */
  toJSON() {
    return {
      error: this.code,
      message: this.message,
      status: this.status,
      ...(this.required ? { required: this.required } : {}),
      ...(this.field ? { field: this.field } : {}),
      ...(this.hint ? { hint: this.hint } : {}),
    };
  }
}

// Server errors already carry a stable code; the hint tells an agent what to do
// instead of retrying the same failing call.
const HINTS: Record<string, string> = {
  need_login: 'the token is missing or was revoked; create a new agent token in the browser',
  insufficient_scope: 'this token lacks the required scope; ask the user for a token that includes it, do not retry',
  no_such_event: 'find the current id with list_events; deleted events appear in list_trash',
  no_such_calendar: 'call list_calendars for the ids this account can use',
  not_a_member: 'this account is not a member of that calendar',
  owner_only: 'only the calendar owner can create invite codes',
  bad_invite: 'the invite code is unknown; ask for a fresh one',
  idempotency_key_reused: 'that request_id was already used with a different body; generate a new one',
  stale_event: 'the event changed after you read it; call get_event and retry with the fresh updated_at',
  bad_time: 'pass epoch ms from list_events, or "YYYY-MM-DD HH:MM"',
  occurrence_not_found: 'pass the occurrence_start epoch reported by list_events',
  no_such_token: 'the subscription token is unknown or already revoked',
  bad_token: 'the subscription token is unknown or already revoked',
  expired_token: 'this subscription link expired; create a new one',
  bad_credentials: 'the email or password is wrong',
};

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
    if (!res.ok) {
      const code = String(json?.error ?? `http_${res.status}`);
      throw new ApiError(res.status, code, {
        hint: typeof json?.hint === 'string' ? json.hint : HINTS[code],
        field: typeof json?.field === 'string' ? json.field : undefined,
        required: typeof json?.required === 'string' ? json.required : undefined,
      });
    }
    return json as T;
  }
}
