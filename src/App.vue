<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, watch, toRaw } from 'vue'
import {
  PhHouse,
  PhBooks,
  PhClockCounterClockwise,
  PhGear,
  PhSun,
  PhMoon,
  PhSlidersHorizontal,
  PhSquaresFour,
  PhDotsNine,
  PhStop,
  PhArrowCounterClockwise,
  PhSparkle,
  PhArrowsLeftRight,
  PhX,
  PhArrowRight,
  PhCaretRight,
  PhCaretDown
} from '@phosphor-icons/vue'
import PromptLibrary from './components/PromptLibrary.vue'
import ImagePreview from './components/ImagePreview.vue'
import HistoryPage from './components/HistoryPage.vue'
import SettingsPage from './components/SettingsPage.vue'
import RubberSegment from './components/RubberSegment.vue'
import LatticeLoader from './components/LatticeLoader.vue'
import {
  generate,
  enhancePrompt,
  uid,
  loadConfigs,
  saveConfigs,
  loadActiveId,
  saveActiveId,
  loadActiveTextId,
  saveActiveTextId,
  loadHistory,
  addHistoryRecord,
  removeHistoryRecord,
  saveHistoryRecord,
  loadPrompts,
  savePrompts,
  getProvider,
  inferVendor,
  allowedSizes,
  imageSrc,
  makeThumb,
  backfillThumbs,
  releaseEntryMedia,
  QUALITY_OPTIONS,
  BACKGROUND_OPTIONS
} from './api'
import { blobToDataURL } from './lib/idb'
import type { Cap, EnhanceMode, Provider } from './api'
import type { ApiConfig, FavoritePayload, HistoryEntry, PromptItem, ResultItem, ReuseParams } from './types'

// —— 状态 ——
const prompt = ref('')
// 提示词改写中(防连点、按钮切文案)
const enhancing = ref(false)
// 改写请求的中断手柄,与生图的 controller 各管各的:两件事互不影响
const enhanceController = ref<AbortController | null>(null)
// 改写前的原稿,空串表示当前没有可撤销的内容。只在点 Undo 或再次改写时更新
const preEnhance = ref('')
// 默认交给上游自决:'auto' 在大多数字段里是"最不会错"的一档,选错尺寸比不选更糟
const size = ref('auto')
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
// 四个平级页面:首页 / 提示词库 / 历史记录 / 接口设置,同时只挂载一个
type Page = 'home' | 'lib' | 'history' | 'settings'
const page = ref<Page>('home')
const previewEntry = ref<HistoryEntry | null>(null)
// 参数 icon 展开的面板:同一时间只开一个,再次点击收起。
// 只有三项 —— 尺寸/画质/背景/参考图合并成 'more' 一块,参数行默认只露模型与张数
type PanelKey = '' | 'n' | 'more' | 'config'
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
const activeConfigName = computed(() => config.value.name || config.value.baseUrl || 'Not configured')

/* 文本模型与出图配置并排各占一个胶囊:改写用哪个模型也是一眼该看到的状态。
   名字优先,没起名字退回模型名 —— 裸地址在胶囊里太长,且对不上"这是哪个模型" */
const activeTextName = computed(() => {
  const c = textConfig.value
  if (!c) return 'Not set'
  return c.name || c.model || 'Not configured'
})

// 参数面板按用途分开列出:出图与改写各有各的"当前",混在一排里点谁生效说不清,
// 而且文本配置被 activateConfig 选中会顶掉出图用的接口
const imageConfigs = computed(() => configs.value.filter((c) => c.kind !== 'text'))
const textConfigs = computed(() => configs.value.filter((c) => c.kind === 'text'))

// —— 历史图墙(输入框下方,可收起) ——
const feedOpen = ref(true)
const FEED_LIMIT = 12
// 老记录没有 w/h,图片加载完再按真实像素补一下比例(与历史页同一个思路)。key 同 feedItems
const measured = ref<Record<string, number>>({})
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
      const key = `${entry.id}-${i}`
      out.push({
        key,
        entry,
        item: entry.results[i],
        ratio: feedRatio(entry, key)
      })
    }
  }
  return out
})
// 缩略块按图片真实比例排:量到的真实比例 → 入库记的 w/h → 解析所选尺寸 → 方形兜底
function feedRatio(entry: HistoryEntry, key: string) {
  const m = measured.value[key]
  if (m) return m
  if (entry.w && entry.h) return Math.min(2, Math.max(0.5, entry.w / entry.h))
  return tileRatio(entry.size)
}
// 按记录尺寸算宽高比(生成中的骨架仍按所选尺寸,不用真实比例)
function tileRatio(size: string) {
  const [w, h] = size.split('x').map(Number)
  if (!w || !h) return 1
  return Math.min(2, Math.max(0.5, w / h))
}
// 图墙里没有 w/h 的老记录:图加载完切到真实比例,避免按所选尺寸裁掉一截
function onFeedLoad(key: string, entry: HistoryEntry, e: Event) {
  if (measured.value[key] || (entry.w && entry.h)) return
  const img = e.target as HTMLImageElement
  if (!img.naturalWidth || !img.naturalHeight) return
  measured.value[key] = Math.min(2, Math.max(0.5, img.naturalWidth / img.naturalHeight))
}

// 当前生效的厂商:配置里没写就按域名猜(兼容加字段之前存的老配置)
const provider = computed<Provider>(() => {
  const cfg = config.value
  return getProvider(cfg.vendor || inferVendor(cfg.baseUrl))
})
// 设置页表头那句能力说明:描述的是当前生效的那个接口,不是表单里正在挑的。
// 界面上的参数门控本来就照生效配置来,说明文字要是跟着草稿走,两者就对不上了
const capabilityNote = computed(() => {
  const p = provider.value
  const t = (c: Cap) => (c === 'yes' ? 'Yes' : c === 'no' ? 'No' : 'Varies')
  return `Active API: quality ${t(p.quality)} · background ${t(p.background)} · image-to-image via ${
    p.edit === 'edits' ? '/images/edits' : '/images/generations'
  }`
})
// 尺寸候选随厂商(以及 OpenAI 的模型代次)变化
const sizeOptions = computed(() => {
  const list = allowedSizes(provider.value.id, config.value.model)
  const base = Array.isArray(list) ? list : FREE_SIZES
  /* 上游没有 auto 档就把这一项摘掉:留着它,界面会显示"自动",而请求里
     根本带不了这个参数(带了就 400),于是每次都拿上游的默认尺寸 ——
     看起来像"模型没按 prompt 定比例",其实是我们自己把这一档抹掉了 */
  return provider.value.autoSize ? base : base.filter((s) => s !== 'auto')
})
// 尺寸是否由接口自行决定:固定候选的厂商不开放手填,列表已经是全部合法值
const sizeFree = computed(() => allowedSizes(provider.value.id, config.value.model) === 'free')

/* 收进「更多」里的参数只要有一项不是默认值,入口就点亮 ——
   否则改过尺寸之后参数行上一点痕迹都没有,像是丢了。
   size 的基线不能用字面量 'auto':dall-e-3 不开放 auto,初始化会被换成它的第一档,
   拿 'auto' 当基线会让这家厂商一进页面就亮着 */
const defaultSize = computed(() =>
  sizeOptions.value.includes('auto') ? 'auto' : sizeOptions.value[0] || 'auto'
)
const moreCustom = computed(
  () =>
    size.value !== defaultSize.value ||
    quality.value !== 'auto' ||
    background.value !== 'auto' ||
    !!refImage.value
)

