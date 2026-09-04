import { computed, ref } from 'vue'

// 擁有者（本人）身分的前端狀態。
//
// 重要：這裡的 isOwner 只是「UI 提示」，不是安全邊界。真正的閘門在 worker/index.js 的
// isOwner()——前端就算被改成永遠回 true，/api/refresh 與 /api/blacklist 一樣會回 403。
// 本檔案存在的目的只是讓訪客看到合適的介面，以及替寫入類請求帶上 header。

const STORAGE_KEY = 'tha_owner_token'
const URL_PARAM = 'key'

// localStorage 在無痕模式 / 停用 cookie 的瀏覽器會直接 throw，一律包起來以免整個 app 掛掉
function readStored () {
  try {
    return localStorage.getItem( STORAGE_KEY ) || null
  } catch {
    return null
  }
}

function writeStored ( value ) {
  try {
    if ( value ) localStorage.setItem( STORAGE_KEY, value )
    else localStorage.removeItem( STORAGE_KEY )
  } catch {
    // 存不進去就算了：token 仍留在記憶體，本次工作階段照常可用
  }
}

// 從網址取 ?key=xxx，存進 localStorage 後立刻以 replaceState 抹掉，
// 避免 token 殘留在網址列、瀏覽記錄或不小心被複製出去的分享連結裡。
function consumeUrlToken () {
  const url = new URL( window.location.href )
  const key = url.searchParams.get( URL_PARAM )
  if ( !key ) return null
  url.searchParams.delete( URL_PARAM )
  window.history.replaceState( null, '', url.pathname + url.search + url.hash )
  writeStored( key )
  return key
}

// 模組層級單例：各處呼叫 useOwner() 拿到的是同一份狀態
const token = ref( consumeUrlToken() ?? readStored() )

export function useOwner () {
  const isOwner = computed( () => Boolean( token.value ) )

  // 寫入類 API 的驗證 header；非擁有者回空物件（展開後等於沒帶）
  function ownerHeaders () {
    return token.value ? { 'x-owner-token': token.value } : {}
  }

  // token 失效（後端回 403）時清掉，UI 立即退回訪客模式，不會卡在「按了就錯」的狀態
  function clearOwner () {
    token.value = null
    writeStored( null )
  }

  return { isOwner, ownerHeaders, clearOwner }
}
