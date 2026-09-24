<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, watch } from 'vue'
import PromptLibrary from './components/PromptLibrary.vue'
import ImagePreview from './components/ImagePreview.vue'
import HistoryDrawer from './components/HistoryDrawer.vue'
import {
  generate,
  uid,
  loadConfigs,
  saveConfigs,
  loadActiveId,
  saveActiveId,
  loadHistory,
  addHistoryRecord,
  removeHistoryRecord,
  loadPrompts,
  savePrompts,
  loadPresets,
  STYLE_WORDS
} from './api'
import type { ApiConfig, HistoryEntry, PromptItem, Preset } from './types'

// —— 状态 ——
const prompt = ref('')
const size = ref('1024x1024')
const n = ref(1)
const loading = ref(false)
const error = ref('')
const history = ref<HistoryEntry[]>([])
const libItems = ref<PromptItem[]>([])
const presets = ref<Preset[]>([])
const refImage = ref('') // 图生图参考图 (data URL)
const usedStyles = ref<string[]>([]) // 当前已用的风格标签
const showLib = ref(false)
const showHistory = ref(false)
const previewEntry = ref<HistoryEntry | null>(null)
// 参数 icon 展开的面板:同一时间只开一个,再次点击收起
type PanelKey = '' | 'ref' | 'size' | 'n' | 'style' | 'config'
const openPanel = ref<PanelKey>('')
// 收起动画播放期间保留上一次的面板内容,避免"内容先消失、容器再合拢"的两段跳变
const shownPanel = ref<PanelKey>('')
watch(openPanel, (v) => {
  if (v) shownPanel.value = v
})
function togglePanel(p: Exclude<PanelKey, ''>) {
  openPanel.value = openPanel.value === p ? '' : p
}
// 当前激活配置的名称(未配置时显示占位)
const activeConfigName = computed(() => config.value.name || config.value.baseUrl || '未配置')

// —— 历史图墙(输入框下方,可收起) ——
const feedOpen = ref(true)
const FEED_LIMIT = 12
// 把历史记录里的多张图摊平成图墙,最新的排在最前
const feedItems = computed(() => {
  const out: Array<{
    key: string
    entry: HistoryEntry
    item: { type: 'b64' | 'url'; data: string }
    ratio: number
  }> = []
  for (const entry of history.value) {
    for (let i = 0; i < entry.results.length; i++) {
      if (out.length >= FEED_LIMIT) return out
      out.push({
        key: `${entry.id}-${i}`,
        entry,
        item: entry.results[i],
        ratio: tileRatio(entry.size)
      })
    }
  }
  return out
})
// 按记录尺寸算宽高比,让图墙保留原图比例、高低错落
function tileRatio(size: string) {
  const [w, h] = size.split('x').map(Number)
  if (!w || !h) return 1
  return Math.min(2, Math.max(0.5, w / h))
}
// 图墙列数随图数自适应,免得太少时被压成窄条
const feedCols = computed(() =>
  Math.min(4, Math.max(1, feedItems.value.length + (loading.value ? Math.max(1, n.value) : 0)))
)

const sizeOptions = ['512x512', '1024x1024', '1024x1792', '1792x1024', '2560x1440']

// —— 主题 ——
const theme = ref<'light' | 'dark'>('light')
const THEME_KEY = 'kimage.theme'
onMounted(() => {
  const saved = localStorage.getItem(THEME_KEY)
  theme.value = saved === 'dark' ? 'dark' : 'light'
})
function toggleTheme() {
  theme.value = theme.value === 'dark' ? 'light' : 'dark'
  document.documentElement.setAttribute('data-theme', theme.value)
  localStorage.setItem(THEME_KEY, theme.value)
}

// —— 顶部导航滚动状态:页面一滑动就浮出毛玻璃底,避免与内容糊在一起 ——
const scrolled = ref(false)
function onScroll() {
  scrolled.value = window.scrollY > 4
}
onMounted(() => {
  onScroll()
  window.addEventListener('scroll', onScroll, { passive: true })
})
onBeforeUnmount(() => window.removeEventListener('scroll', onScroll))

// —— 设置面板 ——
const showSettings = ref(false)
// 全部已保存的接口配置
const configs = ref<ApiConfig[]>([])
// 当前正在编辑的配置(表单直接绑定)
const config = ref<ApiConfig>({ id: '', name: '', baseUrl: '', apiKey: '', model: '' })
const activeId = ref('')
// 设置面板视图:'list' = 已保存接口列表,'form' = 新增/编辑接口表单(独立一屏)
const cfgView = ref<'list' | 'form'>('list')

const presetProviders = [
  {
    label: '豆包 Seedream(火山方舟)',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    model: 'doubao-seedream-3-0-t2i'
  },
  {
    label: '通义万相(百炼)',
    baseUrl: 'https://dashscope.aliyuncs.com/api/v1',
    model: 'wanx2.1-t2i-turbo'
  },
  {
    label: 'OpenAI(海外)',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-image-1'
  }
]

onMounted(() => {
  configs.value = loadConfigs()
  activeId.value = loadActiveId()
  // 选中激活配置;无激活则取第一条
  const active =
    configs.value.find((c) => c.id === activeId.value) ||
    configs.value[0]
  if (active) config.value = { ...active }
  libItems.value = loadPrompts()
  presets.value = loadPresets()
  loadHistory().then((h) => (history.value = h))
})

function applyProvider(i: number) {
  const p = presetProviders[i]
  config.value.baseUrl = p.baseUrl
  config.value.model = p.model
}

// 新建一份空白配置(进入独立的新增接口表单页)
function newConfig() {
  config.value = { id: '', name: '', baseUrl: '', apiKey: '', model: '' }
  cfgView.value = 'form'
}
// 复制已有配置:基于它生成一份新编辑(切到表单页)
function duplicateConfig(c: ApiConfig) {
  config.value = { ...c, id: '', name: c.name ? `${c.name} 副本` : '配置副本' }
  cfgView.value = 'form'
}
// 编辑已有配置:带入该配置,切到表单页
function editConfig(c: ApiConfig) {
  config.value = { ...c }
  cfgView.value = 'form'
}
// 保存当前正在编辑的配置(新增或更新),并设为激活
function saveSettings() {
  const cfg = {
    ...config.value,
    id: config.value.id || uid(),
    name: config.value.name.trim() || cfgNameFromUrl(config.value.baseUrl)
  }
  const idx = configs.value.findIndex((c) => c.id === cfg.id)
  if (idx >= 0) configs.value[idx] = cfg
  else configs.value.push(cfg)
  saveConfigs(configs.value)
  config.value = { ...cfg }
  activeId.value = cfg.id
  saveActiveId(cfg.id)
  cfgView.value = 'list'
  showSettings.value = false
}
// 从地址推导一个默认名称
function cfgNameFromUrl(url: string): string {
  try {
    return new URL(url).hostname || '未命名配置'
  } catch {
    return '未命名配置'
  }
}
// 从表单返回列表视图
function cancelConfig() {
  cfgView.value = 'list'
}
// 从参数面板进入接口配置管理抽屉
function openConfigManager() {
  cfgView.value = configs.value.length ? 'list' : 'form'
  if (!configs.value.length) {
    config.value = { id: '', name: '', baseUrl: '', apiKey: '', model: '' }
  }
  showSettings.value = true
  openPanel.value = ''
}
// 设某条配置为激活
function activateConfig(c: ApiConfig) {
  config.value = { ...c }
  activeId.value = c.id
  saveActiveId(c.id)
}
// 删除一条配置;若删的是激活项,自动激活剩余第一条
function removeConfig(c: ApiConfig) {
  configs.value = configs.value.filter((x) => x.id !== c.id)
  saveConfigs(configs.value)
  if (activeId.value === c.id) {
    const next = configs.value[0]
    if (next) {
      config.value = { ...next }
      activeId.value = next.id
      saveActiveId(next.id)
    } else {
      config.value = { id: '', name: '', baseUrl: '', apiKey: '', model: '' }
      activeId.value = ''
      saveActiveId('')
    }
  }
}