// 张数上限:多数生图接口一次最多 10 张
const N_MAX = 10

// 'auto' 是给上游的值,界面上叫"自动"
function sizeLabel(s: string) {
  return s === 'auto' ? 'Auto' : s.replace(/x/g, '×')
}

/* 厂商不限尺寸时给的一组常用值。
   顺序即优先级:不认 auto 的厂商会把 auto 摘掉,剩下的第一项就成了默认尺寸,
   所以按"最常用"排而不是按尺寸递增 —— 1024x1024 是这类接口的通用默认值,
   排在 512x512 前面,免得摘掉 auto 之后默认掉到 512 去 */
const FREE_SIZES = ['auto', '1024x1024', '1024x1792', '1792x1024', '512x512', '2560x1440']

// 按厂商能力决定携带哪些扩展参数:已知不支持的一律不发
function extraParams(): Record<string, string> {
  const caps = provider.value
  const out: Record<string, string> = {}
  if (caps.quality !== 'no' && quality.value !== 'auto') out.quality = quality.value
  if (caps.background !== 'no' && background.value !== 'auto') out.background = background.value
  return out
}

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

// —— 顶部导航(分段控件) ——
// 四个条目是四个平级页面,不是四个动作:滑块停在哪儿就是当前在看哪一页。
// 视图状态只有 page 一份,navView 只是把它的类型收紧回联合类型
// (RubberSegment 的 v-model 说的是普通字符串)。
// 必须放在 page 声明之后:getter 引用了它
const navItems = [
  { value: 'home', label: 'Studio' },
  { value: 'lib', label: 'Prompt Library' },
  { value: 'history', label: 'History' },
  { value: 'settings', label: 'Settings' }
]
const navView = computed({
  get: () => page.value as string,
  set: (v: string) => {
    page.value = v as Page
  }
})
// 切视图后回到顶部:否则在首页滚到一半再切过去,新页面会停在半空
watch(navView, () => window.scrollTo({ top: 0 }))
// 全部已保存的接口配置
const configs = ref<ApiConfig[]>([])
// 当前生效的配置:生成请求照它发。它和设置页里的表单草稿是两码事,
// 改表单不会动它,只有点了保存才会
const config = ref<ApiConfig>({ id: '', name: '', baseUrl: '', apiKey: '', model: '' })
const activeId = ref('')
// 提示词增强用的文本配置:与出图配置同在一个列表里,只是用途为 'text'。
// 拷贝一份与 config 同理 —— 改设置页表单不会动它,只有存下/设当前才会。
// null 表示列表里还没有文本配置(增强按钮会提示去设置页配一条)
const textConfig = ref<ApiConfig | null>(null)
// 文本类别当前生效配置的 id,与 activeId 各自独立
const activeTextId = ref(loadActiveTextId())
// 接口设置页的视图:'list' = 已保存接口列表,'form' = 新增/编辑接口表单(独立一屏)
const cfgView = ref<'list' | 'form'>('list')
// 表单页要编辑/复制的来源;null 表示新增空白。
// 草稿本身由页面组件持有,这里只给种子 —— 于是「返回列表」是真正的放弃修改
const cfgSeed = ref<ApiConfig | null>(null)

// 换厂商/换模型后,原来的尺寸可能已不在候选里,自动回退到第一个,免得发出上游不认的值。
// immediate 让它立刻跑一次,覆盖初始值:默认是 'auto',但 dall-e-3 这类不开放 auto 的
// 模型会在这里被换成它的第一档 —— 所以必须放在 config 声明之后,提前会撞上 TDZ
watch(
  sizeOptions,
  (list) => {
    if (list.length && !list.includes(size.value)) size.value = list[0]
  },
  { immediate: true }
)

onMounted(() => {
  configs.value = loadConfigs()
  activeId.value = loadActiveId()
  // 选中激活配置;无激活则取第一条出图配置(文本配置不能顶出图的当前位置)
  const active =
    configs.value.find((c) => c.id === activeId.value && c.kind !== 'text') ||
    configs.value.find((c) => c.kind !== 'text')
  if (active) {
    config.value = { ...active }
    // 存着的 activeId 可能指向已被删掉的配置:一并回填成真正选中的那条。
    // 设置页的「当前」标记就是按 activeId 比的,不同步的话一条都不会亮
    if (activeId.value !== active.id) {
      activeId.value = active.id
      saveActiveId(active.id)
    }
  }
  // 文本配置:按 activeTextId 在列表里找用途为 text 的那条;
  // 没命中(存着的 id 已被删/被改用途)就退而取第一条文本配置并回填 ——
  // 只有一条时这是显然的选择,比空着好。一条都没有则保持 null
  const activeText =
    configs.value.find((c) => c.id === activeTextId.value && c.kind === 'text') ||
    configs.value.find((c) => c.kind === 'text')
  if (activeText) {
    textConfig.value = { ...activeText }
    if (activeTextId.value !== activeText.id) {
      activeTextId.value = activeText.id
      saveActiveTextId(activeText.id)
    }
  }
  libItems.value = loadPrompts()
  loadHistory().then((h) => {
    history.value = h
    // 老记录没有列表缩略图,后台慢慢补;不 await,免得拖慢首屏
    backfillThumbs(h)
  })
})

/* 新建一份配置(进入独立的新增接口表单页)。
   空态的四条入口会带一份预填好的 seed(厂商的地址与模型),不带则是一张空表单 */
function newConfig(seed?: ApiConfig) {
  cfgSeed.value = seed ?? null
  cfgView.value = 'form'
}
// 复制已有配置:基于它生成一份新编辑(切到表单页)
function duplicateConfig(c: ApiConfig) {
  cfgSeed.value = { ...c, id: '', name: c.name ? `${c.name} copy` : 'Config copy' }
  cfgView.value = 'form'
}
// 编辑已有配置:带入该配置,切到表单页
function editConfig(c: ApiConfig) {
  cfgSeed.value = { ...c }
  cfgView.value = 'form'
}
// 保存表单草稿(新增或更新),并设为激活
function saveSettings(draft: ApiConfig) {
  const cfg = {
    ...draft,
    id: draft.id || uid(),
    name: draft.name.trim() || cfgNameFromUrl(draft.baseUrl)
  }
  const idx = configs.value.findIndex((c) => c.id === cfg.id)
  if (idx >= 0) configs.value[idx] = cfg
  else configs.value.push(cfg)
  saveConfigs(configs.value)
  /* 按用途分派到各自的「当前生效」:两类各自独立,存文本配置不该把出图的当前项顶掉
     (反之亦然)。同步成副本而不是直接用 cfg —— 之后改表单草稿不能再牵动生效值。 */
  if (cfg.kind === 'text') {
    textConfig.value = { ...cfg }
    activeTextId.value = cfg.id
    saveActiveTextId(cfg.id)
  } else {
    config.value = { ...cfg }
    activeId.value = cfg.id
    saveActiveId(cfg.id)
  }
  // 留在设置页看列表:刚存下的那条会带「当前」标记,比直接跳走更容易确认
  cfgView.value = 'list'
}
// 从地址推导一个默认名称
function cfgNameFromUrl(url: string): string {
  try {
    return new URL(url).hostname || 'Untitled config'
  } catch {
    return 'Untitled config'
  }
}
// 从表单返回列表视图
function cancelConfig() {
  cfgView.value = 'list'
}
// 从参数面板进入接口设置页
function openConfigManager() {
  cfgView.value = configs.value.length ? 'list' : 'form'
  // 种子清空:空表单页不该带着上一次编辑的内容
  cfgSeed.value = null
  page.value = 'settings'
  openPanel.value = ''
}
// 设某条配置为激活
function activateConfig(c: ApiConfig) {
  config.value = { ...c }
  activeId.value = c.id
  saveActiveId(c.id)
}
// 设某条文本配置为当前生效(与 activateConfig 同一套做法,只是走文本那条通道)
function activateTextConfig(c: ApiConfig) {
  textConfig.value = { ...c }
  activeTextId.value = c.id
  saveActiveTextId(c.id)
}
// 删除一条配置;若删的是激活项,自动激活剩余第一条
function removeConfig(c: ApiConfig) {
  configs.value = configs.value.filter((x) => x.id !== c.id)
  saveConfigs(configs.value)
  // 占着各自「当前生效」的那条被删掉时,同样要按用途重新挑一条,免得生效值悬空
  if (activeTextId.value === c.id) {
    const nextText = configs.value.find((x) => x.kind === 'text')
    if (nextText) {
      activateTextConfig(nextText)
    } else {
      textConfig.value = null
      activeTextId.value = ''
      saveActiveTextId('')
    }
  }
  if (activeId.value === c.id) {
    const next = configs.value.find((x) => x.kind !== 'text')
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
    notice.value = 'Not enough local storage. Prompts saved, but cover images were not.'
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
      category: i.category || 'Uncategorized',
      size: i.size,
      quality: i.quality,
      background: i.background,
      thumb: typeof i.thumb === 'string' && i.thumb.startsWith('data:image/') ? i.thumb : undefined,
      createdAt: typeof i.createdAt === 'number' ? i.createdAt : Date.now()
    }))
  libItems.value = [...clean, ...libItems.value]
  persistLib()
}

