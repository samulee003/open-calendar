// End-to-end test of the agent surface: bearer agent tokens, the shared tool
// core, the CLI subprocess and the MCP stdio server — all against a real
// server on an ephemeral port. Run with: node scripts/test-agent.ts
import { makeServer } from '../src/server.ts';
import { freshStore } from '../src/db.ts';
import { Client, ApiError } from '../src/client.ts';
import * as T from '../src/agent-tools.ts';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
ok('getEvent carries updated_at for version checks', Number(detail.event.updated_at) > 0);

// ---- search, label filter, detail=full ----
const labels0 = (await T.listLabels(c, {})).items;
ok('list_labels wraps items', Array.isArray(labels0) && labels0.length === 3, JSON.stringify(labels0));
const workLabel = labels0.find((l: any) => l.name === '工作');
await T.updateEvent(c, { event_id: created.created, label_id: workLabel.id, note: '帶琴譜與松香' });

const byQ = await T.listEvents(c, { from: '2026-11-01', to: '2026-11-30', q: '松香' });
ok('list_events q matches a note', byQ.count === 1 && byQ.events[0].id === created.created, JSON.stringify(byQ));
const byQTitle = await T.listEvents(c, { from: '2026-11-01', to: '2026-11-30', q: '大提琴' });
ok('list_events q matches a title', byQTitle.events.some((e: any) => e.id === created.created));
const byLabel = await T.listEvents(c, { from: '2026-11-01', to: '2026-11-30', label_id: workLabel.id });
ok('list_events label_id filters', byLabel.count === 1 && byLabel.events[0].id === created.created, JSON.stringify(byLabel));

const fullList = await T.listEvents(c, { from: '2026-11-05', days: 1, detail: 'full' });
const fullEv = fullList.events.find((e: any) => e.id === created.created);
ok('detail=full carries note, reminders and label_id',
  fullEv?.note === '帶琴譜與松香' && fullEv.reminders.join() === '30' && fullEv.label_id === workLabel.id,
  JSON.stringify(fullEv));
const summaryList = await T.listEvents(c, { from: '2026-11-05', days: 1 });
const summaryEv = summaryList.events.find((e: any) => e.id === created.created);
ok('detail defaults to summary', summaryList.detail === 'summary' && summaryEv?.note === undefined && summaryEv.reminders === undefined);
let badLabelErr: any;
try { await T.listEvents(c, { from: '2026-11-01', days: 1, label_id: 'abc' }); } catch (e) { badLabelErr = e; }
ok('a non-numeric label_id is a typed error', badLabelErr?.code === 'bad_label_id' && badLabelErr?.field === 'label_id', String(badLabelErr));

const upd = await T.updateEvent(c, { event_id: created.created, title: '大提琴課(改)', location: '老師家' });
ok('updateEvent changes fields', upd.event.title === '大提琴課(改)' && upd.event.location === '老師家');
ok('updateEvent preserves reminders', JSON.stringify(upd.reminders) === '[30]', JSON.stringify(upd.reminders));

// ---- optimistic concurrency ----
await T.updateEvent(c, { event_id: created.created, location: '老師家 2F' });
let staleErr: any;
try {
  await T.updateEvent(c, { event_id: created.created, title: '不該蓋掉', expected_updated_at: upd.event.updated_at });
} catch (e) { staleErr = e; }
ok('a stale expected_updated_at is 409 stale_event',
  staleErr instanceof ApiError && staleErr.status === 409 && staleErr.code === 'stale_event' && !!staleErr.hint,
  String(staleErr));
const fresh = await T.getEvent(c, { event_id: created.created });
const guarded = await T.updateEvent(c, {
  event_id: created.created, title: '大提琴課(改)', expected_updated_at: fresh.event.updated_at,
});
ok('a fresh expected_updated_at passes', guarded.event.title === '大提琴課(改)' && guarded.event.location === '老師家 2F');

