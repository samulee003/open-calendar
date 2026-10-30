import { parseQuickAdd } from '../src/nlp.ts';

const NOW = new Date(2026, 9, 23, 10, 0, 0); // Friday 2026-10-23 10:00 local
const opts = { now: NOW };

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
const p = (s: string) => parseQuickAdd(s, opts);

// ---- dates ----
ok('明天 下午3點 看牙醫', (() => { const r = p('明天 下午3點 看牙醫'); return day(r.start_at) === '2026-10-24' && hm(r.start_at) === '15:00' && r.title === '看牙醫' && r.confidence === 'high'; })(), JSON.stringify(p('明天 下午3點 看牙醫')));
ok('今晚 7點 吃飯', (() => { const r = p('今晚 7點 吃飯'); return day(r.start_at) === '2026-10-23' && hm(r.start_at) === '19:00'; })());
ok('後天 早上8:30 跑步', (() => { const r = p('後天 早上8:30 跑步'); return day(r.start_at) === '2026-10-25' && hm(r.start_at) === '08:30'; })());
ok('10月30日 14:00 開會', (() => { const r = p('10月30日 14:00 開會'); return day(r.start_at) === '2026-10-30' && hm(r.start_at) === '14:00'; })());
ok('already-passed 3月5日 rolls to next year', (() => { const r = p('3月5日 09:00 掃墓'); return day(r.start_at) === '2027-03-05'; })(), day(p('3月5日 09:00 掃墓').start_at));
ok('2026-11-05 iso', (() => { const r = p('2026-11-05 10:00 出差'); return day(r.start_at) === '2026-11-05'; })());

// ---- weekday resolution (2026-10-23 is Friday) ----
ok('星期一 resolves to next Monday', (() => { const r = p('星期一 09:00 例會'); return day(r.start_at) === '2026-10-26'; })(), day(p('星期一 09:00 例會').start_at));
ok('星期日 resolves to this Sunday (2 days later)', (() => { const r = p('星期日 10:00 打球'); return day(r.start_at) === '2026-10-25'; })(), day(p('星期日 10:00 打球').start_at));
ok('星期五 (today) resolves to next week, not today', (() => { const r = p('星期五 10:00 例會'); return day(r.start_at) === '2026-10-30'; })(), day(p('星期五 10:00 例會').start_at));
ok('下週三 14:00', (() => { const r = p('下週三 14:00 課程'); return day(r.start_at) === '2026-10-28'; })(), day(p('下週三 14:00 課程').start_at));
ok('這週四 09:00', (() => { const r = p('這週四 09:00 課程'); return day(r.start_at) === '2026-10-29'; })(), day(p('這週四 09:00 課程').start_at));

// ---- recurrence ----
ok('每週四 19:00 鋼琴課', (() => {
  const r = p('每週四 19:00 鋼琴課');
  return r.rrule === 'RRULE:FREQ=WEEKLY;BYDAY=TH' && day(r.start_at) === '2026-10-29' && hm(r.start_at) === '19:00';
})(), JSON.stringify(p('每週四 19:00 鋼琴課')));
ok('每兩週六 10:00', (() => {
  const r = p('每兩週六 10:00 游泳');
  return r.rrule === 'RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=SA' && day(r.start_at) === '2026-10-24';
})(), JSON.stringify(p('每兩週六 10:00 游泳')));
ok('每月 15 號 09:00 繳費', (() => {
  const r = p('每月 15 號 09:00 繳費');
  return r.rrule === 'RRULE:FREQ=MONTHLY;BYMONTHDAY=15' && day(r.start_at) === '2026-11-15';
})(), JSON.stringify(p('每月 15 號 09:00 繳費')));

// ---- times ----
ok('3點半 keeps 30 minutes', (() => { const r = p('明天 3點半 喝茶'); return hm(r.start_at) === '03:30'; })());
ok('下午3點半 = 15:30', (() => { const r = p('明天 下午3點半 喝茶'); return hm(r.start_at) === '15:30'; })());
ok('晚上9點 = 21:00', (() => { const r = p('明天 晚上9點 看劇'); return hm(r.start_at) === '21:00'; })());
ok('凌晨12點 = 00:00', (() => { const r = p('明天 凌晨12點 出發'); return hm(r.start_at) === '00:00'; })());
ok('14:00-15:30 range', (() => { const r = p('明天 14:00-15:30 會議'); return hm(r.start_at) === '14:00' && hm(r.end_at) === '15:30'; })(), JSON.stringify({ s: hm(p('明天 14:00-15:30 會議').start_at), e: hm(p('明天 14:00-15:30 會議').end_at) }));
ok('時長 2小時', (() => { const r = p('明天 10:00 會議 2小時'); return hm(r.end_at) === '12:00'; })(), hm(p('明天 10:00 會議 2小時').end_at));
ok('default duration is 60 minutes', (() => { const r = p('明天 10:00 會議'); return hm(r.end_at) === '11:00'; })());

