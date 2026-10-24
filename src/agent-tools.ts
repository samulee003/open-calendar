// The agent-facing tool implementations shared by the CLI and the MCP server.
// Every function takes plain JSON args and returns plain JSON, so the two
// adapters stay thin and cannot drift apart in behavior.
import type { Client } from './client.ts';
import { ApiError } from './client.ts';
import { wallParts, wallToUtc, isValidZone } from './tz.ts';

const DAY = 86400000;
export type Args = Record<string, any>;

function fail(message: string): never {
  throw new ApiError(400, message);
}

function compact<T extends Record<string, any>>(o: T): T {
  for (const k of Object.keys(o)) if (o[k] === null || o[k] === undefined || o[k] === '') delete o[k];
  return o;
}

/**
 * Accepts epoch ms, any ISO-8601 instant, "YYYY-MM-DD", or "YYYY-MM-DD HH:MM"
 * (also with "T", optional seconds). Naive readings are wall-clock in `tz`.
 */
export function parseWhen(value: unknown, tz: string): number {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  const s = String(value ?? '').trim();
  if (!s) fail('time_required');
  if (/^\d{10,}$/.test(s)) return Number(s);
  const naive = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(s);
  if (naive) {
    const [, y, mo, d, hh, mi, ss] = naive;
    return wallToUtc(+y, +mo, +d, +(hh ?? 0), +(mi ?? 0), +(ss ?? 0), tz);
  }
  const t = Date.parse(s);
  if (Number.isFinite(t)) return t;
  return fail(`bad_time: ${s}`);
}

export function localLabel(ms: number, tz: string, allDay: boolean): string {
  const w = wallParts(ms, tz);
  const date = `${w.y}-${String(w.mo).padStart(2, '0')}-${String(w.d).padStart(2, '0')}`;
  if (allDay) return `${date} (all-day)`;
  return `${date} ${String(w.hh).padStart(2, '0')}:${String(w.mi).padStart(2, '0')}`;
}

export async function tzOf(c: Client, args: Args = {}): Promise<string> {
  if (isValidZone(args.tz)) return String(args.tz);
  if (isValidZone(c.tz)) return c.tz!;
  const me = await c.me();
  return isValidZone(me.tz) ? me.tz : 'UTC';
}

export function resolveCal(c: Client, args: Args = {}): string {
  const id = args.calendar_id ?? args.calendar ?? c.calendar;
  if (!id) fail('calendar_id_required (or set a default with `use` / CAL_CALENDAR)');
  return String(id);
}

function shapeOccurrence(o: any, tz: string) {
  return compact({
    id: String(o.id),
    occurrence_start: Number(o.occurrence_start),
    title: String(o.title),
    all_day: o.all_day ? true : undefined,
    start: localLabel(Number(o.start_at), tz, !!o.all_day),
    end: o.all_day ? undefined : localLabel(Number(o.end_at), tz, false),
    rrule: o.rrule ? String(o.rrule) : undefined,
    label: o.label_name ? String(o.label_name) : undefined,
    location: o.location ? String(o.location) : undefined,
    comment_count: Number(o.comment_count) || undefined,
  });
}

// ---------- tools ----------

export async function whoami(c: Client) {
  return c.me();
}

export async function listCalendars(c: Client) {
  const rows = await c.call<any[]>('GET', '/api/calendars');
  return rows.map((r) => compact({
    id: String(r.id), name: String(r.name), role: String(r.role),
    member_count: Number(r.member_count), default: String(r.id) === c.calendar ? true : undefined,
  }));
}

export async function listEvents(c: Client, args: Args = {}) {
  const tz = await tzOf(c, args);
  const from = args.from !== undefined ? parseWhen(args.from, tz) : Date.now();
  // Bound the window so a stray `days: 3650` cannot turn into a year-long payload.
  const days = Math.min(400, Math.max(1, Number(args.days ?? 31)));
  const to = args.to !== undefined ? parseWhen(args.to, tz) : from + days * DAY;
  const cal = args.calendar_id ?? args.calendar ?? c.calendar;
  const path = cal ? `/api/calendars/${encodeURIComponent(String(cal))}/events` : '/api/events';
  const rows = await c.call<any[]>('GET', path, { query: { from, to } });
  return {
    tz, from: localLabel(from, tz, false), to: localLabel(to, tz, false), count: rows.length,
    events: rows.map((o) => shapeOccurrence(o, tz)),
  };
}

