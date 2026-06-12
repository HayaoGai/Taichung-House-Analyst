# 專案修改規格（增量）：黑名單系統 + LINE 去重改用 price/room/houseage

> 本文件為對既有專案的「增量修改」，請與原 plan 及前一份「houseid 持久化 + LINE 通知」規格合併實作。涉及：KV schema、`runCycle`、API 路由、前端卡片、驗收標準。

## 1. 變更摘要

1. **新增黑名單系統**：前端每張卡片右下角加一顆垃圾桶圖示按鈕，按下後將該物件的 `price`、`room`、`houseage` 加入黑名單。任何物件只要這三項**皆相同**，即從前端畫面過濾、不顯示。
2. **LINE 去重基準改變**：不再使用 `seen_ids`（houseid）判斷是否已發送 LINE，改以物件的 `price`、`room`、`houseage` 是否皆相同來判斷；並儲存這些「已通知」的鍵值。**移除所有 `seen_ids` 相關程式碼，並刪除已存在的 `seen_ids` KV key**。
3. **調整 LINE 訊息格式**：見 §7。

> 註：黑名單與 LINE 去重皆以 (`price`,`room`,`houseage`) 為鍵，意即「不同物件但這三項恰好相同」會被視為同一筆處理（過濾只留一種、LINE 只通知一次）。此為刻意設計。

## 2. KV schema 變更

| Key | 動作 | 內容 |
|---|---|---|
| `seen_ids` | **移除** | 刪除程式碼引用，並刪除已存的 key（見 §9） |
| `blacklist` | **新增** | `[{ "price": ..., "room": ..., "houseage": ... }, ...]`；持久化、append-only；使用者按垃圾桶時追加 |
| `notified_keys` | **新增（取代 seen_ids 角色）** | 已通知過的鍵值字串陣列，如 `["1280|3房2廳2衛|10", ...]`；持久化、append-only；僅在有新通知時寫入 |
| `house_data` | **欄位調整** | 每筆**額外保留原始 `price`、`houseage`**（不顯示，供黑名單與 LINE 比對；`room` 原本已保留） |

`pickFrontendFields` 需保留欄位更新為：
`houseid, title, room, showhouseage, floor, section_name, address, showprice, photo_url, price, houseage`
（新增 `price`、`houseage` 兩個原始欄位）

## 3. 共用 helper

```js
// 黑名單與 LINE 去重共用的比對鍵
function tripleKey(h) {
  return `${h.price}|${h.room}|${h.houseage}`;
}

function applyBlacklist(houses, blacklist) {
  if (!blacklist || blacklist.length === 0) return houses;
  const blockedSet = new Set(blacklist.map(tripleKey));
  return houses.filter((h) => !blockedSet.has(tripleKey(h)));
}

async function readBlacklist(env) {
  const raw = await env.KV.get('blacklist');
  return raw ? JSON.parse(raw) : [];
}

async function readNotifiedKeys(env) {
  const raw = await env.KV.get('notified_keys');
  return raw ? JSON.parse(raw) : [];
}
```

## 4. 移除 seen_ids

- 刪除 `readSeenIds` 及所有讀寫 `seen_ids` 的程式碼。
- 以 `notified_keys`（§3、§7）取代其「判斷是否已發 LINE」的角色，但改用 `tripleKey` 比對。

## 5. 新增 API 路由：`POST /api/blacklist`

加入垃圾桶按鈕的後端端點（位於既有 `fetch` handler，受 Cloudflare Access 保護）：

```js
if (request.method === 'POST' && url.pathname === '/api/blacklist') {
  const { price, room, houseage } = await request.json();
  const blacklist = await readBlacklist(env);
  const key = `${price}|${room}|${houseage}`;
  const exists = blacklist.some((b) => `${b.price}|${b.room}|${b.houseage}` === key);
  if (!exists) {
    blacklist.push({ price, room, houseage });
    await env.KV.put('blacklist', JSON.stringify(blacklist)); // 僅使用者操作時寫，頻率極低
  }
  return Response.json({ ok: true });
}
```

## 6. 讀取時套用黑名單：`GET /api/houses` 與 `/api/refresh`

兩個回傳資料的地方都要對 `house_data` 套用「當前」黑名單，確保按下垃圾桶後重新整理即生效（不必等下一週期）：

```js
if (request.method === 'GET' && url.pathname === '/api/houses') {
  const [dataRaw, meta, blacklist] = await Promise.all([
    env.KV.get('house_data'),
    readMeta(env),
    readBlacklist(env),
  ]);
  const houses = dataRaw ? JSON.parse(dataRaw) : [];
  return Response.json({
    houses: applyBlacklist(houses, blacklist),
    meta: meta ?? { lastUpdatedAt: null, nextRunAt: Date.now() },
  });
}
```

`/api/refresh` 執行 `runCycle` 後，回傳資料時同樣以 `applyBlacklist(house_data, blacklist)` 過濾。

> `house_data` 本身存「通過抓取篩選的全量資料」（不在此處套黑名單）；黑名單一律於消費端（GET / refresh / LINE 前）即時套用，故黑名單永遠是最新狀態。

## 7. 改寫 `runCycle` 的通知區塊

取代前一份規格中以 `seen_ids` 判斷的通知邏輯。流程：篩選 → 存 `house_data`/`meta`（沿用既有）→ 套黑名單得 `visible` → 以 `notified_keys` 判斷新物件 → 一次送出 → 僅有新物件時寫回 `notified_keys`。