/* 导入的配置来自外部文件,逐条规整:没有 baseUrl 的存下来也发不出请求;
   id 若和现有的撞了必须换新的,否则列表里两条同 id,渲染和删除都会错乱 */
function importConfigs(list: ApiConfig[]) {
  const clean: ApiConfig[] = list
    .filter((c) => c && typeof c.baseUrl === 'string' && c.baseUrl.trim())
    .map((c) => ({
      id: c.id && !configs.value.some((x) => x.id === c.id) ? c.id : uid(),
      name: typeof c.name === 'string' && c.name.trim() ? c.name : cfgNameFromUrl(c.baseUrl),
      baseUrl: c.baseUrl.trim(),
      apiKey: typeof c.apiKey === 'string' ? c.apiKey : '',
      model: typeof c.model === 'string' ? c.model : '',
      vendor: typeof c.vendor === 'string' ? c.vendor : 'custom',
      // 外部文件的脏数据不该让配置错类:认不出是 'text' 的一律当出图
      kind: c.kind === 'text' ? ('text' as const) : ('image' as const)
    }))
  if (!clean.length) return
  // 追加而不是覆盖:导入是补充,不该把现有配置清掉
  configs.value = [...clean, ...configs.value]
  saveConfigs(configs.value)
  // 原本一条都没配(生成会被拦下来)时,顺手把导入里第一条出图配置设为当前,不然导完照样发不出请求
  if (!configured()) {
    const first = configs.value.find((c) => c.kind !== 'text')
    if (first) {
      config.value = { ...first }
      activeId.value = first.id
      saveActiveId(first.id)
    }
  }
  // 文本那边同理:还没有当前生效的文本配置时,取导入进来(或现有)的第一条文本配置
  if (!textConfig.value) {
    const nextText = configs.value.find((c) => c.kind === 'text')
    if (nextText) activateTextConfig(nextText)
  }
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
function compressImage(dataUrl: string, maxEdge = 1024, quality = 0.85): Promise<string> {
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
      resolve(c.toDataURL('image/jpeg', quality))
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
  /* 改写回来时会整体覆盖提示词。此刻发出去的图,用的是改写到一半的内容,
     而用户看到的输入框马上就要变成另一段文字 —— 这批图会和界面对不上。
     按钮那边也置灰了,这里再拦一道是因为回车也能触发生成 */
  if (enhancing.value) return
  if (!prompt.value.trim()) {
    fail('Enter a prompt first')
    return
  }
  if (!configured()) {
    fail('Set an API base URL in Settings first')
    openConfigManager()
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
    // 在代理上改动不会回写到这里的原始对象,而 idb 又只接受原始对象。
    // 同时把量到的真实像素写进记录,图墙就能按真实比例排,而不是按所选尺寸
    const t = await makeThumb(res[0])
    if (t) {
      record.thumb = t.blob
      record.w = t.w
      record.h = t.h
    }
    history.value = [record, ...history.value]
    try {
      const pruned = await addHistoryRecord(record)
      if (pruned) {
        // 磁盘上已经删掉了,内存里也要同步,否则界面还留着早已不存在的记录
        const goneIds = new Set(pruned.removedIds)
        const gone = history.value.filter((h) => goneIds.has(h.id))
        history.value = history.value.filter((h) => !goneIds.has(h.id))
        // 这些图不会再展示了,顺带把 object URL 撤掉,让 Blob 能被回收
        gone.forEach(releaseEntryMedia)
        const pct = Math.round(pruned.usageRatio * 100)
        notice.value = pct
          ? `Local storage is about ${pct}% full. Removed the oldest ${pruned.removed} history ${pruned.removed === 1 ? 'item' : 'items'} to free space.`
          : `Removed the oldest ${pruned.removed} history ${pruned.removed === 1 ? 'item' : 'items'} to limit local usage.`
      }
    } catch {
      // 生成是成功的,失败的只是"存进本地":记录先留在内存里(本次会话仍可见),
      // 但必须如实告知刷新会丢 —— 不能混进下面"生成失败"的提示里
      notice.value = 'Image generated, but not saved locally. It will be lost on refresh — download it first.'
    }
  } catch (e: any) {
    // 主动终止不是失败,不报错也不入历史
    if (e?.name === 'AbortError') return
    // 走到这里说明请求真的发出去了,可以重试
    fail(e?.message || 'Generation failed', true)
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

/* 改写与撤销共用同一个按钮:两件事不会同时可用,拆成两个会让按钮区
   在"有没有原稿"之间来回换宽度,旁边的清除键跟着跳。
   三态由现有状态推出来,不另存一份 */
const canUndo = computed(() => !enhancing.value && !!preEnhance.value)
/* 按钮上只写档位名:"enhance" 已经在四角星图标和它所在的位置里说完了,
   再写一遍只是把按钮撑长。改写中同样带档位,顺带说明这次跑的是哪一档 */
const enhanceText = computed(() => {
  if (enhancing.value) return 'Stop'
  if (canUndo.value) return 'Undo'
  return enhanceMode.value === 'creative' ? 'Creative' : 'Quick'
})
/* 只有"空闲、没得可撤、输入框也空着"才禁用。
   改写中必须可点 —— 那个位置就是中断键,和生成键跑起来变方块停止是同一套;
   可撤销时同样可点,哪怕输入框被清空了:原稿还在,那正是要撤回来的场景 */
const enhanceDisabled = computed(() => !enhancing.value && !canUndo.value && !prompt.value.trim())

/* 悬停提示:说清这次点下去会用哪一档。
   选了参考图时补一句 —— 那时改写是"改什么"而不是"画什么",结果明显更短,
   不点明会让人以为是自己写坏了或者模型变笨了 */
const enhanceTip = computed(() => {
  if (enhancing.value) return 'Stop rewriting'
  if (canUndo.value) return 'Undo'
  const mode = enhanceMode.value === 'creative' ? 'Creative' : 'Quick'
  return `Rewrite the prompt · ${mode}${refImage.value ? ' · Image-to-image' : ''}`
})
// 读屏也该知道是图生图:它看不到悬停提示,更看不到参考图缩略图
const enhanceAria = computed(() => {
  if (enhancing.value) return 'Stop rewriting'
  if (canUndo.value) return 'Undo prompt rewrite'
  return `Rewrite the prompt, ${enhanceMode.value} mode${refImage.value ? ', image-to-image' : ''}`
})

/* 改写档位:只两档,所以切换键直接来回切,不做下拉菜单 ——
   两种状态用不着菜单那套浮层、外部点击收起和箭头图标。
   只存在内存里:刷新后回到保守档,重构档是"这次想放开一点"的临时选择 */
const enhanceMode = ref<EnhanceMode>('quick')
function toggleEnhanceMode() {
  enhanceMode.value = enhanceMode.value === 'quick' ? 'creative' : 'quick'
}
const nextModeLabel = computed(() => (enhanceMode.value === 'quick' ? 'Creative' : 'Quick'))

/* 提示词改写:用文本模型把当前提示词扩写得更具体,结果填回输入框。
   改写前的原稿另存一份供 Undo 撤销 —— 不做历史记录,只留最近一次。 */
async function doEnhance() {
  // 进行中不重入,防连点
  if (enhancing.value) return
  const src = prompt.value.trim()
  if (!src) return
  // 改写模型和地址都要有:缺一个都打不通 /chat/completions,借现有的错误出口提示去设置页配
  const cfg = textConfig.value
  if (!cfg || !cfg.model || !cfg.baseUrl) {
    fail('Set up prompt enhancing in API settings first.')
    return
  }
  enhancing.value = true
  enhanceController.value = new AbortController()
  try {
    const out = await enhancePrompt(
      cfg,
      src,
      {
        mode: enhanceMode.value,
        // 这次改写是给出图那条配置的:各家偏好不同,写法要跟着变
        targetVendor: provider.value.id,
        targetModel: config.value.model,
        // 有参考图时提示词该写成"改什么",而不是重新描述整幅画面
        hasRef: !!refImage.value
      },
      enhanceController.value.signal
    )
    // 原稿存的是改写前的完整文本(含可能的首尾空白),Undo 才能一字不差地还原
    preEnhance.value = prompt.value
    prompt.value = out
  } catch (e: any) {
    // 主动中断不算失败:不报错,输入框保持原样(和生成那边的处理一致)
    if (e?.name === 'AbortError') return
    fail(e?.message || 'Prompt enhancing failed')
  } finally {
    enhancing.value = false
    enhanceController.value = null
  }
}

// 中断改写:断开请求。服务端那边会跟着中断对上游的调用(见 /api/enhance 的 res.on('close'))
function stopEnhance() {
  enhanceController.value?.abort()
}

/* 按钮一个位置承担三件事:改写、中断、撤销。同一时刻只会有一件是当前的,
   拆成三个按钮会把按钮区撑宽,而且用户还得先找哪个是自己的状态 */
function onEnhanceClick() {
  if (enhancing.value) stopEnhance()
  else if (canUndo.value) undoEnhance()
  else doEnhance()
}

// 撤销改写:把原稿写回输入框,并清掉撤销点
function undoEnhance() {
  if (!preEnhance.value) return
  prompt.value = preEnhance.value
  preEnhance.value = ''
}

// —— 工具 ——
// 图墙角标用的紧凑时间:09-24 15:54
function fmtDate(ts: number) {
  const d = new Date(ts)
  const p = (x: number) => String(x).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/* 短标题结尾要摘掉的虚词。放模块级是为了不每次调用都重建正则 */
const TAIL_STOP =
  /\s+(of|in|on|at|with|and|or|for|to|from|by|the|a|an|as|into|over|under|that|is|are)$/i

/* 图砖上的短标题:从提示词开头取几个词,让每块砖有名字可认。
   不新增字段存它 —— 提示词本来就在历史记录里,派生得出来的东西不必再落一份盘,
   这样已有记录也立刻有标题,不用迁移。
   完整提示词仍然只挂在 img 的 alt 上(读屏能拿到),角标里不出现,免得挡图 */
function tileTitle(prompt: string) {
  const s = (prompt || '').replace(/\s+/g, ' ').trim()
  if (!s) return 'Untitled'
  const cap = (t: string) => t.charAt(0).toUpperCase() + t.slice(1)
  /* 拉丁文按词切,顺便去掉开头的冠词:
     "A cinematic portrait of a girl" 里的 A 只是语法,做了标题就是噪声 */
  if (!/[\u3400-\u9fff]/.test(s)) {
    const cut = s.replace(/^(a|an|the)\s+/i, '').split(' ').slice(0, 4).join(' ')
    /* 切在虚词上收不住尾:"cinematic portrait of a" 读起来像被截断,
       所以把结尾的 of / in / the 这类非实词摘掉,直到落在一个实词上 */
    let out = cut
    while (TAIL_STOP.test(out)) out = out.replace(TAIL_STOP, '')
    // 整句都是虚词的极端情况:别返回空串,退回没修过的结果
    return cap(out || cut)
  }
  // 中日韩没有空格,按词切会把整句糊上来,所以按字截
  return s.slice(0, 12)
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
 * 同时限长,避免把原始大图当成封面塞进 localStorage。
 *
 * 320px / 0.78:库页卡片的背面会把这张图铺开显示,原来 160px 在那个尺寸下会糊。
 * 画质压得比参考图低,是因为它按条数存进 localStorage,省下的都是配额。
 */
async function thumbOf(src: string): Promise<string | undefined> {
  if (!src) return undefined
  const out = await compressImage(src, 320, 0.78)
  return /^data:image\//.test(out) && out.length < 80000 ? out : undefined
}

// 预览菜单:收藏当前预览的提示词到库(连带参数与一张封面缩略图)
async function favoriteFromPreview(p: FavoritePayload) {
  if (!p.prompt.trim()) return
  const item: PromptItem = {
    id: uid(),
    prompt: p.prompt,
    category: 'Uncategorized',
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
    fail('Only local images can be used as a reference.')
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
  // 关闭预览之后再释放:预览还开着时撤地址会让图裂掉
  releaseEntryMedia(cur)
}
// 历史页:不进预览,直接删掉某条记录
async function removeHistoryEntry(entry: HistoryEntry) {
  history.value = history.value.filter((h) => h.id !== entry.id)
  await removeHistoryRecord(entry.id)
  releaseEntryMedia(entry)
}
/* 标记逐张标:图墙里一块图块就是一张图,所以标在结果项上而不是整条记录上。
   改完必须落盘,否则刷新就丢;界面靠响应式代理更新,而 idb 只吃原始对象,故 toRaw */
async function toggleMark(entry: HistoryEntry, index: number) {
  const item = entry.results[index]
  if (!item) return
  item.marked = !item.marked
  await saveHistoryRecord(toRaw(entry))
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

      <!-- 居中的视图切换:滑块位置即当前打开的面板。
           轨道 40px / 内边距 5px,滑块因此留在 30px:
           原来 36/3 时白底只比黑色选中底高 3px,两者看起来一样高 -->
      <RubberSegment
        v-model="navView"
        class="nav-seg"
        :items="navItems"
        :radius="999"
        :height="40"
        :inset="5"
        aria-label="Main navigation"
      >
        <template #home>
          <PhHouse class="seg-ico" aria-hidden="true" />
        </template>
        <template #lib>
          <!-- Phosphor 的 Books:表达"收藏成册的提示词库" -->
          <PhBooks class="seg-ico" aria-hidden="true" />
        </template>
        <template #history>
          <PhClockCounterClockwise class="seg-ico" aria-hidden="true" />
        </template>
        <template #settings>
          <PhGear class="seg-ico" :class="{ 'is-warn': !configured() }" aria-hidden="true" />
        </template>
      </RubberSegment>

      <nav class="mast-actions">
        <button
          class="icob tip-below"
          @click="toggleTheme"
          :data-tip="theme === 'dark' ? 'Switch to light' : 'Switch to dark'"
          :aria-label="theme === 'dark' ? 'Switch to light' : 'Switch to dark'"
        >
          <PhSun v-if="theme === 'dark'" aria-hidden="true" />
          <PhMoon v-else aria-hidden="true" />
        </button>
      </nav>
    </header>

    <!-- 视图切换:首页工作台与提示词库是两个平级页面,同时只挂载一个 -->
    <main class="frame">
      <!-- 生图工作台 -->
      <section v-if="page === 'home'" class="workbench page-in" aria-label="Studio">
        <header class="hero">
          <p class="hero-eyebrow">AI Image Studio</p>
          <h1 class="hero-title">Turn your ideas<br />into beautiful images</h1>
          <p class="hero-sub">Create, explore, and organize AI-generated images with ease.</p>
        </header>

        <div class="composer">
          <div class="prompt-box">
            <!-- 一、输入区(横线上方) -->
            <div class="compose-zone">
              <!-- 改写期间只读:改写结果要整体覆盖回来,中途改字会和它打架。
                   用 readonly 而不是 disabled —— 后者会掉焦、框体变灰,
                   而这段时间很短,不该让输入框看起来坏掉了 -->
              <textarea
                id="prompt-input"
                ref="promptEl"
                v-model="prompt"
                rows="1"
                :readonly="enhancing"
                aria-label="Prompt"
                placeholder="Describe your image: an orange cat dozing in the sun…"
                @keydown.enter.exact="onEnter"
              />

            </div>

            <!-- 二、参数 icon 行(横线下方),点击 icon 展开对应选项 -->
            <div class="param-bar" ref="paramBarEl" role="group" aria-label="Generation parameters">
              <!-- 出图与改写两个模型共用一个胶囊:分两个各带一份图标与内边距,
                   在参数行里白占近 80px。中间用细线分开,否则两个名字连读成一条 -->
              <button
                class="param-btn has-val"
                :class="{ on: openPanel === 'config', filled: !!configured() }"
                :data-tip="`Image model · ${activeConfigName} / Text model · ${activeTextName}`"
                :aria-label="`Image model: ${activeConfigName}. Text model: ${activeTextName}`"
                @click="togglePanel('config')"
              >
                <PhSlidersHorizontal aria-hidden="true" />
                <b class="param-val param-val-name">{{ activeConfigName }}</b>
                <span class="param-sep" aria-hidden="true"></span>
                <b class="param-val param-val-name param-val-sub">{{ activeTextName }}</b>
              </button>
              <button
                class="param-btn has-val"
                :class="{ on: openPanel === 'n' }"
                :data-tip="`Images · ${n}`"
                aria-label="Count"
                @click="togglePanel('n')"
              >
                <PhSquaresFour aria-hidden="true" />
                <b class="param-val">{{ n }} {{ n === 1 ? 'image' : 'images' }}</b>
              </button>
              <!-- 尺寸/画质/背景/参考图收进这一个入口:参数行默认只留模型与张数,
                   最常改的两个直接可达,其余点开就是完整面板,不必挤成一长排。
                   有非默认值就点亮,免得改过的参数在行上不留痕迹 -->
              <button
                class="param-btn"
                :class="{ on: openPanel === 'more', filled: moreCustom }"
                data-tip="More parameters"
                aria-label="More parameters"
                @click="togglePanel('more')"
              >
                <!-- Phosphor 的 DotsNine(点阵):与上面那几个语义明确的图标区分,专表示"还有更多" -->
                <PhDotsNine weight="fill" aria-hidden="true" />
              </button>

              <!-- 改写/清除/生成收在参数行末尾。
                   改写与撤销是同一个按钮(有原稿可撤时它变成 Undo),
                   这样按钮区不会在两种状态间变宽变窄 -->
              <div class="prompt-actions">
                <!-- 改写按钮 + 档位切换合成一个控件:两者是同一件事(用哪种方式改写),
                     拆成两个独立按钮会重新把按钮区撑宽 -->
                <div class="enhance-split">
                  <button
                    class="enhance-btn"
                    :class="{ undo: canUndo }"
                    :disabled="enhanceDisabled"
                    :data-tip="enhanceTip"
                    :aria-label="enhanceAria"
                    @click="onEnhanceClick"
                  >
                    <!-- 三态各换符号:运行中 = 方块停止(与生成键同一套语言),
                         可撤销 = 回转箭头,其余 = 四角星 -->
                    <PhStop v-if="enhancing" weight="fill" aria-hidden="true" />
                    <PhArrowCounterClockwise v-else-if="canUndo" aria-hidden="true" />
                    <PhSparkle v-else aria-hidden="true" />
                    {{ enhanceText }}
                  </button>
                  <!-- 只两档,点一下来回切,不用下拉。
                       改写中禁用:请求已经发出去了,这时换档只会让按钮上的
                       档位名和正在跑的那一档对不上 -->
                  <button
                    class="enhance-mode"
                    :disabled="enhancing"
                    :data-tip="`Switch to ${nextModeLabel}`"
                    :aria-label="`Switch to ${nextModeLabel} mode`"
                    @click="toggleEnhanceMode"
                  >
                    <PhArrowsLeftRight aria-hidden="true" />
                  </button>
                </div>
                <button
                  v-if="prompt.trim() && !loading && !enhancing"
                  class="clear-icon"
                  aria-label="Clear input"
                  data-tip="Clear"
                  @click="prompt = ''"
                >
                  <PhX aria-hidden="true" />
                </button>
                <button
                  class="gen-icon"
                  :disabled="!loading && (enhancing || !prompt.trim())"
                  :aria-label="loading ? 'Stop' : 'Generate'"
                  :data-tip="loading ? 'Stop' : enhancing ? 'Rewriting the prompt…' : 'Generate with Enter'"
                  @click="loading ? stopGenerate() : doGenerate()"
                >
                  <!-- 生成中变为方块停止键,点击可终止这一批 -->
                  <PhStop v-if="loading" aria-hidden="true" />
                  <PhArrowRight v-else aria-hidden="true" />
                </button>
              </div>
            </div>

            <!-- 展开面板:用 grid-template-rows 动画高度,收起时连续合拢无跳变 -->
            <div class="fold" ref="panelEl" :class="{ open: !!openPanel }">
              <div class="fold-inner">
                <div class="param-panel">
                  <!-- 配置 -->
                  <div v-if="shownPanel === 'config'" class="pp-body">
                    <!-- 出图与改写分两组,各自标各自的"当前";空组不渲染 -->
                    <div v-if="imageConfigs.length" class="pp-group">
                      <span class="pp-label">Image model</span>
                      <button
                        v-for="c in imageConfigs"
                        :key="c.id"
                        class="preset"
                        :class="{ on: config.id === c.id }"
                        :title="`${c.baseUrl}${c.model ? ' · ' + c.model : ''}`"
                        @click="activateConfig(c)"
                      >
                        {{ c.name || 'Untitled config' }}
                      </button>
                    </div>
                    <div v-if="textConfigs.length" class="pp-group">
                      <span class="pp-label">Text model</span>
                      <button
                        v-for="c in textConfigs"
                        :key="c.id"
                        class="preset"
                        :class="{ on: textConfig?.id === c.id }"
                        :title="`${c.baseUrl}${c.model ? ' · ' + c.model : ''}`"
                        @click="activateTextConfig(c)"
                      >
                        {{ c.name || 'Untitled config' }}
                      </button>
                    </div>
                    <!-- 一条都没有时给一个入口;有配置时只管切换,管理走顶部齿轮 -->
                    <div v-if="!configs.length" class="pp-group">
                      <span class="pp-note">No saved configs</span>
                      <button class="pp-action" @click="openConfigManager">Add config</button>
                    </div>
                  </div>

                  <!-- 尺寸 -->
                  <div v-if="shownPanel === 'more'" class="pp-body">
                    <div class="pp-group">
                      <span class="pp-label">Size</span>
                      <button
                        v-for="s in sizeOptions"
                        :key="s"
                        class="preset"
                        :class="{ on: size === s }"
                        :title="s === 'auto' ? 'Let the model pick the size' : ''"
                        @click="size = s"
                      >
                        {{ sizeLabel(s) }}
                      </button>
                      <!-- 手填尺寸并进这一行:它只是尺寸的另一种填法,不是独立参数。
                           固定候选的厂商不开放手填 —— 列表已经是全部合法值,填别的只会被拒 -->
                      <input
                        v-if="sizeFree"
                        class="num-input size-input"
                        :value="size"
                        placeholder="e.g. 1536×1024"
                        spellcheck="false"
                        aria-label="Custom size"
                        @change="commitSize"
                      />
                    </div>
                  </div>

                  <!-- 张数 -->
                  <div v-if="shownPanel === 'n'" class="pp-body">
                    <div class="pp-group">
                      <span class="pp-label">Count</span>
                      <button
                        v-for="c in 4"
                        :key="c"
                        class="preset"
                        :class="{ on: n === c }"
                        @click="n = c"
                      >
                        {{ c }} {{ c === 1 ? 'image' : 'images' }}
                      </button>
                    </div>
                    <div class="pp-group">
                      <span class="pp-label">Custom</span>
                      <input
                        class="num-input"
                        type="number"
                        min="1"
                        :max="N_MAX"
                        :value="n"
                        :placeholder="`1-${N_MAX}`"
                        aria-label="Custom count"
                        @change="clampN"
                      />
                    </div>
                  </div>

                  <!-- 画质:已知不认的厂商不列出来,免得选了却被上游 400 -->
                  <div v-if="shownPanel === 'more' && provider.quality !== 'no'" class="pp-body">
                    <div class="pp-group">
                      <span class="pp-label">Quality</span>
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
                  </div>

                  <!-- 背景 -->
                  <div v-if="shownPanel === 'more' && provider.background !== 'no'" class="pp-body">
                    <div class="pp-group">
                      <span class="pp-label">Background</span>
                      <button
                        v-for="o in BACKGROUND_OPTIONS"
                        :key="o.value"
                        class="preset"
                        :class="{ on: background === o.value }"
                        :title="o.value === 'auto' ? 'Model decides; not sent' : ''"
                        @click="background = o.value"
                      >
                        {{ o.label }}
                      </button>
                    </div>
                  </div>

                  <!-- 参考图放最后:它是一次性的输入,不是常规参数 -->
                  <div v-if="shownPanel === 'more'" class="pp-body">
                    <div class="pp-group">
                      <span class="pp-label">Reference</span>
                      <template v-if="!refImage">
                        <label class="ref-pick" for="ref-file">+ Choose a reference image</label>
                      </template>
                      <template v-else>
                        <img class="pp-thumb" :src="refImage" alt="Reference image" />
                        <span class="pp-note">Reference selected</span>
                        <button class="pp-action" @click="clearRef">Remove</button>
                      </template>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <input id="ref-file" type="file" accept="image/*" hidden @change="onPickRef" />
          </div>

          <!-- 存储清理提示:是提醒不是错误,中性配色 + 可手动关掉 -->
          <div v-if="notice" class="note" role="status">
            <span class="note-msg">{{ notice }}</span>
            <button class="note-close" @click="notice = ''" aria-label="Got it">
              <PhX aria-hidden="true" />
            </button>
          </div>

          <!-- 报错:默认收成一行,过长才给「详情」;真失败过才给「重试」 -->
          <div v-if="error" class="err" role="alert">
            <p class="err-msg" :class="{ clipped: !errorOpen }">{{ error }}</p>
            <div v-if="errorLong || canRetry" class="err-ops">
              <button v-if="errorLong" class="err-btn" @click="errorOpen = !errorOpen">
                {{ errorOpen ? 'Show less' : 'Details' }}
              </button>
              <button v-if="canRetry" class="err-btn" @click="retry">Retry</button>
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
                <PhCaretRight aria-hidden="true" />
              </button>
              <button
                class="sec-fold"
                :title="feedOpen ? 'Collapse' : 'Expand'"
                :aria-expanded="feedOpen"
                @click="feedOpen = !feedOpen"
              >
                <span>{{ feedOpen ? 'Collapse' : 'Expand' }}</span>
                <PhCaretDown :class="{ up: feedOpen }" aria-hidden="true" />
              </button>
            </div>
          </div>

          <div class="fold" :class="{ open: feedOpen }">
            <div class="fold-inner">
              <div class="feed-grid">
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
                  @click="openPreview(t.entry)"
                >
                  <img
                    loading="lazy"
                    decoding="async"
                    :src="imageSrc(t.item)"
                    :alt="t.entry.prompt"
                    @load="onFeedLoad(t.key, t.entry, $event)"
                  />
                  <!-- 悬停浮出短标题与元信息:提示词动辄两三行,压在缩略图上把图挡掉大半,
                       而这块砖是用来扫图的;要读完整提示词点开预览即可 -->
                  <span class="tile-veil">
                    <span class="tile-name">{{ tileTitle(t.entry.prompt) }}</span>
                    <span class="tile-meta">{{ fmtDate(t.entry.createdAt) }} · {{ sizeLabel(t.entry.size) }}</span>
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
        class="page-in"
        :items="libItems"
        @use="useLibItem"
        @remove="removeLibItem"
        @add="addLibItem"
        @import="importLibItems"
      />

      <!-- 历史记录 -->
      <HistoryPage
        v-else-if="page === 'history'"
        class="page-in"
        :items="history"
        @open="openPreview"
        @use="usePreviewPrompt"
        @remove="removeHistoryEntry"
        @mark="toggleMark"
      />

      <!-- 接口设置 -->
      <SettingsPage
        v-else
        class="page-in"
        :configs="configs"
        :active-id="activeId"
        :active-text-id="activeTextId"
        :mode="cfgView"
        :seed="cfgSeed"
        :capability-note="capabilityNote"
        @activate="activateConfig"
        @activate-text="activateTextConfig"
        @edit="editConfig"
        @duplicate="duplicateConfig"
        @remove="removeConfig"
        @create="newConfig"
        @cancel="cancelConfig"
        @save="saveSettings"
        @import="importConfigs"
      />
    </main>

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
      @mark="toggleMark"
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
  font-size: 21px; /* 品牌锁形的一部分,随字标字体一起定,不进正文字阶 */
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
  font-size: 24px; /* 同上:手写体后缀,品牌锁形的一部分,不进正文字阶 */
  font-weight: 400;
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
/* 17px 是照 34px 胶囊定的,导航条加高到 40px 后配套提到 19px,
   与主题按钮的图标同档,两个控件在一行里视觉重量才对得上 */
.nav-seg .seg-ico {
  width: 19px;
  height: 19px;
}
/* 未配置接口时齿轮标红。选中态那层由滑块的反色副本接管,所以排除 .rs-copy */
.nav-seg :deep(.rs-item:not(.rs-copy)[aria-checked='false'] .is-warn) {
  color: var(--danger);
}
.icob {
  position: relative;
  /* 40px 对齐同一行的 .nav-seg(轨道加高后的实际外高),整条导航读作一个高度;
     底色和描边压成半透明:导航浮在背景图上,不透明的胶囊在这里
     比坐在纯色页面里的参数栏重得多 */
  width: 40px;
  height: 40px;
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
  width: 19px;
  height: 19px;
}

.frame {
  margin-top: var(--sp-2);
  display: flex;
  flex-direction: column;
  gap: var(--sp-7);
}

/* 页面切换:新页挂载时自己淡入上浮一下,不再整块硬切。
   只做入场不做离场 —— 分支链是 v-if 直接替换,要离场就得整条链再包一层 <Transition>,
   那 380 行的首页模板要整体多缩进一级;而入+出会让一次点击等上 360ms,工具类反而显拖。
   让新页接住这一下就够,读起来是"落位"而不是"换页" */
.page-in {
  animation: pageIn 240ms var(--ease) both;
}
@keyframes pageIn {
  from {
    opacity: 0;
    transform: translateY(8px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}

.panel {
  background: var(--bg-elev);
  border: 1px solid var(--line);
  border-radius: var(--r-lg);
  padding: var(--sp-6);
  box-shadow: var(--sh-md);
}
.panel-head h2 {
  font-family: var(--font-sans);
  font-weight: 500;
  font-size: var(--fs-2xl);
}
.lede {
  margin-top: 4px;
  color: var(--text-2);
  font-size: var(--fs-base);
}
.composer textarea {
  width: 100%;
  padding: 11px 14px;
  border: 1px solid var(--line);
  border-radius: var(--r-sm);
  background: var(--surface);
  font-size: var(--fs-base);
  transition: border-color var(--dur) var(--ease), box-shadow var(--dur) var(--ease);
}
.composer textarea:focus {
  border-color: var(--accent);
  box-shadow: 0 6px 22px -8px color-mix(in oklch, var(--accent) 40%, transparent);
}
.panel-foot {
  margin-top: var(--sp-6);
  display: flex;
  justify-content: flex-end;
}
.workbench {
  display: flex;
  flex-direction: column;
  gap: var(--sp-6);
}
.hero {
  position: relative;
  text-align: center;
  /* 顶部留白收窄,让标题与输入框整体上移,首屏更快进入内容。
     上一行加了微标签之后又收了一档:标签本身占掉一行的高度,
     不补回来的话标题与输入框会被推低,首屏就挤了 */
  padding: clamp(16px, 3vw, 34px) var(--sp-4) var(--sp-5);
  overflow: hidden;
}
/* 分类微标签:先说"这是什么",再说"它有多好"。
   全大写 + 拉开字距,和下面的大标题是两种读音,不会被当成同一句话的头 */
.hero-eyebrow {
  margin-bottom: var(--sp-3);
  color: var(--text-3);
  font-size: var(--fs-xs);
  font-weight: 500;
  letter-spacing: var(--ls-eyebrow);
  text-transform: uppercase;
  position: relative;
  z-index: 1;
}
.hero-title {
  font-family: var(--font-sans);
  font-weight: 700;
  /* 英文行更长,字号上限与下限都比中文版收一档,避免窄屏被裁切 */
  font-size: clamp(var(--fs-3xl), 5.2vw, 56px);
  letter-spacing: var(--ls-hero);
  line-height: 1.08;
  position: relative;
  z-index: 1;
}
.hero-sub {
  margin-top: var(--sp-4);
  color: var(--text-3);
  font-size: var(--fs-md);
  letter-spacing: var(--ls-wide);
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
  font-size: var(--fs-lg);
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
/* 展开态与"已改过"态都走中性灰:胶囊在这页只是参数的状态显示,
   用紫色会跟页面里唯一该抢注意力的生成键争视线。
   两者靠底色区分 —— 展开有底,仅改过只加重描边 */
.param-btn.on {
  color: var(--text);
  border-color: var(--line-strong);
  background: var(--bg-elev);
}
.param-btn.filled {
  border-color: var(--line-strong);
  color: var(--text);
}
/* 带数值的参数(尺寸/张数):图标右侧直接露出当前值,宽度随内容撑开 */
.param-btn.has-val {
  width: auto;
  gap: 6px;
  padding: 0 12px 0 10px;
}
.param-val {
  font-size: var(--fs-sm);
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
/* 两个模型名之间的细竖线:少了它,两个名字会连读成一条 */
.param-sep {
  flex: none;
  width: 1px;
  height: 11px;
  margin: 0 1px;
  background: var(--line-strong);
}
/* 改写用的文本模型退一档:出图是主流程,它只在按 Enhance 时才起作用。
   胶囊处于高亮/已填态时会被上面那条 color: inherit 接管,统一成一个颜色 */
.param-val-sub {
  color: var(--text-3);
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
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-top: 10px;
  padding: 12px;
  border-radius: var(--r-sm);
  background: var(--bg-elev);
  /* 「更多」面板要一次容下尺寸/画质/背景/参考图四组,190px 会把它切成两屏;
     用 vh 兜住矮视口,宁可在面板内滚动也不把整个输入区顶下去 */
  max-height: min(46vh, 340px);
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
  font-size: var(--fs-xs);
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
  font-size: var(--fs-sm);
  color: var(--text-2);
}
/* 面板里的紧凑数字输入(自定义张数) */
.num-input {
  width: 76px;
  padding: 6px 10px;
  font-size: var(--fs-sm);
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
/* 面板里的文字动作用中性灰:它是个胶囊形状,和上面那排选项同处一个面板,
   一个紫胶囊夹在灰胶囊中间会显得没做完 */
.pp-action {
  font-size: var(--fs-sm);
  color: var(--text);
  padding: 5px 10px;
  border: 1px solid var(--line-strong);
  border-radius: 999px;
  transition: background var(--dur) var(--ease);
}
.pp-action:hover {
  background: var(--surface-hover);
}

.preset {
  padding: 6px 12px;
  font-size: var(--fs-sm);
  border: 1px solid var(--line);
  border-radius: 999px;
  color: var(--text-2);
  background: var(--surface);
  transition: border-color var(--dur) var(--ease), color var(--dur) var(--ease),
    background var(--dur) var(--ease);
}
/* 面板里的选项胶囊同样去紫:它和外层胶囊是一组,外层转灰后里面还紫着会脱节 */
.preset:hover {
  border-color: var(--line-strong);
  color: var(--text);
}
/* 选中态用墨色实心药丸:这是全站"当前项"的语言(生成键、导航滑块同一套)。
   灰底那版压得太轻,一排白胶囊里几乎看不出选的是哪个。
   借 --cta 而不是写死黑色:它在暗色主题会自动反相成白底黑字 */
.preset.on {
  background: var(--cta);
  border-color: var(--cta);
  color: var(--cta-text);
}
.preset.on:hover {
  background: var(--cta-hover);
  border-color: var(--cta-hover);
  color: var(--cta-text);
}
/* 带注解的胶囊(画质档位):主标签 + 一句代价说明,同一行排布 */
.preset-rich {
  display: inline-flex;
  align-items: baseline;
  gap: 6px;
}
.preset-hint {
  font-style: normal;
  font-size: var(--fs-micro);
  color: var(--text-3);
  transition: color var(--dur) var(--ease);
}
.preset-rich:hover .preset-hint {
  color: var(--text-2);
}
.preset-rich.on .preset-hint {
  color: inherit;
  opacity: 0.75;
}

/* 参考图选择 */
.ref-pick {
  padding: 8px 14px;
  font-size: var(--fs-sm);
  border: 1px dashed var(--line-strong);
  border-radius: var(--r-sm);
  color: var(--text-2);
  cursor: pointer;
  transition: all var(--dur) var(--ease);
}
.ref-pick:hover {
  border-color: var(--line-strong);
  color: var(--text);
}

.err {
  margin-top: var(--sp-2);
  color: var(--danger);
  font-size: var(--fs-sm);
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
  font-size: var(--fs-sm);
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
  font-size: var(--fs-xs);
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
/* 提示词改写:与参数按钮同尺寸、同描边语言。
   描边由外层 .enhance-split 提供 —— 按钮和档位切换要读成一个控件。
   底色透明、高 34px:和旁边的清除键、生成键完全同规格,
   否则这一排里会出现三个填色不同、差 2px 高的控件 */
.enhance-split {
  display: inline-flex;
  align-items: stretch;
  flex-shrink: 0;
  height: 34px;
  border: 1px solid var(--line);
  border-radius: 999px;
  background: transparent;
  overflow: hidden;
  transition: border-color var(--dur) var(--ease);
}
.enhance-split:hover {
  border-color: var(--line-strong);
}
/* 档位切换:竖线把它和改写按钮分开,复用它右边两个图标键的分隔语言 */
.enhance-mode {
  display: flex;
  align-items: center;
  flex-shrink: 0;
  padding: 0 9px 0 7px;
  border: none;
  border-left: 1px solid var(--line);
  background: none;
  color: var(--text-3);
  cursor: pointer;
  transition: color var(--dur) var(--ease), background var(--dur) var(--ease);
}
.enhance-mode:hover:not(:disabled) {
  color: var(--text);
  background: var(--bg-elev);
}
.enhance-mode svg {
  width: 13px;
  height: 13px;
}
.enhance-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  flex-shrink: 0;
  /* 高度交给外层:自己再定 34px 会把带描边的外层撑到 36px */
  padding: 0 12px;
  border: none;
  background: none;
  color: var(--text-2);
  font-size: var(--fs-sm);
  cursor: pointer;
  transition: color var(--dur) var(--ease), background var(--dur) var(--ease);
}
/* 16px 与清除键、生成键的图标同档 */
.enhance-btn svg {
  width: 16px;
  height: 16px;
  flex-shrink: 0;
}
.enhance-btn:hover:not(:disabled) {
  color: var(--text);
  background: var(--bg-elev);
}
.enhance-btn:disabled,
.enhance-mode:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
/* 撤销态:同一个按钮,压轻一档表示"这是往回走"而不是再改写一次 */
.enhance-btn.undo {
  color: var(--text-3);
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
  font-family: var(--font-sans);
  font-size: var(--fs-xl);
  font-weight: 600;
  letter-spacing: var(--ls-tight);
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
  font-size: var(--fs-sm);
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
  /* 定宽多列,和历史图墙同一套:列数只由容器宽度决定,不随图片数量变。
     之前列数是 min(4, 图数 + 生成中张数) 算出来的,后果有两个 ——
     第一次生成时只有 1 列,占位块会铺满整行(约 1000px 的正方块);
     而且每多生成一张就换一次列数,已有的图全部重排、尺寸跟着变 */
  column-width: 240px;
  column-gap: var(--sp-3);
  opacity: 0;
  transition: opacity var(--dur) var(--ease);
}
.fold.open .feed-grid {
  opacity: 1;
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
/* 角标:默认隐去,悬停/聚焦时浮出短标题与元信息。
   不放完整提示词 —— 两行文字会把缩略图挡掉大半,读提示词交给预览卡 */
.tile-veil {
  position: absolute;
  inset: auto 0 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 18px 12px 10px;
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
/* 标题比元信息重一档:图砖先被"叫什么"抓住,时间尺寸是补注 */
.tile-name {
  font-size: var(--fs-base);
  font-weight: 500;
  letter-spacing: var(--ls-tight);
  /* 只留一行。提示词长短不一,不裁的话长的会把图盖掉一半 —— 
     这跟"不放完整提示词"是同一条理由 */
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.tile-meta {
  font-size: var(--fs-micro);
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

/* 窄屏不用再专门收窄列数了:定宽多列会自己退成一列 */
@media (max-width: 640px) {
  .feed-grid {
    column-gap: var(--sp-2);
  }
  .tile {
    margin-bottom: var(--sp-2);
  }
  .prompt-box {
    border-radius: var(--r);
  }
  /* 导航改两行:第一行品牌与主题按钮分居两端,第二行视图切换占满整行居中。
     三栏(1fr auto 1fr)在 375px 下左右各只剩约 60px,品牌字标会被挤坏 */
  .masthead {
    grid-template-columns: 1fr auto;
    padding: var(--sp-3) 0;
  }
  .wordmark {
    grid-row: 1;
    grid-column: 1;
    justify-self: start;
  }
  .mast-actions {
    grid-row: 1;
    grid-column: 2;
    justify-self: end;
  }
  .nav-seg {
    grid-row: 2;
    grid-column: 1 / -1;
    justify-self: center;
  }
  /* 触控目标放大到 40px:34px 在手机上容易点错,40px 兼顾参数栏不至于过高 */
  .param-btn {
    width: 40px;
    height: 40px;
  }
  .param-btn svg {
    width: 18px;
    height: 18px;
  }
  /* 桌面 19px,窄屏跟着胶囊一起再提一档,图标与圆底的比例才不会显得变空。
     .icob 本体不再单列:桌面已是 40px,这里再写一遍是死规则 */
  .icob svg {
    width: 20px;
    height: 20px;
  }
  /* iOS Safari 聚焦字号 <16px 的输入框会放大整页,面板内的数字/尺寸输入提到 16px */
  .num-input {
    font-size: var(--fs-lg);
  }
  /* 底部三个动作键跟着参数胶囊一起升到 40px:触控目标要一致,
     只升一半的话它们会比左边那排小一圈,手指点起来也明显更难点中 */
  .enhance-split {
    height: 40px;
  }
  .clear-icon,
  .gen-icon {
    width: 40px;
    height: 40px;
  }
  .clear-icon svg,
  .gen-icon svg,
  .enhance-btn svg {
    width: 18px;
    height: 18px;
  }
  /* 档位开关也得够宽:桌面靠左右内边距到约 29px,手指点不准。
     改成定宽居中,图标仍比主键小一档 —— 它是这个控件里的次级动作 */
  .enhance-mode {
    justify-content: center;
    min-width: 40px;
    padding: 0;
  }
}
</style>
