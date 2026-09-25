<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, watch } from 'vue'
import PromptLibrary from './components/PromptLibrary.vue'
import ImagePreview from './components/ImagePreview.vue'
import HistoryPage from './components/HistoryPage.vue'
import RubberSegment from './components/RubberSegment.vue'
import LatticeLoader from './components/LatticeLoader.vue'
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
  PROVIDERS,
  getProvider,
  inferVendor,
  allowedSizes,
  optionLabel,
  imageSrc,
  makeThumb,
  backfillThumbs,
  QUALITY_OPTIONS,
  BACKGROUND_OPTIONS
} from './api'
import { blobToDataURL } from './lib/idb'
import type { Cap, Provider } from './api'
import type { ApiConfig, FavoritePayload, HistoryEntry, PromptItem, ResultItem, ReuseParams } from './types'

// —— 状态 ——
const prompt = ref('')
const size = ref('1024x1024')
const n = ref(1)
// 'auto' 表示交给上游自己决定,请求时不带这个参数
const quality = ref('auto')
const background = ref('auto')
const loading = ref(false)
const error = ref('')
// 错误区默认收成一行:上游原文动辄上百字,整段铺开会把输入区顶得很高
const errorOpen = ref(false)
// 只有真正发起过生图才谈得上"重试",校验类提示不给这个按钮
const canRetry = ref(false)
// 统一的错误出口:顺带把折叠状态收回、标记可否重试
function fail(msg: string, retryable = false) {
  error.value = msg
  canRetry.value = retryable
  errorOpen.value = false
}
// 校验类提示都很短,不值得给「详情」;上游原文通常远长于此
const errorLong = computed(() => error.value.length > 90)
// 存储清理的事后告知。它不是错误,所以单独一条通道,中性配色
const notice = ref('')
// 发起生成时锁定的参数快照:生成中途改尺寸/张数/提示词,不会影响已发出的这一批
const running = ref({ prompt: '', size: '1024x1024', n: 1 })
const history = ref<HistoryEntry[]>([])
const libItems = ref<PromptItem[]>([])
const refImage = ref('') // 图生图参考图 (data URL)
// 底下的页面:首页 / 提示词库 / 历史记录三个平级视图,同时只挂载一个。
// 接口设置仍是浮层,它开在哪个页面之上不影响这里
const page = ref<'home' | 'lib' | 'history'>('home')
const previewEntry = ref<HistoryEntry | null>(null)
// 参数 icon 展开的面板:同一时间只开一个,再次点击收起
type PanelKey = '' | 'ref' | 'size' | 'n' | 'quality' | 'bg' | 'config'
const openPanel = ref<PanelKey>('')
// 收起动画播放期间保留上一次的面板内容,避免"内容先消失、容器再合拢"的两段跳变
const shownPanel = ref<PanelKey>('')
watch(openPanel, (v) => {
  if (v) shownPanel.value = v
})
function togglePanel(p: Exclude<PanelKey, ''>) {
  const same = openPanel.value === p
  openPanel.value = same ? '' : p
  // 收起后把焦点还给输入框:点这个图标通常就是为了改个参数接着打字,
  // 不该再要求用户手动点回输入区。切到另一个面板时不抢,用户还在选。
  if (same) focusPrompt()
}
// 面板展开后点别处收起:只有参数行和面板自身算"内部"
const paramBarEl = ref<HTMLElement | null>(null)
const panelEl = ref<HTMLElement | null>(null)
function onDocPointerDown(e: PointerEvent) {
  if (!openPanel.value) return
  const t = e.target as Node | null
  if (!t) return
  if (paramBarEl.value?.contains(t) || panelEl.value?.contains(t)) return
  // 这里不回焦:用户是主动点到别处去的,把焦点拽回来反而打断了那一下操作
  openPanel.value = ''
}
// Esc 收起面板,同样把焦点还给输入框 —— 不给键盘留一条路的话,这条回焦只有鼠标能用
function onDocKeyDown(e: KeyboardEvent) {
  if (e.key !== 'Escape' || !openPanel.value) return
  openPanel.value = ''
  focusPrompt()
}
onMounted(() => {
  document.addEventListener('pointerdown', onDocPointerDown)
  window.addEventListener('keydown', onDocKeyDown)
  window.addEventListener('resize', fitPrompt)
})
onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onDocPointerDown)
  window.removeEventListener('keydown', onDocKeyDown)
  window.removeEventListener('resize', fitPrompt)
})
// —— 输入区:随内容长高 + 焦点归位 ——
const promptEl = ref<HTMLTextAreaElement | null>(null)
// 最多长到 6 行,再多转内部滚动。不封顶的话,一段长提示词会把参数行和下面的图墙顶出视口
const INPUT_MAX_ROWS = 6
// 与 .prompt-box textarea 的 font-size 16px × line-height 1.6 对应,改那两处要一起改
const INPUT_LINE = 16 * 1.6
// 该 textarea 的上下内边距(6 + 8):scrollHeight 含内边距,算上限时要加回来
const INPUT_PAD = 14

/* 高度先置 auto 再读 scrollHeight,否则 scrollHeight 只会返回不小于当前高度的值,
   框能长不能缩。全局是 border-box,所以这个值可以直接当 height 用。 */
function fitPrompt() {
  const el = promptEl.value
  if (!el) return
  el.style.height = 'auto'
  const max = INPUT_MAX_ROWS * INPUT_LINE + INPUT_PAD
  el.style.height = `${Math.min(el.scrollHeight, max)}px`
  el.style.overflowY = el.scrollHeight > max ? 'auto' : 'hidden'
}
// flush: 'post' —— 要等 v-model 写进 DOM 之后再量,否则量到的是上一个字的高度
watch(prompt, fitPrompt, { flush: 'post' })
// 工作台与提示词库是两个视图,切回来时输入框是重新挂载的,
// 得按当前草稿再量一次高度,否则多行的提示词会被 CSS 的一行兜底高度切掉
watch(promptEl, () => fitPrompt(), { flush: 'post' })

// preventScroll:焦点回来时不要把页面拽上去,用户可能正在看下面的图墙
function focusPrompt() {
  promptEl.value?.focus({ preventScroll: true })
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
    item: ResultItem
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
  Math.min(4, Math.max(1, feedItems.value.length + (loading.value ? Math.max(1, running.value.n) : 0)))
)

