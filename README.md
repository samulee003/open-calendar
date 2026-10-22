# shared-calendar

自架的共享日曆:家人一起看同一個日曆、標行程、在行程下留言按讚,資料留在你自己的機器上。
零執行期相依需求 —— 只要 Node.js 24+,不需要 npm install,不需要資料庫伺服器。

這是 **clean-room 實作**:功能邊界參考了現有共享日曆產品的公開行為,
但所有程式碼、schema、介面都是這裡自己寫的,內不含任何第三方產品的原始碼、
介面原文或素材。

## 跑起來

```bash
node src/server.ts
# → shared-calendar listening on http://127.0.0.1:8787
```

打開 http://127.0.0.1:8787 註冊第一個帳號,系統會自動建立你的個人日曆與三個標籤。

驗證實作是否完好(它真的啟動伺服器、走完整 HTTP 流程,不是單元測試的模擬):

```bash
npm test                     # 四組一次跑完
node scripts/test-rrule.ts   # 重複規則引擎(含 +8 與跨 DST 案例)
node scripts/test-import.ts  # CSV 匯入解析器
node scripts/test-e2e-import.ts  # 真啟動伺服器 + 真 spawn CLI 匯入 examples/lessons.csv
node scripts/selftest.ts     # 端對端:鑑權、成員、批次、重複、例外、留言、按讚、ICS 結構驗證
```

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

⚠️ 別名表是照常見匯出格式寫的,**尚未用一份真实的 TimeTree 匯出檔驗證過**。
第一次用請先 `--dry-run`。

## 手機訂閱

「手機訂閱」產生 `/ics/<token>.ics`。這個連結**只讀但公開**:拿到網址的人都能讀那個日曆,
請當成密碼保管。要撤銷就刪掉 `subscriptions` 那列(或重開一個新 token)。

## 安全邊界(已知,不是沒做)

- 所有寫入請求都是同源檢查 + `SameSite=Lax` 的 HttpOnly session cookie;跨站 POST 會被 403 掉。
- 密碼 scrypt 加鹽,不會出現在 log。
- 前端所有文字一律走 `textContent`,行程標題與備註(由**其他家庭成員**撰寫)永遠不會變成 markup。
- iCalendar 輸出會逃換 `\r`/`\n`,所以標題無法偽造 `DESCRIPTION:` 之类的屬性行(有測試)。
- SQL 全部預留參數,沒有字串拼接。
- **沒有做的**:登入嘗試限速、TOTP、audit log、HTTPS(請用 reverse proxy 或 tailscale 之類自行處理)、
  訂閱 token 的有效期。要公開到網際線前這些都得補。

## 已知限制

1. 沒有原生行動 app,也沒有推播通知。手機端是透過 ICS 訂閱走各系統自己的日曆 app,
   因此**手機上看不到留言/按讚,通知也由系統日曆 app 決定**。留言與按讚只在網頁上。
2. `RRULE` 是子集,不吃 `BYSETPOS`、`WKST`、時區型 `UNTIL`(只用 UTC 形式)。
3. 全天行程以「建立者時區的日期」存成 UTC 午夜。跨時區共享的家庭成員看到的日期可能差一天
   (這正是它把全天事件當日期處理的代價,不是 bug,但要知道)。
4. 沒有行程附件、沒有多重位置、沒有公開分享頁。
5. 單機 SQLite,沒有水平擴展。

## 授權

AGPL-3.0-only,見 `LICENSE`。選 AGPL 的理由:這是把別人產品做替代品來用的東西,
如果以後有人拿它去架一個閉源服務複製回市場,這份授權要求他們同樣開放修改。
自己架、自己用、甚至賣服務都不受影響 —— 只要你能提供源碼。
