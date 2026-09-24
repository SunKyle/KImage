<script setup lang="ts">
import { ref, onMounted, watch } from 'vue'
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
const results = ref<Array<{ type: 'b64' | 'url'; data: string }>>([])
const history = ref<HistoryEntry[]>([])
const libItems = ref<PromptItem[]>([])
const presets = ref<Preset[]>([])
const refImage = ref('') // 图生图参考图 (data URL)
const usedStyles = ref<string[]>([]) // 当前已用的风格标签(收起摘要用)
const showLib = ref(false)
const showHistory = ref(false)
const showMeta = ref(false) // 尺寸/张数/参考图折叠
const previewEntry = ref<HistoryEntry | null>(null)

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
  results.value = []
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
    results.value = res
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

function download(url: string, index: number) {
  const a = document.createElement('a')
  a.href = url
  a.download = `kimage-${Date.now()}-${index}.png`
  a.click()
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
    <header class="masthead">
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
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 6v12M6 12h12M9 3.5h6M9 20.5h6" />
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
            <circle cx="12" cy="12" r="8.5" />
            <path d="M12 8v4l2.5 2" />
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
            <path d="M12 8.5a3.5 3.5 0 0 1 3.5 3.5A3.5 3.5 0 0 1 12 15.5 3.5 3.5 0 0 1 8.5 12 3.5 3.5 0 0 1 12 8.5Z" />
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
            <path d="M20.4 14.2A8 8 0 0 1 9.8 3.6a8 8 0 1 0 10.6 10.6Z" />
          </svg>
        </button>
      </nav>
    </header>

    <main class="frame">
      <!-- 生图工作台 -->
      <section class="workbench" aria-label="生图工作台">
        <header class="hero">
          <h1 class="hero-title">把想象，交给画面</h1>
          <p class="hero-sub">一句话，一段描述，剩下的交给我们。</p>
        </header>

        <div class="composer">
          <div class="prompt-box">
            <textarea
              id="prompt-input"
              v-model="prompt"
              rows="4"
              placeholder="描述你想要的画面：一只在樱花树下打盹的橘猫，清晨柔光，电影感，浅景深…（Enter 发送）"
              @keydown.enter.exact.prevent="doGenerate"
            />
            <button
              v-if="prompt.trim() && !loading"
              class="clear-icon"
              aria-label="清除输入"
              title="清除输入"
              @click="prompt = ''"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
                <path d="M7 7l10 10M17 7L7 17" />
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
              <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
                <!-- 精简发送箭头 -->
                <path d="M5 12h13" />
                <path d="M13 6l6 6-6 6" />
              </svg>
            </button>
          </div>

          <p class="hint">Enter 发送 · Shift + Enter 换行 · 配置、预设与提示词库均存于本地</p>

          <button class="adv-toggle" @click="showMeta = !showMeta" :aria-expanded="showMeta">
            <span v-if="showMeta">收起参数</span>
            <span v-else class="adv-summary">
              {{ size }} · {{ n }}张<template v-if="usedStyles.length"> · {{ usedStyles.join(' / ') }}</template><template v-if="refImage"> · 参考图</template>
            </span>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" :style="{ transform: showMeta ? 'rotate(180deg)' : 'none' }">
              <path d="M6 9l6 6 6-6" />
            </svg>
          </button>

          <Transition name="meta">
            <div class="meta-group" v-show="showMeta">
              <!-- 参数预设 -->
              <div class="preset-row" role="group" aria-label="参数预设">
                <span class="preset-label">尺寸</span>
                <button
                  v-for="pr in presets"
                  :key="pr.id"
                  class="preset"
                  :class="{ on: size === pr.size && n === pr.n }"
                  @click="applyPreset(pr)"
                >
                  {{ pr.name }}
                </button>
                <label class="ctrl ctrl-inline">
                  <span>自定义</span>
                  <select v-model="size">
                    <option v-for="s in sizeOptions" :key="s" :value="s">{{ s }}</option>
                  </select>
                </label>
                <label class="ctrl ctrl-inline">
                  <span>张数</span>
                  <input v-model.number="n" type="number" min="1" max="4" />
                </label>
              </div>

              <!-- 图生图 -->
              <div class="ref-row">
                <template v-if="!refImage">
                  <label class="ref-pick" for="ref-file">＋ 参考图</label>
                  <input id="ref-file" type="file" accept="image/*" hidden @change="onPickRef" />
                </template>
                <template v-else>
                  <span class="ref-held">
                    <img class="ref-thumb" :src="refImage" alt="参考图" />
                    已用参考图
                  </span>
                  <button class="text-btn" @click="clearRef">移除</button>
                </template>
              </div>

              <!-- 风格快捷词 -->
              <div class="styles" role="group" aria-label="风格快捷词">
                <span class="styles-label">风格</span>
                <button
                  v-for="s in STYLE_WORDS"
                  :key="s.label"
                  class="style-chip"
                  :class="{ on: usedStyles.includes(s.label) }"
                  :title="usedStyles.includes(s.label) ? '再次点击撤销' : '追加到提示词'"
                  @click="appendStyle(s.word)"
                >
                  {{ s.label }}
                </button>
              </div>
            </div>
          </Transition>

          <p v-if="error" class="err" role="alert">{{ error }}</p>
        </div>

        <!-- 结果:横滑画廊 -->
        <div v-if="loading" class="skeleton" aria-hidden="true">
          <div v-for="k in (n > 0 ? n : 1)" :key="k" class="skel-slot">
            <div class="skel-shimmer"></div>
          </div>
        </div>

        <div v-else-if="results.length" class="gallery" aria-live="polite">
          <figure v-for="(r, i) in results" :key="i" class="shot">
            <img :src="renderData(r)" :alt="`生成结果 ${i + 1}`" />
            <figcaption class="shot-foot">
              <span class="shot-meta">{{ size }} · {{ i + 1 }}/{{ results.length }}</span>
              <button class="text-btn" @click="download(renderData(r), i)">下载</button>
            </figcaption>
          </figure>
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
  padding: var(--sp-5) 0;
  position: sticky;
  top: 0;
  z-index: 10;
  backdrop-filter: blur(10px);
  background: color-mix(in oklch, var(--bg) 82%, transparent);
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
  font-size: 20px;
  font-weight: 500;
  letter-spacing: 0.02em;
}
.mast-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}
.icob {
  position: relative;
  width: 38px;
  height: 38px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--line);
  border-radius: var(--r-sm);
  color: var(--text-2);
  transition: border-color var(--dur) var(--ease), color var(--dur) var(--ease), background var(--dur) var(--ease);
}
.icob:hover {
  border-color: var(--line-strong);
  color: var(--text);
  background: var(--bg-elev);
}
.icob.active {
  border-color: var(--accent);
  color: var(--accent);
}
.icob svg {
  width: 19px;
  height: 19px;
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
  color: oklch(0.985 0.01 45);
}
.icon-btn-warn {
  border-color: color-mix(in oklch, var(--danger) 45%, var(--line));
  color: var(--danger);
}

