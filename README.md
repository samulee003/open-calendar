# shared-calendar

自架的共享日曆:家人一起看同一個日曆、標行程、在行程下留言按讚,資料留在自己的機器上。
零執行期相依需求 —— 只要 Node.js 24+,不需要 `npm install`,不需要資料庫伺服器。
同時也是一個**給 AI agent 用的日曆**:有 CLI 與 MCP server,33 個工具,token 可分權。

這是 clean-room 實作:功能邊界參考了現有共享日曆產品的公開行為,但程式碼、schema、
介面文字都是這裡自己寫的,內不含任何第三方產品的原始碼或素材。

**AI agent 請直接讀 [AGENTS.md](AGENTS.md)。**

---

## 快速開始

原始碼是 `.ts`,由 Node 直接執行,沒有 build 步驟。**需要 Node 24+**;
22.17 之類的舊 `node` 會報 `ERR_UNKNOWN_FILE_EXTENSION`。

```bash
node src/server.ts
# → shared-calendar listening on http://127.0.0.1:8787  (data: .../data)
```

打開 http://127.0.0.1:8787 註冊第一個帳號,系統會自動建立你的個人日曆與三個標籤。

| 環境變數 | 預設 | 說明 |
|---|---|---|
| `PORT` | `8787` | 只綁 `127.0.0.1`,要給別人看請自行放 proxy(見「部署」) |
| `DATA_DIR` | `<專案>/data` | SQLite 檔(`calendar.db` + WAL)所在目錄,換目錄就是換一個資料庫 |
| `TRUST_PROXY` | 未設定 | 設 `1` 才信任 `X-Forwarded-For` / `X-Forwarded-Proto`(限速與同源檢查用) |

本機 Node 24 解壓在 `D:\rea-toolchain` 時:

```bash
export PATH="/d/rea-toolchain/node-v24.18.0-win-x64:$PATH"
```

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
| 時區 | 依 IANA 時區名在**當地牆上時間**展開重複,自然語言新增也以使用者時區解讀;ICS 輸出帶 `TZID` + `VTIMEZONE`,不會把手機上的星期算錯一天 |

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
所以 agent 改完不會立刻出現在手機上。

訂閱連結**預設一年後失效**,對話框會顯示到期日、上次讀取時間,可隨時撤銷。
拿到網址的人都能讀那個日曆,請當成密碼保管。

## 批次匯入

網頁右上角「批次匯入」,每行一筆:

```
2026-11-05 14:00-15:00 大提琴課
2026-11-12 全天 奶奶生日
2026-12-03 15:00-16:00 古箏班 每週
```

CLI(從既有日曆的匯出檔搬過來):

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

## 給 AI Agent 用

三個入口,行為同一份實作(`src/agent-tools.ts`),不會各走各的:

```bash
# 1) 產生 agent token(可命名、可撤銷、可分權;只在建立時顯示一次)
node src/cli.ts login --email you@example.com --password 你的密碼
node src/cli.ts token create --name qoder                      # 預設 read,write,delete
node src/cli.ts token create --name qoder-read --scopes read   # 只能查
```

把 token 交出去的方式二選一:環境變數 `CAL_BASE` / `CAL_TOKEN` / `CAL_CALENDAR`,
或寫進 `~/.shared-calendar-agent.json`(`login` 與 `use <calendar-id>` 會自動維護)。
撤銷:`node src/cli.ts token revoke cal_…`。

```bash
# 2) CLI(人也能用;加 --json 給機器讀)
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
node src/cli.ts help            # 完整清單
```

```bash
# 3) MCP server(stdio,33 個工具)—— 在 agent 的 mcp 設定裡登記
```

```json
{
  "mcpServers": {
    "shared-calendar": {
      "command": "D:/rea-toolchain/node-v24.18.0-win-x64/node.exe",
      "args": ["D:/timetree-oss/src/mcp.ts"],
      "env": { "CAL_BASE": "http://127.0.0.1:8787", "CAL_TOKEN": "cal_…", "CAL_CALENDAR": "cal_…" }
    }
  }
}
```

**重試安全**:`create_event` / `create_events` / `quick_add` / `copy_event` 接受 `request_id`
(HTTP 也可用 `Idempotency-Key` header),CLI 對應 `add`/`quick`/`batch`/`copy` 的 `--request-id`。
同 key 重送回傳原本的結果而不是多建一筆;
同 key 不同內容回 409,不會假裝成功。`update_event` 只送有變的欄位,可用
`expected_updated_at` 擋下並行覆蓋(409 `stale_event`)。

MCP 每個工具都宣告 `outputSchema` 與 `annotations`(唯讀/破壞性/冪等),
回應同時帶 `content` 與 `structuredContent`;清單類工具回 `{ items: [...] }`。
錯誤是 `{ error, message, status, hint?, field?, required? }`,`hint` 說明下一步。

工具清單、時間語意、錯誤碼該做什麼,都寫在 [AGENTS.md](AGENTS.md)。

## 測試

```bash
bash scripts/check.sh            # 全部七組;NODE=... 可指定 node 執行檔
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

## 部署與備份

預設只監聽 `127.0.0.1`,要讓家人從手機用,三條路(由簡到繁):

1. **Tailscale**(建議):機器裝 tailscale,家人也裝,直接用 `http://<tailscale-ip>:8787`。
   不需要公開埠,也不需要自己管憑證。
