import type { Store, Row } from './db.ts';
import { expand, parseRRule } from './rrule.ts';
import { icsForCalendar } from './ics.ts';
import { dayKey, isValidZone, wallParts } from './tz.ts';
import { parseQuickAdd } from './nlp.ts';
import {
  newId, randomCode, hashPass, verifyPass, createSession, userByToken, safeEqual,
} from './auth.ts';

const DAY = 86400000;

export type Ctx = {
  store: Store;
  user: Row | null;
  params: Record<string, string>;
  query: URLSearchParams;
  body: any;
  ip: string;
};

const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_PER_EMAIL = 8;
const LOGIN_MAX_PER_IP = 30;

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}
export { HttpError };

// ---------- helpers ----------

function needUser(ctx: Ctx): Row {
  if (!ctx.user) throw new HttpError(401, 'need_login');
  return ctx.user;
}

function membership(ctx: Ctx, calendarId: string): Row | null {
  const u = needUser(ctx);
  return ctx.store.get(
    'select * from members where calendar_id = ? and user_id = ?', calendarId, String(u.id),
  ) ?? null;
}

function mustView(ctx: Ctx, calendarId: string): Row {
  const m = membership(ctx, calendarId);
  if (!m) throw new HttpError(403, 'not_a_member');
  return m;
}

function calRow(ctx: Ctx, calendarId: string): Row {
  const c = ctx.store.get('select * from calendars where id = ?', calendarId);
  if (!c) throw new HttpError(404, 'no_such_calendar');
  return c;
}

