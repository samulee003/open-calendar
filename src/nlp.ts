// Natural-language quick-add for the self-hosted calendar.
//
// This is a deterministic parser, not an LLM: it recognises the date/time/
// recurrence shapes people actually type in Chinese or English and leaves the rest as
// the title. When it cannot place a date with confidence it returns
// confidence:'low' and asks, instead of guessing — a wrong silent guess is worse
// than a question.
//
// Behaviour boundaries (which expressions matter, how a bare weekday resolves, what
// defaults apply) were studied from a shipping calendar assistant; the rules,
// structures and code here are written from scratch.

const CN_DIGITS: Record<string, number> = {
  零: 0, 一: 1, 二: 2, 兩: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10,
};
const WEEKDAY_INDEX: Record<string, number> = {
  日: 0, 天: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6,
};

export type Confidence = 'high' | 'medium' | 'low';

export type QuickAdd = {
  title: string;
  all_day: boolean;
  start_at: number;
  end_at: number;
  rrule: string | null;
  confidence: Confidence;
  /** Human-readable notes about what was interpreted, for the preview. */
  notes: string[];
  /** Parts of the input that were not understood and stayed in the title. */
  unparsed: string[];
};

export type ParseOptions = {
  now: Date;
  tz?: string;
  defaultHour?: number;
  defaultDurationMinutes?: number;
};

function cnNum(s: string): number {
  if (/^\d+$/.test(s)) return Number(s);
  if (s === '十') return 10;
  if (/^十[一二三四五六七八九]$/.test(s)) return 10 + CN_DIGITS_ONE(s[1]);
  if (/^[一二三四五六七八九]十$/.test(s)) return CN_DIGITS_ONE(s[0]) * 10;
  if (/^[一二三四五六七八九]十[一二三四五六七八九]$/.test(s)) {
    return CN_DIGITS_ONE(s[0]) * 10 + CN_DIGITS_ONE(s[2]);
  }
  return CN_DIGITS_ONE(s);
}
function CN_DIGITS_ONE(ch: string): number { return CN_DIGITS[ch] ?? 0; }

const pad = (n: number) => String(n).padStart(2, '0');

/** Same wall-clock date in the given zone, expressed as a UTC-midnight instant. */
function utcMidnight(y: number, mo: number, d: number): number {
  return Date.UTC(y, mo - 1, d);
}

function addDays(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
}

function weekdayOf(d: Date): number { return d.getDay(); }

/** Monday-first index used in "下週三" style phrases: 0=Mon … 6=Sun. */
function mondayIndex(d: Date): number { return (weekdayOf(d) + 6) % 7; }

const RRULE_DAY = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

