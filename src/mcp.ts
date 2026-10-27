// MCP (Model Context Protocol) stdio server exposing the calendar to any
// MCP-capable AI agent. Zero dependencies; newline-delimited JSON-RPC 2.0.
//
//   node src/mcp.ts [--base URL] [--token cal_…] [--calendar cal_…]
// or via env: CAL_BASE / CAL_TOKEN / CAL_CALENDAR / CAL_TZ
//
// stdout carries protocol messages only; nothing else may write to it.
import { Client, loadConfig, ApiError } from './client.ts';
import * as T from './agent-tools.ts';

const SERVER_INFO = { name: 'shared-calendar', version: '0.1.0' };
const PROTOCOL_VERSION = '2025-06-18';

const s = (description: string, extra: Record<string, any> = {}) => ({ type: 'string', description, ...extra });
const n = (description: string) => ({ type: 'number', description });
const b = (description: string) => ({ type: 'boolean', description });
const obj = (properties: Record<string, any>, required: string[] = []) =>
  ({ type: 'object', properties, required, additionalProperties: false });
// Output schemas stay open: extra keys are allowed so a new field never makes a
// previously valid payload fail validation in a client.
const out = (properties: Record<string, any>, required: string[] = []) =>
  ({ type: 'object', properties, required });
const list = (items: any) => ({ type: 'array', items });

const TIME_HINT = 'epoch ms, ISO 8601, "YYYY-MM-DD" or "YYYY-MM-DD HH:MM" (naive values read as wall-clock in tz)';
const CAL_HINT = 'defaults to the configured default calendar';

// ---------- output schemas ----------

const VIRTUAL_MEMBER = out({
  id: { type: 'string' }, name: { type: 'string' }, account_type: { type: 'string' },
  color: { type: 'string' }, birthday: { type: 'string' }, shows_birthday: { type: 'number' },
}, ['id', 'name', 'account_type']);

const EVENT_SUMMARY = out({
  id: { type: 'string' },
  occurrence_start: { type: 'number', description: 'epoch ms of the original occurrence; feed back to occurrence tools' },
  start_at: { type: 'number' },
  end_at: { type: 'number' },
  title: { type: 'string' },
  start: { type: 'string' },
  end: { type: 'string' },
  all_day: { type: 'boolean' },
  rrule: { type: 'string' },
  label: { type: 'string' },
  label_id: { type: 'number', description: 'only with detail=full' },
  location: { type: 'string' },
  note: { type: 'string', description: 'only with detail=full' },
  reminders: list({ type: 'number' }),
  virtual_attendees: list(VIRTUAL_MEMBER),
  overridden: { type: 'boolean' },
  comment_count: { type: 'number' },
}, ['id', 'occurrence_start', 'start_at', 'end_at', 'title', 'start']);

const EVENT_DETAIL = out({
  ...EVENT_SUMMARY.properties,
  calendar_id: { type: 'string' },
  tz: { type: 'string' },
  updated_at: { type: 'number', description: 'pass back as expected_updated_at to detect concurrent edits' },
}, ['id', 'title', 'start_at', 'end_at', 'start']);

const LIST_EVENTS = out({
  tz: { type: 'string' }, from: { type: 'string' }, to: { type: 'string' },
  detail: { type: 'string', enum: ['summary', 'full'] },
  count: { type: 'number' },
  events: list(EVENT_SUMMARY),
}, ['tz', 'from', 'to', 'count', 'events']);

const GET_EVENT = out({
  event: EVENT_DETAIL,
  reminders: list({ type: 'number' }),
  virtual_attendees: list(VIRTUAL_MEMBER),
  comments: list(out({
    id: { type: 'string' }, name: { type: 'string' }, body: { type: 'string' }, at: { type: 'string' },
  })),
  reactions: list(out({ emoji: { type: 'string' }, count: { type: 'number' }, mine: { type: 'boolean' } })),
}, ['event', 'reminders', 'virtual_attendees', 'comments', 'reactions']);

const LIST_CALENDARS = out({
  items: list(out({
    id: { type: 'string' }, name: { type: 'string' }, role: { type: 'string' },
    member_count: { type: 'number' }, default: { type: 'boolean' },
  }, ['id', 'name', 'role'])),
}, ['items']);

