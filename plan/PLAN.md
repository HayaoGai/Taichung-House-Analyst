# 專案計畫：591 待售物件監控看板

> 本文件為「實作規格書」，主要讀者是負責實作的 AI agent。請完全依照本文件實作；凡標示「假設 / 待確認」之處，請先以本文件的決策實作，並在程式碼註解中標明，方便人工後續調整。

---

## 1. 專案概述

建立一個**個人用**的房屋物件監控看板：

- 後端定期（隨機 4~6 分鐘一次）向 591 的 BFF API 抓取符合條件的待售物件，經過篩選後存入儲存層。
- 前端（Vue 3 + Quasar）以**滾動式列表（不分頁）**顯示最新一批資料，右上角顯示「距離下次更新的倒數（MM:SS）」與「手動更新」按鈕。
- 整個網站以 **Cloudflare Access** 做登入保護，只有本人能載入。

部署目標：**Cloudflare（免費方案內可運作）**。

---

## 2. 技術堆疊與託管架構

| 項目 | 選擇 |
|---|---|
| 前端框架 | Vue 3 + Quasar（SPA 模式，`quasar build` 產出 `dist/spa`） |
| 後端 / 排程 | 單一 Cloudflare Worker（同時負責：靜態資源、API 路由、Cron 排程） |
| 資料儲存 | Cloudflare Workers KV（單一 JSON blob，見 §4） |
| 登入驗證 | Cloudflare Access（Zero Trust），於邊緣保護整個應用 |
| 部署工具 | Wrangler |

**為何用單一 Worker 同時服務 SPA + API + Cron：** Cloudflare Worker 現已原生支援靜態資源（`assets`）。把建置好的 Quasar SPA 當靜態資源掛上，`/api/*` 交給 Worker 的 `fetch` handler，Cron 交給 `scheduled` handler，一個可部署單元就能涵蓋全部需求，最省事也最省額度。

---

## 3. 系統架構與資料流

```
                 ┌─────────────── Cloudflare Access（登入閘門）───────────────┐
                 │                                                            │
   使用者瀏覽器 ──┤  GET  /            → 回傳 Quasar SPA 靜態檔                  │
                 │  GET  /api/houses  → 從 KV 讀出最新資料 + meta             │
                 │  POST /api/refresh → 立即跑一次抓取，並重置隨機週期         │
                 └────────────────────────────┬───────────────────────────────┘
                                              │ (讀/寫)
                                          ┌───▼────┐
   Cron Trigger（每分鐘）── scheduled() ──►│  KV    │  house_data / meta
        └─ 依 meta.nextRunAt 閘門判斷是否真的執行本次抓取
                 │ (符合條件才抓)
                 ▼
        591 BFF API（外部，分批抓取，每批 ≤6 條連線）
```

關鍵點：

- **抓取只在後端進行**（Cron 或手動 refresh 觸發），前端永遠只讀 KV 的成品，不直接打 591。
- Cron 的 `scheduled` handler 是伺服器端事件，**不經過 Cloudflare Access**，不受登入影響。
- 前端的 `fetch` 會自動帶上 Access 的 session cookie，故 `/api/*` 受 Access 保護也能正常呼叫。

---

## 4. 儲存層設計（KV）

使用單一 KV namespace，兩個 key：

### key: `house_data`
存放**篩選後**的物件陣列（整包覆寫，不逐筆寫）。

```jsonc
// JSON 字串
[
  {
    "houseid": 123456,
    "title": "...",
    "room": "3房2廳2衛",
    "showhouseage": "屋齡 10 年",
    "floor": "5F/12F",
    "section_name": "西屯區",
    "address": "...",
    "showprice": 1280,
    "photo_url": "https://.../400x300/...jpg"
    // 視前端需要保留的欄位即可，其餘可不存以節省空間
  }
]
```

### key: `meta`
```jsonc
{
  "lastUpdatedAt": 1718000000000,  // 最後一次成功更新的時間（epoch ms）
  "nextRunAt": 1718000300000,      // 下次預定抓取時間（epoch ms）
  "intervalSec": 287,              // 本週期的隨機長度（240~360 秒）
  "lastStatus": "ok"               // "ok" | "error"；抓取失敗時保留上一份 house_data
}
```

