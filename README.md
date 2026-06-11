# 591 待售物件監控看板

個人用的房屋物件監控看板：後端定期（隨機 4~6 分鐘一次）向 591 BFF API 抓取台中符合條件的待售物件，篩選後存入 Cloudflare KV；前端（Vue 3 + Quasar）以滾動式虛擬列表顯示，右上角有「下次更新倒數」與「手動更新」。整站以 Cloudflare Access 保護。

完整規格見 [PLAN.md](./PLAN.md)。

## 技術堆疊

| 項目 | 選擇 |
|---|---|
| 前端 | Vue 3 + Quasar（SPA，`quasar build` → `dist/spa`） |
| 後端 / 排程 | 單一 Cloudflare Worker（靜態資源 + API + Cron） |
| 儲存 | Cloudflare Workers KV（`house_data` / `meta` / `seen_ids` 三個 key） |
| 通知 | LINE 官方帳號 push（首次出現的物件才通知） |
| 登入 | Cloudflare Access（Zero Trust） |
| 部署 | Wrangler |

## 專案結構

```
.
├─ index.html              # Quasar SPA 進入點樣板
├─ quasar.config.js        # Quasar 設定（含 /api 代理到本機 wrangler dev）
├─ wrangler.jsonc          # Cloudflare Worker / 靜態資源 / KV / Cron 設定
├─ worker/index.js         # 後端 Worker：抓取、篩選、KV、API 路由、Cron
└─ src/                    # 前端原始碼
   ├─ App.vue
   ├─ router/              # vue-router 設定
   ├─ layouts/MainLayout.vue
   ├─ pages/IndexPage.vue  # 主畫面：頂列倒數/更新 + 虛擬滾動卡片列表
   ├─ components/HouseCard.vue
   └─ composables/useHouses.js  # 資料流、倒數、自動銜接、手動更新
```

> 備註：PLAN §8.1 的設定示意把 `main` 指向 `src/worker.js`；因前端原始碼已佔用 `src/`（Quasar），為避免衝突，本專案將 Worker 置於 `worker/index.js`，並於 `wrangler.jsonc` 對應調整。

## 本機開發

需 Node 20+ 與 pnpm。

```bash
pnpm install

# （可選）測試 LINE 通知：複製 .dev.vars.example 為 .dev.vars 並填入機密值
cp .dev.vars.example .dev.vars

# 終端機 A：跑後端 Worker（含 KV、Cron 模擬），預設 http://localhost:8787
pnpm worker:dev

# 終端機 B：跑前端 dev server，http://localhost:9000
# quasar.config.js 已把 /api 代理到 8787，故前端可直接呼叫 API
pnpm dev
```

- `wrangler dev` 預設使用本機模擬的 KV，資料僅存於本機。
- 可在 wrangler dev 互動介面按 `l` 觸發排程（scheduled）事件以測試抓取。

## 部署（對應 PLAN §8.2）

1. 建立 KV namespace，並把回傳的 `id` 填入 `wrangler.jsonc` 的 `kv_namespaces[0].id`：

   ```bash
   pnpm exec wrangler kv namespace create KV
   ```

2. 設定 LINE 推播所需的 Worker secret（機密值，不寫死於程式或設定檔）：

   ```bash
   pnpm exec wrangler secret put LINE_CHANNEL_ACCESS_TOKEN
   pnpm exec wrangler secret put LINE_USER_ID
   ```

3. 登入並部署（會先 `quasar build` 再 `wrangler deploy`）：

   ```bash
   pnpm exec wrangler login
   pnpm deploy
   ```

4. 在 Cloudflare Zero Trust 建立 **Access Application** 保護該網域（含 `/` 與 `/api/*`），
   Policy 設為僅允許本人 email（One-time PIN 或 Google 登入）。
   - 前端不需任何登入畫面；登入由 Access 在邊緣處理。
   - Cron 的 `scheduled` 為伺服器端事件，不受 Access 影響，照常執行。

5. 部署後執行一次手動更新以建立初始資料（或等 ≤1 分鐘讓首次 cron 自動 seed）：

   ```bash
   curl -X POST https://<你的網域>/api/refresh
   ```

## API

| 方法 | 路徑 | 行為 |
|---|---|---|
| GET | `/api/houses` | 回傳 `{ houses, meta }`（KV 最新資料） |
| POST | `/api/refresh` | 立即跑一次抓取週期並重置隨機週期，回傳最新 `{ houses, meta }`（距上次更新 < 10 秒則略過實際抓取） |

## 免費方案額度

- KV 寫入：整包覆寫，一天約 288 次（隨機 4~6 分一次），遠低於 1000 次/日上限。
- Worker invocation：Cron 每分鐘 1 次，一天 1440 次。
- 每週期外部請求 ≤45 頁、每批並行 ≤6 條連線。