const LIST_MEMBERS = out({
  calendar_id: { type: 'string' },
  items: list(out({ id: { type: 'string' }, name: { type: 'string' }, role: { type: 'string' } }, ['id', 'name', 'role'])),
}, ['calendar_id', 'items']);

const CREATE_EVENT = out({
  created: { type: 'string' }, title: { type: 'string' }, start: { type: 'string' },
  rrule: { type: 'string' }, calendar_id: { type: 'string' },
}, ['created', 'title', 'start', 'calendar_id']);

const CREATE_EVENTS = out({
  created: { type: 'number' },
  ids: list({ type: 'string' }),
  failed: list(out({ index: { type: 'number' }, reason: { type: 'string' } })),
}, ['created', 'ids', 'failed']);

const QUICK_ADD = out({
  created: { type: 'string' }, display: { type: 'string' },
  needs_confirmation: { type: 'boolean' }, parsed: { type: 'object' }, event: { type: 'object' },
});

const DELETE_EVENT = out({
  scope: { type: 'string' }, day: { type: 'string' }, until: { type: 'string' },
}, ['scope']);

const LIST_TRASH = out({
  items: list(out({
    id: { type: 'string' }, calendar_id: { type: 'string' }, calendar: { type: 'string' },
    title: { type: 'string' }, start: { type: 'string' }, rrule: { type: 'string' }, deleted: { type: 'string' },
  }, ['id', 'title', 'start', 'deleted'])),
}, ['items']);

const OVERRIDE_OCCURRENCE = out({
  ok: { type: 'boolean' }, event_id: { type: 'string' }, occurrence: { type: 'string' },
}, ['ok', 'event_id']);

const FIND_FREE_SLOTS = out({
  date: { type: 'string' }, tz: { type: 'string' }, duration_minutes: { type: 'number' },
  window: { type: 'string' },
  free: list(out({ start: { type: 'string' }, end: { type: 'string' }, start_at: { type: 'number' }, end_at: { type: 'number' } })),
}, ['date', 'tz', 'free']);

const LIST_LABELS = out({
  calendar_id: { type: 'string' },
  items: list(out({ id: { type: 'number' }, name: { type: 'string' }, color: { type: 'string' } }, ['id', 'name'])),
}, ['calendar_id', 'items']);

const CREATE_SUBSCRIPTION = out({
  url: { type: 'string' }, token: { type: 'string' }, expires_at: { type: 'number' }, calendar_id: { type: 'string' },
}, ['url', 'token', 'calendar_id']);

const LIST_SUBSCRIPTIONS = out({
  calendar_id: { type: 'string' },
  items: list(out({
    token: { type: 'string' }, created_at: { type: 'number' }, expires_at: { type: 'number' },
    revoked_at: { type: 'number' }, last_used_at: { type: 'number' },
  }, ['token'])),
}, ['calendar_id', 'items']);

const COPY_EVENT = out({
  copied: { type: 'string' }, from_event: { type: 'string' }, title: { type: 'string' },
  calendar_id: { type: 'string' }, start: { type: 'string' }, recurrence_copied: { type: 'boolean' },
}, ['copied', 'from_event', 'calendar_id', 'start']);

const DELETE_MEMBER = out({ ok: { type: 'boolean' } }, ['ok']);
const CREATE_MEMBER = out({ id: { type: 'string' }, name: { type: 'string' }, account_type: { type: 'string' } }, ['id']);
const UPDATE_MEMBER = out({ ok: { type: 'boolean' }, id: { type: 'string' } }, ['ok']);
const MEMO = out({
  id: { type: 'string' }, title: { type: 'string' }, body: { type: 'string' }, pinned: { type: 'number' },
  created_by: { type: 'string' }, created_at: { type: 'number' }, updated_at: { type: 'number' },
}, ['id']);
const LIST_MEMOS = out({ calendar_id: { type: 'string' }, items: list(MEMO) }, ['calendar_id', 'items']);
const MEMO_ID = out({ id: { type: 'string' } }, ['id']);
const MEMO_OK = out({ ok: { type: 'boolean' }, id: { type: 'string' } }, ['ok']);