// 当前生效的厂商:配置里没写就按域名猜(兼容加字段之前存的老配置)
const provider = computed<Provider>(() => {
  const cfg = config.value
  return getProvider(cfg.vendor || inferVendor(cfg.baseUrl))
})
// 尺寸候选随厂商(以及 OpenAI 的模型代次)变化
const sizeOptions = computed(() => {
  const list = allowedSizes(provider.value.id, config.value.model)
  return Array.isArray(list) ? list : FREE_SIZES
})
// 尺寸是否由接口自行决定:固定候选的厂商不开放手填,列表已经是全部合法值
const sizeFree = computed(() => allowedSizes(provider.value.id, config.value.model) === 'free')

// 张数上限:多数生图接口一次最多 10 张
const N_MAX = 10

// 'auto' 是给上游的值,界面上叫"自动"
function sizeLabel(s: string) {
  return s === 'auto' ? '自动' : s
}

// 配置行上展示的厂商名(老配置按域名回填后再查表)
function vendorLabel(c: ApiConfig) {
  return getProvider(c.vendor || inferVendor(c.baseUrl)).label
}

// 参数面板底部说明:支持就明说,不确定就提醒可以改回「自动」兜底
function capHint(c: Cap) {
  if (c === 'yes') return `当前厂商(${provider.value.label})支持。`
  if (c === 'no') return `当前厂商(${provider.value.label})不支持,已隐藏。`
  return '自定义/中转接口是否支持不确定,若上游报错请改回「自动」。'
}

// 厂商不限尺寸时给的一组常用值
const FREE_SIZES = ['512x512', '1024x1024', '1024x1792', '1792x1024', '2560x1440', 'auto']

// 按厂商能力决定携带哪些扩展参数:已知不支持的一律不发
function extraParams(): Record<string, string> {
  const caps = provider.value
  const out: Record<string, string> = {}
  if (caps.quality !== 'no' && quality.value !== 'auto') out.quality = quality.value
  if (caps.background !== 'no' && background.value !== 'auto') out.background = background.value
  return out
}

// 选厂商时先讲清它能吃什么:界面上的参数门控就是照着这份声明来的
const capabilityNote = computed(() => {
  const p = provider.value
  const t = (c: Cap) => (c === 'yes' ? '支持' : c === 'no' ? '不支持' : '依接口而定')
  return `画质 ${t(p.quality)} · 背景 ${t(p.background)} · 图生图走 ${
    p.edit === 'edits' ? '/images/edits' : '/images/generations'
  }`
})

// 自定义张数:允许手输,失焦/回车时收敛到 1..N_MAX 的整数并回写输入框
function clampN(e: Event) {
  const el = e.target as HTMLInputElement
  const v = Math.round(Number(el.value))
  n.value = Number.isFinite(v) && v >= 1 ? Math.min(N_MAX, v) : n.value
  el.value = String(n.value)
}

// 把手填的尺寸归一成 1024x1536:容忍 × * 大写与空格;认不出来返回 null
function normalizeSize(raw: string): string | null {
  if (/^auto$/i.test(raw)) return 'auto'
  const m = raw.replace(/[×✕*]/g, 'x').replace(/\s+/g, '').match(/^(\d{1,5})x(\d{1,5})$/i)
  if (!m) return null
  const w = Number(m[1])
  const h = Number(m[2])
  return w > 0 && h > 0 ? `${w}x${h}` : null
}

// 自定义尺寸:失焦/回车时归一化;认不出来就还原成当前生效值,不做隐式猜测
function commitSize(e: Event) {
  const el = e.target as HTMLInputElement
  const norm = normalizeSize(el.value.trim())
  if (norm) size.value = norm
  // 两种情况都回写:成功显示归一化结果,失败还原当前值(值没变时 Vue 不会重渲染)
  el.value = size.value
}

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

// —— 顶部导航(分段控件) ——
// 四个条目代表四种视图状态,而不是四个动作:滑块停在哪儿就是当前打开了哪个面板。
// 页面状态由 page 持有,接口设置是浮层另算,navView 只是这两者的投影,避免两份状态互相打架。
// 必须放在 page / showSettings 声明之后:getter 里引用了它们
const navItems = [
  { value: 'home', label: '首页' },
  { value: 'lib', label: '提示词库' },
  { value: 'history', label: '历史' },
  { value: 'settings', label: '接口设置' }
]
const navView = computed({
  get: () => (showSettings.value ? 'settings' : page.value),
  set: (v: string) => {
    showSettings.value = v === 'settings'
    // 接口设置是浮层,开在原来那页之上,关掉要回到原页,所以这时不动 page
    if (v === 'home' || v === 'lib' || v === 'history') page.value = v
  }
})
// 切视图后回到顶部:否则在首页滚到一半再切过去,新页面会停在半空
watch(navView, () => window.scrollTo({ top: 0 }))
// 全部已保存的接口配置
const configs = ref<ApiConfig[]>([])
// 当前正在编辑的配置(表单直接绑定)
const config = ref<ApiConfig>({ id: '', name: '', baseUrl: '', apiKey: '', model: '' })
const activeId = ref('')
// 设置面板视图:'list' = 已保存接口列表,'form' = 新增/编辑接口表单(独立一屏)
const cfgView = ref<'list' | 'form'>('list')

// 换厂商/换模型后,原来的尺寸可能已不在候选里,自动回退到第一个,免得发出上游不认的值
// (必须放在 config 声明之后,watch 会立刻求值一次,提前会撞上 TDZ)
watch(sizeOptions, (list) => {
  if (list.length && !list.includes(size.value)) size.value = list[0]
})

onMounted(() => {
  configs.value = loadConfigs()
  activeId.value = loadActiveId()
  // 选中激活配置;无激活则取第一条
  const active =
    configs.value.find((c) => c.id === activeId.value) ||
    configs.value[0]
  if (active) config.value = { ...active }
  libItems.value = loadPrompts()
  loadHistory().then((h) => {
    history.value = h
    // 老记录没有列表缩略图,后台慢慢补;不 await,免得拖慢首屏
    backfillThumbs(h)
  })
})

