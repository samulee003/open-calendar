const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
const WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日'];
const REPEAT_LABEL = { 每週: 'WEEKLY', 每兩週: 'BIWEEKLY', 每月: 'MONTHLY', 每年: 'YEARLY' };

// All rendering goes through textContent; nothing from the server is ever
// inserted as markup. Titles and notes are written by other family members.
function el(tag, props = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined) n.setAttribute(k, v);
  }
  for (const kid of kids.flat()) if (kid) n.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return n;
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method ?? 'GET',
    headers: opts.body ? { 'content-type': 'application/json' } : undefined,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  if (!res.ok) throw new Error(data?.error ?? res.statusText);
  return data;
}

const dayKeyFmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
// All-day events are stored at UTC midnight of their calendar day; timed events
// are bucketed by the day the viewer actually sees them in.
const dayKey = (r) => r.all_day
  ? new Date(r.start_at).toISOString().slice(0, 10)
  : dayKeyFmt.format(new Date(r.start_at));
const hhmm = (ms) => new Intl.DateTimeFormat('zh-TW', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(ms));

const state = { me: null, calendars: [], activeCal: null, labels: [], events: [], byDay: new Map(), y: 0, m: 0, sel: null, labelFilter: null, editing: null };

// ---------- auth ----------
function showAuth(msg = '') {
  $('#auth').classList.remove('hidden');
  $('#app').classList.add('hidden');
  $('#auth-msg').textContent = msg;
}

let authMode = 'login';
$$('#auth-form .tabs button').forEach((b) => b.addEventListener('click', () => {
  authMode = b.dataset.mode;
  $$('#auth-form .tabs button').forEach((x) => x.classList.toggle('active', x === b));
  $('.only-signup').classList.toggle('hidden', authMode !== 'signup');
}));

$('#auth-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  const body = { email: f.get('email'), password: f.get('password'), tz: TZ };
  if (authMode === 'signup') body.name = f.get('name') || '我';
  try {
    await api('/api/' + authMode, { method: 'POST', body });
    await boot();
  } catch (err) {
    const map = { bad_email: 'Email 格式不对', name_required: '请填写姓名', password_too_short: '密码至少 8 码', email_taken: '这个 Email 已注册过', bad_credentials: 'Email 或密码不对' };
    showAuth(map[err.message] ?? err.message);
  }
});

$('#logout').addEventListener('click', async () => {
  try { await api('/api/logout', { method: 'POST' }); } catch { /* session already gone */ }
  location.reload();
});

// ---------- data ----------
async function boot() {
  state.me = await api('/api/me');
  $('#auth').classList.add('hidden');
  $('#app').classList.remove('hidden');
  const now = new Date();
  state.y = now.getFullYear(); state.m = now.getMonth();
  await loadCalendars();
  await renderMonth();
}

async function loadCalendars() {
  state.calendars = await api('/api/calendars');
  if (!state.calendars.length) {
    await api('/api/calendars', { method: 'POST', body: { name: '我的日曆' } });
    state.calendars = await api('/api/calendars');
  }
  if (!state.activeCal || !state.calendars.some((c) => c.id === state.activeCal)) state.activeCal = state.calendars[0].id;
  state.labels = await api(`/api/calendars/${state.activeCal}/labels`);
  drawSidebar();
  fillSelects();
}

async function loadEvents() {
  const { firstCell, cells } = gridDays();
  const from = firstCell.getTime();
  const to = cells[cells.length - 1].getTime() + 86400000;
  const rows = await api(`/api/events?from=${from}&to=${to}`);
  state.events = state.labelFilter ? rows.filter((r) => r.label_id === state.labelFilter) : rows;
  state.byDay = new Map();
  for (const r of state.events) {
    const k = dayKey(r);
    if (!state.byDay.has(k)) state.byDay.set(k, []);
    state.byDay.get(k).push(r);
  }
}

function gridDays() {
  const first = new Date(state.y, state.m, 1);
  const shift = (first.getDay() + 6) % 7; // Monday-first
  const start = new Date(state.y, state.m, 1 - shift);
  const cells = Array.from({ length: 42 }, (_, i) => new Date(start.getFullYear(), start.getMonth(), start.getDate() + i));
  return { firstCell: start, cells };
}

const keyOf = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const monthLabel = () => `${state.y} 年 ${state.m + 1} 月`;