function configured() {
  return !!config.value.baseUrl
}

// —— 参数预设 ——
function applyPreset(pr: Preset) {
  size.value = pr.size
  n.value = pr.n
}

// —— 风格快捷词:追加/撤销 ——
function appendStyle(word: string) {
  const chip = STYLE_WORDS.find((s) => s.word === word)
  const label = chip?.label ?? word
  if (usedStyles.value.includes(label)) {
    // 撤销:从 prompt 移除该风格片段
    prompt.value = prompt.value
      .split(',').map((p) => p.trim()).filter((p) => p !== word.trim()).join(', ')
    usedStyles.value = usedStyles.value.filter((l) => l !== label)
  } else {
    if (!prompt.value.trim()) {
      prompt.value = word
    } else {
      prompt.value = prompt.value.replace(/[,\s]*$/, '') + ', ' + word
    }
    usedStyles.value = [...usedStyles.value, label]
  }
}

// 提示词被清空时,清除已用风格标记
watch(prompt, (v) => {
  if (!v.trim()) usedStyles.value = []
})

// 按 prompt 内容重算已用风格(用于回填历史/提示词后)
function syncUsedStyles() {
  usedStyles.value = STYLE_WORDS
    .filter((s) => prompt.value.includes(s.word))
    .map((s) => s.label)
}

function useLibItem(item: PromptItem) {
  prompt.value = item.prompt
  if (item.size) size.value = item.size
  syncUsedStyles()
  showLib.value = false
  window.scrollTo({ top: 0, behavior: 'smooth' })
}
function removeLibItem(id: string) {
  libItems.value = libItems.value.filter((i) => i.id !== id)
  savePrompts(libItems.value)
}
function addLibItem(item: PromptItem) {
  libItems.value = [item, ...libItems.value]
  savePrompts(libItems.value)
}
function importLibItems(items: PromptItem[]) {
  libItems.value = [...items, ...libItems.value]
  savePrompts(libItems.value)
}

// —— 图生图:读取本地图片为 data URL(压缩到最长边 1024,避免请求体过大 413) ——
function onPickRef(e: Event) {
  const file = (e.target as HTMLInputElement).files?.[0]
  if (!file) return
  const reader = new FileReader()
  reader.onload = () => {
    const url = String(reader.result)
    compressImage(url, 1024).then((out) => (refImage.value = out))
  }
  reader.readAsDataURL(file)
  ;(e.target as HTMLInputElement).value = ''
}
// 用 canvas 压缩图片:超过 maxEdge 的最长边等比缩放,透明图铺白底,输出 JPEG
function compressImage(dataUrl: string, maxEdge = 1024): Promise<string> {
  return new Promise((resolve) => {
    const img = new Image()
    img.onload = () => {
      let { width, height } = img
      const scale = Math.min(1, maxEdge / Math.max(width, height))
      if (scale >= 1) return resolve(dataUrl) // 本来就小,原样保留
      width = Math.round(width * scale)
      height = Math.round(height * scale)
      const c = document.createElement('canvas')
      c.width = width
      c.height = height
      const ctx = c.getContext('2d')
      if (!ctx) return resolve(dataUrl)
      ctx.fillStyle = '#fff' // 透明 PNG 转 JPEG 时铺白底,避免变黑
      ctx.fillRect(0, 0, width, height)
      ctx.drawImage(img, 0, 0, width, height)
      resolve(c.toDataURL('image/jpeg', 0.85))
    }
    img.onerror = () => resolve(dataUrl)
    img.src = dataUrl
  })
}
function clearRef() {
  refImage.value = ''
}

// —— 生图 ——
async function doGenerate() {
  if (loading.value) return
  if (!prompt.value.trim()) {
    error.value = '请先输入提示词'
    return
  }
  if (!configured()) {
    error.value = '请先在“接口设置”中配置接口地址'
    showSettings.value = true
    return
  }

  loading.value = true
  error.value = ''
  try {
    const res = await generate(
      {
        prompt: prompt.value,
        size: size.value,
        n: n.value,
        ...(refImage.value ? { image: refImage.value } : {})
      },
      config.value
    )
    const record: HistoryEntry = {
      id: Date.now() + Math.random().toString(16).slice(2),
      prompt: prompt.value,
      size: size.value,
      model: config.value.model || undefined,
      createdAt: Date.now(),
      results: res
    }
    history.value = [record, ...history.value]
    await addHistoryRecord(record)
  } catch (e: any) {
    error.value = e?.message || '生成失败'
  } finally {
    loading.value = false
  }
}

// —— 工具 ——
function renderData(item: { type: 'b64' | 'url'; data: string }) {
  // 已是完整 Data URL 直接返回;旧数据若是纯 base64 补一个 png 前缀(尽力兼容)
  if (item.data.startsWith('data:')) return item.data
  return item.type === 'b64' ? `data:image/png;base64,${item.data}` : item.data
}