**為何用單一 blob 而非逐筆 key：** KV 免費方案每天僅 1000 次寫入。若每筆各存一個 key，約 400 筆 × ~288 週期/天 ≈ 11.5 萬次寫入會直接爆量。整包覆寫一天只有 ~288 次寫入，遠在限制內。讀取（10 萬/天）也足夠。

---

## 5. 後端 Worker 規格

### 5.1 排程與「隨機 4~6 分鐘」週期邏輯

- `wrangler` 設定 Cron Trigger 為**每分鐘觸發一次**（`* * * * *`）。
- 每次 `scheduled` 觸發時：讀 `meta`，若 `meta` 不存在（首次部署）或 `Date.now() >= meta.nextRunAt`，才真正執行一次抓取週期（`runCycle`）；否則直接結束（只花極少 CPU）。
- `runCycle` 成功後，產生新的隨機週期長度並更新 `nextRunAt`。

```js
// 產生 240~360 秒（4~6 分鐘）的隨機間隔
function randomIntervalSec() {
  return Math.floor(Math.random() * (360 - 240 + 1)) + 240;
}

export default {
  async scheduled(event, env, ctx) {
    const meta = await readMeta(env); // 解析 KV 的 meta，可能為 null
    const now = Date.now();
    if (!meta || now >= meta.nextRunAt) {
      ctx.waitUntil(runCycle(env));
    }
  },
  async fetch(request, env, ctx) {
    // 見 §5.4 API 路由
  }
};
```

> 為何不用原生 cron 設「隨機 4~6 分」：Cloudflare cron 是固定排程，無法隨機，也無法被「手動更新」即時改變。用「每分鐘觸發 + `nextRunAt` 閘門」即可同時滿足「隨機週期」與「手動更新後重新隨機」兩個需求。每分鐘觸發一天 1440 次 invocation、1440 次 KV 讀，皆遠低於免費上限。

### 5.2 抓取邏輯（分頁、分批、去重、安全網）

API 規格（**請完全照抄 headers 與 query 參數，`$` 符號為 591 query 語法的一部分，需保留為字面值**）：

```js
const SECTION_IDS = [98,99,100,101,102,103,104,105,106,107,108,109,110,116,117,118];

function buildUrl(firstRow) {
  const ts = Date.now();
  return `https://bff-house.591.com.tw/v1/web/sale/list?timestamp=${ts}&type=2&category=1&regionid=8&kind=9&price=$0_$1400&shape=3,4&houseage=$0_$25&firstRow=${firstRow}&order=price_asc`;
}

const REQUEST_HEADERS = {
  'accept': '*/*',
  'accept-language': 'zh-TW,zh;q=0.9',
  'cache-control': 'no-cache',
  'device': 'pc',
  'deviceid': '19a61088873525d81ac0c2ffba0ef4c0',
  'pragma': 'no-cache',
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
};

async function fetchPage(firstRow) {
  const res = await fetch(buildUrl(firstRow), { method: 'GET', headers: REQUEST_HEADERS });
  if (!res.ok) throw new Error(`591 API ${res.status} @ firstRow=${firstRow}`);
  const json = await res.json();
  return {
    total: Number(json?.data?.total ?? 0),
    list: json?.data?.house_list ?? [],
  };
}
```

抓取流程（`scrapeAll`）：

1. 先打一次 `firstRow=0`，取得 `total` 與第一頁 `list`。每頁約回傳 20~30 筆。
2. 以 `houseid` 為鍵，邊累積邊去重（防止分頁位移造成重覆，這是技術性去重，與 §5.3 的業務去重不同）。
3. 以第一頁的長度作為 `pageSize` 推估後續 offset：`pageSize, 2*pageSize, ...`（< `total`）。
4. **分批，每批最多 6 個並行**（受 Worker 同時 6 條對外連線限制）；批與批之間 `await`。
5. **安全網**：若累積數量仍 < `total`，改用「`firstRow = 目前已抓筆數`」**循序補抓**，直到達到 `total`、或某次回傳 0 筆、或某次沒有新增任何 `houseid` 即停止；並加上硬上限（如最多 60 次）避免無窮迴圈。
6. **外部 subrequest 上限保護**：免費方案每次 invocation 外部請求上限 50。請限制總頁數（例如 ≤ 45 頁），若 `total` 過大導致頁數超限，記錄警告並只抓前 45 頁。

```js
function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

