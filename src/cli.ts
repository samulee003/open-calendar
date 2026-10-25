// Agent-friendly CLI over the calendar REST API.
//   node src/cli.ts <command> [args] [--flags]     (--json for machine output)
// Config lives in ~/.shared-calendar-agent.json (written by `login` / `use`),
// overridable per-invocation with --base/--token or CAL_BASE/CAL_TOKEN env vars.
import { readFileSync } from 'node:fs';
import { Client, loadConfig, saveConfig, ApiError, type ClientConfig } from './client.ts';
import * as T from './agent-tools.ts';

const USAGE = `shared-calendar agent CLI

用法: node src/cli.ts <command> [args] [--flags]

帳號與 token
  login --email E --password P [--base URL]   登入並把 session 存進設定檔
  token create [--name N]                     產生長期 agent token（只顯示這一次）
  token list | token revoke <token>
  whoami

日曆與行程
  calendars                                   列出日曆
  use <calendar-id>                           設預設日曆
  events [--from T] [--to T] [--days N] [--calendar ID] [--json]
  show <event-id> [--json]
  add --title T [--start "YYYY-MM-DD HH:MM"] [--end T] [--rrule R]
      [--all-day --date YYYY-MM-DD] [--note N] [--location L]
      [--label-id N] [--reminders 30,1440] [--tz Z] [--json]
  quick "明天下午3點看牙醫" [--confirm] [--json]
  batch --file events.json                    JSON 陣列,欄位同 add
  update <event-id> [--title …] [--start …] [--end …] [--rrule …] [--note …]
                    [--location …] [--label-id N] [--reminders …] [--json]
  delete <event-id> [--scope all|future|occurrence] [--occ T] [--json]
  override <event-id> --occ T [--title …] [--start …] [--end …] [--gone]
  copy <event-id> [--start T | --shift-days N] [--occurrence T]
       [--to-calendar ID] [--title T] [--keep-recurrence]
  free [--date YYYY-MM-DD] [--duration 60] [--from 08:00] [--to 22:00] [--json]
  dateinfo --date YYYY-MM-DD [--days N] [--json]   澳門公眾假期/星期
  comment <event-id> <文字…>
  labels | subscribe [--days N] | subscriptions | unsubscribe <token>

家庭成員（虛擬）與備忘
  members                                     列出虛擬成員
  member add --name 名字 [--type child|pet|car|grandfather|grandmother|other]
             [--color #hex] [--birthday YYYY-MM-DD] [--show-birthday]
  member update <id> [--name …] [--type …] [--color …] [--birthday …]
  member delete <id>
  memos                                       列出備忘
  memo add --title 標題 [--body 內容] [--pinned]
  memo update <id> [--title …] [--body …] [--pinned]
  memo delete <id>

時間格式: epoch 毫秒、ISO 8601、YYYY-MM-DD、"YYYY-MM-DD HH:MM"（無時區資訊時以 --tz／帳號時區解讀）
全域 flags: --base URL --token TOKEN --tz Z --json`;

type Parsed = { pos: string[]; flags: Record<string, string | boolean> };

function parseArgv(argv: string[]): Parsed {
  const pos: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 0) { flags[a.slice(2, eq)] = a.slice(eq + 1); continue; }
      const name = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) { flags[name] = next; i++; }
      else flags[name] = true;
    } else pos.push(a);
  }
  return { pos, flags };
}

function flagNum(flags: Record<string, string | boolean>, name: string): number | undefined {
  const v = flags[name];
  return typeof v === 'string' ? Number(v) : undefined;
}

function csvNums(v: string | boolean | undefined): number[] | undefined {
  if (typeof v !== 'string') return undefined;
  return v.split(',').map((x) => Number(x.trim())).filter(Number.isFinite);
}

// "true"/"false" string values come from --flag=false, which lets an update clear a boolean.
function boolFlag(v: string | boolean | undefined): boolean | undefined {
  if (v === true || v === 'true' || v === '1') return true;
  if (v === 'false' || v === '0') return false;
  return undefined;
}

