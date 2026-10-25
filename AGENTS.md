# AGENTS.md

這份檔案是寫給 **AI agent** 看的。兩種角色都在这里:

- **A 部:操作這個日曆的 agent**(用 MCP / CLI / REST 幫使用者排行程)。
- **B 部:改這個程式碼的 agent**(修 bug、加功能、跑測試)。

人類讀者請先看 [README.md](README.md)。

---

# A 部:操作日曆

## 先確認你是誰、能做什麼

```
whoami            → { id, email, name, tz }
list_calendars    → 你被授權的日曆(id、role、member_count)
```

連線設定來自環境變數(或 `~/.shared-calendar-agent.json`):

| 變數 | 意義 |
|---|---|
| `CAL_BASE` | 伺服器位址,例如 `http://127.0.0.1:8787` |
| `CAL_TOKEN` | `cal_…` 開頭的 agent token。**不要把它寫進任何回應或 log** |
| `CAL_CALENDAR` | 預設日曆 id。設了它,大部分工具不必再傳 `calendar_id` |
| `CAL_TZ` | 預設 IANA 時區,用來解讀「沒寫時區」的時間字串 |

Token 有 scope:`read`(GET)、`write`(POST/PUT)、`delete`(DELETE)。
收到 `403 insufficient_scope` 時,**不要重試同一個動作**,改請使用者授權或直接說明限制;
錯誤裡有 `required` 欄位告诉你缺哪個。

## 工具清單(29 個)

| 群 | 工具 |
|---|---|
| 讀 | `whoami` `list_calendars` `list_events` `get_event` `list_labels` `list_virtual_members` `list_memos` `list_subscriptions` `list_trash` `find_free_slots` `get_date_info` |
| 寫 | `create_event` `create_events` `quick_add` `update_event` `override_occurrence` `copy_event` `add_comment` `create_virtual_member` `update_virtual_member` `create_memo` `update_memo` `create_subscription` |
| 刪 | `delete_event` `delete_virtual_member` `delete_memo` `revoke_subscription` |
| 還原 | `restore_event` `restore_occurrence` |

## 時間語意(最容易出錯的地方)

可以傳的時間格式:

1. **epoch 毫秒**(最保險)。`list_events` 每筆都附 `start_at` / `end_at` / `occurrence_start`,
   要餵回其他工具時**用這些 epoch,不要用顯示字串**。
2. **epoch 秒**:10 位數自動當成秒(會 ×1000),不會被當成 1970 年。
3. **ISO 8601 含時區**:`2026-11-05T14:00:00+08:00`、`2026-11-05T06:00:00Z`。
4. **裸日期/時間**:`2026-11-05`、`"2026-11-05 14:00"` → 依 `tz` 參數或帳號時區的**牆上時間**解讀。

不要做的事:

- 不要把 `"2026-11-05 (all-day)"` 這類**顯示用標籤**傳回去 —— 會被直接拒絕(`bad_time`)。
  全天事件的日期請用 `date`,或傳 epoch。
- 不要假設伺服器跟你的時區相同;`get_event` 用事件自己的時區標時間,
  `list_events` 用呼叫端/帳號的時區標時間。比對時請比 epoch。
- 重複事件的「某一次」以 **`occurrence_start`(原始時間 epoch)** 為 key,不是顯示時間。
  `override_occurrence` / `delete_event(scope=occurrence)` 都要它;傳了不存在的時刻會被拒絕
  (`occurrence_not_found`)而不會假裝成功。

## 重複、例外、刪除、還原的規則

- `rrule` 收 RFC 5545 字串,可不含 `RRULE:` 前綴。支援
  `FREQ=DAILY|WEEKLY|MONTHLY|YEARLY`、`INTERVAL`、`BYDAY`、`BYMONTHDAY`(含 `-1`)、`BYMONTH`、`COUNT`、`UNTIL`。
  不支援 `BYSETPOS`、`WKST`、時區型 `UNTIL`。
- 展開在**事件時區的牆上時間**做,所以「台北週一 01:00」的課不會被 UTC 拉到週日/週二。
- 三種刪除,語意不同:
  - `scope=all` 整串(可 `restore_event` 還原)。
  - `scope=occurrence` 只刪那一天(寫 `EXDATE`;用 `restore_occurrence` 還原)。
  - `scope=future` 從那天起切斷系列,之前保留(**這個沒有還原工具**,要改 `update_event` 重設 `rrule`)。
- 「只改這一次」用 `override_occurrence`,不是 `update_event`(後者動整串)。
- `copy_event` 預設**不**帶重複規則;要複製成新的系列才給 `keep_recurrence: true`。
  指定 `occurrence_start` 複製某一次時,複製的是**那一次實際看到的樣子**(含 override 後的標題/時間)。
- 刪除是軟刪除。`list_trash`(預設最近 30 天,只列整筆刪除)→ `restore_event`。

## 寫入安全