// ---------- rendering ----------
function drawSidebar() {
  const list = $('#cal-list'); list.textContent = '';
  for (const c of state.calendars) {
    list.append(el('li', {
      class: c.id === state.activeCal ? 'on' : '',
      onclick: () => { state.activeCal = c.id; state.labelFilter = null; loadCalendars().then(renderMonth); },
    }, el('span', { class: 'dot', style: `background:${c.color}` }), c.name,
      el('span', { style: 'margin-left:auto;font-size:11px;color:#8b93a6', text: `${c.member_count} 人` })));
  }
  const ll = $('#label-list'); ll.textContent = '';
  ll.append(el('li', { class: state.labelFilter === null ? 'on' : '', onclick: () => { state.labelFilter = null; renderMonth(); } }, '全部'));
  for (const l of state.labels) {
    ll.append(el('li', {
      class: state.labelFilter === l.id ? 'on' : '',
      onclick: () => { state.labelFilter = state.labelFilter === l.id ? null : Number(l.id); renderMonth(); },
    }, el('span', { class: 'dot', style: `background:${l.color}` }), l.name));
  }
}

async function renderMonth() {
  $('#month-label').textContent = monthLabel();
  const wd = $('#weekdays'); wd.textContent = '';
  for (const w of WEEKDAYS) wd.append(el('div', { text: w }));
  await loadEvents();
  const todayKey = keyOf(new Date());
  const grid = $('#grid'); grid.textContent = '';
  const { cells } = gridDays();
  for (const d of cells) {
    const k = keyOf(d);
    const items = state.byDay.get(k) ?? [];
    const cell = el('div', { class: `cell${d.getMonth() !== state.m ? ' out' : ''}${k === todayKey ? ' today' : ''}`, onclick: () => openDay(k, d) },
      el('span', { class: 'd', text: String(d.getDate()) }));
    for (const it of items.slice(0, 3)) {
      cell.append(el('div', {
        class: 'chip',
        style: `background:${it.label_color ?? (state.calendars.find((c) => c.id === it.calendar_id)?.color ?? '#4a90d9')}`,
        title: it.title,
        text: it.all_day ? it.title : `${hhmm(it.start_at)} ${it.title}`,
      }));
    }
    if (items.length > 3) cell.append(el('div', { class: 'more', text: `還有 ${items.length - 3} 筆` }));
    grid.append(cell);
  }
  if (state.sel) openDay(state.sel.key, state.sel.date);
}

function timeText(r) {
  if (r.all_day) return '全天';
  const a = `${hhmm(r.start_at)}–${hhmm(r.end_at)}`;
  return r.recurring ? `${a}・${r.ruleText ?? '重複'}` : a;
}

function eventCard(r) {
  const box = el('div', { class: 'item' },
    el('b', { text: r.title }),
    el('div', { class: 'when', text: timeText(r) }),
    r.location ? el('div', { class: 'when', text: `地點：${r.location}` }) : null,
    r.note ? el('div', { class: 'note', text: r.note }) : null,
    r.comment_count ? el('div', { class: 'when', text: `${r.comment_count} 則留言` }) : null,
    el('div', { class: 'reacts' }, el('button', { onclick: () => openDetail(r), text: '留言／按讚' })),
  );
  return box;
}

async function openDay(key, date) {
  state.sel = { key, date };
  $('#panel-title').textContent = `${date.getMonth() + 1} 月 ${date.getDate()} 日（${WEEKDAYS[(date.getDay() + 6) % 7]}）`;
  const body = $('#panel-body'); body.textContent = '';
  const items = (state.byDay.get(key) ?? []).slice().sort((a, b) => (a.all_day ? -1 : a.start_at) - (b.all_day ? -1 : b.start_at));
  if (!items.length) body.append(el('p', { class: 'empty', text: '这一天还没有行程' }));
  for (const r of items) body.append(eventCard(r));
  body.append(el('button', { class: 'primary', onclick: () => openAdd(key), text: '新增到此日' }));
  $('#panel').classList.remove('hidden');
}

$('#panel-close').addEventListener('click', () => { $('#panel').classList.add('hidden'); state.sel = null; });

// ---------- add / edit ----------
function rruleFrom(repeat, dateStr) {
  if (!repeat) return null;
  const [y, mo, d] = dateStr.split('-').map(Number);
  const code = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'][new Date(y, mo - 1, d).getDay()];
  if (repeat === 'BIWEEKLY') return `RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=${code}`;
  if (repeat === 'WEEKLY') return `RRULE:FREQ=WEEKLY;BYDAY=${code}`;
  if (repeat === 'MONTHLY') return `RRULE:FREQ=MONTHLY;BYMONTHDAY=${d}`;
  if (repeat === 'YEARLY') return 'RRULE:FREQ=YEARLY';
  return 'RRULE:FREQ=DAILY';
}

