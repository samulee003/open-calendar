// iCalendar (RFC 5545) output, so any phone calendar app can subscribe read-only.
//
// A recurring series is emitted as ONE master VEVENT carrying RRULE and EXDATE,
// plus one VEVENT per per-occurrence override (RECURRENCE-ID). Expanding every
// occurrence into its own VEVENT would make clients show N copies of a series.

const esc = (s: string): string =>
  String(s)
    .replace(/\\/g, '\\\\')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/[;,]/g, (c) => '\\' + c);

import { wallParts, wallToUtc, isValidZone } from './tz.ts';

const DAY = 86400000;

function fold(line: string, out: string[]): void {
  // RFC 5545: physical lines <= 75 octets; a continuation line starts with one space.
  let rest = line;
  let first = true;
  for (;;) {
    const limit = first ? 75 : 74;
    if (Buffer.from(rest, 'utf8').length <= limit) {
      out.push(first ? rest : ' ' + rest);
      return;
    }
    let cut = rest.length;
    while (Buffer.from(rest.slice(0, cut), 'utf8').length > limit) cut--;
    out.push(first ? rest.slice(0, cut) : ' ' + rest.slice(0, cut));
    rest = rest.slice(cut);
    first = false;
  }
}

function stampUTC(ms: number): string {
  return new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

function dateOnly(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10).replace(/-/g, '');
}

const pad = (n: number) => String(n).padStart(2, '0');

/** Local wall-clock stamp, used together with a TZID parameter. */
function wallStamp(ms: number, zone: string): string {
  const w = wallParts(ms, zone);
  return `${w.y}${pad(w.mo)}${pad(w.d)}T${pad(w.hh)}${pad(w.mi)}${pad(w.ss)}`;
}

function offsetMsAt(ms: number, zone: string): number {
  const w = wallParts(ms, zone);
  return Date.UTC(w.y, w.mo - 1, w.d, w.hh, w.mi, w.ss) - ms;
}

function offsetStr(ms: number): string {
  const sign = ms < 0 ? '-' : '+';
  const abs = Math.abs(ms);
  return `${sign}${pad(Math.floor(abs / 3600000))}${pad(Math.floor(abs / 60000) % 60)}`;
}

function zoneName(ms: number, zone: string): string {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'short' }).formatToParts(new Date(ms));
    return parts.find((p) => p.type === 'timeZoneName')?.value ?? 'GMT';
  } catch { return 'GMT'; }
}

/** Offset changes for a zone: scan day by day, then bisect to the hour. */
function zoneTransitions(zone: string, fromMs: number, toMs: number): number[] {
  const out: number[] = [];
  let prev = offsetMsAt(fromMs, zone);
  for (let day = fromMs + DAY; day <= toMs; day += DAY) {
    const off = offsetMsAt(day, zone);
    if (off === prev) continue;
    let lo = day - DAY;
    let hi = day;
    while (hi - lo > 3600000) {
      const mid = Math.floor((lo + hi) / 2);
      if (offsetMsAt(mid, zone) === prev) lo = mid; else hi = mid;
    }
    out.push(hi);
    prev = off;
  }
  return out;
}

/**
 * VTIMEZONE for a zone over [fromMs, toMs]. Without this a client expands the
 * RRULE in UTC, which moves a 01:00 Monday class in Asia/Taipei to a Tuesday.
 */
function vtimezone(zone: string, fromMs: number, toMs: number): string[] {
  const base = offsetMsAt(fromMs, zone);
  const component = (atMs: number, from: number, to: number) => [
    `BEGIN:${to > from ? 'DAYLIGHT' : 'STANDARD'}`,
    `DTSTART:${wallStamp(atMs, zone)}`,
    `TZOFFSETFROM:${offsetStr(from)}`,
    `TZOFFSETTO:${offsetStr(to)}`,
    `TZNAME:${zoneName(atMs, zone)}`,
    `END:${to > from ? 'DAYLIGHT' : 'STANDARD'}`,
  ];
  const lines = ['BEGIN:VTIMEZONE', `TZID:${zone}`, ...component(Date.UTC(1970, 0, 1), base, base)];
  let prev = base;
  for (const at of zoneTransitions(zone, fromMs, toMs)) {
    const off = offsetMsAt(at, zone);
    lines.push(...component(at, prev, off));
    prev = off;
  }
  lines.push('END:VTIMEZONE');
  return lines;
}