const WHOAMI = out({
  id: { type: 'string' }, email: { type: 'string' }, name: { type: 'string' }, tz: { type: 'string' },
}, ['id', 'email', 'tz']);

const DATE_INFO = out({
  date: { type: 'string' }, weekday: { type: 'string' }, weekend: { type: 'boolean' },
  holiday: { type: ['object', 'null'] }, holiday_known: { type: 'boolean' },
  coverage: { type: 'object' }, tz: { type: 'string' }, note: { type: 'string' },
  range: { type: 'object' }, holidays: list(out({
    date: { type: 'string' }, weekday: { type: 'string' }, name: { type: 'string' }, makeup: { type: 'boolean' },
  })), next_holiday: { type: 'object' },
}, ['date', 'weekday', 'weekend', 'holiday_known', 'tz']);

// ---------- tools ----------

type Kind = 'read' | 'create' | 'update' | 'delete' | 'restore';
type Tool = {
  name: string;
  description: string;
  kind: Kind;
  inputSchema: any;
  outputSchema: any;
  run: (c: Client, a: any) => Promise<unknown>;
};

const ANNOTATIONS: Record<Kind, Record<string, boolean>> = {
  read: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  create: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  update: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  delete: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  restore: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
};

const TOOLS: Tool[] = [
  {
    name: 'list_calendars',
    description: 'List calendars the authenticated user belongs to, with role and member count.',
    kind: 'read',
    inputSchema: obj({}),
    outputSchema: LIST_CALENDARS,
    run: (c) => T.listCalendars(c),
  },
  {
    name: 'create_calendar',
    description: 'Create a shared calendar owned by the authenticated account. Add other accounts later with create_invite + join_calendar.',
    kind: 'create',
    inputSchema: obj({
      name: s('calendar name'),
      color: s('hex colour, e.g. #4a90d9'),
    }, ['name']),
    outputSchema: out({ created: { type: 'string' }, name: { type: 'string' }, calendar_id: { type: 'string' } }, ['created', 'calendar_id']),
    run: (c, a) => T.createCalendar(c, a),
  },
  {
    name: 'list_members',
    description: 'List the people who can see a calendar, with their role (owner|member).',
    kind: 'read',
    inputSchema: obj({ calendar_id: s(`calendar; ${CAL_HINT}`) }),
    outputSchema: LIST_MEMBERS,
    run: (c, a) => T.listMembers(c, a),
  },
  {
    name: 'create_invite',
    description: 'Create an invite code for a calendar you own. Another account redeems it with join_calendar. Codes do not expire.',
    kind: 'create',
    inputSchema: obj({ calendar_id: s(`calendar; ${CAL_HINT}`) }),
    outputSchema: out({ calendar_id: { type: 'string' }, code: { type: 'string' }, hint: { type: 'string' } }, ['calendar_id', 'code']),
    run: (c, a) => T.createInvite(c, a),
  },
  {
    name: 'join_calendar',
    description: 'Join a calendar with an invite code from create_invite. Afterwards the calendar appears in list_calendars.',
    kind: 'create',
    inputSchema: obj({ code: s('invite code, e.g. 7KQ2M9XPRT') }, ['code']),
    outputSchema: out({ joined: { type: 'boolean' }, calendar_id: { type: 'string' } }, ['joined', 'calendar_id']),
    run: (c, a) => T.joinCalendar(c, a),
  },
  {
    name: 'list_events',
    description: 'List event occurrences in a time range (default: next 31 days), expanded with recurrence and overrides applied. Times are local labels plus epoch start_at. Optional q searches title/note/location, label_id narrows to one label, and detail=full adds note, reminders, label_id, virtual attendees and the overridden flag.',
    kind: 'read',
    inputSchema: obj({
      calendar_id: s(`calendar to read; ${CAL_HINT}`),
      from: s(`range start; ${TIME_HINT}`),
      to: s(`range end; ${TIME_HINT}`),
      days: n('range length in days when `to` is omitted (default 31, max 400)'),
      q: s('case-insensitive substring match on title, note and location'),
      label_id: n('only occurrences carrying this label (see list_labels)'),
      detail: { type: 'string', enum: ['summary', 'full'], description: 'full adds note, label_id, reminders and virtual attendees (default summary)' },
      tz: s('IANA timezone overriding the account default'),
    }),
    outputSchema: LIST_EVENTS,
    run: (c, a) => T.listEvents(c, a),
  },
  {
    name: 'get_event',
    description: 'Full detail for one event: fields, reminders, comment thread, reactions. Carries updated_at for optimistic concurrency.',
    kind: 'read',
    inputSchema: obj({ event_id: s('event id, e.g. evt_…') }, ['event_id']),
    outputSchema: GET_EVENT,
    run: (c, a) => T.getEvent(c, a),
  },
  {
    name: 'create_event',
    description: 'Create one event. Timed events need `start` (and optional `end`, default +1h); all-day events need all_day=true and `date`. Optional RFC5545 RRULE (e.g. "RRULE:FREQ=WEEKLY;BYDAY=TH") makes it recurring; reminders are minutes-before integers (30 = 30 min, 1440 = 1 day).',
    kind: 'create',
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
      request_id: s('idempotency key: retrying with the same value returns the original event instead of creating a duplicate'),
    }, ['title']),
    outputSchema: CREATE_EVENT,
    run: (c, a) => T.createEvent(c, a),
  },
  {
    name: 'create_events',
    description: 'Batch-create up to 500 events in one call. Each entry takes the same fields as create_event. Returns created count, ids, and per-index failures.',
    kind: 'create',
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
      request_id: s('idempotency key: a retry with the same value replays the original batch result'),
    }, ['events']),
    outputSchema: CREATE_EVENTS,
    run: (c, a) => T.createEvents(c, a),
  },
  {
    name: 'quick_add',
    description: 'Natural-language add (Chinese): "明天下午3點看牙醫", "每週四晚上7點古琴班". High-confidence parses create the event; otherwise returns needs_confirmation with the parsed preview — re-call with confirm=true to accept it.',
    kind: 'create',
    inputSchema: obj({
      calendar_id: s(`target calendar; ${CAL_HINT}`),
      text: s('natural-language sentence'),
      confirm: b('create even when the parser had to guess (needs_confirmation)'),
      tz: s('IANA timezone'),
      request_id: s('idempotency key for safe retries'),
    }, ['text']),
    outputSchema: QUICK_ADD,
    run: (c, a) => T.quickAdd(c, a),
  },
  {
    name: 'update_event',
    description: 'Update an event; only the fields you pass change (reminders and virtual attendees are preserved when omitted). Edits the whole series — use override_occurrence for one day. Pass expected_updated_at from get_event to fail with stale_event instead of overwriting a concurrent edit.',
    kind: 'update',
    inputSchema: obj({
      event_id: s('event id'),
      title: s('new title'), start: s(`new start; ${TIME_HINT}`), end: s(`new end; ${TIME_HINT}`),
      all_day: b('switch all-day'), date: s('new day for all-day events'),
      rrule: s('new RRULE (empty string clears)'), note: s('notes'), location: s('location'),
      label_id: n('label id'), reminders: { type: 'array', items: { type: 'number' }, description: 'replace reminders' },
      virtual_attendees: { type: 'array', items: { type: 'string' }, description: 'replace the tagged virtual members' },
      tz: s('IANA timezone for interpreting naive start/end values'),
      expected_updated_at: n('version check: the updated_at you read; a mismatch is 409 stale_event'),
    }, ['event_id']),
    outputSchema: GET_EVENT,
    run: (c, a) => T.updateEvent(c, a),
  },
  {
    name: 'delete_event',
    description: 'Delete an event. scope=all removes the whole series (default); scope=occurrence cancels one occurrence (needs occurrence_start); scope=future ends the series before that occurrence and keeps it onward. Deletes are recoverable with restore_event / restore_occurrence.',
    kind: 'delete',
    inputSchema: obj({
      event_id: s('event id'),
      scope: { type: 'string', enum: ['all', 'future', 'occurrence'], description: 'what to delete (default all)' },
      occurrence_start: s(`which occurrence, for scope occurrence/future; ${TIME_HINT} or the occurrence_start epoch from list_events`),
    }, ['event_id']),
    outputSchema: DELETE_EVENT,
    run: (c, a) => T.deleteEvent(c, a),
  },
  {
    name: 'list_trash',
    description: 'Recently deleted events (default last 30 days). Deletes are recoverable: restore_event or restore_occurrence. Check here after an accidental delete instead of recreating.',
    kind: 'read',
    inputSchema: obj({
      days: n('look-back window in days (1–365, default 30)'),
      tz: s('IANA timezone for the labels'),
    }),
    outputSchema: LIST_TRASH,
    run: (c, a) => T.listTrash(c, a),
  },
  {
    name: 'restore_event',
    description: 'Undo deleting an event (the whole series). Safe to call repeatedly; an already-visible event reports restored=false with already_visible=true.',
    kind: 'restore',
    inputSchema: obj({ event_id: s('deleted event id') }, ['event_id']),
    outputSchema: out({ restored: { type: 'boolean' }, already_visible: { type: 'boolean' } }, ['restored']),
    run: (c, a) => T.restoreEvent(c, a),
  },
  {
    name: 'restore_occurrence',
    description: 'Undo deleting one occurrence of a recurring event (removes that day from EXDATE). Pass the occurrence_start epoch reported by list_events.',
    kind: 'restore',
    inputSchema: obj({
      event_id: s('recurring event id'),
      occurrence_start: s(`the occurrence to bring back; ${TIME_HINT}`),
    }, ['event_id', 'occurrence_start']),
    outputSchema: out({ restored: { type: 'boolean' }, day: { type: 'string' } }, ['restored']),
    run: (c, a) => T.restoreOccurrence(c, a),
  },
  {
    name: 'override_occurrence',
    description: 'Change one occurrence of a recurring event without touching the series: new title/time/location, or gone=true to cancel just that day.',
    kind: 'update',
    inputSchema: obj({
      event_id: s('event id'),
      occurrence_start: s(`the occurrence to change; ${TIME_HINT} or epoch from list_events`),
      title: s('override title'), start: s(`override start; ${TIME_HINT}`), end: s(`override end; ${TIME_HINT}`),
      note: s('override note'), location: s('override location'), all_day: b('override all-day'),
      gone: b('true cancels this occurrence'),
    }, ['event_id', 'occurrence_start']),
    outputSchema: OVERRIDE_OCCURRENCE,
    run: (c, a) => T.overrideOccurrence(c, a),
  },
  {
    name: 'find_free_slots',
    description: 'Find gaps of at least duration_minutes inside one day\'s window (default 08:00–22:00), across the calendar\'s events.',
    kind: 'read',
    inputSchema: obj({
      calendar_id: s(`calendar to check; ${CAL_HINT}`),
      date: s('day to check (YYYY-MM-DD)'),
      duration_minutes: n('minimum slot length (default 60)'),
      window_start: s('search window start HH:MM (default 08:00)'),
      window_end: s('search window end HH:MM (default 22:00)'),
      tz: s('IANA timezone'),
    }, ['date']),
    outputSchema: FIND_FREE_SLOTS,
    run: (c, a) => T.findFreeSlots(c, a),
  },
  {
    name: 'add_comment',
    description: 'Post a comment on an event; all calendar members see it.',
    kind: 'create',
    inputSchema: obj({ event_id: s('event id'), body: s('comment text') }, ['event_id', 'body']),
    outputSchema: out({ id: { type: 'string' } }, ['id']),
    run: (c, a) => T.addComment(c, a),
  },
  {
    name: 'list_labels',
    description: 'List a calendar\'s labels (id, name, color) for use as label_id, including in list_events.',
    kind: 'read',
    inputSchema: obj({ calendar_id: s(`calendar; ${CAL_HINT}`) }),
    outputSchema: LIST_LABELS,
    run: (c, a) => T.listLabels(c, a),
  },
  {
    name: 'create_subscription',
    description: 'Create a read-only ICS subscription URL for a calendar (phone calendar apps can subscribe). Returns the full URL and expiry.',
    kind: 'create',
    inputSchema: obj({
      calendar_id: s(`calendar; ${CAL_HINT}`),
      days: n('validity in days (1–3650, default 365)'),
    }),
    outputSchema: CREATE_SUBSCRIPTION,
    run: (c, a) => T.createSubscription(c, a),
  },
  {
    name: 'copy_event',
    description: 'Copy an event (or one occurrence of a recurring series) to a new time or another calendar. Carries title, note, location, label, reminders and virtual members; recurrence is NOT copied unless keep_recurrence=true.',
    kind: 'create',
    inputSchema: obj({
      event_id: s('source event id'),
      start: s(`new start; ${TIME_HINT}`),
      shift_days: n('alternative to start: move the copy by this many days'),
      occurrence_start: s('copy this occurrence instead of the master event (epoch from list_events)'),
      to_calendar_id: s('target calendar (default: the source calendar)'),
      title: s('override the copied title'),
      keep_recurrence: b('also copy the RRULE (default false)'),
      tz: s('IANA timezone for interpreting naive times'),
      request_id: s('idempotency key for safe retries'),
    }, ['event_id']),
    outputSchema: COPY_EVENT,
    run: (c, a) => T.copyEvent(c, a),
  },
  {
    name: 'list_virtual_members',
    description: 'List people without accounts (children, pets, cars…) that can be tagged on events. Tag with create_event.virtual_attendees.',
    kind: 'read',
    inputSchema: obj({ calendar_id: s(`calendar; ${CAL_HINT}`) }),
    outputSchema: out({ calendar_id: { type: 'string' }, items: list(VIRTUAL_MEMBER) }, ['calendar_id', 'items']),
    run: (c, a) => T.listVirtualMembers(c, a),
  },
  {
    name: 'create_virtual_member',
    description: 'Add a virtual member to a calendar: name plus account_type (child|pet|car|grandfather|grandmother|other), optional color and birthday.',
    kind: 'create',
    inputSchema: obj({
      calendar_id: s(`calendar; ${CAL_HINT}`),
      name: s('display name'),
      account_type: { type: 'string', enum: ['child', 'pet', 'car', 'grandfather', 'grandmother', 'other'], description: 'what this member is' },
      color: s('hex colour, e.g. #6aa84f'),
      birthday: s('YYYY-MM-DD'),
      shows_birthday: b('show their birthday on the calendar'),
    }, ['name']),
    outputSchema: CREATE_MEMBER,
    run: (c, a) => T.createVirtualMember(c, a),
  },
  {
    name: 'update_virtual_member',
    description: 'Rename or re-tag a virtual member (only the fields you pass change).',
    kind: 'update',
    inputSchema: obj({
      virtual_id: s('virtual member id (vm_…)'),
      name: s('new name'),
      account_type: { type: 'string', enum: ['child', 'pet', 'car', 'grandfather', 'grandmother', 'other'], description: 'new type' },
      color: s('new colour'), birthday: s('YYYY-MM-DD'), shows_birthday: b('show birthday'),
    }, ['virtual_id']),
    outputSchema: UPDATE_MEMBER,
    run: (c, a) => T.updateVirtualMember(c, a),
  },
  {
    name: 'delete_virtual_member',
    description: 'Delete a virtual member; existing events keep their remaining fields but lose the tag.',
    kind: 'delete',
    inputSchema: obj({ virtual_id: s('virtual member id') }, ['virtual_id']),
    outputSchema: DELETE_MEMBER,
    run: (c, a) => T.deleteVirtualMember(c, a),
  },
  {
    name: 'list_memos',
    description: 'List calendar-level notes (not attached to any event), pinned first.',
    kind: 'read',
    inputSchema: obj({ calendar_id: s(`calendar; ${CAL_HINT}`) }),
    outputSchema: LIST_MEMOS,
    run: (c, a) => T.listMemos(c, a),
  },
  {
    name: 'create_memo',
    description: 'Create a calendar-level note (title and/or body).',
    kind: 'create',
    inputSchema: obj({
      calendar_id: s(`calendar; ${CAL_HINT}`),
      title: s('memo title'), body: s('memo text'), pinned: b('pin to the top'),
    }),
    outputSchema: MEMO_ID,
    run: (c, a) => T.createMemo(c, a),
  },
  {
    name: 'update_memo',
    description: 'Edit a memo (only the fields you pass change).',
    kind: 'update',
    inputSchema: obj({
      memo_id: s('memo id'), title: s('new title'), body: s('new text'), pinned: b('pin or unpin'),
    }, ['memo_id']),
    outputSchema: MEMO_OK,
    run: (c, a) => T.updateMemo(c, a),
  },
  {
    name: 'delete_memo',
    description: 'Delete a memo.',
    kind: 'delete',
    inputSchema: obj({ memo_id: s('memo id') }, ['memo_id']),
    outputSchema: DELETE_MEMBER,
    run: (c, a) => T.deleteMemo(c, a),
  },
  {
    name: 'list_subscriptions',
    description: 'List a calendar\'s read-only ICS subscription links. Agent tokens see masked prefixes (enough to recognise and revoke one); the full URL is only shown to a browser session.',
    kind: 'read',
    inputSchema: obj({ calendar_id: s(`calendar; ${CAL_HINT}`) }),
    outputSchema: LIST_SUBSCRIPTIONS,
    run: (c, a) => T.listSubscriptions(c, a),
  },
  {
    name: 'revoke_subscription',
    description: 'Revoke one ICS subscription link immediately (use it when a shared URL leaked). Needs the full token returned by create_subscription.',
    kind: 'delete',
    inputSchema: obj({ token: s('subscription token from create_subscription') }, ['token']),
    outputSchema: out({ revoked: { type: 'boolean' } }, ['revoked']),
    run: (c, a) => T.revokeSubscription(c, a),
  },
  {
    name: 'whoami',
    description: 'The authenticated account behind this connection: id, email, name, default timezone. Call it first to confirm which calendar the agent is acting as.',
    kind: 'read',
    inputSchema: obj({}),
    outputSchema: WHOAMI,
    run: (c) => T.whoami(c),
  },
  {
    name: 'get_date_info',
    description: 'Weekday/weekend plus Macau public holidays (official 2026–2027 table incl. 補假). Coverage is explicit: outside 2026-01-01..2027-12-31, holiday_known=false and the day is unknown — do not assume it is a working day. Pass `days` to list holidays in a window; the result also carries the next holiday.',
    kind: 'read',
    inputSchema: obj({
      date: s('day to inspect (YYYY-MM-DD)'),
      days: n('also list holidays in [date, date+days] (max 366)'),
      tz: s('IANA timezone, used when date is not YYYY-MM-DD'),
    }, ['date']),
    outputSchema: DATE_INFO,
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

function instructions(): string {
  const cal = CLIENT.calendar ? ` Default calendar: ${CLIENT.calendar}.` : ' No default calendar configured — pass calendar_id.';
  return [
    'Local shared calendar.',
    cal,
    'Call whoami first, then list_calendars if you need to pick another.',
    'Times are wall-clock in the account timezone unless tz is passed; feed epoch values from list_events back into other tools.',
    'list_events supports q (text search), label_id, and detail=full for notes, reminders and tagged members.',
    'Deletes are soft: list_trash / restore_event undo them.',
    'List results arrive as { items: [...] }.',
    'Errors are { error, message, status, hint?, field?, required? }; follow the hint instead of retrying blindly.',
  ].join(' ');
}

function errorPayload(e: unknown) {
  if (e instanceof ApiError) return e.toJSON();
  const message = String((e as any)?.message ?? e);
  return { error: 'internal', message, status: 500 };
}

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
      instructions: instructions(),
    });
    return;
  }
  if (method === 'notifications/initialized' || method === 'initialized') return;
  if (method === 'ping') { reply(id, {}); return; }

  if (method === 'tools/list') {
    reply(id, {
      tools: TOOLS.map(({ name, description, inputSchema, outputSchema, kind }) => ({
        name, description, inputSchema, outputSchema, annotations: ANNOTATIONS[kind],
      })),
    });
    return;
  }

  if (method === 'tools/call') {
    const tool = TOOL_MAP.get(String(params?.name));
    if (!tool) { replyError(id, -32602, `unknown tool: ${params?.name}`); return; }
    try {
      const result = await tool.run(CLIENT, params?.arguments ?? {});
      // structuredContent mirrors the text payload so a client can skip JSON.parse.
      reply(id, { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result });
    } catch (e: any) {
      const payload = errorPayload(e);
      reply(id, {
        content: [{ type: 'text', text: JSON.stringify(payload) }],
        structuredContent: payload,
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
