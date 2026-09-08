# 台中待售房屋監控

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
| 存取控制 | 首頁公開；擁有者端點置於 `/owner/*`，由 Cloudflare Access（Zero Trust）保護 |
| 部署 | Workers Builds（連接 GitHub，推送即自動建置部署）；亦保留 Wrangler 手動部署 |

## 專案結構

```
.
├─ index.html              # Quasar SPA 進入點樣板
├─ quasar.config.js        # Quasar 設定（含 API 代理到本機 wrangler dev）
├─ wrangler.jsonc          # Cloudflare Worker / 靜態資源 / KV / Cron 設定
├─ worker/index.js         # 後端 Worker：抓取、篩選、KV、API 路由、Cron
└─ src/                    # 前端原始碼
   ├─ App.vue
   ├─ router/routes.js     # /（訪客）與 /owner（擁有者）兩條路由，同一個畫面
   ├─ layouts/MainLayout.vue
   ├─ pages/IndexPage.vue  # 主畫面：頂列倒數/更新 + 虛擬滾動卡片列表
   ├─ components/HouseCard.vue
   └─ composables/
      ├─ useHouses.js  # 資料流、倒數、自動銜接、更新、黑名單
      └─ useOwner.js   # 依路由判定擁有者模式，並組出 /owner/api/* 路徑
```

## 存取控制

站台原本整站掛 Cloudflare Access（Zero Trust），僅本人可進。改為公開展示後，Access 沒有拿掉，
而是**縮小到 `/owner` 這一條路徑**：首頁對所有人開放，擁有者功能則整包搬進受保護的前綴底下。

### 為什麼是「搬端點」而不是「保護頁面」

這是整個設計最關鍵的一點：**Access 保護的是路徑，而頁面路徑和 API 路徑是兩回事。**

若只把擁有者「頁面」放到 `/owner` 並用 Access 保護，卻讓它照樣呼叫 `/api/refresh`，
那條 API 完全不在 Access 的涵蓋範圍內——任何人 `curl -X POST` 一下就繞過去了。
同理，只在前端用 `v-if` 藏按鈕也毫無作用，開 DevTools 就看得到端點。

所以寫入類端點本身必須搬進受保護的前綴：

| 路徑 | 保護 | 用途 |
|---|---|---|
| `GET /api/houses` | 公開 | 看板讀取資料 |
| `/owner` | Access | 擁有者頁面（SPA 路由） |
| `POST /owner/api/refresh` | Access | 手動更新 |
| `POST /owner/api/blacklist` | Access | 加入黑名單 |

path-based 的 Access application 會涵蓋該路徑底下的所有子路徑，故一條 `/owner` 的規則
就同時罩住頁面與其下的 API。未通過驗證的請求會被擋在 Cloudflare 邊緣，**根本到不了 Worker**。

> ⚠️ 設定時的坑：萬用字元寫成 `/owner/*` **不會**涵蓋 `/owner` 本身。
> 若要用萬用字元，`/owner` 與 `/owner/*` 兩條都要設。

### 權限矩陣

| 操作 | 本人（通過 Access） | 訪客 |
|---|---|---|
| 瀏覽物件列表 | ✅ | ✅ |
| 右上角按鈕 | 「手動更新」→ `POST /owner/api/refresh`，真的跑一次抓取週期 | 「重新載入」→ `GET /api/houses`，只重讀 KV |
| 卡片垃圾桶 | 寫入 KV `blacklist`，長期、跨裝置生效 | 只存進訪客自己的 `localStorage`，不碰後端 |

訪客的所有操作都**不觸發對外抓取、不寫 KV、不發 LINE 推播**，對免費額度是零成本；
互動性完整保留，面試官點得到、也玩得起來，但動不到本人的資料。

黑名單內容本身不會外洩：`buildHousesPayload()` 在伺服器端套用完才回傳，API 只吐出過濾後的結果。

### 本人如何取得權限

直接開 `https://<你的網域>/owner`，Access 會要求登入（One-time PIN 或 Google），
通過後即為擁有者模式。不需要產生、保管或記憶任何權杖；
Access 的工作階段 cookie 會自動帶到 `/owner/api/*` 的請求上。

撤銷方式：到 Zero Trust 儀表板改 policy 或撤銷工作階段即可，並有登入稽核紀錄可查。

`/owner` 這個路徑**不需要保密**——真正的閘門是 Access，不是路徑難猜。

### Worker 端的補強

