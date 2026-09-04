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

// 591 list API 單次最多吃 5 個 section（第 6 個起靜默忽略），故將里區每 5 個切一組，逐組查詢。
// 由 591 端先過濾里區，抓回與待解析的資料量大減（實測全台中 778 筆 → 這 16 里區僅約 126 筆），
// 藉此把 Worker 的 JSON 解析 CPU 壓在免費方案 10ms 上限內。
const SECTION_GROUP_SIZE = 5
const SECTION_GROUPS = ( () => {
  const groups = []
  for ( let i = 0; i < SECTION_IDS.length; i += SECTION_GROUP_SIZE ) {
    groups.push( SECTION_IDS.slice( i, i + SECTION_GROUP_SIZE ).join( ',' ) )
  }
  return groups
} )()

const MAX_PAGES = 45 // 每週期對外請求「總數」上限（保守，免費 subrequest 上限 50）
const FETCH_TIMEOUT_MS = 10000 // 單次對外請求逾時
// /api/refresh 防連點：距上次「嘗試」更新 < 60 秒則略過實際抓取。
// 刻意以「嘗試」而非「成功」計時（見 meta.lastRefreshAt），使抓取連續失敗時防連點依然有效，
// 否則失敗狀態下 lastUpdatedAt 不會前進，等同於完全沒有防連點。
const REFRESH_DEBOUNCE_MS = 60000

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

function buildUrl ( firstRow, sectionCsv ) {
  const ts = Date.now()
  return `https://bff-house.591.com.tw/v1/web/sale/list?timestamp=${ ts }&type=2&category=1&regionid=8&kind=9&price=$500_$1500&shape=3,4&houseage=$0_$22&section=${ sectionCsv }&firstRow=${ firstRow }&order=price_asc`
}

// 帶逾時 + 單次重試（指數退避）的對外抓取
async function fetchPage ( firstRow, sectionCsv, attempt = 0 ) {
  const controller = new AbortController()
  const timer = setTimeout( () => controller.abort(), FETCH_TIMEOUT_MS )
  try {
    const res = await fetch( buildUrl( firstRow, sectionCsv ), {
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
      return fetchPage( firstRow, sectionCsv, attempt + 1 )
    }
    throw err
  } finally {
    clearTimeout( timer )
  }
}

function sleep ( ms ) {
  return new Promise( ( resolve ) => setTimeout( resolve, ms ) )
}

// ── 抓取（分組、逐組分頁、去重） ───────────────────────────────
// 逐個里區分組（每組 ≤5）循序分頁抓取。各組 total 都很小（實測整組最多約 69 筆 ≈ 3 頁），
// 故不再需要大量並行與循序補抓安全網；以 firstRow 依實際回傳筆數推進，達 total 或空頁即止。
// 全程以 requests 計數卡住對外請求「總數」≤ MAX_PAGES，確保不逾越免費 subrequest 上限。
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

  let requests = 0
  for ( const sectionCsv of SECTION_GROUPS ) {
    let firstRow = 0
    let groupCount = 0
    let groupTotal = Infinity
    while ( groupCount < groupTotal && requests < MAX_PAGES ) {
      requests++
      const page = await fetchPage( firstRow, sectionCsv )
      groupTotal = page.total
      if ( page.list.length === 0 ) break // 空頁 → 此組結束
      pushUnique( page.list )
      groupCount += page.list.length
      firstRow += page.list.length
    }
  }

  if ( requests >= MAX_PAGES ) {
    console.warn( `對外請求數已達上限 MAX_PAGES=${ MAX_PAGES }，本週期可能未抓齊` )
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
    if ( floor === '整棟/1F' || ( !floor.includes( '整棟' ) && !floor.includes( '1F~' ) ) ) continue

    // 規則 3：section_id 不在允許清單 → 剔除
    if ( !SECTION_ID_SET.has( Number( h.section_id ) ) ) continue

    // 規則 4：屋齡缺值、非數字、等於 0、大於 22 → 剔除
    const age = Number( h.houseage )
    if ( !Number.isFinite( age ) || age === 0 || age > 22 ) continue

    // 規則 5：總價 < 500 或 > 1500 → 剔除（缺值/非數字視同不合格，一併剔除）
    const price = Number( h.price )
    if ( !( price >= 500 && price <= 1500 ) ) continue

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
    // 額外保留原始欄位（不顯示於前端）：price 供黑名單比對；houseage/linkman 供 LINE 通知的物件身分比對；room 已於上方保留。
    // linkman 為 591 聯絡人（屋主 / 仲介），同一物件價格變動時不變，用來取代不穩定的 houseid。
    price: h.price,
    houseage: h.houseage,
    linkman: h.linkman,
  }
}

