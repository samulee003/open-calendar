# shared-calendar

自架的共享日曆:家人一起看同一個日曆、標行程、在行程下留言按讚,資料留在你自己的機器上。
零執行期相依需求 —— 只要 Node.js 24+,不需要 npm install,不需要資料庫伺服器。

這是 **clean-room 實作**:功能邊界參考了現有共享日曆產品的公開行為,
但所有程式碼、schema、介面都是這裡自己寫的,內不含任何第三方產品的原始碼、
介面原文或素材。

## 跑起來

原始碼是 `.ts`,由 Node 直接執行(沒有 build 步驟)。**需要 Node 24+**;
若你的 `node` 是 22.17 之類較舊的版本,`.ts` 會報 `ERR_UNKNOWN_FILE_EXTENSION`。

```bash
node src/server.ts
# → shared-calendar listening on http://127.0.0.1:8787
```

打開 http://127.0.0.1:8787 註冊第一個帳號,系統會自動建立你的個人日曆與三個標籤。

本機若 24 版是解壓在 `D:\rea-toolchain`,把它放在 PATH 最前面即可:

```bash
export PATH="/d/rea-toolchain/node-v24.18.0-win-x64:$PATH"
```

驗證實作是否完好(它真的啟動伺服器、走完整 HTTP 流程,不是單元測試的模擬):

```bash
bash scripts/check.sh            # 全部測試,NODE=... 可指定 node 執行檔
node scripts/test-nlp.ts         # 中文自然语言解析(quick add)
node scripts/test-holidays.ts    # 澳門公眾假期表完整性 + get_date_info
node scripts/test-rrule.ts       # 重複規則引擎(含 +8 與跨 DST 案例)
node scripts/test-import.ts      # CSV 匯入解析器
node scripts/test-e2e-import.ts  # 真啟動伺服器 + 真 spawn CLI 匯入 examples/lessons.csv
node scripts/test-agent.ts       # agent 面:token、CLI、MCP server(真子进程)
node scripts/selftest.ts         # 端對端:鑑權、成員、批次、重複、例外、留言、按讚、ICS 結構驗證
```

`npm test` / `npm start` 只有在你 PATH 上的 `node` 就是 24+ 時會通;
不然請用上面的 `scripts/check.sh`。

## 它能做什麼

| | |
|---|---|
| 多日曆與成員 | 邀請碼加入、擁有者可移除、每人限額 |
| 行程 | 標題、時間/全天、地點、備註、標籤、通知 |
| 重複 | RFC 5545 `RRULE` 子集:`DAILY/WEEKLY/MONTHLY/YEARLY`、`INTERVAL`、`BYDAY`(含 `1MO`/`-1MO`)、`BYMONTHDAY`(含 `-1`)、`BYMONTH`、`COUNT`、`UNTIL` |
| 單次例外 | 「只改這一次」寫入 override,「只刪這一次」寫 `EXDATE`,「刪這天以後」改寫 `UNTIL` |
| 社交層 | 每個行程的留言串與按讚(👍 ❤️ 🎉 😂),同日曆成員都看得到 |
| 家庭成員 | 沒有帳號的人(小孩、寵物、車…)可建成**虛擬成員**,掛在行程上;刪除成員會自動清掉標記 |
| 複製行程 | 複製單一事件或重複系列的**某一次**到新時間/另一個日曆(可選帶走重複規則) |
| 備忘 | 不屬於任何行程的日曆級筆記,可置頂 |
| 澳門假期 | 公眾假期與補假查詢(2026–2027 官方表),agent 可問「這天放假嗎/下一個假期」 |
| 批次匯入 | 一次送 500 筆;網頁端貼一行一筆,或 CLI 讀 CSV |
| 手機同步 | 每個日曆可產生**唯讀 ICS 訂閱網址**,iPhone 內建日历、Android 的 DAVx⁵／Calendri 都能收 |
| 時區 | 依 IANA 時區名在**當地牆上時間**展開重複,不是用 UTC 日期硬算 |

## 批次匯入

網頁:右上角「批次匯入」,每行一筆:

```
2026-11-05 14:00-15:00 大提琴課
2026-11-12 全天 奶奶生日
2026-12-03 15:00-16:00 古箏班 每週
```

CLI(從既有日曆匯出檔搬過來):

```bash
node scripts/import-timetree.ts --email me@x.tw --password '...' \
  --calendar 家庭 --file examples/lessons.csv --dry-run
```

`--dry-run` 只解析不寫入。表頭比對支援中/英/日常用欄名(見 `src/import-lib.ts`),
比對不到時它會**把表頭印出來並停止**,不會亂猜對映。

