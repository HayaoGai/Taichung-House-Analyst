// ─────────────────────────────────────────────────────────────────────────────
// Cloudflare Worker：591 待售物件監控看板 後端
//
// 職責（單一 Worker 同時負責三件事）：
//   1. fetch handler   → API 路由（/api/houses、/api/refresh），其餘交給靜態資源（SPA）
//   2. scheduled handler → Cron（每分鐘觸發），依 meta.nextRunAt 閘門決定是否真的抓取
//   3. 抓取 / 篩選 / 寫入 KV
//
// 注意：
//   本專案前端原始碼位於 src/（Quasar），為避免與 Quasar 來源衝突，
//   Worker 改置於 worker/index.js，並於 wrangler.jsonc 將 main 指向此檔。
// ─────────────────────────────────────────────────────────────────────────────

// ── 常數 ──────────────────────────────────────────────────────────────
const SECTION_IDS = [ 98, 99, 100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 116, 117, 118 ]
const SECTION_ID_SET = new Set( SECTION_IDS )

const MAX_PAGES = 45 // 每週期外部請求上限（保守，免費上限 50）
const BATCH_SIZE = 6 // 每批並行請求上限（Worker 對外同時 6 條連線）
const SEQUENTIAL_GUARD = 60 // 安全網循序補抓的硬上限，避免無窮迴圈
const FETCH_TIMEOUT_MS = 10000 // 單次對外請求逾時
const REFRESH_DEBOUNCE_MS = 10000 // /api/refresh 防連點：距上次更新 < 10 秒則略過實際抓取

// LINE 推播
const LINE_PUSH_URL = 'https://api.line.me/v2/bot/message/push'
const LINE_TEXT_LIMIT = 5000 // 單一 text 訊息上限，超過則截斷

// 產生 240~360 秒（4~6 分鐘）的隨機間隔
function randomIntervalSec () {
  return Math.floor( Math.random() * ( 360 - 240 + 1 ) ) + 240
}

// ── 591 BFF API（headers 與 query 需照抄，$ 為 591 query 語法字面值）──
const REQUEST_HEADERS = {
  'accept': '*/*',
  'accept-language': 'zh-TW,zh;q=0.9',
  'cache-control': 'no-cache',
  'device': 'pc',
  'deviceid': '19a61088873525d81ac0c2ffba0ef4c0',
  'pragma': 'no-cache',
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
}

function buildUrl ( firstRow ) {
  const ts = Date.now()
  return `https://bff-house.591.com.tw/v1/web/sale/list?timestamp=${ ts }&type=2&category=1&regionid=8&kind=9&price=$0_$1500&shape=3,4&houseage=$0_$25&firstRow=${ firstRow }&order=price_asc`
}

// 帶逾時 + 單次重試（指數退避）的對外抓取
async function fetchPage ( firstRow, attempt = 0 ) {
  const controller = new AbortController()
  const timer = setTimeout( () => controller.abort(), FETCH_TIMEOUT_MS )
  try {
    const res = await fetch( buildUrl( firstRow ), {
      method: 'GET',
      headers: REQUEST_HEADERS,
      signal: controller.signal,
    } )
    if ( !res.ok ) throw new Error( `591 API ${ res.status } @ firstRow=${ firstRow }` )
    const json = await res.json()
    return {
      total: Number( json?.data?.total ?? 0 ),
      list: json?.data?.house_list ?? [],
    }
  } catch ( err ) {
    if ( attempt < 1 ) {
      // 單次重試：退避 ~500ms（不引入隨機以維持可預期）
      await sleep( 500 )
      return fetchPage( firstRow, attempt + 1 )
    }
    throw err
  } finally {
    clearTimeout( timer )
  }
}

function sleep ( ms ) {
  return new Promise( ( resolve ) => setTimeout( resolve, ms ) )
}

function chunk ( arr, n ) {
  const out = []
  for ( let i = 0; i < arr.length; i += n ) out.push( arr.slice( i, i + n ) )
  return out
}

