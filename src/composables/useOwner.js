import { computed } from 'vue'
import { useRoute } from 'vue-router'

// 擁有者（本人）身分判定：改以「目前在哪條路由」決定，不再需要任何權杖。
//
// /       → 訪客，唯讀
// /owner  → 擁有者，寫入類操作走 /owner/api/*
//
// 真正的閘門是 Cloudflare Access（Zero Trust），設定在 /owner 路徑上；Access 會涵蓋其下
// 所有子路徑，故 /owner/api/* 一併受保護。此處的 isOwner 只是「UI 提示」——就算訪客
// 自行導到 /owner，Access 會先擋在登入頁；即使真的載入了畫面，他打 /owner/api/* 也拿不到授權。
//
// OWNER_PATH 需與 worker/index.js 的同名常數一致，兩邊要一起改。
export const OWNER_PATH = 'owner'

export function useOwner () {
  const route = useRoute()

  // 去掉結尾斜線再比對，/owner 與 /owner/ 都算數
  const isOwner = computed( () => route.path.replace( /\/+$/, '' ) === `/${ OWNER_PATH }` )

  // 寫入類端點的路徑前綴。訪客不會用到（前端不會替他們發寫入請求），
  // 但即使發了，Access 也會擋下。
  const ownerApi = ( name ) => `/${ OWNER_PATH }/api/${ name }`

  return { isOwner, ownerApi }
}