// 图墙角标用的紧凑时间:09-24 15:54
function fmtDate(ts: number) {
  const d = new Date(ts)
  const p = (x: number) => String(x).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

function openPreview(entry: HistoryEntry) {
  previewEntry.value = entry
}
function closePreview() {
  previewEntry.value = null
}
function usePreviewPrompt(t: string) {
  prompt.value = t
  syncUsedStyles()
  window.scrollTo({ top: 0, behavior: 'smooth' })
}

// 预览菜单:收藏当前预览的提示词到库
function favoriteFromPreview(t: string) {
  if (!t.trim()) return
  const item: PromptItem = {
    id: Date.now() + Math.random().toString(16).slice(2),
    title: t,
    prompt: t,
    category: '未分类',
    createdAt: Date.now()
  }
  libItems.value = [item, ...libItems.value]
  savePrompts(libItems.value)
  closePreview()
  showLib.value = true
}

// 预览菜单:把当前图用作参考图
function setAsReference(src: string) {
  if (!src || !src.startsWith('data:')) {
    error.value = '仅本地图片(Data URL)可作为参考图'
    return
  }
  refImage.value = src
  closePreview()
  window.scrollTo({ top: 0, behavior: 'smooth' })
}

// 预览菜单:删除该条历史
async function removeHistoryItem() {
  const cur = previewEntry.value
  if (!cur) return
  history.value = history.value.filter((h) => h.id !== cur.id)
  await removeHistoryRecord(cur.id)
  closePreview()
}
// 历史抽屉:直接删除某条记录
async function removeHistoryEntry(entry: HistoryEntry) {
  history.value = history.value.filter((h) => h.id !== entry.id)
  await removeHistoryRecord(entry.id)
}

</script>

<template>
  <div class="shell">
    <!-- 品牌 + 全局操作 -->
    <header class="masthead" :class="{ scrolled }">
      <div class="wordmark">
        <span class="mark" aria-hidden="true">
          <svg viewBox="0 0 32 32" fill="none">
            <defs>
              <linearGradient id="lg-k" x1="8" y1="6" x2="24" y2="26">
                <stop offset="0" stop-color="#c98a5e" />
                <stop offset="1" stop-color="#a85f3f" />
              </linearGradient>
            </defs>
            <!-- 取景框圆角方形 -->
            <rect x="3.2" y="3.2" width="25.6" height="25.6" rx="7" stroke="currentColor" stroke-width="1.8" />
            <!-- 画面边缘渐变线(留白呼吸感) -->
            <path d="M3.2 22.5h6.2l3.6-6 4.2 6h5.4" stroke="url(#lg-k)" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" />
            <!-- 内置太阳：图像主题 -->
            <circle cx="21.5" cy="11.2" r="2.6" stroke="url(#lg-k)" stroke-width="2.2" />
          </svg>
        </span>
        <span class="title">KImage</span>
      </div>
      <nav class="mast-actions">
        <button class="icob" @click="showLib = true" title="提示词库" aria-label="提示词库">
          <!-- 摊开的书:表达"收藏成册的提示词库" -->
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 7v14" />
            <path d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z" />
          </svg>
        </button>
        <button
          class="icob"
          :class="{ active: showHistory }"
          @click="showHistory = true"
          title="历史"
          aria-label="历史"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="9" />
            <path d="M12 7.4V12l2.8 1.9" />
          </svg>
          <span v-if="history.length" class="icob-badge">{{ history.length }}</span>
        </button>
        <button
          class="icob"
          :class="{ active: showSettings, 'icon-btn-warn': !configured() }"
          @click="showSettings = !showSettings"
          :title="configured() ? (showSettings ? '关闭设置' : '接口设置') : '未配置接口,点击设置'"
          :aria-label="configured() ? (showSettings ? '关闭设置' : '接口设置') : '未配置接口,点击设置'"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="3.4" />
            <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.03 1.56V21a2 2 0 1 1-4 0v-.09A1.7 1.7 0 0 0 8.96 19.4a1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.56-1.03H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.6 8.96 1.7 1.7 0 0 0 4.26 7.09l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 8.96 4.6 1.7 1.7 0 0 0 9.99 3.04V3a2 2 0 1 1 4 0v.09A1.7 1.7 0 0 0 15 4.6 1.7 1.7 0 0 0 16.91 4.26l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.4 8.96 1.7 1.7 0 0 0 20.96 9.99H21a2 2 0 1 1 0 4h-.09A1.7 1.7 0 0 0 19.4 15Z" />
          </svg>
        </button>
        <button
          class="icob"
          @click="toggleTheme"
          :title="theme === 'dark' ? '切换浅色' : '切换深色'"
          :aria-label="theme === 'dark' ? '切换浅色' : '切换深色'"
        >
          <svg v-if="theme === 'dark'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="4" />
            <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
          </svg>
          <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />
          </svg>
        </button>
      </nav>
    </header>

    <main class="frame">
      <!-- 生图工作台 -->
      <section class="workbench" aria-label="生图工作台">
        <header class="hero">
          <h1 class="hero-title">Turn your ideas<br />into beautiful images</h1>
          <p class="hero-sub">Create, explore, and organize AI-generated images with ease.</p>
        </header>

        <div class="composer">
          <div class="prompt-box">
            <!-- 一、输入区(横线上方) -->
            <div class="compose-zone">
              <textarea
                id="prompt-input"
                v-model="prompt"
                rows="1"
                placeholder="描述你想要的画面：一只在樱花树下打盹的橘猫，清晨柔光，电影感，浅景深…"
                @keydown.enter.exact.prevent="doGenerate"
              />

            </div>

            <!-- 二、参数 icon 行(横线下方),点击 icon 展开对应选项 -->
            <div class="param-bar" role="group" aria-label="生成参数">
              <button
                class="param-btn"
                :class="{ on: openPanel === 'config', filled: !!configured() }"
                title="配置"
                @click="togglePanel('config')"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M4 7h8M17 7h3M4 17h3M12 17h8" />
                  <circle cx="14.5" cy="7" r="2.3" />
                  <circle cx="9.5" cy="17" r="2.3" />
                </svg>
                <span>配置</span>
                <b class="param-val param-val-name">{{ activeConfigName }}</b>
              </button>
              <button
                class="param-btn"
                :class="{ on: openPanel === 'ref', filled: !!refImage }"
                title="参考图"
                @click="togglePanel('ref')"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
                  <rect x="3" y="4" width="18" height="16" rx="2.5" />
                  <circle cx="8.5" cy="9.5" r="1.8" />
                  <path d="M4 17.5l4.5-4.5L12 16.5l3-3 5 5" />
                </svg>
                <span>参考图</span>
              </button>
              <button
                class="param-btn"
                :class="{ on: openPanel === 'size' }"
                title="尺寸"
                @click="togglePanel('size')"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
                  <!-- 外框 + 对角缩放箭头:表达"尺寸/比例" -->
                  <rect x="3.5" y="3.5" width="17" height="17" rx="3" />
                  <path d="M9.5 14.5 14.5 9.5M9.5 11.6v2.9h2.9M14.5 12.4V9.5h-2.9" />
                </svg>
                <span>尺寸</span>
                <b class="param-val">{{ size }}</b>
              </button>
              <button
                class="param-btn"
                :class="{ on: openPanel === 'n' }"
                title="张数"
                @click="togglePanel('n')"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
                  <rect x="3.5" y="3.5" width="7" height="7" rx="1.6" />
                  <rect x="13.5" y="3.5" width="7" height="7" rx="1.6" />
                  <rect x="3.5" y="13.5" width="7" height="7" rx="1.6" />
                  <rect x="13.5" y="13.5" width="7" height="7" rx="1.6" />
                </svg>
                <span>张数</span>
                <b class="param-val">{{ n }}</b>
              </button>
              <button
                class="param-btn"
                :class="{ on: openPanel === 'style', filled: usedStyles.length > 0 }"
                title="风格"
                @click="togglePanel('style')"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M12 3l1.9 4.6L18.5 9.5l-4.6 1.9L12 16l-1.9-4.6L5.5 9.5l4.6-1.9L12 3Z" />
                  <path d="M18 16.5l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8.8-2Z" />
                </svg>
                <span>风格</span>
                <b v-if="usedStyles.length" class="param-val">{{ usedStyles.length }}</b>
              </button>

              <!-- 清除(次级) + 生成(主按钮),右对齐收在参数行末尾 -->
              <div class="prompt-actions">
                <button
                  v-if="prompt.trim() && !loading"
                  class="clear-icon"
                  aria-label="清除输入"
                  title="清除输入"
                  @click="prompt = ''"
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">
                    <path d="M6 6l12 12M18 6L6 18" />
                  </svg>
                </button>
                <button
                  class="gen-icon"
                  :disabled="loading || !prompt.trim()"
                  :aria-label="loading ? '生成中…' : '生成画面'"
                  :title="loading ? '生成中…' : '生成画面（Enter）'"
                  @click="doGenerate"
                >
                  <span v-if="loading" class="spinner" aria-hidden="true"></span>
                  <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M5 12h13" />
                    <path d="M13 6l6 6-6 6" />
                  </svg>
                </button>
              </div>
            </div>

            <!-- 展开面板:用 grid-template-rows 动画高度,收起时连续合拢无跳变 -->
            <div class="fold" :class="{ open: !!openPanel }">
              <div class="fold-inner">
                <div class="param-panel">
                  <!-- 配置 -->
                  <div v-if="shownPanel === 'config'" class="pp-body">
                    <div v-if="configs.length" class="pp-group">
                      <span class="pp-label">已保存</span>
                      <button
                        v-for="c in configs"
                        :key="c.id"
                        class="preset"
                        :class="{ on: config.id === c.id }"
                        :title="`${c.baseUrl}${c.model ? ' · ' + c.model : ''}`"
                        @click="activateConfig(c)"
                      >
                        {{ c.name || '未命名配置' }}
                      </button>
                    </div>
                    <div class="pp-group">
                      <span v-if="!configs.length" class="pp-note">还没有保存的配置</span>
                      <button class="pp-action" @click="openConfigManager">
                        {{ configs.length ? '管理接口配置' : '去新增配置' }}
                      </button>
                    </div>
                  </div>

                  <!-- 参考图 -->
                  <div v-else-if="shownPanel === 'ref'" class="pp-body">
                    <div class="pp-group">
                      <template v-if="!refImage">
                        <label class="ref-pick" for="ref-file">＋ 选择本地图片作为参考图</label>
                      </template>
                      <template v-else>
                        <img class="pp-thumb" :src="refImage" alt="参考图" />
                        <span class="pp-note">已选用参考图</span>
                        <button class="pp-action" @click="clearRef">移除</button>
                      </template>
                    </div>
                  </div>

                  <!-- 尺寸 -->
                  <div v-else-if="shownPanel === 'size'" class="pp-body">
                    <div class="pp-group">
                      <span class="pp-label">常用</span>
                      <button
                        v-for="pr in presets"
                        :key="pr.id"
                        class="preset"
                        :class="{ on: size === pr.size && n === pr.n }"
                        @click="applyPreset(pr)"
                      >
                        {{ pr.name }}
                      </button>
                    </div>
                    <div class="pp-group">
                      <span class="pp-label">尺寸</span>
                      <button
                        v-for="s in sizeOptions"
                        :key="s"
                        class="preset"
                        :class="{ on: size === s }"
                        @click="size = s"
                      >
                        {{ s }}
                      </button>
                    </div>
                  </div>

                  <!-- 张数 -->
                  <div v-else-if="shownPanel === 'n'" class="pp-body">
                    <div class="pp-group">
                      <span class="pp-label">张数</span>
                      <button
                        v-for="c in 4"
                        :key="c"
                        class="preset"
                        :class="{ on: n === c }"
                        @click="n = c"
                      >
                        {{ c }} 张
                      </button>
                    </div>
                  </div>

                  <!-- 风格 -->
                  <div v-else-if="shownPanel === 'style'" class="pp-body">
                    <div class="pp-group">
                      <span class="pp-label">风格</span>
                      <button
                        v-for="s in STYLE_WORDS"
                        :key="s.label"
                        class="preset"
                        :class="{ on: usedStyles.includes(s.label) }"
                        :title="usedStyles.includes(s.label) ? '再次点击撤销' : '追加到提示词'"
                        @click="appendStyle(s.word)"
                      >
                        {{ s.label }}
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <input id="ref-file" type="file" accept="image/*" hidden @change="onPickRef" />
          </div>

          <p class="hint">Enter 发送 · Shift + Enter 换行 · 配置、预设与提示词库均存于本地</p>

          <p v-if="error" class="err" role="alert">{{ error }}</p>
        </div>

        <!-- 历史图墙:输入框下方展示最近生成的图,可收起 -->
        <div v-if="loading || feedItems.length" class="feed-zone" aria-live="polite">
          <div class="section-head">
            <span class="sec-title">{{ loading ? 'Generating…' : 'Recent creations' }}</span>
            <div class="sec-tools">
              <button v-if="history.length" class="sec-more" @click="showHistory = true">
                View all
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M9 6l6 6-6 6" />
                </svg>
              </button>
              <button
                class="sec-fold"
                :title="feedOpen ? 'Collapse' : 'Expand'"
                :aria-expanded="feedOpen"
                @click="feedOpen = !feedOpen"
              >
                <span>{{ feedOpen ? 'Collapse' : 'Expand' }}</span>
                <svg
                  viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
                  stroke-linecap="round" stroke-linejoin="round" :class="{ up: feedOpen }"
                >
                  <path d="M6 9l6 6 6-6" />
                </svg>
              </button>
            </div>
          </div>

          <div class="fold" :class="{ open: feedOpen }">
            <div class="fold-inner">
              <div class="feed-grid" :class="`cols-${feedCols}`">
                <div
                  v-for="k in loading ? (n > 0 ? n : 1) : 0"
                  :key="`sk-${k}`"
                  class="tile tile-skel"
                  :style="{ aspectRatio: String(tileRatio(size)) }"
                >
                  <div class="skel-shimmer"></div>
                </div>
                <button
                  v-for="t in feedItems"
                  :key="t.key"
                  class="tile"
                  :style="{ aspectRatio: String(t.ratio) }"
                  :title="t.entry.prompt"
                  @click="openPreview(t.entry)"
                >
                  <img loading="lazy" :src="renderData(t.item)" :alt="t.entry.prompt" />
                  <span class="tile-veil">
                    <span class="tile-text">{{ t.entry.prompt }}</span>
                    <span class="tile-meta">{{ fmtDate(t.entry.createdAt) }} · {{ t.entry.size }}</span>
                  </span>
                </button>
              </div>
            </div>
          </div>
        </div>
      </section>
    </main>

    <!-- 接口设置抽屉 -->
    <Teleport to="body">
      <Transition name="drawer">
        <div v-if="showSettings" class="drawer-scrim" @click.self="showSettings = false">
          <aside class="drawer-panel" role="dialog" aria-label="接口设置">
            <header class="d-head">
              <div>
                <h2>接口设置</h2>
                <p class="d-lede">支持任意 OpenAI 兼容的生图接口，配置保存在本地。</p>
              </div>
              <button class="d-close" @click="showSettings = false" aria-label="关闭" title="关闭">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
              </button>
            </header>

            <div class="d-body no-bar">
              <!-- ===== 视图一:已保存的接口列表 ===== -->
              <section v-if="cfgView === 'list'" class="cfg-bloc">
                <header class="cfg-head">
                  <span class="preset-label">{{ configs.length ? '已保存的接口' : '接口列表' }}</span>
                  <button class="cfg-add" @click="newConfig" title="新增接口" aria-label="新增接口">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M12 5v14M5 12h14" /></svg>
                  </button>
                </header>

                <div v-if="configs.length" class="cfg-list">
                  <div class="cfg-row" :class="{ on: config.id === c.id }" v-for="c in configs" :key="c.id">
                    <button class="cfg-main" @click="activateConfig(c)">
                      <span class="cfg-name">{{ c.name || '未命名配置' }}</span>
                      <span class="cfg-meta">{{ c.baseUrl }}<template v-if="c.model"> · {{ c.model }}</template></span>
                    </button>
                    <span v-if="config.id === c.id" class="cfg-active">当前</span>
                    <div class="cfg-ops">
                      <button class="cfg-op" @click="editConfig(c)" title="修改" aria-label="修改">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                          <path d="M12 20h9" />
                          <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
                        </svg>
                      </button>
                      <button class="cfg-op" @click="duplicateConfig(c)" title="复制" aria-label="复制">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                          <rect x="9" y="9" width="11" height="11" rx="2" />
                          <path d="M5 15V6a1 1 0 0 1 1-1h9" />
                        </svg>
                      </button>
                      <button class="cfg-op danger" @click="removeConfig(c)" title="删除" aria-label="删除">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                          <path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6 7l1 12a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-12" />
                        </svg>
                      </button>
                    </div>
                  </div>
                </div>
                <p v-else class="cfg-empty">还没有接口，点右上角 ＋ 新增第一个。</p>
              </section>

              <!-- ===== 视图二:新增/编辑接口表单(独立一屏) ===== -->
              <section v-else class="cfg-form">
                <header class="cfg-head">
                  <span class="preset-label">{{ config.id ? '编辑接口' : '新增接口' }}</span>
                  <button class="cfg-back" @click="cancelConfig" title="返回列表" aria-label="返回列表">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M15 6l-6 6 6 6" /></svg>
                  </button>
                </header>

                <div class="presets" role="group" aria-label="快速选择">
                  <span class="preset-label">预设</span>
                  <button
                    v-for="(p, i) in presetProviders"
                    :key="p.label"
                    class="preset"
                    @click="applyProvider(i)"
                  >
                    {{ p.label }}
                  </button>
                </div>

                <label class="field">
                  <span class="flabel">配置名称</span>
                  <input v-model="config.name" placeholder="如：豆包主力 / 通义备用" spellcheck="false" />
                </label>
                <label class="field">
                  <span class="flabel">接口地址 Base URL</span>
                  <input v-model="config.baseUrl" placeholder="https://example.com/api/v3" spellcheck="false" />
                </label>
                <label class="field">
                  <span class="flabel">API Key</span>
                  <input v-model="config.apiKey" type="password" placeholder="sk-…  (本地服务可留空)" />
                </label>
                <label class="field">
                  <span class="flabel">模型名称</span>
                  <input v-model="config.model" placeholder="doubao-seedream-3-0-t2i" spellcheck="false" />
                </label>

                <div class="drawer-foot">
                  <button class="slot-btn" @click="saveSettings">保存配置</button>
                </div>
              </section>
            </div>
          </aside>
        </div>
      </Transition>
    </Teleport>

    <!-- 提示词库抽屉 -->
    <PromptLibrary
      :items="libItems"
      :visible="showLib"
      @close="showLib = false"
      @use="useLibItem"
      @remove="removeLibItem"
      @add="addLibItem"
      @import="importLibItems"
    />

    <!-- 历史记录抽屉 -->
    <HistoryDrawer
      :items="history"
      :visible="showHistory"
      @close="showHistory = false"
      @open="openPreview"
      @use="usePreviewPrompt"
      @remove="removeHistoryEntry"
    />

    <!-- 历史图片预览 -->
    <ImagePreview
      :visible="!!previewEntry"
      :entry="previewEntry"
      @close="closePreview"
      @use-prompt="usePreviewPrompt"
      @favorite="favoriteFromPreview"
      @reference="setAsReference"
      @remove="removeHistoryItem"
    />
  </div>
</template>

<style scoped>
.shell {
  max-width: 1080px;
  margin: 0 auto;
  padding: 0 clamp(16px, 4vw, 40px) 64px;
}

.masthead {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--sp-4) 0;
  position: sticky;
  top: 0;
  z-index: 10;
}
/* 页面顶部时完全透明,融入背景图;滚动后浮出一层通栏毛玻璃,
   与主页面内容拉开层次,不再糊在一起 */