async function scrapeAll() {
  const MAX_PAGES = 45;
  const all = [];
  const seenIds = new Set();
  const pushUnique = (list) => {
    for (const h of list) {
      if (h?.houseid != null && !seenIds.has(h.houseid)) {
        seenIds.add(h.houseid);
        all.push(h);
      }
    }
  };

  const first = await fetchPage(0);
  const total = first.total;
  pushUnique(first.list);
  if (total === 0 || first.list.length === 0) return all;

  const pageSize = first.list.length;
  const offsets = [];
  for (let off = pageSize; off < total && offsets.length < MAX_PAGES - 1; off += pageSize) {
    offsets.push(off);
  }

  for (const batch of chunk(offsets, 6)) {
    const pages = await Promise.all(batch.map((off) => fetchPage(off)));
    pages.forEach((p) => pushUnique(p.list));
  }

  // 安全網：循序補抓
  let guard = 0;
  while (all.length < total && guard < 60) {
    guard++;
    const p = await fetchPage(all.length);
    if (p.list.length === 0) break;
    const before = all.length;
    pushUnique(p.list);
    if (all.length === before) break; // 沒有新增 → 停止
  }
  return all;
}
```

### 5.3 篩選邏輯（業務規則）

對 `scrapeAll()` 得到的 `allHouses` 依序套用以下「**剔除**」規則，保留通過者。請完全照下列述語實作；`section_id` 比對與業務去重請用 `Set` 以維持 O(n)、把 CPU 壓在免費 10ms 內。

1. `photoNum` 為 `0` → 剔除。
2. `floor` 符合 `floor === '整棟/1F' || ( !floor.includes('整棟') && !floor.includes('~') )` → 剔除（`floor` 缺值時視為空字串，依此規則會被剔除）。
3. `price`、`room`、`houseage` **三者同時都存在且相同**的資料 → 剔除（保留第一筆；資料來源為 `price_asc`，故第一筆為價格較低者）。任一欄缺值則不參與此去重、予以保留。
4. `section_id` 不在 `[98,99,100,101,102,103,104,105,106,107,108,109,110,116,117,118]` 之內 → 剔除。

參考實作：

```js
const SECTION_ID_SET = new Set([98,99,100,101,102,103,104,105,106,107,108,109,110,116,117,118]);

