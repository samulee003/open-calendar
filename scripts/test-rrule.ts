import { expand, parseRRule, describe } from '../src/rrule.ts';
import { wallParts, dayKey } from '../src/tz.ts';

const weekdayIn = (ms: number, tz: string) => wallParts(ms, tz).weekday;
const hhmmIn = (ms: number, tz: string) => {
  const w = wallParts(ms, tz);
  return String(w.hh).padStart(2, '0') + ':' + String(w.mi).padStart(2, '0');
};

const D = (s: string) => Date.parse(s);
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
let fails = 0;

function check(label: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) { fails++; console.log(`FAIL ${label}\n  got  ${JSON.stringify(got)}\n  want ${JSON.stringify(want)}`); }
  else console.log(`ok   ${label}`);
}

// 1. every Thursday, Jan 2026
check('weekly TH',
  expand('RRULE:FREQ=WEEKLY;BYDAY=TH', D('2026-01-01T10:00:00Z'), 3600000, D('2026-01-01'), D('2026-01-31'))
    .map(iso),
  ['2026-01-01', '2026-01-08', '2026-01-15', '2026-01-22', '2026-01-29']);

// 2. biweekly (隔週) Thursday
check('weekly TH interval 2',
  expand('RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=TH', D('2026-01-01T10:00:00Z'), 3600000, D('2026-01-01'), D('2026-02-28'))
    .map(iso),
  ['2026-01-01', '2026-01-15', '2026-01-29', '2026-02-12', '2026-02-26']);

// 3. MO,WE,FR across a month boundary
check('weekly MO WE FR',
  expand('RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR', D('2026-01-05T00:00:00Z'), 3600000, D('2026-01-05'), D('2026-01-16'))
    .map(iso),
  ['2026-01-05', '2026-01-07', '2026-01-09', '2026-01-12', '2026-01-14', '2026-01-16']);

// 4. monthly on the 15th
check('monthly day 15',
  expand('RRULE:FREQ=MONTHLY;BYMONTHDAY=15', D('2026-01-15T00:00:00Z'), 3600000, D('2026-01-01'), D('2026-06-30'))
    .map(iso),
  ['2026-01-15', '2026-02-15', '2026-03-15', '2026-04-15', '2026-05-15', '2026-06-15']);

// 5. every 3 months
check('monthly interval 3',
  expand('RRULE:FREQ=MONTHLY;INTERVAL=3;BYMONTHDAY=10', D('2026-01-10T00:00:00Z'), 3600000, D('2026-01-01'), D('2026-12-31'))
    .map(iso),
  ['2026-01-10', '2026-04-10', '2026-07-10', '2026-10-10']);

// 6. last day of month
check('monthly last day',
  expand('RRULE:FREQ=MONTHLY;BYMONTHDAY=-1', D('2026-01-31T00:00:00Z'), 3600000, D('2026-01-01'), D('2026-04-30'))
    .map(iso),
  ['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30']);

// 7. 1st Monday of month
check('monthly 1st MO',
  expand('RRULE:FREQ=MONTHLY;BYDAY=1MO', D('2026-01-05T00:00:00Z'), 3600000, D('2026-01-01'), D('2026-04-30'))
    .map(iso),
  ['2026-01-05', '2026-02-02', '2026-03-02', '2026-04-06']);

// 8. COUNT caps
check('daily count 5',
  expand('RRULE:FREQ=DAILY;COUNT=5', D('2026-03-02T00:00:00Z'), 3600000, D('2026-01-01'), D('2026-12-31'))
    .map(iso),
  ['2026-03-02', '2026-03-03', '2026-03-04', '2026-03-05', '2026-03-06']);

// 9. UNTIL caps
check('daily until',
  expand('RRULE:FREQ=DAILY;UNTIL=20260306', D('2026-03-02T00:00:00Z'), 3600000, D('2026-01-01'), D('2026-12-31'))
    .map(iso),
  ['2026-03-02', '2026-03-03', '2026-03-04', '2026-03-05', '2026-03-06']);

// 10. EXDATE skips
check('weekly with exdate',
  expand('RRULE:FREQ=WEEKLY;BYDAY=TH', D('2026-01-01T00:00:00Z'), 3600000, D('2026-01-01'), D('2026-01-31'),
    ['2026-01-08']).map(iso),
  ['2026-01-01', '2026-01-15', '2026-01-22', '2026-01-29']);

// 15. a 01:00 Asia/Taipei Thursday is Wednesday 17:00 UTC — must still land on Thursdays
const TPE = 'Asia/Taipei';
const lateNight = D('2026-12-02T17:00:00Z'); // = 2026-12-03 01:00 TPE (Thursday)
check('zone-aware start resolves to Thursday locally', weekdayIn(lateNight, TPE), 'TH');
const tpe = expand('RRULE:FREQ=WEEKLY;BYDAY=TH', lateNight, 3600000, D('2026-12-01'), D('2026-12-31'), [], TPE);
check('weekly TH stays on Thursdays in +8', tpe.map((ms) => weekdayIn(ms, TPE)).join(','), 'TH,TH,TH,TH,TH');
check('weekly TH local dates in +8', tpe.map((ms) => dayKey(ms, TPE)).join(','),
  '2026-12-03,2026-12-10,2026-12-17,2026-12-24,2026-12-31');