// The agent layer now sends only changed fields; a plain PUT must still keep reminders.
const rawPut = await fetch(base + `/api/events/${created.created}`, {
  method: 'PUT', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  body: JSON.stringify({ title: '只改標題' }),
});
const afterRaw = await T.getEvent(c, { event_id: created.created });
ok('PUT without reminders preserves them',
  rawPut.status === 200 && afterRaw.reminders.join() === '30', JSON.stringify(afterRaw.reminders));

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

const labels = (await T.listLabels(c, {})).items;
ok('list_labels works', labels.length === 3);

const di = await T.getDateInfo(c, { date: '2026-11-02' }) as any;
ok('get_date_info returns a Macau holiday', di.holiday?.name === '追思節' && di.holiday_known === true, JSON.stringify(di));
const di2 = await T.getDateInfo(c, { date: '2025-12-25' }) as any;
ok('get_date_info flags unknown coverage', di2.holiday_known === false && !!di2.note);

// ---- virtual members ----
const kid = await T.createVirtualMember(c, { name: '李悅', account_type: 'child' }) as any;
fatal('create_virtual_member', !!kid.id, JSON.stringify(kid));
ok('list_virtual_members', (await T.listVirtualMembers(c, {})).items.some((v) => v.id === kid.id && v.account_type === 'child'));

const withKid = await T.createEvent(c, {
  title: '李悅古琴班', start: '2026-11-06 18:00', end: '2026-11-06 19:00', virtual_attendees: [kid.id],
}) as any;
ok('event created with a virtual attendee', !!withKid.created);
const kidDetail = await T.getEvent(c, { event_id: withKid.created });
ok('getEvent names the tagged member', kidDetail.virtual_attendees.map((v: any) => v.name).join() === '李悅');

await T.updateVirtualMember(c, { virtual_id: kid.id, name: '李悅(姐)' });
ok('update_virtual_member', (await T.listVirtualMembers(c, {})).items.some((v) => v.id === kid.id && v.name === '李悅(姐)'));
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
const memos = (await T.listMemos(c, {})).items;
ok('memos listed pinned first', memos.length === 2 && memos[0].id === m2.id && Number(memos[0].pinned) === 1, JSON.stringify(memos));
ok('memo body kept', memos.find((m: any) => m.id === m1.id)?.body === '到月底');
await T.updateMemo(c, { memo_id: m1.id, body: '到 11 月底' });
ok('update_memo', (await T.listMemos(c, {})).items.find((m) => m.id === m1.id)?.body === '到 11 月底');
await T.deleteMemo(c, { memo_id: m1.id });
ok('delete_memo hides it', (await T.listMemos(c, {})).items.length === 1);

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

// ---- time-argument hardening ----
ok('10-digit epoch seconds are not read as milliseconds', T.parseWhen(1767225600, 'UTC') === 1767225600000);
ok('13-digit epoch milliseconds pass through', T.parseWhen(1900000000000, 'UTC') === 1900000000000);
let labelErr: any;
try { T.parseWhen('2026-01-05 (all-day)', 'Asia/Taipei'); } catch (e) { labelErr = e; }
ok('an all-day label is refused with a pointer to the epoch',
  labelErr?.code === 'bad_time' && /epoch/.test(String(labelErr?.hint)), String(labelErr));
const allDay = await T.createEvent(c, { title: '全天複刻', date: '2026-11-25', all_day: true }) as any;
const allDayCopy = await T.copyEvent(c, { event_id: allDay.created, shift_days: 7 }) as any;
ok('copying an all-day event lands on the right single day', allDayCopy.start === '2026-12-02 (all-day)', JSON.stringify(allDayCopy));
let ovErr = '';
try { await T.overrideOccurrence(c, { event_id: weekly.created, occurrence_start: '2026-11-14 09:00' }); }
catch (e) { ovErr = String((e as Error).message); }
ok('override refuses an occurrence that does not exist', /occurrence_not_found/.test(ovErr), ovErr);

