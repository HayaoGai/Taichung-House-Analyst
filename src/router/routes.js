const routes = [
  {
    path: '/',
    component: () => import( 'layouts/MainLayout.vue' ),
    children: [
      { path: '', component: () => import( 'pages/IndexPage.vue' ) },
    ],
  },

  // 任何未匹配路徑導回首頁（SPA 單頁，無 404 需求）
  {
    path: '/:catchAll(.*)*',
    redirect: '/',
  },
]

export default routes