Worker 沒有做完整的 JWT 驗簽（那需要額外設定 team domain 與 AUD tag），
但 `isOwner()` 會檢查請求是否帶有 Access 簽發的 `Cf-Access-Jwt-Assertion` header：

- 通過 Access 的請求一定帶有此 header。
- 若哪天 Access 應用被誤刪或路徑設錯，請求會不帶 header 抵達 Worker，此時直接回 403，
  而不是無聲地把寫入端點對外全開。

這**不是**密碼學驗證，擋不住刻意偽造 header 的攻擊者；它的價值在於攔下設定失誤造成的意外暴露。
若要升級為真正的驗證，就是驗簽 + 檢查 `aud` / `iss` / `exp`。

> 注意：Access policy 若設為 **Bypass** 不會走驗證流程，也就不會有 JWT header，
> Worker 會回 403。請使用 **Allow** policy。

### 額度的第二道防線

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
# quasar.config.js 已把 /api 與 /owner/api 代理到 8787，故前端可直接呼叫 API
pnpm dev
```

- 訪客畫面：<http://localhost:9000/>；擁有者畫面：<http://localhost:9000/owner>。
- 本機沒有 Cloudflare Access，請求不會帶 `Cf-Access-Jwt-Assertion`，因此要在 `.dev.vars`
  設 `ALLOW_INSECURE_OWNER=true` 才能測試手動更新與黑名單。**此變數僅限本機**。
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
   ```

   > 注意：這些是「執行時」機密，非「建置時」變數。Workers Builds 的 Build variables and secrets
   > 僅在建置階段可見，本專案的 LINE 機密不需放在那裡。

   > **絕對不要**在正式環境設定 `ALLOW_INSECURE_OWNER`——那是本機開發用的放行旗標，
   > 設了等於把 `/owner/api/*` 完全對外開放。

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

5. 在 **Zero Trust** → **Access** → **Applications** 建立（或改設）一個 self-hosted application，
   涵蓋 `<你的網域>/owner`，policy 設為僅允許本人 email（One-time PIN 或 Google 登入）。

   - **只保護 `/owner`，不要保護整個網域**——首頁要對所有人開放。
   - 若用萬用字元，`/owner` 與 `/owner/*` 兩條都要設；`/owner/*` 不涵蓋 `/owner` 本身。
   - policy 必須是 **Allow**。設成 Bypass 不會簽發 JWT，Worker 會回 403。
   - Cron 的 `scheduled` 是伺服器端事件，不受 Access 影響，照常執行。

   驗證設定是否正確：

   ```bash
   # 應被 Access 攔下（302 導向登入頁），而不是 200
   curl -si -X POST https://<你的網域>/owner/api/refresh | head -1
   # 首頁應正常回 200，不需登入
   curl -so /dev/null -w '%{http_code}\n' https://<你的網域>/api/houses
   ```

6. （建議）在 Cloudflare 儀表板 → **Security** → **WAF** → **Rate limiting rules** 加一條規則，
   路徑符合 `/api/*` 時限制每 IP 10 秒 20 次。免費方案含 1 條，純設定不需改碼。

7. 首次部署後開啟 `https://<你的網域>/owner`，登入後按一次「手動更新」以建立初始資料
   （或等 ≤1 分鐘讓首次 cron 自動 seed）。

   > 這一步不再用 curl：`/owner/api/*` 由 Access 保護，CLI 需要另外申請 service token。

8. （v0.0.2 升級者）一次性刪除舊的 `seen_ids` key（已由 `notified_keys` 取代）：

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

`/owner/api/*` 由 Cloudflare Access 保護，未通過驗證的請求會被擋在邊緣（302 導向登入頁），
不會抵達 Worker；萬一 Access 設定失效而讓請求穿透，Worker 會因缺少 `Cf-Access-Jwt-Assertion`
而回 `403 { "error": "Forbidden" }`。

| 方法 | 路徑 | 權限 | 行為 |
|---|---|---|---|
| GET | `/api/houses` | 公開 | 回傳 `{ houses, meta }`（KV 最新資料，已套用黑名單）；帶 `cache-control: private, max-age=10` |
| POST | `/owner/api/refresh` | Access | 立即跑一次抓取週期並重置隨機週期，回傳最新 `{ houses, meta }`（距上次**嘗試**更新 < 60 秒則略過實際抓取） |
| POST | `/owner/api/blacklist` | Access | body `{ price, room, houseage, address }`，四項加入黑名單（append-only，去重）；缺欄位回 400 |

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
- LINE 推播僅由 `runCycle` 觸發，故同樣受 Access 閘門與 cron 節奏約束。