// ---- idempotency ----
const idem1 = await T.createEvent(c, { title: '冪等測試', start: '2026-11-23 10:00', end: '2026-11-23 11:00', request_id: 'agent-retry-1' }) as any;
const idem2 = await T.createEvent(c, { title: '冪等測試', start: '2026-11-23 10:00', end: '2026-11-23 11:00', request_id: 'agent-retry-1' }) as any;
ok('same request_id returns the original event', idem1.created === idem2.created, JSON.stringify([idem1, idem2]));
const idemDay = await T.listEvents(c, { from: '2026-11-23', days: 1 });
ok('retry did not duplicate the event', idemDay.events.filter((e: any) => e.title === '冪等測試').length === 1);
const idemConflict = await fetch(base + `/api/calendars/${calId}/events`, {
  method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  body: JSON.stringify({ title: '不同內容', start_at: 1900000000000, request_id: 'agent-retry-1' }),
});
ok('same request_id with a different body is a 409', idemConflict.status === 409);

// ---- trash + restore ----
await T.deleteEvent(c, { event_id: idem1.created });
const trash = (await T.listTrash(c, { days: 365 })).items;
ok('trash lists the deleted event', trash.some((x) => x.id === idem1.created), JSON.stringify(trash.map((x) => x.id)));
const restored = await T.restoreEvent(c, { event_id: idem1.created }) as any;
ok('restore_event brings it back', restored.restored === true);
const back = await T.listEvents(c, { from: '2026-11-23', days: 1 });
ok('restored event is visible again', back.events.some((e: any) => e.id === idem1.created));
ok('restoring a visible event is a no-op', (await T.restoreEvent(c, { event_id: idem1.created }) as any).already_visible === true);

const occRestore = await T.restoreOccurrence(c, { event_id: weekly.created, occurrence_start: thu3.occurrence_start }) as any;
ok('restore_occurrence undoes a single deletion', occRestore.restored === true && occRestore.day === '2026-11-19', JSON.stringify(occRestore));
const occBack = await T.listEvents(c, { from: '2026-11-19', days: 1 });
ok('restored occurrence is visible again', occBack.events.some((e: any) => e.id === weekly.created && e.start.startsWith('2026-11-19')));

// ---- calendars, members and invites ----
const newCal = await T.createCalendar(c, { name: '祖父母' });
ok('create_calendar', /^cal_/.test(newCal.created) && newCal.calendar_id === newCal.created, JSON.stringify(newCal));
const memberList = await T.listMembers(c, { calendar_id: newCal.calendar_id });
ok('list_members shows the owner', memberList.items.length === 1 && memberList.items[0].role === 'owner', JSON.stringify(memberList));
const invite = await T.createInvite(c, { calendar_id: newCal.calendar_id });
ok('create_invite returns a code', /^[A-Z0-9]{10}$/.test(invite.code), JSON.stringify(invite));

const b = await req('POST', '/api/signup', { email: 'dad@example.com', name: '爸', password: 'supersecret2', tz: 'Asia/Taipei' });
fatal('second signup ok', b.status === 200 && !!b.cookie, JSON.stringify(b.data));
const session2 = b.cookie!.split('=')[1];
const c2 = new Client({ base, token: session2, tz: 'Asia/Taipei' });
const joined = await T.joinCalendar(c2, { code: invite.code.toLowerCase() });
ok('join_calendar accepts the code case-insensitively',
  joined.joined === true && joined.calendar_id === newCal.calendar_id, JSON.stringify(joined));
ok('the joiner sees the calendar as a member',
  (await T.listCalendars(c2)).items.some((x: any) => x.id === newCal.calendar_id && x.role === 'member'));
ok('list_members now shows both', (await T.listMembers(c, { calendar_id: newCal.calendar_id })).items.length === 2);
let inviteErr: any;
try { await T.createInvite(c2, { calendar_id: newCal.calendar_id }); } catch (e) { inviteErr = e; }
ok('only the owner can create invites',
  inviteErr instanceof ApiError && inviteErr.status === 403 && inviteErr.code === 'owner_only', String(inviteErr));