export function parseQuickAdd(input: string, opts: ParseOptions): QuickAdd {
  const now = opts.now;
  const defaultHour = opts.defaultHour ?? 9;
  const defaultDuration = opts.defaultDurationMinutes ?? 60;
  const notes: string[] = [];
  const unparsed: string[] = [];

  let text = input
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[：]/g, ':')
    .replace(/\s+/g, ' ')
    .trim();

  // ---------- recurrence ----------
  let rrule: string | null = null;
  let anchorWeekday: number | null = null;

  const everyOther = /每兩週\s*(?:的)?\s*(?:星期|週|禮拜)?\s*([日天一二三四五六])/.exec(text);
  const everyWeek = /每(?:個)?(?:星期|週|禮拜)\s*([日天一二三四五六])/.exec(text);
  const everyDay = /每天|每日/.exec(text);
  const everyMonth = /每(?:個)?月\s*(\d{1,2})\s*[日號号]/.exec(text);
  const everyYear = /每年/.exec(text);

  if (everyOther) {
    anchorWeekday = WEEKDAY_INDEX[everyOther[1]];
    rrule = `RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=${RRULE_DAY[anchorWeekday]}`;
    text = text.replace(everyOther[0], ' ');
    notes.push('每兩週');
  } else if (everyWeek) {
    anchorWeekday = WEEKDAY_INDEX[everyWeek[1]];
    rrule = `RRULE:FREQ=WEEKLY;BYDAY=${RRULE_DAY[anchorWeekday]}`;
    text = text.replace(everyWeek[0], ' ');
    notes.push('每週');
  } else if (everyMonth) {
    const day = Number(everyMonth[1]);
    rrule = `RRULE:FREQ=MONTHLY;BYMONTHDAY=${day}`;
    text = text.replace(everyMonth[0], ' ');
    notes.push(`每月 ${day} 號`);
  } else if (everyYear) {
    rrule = 'RRULE:FREQ=YEARLY';
    text = text.replace(everyYear[0], ' ');
    notes.push('每年');
  } else if (everyDay) {
    rrule = 'RRULE:FREQ=DAILY';
    text = text.replace(everyDay[0], ' ');
    notes.push('每天');
  }

  // ---------- date ----------
  let date: Date | null = null;
  let dateNote = '';
  let lowDate = false;

  const iso = /(\d{4})-(\d{1,2})-(\d{1,2})/.exec(text);
  const slash = /(\d{4})\/(\d{1,2})\/(\d{1,2})/.exec(text);
  const cnFull = /(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*[日號号]?/.exec(text);
  const cnShort = /(\d{1,2})\s*月\s*(\d{1,2})\s*[日號号]/.exec(text);
  const rel = /(今天|今晚|明天|明晚|後天|大後天|昨天)/.exec(text);
  const week = /(下下週|下週|這週|本週|下個星期|下星期|這個星期|這個禮拜|下個禮拜|這禮拜)\s*(?:的)?\s*(?:星期|週|禮拜)?\s*([日天一二三四五六])/.exec(text);
  const bareWeekday = /(?:^|\s)(?:星期|週|禮拜)([日天一二三四五六])(?:\s|$)/.exec(text);

  if (iso || slash) {
    const m = (iso ?? slash)!;
    date = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    text = text.replace(m[0], ' ');
    dateNote = `${m[1]}-${pad(Number(m[2]))}-${pad(Number(m[3]))}`;
  } else if (cnFull) {
    date = new Date(Number(cnFull[1]), Number(cnFull[2]) - 1, Number(cnFull[3]));
    text = text.replace(cnFull[0], ' ');
    dateNote = `${cnFull[1]}-${pad(Number(cnFull[2]))}-${pad(Number(cnFull[3]))}`;
  } else if (cnShort) {
    date = new Date(now.getFullYear(), Number(cnShort[1]) - 1, Number(cnShort[2]));
    // A bare "3月5日" that already passed refers to next year.
    if (date.getTime() < utcMidnight(now.getFullYear(), now.getMonth() + 1, now.getDate())) {
      date = new Date(now.getFullYear() + 1, Number(cnShort[1]) - 1, Number(cnShort[2]));
    }
    text = text.replace(cnShort[0], ' ');
    dateNote = `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  } else if (rel) {
    const offset = { 今天: 0, 今晚: 0, 明天: 1, 明晚: 1, 後天: 2, 大後天: 3, 昨天: -1 }[rel[1]] ?? 0;
    date = addDays(now, offset);
    text = text.replace(rel[0], ' ');
    dateNote = rel[1];
  } else if (week) {
    const mondayBased = mondayIndex(now);
    const target = WEEKDAY_INDEX[week[2]];
    const targetMonday = (target + 6) % 7;
    const weekShift = week[1].startsWith('下下') ? 2 : week[1].startsWith('下') ? 1 : 0;
    const baseMonday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - mondayBased + weekShift * 7);
    date = addDays(baseMonday, targetMonday);
    if (weekShift === 0 && date.getTime() < utcMidnight(now.getFullYear(), now.getMonth() + 1, now.getDate())) {
      date = addDays(date, 7);
      dateNote = `下週${week[2]}`;
    } else {
      dateNote = `${week[1]}${week[2]}`;
    }
    text = text.replace(week[0], ' ');
  } else if (bareWeekday) {
    const target = WEEKDAY_INDEX[bareWeekday[1]];
    const delta = (target - weekdayOf(now) + 7) % 7 || 7;
    date = addDays(now, delta);
    text = text.replace(bareWeekday[0], ' ');
    dateNote = `下個${bareWeekday[1] === '天' ? '日' : bareWeekday[1]}`;
  } else if (anchorWeekday !== null && rrule) {
    // "每週四" alone: start at the next occurrence of that weekday.
    const delta = (anchorWeekday - weekdayOf(now) + 7) % 7 || 7;
    date = addDays(now, delta);
    dateNote = `下個${['日', '一', '二', '三', '四', '五', '六'][anchorWeekday]}`;
  } else if (everyMonth) {
    // "每月 15 號" alone: start at the next 15th.
    const target = Number(everyMonth[1]);
    let y = now.getFullYear();
    let m = now.getMonth();
    if (now.getDate() >= target) m += 1;
    const lastDay = new Date(y, m + 1, 0).getDate();
    date = new Date(y, m, Math.min(target, lastDay));
    dateNote = `每月 ${target} 號`;
  }

  // ---------- time ----------
  let startMinutes: number | null = null;
  let endMinutes: number | null = null;
  let allDay = false;

  const clock = /(上午|早上|清晨|中午|下午|傍晚|晚上|夜間|凌晨)?\s*(\d{1,2})\s*[:點点時时]\s*(半|\d{1,2})?\s*(?:分)?/g;
  const found: { h: number; mi: number; period?: string; raw: string; index: number }[] = [];
  for (const m of text.matchAll(clock)) {
    const mi = m[3] === '半' ? 30 : m[3] ? Number(m[3]) : 0;
    found.push({ h: Number(m[2]), mi, period: m[1], raw: m[0], index: m.index ?? 0 });
  }
  if (found.length) {
    const first = found[0];
    startMinutes = to24(first.h, first.mi, first.period);
    // "今晚 7點" / "明晚 8點": an evening word applies to a bare hour.
    if (!first.period && rel && /晚|夜/.test(rel[1]) && first.h < 12) startMinutes += 12 * 60;
    text = text.replace(first.raw, ' ');
    if (found.length > 1) {
      const second = found[1];
      endMinutes = to24(second.h, second.mi, second.period);
      if (!second.period && rel && /晚|夜/.test(rel[1]) && second.h < 12) endMinutes += 12 * 60;
      text = text.replace(second.raw, ' ');
      if (endMinutes <= startMinutes) endMinutes += 24 * 60;
    }
  }

  const durHours = /(\d+(?:\.\d+)?)\s*(?:個)?\s*(?:小時|钟头|鐘頭)/.exec(text);
  const durMinutes = /(\d+)\s*(?:分鐘|分钟|分)/.exec(text);
  if (startMinutes !== null && endMinutes === null) {
    if (durHours) {
      endMinutes = startMinutes + Math.round(Number(durHours[1]) * 60);
      text = text.replace(durHours[0], ' ');
    } else if (durMinutes) {
      endMinutes = startMinutes + Number(durMinutes[1]);
      text = text.replace(durMinutes[0], ' ');
    }
  }

  if (/全天|整日|一整天/.test(text)) {
    allDay = true;
    text = text.replace(/全天|整日|一整天/g, ' ');
  }

  // ---------- title ----------
  const title = text
    .replace(/[，,。;；、]/g, ' ')
    .replace(/(?:^|\s)[-–~〜](?=\s|$)/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^(在|於|于)\s*/, '')
    .replace(/\s*(的)?\s*$/, '')
    .trim();

  if (!title) unparsed.push('沒有標題');

  // ---------- resolve ----------
  let confidence: Confidence = 'high';
  if (!date) {
    confidence = 'low';
    unparsed.push('沒有日期');
  }
  if (!allDay && startMinutes === null) {
    confidence = confidence === 'low' ? 'low' : 'medium';
    unparsed.push('沒有時間');
  }

  const day = date ?? addDays(now, 0);
  const y = day.getFullYear(), mo = day.getMonth() + 1, d = day.getDate();

  let start_at: number;
  let end_at: number;
  if (allDay) {
    start_at = utcMidnight(y, mo, d);
    end_at = start_at + 86400000;
  } else {
    const sm = startMinutes ?? defaultHour * 60;
    const em = endMinutes ?? sm + defaultDuration;
    start_at = new Date(y, mo - 1, d, Math.floor(sm / 60), sm % 60).getTime();
    end_at = new Date(y, mo - 1, d, Math.floor(em / 60) % 24, em % 60).getTime() + (em >= 1440 ? 86400000 : 0);
  }

  return {
    title: title || '（未命名）',
    all_day: allDay,
    start_at,
    end_at,
    rrule,
    confidence,
    notes: [dateNote, ...notes].filter(Boolean),
    unparsed,
  };
}

function to24(h: number, mi: number, period?: string): number {
  let hour = h;
  if (period) {
    if (/(下午|傍晚|晚上|夜間)/.test(period) && hour < 12) hour += 12;
    if (/(中午)/.test(period) && hour < 11) hour += 12;
    if (/(凌晨|早上|清晨|上午)/.test(period) && hour === 12) hour = 0;
  }
  return hour * 60 + mi;
}
