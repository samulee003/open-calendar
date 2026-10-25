// Macau holiday table integrity + get_date_info semantics. Pure: no server,
// because the table is static and timezone is passed explicitly.
import { Client } from '../src/client.ts';
import { getDateInfo } from '../src/agent-tools.ts';
import { MACAU_HOLIDAYS, COVERAGE, holidayOn, holidaysBetween, weekdayOf } from '../src/holidays.ts';

let pass = 0, fail = 0;
const ok = (label: string, cond: boolean, extra = '') => {
  if (cond) { pass++; console.log('ok   ' + label); }
  else { fail++; console.log(`FAIL ${label} ${extra}`); }
};

const c = new Client({ base: 'http://127.0.0.1:1', tz: 'Asia/Macau' });
const info = (args: any) => getDateInfo(c, args);

// ---- table integrity ----
const all = Object.values(MACAU_HOLIDAYS).flat();
ok('2026 has 20 holidays + 6 makeup days', MACAU_HOLIDAYS[2026].length === 26
  && MACAU_HOLIDAYS[2026].filter((x) => x.makeup).length === 6);
ok('2027 has 20 holidays + 6 makeup days', MACAU_HOLIDAYS[2027].length === 26
  && MACAU_HOLIDAYS[2027].filter((x) => x.makeup).length === 6);
ok('no duplicate dates', new Set(all.map((x) => x.date)).size === all.length);
ok('every date sorts inside its coverage year', all.every((x) => x.date >= COVERAGE.from && x.date <= COVERAGE.to));
ok('makeup days never land on a weekend', all.filter((x) => x.makeup).every((x) => [1, 2, 3, 4, 5].includes(weekdayOf(x.date))));

// Weekdays taken from the published 2026/2027 tables — a wrong date would flip these.
const weekdayName = (d: string) => ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][weekdayOf(d)];
ok('2026-01-01 is Thursday', weekdayName('2026-01-01') === 'Thu');
ok('2026-02-17 is Tuesday', weekdayName('2026-02-17') === 'Tue');
ok('2026-09-26 is Saturday', weekdayName('2026-09-26') === 'Sat');
ok('2026-11-02 is Monday', weekdayName('2026-11-02') === 'Mon');
ok('2027-01-01 is Friday', weekdayName('2027-01-01') === 'Fri');
ok('2027-02-06 is Saturday', weekdayName('2027-02-06') === 'Sat');
ok('2027-12-27 is Monday', weekdayName('2027-12-27') === 'Mon');

ok('2026-09-28 is the 中秋 makeup day', holidayOn('2026-09-28')?.makeup === true
  && holidayOn('2026-09-28')?.name.includes('中秋'));
ok('2027-02-09/10 are CNY makeup days', holidayOn('2027-02-09')?.makeup === true && holidayOn('2027-02-10')?.makeup === true);
ok('ordinary day has no holiday', holidayOn('2026-10-26') === null);
ok('holidaysBetween counts the year', holidaysBetween('2026-01-01', '2026-12-31').length === 26);

// ---- get_date_info ----
const d1 = await info({ date: '2026-11-02' });
ok('holiday name returned', d1.holiday?.name === '追思節' && d1.holiday?.makeup === false, JSON.stringify(d1));
ok('weekday in Chinese', d1.weekday === '星期一');
ok('weekend flag false on Monday', d1.weekend === false);
ok('coverage reported', d1.holiday_known === true && d1.coverage.from === '2026-01-01');

const d2 = await info({ date: '2026-10-25' });
ok('next holiday is 追思節 in 8 days', d2.next_holiday?.date === '2026-11-02' && d2.next_holiday?.days_away === 8, JSON.stringify(d2.next_holiday));
ok('Sunday is a weekend', d2.weekend === true && d2.weekday === '星期日');
ok('ordinary day returns null holiday', d2.holiday === null && d2.holiday_known === true);

const d3 = await info({ date: '2026-09-28' });
ok('makeup day flagged', d3.holiday?.makeup === true, JSON.stringify(d3.holiday));

const d4 = await info({ date: '2027-02-01', days: 15 });
ok('holiday window lists CNY block', d4.holidays?.length === 5
  && d4.holidays.map((x: any) => x.date).join() === '2027-02-06,2027-02-07,2027-02-08,2027-02-09,2027-02-10', JSON.stringify(d4.holidays));

const d5 = await info({ date: '2025-12-25' });
ok('outside coverage is explicitly unknown', d5.holiday === null && d5.holiday_known === false && !!d5.note, JSON.stringify(d5));
ok('unknown date still reports weekday', d5.weekday === '星期四' && d5.weekend === false);

const d6 = await info({ date: '2027-12-31' });
ok('last covered day has no next holiday', 'next_holiday' in d6 ? false : true, JSON.stringify(d6));

const d7 = await info({ date: '2026-11-05T10:00:00+08:00' });
ok('non-date input resolves to its local day', d7.date === '2026-11-05');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