.masthead::before {
  content: '';
  position: absolute;
  top: 0;
  bottom: 0;
  left: 50%;
  width: 100vw;
  transform: translateX(-50%);
  /* translate 会让伪元素按 z-index:0 参与绘制,压住未定位的品牌区,
     所以显式沉到负层:在导航自身内容之下、主页面内容之上 */
  z-index: -1;
  pointer-events: none;
  opacity: 0;
  background: color-mix(in srgb, var(--bg) 82%, transparent);
  border-bottom: 1px solid var(--line);
  backdrop-filter: blur(14px) saturate(140%);
  -webkit-backdrop-filter: blur(14px) saturate(140%);
  transition: opacity var(--dur) var(--ease);
}
.masthead.scrolled::before {
  opacity: 1;
}
.wordmark {
  display: flex;
  align-items: center;
  gap: 9px;
}
.mark {
  display: inline-flex;
  color: var(--text);
}
.mark svg {
  width: 30px;
  height: 30px;
  display: block;
  transition: transform var(--dur) var(--ease);
}
.wordmark:hover .mark svg {
  transform: rotate(-4deg) scale(1.04);
}
.title {
  font-family: var(--font-display);
  font-size: 21px;
  /* 字标:加重笔画 + 收紧字距,避免读成正文(正字距是正文/大写小字的用法) */
  font-weight: 600;
  letter-spacing: -0.022em;
  color: var(--text);
}
.mast-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}
.icob {
  position: relative;
  width: 36px;
  height: 36px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px solid transparent;
  border-radius: 999px;
  color: var(--text-2);
  transition: color var(--dur) var(--ease), background var(--dur) var(--ease), border-color var(--dur) var(--ease);
}
.icob:hover {
  color: var(--text);
  background: var(--bg-elev);
  border-color: var(--line);
}
.icob.active {
  color: var(--accent);
  background: var(--accent-soft);
  border-color: color-mix(in oklch, var(--accent) 30%, transparent);
}
.icob svg {
  width: 18px;
  height: 18px;
}
.icob-badge {
  position: absolute;
  top: -5px;
  right: -5px;
  min-width: 17px;
  height: 17px;
  padding: 0 4px;
  font-size: 10px;
  font-variant-numeric: tabular-nums;
  line-height: 17px;
  text-align: center;
  border-radius: 999px;
  background: var(--accent);
  color: var(--accent-contrast);
}
.icon-btn-warn {
  color: var(--danger);
  border-color: color-mix(in oklch, var(--danger) 35%, transparent);
  background: color-mix(in oklch, var(--danger) 8%, transparent);
}
.icon-btn-warn:hover {
  color: var(--danger);
  background: color-mix(in oklch, var(--danger) 14%, transparent);
  border-color: color-mix(in oklch, var(--danger) 50%, transparent);
}