export async function getEvent(c: Client, args: Args) {
  const id = String(args.event_id ?? args.id ?? fail('event_id_required'));
  const r = await c.call<any>('GET', `/api/events/${encodeURIComponent(id)}`);
  const tz = isValidZone(r.event?.tz) ? String(r.event.tz) : await tzOf(c);
  const e = r.event;
  return compact({
    event: compact({
      id: String(e.id), calendar_id: String(e.calendar_id), title: String(e.title),
      all_day: Number(e.all_day) === 1 ? true : undefined,
      start: localLabel(Number(e.start_at), tz, Number(e.all_day) === 1),
      end: Number(e.all_day) === 1 ? undefined : localLabel(Number(e.end_at), tz, false),
      start_at: Number(e.start_at), end_at: Number(e.end_at), tz,
      note: e.note ? String(e.note) : undefined,
      location: e.location ? String(e.location) : undefined,
      rrule: e.rrule ? String(e.rrule) : undefined,
      label_id: e.label_id == null ? undefined : Number(e.label_id),
    }),
    reminders: (r.reminders ?? []).map((x: any) => Number(x.minutes)),
    comments: (r.comments ?? []).map((x: any) => ({
      id: String(x.id), name: String(x.name), body: String(x.body),
      at: localLabel(Number(x.created_at), tz, false),
    })),
    reactions: r.reactions ?? [],
  });
}

function eventPayload(c: Client, args: Args, tz: string) {
  const title = String(args.title ?? '').trim();
  if (!title) fail('title_required');
  const allDay = args.all_day === true || args.all_day === 1;
  let start_at: number;
  if (allDay) {
    start_at = parseWhen(args.date ?? args.start, tz);
  } else {
    if (args.start === undefined) fail('start_required (or all_day with date)');
    start_at = parseWhen(args.start, tz);
  }
  const payload: Args = {
    title, all_day: allDay, start_at, tz,
    end_at: args.end !== undefined && !allDay ? parseWhen(args.end, tz) : undefined,
    rrule: args.rrule ?? undefined,
    note: args.note ?? undefined,
    location: args.location ?? undefined,
    label_id: args.label_id ?? undefined,
    reminders: args.reminders ?? undefined,
  };
  return compact(payload);
}

export async function createEvent(c: Client, args: Args) {
  const tz = await tzOf(c, args);
  const cal = resolveCal(c, args);
  const payload = eventPayload(c, args, tz);
  const r = await c.call<{ id: string }>('POST', `/api/calendars/${encodeURIComponent(cal)}/events`, { body: payload });
  return {
    created: r.id, title: payload.title,
    start: localLabel(Number(payload.start_at), tz, !!payload.all_day),
    rrule: payload.rrule, calendar_id: cal,
  };
}

export async function createEvents(c: Client, args: Args) {
  const tz = await tzOf(c, args);
  const cal = resolveCal(c, args);
  const list = args.events;
  if (!Array.isArray(list) || !list.length) fail('events_required');
  // Entries that fail local normalization are passed through raw so the server
  // rejects them at their real index — batch results stay index-aligned.
  const body = {
    events: list.map((raw: Args) => {
      try { return eventPayload(c, raw, tz); } catch { return raw; }
    }),
  };
  return c.call('POST', `/api/calendars/${encodeURIComponent(cal)}/events/batch`, { body });
}

export async function quickAdd(c: Client, args: Args) {
  const tz = await tzOf(c, args);
  const cal = resolveCal(c, args);
  const text = String(args.text ?? '').trim();
  if (!text) fail('text_required');
  return c.call('POST', `/api/calendars/${encodeURIComponent(cal)}/quick-add`,
    { body: { text, tz, confirm: args.confirm === true } });
}

export async function updateEvent(c: Client, args: Args) {
  const id = String(args.event_id ?? args.id ?? fail('event_id_required'));
  const existing = await c.call<any>('GET', `/api/events/${encodeURIComponent(id)}`);
  const e = existing.event;
  const tz = isValidZone(args.tz) ? String(args.tz) : (isValidZone(e.tz) ? String(e.tz) : await tzOf(c));
  const body: Args = { reminders: (existing.reminders ?? []).map((x: any) => Number(x.minutes)) };
  for (const f of ['title', 'note', 'location', 'rrule', 'label_id']) {
    if (args[f] !== undefined) body[f] = args[f];
  }
  if (args.all_day !== undefined) body.all_day = args.all_day === true || args.all_day === 1;
  if (args.reminders !== undefined) body.reminders = args.reminders;
  const allDay = body.all_day ?? Number(e.all_day) === 1;
  if (allDay && args.date !== undefined) body.start_at = parseWhen(args.date, tz);
  if (args.start !== undefined) body.start_at = parseWhen(args.start, tz);
  if (args.end !== undefined) body.end_at = parseWhen(args.end, tz);
  await c.call('PUT', `/api/events/${encodeURIComponent(id)}`, { body });
  return getEvent(c, { event_id: id });
}

export async function deleteEvent(c: Client, args: Args) {
  const id = String(args.event_id ?? args.id ?? fail('event_id_required'));
  const scope = String(args.scope ?? 'all');
  if (!['all', 'future', 'occurrence'].includes(scope)) fail('bad_scope (all|future|occurrence)');
  const occ = args.occurrence_start !== undefined ? parseWhen(args.occurrence_start, await tzOf(c)) : null;
  return c.call('DELETE', `/api/events/${encodeURIComponent(id)}`, { query: { scope, occ } });
}

