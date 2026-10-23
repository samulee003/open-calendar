import { parseCsv, splitCsvLine, describeHeader } from '../src/import-lib.ts';

let pass = 0, fail = 0;
const ok = (label: string, cond: boolean, extra = '') => {
  if (cond) { pass++; console.log('ok   ' + label); }
  else { fail++; console.log(`FAIL ${label} ${extra}`); }
};

const day = (ms: number) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const hm = (ms: number) => {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

ok('csv line splits quotes and commas', splitCsvLine('a,"b,c",d').join('|'), 'a|b,c|d');
ok('csv line unescapes doubled quotes', splitCsvLine('"he said ""hi"""')[0], 'he said "hi"');

const zh = `日期,標題,開始時間,結束時間,備註
2026-11-05,大提琴課,14:00,15:00,帶譜
2026-11-12,古箏班,16:00,17:00,`;
const a = parseCsv(zh);
ok('zh headers map', a.events.length === 2, JSON.stringify(a).slice(0, 120));
ok('zh first event fields', a.events[0].title === '大提琴課' && day(a.events[0].start_at) === '2026-11-05'
  && hm(a.events[0].start_at) === '14:00' && hm(a.events[0].end_at) === '15:00' && a.events[0].note === '帶譜');
ok('zh second event defaults to +60min', hm(a.events[1].end_at) === '17:00');

const ja = `予定タイトル,日付,開始時間,終日
奶奶生日,2026/11/12,,1`;
const b = parseCsv(ja);
ok('ja headers map', b.events.length === 1 && b.events[0].all_day === true, JSON.stringify(b).slice(0, 160));
ok('all-day stored as UTC midnight of that calendar day',
  new Date(b.events[0].start_at).toISOString().slice(0, 10) === '2026-11-12');
ok('all-day duration is one day', b.events[0].end_at - b.events[0].start_at === 86400000);

const en = `title,date,start,note,"Location"
" Piano, lesson ",2026-12-01,09:30,bring sheet music,Taipei Hall`;
const c = parseCsv(en);
ok('quoted comma inside title survives', c.events[0].title === 'Piano, lesson', JSON.stringify(c.events[0]));
ok('location column mapped', c.events[0].location === 'Taipei Hall');

const weekly = `標題,日期,時間
游泳,2026-12-03 14:00 每週`;
const w = parseCsv(weekly);
ok('weekly keyword builds an RRULE on the anchor weekday',
  w.events[0].rrule === 'RRULE:FREQ=WEEKLY;BYDAY=TH', JSON.stringify(w.events[0].rrule));

const badHeader = `foo,bar
1,2`;
const d1 = parseCsv(badHeader);
ok('unrecognised header is reported, not guessed', d1.events.length === 0 && d1.skipped.length >= 1, JSON.stringify(d1.skipped));

const badRow = `標題,日期
沒有日期,2026-13-45`;
const d2 = parseCsv(badRow);
ok('out-of-range date is skipped with a reason', d2.events.length === 0 && /無法解析日期/.test(d2.skipped[0]), JSON.stringify(d2.skipped));

const withLabel = `日期,標題,標籤
2026-11-05,大提琴課,才藝`;
const lb = parseCsv(withLabel);
ok('label column is carried for id resolution', lb.events[0].__label === '才藝', JSON.stringify(lb.events[0]));

// ---- format tolerance ----
const cnDate = parseCsv(`日期,標題\n2026年11月5日,家長會`);
ok('chinese 年月日 date parses', cnDate.events.length === 1 && day(cnDate.events[0].start_at) === '2026-11-05', JSON.stringify(cnDate));

const twelve = parseCsv(`title,date,start,end
Dentist,2026-11-06,2:00 PM,3:30 PM`);
ok('12-hour times with PM parse', twelve.events.length === 1
  && hm(twelve.events[0].start_at) === '14:00' && hm(twelve.events[0].end_at) === '15:30', JSON.stringify(twelve.events[0]));

const isoTime = parseCsv(`title,dateTime
Standup,2026-11-09T09:15:00`);
ok('ISO datetime with T parses', isoTime.events.length === 1 && hm(isoTime.events[0].start_at) === '09:15', JSON.stringify(isoTime.events[0]));

const englishDate = parseCsv(`title,date
Concert,"November 5, 2026"`);
ok('english month-name date parses', englishDate.events.length === 1
  && day(englishDate.events[0].start_at) === '2026-11-05', JSON.stringify(englishDate));

const ambiguous = parseCsv(`title,date
Mystery,05/11/2026`);
ok('ambiguous d/m vs m/d date is refused, not guessed',
  ambiguous.events.length === 0 && /無法解析日期/.test(ambiguous.skipped[0] ?? ''), JSON.stringify(ambiguous));

const hdr = describeHeader(`日期,標題,開始時間,結束時間,備註\n2026-11-05,x,1:00,2:00,`);
ok('header diagnostic maps the useful columns',
  hdr.mapping.title === 1 && hdr.mapping.date === 0 && hdr.mapping.start === 2 && hdr.mapping.note === 4,
  JSON.stringify(hdr));
const hdrBad = describeHeader(`foo,bar\n1,2`);
ok('header diagnostic flags unmapped required columns', hdrBad.mapping.title === -1 && hdrBad.mapping.date === -1);

console.log(fail ? `\n${fail} FAILED` : `\n${pass} passed`);
process.exitCode = fail ? 1 : 0;