check('ignoring the zone shifts the lesson to Friday locally',
  weekdayIn(expand('RRULE:FREQ=WEEKLY;BYDAY=TH', lateNight, 3600000, D('2026-12-01'), D('2026-12-31'))[0], TPE), 'FR');
check('zone-aware expansion puts it back on Thursday locally',
  weekdayIn(expand('RRULE:FREQ=WEEKLY;BYDAY=TH', lateNight, 3600000, D('2026-12-01'), D('2026-12-31'), [], TPE)[0], TPE), 'TH');

// 16. exdate keyed by local day, not UTC day
check('exdate by local day works at +8',
  expand('RRULE:FREQ=WEEKLY;BYDAY=TH', lateNight, 3600000, D('2026-12-01'), D('2026-12-31'), ['2026-12-10'], TPE)
    .map((ms) => dayKey(ms, TPE)).join(','),
  '2026-12-03,2026-12-17,2026-12-24,2026-12-31');

// 17. DST zones keep wall-clock stable
const ny = expand('RRULE:FREQ=WEEKLY;BYDAY=MO', D('2026-03-02T13:00:00Z'), 3600000, D('2026-02-23'), D('2026-04-06'), [], 'America/New_York');
check('wall clock survives a DST transition', ny.map((ms) => hhmmIn(ms, 'America/New_York')).join(','), '08:00,08:00,08:00,08:00,08:00');
check('ny Mondays stay Mondays', ny.every((ms) => weekdayIn(ms, 'America/New_York') === 'MO'), true);

// 11. yearly birthday incl. Feb 29 anchor -> skips short Feb
check('yearly',
  expand('RRULE:FREQ=YEARLY', D('2026-05-17T00:00:00Z'), 3600000, D('2026-01-01'), D('2030-12-31'))
    .map(iso),
  ['2026-05-17', '2027-05-17', '2028-05-17', '2029-05-17', '2030-05-17']);

// 12. time-of-day preserved
check('time preserved',
  expand('RRULE:FREQ=WEEKLY;BYDAY=TH', D('2026-01-01T13:10:00Z'), 2400000, D('2026-01-01'), D('2026-01-08T23:59:59Z'))
    .map((ms) => new Date(ms).toISOString().slice(11, 16)),
  ['13:10', '13:10']);

// 13. non-recurring passthrough, and range filtering
check('single inside range', expand('RRULE:FREQ=BOGUS', D('2026-02-02T00:00:00Z'), 1, D('2026-01-01'), D('2026-03-01')).length, 1);
check('single outside range', expand('', D('2026-05-05T00:00:00Z'), 1, D('2026-01-01'), D('2026-03-01')).length, 0);

// 14. parse + describe
check('parse ok', parseRRule('RRULE:FREQ=WEEKLY;BYDAY=MO')?.freq, 'WEEKLY');
check('parse null on junk', parseRRule('nonsense'), null);
check('describe', describe('RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=TH'), '每 2 週的星期四');

check('monthly last MO',
  expand('RRULE:FREQ=MONTHLY;BYDAY=-1MO', D('2026-01-26T00:00:00Z'), 3600000, D('2026-01-01'), D('2026-04-30'))
    .map(iso),
  ['2026-01-26', '2026-02-23', '2026-03-30', '2026-04-27']);

// 15. a series anchored years ago must still answer for a far-future window
check('daily series anchored 2013 answers for Nov 2026',
  expand('RRULE:FREQ=DAILY', D('2013-01-01T00:00:00Z'), 3600000, D('2026-11-01'), D('2026-11-30')).length, 30);

// 16. COUNT counts from the anchor, so an old bounded series stays bounded
check('COUNT from an old anchor lists its four Mondays',
  expand('RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=4', D('2013-01-07T00:00:00Z'), 3600000, D('2013-01-01'), D('2013-03-31')).map(iso),
  ['2013-01-07', '2013-01-14', '2013-01-21', '2013-01-28']);
check('that COUNT series is empty five years later',
  expand('RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=4', D('2013-01-07T00:00:00Z'), 3600000, D('2018-01-01'), D('2018-12-31')).length, 0);

// 17. an ordinal prefix on WEEKLY is the weekday, not a silent empty series
check('weekly BYDAY=2MO still matches Mondays',
  expand('RRULE:FREQ=WEEKLY;BYDAY=2MO', D('2026-01-05T00:00:00Z'), 3600000, D('2026-01-01'), D('2026-01-31')).map(iso),
  ['2026-01-05', '2026-01-12', '2026-01-19', '2026-01-26']);

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exitCode = fails ? 1 : 0;
