// Tolerant CSV/TSV reader for moving an existing calendar export into this app.
// Column names are matched by alias because export headers differ by locale and
// change over time; when nothing matches, the tool reports the header row rather
// than guessing a mapping.

type Rec = Record<string, string>;

const ALIASES: Record<string, string[]> = {
  title: ['title', '標題', '标题', '予定タイトル', 'summary', '事件名稱', 'event'],
  date: ['date', '日期', '日付', 'start date', '開始日期', 'start_date'],
  start: ['start', 'start time', '開始時間', '开始时间', '開始'],
  end: ['end', 'end time', '終了時間', '结束时间', '結束時間', '結束'],
  all_day: ['all_day', 'all day', '全天', '終日', '整日'],
  note: ['note', 'description', '備註', '备注', '備考', '内容'],
  location: ['location', '地點', '場所', '地点'],
  label: ['label', 'labels', '標籤', 'ラベル'],
  time: ['time', '時間', 'datetime', '開始日時'],
};

export function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '', quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') quoted = false;
      else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === ',' || c === '\t' || c === ';') { out.push(cur.trim()); cur = ''; }
    else cur += c;
  }
  out.push(cur.trim());
  return out;
}

const pick = (headers: string[], key: string): number =>
  headers.findIndex((h) => ALIASES[key]?.includes(h.replace(/\s+/g, ' ').trim()));

// The leading guard must be a lookbehind, not \b: in "2026-11-09T09:15" there is
// no word boundary between T and 0, so \b would skip ahead and match "15:00".
const TIMES = /(?<![\d:])(\d{1,2}):(\d{2})(?::\d{2})?(?!\d)\s*(am|pm)?/gi;

function toMin(h: string, m: string, ampm?: string): number {
  let hours = +h;
  const suffix = (ampm ?? '').toLowerCase();
  if (suffix === 'pm' && hours < 12) hours += 12;
  if (suffix === 'am' && hours === 12) hours = 0;
  return hours * 60 + +m;
}

function parseDate(v: string): [number, number, number] | null {
  const s = v.trim();
  const iso = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(s);
  if (iso) return [+iso[1], +iso[2], +iso[3]];
  const cn = /^(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日?/.exec(s);
  if (cn) return [+cn[1], +cn[2], +cn[3]];
  // "05/11/2026" is deliberately rejected: day-first and month-first are both
  // plausible and Date.parse would silently assume US order.
  if (/^\d{1,2}[/.]\d{1,2}[/.]\d{2,4}/.test(s)) return null;
  const parsed = Date.parse(s);
  if (Number.isNaN(parsed)) return null;
  const d = new Date(parsed);
  return [d.getFullYear(), d.getMonth() + 1, d.getDate()];
}

export type ParsedRow = { error?: string; event?: any };

/** Local-timezone instants, so a phone and a laptop in the same zone agree. */
export function rowToEvent(row: Rec): ParsedRow {
  const rawDate = row.date ?? row.time ?? '';
  const date = parseDate(rawDate);
  if (!date) return { error: `無法解析日期：「${rawDate}」` };
  const title = (row.title ?? '').trim();
  if (!title) return { error: '這列沒有標題欄位' };
  const [y, mo, d] = date;
  const probe = new Date(y, mo - 1, d);
  if (probe.getFullYear() !== y || probe.getMonth() !== mo - 1 || probe.getDate() !== d) {
    return { error: `無法解析日期：「${rawDate}」（日期超出範圍）` };
  }

  // times may live in their own columns or inside the date cell ("2026-11-05 14:00-15:00")
  const found = [...rawDate.matchAll(TIMES)].map((m) => toMin(m[1], m[2], m[3]));
  const explicit = [row.start, row.end].map((v) => {
    const m = v ? /^(\d{1,2}):(\d{2})(?::\d{2})?\s*(am|pm)?$/i.exec(v.trim()) : null;
    return m ? toMin(m[1], m[2], m[3]) : null;
  });
  const sMin = explicit[0] ?? found[0] ?? null;
  const eMin = explicit[1] ?? found[1] ?? (sMin !== null ? sMin + 60 : null);

  const truthy = /^(1|true|yes|y|是|全?天|終日)$/.test((row.all_day ?? '').trim().toLowerCase());
  const allDay = truthy || sMin === null;
  if (eMin !== null && eMin <= sMin! && eMin < 1440) eMin += 1440; // e.g. 23:00-01:00

  const start_at = allDay ? Date.UTC(y, mo - 1, d) : new Date(y, mo - 1, d, Math.floor(sMin! / 60), sMin! % 60).getTime();
  const end_at = allDay ? start_at + 86400000 : new Date(y, mo - 1, d, Math.floor((eMin! % 1440) / 60), eMin! % 60).getTime();
  const event: any = {
    title, all_day: allDay, start_at, end_at,
    note: row.note ?? '', location: row.location ?? '',
    __label: row.label ?? '',
  };

  const hay = Object.values(row).join(' ');
  const wd = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'][new Date(y, mo - 1, d).getDay()];
  if (/每兩週|隔週|biweek/i.test(hay)) event.rrule = `RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=${wd}`;
  else if (/每週|每星期的?星期|weekly/i.test(hay)) event.rrule = `RRULE:FREQ=WEEKLY;BYDAY=${wd}`;
  else if (/每月|monthly/i.test(hay)) event.rrule = `RRULE:FREQ=MONTHLY;BYMONTHDAY=${d}`;
  else if (/每年|yearly/i.test(hay)) event.rrule = 'RRULE:FREQ=YEARLY';
  return { event };
}

/** Prints what the header row would map to, without parsing any data rows. */
export function describeHeader(text: string): { header: string[]; mapping: Record<string, number> } {
  const first = text.split(/\r?\n/).find((l) => l.trim()) ?? '';
  const header = splitCsvLine(first).map((h) => h.toLowerCase());
  const mapping: Record<string, number> = {};
  for (const k of Object.keys(ALIASES)) mapping[k] = pick(header, k);
  return { header, mapping };
}

export function parseCsv(text: string): { events: any[]; skipped: string[] } {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() && !l.startsWith('#'));
  if (!lines.length) return { events: [], skipped: ['檔案是空的'] };
  const header = splitCsvLine(lines[0]).map((h) => h.toLowerCase());
  const idx: Record<string, number> = {};
  for (const k of Object.keys(ALIASES)) idx[k] = pick(header, k);
  if (idx.title < 0 || (idx.date < 0 && idx.time < 0)) {
    return { events: [], skipped: [`表頭無法辨識：${lines[0]}`, '需要可對應 title(標題/予定タイトル/summary) 及 date(日期/日付) 或 time(時間) 的欄位'] };
  }
  const events: any[] = [], skipped: string[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = splitCsvLine(lines[i]);
    const row: Rec = {};
    for (const [k, at] of Object.entries(idx)) if (at >= 0 && cells[at] !== undefined) row[k] = cells[at];
    const out = rowToEvent(row);
    if (out.error) skipped.push(`第 ${i + 1} 行：${out.error}`);
    else events.push(out.event);
  }
  return { events, skipped };
}
