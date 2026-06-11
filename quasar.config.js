// Quasar App (app-vite v2) 設定檔
// 產出 SPA 至 dist/spa，供 Cloudflare Worker 當作靜態資源掛載（見 PLAN §2、§8.1）
import { defineConfig } from '#q-app/wrappers'
import { fileURLToPath } from 'node:url'

export default defineConfig( () => {
  return {
    boot: [],

    css: [ 'app.scss' ],

    // 僅載入 Material Icons（卡片上的 refresh / open icon 使用）
    extras: [ 'material-icons' ],

    build: {
      target: {
        browser: [ 'es2022', 'firefox115', 'chrome115', 'safari14' ],
        node: 'node20',
      },
      // 以 history 模式產生 SPA；Worker 端 not_found_handling: single-page-application 負責 fallback
      vueRouterMode: 'history',

      // 額外別名：composables（components/layouts/pages 為 Quasar 內建別名）
      alias: {
        composables: fileURLToPath( new URL( './src/composables', import.meta.url ) ),
      },
    },

    devServer: {
      open: false,
      port: 9000,
      // 本機開發時，把 /api 代理到 wrangler dev（預設 8787），模擬正式環境同源行為
      proxy: {
        '/api': {
          target: 'http://localhost:8787',
          changeOrigin: true,
        },
      },
    },

    framework: {
      config: {
        // 啟用深色主題（Quasar Dark 模式），全站元件採深色配色
        dark: true,
      },
      // Notify 用於手動更新的成功/失敗提示
      plugins: [ 'Notify' ],
    },

    animations: [],
  }
} )