let badCodeErr: any;
try { await T.joinCalendar(c2, { code: 'ZZZZZZZZZZ' }); } catch (e) { badCodeErr = e; }
ok('an unknown invite code is typed',
  badCodeErr?.status === 404 && badCodeErr?.code === 'bad_invite' && !!badCodeErr?.hint, String(badCodeErr));

// ---- token scopes ----
const roTok = (await req('POST', '/api/agent-tokens', { name: 'read-only', scopes: ['read'] }, ca)).data.token;
const ro = new Client({ base, token: roTok, calendar: calId, tz: 'Asia/Taipei' });
ok('read token can list events', (await T.listEvents(ro, { from: '2026-11-01', days: 1 })).count >= 0);
let roErr: any;
try { await T.createEvent(ro, { title: '不該建立', start: '2026-11-24 10:00' }); } catch (e) { roErr = e; }
ok('read token cannot create', roErr instanceof ApiError && roErr.status === 403 && roErr.message === 'insufficient_scope', String(roErr));

const rwTok = (await req('POST', '/api/agent-tokens', { name: 'writer', scopes: ['read', 'write'] }, ca)).data.token;
const rw = new Client({ base, token: rwTok, calendar: calId, tz: 'Asia/Taipei' });
let rwErr: any;
try { await T.deleteEvent(rw, { event_id: withKid.created }); } catch (e) { rwErr = e; }
ok('read+write token cannot delete', rwErr instanceof ApiError && rwErr.status === 403, String(rwErr));
ok('scopes are listed', ((await req('GET', '/api/agent-tokens', undefined, ca)).data as any[])
  .some((t) => t.name === 'read-only' && t.scopes === 'read'));
ok('unknown scope is rejected', (await req('POST', '/api/agent-tokens', { name: 'bad', scopes: ['root'] }, ca)).status === 400);

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
ok('cli calendars', cliCal.code === 0 && JSON.parse(cliCal.out).items.some((x: any) => x.id === calId), cliCal.out.slice(0, 200));

const cliAdd = await run(['add', '--calendar', calId, '--title', 'CLI 事件', '--start', '2026-11-20 10:00', '--json']);
ok('cli add', cliAdd.code === 0 && JSON.parse(cliAdd.out).created, cliAdd.out.slice(0, 200));

const cliEv = await run(['events', '--calendar', calId, '--from', '2026-11-20', '--days', '1', '--json']);
ok('cli events sees it', cliEv.code === 0 && JSON.parse(cliEv.out).events.some((e: any) => e.title === 'CLI 事件'), cliEv.out.slice(0, 200));

const cliSearch = await run(['events', '--calendar', calId, '--from', '2026-11-20', '--days', '1', '--q', 'CLI', '--json']);
ok('cli events --q', cliSearch.code === 0 && JSON.parse(cliSearch.out).count === 1, cliSearch.out.slice(0, 200));

const cliCalNew = await run(['calendar', 'add', '--name', 'CLI 日曆', '--json']);
ok('cli calendar add', cliCalNew.code === 0 && /^cal_/.test(JSON.parse(cliCalNew.out).created), cliCalNew.out.slice(0, 200));

const cliHuman = await run(['events', '--calendar', calId, '--from', '2026-11-20', '--days', '1']);
ok('cli human output', cliHuman.code === 0 && cliHuman.out.includes('CLI 事件'), cliHuman.out.slice(0, 200));

const cliErr = await run(['show', 'evt_nope', '--json']);
ok('cli error exits 1 with json', cliErr.code === 1 && JSON.parse(cliErr.out).status === 404, cliErr.out.slice(0, 200));
ok('cli error carries a code and hint',
  JSON.parse(cliErr.out).error === 'no_such_event' && typeof JSON.parse(cliErr.out).hint === 'string');

const cliDate = await run(['dateinfo', '--date', '2026-11-02', '--json']);
ok('cli dateinfo', cliDate.code === 0 && JSON.parse(cliDate.out).holiday.name === '追思節', cliDate.out.slice(0, 200));

