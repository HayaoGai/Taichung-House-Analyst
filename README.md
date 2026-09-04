# 591 待售物件監控看板

個人用的房屋物件監控看板：後端定期（隨機 4~6 分鐘一次）向 591 BFF API 抓取台中符合條件的待售物件，篩選後存入 Cloudflare KV；前端（Vue 3 + Quasar）以滾動式虛擬列表顯示，右上角有「下次更新倒數」與更新按鈕。

站台本身公開（供作品展示），但**會消耗免費額度或改動個人資料的端點僅限本人**——詳見〈存取控制〉。

## 技術堆疊

| 項目 | 選擇 |
|---|---|
| 前端 | Vue 3 + Quasar（SPA，`quasar build` → `dist/spa`） |
| 後端 / 排程 | 單一 Cloudflare Worker（靜態資源 + API + Cron） |
| 儲存 | Cloudflare Workers KV（`house_data` / `meta` / `blacklist` / `notified_keys`） |
| 通知 | LINE 官方帳號 push（首次出現的物件才通知；以 price/room/houseage 去重） |
| 黑名單 | 卡片垃圾桶按鈕，將 price/room/houseage 三項皆相同者隱藏 |
| 存取控制 | 站台公開；寫入類端點以 `OWNER_TOKEN`（Worker secret）把關 |
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
   └─ composables/
      ├─ useHouses.js  # 資料流、倒數、自動銜接、更新、黑名單
      └─ useOwner.js   # 擁有者權杖（?key= → localStorage）與請求 header
```

## 存取控制

站台原本整站掛 Cloudflare Access（Zero Trust），僅本人可進。改為公開展示後，改用**端點層級**的權限控制。

### 為什麼閘門一定要放在 Worker

只把前端按鈕藏起來是無效的：`/api/refresh`、`/api/blacklist` 仍是公開端點，開 DevTools 就能直接打。
因此判斷寫在 `worker/index.js` 的 `isOwner()`，前端的 `useOwner.js` 只負責介面呈現與帶 header。

### 權限矩陣

| 操作 | 本人（持 `OWNER_TOKEN`） | 訪客 |
|---|---|---|
| 瀏覽物件列表 | ✅ | ✅ |
| 右上角按鈕 | 「手動更新」→ `POST /api/refresh`，真的跑一次抓取週期 | 「重新載入」→ `GET /api/houses`，只重讀 KV |
| 卡片垃圾桶 | 寫入 KV `blacklist`，長期、跨裝置生效 | 只存進訪客自己的 `localStorage`，不碰後端 |

訪客的所有操作都**不觸發對外抓取、不寫 KV、不發 LINE 推播**，對免費額度是零成本；
互動性完整保留，面試官點得到、也玩得起來，但動不到本人的資料。

黑名單內容本身不會外洩：`buildHousesPayload()` 在伺服器端套用完才回傳，API 只吐出過濾後的結果。

### 本人如何取得權限

1. 產生一組隨機字串並設為 Worker secret：

   ```bash
   openssl rand -hex 32          # 產生 token，複製起來
   pnpm exec wrangler secret put OWNER_TOKEN
   ```

2. 用 `https://<你的網域>/?key=<剛才那組 token>` 開啟一次。

   前端會把 token 存入 `localStorage`，並立刻以 `history.replaceState` 把 `?key=` 從網址列抹掉，
   避免 token 殘留在瀏覽記錄或不小心被複製出去的連結裡。之後直開網域即為擁有者模式。

3. 若 token 外洩需撤銷：重新 `wrangler secret put OWNER_TOKEN` 換一組即可，舊 token 立即失效
   （前端收到 403 會自動清掉本地 token 並退回唯讀模式）。

### 額度的第二道防線

即使 token 外洩，仍有以下保護：

- `REFRESH_DEBOUNCE_MS = 60000`：距上次**嘗試**更新未滿 60 秒則略過實際抓取。
  刻意以「嘗試」而非「成功」計時（`meta.lastRefreshAt`），否則抓取連續失敗時 `lastUpdatedAt` 不前進，防連點等同失效。
- `GET /api/houses` 回應帶 `cache-control: private, max-age=10`，連點與輪詢由瀏覽器擋下。
- 前端輪詢在分頁切到背景時停止（`visibilitychange`），避免被遺忘的分頁整天燒 KV read。
- 建議另在 Cloudflare 儀表板加一條 Rate Limiting rule（免費方案含 1 條）掛在 `/api/*`，例如 10 秒 20 次 / IP。

### 不希望被搜尋引擎收錄

