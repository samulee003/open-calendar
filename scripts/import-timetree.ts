// Import events from a CSV/TSV file into one calendar via the batch endpoint.
//
//   node scripts/import-timetree.ts --url http://127.0.0.1:8787 --email me@x.tw \
//        --password secret --calendar <calendar_id 或名稱> --file lessons.csv [--dry-run]
//
// Parsing lives in src/import-lib.ts (unit-tested by scripts/test-import.ts).
// Header aliases are matched tolerantly because export headers differ by locale;
// nothing here has been verified against a live TimeTree export file. If a real
// export does not map, the tool prints the header row and stops instead of guessing.

import { readFile } from 'node:fs/promises';
import { parseCsv } from '../src/import-lib.ts';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

const base = arg('url') ?? 'http://127.0.0.1:8787';
const file = arg('file');
const usage = '用法: node scripts/import-timetree.ts --url URL --email E --password P --calendar ID或名稱 --file data.csv [--dry-run]';

if (!file || !arg('email') || !arg('password') || !arg('calendar')) {
  console.log(usage);
  process.exitCode = 2;
} else {
  const { events, skipped } = parseCsv(await readFile(file, 'utf8'));
  for (const s of skipped) console.log('跳過 ' + s);
  if (!events.length) {
    console.log('沒有可匯入的列');
    process.exitCode = 1;
  } else if (flag('dry-run')) {
    console.log(`[dry-run] ${events.length} 筆可匯入：`);
    for (const e of events.slice(0, 10)) console.log(`  ${new Date(e.start_at).toISOString().slice(0, 16).replace('T', ' ')} ${e.title}${e.rrule ? ` (${e.rrule})` : ''}`);
    if (events.length > 10) console.log(`  …共 ${events.length} 筆`);
  } else {
    const login = await fetch(`${base}/api/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: arg('email'), password: arg('password') }),
    });
    if (!login.ok) { console.log('登入失敗：' + (await login.text())); process.exitCode = 1; }
    else {
      const cookie = login.headers.get('set-cookie')!.split(';')[0];
      const want = arg('calendar')!;
      const cals = await (await fetch(`${base}/api/calendars`, { headers: { cookie } })).json();
      const cal = cals.find((c: any) => c.id === want || c.name === want);
      if (!cal) { console.log(`找不到日曆：${want}（可用: ${cals.map((c: any) => c.name).join(', ')}）`); process.exitCode = 1; }
      else {
        // resolve 標籤 names to this calendar's label ids; unknown names stay as note text
        const labels = await (await fetch(`${base}/api/calendars/${cal.id}/labels`, { headers: { cookie } })).json();
        const byName = new Map(labels.map((l: any) => [String(l.name).toLowerCase(), Number(l.id)]));
        let unmatchedLabels = 0;
        for (const e of events) {
          const raw = String((e as any).__label ?? '').trim().toLowerCase();
          delete e.__label;
          if (!raw) continue;
          if (byName.has(raw)) e.label_id = byName.get(raw);
          else unmatchedLabels++;
        }
        if (unmatchedLabels) console.log(`${unmatchedLabels} 列的標籤在此日曆不存在，已忽略`);
        const out = await (await fetch(`${base}/api/calendars/${cal.id}/events/batch`, {
          method: 'POST', headers: { 'content-type': 'application/json', cookie },
          body: JSON.stringify({ events }),
        })).json();
        console.log(`已匯入 ${out.created} 筆到「${cal.name}」` + (out.failed?.length ? `，失敗 ${out.failed.length} 筆` : ''));
        for (const f of out.failed ?? []) console.log(`  第 ${f.index + 1} 筆：${f.reason}`);
        process.exitCode = out.failed?.length ? 1 : 0;
      }
    }
  }
}