- **重試要帶 `request_id`**:`create_event` / `create_events` / `quick_add` / `copy_event` 都支援。
  同一個 key 在 7 天內重送,會回傳第一次的結果(同一個 id),不會多一筆。
  同 key 換內容會回 `409 idempotency_key_reused` —— 那是你的 bug,換一個 key。
- 批次:`create_events` 一次最多 500 筆,回 `{created, ids, failed:[{index, reason}]}`。
  **部分失敗是正常的**,請讀 `failed` 而不是假設全成功。
- `quick_add` 在解析沒把握時回 `needs_confirmation: true` 而**不會寫入**。
  此時該問使用者,而不是自己猜;確認後帶 `confirm: true` 重送。
- 大量破壞性操作(例如「把下學期的課都刪掉」)前先 `list_events` 列出會動到哪些筆,
  取得人類確認,再逐一或批次處理。

## 錯誤碼 → 該做什麼

| 錯誤 | 意義 | 你該做 |
|---|---|---|
| `need_login` (401) | token 無效或已撤銷 | 停止,請使用者重新發 token |
| `insufficient_scope` (403) | 缺 `read`/`write`/`delete` | 看 `required` 欄位,請使用者授權;別重試 |
| `session_required` (403) | 該操作只給瀏覽器 session(如發 token) | 請使用者自己在網頁做 |
| `not_a_member` (403) | 那個日曆你不屬於 | 換 `calendar_id` 或先 `list_calendars` |
| `bad_time: …` | 時間看不懂 | 改傳 epoch;標籤類字串請改用 `start_at` |
| `occurrence_not_found` | 那個時刻不是此系列的出現 | 先 `list_events` 取正確的 `occurrence_start` |
| `bad_rrule` / `not_recurring` | 規則不支援或事件不重複 | 改用支援的 RRULE 屬性 |
| `bad_virtual_member:<id>` | 該虛擬成員不屬於這個日曆 | 先 `list_virtual_members`,別跨日曆引用 |
| `needs_confirmation` | 自然語言解析沒把握(200,不是錯誤) | 問使用者,或帶 `confirm` 重送 |
| `idempotency_key_reused` (409) | 同 key 不同內容 | 換 key |
| `too_many_attempts` (429) | 登入限速 | 等 15 分鐘,別繼續試密碼 |
| `title_required` / `start_required` / `text_required` | 欄位缺漏 | 補齊再送 |

## 省 token 的讀法

- `list_events` 預設「今天起 31 天」,`days` 上限 400。要查更遠就分段,不要一次開很大。
- 回傳已精簡(空欄位移除),每筆含 `id`、`occurrence_start`、`start_at`/`end_at`、`title`、
  `start`(本地標籤)、`rrule`、`label`、`location`、`comment_count`。
- 只要「有沒有空」就別抓全部行程,用 `find_free_slots`。
- 只要「這天是不是假日」用 `get_date_info`,不要抓整天行程自己判斷。
  注意它只涵蓋 2026–2027,範圍外會回 `holiday_known: false` —— 那是「不知道」,不是「要上班」。

---

# B 部:改這個程式碼

## 必須知道的硬性規則

1. **零執行期相依需求**。不准加 `dependencies`;不准 `npm install`。只用 Node 24 內建
   (`node:sqlite`、`node:http`、`node:crypto`、`Intl`)。
2. **`.ts` 直接跑,沒有 build**。型別註解要能被 Node 的 type stripping 吃(不要 `enum`、
   不要 namespace、不要參數屬性)。
3. **一個行為只有一個落點**。路由與欄位驗證在 `src/api.ts`;agent 工具的共同實作在
   `src/agent-tools.ts`,`src/cli.ts` 與 `src/mcp.ts` 只是薄殼 —— 新行為要同時出現在兩個入口,
   但**邏輯只能寫在 agent-tools 一次**。
4. **測試要跑真的**。新增路由/工具時,在 `scripts/test-agent.ts` 或 `scripts/selftest.ts` 加斷言:
   真啟動伺服器、真走 HTTP、真 spawn 子行程。不要用 mock 假裝通過。
   小心「永遠不會失敗的斷言」:`ok(label, someString, expected)` 是**錯的**(字串恆真),
   第三參數只是失敗時的說明文字。
5. **不要宣示沒做過的事**。README/註解裡的功能要能實際跑;測量值、驗證狀態要如實標註,
   沒驗證就寫「未驗證」。

## 指令

```bash
export PATH="/d/rea-toolchain/node-v24.18.0-win-x64:$PATH"   # 本機 Node 24
bash scripts/check.sh          # 七組全跑(302 條斷言)
NODE=/path/to/node bash scripts/check.sh
node scripts/selftest.ts       # 單跑一組
node --experimental-strip-types ...   # 不需要,Node 24 直接跑 .ts
```

`npm test` / `npm start` 只有 PATH 上的 `node` 是 24+ 才會通。
系統若只有 Node 22.17,`.ts` 會報 `ERR_UNKNOWN_FILE_EXTENSION` —— 這是環境問題,不是程式 bug,
改用 `scripts/check.sh` 加 `NODE=`。

