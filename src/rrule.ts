// RFC 5545 recurrence subset: FREQ=DAILY|WEEKLY|MONTHLY|YEARLY, INTERVAL,
// BYDAY, BYMONTHDAY (incl. -1 = last day), BYMONTH, COUNT, UNTIL.
//
// Each occurrence is re-projected through the event's own IANA zone (wallToUtc),
// so a series stays on its wall-clock weekday across a DST transition. Properties
// this subset cannot expand faithfully (BYSETPOS, WKST, BYWEEKNO, YEARLY's BYDAY…)
// are rejected by parseRRule — the caller gets a loud bad_rrule instead of a
// silently wrong series.

import { wallParts, wallToUtc } from './tz.ts';

const DAY_MS = 86400000;
const WEEKDAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
const MAX_OCCURRENCES = 5000;
const MAX_SCAN_DAYS = 4000;
// Anything outside this set cannot be expanded faithfully; refusing beats a
// half-ignored rule that quietly means something else.
const SUPPORTED = new Set(['FREQ', 'INTERVAL', 'BYDAY', 'BYMONTHDAY', 'BYMONTH', 'COUNT', 'UNTIL']);

export type Rule = {
  freq: 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY';
  interval: number;
  byday: string[];
  bymonthday: number[];
  bymonth: number[];
  count: number | null;
  until: number | null;
};

export function parseRRule(text: string): Rule | null {
  const body = text.trim().startsWith('RRULE:') ? text.trim().slice(6) : text.trim();
  if (!body) return null;
  const parts: Record<string, string> = {};
  for (const kv of body.split(';')) {
    const eq = kv.indexOf('=');
    if (eq > 0) parts[kv.slice(0, eq).toUpperCase()] = kv.slice(eq + 1).toUpperCase();
  }
  const freq = parts.FREQ;
  if (!freq || !['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].includes(freq)) return null;
  for (const key of Object.keys(parts)) if (!SUPPORTED.has(key)) return null;
  // YEARLY here only repeats the anchor's month/day; BYDAY/BYMONTHDAY would be
  // silently meaningless, so refuse them instead of misreading the rule.
  if (freq === 'YEARLY' && (parts.BYDAY || parts.BYMONTHDAY)) return null;
  if (parts.INTERVAL !== undefined && !/^\d+$/.test(parts.INTERVAL)) return null;
  if (parts.COUNT !== undefined && !/^\d+$/.test(parts.COUNT)) return null;

  let until: number | null = null;
  if (parts.UNTIL) {
    const u = parts.UNTIL;
    // Only the date form and the UTC datetime form; a floating datetime would be
    // silently misread as UTC, so it is refused instead.
    if (!/^\d{8}(T\d{6}Z)?$/.test(u)) return null;
    until = u.length === 16
      ? Date.UTC(+u.slice(0, 4), +u.slice(4, 6) - 1, +u.slice(6, 8), +u.slice(9, 11), +u.slice(11, 13), +u.slice(13, 15))
      : Date.UTC(+u.slice(0, 4), +u.slice(4, 6) - 1, +u.slice(6, 8), 23, 59, 59);
  }

  return {
    freq: freq as Rule['freq'],
    interval: parts.INTERVAL ? Math.max(1, +parts.INTERVAL) : 1,
    byday: parts.BYDAY ? parts.BYDAY.split(',').filter(Boolean) : [],
    bymonthday: parts.BYMONTHDAY ? parts.BYMONTHDAY.split(',').filter(Boolean).map(Number) : [],
    bymonth: parts.BYMONTH ? parts.BYMONTH.split(',').filter(Boolean).map(Number) : [],
    count: parts.COUNT ? Math.max(1, +parts.COUNT) : null,
    until,
  };
}

function lastDayOfMonth(y: number, m0: number): number {
  return new Date(Date.UTC(y, m0 + 1, 0)).getUTCDate();
}

/** "2MO" / "-1FR" → "MO" / "FR"; the prefix only selects a week of the month. */
function weekdayOf(spec: string): string {
  return spec.replace(/^-?\d+/, '');
}

function matches(day: Date, rule: Rule, anchor: Date): boolean {
  const y = day.getUTCFullYear(), m0 = day.getUTCMonth(), d = day.getUTCDate();
  const monthsFromAnchor = (y - anchor.getUTCFullYear()) * 12 + (m0 - anchor.getUTCMonth());

  if (rule.bymonth.length && !rule.bymonth.includes(m0 + 1)) return false;

  if (rule.freq === 'DAILY') {
    if (rule.interval > 1) {
      const days = Math.round((Date.UTC(y, m0, d) - Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth(), anchor.getUTCDate())) / DAY_MS);
      if (days % rule.interval !== 0) return false;
    }
    // An ordinal prefix (2MO) is only meaningful for MONTHLY/YEARLY; treat it as the weekday here.
    if (rule.byday.length && !rule.byday.map(weekdayOf).includes(WEEKDAYS[day.getUTCDay()])) return false;
    return true;
  }

  if (rule.freq === 'WEEKLY') {
    if (rule.byday.length && !rule.byday.map(weekdayOf).includes(WEEKDAYS[day.getUTCDay()])) return false;
    if (rule.interval > 1) {
      const anchorWeek = Math.floor(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth(), anchor.getUTCDate()) / DAY_MS);
      const weekStart = anchorWeek - ((anchor.getUTCDay() + 6) % 7);
      const dayWeek = Math.floor(Date.UTC(y, m0, d) / DAY_MS);
      const weekIdx = Math.floor((dayWeek - weekStart) / 7);
      if (weekIdx < 0 || weekIdx % rule.interval !== 0) return false;
    }
    return true;
  }

  if (rule.freq === 'MONTHLY') {
    if (rule.interval > 1 && (monthsFromAnchor < 0 || monthsFromAnchor % rule.interval !== 0)) return false;
    if (rule.byday.length) {
      let ok = false;
      const f = new Date(Date.UTC(y, m0, 1)).getUTCDay();
      const last = lastDayOfMonth(y, m0);
      for (const spec of rule.byday) {
        const wd = spec.replace(/^-?\d+/, '');
        const ord = spec === wd ? null : parseInt(spec, 10);
        if (WEEKDAYS[day.getUTCDay()] !== wd) continue;
        if (ord === null) { ok = true; break; }
        const w = WEEKDAYS.indexOf(wd);
        const firstOcc = ((w - f + 7) % 7) + 1;
        const nthFromStart = Math.floor((d - firstOcc) / 7) + 1;
        const nthFromEnd = Math.floor((last - d) / 7) + 1;
        if (ord > 0 ? nthFromStart === ord : nthFromEnd === -ord) { ok = true; break; }
      }
      if (!ok) return false;
      return true;
    }
    const days = rule.bymonthday.length
      ? rule.bymonthday.map((n) => (n < 0 ? lastDayOfMonth(y, m0) + 1 + n : n))
      : [anchor.getUTCDate() === 29 || anchor.getUTCDate() === 30 || anchor.getUTCDate() === 31
          ? Math.min(anchor.getUTCDate(), lastDayOfMonth(y, m0))
          : anchor.getUTCDate()];
    return days.includes(d);
  }

  // YEARLY
  const yearsFromAnchor = y - anchor.getUTCFullYear();
  if (rule.interval > 1 && (yearsFromAnchor < 0 || yearsFromAnchor % rule.interval !== 0)) return false;
  if (rule.bymonth.length) return rule.bymonth.includes(m0 + 1) && d === anchor.getUTCDate();
  return m0 === anchor.getUTCMonth() && d === anchor.getUTCDate();
}

