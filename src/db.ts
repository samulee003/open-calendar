import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

export type Row = Record<string, string | number | null | undefined>;

const SCHEMA = `
pragma journal_mode = wal;
pragma foreign_keys = on;

create table if not exists users (
  id         text primary key,
  email      text not null unique,
  name       text not null,
  pass_hash  text not null,
  pass_salt  text not null,
  tz         text not null default 'UTC',
  created_at integer not null
);

create table if not exists sessions (
  token      text primary key,
  user_id    text not null references users(id) on delete cascade,
  created_at integer not null,
  expires_at integer not null
);

create table if not exists calendars (
  id         text primary key,
  name       text not null,
  color      text not null default '#4a90d9',
  owner_id   text not null references users(id) on delete cascade,
  created_at integer not null
);

create table if not exists members (
  calendar_id text not null references calendars(id) on delete cascade,
  user_id     text not null references users(id) on delete cascade,
  role        text not null default 'member',
  joined_at   integer not null,
  primary key (calendar_id, user_id)
);

create table if not exists invites (
  code        text primary key,
  calendar_id text not null references calendars(id) on delete cascade,
  created_by  text not null references users(id) on delete cascade,
  created_at  integer not null
);

create table if not exists labels (
  id          integer primary key autoincrement,
  calendar_id text not null references calendars(id) on delete cascade,
  name        text not null,
  color       text not null default '#888888',
  position    integer not null default 0
);

create table if not exists events (
  id          text primary key,
  calendar_id text not null references calendars(id) on delete cascade,
  title       text not null,
  note        text not null default '',
  location    text not null default '',
  all_day     integer not null default 0,
  start_at    integer not null,
  end_at      integer not null,
  tz          text not null default 'UTC',
  label_id    integer references labels(id) on delete set null,
  rrule       text,
  exdates     text not null default '[]',
  created_by  text not null references users(id),
  created_at  integer not null,
  updated_at  integer not null,
  deleted_at  integer
);

create index if not exists events_cal_start on events (calendar_id, start_at);

-- Single-occurrence edits and deletions, keyed by the occurrence's original start.
create table if not exists overrides (
  event_id    text not null references events(id) on delete cascade,
  orig_start  integer not null,
  title       text,
  note        text,
  location    text,
  all_day     integer,
  start_at    integer,
  end_at      integer,
  gone        integer not null default 0,
  primary key (event_id, orig_start)
);

create table if not exists attendees (
  event_id text not null references events(id) on delete cascade,
  user_id  text not null references users(id) on delete cascade,
  response text not null default 'none',
  primary key (event_id, user_id)
);

create table if not exists reminders (
  event_id    text not null references events(id) on delete cascade,
  minutes     integer not null,
  primary key (event_id, minutes)
);

create table if not exists comments (
  id         text primary key,
  event_id   text not null references events(id) on delete cascade,
  user_id    text not null references users(id) on delete cascade,
  body       text not null,
  created_at integer not null,
  deleted_at integer
);

create table if not exists reactions (
  event_id text not null references events(id) on delete cascade,
  user_id  text not null references users(id) on delete cascade,
  emoji    text not null,
  primary key (event_id, user_id, emoji)
);

-- Read-only subscription tokens so a phone calendar app can pull ICS without a password.
create table if not exists subscriptions (
  token       text primary key,
  calendar_id text not null references calendars(id) on delete cascade,
  created_by  text not null references users(id),
  created_at  integer not null
);
`;

export function openDb(path: string): DatabaseSync {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);
  return db;
}

export class Store {
  db: DatabaseSync;
  constructor(db: DatabaseSync) { this.db = db; }

  all(sql: string, ...p: unknown[]): Row[] { return this.db.prepare(sql).all(...(p as never[])) as Row[]; }
  get(sql: string, ...p: unknown[]): Row | undefined { return this.db.prepare(sql).get(...(p as never[])) as Row | undefined; }
  run(sql: string, ...p: unknown[]) { return this.db.prepare(sql).run(...(p as never[])); }
}

export function freshStore(dataDir: string): Store {
  return new Store(openDb(join(dataDir, 'calendar.db')));
}