// ── 抓取（分頁、分批、去重、安全網） ───────────────────────────────
async function scrapeAll () {
  const all = []
  const seenIds = new Set()
  const pushUnique = ( list ) => {
    for ( const h of list ) {
      if ( h?.houseid != null && !seenIds.has( h.houseid ) ) {
        seenIds.add( h.houseid )
        all.push( h )
      }
    }
  }

  // 1. 先打 firstRow=0 取得 total 與第一頁
  const first = await fetchPage( 0 )
  const total = first.total
  pushUnique( first.list )
  if ( total === 0 || first.list.length === 0 ) return all

  // 3. 以第一頁長度推估 offset；6. 限制總頁數 ≤ MAX_PAGES
  const pageSize = first.list.length
  const offsets = []
  for ( let off = pageSize; off < total && offsets.length < MAX_PAGES - 1; off += pageSize ) {
    offsets.push( off )
  }

  // 若 total 過大導致頁數超限，記錄警告（只抓前 MAX_PAGES 頁）
  if ( pageSize > 0 && Math.ceil( total / pageSize ) > MAX_PAGES ) {
    console.warn( `total=${ total } 超過 MAX_PAGES=${ MAX_PAGES } 頁上限，僅抓前 ${ MAX_PAGES } 頁` )
  }

  // 4. 分批，每批最多 BATCH_SIZE 個並行；批與批之間 await
  for ( const batch of chunk( offsets, BATCH_SIZE ) ) {
    const pages = await Promise.all( batch.map( ( off ) => fetchPage( off ) ) )
    pages.forEach( ( p ) => pushUnique( p.list ) )
  }

  // 5. 安全網：循序補抓（達 total / 回傳 0 筆 / 無新增 / 超過 guard 即停）
  let guard = 0
  while ( all.length < total && guard < SEQUENTIAL_GUARD ) {
    guard++
    const p = await fetchPage( all.length )
    if ( p.list.length === 0 ) break
    const before = all.length
    pushUnique( p.list )
    if ( all.length === before ) break // 沒有新增 → 停止
  }
  return all
}

// ── 篩選（業務規則） ──────────────────────────────────────────────
function filterHouses ( allHouses ) {
  const result = []
  for ( const h of allHouses ) {
    // 規則 1：photoNum 為 0 → 剔除（photoNum 確為駝峰命名，照實作）
    if ( h.photoNum === 0 ) continue

    // 規則 2：樓層（缺值視為空字串，依規則會被剔除）
    const floor = h.floor ?? ''
    if ( floor === '整棟/1F' || ( !floor.includes( '整棟' ) && !floor.includes( '~' ) ) ) continue

    // 規則 3：section_id 不在允許清單 → 剔除
    if ( !SECTION_ID_SET.has( Number( h.section_id ) ) ) continue

    // 規則 4：屋齡 > 25 → 剔除（houseage 缺值/非數字時 Number 為 NaN，比較為 false，予以保留）
    if ( Number( h.houseage ) > 25 ) continue

    result.push( h )
  }
  return result
}

// ── 只保留前端需要的欄位以節省 KV 容量 ─────────────────────────────
function pickFrontendFields ( h ) {
  return {
    houseid: h.houseid,
    title: h.title,
    room: h.room,
    showhouseage: h.showhouseage,
    floor: h.floor,
    section_name: h.section_name,
    address: h.address,
    showprice: h.showprice,
    photo_url: h.photo_url,
    // 額外保留原始 price/houseage（不顯示，供黑名單與 LINE 去重比對；room 已於上方保留）
    price: h.price,
    houseage: h.houseage,
  }
}

// ── KV 存取 ──────────────────────────────────────────────────────────────────
async function readMeta ( env ) {
  const raw = await env.KV.get( 'meta' )
  if ( !raw ) return null
  try {
    return JSON.parse( raw )
  } catch {
    return null
  }
}

async function readHouses ( env ) {
  const raw = await env.KV.get( 'house_data' )
  if ( !raw ) return []
  try {
    const parsed = JSON.parse( raw )
    return Array.isArray( parsed ) ? parsed : []
  } catch {
    return []
  }
}

// ── 黑名單 / 去重 helper ──────────────────────────────────────
// 黑名單與 LINE 去重共用的比對鍵：price|room|houseage|address（四項皆相同視為同一筆）
function matchKey ( h ) {
  return `${ h.price }|${ h.room }|${ h.houseage }|${ h.address }`
}

