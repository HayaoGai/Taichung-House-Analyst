import { ref, computed, onMounted, onBeforeUnmount } from 'vue'

// 封裝看板的資料流與更新行為。
// 真實的倒數來源是後端 meta.nextRunAt；前端只負責顯示與在歸零後銜接，
// 避免前後端時間不一致。
export function useHouses () {
  const houses = ref( [] )
  const nextRunAt = ref( Date.now() )
  const lastUpdatedAt = ref( null )
  const lastStatus = ref( null )
  const now = ref( Date.now() )

  const loading = ref( false ) // 初次載入中
  const refreshing = ref( false ) // 手動更新中（按鈕 loading）
  const error = ref( null )

  let tick = null // 每秒更新 now 的 interval
  let poller = null // 倒數歸零後的輪詢 interval

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
    houses.value = [ ...list ].sort( ( a, b ) => Number( a.price ) - Number( b.price ) )
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

  // 倒數歸零後，每 5 秒輪詢，直到 lastUpdatedAt 比目前新（代表後端 cron 已更新）
  function startPolling () {
    if ( poller ) return
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
    }, 5000 )
  }

  function stopPolling () {
    if ( poller ) {
      clearInterval( poller )
      poller = null
    }
  }

  // 手動更新：立即抓取、整批取代、重置隨機週期與倒數
  async function refresh () {
    if ( refreshing.value ) return
    refreshing.value = true
    error.value = null
    stopPolling()
    try {
      const res = await fetch( '/api/refresh', {
        method: 'POST',
        headers: { accept: 'application/json' },
      } )
      if ( !res.ok ) throw new Error( `POST /api/refresh ${ res.status }` )
      applyPayload( await res.json() )
    } catch ( e ) {
      error.value = e?.message ?? String( e )
      throw e
    } finally {
      refreshing.value = false
    }
  }

  // 加入黑名單：樂觀更新——本地立即移除所有 price/room/houseage/address 皆相同者，
  // 同時 POST /api/blacklist 持久化（失敗僅記錄，重新整理即可還原）。
  async function blacklistHouse ( house ) {
    const { price, room, houseage, address } = house
    houses.value = houses.value.filter(
      ( h ) => !( h.price === price && h.room === room && h.houseage === houseage && h.address === address ),
    )
    try {
      await fetch( '/api/blacklist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify( { price, room, houseage, address } ),
      } )
    } catch ( e ) {
      console.error( '加入黑名單失敗，可重新整理還原：', e )
    }
  }

  onMounted( () => {
    load()
    tick = setInterval( () => {
      now.value = Date.now()
      // 倒數歸零 → 啟動輪詢銜接後端 cron 的更新
      if ( remainingMs.value <= 0 ) startPolling()
    }, 1000 )
  } )

  onBeforeUnmount( () => {
    if ( tick ) clearInterval( tick )
    stopPolling()
  } )

  return {
    houses,
    nextRunAt,
    lastUpdatedAt,
    lastStatus,
    countdown,
    remainingMs,
    loading,
    refreshing,
    error,
    refresh,
    blacklistHouse,
  }
}