.frame {
  margin-top: var(--sp-4);
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
  margin: var(--sp-5) 0;
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
  width: 28px;
  height: 28px;
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
  width: 28px;
  height: 28px;
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
  background: var(--bg);
  transition: border-color var(--dur) var(--ease), background var(--dur) var(--ease);
}
.cfg-row.on {
  border-color: var(--accent);
  background: var(--accent-soft);
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
  background: var(--accent-soft);
  border: 1px solid var(--accent);
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
  border-color: var(--accent);
  color: var(--accent);
  background: var(--bg-elev);
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
.ctrl select,
.ctrl input[type='number'],
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
  box-shadow: 0 0 0 3px var(--accent-soft);
}
.composer textarea:focus {
  box-shadow: 0 0 0 3px var(--accent-soft), 0 2px 10px color-mix(in oklch, var(--accent) 10%, transparent);
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
  color: oklch(0.985 0.01 45);
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
  text-align: center;
  padding: var(--sp-6) var(--sp-4) var(--sp-1);
}
.hero-title {
  font-family: var(--font-display);
  font-weight: 500;
  font-size: clamp(28px, 4.5vw, 40px);
  letter-spacing: -0.02em;
  line-height: 1.2;
}
.hero-sub {
  margin-top: var(--sp-2);
  color: var(--text-2);
  font-size: 14px;
}
.prompt-box {
  position: relative;
}
.composer textarea {
  resize: vertical;
  line-height: 1.6;
  font-size: 15px;
  min-height: 112px;
  padding-right: 44px;
}
.text-btn {
  font-size: 13px;
  color: var(--accent);
  padding: 4px 8px;
  border-radius: var(--r-sm);
  transition: background var(--dur) var(--ease);
}
.text-btn:hover {
  background: var(--accent-soft);
}

/* 风格快捷词 */
.styles {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--sp-2);
  padding-top: var(--sp-3);
  margin-top: var(--sp-3);
  border-top: 1px solid var(--line);
}
.styles-label {
  font-size: 13px;
  color: var(--text-3);
  margin-right: 6px;
}
.style-chip {
  padding: 5px 12px;
  font-size: 13px;
  border: 1px solid var(--line);
  border-radius: 999px;
  color: var(--text-2);
  transition: all var(--dur) var(--ease);
}
.style-chip:hover {
  border-color: var(--accent);
  color: var(--accent);
}
.style-chip.on {
  border-color: var(--accent);
  color: var(--accent);
  background: var(--accent-soft);
}

.adv-toggle {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-top: var(--sp-4);
  padding: 6px 12px;
  font-size: 13px;
  color: var(--text-3);
  border: 1px solid var(--line);
  border-radius: 999px;
  transition: all var(--dur) var(--ease);
}
.adv-summary {
  color: var(--text-2);
  font-variant-numeric: tabular-nums;
}
.adv-toggle:hover {
  color: var(--text);
  border-color: var(--line-strong);
}
.adv-toggle svg {
  width: 14px;
  height: 14px;
  transition: transform var(--dur) var(--ease);
}

/* 参数 + 参考图组合区 */
.meta-group {
  margin-top: var(--sp-4);
  padding-top: var(--sp-4);
  border-top: 1px solid var(--line);
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
}
.preset-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--sp-2);
}