支援的日期寫法:`2026-11-05`、`2026/11/5`、`2026年11月5日`、`2026-11-05T14:00`、
`November 5, 2026`;時間支援 `14:00`、`14:00:00`、`2:00 PM`。
`05/11/2026` 這種日/月順序不明的寫法**故意拒絕**,不猜。

拿到一份格式未知的匯出檔時,先看它怎麼對映:

```bash
node scripts/import-timetree.ts --file export.csv --headers
```

⚠️ 別名表是照常見匯出格式寫的,**尚未用一份真实的 TimeTree 匯出檔驗證過**。
第一次用請先 `--dry-run`。

## 手機訂閱與手機使用

有兩條路,可以並用:

**A. 直接用手機瀏覽器(推薦,功能完整)**
打開同一個網址登入即可。版面在 760px 以下自動切換成手機模式:單欄月曆、日期詳情變成底部面板、輸入框 16px(避免 iOS 聚焦時整頁放大)。
「加入主畫面」後以 standalone 模式啟動(已附 `manifest.webmanifest` 與 service worker)。
Service worker **只快取介面**,不快取 `/api`、`/ics` —— 離線時看到的是介面而非過期資料。

**B. 訂閱到手機內建日曆(唯讀)**
「手機訂閱」產生 `/ics/<token>.ics`,iPhone 內建日曆、Android 的 DAVx⁵／Calendri 都能收。
行程的提醒會以 iCalendar `VALARM` 輸出,由**手機自己的日曆 app** 負責響鈴 ——
不需要推播伺服器。訂閱是唯讀的:手機上不會看到留言與按讚。

訂閱連結會**一年後自動失效**,可在同一對話框看到到期日、上次讀取時間,並隨時撤銷。
拿到網址的人都能讀那個日曆,請當成密碼保管。

## 給 AI Agent 用(CLI + MCP)

日曆本身就是一个工具面:任何会跑命令行、或会说 MCP 的 AI agent(Qoder、Claude、Codex……)
都能直接查行程、建行程、找空档、留言——不用碰浏览器。

### 1. 产生 agent token

Agent 不用 cookie,用长期 bearer token(可命名、可撤销、列出时只显示前缀):

```bash
node src/cli.ts login --email you@example.com --password 你的密碼
node src/cli.ts token create --name qoder
# → { "token": "cal_…", "name": "qoder" }   只显示这一次
```

把 token 交给 agent 的方式二选一:环境变量 `CAL_BASE` / `CAL_TOKEN` / `CAL_CALENDAR`(预设日历),
或写进 `~/.shared-calendar-agent.json`(`login` 与 `use <calendar-id>` 会自动维护)。
撤销:`node src/cli.ts token revoke cal_…`。

### 2. CLI(人也能用,`--json` 给机器)

```bash
node src/cli.ts calendars
node src/cli.ts events --from 2026-11-01 --days 30
node src/cli.ts add --title "大提琴課" --start "2026-11-05 14:00" --end "2026-11-05 15:00" --reminders 30
node src/cli.ts add --title "古琴班" --start "2026-11-05 19:00" --rrule "FREQ=WEEKLY;BYDAY=TH"
node src/cli.ts quick "明天下午3點看牙醫"          # 自然语言;没把握时会回 needs_confirmation
node src/cli.ts free --date 2026-11-05 --duration 60
node src/cli.ts dateinfo --date 2026-11-02 --days 30   # 澳門公眾假期/星期/下一個假期
node src/cli.ts show evt_…  |  update evt_… --title "新標題"  |  delete evt_… --scope occurrence --occ 2026-11-12
node src/cli.ts copy evt_… --shift-days 7        # 複製到下一週;--occurrence 只複製某一次
node src/cli.ts members                          # 虛擬成員(小孩/寵物)
node src/cli.ts member add --name 李悅 --type child
node src/cli.ts memos  |  memo add --title 工人放假 --body "到 11 月底"
node src/cli.ts comment evt_… 記得帶譜
node src/cli.ts subscribe --days 365               # 唯读 ICS 订阅网址
```

时间参数接受 epoch 毫秒、ISO 8601、`YYYY-MM-DD`、`"YYYY-MM-DD HH:MM"`
(没写时区时按 `--tz`/账号时区的墙上时间解读)。错误一律输出 `{"error":…,"status":…}` 并以非 0 退出。

### 3. MCP server(给会说 MCP 的 agent)