function openAdd(key) {
  state.editing = null;
  const f = $('#add-form');
  f.reset();
  f.elements.date.value = key;
  $('#dlg-add').showModal();
}

$('#open-add').addEventListener('click', () => openAdd(keyOf(new Date())));
$('#add-cancel').addEventListener('click', () => $('#dlg-add').close());

$('#add-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  const allDay = f.get('all_day') === 'on';
  const date = f.get('date');
  const [y, mo, d] = date.split('-').map(Number);
  const t = (v, dh, dm) => { const [hh, mm] = (v || `${dh}:${dm}`).split(':').map(Number); return hh * 60 + mm; };
  const startMin = t(f.get('start'), 9, 0);
  const endMin = t(f.get('end'), 10, 0);
  const body = {
    title: f.get('title'),
    all_day: allDay,
    start_at: allDay ? Date.UTC(y, mo - 1, d) : new Date(y, mo - 1, d, Math.floor(startMin / 60), startMin % 60).getTime(),
    end_at: allDay ? Date.UTC(y, mo - 1, d) + 86400000 : new Date(y, mo - 1, d, Math.floor(endMin / 60), endMin % 60).getTime(),
    note: f.get('note') || '',
    location: f.get('location') || '',
    label_id: f.get('label_id') ? Number(f.get('label_id')) : null,
    rrule: rruleFrom(f.get('repeat'), date),
    reminders: f.get('reminder') ? [Number(f.get('reminder'))] : [],
  };
  try {
    if (state.editing) await api(`/api/events/${state.editing}`, { method: 'PUT', body });
    else await api(`/api/calendars/${state.activeCal}/events`, { method: 'POST', body });
    $('#dlg-add').close();
    await renderMonth();
  } catch (err) { alert(`保存失敗：${err.message}`); }
});

// ---------- detail: comments + reactions + delete ----------
async function openDetail(r) {
  const d = await api(`/api/events/${r.id}`);
  const body = $('#panel-body'); body.textContent = '';
  body.append(el('button', { onclick: () => openDay(state.sel.key, state.sel.date), text: '‹ 返回这一天' }));
  body.append(el('div', { class: 'item' },
    el('b', { text: r.title }),
    el('div', { class: 'when', text: timeText(r) }),
    r.note ? el('div', { class: 'note', text: r.note }) : null,
  ));

  const reacts = el('div', { class: 'reacts' });
  for (const emoji of ['👍', '❤️', '🎉', '😂']) {
    const cur = d.reactions.find((x) => x.emoji === emoji);
    reacts.append(el('button', {
      class: cur?.mine ? 'on' : '',
      onclick: async () => { await api(`/api/events/${r.id}/reaction`, { method: 'PUT', body: { emoji } }); openDetail(r); },
      text: cur ? `${emoji} ${cur.count}` : emoji,
    }));
  }
  body.append(reacts);

  const cmts = el('div', { class: 'cmts' });
  if (!d.comments.length) cmts.append(el('p', { class: 'empty', text: '还没有留言' }));
  for (const c of d.comments) {
    const row = el('div', { class: 'cmt' }, el('span', { text: c.name }), '：', c.body);
    if (String(c.user_id) === String(state.me.id)) row.append(el('button', {
      class: 'icon', style: 'margin-left:6px', text: '×',
      onclick: async () => { await api(`/api/comments/${c.id}`, { method: 'DELETE' }); openDetail(r); },
    }));
    cmts.append(row);
  }
  const input = el('textarea', { rows: '2', placeholder: '留言给一起看这个日历的人' });
  cmts.append(input, el('button', {
    class: 'primary', style: 'margin-top:6px', text: '发送',
    onclick: async () => { const v = input.value.trim(); if (!v) return; await api(`/api/events/${r.id}/comments`, { method: 'POST', body: { body: v } }); openDetail(r); },
  }));
  body.append(cmts);

  const ops = el('div', { class: 'actions' });
  ops.append(el('button', { text: '编辑（整个系列）', onclick: () => { editPrefill(r); } }));
  if (r.recurring) {
    ops.append(el('button', { class: 'danger', text: '删掉这一次', onclick: () => del(r, 'occurrence') }));
    ops.append(el('button', { class: 'danger', text: '删掉这次以后', onclick: () => del(r, 'future') }));
  }
  ops.append(el('button', { class: 'danger', text: r.recurring ? '删掉整个系列' : '删除', onclick: () => del(r, 'all') }));
  body.append(ops);
}

