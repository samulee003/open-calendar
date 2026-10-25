// MCP (Model Context Protocol) stdio server exposing the calendar to any
// MCP-capable AI agent. Zero dependencies; newline-delimited JSON-RPC 2.0.
//
//   node src/mcp.ts [--base URL] [--token cal_…] [--calendar cal_…]
// or via env: CAL_BASE / CAL_TOKEN / CAL_CALENDAR / CAL_TZ
//
// stdout carries protocol messages only; nothing else may write to it.
import { Client, loadConfig } from './client.ts';
import * as T from './agent-tools.ts';

const SERVER_INFO = { name: 'shared-calendar', version: '0.1.0' };
const PROTOCOL_VERSION = '2024-11-05';

const s = (description: string, extra: Record<string, any> = {}) => ({ type: 'string', description, ...extra });
const n = (description: string) => ({ type: 'number', description });
const b = (description: string) => ({ type: 'boolean', description });
const obj = (properties: Record<string, any>, required: string[] = []) =>
  ({ type: 'object', properties, required, additionalProperties: false });

const TIME_HINT = 'epoch ms, ISO 8601, "YYYY-MM-DD" or "YYYY-MM-DD HH:MM" (naive values read as wall-clock in tz)';
const CAL_HINT = 'defaults to the configured default calendar';