// 對房屋陣列套用黑名單（四項皆相同者過濾掉）
function applyBlacklist ( houses, blacklist ) {
  if ( !blacklist || blacklist.length === 0 ) return houses
  const blockedSet = new Set( blacklist.map( matchKey ) )
  return houses.filter( ( h ) => !blockedSet.has( matchKey( h ) ) )
}

// 黑名單（持久化、append-only；使用者按垃圾桶時追加）
async function readBlacklist ( env ) {
  const raw = await env.KV.get( 'blacklist' )
  if ( !raw ) return []
  try {
    const parsed = JSON.parse( raw )
    return Array.isArray( parsed ) ? parsed : []
  } catch {
    return []
  }
}

// 已通知過的 tripleKey 字串陣列（持久化、append-only；僅有新通知時寫入）
async function readNotifiedKeys ( env ) {
  const raw = await env.KV.get( 'notified_keys' )
  if ( !raw ) return []
  try {
    const parsed = JSON.parse( raw )
    return Array.isArray( parsed ) ? parsed : []
  } catch {
    return []
  }
}

// 組 LINE 文字訊息（移除照片與地圖、格局/屋齡/樓層各自獨立成行）；超過 5000 字則截斷
function buildLineText ( newHouses ) {
  const blocks = newHouses.map( ( h ) => {
    const detailUrl = `https://sale.591.com.tw/home/house/detail/2/${ h.houseid }.html`
    return [
      `🏠 ${ h.title }`,
      `格局：${ h.room }`,
      `屋齡：${ h.showhouseage }`,
      `樓層：${ h.floor }`,
      `地址：${ h.section_name } - ${ h.address }`,
      `總價：${ h.showprice } 萬`,
      `詳情：${ detailUrl }`,
    ].join( '\n' )
  } )

  let text = `🆕 新物件 ${ newHouses.length } 筆\n\n` + blocks.join( '\n\n' )
  if ( text.length > LINE_TEXT_LIMIT ) {
    text = text.slice( 0, LINE_TEXT_LIMIT - 1 ) + '…' // 截斷（預期僅首次可能發生）
  }
  return text
}

