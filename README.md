# shared-calendar

**一個自己架、自己擁有資料的家庭共享日曆 —— 人用起來像 TimeTree,AI agent 也能和人一樣可靠地操作它。**

家人看同一份行程、在行程下留言按讚;同一份日曆,你的 AI 助理(例如 Qoder 這類支援 MCP 的 agent)
也能幫你查、排、改、還原。資料就是你機器上的一個 SQLite 檔。
只要 Node.js 24+,**沒有 `npm install`、沒有 build、沒有資料庫伺服器、沒有第三方執行期相依**。

> 這是 clean-room 實作:功能邊界參考了現有共享日曆產品的公開行為,
> 程式碼、schema、介面文字都是這裡自己寫的,不含任何第三方產品的原始碼或素材。

## 這個專案真正要解決什麼

| 目標 | 具體的意思 |
|---|---|
| **家人共用一份真實行程** | 同一個日曆的人看到同樣的行程、留言、按讚;小孩、寵物、車也能掛在行程上(不需要帳號);手機看得到、會響鈴 |
| **資料自己擁有** | 自架、單檔 SQLite、可備份、可用 ICS 訂閱帶走;不依賴任何雲端服務,也不需要誰的帳號 |
| **AI agent 是一等使用者** | 不是事後加的 API:CLI、MCP server、REST 共用同一份實作;token 可分權、可撤銷;寫入可安全重試;出錯給穩定錯誤碼與下一步建議 |

設計上堅持的幾件事(它們比功能多寡更重要):

- **不亂猜**:自然語言解析沒把握就先問、不寫入;看不懂的時間字串直接拒絕;不支援的重複規則回 `bad_rrule`,而不是靜默忽略。
- **做錯救得回來**:刪除是軟刪除,最近 30 天可一鍵還原。
- **只講做過的事**:沒驗證過的就寫「未驗證」,沒做的功能寫在「刻意沒做的」,不留在功能表裡。
- **在地化**:繁體中文介面、澳門公眾假期、以 IANA 時區在**當地牆上時間**展開重複事件。

這**不是**:多人 SaaS、原生行動 app、需要水平擴展的服務。單機、單一 SQLite,一個家庭夠用。

## 你是哪一種讀者?

