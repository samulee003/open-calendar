// Wall-clock helpers over IANA zones, without Temporal or any dependency.
// Recurrence must be expanded in the event's own zone: a lesson at 01:00 in
// Asia/Taipei is 17:00 the previous day in UTC, and expanding on UTC calendar
// days would silently move it to another weekday.

const DAY_MS = 86400000;

const fmtCache = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', weekday: 'short',
    });
    fmtCache.set(tz, f);
  }
  return f;
}

export type Wall = { y: number; mo: number; d: number; hh: number; mi: number; ss: number; weekday: string };

const WEEKDAY_MAP: Record<string, string> = { Sun: 'SU', Mon: 'MO', Tue: 'TU', Wed: 'WE', Thu: 'TH', Fri: 'FR', Sat: 'SA' };

export function wallParts(ms: number, tz: string): Wall {
  let y = 0, mo = 0, d = 0, hh = 0, mi = 0, ss = 0, wd = '';
  for (const p of formatter(tz).formatToParts(new Date(ms))) {
    switch (p.type) {
      case 'year': y = +p.value; break;
      case 'month': mo = +p.value; break;
      case 'day': d = +p.value; break;
      case 'hour': hh = +p.value % 24; break;
      case 'minute': mi = +p.value; break;
      case 'second': ss = +p.value; break;
      case 'weekday': wd = p.value.slice(0, 3); break;
    }
  }
  return { y, mo, d, hh, mi, ss, weekday: WEEKDAY_MAP[wd] ?? 'SU' };
}

function offsetAt(utcMs: number, tz: string): number {
  const w = wallParts(utcMs, tz);
  return Date.UTC(w.y, w.mo - 1, w.d, w.hh, w.mi, w.ss) - utcMs;
}

/** Instant (ms) of the given wall-clock reading in `tz`. Ambiguous DST times resolve to the earlier offset. */
export function wallToUtc(y: number, mo: number, d: number, hh: number, mi: number, ss: number, tz: string): number {
  const target = Date.UTC(y, mo - 1, d, hh, mi, ss);
  const first = target - offsetAt(target, tz);
  const second = target - offsetAt(first, tz);
  return second === first ? second : Math.min(first, second);
}

/** Stable key for one calendar day in a zone: "2026-11-05". */
export function dayKey(ms: number, tz: string): string {
  const w = wallParts(ms, tz);
  return `${String(w.y).padStart(4, '0')}-${String(w.mo).padStart(2, '0')}-${String(w.d).padStart(2, '0')}`;
}

export function dayKeyToUtcNoon(key: string, tz: string): number {
  const [y, mo, d] = key.split('-').map(Number);
  return wallToUtc(y, mo, d, 12, 0, 0, tz);
}

export function addDaysToKey(key: string, n: number): string {
  const [y, mo, d] = key.split('-').map(Number);
  const ms = Date.UTC(y, mo - 1, d) + n * DAY_MS;
  const dt = new Date(ms);
  return `${String(dt.getUTCFullYear()).padStart(4, '0')}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
}

export function isValidZone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || !tz) return false;
  try { new Intl.DateTimeFormat('en', { timeZone: tz }); return true; } catch { return false; }
}
