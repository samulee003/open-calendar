// Real end-to-end proof: boots the server, imports examples/lessons.csv through
// the actual CLI (spawned as a child process), then reads the calendar back and
// checks the recurrence, the all-day rows and the label mapping landed correctly.
import { makeServer } from '../src/server.ts';
import { freshStore } from '../src/db.ts';
import { mkdtempSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

const dir = mkdtempSync(join(tmpdir(), 'scal-e2e-'));
const store = freshStore(dir);
const server = makeServer(store);
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${(server.address() as any).port}`;

let pass = 0, fail = 0;
const ok = (label: string, cond: boolean, extra = '') => {
  if (cond) { pass++; console.log('ok   ' + label); }
  else { fail++; console.log(`FAIL ${label} ${extra}`); }
};

// must not use spawnSync: the parent event loop has to stay free to serve the child
function run(args: string[]): Promise<{ stdout: string; stderr: string; status: number }> {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, args, { cwd: process.cwd() });
    let stdout = '', stderr = '';
    p.stdout.on('data', (d) => { stdout += d; });
    p.stderr.on('data', (d) => { stderr += d; });
    p.on('close', (status) => resolve({ stdout, stderr, status: status ?? -1 }));
  });
}

const signup = await fetch(`${base}/api/signup`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'e2e@x.tw', name: 'Family', password: 'password1', tz: 'Asia/Taipei' }),
});
const cookie = signup.headers.get('set-cookie')!.split(';')[0];
const auth = { cookie, 'content-type': 'application/json' };
const cal = await (await fetch(`${base}/api/calendars`, { method: 'POST', headers: auth, body: JSON.stringify({ name: 'Family' }) })).json();
const label = await (await fetch(`${base}/api/calendars/${cal.id}/labels`, { method: 'POST', headers: auth, body: JSON.stringify({ name: '才藝', color: '#6aa84f' }) })).json();
ok('label creation returns its own id', Number(label.id) > 0, JSON.stringify(label));

const csv = join(dir, 'lessons.csv');
copyFileSync('examples/lessons.csv', csv);
const cli = ['scripts/import-timetree.ts', '--url', base, '--email', 'e2e@x.tw',
  '--password', 'password1', '--calendar', 'Family', '--file', csv];

const dry = await run([...cli, '--dry-run']);
ok('dry-run parses every row', /7 筆可匯入/.test(dry.stdout), dry.stdout + dry.stderr);
const afterDry = await (await fetch(`${base}/api/events?from=1&to=99999999999999`, { headers: auth })).json();
ok('dry-run writes nothing', Array.isArray(afterDry) && afterDry.length === 0, JSON.stringify(afterDry).slice(0, 120));

const real = await run(cli);
ok('import reports 7 rows created', /已匯入 7 筆/.test(real.stdout), real.stdout.slice(0, 300) + real.stderr.slice(0, 400));
ok('every label matched the calendar', !/標籤在此日曆不存在/.test(real.stdout), real.stdout.slice(0, 200));

const rows = await (await fetch(`${base}/api/events?from=${Date.UTC(2026, 9, 25)}&to=${Date.UTC(2027, 2, 1)}`, { headers: auth })).json();
ok('imported events are visible', Array.isArray(rows) && rows.length >= 10, `got ${rows.length}`);
ok('weekly 游泳課 expands past its anchor', rows.filter((r: any) => r.title === '游泳課').length >= 3,
  `${rows.filter((r: any) => r.title === '游泳課').length}`);
ok('label resolved by name', rows.some((r: any) => r.label_name === '才藝'));
const allDay = rows.filter((r: any) => r.title === '奶奶生日')[0];
ok('all-day row marked all_day', allDay?.all_day === true);
ok('all-day row is UTC midnight of that calendar day',
  new Date(allDay.start_at).toISOString() === '2026-12-24T00:00:00.000Z', String(allDay?.start_at));
ok('note landed', rows.some((r: any) => r.note === '記得帶譜'), JSON.stringify(rows.slice(0, 2)));

const sub = await (await fetch(`${base}/api/calendars/${cal.id}/subscription`, { method: 'POST', headers: auth, body: '{}' })).json();
const ics = await (await fetch(base + sub.path)).text();
ok('phone subscription carries imported events', ics.includes('SUMMARY:大提琴課'));
ok('phone subscription carries the weekly rule', ics.includes('RRULE:FREQ=WEEKLY;BYDAY=TH'));
ok('phone subscription carries all-day form', ics.includes('DTSTART;VALUE=DATE:20261224'));

server.close();
store.db.close();
try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows may hold the WAL briefly */ }
console.log(fail ? `\n${fail} FAILED of ${pass + fail}` : `\n${pass} passed`);
process.exitCode = fail ? 1 : 0;