## 架構與所有權

```
public/app.js  ──►  src/server.ts  ──►  src/api.ts(路由=唯一驗證點)──►  src/db.ts
                        │                    ▲
   src/cli.ts ──┐      ├─ cookie session     │
   src/mcp.ts ──┴──► src/agent-tools.ts ── src/client.ts(REST 呼叫)
                          │
                    src/nlp.ts / rrule.ts / tz.ts / ics.ts / holidays.ts
```

- `api.ts` 的 `routes` 物件是**唯一**的路由表,key 是 `'METHOD /path/:param'`;`server.ts` 編譯它。
  回傳 `raw` 表示直接輸出字串(ICS 用),回傳 `session` 才會設 cookie(別亂加叫 `token` 的欄位)。
- 鑑權在 `server.ts` 解析:cookie 優先,bearer 其次;`ctx.via` 是 `'cookie' | 'token' | null`。
  **只有瀏覽器 session 能管理 token**(`needSession`)。scope 在路由前就擋掉。
- `occurrences()`(api.ts)是重複展開的唯一出口:list、ICS、工具都讀它的結果。
- 軟刪除用 `deleted_at`;`overrides` 表存單次修改,`exdates`(JSON 的 `YYYY-MM-DD`)存單次刪除。
  三者語意不同,別混。

## 不可退讓的不變性(動這些檔前先看)

| 不變性 | 在哪 | 破壞會怎樣 |
|---|---|---|
| 所有前端輸出走 `textContent` | `public/app.js` 的 `el()` | 其他家庭成員寫的標題變成 XSS 載具 |
| SQL 一律預留參數 | `src/db.ts` 的 `Store` | 注入 |
| ICS 值要轉義 `\ ; , CR LF`、行長 ≤75 octet | `src/ics.ts` `esc()`/`fold()` | 標題可偽造 `DESCRIPTION:`/`ATTACH:` 行 |
| 重複在**事件時區**展開,ICS 要帶 `TZID`+`VTIMEZONE` | `src/rrule.ts`、`src/ics.ts` | 手機把週一 01:00 的課顯示成別天 |
| 全天事件 `DTEND` 是**排他的次日** | `src/ics.ts` | 手機顯示成兩天 |
| 建立時 `request_id` 只存一次結果 | `src/api.ts` idempotency | agent 重試就多出重複行程 |
| 刪除是軟刪除,`restore` 只清 `deleted_at` | `src/api.ts` | 誤刪救不回來 |
| 虛擬成員隸屬單一CALENDAR,掛行程時要同Calendar | `src/api.ts` `virtualIds` | 跨日曆引用、資料串味 |
| 遷移只能新增,且對既有 DB 冪等 | `src/db.ts` `MIGRATIONS` | 使用者唯一的資料庫被打壞 |

## 已知地雷(踩過)

- **Windows cp950**:`curl.exe -d` 或 shell 內含中文會被壓成 `?`。要送中文請用檔案 body
  (`--data-binary "@file.json"`)或直接寫 Node 腳本本機 `fetch`。
- **`spawnSync` 會死鎖**:當測試行程自己就是被測 HTTP server 時,用非同步 `spawn`。
- **WAL 檔鎖**:測試結束後 `rmSync(tempDir)` 可能 EPERM,先 `store.db.close()` 並等 `server.close()` 回調。
- **久跑的 SPA/伺服器分頁**:背景分頁的 timer 會被凍結(瀏覽器驗證時)。
- **`new URL(path, base)` 會吃掉 base 的子路徑**;拼完整 URL 時用字串串接(見 `createSubscription`)。
- 多個行程共用同一個 SQLite:伺服器 + CLI + MCP 同時寫會碰鎖,寫入保持短小事務。

## 驗證清單(提交前)

1. `bash scripts/check.sh` 全綠,且**新行為有新斷言**(不是只改舊斷言)。
2. 動到 UI:用瀏覽器實際點過(桌面寬度 + 390×844),不是只有 `node --check`。
   注意 `node --check` 不支援 `.ts`,只能驗 `.js`。
3. 動到 ICS:抓一份實際輸出,檢查 `BEGIN:VTIMEZONE`、`DTSTART;TZID=`、`DTEND` 是否正確。
4. 動到 token/scope/冪等:`scripts/test-agent.ts` 涵蓋了拒權、重送、409、還原,別繞過它。
5. 更新 README(人類)與本檔(agent)中受影響的事實:工具數、指令、限制。
   兩者都要**如實**;沒做的功能寫在「刻意沒做的」裡,不要留在功能表。
6. Conventional Commit 主旨(`feat:` / `fix:` / `docs:`),主旨描述行為而不是檔案。

## 刻意不做的事(別「順手」加)

移除成員、日曆改名/刪除/退出、標籤改名、RSVP、附件、公開分享頁、推播/Webhook、
CalDAV 雙向同步、多節點、TOTP、audit log、HTTPS。
這些需要 maintainer 的範圍決定,不是實作疏漏。要加先問。