`public/robots.txt`（`Disallow: /`）與 `index.html` 的 `<meta name="robots" content="noindex, nofollow">` 雙保險。

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
   pnpm exec wrangler kv namespace create HOUSES_KV
   ```

2. 設定 Worker **執行時 secret**（與部署方式無關，設定後長期保留）：

   ```bash
   pnpm exec wrangler secret put LINE_CHANNEL_ACCESS_TOKEN
   pnpm exec wrangler secret put LINE_USER_ID
   pnpm exec wrangler secret put OWNER_TOKEN   # 見〈存取控制〉
   ```

   > `OWNER_TOKEN` 未設定時，`/api/refresh` 與 `/api/blacklist` 一律回 403（安全預設）。
   > 也就是說忘了設只會讓自己用不了手動更新，不會讓端點門戶洞開。

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

5. （建議）在 Cloudflare 儀表板 → **Security** → **WAF** → **Rate limiting rules** 加一條規則，
   路徑符合 `/api/*` 時限制每 IP 10 秒 20 次。免費方案含 1 條，純設定不需改碼。

6. 首次部署後執行一次手動更新以建立初始資料（或等 ≤1 分鐘讓首次 cron 自動 seed）：

   ```bash
   curl -X POST https://<你的網域>/api/refresh -H "x-owner-token: <你的 OWNER_TOKEN>"
   ```

   > 少了 `x-owner-token` 會得到 403——這是預期行為，代表閘門生效中。

7. （v0.0.2 升級者）一次性刪除舊的 `seen_ids` key（已由 `notified_keys` 取代）：

   ```bash
   pnpm exec wrangler kv key delete --binding HOUSES_KV seen_ids
   ```

### 手動部署（備援）

若需繞過 Workers Builds 直接從本機部署（會先 `quasar build` 再 `wrangler deploy`）：

```bash
pnpm exec wrangler login
pnpm deploy
```

## API

寫入類端點需帶 `x-owner-token: <OWNER_TOKEN>`，否則回 `403 { "error": "Forbidden" }`。

| 方法 | 路徑 | 權限 | 行為 |
|---|---|---|---|
| GET | `/api/houses` | 公開 | 回傳 `{ houses, meta }`（KV 最新資料，已套用黑名單）；帶 `cache-control: private, max-age=10` |
| POST | `/api/refresh` | 僅本人 | 立即跑一次抓取週期並重置隨機週期，回傳最新 `{ houses, meta }`（距上次**嘗試**更新 < 60 秒則略過實際抓取） |
| POST | `/api/blacklist` | 僅本人 | body `{ price, room, houseage, address }`，四項加入黑名單（append-only，去重）；缺欄位回 400 |

## 抓取策略（分組查詢）

591 的 list API 支援 `section` 參數讓伺服器端先過濾里區，**但單次最多只吃 5 個 section，第 6 個起會被靜默忽略**。
故 Worker 將這 16 個里區每 5 個切成一組（4 組：5+5+5+1），逐組循序分頁抓取後合併去重。

- 由 591 端先過濾里區，抓回與待解析的資料量大減（實測全台中 778 筆 → 這 16 里區僅約 126 筆），
  對外請求數亦從最多 45 次降到約 7 次，藉此把 Worker 的 JSON 解析 CPU 壓在免費方案 10ms 上限內。
- 591 偶爾會夾帶無視 `section` 條件的推薦/廣告物件，故 `filterHouses` 仍保留里區白名單檢查（規則 3）作為防線。

## 免費方案額度

**KV 寫入是最緊的一項，且是站台公開後最需要保護的資源。** 免費上限 1000 次/日：

- 每個 cron 週期寫 `house_data` + `meta` = 2 次，偶爾再加 `seen_prices_v2`。
- 隨機 4~6 分一次 → 一天約 288 個週期 → **約 600~700 次/日，已用掉近七成**，
  剩餘 headroom 只有 300 左右。一次 `/api/refresh` 就吃掉 2~3 次。
- 額度耗盡時 KV put 會失敗，`runCycle` 進 catch、catch 內的 put 同樣失敗，看板會卡在舊資料上。
- 這正是 `/api/refresh` 必須限本人、且訪客的按鈕只做 `GET` 的原因。

其餘項目寬鬆：

- KV 讀取：每次 `GET /api/houses` 讀 3 個 key，上限 100,000 次/日。
- Worker invocation：Cron 每分鐘 1 次一天 1440 次，加上 `/api/*`；上限 100,000 次/日。
  靜態資源（SPA）走 Workers Assets，不計入此額度。
- 每週期對外請求總數 ≤45（`MAX_PAGES` 全域上限），保守低於免費 subrequest 50 次上限。
- LINE 推播僅由 `runCycle` 觸發，故同樣受 `OWNER_TOKEN` 與 cron 節奏約束。