// ---- all day ----
ok('全天', (() => { const r = p('10月24日 全天 旅行'); return r.all_day === true && day(r.start_at) === '2026-10-24'; })(), JSON.stringify(p('10月24日 全天 旅行')));

// ---- low confidence instead of guessing ----
ok('no date is low confidence and flagged', (() => { const r = p('買牛奶'); return r.confidence === 'low' && r.unparsed.includes('沒有日期') && r.title === '買牛奶'; })(), JSON.stringify(p('買牛奶')));
ok('date without time is medium, not silently 9am', (() => { const r = p('明天 看牙醫'); return r.confidence === 'medium' && r.unparsed.includes('沒有時間'); })());
ok('title keeps unknown words', (() => { const r = p('明天 15:00 到學校接小孩'); return r.title === '到學校接小孩'; })(), p('明天 15:00 到學校接小孩').title);

// ---- messy real-world phrasing ----
ok('fullwidth digits and colon', (() => { const r = p('明天　１５：００　開會'); return hm(r.start_at) === '15:00' && r.title === '開會'; })(), JSON.stringify(p('明天　１５：００　開會')));
ok('no space between date and time', (() => { const r = p('明天15:00開會'); return day(r.start_at) === '2026-10-24' && hm(r.start_at) === '15:00'; })(), JSON.stringify(p('明天15:00開會')));

// ---- same-day phrases stay today (regression: a zone-mixed compare used to roll them) ----
ok('same-day 10月23日 does not roll to next year', (() => { const r = p('10月23日 上午9點 打掃'); return day(r.start_at) === '2026-10-23' && hm(r.start_at) === '09:00'; })(), JSON.stringify(p('10月23日 上午9點 打掃')));
ok('這週五 said on Friday stays today', (() => { const r = p('這週五 15:00 收尾'); return day(r.start_at) === '2026-10-23' && hm(r.start_at) === '15:00'; })(), JSON.stringify(p('這週五 15:00 收尾')));

// ---- explicit timezone anchoring (absolute epochs, machine-independent) ----
const tp = (s: string, nowMs: number, tz: string) => parseQuickAdd(s, { now: new Date(nowMs), tz });
// 2026-11-05 01:00Z is 09:00 in Taipei and 2026-11-04 21:00 in New York.
ok('tz: 明天 15:00 in Asia/Taipei is 07:00Z next day', (() => { const r = tp('明天 下午3點 看牙醫', Date.UTC(2026, 10, 5, 1, 0), 'Asia/Taipei'); return r.start_at === Date.UTC(2026, 10, 6, 7, 0) && r.confidence === 'high'; })(), JSON.stringify(tp('明天 下午3點 看牙醫', Date.UTC(2026, 10, 5, 1, 0), 'Asia/Taipei')));
ok('tz: the same sentence in New York lands on a different date', (() => { const r = tp('明天 下午3點 看牙醫', Date.UTC(2026, 10, 5, 1, 0), 'America/New_York'); return r.start_at === Date.UTC(2026, 10, 5, 20, 0); })(), JSON.stringify(tp('明天 下午3點 看牙醫', Date.UTC(2026, 10, 5, 1, 0), 'America/New_York')));
ok('tz: same-day M月D日 does not roll to next year', (() => { const r = tp('11月5日 上午9點 測試', Date.UTC(2026, 10, 5, 1, 0), 'Asia/Taipei'); return r.start_at === Date.UTC(2026, 10, 5, 1, 0); })(), JSON.stringify(tp('11月5日 上午9點 測試', Date.UTC(2026, 10, 5, 1, 0), 'Asia/Taipei')));
ok('tz: 這週三 on the Wednesday itself stays today', (() => { const r = tp('這週三 下午3點 會議', Date.UTC(2026, 10, 4, 9, 0), 'Asia/Taipei'); return r.start_at === Date.UTC(2026, 10, 4, 7, 0); })(), JSON.stringify(tp('這週三 下午3點 會議', Date.UTC(2026, 10, 4, 9, 0), 'Asia/Taipei')));
ok('tz: 每週四 anchors on Thursday in that zone', (() => { const r = tp('每週四 19:00 鋼琴課', Date.UTC(2026, 10, 4, 9, 0), 'America/New_York'); return r.rrule === 'RRULE:FREQ=WEEKLY;BYDAY=TH' && r.start_at === Date.UTC(2026, 10, 6, 0, 0); })(), JSON.stringify(tp('每週四 19:00 鋼琴課', Date.UTC(2026, 10, 4, 9, 0), 'America/New_York')));

console.log(fail ? `\n${fail} FAILED of ${pass + fail}` : `\n${pass} passed`);
process.exitCode = fail ? 1 : 0;