function intOrNull(v: unknown): number | null {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

type EventInput = {
  title: string; note: string; location: string; allDay: boolean;
  start_at: number; end_at: number; label_id: number | null;
  rrule: string | null; reminders: number[]; attendees: string[]; tz: string;
};

function resolveZone(raw: any, fallback: string): string {
  return isValidZone(raw?.tz) ? String(raw.tz) : fallback;
}

function normalizeEvent(raw: any, tz: string): EventInput {
  const title = String(raw?.title ?? '').trim();
  if (!title) throw new HttpError(400, 'title_required');
  if (title.length > 500) throw new HttpError(400, 'title_too_long');

  const zone = resolveZone(raw, tz);
  const allDay = raw?.all_day === true || raw?.all_day === 1;
  let start = intOrNull(raw?.start_at);
  const end = intOrNull(raw?.end_at);
  if (start === null) throw new HttpError(400, 'start_at_required');
  if (allDay) {
    // All-day events are stored as UTC midnight of the user's calendar day, so
    // VALUE=DATE in ICS and the recurrence day keys agree with what they see.
    const w = wallParts(start, zone);
    start = Date.UTC(w.y, w.mo - 1, w.d);
  }
  const duration = allDay ? DAY : 3600000;
  const finished = end === null ? start + duration : end;
  if (finished < start) throw new HttpError(400, 'end_before_start');

  let rrule: string | null = null;
  const r = raw?.rrule;
  if (typeof r === 'string' && r.trim()) {
    const text = r.trim().startsWith('RRULE:') ? r.trim() : `RRULE:${r.trim()}`;
    if (!parseRRule(text)) throw new HttpError(400, 'bad_rrule');
    rrule = text;
  }

  const reminders = Array.isArray(raw?.reminders)
    ? raw.reminders.map((x: unknown) => Math.trunc(Number(x))).filter((n: number) => Number.isFinite(n) && n >= 0 && n <= 60 * 24 * 60)
    : [];
  const attendees = Array.isArray(raw?.attendees) ? raw.attendees.map(String) : [];

  return {
    title,
    note: String(raw?.note ?? '').slice(0, 20000),
    location: String(raw?.location ?? '').slice(0, 1000),
    allDay,
    start_at: start,
    end_at: finished,
    label_id: intOrNull(raw?.label_id),
    rrule,
    reminders,
    attendees,
    tz: zone,
  };
}

function insertEvent(ctx: Ctx, calendarId: string, ev: EventInput, userId: string): string {
  const now = Date.now();
  const id = newId('evt');
  ctx.store.run(
    `insert into events (id, calendar_id, title, note, location, all_day, start_at, end_at, tz,
       label_id, rrule, exdates, created_by, created_at, updated_at)
     values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    id, calendarId, ev.title, ev.note, ev.location, ev.allDay ? 1 : 0, ev.start_at, ev.end_at,
    ev.tz, ev.label_id, ev.rrule, '[]', userId, now, now,
  );
  for (const minutes of ev.reminders) ctx.store.run('insert or ignore into reminders (event_id, minutes) values (?,?)', id, minutes);
  for (const a of ev.attendees) ctx.store.run('insert or ignore into attendees (event_id, user_id) values (?,?)', id, a);
  return id;
}

/** Expand stored events into concrete occurrences, applying per-occurrence overrides. */
function occurrences(ctx: Ctx, calendarIds: string[], from: number, to: number): Row[] {
  if (!calendarIds.length) return [];
  const ph = calendarIds.map(() => '?').join(',');
  const rows = ctx.store.all(
    `select e.*, l.name as label_name, l.color as label_color
     from events e left join labels l on l.id = e.label_id
     where e.calendar_id in (${ph}) and e.deleted_at is null`, ...calendarIds,
  );

  const out: Row[] = [];
  for (const e of rows) {
    const start = Number(e.start_at), end = Number(e.end_at);
    const allDay = Number(e.all_day) === 1;
    const duration = Math.max(allDay ? DAY : 1, end - start);
    const rrule = e.rrule ? String(e.rrule) : null;
    const exdates: string[] = (JSON.parse(String(e.exdates || '[]')) as unknown[]).map(String);
    const tz = String(e.tz || 'UTC');

    let occs: number[];
    if (rrule) occs = expand(rrule, start, duration, from, to, exdates, tz);
    else occs = end >= from && start <= to ? [start] : [];

    for (const occ of occs) {
      const ov = ctx.store.get('select * from overrides where event_id = ? and orig_start = ?', String(e.id), occ);
      if (ov && Number(ov.gone) === 1) continue;
      const s = ov?.start_at != null ? Number(ov.start_at) : occ;
      const en = ov?.end_at != null ? Number(ov.end_at) : s + duration;
      const cmts = ctx.store.get('select count(*) as n from comments where event_id = ? and deleted_at is null', String(e.id));
      out.push({
        id: String(e.id),
        occurrence_start: occ,
        calendar_id: String(e.calendar_id),
        all_day: ov?.all_day != null ? Number(ov.all_day) === 1 : allDay,
        start_at: s,
        end_at: en,
        title: ov?.title != null ? String(ov.title) : String(e.title),
        note: ov?.note != null ? String(ov.note) : String(e.note),
        location: ov?.location != null ? String(ov.location) : String(e.location),
        label_id: e.label_id == null ? null : Number(e.label_id),
        label_name: e.label_name ? String(e.label_name) : null,
        label_color: e.label_color ? String(e.label_color) : null,
        rrule,
        recurring: !!rrule,
        overridden: !!ov,
        created_by: String(e.created_by),
        comment_count: Number(cmts?.n ?? 0),
      } as unknown as Row);
    }
  }
  out.sort((a: any, b: any) => a.start_at - b.start_at);
  return out;
}

// ---------- routes ----------

export const routes = {
  'POST /api/signup': (ctx: Ctx) => {
    const email = String(ctx.body?.email ?? '').trim().toLowerCase();
    const name = String(ctx.body?.name ?? '').trim();
    const password = String(ctx.body?.password ?? '');
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new HttpError(400, 'bad_email');
    if (!name) throw new HttpError(400, 'name_required');
    if (password.length < 8) throw new HttpError(400, 'password_too_short');
    if (ctx.store.get('select id from users where email = ?', email)) throw new HttpError(409, 'email_taken');
    const [hash, salt] = hashPass(password);
    const id = newId('usr');
    ctx.store.run('insert into users (id, email, name, pass_hash, pass_salt, tz, created_at) values (?,?,?,?,?,?,?)',
      id, email, name.slice(0, 100), hash, salt, String(ctx.body?.tz ?? 'UTC'), Date.now());
    const personal = newId('cal');
    ctx.store.run('insert into calendars (id, name, color, owner_id, created_at) values (?,?,?,?,?)',
      personal, `${name} 的日曆`, '#4a90d9', id, Date.now());
    ctx.store.run('insert into members (calendar_id, user_id, role, joined_at) values (?,?,?,?)', personal, id, 'owner', Date.now());
    for (const [i, [n, c]] of [['工作', '#e06666'], ['家庭', '#6aa84f'], ['個人', '#8e7cc3']].entries())
      ctx.store.run('insert into labels (calendar_id, name, color, position) values (?,?,?,?)', personal, n, c, i);
    return { session: createSession(ctx.store, id), user_id: id };
  },

  'POST /api/login': (ctx: Ctx) => {
    const email = String(ctx.body?.email ?? '').trim().toLowerCase();
    const now = Date.now();
    const windowStart = now - LOGIN_WINDOW_MS;
    ctx.store.run('delete from login_failures where ts < ?', now - 86400000);
    const byEmail = Number(ctx.store.get(
      'select count(*) as n from login_failures where email = ? and ts > ?', email, windowStart)?.n ?? 0);
    const byIp = Number(ctx.store.get(
      'select count(*) as n from login_failures where ip = ? and ts > ?', ctx.ip, windowStart)?.n ?? 0);
    if (byEmail >= LOGIN_MAX_PER_EMAIL || byIp >= LOGIN_MAX_PER_IP) throw new HttpError(429, 'too_many_attempts');

    const row = ctx.store.get('select * from users where email = ?', email);
    if (!row || !verifyPass(String(ctx.body?.password ?? ''), String(row.pass_hash), String(row.pass_salt))) {
      ctx.store.run('insert into login_failures (email, ip, ts) values (?,?,?)', email, ctx.ip, now);
      throw new HttpError(401, 'bad_credentials');
    }
    ctx.store.run('delete from login_failures where email = ?', email);
    return { session: createSession(ctx.store, String(row.id)), user_id: String(row.id) };
  },

  'POST /api/logout': (ctx: Ctx) => {
    if (ctx.user) ctx.store.run('delete from sessions where token = ?', ctx.query.get('t') ?? '');
    return { ok: true };
  },

  'GET /api/me': (ctx: Ctx) => {
    const u = needUser(ctx);
    return { id: u.id, email: u.email, name: u.name, tz: u.tz };
  },

  'GET /api/calendars': (ctx: Ctx) => {
    const u = needUser(ctx);
    return ctx.store.all(
      `select c.*, m.role, (select count(*) from members x where x.calendar_id = c.id) as member_count
       from calendars c join members m on m.calendar_id = c.id and m.user_id = ?
       order by c.created_at`, String(u.id));
  },

  'POST /api/calendars': (ctx: Ctx) => {
    const u = needUser(ctx);
    const name = String(ctx.body?.name ?? '').trim();
    if (!name) throw new HttpError(400, 'name_required');
    const id = newId('cal');
    ctx.store.run('insert into calendars (id, name, color, owner_id, created_at) values (?,?,?,?,?)',
      id, name.slice(0, 120), String(ctx.body?.color ?? '#4a90d9'), String(u.id), Date.now());
    ctx.store.run('insert into members (calendar_id, user_id, role, joined_at) values (?,?,?,?)', id, String(u.id), 'owner', Date.now());
    return { id };
  },

  'POST /api/calendars/:id/invite': (ctx: Ctx) => {
    calRow(ctx, ctx.params.id);
    const m = mustView(ctx, ctx.params.id);
    if (m.role !== 'owner') throw new HttpError(403, 'owner_only');
    let code = randomCode(10);
    for (let i = 0; i < 5 && ctx.store.get('select 1 as x from invites where code = ?', code); i++) code = randomCode(10);
    ctx.store.run('insert or ignore into invites (code, calendar_id, created_by, created_at) values (?,?,?,?)',
      code, ctx.params.id, String(ctx.user!.id), Date.now());
    return { code };
  },

  'POST /api/join': (ctx: Ctx) => {
    const u = needUser(ctx);
    const code = String(ctx.body?.code ?? '').trim().toUpperCase();
    const inv = ctx.store.get('select * from invites where code = ?', code);
    if (!inv) throw new HttpError(404, 'bad_invite');
    ctx.store.run('insert or ignore into members (calendar_id, user_id, role, joined_at) values (?,?,?,?)',
      String(inv.calendar_id), String(u.id), 'member', Date.now());
    return { calendar_id: inv.calendar_id };
  },

  'GET /api/calendars/:id/members': (ctx: Ctx) => {
    mustView(ctx, ctx.params.id);
    return ctx.store.all(
      `select u.id, u.name, m.role from members m join users u on u.id = m.user_id where m.calendar_id = ?`,
      ctx.params.id);
  },

  'GET /api/calendars/:id/labels': (ctx: Ctx) => {
    mustView(ctx, ctx.params.id);
    return ctx.store.all('select * from labels where calendar_id = ? order by position, id', ctx.params.id);
  },

  'POST /api/calendars/:id/labels': (ctx: Ctx) => {
    mustView(ctx, ctx.params.id);
    const name = String(ctx.body?.name ?? '').trim();
    if (!name) throw new HttpError(400, 'name_required');
    const info = ctx.store.run('insert into labels (calendar_id, name, color, position) values (?,?,?,?)',
      ctx.params.id, name.slice(0, 60), String(ctx.body?.color ?? '#888888'),
      Number(ctx.store.get('select count(*) as n from labels where calendar_id = ?', ctx.params.id)?.n ?? 0));
    return { id: Number(info.lastInsertRowid) };
  },

  'DELETE /api/labels/:id': (ctx: Ctx) => {
    const l = ctx.store.get('select * from labels where id = ?', ctx.params.id);
    if (!l) throw new HttpError(404, 'no_such_label');
    mustView(ctx, String(l.calendar_id));
    ctx.store.run('delete from labels where id = ?', ctx.params.id);
    return { ok: true };
  },

  // Natural-language quick add: "明天下午3點看牙醫" -> one event, or a preview when
  // the sentence lacks a date/time (so the caller can ask instead of guessing).
  'POST /api/calendars/:id/quick-add': (ctx: Ctx) => {
    const u = needUser(ctx);
    mustView(ctx, ctx.params.id);
    const text = String(ctx.body?.text ?? '').trim();
    if (!text) throw new HttpError(400, 'text_required');
    const tz = isValidZone(ctx.body?.tz) ? String(ctx.body.tz) : String(u.tz ?? 'UTC');
    const parsed = parseQuickAdd(text, { now: new Date(), tz });
    const w = wallParts(parsed.start_at, tz);
    const display = parsed.all_day
      ? `${w.y}-${String(w.mo).padStart(2, '0')}-${String(w.d).padStart(2, '0')} 全天`
      : `${w.y}-${String(w.mo).padStart(2, '0')}-${String(w.d).padStart(2, '0')} ${String(w.hh).padStart(2, '0')}:${String(w.mi).padStart(2, '0')}`;
    const payload = {
      title: parsed.title,
      all_day: parsed.all_day,
      start_at: parsed.start_at,
      end_at: parsed.end_at,
      rrule: parsed.rrule,
      tz,
    };
    // Only a high-confidence parse is created without asking; anything the parser had
    // to assume (missing date or time) comes back for confirmation.
    if (ctx.body?.confirm !== true && parsed.confidence !== 'high') {
      return { needs_confirmation: true, parsed, display, event: payload };
    }
    const id = insertEvent(ctx, ctx.params.id, normalizeEvent(payload, tz), String(u.id));
    return { created: id, parsed, display };
  },

  'GET /api/calendars/:id/events': (ctx: Ctx) => {
    mustView(ctx, ctx.params.id);
    const from = intOrNull(ctx.query.get('from')) ?? Date.now();
    const to = intOrNull(ctx.query.get('to')) ?? from + 31 * DAY;
    return occurrences(ctx, [ctx.params.id], from, to);
  },

  'GET /api/events': (ctx: Ctx) => {
    const u = needUser(ctx);
    const cals = ctx.store.all('select calendar_id from members where user_id = ?', String(u.id)).map((r) => String(r.calendar_id));
    const from = intOrNull(ctx.query.get('from')) ?? Date.now();
    const to = intOrNull(ctx.query.get('to')) ?? from + 31 * DAY;
    return occurrences(ctx, cals, from, to);
  },

  'POST /api/calendars/:id/events': (ctx: Ctx) => {
    const u = needUser(ctx);
    mustView(ctx, ctx.params.id);
    const ev = normalizeEvent(ctx.body, String(u.tz ?? 'UTC'));
    return { id: insertEvent(ctx, ctx.params.id, ev, String(u.id)) };
  },

  // The endpoint this whole project exists for: one request, many dates.
  'POST /api/calendars/:id/events/batch': (ctx: Ctx) => {
    const u = needUser(ctx);
    mustView(ctx, ctx.params.id);
    const list = ctx.body?.events;
    if (!Array.isArray(list) || !list.length) throw new HttpError(400, 'events_required');
    if (list.length > 500) throw new HttpError(400, 'too_many_in_batch');
    const created: string[] = [], failed: { index: number; reason: string }[] = [];
    list.forEach((raw, i) => {
      try { created.push(insertEvent(ctx, ctx.params.id, normalizeEvent(raw, String(u.tz ?? 'UTC')), String(u.id))); }
      catch (e) { failed.push({ index: i, reason: e instanceof HttpError ? e.message : 'unknown' }); }
    });
    return { created: created.length, ids: created, failed };
  },

  'GET /api/events/:id': (ctx: Ctx) => {
    const e = ctx.store.get('select * from events where id = ?', ctx.params.id);
    if (!e || Number(e.deleted_at) > 0) throw new HttpError(404, 'no_such_event');
    mustView(ctx, String(e.calendar_id));
    const comments = ctx.store.all(
      `select c.id, c.body, c.created_at, u.name, u.id as user_id from comments c
       join users u on u.id = c.user_id where c.event_id = ? and c.deleted_at is null
       order by c.created_at`, ctx.params.id);
    const reactions = ctx.store.all(
      `select emoji, count(*) as n, sum(case when user_id = ? then 1 else 0 end) as mine
       from reactions where event_id = ? group by emoji`, String(ctx.user!.id), ctx.params.id);
    return {
      event: e,
      comments,
      reactions: reactions.map((r) => ({ emoji: String(r.emoji), count: Number(r.n), mine: Number(r.mine ?? 0) > 0 })),
      reminders: ctx.store.all('select minutes from reminders where event_id = ?', ctx.params.id),
      attendees: ctx.store.all('select user_id from attendees where event_id = ?', ctx.params.id),
    };
  },

  'PUT /api/events/:id': (ctx: Ctx) => {
    const e = ctx.store.get('select * from events where id = ?', ctx.params.id);
    if (!e) throw new HttpError(404, 'no_such_event');
    mustView(ctx, String(e.calendar_id));
    const ev = normalizeEvent({
      title: ctx.body?.title ?? e.title,
      note: ctx.body?.note ?? e.note,
      location: ctx.body?.location ?? e.location,
      all_day: ctx.body?.all_day ?? Number(e.all_day) === 1,
      start_at: ctx.body?.start_at ?? e.start_at,
      end_at: ctx.body?.end_at ?? e.end_at,
      label_id: ctx.body?.label_id !== undefined ? ctx.body.label_id : e.label_id,
      rrule: ctx.body?.rrule !== undefined ? ctx.body.rrule : e.rrule,
      reminders: ctx.body?.reminders ?? [],
      attendees: ctx.body?.attendees ?? [],
      tz: ctx.body?.tz ?? e.tz,
    }, String(e.tz ?? 'UTC'));
    ctx.store.run(
      `update events set title=?, note=?, location=?, all_day=?, start_at=?, end_at=?, label_id=?, rrule=?, updated_at=?
       where id=?`, ev.title, ev.note, ev.location, ev.allDay ? 1 : 0, ev.start_at, ev.end_at,
      ev.label_id, ev.rrule, Date.now(), ctx.params.id);
    ctx.store.run('delete from reminders where event_id = ?', ctx.params.id);
    for (const m of ev.reminders) ctx.store.run('insert or ignore into reminders (event_id, minutes) values (?,?)', ctx.params.id, m);
    return { ok: true };
  },

  // scope: all | future | occurrence
  'DELETE /api/events/:id': (ctx: Ctx) => {
    const e = ctx.store.get('select * from events where id = ?', ctx.params.id);
    if (!e) throw new HttpError(404, 'no_such_event');
    mustView(ctx, String(e.calendar_id));
    const scope = ctx.query.get('scope') ?? 'all';
    const occ = intOrNull(ctx.query.get('occ'));

    if (scope === 'all') {
      ctx.store.run('update events set deleted_at = ? where id = ?', Date.now(), ctx.params.id);
      return { scope: 'all' };
    }
    if (!e.rrule) throw new HttpError(400, 'not_recurring');
    if (occ === null) throw new HttpError(400, 'occ_required');

    if (scope === 'occurrence') {
      const tz = String(e.tz || 'UTC');
      const ex = new Set<string>([...(JSON.parse(String(e.exdates || '[]')) as unknown[]).map(String), dayKey(occ, tz)]);
      ctx.store.run('update events set exdates = ?, updated_at = ? where id = ?',
        JSON.stringify([...ex].sort()), Date.now(), ctx.params.id);
      return { scope: 'occurrence', day: dayKey(occ, tz) };
    }

    // future: cut the series at the day before this occurrence, keep this one onward as a new event
    const until = new Date(occ - DAY).toISOString().replace(/[-:]/g, '').slice(0, 8) + 'T235959Z';
    const oldRule = String(e.rrule).replace(/;UNTIL=[^;]*/g, '');
    ctx.store.run('update events set rrule = ?, updated_at = ? where id = ?', `${oldRule};UNTIL=${until}`, Date.now(), ctx.params.id);
    return { scope: 'future', until };
  },

  // edit one occurrence without touching the series
  'POST /api/events/:id/override': (ctx: Ctx) => {
    const e = ctx.store.get('select * from events where id = ?', ctx.params.id);
    if (!e) throw new HttpError(404, 'no_such_event');
    mustView(ctx, String(e.calendar_id));
    const occ = intOrNull(ctx.body?.occurrence_start);
    if (occ === null) throw new HttpError(400, 'occurrence_start_required');
    ctx.store.run(
      `insert into overrides (event_id, orig_start, title, note, location, all_day, start_at, end_at, gone)
       values (?,?,?,?,?,?,?,?,?)
       on conflict(event_id, orig_start) do update set
         title=excluded.title, note=excluded.note, location=excluded.location,
         all_day=excluded.all_day, start_at=excluded.start_at, end_at=excluded.end_at, gone=excluded.gone`,
      ctx.params.id, occ,
      ctx.body?.title !== undefined ? String(ctx.body.title) : null,
      ctx.body?.note !== undefined ? String(ctx.body.note) : null,
      ctx.body?.location !== undefined ? String(ctx.body.location) : null,
      ctx.body?.all_day !== undefined ? (ctx.body.all_day ? 1 : 0) : null,
      intOrNull(ctx.body?.start_at), intOrNull(ctx.body?.end_at),
      ctx.body?.gone ? 1 : 0);
    return { ok: true };
  },

  'POST /api/events/:id/comments': (ctx: Ctx) => {
    const e = ctx.store.get('select * from events where id = ?', ctx.params.id);
    if (!e) throw new HttpError(404, 'no_such_event');
    mustView(ctx, String(e.calendar_id));
    const body = String(ctx.body?.body ?? '').trim();
    if (!body) throw new HttpError(400, 'body_required');
    const id = newId('cmt');
    ctx.store.run('insert into comments (id, event_id, user_id, body, created_at) values (?,?,?,?,?)',
      id, ctx.params.id, String(ctx.user!.id), body.slice(0, 5000), Date.now());
    return { id };
  },

  'DELETE /api/comments/:id': (ctx: Ctx) => {
    const c = ctx.store.get('select * from comments where id = ?', ctx.params.id);
    if (!c) throw new HttpError(404, 'no_such_comment');
    if (String(c.user_id) !== String(ctx.user?.id)) throw new HttpError(403, 'not_yours');
    ctx.store.run('update comments set deleted_at = ? where id = ?', Date.now(), ctx.params.id);
    return { ok: true };
  },

  'PUT /api/events/:id/reaction': (ctx: Ctx) => {
    const e = ctx.store.get('select * from events where id = ?', ctx.params.id);
    if (!e) throw new HttpError(404, 'no_such_event');
    mustView(ctx, String(e.calendar_id));
    const emoji = String(ctx.body?.emoji ?? '').trim();
    if (!emoji || [...emoji].length > 4) throw new HttpError(400, 'bad_emoji');
    const existed = ctx.store.get('select 1 as x from reactions where event_id = ? and user_id = ? and emoji = ?',
      ctx.params.id, String(ctx.user!.id), emoji);
    if (existed) ctx.store.run('delete from reactions where event_id = ? and user_id = ? and emoji = ?', ctx.params.id, String(ctx.user!.id), emoji);
    else ctx.store.run('insert into reactions (event_id, user_id, emoji) values (?,?,?)', ctx.params.id, String(ctx.user!.id), emoji);
    return { added: !existed };
  },

  'POST /api/calendars/:id/subscription': (ctx: Ctx) => {
    mustView(ctx, ctx.params.id);
    const token = newId('sub').slice(4);
    const now = Date.now();
    const days = Math.min(3650, Math.max(1, Number(ctx.body?.days ?? 365)));
    const expires = now + days * 86400000;
    ctx.store.run('insert into subscriptions (token, calendar_id, created_by, created_at, expires_at) values (?,?,?,?,?)',
      token, ctx.params.id, String(ctx.user!.id), now, expires);
    return { token, path: `/ics/${token}.ics`, expires_at: expires };
  },

  'GET /api/calendars/:id/subscriptions': (ctx: Ctx) => {
    mustView(ctx, ctx.params.id);
    return ctx.store.all(
      `select token, created_at, expires_at, revoked_at, last_used_at from subscriptions
       where calendar_id = ? order by created_at desc`, ctx.params.id);
  },

  'DELETE /api/subscriptions/:token': (ctx: Ctx) => {
    const sub = ctx.store.get('select * from subscriptions where token = ?', ctx.params.token);
    if (!sub) throw new HttpError(404, 'bad_token');
    mustView(ctx, String(sub.calendar_id));
    ctx.store.run('update subscriptions set revoked_at = ? where token = ?', Date.now(), ctx.params.token);
    return { revoked: true };
  },

  'GET /ics/:token.ics': (ctx: Ctx) => {
    const sub = ctx.store.get('select * from subscriptions where token = ?', ctx.params.token);
    if (!sub || sub.revoked_at != null) throw new HttpError(404, 'bad_token');
    if (sub.expires_at != null && Number(sub.expires_at) < Date.now()) throw new HttpError(404, 'expired_token');
    ctx.store.run('update subscriptions set last_used_at = ? where token = ?', Date.now(), ctx.params.token);

    const cal = calRow(ctx, String(sub.calendar_id));
    const events = ctx.store.all(
      `select e.*, l.name as label_name from events e
       left join labels l on l.id = e.label_id
       where e.calendar_id = ? and e.deleted_at is null`, String(sub.calendar_id)) as any[];
    if (events.length > 5000) throw new HttpError(500, 'too_many_events');
    const ids = events.map((e) => String(e.id));
    const overrides = ids.length
      ? ctx.store.all(`select * from overrides where event_id in (${ids.map(() => '?').join(',')})`, ...ids) as any[]
      : [];
    const alarms = ids.length
      ? ctx.store.all(`select event_id, minutes from reminders where event_id in (${ids.map(() => '?').join(',')})`, ...ids) as any[]
      : [];
    const byEvent = new Map<string, number[]>();
    for (const a of alarms) {
      const key = String(a.event_id);
      byEvent.set(key, [...(byEvent.get(key) ?? []), Number(a.minutes)]);
    }
    for (const e of events) e.reminders = byEvent.get(String(e.id)) ?? [];

    return { raw: icsForCalendar(String(cal.name), events, overrides), contentType: 'text/calendar; charset=utf-8' };
  },
};

export { needUser, membership, mustView, occurrences, safeEqual, userByToken };
