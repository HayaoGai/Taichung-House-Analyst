const routes = [
  {
    path: '/',
    component: () => import( 'layouts/MainLayout.vue' ),
    children: [
      // 訪客首頁：唯讀
      { path: '', component: () => import( 'pages/IndexPage.vue' ) },

      // 擁有者入口：與首頁同一個畫面，差別在於 useOwner 依路徑判定為擁有者模式，
      // 寫入類操作改打 /owner/api/*。此路徑（含其下子路徑）由 Cloudflare Access 保護，
      // 路徑名稱需與 src/composables/useOwner.js 的 OWNER_PATH 一致。
      { path: 'owner', component: () => import( 'pages/IndexPage.vue' ) },
    ],
  },

  // 任何未匹配路徑導回首頁（SPA 單頁，無 404 需求）
  {
    path: '/:catchAll(.*)*',
    redirect: '/',
  },
]

export default routes
