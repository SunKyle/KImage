import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [vue()],
  server: {
    // 固定端口:默认的 5173 被本机另一个项目长期占用,自动顺延会让地址一直漂
    port: 5175,
    // 端口被占时直接报错退出,而不是悄悄换一个端口
    strictPort: true,
    proxy: {
      // 开发环境将 /api 转发给本地 Express 后端,避开跨域
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true
      }
    }
  }
})