.frame {
  margin-top: var(--sp-2);
  display: flex;
  flex-direction: column;
  gap: var(--sp-7);
}

.panel {
  background: var(--bg-elev);
  border: 1px solid var(--line);
  border-radius: var(--r-lg);
  padding: var(--sp-6);
  box-shadow: var(--sh-md);
}
.panel-head h2 {
  font-family: var(--font-display);
  font-weight: 500;
  font-size: 22px;
}
.lede {
  margin-top: 4px;
  color: var(--text-2);
  font-size: 14px;
}
.presets {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--sp-2);
  margin: var(--sp-5) 0 var(--sp-5);
}
.preset-label {
  font-size: 13px;
  color: var(--text-3);
  margin-right: 6px;
}
.preset {
  padding: 6px 12px;
  font-size: 13px;
  border: 1px solid var(--line);
  border-radius: 999px;
  color: var(--text-2);
  transition: all var(--dur) var(--ease);
}
.preset:hover {
  border-color: var(--accent);
  color: var(--accent);
}
.preset.on {
  background: var(--accent-soft);
  border-color: var(--accent);
  color: var(--accent-strong);
}
/* 已保存的接口配置列表 */
.cfg-bloc {
  margin: 0;
}
.cfg-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 10px;
}
.cfg-head .preset-label {
  margin-right: 0;
}
.cfg-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.cfg-add {
  width: 30px;
  height: 30px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--line);
  border-radius: 999px;
  color: var(--text-3);
  background: none;
  cursor: pointer;
  transition: all var(--dur) var(--ease);
}
.cfg-add svg {
  width: 16px;
  height: 16px;
}
.cfg-add:hover {
  border-color: var(--accent);
  color: var(--accent);
  background: var(--accent-soft);
}
.cfg-back {
  width: 30px;
  height: 30px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--line);
  border-radius: 999px;
  color: var(--text-3);
  background: none;
  cursor: pointer;
  transition: all var(--dur) var(--ease);
}
.cfg-back svg {
  width: 16px;
  height: 16px;
}
.cfg-back:hover {
  border-color: var(--accent);
  color: var(--accent);
  background: var(--accent-soft);
}
.cfg-empty {
  font-size: 13px;
  color: var(--text-3);
  padding: 18px 4px;
}
.cfg-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  border: 1px solid var(--line);
  border-radius: var(--r-sm);
  background: var(--surface);
  transition: border-color var(--dur) var(--ease), background var(--dur) var(--ease),
    box-shadow var(--dur) var(--ease);
}
.cfg-row:hover {
  border-color: var(--line-strong);
}
.cfg-row.on {
  border-color: color-mix(in oklch, var(--accent) 45%, var(--line));
  background: var(--accent-soft);
  box-shadow: 0 6px 18px -10px color-mix(in oklch, var(--accent) 60%, transparent);
}
.cfg-main {
  flex: 1;
  min-width: 0;
  text-align: left;
  display: flex;
  flex-direction: column;
  gap: 3px;
  cursor: pointer;
  background: none;
  border: none;
  padding: 0;
  color: var(--text);
}
.cfg-main:hover .cfg-name {
  color: var(--accent);
}
.cfg-name {
  font-size: 14px;
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  transition: color var(--dur) var(--ease);
}
.cfg-meta {
  font-size: 12px;
  color: var(--text-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.cfg-active {
  flex-shrink: 0;
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 999px;
  color: var(--accent-strong);
  background: color-mix(in oklch, var(--accent) 14%, transparent);
  border: 1px solid color-mix(in oklch, var(--accent) 30%, transparent);
}
.cfg-ops {
  flex-shrink: 0;
  display: flex;
  gap: 4px;
}
.cfg-op {
  width: 28px;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--line);
  border-radius: var(--r-sm);
  color: var(--text-3);
  background: none;
  cursor: pointer;
  transition: all var(--dur) var(--ease);
}
.cfg-op svg {
  width: 15px;
  height: 15px;
}
.cfg-op:hover {
  border-color: color-mix(in oklch, var(--accent) 45%, var(--line));
  color: var(--accent);
  background: var(--accent-soft);
}
.cfg-op.danger:hover {
  border-color: var(--danger);
  color: var(--danger);
}
.field {
  display: block;
  margin-top: var(--sp-4);
}
.field + .field {
  margin-top: var(--sp-4);
}
.flabel {
  display: block;
  font-size: 13px;
  color: var(--text-2);
  margin-bottom: 6px;
}
.field input,
.composer textarea,
.search {
  width: 100%;
  padding: 11px 14px;
  border: 1px solid var(--line);
  border-radius: var(--r-sm);
  background: var(--surface);
  font-size: 14px;
  transition: border-color var(--dur) var(--ease), box-shadow var(--dur) var(--ease);
}
.field input:focus,
.composer textarea:focus {
  border-color: var(--accent);
  box-shadow: 0 6px 22px -8px color-mix(in oklch, var(--accent) 40%, transparent);
}
.panel-foot {
  margin-top: var(--sp-6);
  display: flex;
  justify-content: flex-end;
}
.slot-btn {
  padding: 10px 20px;
  border-radius: var(--r-sm);
  background: var(--accent);
  color: var(--accent-contrast);
  font-size: 14px;
  font-weight: 500;
  transition: background var(--dur) var(--ease);
}
.slot-btn:hover {
  background: var(--accent-strong);
}

.workbench {
  display: flex;
  flex-direction: column;
  gap: var(--sp-6);
}
.hero {
  position: relative;
  text-align: center;
  /* 顶部留白收窄,让标题与输入框整体上移,首屏更快进入内容 */
  padding: clamp(24px, 3.5vw, 44px) var(--sp-4) var(--sp-5);
  overflow: hidden;
}
.hero-title {
  font-family: var(--font-display);
  font-weight: 700;
  /* 英文行更长,字号上限与下限都比中文版收一档,避免窄屏被裁切 */
  font-size: clamp(28px, 5.2vw, 56px);
  letter-spacing: -0.03em;
  line-height: 1.08;
  position: relative;
  z-index: 1;
}
.hero-sub {
  margin-top: var(--sp-4);
  color: var(--text-3);
  font-size: 15px;
  letter-spacing: 0.01em;
  position: relative;
  z-index: 1;
}
.composer {
  max-width: 840px; /* 放宽:保证参数行一行容纳各参数 + 清除/发送按钮 */
  width: 100%;
  margin: 0 auto;
}
.prompt-box {
  position: relative;
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: var(--r-lg); /* Prompt Composer: Large 24px */
  padding: 16px;
  box-shadow: var(--sh-float);
  display: flex;
  flex-direction: column;
  /* 光晕用更长的时长淡入淡出,避免收放时显得突兀 */
  transition: border-color var(--dur) var(--ease), box-shadow 340ms var(--ease);
}
.prompt-box:focus-within {
  border-color: color-mix(in oklch, var(--accent) 34%, var(--line));
  box-shadow:
    var(--sh-float),
    /* 漫反射:由内向外 4 层递减柔光,越往外越淡,层间无可见边界 */
    0 0 8px -3px color-mix(in oklch, var(--accent) 16%, transparent),
    0 0 18px -5px color-mix(in oklch, var(--accent) 20%, transparent),
    0 0 34px -10px color-mix(in oklch, var(--accent) 24%, transparent),
    0 0 58px -18px color-mix(in oklch, var(--accent) 26%, transparent),
    /* 向下的柔和投影,把输入框轻轻托起来 */
    0 14px 36px -22px color-mix(in oklch, var(--accent) 34%, transparent),
    /* 内侧沿边框晕染的一层薄雾,像光从边缘渗进来 */
    inset 0 0 14px -10px color-mix(in oklch, var(--accent) 26%, transparent);
}
/* 一、输入区(横线上方) */
.compose-zone {
  display: flex;
  flex-direction: column;
}
.prompt-box textarea {
  resize: vertical;
  line-height: 1.6;
  font-size: 16px;
  min-height: 40px; /* 默认一行(16px × 1.6 + 上下内边距),可拖拽加高 */
  padding: 6px 2px 8px;
  border: none;
  border-radius: 0;
  background: transparent;
  box-shadow: none;
}
.prompt-box textarea:focus,
.prompt-box textarea:focus-visible {
  border: none;
  box-shadow: none;
  outline: none;
}
/* 二、参数 icon 行(横线下方) */
.param-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-top: 10px;
  padding: 12px 2px 0;
  border-top: 1px solid var(--line);
}
.param-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 34px;
  padding: 0 13px 0 11px;
  font-size: 13px;
  line-height: 1;
  color: var(--text-2);
  border: 1px solid var(--line);
  border-radius: 999px;
  background: var(--surface);
  transition: color var(--dur) var(--ease), border-color var(--dur) var(--ease),
    background var(--dur) var(--ease);
}
.param-btn svg {
  width: 16px;
  height: 16px;
  flex-shrink: 0;
}
.param-btn:hover {
  color: var(--text);
  border-color: var(--line-strong);
}
.param-btn.on {
  color: var(--accent-strong);
  border-color: color-mix(in oklch, var(--accent) 45%, transparent);
  background: var(--accent-soft);
}
.param-btn.filled {
  border-color: color-mix(in oklch, var(--accent) 40%, transparent);
  color: var(--accent-strong);
}
.param-val {
  font-weight: 500;
  color: var(--text);
  font-variant-numeric: tabular-nums;
}
/* 配置名过长时省略 */
.param-val-name {
  max-width: 130px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 400;
  font-size: 12px;
  color: var(--text-3);
}
.param-btn.on .param-val-name,
.param-btn.filled .param-val-name {
  color: inherit;
}
.param-btn.on .param-val,
.param-btn.filled .param-val {
  color: inherit;
}