export async function overrideOccurrence(c: Client, args: Args) {
  const id = String(args.event_id ?? args.id ?? fail('event_id_required'));
  if (args.occurrence_start === undefined) fail('occurrence_start_required');
  const e = await c.call<any>('GET', `/api/events/${encodeURIComponent(id)}`);
  const tz = isValidZone(e.event?.tz) ? String(e.event.tz) : await tzOf(c);
  const body = compact({
    occurrence_start: parseWhen(args.occurrence_start, tz),
    title: args.title, note: args.note, location: args.location,
    all_day: args.all_day,
    start_at: args.start !== undefined ? parseWhen(args.start, tz) : undefined,
    end_at: args.end !== undefined ? parseWhen(args.end, tz) : undefined,
    gone: args.gone === true ? 1 : undefined,
  });
  await c.call('POST', `/api/events/${encodeURIComponent(id)}/override`, { body });
  return { ok: true, event_id: id, occurrence: localLabel(body.occurrence_start, tz, false) };
}

/** Free windows inside a day's [window_start, window_end], from merged busy intervals. */
export async function findFreeSlots(c: Client, args: Args) {
  const tz = await tzOf(c, args);
  const date = String(args.date ?? '').trim();
  const dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!dm) fail('date_required (YYYY-MM-DD)');
  const duration = Math.max(5, Number(args.duration_minutes ?? 60));
  const [wsH, wsM] = String(args.window_start ?? '08:00').split(':').map(Number);
  const [weH, weM] = String(args.window_end ?? '22:00').split(':').map(Number);
  const winStart = wallToUtc(+dm[1], +dm[2], +dm[3], wsH || 0, wsM || 0, 0, tz);
  const winEnd = wallToUtc(+dm[1], +dm[2], +dm[3], weH || 0, weM || 0, 0, tz);
  if (winEnd <= winStart) fail('window_end_before_start');

  const events = await listEvents(c, { ...args, from: winStart, to: winEnd, tz });
  const busy: [number, number][] = [];
  for (const ev of events.events) {
    const raw = ev as any;
    const s = raw.all_day ? Math.max(winStart, parseWhen(raw.start.slice(0, 10), tz)) : parseWhen(raw.start, tz);
    const e = raw.all_day ? Math.min(winEnd, s + DAY) : parseWhen(raw.end, tz);
    busy.push([Math.max(s, winStart), Math.min(e, winEnd)]);
  }
  busy.sort((a, b) => a[0] - b[0]);
  const free: any[] = [];
  let cursor = winStart;
  for (const [s, e] of busy) {
    if (s > cursor && s - cursor >= duration * 60000) {
      free.push({ start: localLabel(cursor, tz, false), end: localLabel(Math.min(s, winEnd), tz, false), start_at: cursor, end_at: Math.min(s, winEnd) });
    }
    cursor = Math.max(cursor, e);
  }
  if (winEnd - cursor >= duration * 60000) {
    free.push({ start: localLabel(cursor, tz, false), end: localLabel(winEnd, tz, false), start_at: cursor, end_at: winEnd });
  }
  return { date, tz, duration_minutes: duration, window: `${String(wsH).padStart(2, '0')}:${String(wsM ?? 0).padStart(2, '0')}-${String(weH).padStart(2, '0')}:${String(weM ?? 0).padStart(2, '0')}`, free };
}

export async function addComment(c: Client, args: Args) {
  const id = String(args.event_id ?? args.id ?? fail('event_id_required'));
  const body = String(args.body ?? args.text ?? '').trim();
  if (!body) fail('body_required');
  return c.call('POST', `/api/events/${encodeURIComponent(id)}/comments`, { body: { body } });
}

export async function createSubscription(c: Client, args: Args) {
  const cal = resolveCal(c, args);
  const r = await c.call<{ token: string; path: string; expires_at: number }>(
    'POST', `/api/calendars/${encodeURIComponent(cal)}/subscription`, { body: { days: args.days ?? 365 } });
  return { url: `${c.base}${r.path}`, token: r.token, expires_at: r.expires_at, calendar_id: cal };
}

export async function listSubscriptions(c: Client, args: Args) {
  const cal = resolveCal(c, args);
  return c.call('GET', `/api/calendars/${encodeURIComponent(cal)}/subscriptions`);
}

export async function revokeSubscription(c: Client, args: Args) {
  const token = String(args.token ?? fail('token_required'));
  return c.call('DELETE', `/api/subscriptions/${encodeURIComponent(token)}`);
}

export async function listLabels(c: Client, args: Args) {
  const cal = resolveCal(c, args);
  return c.call('GET', `/api/calendars/${encodeURIComponent(cal)}/labels`);
}