function alarmTrigger(minutes: number): string {
  if (minutes === 0) return 'PT0S';
  return minutes % 1440 === 0 ? `-P${minutes / 1440}D` : `-PT${minutes}M`;
}

function alarmLines(minutes: number[], title: string): string[] {
  const out: string[] = [];
  for (const m of minutes.map(Number).filter((n) => Number.isFinite(n) && n >= 0 && n <= 525600)) {
    out.push('BEGIN:VALARM', 'ACTION:DISPLAY', `TRIGGER:${alarmTrigger(m)}`, `DESCRIPTION:${esc(title)}`, 'END:VALARM');
  }
  return out;
}

export type IcsRow = {
  id: string | number;
  title: string;
  note: string;
  location: string;
  start_at: number;
  end_at: number;
  all_day: number | boolean;
  rrule: string | null;
  exdates: string;
  created_at: number;
  label_name?: string | null;
  tz?: string | null;
  reminders?: number[];
};

export type IcsOverride = {
  event_id: string;
  orig_start: number;
  title: string | null;
  note: string | null;
  location: string | null;
  all_day: number | null;
  start_at: number | null;
  end_at: number | null;
  gone: number;
};

function dtLines(startAt: number, endAt: number, allDay: boolean, zone: string): string[] {
  if (allDay) {
    // end_at is already the exclusive start-of-next-day instant; adding another day
    // here made every all-day event span two days on the phone.
    const end = Math.max(endAt, startAt + DAY);
    return [
      `DTSTART;VALUE=DATE:${dateOnly(startAt)}`,
      `DTEND;VALUE=DATE:${dateOnly(end)}`,
    ];
  }
  return [
    `DTSTART;TZID=${zone}:${wallStamp(startAt, zone)}`,
    `DTEND;TZID=${zone}:${wallStamp(endAt, zone)}`,
  ];
}

function common(e: { title: string; note: string; location: string; label_name?: string | null }): string[] {
  const lines = [`SUMMARY:${esc(e.title)}`];
  if (e.note) lines.push(`DESCRIPTION:${esc(e.note)}`);
  if (e.location) lines.push(`LOCATION:${esc(e.location)}`);
  if (e.label_name) lines.push(`CATEGORIES:${esc(e.label_name)}`);
  return lines;
}

