import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import { useOwner } from 'composables/useOwner'

const POLL_INTERVAL_MS = 5000
const HIDDEN_STORAGE_KEY = 'tha_hidden_houses'

// 黑名單 / 隱藏比對鍵，需與 worker 的 matchKey 一致
function matchKey ( h ) {
  return `${ h.price }|${ h.room }|${ h.houseage }|${ h.address }`
}

// 訪客端的本地隱藏清單（存在訪客自己的瀏覽器，不寫入後端）
function readHidden () {
  try {
    const parsed = JSON.parse( localStorage.getItem( HIDDEN_STORAGE_KEY ) ?? '[]' )
    return Array.isArray( parsed ) ? parsed : []
  } catch {
    return []
  }
}

function writeHidden ( keys ) {
  try {
    localStorage.setItem( HIDDEN_STORAGE_KEY, JSON.stringify( keys ) )
  } catch {
    // 無痕模式等寫不進去：僅本次工作階段有效，可接受
  }
}

// 封裝看板的資料流與更新行為。
// 真實的倒數來源是後端 meta.nextRunAt；前端只負責顯示與在歸零後銜接，
// 避免前後端時間不一致。
export function useHouses () {
  const { isOwner, ownerHeaders, clearOwner } = useOwner()

  const allHouses = ref( [] )
  const hiddenKeys = ref( readHidden() )
  const nextRunAt = ref( Date.now() )
  const lastUpdatedAt = ref( null )
  const lastStatus = ref( null )
  const now = ref( Date.now() )

  const loading = ref( false ) // 初次載入中
  const refreshing = ref( false ) // 手動更新 / 重新載入中（按鈕 loading）
  const error = ref( null )

  let tick = null // 每秒更新 now 的 interval
  let poller = null // 倒數歸零後的輪詢 interval

  // 對外的清單：後端已套過本人的黑名單，這裡再套訪客自己的本地隱藏
  const houses = computed( () => {
    if ( hiddenKeys.value.length === 0 ) return allHouses.value
    const hidden = new Set( hiddenKeys.value )
    return allHouses.value.filter( ( h ) => !hidden.has( matchKey( h ) ) )
  } )

  // 距離下次更新的剩餘毫秒
  const remainingMs = computed( () => Math.max( 0, nextRunAt.value - now.value ) )

  // 格式化為 MM:SS
  const countdown = computed( () => {
    const totalSec = Math.floor( remainingMs.value / 1000 )
    const mm = String( Math.floor( totalSec / 60 ) ).padStart( 2, '0' )
    const ss = String( totalSec % 60 ).padStart( 2, '0' )
    return `${ mm }:${ ss }`
  } )

  // 將後端回傳的 { houses, meta } 整批取代到狀態
  function applyPayload ( payload ) {
    const list = Array.isArray( payload?.houses ) ? payload.houses : []
    const meta = payload?.meta ?? {}
    // 整批取代（先清空再填入），不做增量合併。
    // 後端係逐個里區分組抓取後串接，合併後未必全域有序，故此處統一依總價由小到大排序。
    allHouses.value = [ ...list ].sort( ( a, b ) => Number( a.price ) - Number( b.price ) )
    nextRunAt.value = typeof meta.nextRunAt === 'number' ? meta.nextRunAt : Date.now()
    lastUpdatedAt.value = meta.lastUpdatedAt ?? null
    lastStatus.value = meta.lastStatus ?? null
  }

  async function fetchHouses () {
    const res = await fetch( '/api/houses', { headers: { accept: 'application/json' } } )
    if ( !res.ok ) throw new Error( `GET /api/houses ${ res.status }` )
    return res.json()
  }

  // 初始載入
  async function load () {
    loading.value = true
    error.value = null
    try {
      applyPayload( await fetchHouses() )
    } catch ( e ) {
      error.value = e?.message ?? String( e )
    } finally {
      loading.value = false
    }
  }

  // 倒數歸零後，每 5 秒輪詢，直到 lastUpdatedAt 比目前新（代表後端 cron 已更新）。
  // 分頁在背景時不啟動（見 onVisibilityChange），避免被遺忘的分頁整天打 API 燒 KV read 額度。
  function startPolling () {
    if ( poller || document.hidden ) return
    poller = setInterval( async () => {
      try {
        const payload = await fetchHouses()
        const incoming = payload?.meta?.lastUpdatedAt ?? null
        const hasNewer = incoming != null && ( lastUpdatedAt.value == null || incoming > lastUpdatedAt.value )
        if ( hasNewer ) {
          applyPayload( payload )
          stopPolling()
        }
      } catch ( e ) {
        // 輪詢失敗忽略，等下一次；不擾動現有畫面
        console.warn( 'poll failed:', e )
      }
    }, POLL_INTERVAL_MS )
  }

  function stopPolling () {
    if ( poller ) {
      clearInterval( poller )
      poller = null
    }
  }

  // 分頁切到背景 → 停止輪詢；切回前景 → 若倒數已歸零則接回
  function onVisibilityChange () {
    if ( document.hidden ) {
      stopPolling()
    } else {
      now.value = Date.now()
      if ( remainingMs.value <= 0 ) startPolling()
    }
  }

  // 擁有者專用的手動更新：後端會真的跑一次抓取週期（對外請求 + KV 寫入 + 可能的 LINE 推播），
  // 故後端以 OWNER_TOKEN 把關；此處帶上 header，若回 403 代表 token 已失效。
  async function refresh () {
    if ( refreshing.value ) return
    refreshing.value = true
    error.value = null
    stopPolling()
    try {
      const res = await fetch( '/api/refresh', {
        method: 'POST',
        headers: { accept: 'application/json', ...ownerHeaders() },
      } )
      if ( res.status === 403 ) {
        clearOwner() // 退回訪客模式，按鈕自動變成「重新載入」
        throw new Error( 'FORBIDDEN' )
      }
      if ( !res.ok ) throw new Error( `POST /api/refresh ${ res.status }` )
      applyPayload( await res.json() )
    } catch ( e ) {
      error.value = e?.message ?? String( e )
      throw e
    } finally {
      refreshing.value = false
    }
  }

  // 訪客用的重新載入：只重讀 KV 現況（GET），不觸發抓取、不寫 KV、不推播，對額度零成本。
  // 後端在 /api/houses 帶了 10 秒瀏覽器快取，故連點也不會真的打到 Worker。
  async function reload () {
    if ( refreshing.value ) return
    refreshing.value = true
    error.value = null
    try {
      applyPayload( await fetchHouses() )
    } catch ( e ) {
      error.value = e?.message ?? String( e )
      throw e
    } finally {
      refreshing.value = false
    }
  }

  // 垃圾桶：
  //   擁有者 → 樂觀更新後 POST /api/blacklist 持久化（跨裝置、長期生效）
  //   訪客   → 只存進他自己的 localStorage，不碰後端，也不會污染本人的黑名單
  async function blacklistHouse ( house ) {
    const key = matchKey( house )

    if ( !isOwner.value ) {
      if ( !hiddenKeys.value.includes( key ) ) {
        hiddenKeys.value = [ ...hiddenKeys.value, key ]
        writeHidden( hiddenKeys.value )
      }
      return
    }

    const { price, room, houseage, address } = house
    allHouses.value = allHouses.value.filter( ( h ) => matchKey( h ) !== key )
    try {
      const res = await fetch( '/api/blacklist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...ownerHeaders() },
        body: JSON.stringify( { price, room, houseage, address } ),
      } )
      if ( res.status === 403 ) {
        clearOwner()
        throw new Error( 'FORBIDDEN' )
      }
      if ( !res.ok ) throw new Error( `POST /api/blacklist ${ res.status }` )
    } catch ( e ) {
      console.error( '加入黑名單失敗，可重新整理還原：', e )
    }
  }

  onMounted( () => {
    load()
    document.addEventListener( 'visibilitychange', onVisibilityChange )
    tick = setInterval( () => {
      now.value = Date.now()
      // 倒數歸零 → 啟動輪詢銜接後端 cron 的更新
      if ( remainingMs.value <= 0 ) startPolling()
    }, 1000 )
  } )

  onBeforeUnmount( () => {
    document.removeEventListener( 'visibilitychange', onVisibilityChange )
    if ( tick ) clearInterval( tick )
    stopPolling()
  } )

  return {
    houses,
    isOwner,
    nextRunAt,
    lastUpdatedAt,
    lastStatus,
    countdown,
    remainingMs,
    loading,
    refreshing,
    error,
    refresh,
    reload,
    blacklistHouse,
  }
}