function editPrefill(r) {
  state.editing = r.id;
  const f = $('#add-form'); f.reset();
  const d = new Date(r.start_at);
  f.elements.title.value = r.title;
  f.elements.all_day.checked = !!r.all_day;
  f.elements.date.value = r.all_day ? new Date(r.start_at).toISOString().slice(0, 10) : keyOf(d);
  if (!r.all_day) { f.elements.start.value = hhmm(r.start_at); f.elements.end.value = hhmm(r.end_at); }
  f.elements.note.value = r.note;
  f.elements.location.value = r.location;
  $('#dlg-add').showModal();
}

async function del(r, scope) {
  const need = scope !== 'all';
  if (need && !confirm(scope === 'occurrence' ? '只删掉这一次？' : '从这个日期以后的全系列都会删掉，确定吗？')) return;
  if (!need && !confirm('确定要删除吗？')) return;
  const q = new URLSearchParams({ scope });
  if (need) q.set('occ', String(r.occurrence_start));
  await api(`/api/events/${r.id}?${q}`, { method: 'DELETE' });
  $('#panel').classList.add('hidden');
  await renderMonth();
}

// ---------- batch ----------
function parseLine(line) {
  const tk = line.trim().split(/\s+/);
  const date = tk.shift();
  if (!/^\d{4}-\d{1,2}-\d{1,2}$/.test(date)) return { error: `日期格式应为 YYYY-MM-DD：「${date}」` };
  let allDay = false;
  if (/^(全天|all-day|all)$/i.test(tk[0] ?? '')) { allDay = true; tk.shift(); }
  let sMin = 19 * 60, eMin = 20 * 60;
  const range = /^(\d{1,2}):(\d{2})(?:-~?(\d{1,2}):(\d{2}))?$/.exec(tk[0] ?? '');
  if (range) {
    sMin = +range[1] * 60 + +range[2];
    eMin = range[3] !== undefined ? +range[3] * 60 + +range[4] : sMin + 60;
    if (eMin <= sMin) eMin += 1440;
    tk.shift();
  }
  let repeat = null;
  const last = tk[tk.length - 1];
  if (last && REPEAT_LABEL[last]) { repeat = REPEAT_LABEL[last]; tk.pop(); }
  const title = tk.join(' ').trim();
  if (!title) return { error: '这一行没有标题' };
  const [y, mo, d] = date.split('-').map(Number);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return { error: `日期超出范围：${date}` };
  const start_at = allDay ? Date.UTC(y, mo - 1, d) : new Date(y, mo - 1, d, Math.floor(sMin / 60), sMin % 60).getTime();
  const end_at = allDay ? start_at + 86400000 : new Date(y, mo - 1, d, Math.floor(eMin % 1440 / 60), eMin % 60).getTime();
  return { event: { title, all_day: allDay, start_at, end_at, rrule: repeat ? rruleFrom(repeat, date) : null } };
}

function batchRows() {
  const lines = $('#batch-text').value.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  const events = [], errors = [];
  lines.forEach((line, i) => {
    const r = parseLine(line);
    if (r.error) errors.push(`第 ${i + 1} 行：${r.error}`); else events.push(r.event);
  });
  return { events, errors };
}

function batchPreview() {
  const { events, errors } = batchRows();
  const p = $('#batch-preview'); p.textContent = '';
  p.append(`${events.length} 笔可导入` + (errors.length ? `，${errors.length} 行有问题` : ''));
  if (events.length) {
    const preview = new Intl.DateTimeFormat('zh-TW', { timeZone: TZ, month: 'numeric', day: 'numeric', weekday: 'short' });
    p.append(el('div', { class: 'hint', text: events.slice(0, 4).map((e) => `${e.all_day ? '全天 ' : hhmm(e.start_at) + ' '}${e.title}（${preview.format(new Date(e.start_at))}）`).join('　') }));
  }
  for (const e of errors.slice(0, 8)) p.append(el('div', { class: 'hint', style: 'color:var(--warn)', text: e }));
  return { events, errors };
}

$('#open-batch').addEventListener('click', () => { $('#batch-preview').textContent = ''; $('#dlg-batch').showModal(); });
$('#batch-cancel').addEventListener('click', () => $('#dlg-batch').close());
$('#batch-preview-btn').addEventListener('click', batchPreview);
$('#batch-run').addEventListener('click', async () => {
  const { events, errors } = batchPreview();
  if (!events.length) return;
  if (errors.length && !confirm(`有 ${errors.length} 行会被跳过，其余 ${events.length} 笔继续导入？`)) return;
  const cal = $('#batch-cal').value || state.activeCal;
  const out = await api(`/api/calendars/${cal}/events/batch`, { method: 'POST', body: { events } });
  $('#batch-preview').textContent = `已导入 ${out.created} 笔` + (out.failed.length ? `，失败 ${out.failed.length} 笔` : '');
  await renderMonth();
});