function filterHouses(allHouses) {
  const seenKeys = new Set();
  const result = [];
  for (const h of allHouses) {
    // 規則 1
    if (h.photoNum === 0) continue;

    // 規則 2
    const floor = h.floor ?? '';
    if (floor === '整棟/1F' || (!floor.includes('整棟') && !floor.includes('~'))) continue;

    // 規則 3
    if (!SECTION_ID_SET.has(Number(h.section_id))) continue;

    result.push(h);
  }
  return result;
}
```

### 5.4 完整週期（`runCycle`）與資料寫入

```js
async function runCycle(env) {
  const now = Date.now();
  try {
    const raw = await scrapeAll();
    const filtered = filterHouses(raw);
    // 只保留前端需要的欄位以節省 KV 容量（見 §6.2）
    const slim = filtered.map(pickFrontendFields);
    await env.KV.put('house_data', JSON.stringify(slim));
    await env.KV.put('meta', JSON.stringify({
      lastUpdatedAt: now,
      nextRunAt: now + randomIntervalSec() * 1000,
      intervalSec: undefined, // 可選填
      lastStatus: 'ok',
    }));
  } catch (err) {
    // 抓取失敗：保留上一份 house_data，僅延後下次嘗試（短一點，例如 1 分鐘後重試）
    await env.KV.put('meta', JSON.stringify({
      lastUpdatedAt: (await readMeta(env))?.lastUpdatedAt ?? null,
      nextRunAt: now + 60 * 1000,
      lastStatus: 'error',
    }));
    console.error('runCycle failed:', err);
  }
}
```

### 5.5 API 路由（`fetch` handler）

| 方法 | 路徑 | 行為 |
|---|---|---|
| GET | `/api/houses` | 從 KV 讀 `house_data` 與 `meta`，回傳 `{ houses, meta }`。若無資料，回傳 `{ houses: [], meta: { lastUpdatedAt: null, nextRunAt: Date.now() } }`。 |
| POST | `/api/refresh` | 立即執行一次 `runCycle`（含重置隨機 `nextRunAt`），完成後回傳最新 `{ houses, meta }`。 |
| 其他 | `/*` | 交給靜態資源（SPA）。 |

- 回應一律 `Content-Type: application/json`（API）；SPA fallback 回 `index.html`。
- `/api/refresh` 可加一個簡單防連點保護：若距離上次更新 < 10 秒則略過實際抓取、直接回現有資料（可選）。

### 5.6 韌性與「禮貌性」

- 每個對外 `fetch` 設逾時（例如 10 秒）與單次重試（指數退避）。
- 任何一頁失敗不要讓整個週期崩潰：可記錄並以目前已抓到的資料繼續（或標記 `lastStatus: 'error'` 保留舊資料）。
- 抓取失敗時**保留上一份成功的 `house_data`**，前端才不會突然空白。
- 維持每週期 ≤16 次請求、4~6 分鐘一次的節奏，不要縮短或並行爆量，以免被來源端封鎖。

---

## 6. 前端規格（Vue 3 + Quasar）

### 6.1 版面

- 單一頁面。頂部固定列（`QHeader`）：左側標題；**右上角**顯示「下次更新倒數 MM:SS」與「手動更新」按鈕（`QBtn`，可帶 `refresh` icon）。
- 主體為**滾動式列表（不分頁）**，一次顯示全部篩選後物件。資料量約數百筆，請使用 **`QVirtualScroll`**（虛擬滾動）渲染卡片，確保滾動順暢。

### 6.2 每張卡片顯示欄位與連結

| 顯示項 | 來源 / 處理 |
|---|---|
| 照片 | `photo_url.replace('400x300', '1000xwater2')` |
| 標題 | `title` |
| 格局 | `room` |
| 屋齡 | `showhouseage` |
| 樓層 | `floor` |
| 地址 | 顯示 `` `${section_name} - ${address}` ``；**可點按**，開新分頁導向 Google 地圖：`https://www.google.com/maps/search/?api=1&query=` + `encodeURIComponent(`${section_name} ${address}`)` |
| 總價 | `` `${showprice} 萬` `` |
| 整張卡片 | **可點按**，開新分頁導向 `` `https://sale.591.com.tw/home/house/detail/2/${houseid}.html` `` |

- 地址連結需 `@click.stop`（`stopPropagation`），避免同時觸發整張卡片的詳情導向。
- 連結一律 `target="_blank"` + `rel="noopener"`。
- `pickFrontendFields`（後端用）至少需保留：`houseid, title, room, showhouseage, floor, section_name, address, showprice, photo_url`。

### 6.3 資料流與更新行為

狀態：`houses[]`、`nextRunAt`、`lastUpdatedAt`、`now`（每秒更新）。

- **初始載入**：`GET /api/houses` → 填入 `houses / meta`。
- **倒數顯示**：`remaining = max(0, nextRunAt - now)`，格式化為 `MM:SS`，每秒重算。
- **自動更新銜接**：當 `remaining` 歸零，開始每 5 秒輪詢 `GET /api/houses`；一旦回傳的 `lastUpdatedAt` 比目前新，代表後端 cron 已更新 → 以新資料**整批取代**列表、更新 `nextRunAt/lastUpdatedAt`、停止輪詢。
- **手動更新按鈕**：點擊後禁用按鈕並顯示 loading → `POST /api/refresh` → 以回傳資料**整批取代**列表、更新 `nextRunAt/lastUpdatedAt`（即「重新隨機下一個週期」）→ 恢復按鈕。
- **每次更新都整批取代**（先清空再填入），不做增量合併、不保留舊資料畫面。

> 倒數的真實來源是後端 `meta.nextRunAt`，前端只負責顯示與在歸零後銜接，避免前後端時間不一致。

---

## 7. 登入驗證（Cloudflare Access）

- 在 Cloudflare Zero Trust 建立一個 **Access Application**，保護本 Worker 對應的網域（含 `/` 與 `/api/*`）。
- Policy 設為僅允許本人 email（用 One-time PIN 或 Google 登入）。個人用途免費。
- **前端不需實作任何登入畫面或帳密邏輯**；登入由 Access 在邊緣處理，登入後瀏覽器持有 session cookie，後續 `fetch /api/*` 會自動帶上。
- Cron 的 `scheduled` 為伺服器端事件，不受 Access 影響，照常執行。

---

## 8. 部署與設定

### 8.1 `wrangler` 設定（示意）

```jsonc
{
  "name": "house-monitor",
  "main": "src/worker.js",
  "compatibility_date": "2026-01-01",
  "assets": { "directory": "./dist/spa", "not_found_handling": "single-page-application" },
  "kv_namespaces": [
    { "binding": "KV", "id": "<your-kv-namespace-id>" }
  ],
  "triggers": { "crons": ["* * * * *"] }
}
```

### 8.2 建置與部署流程

1. `quasar build`（SPA 模式）→ 產出 `dist/spa`。
2. 建立 KV namespace 並填入 `wrangler` 設定。
3. `wrangler deploy`。
4. 在 Cloudflare Zero Trust 設定 Access Application 保護該網域。
5. 部署後執行一次手動 `POST /api/refresh`（或等待 ≤1 分鐘讓首次 cron 自動 seed）以建立初始資料。

---

## 9. 常數與設定彙整

- 週期：隨機 **240~360 秒**（4~6 分鐘）。
- Cron 觸發頻率：每 1 分鐘。
- 每批並行請求上限：**6**。
- 每週期外部請求上限：**≤45 頁**（保守，免費上限為 50）。
- `section_id` 允許清單：`[98,99,100,101,102,103,104,105,106,107,108,109,110,116,117,118]`。
- API headers / URL 模板：見 §5.2（需照抄）。

---

## 10. 注意事項

1. **欄位命名（已確認）**：篩選用的 `photoNum` 確實為駝峰命名，與其他底線命名欄位（`photo_url`、`section_id`、`section_name`、`showprice`、`showhouseage` 等）並存——這是該 API 自身命名不一致所致，請**照實作，勿自行改成 `photo_num`**。
2. **User-Agent（已加入）**：`REQUEST_HEADERS` 已內含一組桌面版 Chrome 的 `user-agent`（見 §5.2）。若日後 591 改版導致請求被擋（非 200），可更新成較新的瀏覽器 UA 字串再試。
3. **KV 最終一致性**：KV 全球同步可能有數十秒延遲，對本案（單人、4~6 分週期）可接受。若日後需要嚴格的計時/狀態一致性，可將 `meta` 改用 Durable Object（屬付費功能範疇，非必要）。
4. **CPU 額度**：免費方案每次 invocation CPU 上限 10ms。篩選已用 `Set` 維持 O(n)，預期遠低於上限；若日後資料量大增導致超時，升級 Workers 付費方案（約每月 US$5）即可放寬至 5 分鐘。
5. **託管替代方案**：本案採「單一 Worker + 靜態資源」。若偏好，亦可改為 Cloudflare Pages 託管 SPA + 獨立 Worker 處理 API/Cron，但需自行處理 KV 共用與路由，較不省事。

---

## 11. 驗收標準（Checklist）

- [ ] 未登入者無法載入任何頁面（Cloudflare Access 生效）。
- [ ] 後端每隔隨機 4~6 分鐘自動抓取並更新一次資料。
- [ ] 抓取會依 `total` 分頁抓完，且每批並行不超過 6 條連線。
- [ ] 四條篩選規則皆正確套用（可用少量樣本驗證剔除結果）。
- [ ] 前端以滾動式（虛擬滾動）列表顯示全部資料，無分頁。
- [ ] 每張卡片正確顯示八個欄位；照片網址已做 `400x300 → 1000xwater2` 轉換。
- [ ] 點地址 → 開 Google 地圖；點卡片 → 開 591 詳情頁；兩者不互相觸發。
- [ ] 右上角倒數 `MM:SS` 正確；歸零後能自動銜接最新資料。
- [ ] 手動更新按鈕會即時抓取、整批取代資料，並重置隨機週期與倒數。
- [ ] 每次更新皆整批清空後重填，無殘留舊資料。
- [ ] 抓取失敗時保留上一份資料，畫面不空白。
- [ ] 全部運作維持在 Cloudflare 免費方案額度內。