const cliQuick1 = await run(['quick', '--calendar', calId, '後天 上午9點 CLI冪等測試', '--request-id', 'k-cli-quick-1', '--json']);
const cliQuick2 = await run(['quick', '--calendar', calId, '後天 上午9點 CLI冪等測試', '--request-id', 'k-cli-quick-1', '--json']);
ok('cli quick --request-id replays the first result',
  cliQuick1.code === 0 && cliQuick2.code === 0 && !!JSON.parse(cliQuick1.out).created
    && JSON.parse(cliQuick1.out).created === JSON.parse(cliQuick2.out).created,
  cliQuick1.out.slice(0, 160) + ' | ' + cliQuick2.out.slice(0, 160));

const cliBatchPath = join(dir, 'cli-batch.json');
writeFileSync(cliBatchPath, JSON.stringify([{ title: 'CLI batch 冪等', start: '2026-11-21 10:00' }]));
const cliBatch1 = await run(['batch', '--calendar', calId, '--file', cliBatchPath, '--request-id', 'k-cli-batch-1', '--json']);
const cliBatch2 = await run(['batch', '--calendar', calId, '--file', cliBatchPath, '--request-id', 'k-cli-batch-1', '--json']);
ok('cli batch --request-id replays the first result',
  cliBatch1.code === 0 && cliBatch2.code === 0 && JSON.parse(cliBatch1.out).created === 1
    && JSON.stringify(JSON.parse(cliBatch1.out).ids) === JSON.stringify(JSON.parse(cliBatch2.out).ids),
  cliBatch1.out.slice(0, 160) + ' | ' + cliBatch2.out.slice(0, 160));

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
ok('mcp initialize explains the tool surface in instructions',
  typeof init.result?.instructions === 'string' && init.result.instructions.includes('list_trash'));
ok('mcp echoes the client protocol version', init.result?.protocolVersion === '2024-11-05');
notify('notifications/initialized');

const tools = await rpc('tools/list');
const names = (tools.result?.tools ?? []).map((t: any) => t.name);
const expected = ['list_calendars', 'create_calendar', 'list_members', 'create_invite', 'join_calendar',
  'list_events', 'get_event', 'create_event', 'create_events', 'quick_add',
  'update_event', 'delete_event', 'override_occurrence', 'find_free_slots', 'add_comment', 'list_labels',
  'create_subscription', 'copy_event', 'list_virtual_members', 'create_virtual_member', 'update_virtual_member',
  'delete_virtual_member', 'list_memos', 'create_memo', 'update_memo', 'delete_memo', 'get_date_info',
  'list_trash', 'restore_event', 'restore_occurrence', 'list_subscriptions', 'revoke_subscription', 'whoami'];
fatal('mcp advertises every tool', names.length === expected.length && expected.every((n) => names.includes(n)), JSON.stringify(names));
ok('mcp schemas are objects with descriptions', tools.result.tools.every((t: any) => t.inputSchema?.type === 'object' && typeof t.description === 'string'));
ok('mcp every tool declares an object output schema',
  tools.result.tools.every((t: any) => t.outputSchema?.type === 'object'));
const toolByName = new Map<string, any>(tools.result.tools.map((t: any) => [t.name, t]));
ok('mcp annotations separate reads from writes and deletes',
  toolByName.get('list_events').annotations?.readOnlyHint === true
  && toolByName.get('create_event').annotations?.readOnlyHint === false
  && toolByName.get('create_event').annotations?.destructiveHint === false
  && toolByName.get('delete_event').annotations?.destructiveHint === true
  && toolByName.get('restore_event').annotations?.idempotentHint === true);
ok('mcp list_events advertises q, label_id and detail',
  ['q', 'label_id', 'detail'].every((k) => !!toolByName.get('list_events').inputSchema.properties[k]));

const call = await rpc('tools/call', { name: 'create_event', arguments: { title: 'MCP 事件', start: '2026-11-21 09:00', end: '2026-11-21 10:00' } });
const callOut = JSON.parse(call.result?.content?.[0]?.text ?? '{}');
ok('mcp create_event uses default calendar', !call.result?.isError && !!callOut.created, JSON.stringify(call).slice(0, 300));
ok('mcp structuredContent mirrors the text payload',
  call.result?.structuredContent?.created === callOut.created, JSON.stringify(call.result?.structuredContent));