// ---------- calendars / invite / subscribe ----------
function fillSelects() {
  for (const sel of ['#batch-cal', '#invite-cal', '#sub-cal', 'select[name="label_id"]']) {
    const node = $(sel); if (!node) continue;
    node.textContent = '';
    if (sel.includes('label_id')) {
      node.append(el('option', { value: '', text: '（无标签）' }));
      for (const l of state.labels) node.append(el('option', { value: String(l.id), text: l.name }));
    } else {
      for (const c of state.calendars) node.append(el('option', { value: c.id, text: c.name }));
    }
  }
}

$('#prev').addEventListener('click', () => { state.m--; if (state.m < 0) { state.m = 11; state.y--; } renderMonth(); });
$('#next').addEventListener('click', () => { state.m++; if (state.m > 11) { state.m = 0; state.y++; } renderMonth(); });
$('#today').addEventListener('click', () => { const n = new Date(); state.y = n.getFullYear(); state.m = n.getMonth(); state.sel = null; renderMonth(); });

$('#open-cal').addEventListener('click', () => $('#dlg-cal').showModal());
$('#cal-close').addEventListener('click', () => $('#dlg-cal').close());
$('#create-cal').addEventListener('click', async () => {
  const name = $('#new-cal-name').value.trim();
  if (!name) return;
  const out = await api('/api/calendars', { method: 'POST', body: { name } });
  state.activeCal = out.id; $('#new-cal-name').value = '';
  await loadCalendars(); await renderMonth();
});
$('#gen-invite').addEventListener('click', async () => {
  try {
    const out = await api(`/api/calendars/${$('#invite-cal').value}/invite`, { method: 'POST', body: {} });
    $('#invite-code').textContent = out.code;
  } catch (e) { $('#invite-code').textContent = e.message === 'owner_only' ? '只有这个日曆的擁有者能產生邀請碼' : e.message; }
});
$('#join').addEventListener('click', async () => {
  const code = $('#join-code').value.trim().toUpperCase();
  if (!code) return;
  try { const out = await api('/api/join', { method: 'POST', body: { code } }); state.activeCal = out.calendar_id; $('#join-code').value = ''; await loadCalendars(); await renderMonth(); }
  catch (e) { alert(e.message === 'bad_invite' ? '邀请码不对或已被使用' : e.message); }
});

function subStatus(s) {
  const fmt = (ms) => new Date(ms).toLocaleDateString('zh-TW');
  if (s.revoked_at) return '已撤銷';
  if (s.expires_at && s.expires_at < Date.now()) return '已過期';
  const base = s.expires_at ? `到 ${fmt(s.expires_at)} 失效` : '永久有效';
  return s.last_used_at ? `${base}・上次讀取 ${fmt(s.last_used_at)}` : base;
}

async function loadSubs(calId) {
  const list = $('#sub-list');
  if (!list) return;
  list.textContent = '';
  let rows = [];
  try { rows = await api(`/api/calendars/${calId}/subscriptions`); } catch { rows = []; }
  if (!rows.length) {
    list.append(el('li', { class: 'hint', text: '还没有订阅链接' }));
    return;
  }
  for (const s of rows) {
    const dead = s.revoked_at || (s.expires_at && s.expires_at < Date.now());
    const li = el('li', {},
      el('code', { text: `/ics/${s.token}.ics` }),
      el('div', { class: 'hint', text: subStatus(s) }),
    );
    if (!dead) {
      li.append(el('button', {
        class: 'danger', text: '撤銷',
        onclick: async () => {
          if (!confirm('撤銷後這條連結立刻失效，手機要重新訂閱。確定？')) return;
          await api(`/api/subscriptions/${s.token}`, { method: 'DELETE' });
          loadSubs(calId);
        },
      }));
    }
    list.append(li);
  }
}

$('#open-sub').addEventListener('click', () => {
  $('#dlg-sub').showModal();
  $('#sub-url').value = '';
  loadSubs($('#sub-cal').value);
});
$('#sub-close').addEventListener('click', () => $('#dlg-sub').close());
$('#sub-cal').addEventListener('change', () => loadSubs($('#sub-cal').value));
$('#sub-make').addEventListener('click', async () => {
  const out = await api(`/api/calendars/${$('#sub-cal').value}/subscription`, { method: 'POST', body: {} });
  $('#sub-url').value = `${location.origin}${out.path}`;
  $('#sub-url').select();
  loadSubs($('#sub-cal').value);
});

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => { /* shell cache is optional */ });
}

// ---------- go ----------
try { await boot(); } catch { showAuth(); }