const TOOLS: { name: string; description: string; inputSchema: any; run: (c: Client, a: any) => Promise<unknown> }[] = [
  {
    name: 'list_calendars',
    description: 'List calendars the authenticated user belongs to, with role and member count.',
    inputSchema: obj({}),
    run: (c) => T.listCalendars(c),
  },
  {
    name: 'list_events',
    description: 'List event occurrences in a time range (default: next 31 days), expanded with recurrence and overrides applied. Times are local labels plus epoch occurrence_start for follow-up edits.',
    inputSchema: obj({
      calendar_id: s(`calendar to read; ${CAL_HINT}`),
      from: s(`range start; ${TIME_HINT}`),
      to: s(`range end; ${TIME_HINT}`),
      days: n('range length in days when `to` is omitted (default 31)'),
      tz: s('IANA timezone overriding the account default'),
    }),
    run: (c, a) => T.listEvents(c, a),
  },
  {
    name: 'get_event',
    description: 'Full detail for one event: fields, reminders, comment thread, reactions.',
    inputSchema: obj({ event_id: s('event id, e.g. evt_…') }, ['event_id']),
    run: (c, a) => T.getEvent(c, a),
  },
  {
    name: 'create_event',
    description: 'Create one event. Timed events need `start` (and optional `end`, default +1h); all-day events need all_day=true and `date`. Optional RFC5545 RRULE (e.g. "RRULE:FREQ=WEEKLY;BYDAY=TH") makes it recurring; reminders are minutes-before integers (30 = 30 min, 1440 = 1 day).',
    inputSchema: obj({
      calendar_id: s(`target calendar; ${CAL_HINT}`),
      title: s('event title'),
      start: s(`start; ${TIME_HINT}`),
      end: s(`end; ${TIME_HINT}`),
      all_day: b('true for an all-day event'),
      date: s('calendar day for all-day events (YYYY-MM-DD)'),
      rrule: s('RFC5545 RRULE for recurrence'),
      note: s('notes/description'),
      location: s('location'),
      label_id: n('label id (see list_labels)'),
      reminders: { type: 'array', items: { type: 'number' }, description: 'minutes before start, e.g. [30] or [1440]' },
      virtual_attendees: { type: 'array', items: { type: 'string' }, description: 'virtual member ids (see list_virtual_members), e.g. the child the lesson belongs to' },
      tz: s('IANA timezone for interpreting naive times'),
    }, ['title']),
    run: (c, a) => T.createEvent(c, a),
  },
  {
    name: 'create_events',
    description: 'Batch-create up to 500 events in one call. Each entry takes the same fields as create_event. Returns created count, ids, and per-index failures.',
    inputSchema: obj({
      calendar_id: s(`target calendar; ${CAL_HINT}`),
      events: { type: 'array', minItems: 1, maxItems: 500, items: obj({
        title: s('event title'), start: s(`start; ${TIME_HINT}`), end: s(`end; ${TIME_HINT}`),
        all_day: b('all-day'), date: s('day for all-day events'), rrule: s('RRULE'),
        note: s('notes'), location: s('location'), label_id: n('label id'),
        reminders: { type: 'array', items: { type: 'number' }, description: 'minutes before start' },
        virtual_attendees: { type: 'array', items: { type: 'string' }, description: 'virtual member ids' },
      }, ['title']) },
      tz: s('IANA timezone for interpreting naive times'),
    }, ['events']),
    run: (c, a) => T.createEvents(c, a),
  },
  {
    name: 'quick_add',
    description: 'Natural-language add (Chinese): "明天下午3點看牙醫", "每週四晚上7點古琴班". High-confidence parses create the event; otherwise returns needs_confirmation with the parsed preview — re-call with confirm=true to accept it.',
    inputSchema: obj({
      calendar_id: s(`target calendar; ${CAL_HINT}`),
      text: s('natural-language sentence'),
      confirm: b('create even when the parser had to guess (needs_confirmation)'),
      tz: s('IANA timezone'),
    }, ['text']),
    run: (c, a) => T.quickAdd(c, a),
  },
  {
    name: 'update_event',
    description: 'Update fields of an event (only the fields you pass change; reminders are preserved unless you pass new ones). Edits the whole series — use override_occurrence to change a single occurrence.',
    inputSchema: obj({
      event_id: s('event id'),
      title: s('new title'), start: s(`new start; ${TIME_HINT}`), end: s(`new end; ${TIME_HINT}`),
      all_day: b('switch all-day'), date: s('new day for all-day events'),
      rrule: s('new RRULE (empty string clears)'), note: s('notes'), location: s('location'),
      label_id: n('label id'), reminders: { type: 'array', items: { type: 'number' }, description: 'replace reminders' },
      virtual_attendees: { type: 'array', items: { type: 'string' }, description: 'replace the tagged virtual members' },
    }, ['event_id']),
    run: (c, a) => T.updateEvent(c, a),
  },
  {
    name: 'delete_event',
    description: 'Delete an event. scope=all removes the whole series (default); scope=occurrence cancels one occurrence (needs occurrence_start); scope=future ends the series before that occurrence and keeps it onward.',
    inputSchema: obj({
      event_id: s('event id'),
      scope: { type: 'string', enum: ['all', 'future', 'occurrence'], description: 'what to delete (default all)' },
      occurrence_start: s(`which occurrence, for scope occurrence/future; ${TIME_HINT} or the occurrence_start epoch from list_events`),
    }, ['event_id']),
    run: (c, a) => T.deleteEvent(c, a),
  },
  {
    name: 'override_occurrence',
    description: 'Change one occurrence of a recurring event without touching the series: new title/time/location, or gone=true to cancel just that day.',
    inputSchema: obj({
      event_id: s('event id'),
      occurrence_start: s(`the occurrence to change; ${TIME_HINT} or epoch from list_events`),
      title: s('override title'), start: s(`override start; ${TIME_HINT}`), end: s(`override end; ${TIME_HINT}`),
      note: s('override note'), location: s('override location'), all_day: b('override all-day'),
      gone: b('true cancels this occurrence'),
    }, ['event_id', 'occurrence_start']),
    run: (c, a) => T.overrideOccurrence(c, a),
  },
  {
    name: 'find_free_slots',
    description: 'Find gaps of at least duration_minutes inside one day\'s window (default 08:00–22:00), across the calendar\'s events.',
    inputSchema: obj({
      calendar_id: s(`calendar to check; ${CAL_HINT}`),
      date: s('day to check (YYYY-MM-DD)'),
      duration_minutes: n('minimum slot length (default 60)'),
      window_start: s('search window start HH:MM (default 08:00)'),
      window_end: s('search window end HH:MM (default 22:00)'),
      tz: s('IANA timezone'),
    }, ['date']),
    run: (c, a) => T.findFreeSlots(c, a),
  },
  {
    name: 'add_comment',
    description: 'Post a comment on an event; all calendar members see it.',
    inputSchema: obj({ event_id: s('event id'), body: s('comment text') }, ['event_id', 'body']),
    run: (c, a) => T.addComment(c, a),
  },
  {
    name: 'list_labels',
    description: 'List a calendar\'s labels (id, name, color) for use as label_id.',
    inputSchema: obj({ calendar_id: s(`calendar; ${CAL_HINT}`) }),
    run: (c, a) => T.listLabels(c, a),
  },
  {
    name: 'create_subscription',
    description: 'Create a read-only ICS subscription URL for a calendar (phone calendar apps can subscribe). Returns the full URL and expiry.',
    inputSchema: obj({
      calendar_id: s(`calendar; ${CAL_HINT}`),
      days: n('validity in days (1–3650, default 365)'),
    }),
    run: (c, a) => T.createSubscription(c, a),
  },
  {
    name: 'copy_event',
    description: 'Copy an event (or one occurrence of a recurring series) to a new time or another calendar. Carries title, note, location, label, reminders and virtual members; recurrence is NOT copied unless keep_recurrence=true.',
    inputSchema: obj({
      event_id: s('source event id'),
      start: s(`new start; ${TIME_HINT}`),
      shift_days: n('alternative to start: move the copy by this many days'),
      occurrence_start: s('copy this occurrence instead of the master event (epoch from list_events)'),
      to_calendar_id: s('target calendar (default: the source calendar)'),
      title: s('override the copied title'),
      keep_recurrence: b('also copy the RRULE (default false)'),
      tz: s('IANA timezone for interpreting naive times'),
    }, ['event_id']),
    run: (c, a) => T.copyEvent(c, a),
  },
  {
    name: 'list_virtual_members',
    description: 'List people without accounts (children, pets, cars…) that can be tagged on events. Tag with create_event.virtual_attendees.',
    inputSchema: obj({ calendar_id: s(`calendar; ${CAL_HINT}`) }),
    run: (c, a) => T.listVirtualMembers(c, a),
  },
  {
    name: 'create_virtual_member',
    description: 'Add a virtual member to a calendar: name plus account_type (child|pet|car|grandfather|grandmother|other), optional color and birthday.',
    inputSchema: obj({
      calendar_id: s(`calendar; ${CAL_HINT}`),
      name: s('display name'),
      account_type: { type: 'string', enum: ['child', 'pet', 'car', 'grandfather', 'grandmother', 'other'], description: 'what this member is' },
      color: s('hex colour, e.g. #6aa84f'),
      birthday: s('YYYY-MM-DD'),
      shows_birthday: b('show their birthday on the calendar'),
    }, ['name']),
    run: (c, a) => T.createVirtualMember(c, a),
  },
  {
    name: 'update_virtual_member',
    description: 'Rename or re-tag a virtual member (only the fields you pass change).',
    inputSchema: obj({
      virtual_id: s('virtual member id (vm_…)'),
      name: s('new name'),
      account_type: { type: 'string', enum: ['child', 'pet', 'car', 'grandfather', 'grandmother', 'other'], description: 'new type' },
      color: s('new colour'), birthday: s('YYYY-MM-DD'), shows_birthday: b('show birthday'),
    }, ['virtual_id']),
    run: (c, a) => T.updateVirtualMember(c, a),
  },
  {
    name: 'delete_virtual_member',
    description: 'Delete a virtual member; existing events keep their remaining fields but lose the tag.',
    inputSchema: obj({ virtual_id: s('virtual member id') }, ['virtual_id']),
    run: (c, a) => T.deleteVirtualMember(c, a),
  },
  {
    name: 'list_memos',
    description: 'List calendar-level notes (not attached to any event), pinned first.',
    inputSchema: obj({ calendar_id: s(`calendar; ${CAL_HINT}`) }),
    run: (c, a) => T.listMemos(c, a),
  },
  {
    name: 'create_memo',
    description: 'Create a calendar-level note (title and/or body).',
    inputSchema: obj({
      calendar_id: s(`calendar; ${CAL_HINT}`),
      title: s('memo title'), body: s('memo text'), pinned: b('pin to the top'),
    }),
    run: (c, a) => T.createMemo(c, a),
  },
  {
    name: 'update_memo',
    description: 'Edit a memo (only the fields you pass change).',
    inputSchema: obj({
      memo_id: s('memo id'), title: s('new title'), body: s('new text'), pinned: b('pin or unpin'),
    }, ['memo_id']),
    run: (c, a) => T.updateMemo(c, a),
  },
  {
    name: 'delete_memo',
    description: 'Delete a memo.',
    inputSchema: obj({ memo_id: s('memo id') }, ['memo_id']),
    run: (c, a) => T.deleteMemo(c, a),
  },
  {
    name: 'get_date_info',
    description: 'Weekday/weekend plus Macau public holidays (official 2026–2027 table incl. 補假). Coverage is explicit: outside 2026-01-01..2027-12-31, holiday_known=false and the day is unknown — do not assume it is a working day. Pass `days` to list holidays in a window; the result also carries the next holiday.',
    inputSchema: obj({
      date: s('day to inspect (YYYY-MM-DD)'),
      days: n('also list holidays in [date, date+days] (max 366)'),
      tz: s('IANA timezone, used when date is not YYYY-MM-DD'),
    }, ['date']),
    run: (c, a) => T.getDateInfo(c, a),
  },
];