2. **反向代理 + HTTPS**:caddy/nginx 擋在前面,設 `TRUST_PROXY=1`(否則限速会把所有人都看成 proxy,
   同源檢查也會把 https 的 Origin 擋掉)。
3. **公開到網際網路**:先補 HTTPS、備份,再考慮。

備份就是備份 `DATA_DIR`(建議用 SQLite 的 backup API,不要在運行中直接複製單一檔):

```bash
node -e "const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync('data/calendar.db',{readOnly:true});
db.prepare('vacuum into ?').run('backup-'+new Date().toISOString().slice(0,10)+'.db');db.close();"
```

還原演練做一次就好:把備份檔指到新的 `DATA_DIR` 啟動,確認行程還在。

## 安全邊界(已知,不是沒做)

- 寫入請求做同源檢查;session cookie 是 `SameSite=Lax` + HttpOnly,跨站 POST 直接 403。
  放在 TLS proxy 後面時,`TRUST_PROXY=1` 才會用 `X-Forwarded-Proto` 判斷來源協定。
- **登出會真的作廢 session**(刪除該 cookie 對應的列,並讓瀏覽器丢掉 cookie)。
- Agent token 是 `cal_` 前綴的 192-bit 隨機 bearer:建立時回顯一次,清單只顯示前綴,可隨時撤銷,
  撤銷後下一個請求就 401(有測試)。
- **Token 管理只能從瀏覽器 session 做**:agent token 不能替自己續發,也不能撤銷別的 token
  (否則洩漏的 token 撤掉後還能復活);撤銷時 token 放 POST body,不會留在 proxy 的 URL 日誌裡。
- **Token 有 scope**:`read` / `write` / `delete` 分開授予,在路由前攔截,唯讀 agent 打不出寫入與刪除。
- **誤刪可救**:刪除是軟刪除,`/api/trash` 列最近 30 天,`restore` / `restore-occurrence` 還原。
- **重試不重複**:建立類請求的 `request_id` 保留 7 天,同 key 重送回原結果。
- 密碼 scrypt 加鹽,不會出現在 log;SQL 全部預留參數,沒有字串拼接。
- **登入限速**:15 分鐘內同一 email 失敗 8 次、或同一 IP 失敗 30 次回 429。
- 回應帶 `Content-Security-Policy`(無 inline script)、`X-Content-Type-Options: nosniff`、
  `X-Frame-Options: DENY`、`Referrer-Policy: no-referrer`。
- 前端所有文字一律走 `textContent`;行程標題與備註(由**其他家庭成員**撰寫)永遠不會變成 markup。
- ICS 輸出會轉義 `\`、`\r`、`\n`、`;`、`,`,標題偽造不出 `DESCRIPTION:` 之類的屬性行(有測試)。
- 日曆/標籤/虛擬成員的顏色欄只接受 `#RGB`–`#RRGGBBAA` 十六進位字面值——顏色會插進網頁的
  style 屬性,放寬就等於讓家人互相注入 CSS(有測試)。
- 靜態檔帶 `no-cache`,升級後瀏覽器不會留著昨天的 `app.js`。
- 訂閱連結有到期日、可撤銷、會記錄上次讀取時間;透過 agent token 讀訂閱清單時只回前缀,不回完整 token。
- **沒有做的**:TOTP/二階段驗證、動作審計(audit log)、HTTPS、每帳號資料量上限、
  成員移除。要公開到網際網路前,至少先補 HTTPS 與備份。

## 已知限制

1. 沒有原生行動 app,也沒有伺服器推播;手機靠瀏覽器或 ICS 訂閱(見上)。
2. `RRULE` 是子集:子集外的屬性(`BYSETPOS`、`WKST`、`BYWEEKNO`、floating 形式的 `UNTIL`、
   `YEARLY` 的 `BYDAY`/`BYMONTHDAY`)會被**明確拒絕**(`bad_rrule`),不是靜默忽略。
   `WEEKLY` 的序數前綴(`2MO`)會被當成該星期幾處理,只有 `MONTHLY` 才真的解析序數。
3. 全天行程以「建立者時區的日期」存成 UTC 午夜。跨時區共用的家庭成員看到的日期可能差一天
   —— 這是把全天事件當日期處理的代價,不是 bug,但要知道。
4. 重複系列的展開有上限(單次回讀最多 400 天視窗、5000 次出現),要更長請分段查。
5. 假期表是寫死的官方資料(2026–2027,含補假),放在 `src/holidays.ts`。
   每年公報刊出新表後要手動補上;超出涵蓋範圍時 `get_date_info` 明確回   `holiday_known: false`,不會把「未知」當成「要上班」。
6. 單機 SQLite,沒有水平擴展;多個程序(伺服器 + CLI + MCP)共用同一個 WAL 資料庫。

## 專案結構

| 檔 | 職責 |
|---|---|
| `src/server.ts` | HTTP、靜檔、cookie/bearer 鑑權、scope 攔截、資安標頭 |
| `src/api.ts` | 所有路由(42 條)與請求驗證;業務規則的唯一落點 |
| `src/db.ts` | schema 與遷移 |
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