// ── KV 存取 ──────────────────────────────────────────────────────────────────
async function readMeta ( env ) {
  const raw = await env.HOUSES_KV.get( 'meta' )
  if ( !raw ) return null
  try {
    return JSON.parse( raw )
  } catch {
    return null
  }
}

async function readHouses ( env ) {
  const raw = await env.HOUSES_KV.get( 'house_data' )
  if ( !raw ) return []
  try {
    const parsed = JSON.parse( raw )
    return Array.isArray( parsed ) ? parsed : []
  } catch {
    return []
  }
}

// ── 黑名單 / 去重 helper ──────────────────────────────────────
// 黑名單比對鍵：price|room|houseage|address（四項皆相同視為同一筆）
function matchKey ( h ) {
  return `${ h.price }|${ h.room }|${ h.houseage }|${ h.address }`
}

// LINE 通知專用的「物件身分」鍵：room|houseage|address|linkman。
// 刻意不含價格，故同一物件價格變動時身分不變，可辨識為「價格異動」而非「新物件」；
// 亦不採用 591 的 houseid（實測不穩定）。與黑名單的 matchKey 分開維護。
function notifyKey ( h ) {
  return `${ h.room }|${ h.houseage }|${ h.address }|${ h.linkman }`
}

// 對房屋陣列套用黑名單（四項皆相同者過濾掉）
function applyBlacklist ( houses, blacklist ) {
  if ( !blacklist || blacklist.length === 0 ) return houses
  const blockedSet = new Set( blacklist.map( matchKey ) )
  return houses.filter( ( h ) => !blockedSet.has( matchKey( h ) ) )
}

// 黑名單（持久化、append-only；使用者按垃圾桶時追加）
async function readBlacklist ( env ) {
  const raw = await env.HOUSES_KV.get( 'blacklist' )
  if ( !raw ) return []
  try {
    const parsed = JSON.parse( raw )
    return Array.isArray( parsed ) ? parsed : []
  } catch {
    return []
  }
}

// 各物件「上次通知時的價格」對照表：{ [notifyKey]: price }（持久化）
// 回傳 null 代表尚未初始化（首次部署）；此時 notifyNewHouses 會靜默植入現況、不發通知，
// 避免部署當下把全部既有物件當成新物件一次轟炸。
async function readSeenPrices ( env ) {
  const raw = await env.HOUSES_KV.get( 'seen_prices_v2' )
  if ( !raw ) return null
  try {
    const parsed = JSON.parse( raw )
    return ( parsed && typeof parsed === 'object' && !Array.isArray( parsed ) ) ? parsed : null
  } catch {
    return null
  }
}

function houseDetailUrl ( h ) {
  return `https://sale.591.com.tw/home/house/detail/2/${ h.houseid }.html`
}

// 新物件與價格異動共用的基本資訊行（標題、格局、屋齡、樓層、地址）
function houseBaseLines ( h ) {
  return [
    `🏠 ${ h.title }`,
    `格局：${ h.room }`,
    `屋齡：${ h.showhouseage }`,
    `樓層：${ h.floor }`,
    `地址：${ h.section_name } - ${ h.address }`,
  ]
}