/* 折叠容器:高度用 grid-template-rows 0fr→1fr 连续过渡,
   不靠 display 切换,避免"先淡出、再瞬间合拢"的两段跳变 */
.fold {
  display: grid;
  grid-template-rows: 0fr;
  min-height: 0;
  transition: grid-template-rows var(--dur) var(--ease);
}
.fold.open {
  grid-template-rows: 1fr;
}
.fold-inner {
  min-height: 0;
  overflow: hidden;
}
.param-panel {
  margin-top: 10px;
  padding: 12px;
  border-radius: var(--r-sm);
  background: var(--bg-elev);
  max-height: 190px;
  overflow-y: auto;
  opacity: 0;
  transform: translateY(-4px);
  transition: opacity var(--dur) var(--ease), transform var(--dur) var(--ease);
}
.fold.open .param-panel {
  opacity: 1;
  transform: none;
}
.pp-body {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.pp-group {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.pp-label {
  font-size: 12px;
  color: var(--text-3);
  margin-right: 2px;
}
.pp-thumb {
  width: 40px;
  height: 40px;
  object-fit: cover;
  border-radius: var(--r-sm);
  border: 1px solid var(--line);
}
.pp-note {
  font-size: 13px;
  color: var(--text-2);
}
.pp-action {
  font-size: 13px;
  color: var(--accent);
  padding: 5px 10px;
  border: 1px solid color-mix(in oklch, var(--accent) 35%, transparent);
  border-radius: 999px;
  transition: background var(--dur) var(--ease);
}
.pp-action:hover {
  background: var(--accent-soft);
}

.preset-label {
  font-size: 13px;
  color: var(--text-3);
  margin-right: 2px;
}
.preset {
  padding: 6px 12px;
  font-size: 13px;
  border: 1px solid var(--line);
  border-radius: 999px;
  color: var(--text-2);
  background: var(--surface);
  transition: all var(--dur) var(--ease);
}
.preset:hover {
  border-color: var(--accent);
  color: var(--accent);
}
.preset.on {
  background: var(--accent-soft);
  border-color: var(--accent);
  color: var(--accent-strong);
}

/* 参考图选择 */
.ref-pick {
  padding: 8px 14px;
  font-size: 13px;
  border: 1px dashed var(--line-strong);
  border-radius: var(--r-sm);
  color: var(--text-2);
  cursor: pointer;
  transition: all var(--dur) var(--ease);
}
.ref-pick:hover {
  border-color: var(--accent);
  color: var(--accent);
}

.err {
  margin-top: var(--sp-2);
  color: var(--danger);
  font-size: 13px;
  padding: 8px 12px;
  background: color-mix(in oklch, var(--danger) 10%, transparent);
  border-radius: var(--r-sm);
}

/* 输入框图标簇:清除(次级) + 发送(主按钮),同尺寸、同造型、留白节奏一致 */
.prompt-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
  margin-left: auto;
  padding-left: 4px;
}
.clear-icon,
.gen-icon {
  flex-shrink: 0;
  width: 34px;
  height: 34px;
  border-radius: 999px;
  border: 1px solid var(--line);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: background var(--dur) var(--ease), color var(--dur) var(--ease),
    border-color var(--dur) var(--ease), box-shadow var(--dur) var(--ease), transform 120ms var(--ease);
}
.clear-icon svg,
.gen-icon svg {
  width: 15px;
  height: 15px;
}
.clear-icon {
  color: var(--text-3);
  background: transparent;
}
.clear-icon:hover {
  color: var(--danger);
  border-color: color-mix(in oklch, var(--danger) 45%, var(--line));
  background: color-mix(in oklch, var(--danger) 8%, transparent);
}
.gen-icon {
  border-color: var(--cta);
  background: var(--cta);
  color: var(--cta-text);
  box-shadow: 0 2px 8px color-mix(in oklch, var(--cta) 30%, transparent);
}
.gen-icon:hover:not(:disabled) {
  background: var(--cta-hover);
  border-color: var(--cta-hover);
  box-shadow: 0 4px 12px color-mix(in oklch, var(--cta) 42%, transparent);
}
.clear-icon:active,
.gen-icon:active:not(:disabled) {
  transform: scale(0.94);
}
.gen-icon:disabled {
  opacity: 0.45;
  cursor: not-allowed;
  box-shadow: none;
}

.drawer-scrim {
  position: fixed;
  inset: 0;
  z-index: 50;
  background: color-mix(in oklch, #000 30%, transparent);
  /* 蒙层做轻微毛玻璃,抽屉浮在内容之上而不是糊一层黑 */
  backdrop-filter: blur(6px) saturate(130%);
  -webkit-backdrop-filter: blur(6px) saturate(130%);
  display: flex;
  justify-content: flex-end;
}
.drawer-panel {
  width: min(440px, 92vw);
  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--bg);
  border-left: 1px solid var(--line);
  box-shadow: -30px 0 70px -28px rgba(0, 0, 0, 0.28);
  color: var(--text-2);
  font-size: 14px;
}
.drawer-panel h2 {
  font-family: var(--font-display);
  font-weight: 500;
  font-size: 22px;
}
/* 头部固定,内容独立滚动 */
.d-head {
  flex-shrink: 0;
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--sp-3);
  padding: var(--sp-5) var(--sp-5) var(--sp-4);
  border-bottom: 1px solid var(--line);
}
.d-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: var(--sp-5);
}
.d-close {
  flex-shrink: 0;
  width: 30px;
  height: 30px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--line);
  border-radius: 999px;
  color: var(--text-3);
  transition: all var(--dur) var(--ease);
  cursor: pointer;
}
.d-close svg {
  width: 15px;
  height: 15px;
}
.d-close:hover {
  border-color: var(--line-strong);
  color: var(--text);
  background: var(--bg-elev);
}
.d-lede {
  margin-top: 4px;
  color: var(--text-3);
  font-size: 13px;
  line-height: 1.5;
}
.drawer-foot {
  margin-top: var(--sp-6);
}
/* 蒙层淡入淡出,面板单独横向滑入(此前是整体平移,蒙层会跟着甩) */
.drawer-enter-active,
.drawer-leave-active {
  transition: opacity var(--dur) var(--ease);
}
.drawer-enter-active .drawer-panel,
.drawer-leave-active .drawer-panel {
  transition: transform var(--dur) var(--ease);
}
.drawer-enter-from,
.drawer-leave-to {
  opacity: 0;
}
.drawer-enter-from .drawer-panel,
.drawer-leave-to .drawer-panel {
  transform: translateX(100%);
}

