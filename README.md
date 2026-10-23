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
bash scripts/check.sh            # 四組全跑,NODE=... 可指定 node 執行檔
node scripts/test-rrule.ts       # 重複規則引擎(含 +8 與跨 DST 案例)
node scripts/test-import.ts      # CSV 匯入解析器
node scripts/test-e2e-import.ts  # 真啟動伺服器 + 真 spawn CLI 匯入 examples/lessons.csv
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

## 安全邊界(已知,不是沒做)

- 所有寫入請求都是同源檢查 + `SameSite=Lax` 的 HttpOnly session cookie;跨站 POST 會被 403 掉。
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