/** Returns occurrence start instants (ms) inside [rangeStart, rangeEnd], in zone `tz`. */
export function expand(
  rruleText: string,
  anchorStart: number,
  duration: number,
  rangeStart: number,
  rangeEnd: number,
  exdates: string[] = [],
  tz: string = 'UTC',
): number[] {
  const rule = parseRRule(rruleText);
  if (!rule) return anchorStart >= rangeStart && anchorStart <= rangeEnd ? [anchorStart] : [];

  const anchorWall = wallParts(anchorStart, tz);
  const anchor = new Date(Date.UTC(anchorWall.y, anchorWall.mo - 1, anchorWall.d));
  const exset = new Set(exdates.map(String));
  const out: number[] = [];
  let seq = 0;
  let scanned = 0;

  // A series anchored years ago must still answer for a window far in the future.
  // Without COUNT the scan can start just before the requested window; with COUNT
  // the occurrences before it still have to be counted, so the scan starts at the
  // anchor but is bounded by the count instead of a fixed 4000 days.
  const cycleDays = { DAILY: 1, WEEKLY: 7, MONTHLY: 31, YEARLY: 366 }[rule.freq] * rule.interval;
  const windowStart = Math.floor(rangeStart / DAY_MS) * DAY_MS;
  let cursor = rule.count === null
    ? Math.max(anchor.getTime(), windowStart - cycleDays * DAY_MS)
    : anchor.getTime();
  const scanLimit = rule.count === null
    ? MAX_SCAN_DAYS
    : Math.max(MAX_SCAN_DAYS, (rule.count + 2) * cycleDays + 400);

  while (out.length < MAX_OCCURRENCES && scanned < scanLimit) {
    const day = new Date(cursor);
    if (rule.count === null && cursor > rangeEnd + DAY_MS) break;
    if (matches(day, rule, anchor)) {
      if (rule.count !== null && ++seq > rule.count) break;
      const key = `${String(day.getUTCFullYear()).padStart(4, '0')}-${String(day.getUTCMonth() + 1).padStart(2, '0')}-${String(day.getUTCDate()).padStart(2, '0')}`;
      const instant = wallToUtc(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), anchorWall.hh, anchorWall.mi, anchorWall.ss, tz);
      if (rule.until !== null && instant > rule.until) break;
      if (!exset.has(key) && instant + duration > rangeStart && instant <= rangeEnd) out.push(instant);
    }
    cursor += DAY_MS;
    scanned++;
  }
  return out;
}

export function describe(ruleText: string): string {
  const r = parseRRule(ruleText);
  if (!r) return '單次';
  const every = r.interval > 1 ? `每 ${r.interval} ` : '每';
  const unit = { DAILY: '天', WEEKLY: '週', MONTHLY: '個月', YEARLY: '年' }[r.freq];
  const names: Record<string, string> = { SU: '日', MO: '一', TU: '二', WE: '三', TH: '四', FR: '五', SA: '六' };
  let s = every + unit;
  if (r.freq === 'WEEKLY' && r.byday.length) s += '的星期' + r.byday.map((x) => names[x] ?? x).join('、');
  if (r.freq === 'MONTHLY' && r.bymonthday.length) s += '的 ' + r.bymonthday.join('/') + ' 號';
  if (r.count) s += `,共 ${r.count} 次`;
  if (r.until) s += `,到 ${new Date(r.until).toISOString().slice(0, 10)}`;
  return s;
}
