// Macau public holidays under 第60/2000號行政命令, as published in the
// Boletim Oficial: 2026 list and the 2027 list gazetted 2026-04-22.
// Makeup days (補假) are marked separately; the table is deliberately finite —
// callers must treat dates outside COVERAGE as unknown, not as working days.

export type Holiday = { date: string; name: string; makeup: boolean };

const h = (date: string, name: string): Holiday => ({ date, name, makeup: false });
const m = (date: string, name: string): Holiday => ({ date, name: `${name}補假`, makeup: true });

export const MACAU_HOLIDAYS: Record<number, Holiday[]> = {
  2026: [
    h('2026-01-01', '元旦'),
    h('2026-02-17', '農曆正月初一'),
    h('2026-02-18', '農曆正月初二'),
    h('2026-02-19', '農曆正月初三'),
    h('2026-04-03', '耶穌受難日'),
    h('2026-04-04', '復活節前日'),
    h('2026-04-05', '清明節'),
    m('2026-04-06', '復活節前日'),
    m('2026-04-07', '清明節'),
    h('2026-05-01', '勞動節'),
    h('2026-05-24', '佛誕節'),
    m('2026-05-25', '佛誕節'),
    h('2026-06-19', '端午節'),
    h('2026-09-26', '中秋節翌日'),
    m('2026-09-28', '中秋節翌日'),
    h('2026-10-01', '中華人民共和國國慶日'),
    h('2026-10-02', '國慶日翌日'),
    h('2026-10-18', '重陽節'),
    m('2026-10-19', '重陽節'),
    h('2026-11-02', '追思節'),
    h('2026-12-08', '聖母無原罪瞻禮'),
    h('2026-12-20', '澳門特別行政區成立紀念日'),
    m('2026-12-21', '成立紀念日'),
    h('2026-12-22', '冬至'),
    h('2026-12-24', '聖誕節前日'),
    h('2026-12-25', '聖誕節'),
  ],
  2027: [
    h('2027-01-01', '元旦'),
    h('2027-02-06', '農曆正月初一'),
    h('2027-02-07', '農曆正月初二'),
    h('2027-02-08', '農曆正月初三'),
    m('2027-02-09', '農曆正月初一'),
    m('2027-02-10', '農曆正月初二'),
    h('2027-03-26', '耶穌受難日'),
    h('2027-03-27', '復活節前日'),
    m('2027-03-29', '復活節前日'),
    h('2027-04-05', '清明節'),
    h('2027-05-01', '勞動節'),
    m('2027-05-03', '勞動節'),
    h('2027-05-13', '佛誕節'),
    h('2027-06-09', '端午節'),
    h('2027-09-16', '中秋節翌日'),
    h('2027-10-01', '中華人民共和國國慶日'),
    h('2027-10-02', '國慶日翌日'),
    m('2027-10-04', '國慶日翌日'),
    h('2027-10-08', '重陽節'),
    h('2027-11-02', '追思節'),
    h('2027-12-08', '聖母無原罪瞻禮'),
    h('2027-12-20', '澳門特別行政區成立紀念日'),
    h('2027-12-22', '冬至'),
    h('2027-12-24', '聖誕節前日'),
    h('2027-12-25', '聖誕節'),
    m('2027-12-27', '聖誕節'),
  ],
};

const BY_DATE = new Map<string, Holiday>(
  Object.values(MACAU_HOLIDAYS).flat().map((x) => [x.date, x]),
);

export const COVERAGE = { from: '2026-01-01', to: '2027-12-31' };

export function isCovered(date: string): boolean {
  return date >= COVERAGE.from && date <= COVERAGE.to;
}

export function holidayOn(date: string): Holiday | null {
  return BY_DATE.get(date) ?? null;
}

export function holidaysBetween(from: string, to: string): Holiday[] {
  if (to < from) return [];
  return [...BY_DATE.values()].filter((x) => x.date >= from && x.date <= to).sort((a, b) => (a.date < b.date ? -1 : 1));
}

/** Calendar weekday of a YYYY-MM-DD key: 0=Sunday … 6=Saturday (date-only, no zone involved). */
export function weekdayOf(date: string): number {
  const [y, mo, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, mo - 1, d)).getUTCDay();
}