`src/mcp.ts` 是零依赖的 stdio MCP server,提供 23 个工具:
`list_calendars` / `list_events` / `get_event` / `create_event` / `create_events`(批次)/
`quick_add` / `update_event` / `delete_event` / `override_occurrence`(只改某一次)/
`copy_event`(复制单次或某一次) / `find_free_slots` / `add_comment` / `list_labels` /
`create_subscription` /
`list_virtual_members` / `create_virtual_member` / `update_virtual_member` / `delete_virtual_member`(家庭成員)/
`list_memos` / `create_memo` / `update_memo` / `delete_memo`(備忘) /
`get_date_info`(澳門公眾假期、補假、星期、下一個假期)。

在你的 agent 里登记(Qoder / Claude Desktop 等的 mcp 设置皆同型):

```json
{
  "mcpServers": {
    "shared-calendar": {
      "command": "node",
      "args": ["D:/timetree-oss/src/mcp.ts"],
      "env": {
        "CAL_BASE": "http://127.0.0.1:8787",
        "CAL_TOKEN": "cal_…",
        "CAL_CALENDAR": "cal_…"
      }
    }
  }
}
```

`command` 的 node 必须是 24+(或改用绝对路径 `D:/rea-toolchain/node-v24.18.0-win-x64/node.exe`)。
工具回报刻意紧凑(本地时间标签 + `occurrence_start` epoch),重复规则的展开、override、EXDATE
都由服务器算好,agent 不需要自己处理 RFC 5545。

验证:`node scripts/test-agent.ts` 会真启服务器,把 token 生命周期、23 个工具、CLI 子进程、
MCP stdio 子进程全部走一遍(70 个断言)。

`get_date_info` 的假期表是**写死的官方资料**(2026–2027,含補假),放在
[src/holidays.ts](src/holidays.ts)。每年公报刊出新表后要手动补上:超出覆盖范围时工具会明确回
`holiday_known: false`,不会把「未知」当成「要上班」。`scripts/test-holidays.ts` 会核对星期与补假数。

## 安全邊界(已知,不是沒做)

- 所有寫入請求都是同源檢查 + `SameSite=Lax` 的 HttpOnly session cookie;跨站 POST 會被 403 掉。
- Agent token 是 `cal_` 前缀的 192-bit 随机 bearer:只在建立时回显一次,列表只显示前缀,可随时撤销;
  撤销即刻生效(下一个请求就 401,有测试)。
- **token 的管理本身只能从浏览器 session 做**:agent token 不能替自己续发新 token、也不能撤销其他 token
  (否则泄漏的 token 撤销后还能复活);撤销时 token 放在 POST body,不会留在 proxy 访问日志的 URL 里。
- 密碼 scrypt 加鹽,不會出現在 log。
- **登入限速**:15 分鐘內同一 email 失敗 8 次、或同一 IP 失敗 30 次即回 429(有測試)。
  放在 reverse proxy 後面時設 `TRUST_PROXY=1`,否則每個請求看起來都來自 proxy。
- 回應帶 `Content-Security-Policy`(無 inline script)、`X-Content-Type-Options`、`X-Frame-Options: DENY`、`Referrer-Policy: no-referrer`。
- 前端所有文字一律走 `textContent`,行程標題與備註(由**其他家庭成員**撰寫)永遠不會變成 markup。
- iCalendar 輸出會逃換 `\r`/`\n`,所以標題無法偽造 `DESCRIPTION:` 之类的屬性行(有測試)。
- 訂閱連結有到期日、可撤銷、會記錄上次讀取時間。
- SQL 全部預留參數,沒有字串拼接。
- **沒有做的**:TOTP／二階段、audit log、HTTPS(請用 reverse proxy 或 tailscale 之類自行處理)、
  每個帳號的資料量上限。要公開到網際網路上前,至少先補 HTTPS 與備份。

## 已知限制

1. 沒有原生行動 app,也沒有伺服器推播。手機有兩條路:用**手機瀏覽器**(功能完整,含留言按讚,
   可加入主畫面)或訂閱 **ICS**(唯讀、看不到留言;提醒靠 `VALARM` 由系統日曆 app 響)。
2. `RRULE` 是子集,不吃 `BYSETPOS`、`WKST`、時區型 `UNTIL`(只用 UTC 形式)。
3. 全天行程以「建立者時區的日期」存成 UTC 午夜。跨時區共享的家庭成員看到的日期可能差一天
   (這正是它把全天事件當日期處理的代價,不是 bug,但要知道)。
4. 沒有行程附件、沒有多重位置、沒有公開分享頁。
5. 單機 SQLite,沒有水平擴展。

## 授權

AGPL-3.0-only,見 `LICENSE`。選 AGPL 的理由:這是把別人產品做替代品來用的東西,
如果以後有人拿它去架一個閉源服務複製回市場,這份授權要求他們同樣開放修改。
自己架、自己用、甚至賣服務都不受影響 —— 只要你能提供源碼。
