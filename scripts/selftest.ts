// End-to-end selftest: boots the real server on an ephemeral port and drives it
// over real HTTP. Run with: npm run selftest
import { makeServer } from '../src/server.ts';
import { freshStore } from '../src/db.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'scal-test-'));
const store = freshStore(dir);
const server = makeServer(store);
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${(server.address() as any).port}`;

let pass = 0, fail = 0;
const ok = (label: string, cond: boolean, extra = '') => {
  if (cond) { pass++; console.log('ok   ' + label); }
  else { fail++; console.log(`FAIL ${label} ${extra}`); }
};

type Res = { status: number; data: any; cookie: string | null; text: string };
async function req(method: string, path: string, body?: unknown, cookie?: string, origin?: string): Promise<Res> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (cookie) headers.cookie = cookie;
  if (origin) headers.origin = origin;
  const res = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' });
  const text = await res.text();
  let data: any;
  try { data = JSON.parse(text); } catch { data = text; }
  const sc = res.headers.get('set-cookie');
  return { status: res.status, data, cookie: sc ? sc.split(';')[0] : null, text };
}

const D = (s: string) => Date.parse(s);
const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

// ---- signup & session ----
const a = await req('POST', '/api/signup', { email: 'mom@example.com', name: '媽', password: 'supersecret1', tz: 'Asia/Taipei' });
ok('signup returns cookie', a.status === 200 && !!a.cookie, JSON.stringify(a.data));
const ca = a.cookie!;
const me = await req('GET', '/api/me', undefined, ca);
ok('me after login', me.status === 200 && me.data.email === 'mom@example.com');
ok('unauth me is 401', (await req('GET', '/api/me')).status === 401);
ok('bad password rejected', (await req('POST', '/api/login', { email: 'mom@example.com', password: 'wrongpass123' })).status === 401);
ok('short password rejected', (await req('POST', '/api/signup', { email: 'x@y.tw', name: 'x', password: '123' })).status === 400);
ok('duplicate email rejected', (await req('POST', '/api/signup', { email: 'MOM@example.com', name: 'x', password: 'whatever1' })).status === 409);

const cals = await req('GET', '/api/calendars', undefined, ca);
ok('personal calendar auto-created', cals.data.length >= 1 && cals.data[0].role === 'owner');
ok('starter labels auto-created', (await req('GET', `/api/calendars/${cals.data[0].id}/labels`, undefined, ca)).data.length === 3);

// ---- shared calendar + second member ----
const shared = await req('POST', '/api/calendars', { name: '家庭', color: '#6aa84f' }, ca);
const cid = shared.data.id;
ok('create shared calendar', shared.status === 200 && !!cid);
const inv = await req('POST', `/api/calendars/${cid}/invite`, {}, ca);
ok('invite code issued', /^[A-Z0-9]{8,}$/.test(inv.data.code), JSON.stringify(inv.data));

const b = await req('POST', '/api/signup', { email: 'dad@example.com', name: '爸', password: 'supersecret2', tz: 'Asia/Taipei' });
const cb = b.cookie!;
ok('non-member cannot read calendar', (await req('GET', `/api/calendars/${cid}/events`, undefined, cb)).status === 403);
ok('join by code', (await req('POST', '/api/join', { code: inv.data.code }, cb)).status === 200);
ok('members listed', (await req('GET', `/api/calendars/${cid}/members`, undefined, cb)).data.length === 2);

// ---- single + batch creation ----
const one = await req('POST', `/api/calendars/${cid}/events`, {
  title: '大提琴課', start_at: D('2026-11-05T10:00:00Z'), end_at: D('2026-11-05T10:50:00Z'), reminders: [30],
}, ca);
ok('create single event', one.status === 200 && !!one.data.id);
ok('title required', (await req('POST', `/api/calendars/${cid}/events`, { start_at: D('2026-11-05T10:00:00Z') }, ca)).status === 400);
ok('bad rrule rejected', (await req('POST', `/api/calendars/${cid}/events`, { title: 'x', start_at: 1, rrule: 'FREQ=NOPE' }, ca)).status === 400);
ok('end before start rejected', (await req('POST', `/api/calendars/${cid}/events`, { title: 'x', start_at: 5000, end_at: 1000 }, ca)).status === 400);

const batch = Array.from({ length: 6 }, (_, i) => ({
  title: `古琴班 ${i + 1}`, start_at: Date.UTC(2026, 10, 7 + i * 7, 8, 0), all_day: false,
}));
batch[2].title = ''; // deliberately invalid
const res = await req('POST', `/api/calendars/${cid}/events/batch`, { events: batch }, cb);
ok('batch reports created count', res.data.created === 5, JSON.stringify(res.data).slice(0, 160));
ok('batch reports failures with index', res.data.failed.length === 1 && res.data.failed[0].index === 2);
ok('batch over limit rejected', (await req('POST', `/api/calendars/${cid}/events/batch`, { events: new Array(501).fill({ title: 'x', start_at: 1 }) }, cb)).status === 400);

// ---- recurrence ----
const rec = await req('POST', `/api/calendars/${cid}/events`, {
  title: '每四游泳', start_at: D('2026-12-03T14:00:00Z'), end_at: D('2026-12-03T15:00:00Z'), rrule: 'RRULE:FREQ=WEEKLY;BYDAY=TH',
}, ca);
const rid = rec.data.id;
const q = await req('GET', `/api/calendars/${cid}/events?from=${D('2026-12-01')}&to=${D('2027-01-01')}`, undefined, ca);
const thursdays = q.data.filter((r: any) => r.id === rid);
ok('weekly TH expands to 5 in Dec 2026', thursdays.length === 5, `got ${thursdays.length}`);
ok('occurrences keep time of day', thursdays.length > 0 && thursdays.every((r: any) => new Date(r.start_at).toISOString().endsWith('14:00:00.000Z')));
ok('occurrences sorted', q.data.length > 1 && q.data.every((r: any, i: number, arr: any[]) => i === 0 || arr[i - 1].start_at <= r.start_at));
if (thursdays.length < 3) {
  console.log('FATAL recurrence expansion produced too few rows; later steps would false-pass');
  server.close(); process.exitCode = 1; throw new Error('aborted after recurrence');
}

// skip one occurrence
await req('DELETE', `/api/events/${rid}?scope=occurrence&occ=${thursdays[1].occurrence_start}`, undefined, ca);
const afterSkip = (await req('GET', `/api/calendars/${cid}/events?from=${D('2026-12-01')}&to=${D('2027-01-01')}`, undefined, ca))
  .data.filter((r: any) => r.id === rid);
ok('EXDATE removes that occurrence', afterSkip.length === 4, `got ${afterSkip.length}`);

// override one occurrence's title
const target = afterSkip[0].occurrence_start;
await req('POST', `/api/events/${rid}/override`, { occurrence_start: target, title: '游泳課(改期)' }, ca);
const overridden = (await req('GET', `/api/calendars/${cid}/events?from=${D('2026-12-01')}&to=${D('2027-01-01')}`, undefined, ca))
  .data.filter((r: any) => r.id === rid);
ok('override changes only one occurrence', overridden.filter((r: any) => r.title === '游泳課(改期)').length === 1);
ok('other occurrences keep series title', overridden.filter((r: any) => r.title === '每四游泳').length === 3);

// truncate the series from one occurrence onward
const dec17 = overridden[1].occurrence_start;
await req('DELETE', `/api/events/${rid}?scope=future&occ=${dec17}`, undefined, ca);
const truncated = (await req('GET', `/api/calendars/${cid}/events?from=${D('2026-12-01')}&to=${D('2027-01-31')}`, undefined, ca))
  .data.filter((r: any) => r.id === rid);
ok('scope=future stops the series', truncated.length <= 2, `got ${truncated.length} (expected <=2)`);
ok('series still has UNTIL', String((await req('GET', `/api/events/${rid}`, undefined, ca)).data.event.rrule).includes('UNTIL='));

// ---- timezone-correct recurrence over the wire (the +8 late-night lesson) ----
const tpeUser = await req('POST', '/api/signup', { email: 'tpe@example.com', name: 'T', password: 'password1', tz: 'Asia/Taipei' });
const ct = tpeUser.cookie!;
const tcal = (await req('GET', '/api/calendars', undefined, ct)).data[0].id;
const late = await req('POST', `/api/calendars/${tcal}/events`, {
  title: '夜間練習', start_at: Date.UTC(2026, 11, 2, 17, 0), end_at: Date.UTC(2026, 11, 2, 18, 0),
  rrule: 'RRULE:FREQ=WEEKLY;BYDAY=TH',
}, ct);
const trows = (await req('GET', `/api/calendars/${tcal}/events?from=${D('2026-12-01')}&to=${D('2027-01-01')}`, undefined, ct))
  .data.filter((r: any) => r.id === late.data.id);
const localWeekday = (ms: number) => new Date(ms).toLocaleDateString('en-US', { timeZone: 'Asia/Taipei', weekday: 'short' });
ok('+8 late-night Thursday series stays on Thursday locally',
  trows.length === 5 && trows.every((r: any) => localWeekday(r.start_at) === 'Thu'),
  `got ${trows.length} rows: ${trows.map((r: any) => localWeekday(r.start_at)).join(',')}`);
ok('+8 local date keys are the expected Thursdays',
  trows.map((r: any) => new Date(r.start_at).toLocaleDateString('en-CA', { timeZone: 'Asia/Taipei' })).join(','),
  '2026-12-03,2026-12-10,2026-12-17,2026-12-24,2026-12-31');

// ---- comments & reactions ----
const cm = await req('POST', `/api/events/${one.data.id}/comments`, { body: '記得帶譜' }, cb);
ok('member can comment', cm.status === 200);
ok('empty comment rejected', (await req('POST', `/api/events/${one.data.id}/comments`, { body: '  ' }, cb)).status === 400);
const detail = await req('GET', `/api/events/${one.data.id}`, undefined, ca);
ok('comment visible to other member', detail.data.comments.length === 1 && detail.data.comments[0].name === '爸');
ok('event listing carries comment_count', (await req('GET', `/api/calendars/${cid}/events?from=${D('2026-11-01')}&to=${D('2026-12-01')}`, undefined, ca))
  .data.find((r: any) => r.id === one.data.id).comment_count === 1);
ok('cannot delete others comment', (await req('DELETE', `/api/comments/${cm.data.id}`, undefined, ca)).status === 403);

await req('PUT', `/api/events/${one.data.id}/reaction`, { emoji: '👍' }, ca);
await req('PUT', `/api/events/${one.data.id}/reaction`, { emoji: '👍' }, cb);
ok('two reactions counted', (await req('GET', `/api/events/${one.data.id}`, undefined, ca)).data.reactions[0].count === 2);
await req('PUT', `/api/events/${one.data.id}/reaction`, { emoji: '👍' }, cb);
const untoggle = (await req('GET', `/api/events/${one.data.id}`, undefined, ca)).data.reactions[0];
ok('reaction toggles off for the same user', untoggle.count === 1);
ok('mine flag present', typeof untoggle.mine === 'boolean');

// ---- ICS subscription ----
const allDay = await req('POST', `/api/calendars/${cid}/events`, {
  title: '奶奶生日', start_at: D('2026-12-24T00:00:00Z'), all_day: true,
}, ca);
ok('all-day event accepted', allDay.status === 200);
const injected = await req('POST', `/api/calendars/${cid}/events`, {
  title: '正常標題\r\nDESCRIPTION:INJECTED\r\nDTSTART:19700101T000000Z', start_at: D('2026-12-25T09:00:00Z'),
}, cb);
ok('crlf title accepted as data', injected.status === 200);

// ---- creating an ICS token must not disturb the session cookie ----
const beforeSub = await req('GET', '/api/me', undefined, ca);
const subResp = await req('POST', `/api/calendars/${cid}/subscription`, {}, ca);
ok('subscription response does not carry a session cookie', subResp.cookie === null, String(subResp.cookie));
ok('session survives issuing an ICS token',
  beforeSub.status === 200 && (await req('GET', '/api/me', undefined, ca)).status === 200);

const sub = { data: subResp.data };
ok('subscription token issued', !!sub.data.token);
const ics = await fetch(`${base}${sub.data.path}`);
ok('ics readable without login', ics.status === 200 && ics.headers.get('content-type')!.includes('text/calendar'));
const body = await ics.text();
ok('ics has VCALENDAR', body.startsWith('BEGIN:VCALENDAR') && body.trimEnd().endsWith('END:VCALENDAR'));
const countLines = (needle: string) => body.split('\r\n').filter((l) => l.startsWith(needle)).length;
ok('recurring series is ONE vevent, not one per occurrence', countLines('SUMMARY:每四游泳') === 1, `got ${countLines('SUMMARY:每四游泳')}`);
ok('series carries a single RRULE line', countLines('RRULE:FREQ=WEEKLY;BYDAY=TH') === 1, `got ${countLines('RRULE:FREQ=WEEKLY;BYDAY=TH')}`);
ok('series carries EXDATE for the skipped day', /EXDATE:20261210T140000Z/.test(body));
ok('override becomes a RECURRENCE-ID vevent', /RECURRENCE-ID:/.test(body) && body.includes('SUMMARY:游泳課(改期)'));
ok('ics folds every line <=75 octets', body.split('\r\n').every((l) => Buffer.byteLength(l, 'utf8') <= 75));
ok('ics all-day uses VALUE=DATE', /DTSTART;VALUE=DATE:20261224/.test(body));
ok('ics cannot be forged by a CRLF title', !body.split('\r\n').some((l) => l === 'DESCRIPTION:INJECTED' || l === 'X-FAKE:1'));
ok('crlf title survives as escaped text', body.split('\r\n').some((l) => l.includes('SUMMARY:正常標題\\r\\nDESCRIPTION:INJECTED')));

// structural iCalendar validation, not just substring spot checks
{
  const lines = body.split('\r\n');
  const opens = lines.filter((l) => l === 'BEGIN:VEVENT').length;
  const closes = lines.filter((l) => l === 'END:VEVENT').length;
  ok('ics vevent blocks balance', opens === closes && opens > 0, `${opens}/${closes}`);
  ok('ics has no doubled timezone suffix', !lines.some((l) => /T\d{6}ZZ/.test(l)),
    lines.find((l) => /T\d{6}ZZ/.test(l)) ?? '');
  const timeRe = /^(DTSTART|DTEND|DTSTAMP|RECURRENCE-ID)(;VALUE=DATE)?:\d{8}(T\d{6}Z)?$/;
  const timeLines = lines.filter((l) => /^(DTSTART|DTEND|DTSTAMP|RECURRENCE-ID)[;:]/.test(l));
  ok('every ics time value is well formed', timeLines.length > 3 && timeLines.every((l) => timeRe.test(l)),
    timeLines.find((l) => !timeRe.test(l)) ?? '');
  const blocks: string[][] = [];
  let cur: string[] | null = null;
  for (const l of lines) {
    if (l === 'BEGIN:VEVENT') { cur = []; continue; }
    if (l === 'END:VEVENT') { if (cur) blocks.push(cur); cur = null; continue; }
    if (cur) cur.push(l);
  }
  ok('every vevent has UID, DTSTAMP, SUMMARY and DTSTART',
    blocks.length > 0 && blocks.every((b) => ['UID:', 'DTSTAMP:', 'SUMMARY:', 'DTSTART'].every((p) => b.some((l) => l.startsWith(p)))),
    JSON.stringify(blocks.find((b) => !b.some((l) => l.startsWith('DTSTART')))?.slice(0, 3) ?? ''));
  ok('ics uses CRLF line breaks', body.includes('\r\n') && !body.includes('\n\r'));
}
ok('bad subscription token 404', (await fetch(`${base}/ics/nope.ics`)).status === 404);

// ---- hostile content is data, not markup ----
const xss = await req('POST', `/api/calendars/${cid}/events`, {
  title: '<img src=x onerror=alert(1)>', note: 'javascript:alert(2)', start_at: D('2026-12-20T09:00:00Z'),
}, cb);
const echoed = (await req('GET', `/api/calendars/${cid}/events?from=${D('2026-12-15')}&to=${D('2027-01-01')}`, undefined, ca))
  .data.find((r: any) => r.id === xss.data.id);
ok('stored verbatim, no server-side markup injection', echoed.title === '<img src=x onerror=alert(1)>');
const ics2 = await (await fetch(`${base}${sub.data.path}`)).text();
ok('ics carries the raw title as summary text (escaping is the renderer job)', ics2.includes('SUMMARY:<img src=x onerror=alert(1)>'));

// ---- reminders reach the phone as VALARM ----
ok('ics carries a VALARM for the 30-minute reminder',
  body.includes('BEGIN:VALARM') && body.includes('TRIGGER:-PT30M') && body.includes('ACTION:DISPLAY'));
ok('VALARM sits inside a VEVENT, not after it',
  body.indexOf('BEGIN:VALARM') > body.indexOf('BEGIN:VEVENT') && body.indexOf('END:VALARM') < body.lastIndexOf('END:VEVENT'));

// ---- natural-language quick add ----
const qa = await req('POST', `/api/calendars/${cid}/quick-add`, { text: '明天 下午3點 看牙醫' }, ca);
ok('quick-add creates a confident parse', qa.status === 200 && !!qa.data.created, JSON.stringify(qa.data).slice(0, 200));
const qaList = await req('GET', `/api/calendars/${cid}/events?from=${Date.now() - 86400000}&to=${Date.now() + 8 * 86400000}`, undefined, ca);
ok('quick-add event is visible', qaList.data.some((r: any) => r.title === '看牙醫'));
const vague = await req('POST', `/api/calendars/${cid}/quick-add`, { text: '買牛奶' }, ca);
ok('vague input asks instead of creating', vague.status === 200 && vague.data.needs_confirmation === true && !vague.data.created,
  JSON.stringify(vague.data).slice(0, 200));
ok('vague input is not silently written', !(await req('GET', `/api/calendars/${cid}/events?from=${Date.now() - 86400000}&to=${Date.now() + 8 * 86400000}`, undefined, ca))
  .data.some((r: any) => r.title === '買牛奶'));
const confirmCreate = await req('POST', `/api/calendars/${cid}/quick-add`, { text: '買牛奶', confirm: true }, ca);
ok('confirm creates the assumed event', confirmCreate.status === 200 && !!confirmCreate.data.created);

// ---- security headers ----
const headRes = await fetch(`${base}/api/me`, { headers: { cookie: ca } });
ok('api sends nosniff', headRes.headers.get('x-content-type-options') === 'nosniff');
ok('api sends a CSP', /default-src 'self'/.test(headRes.headers.get('content-security-policy') ?? ''));
ok('api sends no-referrer', headRes.headers.get('referrer-policy') === 'no-referrer');
const idxHead = await fetch(`${base}/`);
ok('static ui sends the same headers', idxHead.headers.get('x-content-type-options') === 'nosniff'
  && idxHead.headers.get('x-frame-options') === 'DENY');

// ---- subscription management ----
const subsList = await req('GET', `/api/calendars/${cid}/subscriptions`, undefined, ca);
ok('subscription list shows the token and its expiry',
  Array.isArray(subsList.data) && subsList.data.some((s: any) => s.token === sub.data.token && s.expires_at > Date.now()),
  JSON.stringify(subsList.data).slice(0, 200));
ok('subscription defaults to a one-year window',
  subsList.data[0].expires_at - subsList.data[0].created_at >= 364 * 86400000);
ok('revoked token stops answering', (await (async () => {
  const r = await req('DELETE', `/api/subscriptions/${sub.data.token}`, undefined, ca);
  return r.status === 200 && (await fetch(`${base}${sub.data.path}`)).status === 404;
})()));

const expired = 'expiredtoken-for-test';
store.run('insert into subscriptions (token, calendar_id, created_by, created_at, expires_at) values (?,?,?,?,?)',
  expired, cid, String(me.data.id), Date.now() - 2000, Date.now() - 1000);
ok('expired token is rejected', (await fetch(`${base}/ics/${expired}.ics`)).status === 404);
ok('non-members cannot revoke a subscription', (await req('DELETE', `/api/subscriptions/${expired}`, undefined, ct)).status === 403);

// ---- login throttling ----
const brute = 'brute@example.com';
await req('POST', '/api/signup', { email: brute, name: 'B', password: 'password1' });
let throttled = 0;
for (let i = 0; i < 9; i++) {
  const r = await req('POST', '/api/login', { email: brute, password: 'wrong-one-' + i });
  if (r.status === 429) { throttled = i + 1; break; }
}
ok('repeated failures get throttled', throttled > 0 && throttled <= 9, `throttled at attempt ${throttled}`);
ok('throttled login does not leak whether the account exists',
  (await req('POST', '/api/login', { email: 'nosuch@example.com', password: 'x'.repeat(12) })).status === 401);

// ---- cross-site request blocked ----
ok('cross-origin mutation blocked', (await req('POST', `/api/calendars/${cid}/events`, { title: 'x', start_at: 1 }, ca, 'http://evil.example')).status === 403);

// ---- static ui ----
const idx = await fetch(`${base}/`);
ok('web ui served', idx.status === 200 && (await idx.text()).includes('<html'));

server.close();
store.db.close();
try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows can hold the WAL file briefly */ }
console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
