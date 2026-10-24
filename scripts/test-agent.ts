// End-to-end test of the agent surface: bearer agent tokens, the shared tool
// core, the CLI subprocess and the MCP stdio server — all against a real
// server on an ephemeral port. Run with: node scripts/test-agent.ts
import { makeServer } from '../src/server.ts';
import { freshStore } from '../src/db.ts';
import { Client, ApiError } from '../src/client.ts';
import * as T from '../src/agent-tools.ts';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const dir = mkdtempSync(join(tmpdir(), 'scal-agent-'));
const store = freshStore(dir);
const server = makeServer(store);
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${(server.address() as any).port}`;

let pass = 0, fail = 0;
const ok = (label: string, cond: boolean, extra = '') => {
  if (cond) { pass++; console.log('ok   ' + label); }
  else { fail++; console.log(`FAIL ${label} ${extra}`); }
};
const fatal = (label: string, cond: boolean, extra = '') => {
  ok(label, cond, extra);
  if (!cond) { console.log('FATAL: cannot continue'); process.exit(1); }
};

async function req(method: string, path: string, body?: unknown, cookie?: string) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (cookie) headers.cookie = cookie;
  const res = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let data: any; try { data = JSON.parse(text); } catch { data = text; }
  const sc = res.headers.get('set-cookie');
  return { status: res.status, data, cookie: sc ? sc.split(';')[0] : null, text };
}

// ---- signup + agent token lifecycle ----
const a = await req('POST', '/api/signup', { email: 'mom@example.com', name: '媽', password: 'supersecret1', tz: 'Asia/Taipei' });
fatal('signup ok', a.status === 200 && !!a.cookie, JSON.stringify(a.data));
const ca = a.cookie!;
const calId = (await req('GET', '/api/calendars', undefined, ca)).data[0].id;

const tok = await req('POST', '/api/agent-tokens', { name: 'qoder-agent' }, ca);
fatal('agent token created', tok.status === 200 && tok.data.token?.startsWith('cal_'), JSON.stringify(tok.data));
const token = tok.data.token as string;

const list = await req('GET', '/api/agent-tokens', undefined, ca);
ok('token list is masked', list.data.length === 1 && !JSON.stringify(list.data).includes(token.slice(10)));
ok('token list carries name', list.data[0].name === 'qoder-agent');

const noAuth = await req('GET', '/api/me');
ok('no auth is 401', noAuth.status === 401);
const bad = await req('GET', '/api/me', undefined, undefined);
const badRes = await fetch(base + '/api/me', { headers: { authorization: 'Bearer cal_notatoken' } });
ok('bad bearer is 401', badRes.status === 401 && bad.status === 401);
const bearerMe = await fetch(base + '/api/me', { headers: { authorization: `Bearer ${token}` } });
ok('bearer token authenticates', bearerMe.status === 200);

// A leaked agent token must not be able to mint replacements or revoke siblings.
const mintAsAgent = await fetch(base + '/api/agent-tokens', {
  method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: '{}',
});
ok('agent token cannot mint tokens', mintAsAgent.status === 403);
const listAsAgent = await fetch(base + '/api/agent-tokens', { headers: { authorization: `Bearer ${token}` } });
ok('agent token cannot list tokens', listAsAgent.status === 403);
const revokeAsAgent = await fetch(base + '/api/agent-tokens/revoke', {
  method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  body: JSON.stringify({ token }),
});
ok('agent token cannot revoke tokens', revokeAsAgent.status === 403);

// ---- tool core over bearer ----
const c = new Client({ base, token, calendar: calId, tz: 'Asia/Taipei' });

const created = await T.createEvent(c, { title: '大提琴課', start: '2026-11-05 14:00', end: '2026-11-05 15:00', reminders: [30] });
fatal('createEvent with naive wall-clock time', !!created.created, JSON.stringify(created));
ok('createEvent echoes local label', created.start === '2026-11-05 14:00');

const weekly = await T.createEvent(c, { title: '古琴班', start: '2026-11-05 19:00', end: '2026-11-05 20:00', rrule: 'FREQ=WEEKLY;BYDAY=TH' });
ok('createEvent accepts rrule without prefix', !!weekly.created);

const listed = await T.listEvents(c, { from: '2026-11-01', to: '2026-11-30' });
ok('listEvents expands recurrence', listed.count >= 5 && listed.events.some((e: any) => e.title === '古琴班' && e.rrule), JSON.stringify(listed.count));
fatal('listEvents includes the single event', listed.events.some((e: any) => e.id === created.created));

const detail = await T.getEvent(c, { event_id: created.created });
ok('getEvent returns reminders', JSON.stringify(detail.reminders) === '[30]', JSON.stringify(detail));

const upd = await T.updateEvent(c, { event_id: created.created, title: '大提琴課(改)', location: '老師家' });
ok('updateEvent changes fields', upd.event.title === '大提琴課(改)' && upd.event.location === '老師家');
ok('updateEvent preserves reminders', JSON.stringify(upd.reminders) === '[30]', JSON.stringify(upd.reminders));

// quick add: high confidence creates, low confidence asks
const q1 = await T.quickAdd(c, { text: '明天下午3點看牙醫' }) as any;
ok('quick_add high confidence creates', !!q1.created, JSON.stringify(q1).slice(0, 200));
const q2 = await T.quickAdd(c, { text: '買牛奶' }) as any;
ok('quick_add low confidence asks', q2.needs_confirmation === true && !q2.created);

// occurrence-level ops on the weekly series
const thu2 = listed.events.find((e: any) => e.title === '古琴班' && e.start.startsWith('2026-11-12'));
fatal('found the 11/12 occurrence', !!thu2, JSON.stringify(listed.events.map((e: any) => e.start)));
await T.overrideOccurrence(c, { event_id: weekly.created, occurrence_start: thu2.occurrence_start, title: '古琴班(展延)' });
const afterOv = await T.listEvents(c, { from: '2026-11-12', to: '2026-11-13' });
ok('override renames one occurrence', afterOv.events.some((e: any) => e.title === '古琴班(展延)'), JSON.stringify(afterOv.events));

const thu3 = listed.events.find((e: any) => e.title === '古琴班' && e.start.startsWith('2026-11-19'));
const del = await T.deleteEvent(c, { event_id: weekly.created, scope: 'occurrence', occurrence_start: thu3.occurrence_start }) as any;
ok('delete occurrence returns day', del.scope === 'occurrence' && del.day === '2026-11-19', JSON.stringify(del));
const afterDel = await T.listEvents(c, { from: '2026-11-19', to: '2026-11-20' });
ok('deleted occurrence is gone', !afterDel.events.some((e: any) => e.title.startsWith('古琴班') && e.start.startsWith('2026-11-19')), JSON.stringify(afterDel.events));

// free slots around the 14:00–15:00 lesson
const free = await T.findFreeSlots(c, { date: '2026-11-05', duration_minutes: 60, window_start: '12:00', window_end: '18:00' }) as any;
ok('find_free_slots skips the busy hour', free.free.length === 2
  && free.free[0].start.endsWith('12:00') && free.free[0].end.endsWith('14:00')
  && free.free[1].start.endsWith('15:00') && free.free[1].end.endsWith('18:00'), JSON.stringify(free.free));

const cmt = await T.addComment(c, { event_id: created.created, body: '記得帶譜' }) as any;
ok('add_comment works', !!cmt.id);

const batch = await T.createEvents(c, { events: [
  { title: '甲', start: '2026-12-01 09:00' },
  { title: '乙', date: '2026-12-02', all_day: true },
  { title: '', start: '2026-12-03 09:00' },
] }) as any;
ok('create_events batch reports partial failure', batch.created === 2 && batch.failed.length === 1 && batch.failed[0].index === 2, JSON.stringify(batch));

const sub = await T.createSubscription(c, { days: 30 }) as any;
ok('create_subscription returns absolute url', sub.url.startsWith(base) && sub.url.endsWith('.ics'));
const ics = await fetch(sub.url);
ok('ICS reachable without any auth', ics.status === 200 && (await ics.text()).includes('BEGIN:VCALENDAR'));

const labels = await T.listLabels(c, {}) as any[];
ok('list_labels works', labels.length === 3);

// ---- virtual members ----
const kid = await T.createVirtualMember(c, { name: '李悅', account_type: 'child' }) as any;
fatal('create_virtual_member', !!kid.id, JSON.stringify(kid));
ok('list_virtual_members', (await T.listVirtualMembers(c, {}) as any[]).some((v) => v.id === kid.id && v.account_type === 'child'));

const withKid = await T.createEvent(c, {
  title: '李悅古琴班', start: '2026-11-06 18:00', end: '2026-11-06 19:00', virtual_attendees: [kid.id],
}) as any;
ok('event created with a virtual attendee', !!withKid.created);
const kidDetail = await T.getEvent(c, { event_id: withKid.created });
ok('getEvent names the tagged member', kidDetail.virtual_attendees.map((v: any) => v.name).join() === '李悅');

await T.updateVirtualMember(c, { virtual_id: kid.id, name: '李悅(姐)' });
ok('update_virtual_member', (await T.listVirtualMembers(c, {}) as any[]).some((v) => v.id === kid.id && v.name === '李悅(姐)'));
ok('update_event clears tags', (await T.updateEvent(c, { event_id: withKid.created, virtual_attendees: [] })).virtual_attendees.length === 0);
await T.updateEvent(c, { event_id: withKid.created, virtual_attendees: [kid.id] });

const otherCal = await req('POST', '/api/calendars', { name: '另一個' }, ca);
const foreign = await req('POST', `/api/calendars/${otherCal.data.id}/virtual-members`, { name: '外人' }, ca);
const badAttach = await fetch(base + `/api/calendars/${calId}/events`, {
  method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  body: JSON.stringify({ title: 'x', start_at: 1900000000000, virtual_attendees: [foreign.data.id] }),
});
ok('foreign virtual member is rejected', badAttach.status === 400);

await T.deleteVirtualMember(c, { virtual_id: kid.id });
ok('deleting a member clears event tags', (await T.getEvent(c, { event_id: withKid.created })).virtual_attendees.length === 0);

// ---- memos ----
const m1 = await T.createMemo(c, { title: '工人放假', body: '到月底' }) as any;
const m2 = await T.createMemo(c, { title: '置頂提醒', pinned: true }) as any;
const memos = await T.listMemos(c, {}) as any[];
ok('memos listed pinned first', memos.length === 2 && memos[0].id === m2.id && Number(memos[0].pinned) === 1, JSON.stringify(memos));
ok('memo body kept', memos.find((m: any) => m.id === m1.id)?.body === '到月底');
await T.updateMemo(c, { memo_id: m1.id, body: '到 11 月底' });
ok('update_memo', (await T.listMemos(c, {}) as any[]).find((m) => m.id === m1.id)?.body === '到 11 月底');
await T.deleteMemo(c, { memo_id: m1.id });
ok('delete_memo hides it', (await T.listMemos(c, {}) as any[]).length === 1);

// ---- copy_event ----
const copied = await T.copyEvent(c, { event_id: created.created, shift_days: 7 }) as any;
ok('copy_event shifts by days', !!copied.copied && copied.start.startsWith('2026-11-12'), JSON.stringify(copied));
const copiedDetail = await T.getEvent(c, { event_id: copied.copied });
ok('copy keeps duration and reminders',
  copiedDetail.event.end_at - copiedDetail.event.start_at === 3600000 && copiedDetail.reminders[0] === 30);
ok('copy does not carry recurrence by default', !copiedDetail.event.rrule);

const occCopy = await T.copyEvent(c, { event_id: weekly.created, occurrence_start: thu2.occurrence_start, start: '2026-11-13 09:00' }) as any;
const occCopyDetail = await T.getEvent(c, { event_id: occCopy.copied });
ok('copying an occurrence keeps its override', occCopyDetail.event.title === '古琴班(展延)' && !occCopyDetail.event.rrule, JSON.stringify(occCopyDetail.event));
const occCopyList = await T.listEvents(c, { from: '2026-11-13', days: 1 });
ok('copied occurrence lands at the new time', occCopyList.events.some((e: any) => e.id === occCopy.copied && e.start.endsWith('09:00')));

const seriesCopy = await T.copyEvent(c, { event_id: weekly.created, shift_days: 0, keep_recurrence: true }) as any;
ok('copy_event keep_recurrence', (await T.getEvent(c, { event_id: seriesCopy.copied })).event.rrule === 'RRULE:FREQ=WEEKLY;BYDAY=TH');

// ---- revocation actually revokes ----
const rev = await req('POST', '/api/agent-tokens/revoke', { token }, ca);
ok('revoke token', rev.status === 200 && rev.data.revoked === true);
ok('revoking an unknown token is 404', (await req('POST', '/api/agent-tokens/revoke', { token: 'cal_nope' }, ca)).status === 404);
let revoked401 = false;
try { await T.listCalendars(c); } catch (e) { revoked401 = e instanceof ApiError && e.status === 401; }
ok('revoked token is rejected', revoked401);
const tok2 = await req('POST', '/api/agent-tokens', { name: 'second' }, ca);
const token2 = tok2.data.token as string;

// ---- CLI subprocess ----
// HOME/USERPROFILE point at the temp dir so a real ~/.shared-calendar-agent.json
// on this machine can never leak into the test.
const childEnv = { ...process.env, HOME: dir, USERPROFILE: dir, CAL_BASE: base, CAL_TOKEN: token2 };
delete childEnv.CAL_CALENDAR; delete childEnv.CAL_TZ;

function run(args: string[]): Promise<{ code: number; out: string }> {
  return new Promise((res) => {
    const child = spawn(process.execPath, [join(ROOT, 'src', 'cli.ts'), ...args], {
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('close', (code) => res({ code: code ?? -1, out }));
  });
}

const cliCal = await run(['calendars', '--json']);
ok('cli calendars', cliCal.code === 0 && JSON.parse(cliCal.out).some((x: any) => x.id === calId), cliCal.out.slice(0, 200));

const cliAdd = await run(['add', '--calendar', calId, '--title', 'CLI 事件', '--start', '2026-11-20 10:00', '--json']);
ok('cli add', cliAdd.code === 0 && JSON.parse(cliAdd.out).created, cliAdd.out.slice(0, 200));

const cliEv = await run(['events', '--calendar', calId, '--from', '2026-11-20', '--days', '1', '--json']);
ok('cli events sees it', cliEv.code === 0 && JSON.parse(cliEv.out).events.some((e: any) => e.title === 'CLI 事件'), cliEv.out.slice(0, 200));

const cliHuman = await run(['events', '--calendar', calId, '--from', '2026-11-20', '--days', '1']);
ok('cli human output', cliHuman.code === 0 && cliHuman.out.includes('CLI 事件'), cliHuman.out.slice(0, 200));

const cliErr = await run(['show', 'evt_nope', '--json']);
ok('cli error exits 1 with json', cliErr.code === 1 && JSON.parse(cliErr.out).status === 404, cliErr.out.slice(0, 200));

// ---- MCP stdio subprocess ----
const mcp = spawn(process.execPath, [join(ROOT, 'src', 'mcp.ts'), '--base', base, '--token', token2, '--calendar', calId], {
  env: { ...childEnv, CAL_BASE: base, CAL_TOKEN: token2 },
  stdio: ['pipe', 'pipe', 'pipe'],
});
const pending = new Map<number, (v: any) => void>();
let buf = '';
let nextId = 1;
mcp.stdout.setEncoding('utf8');
mcp.stdout.on('data', (chunk: string) => {
  buf += chunk;
  let nl: number;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    if (msg.id !== undefined && pending.has(msg.id)) { pending.get(msg.id)!(msg); pending.delete(msg.id); }
  }
});
function rpc(method: string, params?: any): Promise<any> {
  const id = nextId++;
  return new Promise((res, rej) => {
    const timer = setTimeout(() => rej(new Error(`mcp timeout: ${method}`)), 10000);
    pending.set(id, (v) => { clearTimeout(timer); res(v); });
    mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}
function notify(method: string) { mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', method }) + '\n'); }

const init = await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
ok('mcp initialize', init.result?.serverInfo?.name === 'shared-calendar' && init.result?.capabilities?.tools !== undefined, JSON.stringify(init).slice(0, 200));
notify('notifications/initialized');

const tools = await rpc('tools/list');
const names = (tools.result?.tools ?? []).map((t: any) => t.name);
const expected = ['list_calendars', 'list_events', 'get_event', 'create_event', 'create_events', 'quick_add',
  'update_event', 'delete_event', 'override_occurrence', 'find_free_slots', 'add_comment', 'list_labels',
  'create_subscription', 'copy_event', 'list_virtual_members', 'create_virtual_member', 'update_virtual_member',
  'delete_virtual_member', 'list_memos', 'create_memo', 'update_memo', 'delete_memo'];
fatal('mcp advertises every tool', names.length === expected.length && expected.every((n) => names.includes(n)), JSON.stringify(names));
ok('mcp schemas are objects with descriptions', tools.result.tools.every((t: any) => t.inputSchema?.type === 'object' && typeof t.description === 'string'));

const call = await rpc('tools/call', { name: 'create_event', arguments: { title: 'MCP 事件', start: '2026-11-21 09:00', end: '2026-11-21 10:00' } });
const callOut = JSON.parse(call.result?.content?.[0]?.text ?? '{}');
ok('mcp create_event uses default calendar', !call.result?.isError && !!callOut.created, JSON.stringify(call).slice(0, 300));

const listCall = await rpc('tools/call', { name: 'list_events', arguments: { from: '2026-11-21', days: 1 } });
const listOut = JSON.parse(listCall.result?.content?.[0]?.text ?? '{}');
ok('mcp list_events sees it', listOut.events?.some((e: any) => e.title === 'MCP 事件'), JSON.stringify(listOut).slice(0, 300));

const memoCall = await rpc('tools/call', { name: 'create_memo', arguments: { title: 'MCP 備忘', body: '給 agent 的' } });
ok('mcp create_memo', !memoCall.result?.isError && !!JSON.parse(memoCall.result.content[0].text).id, JSON.stringify(memoCall).slice(0, 200));
const memosCall = await rpc('tools/call', { name: 'list_memos', arguments: {} });
ok('mcp list_memos', JSON.parse(memosCall.result.content[0].text).some((m: any) => m.title === 'MCP 備忘'));
const vmsCall = await rpc('tools/call', { name: 'list_virtual_members', arguments: {} });
ok('mcp list_virtual_members', Array.isArray(JSON.parse(vmsCall.result.content[0].text)));

const errCall = await rpc('tools/call', { name: 'get_event', arguments: { event_id: 'evt_nope' } });
ok('mcp tool error is isError not protocol error', errCall.result?.isError === true && JSON.parse(errCall.result.content[0].text).status === 404, JSON.stringify(errCall).slice(0, 300));

const unknown = await rpc('tools/call', { name: 'nope', arguments: {} });
ok('mcp unknown tool is protocol error', unknown.error?.code === -32602);

mcp.kill();

// ---- shutdown ----
await new Promise<void>((r) => server.close(() => r()));
store.db.close();
try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows can hold the WAL file briefly */ }
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
