import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

// strucmed form-app 範本。__APP_NAME__／__APP_SHORT__ 由 scaffold-form-app.mjs 代換。
export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.ico', 'logo192.png', 'logo512.png'],
      manifest: {
        name: '__APP_NAME__',
        short_name: '__APP_SHORT__',
        description: '__APP_NAME__（StrucMed 表單 APP）',
        theme_color: '#f97316',
        // 相對路徑：同一份打包檔可放在 Docker 容器的 / 或站台的 /strucmed/apps/<name>/
        start_url: './',
        scope: './',
        icons: [
          { src: 'logo192.png', sizes: '192x192', type: 'image/png' },
          { src: 'logo512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
        ],
      },
    }),
  ],
  server: {
    port: 3000,
    // 開發：API 轉到本機 strucmed（PathBase 留空）；正式環境由 nginx（H0）或站台（H2）同源提供
    proxy: { '/api': { target: 'http://localhost:5153', changeOrigin: true } },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
  },
  base: './',
})