function eventArgs(pos: string[], flags: Record<string, string | boolean>): T.Args {
  return {
    event_id: pos[1],
    title: flags.title, note: flags.note, location: flags.location,
    rrule: flags.rrule, label_id: flagNum(flags, 'label-id'),
    reminders: csvNums(flags.reminders),
    start: flags.start, end: flags.end, date: flags.date,
    all_day: flags['all-day'] === true ? true : undefined,
    tz: flags.tz, calendar_id: flags.calendar,
    occurrence_start: flags.occ, scope: flags.scope, gone: flags.gone === true ? true : undefined,
    shift_days: flagNum(flags, 'shift-days'), to_calendar_id: flags['to-calendar'],
    keep_recurrence: boolFlag(flags['keep-recurrence']),
  };
}

async function main() {
  const { pos, flags } = parseArgv(process.argv.slice(2));
  const cmd = pos[0] ?? 'help';
  const sub = typeof pos[1] === 'string' && !pos[1].startsWith('-') ? pos[1] : undefined;
  const json = flags.json === true;

  const cfg: Partial<ClientConfig> = {};
  if (typeof flags.base === 'string') cfg.base = flags.base;
  if (typeof flags.token === 'string') cfg.token = flags.token;
  if (typeof flags.tz === 'string') cfg.tz = flags.tz;
  const client = new Client(loadConfig(cfg));

  let result: unknown;

  switch (cmd) {
    case 'help': console.log(USAGE); return;

    case 'login': {
      if (typeof flags.email !== 'string' || typeof flags.password !== 'string') throw new ApiError(400, 'need --email and --password');
      const r = await client.call<{ session: string; user_id: string }>('POST', '/api/login',
        { body: { email: flags.email, password: flags.password } });
      saveConfig({ base: client.base, token: r.session });
      result = { ok: true, user_id: r.user_id, config: `session 已存入 ${client.base}` };
      break;
    }

    case 'token': {
      if (sub === 'create') result = await client.call('POST', '/api/agent-tokens', { body: { name: flags.name ?? 'agent' } });
      else if (sub === 'list') result = await client.call('GET', '/api/agent-tokens');
      else if (sub === 'revoke') result = await client.call('POST', '/api/agent-tokens/revoke',
        { body: { token: pos[2] ?? '' } });
      else throw new ApiError(400, 'token create|list|revoke <token>');
      break;
    }

    case 'whoami': result = await T.whoami(client); break;

    case 'calendars': result = await T.listCalendars(client); break;

    case 'use': {
      const id = pos[1];
      if (!id) throw new ApiError(400, 'use <calendar-id>');
      const cals = await T.listCalendars(client);
      if (!cals.some((c: any) => c.id === id)) throw new ApiError(404, 'no_such_calendar_or_not_member');
      saveConfig({ calendar: id });
      result = { ok: true, default_calendar: id };
      break;
    }

    case 'events': {
      const r = await T.listEvents(client, { from: flags.from, to: flags.to, days: flagNum(flags, 'days'), calendar_id: flags.calendar, tz: flags.tz });
      result = json ? r : `${r.count} 筆 (${r.from} → ${r.to}, ${r.tz})\n` + r.events.map((e: any) =>
        `  ${e.start}${e.end ? `–${e.end.slice(11)}` : ''}  ${e.title}${e.rrule ? ' ↻' : ''}  [${e.id}]`).join('\n');
      break;
    }

    case 'show': result = await T.getEvent(client, { event_id: pos[1] ?? failId() }); break;

    case 'add': result = await T.createEvent(client, eventArgs(pos, flags)); break;

    case 'quick': {
      const text = pos.slice(1).join(' ');
      if (!text) throw new ApiError(400, 'quick "自然語言句子"');
      result = await T.quickAdd(client, { text, confirm: flags.confirm === true, calendar_id: flags.calendar, tz: flags.tz });
      break;
    }

    case 'batch': {
      const file = typeof flags.file === 'string' ? flags.file : null;
      const raw = file ? readFileSync(file, 'utf8') : readFileSync(0, 'utf8');
      result = await T.createEvents(client, { events: JSON.parse(raw), calendar_id: flags.calendar, tz: flags.tz });
      break;
    }

    case 'update': result = await T.updateEvent(client, eventArgs(pos, flags)); break;

    case 'delete': result = await T.deleteEvent(client, eventArgs(pos, flags)); break;

    case 'override': result = await T.overrideOccurrence(client, eventArgs(pos, flags)); break;

    case 'copy': result = await T.copyEvent(client, eventArgs(pos, flags)); break;

    case 'dateinfo': result = await T.getDateInfo(client, {
      date: flags.date ?? pos[1], days: flagNum(flags, 'days'), tz: flags.tz,
    }); break;

    case 'members': result = await T.listVirtualMembers(client, { calendar_id: flags.calendar }); break;

    case 'member': {
      if (sub === 'add') result = await T.createVirtualMember(client, {
        calendar_id: flags.calendar, name: flags.name, account_type: flags.type,
        color: flags.color, birthday: flags.birthday,
        shows_birthday: boolFlag(flags['show-birthday']),
      });
      else if (sub === 'update') result = await T.updateVirtualMember(client, {
        virtual_id: pos[2], name: flags.name, account_type: flags.type,
        color: flags.color, birthday: flags.birthday,
        shows_birthday: boolFlag(flags['show-birthday']),
      });
      else if (sub === 'delete') result = await T.deleteVirtualMember(client, { virtual_id: pos[2] });
      else throw new ApiError(400, 'member add|update|delete <id>');
      break;
    }

    case 'memos': result = await T.listMemos(client, { calendar_id: flags.calendar }); break;

    case 'memo': {
      if (sub === 'add') result = await T.createMemo(client, {
        calendar_id: flags.calendar, title: flags.title, body: flags.body, pinned: boolFlag(flags.pinned),
      });
      else if (sub === 'update') result = await T.updateMemo(client, {
        memo_id: pos[2], title: flags.title, body: flags.body, pinned: boolFlag(flags.pinned),
      });
      else if (sub === 'delete') result = await T.deleteMemo(client, { memo_id: pos[2] });
      else throw new ApiError(400, 'memo add|update|delete <id>');
      break;
    }

    case 'free': {
      const r = await T.findFreeSlots(client, {
        date: flags.date, duration_minutes: flagNum(flags, 'duration'),
        window_start: flags.from, window_end: flags.to, calendar_id: flags.calendar, tz: flags.tz,
      });
      result = json ? r : `${r.date} ${r.window} 空檔 (≥${r.duration_minutes}分, ${r.tz}):\n` +
        (r.free.length ? r.free.map((f: any) => `  ${f.start.slice(11)}–${f.end.slice(11)}`).join('\n') : '  (沒有)');
      break;
    }

    case 'comment': {
      const id = pos[1];
      const body = pos.slice(2).join(' ');
      if (!id || !body) throw new ApiError(400, 'comment <event-id> <文字…>');
      result = await T.addComment(client, { event_id: id, body });
      break;
    }

    case 'labels': result = await T.listLabels(client, { calendar_id: flags.calendar }); break;

    case 'subscribe': result = await T.createSubscription(client, { days: flagNum(flags, 'days'), calendar_id: flags.calendar }); break;
    case 'subscriptions': result = await T.listSubscriptions(client, { calendar_id: flags.calendar }); break;
    case 'unsubscribe': result = await T.revokeSubscription(client, { token: pos[1] }); break;

    default:
      console.log(USAGE);
      process.exitCode = 2;
      return;
  }

  if (json || typeof result === 'object') console.log(JSON.stringify(result, null, 2));
  else console.log(String(result));
}

function failId(): never { throw new ApiError(400, 'event_id_required'); }

main().catch((e) => {
  const status = e instanceof ApiError ? e.status : 1;
  console.error(JSON.stringify({ error: String(e?.message ?? e), status }));
  process.exit(1);
});