const calsCall = await rpc('tools/call', { name: 'list_calendars', arguments: {} });
const calsOut = JSON.parse(calsCall.result.content[0].text);
ok('mcp list_calendars wraps items',
  Array.isArray(calsOut.items) && calsOut.items.some((x: any) => x.id === calId)
  && calsCall.result.structuredContent?.items?.length === calsOut.items.length, JSON.stringify(calsOut).slice(0, 200));

const listCall = await rpc('tools/call', { name: 'list_events', arguments: { from: '2026-11-21', days: 1 } });
const listOut = JSON.parse(listCall.result?.content?.[0]?.text ?? '{}');
ok('mcp list_events sees it', listOut.events?.some((e: any) => e.title === 'MCP 事件'), JSON.stringify(listOut).slice(0, 300));

const fullCall = await rpc('tools/call', { name: 'list_events', arguments: { from: '2026-11-05', days: 1, q: '松香', detail: 'full' } });
const fullOut = JSON.parse(fullCall.result.content[0].text);
ok('mcp list_events q + detail=full', fullOut.count === 1 && fullOut.events[0].note === '帶琴譜與松香' && fullOut.events[0].reminders[0] === 30,
  JSON.stringify(fullOut).slice(0, 300));

const memoCall = await rpc('tools/call', { name: 'create_memo', arguments: { title: 'MCP 備忘', body: '給 agent 的' } });
ok('mcp create_memo', !memoCall.result?.isError && !!JSON.parse(memoCall.result.content[0].text).id, JSON.stringify(memoCall).slice(0, 200));
const memosCall = await rpc('tools/call', { name: 'list_memos', arguments: {} });
ok('mcp list_memos', JSON.parse(memosCall.result.content[0].text).items.some((m: any) => m.title === 'MCP 備忘'));
const vmsCall = await rpc('tools/call', { name: 'list_virtual_members', arguments: {} });
ok('mcp list_virtual_members', Array.isArray(JSON.parse(vmsCall.result.content[0].text).items));

const dateCall = await rpc('tools/call', { name: 'get_date_info', arguments: { date: '2027-02-06' } });
const dateOut = JSON.parse(dateCall.result.content[0].text);
ok('mcp get_date_info', dateOut.holiday?.name === '農曆正月初一', JSON.stringify(dateOut));

const trashCall = await rpc('tools/call', { name: 'list_trash', arguments: { days: 30 } });
ok('mcp list_trash', Array.isArray(JSON.parse(trashCall.result.content[0].text).items));

const whoCall = await rpc('tools/call', { name: 'whoami', arguments: {} });
ok('mcp whoami identifies the account', JSON.parse(whoCall.result.content[0].text).email === 'mom@example.com',
  JSON.stringify(whoCall).slice(0, 200));

const errCall = await rpc('tools/call', { name: 'get_event', arguments: { event_id: 'evt_nope' } });
ok('mcp tool error is isError not protocol error', errCall.result?.isError === true && JSON.parse(errCall.result.content[0].text).status === 404, JSON.stringify(errCall).slice(0, 300));
const errOut = JSON.parse(errCall.result.content[0].text);
ok('mcp error carries a stable code, message and hint',
  errOut.error === 'no_such_event' && typeof errOut.message === 'string' && typeof errOut.hint === 'string',
  JSON.stringify(errOut));
ok('mcp error mirrors structuredContent', errCall.result?.structuredContent?.error === 'no_such_event');

const unknown = await rpc('tools/call', { name: 'nope', arguments: {} });
ok('mcp unknown tool is protocol error', unknown.error?.code === -32602);

mcp.kill();

// ---- shutdown ----
await new Promise<void>((r) => server.close(() => r()));
store.db.close();
try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows can hold the WAL file briefly */ }
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