.spinner {
  width: 14px;
  height: 14px;
  border: 2px solid rgba(255, 255, 255, 0.35);
  border-top-color: #fff;
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

/* ===== 历史图墙(输入框下方的最近生成) ===== */
.feed-zone {
  display: flex;
  flex-direction: column;
  gap: var(--sp-5);
}
.section-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 2px;
}
.sec-title {
  font-family: var(--font-display);
  font-size: 20px;
  font-weight: 600;
  letter-spacing: -0.01em;
  color: var(--text);
}
.sec-tools {
  display: flex;
  align-items: center;
  gap: var(--sp-1);
}
.sec-more,
.sec-fold {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 13px;
  color: var(--text-3);
  padding: 6px 10px;
  border-radius: 999px;
  transition: color var(--dur) var(--ease), background var(--dur) var(--ease);
}
.sec-more:hover,
.sec-fold:hover {
  color: var(--text);
  background: var(--bg-elev);
}
.sec-more svg,
.sec-fold svg {
  width: 14px;
  height: 14px;
  transition: transform var(--dur) var(--ease);
}
.sec-more:hover svg {
  transform: translateX(2px);
}
/* 展开时箭头翻上去,收起时朝下 */
.sec-fold svg.up {
  transform: rotate(180deg);
}

/* 图墙:多列瀑布流,图片按原始比例高低错落 */
.feed-grid {
  column-gap: var(--sp-3);
  opacity: 0;
  transition: opacity var(--dur) var(--ease);
}
.fold.open .feed-grid {
  opacity: 1;
}
.feed-grid.cols-1 {
  column-count: 1;
}
.feed-grid.cols-2 {
  column-count: 2;
}
.feed-grid.cols-3 {
  column-count: 3;
}
.feed-grid.cols-4 {
  column-count: 4;
}
.tile {
  position: relative;
  display: block;
  width: 100%;
  margin: 0 0 var(--sp-3);
  padding: 0;
  border: none;
  border-radius: var(--r);
  overflow: hidden;
  background: var(--image-bg);
  break-inside: avoid;
  cursor: zoom-in;
  animation: rise 400ms var(--ease) both;
  transition: box-shadow var(--dur) var(--ease);
}
.tile:hover {
  box-shadow: var(--sh-md);
}
.tile img {
  width: 100%;
  height: 100%;
  display: block;
  object-fit: cover;
  transition: transform 600ms var(--ease);
}
.tile:hover img {
  transform: scale(1.04);
}
/* 生成中的占位块:宽高比由当前尺寸决定,与出图尺寸一致 */
.tile-skel {
  cursor: default;
  animation: none;
}
/* 角标:默认隐去,悬停/聚焦时浮出提示词与时间 */
.tile-veil {
  position: absolute;
  inset: auto 0 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 26px 12px 10px;
  text-align: left;
  color: #fff;
  background: linear-gradient(to top, rgba(0, 0, 0, 0.62), transparent);
  opacity: 0;
  transition: opacity var(--dur) var(--ease);
}
.tile:hover .tile-veil,
.tile:focus-visible .tile-veil {
  opacity: 1;
}
.tile-text {
  font-size: 12px;
  line-height: 1.5;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.tile-meta {
  font-size: 11px;
  opacity: 0.75;
  font-variant-numeric: tabular-nums;
}

.skel-shimmer {
  width: 100%;
  height: 100%;
  background: linear-gradient(
    100deg,
    transparent 30%,
    color-mix(in oklch, var(--line) 60%, transparent) 50%,
    transparent 70%
  );
  background-size: 200% 100%;
  animation: shimmer 1.4s infinite;
}
@keyframes shimmer {
  to {
    background-position: -200% 0;
  }
}
@keyframes rise {
  from {
    opacity: 0;
    transform: translateY(10px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.hint {
  margin-top: 10px;
  text-align: center;
  font-size: 12px;
  color: var(--text-3);
}

@media (max-width: 860px) {
  /* 窄屏收窄列数,保证图块仍有足够宽度 */
  .feed-grid.cols-3,
  .feed-grid.cols-4 {
    column-count: 2;
  }
}
@media (max-width: 640px) {
  .feed-grid.cols-2,
  .feed-grid.cols-3,
  .feed-grid.cols-4 {
    column-count: 1;
  }
  .feed-grid {
    column-gap: var(--sp-2);
  }
  .tile {
    margin-bottom: var(--sp-2);
  }
  .prompt-box {
    border-radius: var(--r);
  }
}
</style>