export function icsForCalendar(name: string, events: IcsRow[], overrides: IcsOverride[]): string {
  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//shared-calendar//0.1//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${esc(name)}`,
  ];

  // Declare every zone the events use before the first VEVENT. The window covers
  // the data plus three forward years, so a DST zone keeps its rules current.
  const zoneMs: Record<string, { from: number; to: number }> = {};
  const note = (ms: number, zone: string) => {
    const cur = zoneMs[zone];
    if (!cur) zoneMs[zone] = { from: ms, to: ms };
    else { cur.from = Math.min(cur.from, ms); cur.to = Math.max(cur.to, ms); }
  };
  for (const e of events) {
    if (Number(e.all_day) === 1) continue;
    const zone = isValidZone(e.tz) ? String(e.tz) : 'UTC';
    note(Number(e.start_at) - 400 * DAY, zone);
    note(Number(e.end_at) + 3 * 365 * DAY, zone);
  }
  for (const zone of Object.keys(zoneMs)) lines.push(...vtimezone(zone, zoneMs[zone].from, zoneMs[zone].to));

  for (const e of events) {
    const allDay = Number(e.all_day) === 1;
    const zone = isValidZone(e.tz) ? String(e.tz) : 'UTC';
    const uid = `${e.id}@shared-calendar`;
    lines.push('BEGIN:VEVENT', `UID:${uid}`, `DTSTAMP:${stampUTC(Number(e.created_at))}`);
    lines.push(...dtLines(Number(e.start_at), Number(e.end_at), allDay, zone));
    lines.push(...common(e));
    if (e.rrule) lines.push(String(e.rrule).startsWith('RRULE:') ? String(e.rrule) : `RRULE:${e.rrule}`);
    const keys = (JSON.parse(String(e.exdates || '[]')) as unknown[]).map(String).filter((s) => /^\d{4}-\d{2}-\d{2}$/.test(s));
    if (keys.length) {
      if (allDay) {
        lines.push(`EXDATE;VALUE=DATE:${keys.map((k) => k.replace(/-/g, '')).join(',')}`);
      } else {
        const w = wallParts(Number(e.start_at), zone);
        const instants = keys.map((k) => {
          const [y, mo, d] = k.split('-').map(Number);
          return wallToUtc(y, mo, d, w.hh, w.mi, w.ss, zone);
        });
        lines.push(`EXDATE;TZID=${zone}:${instants.map((ms) => wallStamp(ms, zone)).join(',')}`);
      }
    }
    // Let the phone's own calendar app fire the reminder; subscribed calendars
    // honour VALARM on iOS and most Android clients, but not all.
    lines.push(...alarmLines(e.reminders ?? [], String(e.title)));
    lines.push('END:VEVENT');
  }

  for (const o of overrides) {
    const master = events.find((e) => String(e.id) === String(o.event_id));
    if (!master) continue;
    const zone = isValidZone(master.tz) ? String(master.tz) : 'UTC';
    const allDay = o.all_day != null ? Number(o.all_day) === 1 : Number(master.all_day) === 1;
    const rid = allDay ? dateOnly(Number(o.orig_start)) : wallStamp(Number(o.orig_start), zone);
    lines.push(
      'BEGIN:VEVENT',
      `UID:${master.id}-ov-${o.orig_start}@shared-calendar`,
      // The parameter belongs before the colon: RECURRENCE-ID;TZID=…:<value>
      allDay ? `RECURRENCE-ID;VALUE=DATE:${rid}` : `RECURRENCE-ID;TZID=${zone}:${rid}`,
      `DTSTAMP:${stampUTC(Number(master.created_at))}`,
    );
    if (Number(o.gone) === 1) {
      // Keep a full time span even for cancellations; some clients drop a VEVENT
      // with no DTSTART instead of matching it to the series.
      const dur = Number(master.end_at) - Number(master.start_at);
      lines.push(...dtLines(Number(o.orig_start), Number(o.orig_start) + dur, allDay, zone));
      lines.push(`SUMMARY:${esc(String(master.title))}`, 'STATUS:CANCELLED');
    } else {
      const s = o.start_at != null ? Number(o.start_at) : Number(o.orig_start);
      const dur = Number(master.end_at) - Number(master.start_at);
      lines.push(...dtLines(s, o.end_at != null ? Number(o.end_at) : s + dur, allDay, zone));
      lines.push(...common({
        title: o.title != null ? String(o.title) : String(master.title),
        note: o.note != null ? String(o.note) : String(master.note),
        location: o.location != null ? String(o.location) : String(master.location),
        label_name: master.label_name ?? null,
      }));
      lines.push(...alarmLines(master.reminders ?? [], o.title != null ? String(o.title) : String(master.title)));
    }
    lines.push('END:VEVENT');
  }

  lines.push('END:VCALENDAR');
  const out: string[] = [];
  for (const l of lines) fold(l, out);
  return out.join('\r\n') + '\r\n';
}
