import { createApp } from 'vue'
// 字标字体:只引 latin 子集,避免把西里尔/希腊等用不到的字形打进包
import '@fontsource/poppins/latin-700.css'
import '@fontsource/pacifico/latin-400.css'
import './style.css'
import App from './App.vue'

// 主题切换:优先用用户手动设置,否则跟随系统
const THEME_KEY = 'kimage.theme'
const root = document.documentElement

function applyTheme() {
  const saved = localStorage.getItem(THEME_KEY)
  if (saved === 'light' || saved === 'dark') {
    root.setAttribute('data-theme', saved)
  } else {
    const dark = window.matchMedia('(prefers-color-scheme: dark)').matches
    root.setAttribute('data-theme', dark ? 'dark' : 'light')
  }
}

// 首次渲染前同步主题,避免闪烁
applyTheme()

createApp(App).mount('#app')

// 导出供设置面板做带状态驱动的切换能力(简单起见通过事件)
export { THEME_KEY }