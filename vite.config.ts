import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [vue()],
  server: {
    port: 5173,
    proxy: {
      // 开发环境将 /api 转发给本地 Express 后端,避开跨域
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true
      }
    }
  }
})