// 选厂商:已知厂商顺带填入它的默认地址与模型;自定义只记身份,不动用户已填的内容
function applyProvider(p: Provider) {
  config.value.vendor = p.id
  if (p.baseUrl) config.value.baseUrl = p.baseUrl
  if (p.model) config.value.model = p.model
}

// 新建一份空白配置(进入独立的新增接口表单页)
function newConfig() {
  config.value = { id: '', name: '', baseUrl: '', apiKey: '', model: '', vendor: 'custom' }
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
    config.value = { id: '', name: '', baseUrl: '', apiKey: '', model: '', vendor: 'custom' }
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
      config.value = { id: '', name: '', baseUrl: '', apiKey: '', model: '', vendor: 'custom' }
      activeId.value = ''
      saveActiveId('')
    }
  }
}

function configured() {
  return !!config.value.baseUrl
}

// 套用尺寸:厂商声明 free 就照单全收,给了固定列表的必须命中,否则宁可不改
function applySize(s?: string) {
  if (!s) return
  const list = allowedSizes(provider.value.id, config.value.model)
  if (list === 'free' || list.includes(s)) size.value = s
}

// 保存提示词库。配额不足时 savePrompts 会退化成不带缩略图的版本,
// 这时必须说一声 —— 否则封面会莫名消失,而用户以为存好了
function persistLib() {
  if (!savePrompts(libItems.value)) {
    notice.value = '本地存储空间不足，提示词已存下，但封面缩略图未能保存'
  }
}
function useLibItem(item: PromptItem) {
  prompt.value = item.prompt
  applySize(item.size)
  // 画质/背景同样过一遍能力表:库里存的可能是别家厂商支持的档位
  if (item.quality && provider.value.quality !== 'no') quality.value = item.quality
  if (item.background && provider.value.background !== 'no') background.value = item.background
  // 关掉库页就等于切回首页;回顶部由 navView 的 watch 统一负责,这里不必再来一次
  page.value = 'home'
}
function removeLibItem(id: string) {
  libItems.value = libItems.value.filter((i) => i.id !== id)
  persistLib()
}
function addLibItem(item: PromptItem) {
  libItems.value = [item, ...libItems.value]
  persistLib()
}
function importLibItems(items: PromptItem[]) {
  // 内容是外部文件,逐条规整:缺 prompt 的记录会让列表渲染崩掉,
  // 超大的 thumb 会顶爆 localStorage 配额,两者都必须在入口拦掉
  const clean: PromptItem[] = items
    .filter((i) => i && typeof i.prompt === 'string' && i.prompt.trim())
    .map((i) => ({
      id: i.id || uid(),
      prompt: i.prompt,
      category: i.category || '未分类',
      size: i.size,
      quality: i.quality,
      background: i.background,
      thumb: typeof i.thumb === 'string' && i.thumb.startsWith('data:image/') ? i.thumb : undefined,
      createdAt: typeof i.createdAt === 'number' ? i.createdAt : Date.now()
    }))
  libItems.value = [...clean, ...libItems.value]
  persistLib()
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
// 当前这一批的请求句柄,用于中途终止
const controller = ref<AbortController | null>(null)

/* 中文输入法里用回车「上屏」也会触发 keydown.enter(keyCode 229,isComposing 为真)。
   这里必须提前返回、且不能 preventDefault —— 一 prevent 就把输入法确认候选词的
   动作吃掉了,而且会把还没上屏的拼音当成提示词发出去。 */
function onEnter(e: KeyboardEvent) {
  if (e.isComposing || e.keyCode === 229) return
  e.preventDefault()
  doGenerate()
}

async function doGenerate() {
  if (loading.value) return
  if (!prompt.value.trim()) {
    fail('请先输入提示词')
    return
  }
  if (!configured()) {
    fail('请先在“接口设置”中配置接口地址')
    showSettings.value = true
    return
  }

  // 发起前锁定这一批的参数,后面一律读快照,避免中途改参数串味
  running.value = { prompt: prompt.value, size: size.value, n: n.value }
  // 扩展参数与参考图同样要快照:它们在 await 期间可能被改动
  const extras = extraParams()
  const refSrc = refImage.value
  const startedAt = Date.now()
  controller.value = new AbortController()

  loading.value = true
  error.value = ''
  notice.value = ''
  canRetry.value = false
  try {
    const res = await generate(
      {
        prompt: running.value.prompt,
        size: running.value.size,
        n: running.value.n,
        ...(refSrc ? { image: refSrc } : {}),
        // 由厂商能力表决定带哪些扩展参数:auto 与已知不支持的都不发
        ...extras
      },
      config.value,
      controller.value.signal
    )
    const record: HistoryEntry = {
      id: Date.now() + Math.random().toString(16).slice(2),
      prompt: running.value.prompt,
      size: running.value.size,
      model: config.value.model || undefined,
      // 只记真正发出去的扩展参数,免得预览里展示出当时并没生效的档位
      quality: extras.quality,
      background: extras.background,
      hasRef: !!refSrc,
      elapsedMs: Date.now() - startedAt,
      createdAt: Date.now(),
      results: res
    }
    // 缩略图要在入列表和落盘之前补上:入列表后拿到的是响应式代理,
    // 在代理上改动不会回写到这里的原始对象,而 idb 又只接受原始对象
    record.thumb = await makeThumb(res[0])
    history.value = [record, ...history.value]
    const pruned = await addHistoryRecord(record)
    if (pruned) {
      // 磁盘上已经删掉了,内存里也要同步,否则界面还留着早已不存在的记录
      history.value = history.value.slice(0, Math.max(0, history.value.length - pruned.removed))
      const pct = Math.round(pruned.usageRatio * 100)
      notice.value = pct
        ? `本地存储已用约 ${pct}%，为腾出空间清理了最旧的 ${pruned.removed} 条历史`
        : `为控制本地占用，清理了最旧的 ${pruned.removed} 条历史`
    }
  } catch (e: any) {
    // 主动终止不是失败,不报错也不入历史
    if (e?.name === 'AbortError') return
    // 走到这里说明请求真的发出去了,可以重试
    fail(e?.message || '生成失败', true)
  } finally {
    loading.value = false
    controller.value = null
  }
}

// 终止当前批次
function stopGenerate() {
  controller.value?.abort()
}

// 重试:按当前输入再发一次(用户可能已经改过提示词或参数,以界面上的为准)
function retry() {
  if (loading.value) return
  doGenerate()
}

// —— 工具 ——
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
// 复现一条记录:提示词连同当时的参数一起带回,但只套用当前厂商认得的项
function usePreviewPrompt(p: ReuseParams) {
  prompt.value = p.prompt
  applySize(p.size)
  if (p.n) n.value = Math.min(N_MAX, Math.max(1, p.n))
  // 已知不支持的厂商直接跳过,免得把界面上根本不存在的档位偷偷塞进去
  if (p.quality && provider.value.quality !== 'no') quality.value = p.quality
  if (p.background && provider.value.background !== 'no') background.value = p.background
  // 从历史页取用要先回到首页,否则参数填进去了却看不见输入框
  page.value = 'home'
  // 已经在首页时上面这次赋值不会触发滚动(navView 没变),所以这里补一次
  window.scrollTo({ top: 0, behavior: 'smooth' })
}

/**
 * 生成封面缩略图。compressImage 在最长边已经小于目标时会把输入原样返回,
 * 那种情况可能是个 blob: URL(刷新即失效),所以只收 data: 开头的;
 * 同时限长,避免把原始大图当成封面塞进 localStorage
 */
async function thumbOf(src: string): Promise<string | undefined> {
  if (!src) return undefined
  const out = await compressImage(src, 160)
  return /^data:image\//.test(out) && out.length < 60000 ? out : undefined
}

// 预览菜单:收藏当前预览的提示词到库(连带参数与一张封面缩略图)
async function favoriteFromPreview(p: FavoritePayload) {
  if (!p.prompt.trim()) return
  const item: PromptItem = {
    id: uid(),
    prompt: p.prompt,
    category: '未分类',
    size: p.size,
    quality: p.quality,
    background: p.background,
    thumb: await thumbOf(p.src),
    createdAt: Date.now()
  }
  libItems.value = [item, ...libItems.value]
  persistLib()
  closePreview()
  page.value = 'lib'
}

// 预览菜单:把当前图用作参考图。接口只认 data URL,Blob 要现转一趟
async function setAsReference(item: ResultItem) {
  const dataUrl = typeof item.data === 'string' ? item.data : await blobToDataURL(item.data)
  if (!dataUrl.startsWith('data:')) {
    fail('仅本地图片可作为参考图')
    return
  }
  refImage.value = dataUrl
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
// 历史页:不进预览,直接删掉某条记录
async function removeHistoryEntry(entry: HistoryEntry) {
  history.value = history.value.filter((h) => h.id !== entry.id)
  await removeHistoryRecord(entry.id)
}

</script>

<template>
  <div class="shell">
    <!-- 品牌 + 视图切换 + 全局操作 -->
    <header class="masthead" :class="{ scrolled }">
      <div class="wordmark">
        <span class="title">
          KImage
          <span class="title-script">Gallery</span>
        </span>
      </div>

      <!-- 居中的视图切换:滑块位置即当前打开的面板 -->
      <RubberSegment
        v-model="navView"
        class="nav-seg"
        :items="navItems"
        :radius="999"
        aria-label="主导航"
      >
        <template #home>
          <svg class="seg-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M4 10.5 12 4l8 6.5V20a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z" />
            <path d="M9.5 21v-6h5v6" />
          </svg>
        </template>
        <template #lib>
          <!-- 摊开的书:表达"收藏成册的提示词库" -->
          <svg class="seg-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 7v14" />
            <path d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z" />
          </svg>
        </template>
        <template #history>
          <svg class="seg-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="9" />
            <path d="M12 7.4V12l2.8 1.9" />
          </svg>
        </template>
        <template #settings>
          <svg class="seg-ico" :class="{ 'is-warn': !configured() }" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="3.4" />
            <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.03 1.56V21a2 2 0 1 1-4 0v-.09A1.7 1.7 0 0 0 8.96 19.4a1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.56-1.03H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.6 8.96 1.7 1.7 0 0 0 4.26 7.09l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 8.96 4.6 1.7 1.7 0 0 0 9.99 3.04V3a2 2 0 1 1 4 0v.09A1.7 1.7 0 0 0 15 4.6 1.7 1.7 0 0 0 16.91 4.26l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.4 8.96 1.7 1.7 0 0 0 20.96 9.99H21a2 2 0 1 1 0 4h-.09A1.7 1.7 0 0 0 19.4 15Z" />
          </svg>
        </template>
      </RubberSegment>

      <nav class="mast-actions">
        <button
          class="icob tip-below"
          @click="toggleTheme"
          :data-tip="theme === 'dark' ? '切换浅色' : '切换深色'"
          :aria-label="theme === 'dark' ? '切换浅色' : '切换深色'"
        >
          <svg v-if="theme === 'dark'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="4" />
            <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
          </svg>
          <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />
          </svg>
        </button>
      </nav>
    </header>

    <!-- 视图切换:首页工作台与提示词库是两个平级页面,同时只挂载一个 -->
    <main class="frame">
      <!-- 生图工作台 -->
      <section v-if="page === 'home'" class="workbench" aria-label="生图工作台">
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
                ref="promptEl"
                v-model="prompt"
                rows="1"
                placeholder="描述你想要的画面：一只在樱花树下打盹的橘猫，清晨柔光，电影感，浅景深…"
                @keydown.enter.exact="onEnter"
              />

            </div>

            <!-- 二、参数 icon 行(横线下方),点击 icon 展开对应选项 -->
            <div class="param-bar" ref="paramBarEl" role="group" aria-label="生成参数">
              <button
                class="param-btn has-val"
                :class="{ on: openPanel === 'config', filled: !!configured() }"
                :data-tip="`配置 · ${activeConfigName}`"
                aria-label="配置"
                @click="togglePanel('config')"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M4 7h8M17 7h3M4 17h3M12 17h8" />
                  <circle cx="14.5" cy="7" r="2.3" />
                  <circle cx="9.5" cy="17" r="2.3" />
                </svg>
                <b class="param-val param-val-name">{{ activeConfigName }}</b>
              </button>
              <button
                class="param-btn has-val"
                :class="{ on: openPanel === 'size' }"
                :data-tip="`尺寸 · ${sizeLabel(size)}`"
                aria-label="尺寸"
                @click="togglePanel('size')"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <!-- 外框 + 对角缩放箭头:表达"尺寸/比例" -->
                  <rect x="3.5" y="3.5" width="17" height="17" rx="3" />
                  <path d="M9.5 14.5 14.5 9.5M9.5 11.6v2.9h2.9M14.5 12.4V9.5h-2.9" />
                </svg>
                <b class="param-val">{{ sizeLabel(size) }}</b>
              </button>
              <button
                class="param-btn has-val"
                :class="{ on: openPanel === 'n' }"
                :data-tip="`张数 · ${n} 张`"
                aria-label="张数"
                @click="togglePanel('n')"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <rect x="3.5" y="3.5" width="7" height="7" rx="1.6" />
                  <rect x="13.5" y="3.5" width="7" height="7" rx="1.6" />
                  <rect x="3.5" y="13.5" width="7" height="7" rx="1.6" />
                  <rect x="13.5" y="13.5" width="7" height="7" rx="1.6" />
                </svg>
                <b class="param-val">{{ n }} 张</b>
              </button>
              <!-- 已知不认画质的厂商直接收起来,免得选了却被上游 400 -->
              <button
                v-if="provider.quality !== 'no'"
                class="param-btn has-val"
                :class="{ on: openPanel === 'quality', filled: quality !== 'auto' }"
                :data-tip="`画质 · ${optionLabel(QUALITY_OPTIONS, quality)}`"
                aria-label="画质"
                @click="togglePanel('quality')"
              >
                <!-- 三根递升的柱子:表达档位高低 -->
                <svg viewBox="0 0 24 24" fill="currentColor">
                  <rect x="4" y="13.5" width="3.2" height="6.5" rx="1.6" />
                  <rect x="10.4" y="9" width="3.2" height="11" rx="1.6" />
                  <rect x="16.8" y="4.5" width="3.2" height="15.5" rx="1.6" />
                </svg>
                <b class="param-val">{{ optionLabel(QUALITY_OPTIONS, quality) }}</b>
              </button>
              <button
                v-if="provider.background !== 'no'"
                class="param-btn has-val"
                :class="{ on: openPanel === 'bg', filled: background !== 'auto' }"
                :data-tip="`背景 · ${optionLabel(BACKGROUND_OPTIONS, background)}`"
                aria-label="背景"
                @click="togglePanel('bg')"
              >
                <!-- 方框 + 棋盘点:透明底的通用符号 -->
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <rect x="3.5" y="3.5" width="17" height="17" rx="2.5" />
                  <path d="M8 8h.01M16 8h.01M12 12h.01M8 16h.01M16 16h.01" stroke-width="2.6" />
                </svg>
                <b class="param-val">{{ optionLabel(BACKGROUND_OPTIONS, background) }}</b>
              </button>
              <!-- 参考图放最后:它是一次性的输入,不是常规参数 -->
              <button
                class="param-btn"
                :class="{ on: openPanel === 'ref', filled: !!refImage }"
                :data-tip="refImage ? '参考图 · 已选' : '参考图 · 未选'"
                aria-label="参考图"
                @click="togglePanel('ref')"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <rect x="3" y="4" width="18" height="16" rx="2.5" />
                  <circle cx="8.5" cy="9.5" r="1.8" />
                  <path d="M4 17.5l4.5-4.5L12 16.5l3-3 5 5" />
                </svg>
              </button>

              <!-- 清除(次级) + 生成(主按钮),右对齐收在参数行末尾 -->
              <div class="prompt-actions">
                <button
                  v-if="prompt.trim() && !loading"
                  class="clear-icon"
                  aria-label="清除输入"
                  data-tip="清除输入"
                  @click="prompt = ''"
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">
                    <path d="M6 6l12 12M18 6L6 18" />
                  </svg>
                </button>
                <button
                  class="gen-icon"
                  :disabled="!loading && !prompt.trim()"
                  :aria-label="loading ? '终止生成' : '生成画面'"
                  :data-tip="loading ? '终止生成' : '生成画面（Enter）'"
                  @click="loading ? stopGenerate() : doGenerate()"
                >
                  <!-- 生成中变为方块停止键,点击可终止这一批 -->
                  <svg v-if="loading" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round">
                    <rect x="7" y="7" width="10" height="10" rx="1.6" />
                  </svg>
                  <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M5 12h13" />
                    <path d="M13 6l6 6-6 6" />
                  </svg>
                </button>
              </div>
            </div>

            <!-- 展开面板:用 grid-template-rows 动画高度,收起时连续合拢无跳变 -->
            <div class="fold" ref="panelEl" :class="{ open: !!openPanel }">
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
                    <!-- 没有已保存配置时给一个入口;有配置时只管切换,管理走顶部齿轮 -->
                    <div v-if="!configs.length" class="pp-group">
                      <span class="pp-note">还没有保存的配置</span>
                      <button class="pp-action" @click="openConfigManager">去新增配置</button>
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
                      <span class="pp-label">尺寸</span>
                      <button
                        v-for="s in sizeOptions"
                        :key="s"
                        class="preset"
                        :class="{ on: size === s }"
                        :title="s === 'auto' ? '由上游按提示词自动决定尺寸' : ''"
                        @click="size = s"
                      >
                        {{ sizeLabel(s) }}
                      </button>
                    </div>
                    <!-- 固定候选的厂商不开放手填:列表已经是全部合法值,填别的只会被上游拒掉 -->
                    <div v-if="sizeFree" class="pp-group">
                      <span class="pp-label">自定义</span>
                      <input
                        class="num-input size-input"
                        :value="size"
                        placeholder="如 1536x1024"
                        spellcheck="false"
                        aria-label="自定义尺寸"
                        @change="commitSize"
                      />
                      <span class="pp-note">宽 × 高,也可填 auto</span>
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
                    <div class="pp-group">
                      <span class="pp-label">自定义</span>
                      <input
                        class="num-input"
                        type="number"
                        min="1"
                        :max="N_MAX"
                        :value="n"
                        :placeholder="`1-${N_MAX}`"
                        aria-label="自定义张数"
                        @change="clampN"
                      />
                      <span class="pp-note">张,最多 {{ N_MAX }} 张</span>
                    </div>
                  </div>

                  <!-- 画质 -->
                  <div v-else-if="shownPanel === 'quality'" class="pp-body">
                    <div class="pp-group">
                      <span class="pp-label">画质</span>
                      <button
                        v-for="o in QUALITY_OPTIONS"
                        :key="o.value"
                        class="preset preset-rich"
                        :class="{ on: quality === o.value }"
                        @click="quality = o.value"
                      >
                        <span>{{ o.label }}</span>
                        <em class="preset-hint">{{ o.hint }}</em>
                      </button>
                    </div>
                    <p class="pp-tip">档位越高越清晰,耗时与费用也越高。{{ capHint(provider.quality) }}</p>
                  </div>

                  <!-- 背景 -->
                  <div v-else-if="shownPanel === 'bg'" class="pp-body">
                    <div class="pp-group">
                      <span class="pp-label">背景</span>
                      <button
                        v-for="o in BACKGROUND_OPTIONS"
                        :key="o.value"
                        class="preset"
                        :class="{ on: background === o.value }"
                        :title="o.value === 'auto' ? '由上游决定,不发送该参数' : ''"
                        @click="background = o.value"
                      >
                        {{ o.label }}
                      </button>
                    </div>
                    <p class="pp-tip">选「透明」可得到无底图,适合做素材。{{ capHint(provider.background) }}</p>
                  </div>
                </div>
              </div>
            </div>

            <input id="ref-file" type="file" accept="image/*" hidden @change="onPickRef" />
          </div>

          <!-- 存储清理提示:是提醒不是错误,中性配色 + 可手动关掉 -->
          <div v-if="notice" class="note" role="status">
            <span class="note-msg">{{ notice }}</span>
            <button class="note-close" @click="notice = ''" aria-label="知道了">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
                <path d="M6 6l12 12M18 6L6 18" />
              </svg>
            </button>
          </div>

          <!-- 报错:默认收成一行,过长才给「详情」;真失败过才给「重试」 -->
          <div v-if="error" class="err" role="alert">
            <p class="err-msg" :class="{ clipped: !errorOpen }">{{ error }}</p>
            <div v-if="errorLong || canRetry" class="err-ops">
              <button v-if="errorLong" class="err-btn" @click="errorOpen = !errorOpen">
                {{ errorOpen ? '收起' : '详情' }}
              </button>
              <button v-if="canRetry" class="err-btn" @click="retry">重试</button>
            </div>
          </div>
        </div>

        <!-- 历史图墙:输入框下方展示最近生成的图,可收起 -->
        <div v-if="loading || feedItems.length" class="feed-zone" aria-live="polite">
          <div class="section-head">
            <span v-if="!loading" class="sec-title">Recent creations</span>
            <!-- 生成中换成格子波 + 秒表:尺寸与字重都对齐 sec-title,
                 生成结束时从加载态切回标题不会跳一下 -->
            <LatticeLoader
              v-else
              class="sec-title"
              label="Generating"
              :font-size="20"
              :cell-size="6"
              :gap="2"
            />
            <div class="sec-tools">
              <button v-if="history.length" class="sec-more" @click="page = 'history'">
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
                  v-for="k in loading ? (running.n > 0 ? running.n : 1) : 0"
                  :key="`sk-${k}`"
                  class="tile tile-skel"
                  :style="{ aspectRatio: String(tileRatio(running.size)) }"
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
                  <img loading="lazy" :src="imageSrc(t.item)" :alt="t.entry.prompt" />
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

      <!-- 提示词库 -->
      <PromptLibrary
        v-else-if="page === 'lib'"
        :items="libItems"
        @use="useLibItem"
        @remove="removeLibItem"
        @add="addLibItem"
        @import="importLibItems"
      />

      <!-- 历史记录 -->
      <HistoryPage
        v-else
        :items="history"
        @open="openPreview"
        @use="usePreviewPrompt"
        @remove="removeHistoryEntry"
      />
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
              <button class="d-close tip-left" @click="showSettings = false" aria-label="关闭" data-tip="关闭">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
              </button>
            </header>

            <div class="d-body no-bar">
              <!-- ===== 视图一:已保存的接口列表 ===== -->
              <section v-if="cfgView === 'list'" class="cfg-bloc">
                <header class="cfg-head">
                  <span class="preset-label">{{ configs.length ? '已保存的接口' : '接口列表' }}</span>
                  <button class="cfg-add tip-left" @click="newConfig" data-tip="新增接口" aria-label="新增接口">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M12 5v14M5 12h14" /></svg>
                  </button>
                </header>

                <div v-if="configs.length" class="cfg-list">
                  <div class="cfg-row" :class="{ on: config.id === c.id }" v-for="c in configs" :key="c.id">
                    <button class="cfg-main" @click="activateConfig(c)">
                      <span class="cfg-name">{{ c.name || '未命名配置' }}</span>
                      <span class="cfg-meta">
                        <span class="cfg-vendor">{{ vendorLabel(c) }}</span>
                        <span class="cfg-url">{{ c.baseUrl }}<template v-if="c.model"> · {{ c.model }}</template></span>
                      </span>
                    </button>
                    <span v-if="config.id === c.id" class="cfg-active">当前</span>
                    <div class="cfg-ops">
                      <button class="cfg-op tip-left" @click="editConfig(c)" data-tip="修改" aria-label="修改">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                          <path d="M12 20h9" />
                          <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
                        </svg>
                      </button>
                      <button class="cfg-op tip-left" @click="duplicateConfig(c)" data-tip="复制" aria-label="复制">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                          <rect x="9" y="9" width="11" height="11" rx="2" />
                          <path d="M5 15V6a1 1 0 0 1 1-1h9" />
                        </svg>
                      </button>
                      <button class="cfg-op danger tip-left" @click="removeConfig(c)" data-tip="删除" aria-label="删除">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                          <path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6 7l1 12a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-12" />
                        </svg>
                      </button>
                    </div>
                  </div>
                </div>
                <div v-else class="cfg-empty">
                  <div class="cfg-empty-ico" aria-hidden="true">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                      <path d="M12 22v-5M9 8V2M15 8V2" />
                      <path d="M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z" />
                    </svg>
                  </div>
                  <p class="cfg-empty-title">还没有接口</p>
                  <p class="cfg-empty-sub">点右上角 ＋ 新增第一个，支持任意 OpenAI 兼容的生图接口，配置只存在本地。</p>
                </div>
              </section>

              <!-- ===== 视图二:新增/编辑接口表单(独立一屏) ===== -->
              <section v-else class="cfg-form">
                <header class="cfg-head">
                  <span class="preset-label">{{ config.id ? '编辑接口' : '新增接口' }}</span>
                  <button class="cfg-back tip-left" @click="cancelConfig" data-tip="返回列表" aria-label="返回列表">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M15 6l-6 6 6 6" /></svg>
                  </button>
                </header>

                <div class="presets" role="group" aria-label="选择厂商">
                  <span class="preset-label">厂商</span>
                  <button
                    v-for="p in PROVIDERS"
                    :key="p.id"
                    class="preset"
                    :class="{ on: (config.vendor || 'custom') === p.id }"
                    @click="applyProvider(p)"
                  >
                    {{ p.label }}
                  </button>
                </div>
                <p class="vendor-note">{{ capabilityNote }}</p>

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

    <!-- 历史图片预览 -->
    <ImagePreview
      :visible="!!previewEntry"
      :entry="previewEntry"
      :items="history"
      @close="closePreview"
      @navigate="openPreview"
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
  /* 三段式:品牌靠左、视图切换居中、主题按钮紧贴滑块右侧。
     两侧都是 1fr、中间 auto,中列才会真正居中于容器;
     主题按钮靠第 3 列的起始边,所以不会把滑块推离中心。
     列间距取 8px:只有"滑块 ↔ 主题按钮"这一处会真实呈现间距,
     与参数栏图标簇的 8px 对齐 */
  display: grid;
  grid-template-columns: 1fr auto 1fr;
  align-items: center;
  gap: var(--sp-2);
  padding: var(--sp-4) 0;
  position: sticky;
  top: 0;
  /* 高于全部页面内容;抽屉与图片预览的浮层刻意压在其上 ——
     否则蒙层盖不住导航,打开抽屉时导航会浮在蒙层之上,看着像坏了 */
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
}
.title {
  /* 品牌锁形:几何粗体主打 + 手写体后缀,两者按基线对齐 */
  font-family: var(--font-wordmark);
  font-size: 21px;
  font-weight: 700;
  letter-spacing: -0.01em;
  line-height: 1.2;
  color: var(--text);
  display: inline-flex;
  align-items: baseline;
  gap: 7px;
}
.title-script {
  font-family: var(--font-script);
  /* 手写体字面小、上下留白多,要放大一档才和左边的字重们等高 */
  font-size: 24px;
  font-weight: 400;
  letter-spacing: 0;
}
.mast-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  /* 靠第 3 列的起始边,于是紧挨着中间的滑块;
     若改成 end 会退回右端,中间的滑块也就不再居中 */
  justify-self: start;
}
/* 居中的视图切换。justify-self 兜住 grid 的默认 stretch,避免被拉伸 */
.nav-seg {
  justify-self: center;
}
.nav-seg .seg-ico {
  width: 17px;
  height: 17px;
}
/* 未配置接口时齿轮标红。选中态那层由滑块的反色副本接管,所以排除 .rs-copy */
.nav-seg :deep(.rs-item:not(.rs-copy)[aria-checked='false'] .is-warn) {
  color: var(--danger);
}
.icob {
  position: relative;
  /* 规格与参数栏的 .param-btn 对齐:34px 圆胶囊 + 常驻底色和描边。
     导航原本是 36px 的无边界裸图标,是页面上唯一一处例外。
     底色和描边压成半透明:导航浮在背景图上,不透明的胶囊在这里
     比坐在纯色页面里的参数栏重得多 */
  width: 34px;
  height: 34px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px solid color-mix(in srgb, var(--line) 80%, transparent);
  border-radius: 999px;
  background: color-mix(in srgb, var(--surface) 88%, transparent);
  color: var(--text-2);
  transition: color var(--dur) var(--ease), background var(--dur) var(--ease), border-color var(--dur) var(--ease);
}
.icob:hover {
  color: var(--text);
  background: var(--bg-elev);
  border-color: var(--line-strong);
}
.icob svg {
  width: 17px;
  height: 17px;
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
  margin: 0 0 var(--sp-2);
}
/* 厂商能力说明:紧贴在厂商按钮下方,说明界面为何只露出这些参数 */
.vendor-note {
  margin: 0 0 var(--sp-5);
  font-size: 12px;
  line-height: 1.6;
  color: var(--text-3);
}
/* 已保存的接口配置列表 */
.cfg-bloc {
  margin: 0;
}
.cfg-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: var(--sp-4);
}
.cfg-head .preset-label {
  margin-right: 0;
}
.cfg-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
/* 列表头部的新增、表单头部的返回:同一套圆形图标按钮 */
.cfg-add,
.cfg-back {
  flex-shrink: 0;
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
  transition: color var(--dur) var(--ease), background var(--dur) var(--ease),
    border-color var(--dur) var(--ease);
}
.cfg-add svg,
.cfg-back svg {
  width: 16px;
  height: 16px;
}
.cfg-add:hover,
.cfg-back:hover {
  border-color: color-mix(in oklch, var(--accent) 45%, var(--line));
  color: var(--accent);
  background: var(--accent-soft);
}
/* 空态:和历史抽屉的空态用同一套虚线框造型 */
.cfg-empty {
  text-align: center;
  padding: var(--sp-6) var(--sp-3);
  border: 1px dashed var(--line-strong);
  border-radius: var(--r);
  color: var(--text-3);
}
.cfg-empty-ico {
  width: 40px;
  height: 40px;
  margin: 0 auto var(--sp-2);
  display: flex;
  align-items: center;
  justify-content: center;
  opacity: 0.7;
}
.cfg-empty-ico svg {
  width: 24px;
  height: 24px;
}
.cfg-empty-title {
  font-family: var(--font-display);
  font-size: 15px;
  color: var(--text-2);
}
.cfg-empty-sub {
  margin: 6px auto 0;
  max-width: 260px;
  font-size: 12px;
  line-height: 1.6;
  color: var(--text-3);
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
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  font-size: 12px;
  color: var(--text-3);
}
/* 厂商小标签 + 地址,地址过长时自己截断,不挤压标签 */
.cfg-vendor {
  flex-shrink: 0;
  padding: 1px 7px;
  font-size: 11px;
  border-radius: 999px;
  color: var(--text-2);
  background: color-mix(in oklch, var(--text) 6%, transparent);
  border: 1px solid var(--line);
}
.cfg-url {
  min-width: 0;
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
  max-width: 840px;
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
  /* 高度由 fitPrompt() 按内容算(6 行封顶后转内部滚动),
     所以既不要拖拽角,也不能让浏览器自己先冒出滚动条 */
  resize: none;
  overflow-y: hidden;
  line-height: 1.6;
  font-size: 16px;
  /* 一行(16px × 1.6 + 上下内边距 = 39.6)的兜底高度,JS 接管前先撑住;
     同时是 JS 算高度时的下限 */
  min-height: 40px;
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
/* 纯图标按钮:名称与当前值都放进 title,鼠标悬停才显示 */
.param-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  color: var(--text-2);
  border: 1px solid var(--line);
  border-radius: 999px;
  background: var(--surface);
  transition: color var(--dur) var(--ease), border-color var(--dur) var(--ease),
    background var(--dur) var(--ease);
}
.param-btn svg {
  width: 17px;
  height: 17px;
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
/* 带数值的参数(尺寸/张数):图标右侧直接露出当前值,宽度随内容撑开 */
.param-btn.has-val {
  width: auto;
  gap: 6px;
  padding: 0 12px 0 10px;
}
.param-val {
  font-size: 13px;
  font-weight: 500;
  font-variant-numeric: tabular-nums;
  color: var(--text);
}
/* 配置名可能很长,限宽后省略;行高继承自 body(1.6),不会切掉字的下缘 */
.param-val-name {
  max-width: 120px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
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
/* 面板底部的说明文字 */
.pp-tip {
  font-size: 12px;
  line-height: 1.6;
  color: var(--text-3);
}
/* 面板里的紧凑数字输入(自定义张数) */
.num-input {
  width: 76px;
  padding: 6px 10px;
  font-size: 13px;
  font-variant-numeric: tabular-nums;
  text-align: center;
  color: var(--text);
  border: 1px solid var(--line);
  border-radius: 999px;
  background: var(--surface);
  transition: border-color var(--dur) var(--ease), box-shadow var(--dur) var(--ease);
  /* 去掉数字框自带的上下箭头,和面板里的胶囊按钮保持同一套造型 */
  appearance: textfield;
  -moz-appearance: textfield;
}
.num-input::-webkit-outer-spin-button,
.num-input::-webkit-inner-spin-button {
  -webkit-appearance: none;
  margin: 0;
}
.num-input:focus {
  border-color: var(--accent);
  box-shadow: 0 6px 18px -10px color-mix(in oklch, var(--accent) 60%, transparent);
}
/* 自定义尺寸:比纯数字输入更宽,容纳 1024x1024 这类字符串,左对齐便于对位读数 */
.size-input {
  width: 124px;
  text-align: left;
  padding-left: 12px;
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

/* 面板里的分区小标题,和参数面板的 .pp-label 同一档 */
.preset-label {
  font-size: 12px;
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
  transition: border-color var(--dur) var(--ease), color var(--dur) var(--ease),
    background var(--dur) var(--ease);
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
/* 带注解的胶囊(画质档位):主标签 + 一句代价说明,同一行排布 */
.preset-rich {
  display: inline-flex;
  align-items: baseline;
  gap: 6px;
}
.preset-hint {
  font-style: normal;
  font-size: 11px;
  color: var(--text-3);
  transition: color var(--dur) var(--ease);
}
.preset-rich:hover .preset-hint {
  color: var(--accent);
}
.preset-rich.on .preset-hint {
  color: inherit;
  opacity: 0.75;
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
/* 存储清理提示:提醒而非错误,用中性色,不与报错抢注意力 */
.note {
  display: flex;
  align-items: flex-start;
  gap: var(--sp-3);
  margin-top: var(--sp-2);
  padding: 8px 12px;
  font-size: 13px;
  color: var(--text-2);
  background: var(--bg-elev);
  border: 1px solid var(--line);
  border-radius: var(--r-sm);
}
.note-msg {
  flex: 1;
  line-height: 1.6;
  overflow-wrap: anywhere;
}
.note-close {
  flex-shrink: 0;
  width: 22px;
  height: 22px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-3);
  border-radius: 999px;
  transition: color var(--dur) var(--ease), background var(--dur) var(--ease);
}
.note-close svg {
  width: 13px;
  height: 13px;
}
.note-close:hover {
  color: var(--text);
  background: var(--surface);
}

/* 长报错默认一行截断:上游原文动辄上百字,整段铺开会把输入区顶得很高 */
.err-msg {
  line-height: 1.6;
  overflow-wrap: anywhere;
}
.err-msg.clipped {
  display: -webkit-box;
  -webkit-line-clamp: 1;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.err-ops {
  display: flex;
  justify-content: flex-end;
  gap: 6px;
  margin-top: 6px;
}
.err-btn {
  padding: 3px 10px;
  font-size: 12px;
  color: var(--danger);
  border: 1px solid color-mix(in oklch, var(--danger) 32%, transparent);
  border-radius: 999px;
  transition: background var(--dur) var(--ease);
}
.err-btn:hover {
  background: color-mix(in oklch, var(--danger) 12%, transparent);
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
  width: 16px;
  height: 16px;
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
  /* 和主页面小节标题、预览弹层标题同一套:600 + 微收字距 */
  font-weight: 600;
  font-size: 22px;
  letter-spacing: -0.01em;
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
/* 加载态复用 sec-title 的字族与配色,只有动词的字重是组件内写死的 500,
   这里抬到 600,免得标题槽位在两种状态间来回变粗细 */
.sec-title :deep(.lattice-loader__label) {
  font-weight: 600;
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
