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
import UndoToast from './components/UndoToast.vue'
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
  normalizePrompt,
  getProvider,
  inferVendor,
  allowedSizes,
  imageSrc,
  makeThumb,
  backfillThumbs,
  releaseEntryMedia,
  releaseSrc,
  QUALITY_OPTIONS,
  BACKGROUND_OPTIONS
} from './api'
import { blobToDataURL, urlToBlob } from './lib/idb'
import { titleFromPrompt } from './lib/text'
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
/* 随机种子。留空表示"不发这个参数",交给上游随机。
   注意它和 quality/background 的 auto 不是一回事:那两个的 'auto' 是"不传"的哨兵值,
   这里空着才是"不传"。上游从不告诉我们它实际用了哪个数,所以这里只能由用户自己填,
   填了才有"同一张图再微调"可言 */
const seed = ref('')
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

/* ===== 删除的撤销窗口 ================================================
   删除不再弹确认框,而是立刻生效、几秒内可撤销(见 components/UndoToast.vue)。
   关键在于:真正落盘的删除发生在窗口结束时(见 purge),窗口里数据一直还在 ——
   所以"撤销"只是把它放回列表,不需要从磁盘上把东西搬回来。
   同一时刻只保留一次待撤销:再来一次删除就把上一次落盘,否则两枚按钮会各烧各的。
   ------------------------------------------------------------------ */
interface PendingUndo {
  /** 换一次删除就换一个 token,撤销条据此重新点燃 */
  token: string
  /** 说明删掉了什么 */
  label: string
  /** 把东西放回列表,并把恢复后的状态落盘 */
  undo: () => void
  /** 窗口结束:真正落盘删除,释放图片地址 */
  purge: () => void
}
const pendingUndo = ref<PendingUndo | null>(null)
/** 4.5 秒:够看清删了什么、也够反悔,又不至于让这条一直挂在屏幕上 */
const UNDO_MS = 4500

