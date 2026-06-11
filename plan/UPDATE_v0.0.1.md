# 專案修改規格（增量）：houseid 持久化 + LINE 首次通知

> 本文件為對既有專案計畫的「增量修改」，請與原 [plan](./PLAN.md) 合併實作。涉及原 plan 的 §4（KV schema）、§5.2（抓取/headers）、§5.4（runCycle）、§11（驗收標準）。

## 1. 變更摘要

1. 新增一個持久化的 KV key `seen_ids`，記錄所有「曾經出現過」的 `houseid`。
2. `seen_ids` 為 **append-only**：不清空、不覆寫，只在「本週期出現了新的 houseid」時才把新 id 追加寫回。
3. 每個週期，對「首次出現（不在 `seen_ids` 內）」的物件，透過 LINE 官方帳號推播通知；已記錄過的物件不再通知。
4. 一個週期**最多送出一次** LINE push：收齊本週期所有篩選後資料、算出新物件後，合併成單一訊息一次送出。
5. LINE 訊息內容等同前端顯示欄位；若單則文字超過 5000 字上限則截斷（此情況預期僅首次執行可能發生）。

## 2. 新增 KV key：`seen_ids`

- **key**：`seen_ids`
- **value**：`houseid` 的 JSON 陣列，例如 `[123456, 234567]`
- **特性**：持久化、append-only。讀取後做差集判斷；**僅當本週期有新 id 時**才追加並寫回。
- **首次執行**：`seen_ids` 不存在時，`get` 視為空陣列 `[]`（此時全部篩選後物件都算「新」）。

## 3. 新增 Worker secrets（機密值）

程式僅透過 `env` 取用，**不得寫死於程式碼或 `wrangler.jsonc`**：

| Secret 名稱 | 用途 |
|---|---|
| `LINE_CHANNEL_ACCESS_TOKEN` | LINE 官方帳號的 Channel access token（推播授權） |
| `LINE_USER_ID` | 接收者（你本人）的 LINE user ID |

> 手動設定（由人執行，非 agent）：
> ```bash
> npx wrangler secret put LINE_CHANNEL_ACCESS_TOKEN
> npx wrangler secret put LINE_USER_ID
> ```
> 本機 `wrangler dev` 測試時改用根目錄 `.dev.vars`（需加入 `.gitignore`）。

## 4. LINE 推播實作

- **Endpoint**：`POST https://api.line.me/v2/bot/message/push`
- **Headers**：`Authorization: Bearer <LINE_CHANNEL_ACCESS_TOKEN>`、`Content-Type: application/json`
- **Body**：`{ "to": <LINE_USER_ID>, "messages": [{ "type": "text", "text": "<內容>" }] }`
- **限制**：單一 text 訊息上限 5000 字；超過則截斷（見下方 `buildLineText`）。
- 訊息為**單一 text 物件**，內含本週期全部新物件，符合「一週期最多送一次」。

參考實作：

```js
const LINE_PUSH_URL = 'https://api.line.me/v2/bot/message/push';
const LINE_TEXT_LIMIT = 5000;

async function readSeenIds(env) {
  const raw = await env.KV.get('seen_ids');
  return raw ? JSON.parse(raw) : [];
}

// 訊息內容等同前端顯示欄位
function buildLineText(newHouses) {
  const blocks = newHouses.map((h) => {
    const photo = (h.photo_url || '').replace('400x300', '1000xwater2');
    const detailUrl = `https://sale.591.com.tw/home/house/detail/2/${h.houseid}.html`;
    const mapsUrl = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${h.section_name} ${h.address}`)}`;
    return [
      `🏠 ${h.title}`,
      `格局：${h.room}　屋齡：${h.showhouseage}　樓層：${h.floor}`,
      `地址：${h.section_name} - ${h.address}`,
      `總價：${h.showprice} 萬`,
      `照片：${photo}`,
      `詳情：${detailUrl}`,
      `地圖：${mapsUrl}`,
    ].join('\n');
  });

  let text = `🆕 新物件 ${newHouses.length} 筆\n\n` + blocks.join('\n\n');
  if (text.length > LINE_TEXT_LIMIT) {
    text = text.slice(0, LINE_TEXT_LIMIT - 1) + '…'; // 截斷（預期僅首次可能發生）
  }
  return text;
}