/* 参数区折叠过渡 */
.meta-enter-active,
.meta-leave-active {
  transition: opacity var(--dur) var(--ease), transform var(--dur) var(--ease);
}
.meta-enter-from,
.meta-leave-to {
  opacity: 0;
  transform: translateY(-6px);
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
.ctrl-inline {
  display: inline-flex;
  flex-direction: row;
  align-items: center;
  gap: 8px;
  margin-left: 6px;
}
.ctrl-inline span {
  font-size: 12px;
  color: var(--text-3);
}
.ctrl select,
.ctrl input[type='number'] {
  width: auto;
  padding: 7px 10px;
  font-size: 13px;
}
.ctrl input[type='number'] {
  width: 60px;
}

/* 图生图 */
.ref-row {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
}
.ref-pick {
  padding: 7px 14px;
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
.ref-held {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: var(--text-2);
}
.ref-thumb {
  width: 44px;
  height: 44px;
  object-fit: cover;
  border-radius: var(--r-sm);
  border: 1px solid var(--line);
}

.err {
  margin-top: var(--sp-2);
  color: var(--danger);
  font-size: 13px;
  padding: 8px 12px;
  background: color-mix(in oklch, var(--danger) 10%, transparent);
  border-radius: var(--r-sm);
}

.gen-icon {
  position: absolute;
  right: 10px;
  bottom: 12px;
  width: 34px;
  height: 34px;
  border-radius: 999px;
  background: var(--accent);
  color: oklch(0.985 0.01 45);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  box-shadow: 0 2px 8px color-mix(in oklch, var(--accent) 32%, transparent);
  transition: background var(--dur) var(--ease), transform 120ms var(--ease), box-shadow var(--dur) var(--ease);
}
.gen-icon svg {
  width: 16px;
  height: 16px;
}
.gen-icon:hover:not(:disabled) {
  background: var(--accent-strong);
  box-shadow: 0 4px 12px color-mix(in oklch, var(--accent) 42%, transparent);
}
.gen-icon:active:not(:disabled) {
  transform: scale(0.94);
  box-shadow: 0 1px 4px color-mix(in oklch, var(--accent) 30%, transparent);
}
.gen-icon:disabled {
  opacity: 0.45;
  cursor: not-allowed;
  box-shadow: none;
}
.clear-icon {
  position: absolute;
  top: 10px;
  right: 10px;
  width: 28px;
  height: 28px;
  border-radius: 999px;
  border: 1px solid var(--line);
  color: var(--text-3);
  background: transparent;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: color var(--dur) var(--ease), border-color var(--dur) var(--ease), background var(--dur) var(--ease);
}
.clear-icon svg {
  width: 14px;
  height: 14px;
}
.clear-icon:hover {
  color: var(--danger);
  border-color: color-mix(in oklch, var(--danger) 45%, var(--line));
  background: color-mix(in oklch, var(--danger) 8%, transparent);
}

.drawer-scrim {
  position: fixed;
  inset: 0;
  z-index: 50;
  background: color-mix(in oklch, #000 30%, transparent);
  display: flex;
  justify-content: flex-end;
}
.drawer-panel {
  width: min(440px, 92vw);
  height: 100%;
  background: var(--bg);
  border-left: 1px solid var(--line);
  box-shadow: var(--sh-md);
  padding: var(--sp-5);
  overflow-y: auto;
  color: var(--text-2);
  font-size: 14px;
}
.drawer-panel h2 {
  font-family: var(--font-display);
  font-weight: 500;
  font-size: 22px;
}
.d-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--sp-3);
}
.d-close {
  flex-shrink: 0;
  width: 28px;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--line);
  border-radius: var(--r-sm);
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
.drawer-enter-active,
.drawer-leave-active {
  transition: transform var(--dur) var(--ease);
}
.drawer-enter-from,
.drawer-leave-to {
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

/* 骨架屏 */
.skeleton {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: var(--sp-5);
}
.skel-slot {
  aspect-ratio: 1;
  border-radius: var(--r-lg);
  overflow: hidden;
  background: var(--bg-elev);
  border: 1px solid var(--line);
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

/* 结果横滑画廊 */
.gallery {
  display: flex;
  gap: var(--sp-4);
  overflow-x: auto;
  padding-bottom: var(--sp-3);
  scroll-snap-type: x mandatory;
}
.shot {
  flex: 0 0 min(340px, 80vw);
  scroll-snap-align: start;
  background: var(--bg-elev);
  border: 1px solid var(--line);
  border-radius: var(--r-lg);
  overflow: hidden;
  box-shadow: var(--sh-sm);
  animation: rise 400ms var(--ease) both;
}
.shot img {
  width: 100%;
  display: block;
  aspect-ratio: 1;
  object-fit: cover;
}
.shot-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 14px;
}
.shot-meta {
  font-size: 12px;
  color: var(--text-3);
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

@media (max-width: 640px) {
  .skeleton,
  .gallery {
    grid-template-columns: 1fr;
  }
  .gen {
    margin-left: 0;
    width: 100%;
    margin-top: 4px;
  }
}
</style>