async function sendLinePush ( env, text ) {
  const res = await fetch( LINE_PUSH_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${ env.LINE_CHANNEL_ACCESS_TOKEN }`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify( {
      to: env.LINE_USER_ID,
      messages: [ { type: 'text', text } ],
    } ),
  } )
  if ( !res.ok ) {
    throw new Error( `LINE push failed: ${ res.status } ${ await res.text() }` )
  }
}

// 通知區塊：先套黑名單，再以 price/room/houseage/address（matchKey）判斷是否已通知。
// 以獨立 try/catch 包住，使 LINE 失敗不影響正常週期；失敗時不寫 notified_keys，下個週期自動重試。
async function notifyNewHouses ( env, slim ) {
  try {
    const [ blacklist, notifiedKeys ] = await Promise.all( [
      readBlacklist( env ),
      readNotifiedKeys( env ),
    ] )
    const visible = applyBlacklist( slim, blacklist ) // 黑名單物件不顯示也不通知
    const notifiedSet = new Set( notifiedKeys )
    const newHouses = visible.filter( ( h ) => !notifiedSet.has( matchKey( h ) ) )

    if ( newHouses.length > 0 ) {
      // 一週期最多一次 push（單一 text 訊息，含全部新物件）
      await sendLinePush( env, buildLineText( newHouses ) )
      // 送出成功才寫回；用 Set 去重避免同鍵重複堆積
      const updated = [ ...new Set( notifiedKeys.concat( newHouses.map( matchKey ) ) ) ]
      await env.KV.put( 'notified_keys', JSON.stringify( updated ) )
    }
    // 沒有新物件 → 不送 LINE、也不寫 notified_keys
  } catch ( err ) {
    console.error( 'LINE notify step failed (will retry next cycle):', err )
  }
}

// ── 完整週期（runCycle） ──────────────────────────────────────────
async function runCycle ( env ) {
  const now = Date.now()
  try {
    const raw = await scrapeAll()
    const filtered = filterHouses( raw )
    const slim = filtered.map( pickFrontendFields )
    await env.KV.put( 'house_data', JSON.stringify( slim ) )
    const intervalSec = randomIntervalSec()
    await env.KV.put( 'meta', JSON.stringify( {
      lastUpdatedAt: now,
      nextRunAt: now + intervalSec * 1000,
      intervalSec,
      lastStatus: 'ok',
    } ) )

    // 套黑名單後、首次出現（tripleKey）的物件 → LINE 通知 + 記錄 notified_keys（獨立 try/catch，不影響上方週期）
    await notifyNewHouses( env, slim )
  } catch ( err ) {
    // 抓取失敗：保留上一份 house_data，僅延後下次嘗試（1 分鐘後重試）
    const prev = await readMeta( env )
    await env.KV.put( 'meta', JSON.stringify( {
      lastUpdatedAt: prev?.lastUpdatedAt ?? null,
      nextRunAt: now + 60 * 1000,
      intervalSec: 60,
      lastStatus: 'error',
    } ) )
    console.error( 'runCycle failed:', err )
  }
}

// ── 共用：組成 /api/houses 與 /api/refresh 的回應內容 ──────────
// 黑名單一律於消費端即時套用，故按下垃圾桶後重新整理即生效，不必等下一週期。
async function buildHousesPayload ( env ) {
  const [ houses, meta, blacklist ] = await Promise.all( [
    readHouses( env ),
    readMeta( env ),
    readBlacklist( env ),
  ] )
  return {
    houses: applyBlacklist( houses, blacklist ),
    meta: meta ?? { lastUpdatedAt: null, nextRunAt: Date.now(), lastStatus: null },
  }
}

function jsonResponse ( data, init = {} ) {
  return new Response( JSON.stringify( data ), {
    ...init,
    headers: { 'content-type': 'application/json; charset=utf-8', ...( init.headers ?? {} ) },
  } )
}

// ── Worker 入口 ──────────────────────────────────────────────────────────────
export default {
  // Cron（每分鐘觸發）：依 nextRunAt 閘門決定是否真的執行抓取週期
  async scheduled ( event, env, ctx ) {
    const meta = await readMeta( env )
    const now = Date.now()
    if ( !meta || now >= meta.nextRunAt ) {
      ctx.waitUntil( runCycle( env ) )
    }
  },

  // API 路由
  async fetch ( request, env ) {
    const url = new URL( request.url )

    // GET /api/houses：從 KV 讀最新資料 + meta
    if ( url.pathname === '/api/houses' && request.method === 'GET' ) {
      return jsonResponse( await buildHousesPayload( env ) )
    }

    // POST /api/refresh：立即跑一次 runCycle（含重置隨機 nextRunAt），回傳最新資料
    if ( url.pathname === '/api/refresh' && request.method === 'POST' ) {
      const meta = await readMeta( env )
      const now = Date.now()
      // 防連點：距上次成功更新 < 10 秒則略過實際抓取，直接回現有資料
      const tooSoon = meta?.lastUpdatedAt != null && ( now - meta.lastUpdatedAt ) < REFRESH_DEBOUNCE_MS
      if ( !tooSoon ) {
        await runCycle( env )
      }
      return jsonResponse( await buildHousesPayload( env ) )
    }

    // POST /api/blacklist：將 price/room/houseage/address 加入黑名單
    if ( url.pathname === '/api/blacklist' && request.method === 'POST' ) {
      const { price, room, houseage, address } = await request.json()
      const blacklist = await readBlacklist( env )
      const key = matchKey( { price, room, houseage, address } )
      const exists = blacklist.some( ( b ) => matchKey( b ) === key )
      if ( !exists ) {
        blacklist.push( { price, room, houseage, address } )
        await env.KV.put( 'blacklist', JSON.stringify( blacklist ) ) // 僅使用者操作時寫，頻率極低
      }
      return jsonResponse( { ok: true } )
    }

    // 其他 /api/* 一律回 404（避免落到 SPA fallback）
    if ( url.pathname.startsWith( '/api/' ) ) {
      return jsonResponse( { error: 'Not Found' }, { status: 404 } )
    }

    // 其餘交給靜態資源（SPA）。env.ASSETS 由 wrangler assets 綁定提供。
    if ( env.ASSETS ) {
      return env.ASSETS.fetch( request )
    }
    // 本機僅跑 wrangler dev（無 assets 綁定）時的保底回應
    return new Response( 'Static assets not bound. Run `quasar build` then `wrangler deploy`.', { status: 404 } )
  },
}
