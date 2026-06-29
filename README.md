# 591 待售物件監控看板

個人用的房屋物件監控看板：後端定期（隨機 4~6 分鐘一次）向 591 BFF API 抓取台中符合條件的待售物件，篩選後存入 Cloudflare KV；前端（Vue 3 + Quasar）以滾動式虛擬列表顯示，右上角有「下次更新倒數」與「手動更新」。整站以 Cloudflare Access 保護。

## 技術堆疊

| 項目 | 選擇 |
|---|---|
| 前端 | Vue 3 + Quasar（SPA，`quasar build` → `dist/spa`） |
| 後端 / 排程 | 單一 Cloudflare Worker（靜態資源 + API + Cron） |
| 儲存 | Cloudflare Workers KV（`house_data` / `meta` / `blacklist` / `notified_keys`） |
| 通知 | LINE 官方帳號 push（首次出現的物件才通知；以 price/room/houseage 去重） |
| 黑名單 | 卡片垃圾桶按鈕，將 price/room/houseage 三項皆相同者隱藏 |
| 登入 | Cloudflare Access（Zero Trust） |
| 部署 | Workers Builds（連接 GitHub，推送即自動建置部署）；亦保留 Wrangler 手動部署 |

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

## 部署

採 **Workers Builds**：將此 Worker 連接 GitHub 儲存庫，推送至 `master` 即自動建置並部署；
其他分支則建立預覽版本（preview）。Git 連接屬 OAuth 授權流程，僅能於 Cloudflare 儀表板設定。

### 一次性前置（沿用既有資源，僅需做一次）

1. 建立 KV namespace，並把回傳的 `id` 填入 `wrangler.jsonc` 的 `kv_namespaces[0].id`：

   ```bash
   pnpm exec wrangler kv namespace create KV
   ```

2. 設定 LINE 推播所需的 Worker **執行時 secret**（與部署方式無關，設定後長期保留）：

   ```bash
   pnpm exec wrangler secret put LINE_CHANNEL_ACCESS_TOKEN
   pnpm exec wrangler secret put LINE_USER_ID
   ```

   > 注意：這些是「執行時」機密，非「建置時」變數。Workers Builds 的 Build variables and secrets
   > 僅在建置階段可見，本專案的 LINE 機密不需放在那裡。

### 連接 GitHub 自動部署（Workers Builds）

> 前提：Cloudflare 上的 Worker 名稱必須與 `wrangler.jsonc` 的 `name`（`house-monitor`）一致，否則建置會失敗。
> 若尚未建立該 Worker，可先手動部署一次（見下方「手動部署」）以建立同名 Worker。

1. Cloudflare 儀表板 → **Workers & Pages** → 選擇 `house-monitor`。
2. **Settings** → **Builds** → **Connect**，依指示授權 Cloudflare 的 GitHub App
   並選擇 `HayaoGai/taichung-house-analyst` 儲存庫。
3. 設定建置參數：

   | 欄位 | 值 |
   |---|---|
   | Git branch（生產分支） | `master`（儀表板預設為 `main`，**務必改成 `master`**） |
   | Build command | `pnpm run build` |
   | Deploy command | `npx wrangler deploy`（預設值，保持即可） |
   | Non-production branch deploy command | `npx wrangler versions upload`（預設值，保持即可） |
   | Root directory | 留空（即儲存庫根目錄） |

   - 套件管理器：偵測到 `pnpm-lock.yaml` 會自動使用 pnpm，無需設定。
   - Node 版本：由根目錄 `.node-version`（`22`）決定。

4. 儲存後推送一個 commit 至 `master` 觸發首次自動建置與部署；之後每次推送 `master` 都會自動部署。

6. 在 Cloudflare Zero Trust 建立 **Access Application** 保護該網域（含 `/` 與 `/api/*`），
   Policy 設為僅允許本人 email（One-time PIN 或 Google 登入）。
   - 前端不需任何登入畫面；登入由 Access 在邊緣處理。
   - Cron 的 `scheduled` 為伺服器端事件，不受 Access 影響，照常執行。

7. 首次部署後執行一次手動更新以建立初始資料（或等 ≤1 分鐘讓首次 cron 自動 seed）：

   ```bash
   curl -X POST https://<你的網域>/api/refresh
   ```

8. （v0.0.2 升級者）一次性刪除舊的 `seen_ids` key（已由 `notified_keys` 取代）：

   ```bash
   pnpm exec wrangler kv key delete --binding KV seen_ids
   ```

### 手動部署（備援）

若需繞過 Workers Builds 直接從本機部署（會先 `quasar build` 再 `wrangler deploy`）：

```bash
pnpm exec wrangler login
pnpm deploy
```

## API

| 方法 | 路徑 | 行為 |
|---|---|---|
| GET | `/api/houses` | 回傳 `{ houses, meta }`（KV 最新資料，已套用黑名單） |
| POST | `/api/refresh` | 立即跑一次抓取週期並重置隨機週期，回傳最新 `{ houses, meta }`（已套用黑名單；距上次更新 < 10 秒則略過實際抓取） |
| POST | `/api/blacklist` | body `{ price, room, houseage }`，將該三項加入黑名單（append-only，去重） |

## 免費方案額度

- KV 寫入：整包覆寫，一天約 288 次（隨機 4~6 分一次），遠低於 1000 次/日上限。
- Worker invocation：Cron 每分鐘 1 次，一天 1440 次。
- 每週期外部請求 ≤45 頁、每批並行 ≤6 條連線。
