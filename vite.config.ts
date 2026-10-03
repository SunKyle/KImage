import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [vue()],
  build: {
    rollupOptions: {
      output: {
        /* 把几乎不随业务改动的几个依赖拆成独立的包:改业务只让主包失效,
           用户缓存里那几份大的(图标字库尤其)能留下来。
           fflate 不列在这里 —— 它是动态引入的,本来就自成一块 */
        manualChunks: {
          vue: ['vue'],
          icons: ['@phosphor-icons/vue', 'simple-icons'],
          motion: ['motion']
        }
      }
    }
  },
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