| 我是…… | 請讀 |
|---|---|
| 想自己架來用的人、家人 | [**第一部分:給人類**](#humans)(安裝、使用、手機、部署、備份、安全) |
| 要「操作日曆」的 AI agent | [**第二部分:給 AI Agent**](#agents),再讀 [AGENTS.md](AGENTS.md) 的 **A 部** |
| 要「改這個程式碼」的人或 agent | [**開發者參考**](#dev),再讀 [AGENTS.md](AGENTS.md) 的 **B 部** |

---

<a id="humans"></a>

# 第一部分:給人類

## 快速開始

原始碼是 `.ts`,由 Node 直接執行,沒有 build 步驟。**需要 Node 24+**;
22.17 之類的舊 `node` 會報 `ERR_UNKNOWN_FILE_EXTENSION`。

```bash
node src/server.ts
# → shared-calendar listening on http://127.0.0.1:8787  (data: .../data)
```

打開 http://127.0.0.1:8787 註冊第一個帳號,系統會自動建立你的個人日曆與三個標籤(工作／家庭／個人)。
接著在「日曆／邀請」產生邀請碼,家人註冊後用邀請碼加入同一個日曆。

| 環境變數 | 預設 | 說明 |
|---|---|---|
| `PORT` | `8787` | 只綁 `127.0.0.1`,要給別人看請自行放 proxy(見「部署與備份」) |
| `DATA_DIR` | `<專案>/data` | SQLite 檔(`calendar.db` + WAL)所在目錄,換目錄就是換一個資料庫 |
| `TRUST_PROXY` | 未設定 | 設 `1` 才信任 `X-Forwarded-For` / `X-Forwarded-Proto`(限速與同源檢查用) |

Windows 想開機自動啟動:`start-server.cmd` 設定 `PORT` / `DATA_DIR` 並啟動 node,
`start-server.vbs` 是它的無視窗包裝(放進「啟動」資料夾即可,不需要系統管理員權限)。
**兩個檔案裡的路徑是作者自己機器的路徑,請先改成你的。**

## 它能做什麼

| | |
|---|---|
| 多日曆與成員 | 邀請碼加入;同日曆的人看得到同一份行程、留言、按讚 |
| 行程 | 標題、時間或全天、地點、備註、標籤、通知(開始前 N 分鐘) |
| 重複 | RFC 5545 `RRULE` 子集:`DAILY/WEEKLY/MONTHLY/YEARLY`、`INTERVAL`、`BYDAY`、`BYMONTHDAY`(含 `-1`)、`BYMONTH`、`COUNT`、`UNTIL`;無法忠實展開的屬性(`BYSETPOS`、`WKST`、`YEARLY` 的 `BYDAY` 等)會被**明確拒絕**(`bad_rrule`),不是靜默忽略 |
| 單次例外 | 「只改這一次」寫 override;「只刪這一次」寫 `EXDATE`;「刪這天以後」改寫 `UNTIL` |
| 家庭成員 | 沒有帳號的人(小孩、寵物、車…)可建成**虛擬成員**掛在行程上;刪成員會自動清掉標記 |
| 複製行程 | 複製整筆或重複系列的**某一次**到新時間/另一個日曆,可選帶走重複規則 |
| 備忘 | 不屬於任何行程的日曆級筆記,可置頂 |
| 搜尋與詳情 | 標題/備註/地點關鍵字、標籤篩選;`detail=full` 一次帶回備註、提醒與虛擬成員(CLI/MCP) |
| 誤刪救援 | 刪除是軟刪除;「垃圾桶」列出最近 30 天,可一鍵還原(網頁、CLI、MCP 都有) |
| 自然語言新增 | 「明天下午3點看牙醫」「每週四 19:00 鋼琴課」,以**使用者時區**解讀(與伺服器時區無關);沒把握時先問,不亂猜 |
| 澳門假期 | 公眾假期與補假查詢(2026–2027 官方表),可問「這天放假嗎」「下一個假期」 |
| 批次匯入 | 一次 500 筆;網頁貼一行一筆,或 CLI 讀 CSV |
| 手機同步 | 每個日曆可產生**唯讀 ICS 訂閱網址**,並帶 `VALARM` 讓手機自己響鈴 |
| 時區 | 依 IANA 時區名在**當地牆上時間**展開重複;ICS 輸出帶 `TZID` + `VTIMEZONE`,不會把手機上的星期算錯一天 |

### 目前刻意沒做的

避免誤會,這些**沒有**實作:移除成員、日曆改名/刪除/退出、標籤改名、行程附件、
RSVP、公開分享頁、伺服器推播、Webhook、多節點擴展。邀請碼不會過期。
`GET /api/calendars/:id/members` 只列成員,沒有踢人路由。

## 手機怎麼用

**A. 手機瀏覽器(推薦,功能完整)。** 同一網址登入即可。1000px 以下版面變成:
上方可橫向滑動的日曆/標籤列、日期詳情以底部面板開啟、輸入框 16px(iOS 不會整頁放大)。
「加入主畫面」後以 standalone 啟動(附 `manifest.webmanifest` 與 service worker)。
Service worker **只快取介面**,不快取 `/api` 與 `/ics`,離線時看到的是介面而非過期資料。

**B. 訂閱進手機內建日曆(唯讀)。** 「手機訂閱」產生 `/ics/<token>.ics`,
iPhone 內建日曆、Android 的 DAVx⁵／Calendri 都能收。提醒由手機的日曆 app 依 `VALARM` 響。
訂閱是唯讀的:看不到留言與按讚;手機抓新資料的頻率由該 app 自己決定(通常 15–60 分鐘),
所以在別處改完不會立刻出現在手機上。

訂閱連結**預設一年後失效**,對話框會顯示到期日、上次讀取時間,可隨時撤銷。
拿到網址的人都能讀那個日曆,請當成密碼保管。

## 批次匯入與搬家

網頁右上角「批次匯入」,每行一筆:

```
2026-11-05 14:00-15:00 大提琴課
2026-11-12 全天 奶奶生日
2026-12-03 15:00-16:00 古箏班 每週
```

從別的日曆 app 的匯出檔(CSV)搬過來,用 CLI:

```bash
node scripts/import-timetree.ts --email me@x.tw --password '...' \
  --calendar 家庭 --file examples/lessons.csv --dry-run
```

`--dry-run` 只解析不寫入。表頭比對支援中/英/日常用欄名(見 `src/import-lib.ts`);
比對不到時它會**把表頭印出來並停止**,不會亂猜對映。想先看對映結果:

```bash
node scripts/import-timetree.ts --file export.csv --headers
```

支援的日期寫法:`2026-11-05`、`2026/11/5`、`2026年11月5日`、`2026-11-05T14:00`、
`November 5, 2026`;時間支援 `14:00`、`14:00:00`、`2:00 PM`。
`05/11/2026` 這種日/月順序不明的寫法**故意拒絕**。

⚠️ 別名表是照常見匯出格式寫的,**尚未用一份真實的 TimeTree 匯出檔驗證過**,第一次用請先 `--dry-run`。

## 部署與備份

預設只監聽 `127.0.0.1`,要讓家人從手機用,三條路(由簡到繁):

1. **Tailscale**(建議):機器裝 tailscale,家人也裝,直接用 `http://<tailscale-ip>:8787`。
   不需要公開埠,也不需要自己管憑證。
2. **反向代理 + HTTPS**:caddy/nginx 擋在前面,設 `TRUST_PROXY=1`(否則限速會把所有人都看成 proxy,
   同源檢查也會把 https 的 Origin 擋掉)。
3. **公開到網際網路**:先補 HTTPS、備份,再考慮(見下方「安全邊界」)。

> ⚠️ **註冊是開放的**:任何連得到這個網址的人都能自己建立帳號(只會得到他自己的個人日曆,
> 看不到你們的日曆,但仍會佔用你的資源)。目前沒有「只限邀請」的開關,
> 所以不要在沒有網路層限制(如 Tailscale)的情況下直接公開。

備份就是備份 `DATA_DIR`(建議用 SQLite 的 backup API,不要在運行中直接複製單一檔):

```bash
node -e "const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync('data/calendar.db',{readOnly:true});
db.prepare('vacuum into ?').run('backup-'+new Date().toISOString().slice(0,10)+'.db');db.close();"
```

還原演練做一次就好:把備份檔指到新的 `DATA_DIR` 啟動,確認行程還在。

## 安全邊界(已知,不是沒做)

- 寫入請求做同源檢查;session cookie 是 `SameSite=Lax` + HttpOnly,跨站 POST 直接 403。
  放在 TLS proxy 後面時,`TRUST_PROXY=1` 才會用 `X-Forwarded-Proto` 判斷來源協定。
- **登出會真的作廢 session**(刪除該 cookie 對應的列,並讓瀏覽器丟掉 cookie)。
- 密碼 scrypt 加鹽,不會出現在 log;SQL 全部預留參數,沒有字串拼接。
- **登入限速**:15 分鐘內同一 email 失敗 8 次、或同一 IP 失敗 30 次回 429。
- 回應帶 `Content-Security-Policy`(無 inline script)、`X-Content-Type-Options: nosniff`、
  `X-Frame-Options: DENY`、`Referrer-Policy: no-referrer`。
- 前端所有文字一律走 `textContent`;行程標題與備註(由**其他家庭成員**撰寫)永遠不會變成 markup。
- ICS 輸出會轉義 `\`、`\r`、`\n`、`;`、`,`,標題偽造不出 `DESCRIPTION:` 之類的屬性行(有測試)。
- 日曆/標籤/虛擬成員的顏色欄只接受 `#RGB`–`#RRGGBBAA` 十六進位字面值——顏色會插進網頁的
  style 屬性,放寬就等於讓家人互相注入 CSS(有測試)。
- 靜態檔帶 `no-cache`,升級後瀏覽器不會留著昨天的 `app.js`。
- 訂閱連結有到期日、可撤銷、會記錄上次讀取時間;透過 agent token 讀訂閱清單時只回前綴,不回完整 token。
- Agent token 的安全設計(分權、撤銷、只能由瀏覽器 session 管理)見第二部分。
- **沒有做的**:TOTP/二階段驗證、動作審計(audit log)、HTTPS、每帳號資料量上限、
  成員移除、關閉公開註冊。要公開到網際網路前,至少先補 HTTPS 與備份。

## 已知限制

1. 沒有原生行動 app,也沒有伺服器推播;手機靠瀏覽器或 ICS 訂閱(見上)。
2. `RRULE` 是子集:子集外的屬性(`BYSETPOS`、`WKST`、`BYWEEKNO`、floating 形式的 `UNTIL`、
   `YEARLY` 的 `BYDAY`/`BYMONTHDAY`)會被**明確拒絕**(`bad_rrule`),不是靜默忽略。
   `WEEKLY` 的序數前綴(`2MO`)會被當成該星期幾處理,只有 `MONTHLY` 才真的解析序數。
3. 全天行程以「建立者時區的日期」存成 UTC 午夜。跨時區共用的家庭成員看到的日期可能差一天
   —— 這是把全天事件當日期處理的代價,不是 bug,但要知道。
4. 重複系列的展開有上限(單次回讀最多 400 天視窗、5000 次出現),要更長請分段查。
5. 假期表是寫死的官方資料(2026–2027,含補假),放在 `src/holidays.ts`。
   每年公報刊出新表後要手動補上;超出涵蓋範圍時 `get_date_info` 明確回 `holiday_known: false`,
   不會把「未知」當成「要上班」。
6. 單機 SQLite,沒有水平擴展;多個程序(伺服器 + CLI + MCP)共用同一個 WAL 資料庫。

## 想讓 AI 幫你排行程?

你只需要做一件事:**發一個 token 給它**。細節在第二部分,最短路徑:

```bash
node src/cli.ts login --email you@example.com --password 你的密碼
node src/cli.ts token create --name my-agent --scopes read   # 先給唯讀試試看
```

建議先給 `read`,確認它查得對,再另外發一個帶 `write` 的;`delete` 最後再給。
token 可隨時撤銷(`node src/cli.ts token revoke cal_…`),撤銷後它的下一個請求就是 401。

---

<a id="agents"></a>

# 第二部分:給 AI Agent

> 你是要**操作日曆**的 agent。完整規則(時間語意、重複/刪除/還原、錯誤碼對照、省 token 讀法)
> 都在 **[AGENTS.md](AGENTS.md) 的 A 部**,動手前請先讀完。
> 這一節只是入口與速查,**若兩邊有出入,以 AGENTS.md 為準**。

## 你需要什麼

由**人類**準備好(只有瀏覽器 session 能發 token,你不能替自己續發或撤銷別人的 token):

| 變數 | 意義 |
|---|---|
| `CAL_BASE` | 伺服器位址,例如 `http://127.0.0.1:8787` |
| `CAL_TOKEN` | `cal_…` 開頭的 agent token。**不要把它寫進任何回應或 log** |
| `CAL_CALENDAR` | 預設日曆 id,設了之後大部分工具不必再傳 `calendar_id` |
| `CAL_TZ` | 預設 IANA 時區,用來解讀「沒寫時區」的時間字串 |

也可以寫進 `~/.shared-calendar-agent.json`(`login` 與 `use <calendar-id>` 會自動維護;
環境變數優先於檔案,空字串不會蓋掉檔案內容)。

Token 有三種 scope:`read`(GET)、`write`(POST/PUT)、`delete`(DELETE)。
權限不足回 `403 insufficient_scope`,`required` 欄位會告訴你缺哪個 —— **不要重試同一個動作**,
請使用者授權或說明限制。

## 三個入口,同一份實作

`src/agent-tools.ts` 是工具邏輯的唯一落點,CLI 與 MCP 只是薄殼,行為一致。

| 入口 | 用法 |
|---|---|
| **MCP server**(stdio,33 個工具) | 在 agent host 的 mcp 設定裡登記(下方範例) |
| **CLI** | `node src/cli.ts <command>`,加 `--json` 給機器讀;`node src/cli.ts help` 看完整清單 |
| **REST** | 在 `Authorization` header 帶 `Bearer cal_…`;路由表在 `src/api.ts`(42 條) |

MCP 設定範例(`command` 必須解析到 **Node 24+**,否則請寫 node 執行檔的絕對路徑;`args` 用絕對路徑):

```json
{
  "mcpServers": {
    "shared-calendar": {
      "command": "node",
      "args": ["/absolute/path/to/open-calendar/src/mcp.ts"],
      "env": { "CAL_BASE": "http://127.0.0.1:8787", "CAL_TOKEN": "cal_…", "CAL_CALENDAR": "cal_…" }
    }
  }
}
```

MCP 每個工具都宣告 `outputSchema` 與 `annotations`(唯讀/破壞性/冪等),
回應同時帶 `content` 與 `structuredContent`;清單類工具回 `{ items: [...] }`
(`list_events` 例外,回 `{ tz, from, to, detail, count, events }`)。

### 一眼看完 33 個工具

| 群 | 工具 |
|---|---|
| 讀 | `whoami` `list_calendars` `list_members` `list_events` `get_event` `list_labels` `list_virtual_members` `list_memos` `list_subscriptions` `list_trash` `find_free_slots` `get_date_info` |
| 寫 | `create_calendar` `create_invite` `join_calendar` `create_event` `create_events` `quick_add` `update_event` `override_occurrence` `copy_event` `add_comment` `create_virtual_member` `update_virtual_member` `create_memo` `update_memo` `create_subscription` |
| 刪 | `delete_event` `delete_virtual_member` `delete_memo` `revoke_subscription` |
| 還原 | `restore_event` `restore_occurrence` |

### CLI 速覽

```bash
node src/cli.ts events --from 2026-11-01 --days 30
node src/cli.ts events --q 鋼琴 --label-id 2 --detail full
node src/cli.ts add --title "大提琴課" --start "2026-11-05 14:00" --end "2026-11-05 15:00" --reminders 30
node src/cli.ts quick "明天下午3點看牙醫"
node src/cli.ts free --date 2026-11-05 --duration 60
node src/cli.ts dateinfo --date 2026-11-02 --days 30
node src/cli.ts copy evt_… --shift-days 7
node src/cli.ts trash  |  restore evt_…  |  restore-occurrence evt_… --occ 2026-11-19
node src/cli.ts calendar add --name 祖父母  |  calendar invite  |  calendar join CODE
node src/cli.ts calendar members
node src/cli.ts members  |  member add --name 李悅 --type child
node src/cli.ts memos  |  memo add --title 工人放假 --body "到 11 月底"
```

## 速查:最容易出錯的規則

完整說明與原因見 [AGENTS.md](AGENTS.md) A 部。

1. **先確認身分**:`whoami`、`list_calendars`,再動手。
2. **時間用 epoch 毫秒最保險**。`list_events` 每筆都附 `start_at` / `end_at` / `occurrence_start`,
   要餵回其他工具時用這些,**不要用顯示字串**(如 `"2026-11-05 (all-day)"` 會被拒絕為 `bad_time`)。
   裸日期/時間依 `tz` 參數或帳號時區的**牆上時間**解讀。
3. **重複事件的某一次**以 `occurrence_start`(原始時間 epoch)為 key。
   「只改這一次」用 `override_occurrence`,不是 `update_event`(後者動整串)。
4. **三種刪除語意不同**:`scope=all`(整串,可 `restore_event`)、`scope=occurrence`(只那一天,可 `restore_occurrence`)、
   `scope=future`(從那天起切斷系列,**沒有還原工具**)。
5. **重試要帶 `request_id`**(`create_event` / `create_events` / `quick_add` / `copy_event`):
   同 key 7 天內重送回第一次的結果,不會多一筆;同 key 換內容回 `409 idempotency_key_reused` —— 那是你的 bug,換一個 key。
6. **`update_event` 只送要改的欄位**;先 `get_event` 記下 `updated_at`,帶 `expected_updated_at` 防止蓋掉別人的修改
   (版本不符回 `409 stale_event`,重讀後再試)。
7. **批次的部分失敗是正常的**:`create_events` 最多 500 筆,讀 `failed:[{index, reason}]`,別假設全成功。
8. **`quick_add` 沒把握時回 `needs_confirmation: true` 而且不會寫入**。這時該問使用者,
   確認後再帶 `confirm: true` 重送,不要自己猜。
9. **大量破壞性操作前先 `list_events` 列出會動到哪些筆**,取得人類確認再做。
10. **省 token**:`list_events` 先用 `q` / `label_id` 縮範圍;只問「有沒有空」用 `find_free_slots`;
    只問「這天放不放假」用 `get_date_info`(只涵蓋 2026–2027,範圍外回 `holiday_known: false` 是「不知道」,不是「要上班」)。
11. **錯誤長這樣**:`{ error, message, status, hint?, field?, required? }`。`error` 是穩定代碼,
    `hint` 是建議的下一步 —— 照做,不要原樣重試。`need_login`(401)就停下來請使用者重新發 token。
12. **別洩漏 token**,也別把它寫進任何回應或 log。

## 你不該自己做的

- 發/撤銷 token、改權限(`session_required`)—— 請使用者自己在瀏覽器或 CLI 做。
- 加「刻意沒做的」功能(移除成員、日曆改名/刪除/退出、標籤改名、RSVP、附件、公開分享頁、推播/Webhook……)—— 需要 maintainer 決定,見第一部分。
- 把「手機沒更新」當成你寫失敗:ICS 訂閱由手機 app 自己決定抓取頻率(通常 15–60 分鐘)。

## Token 與權限模型(給你理解邊界)

- Agent token 是 `cal_` 前綴的 192-bit 隨機 bearer:建立時回顯一次,清單只顯示前綴,可隨時撤銷,
  撤銷後下一個請求就 401(有測試)。
- **Token 管理只能從瀏覽器 session 做**:agent token 不能替自己續發,也不能撤銷別的 token
  (否則洩漏的 token 撤掉後還能復活);撤銷時 token 放 POST body,不會留在 proxy 的 URL 日誌裡。
- **Scope 在路由前就攔截**:唯讀 agent 打不出寫入與刪除。
- **誤刪可救**:刪除是軟刪除;`list_trash` 列最近 30 天,`restore_event` / `restore_occurrence` 還原。
- **重試不重複**:建立類請求的 `request_id` 保留 7 天;HTTP 也可用 `Idempotency-Key` header,CLI 對應 `--request-id`。

## 如果你要改這個程式碼

請先讀 [AGENTS.md](AGENTS.md) 的 **B 部**。最重要的五條:

1. **零執行期相依**:不准加 `dependencies`,不准 `npm install`;只用 Node 24 內建模組。
2. **`.ts` 直接跑,沒有 build**:不要用 `enum`、namespace、參數屬性(Node 的 type stripping 吃不了)。
3. **一個行為只有一個落點**:路由與驗證在 `src/api.ts`;工具邏輯在 `src/agent-tools.ts`,
   `src/cli.ts` 與 `src/mcp.ts` 只是薄殼,新行為兩個入口都要有。
4. **測試要跑真的**:真啟動伺服器、真走 HTTP、真 spawn 子行程,不要 mock;新行為要有新斷言。
5. **不要宣示沒做過的事**:README/註解裡的功能要能實際跑,沒驗證的就寫「未驗證」。

---

<a id="dev"></a>

# 開發者參考(人類與 agent 共用)

## 測試

```bash
bash scripts/check.sh            # 全部七組(366 條斷言);NODE=... 可指定 node 執行檔
node scripts/selftest.ts         # 單跑一組
```

| 程式 | 驗什麼 | 斷言 |
|---|---|---|
| `test-nlp.ts` | 中文自然語言解析(quick add;時區錨定、同日不滾位) | 34 |
| `test-holidays.ts` | 澳門假期表完整性與 `get_date_info` 語意 | 29 |
| `test-rrule.ts` | 重複規則引擎(+8、跨 DST、COUNT、舊錨點、不支援屬性拒絕) | 42 |
| `test-import.ts` | CSV 匯入解析器 | 21 |
| `test-e2e-import.ts` | 真啟動伺服器 + 真 spawn CLI 匯入範例檔 | 14 |
| `test-agent.ts` | token 生命週期與 scope、冪等重送、搜尋/詳情、版本衝突、日曆與邀請、33 個工具、CLI 與 MCP 子行程 | 126 |
| `selftest.ts` | 端對端:鑑權、成員、批次、重複、例外、留言、按讚、ICS 結構、色彩驗證、資安標頭 | 100 |

這些測試**真的啟動伺服器、真的跑子行程**,不是把函式 mock 起來。
`npm test` / `npm start` 只有 PATH 上的 `node` 是 24+ 時會通,否則請用 `scripts/check.sh`。

## 專案結構

| 檔 | 職責 |
|---|---|
| `src/server.ts` | HTTP、靜檔、cookie/bearer 鑑權、scope 攔截、資安標頭 |
| `src/api.ts` | 所有路由(42 條)與請求驗證;業務規則的唯一落點 |
| `src/db.ts` | schema 與遷移(只能新增,且對既有 DB 冪等) |
| `src/auth.ts` | scrypt、session、agent token(含 scope) |
| `src/rrule.ts` `src/tz.ts` | 牆上時間的重複展開 |
| `src/ics.ts` | iCalendar 輸出(`TZID` + `VTIMEZONE`、EXDATE、override、VALARM) |
| `src/nlp.ts` | 中文自然語言解析 |
| `src/import-lib.ts` `scripts/import-timetree.ts` | CSV 對映與匯入 CLI |
| `src/holidays.ts` | 澳門假期表 |
| `src/agent-tools.ts` | **agent 工具的共同實作**(CLI 與 MCP 都只是薄殼) |
| `src/client.ts` | 零相依 HTTP client + 設定載入 |
| `src/cli.ts` `src/mcp.ts` | 兩個入口適配層 |
| `public/` | 單頁 UI(原生 JS,無框架)、PWA manifest、service worker |

## 授權

AGPL-3.0-only,見 `LICENSE`。選 AGPL 的理由:這是把別人產品做替代品來用的東西,
如果以後有人拿它去架一個閉源服務複製回市場,這份授權要求他們同樣開放修改。
自己架、自己用、甚至賣服務都不受影響 —— 只要你能提供源碼。