const TOOL_MAP = new Map(TOOLS.map((t) => [t.name, t]));

function buildClient(): Client {
  const cfg = loadConfig();
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--base' && argv[i + 1]) cfg.base = argv[++i];
    else if (argv[i] === '--token' && argv[i + 1]) cfg.token = argv[++i];
    else if (argv[i] === '--calendar' && argv[i + 1]) cfg.calendar = argv[++i];
    else if (argv[i] === '--tz' && argv[i + 1]) cfg.tz = argv[++i];
  }
  return new Client(cfg);
}

const CLIENT = buildClient();

function send(msg: Record<string, any>) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function reply(id: any, result: unknown) {
  send({ jsonrpc: '2.0', id, result });
}

function replyError(id: any, code: number, message: string) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

async function handle(msg: any) {
  const { id, method, params } = msg;
  if (method === 'initialize') {
    reply(id, {
      protocolVersion: typeof params?.protocolVersion === 'string' ? params.protocolVersion : PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: SERVER_INFO,
    });
    return;
  }
  if (method === 'notifications/initialized' || method === 'initialized') return;
  if (method === 'ping') { reply(id, {}); return; }

  if (method === 'tools/list') {
    reply(id, { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
    return;
  }

  if (method === 'tools/call') {
    const tool = TOOL_MAP.get(String(params?.name));
    if (!tool) { replyError(id, -32602, `unknown tool: ${params?.name}`); return; }
    try {
      const out = await tool.run(CLIENT, params?.arguments ?? {});
      reply(id, { content: [{ type: 'text', text: JSON.stringify(out) }] });
    } catch (e: any) {
      reply(id, {
        content: [{ type: 'text', text: JSON.stringify({ error: String(e?.message ?? e), status: e?.status ?? 500 }) }],
        isError: true,
      });
    }
    return;
  }

  if (id !== undefined) replyError(id, -32601, `method not found: ${method}`);
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk: string) => {
  buffer += chunk;
  let nl: number;
  while ((nl = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    let msg: any;
    try { msg = JSON.parse(line); } catch { continue; }
    handle(msg).catch((e) => {
      if (msg?.id !== undefined) replyError(msg.id, -32603, String(e?.message ?? e));
    });
  }
});
process.stdin.on('end', () => process.exit(0));