async function sendLinePush(env, text) {
  const res = await fetch(LINE_PUSH_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      to: env.LINE_USER_ID,
      messages: [{ type: 'text', text }],
    }),
  });
  if (!res.ok) {
    throw new Error(`LINE push failed: ${res.status} ${await res.text()}`);
  }
}
```

## 5. 整合進 `runCycle`（§5.4）

在 `filterHouses` 完成、且既有的 `house_data` / `meta` 寫入之後，加入「通知區塊」。此區塊用**獨立的 try/catch** 包住，使 LINE 失敗不影響正常週期；失敗時不更新 `seen_ids`，下個週期會自動重試通知。

```js
// （既有）抓取 + 篩選 + 寫入 house_data / meta ...
const filtered = filterHouses(raw);
// （既有）env.KV.put('house_data', ...) 與 meta ...

// === 新增：首次出現的物件 → LINE 通知 + 記錄 seen_ids ===
try {
  const seenIds = await readSeenIds(env);            // 持久化、append-only
  const seenSet = new Set(seenIds);
  const newHouses = filtered.filter(
    (h) => h.houseid != null && !seenSet.has(h.houseid)
  );

  if (newHouses.length > 0) {
    // 一週期最多一次 push（單一 text 訊息，含全部新物件）
    await sendLinePush(env, buildLineText(newHouses));
    // 送出成功後才寫回 seen_ids：避免送失敗卻被標記為已通知
    const updated = seenIds.concat(newHouses.map((h) => h.houseid));
    await env.KV.put('seen_ids', JSON.stringify(updated));
  }
  // 沒有新物件 → 不送 LINE、也不寫 seen_ids
} catch (err) {
  console.error('LINE notify step failed (will retry next cycle):', err);
}
```

### 行為要點
- **送出成功才寫 `seen_ids`**：LINE 推播失敗時不更新 `seen_ids`，確保首次通知不會永久遺失（下個週期重試）。
- **截斷例外**：訊息超過 5000 字時截斷，但**仍把本週期所有新 houseid 標記為已通知**（被截斷掉的物件不會再補送，符合需求；此情況預期僅首次發生）。

## 6. 對 Cloudflare 免費額度的影響（確認仍在免費方案內）

- **KV 寫入**：`seen_ids` 僅在「有新 houseid」時寫入。穩定狀態下大多週期無新物件、不寫入，每日 KV 寫入仍維持在 `house_data` + `meta` 的量（最壞約 720 次/天），遠低於 1000 次/天上限。
- **外部 subrequest**：有新物件的週期，LINE push 為 +1 外部 subrequest，單次 invocation 約 17 個，遠低於 50。
- **每日 invocation 數**：LINE 為 subrequest，不增加 Worker 每日 invocation 計數。
- **CPU**：差集判斷用 `Set`（O(n)）、組字串成本可忽略，對 10ms CPU 上限無實質影響。

## 7. 驗收標準（追加至 §11）

- [ ] `seen_ids` 持久化、append-only：不清空、不覆寫，僅在有新 houseid 時追加寫回。
- [ ] 只有「未曾出現過」的 houseid 會觸發 LINE；已記錄者不再重送。
- [ ] 每個週期最多送出一次 push，且為單一訊息含全部新物件。
- [ ] LINE 文字超過 5000 字時正確截斷（僅首次可能發生）。
- [ ] `LINE_CHANNEL_ACCESS_TOKEN`、`LINE_USER_ID` 以 Worker secret 提供，未寫死於程式或設定檔。
- [ ] 沒有新物件的週期：不寫 `seen_ids`、不發 LINE。
- [ ] LINE 推播失敗時不更新 `seen_ids`，且不影響當次 `house_data` / `meta` 的正常更新。