// 組 LINE 文字訊息（移除照片與地圖、各欄位獨立成行）：含「新物件」與「價格異動」兩區塊；超過 5000 字則截斷
function buildLineText ( newHouses, priceChanges ) {
  const sections = []

  if ( newHouses.length > 0 ) {
    const blocks = newHouses.map( ( h ) => [
      ...houseBaseLines( h ),
      `總價：${ h.showprice } 萬`,
      `詳情：${ houseDetailUrl( h ) }`,
    ].join( '\n' ) )
    sections.push( `🆕 新物件 ${ newHouses.length } 筆\n\n` + blocks.join( '\n\n' ) )
  }

  if ( priceChanges.length > 0 ) {
    const blocks = priceChanges.map( ( { house, oldPrice, newPrice } ) => [
      ...houseBaseLines( house ),
      `原本價格：${ oldPrice } 萬`,
      `現在價格：${ newPrice } 萬（${ newPrice < oldPrice ? '↓ 降價' : '↑ 漲價' }）`,
      `詳情：${ houseDetailUrl( house ) }`,
    ].join( '\n' ) )
    sections.push( `💰 價格異動 ${ priceChanges.length } 筆\n\n` + blocks.join( '\n\n' ) )
  }

  let text = sections.join( '\n\n────────\n\n' )
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

// 通知區塊：先套黑名單，再以 notifyKey（room|houseage|address|linkman，不含價格）追蹤各物件價格。
//   1. 首次出現的 notifyKey → 新物件通知。
//   2. 既有 notifyKey 但價格與上次不同 → 價格異動通知（附原本 / 現在價格）。
// seen_prices_v2 為 null（首次部署）時：僅靜默植入現況、不發通知，避免把既有物件全部當新物件轟炸。
// 以獨立 try/catch 包住，使 LINE 失敗不影響正常週期；失敗時不寫 seen_prices_v2，下個週期自動重試。
async function notifyNewHouses ( env, slim ) {
  try {
    const [ blacklist, seenPrices ] = await Promise.all( [
      readBlacklist( env ),
      readSeenPrices( env ),
    ] )
    const visible = applyBlacklist( slim, blacklist ) // 黑名單物件不顯示也不通知

    // 首次部署（尚無 seen_prices_v2）：僅記錄現況，本週期不發通知
    if ( seenPrices === null ) {
      const seed = {}
      for ( const h of visible ) seed[ notifyKey( h ) ] = Number( h.price )
      await env.HOUSES_KV.put( 'seen_prices_v2', JSON.stringify( seed ) )
      return
    }

    const newHouses = []
    const priceChanges = []
    for ( const h of visible ) {
      const key = notifyKey( h )
      const prev = seenPrices[ key ]
      const cur = Number( h.price )
      if ( prev === undefined ) {
        newHouses.push( h )
      } else if ( Number( prev ) !== cur ) {
        priceChanges.push( { house: h, oldPrice: prev, newPrice: cur } )
      }
    }

    if ( newHouses.length > 0 || priceChanges.length > 0 ) {
      // 一週期最多一次 push（單一 text 訊息，含新物件與價格異動）
      await sendLinePush( env, buildLineText( newHouses, priceChanges ) )
      // 送出成功才寫回：更新所有可見物件的最新價格（涵蓋新物件、異動、未變動者）
      const updated = { ...seenPrices }
      for ( const h of visible ) updated[ notifyKey( h ) ] = Number( h.price )
      await env.HOUSES_KV.put( 'seen_prices_v2', JSON.stringify( updated ) )
    }
    // 沒有新物件也沒有價格異動 → 不送 LINE、也不寫 seen_prices_v2
  } catch ( err ) {
    console.error( 'LINE notify step failed (will retry next cycle):', err )
  }
}

// ── 完整週期（runCycle） ──────────────────────────────────────────
// extraMeta：由呼叫端補寫進 meta 的欄位（目前僅 /api/refresh 用來記 lastRefreshAt）。
// 成功與失敗兩條路徑都會寫入，故「嘗試過就算數」，抓取失敗時防連點依然成立。
// lastRefreshAt 由 prev 承接後再被 extraMeta 覆蓋，避免 cron 週期把它洗掉。
async function runCycle ( env, extraMeta = {} ) {
  const now = Date.now()
  const prev = await readMeta( env )
  try {
    const raw = await scrapeAll()
    const filtered = filterHouses( raw )
    const slim = filtered.map( pickFrontendFields )
    await env.HOUSES_KV.put( 'house_data', JSON.stringify( slim ) )
    const intervalSec = randomIntervalSec()
    await env.HOUSES_KV.put( 'meta', JSON.stringify( {
      lastUpdatedAt: now,
      nextRunAt: now + intervalSec * 1000,
      intervalSec,
      lastStatus: 'ok',
      lastRefreshAt: prev?.lastRefreshAt ?? null,
      ...extraMeta,
    } ) )

    // 套黑名單後，依 houseid 判斷新物件與價格異動 → LINE 通知 + 記錄 seen_prices_v2（獨立 try/catch，不影響上方週期）
    await notifyNewHouses( env, slim )
  } catch ( err ) {
    // 抓取失敗：保留上一份 house_data，僅延後下次嘗試（1 分鐘後重試）
    await env.HOUSES_KV.put( 'meta', JSON.stringify( {
      lastUpdatedAt: prev?.lastUpdatedAt ?? null,
      nextRunAt: now + 60 * 1000,
      intervalSec: 60,
      lastStatus: 'error',
      lastRefreshAt: prev?.lastRefreshAt ?? null,
      ...extraMeta,
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

// ── 擁有者驗證 ────────────────────────────────────────────────────────────────
// 本站對外公開（已移除 Cloudflare Access），但「會花掉免費額度」與「會改動個人資料」的端點
// （/api/refresh、/api/blacklist）僅限本人。閘門必須放在這裡而不是前端——前端只藏按鈕的話，
// 端點仍是公開的，F12 就能直接打。
//
// token 以 Worker secret 提供：`wrangler secret put OWNER_TOKEN`，前端置於 x-owner-token header。
// 未設定 secret 時一律視為非擁有者（安全預設：寧可自己也用不了，也不要整站門戶洞開）。
function isOwner ( request, env ) {
  const expected = env.OWNER_TOKEN
  if ( !expected ) return false
  return safeEqual( request.headers.get( 'x-owner-token' ) ?? '', expected )
}

// 定長比較，避免以回應時間逐字元試出 token。
// 長度本身仍會外洩（提前 return），對此用途可接受。
function safeEqual ( a, b ) {
  if ( a.length !== b.length ) return false
  let diff = 0
  for ( let i = 0; i < a.length; i++ ) diff |= a.charCodeAt( i ) ^ b.charCodeAt( i )
  return diff === 0
}

function forbidden () {
  return jsonResponse( { error: 'Forbidden' }, { status: 403 } )
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

    // GET /api/houses：從 KV 讀最新資料 + meta（公開；只讀，成本僅 KV read）
    // 帶 10 秒瀏覽器快取：抓取週期本就是 4~6 分鐘，10 秒內的重覆請求（連點、輪詢）
    // 直接由瀏覽器擋下，不打到 Worker。private 表示只讓瀏覽器快取、不讓中介 CDN 共用。
    if ( url.pathname === '/api/houses' && request.method === 'GET' ) {
      return jsonResponse( await buildHousesPayload( env ), {
        headers: { 'cache-control': 'private, max-age=10' },
      } )
    }

    // POST /api/refresh：立即跑一次 runCycle（含重置隨機 nextRunAt），回傳最新資料
    // 僅限擁有者：一次 runCycle 會產生 2~3 次 KV 寫入（免費上限 1000/日，cron 本身已用掉約七成），
    // 且可能觸發 LINE 推播，故絕不開放給訪客。
    if ( url.pathname === '/api/refresh' && request.method === 'POST' ) {
      if ( !isOwner( request, env ) ) return forbidden()
      const meta = await readMeta( env )
      const now = Date.now()
      // 防連點：距上次「嘗試」更新 < REFRESH_DEBOUNCE_MS 則略過實際抓取，直接回現有資料
      const tooSoon = meta?.lastRefreshAt != null && ( now - meta.lastRefreshAt ) < REFRESH_DEBOUNCE_MS
      if ( !tooSoon ) {
        await runCycle( env, { lastRefreshAt: now } )
      }
      return jsonResponse( await buildHousesPayload( env ) )
    }

    // POST /api/blacklist：將 price/room/houseage/address 加入黑名單
    // 僅限擁有者：黑名單是個人化的長期資料，訪客若能寫入會永久污染本人的看板。
    // 訪客端的垃圾桶改為純前端隱藏（見 src/composables/useHouses.js），不經過此端點。
    if ( url.pathname === '/api/blacklist' && request.method === 'POST' ) {
      if ( !isOwner( request, env ) ) return forbidden()
      let body
      try {
        body = await request.json()
      } catch {
        return jsonResponse( { error: 'Bad Request' }, { status: 400 } )
      }
      const { price, room, houseage, address } = body ?? {}
      if ( price == null || room == null || houseage == null || address == null ) {
        return jsonResponse( { error: 'Bad Request' }, { status: 400 } )
      }
      const blacklist = await readBlacklist( env )
      const key = matchKey( { price, room, houseage, address } )
      const exists = blacklist.some( ( b ) => matchKey( b ) === key )
      if ( !exists ) {
        blacklist.push( { price, room, houseage, address } )
        await env.HOUSES_KV.put( 'blacklist', JSON.stringify( blacklist ) ) // 僅使用者操作時寫，頻率極低
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