```js
// （既有）抓取 + 篩選
const filtered = filterHouses(raw);

// （既有）寫入 house_data（含新增的 price/houseage 原始欄位）與 meta
await env.KV.put('house_data', JSON.stringify(filtered.map(pickFrontendFields)));
// ... meta 寫入沿用既有 ...

// === LINE 通知：先套黑名單，再以 price/room/houseage 判斷是否已通知 ===
try {
  const [blacklist, notifiedKeys] = await Promise.all([
    readBlacklist(env),
    readNotifiedKeys(env),
  ]);
  const visible = applyBlacklist(filtered, blacklist);   // 黑名單物件不顯示也不通知
  const notifiedSet = new Set(notifiedKeys);
  const newHouses = visible.filter((h) => !notifiedSet.has(tripleKey(h)));

  if (newHouses.length > 0) {
    await sendLinePush(env, buildLineText(newHouses));   // 一週期最多一次
    // 送出成功才寫回；用 Set 去重避免同鍵重複堆積
    const updated = [...new Set(notifiedKeys.concat(newHouses.map(tripleKey)))];
    await env.KV.put('notified_keys', JSON.stringify(updated));
  }
  // 沒有新物件 → 不送 LINE、也不寫 notified_keys
} catch (err) {
  console.error('LINE notify step failed (will retry next cycle):', err);
}
```

### 調整後的 `buildLineText`（§3 變更：移除照片與地圖、格局/屋齡/樓層各自獨立成行）

```js
function buildLineText(newHouses) {
  const blocks = newHouses.map((h) => {
    const detailUrl = `https://sale.591.com.tw/home/house/detail/2/${h.houseid}.html`;
    return [
      `🏠 ${h.title}`,
      `格局：${h.room}`,
      `屋齡：${h.showhouseage}`,
      `樓層：${h.floor}`,
      `地址：${h.section_name} - ${h.address}`,
      `總價：${h.showprice} 萬`,
      `詳情：${detailUrl}`,
    ].join('\n');
  });

  let text = `🆕 新物件 ${newHouses.length} 筆\n\n` + blocks.join('\n\n');
  if (text.length > LINE_TEXT_LIMIT) {              // 超過 5000 字截斷（預期僅首次可能發生）
    text = text.slice(0, LINE_TEXT_LIMIT - 1) + '…';
  }
  return text;
}
```

## 8. 前端：卡片右下角垃圾桶按鈕

- 每張卡片右下角放一顆 `QBtn`（建議 `flat round dense`，icon 用 `delete` 或 `delete_outline`）。
- 點擊需 `@click.stop`，避免觸發整張卡片導向詳情頁。
- 點擊行為：**樂觀更新**——本地立即移除所有 `price`/`room`/`houseage` 皆相同的物件；同時 `POST /api/blacklist` 持久化。

```js
async function blacklistHouse(house) {
  const { price, room, houseage } = house;
  // 樂觀更新：本地移除所有三項皆相同者
  houses.value = houses.value.filter(
    (h) => !(h.price === price && h.room === room && h.houseage === houseage)
  );
  try {
    await fetch('/api/blacklist', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ price, room, houseage }),
    });
  } catch (e) {
    console.error('加入黑名單失敗，可重新整理還原：', e);
  }
}
```

> 前端卡片資料需能取得原始 `price`、`houseage`（已於 §2 加入 `house_data`）。

## 9. 一次性清理：刪除舊的 seen_ids key

部署新版後（或部署前），於專案根目錄執行一次：

```bash
npx wrangler kv key delete --binding KV seen_ids
```

（或在 Cloudflare 儀表板的 KV 介面手動刪除 `seen_ids`。）

## 10. 對 Cloudflare 免費額度的影響

- **KV 寫入**：移除 `seen_ids`（原為「有新才寫」）、新增 `notified_keys`（同樣「有新才寫」），兩者相抵，每日寫入量不變；`blacklist` 僅在使用者按垃圾桶時寫入，頻率極低。整體每日寫入仍遠低於 1000 次上限。✅
- **KV 讀取**：`GET /api/houses` 增為讀 3 個 key、`runCycle` 通知前讀 2 個 key，相對 10 萬/天可忽略。✅
- **每日 invocation**：新增的 `POST /api/blacklist` 僅在使用者操作時觸發，量極小。✅
- **subrequest / CPU**：抓取與 LINE 數量不變；黑名單比對用 `Set`（O(n)），對 10ms CPU 無實質影響。✅

**結論：本次修改仍完全在 Cloudflare 免費方案內。**

## 11. 驗收標準（追加 / 取代）

- [ ] 卡片右下角有垃圾桶按鈕，點擊不會觸發詳情導向（`@click.stop`）。
- [ ] 按下垃圾桶後，畫面立即移除所有 `price`/`room`/`houseage` 皆相同的物件，且重新整理後仍不顯示（已持久化）。
- [ ] 新抓取到、與黑名單三項皆相同的物件，不顯示也不發 LINE。
- [ ] 已移除所有 `seen_ids` 程式碼，且 KV 中的 `seen_ids` 已刪除。
- [ ] LINE 是否已發送改以 (`price`,`room`,`houseage`) 判斷；相同鍵值不重複發送。
- [ ] `house_data` 每筆含原始 `price`、`houseage`、`room`，供黑名單與去重比對。
- [ ] LINE 訊息格式為新版七行（無照片、無地圖；格局/屋齡/樓層各自獨立成行）。
- [ ] 沒有新物件的週期不寫 `notified_keys`、不發 LINE；LINE 失敗時不寫 `notified_keys`、不影響 `house_data`/`meta` 更新。