function scheduleUndo(item: Omit<PendingUndo, 'token'>) {
  pendingUndo.value?.purge()
  pendingUndo.value = { ...item, token: uid() }
}
// 保险丝烧完 = 用户接受了这次删除
function commitUndo() {
  const p = pendingUndo.value
  pendingUndo.value = null
  p?.purge()
}
function runUndo() {
  const p = pendingUndo.value
  pendingUndo.value = null
  p?.undo()
}
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
  // 带上模型:能力表按 (厂商, 模型) 解析 —— 中转上同一个地址的模型可能走不同协议
  return getProvider(cfg.vendor || inferVendor(cfg.baseUrl), cfg.model)
})
// 设置页表头那句能力说明:描述的是当前生效的那个接口,不是表单里正在挑的。
// 界面上的参数门控本来就照生效配置来,说明文字要是跟着草稿走,两者就对不上了
const capabilityNote = computed(() => {
  const p = provider.value
  const t = (c: Cap) => (c === 'yes' ? 'Yes' : c === 'no' ? 'No' : 'Varies')
  /* Gemini 的图生图没有独立端点:参考图是同一个 :generateContent 里的另一段 parts。
     照 edit 字段写就会显示成 /images/generations,那是错的 */
  const i2i =
    p.protocol === 'gemini'
      ? ':generateContent'
      : p.edit === 'edits'
        ? '/images/edits'
        : '/images/generations'
  return `Active API: quality ${t(p.quality)} · background ${t(p.background)} · image-to-image via ${i2i}`
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
    (provider.value.seed !== 'no' && !!seed.value.trim()) ||
    !!refImage.value
)

/* 种子的实际取值:空着、或厂商明确不支持就不发。范围按 32 位有符号整数收 ——
   各家都在这条线以内,再大的值上游只当非法 */
const seedValue = computed(() => {
  const raw = seed.value.trim()
  if (!raw) return undefined
  const v = Math.round(Number(raw))
  return Number.isFinite(v) && Math.abs(v) <= 2147483647 ? v : undefined
})
function seedFor(cfg: ApiConfig = config.value): number | undefined {
  const caps = getProvider(cfg.vendor || inferVendor(cfg.baseUrl), cfg.model)
  return caps.seed === 'no' ? undefined : seedValue.value
}
// 手填种子:失焦/回车时收敛成整数并回写输入框;认不出来就清空(= 交给上游随机)
function commitSeed(e: Event) {
  const el = e.target as HTMLInputElement
  const v = Math.round(Number(el.value))
  seed.value =
    el.value.trim() !== '' && Number.isFinite(v) && Math.abs(v) <= 2147483647 ? String(v) : ''
  el.value = seed.value
}

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

/* 按厂商能力决定携带哪些扩展参数:已知不支持的一律不发。
   默认按当前生效配置算;对比出图时逐个传入 —— 同一次对比里各模型的
   可用参数并不一样(OpenAI 认 quality,豆包不认),不能拿一家的能力套所有家 */
function extraParams(cfg: ApiConfig = config.value): Record<string, string> {
  const caps = getProvider(cfg.vendor || inferVendor(cfg.baseUrl), cfg.model)
  const out: Record<string, string> = {}
  if (caps.quality !== 'no' && quality.value !== 'auto') out.quality = quality.value
  if (caps.background !== 'no' && background.value !== 'auto') out.background = background.value
  return out
}

/* 对比出图时按每个模型各自校验尺寸:候选是固定列表的厂商(OpenAI 只认那几档),
   当前尺寸不在它的列表里就退回它自己的第一档,而不是硬发一个它不认的值。
   退回是必要的妥协 —— 各模型支持的尺寸本来就不完全重合,
   并排面板里会把每张实际用的尺寸写出来,所以这个差异是看得见的 */
function sizeFor(cfg: ApiConfig): string {
  const allowed = allowedSizes(
    getProvider(cfg.vendor || inferVendor(cfg.baseUrl), cfg.model).id,
    cfg.model
  )
  if (allowed === 'free') return size.value
  return allowed.includes(size.value) ? size.value : allowed[0] || 'auto'
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

/* —— 对比出图(Model Race) ——
   把同一句提示词一次发给多个出图配置,并排看结果。这是"自带多家模型"才有的事:
   官方 app 只能跑自家模型。代价是花费按模型数翻倍。
   没有单独的"对比"开关:芯片本来就是多选,选一个 = 平时那样,选两个以上 = 对比 */
const selectedIds = ref<string[]>([])
// 一次最多几个:花费线性增长,四个已经排满一屏
const RACE_MAX = 4
// 参与这次生成的配置。存 id 不存配置对象:设置页改了名字或地址,这里自动跟着走
const selectedConfigs = computed(() =>
  imageConfigs.value.filter((c) => selectedIds.value.includes(c.id))
)
// 多选即对比
const compareMode = computed(() => selectedConfigs.value.length > 1)
/* 对比模式下每个模型只出一张(见 doRace):张数入口停用,并且如实显示 1 ——
   否则行上还写着"3 images",用户会以为三家各出三张。
   n 本身不动:退出对比模式后,之前设的张数原样回来 */
const shownN = computed(() => (compareMode.value ? 1 : n.value))
/* 加选到第二个模型时,张数面板已经没意义了(下一刻入口就会被停用),顺手收起 ——
   留着它只会让人以为还能改 */
watch(compareMode, (on) => {
  if (on && openPanel.value === 'n') openPanel.value = ''
})
// 一个槽位 = 一个模型 × 这一次请求。results 为空表示还没回来
type RaceSlot = {
  configId: string
  label: string
  model: string
  size: string
  // 发起时锁定的扩展参数:各模型不一样(OpenAI 有 quality,豆包没有)
  extras: Record<string, string>
  // 发起时锁定的种子(该模型认 seed 且用户填了才有)
  seed?: number
  state: 'running' | 'done' | 'stopped' | 'error'
  results: ResultItem[]
  error?: string
  elapsedMs?: number
  // 落盘后指向历史记录,点开预览要用
  entryId?: string
}
const raceSlots = ref<RaceSlot[]>([])
// 这一批用的提示词:槽位里不各存一份,它们本来就是同一句
const racePrompt = ref('')
// 同一次对比的各条记录共用一个分组 id
const raceGroupId = ref('')
const raceRunning = computed(() => raceSlots.value.some((s) => s.state === 'running'))
/* 图墙的占位格子:单模型看张数,对比看模型数 —— 数量不同,形式一样。
   对比进行中刻意不走"一排对比槽位"那套骨架:还没有图可比,那种布局把页面
   切成另一副样子,出图后又得切回来 */
const skeletonCount = computed(() =>
  raceRunning.value ? raceSlots.value.length : running.value.n > 0 ? running.value.n : 1
)
// 占位按发起时锁定的尺寸取比例;对比时各家尺寸可能不同,取第一个就够
const skeletonSize = computed(() =>
  raceRunning.value ? raceSlots.value[0]?.size || size.value : running.value.size
)
/* 参数行上的出图胶囊:多选时写成"主模型 +N"。这里必须说清楚 ——
   点一下芯片就从单模型变成多模型,生成键又只是个图标,
   不在胶囊上写明"这次要跑几个",加选一个模型就会变成一次双倍花费的意外 */
const imagePillName = computed(() =>
  compareMode.value
    ? `${activeConfigName.value} +${selectedConfigs.value.length - 1}`
    : activeConfigName.value
)
const selectionTip = computed(() => {
  const names = selectedConfigs.value.map((c) => c.name || c.model || 'Untitled config')
  return compareMode.value
    ? `Running ${names.length} models: ${names.join(', ')} · Text model · ${activeTextName.value}`
    : `Image model · ${activeConfigName.value} / Text model · ${activeTextName.value}`
})
const selectionAria = computed(() =>
  compareMode.value
    ? `Running ${selectedConfigs.value.length} image models. Text model: ${activeTextName.value}`
    : `Image model: ${activeConfigName.value}. Text model: ${activeTextName.value}`
)

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
    // 选择集合起手就是"当前这一条":单选是常态,多选是用户一个个点出来的
    selectedIds.value = [active.id]
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
  /* 库封面存在 IndexedDB 里,读取因此是异步的(见 api.ts 的 loadPrompts)。
     不 await —— 首页不必等它,提示词库页挂载时数据早到了 */
  loadPrompts().then((list) => (libItems.value = list))
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
    /* 选择集合里必须有"当前"这条,否则参数行胶囊写着它、生成用的却是别的。
       新建一条时直接收敛成只选它(刚建好就是要用它);改一条已有的,
       缺了才补上,不能把正在做的多模型对比打散。已经选满则同样收敛 */
    if (!selectedIds.value.includes(cfg.id)) {
      selectedIds.value =
        idx < 0 || selectedIds.value.length >= RACE_MAX ? [cfg.id] : [...selectedIds.value, cfg.id]
    }
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
/* 删除一条配置;若删的是激活项,自动激活剩余第一条。
   删除本身立刻改列表,但落盘推迟到撤销窗口结束 —— 于是"撤销"只要把这一条
   放回去、并把「当前生效」的指向恢复即可,不必从磁盘上搬回来。
   恢复时用的是"当前列表 + 插回这一条",不是整份旧快照:
   窗口里万一正好改了别的配置,不该被这次撤销一起回滚 */
function removeConfig(c: ApiConfig) {
  const at = configs.value.findIndex((x) => x.id === c.id)
  if (at < 0) return
  const wasActive = activeId.value === c.id
  const wasActiveText = activeTextId.value === c.id
  const wasSelected = selectedIds.value.includes(c.id)

  /* 选择集合里也要摘掉它:被删的那条不再参与生成,但它留在集合里会让
     长度算错 —— 剩两条其实只剩一条,却仍被当成对比模式。摘完一个不剩就退回当前这条 */
  configs.value = configs.value.filter((x) => x.id !== c.id)
  // 占着各自「当前生效」的那条被删掉时,同样要按用途重新挑一条,免得生效值悬空
  if (wasActiveText) {
    const nextText = configs.value.find((x) => x.kind === 'text')
    if (nextText) {
      activateTextConfig(nextText)
    } else {
      textConfig.value = null
      activeTextId.value = ''
      saveActiveTextId('')
    }
  }
  if (wasActive) {
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
  selectedIds.value = selectedIds.value.filter((id) => id !== c.id)
  if (!selectedIds.value.length && config.value.id) selectedIds.value = [config.value.id]

  scheduleUndo({
    label: 'Config deleted',
    undo: () => {
      configs.value = [
        ...configs.value.slice(0, Math.min(at, configs.value.length)),
        c,
        ...configs.value.slice(Math.min(at, configs.value.length))
      ]
      if (wasSelected && !selectedIds.value.includes(c.id)) {
        selectedIds.value = [...selectedIds.value, c.id]
      }
      // 恢复「当前生效」的指向。它当初是被这次删除夺走的,现在物归原主
      if (wasActive) {
        config.value = { ...c }
        activeId.value = c.id
        saveActiveId(c.id)
      }
      if (wasActiveText) {
        textConfig.value = { ...c }
        activeTextId.value = c.id
        saveActiveTextId(c.id)
      }
      saveConfigs(configs.value)
    },
    purge: () => saveConfigs(configs.value)
  })
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

/* 保存提示词库。封面现在写在 IndexedDB(见 api.ts 的 savePrompts),
   失败的概率比从前低得多,但一旦失败仍然要说一声 —— 否则用户以为存好了 */
async function persistLib() {
  if (!(await savePrompts(libItems.value))) {
    notice.value = 'Not enough local storage. Prompts saved, but their covers were not.'
  }
}
async function useLibItem(item: PromptItem) {
  prompt.value = item.prompt
  applySize(item.size)
  // 画质/背景同样过一遍能力表:库里存的可能是别家厂商支持的档位
  if (item.quality && provider.value.quality !== 'no') quality.value = item.quality
  if (item.background && provider.value.background !== 'no') background.value = item.background
  /* 记一次取用。这是库里唯一一个"随时间变化"的数字,它回答的是
     "我到底在用哪些提示词" —— 不记的话,一年后翻库只能靠感觉 */
  item.uses = (item.uses || 0) + 1
  await persistLib()
  // 关掉库页就等于切回首页;回顶部由 navView 的 watch 统一负责,这里不必再来一次
  page.value = 'home'
}
function removeLibItem(id: string) {
  const at = libItems.value.findIndex((i) => i.id === id)
  if (at < 0) return
  const gone = libItems.value[at]
  libItems.value = libItems.value.filter((i) => i.id !== id)
  scheduleUndo({
    label: 'Prompt deleted',
    undo: () => {
      // 放回原来的位置:列表顺序是有意义的(最近存的在最前)
      libItems.value.splice(Math.min(at, libItems.value.length), 0, gone)
      // 撤销要立刻落盘:窗口里别的操作可能已经把"它不在"写进去了
      persistLib()
    },
    purge: () => {
      /* 封面用过的 object URL 到这时才撤:blob URL 会强引用住 Blob,
         不撤就回收不了 —— 但窗口里撤销回来还要用它渲染,提前撤就是裂图 */
      releaseSrc(gone.cover)
      persistLib()
    }
  })
}
/* 新建与编辑走同一个出口:按 id 判断是插入还是覆盖。
   分成两个 emit 会让"编辑"这件事在库页多一次分支判断,而它本来就只是"存一条" */
async function saveLibItem(item: PromptItem) {
  const idx = libItems.value.findIndex((i) => i.id === item.id)
  if (idx >= 0) libItems.value[idx] = item
  else libItems.value = [item, ...libItems.value]
  await persistLib()
}
async function importLibItems(items: PromptItem[]) {
  /* 内容是外部文件,逐条规整:缺 prompt 的记录会让列表渲染崩掉,必须在入口拦掉。
     封面只在旧版备份里才有,而且是 320px 的 data URL 缩略图 —— 转成 Blob 收下,
     比没有强;尺寸够不够清楚不是导入这一步该管的事 */
  const clean: PromptItem[] = []
  for (const i of items) {
    if (!i || typeof i.prompt !== 'string' || !i.prompt.trim()) continue
    const thumb = typeof i.thumb === 'string' && i.thumb.startsWith('data:image/') ? i.thumb : ''
    const item = normalizePrompt({
      ...i,
      id: i.id || uid(),
      prompt: i.prompt,
      cover: i.cover instanceof Blob ? i.cover : undefined,
      thumb: undefined,
      createdAt: typeof i.createdAt === 'number' ? i.createdAt : Date.now()
    })
    if (!item.cover && thumb) {
      try {
        item.cover = await urlToBlob(thumb)
      } catch {
        /* 坏封面丢掉,不影响这条提示词 */
      }
    }
    clean.push(item)
  }
  libItems.value = [...clean, ...libItems.value]
  await persistLib()
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
/* 参考图的存档副本:配方要能完整复现,就得连参考图一起留下 ——
   hasRef 只说得出"用过参考图",说不出是哪一张,重跑时就会悄悄退化成文生图。
   压到最长边 512(它只当参考用,不需要原分辨率),存 Blob 不存 data URL,
   与结果图同一套。压不出来就返回 undefined,按"没存档"处理,不阻断生成 */
async function refThumbOf(src: string): Promise<Blob | undefined> {
  if (!src) return undefined
  try {
    const out = await compressImage(src, 512, 0.72)
    return /^data:image\//.test(out) ? await urlToBlob(out) : undefined
  } catch {
    return undefined
  }
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
  // 选了多个模型时走另一条链路:一次发给每个模型,结果并排
  if (compareMode.value) {
    await doRace()
    return
  }

  // 发起前锁定这一批的参数,后面一律读快照,避免中途改参数串味
  running.value = { prompt: prompt.value, size: size.value, n: n.value }
  // 扩展参数与参考图同样要快照:它们在 await 期间可能被改动
  const extras = extraParams()
  // 种子也是快照的一部分:中途改它不该影响已经发出的这一批
  const seedNum = seedFor()
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
        ...(seedNum !== undefined ? { seed: seedNum } : {}),
        // 由厂商能力表决定带哪些扩展参数:auto 与已知不支持的都不发
        ...extras
      },
      config.value,
      controller.value.signal
    )
    const record = await recordFor(res, {
      prompt: running.value.prompt,
      size: running.value.size,
      model: config.value.model || undefined,
      // 只记真正发出去的扩展参数,免得预览里展示出当时并没生效的档位
      quality: extras.quality,
      background: extras.background,
      hasRef: !!refSrc,
      configId: config.value.id,
      seed: seedNum,
      refSrc: refSrc || undefined,
      elapsedMs: Date.now() - startedAt
    })
    await persist(record)
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

/* 把一组结果包成一条历史记录,并补上缩略图与真实像素。
   缩略图要在入列表和落盘之前补上:入列表后拿到的是响应式代理,
   在代理上改动不会回写到这里的原始对象,而 idb 又只接受原始对象。
   同时把量到的真实像素写进记录,图墙就能按真实比例排,而不是按所选尺寸 */
async function recordFor(
  res: ResultItem[],
  meta: {
    prompt: string
    size: string
    model?: string
    quality?: string
    background?: string
    hasRef?: boolean
    groupId?: string
    elapsedMs: number
    // 完整配方里其余的三项:重跑时要用它们还原当时的条件
    configId?: string
    seed?: number
    // 参考图本体(data URL)。存一份压过的小图,不然"当时用了哪张参考图"就丢了
    refSrc?: string
  }
): Promise<HistoryEntry> {
  const record: HistoryEntry = {
    id: Date.now() + Math.random().toString(16).slice(2),
    prompt: meta.prompt,
    size: meta.size,
    model: meta.model,
    quality: meta.quality,
    background: meta.background,
    hasRef: meta.hasRef,
    groupId: meta.groupId,
    configId: meta.configId,
    seed: meta.seed,
    elapsedMs: meta.elapsedMs,
    createdAt: Date.now(),
    results: res
  }
  const t = await makeThumb(res[0])
  if (t) {
    record.thumb = t.blob
    record.w = t.w
    record.h = t.h
  }
  if (meta.refSrc) record.ref = await refThumbOf(meta.refSrc)
  return record
}

/* 一条记录:入内存 + 落盘。裁剪与落盘失败的处置只有这一处,
   生成与对比出图的每条结果都走它 */
async function persist(record: HistoryEntry) {
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
    // 但必须如实告知刷新会丢 —— 不能混进"生成失败"的提示里
    notice.value = 'Image generated, but not saved locally. It will be lost on refresh — download it first.'
  }
}

/* —— 对比出图 ——
   同一提示词并发发给每个选中的模型。单个槽位自己吞掉异常,一个失败不影响其他 ——
   这正是这个功能最值钱的地方:并排就能看出是"提示词不行"还是"某个模型不行" */
async function doRace() {
  // 没地址或没密钥的配置发不出去,先摘掉:参与生成的必须是能真跑的
  const targets = selectedConfigs.value.filter((c) => c.baseUrl && c.apiKey)
  if (targets.length < 2) {
    fail('Pick at least 2 image models with a base URL and an API key to compare')
    openPanel.value = 'config'
    return
  }
  const runPrompt = prompt.value
  const refSrc = refImage.value
  racePrompt.value = runPrompt
  raceGroupId.value = `race-${Date.now().toString(36)}`
  /* 尺寸与扩展参数在发起前逐配置定下来:中途改参数不该影响已经发出的这一批,
     而且各模型的合法尺寸/参数本来就不一样,不能拿一家的能力套所有家 */
  raceSlots.value = targets.map((c) => ({
    configId: c.id,
    label: c.name || c.model || c.baseUrl,
    model: c.model || '',
    size: sizeFor(c),
    extras: extraParams(c),
    seed: seedFor(c),
    state: 'running',
    results: []
  }))
  controller.value = new AbortController()
  const signal = controller.value.signal

  loading.value = true
  error.value = ''
  notice.value = ''
  canRetry.value = false
  try {
    /* 张数固定 1:对比要看的是"哪个模型更好",不是每个模型各来三张。
       并发发出 —— 串行的话总耗时是各家之和,等起来没法用 */
    await Promise.all(
      targets.map(async (cfg, i) => {
        const slot = raceSlots.value[i]
        const slotStart = Date.now()
        try {
          const res = await generate(
            {
              prompt: runPrompt,
              size: slot.size,
              n: 1,
              ...(refSrc ? { image: refSrc } : {}),
              ...(slot.seed !== undefined ? { seed: slot.seed } : {}),
              ...slot.extras
            },
            cfg,
            signal
          )
          slot.results = res
          slot.elapsedMs = Date.now() - slotStart
          slot.state = 'done'
        } catch (e: any) {
          // 主动终止不是失败,但要说清是"你停的",不是模型坏了
          slot.state = e?.name === 'AbortError' ? 'stopped' : 'error'
          // 上游原文可能很长,槽位里放不下;完整内容挂在节点的 title 上
          if (slot.state === 'error') {
            slot.error = String(e?.message || 'Generation failed').slice(0, 300)
          }
        }
      })
    )
    /* 跑完的槽位落进历史:它们已经是用户看得见的图,不存就等于关掉面板就没了。
       (单模型那条路中断后不入历史 —— 那时根本没有图可言,这里不一样) */
    for (const slot of raceSlots.value) {
      if (slot.state !== 'done' || !slot.results.length) continue
      /* 必须取原始数组:槽位上的 results 是响应式代理,而 indexedDB 用结构化克隆
         写盘,代理克隆不了(DataCloneError),记录会写不进去 —— 界面看着图还在
         (内存里有),刷新就没了,还会误报"没能保存到本地" */
      const results = toRaw(slot.results)
      const record = await recordFor(results, {
        prompt: runPrompt,
        size: slot.size,
        model: slot.model || undefined,
        quality: slot.extras.quality,
        background: slot.extras.background,
        hasRef: !!refSrc,
        groupId: raceGroupId.value,
        configId: slot.configId,
        seed: slot.seed,
        refSrc: refSrc || undefined,
        elapsedMs: slot.elapsedMs || 0
      })
      slot.entryId = record.id
      await persist(record)
    }
    // 全盘皆输才占用错误区;部分成功不报错 —— 成败各自写在槽位里
    if (raceSlots.value.every((s) => s.state === 'error')) {
      fail('Every model failed. See the compare panel for each error.', true)
    }
  } finally {
    loading.value = false
    controller.value = null
  }
}

/* 关掉对比面板:图已经落进历史了,关掉只是回到图墙。
   跑动中不给关(那时头部只写"Comparing…")—— 否则已经回来的那几个槽位
   还没走到落盘那一步,关掉就等于把它们扔了 */
function dismissRace() {
  raceSlots.value = []
  racePrompt.value = ''
}

// 点开某个槽的大图:它在历史里已经是一条普通记录,复用同一个预览卡
function openRaceSlot(s: RaceSlot) {
  const entry = history.value.find((h) => h.id === s.entryId)
  if (entry) openPreview(entry)
}

// 槽位第二行:配置名(与模型名重复时省掉)、尺寸、耗时或状态
function raceMeta(s: RaceSlot) {
  const parts: string[] = []
  if (s.label && s.label !== s.model) parts.push(s.label)
  parts.push(sizeLabel(s.size))
  if (s.state === 'error') parts.push('failed')
  else if (s.state === 'stopped') parts.push('stopped')
  else if (s.state === 'done') parts.push(`${((s.elapsedMs || 0) / 1000).toFixed(1)}s`)
  return parts.join(' · ')
}

/* 点芯片 = 加入/移出这次生成。这就是全部的开关:选一个跟平时一样,选两个以上就是对比 */
function toggleSelectedId(id: string) {
  if (selectedIds.value.includes(id)) {
    // 至少要留一个:一个都不选,生成键就无事可做了
    if (selectedIds.value.length <= 1) return
    selectedIds.value = selectedIds.value.filter((x) => x !== id)
    /* 卸掉的正好是主模型时要顺位给剩下的第一个:尺寸候选、画质门控、
       改写风格都照主模型来,不能让"当前"指向一个已经不在选择里的配置 */
    if (config.value.id === id) {
      const next = imageConfigs.value.find((c) => selectedIds.value.includes(c.id))
      if (next) activateConfig(next)
    }
    return
  }
  if (selectedIds.value.length >= RACE_MAX) return
  selectedIds.value = [...selectedIds.value, id]
}

// 终止当前批次(单模型与对比共用同一个 controller)
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

/* 短标题的派生逻辑在 lib/text.ts:图砖角标与提示词库卡片共用同一个口径。
   完整提示词仍然只挂在 img 的 alt 上(读屏能拿到),角标里不出现,免得挡图 */

function openPreview(entry: HistoryEntry) {
  previewEntry.value = entry
}
function closePreview() {
  previewEntry.value = null
}
// 复现一条记录:提示词连同当时的参数一起带回,但只套用当前厂商认得的项
/* 从历史取用一条记录的完整配方。顺序要紧:先切配置,后面几项的能力校验
   才会按"当时那个模型"来判,而不是按切换前那个 */
function usePreviewPrompt(p: ReuseParams) {
  prompt.value = p.prompt
  /* 配置先还原 —— 配方里最容易漏、又最影响结果的就是"当时用的哪个模型"。
     不还原它,重跑用的其实是当前生效的那个:换了模型却以为是在同一张图上微调。
     配置已被删掉时保持当前这条,但要说一声,别让人以为还原成了 */
  if (p.configId && p.configId !== config.value.id) {
    const c = configs.value.find((x) => x.id === p.configId && x.kind !== 'text')
    if (c) activateConfig(c)
    else notice.value = 'The model this image used is no longer in your configs — using the current one.'
  }
  applySize(p.size)
  if (p.n) n.value = Math.min(N_MAX, Math.max(1, p.n))
  // 已知不支持的厂商直接跳过,免得把界面上根本不存在的档位偷偷塞进去
  if (p.quality && provider.value.quality !== 'no') quality.value = p.quality
  if (p.background && provider.value.background !== 'no') background.value = p.background
  seed.value = p.seed !== undefined ? String(p.seed) : ''
  /* 参考图整项覆盖,而不是"有才设":这条记录当初没用参考图,却留着上一张的
     参考图,下一次生成就会悄悄变成图生图 —— 那是最不该发生的意外 */
  refImage.value = p.ref || ''
  // 从历史页取用要先回到首页,否则参数填进去了却看不见输入框
  page.value = 'home'
  // 已经在首页时上面这次赋值不会触发滚动(navView 没变),所以这里补一次
  window.scrollTo({ top: 0, behavior: 'smooth' })
  // 这个动作的目的就是"改一个变量再跑",所以把光标直接放回输入框
  focusPrompt()
}

/**
 * 生成提示词封面。
 *
 * 存的是原图,不是缩略图:封面同时铺在库页卡片和详情左栏上,原来那张
 * 320px 的缩略图在那个尺寸下一眼就糊(它当年压那么小,只是因为封面挤在
 * localStorage 的 5MB 里;现在封面在 IndexedDB,没有这个约束了)。
 *
 * 之所以还留一个上限:4000px 的图光解码就占几十 MB 内存,库里几十张一起
 * 铺开会把页面拖死;1600 已经够卡片和详情在 2× 屏上显示得干干净净。
 * 没超过上限时一次编码都不做 —— compressImage 在那种情况会把输入原样返回,
 * 于是这里直接把原始载荷存下来,画质一点不丢。
 */
const COVER_MAX = 1600
async function coverOf(item: ResultItem | undefined): Promise<Blob | undefined> {
  if (!item) return undefined
  const src = imageSrc(item)
  if (!src) return undefined
  try {
    const out = await compressImage(src, COVER_MAX, 0.9)
    const blob =
      out === src && item.data instanceof Blob
        ? item.data
        : // 超限走了 canvas(或旧记录是 data URL):取回字节
          await urlToBlob(out)
    return blob.type.startsWith('image/') ? blob : undefined
  } catch {
    return undefined
  }
}

// 预览菜单:收藏当前预览的提示词到库(连带参数与一张封面)
async function favoriteFromPreview(p: FavoritePayload) {
  if (!p.prompt.trim()) return
  const item: PromptItem = {
    id: uid(),
    prompt: p.prompt,
    // 新条目起手没有标签:标签是用户自己的分类法,替他猜一个只会多出噪声
    tags: [],
    model: p.model,
    size: p.size,
    quality: p.quality,
    background: p.background,
    cover: await coverOf(p.image),
    createdAt: Date.now()
  }
  libItems.value = [item, ...libItems.value]
  await persistLib()
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

// 预览菜单:删除该条历史。与历史页那条走同一个出口,撤销窗口也共用
function removeHistoryItem() {
  const cur = previewEntry.value
  if (!cur) return
  removeHistoryEntry(cur)
  closePreview()
}
// 历史页:不进预览,直接删掉某条记录
function removeHistoryEntry(entry: HistoryEntry) {
  const at = history.value.findIndex((h) => h.id === entry.id)
  if (at < 0) return
  history.value = history.value.filter((h) => h.id !== entry.id)
  scheduleUndo({
    label: 'Removed from history',
    undo: () => {
      history.value.splice(Math.min(at, history.value.length), 0, entry)
      // 窗口里可能正好生成了新图并触发淘汰,把这条按最旧的清掉了,所以补写一次
      saveHistoryRecord(entry)
    },
    purge: () => {
      removeHistoryRecord(entry.id)
      /* 地址到这时才释放:窗口里撤销回来还要渲染它。
         也只在这里释放 —— 预览开着时撤地址会让图裂掉 */
      releaseEntryMedia(entry)
    }
  })
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

    <!-- 视图切换:四个页面是平级视图,同时只挂载一个 -->
    <main class="frame">
      <!-- 外面这层 Transition 让新旧两页交叉过渡 ——
           原来只做了"新页淡入",旧页瞬间消失,那一下硬切就是生硬的来源 -->
      <Transition name="page">
        <!-- 生图工作台 -->
        <section v-if="page === 'home'" class="workbench" aria-label="Studio">
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
                :data-tip="selectionTip"
                :aria-label="selectionAria"
                @click="togglePanel('config')"
              >
                <PhSlidersHorizontal aria-hidden="true" />
                <b class="param-val param-val-name">{{ imagePillName }}</b>
                <span class="param-sep" aria-hidden="true"></span>
                <b class="param-val param-val-name param-val-sub">{{ activeTextName }}</b>
              </button>
              <button
                class="param-btn has-val"
                :class="{ on: openPanel === 'n' }"
                :disabled="compareMode"
                :data-tip="
                  compareMode ? 'One image per model in compare mode' : `Images · ${n}`
                "
                aria-label="Count"
                @click="togglePanel('n')"
              >
                <PhSquaresFour aria-hidden="true" />
                <b class="param-val">{{ shownN }} {{ shownN === 1 ? 'image' : 'images' }}</b>
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
                  :aria-label="loading ? 'Stop' : compareMode ? 'Compare models' : 'Generate'"
                  :data-tip="
                    loading
                      ? 'Stop'
                      : enhancing
                        ? 'Rewriting the prompt…'
                        : compareMode
                          ? `Generate with ${selectedConfigs.length} models`
                          : 'Generate with Enter'
                  "
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
                      <!-- 芯片就是多选:点一下加入/移出这次生成。
                           选一个 = 平时那样,选两个以上 = 对比模式 ——
                           不再有单独的"对比"开关,多选本身就是那个开关。
                           一键切换单个模型仍然是一次点击:先选上新的,再卸掉旧的 -->
                      <button
                        v-for="c in imageConfigs"
                        :key="c.id"
                        class="preset"
                        :class="{ on: selectedIds.includes(c.id) }"
                        :disabled="
                          !selectedIds.includes(c.id) && selectedIds.length >= RACE_MAX
                        "
                        :title="
                          !selectedIds.includes(c.id) && selectedIds.length >= RACE_MAX
                            ? `At most ${RACE_MAX} models can run at once`
                            : selectedIds.length === 1 && selectedIds.includes(c.id)
                              ? 'At least one model has to stay selected'
                              : `${c.baseUrl}${c.model ? ' · ' + c.model : ''}`
                        "
                        @click="toggleSelectedId(c.id)"
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

                    <!-- 种子:它只对"复现同一张图"有意义,所以自成一格,并把话说全 ——
                         上游从不回传它实际用的那个数,所以这里空着就是"每次都不同" -->
                    <div v-if="provider.seed !== 'no'" class="pp-group">
                      <span class="pp-label">Seed</span>
                      <input
                        class="num-input seed-input"
                        :value="seed"
                        placeholder="Random"
                        inputmode="numeric"
                        spellcheck="false"
                        aria-label="Random seed"
                        @change="commitSeed"
                      />
                      <span class="pp-note">
                        Same seed with the same settings may reproduce the same image
                      </span>
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

        <!-- 对比结果:同一句提示词的各家结果并排。只在出图后出现 ——
             生成中不摆一排空槽位:那时还没有图可比,那种骨架既说明不了什么,
             又把页面切成另一副布局,出图后还得再切回来。生成中的占位交给下面的图墙 -->
        <div v-if="raceSlots.length && !raceRunning" class="feed-zone" aria-live="polite">
          <div class="section-head">
            <span class="sec-title">Compare · {{ raceSlots.length }} models</span>
            <div class="sec-tools">
              <button class="sec-more" @click="dismissRace">
                Close
                <PhX aria-hidden="true" />
              </button>
            </div>
          </div>
          <div class="race-board" :style="{ '--race-cols': String(raceSlots.length) }">
            <article v-for="s in raceSlots" :key="s.configId" class="race-slot">
              <!-- 标签在图上:各列的名字与耗时因此天然对齐在同一行,
                   底下的图可以各自不同的比例,不会把脚注拉得高低不齐 -->
              <div class="race-foot">
                <b class="race-name" :title="s.model || s.label">{{ s.model || s.label }}</b>
                <span class="race-meta">{{ raceMeta(s) }}</span>
              </div>
              <!-- 只有占位与失败态需要给个形状(占位按所选尺寸,失败态按同一尺寸),
                   出图后不再约束比例:auto 档下各家输出的比例并不相同,
                   裁掉两侧就看不出构图差异了 —— 而看构图正是对比的目的 -->
              <div
                class="race-media"
                :style="
                  s.state === 'done' ? undefined : { aspectRatio: String(tileRatio(s.size)) }
                "
              >
                <div v-if="s.state === 'running'" class="skel-shimmer"></div>
                <button
                  v-else-if="s.state === 'done'"
                  class="race-open"
                  :aria-label="`Open ${s.model || s.label}`"
                  @click="openRaceSlot(s)"
                >
                  <img :src="imageSrc(s.results[0])" :alt="racePrompt" />
                </button>
                <!-- 失败与中断分开写:分不清"是你停的"还是"模型坏了",
                     并排看结果这件事就失去意义了 -->
                <p v-else class="race-note" :title="s.error || ''">
                  {{ s.state === 'stopped' ? 'Stopped' : s.error || 'Failed' }}
                </p>
              </div>
            </article>
          </div>
        </div>

        <!-- 历史图墙:输入框下方展示最近生成的图,可收起。
             对比出图进行中也走这一支:占位与单模型一样是图墙式的格子,
             只是格子数等于参与对比的模型数 -->
        <div
          v-else-if="loading || raceRunning || feedItems.length"
          class="feed-zone"
          aria-live="polite"
        >
          <div class="section-head">
            <span v-if="!loading && !raceRunning" class="sec-title">Recent creations</span>
            <!-- 生成中换成格子波 + 秒表:尺寸与字重都对齐 sec-title,
                 生成结束时从加载态切回标题不会跳一下 -->
            <LatticeLoader
              v-else
              class="sec-title"
              :label="raceRunning ? 'Comparing' : 'Generating'"
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
                  v-for="k in loading || raceRunning ? skeletonCount : 0"
                  :key="`sk-${k}`"
                  class="tile tile-skel"
                  :style="{ aspectRatio: String(tileRatio(skeletonSize)) }"
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
                    <span class="tile-name">{{ titleFromPrompt(t.entry.prompt) }}</span>
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
        :items="libItems"
        @use="useLibItem"
        @remove="removeLibItem"
        @save="saveLibItem"
        @import="importLibItems"
      />

      <!-- 历史记录 -->
      <HistoryPage
        v-else-if="page === 'history'"
        :items="history"
        @open="openPreview"
        @use="usePreviewPrompt"
        @remove="removeHistoryEntry"
        @mark="toggleMark"
      />

      <!-- 接口设置 -->
      <SettingsPage
        v-else
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
      </Transition>
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

    <!-- 删除的撤销条:固定在底部居中,四个页面里删了东西都从这儿撤销 -->
    <Transition name="undo-in">
      <UndoToast
        v-if="pendingUndo"
        :key="pendingUndo.token"
        :label="pendingUndo.label"
        :duration="UNDO_MS"
        @undo="runUndo"
        @expire="commitUndo"
      />
    </Transition>
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
  /* 离场的那一页会脱离文档流(见 .page-leave-active),这里得是它的定位基准 */
  position: relative;
}

/* 撤销条从底部升起来。它比页面切换更"贴身",所以更快一点 */
.undo-in-enter-active,
.undo-in-leave-active {
  transition: opacity 180ms var(--ease), transform 180ms var(--ease);
}
.undo-in-enter-from,
.undo-in-leave-to {
  opacity: 0;
  transform: translateY(10px);
}

/* ===== 页面切换 =====
   旧页原地淡出并微微上移,新页从下方浮起来接住它 —— 两页在同一段时间里交叉,
   不是"旧页消失、新页另起一段"。离场期间旧页脱离文档流,高度交给新页,
   所以滚动条不会在中途缩一下又弹回来 */
.page-leave-active {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  /* 离场只是让位,所以比入场短:两段叠起来刚好是一次呼吸的长度 */
  transition: opacity 150ms ease-out, transform 150ms ease-out;
}
.page-leave-to {
  opacity: 0;
  /* 往上走一点,与入场的方向对上:读起来像两页纸交错滑过 */
  transform: translateY(-6px);
}
.page-enter-active {
  transition: opacity 320ms var(--ease), transform 320ms var(--ease);
}
.page-enter-from {
  opacity: 0;
  transform: translateY(14px);
}
/* 位移对前庭敏感的人不友好,那种情况下只留淡入淡出 */
@media (prefers-reduced-motion: reduce) {
  .page-enter-active,
  .page-leave-active {
    transition-duration: 160ms;
  }
  .page-enter-from,
  .page-leave-to {
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
/* 多模型对比时张数入口被停用(每个模型只出一张)。停用不是"出错",
   所以压暗但保留可读,悬停仍能拿到 tooltip 说明为什么不能改 */
.param-btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.param-btn:disabled:hover {
  color: var(--text-2);
  border-color: var(--line);
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
/* 种子:比默认的 76px 宽,容得下 2147483647 这种十位数 */
.seed-input {
  width: 118px;
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
/* 对比选满之后,没入选的芯片不能再加进来。置灰而不是静默忽略:
   点了没反应会被当成坏了 */
.preset:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.preset:disabled:hover {
  border-color: var(--line);
  color: var(--text-2);
  background: var(--surface);
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

/* —— 对比出图:同题并排 ——
   等宽格子,信息放在图下面。列数只由参与对比的模型数决定 */
.race-board {
  display: grid;
  grid-template-columns: repeat(var(--race-cols, 2), minmax(0, 1fr));
  gap: var(--sp-4);
}
.race-slot {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  min-width: 0;
}
/* 占位与成图共用同一个框。出图后不给比例,由图片自身决定高度 ——
   各模型按 auto 档输出的比例可能不同,强行装进同一个形状只能二选一:
   裁掉两侧(看不出构图差异)或留黑边(白占地方) */
.race-media {
  position: relative;
  display: grid;
  place-items: center;
  width: 100%;
  overflow: hidden;
  border: 1px solid var(--line);
  border-radius: var(--r);
  background: var(--image-bg);
}
.race-open {
  display: block;
  width: 100%;
  padding: 0;
  border: none;
  cursor: zoom-in;
}
.race-open img {
  width: 100%;
  height: auto;
  display: block;
  transition: transform 600ms var(--ease);
}
.race-open:hover img {
  transform: scale(1.04);
}
/* 失败与中断写在这个框里。上游原文可能很长,框内滚动,全文挂在 title 上 */
.race-note {
  max-width: 100%;
  max-height: 100%;
  margin: 0;
  padding: var(--sp-4) var(--sp-3);
  overflow: auto;
  font-size: var(--fs-xs);
  line-height: 1.5;
  color: var(--text-3);
  text-align: center;
  word-break: break-word;
}
.race-foot {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.race-name {
  font-size: var(--fs-sm);
  font-weight: 500;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.race-meta {
  font-size: var(--fs-micro);
  color: var(--text-3);
}
/* 四个模型在窄屏上仍要能并排比较,所以先折成两列,很窄才单列 */
@media (max-width: 900px) {
  .race-board {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
@media (max-width: 560px) {
  .race-board {
    grid-template-columns: minmax(0, 1fr);
  }
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
