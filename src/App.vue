<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, watch, toRaw } from 'vue'
import {
  PhSun,
  PhMoon,
  PhSlidersHorizontal,
  PhDotsNine,
  PhStop,
  PhArrowCounterClockwise,
  PhSparkle,
  PhArrowsLeftRight,
  PhX,
  PhArrowRight,
  PhCaretRight,
  PhCaretDown,
  PhMaskHappy,
  PhRuler,
  PhHash,
  PhStack,
  PhGauge,
  PhPaintBucket,
  PhImageSquare,
  PhTextT,
  PhEye
} from '@phosphor-icons/vue'
import PromptLibrary from './components/PromptLibrary.vue'
import ImagePreview from './components/ImagePreview.vue'
import HistoryPage from './components/HistoryPage.vue'
import CanvasEditor from './components/CanvasEditor.vue'
import CharacterPage from './components/CharacterPage.vue'
import ChatPage from './components/ChatPage.vue'
import SettingsPage from './components/SettingsPage.vue'
import NavSegment from './components/NavSegment.vue'
import LatticeLoader from './components/LatticeLoader.vue'
import UndoToast from './components/UndoToast.vue'
import {
  generate,
  enhancePrompt,
  uid,
  loadConfigs,
  saveConfigs,
  pickActiveByKind,
  loadActiveId,
  saveActiveId,
  loadActiveTextId,
  saveActiveTextId,
  loadActiveVisionId,
  saveActiveVisionId,
  loadActiveTtsId,
  saveActiveTtsId,
  loadHistory,
  addHistoryRecord,
  removeHistoryRecord,
  saveHistoryRecord,
  loadPrompts,
  savePrompts,
  normalizePrompt,
  loadCollections,
  saveCollections,
  characterDesc,
  characterFaceDesc,
  chatPayloadOf,
  chatStream,
  coerceCharVoice,
  summarizeChat,
  CHAT_WINDOW,
  CHAT_SUMMARIZE_AFTER,
  CHAT_SUMMARY_CAP,
  loadCharacters,
  saveCharacters,
  exportCharacter,
  readCharacterZip,
  CHAT_EXPORT_MSGS,
  getProvider,
  inferVendor,
  allowedSizes,
  imageSrc,
  coverSrc,
  makeThumb,
  backfillThumbs,
  releaseEntryMedia,
  releaseSrc,
  QUALITY_OPTIONS,
  BACKGROUND_OPTIONS,
  CHARACTER_VIEWS
} from './api'
import { blobToDataURL, urlToBlob, getCharViews, putCharView, getChatMessages, putChatMessage, deleteChatMessage, deleteChatOf, deleteVoiceSample, putChatImage, getChatImage, deleteChatImage, CHAT_PAGE, getChatSummary, putChatSummary, countChatMessages, getChatMessagesToSummarize, getLastChatLine } from './lib/idb'
import { titleFromPrompt } from './lib/text'
import { stopSpeaking } from './lib/speech'
import { NAV_ITEMS } from './lib/nav'
// 另一个标签页改了 localStorage 里的目录时,本页要跟着重载(见 lib/crossTab.ts)
import { syncTargetsOf } from './lib/crossTab'
// 图片尺寸上限的唯一来源(参考图 / 存档 / 编辑载荷),别再各写一个字面量
import { REF_ARCHIVE_EDGE, REF_IMAGE_EDGE } from './lib/payload'
// 浮层的公共行为(点外收起 / Esc 逐层退)
import { isInside } from './lib/ui'
import {
  applyTheme,
  currentTheme,
  saveTheme,
  watchSystemTheme,
  type Theme
} from './lib/theme'
import type { Cap, EnhanceMode, Provider } from './api'
import type { ApiConfig, Collection, FavoritePayload, HistoryEntry, PromptItem, ResultItem, ReuseParams, Character, CharacterFields, CharacterPersona, CharacterStat, CharacterView, CharacterViewKind, CharacterVoice, CharacterWork, ChatMessage, ChatSummary, ImportedCharacter, ImportedChat } from './types'

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

/* —— 提示的自动收起 ——
   它是"说过就算"的中性通知(存好了、空间快满了),不该一直占着画面底部等人来关;
   但也不能一闪而过:长句得留够读的时间,所以按长度给时长。
   新提示进来时上一条的计时会被这里重置(同一个 ref,watch 又会跑一遍) */
let noticeTimer = 0
/** 读一条提示要多久。短句 4 秒;长的每字再加 60ms ——
 *  "存储快满"那种一句能到一百多字,照 4 秒收掉等于没提示 */
function noticeMs(msg: string) {
  return Math.min(9000, 4000 + msg.length * 60)
}
function clearNotice() {
  window.clearTimeout(noticeTimer)
  notice.value = ''
}
/** 把指针停在浮条上时不计时:长一点的提示用户可能正在读,
 *  读到一半整条消失,会让人怀疑自己是不是记错了 */
function holdNotice() {
  window.clearTimeout(noticeTimer)
}
/** 指针移开,接着计时。整条重新算而不是接着上一段:实现简单,
 *  而且用户等于又看了一遍 —— 多留这几秒不亏 */
function releaseNotice() {
  window.clearTimeout(noticeTimer)
  if (notice.value) noticeTimer = window.setTimeout(clearNotice, noticeMs(notice.value))
}
watch(notice, (v) => {
  window.clearTimeout(noticeTimer)
  if (v) noticeTimer = window.setTimeout(clearNotice, noticeMs(v))
})
onBeforeUnmount(() => window.clearTimeout(noticeTimer))

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
const history = ref<HistoryEntry[]>([])
// 作品集目录(只有标题 + id)。归属关系挂在记录上,这里只存目录
const collections = ref<Collection[]>([])
const libItems = ref<PromptItem[]>([])
const refImage = ref('') // 图生图参考图 (data URL)
/* —— 角色 ——
   一个角色 = 一组设定图 + 一段固定描述。目录(名字/描述)放 localStorage,
   图是 Blob,按 id 存在 IndexedDB(见 api.ts 的 loadCharacters)。
   角色是独立的输入:它不占表单里的参考图槽,只在发请求那一刻并进参考图一起送
   (见 charRefSrcs)。表单上看到的是什么,发出去的参考图就由这里决定 */
const characters = ref<Character[]>([])
/* 角色页的组件句柄:第 1 步存完由它把向导推进到下一步
   (见 saveCharFromPage)。这一页自己管向导的步数,所以"存完该去哪"得由它说了算 */
const charPageRef = ref<{
  // 新建存完:角色页据此把向导推进到"主视图"那一步
  onSaved: (id: string) => void
  // 编辑存完:角色页据此关掉向导、回到这个角色的详情页
  onUpdated: (id: string) => void
} | null>(null)
/* 这次创作套用的角色 id。空 = 不用角色 */
const activeCharId = ref('')
/* 设定图:按角色 id 缓存已取出的视图。只在这个角色被选中时才读 IndexedDB ——
   启动时不碰,5 张图 × N 个角色全读进来太重 */
const charViews = ref<Record<string, CharacterView[]>>({})
/* 各角色正在生成哪几张视图(没有该角色的键 = 空闲)。
   必须落到角色维度上:同一时间可以跑多张,而且是好几个角色的 ——
   只记 kind 的话,A 的正脸在跑时切到 B,B 的格子也会显示成"生成中"。
   同一张重复点会被忽略(见 genCharView) */
const charViewBusy = ref<Record<string, CharacterViewKind[]>>({})
/* 重跑设定图的中断手柄,按"角色 + 视图"各存一个:同时跑几张时,
   停一张不能把别张掐掉;不同角色的同一视图也得分得开 */
const charViewControllers = new Map<string, AbortController>()
/** 中断手柄的键。角色 id 与视图名拼一格 —— 两边都可能撞,只有合起来才唯一 */
function charViewKey(charId: string, kind: CharacterViewKind) {
  return `${charId}:${kind}`
}

/* —— 角色对话 ——
   与设定图同一套分工:这一页只管展示,消息从哪读、请求怎么发都在主界面。
   状态也按角色分开,理由与 charViewBusy 那次一模一样:
   A 在说话时切到 B,B 的界面不该跟着显示"正在输入" */
/* 当前在看哪个角色的对话。空 = 还没挑(对话页会给一句"挑一个") */
const chatCharId = ref('')
/* 已取到的消息,按角色 id 缓存。进对话页时才读,启动时不碰。
   注意这里装的是**最近一档**(见 idb.ts 的 CHAT_PAGE),不是全部历史 */
const chatMessages = ref<Record<string, ChatMessage[]>>({})
/* 前面还有更早的没读。界面据此决定要不要给"加载更早" ——
   没有它就分不清"这是第一句"和"只读到这里" */
const chatHasMore = ref<Record<string, boolean>>({})
/* 长期记忆:滑出窗口的消息压成的一段简报,按角色各一份。
   有没有这个键 = 这个角色压过没有 */
const chatSummary = ref<Record<string, ChatSummary>>({})
/* 每个角色的**最后一条**消息,只用来喂左栏(摘要那一行 + 最近活跃排序)。
   单独存一份是因为消息是按角色懒加载的:没打开过的角色 chatMessages 里没有键,
   左栏就会把它当成"从没聊过" —— 明明聊过,却显示 No messages yet 并排到最后。
   取法见 idb.ts 的 getLastChatLine,代价与消息条数无关 */
const chatLast = ref<Record<string, ChatMessage>>({})
/* 正在压记忆的角色。压缩是后台动作,但同一个角色不该叠两个 */
const chatSummarizing = new Set<string>()
/* "这段对话还作数吗"的代次。压缩是异步的,回来时得知道这期间它有没有被清掉 ——
   不查的话,一次后台整理会把用户刚清掉的记忆又写回去。
   与角色起稿的 draftSeq 是同一套做法:对不上就整份丢弃 */
const chatSeq = new Map<string, number>()
function bumpChatSeq(id: string) {
  chatSeq.set(id, (chatSeq.get(id) || 0) + 1)
}
/* 各角色正在生成中(没有该角色的键 = 空闲) */
const chatBusy = ref<Record<string, boolean>>({})
/* 一轮对话的中断手柄,按角色各存一个 —— 与 charViewControllers 同一个理由 */
const chatControllers = new Map<string, AbortController>()
/* 正在读取的角色。同一 id 可能被两处同时触发(选角色的 watch 与角色页的入口) */
const chatLoading = new Map<string, Promise<void>>()
// 七个平级页面:首页 / 角色 / 对话 / 画布 / 提示词库 / 历史记录 / 接口设置,同时只挂载一个
type Page = 'home' | 'chars' | 'chat' | 'canvas' | 'lib' | 'history' | 'settings'
const page = ref<Page>('home')
const previewEntry = ref<HistoryEntry | null>(null)

/* ===== 自由画布 =====================================================
   它是导航上的一个平级页面,不是一个弹层 —— 所以只把"画布上摆着哪张图"
   交给它(item),其余(工具箱、视图、操作序列)全归组件自己管。
   页面本身不用 v-if 而用 v-show 挂载,所以切去历史挑张图再切回来,
   手上那半张裁剪框还在。

   画布上的图有两个来路:从历史里挑一张,或本地上传一张新的。
   产物都是一条普通的历史记录 —— 来自历史的那张挂在源记录之下(parentId),
   于是创作链上"这张是从哪张裁出来的"一眼可见,不必另建一套数据结构;
   上传的没有出处,就是一条独立的记录。
   尺寸按编辑后的真实像素记,而不是沿用源记录的 size —— 裁完比例可能已经变了,
   沿用会让图墙按错误的宽高比排版(图墙是按 w/h 排的)。
   ------------------------------------------------------------------ */
const canvasItem = ref<ResultItem | null>(null)
/* 画布的出处记录,存回新记录时用来接上派生关系(parentId)。
   本地上传的图为 null —— 它没有出处 */
const canvasSource = ref<HistoryEntry | null>(null)
/* 画布上这张图"下一版"该接在哪条记录后面。它与 canvasSource 分开 ——
   保存之后画布留在原地(见 saveEdit),出处就变成刚存下的那一条;
   而 canvasSource 说的始终是"这张图当初从哪来",那个不该跟着变 */
const canvasParent = ref<HistoryEntry | null>(null)
/* 子组件实例。保存落盘结束后要给画布回执一声(见 CanvasEditor 的 finishSave) */
const canvasRef = ref<{ finishSave: () => void } | null>(null)

function openCanvas(entry: HistoryEntry, index: number) {
  releaseCanvasLocal()
  canvasItem.value = entry.results[index] ?? null
  canvasSource.value = entry
  canvasParent.value = entry
  // 画布是整页的,预览要是还开着会盖在上面,所以进来就把它收掉
  closePreview()
  page.value = 'canvas'
}
/* 本地上传的图直接摆上画布。它没有来源记录 ——
   保存时落成一条新的历史记录,不接派生关系:这张不是从哪条生成记录来的 */
function openCanvasFile(file: File) {
  releaseCanvasLocal()
  canvasItem.value = { type: 'b64', data: file }
  canvasSource.value = null
  canvasParent.value = null
  closePreview()
  page.value = 'canvas'
}
/* 画布上这张若是本地文件,它的 object URL 归画布独有 ——
   换图或撤图时得撤掉,不然那张图的字节一直被 URL 强引用着。
   来自历史的图不能这么干:它的 URL 和历史列表共用一份 */
function releaseCanvasLocal() {
  if (canvasSource.value || !canvasItem.value) return
  releaseSrc(canvasItem.value)
}
// 预览里点「Edit on canvas」:目标就是正在看的那条记录里的当前那张
function editFromPreview(index: number) {
  const e = previewEntry.value
  if (e) openCanvas(e, index)
}
// 画布上把这张图撤下来(回到空态)。空态里那个"去历史挑一张"由导航接手
function discardCanvas() {
  releaseCanvasLocal()
  canvasItem.value = null
  canvasSource.value = null
  canvasParent.value = null
}

/* 顶部横条的实际高度,写进 --mast-h 给自由画布用。
   导航条是最顶层、每一页都在,画布就铺在它下面 —— 让出多少高度得知道。
   不能写死:窄屏下这条会从一行变成两行,高度跟着变 */
const mastEl = ref<HTMLElement | null>(null)
let mastRO: ResizeObserver | null = null
onMounted(() => {
  const el = mastEl.value
  if (!el || typeof ResizeObserver === 'undefined') return
  const sync = () =>
    document.documentElement.style.setProperty('--mast-h', `${el.offsetHeight}px`)
  sync()
  mastRO = new ResizeObserver(sync)
  mastRO.observe(el)
})
onBeforeUnmount(() => mastRO?.disconnect())

/* 画布存回来的像素 → 新记录。走 recordFor 而不是自己拼一条:
   缩略图、真实像素这些图墙要用的字段都由它一并补齐 */
async function saveEdit(payload: { blob: Blob; w: number; h: number }) {
  const parent = canvasParent.value
  const record = await recordFor([{ type: 'b64', data: payload.blob }], {
    /* 提示词沿上一版。画布是本地加工,没有发生新的生成 ——
       编一句像 "cropped" 的提示词塞进去,只会让这条记录以后没法被复用。
       本地上传的图没有上一版,提示词就空着 */
    prompt: parent?.prompt ?? '',
    size: `${payload.w}x${payload.h}`,
    model: parent?.model,
    parentId: parent?.id,
    elapsedMs: 0
  })
  await persist(record)
  /* 画布留在原地,不撤图。存完往往要顺着同一个方向接着改,
     撤下去等于每存一次都得重新找图、重新定位一遍。
     这一版成为下一版的出处:于是"改一版存一版"自然连成一条链,
     再存出来的是链上的下一个节点,不是重复的一条 */
  canvasParent.value = record
  canvasRef.value?.finishSave()
  notice.value = 'Saved to history.'
}

/* 「拉自某条记录改一个变量重跑」时,这一批的父记录 id。
   use-prompt 会把 fromEntryId 放进来,doGenerate 落盘时写进新记录做 parentId;
   用户手动改输入框后清空 —— 改完就不再是"同一个实验的延续",而是一张新图 */
const pendingParentId = ref<string | undefined>()
// 参数 icon 展开的面板:同一时间只开一个,再次点击收起。
// 参数行只露模型与角色两个"身份"入口 —— 其余参数合并成 'more' 一块
type PanelKey = '' | 'chars' | 'more' | 'config'
const openPanel = ref<PanelKey>('')
// 收起动画播放期间保留上一次的面板内容,避免"内容先消失、容器再合拢"的两段跳变
const shownPanel = ref<PanelKey>('')
watch(openPanel, (v) => {
  if (v) shownPanel.value = v
  // 面板一收,里面那排头像整块卸载,不会再补一次 mouseleave —— 悬停卡片得在这里收掉
  else hideCharPeek()
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
  if (isInside(e.target, paramBarEl.value) || isInside(e.target, panelEl.value)) return
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

/* 参数面板按用途分开列出:出图、改写、识图与朗读各有各的"当前",混在一排里点谁生效说不清,
   而且文本/识图配置被 activateConfig 选中会顶掉出图用的接口。
   出图那条要排掉另外三类 —— 它们也走配置列表,但打的是对话端点或语音端点,拿来出图必错 */
const imageConfigs = computed(
  () => configs.value.filter((c) => c.kind !== 'text' && c.kind !== 'vision' && c.kind !== 'tts')
)
const textConfigs = computed(() => configs.value.filter((c) => c.kind === 'text'))
const visionConfigs = computed(() => configs.value.filter((c) => c.kind === 'vision'))

// —— 历史图墙(输入框下方,可收起) ——
const feedOpen = ref(true)
const FEED_LIMIT = 12
// 老记录没有 w/h,图片加载完再按真实像素补一下比例(与历史页同一个思路)。key 同 feedItems
const measured = ref<Record<string, number>>({})
/* 记录被删掉、或被存储清理淘汰之后,它量出来的比例跟着没用了 ——
   键只增不减会一直挂在内存里(与历史页同一处理) */
watch(history, (list) => {
  const alive = new Set<string>()
  for (const e of list) for (let i = 0; i < e.results.length; i++) alive.add(`${e.id}-${i}`)
  const next: Record<string, number> = {}
  let dropped = false
  for (const k of Object.keys(measured.value)) {
    if (alive.has(k)) next[k] = measured.value[k]
    else dropped = true
  }
  if (dropped) measured.value = next
})
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
    n.value !== 1 ||
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
/* 初值必须与 main.ts 同一套口径(存档优先、否则跟随系统)。
   原来这里只认存档、没有就硬当浅色,于是系统是深色且用户没手动设过时:
   页面已是深色,按钮却显示"切到深色",点一下毫无变化 —— 要连点两次才对 */
const theme = ref<Theme>(currentTheme())
function toggleTheme() {
  theme.value = theme.value === 'dark' ? 'light' : 'dark'
  applyTheme(theme.value)
  saveTheme(theme.value)
}
/* 系统里切深浅色,页面要跟着走(用户手动设过就不再跟,见 watchSystemTheme) */
let unwatchSystemTheme: (() => void) | null = null
onMounted(() => {
  unwatchSystemTheme = watchSystemTheme((t) => {
    theme.value = t
    applyTheme(t)
  })
})
onBeforeUnmount(() => unwatchSystemTheme?.())

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
onBeforeUnmount(() => window.removeEventListener('storage', onStorageSync))

/* —— 顶部导航(分段控件) ——
   条目清单在 lib/nav.ts(导航与字标共用那一份)。这里只留状态:
   视图状态只有 page 一份,navView 只是把它的类型收紧回联合类型
   (分段控件的 v-model 说的是普通字符串)。
   必须放在 page 声明之后:getter 引用了它 */
const navView = computed({
  get: () => page.value as string,
  set: (v: string) => {
    /* 认过再写:主区是几个 v-if 铺出来的,page 落到清单外的值上,整页就是空白
       (没有任何兜底分支)。控件那边给的都是清单里的值,但这是唯一的入口,
       在这里收一次窄,比给每个分支补 v-else 划算 */
    if (NAV_ITEMS.some((i) => i.value === v)) page.value = v as Page
  }
})
/* 字标里跟在 KImage 后面那一截:当前在哪一页。
   名字取自导航那份清单(lib/nav.ts),不另抄一份 —— 首页那页叫 Studio,
   于是首页写"KImage Studio",其余页各写各的 */
const wordmarkSuffix = computed(() => NAV_ITEMS.find((i) => i.value === page.value)?.label ?? '')
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
/* 识图用的配置:把角色向导里上传的参考图读成设定。三类配置同在 configs 里,
   只是用途不同 —— 能画图的模型未必会看图,所以它是一条独立的「当前」 */
const visionConfig = ref<ApiConfig | null>(null)
const activeVisionId = ref(loadActiveVisionId())
/* 朗读用的合成配置。前三类打的都是 OpenAI 兼容那套,这一条不是 ——
   它走 /api/v3/tts/...,还要一个 Resource-Id(见 types.ts 的 ApiConfig.resourceId)。
   同样是一条独立的「当前」:朗读配置被选中不该顶掉出图或改写 */
const ttsConfig = ref<ApiConfig | null>(null)
const activeTtsId = ref(loadActiveTtsId())
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
/* —— 生成中的每一张 = 一个槽 ——
   为什么不是"一次点击一个槽"而是一张一个:用户要的是每格能单独停,
   而"一次请求出 4 张"没法停下其中一张 —— 上游回来就是一整包。
   所以张数 4 就发 4 次各出一张,多模型对比则是每模型一个槽。

   代价是请求数等于张数。换来的是:每格自己转、自己停、先回来先出图。
   落盘仍按"一次点击 = 一条记录"归并(见 recordKey),
   所以历史里看到的条数和以前一模一样 */
type GenSlot = {
  id: string
  /* 落盘归并键。同一批里同键的槽合成一条历史记录:
     单模型出 4 张 → 一条记录带 4 张图(与从前一致);
     对比 3 个模型 → 三条记录(也与从前一致) */
  recordKey: string
  /* 这一次点击共用的分组 id,与对比出图沿用同一个字段语义(见 HistoryEntry.groupId) */
  groupId: string
  /* —— 发起时锁死的整套条件 ——
     中途改提示词、尺寸或配置,都不该影响已经发出去的那几张 */
  config: ApiConfig
  // 展示用的模型名(槽位上要写清这是哪家)
  label: string
  model: string
  prompt: string
  size: string
  extras: Record<string, string>
  seed?: number
  refList: string[]
  // 用户自己挑的那张参考图(角色的不算)。存快照是为了落盘时记下"当时用的哪张"
  refSrc?: string
  characterId?: string
  parentId?: string
  startedAt: number
  state: 'running' | 'done' | 'stopped' | 'error'
  results: ResultItem[]
  error?: string
  elapsedMs?: number
}
const genSlots = ref<GenSlot[]>([])
/* 中断手柄按槽各存一个。同一时刻可能有好几批在跑(生成键不再锁死),
   共用一个手柄的话,停一张会把别张一起掐掉 */
const slotControllers = new Map<string, AbortController>()
/* 正在跑的槽。骨架格、忙闲、进度条都读它 —— 只有还没结束的槽才占位 */
const activeSlots = computed(() => genSlots.value.filter((s) => s.state === 'running'))
const loading = computed(() => genSlots.value.some((s) => s.state === 'running'))
/* 这一批是不是在多模型对比(落盘键按模型分,所以键多于一个就是对比)。
   骨架格上要不要写模型名、进度条上说"Comparing"还是"Generating",都看它 */
const multiModel = computed(() => new Set(activeSlots.value.map((s) => s.recordKey)).size > 1)
/* 进度条上那句话。单模型出几张时报个数 —— 用户想知道的是"还有几张在路上" */
const runLabel = computed(() => {
  if (multiModel.value) return 'Comparing'
  const n = activeSlots.value.length
  return n > 1 ? `Generating ${n} images` : 'Generating'
})
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
  const active = pickActiveByKind(configs.value, 'image', activeId.value)
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
  const activeText = pickActiveByKind(configs.value, 'text', activeTextId.value)
  if (activeText) {
    textConfig.value = { ...activeText }
    if (activeTextId.value !== activeText.id) {
      activeTextId.value = activeText.id
      saveActiveTextId(activeText.id)
    }
  }
  // 识图配置:与文本那条同一套挑法(按存的 id 找,落空就退到第一条)
  const activeVision = pickActiveByKind(configs.value, 'vision', activeVisionId.value)
  if (activeVision) {
    visionConfig.value = { ...activeVision }
    if (activeVisionId.value !== activeVision.id) {
      activeVisionId.value = activeVision.id
      saveActiveVisionId(activeVision.id)
    }
  }
  // 朗读配置:同一套挑法。没配时 ttsConfig 为 null 是正常的 ——
  // 朗读会退回浏览器自带的语音(见 lib/speech),不是错误
  const activeTts = pickActiveByKind(configs.value, 'tts', activeTtsId.value)
  if (activeTts) {
    ttsConfig.value = { ...activeTts }
    if (activeTtsId.value !== activeTts.id) {
      activeTtsId.value = activeTts.id
      saveActiveTtsId(activeTts.id)
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
  // 作品集目录是同步读的 localStorage,直接落一次
  collections.value = loadCollections()
  // 角色要连 IndexedDB 里的参考图一起取,所以是异步的
  loadCharacters().then((list) => {
    characters.value = list.map(normalizeChar)
    /* 左栏那行"最后说了什么"需要每个角色各读一条 ——
       没打开过的角色在 chatMessages 里没有键,光靠它是读不到的(见 loadChatLast)。
       启动时补一趟就够:之后每一句都由 sendChat / runChat 就地更新 */
    void loadChatLast()
  })
  window.addEventListener('storage', onStorageSync)
})

/* —— 跨标签页同步 ——
   localStorage 里的目录都是整份覆盖写的(见 api.ts 的 save* 那几个)。
   两个标签页同时开着,A 页删掉一个角色,B 页内存里还留着旧目录,
   于是 B 页下一次保存会把它整个写回去 —— 用户看到的是"删掉的又回来了"。
   storage 事件只在**其他**标签页写入时触发,正好是我们要的信号。
   处理方式就是把受影响的那份目录重读一遍(见 lib/crossTab.ts 的取舍说明)。 */
function onStorageSync(e: StorageEvent) {
  const targets = syncTargetsOf(e.key)
  if (!targets.length) return
  const labels: string[] = []

  if (targets.includes('configs')) {
    configs.value = loadConfigs()
    // 重挑四类的「当前生效」:另一个标签页可能把当前那条删了或改了用途
    repickActiveImage()
    repickActiveText()
    repickActiveVision()
    repickActiveTts()
    /* 对比出图的选择集合可能指向已消失的配置。单选是常态,所以过滤后
       空了就退回"当前这一条",不留一个空的比对集 */
    const alive = new Set(configs.value.map((c) => c.id))
    selectedIds.value = selectedIds.value.filter((id) => alive.has(id))
    if (!selectedIds.value.length && activeId.value) selectedIds.value = [activeId.value]
    labels.push('API settings')
  }
  if (targets.includes('characters')) {
    loadCharacters().then((list) => {
      characters.value = list.map(normalizeChar)
      // 目录变了,左栏那行"最后说了什么"也要跟着对齐
      void loadChatLast()
    })
    labels.push('characters')
  }
  if (targets.includes('collections')) {
    collections.value = loadCollections()
    labels.push('collections')
  }
  if (targets.includes('prompts')) {
    loadPrompts().then((list) => (libItems.value = list))
    labels.push('prompt library')
  }

  /* 说一声。不说的话用户只会觉得"我明明没动,列表却变了" ——
     这是同步本身带来的观感问题,不是噪音 */
  notice.value = `Updated from another tab — reloaded ${labels.join(' and ')}.`
}

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
/* 当前生效的出图配置指向了一条已经不存在的(或已经改了用途的)配置时,
   按用途重挑一条;一条都没有就清空。删除与"改用途"两条路共用它 ——
   不收拾的话生效值会悬空:界面显示着它,它却已经发不出请求 */
function repickActiveImage() {
  const next = pickActiveByKind(configs.value, 'image', activeId.value)
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
// 文本侧同理。没有文本配置时 textConfig 为 null 是正常态,增强按钮会提示去配一条
function repickActiveText() {
  const next = pickActiveByKind(configs.value, 'text', activeTextId.value)
  if (next) {
    activateTextConfig(next)
  } else {
    textConfig.value = null
    activeTextId.value = ''
    saveActiveTextId('')
  }
}
// 识图侧同理:没有识图配置时 visionConfig 为 null,角色向导里会提示去配一条
function repickActiveVision() {
  const next = pickActiveByKind(configs.value, 'vision', activeVisionId.value)
  if (next) {
    activateVisionConfig(next)
  } else {
    visionConfig.value = null
    activeVisionId.value = ''
    saveActiveVisionId('')
  }
}
/* 朗读侧同理。**它与上面三条有一处不同**:ttsConfig 为 null 不是错误态 ——
   朗读会自动走浏览器自带的语音,只是听起来不是这个角色自己的嗓子 */
function repickActiveTts() {
  const next = pickActiveByKind(configs.value, 'tts', activeTtsId.value)
  if (next) {
    activateTtsConfig(next)
  } else {
    ttsConfig.value = null
    activeTtsId.value = ''
    saveActiveTtsId('')
  }
}

// 保存表单草稿(新增或更新),并设为对应用途的激活项
function saveSettings(draft: ApiConfig) {
  const cfg = {
    ...draft,
    id: draft.id || uid(),
    name: draft.name.trim() || cfgNameFromUrl(draft.baseUrl)
  }
  const idx = configs.value.findIndex((c) => c.id === cfg.id)
  /* 这一条原来是什么用途。表单允许改用途(见设置页的 setPurpose),
     改过之后它必须从原来那一侧退场 —— 否则那一侧的「当前生效」
     还留着它改之前的快照:界面说当前用它,实际发出去的却已经不是一回事了 */
  const prevKind = idx >= 0 ? configs.value[idx].kind : undefined
  const kind =
    cfg.kind === 'text'
      ? 'text'
      : cfg.kind === 'vision'
        ? 'vision'
        : cfg.kind === 'tts'
          ? 'tts'
          : 'image'
  if (idx >= 0) configs.value[idx] = cfg
  else configs.value.push(cfg)
  saveConfigs(configs.value)

  // 换了用途 ⇒ 原来那一侧的「当前」必须重挑,不能留着一个已经不属于它的快照
  if (prevKind && prevKind !== kind) {
    if (prevKind === 'text') {
      if (activeTextId.value === cfg.id) repickActiveText()
    } else if (prevKind === 'vision') {
      if (activeVisionId.value === cfg.id) repickActiveVision()
    } else if (prevKind === 'tts') {
      if (activeTtsId.value === cfg.id) repickActiveTts()
    } else {
      if (activeId.value === cfg.id) repickActiveImage()
      // 它也不再参与出图的选择集合(那个集合决定这次发给哪些模型)
      selectedIds.value = selectedIds.value.filter((id) => id !== cfg.id)
      if (!selectedIds.value.length && config.value.id) selectedIds.value = [config.value.id]
    }
  }

  /* 按用途分派到各自的「当前生效」:四类各自独立,存一条不该把别类的当前项顶掉
     (反之亦然)。同步成副本而不是直接用 cfg —— 之后改表单草稿不能再牵动生效值。 */
  if (kind === 'text') {
    textConfig.value = { ...cfg }
    activeTextId.value = cfg.id
    saveActiveTextId(cfg.id)
  } else if (kind === 'vision') {
    visionConfig.value = { ...cfg }
    activeVisionId.value = cfg.id
    saveActiveVisionId(cfg.id)
  } else if (kind === 'tts') {
    ttsConfig.value = { ...cfg }
    activeTtsId.value = cfg.id
    saveActiveTtsId(cfg.id)
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
// 设某条识图配置为当前生效(同上,走识图那条通道)
function activateVisionConfig(c: ApiConfig) {
  visionConfig.value = { ...c }
  activeVisionId.value = c.id
  saveActiveVisionId(c.id)
}
// 设某条朗读配置为当前生效(同上,走朗读那条通道)
function activateTtsConfig(c: ApiConfig) {
  ttsConfig.value = { ...c }
  activeTtsId.value = c.id
  saveActiveTtsId(c.id)
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
  const wasActiveVision = activeVisionId.value === c.id
  const wasActiveTts = activeTtsId.value === c.id
  const wasSelected = selectedIds.value.includes(c.id)

  /* 选择集合里也要摘掉它:被删的那条不再参与生成,但它留在集合里会让
     长度算错 —— 剩两条其实只剩一条,却仍被当成对比模式。摘完一个不剩就退回当前这条 */
  configs.value = configs.value.filter((x) => x.id !== c.id)
  // 占着各自「当前生效」的那条被删掉时,同样要按用途重新挑一条,免得生效值悬空
  if (wasActiveText) repickActiveText()
  if (wasActiveVision) repickActiveVision()
  if (wasActiveTts) repickActiveTts()
  if (wasActive) repickActiveImage()
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
      if (wasActiveVision) {
        visionConfig.value = { ...c }
        activeVisionId.value = c.id
        saveActiveVisionId(c.id)
      }
      if (wasActiveTts) {
        ttsConfig.value = { ...c }
        activeTtsId.value = c.id
        saveActiveTtsId(c.id)
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
  /* 撞 id 就换新的:一份备份里可能自己就有两条同 id(手改过、或同一份导两次),
     也可能与库里已有的撞上。重复 id 会让 v-for 的 :key 重复,
     而编辑/删除都按 id 查找 —— 只会命中的第一条,表现就是"删不掉"或"删错一条" */
  const seen = new Set(libItems.value.map((i) => i.id))
  for (const i of items) {
    if (!i || typeof i.prompt !== 'string' || !i.prompt.trim()) continue
    const thumb = typeof i.thumb === 'string' && i.thumb.startsWith('data:image/') ? i.thumb : ''
    let id = typeof i.id === 'string' && i.id ? i.id : uid()
    if (seen.has(id)) id = uid()
    seen.add(id)
    const item = normalizePrompt({
      ...i,
      id,
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
  /* 撞 id 就换新的。这里必须维护一份"这次已经用掉的 id",不能只跟现有列表比:
     map 期间 configs.value 不变,同一个文件里两条同 id 会双双通过 */
  const seen = new Set(configs.value.map((c) => c.id))
  const clean: ApiConfig[] = list
    .filter((c) => c && typeof c.baseUrl === 'string' && c.baseUrl.trim())
    .map((c) => {
      let id = typeof c.id === 'string' && c.id ? c.id : uid()
      if (seen.has(id)) id = uid()
      seen.add(id)
      return {
        id,
        name: typeof c.name === 'string' && c.name.trim() ? c.name : cfgNameFromUrl(c.baseUrl),
        baseUrl: c.baseUrl.trim(),
        apiKey: typeof c.apiKey === 'string' ? c.apiKey : '',
        model: typeof c.model === 'string' ? c.model : '',
        vendor: typeof c.vendor === 'string' ? c.vendor : 'custom',
        // 外部文件的脏数据不该让配置错类:只认得出 text / vision / tts,其余一律当出图
        kind:
          c.kind === 'text'
            ? ('text' as const)
            : c.kind === 'vision'
              ? ('vision' as const)
              : c.kind === 'tts'
                ? ('tts' as const)
                : ('image' as const),
        /* 朗读那条的资源标识。丢掉它的话,导入进来的朗读配置会变成
           "地址与密钥都对、但每次请求都被上游拒掉(access denied)",
           而原因藏在一格看不见的字段里 */
        ...(typeof c.resourceId === 'string' && c.resourceId.trim()
          ? { resourceId: c.resourceId.trim() }
          : {})
      }
    })
  if (!clean.length) return
  // 追加而不是覆盖:导入是补充,不该把现有配置清掉
  configs.value = [...clean, ...configs.value]
  saveConfigs(configs.value)
  // 原本一条都没配(生成会被拦下来)时,顺手把导入里第一条出图配置设为当前,不然导完照样发不出请求
  if (!configured()) {
    const first = configs.value.find(
      (c) => c.kind !== 'text' && c.kind !== 'vision' && c.kind !== 'tts'
    )
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
  // 识图那边同理 —— 三类「当前」互不隶属,缺哪一条就补哪一条
  if (!visionConfig.value) {
    const nextVision = configs.value.find((c) => c.kind === 'vision')
    if (nextVision) activateVisionConfig(nextVision)
  }
}

// —— 图生图:读取本地图片为 data URL(压缩到最长边 REF_IMAGE_EDGE,避免请求体过大 413) ——
function onPickRef(e: Event) {
  const file = (e.target as HTMLInputElement).files?.[0]
  if (!file) return
  // 角色与参考图是两个独立输入,自己挑图不动角色(见 types.ts 的 characterId 注释)
  const reader = new FileReader()
  reader.onload = () => {
    const url = String(reader.result)
    compressImage(url, REF_IMAGE_EDGE).then((out) => (refImage.value = out))
  }
  reader.readAsDataURL(file)
  ;(e.target as HTMLInputElement).value = ''
}
/* 键盘也能选参考图。那个入口是 <label for>:它不在 Tab 序里,而点它才触发
   file input —— 补上 tabindex 与回车/空格之后,把触发这件事显式写出来 */
const refInputEl = ref<HTMLInputElement | null>(null)
function pickRef() {
  refInputEl.value?.click()
}
/* 参考图的存档副本:配方要能完整复现,就得连参考图一起留下 ——
   hasRef 只说得出"用过参考图",说不出是哪一张,重跑时就会悄悄退化成文生图。
   压到最长边 512(它只当参考用,不需要原分辨率),存 Blob 不存 data URL,
   与结果图同一套。压不出来就返回 undefined,按"没存档"处理,不阻断生成 */
async function refThumbOf(src: string): Promise<Blob | undefined> {
  if (!src) return undefined
  try {
    const out = await compressImage(src, REF_ARCHIVE_EDGE, 0.72)
    return /^data:image\//.test(out) ? await urlToBlob(out) : undefined
  } catch {
    return undefined
  }
}

/* 用 canvas 压缩图片:超过 maxEdge 的最长边等比缩放,透明图铺白底,输出 JPEG。
   force = 即使是"本来就小于上限"的图也重编码一遍 —— 默认不这么做是为了
   让调用方能把没缩过的原始载荷原样留下(画质一点不丢);
   但原图如果是 PNG(模型给的多半是),原样留下就是 1MB 上下,那时才需要 force */
function compressImage(
  dataUrl: string,
  maxEdge = REF_IMAGE_EDGE,
  quality = 0.85,
  force = false
): Promise<string> {
  return new Promise((resolve) => {
    const img = new Image()
    img.onload = () => {
      let { width, height } = img
      const scale = Math.min(1, maxEdge / Math.max(width, height))
      if (scale >= 1 && !force) return resolve(dataUrl) // 本来就小,原样保留
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

/* —— 角色 ——
   一个角色 = 一组设定图 + 一段固定的描述。选中后分两路进这一批:
   脸部的三项设定接在提示词后面(见 composedPrompt),设定图并进参考图一起送
   (见 charRefSrcs),合成后的完整提示词才落进历史。
   于是"这条是照哪个角色出的"在记录上查得到(characterId) */
/** 当前套用的角色。没有就是 undefined —— 模板与合成提示词都读它 */
const activeCharacter = computed(() =>
  characters.value.find((c) => c.id === activeCharId.value)
)
/* 当前角色的头像。角色可能只有设定没有参考图,那时返回空串,界面上退回图标 */
const activeCharSrc = computed(() => coverSrc(activeCharacter.value?.ref))

/* —— 头像悬停预览 ——
   只在"挑人"的地方出现(角色面板里那排头像):悬停就把正脸整张放出来。
   选中之后的胶囊不再用它 —— 那时要看的是"怎么把这个角色摘下来"(见 .char-drop)。
   卡片 fixed 挂在最外层,坐标由这里按被悬停的头像现算 ——
   角色面板自己会滚、也会裁掉溢出(见 .fold-inner),卡片放在头像里面会被切掉一半。
   两个尺寸要与 CSS 对齐(图 168 宽、3:4,名字压在图上不额外占高),
   算"下面够不够放"用它,改一处别忘了另一处 */
const PEEK_W = 168
const PEEK_H = 224
/* 卡片常驻在页面上,切换的只是 .on:节点是挂载当帧就带着 .on 的话,
   浏览器不会播入场过渡(直接出现)。收起时保留上一次的内容,
   否则会先空一下再淡出 —— 与 shownPanel 同一个理由 */
const charPeek = ref({ src: '', name: '', x: 0, y: 0, up: false })
const peekOn = ref(false)

/** 把某个角色的正脸摆到这颗头像的下方(下面放不下就翻到上方) */
function showCharPeek(e: Event, c: Character) {
  const src = coverSrc(viewOf(c.id, 'front')?.data ?? c.ref)
  // 连主参考图都没有的老角色没什么可看的:把上一张收掉,别留着一张别人的脸
  if (!src) return hideCharPeek()
  const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
  const below = r.bottom + 8 + PEEK_H <= window.innerHeight - 8
  // 横向也夹回视口内:头像贴着边时卡片不该被切掉半边
  const half = PEEK_W / 2 + 8
  charPeek.value = {
    src,
    name: c.name,
    x: Math.min(Math.max(r.left + r.width / 2, half), window.innerWidth - half),
    y: below ? r.bottom + 8 : r.top - 8 - PEEK_H,
    up: !below
  }
  peekOn.value = true
}
function hideCharPeek() {
  peekOn.value = false
}

/* 会自动并进提示词的那一段(角色设定) */
const charSpecPrefix = computed(() =>
  activeCharacter.value ? characterFaceDesc(activeCharacter.value) : ''
)

/** 这次真正要发出去的提示词:用户自己写的在前,角色设定接在后面。
 *  顺序不能反 —— 前段权重更高,把固定的那套长相顶在最前面,
 *  "这一张要画什么"就被压到最后了。角色是加在场景上的,不是反过来 */
function composedPrompt(): string {
  const spec = charSpecPrefix.value
  const text = prompt.value.trim()
  if (!spec) return prompt.value
  return text ? `${text}, ${spec}` : spec
}

/** 读进来时校正一下角色记录,顺带补上后来才有的字段。
 *
 *  底图(sourceRef)是"其余四张要拿它当参考"之后才单独存的一份。在这之前,
 *  记录里只有 ref,它装的是这两者之一:上传的底图,或某张设定图提升来的副本 ——
 *  而 refKind 正好是这两者的标记(有值说明 ref 是某张视图的副本)。
 *  所以只有不带 refKind 的老记录,它的 ref 才是真底图,可以补进 sourceRef。
 *  反过来,refKind 是 'front' 的那种拿不回底图:那张早被正脸顶掉了。
 *
 *  主视图只能是正面 —— 老数据里可能留着被设成别张的 refKind(那个功能已经去掉),
 *  清掉即可。ref 不动:它是这张角色的封面,丢了卡片就只剩占位图标 */
function normalizeChar(c: Character): Character {
  const legacySource = c.refKind ? undefined : c.ref
  if (c.refKind && c.refKind !== 'front') delete c.refKind
  if (!c.sourceRef && legacySource) c.sourceRef = legacySource
  /* 嗓音逐项收一遍:它是从 localStorage 读回来的,可能被手改过、
     也可能来自更早的版本 —— 形状不对时整个退回"浏览器语音",
     而不是让一个残缺的对象一路走到合成请求里 */
  c.voice = coerceCharVoice(c.voice)
  return c
}

/** 卸下当前角色 */
function detachCharacter() {
  activeCharId.value = ''
}

/** 从角色卡直接开画:套上这个角色并切回工作台。
 *  交给 toggleChar 会变成"再点一次取消",这里要的是明确的选中,所以直接赋值。
 *  回顶部由 navView 的 watch 统一负责(见 useLibItem 同一条路径) */
function createWithCharacter(id: string) {
  activeCharId.value = id
  page.value = 'home'
}

/** 选中/取消一个角色卡:再点当前这个即取消。
 *  只动 activeCharId,不碰参考图槽 —— 角色和参考图是两个独立的输入,
 *  角色那几张图在发请求时才并进去(见 charRefSrcs) */
function toggleChar(id: string) {
  activeCharId.value = activeCharId.value === id ? '' : id
}

/** 面板里点一个头像:选定/取消,顺手把悬停预览收掉。
 *  光靠 mouseleave 收不干净:点完指针还停在原处,那张正脸会一直压在面板上,
 *  挡住的正是刚点过的那一排 —— 而这会儿人已经选完了,不需要再看它 */
function pickChar(id: string) {
  toggleChar(id)
  hideCharPeek()
}

/* 存角色这条链不算快(参考图要压缩、角色要落 IndexedDB),而第 1 步那个按钮
   在等待期间仍可点 —— 连点两下就会建出两个角色,第一个还没有任何界面引用它。
   所以做一次幂等。判定放在这个唯一的写入入口上,而不是角色页那个按钮上 */
let savingChar = false

/** 存下角色页交过来的草稿:带 id 是改这一条,不带就是新建。
 *  名字必填 —— 没名字的卡没法认 */
async function saveCharFromPage(d: {
  /* 带 id = 改这一条,不带 = 新建。角色页那边按"向导里有没有正在编辑的对象"给 */
  id?: string
  name: string
  fields: CharacterFields
  desc: string
  /* 人格设定。与 fields 分开进(见 types.ts 的 CharacterPersona)——
     它只服务对话,不该混进任何出图的提示词 */
  persona: CharacterPersona
  /* 嗓音。与 persona 同一条理由:只服务对话。它比 persona 多一层 ——
     clone 档会在库里留下一段样本音频(按 sampleId 认领) */
  voice: CharacterVoice
  refData: string
}) {
  const name = d.name.trim()
  if (!name || savingChar) return
  savingChar = true
  try {
    /* 上传的参考图会当角色卡封面直接铺出来,所以按显示级存(见 CHAR_IMAGE_MAX),
       不走那条"只喂给模型"的 refThumbOf —— 512 做卡面一眼就糊 */
    const ref = d.refData ? await charImageBlob(d.refData) : undefined

    /* —— 改一条已有的 ——
       名字与设定照单更新;参考图只有真换了才动(refData 为空 = 没换那张)。
       封面 ref 一律不碰:它要么是生成出来的正脸,要么是这张角色最初那张图 ——
       换一张参考图不该顺手把脸也换掉 */
    if (d.id) {
      const c = characters.value.find((x) => x.id === d.id)
      if (!c) return
      /* 备注也算设定的一部分:它同样会拼进提示词(见 characterDesc),
         改它的效果和改某一栏字段是一样的 */
      const before = JSON.stringify({ ...(c.fields || {}), desc: c.desc || '' })
      c.name = name
      c.fields = { ...d.fields }
      c.desc = d.desc.trim()
      c.persona = { ...d.persona }
      /* 换音色时旧的那段克隆样本要跟着清掉 —— 留着就是一段没人认领的录音。
         只在"换了另一个样本"时清:同一个 sampleId 再存一次当然不动它 */
      const prevSample = c.voice?.sampleId
      const nextSample = d.voice.sampleId
      c.voice = { ...d.voice }
      if (prevSample && prevSample !== nextSample) void deleteVoiceSample(prevSample)
      if (ref) c.sourceRef = ref
      await saveCharacters(characters.value)
      /* 改的可能只是一个名字,也可能把脸改了。设定动了就得说一声 ——
         那五张设定图是按旧设定生成的,不提示的话用户会以为它们跟着一起变了。
         一张视图都没有时不必说这句:没有"旧的"可以重跑 */
      const hasViews = (charViews.value[c.id] || []).length > 0
      notice.value =
        hasViews && before !== JSON.stringify({ ...d.fields, desc: c.desc })
          ? 'Saved. The reference views were made from the old spec — regenerate them if the face changed.'
          : `Saved “${c.name}”.`
      /* 编辑没有第 2、3 步要走,收尾就是回到这个人自己的详情页 */
      charPageRef.value?.onUpdated(c.id)
      return
    }

    const c: Character = {
      id: uid(),
      name,
      createdAt: Date.now(),
      fields: { ...d.fields },
      desc: d.desc.trim(),
      persona: { ...d.persona },
      voice: { ...d.voice },
      /* 这一张同时是封面的底图(正脸出来之前先用它顶着)和"第一步的参考图"。
         两者指向同一个 Blob,但语义不同,所以两个字段都写 ——
         正脸生成后封面会被换成正脸,而参考图那份还得留着给其余四张用 */
      ...(ref ? { ref, sourceRef: ref } : {})
    }
    characters.value = [c, ...characters.value]
    await saveCharacters(characters.value)
    /* 存完把 id 交回角色页,让向导推进到"主视图"那一步。
       这里不负责跳转 —— 向导的步数归角色页自己管 */
    charPageRef.value?.onSaved(c.id)
  } finally {
    // 失败时也要松开,否则按钮从此点不动
    savingChar = false
  }
}

/* 删掉一个角色。与别处(提示词 / 配置 / 历史)同一套:
   立刻从列表消失、几秒内可撤销,真正落盘发生在窗口结束时。
   落盘那一步顺带把它的图一起收走 —— saveCharacters → putCharRefs 是按 key 归属
   清理的,角色不在了,它的主参考图与五张设定图会一并删掉(见 idb.ts) */
function deleteChar(id: string) {
  const at = characters.value.findIndex((c) => c.id === id)
  if (at < 0) return
  const gone = characters.value[at]
  const wasActive = activeCharId.value === id
  // 与 activeCharId 同一处理:留着一个已不在的角色 id,对话页会指着一段没人认领的历史
  const wasChatting = chatCharId.value === id
  characters.value = characters.value.filter((c) => c.id !== id)
  /* 这一条不能等窗口结束:当前套用的角色是个 id 引用,
     留着一个已经不在列表里的 id,下一次生成会莫名多出一段角色描述 */
  if (wasActive) detachCharacter()
  if (wasChatting) chatCharId.value = ''

  scheduleUndo({
    label: 'Character deleted',
    undo: () => {
      // 放回原来的位置:列表顺序有意义(最近建的在前)
      characters.value.splice(Math.min(at, characters.value.length), 0, gone)
      // 恢复「当前套用的角色」—— 它当初是被这次删除夺走的,现在物归原主
      if (wasActive) activeCharId.value = id
      if (wasChatting) chatCharId.value = id
      /* 撤销要立刻落盘:窗口里别的操作可能已经把"它不在"写进去了。
         图是整批按归属清理的,所以这一步同时保住它的主图与设定图 */
      saveCharacters(characters.value)
    },
    purge: () => {
      /* 到这里才真正落盘删除,同时把图从内存里放掉 ——
         卡片的 object URL 由弱引用表带出,不收就等于把一个已删角色的
         六张图一直留在内存里(见 idb.ts 与 api.ts 的 releaseSrc) */
      for (const v of charViews.value[id] || []) releaseSrc(v.data)
      releaseSrc(gone.ref)
      /* 底图是**另一个** Blob:正脸生成成功时 ref 会被换成正脸,那时两者就不再
         指向同一个实例了 —— 只收 ref 会把底图那张的地址留在弱引用表里 */
      releaseSrc(gone.sourceRef)
      /* 克隆用的那段录音也跟着走。它与图不同 —— 那是**用户的录音**,
         角色没了还把它留在库里,既没人认领也不该留。同样放这一步:
         撤销回来时它还得在 */
      if (gone.voice?.sampleId) void deleteVoiceSample(gone.voice.sampleId)
      const rest = { ...charViews.value }
      delete rest[id]
      charViews.value = rest
      /* 对话跟着角色一起走:人没了,跟他聊的那一段留着也没有对象了。
         放在这一步(真正落盘)而不是点删除那一刻 —— 撤销回来时对话还得在 */
      chatControllers.get(id)?.abort()
      chatControllers.delete(id)
      /* 对话里附过的图也跟着走。**先收 id 再清消息** ——
         消息一旦从内存里抹掉,就再也问不出它带过哪几张图了,
         那些图会变成永远没人认领的孤儿 */
      for (const m of chatMessages.value[id] || []) {
        if (m.imageId) void deleteChatImage(m.imageId)
      }
      const chatRest = { ...chatMessages.value }
      delete chatRest[id]
      chatMessages.value = chatRest
      const moreRest = { ...chatHasMore.value }
      delete moreRest[id]
      chatHasMore.value = moreRest
      /* 在途的压缩也要作废 —— 它会往一份已经没人认领的记忆里写。
         deleteChatOf 连记忆一起清,所以这里不用再单独删一次库里的那份 */
      bumpChatSeq(id)
      const sumRest = { ...chatSummary.value }
      delete sumRest[id]
      chatSummary.value = sumRest
      dropChatLast(id)
      void deleteChatOf(id)
      saveCharacters(characters.value)
    }
  })
}

/** Blob 的切片:拿到一个指向同一批字节、但**实例是新的** Blob。
 *  复制角色时必须换实例 —— 两个角色共用同一个 Blob 会共用同一个 object URL,
 *  一边撤销(见 deleteChar 的 purge / releaseSrc)另一边正在显示的图就裂了。
 *  slice 不复制底层字节,只多一个引用 */
function reBlob(b: Blob): Blob {
  return b.slice(0, b.size, b.type)
}

/* 复制一个角色:名字、设定、备注、图全拷一份,插在原件后面。
   设定图在 IndexedDB 里按角色 id 存,所以得读出来再写到新 id 名下。

   下面三处报错都用 notice 而不是 fail:fail 写的是 home 那条 .err,
   它只在创作区渲染 —— 用户人在角色页,写过去等于什么都没说 */
async function duplicateChar(id: string) {
  const at = characters.value.findIndex((c) => c.id === id)
  if (at < 0) return
  const src = characters.value[at]
  const copy: Character = {
    id: uid(),
    name: `${src.name} copy`,
    createdAt: Date.now(),
    ...(src.fields ? { fields: { ...src.fields } } : {}),
    ...(src.desc ? { desc: src.desc } : {}),
    /* 人格与嗓音一起拷。它们与设定同属"这个人是谁"——
       复制一个角色的意思本来就是"同一副皮囊、同一个性格,拿去改点别的",
       不拷这两样的话,复制出来的是个没性格也没嗓子的陌生人。
       (人格这一项在加嗓音之前一直漏着,一起补上) */
    ...(src.persona ? { persona: { ...src.persona } } : {}),
    /* 嗓音照拷,但**丢掉 sampleId** —— 那段录音属于原件。
       共用同一个 id 的话,删掉其中一个角色会把另一个的样本也清掉。
       留着 vendorVoice 就够合成用了,副本只是不能再"重新克隆"那一手 */
    ...(src.voice ? { voice: { ...src.voice, sampleId: undefined, sampleName: undefined } } : {}),
    ...(src.ref ? { ref: reBlob(src.ref) } : {}),
    ...(src.sourceRef ? { sourceRef: reBlob(src.sourceRef) } : {}),
    ...(src.refKind ? { refKind: src.refKind } : {})
  }
  const known = new Set<string>(CHARACTER_VIEWS.map((v) => v.kind))
  /* 先写图、再 saveCharacters:后者顺带按 key 归属清理,顺序反了会把刚写进去的
     设定图当成"已经不在的角色名下的"删掉(见 idb.ts 的 putCharRefs) */
  try {
    for (const r of await getCharViews(id)) {
      if (known.has(r.kind)) await putCharView(copy.id, r.kind, reBlob(r.data))
    }
    characters.value = [
      ...characters.value.slice(0, at + 1),
      copy,
      ...characters.value.slice(at + 1)
    ]
    await saveCharacters(characters.value)
    notice.value = `Duplicated as “${copy.name}”.`
  } catch {
    notice.value = 'Could not duplicate this character.'
  }
}

/* 导出一个角色为 zip(带图)。设定图是懒加载的,所以先确保取过 ——
   不取的话导出包里会少掉那五张,而这正是这个功能的意义所在 */
async function exportChar(id: string) {
  const c = characters.value.find((x) => x.id === id)
  if (!c) return
  try {
    if (!charViews.value[id]) await loadCharViews(id)
    const chat = await readChatForExport(id)
    const images = await exportCharacter(c, charViews.value[id] || [], chat)
    const msgCount = chat.messages.length
    /* 回执要把两样都说到:一个只有设定没有图的角色,与一个连对话都带走的角色,
       导出来的东西差别很大,让用户知道包里到底装了什么 */
    const parts: string[] = []
    if (images) parts.push(`${images} image${images === 1 ? '' : 's'}`)
    if (msgCount) parts.push(`${msgCount} message${msgCount === 1 ? '' : 's'}`)
    notice.value = parts.length
      ? `Exported “${c.name}” with ${parts.join(' and ')}.`
      : `Exported “${c.name}” — it has no images or conversation yet, so the zip is settings only.`
  } catch (e: any) {
    notice.value = e?.message || 'Could not export this character'
  }
}

/** 备好一个角色的对话,交给导出。
 *
 *  记忆**从库里读**:界面里那份是按角色懒加载的,没打开过的角色在内存里根本没有。
 *  消息只取最近一档(CHAT_EXPORT_MSGS)—— 分享时真正要传的是"它记得什么",
 *  消息只是那份记忆的来处,而且对话可以无限长,全带出去包里会塞进几 MB 纯文本。 */
async function readChatForExport(id: string): Promise<ImportedChat> {
  const [sum, page] = await Promise.all([
    chatSummary.value[id] ? Promise.resolve(chatSummary.value[id]) : getChatSummary(id),
    getChatMessages(id, CHAT_EXPORT_MSGS)
  ])
  const messages = page.list.map((m) => ({
    role: m.role,
    content: m.content,
    createdAt: m.createdAt,
    ...(m.stopped ? { stopped: true } : {}),
    ...(m.truncated ? { truncated: true } : {}),
    ...(m.mood ? { mood: m.mood } : {}),
    ...(m.imageId ? { imageId: m.imageId } : {})
  }))
  /* 附图一起带走。**缺了它们,对方拿到的是一串"不知道在说什么的回复"** ——
     消息在,而消息指着的那张图不在。读不回来的那张跳过:
     少一张图不该让整份导出失败 */
  const ids = [...new Set(messages.map((m) => m.imageId).filter((x): x is string => !!x))]
  const images: Array<{ id: string; blob: Blob }> = []
  for (const imgId of ids) {
    const rec = await getChatImage(imgId)
    if (rec) images.push({ id: imgId, blob: rec.blob })
  }
  return {
    messages,
    // 忘掉过的角色导出的就是空串(库里那条正文为空),包里也就不带记忆
    memory: sum?.text || '',
    ...(images.length ? { images } : {})
  }
}

/** 把角色包里带回来的那段对话写进库。
 *
 *  消息 id 一律换新(与角色 id 同一条理由:不沿用文件里的标识)。
 *  记忆则按**收到的这些消息**重新对游标 —— 不能照抄包里那份:
 *  那些 id 与时间戳在本地已经不成立,照抄会让下一轮压缩要么把导入的这段
 *  整段重新压一遍,要么一条都不压。 */
async function writeImportedChat(charId: string, chat: ImportedChat) {
  const msgs: ChatMessage[] = chat.messages.map((m) => ({ id: uid(), charId, ...m }))
  for (const m of msgs) await putChatMessage(m)
  if (!chat.memory) return
  const last = msgs[msgs.length - 1]
  await putChatSummary({
    charId,
    text: chat.memory,
    upToId: last?.id || '',
    upToAt: last?.createdAt || 0,
    covered: msgs.length,
    /* 这份记忆是跟着包过来的,不是此刻压出来的。界面上那行"多久没动过"
       显示的是它落到这台机器上的时间 —— 除此之外没有更早的时刻可写 */
    updatedAt: Date.now()
  })
}

/* 角色包的大小上限:一个角色是 1 张主图 + 5 张设定图,正常不过几 MB。
   不拦的话整个文件会先被读进内存再解压 —— 一个上百 MB 的 zip 就能把标签页顶掉,
   而它显然不会是角色包 */
const MAX_CHAR_ZIP = 64 * 1024 * 1024

/* 导入角色 zip。文件里的 id 一律换新 —— 与现有的撞上会让列表里出现两条同 id,
   渲染和删除都会错乱(与配置的导入同一条理由) */
async function importCharFile(file: File) {
  if (file.size > MAX_CHAR_ZIP) {
    notice.value = 'That file is too large to be a character export.'
    return
  }
  let list: ImportedCharacter[]
  try {
    list = await readCharacterZip(file)
  } catch (e: any) {
    notice.value = e?.message || 'Could not read that file'
    return
  }
  if (!list.length) {
    notice.value = 'That zip has no usable characters in it.'
    return
  }

  const added: Character[] = []
  let msgs = 0
  try {
    for (const imp of list) {
      const c: Character = {
        id: uid(),
        name: imp.name,
        createdAt: imp.createdAt,
        ...(imp.fields ? { fields: { ...imp.fields } } : {}),
        ...(imp.desc ? { desc: imp.desc } : {}),
        ...(imp.persona ? { persona: { ...imp.persona } } : {}),
        ...(imp.ref ? { ref: imp.ref } : {}),
        ...(imp.sourceRef ? { sourceRef: imp.sourceRef } : {}),
        ...(imp.refKind ? { refKind: imp.refKind } : {})
      }
      // 与 duplicateChar 同一条顺序要求:图先写,再交给 saveCharacters 落盘
      for (const v of imp.views) await putCharView(c.id, v.kind, v.data)
      /* 对话跟着角色一起落库。顺序也是要紧的:先得有这个角色 id,
         而记忆的游标要指着已经写进去的最后一条消息 */
      if (imp.chat) {
        await writeImportedChat(c.id, imp.chat)
        msgs += imp.chat.messages.length
        /* 包里的附图跟着落库。**id 原样用** —— 消息里引用的就是它,
           与"消息 id 一律换新"不同:那个是本地身份,这个只是一根引用的键 */
        for (const img of imp.chat.images || []) {
          await putChatImage({ id: img.id, blob: img.blob, createdAt: Date.now() })
        }
      }
      added.push(c)
    }
    characters.value = [...added, ...characters.value]
    await saveCharacters(characters.value)
    /* 补一趟左栏那行摘要:导入的对话已经在库里,而 chatLast 只在启动时读过一次 ——
       不补的话,这些明明带着历史的角色在左栏会显示 "No messages yet" */
    if (msgs) void loadChatLast()
    const base =
      added.length === 1 ? `Imported “${added[0].name}”.` : `Imported ${added.length} characters.`
    notice.value = msgs
      ? `${base} Includes ${msgs} message${msgs === 1 ? '' : 's'} of conversation.`
      : base
  } catch {
    notice.value = 'Could not save the imported characters.'
  }
}

/* 每个角色被用了几次、最后一次是什么时候。数据全在历史里 ——
   记录带着 characterId(见 types.ts),这里只做一次聚合,不新增存储。
   角色页靠它把"清单"说成"资产":一个没人用过的角色和一个出过上百张的,
   在列表里应该长得不一样 */
const charStats = computed<Record<string, CharacterStat>>(() => {
  const m: Record<string, CharacterStat> = {}
  for (const h of history.value) {
    const id = h.characterId
    if (!id) continue
    const s = m[id] || (m[id] = { count: 0, lastAt: 0 })
    s.count += 1
    if (h.createdAt > s.lastAt) s.lastAt = h.createdAt
  }
  return m
})

/* 每个角色名下的作品:历史里带 characterId 的那些图,按记录顺序(新的在前)。
   与上面的 stats 同一趟口径、同一个出处 —— 角色页上"12 images"和它下面
   那排图是同一份数据,不会出现数字说有 12 张、点开只找到 3 张 */
const charWorks = computed<Record<string, CharacterWork[]>>(() => {
  const m: Record<string, CharacterWork[]> = {}
  for (const h of history.value) {
    const id = h.characterId
    if (!id) continue
    const list = m[id] || (m[id] = [])
    h.results.forEach((item, index) =>
      list.push({ key: `${h.id}:${index}`, entry: h, index, item })
    )
  }
  return m
})

/* —— 设定图 ——
   五张视图,正脸是锚:其余四张都以正脸为参考图生成 —— 这是"同一张脸"的唯一保证。
   结果只进角色自己的 views,不进历史 —— 它们是中转用的参考料,不是作品 */
function viewOf(charId: string, kind: CharacterViewKind): CharacterView | undefined {
  return charViews.value[charId]?.find((v) => v.kind === kind)
}

/* 竖幅的目标比例。全身像用 2:3:站姿人形只有竖框装得下,
   9:16 会把人大幅缩小、面料与配饰的细节跟着丢,3:4 又偏紧、容易切到脚 */
const PORTRAIT_RATIO = 2 / 3

/* 取景 → 实际尺寸。
   比例是按视图写死的(见 api.ts 的 framing:正脸 / 3-4 / 细节 / 表情一律方形,
   只有全身是竖幅),但像素值写不死 —— 各厂商只认自己那几档,
   所以这里做的是"在它认的档位里挑最接近那个比例的"。
   厂商不限尺寸时,候选换成应用自己那组常用值:FREE_SIZES 里有 1024x1792 这一档竖幅,
   全身图才装得下。这里刻意不沿用创作区当前尺寸 —— 那是给作品用的,
   可能是个宽幅,拿来当全身图的画框会得到一张横过来的人 */
function viewSize(framing: 'square' | 'portrait'): string {
  const allowed = allowedSizes(provider.value.id, config.value.model)
  const want = framing === 'square' ? 1 : PORTRAIT_RATIO
  let best = ''
  let bestGap = Infinity
  for (const s of allowed === 'free' ? FREE_SIZES : allowed) {
    const [w, h] = s.split('x').map(Number)
    if (!(w > 0 && h > 0)) continue
    const gap = Math.abs(w / h - want)
    if (gap < bestGap) {
      bestGap = gap
      best = s
    }
  }
  // 一档都没挑出来(候选里只有 auto 这类非尺寸值):退回创作区当前尺寸
  return best || size.value
}

/* —— 角色身上的图 ——
   角色有两处图:ref(卡面与头像)与 5 张设定图。它们和 record.ref 的用处不同 ——
   后者只是"当时用了哪张参考图"的复现凭据,只喂给模型,压到最长边 512 就够
   (见 refThumbOf);而角色这两处是要给人看的:角色卡封面、详情页头像、
   以及全屏查看器里能铺到 600px 宽 —— 2× 屏就是 1200px。
   512 一到那个尺寸一眼就糊,所以这条路按显示级编:最长边 1280、JPEG q0.88。
   1280 是照着全屏查看器定的(600 CSS px × 2),再大对观感没有增益,
   只是让一套 6 张图多占几 MB */
const CHAR_IMAGE_MAX = 1280
async function charImageBlob(src: string): Promise<Blob | undefined> {
  if (!src) return undefined
  try {
    /* 先把字节抓回来再转 data URL:src 可能是上游回的外链,
       直接塞进 <img> 会让 canvas 被跨域污染,toDataURL 直接抛错 */
    const raw = await blobToDataURL(await urlToBlob(src))
    /* force 重编码:模型给的多半是 PNG,原样留下就是 1MB 上下 ——
       一套六张图好几 MB,画质上却看不出多出来的好处 */
    const out = await compressImage(raw, CHAR_IMAGE_MAX, 0.88, true)
    const blob = await urlToBlob(out)
    return blob.type.startsWith('image/') ? blob : undefined
  } catch {
    return undefined
  }
}

/** 一张生成结果 → 落进角色设定图的 Blob(显示级,见上面 CHAR_IMAGE_MAX) */
async function resultRefBlob(item: ResultItem | undefined): Promise<Blob | undefined> {
  if (!item) return undefined
  return charImageBlob(imageSrc(item))
}

/**
 * 生成一张设定图。
 * 正脸:角色有主参考图(上传的 / 从作品提升的 / 上一版正脸)就以它为参考图,
 * 没有就是纯文生图 —— 三种输入因此走同一条流水线;
 * 其余四张一律以正脸为参考图。
 * 返回是否成功,好让"补齐"那一步知道该停下还是继续。
 */
async function genCharView(charId: string, kind: CharacterViewKind): Promise<boolean> {
  const view = CHARACTER_VIEWS.find((v) => v.kind === kind)
  const c = characters.value.find((x) => x.id === charId)
  /* 同一张重复点没有意义:第二次请求只会把第一次的结果盖掉。
     别的张在跑不影响这一张 —— 它们之间没有依赖(正脸未生成时那几格本来就是锁的) */
  if (!view || !c || charViewBusy.value[charId]?.includes(kind)) return false
  const cfg = config.value
  /* 这里几个报错都走 notice 而不是 fail:这条流水线只有站在角色页才会触发,
     而 fail 写的是 home 那条 .err —— 在角色页触发时它不渲染,等于没提示 */
  if (!cfg.model) {
    notice.value = 'Set an image model in API settings first.'
    return false
  }
  /* —— 这一张拿哪几张图当参考 ——
     正脸:用第一步上传的那张底图,它就是"这个人原本的样子"。
     没传过就是纯文生图。回退 ref 是留给老数据的路 ——
     那批角色的 ref 里存的就是图本身,没有单独一份底图
     其余四张:正脸与底图一起送。正脸定"这张脸长什么样",
     底图补上一张正面头像交代不了的东西(发型轮廓、体态、服装轮廓) */
  const front = viewOf(c.id, 'front')?.data
  const source = c.sourceRef ?? (kind === 'front' ? c.ref : undefined)
  let refBlobs: Blob[]
  if (kind === 'front') {
    refBlobs = source ? [source] : []
  } else {
    // 没有正脸就没有锚,跑出来的只是"另一个长得有点像的人"
    if (!front) {
      notice.value = 'Generate the front view first — the other views are built from it.'
      return false
    }
    /* 不认多图的模型只送正脸:宁可少一张,也不能为了多送一张把整个请求弄失败 ——
       正脸是不可少的那个,四张之间靠它才串成同一个人 */
    const caps = getProvider(cfg.vendor || inferVendor(cfg.baseUrl), cfg.model)
    refBlobs = caps.multiImage === 'no' || !source ? [front] : [front, source]
  }
  charViewBusy.value = {
    ...charViewBusy.value,
    [charId]: [...(charViewBusy.value[charId] || []), kind]
  }
  error.value = ''
  const ctl = new AbortController()
  charViewControllers.set(charViewKey(charId, kind), ctl)
  let ok = false
  try {
    const prompt = [characterDesc(c), view.suffix].filter(Boolean).join(', ')
    const images: string[] = []
    for (const b of refBlobs) images.push(await blobToDataURL(b))
    const res = await generate(
      {
        prompt,
        size: viewSize(view.framing),
        n: 1,
        ...(images.length ? { images } : {})
      },
      cfg,
      ctl.signal
    )
    const blob = await resultRefBlob(res[0])
    if (!blob) throw new Error('Upstream returned no usable image')
    /* 换掉的那张旧图不再有任何界面引用它,连同它的 object URL 一起放掉 ——
       反复重跑同一格,否则每次都在内存里留一张全尺寸图 */
    releaseSrc(viewOf(c.id, kind)?.data)
    await putCharView(c.id, kind, blob)
    const rest = (charViews.value[c.id] || []).filter((v) => v.kind !== kind)
    charViews.value = { ...charViews.value, [c.id]: [...rest, { kind, data: blob }] }
    /* 正脸同时是这张角色的封面与头像,生成成功后就写回 ref ——
       否则卡片上停留的还是那张上传的底图,跟刚生成的脸对不上。
       底图不会被这一下顶掉:它另存了一份(sourceRef),
       其余四张设定图还要拿它和正脸一起当参考 */
    if (kind === 'front') {
      const stale = c.ref
      c.ref = blob
      await saveCharacters(characters.value)
      // 界面已经换成新图,旧封面那张不再被任何地方引用
      if (stale && stale !== blob) releaseSrc(stale)
    }
    /* 重跑正脸之后,其余四张就是照上一张正脸出的了。提醒一句,但不替用户删 ——
       删是不可逆的,而"要不要重跑"只有他自己知道 */
    if (kind === 'front' && rest.length) {
      notice.value =
        'Other views were built from the previous front view — regenerate them if the face changed.'
    }
    ok = true
  } catch (e: any) {
    /* 用户主动停的不算失败 —— 按报错抛出来会让人以为出了故障 */
    notice.value = ctl.signal.aborted
      ? 'Generation stopped.'
      : e?.message || 'Could not generate this view'
  } finally {
    // 只有还是自己那一个才摘掉:同一张连跑时后一次已经换了新的手柄
    const key = charViewKey(charId, kind)
    if (charViewControllers.get(key) === ctl) charViewControllers.delete(key)
    /* 只摘掉这一张 —— 同一角色可能还有别的张在跑,
       别的角色的记录更是不能碰(它们与这一次请求无关) */
    const rest = (charViewBusy.value[charId] || []).filter((k) => k !== kind)
    const next = { ...charViewBusy.value }
    if (rest.length) next[charId] = rest
    else delete next[charId]
    charViewBusy.value = next
  }
  return ok
}

/** 停掉正在重跑的那一张设定图,只停它 —— 别张还在跑的自己跑完。
 *  已经落库的那张不受影响:只有成功写入的那一刻才作数,半路掐断不会留下坏图 */
function stopCharView(charId: string, kind: CharacterViewKind) {
  charViewControllers.get(charViewKey(charId, kind))?.abort()
}

/** 一次补齐五张。串行跑:每张都以前一张为参考图,并行只会互相抢带宽;
 *  中途失败(多半是配置或配额)就直接停下,免得连错四次 */
async function genRemainingViews(charId: string) {
  for (const v of CHARACTER_VIEWS) {
    if (viewOf(charId, v.kind)) continue
    // 已经自己在跑的那张跳过:这个循环只把"还缺的"补上,不重发一遍
    if (charViewBusy.value[charId]?.includes(v.kind)) continue
    if (!(await genCharView(charId, v.kind))) return
  }
}

/* 取出某个角色的设定图并缓存。已经取过就不再读 IndexedDB ——
   启动时不碰这些图,5 张 × N 个角色全读进来太重 */
/* 正在路上的读取。同一个 id 可能被两处同时触发(创作区选中角色时的 watch,
   与角色页的 @open),读两遍 IndexedDB 是白费 */
const charViewsLoading = new Map<string, Promise<void>>()
async function loadCharViews(id: string) {
  if (!id || charViews.value[id]) return
  const inflight = charViewsLoading.get(id)
  if (inflight) return inflight
  const task = (async () => {
    try {
      const rows = await getCharViews(id)
      /* 回来时如果这个角色的图已经有了,就别拿这份快照盖上去:
         期间多半刚生成完一张,库里那次写入是后发生的,却不一定被这次读看到 ——
         盖上去的结果是刚出的图从网格上消失,刷新才回来 */
      if (charViews.value[id]) return
      const known = new Set<string>(CHARACTER_VIEWS.map((v) => v.kind))
      /* 存储层只知道"有个 kind 字符串",这里按已知视图清单收窄 ——
         万一库里留着旧版写下的未知 kind,不该让它混进网格 */
      charViews.value = {
        ...charViews.value,
        [id]: rows
          .filter((r) => known.has(r.kind))
          .map((r) => ({ kind: r.kind as CharacterViewKind, data: r.data }))
      }
    } finally {
      charViewsLoading.delete(id)
    }
  })()
  charViewsLoading.set(id, task)
  return task
}

// 在创作区选中某个角色时顺手取一次;角色页那边由 @open 触发
watch(activeCharId, (id) => loadCharViews(id))

/* ===== 角色对话 ======================================================
   与设定图那条流水线同一套分工:请求从这里发,状态也留在这里,
   对话页只负责把消息铺出来、把意图交出来(见 ChatPage.vue)。
   -------------------------------------------------------------------- */

/**
 * 把每个角色的最后一条消息读进 chatLast —— 左栏那一行摘要与"最近活跃"排序都靠它。
 *
 * 消息是按角色懒加载的,不补这一趟的话,没打开过的角色在左栏一律显示
 * "No messages yet" 并排到最后:明明聊过,看起来却像从没聊过。
 *
 * 每个角色只读一条(见 idb.ts 的 getLastChatLine),代价与消息条数无关,
 * 所以可以放心在角色列表变化时整批重读。**只往后合并,不整体替换** ——
 * 刚说完的那一句比库里读出来的新,不能被盖回去。
 */
async function loadChatLast() {
  const ids = characters.value.map((c) => c.id)
  if (!ids.length) return
  const got = await getLastChatLine(ids)
  if (!got.size) return
  const next = { ...chatLast.value }
  for (const [id, msg] of got) {
    const known = next[id]
    if (!known || known.createdAt < msg.createdAt) next[id] = msg
  }
  chatLast.value = next
}

/* 说完一句就地把左栏那行更新掉,不必整批重读 */
function setChatLast(id: string, msg: ChatMessage) {
  chatLast.value = { ...chatLast.value, [id]: msg }
}
/* 清空/删除之后要把那行也撤掉,否则左栏还留着已经不存在的摘要 */
function dropChatLast(id: string) {
  if (!chatLast.value[id]) return
  const next = { ...chatLast.value }
  delete next[id]
  chatLast.value = next
}

/** 取某个角色的对话。与 loadCharViews 同一套懒加载 + 去重:
 *  同一个 id 可能被选角色的 watch 与角色页的入口同时触发 */
async function loadChatMessages(id: string) {
  if (!id || chatMessages.value[id]) return
  const inflight = chatLoading.get(id)
  if (inflight) return inflight
  const task = (async () => {
    try {
      /* 消息与记忆一起取:两者是同一屏的两半,
         分两趟只会让记忆晚一拍出现 */
      const [page, sum] = await Promise.all([getChatMessages(id, CHAT_PAGE), getChatSummary(id)])
      chatMessages.value = { ...chatMessages.value, [id]: page.list }
      chatHasMore.value = { ...chatHasMore.value, [id]: page.hasMore }
      if (sum) chatSummary.value = { ...chatSummary.value, [id]: sum }
    } finally {
      chatLoading.delete(id)
    }
  })()
  chatLoading.set(id, task)
  return task
}
watch(chatCharId, (id) => {
  if (id) loadChatMessages(id)
})

/**
 * 往前再读一档。**这只是显示上限,库里一条都没少** ——
 * 和"清空"完全是两回事,所以它不该有任何破坏性的味道。
 *
 * 这里不走 loadChatMessages:它会把内存里那份整个换掉,
 * 而读的这段时间里可能刚说完一句 —— 用库里那份盖上去就把新句子抹了。
 * 所以按 id 并一遍:老的在前面,内存里那份新的接在后面。
 */
async function loadEarlierChat(id: string) {
  if (!chatHasMore.value[id] || chatLoading.has(id)) return
  const cur = chatMessages.value[id] || []
  const task = (async () => {
    try {
      const { list, hasMore } = await getChatMessages(id, cur.length + CHAT_PAGE)
      const seen = new Set(list.map((m) => m.id))
      chatMessages.value = {
        ...chatMessages.value,
        [id]: [...list, ...cur.filter((m) => !seen.has(m.id))].sort(
          (a, b) => a.createdAt - b.createdAt
        )
      }
      chatHasMore.value = { ...chatHasMore.value, [id]: hasMore }
    } finally {
      chatLoading.delete(id)
    }
  })()
  chatLoading.set(id, task)
  return task
}

/**
 * 看一眼要不要把滑出窗口的消息压进记忆 —— 每一轮说完之后顺手跑,不挡用户看回复。
 *
 * "该不该压"由三个数算出来:**总条数 − 窗口大小 − 已覆盖条数**。
 * 减掉窗口,是因为最近那些条本来就还在上下文里,压了也是白压;
 * 结果够 CHAT_SUMMARIZE_AFTER 才值得花一次调用。
 *
 * 全程静默:它是一次后台整理,失败就从这一轮退出,covered 不推进,
 * 下一轮再试 —— 不弹提示,也不会因此丢东西。
 */
async function maybeSummarize(id: string) {
  const cfg = textConfig.value
  if (!cfg || chatSummarizing.has(id)) return
  chatSummarizing.add(id)
  const seq = chatSeq.get(id) || 0
  try {
    const cur = chatSummary.value[id]
    const total = await countChatMessages(id)
    const want = total - CHAT_WINDOW - (cur?.covered || 0)
    if (want < CHAT_SUMMARIZE_AFTER) return

    /* 由旧往新收。收多少条正是上面那个 want(封顶 CHAT_SUMMARY_CAP),
       这样算出来的边界刚好落在"最近窗口"前面,窗口里的原话一句都不会被压掉 */
    const batch = await getChatMessagesToSummarize(
      id,
      cur?.upToAt || 0,
      Math.min(want, CHAT_SUMMARY_CAP)
    )
    if (!batch.length) return

    const text = await summarizeChat(cfg, cur?.text || '', batch)
    /* 这期间对话被清掉过(或角色被删)就别写了 ——
       否则一次后台整理会把用户刚清掉的记忆又请回来 */
    if ((chatSeq.get(id) || 0) !== seq) return

    /* 这期间用户亲手改过记忆:他写的那个版本,比这轮重回炉压出来的更算数。
       这一轮就丢掉 —— covered 没动,消息一条不少,下一轮连着他的新版本一起再压 */
    if ((chatSummary.value[id]?.text || '') !== (cur?.text || '')) return

    const last = batch[batch.length - 1]
    const next: ChatSummary = {
      charId: id,
      text,
      upToId: last.id,
      upToAt: last.createdAt,
      covered: (cur?.covered || 0) + batch.length,
      updatedAt: Date.now()
    }
    await putChatSummary(next)
    chatSummary.value = { ...chatSummary.value, [id]: next }
  } catch {
    /* 见上:后台整理失败不打扰用户 */
  } finally {
    chatSummarizing.delete(id)
  }
}

/** 用户亲手改那段记忆。
 *  只换正文:upToAt / covered 说的是"哪些消息已经进去过了",
 *  改几个字不改变这件事 —— 动了它们,下一轮会把老消息重新压一遍。
 *  updatedAt 跟着刷,因为界面拿它显示"多久没动过了":
 *  用户刚写完的这一版,就不该还挂着"3 天前" */
async function editChatSummary(id: string, text: string) {
  const cur = chatSummary.value[id]
  if (!cur) return
  const next: ChatSummary = { ...cur, text, updatedAt: Date.now() }
  chatSummary.value = { ...chatSummary.value, [id]: next }
  await putChatSummary(next)
}

/** 忘掉这段记忆。**消息一条都不删** —— "角色不再记得"和"这事发生过"是两回事,
 *  那份原文还在库里,想回看随时能往上翻。
 *
 *  关键在于**不能只把正文清空**。压缩是从 upToAt 之后接着取的:
 *  正文一空而游标没动,下一轮就会把刚忘掉的那段重新压回来 —— 等于没忘。
 *  所以连游标一起推到最后一条:忘掉的那一段从此不再进记忆,
 *  而**在这之后**说的新话照常重新积累起来。
 *  记录本身留着(正文为空),因为那个"从哪之后不再记得"的游标得有地方待;
 *  界面据此不再显示记忆块(见 ChatPage 的 hasMemory)。 */
async function forgetChatSummary(id: string) {
  const before = chatSummary.value[id]
  const list = chatMessages.value[id] || []
  const last = list[list.length - 1]
  if (!before || !last) return
  /* 在途的压缩要是正跑着,回来会把记忆写回来 —— 作废那一轮 */
  bumpChatSeq(id)
  const total = await countChatMessages(id)
  const next: ChatSummary = {
    charId: id,
    text: '',
    /* covered 与 upToAt 一起推平到"最后一条为止"。
       covered 宁可算多一点:多算了只是下一轮少压一次,
       算少了会把已经忘掉的那段重新捞回来 */
    upToId: last.id,
    upToAt: last.createdAt,
    covered: total,
    updatedAt: Date.now()
  }
  chatSummary.value = { ...chatSummary.value, [id]: next }
  /* 与"清空对话"不同,这一步**立刻落盘**:忘掉就该马上生效,
     而且只有一条记录,写它不心疼。撤销再把老的那版写回去 */
  await putChatSummary(next)
  scheduleUndo({
    label: 'Memory forgotten',
    undo: () => {
      chatSummary.value = { ...chatSummary.value, [id]: before }
      void putChatSummary(before)
    },
    /* 上面已经落过笔了,窗口结束没有别的事要做 ——
       记忆是模型生成的,撤销窗口一过就真的找不回来了 */
    purge: () => {}
  })
}

/** 进对话页时挑一个角色:留着上次那个(还在的话),否则取列表第一个。
 *  一个角色都没有时保持空 —— 页面自己会给"先去建一个"的空态 */
function ensureChatChar() {
  if (chatCharId.value && characters.value.some((c) => c.id === chatCharId.value)) return
  chatCharId.value = characters.value[0]?.id || ''
}

/** 从别处进对话页:带上要看的那个人(角色详情页的入口走这里) */
function openChat(charId: string) {
  chatCharId.value = charId
  page.value = 'chat'
}

/** 把一条消息追加进内存里的那一份 */
function pushChatMessage(id: string, msg: ChatMessage) {
  chatMessages.value = { ...chatMessages.value, [id]: [...(chatMessages.value[id] || []), msg] }
}

function isAbort(e: unknown): boolean {
  return !!e && typeof e === 'object' && (e as { name?: string }).name === 'AbortError'
}

/**
 * 发一轮,一边收一边长。
 *
 * 三条收尾路径 —— 说完 / 用户按 Stop / 上游出错 —— **都保留已经收到的字**:
 * 用户按 Stop 不是"这次失败了",是"说到这儿够了",
 * 把半句话删掉等于惩罚他按了那个按钮(与设定图"中断后保留旧图"同一条原则)。
 */
async function runChat(id: string) {
  const c = characters.value.find((x) => x.id === id)
  const cfg = textConfig.value
  if (!c || chatBusy.value[id]) return
  if (!cfg) {
    notice.value = 'Add a text model in API settings before chatting.'
    return
  }

  /* 上文现场从内存里取:最近 CHAT_WINDOW 条。
     被截掉的旧消息**不从库里删** —— 它们还在,只是这一轮不带 */
  const context = (chatMessages.value[id] || [])
    .slice(-CHAT_WINDOW)
    .map((m) => ({ role: m.role, content: m.content }))
  // 最后一句必须是用户说的,否则这一轮本来就不该发
  if (!context.length || context[context.length - 1].role !== 'user') return

  /* 用户这一轮带没带图。带了要另说两件事:
     1. 请求改用识图那条配置 —— **看图得有看图的模型**,文本模型多半不支持,
        而它回的那句参数错用户看不出"该换个模型了";没配识图就照旧用文本配置
        (会报错,但那是实情,如实转述给用户);
     2. 把那张图读回来转成 data URL 一起发 —— 库里存的是 Blob,
        发出去要的是字符。**只带当前这一条**:历史里的图不重发(一张上千 token)。 */
  const lastSent = (chatMessages.value[id] || []).slice(-1)[0]
  const picId = lastSent?.imageId || ''
  const useCfg = picId ? visionConfig.value || cfg : cfg
  let images: string[] | undefined
  if (picId) {
    const rec = await getChatImage(picId)
    /* 读不回来就照常发文字 —— 整轮失败比"少一张图"更糟 */
    if (rec) images = [await blobToDataURL(rec.blob)]
  }

  const ctrl = new AbortController()
  chatControllers.set(id, ctrl)
  chatBusy.value = { ...chatBusy.value, [id]: true }

  /* 先摆一条空的助手消息占位,增量往它身上长。不这么做的话字会先攒在一个
     局部变量里、等说完才一次性冒出来,那就不叫流式了。
     注意:要从 chatMessages 里取回**响应式代理**再改 ——
     手里那个原始对象改得再勤也不会触发渲染 */
  pushChatMessage(id, {
    id: uid(),
    charId: id,
    role: 'assistant',
    content: '',
    createdAt: Date.now()
  })
  const replyList = chatMessages.value[id] || []
  const reply = replyList[replyList.length - 1]

  let stopped = false
  let failure = ''
  /* 上游为什么停下。'length' 表示它撞上了 max_tokens —— 见下面收尾那一段 */
  let finish = ''
  /* 这一轮的情绪,由服务端从正文末尾剪下来单独给 */
  let mood = ''
  try {
    const out = await chatStream({
      character: chatPayloadOf(c),
      messages: context,
      /* 长期记忆随请求带上。它是"这一整段对话的状态",
         与角色资料分开传 —— 同一个角色换一段对话,记忆不该跟着走 */
      memory: chatSummary.value[id]?.text || '',
      images,
      cfg: useCfg,
      signal: ctrl.signal,
      onDelta: (delta) => {
        if (reply) reply.content += delta
      }
    })
    finish = out.finish
    mood = out.mood
  } catch (e) {
    if (isAbort(e)) stopped = true
    else failure = e instanceof Error ? e.message : 'Request failed'
  } finally {
    chatControllers.delete(id)
    chatBusy.value = { ...chatBusy.value, [id]: false }
  }

  if (!reply) return
  if (stopped) reply.stopped = true
  /* 撞上 max_tokens —— 上游把话说到了额度上沿就停下。
     与 stopped 分开记:那个是人按的,这个是模型的额度用完了。
     不记的话前端看到的和"正常说完"一模一样,用户会以为角色话说一半是它自己的风格 */
  else if (finish === 'length') reply.truncated = true
  /* 情绪挂在这一条上。收在半截上时多半没有(标签本来就在末尾),
     没有就不写 —— 界面上那枚小药丸宁可不出,也不要显示一个错的 */
  if (mood) reply.mood = mood
  if (!reply.content.trim() && !stopped) {
    /* 一个字都没收到(上游出错,或它真的什么都没说):
       把这条空壳摘掉,免得消息流里留一个空气泡。
       摘掉之后最后一条又回到用户那句 —— 界面上因此会给出"重试",
       它走的就是 regenerateChat(见那边的注释) */
    chatMessages.value = {
      ...chatMessages.value,
      [id]: (chatMessages.value[id] || []).filter((m) => m.id !== reply.id)
    }
    // 左栏那行还停在上一次的回复上,说明这一轮没留下东西:让它退回去
    dropChatLast(id)
    void loadChatLast()
  } else {
    // 落盘要交原始对象:reactive 代理进不了 IndexedDB 的 structuredClone
    await putChatMessage({ ...toRaw(reply) })
    setChatLast(id, { ...toRaw(reply) })
  }
  if (stopped) notice.value = 'Stopped.'
  else if (failure) notice.value = failure
  /* 收尾之后顺手看一眼要不要压记忆。放在最末是有意的:
     它是后台整理,不该挡在用户看到回复之前,也不该挤进上面那两句提示 */
  void maybeSummarize(id)
}

/** 发一句。先把用户那句落进去,再连同它一起发 ——
 *  不加这一步,模型看不到这次问的到底是什么 */
async function sendChat(id: string, body: string, image?: Blob) {
  if (chatBusy.value[id]) return
  /* 先把图落库,再把 id 挂到消息上。顺序不能反 ——
     反过来写的话,中途失败会留下一条指着不存在图片的消息 */
  let imageId = ''
  if (image) {
    imageId = uid()
    try {
      await putChatImage({ id: imageId, blob: image, createdAt: Date.now() })
    } catch {
      /* 存不下就别把 id 挂上去:那会是一条永远显示不出图的记录,
         用户还以为是图坏了 */
      imageId = ''
      notice.value = 'Could not save that image — sending the message without it.'
    }
  }
  const mine: ChatMessage = {
    id: uid(),
    charId: id,
    role: 'user',
    content: body,
    createdAt: Date.now(),
    ...(imageId ? { imageId } : {})
  }
  if (!mine.content.trim() && !mine.imageId) return
  pushChatMessage(id, mine)
  await putChatMessage(mine)
  // 左栏那行摘要跟着这一句走 —— 不必为此重读一遍库
  setChatLast(id, mine)
  await runChat(id)
}

/** 重新生成:删掉最后那条助手消息再发一次。**用户那句不动** ——
 *  要重来的是它的回答,不是让用户再说一遍 */
async function regenerateChat(id: string) {
  if (chatBusy.value[id]) return
  const list = chatMessages.value[id] || []
  const last = list[list.length - 1]
  if (!last) return
  /* 最后一条是助手消息 ⇒ 说了一半想重来,先把它删掉(用户那句留着)。
     是用户消息 ⇒ 上一轮压根没答上来(runChat 失败时会把空壳删掉),
     那就什么都不用删,直接重发。两种情况共用这一个入口,
     所以"报错之后重试"不需要另写一条链路 */
  if (last.role === 'assistant') {
    /* 这条正要被删掉,它可能还在念 —— 念着一条已经不存在的消息没有道理。
       (不在这里停也不算错:新的回复开始念时会掐掉它,但那中间有几秒) */
    stopSpeaking()
    await deleteChatMessage(last.id)
    chatMessages.value = { ...chatMessages.value, [id]: list.slice(0, -1) }
    /* 左栏那行摘要可能就是这一条,得跟着回退到上一条 */
    const prev = list[list.length - 2]
    if (prev) setChatLast(id, prev)
    else dropChatLast(id)
  }
  await runChat(id)
}

function stopChat(id: string) {
  chatControllers.get(id)?.abort()
}

/** 清空一个角色的对话。走撤销条 —— 与删除角色、清空历史同一套规矩:
 *  说没就没的东西得留一条退路 */
function clearChat(id: string) {
  const list = chatMessages.value[id] || []
  const beforeSummary = chatSummary.value[id]
  const beforeLast = chatLast.value[id]
  if (!list.length && !beforeSummary) return
  // 正在说话的先掐掉,否则它会往上文里补一句刚落空的消息
  chatControllers.get(id)?.abort()
  /* 正在念的那句也一起停:它念的正是一条马上就不存在的消息 */
  stopSpeaking()
  /* 也让在途的压缩作废:它回来时这段对话已经不是原来那段了 */
  bumpChatSeq(id)
  const before = list.map((m) => ({ ...toRaw(m) }))
  // 清空之后前面当然没有更早的了,顺手把"加载更早"收掉
  const hadMore = !!chatHasMore.value[id]
  chatMessages.value = { ...chatMessages.value, [id]: [] }
  chatHasMore.value = { ...chatHasMore.value, [id]: false }
  /* 记忆必须跟着一起清 —— 消息没了而记忆还留着,下一句开口就会提起
     一段用户刚刚清掉的旧事,那比失忆更糟 */
  const sumRest = { ...chatSummary.value }
  delete sumRest[id]
  chatSummary.value = sumRest
  // 左栏那行也得跟着空掉,不然它还挂着一段已经不存在的对话
  dropChatLast(id)
  scheduleUndo({
    label: 'Conversation cleared',
    undo: () => {
      chatMessages.value = { ...chatMessages.value, [id]: before }
      chatHasMore.value = { ...chatHasMore.value, [id]: hadMore }
      if (beforeSummary) chatSummary.value = { ...chatSummary.value, [id]: beforeSummary }
      if (beforeLast) setChatLast(id, beforeLast)
      /* 撤销要立刻落盘:窗口里别的操作可能已经把"它是空的"写进去了 */
      void (async () => {
        await deleteChatOf(id)
        for (const m of before) await putChatMessage(m)
        if (beforeSummary) await putChatSummary(beforeSummary)
      })()
    },
    purge: () => {
      /* 附过的图也跟着走(与 deleteChar 同一处说明)。
         这里用它开头取的那份 list —— purge 执行时 chatMessages 里
         那一份已经被清空了,问不出来 */
      for (const m of list) {
        if (m.imageId) void deleteChatImage(m.imageId)
      }
      void deleteChatOf(id)
    }
  })
}

// 进对话页时确保手上有一个角色
watch(page, (p) => {
  if (p === 'chat') ensureChatChar()
})

/* 角色是异步读进来的:进页面那一刻可能还没到,挑出来的是空。
   角色到位(或列表长度变了)时补挑一次 —— 否则明明有角色,
   对话页却一直停在"挑一个"的空态上 */
watch(
  () => characters.value.length,
  () => {
    if (page.value === 'chat') ensureChatChar()
  }
)

/* 角色最多并进几张参考图。再多上游多半不认,而请求体会迅速变大 */
const MAX_CHAR_REFS = 4

/** 当前角色的图 → data URL,发请求时并进参考图。
 *  角色不占表单里的参考图槽 —— 表单上看到的始终是用户自己挑的那张,
 *  角色这几张只在这一刻合进来。
 *  正面固定排最前:它是唯一的主视图,前段权重更高,脸就定在它上面。
 *  上传的那张底图不在这里:它只为生成正脸服务一次(见 genCharView),
 *  那之后 c.ref 里存的已经是正脸本身,再送一次就是把同一张图送两遍 */
async function charRefSrcs(): Promise<string[]> {
  const c = activeCharacter.value
  if (!c) return []
  // 视图是按需加载的,这里先确保取过一次
  await loadCharViews(c.id)
  const out: string[] = []
  const front = viewOf(c.id, 'front')
  if (front) out.push(await blobToDataURL(front.data))
  for (const v of CHARACTER_VIEWS) {
    if (out.length >= MAX_CHAR_REFS) break
    // 正面已经送过,别的视图按顺序补
    if (v.kind === 'front') continue
    const view = viewOf(c.id, v.kind)
    if (view) out.push(await blobToDataURL(view.data))
  }
  return out
}

// —— 生图 ——

/* 中文输入法里用回车「上屏」也会触发 keydown.enter(keyCode 229,isComposing 为真)。
   这里必须提前返回、且不能 preventDefault —— 一 prevent 就把输入法确认候选词的
   动作吃掉了,而且会把还没上屏的拼音当成提示词发出去。 */
function onEnter(e: KeyboardEvent) {
  if (e.isComposing || e.keyCode === 229) return
  e.preventDefault()
  doGenerate()
}

/* 用户手动改动提示词 = 开启一个新的实验分支,和"从某条记录拉下来再改"不再是同一件事。
   所以来源要清掉:这一批落盘时就不会再挂父记录,链在这里断开。
   撤销点也一并清掉:Undo 是给"看完改写结果觉得不对,想回到原稿"用的 ——
   改写完自己又动过笔,再点它就变成抹掉刚敲的这段,那个场景已经不成立了。
   清掉之后按钮回到改写态,顺手也能再改写一次。
   注意这里只认"用户敲的":改写结果与撤销都是程序赋值,不会走 @input,
   所以它们不会自己把撤销点清掉(清空输入框的那个按键同理,那是要撤回来的场景) */
function onPromptEdit() {
  pendingParentId.value = undefined
  preEnhance.value = ''
}

async function doGenerate() {
  /* 这里不再用"正在生成"拦第二次点击:那正是要解决的问题 ——
     生成键在跑的时候变成暂停键,于是生成中途发不出新的了。
     现在每次点击各自成批,可以叠着跑 */
  /* 改写回来时会整体覆盖提示词。此刻发出去的图,用的是改写到一半的内容,
     而用户看到的输入框马上就要变成另一段文字 —— 这批图会和界面对不上。
     改写按钮那边也置灰了,这里再拦一道是因为回车也能触发生成 */
  if (enhancing.value) return
  if (!prompt.value.trim()) {
    fail('Enter a prompt first')
    return
  }
  if (!configured()) {
    /* 用 notice 而不是 fail:这条路径紧接着就跳到设置页,而 fail 写的是 home
       那条 .err —— 页面已经切走,提示留在不渲染的 DOM 里等于没提示 */
    notice.value = 'Set an API base URL in Settings first'
    openConfigManager()
    return
  }
  /* 发出去了,参数面板就没有再开着的理由:它是"发之前调一调"的东西,
     而这一批的参数此刻已经锁进槽里,面板留着只会挡住下面的图墙 */
  openPanel.value = ''
  // 选了多个模型时走另一条链路:一次发给每个模型,结果并排
  if (compareMode.value) {
    await doRace()
    return
  }

  /* 发起前锁定这一批的参数,后面一律读快照,避免中途改参数串味。
     套了角色时这里锁的是合成后的提示词 —— 真正发出去的就是它 */
  const runPrompt = composedPrompt()
  const runSize = size.value
  const runN = Math.max(1, n.value)
  /* 同一次点生成就是一批。group 让生成的结果在图墙上可归拢,
     和对比出图共用同一个字段语义(见 groupId 注释) */
  const genGroupId = `gen-${Date.now().toString(36)}`
  // 扩展参数与参考图同样要快照:它们在 await 期间可能被改动
  const extras = extraParams()
  // 种子也是快照的一部分:中途改它不该影响已经发出的这一批
  const seedNum = seedFor()
  const refSrc = refImage.value
  /* 参考图可以不止一张:用户自己挑的图 + 角色的那几张一起送 ——
     单张太弱,多视图才锁得住同一张脸。用户那张排最前,它多半就是这次要改的底图 */
  const refList: string[] = []
  if (refSrc) refList.push(refSrc)
  for (const s of await charRefSrcs()) if (!refList.includes(s)) refList.push(s)

  /* 张数就是槽数。种子要逐张错开:原来一个请求带 n=4 时,上游按序号派生四张;
     拆成四次请求后如果都传同一个种子,四次会拿到同一张图。
     填了种子就 S、S+1、S+2 …… —— 指定种子仍然可复现,只是从"上游派生"
     变成"我们自己接管这件事" */
  const slots: GenSlot[] = Array.from({ length: runN }, (_, i) => {
    const s = seedNum === undefined ? undefined : seedNum + i
    return {
      id: uid(),
      // 单模型出几张 = 一条记录带几张图(与拆分前的粒度一致)
      recordKey: genGroupId,
      groupId: genGroupId,
      config: config.value,
      label: config.value.name || config.value.model || config.value.baseUrl || 'Model',
      model: config.value.model || '',
      prompt: runPrompt,
      size: runSize,
      extras,
      ...(s !== undefined ? { seed: s } : {}),
      refList,
      refSrc: refSrc || undefined,
      characterId: activeCharId.value || undefined,
      parentId: pendingParentId.value,
      startedAt: Date.now(),
      state: 'running' as const,
      results: []
    }
  })
  await runBatch(slots)
}

/* 同时在跑的请求数上限。拆开之后"张数 = 请求数",一次 10 张原样并发
   很容易被上游限流(429),而限流的报错长得像"这个模型坏了"。
   排队只让慢的那几张等一等,不影响结果 */
const SLOT_CONCURRENCY = 3

/** 按上限并发跑。够用就好的轮子 —— 不引依赖,也不做动态调参 */
async function runWithLimit<T>(items: T[], limit: number, run: (t: T) => Promise<void>) {
  const queue = [...items]
  const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    for (let next = queue.shift(); next !== undefined; next = queue.shift()) await run(next)
  })
  await Promise.all(workers)
}

/** 跑一批槽,结束再落盘、收尾。单模型多张与多模型对比共用这一条 */
async function runBatch(slots: GenSlot[]) {
  genSlots.value = [...genSlots.value, ...slots]
  error.value = ''
  notice.value = ''
  canRetry.value = false
  /* 跑的是 genSlots 里那份响应式代理,而不是传进来的本地数组。
     ref 的深层代理只在**读取**时才套上,而 runSlot 直接改原对象的
     state / results —— 不经过 set trap,逐格的完成与失败就不会触发渲染,
     整批跑完才一起变(点掉一张的停止键,那格骨架会一直转到最后)。
     按 id 取回代理,顺序与 slots 一致,下面 persistBatch 照旧读原数组 */
  const ids = new Set(slots.map((s) => s.id))
  const live = genSlots.value.filter((s) => ids.has(s.id))
  try {
    /* 上限内并发 —— 既不串成一条长队(多张的总耗时等于各张之和),
       也不一次性全丢出去(自己把自己限流) */
    await runWithLimit(live, SLOT_CONCURRENCY, runSlot)
  } finally {
    await persistBatch(slots)
    /* 结束的槽立刻撤出图墙:留下的只有图和提示。
       骨架格一直挂在那儿会让人以为还在跑 */
    genSlots.value = genSlots.value.filter((s) => !ids.has(s.id))
  }
  reportBatch(slots)
}

/** 一个槽 = 一次请求 = 一张图。异常在这一层吃掉 ——
 *  一张失败不该拖累同批的其它张,这正是拆开跑最值钱的地方 */
async function runSlot(slot: GenSlot) {
  // 排队期间被停掉的:不必再发出去
  if (slot.state !== 'running') return
  const ctl = new AbortController()
  slotControllers.set(slot.id, ctl)
  try {
    const res = await generate(
      {
        prompt: slot.prompt,
        size: slot.size,
        n: 1,
        ...(slot.refList.length ? { images: slot.refList } : {}),
        ...(slot.seed !== undefined ? { seed: slot.seed } : {}),
        // 由厂商能力表决定带哪些扩展参数:auto 与已知不支持的都不发
        ...slot.extras
      },
      slot.config,
      ctl.signal
    )
    slot.results = res
    slot.state = 'done'
  } catch (e: any) {
    // 主动终止不是失败,但要说清是"你停的",不是模型坏了
    slot.state = e?.name === 'AbortError' ? 'stopped' : 'error'
    // 上游原文可能很长,槽位里放不下;完整内容留到汇总那条提示里
    if (slot.state === 'error') {
      slot.error = String(e?.message || 'Generation failed').slice(0, 300)
    }
  } finally {
    slot.elapsedMs = Date.now() - slot.startedAt
    slotControllers.delete(slot.id)
  }
}

/** 落盘:同一批里按 recordKey 归并。
 *  单模型的几张合成一条记录(与拆分前一致),对比的每模型一条(也与拆分前一致) */
async function persistBatch(slots: GenSlot[]) {
  const groups = new Map<string, GenSlot[]>()
  for (const s of slots) {
    const list = groups.get(s.recordKey)
    if (list) list.push(s)
    else groups.set(s.recordKey, [s])
  }
  for (const group of groups.values()) {
    const ok = group.filter((s) => s.state === 'done' && s.results.length)
    if (!ok.length) continue
    // 条件取第一个槽:同键的这几个除了种子逐张递进,其余完全一样
    const head = group[0]
    /* 必须取原始数组:槽上的 results 是响应式代理,而 indexedDB 用结构化克隆
       写盘,代理克隆不了(DataCloneError),记录会写不进去 —— 界面看着图还在
       (内存里有),刷新就没了,还会误报"没能保存到本地" */
    const results = ok.flatMap((s) => toRaw(s.results))
    const record = await recordFor(results, {
      prompt: head.prompt,
      size: head.size,
      model: head.model || undefined,
      // 只记真正发出去的扩展参数,免得预览里展示出当时并没生效的档位
      quality: head.extras.quality,
      background: head.extras.background,
      hasRef: !!head.refSrc,
      groupId: head.groupId,
      configId: head.config.id,
      seed: head.seed,
      refSrc: head.refSrc,
      /* 「拉自某条记录改一个变量重跑」的出处。普通手写提示词这里是空,不入链 */
      parentId: head.parentId,
      // 套了角色就记下是谁 —— 预览里才说得清"这条是照哪个角色出的"
      characterId: head.characterId,
      // 一批里各张耗时不同,记最慢的那张 = 这一批总共要等多久
      elapsedMs: Math.max(...ok.map((s) => s.elapsedMs || 0))
    })
    await persist(record)
  }
}

/** 这一批跑完说一句。全成败占用错误区(有原文和重试),部分失败走中性的 notice,
 *  一张都没失败就什么都不说 —— 图自己会出现在图墙里 */
function reportBatch(slots: GenSlot[]) {
  const failed = slots.filter((s) => s.state === 'error')
  if (!failed.length) return
  /* 同一个模型的几张失败时不必把名字念好几遍:按名字收一遍,
     一家的报错就用第一条(同一次请求失败,原因通常也只有一个) */
  const byName = new Map<string, string>()
  for (const s of failed) if (!byName.has(s.label)) byName.set(s.label, s.error || 'failed')
  const names = [...byName.keys()].join(', ')
  if (byName.size === new Set(slots.map((s) => s.label)).size) {
    fail([...byName].map(([label, err]) => `${label}: ${err}`).join('\n'), true)
    return
  }
  notice.value = `${failed.length} of ${slots.length} failed (${names}) — the rest are in your recent creations`
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
    /* 这一批是「从某条记录拉下来改的」时的父记录 id。见 pendingParentId */
    parentId?: string
    /* 这一批套用的角色 id。见 Character */
    characterId?: string
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
    parentId: meta.parentId,
    characterId: meta.characterId,
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
      /* 标记过的记录不参与自动清理(见 idb.ts 的 planPrune)。既然因此少删了,
         就得说出来 —— 否则用户会觉得"我标记了图,空间却没腾出来"是坏了 */
      const kept = pruned.keptMarked
        ? ` Kept ${pruned.keptMarked} marked ${pruned.keptMarked === 1 ? 'item' : 'items'}.`
        : ''
      notice.value = pct
        ? `Local storage is about ${pct}% full. Removed the oldest ${pruned.removed} history ${pruned.removed === 1 ? 'item' : 'items'} to free space.${kept}`
        : `Removed the oldest ${pruned.removed} history ${pruned.removed === 1 ? 'item' : 'items'} to limit local usage.${kept}`
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
  /* 与单模型那条路一致:套了角色就得把角色设定合成进去。
     下面参考图与 characterId 都照常备着,提示词少了这一段的话,
     出的图不像这个角色,记录却声称用了它 —— 预览里重跑还会再错一次 */
  const runPrompt = composedPrompt()
  const refSrc = refImage.value
  /* 角色在对比出图里同样要并进去:那是另一条链路,参考图得在这儿另做一份快照 */
  const refList: string[] = []
  if (refSrc) refList.push(refSrc)
  for (const s of await charRefSrcs()) if (!refList.includes(s)) refList.push(s)
  const groupId = `race-${Date.now().toString(36)}`
  /* 尺寸与扩展参数在发起前逐配置定下来:中途改参数不该影响已经发出的这一批,
     而且各模型的合法尺寸/参数本来就不一样,不能拿一家的能力套所有家。
     张数固定 1:对比要看的是"哪个模型更好",不是每个模型各来三张 */
  const slots: GenSlot[] = targets.map((c) => {
    const s = seedFor(c)
    return {
      id: uid(),
      // 每个模型各自成一条记录:这正是对比的意义
      recordKey: c.id,
      groupId,
      config: c,
      label: c.name || c.model || c.baseUrl,
      model: c.model || '',
      prompt: runPrompt,
      size: sizeFor(c),
      extras: extraParams(c),
      ...(s !== undefined ? { seed: s } : {}),
      refList,
      refSrc: refSrc || undefined,
      characterId: activeCharId.value || undefined,
      parentId: pendingParentId.value,
      startedAt: Date.now(),
      state: 'running' as const,
      results: []
    }
  })
  await runBatch(slots)
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

/* 停掉一张。只掐这一个槽 —— 同一个模型出的另外几张、
   以及叠着跑的另一批,都不该被牵连 */
function stopSlot(id: string) {
  const ctl = slotControllers.get(id)
  if (ctl) {
    ctl.abort()
    return
  }
  /* 还没轮到它发出去(并发上限之外的那些)。不处理的话这一格会一直转 ——
     用户点了停止却什么都没发生,比按钮没反应更糟 */
  const slot = genSlots.value.find((s) => s.id === id)
  if (slot?.state === 'running') slot.state = 'stopped'
}
/** 全部停下。骨架格上各自有停止键,这个入口是给"一次跑了十来张、
 *  不想一个个点"的情况用的 */
function stopAllSlots() {
  for (const c of slotControllers.values()) c.abort()
  // 排队中的那几个没有手柄可掐,得单独标记
  for (const s of genSlots.value) if (s.state === 'running') s.state = 'stopped'
}

// 重试:按当前输入再发一次(用户可能已经改过提示词或参数,以界面上的为准)
function retry() {
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
  /* 这一批的出处:只有当它确实是"从某条记录拉下来的"才记。
     普通手写提示词的生成没有 fromEntryId,来源就保持为空 */
  pendingParentId.value = p.fromEntryId
  /* 配置先还原 —— 配方里最容易漏、又最影响结果的就是"当时用的哪个模型"。
     不还原它,重跑用的其实是当前生效的那个:换了模型却以为是在同一张图上微调。
     配置已被删掉时保持当前这条,但要说一声,别让人以为还原成了 */
  if (p.configId && p.configId !== config.value.id) {
    const c = configs.value.find((x) => x.id === p.configId && x.kind !== 'text' && x.kind !== 'vision')
    if (c) activateConfig(c)
    else notice.value = 'The model this image used is no longer in your configs — using the current one.'
  }
  applySize(p.size)
  if (p.n) n.value = Math.min(N_MAX, Math.max(1, p.n))
  // 已知不支持的厂商直接跳过,免得把界面上根本不存在的档位偷偷塞进去
  if (p.quality && provider.value.quality !== 'no') quality.value = p.quality
  if (p.background && provider.value.background !== 'no') background.value = p.background
  seed.value = p.seed !== undefined ? String(p.seed) : ''
  /* 配方是自洽的:它的 prompt 里已经含了当时前置的角色描述。
     所以这里不"还原"角色 —— 还原会让描述再前置一次,变成重复;
     但必须先把当前选着的角色卸下:否则刚选的角色描述会跟着这段配方一起发出去、
     设定图也会跟着并进参考图,而用户要的是"照这条记录重跑" */
  detachCharacter()
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

// 预览里「存进提示词库」:连带参数与一张封面存下来。
// 不切页、也不关预览 —— 存库是顺手做的一步,不该把用户从正在看的图上带走。
// 回执由预览卡上的按钮自己给(存完短暂变成 Saved)
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

/* —— 作品集(Collection) ——
   把一组生成归拢起来,并让它们不被存储清理淘汰(见 idb.ts 的 pruneHistory)。
   目录本身轻量,放 localStorage;归属挂在记录上,在这里同步内存并落盘 */

/** 新建一个作品集。空标题用占位名兜底;返回新 id 方便调用方顺手把它选中 */
function createCollection(title: string): string {
  const c: Collection = {
    id: uid(),
    title: title.trim() || 'Untitled collection',
    createdAt: Date.now()
  }
  collections.value = [c, ...collections.value]
  saveCollections(collections.value)
  return c.id
}

/** 删除作品集:目录里摘掉,并把它名下所有记录的归属一并清掉。
    清掉归属之后那些记录就重新可以被自动清理 —— 这是删作品的预期语义。

    与别处的删除同一套:立刻生效、几秒内可撤销,真正落盘发生在窗口结束时。
    这里是全站唯一一处点了就不可反悔的删除,而它一按就解除了 pruneHistory
    对这批记录的豁免 —— 用户特意归拢好的作品可能就被自动清理掉了 */
function deleteCollection(id: string) {
  const at = collections.value.findIndex((c) => c.id === id)
  if (at < 0) return
  const gone = collections.value[at]
  /* 摘归属之前先把受影响的记录记下来:撤销时要原样还回去。
     摘掉归属只动内存,写盘推迟到窗口结束 —— 窗口里撤销回来不必再读一次库 */
  const detached = history.value.filter((h) => h.collectionId === id)
  collections.value = collections.value.filter((c) => c.id !== id)
  saveCollections(collections.value)
  for (const h of detached) delete h.collectionId
  scheduleUndo({
    label: 'Collection deleted',
    undo: () => {
      // 放回原来的位置:目录顺序有意义(最近建的在前)
      collections.value = [
        ...collections.value.slice(0, Math.min(at, collections.value.length)),
        gone,
        ...collections.value.slice(Math.min(at, collections.value.length))
      ]
      saveCollections(collections.value)
      for (const h of detached) {
        h.collectionId = id
        saveHistoryRecord(toRaw(h))
      }
    },
    // 窗口结束才算真删:这时才把"归属已摘掉"落盘
    purge: () => {
      for (const h of detached) saveHistoryRecord(toRaw(h))
    }
  })
}

/** 把预览里当前这条记录挂到某个作品集下(collectionId 为空串即摘出)。
    改的是内存 + 落盘,不重跑裁剪 —— 归属不影响裁剪体积 */
function assignCollection(collectionId: string) {
  const entry = previewEntry.value
  if (!entry) return
  if (collectionId) entry.collectionId = collectionId
  else delete entry.collectionId
  saveHistoryRecord(toRaw(entry))
}

/** 预览里「新建作品集并纳入当前这条」:连建带挂一次做完,
    免得用户先建好再回来翻那条的去挂 */
function createAssignCollection(title: string) {
  const id = createCollection(title)
  if (previewEntry.value) assignCollection(id)
}

</script>

<template>
  <div class="shell" :class="{ 'shell-wide': page === 'chat' }">
    <!-- 品牌 + 视图切换 + 全局操作 -->
    <!-- 顶部横条:字标、导航与主题开关都在最顶层,每一页都在(画布页也不例外),
         切页时相对位置不动。
         字标是"KImage + 一截手写体",那截就是当前页名 ——
         首页写 Studio,其余页写各自的名字,名字取自导航那份清单(lib/nav.ts) -->
    <header ref="mastEl" class="masthead" :class="{ scrolled }">
      <div class="wordmark">
        <span class="title">
          KImage
          <span class="title-script">{{ wordmarkSuffix }}</span>
        </span>
      </div>

      <!-- 居中的视图切换:滑块位置即当前打开的面板。
           轨道 40px / 内边距 5px,滑块因此留在 30px:
           原来 36/3 时白底只比黑色选中底高 3px,两者看起来一样高 -->
      <NavSegment v-model="navView" :warn="!configured()" />

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

    <!-- 视图切换:平级视图同时只挂载一个(画布例外,它是常驻的 v-show) -->
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
          <!-- 改写中整块输入框走等待态:呼吸光晕(见 style.css 的 .halo-breathe)。
               原来这段时间里只有改写按钮上的字变了,输入框本身毫无动静 -->
          <div class="prompt-box" :class="{ 'halo-breathe': enhancing }">
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
                @input="onPromptEdit"
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
              <!-- 角色:和模型并排 —— 两者是同一层的东西(用谁出图),都该一眼可见。
                   收进「更多」里等于每次用角色都要先展开一次。
                   选中的角色直接露头像,名字进 tooltip:一排参数里放文字名会把行撑长 -->
              <!-- 外面这层给"移除"角标当定位基准:角标要探出胶囊一点点 -->
              <span class="param-char">
                <button
                  class="param-btn"
                  :class="{ on: openPanel === 'chars', filled: !!activeCharId }"
                  :data-tip="activeCharacter ? `Character · ${activeCharacter.name}` : 'Character'"
                  :aria-label="activeCharacter ? `Character · ${activeCharacter.name}` : 'Character'"
                  @click="togglePanel('chars')"
                >
                  <img v-if="activeCharSrc" class="param-avatar" :src="activeCharSrc" alt="" />
                  <PhMaskHappy v-else aria-hidden="true" />
                </button>
                <!-- 选中之后悬停露出来的是"摘下来",不再是那张正脸 ——
                     看清一张脸是挑人的事,挑完了要解决的是另一个问题。
                     角标压在胶囊右上角,只占一角,不与"点开面板"抢位置 -->
                <button
                  v-if="activeCharId"
                  class="char-drop"
                  data-tip="Remove character"
                  aria-label="Remove character"
                  @click="detachCharacter"
                >
                  <PhX aria-hidden="true" />
                </button>
              </span>
              <!-- 尺寸/张数/画质/背景/参考图收进这一个入口:参数行只留模型与角色,
                   其余点开就是完整面板,不必挤成一长排。
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
                  :disabled="enhancing || !prompt.trim()"
                  :aria-label="compareMode ? 'Compare models' : 'Generate'"
                  :data-tip="
                    enhancing
                      ? 'Rewriting the prompt…'
                      : compareMode
                        ? `Generate with ${selectedConfigs.length} models`
                        : 'Generate with Enter'
                  "
                  @click="doGenerate()"
                >
                  <!-- 生成中不再是停止键:它原来占着这个位置,于是"想接着发一批"
                       这条最常走的路被自己的暂停键堵死了。
                       停止入口下到每一张的占位格上(见图墙),这里始终是"再生成" -->
                  <PhArrowRight aria-hidden="true" />
                </button>
              </div>
            </div>

            <!-- 展开面板:用 grid-template-rows 动画高度,收起时连续合拢无跳变 -->
            <div class="fold" ref="panelEl" :class="{ open: !!openPanel }">
              <div class="fold-inner">
                <!-- 面板滚动时悬停卡片会停在旧坐标上不动了(fixed 不跟着滚),
                     所以一滚就收掉,等鼠标挪到下一个头像上再出 -->
                <div class="param-panel" @scroll="hideCharPeek">
                  <!-- 配置 -->
                  <div v-if="shownPanel === 'config'" class="pp-body">
                    <!-- 出图与改写分两组,各自标各自的"当前";空组不渲染 -->
                    <div v-if="imageConfigs.length" class="pp-group">
                      <span class="pp-label"><PhImageSquare class="pp-label-ico" aria-hidden="true" />Image model</span>
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
                      <span class="pp-label"><PhTextT class="pp-label-ico" aria-hidden="true" />Text model</span>
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
                    <!-- 识图模型:与上面那条同构。它不进"这次跑哪几个模型"的选择集合,
                         只在角色向导里读参考图 —— 所以是单选 -->
                    <div v-if="visionConfigs.length" class="pp-group">
                      <span class="pp-label"><PhEye class="pp-label-ico" aria-hidden="true" />Vision model</span>
                      <button
                        v-for="c in visionConfigs"
                        :key="c.id"
                        class="preset"
                        :class="{ on: visionConfig?.id === c.id }"
                        :title="`${c.baseUrl}${c.model ? ' · ' + c.model : ''}`"
                        @click="activateVisionConfig(c)"
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

                  <!-- 角色:这里只负责"这次用哪个"。新建、编辑、设定图都在角色页 ——
                       那是这一站的重点,不该挤在参数面板里 -->
                  <div v-if="shownPanel === 'chars'" class="pp-body">
                    <div class="pp-group">
                      <span class="pp-label"><PhMaskHappy class="pp-label-ico" aria-hidden="true" />Character</span>
                      <!-- 头像即标识:名字进 title。面板本身是滚动容器,
                           自绘 tooltip 会被裁掉,所以这里用原生的。
                           悬停看正脸与参数行那颗头像同一套(见 showCharPeek)——
                           面板里这排只有 40px,选之前更该看清是谁 -->
                      <button
                        v-for="c in characters"
                        :key="c.id"
                        class="char-pick"
                        :class="{ on: activeCharId === c.id }"
                        :title="c.name"
                        :aria-label="c.name"
                        @click="pickChar(c.id)"
                        @mouseenter="showCharPeek($event, c)"
                        @mouseleave="hideCharPeek"
                      >
                        <img v-if="c.ref" class="char-pick-img" :src="coverSrc(c.ref)" alt="" />
                        <PhMaskHappy v-else class="char-pick-ph" aria-hidden="true" />
                      </button>
                      <!-- 不在这里放"去管理"的入口:新建与编辑都在角色页,
                           顶部导航就是那一页,再挂一个按钮只是把输入框撑长 -->
                      <span v-if="!characters.length" class="pp-note">
                        None yet — create one on the Characters page.
                      </span>
                    </div>
                  </div>

                  <!-- 张数:它是"偶尔改一次"的参数,和尺寸/画质放一起,
                       不再单独占参数行上的一格 -->
                  <div v-if="shownPanel === 'more'" class="pp-body">
                    <!-- 固定四档 + 手填挤在同一行:它们回答的是同一个问题(要几张),
                         分成两行只是把一组选项拆散 -->
                    <div class="pp-group">
                      <span class="pp-label"><PhStack class="pp-label-ico" aria-hidden="true" />Count</span>
                      <!-- 对比模式下一家只出一张(见 doRace),这里如实说明并收起选项 ——
                           留着能点但改了没用的胶囊,比看不到更糟 -->
                      <span v-if="compareMode" class="pp-note">One image per model in compare mode</span>
                      <template v-else>
                        <button
                          v-for="c in 4"
                          :key="c"
                          class="preset"
                          :class="{ on: n === c }"
                          @click="n = c"
                        >
                          {{ c }} {{ c === 1 ? 'image' : 'images' }}
                        </button>
                        <!-- 手填并进这一行:它只是张数的另一种填法,不是独立参数 -->
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
                      </template>
                    </div>
                  </div>

                  <!-- 尺寸 -->
                  <div v-if="shownPanel === 'more'" class="pp-body">
                    <div class="pp-group">
                      <span class="pp-label"><PhRuler class="pp-label-ico" aria-hidden="true" />Size</span>
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
                      <span class="pp-label"><PhHash class="pp-label-ico" aria-hidden="true" />Seed</span>
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

                  <!-- 画质:已知不认的厂商不列出来,免得选了却被上游 400 -->
                  <div v-if="shownPanel === 'more' && provider.quality !== 'no'" class="pp-body">
                    <div class="pp-group">
                      <span class="pp-label"><PhGauge class="pp-label-ico" aria-hidden="true" />Quality</span>
                      <button
                        v-for="o in QUALITY_OPTIONS"
                        :key="o.value"
                        class="preset"
                        :class="{ on: quality === o.value }"
                        @click="quality = o.value"
                      >
                        {{ o.label }}
                      </button>
                    </div>
                  </div>

                  <!-- 背景 -->
                  <div v-if="shownPanel === 'more' && provider.background !== 'no'" class="pp-body">
                    <div class="pp-group">
                      <span class="pp-label"><PhPaintBucket class="pp-label-ico" aria-hidden="true" />Background</span>
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
                      <span class="pp-label"><PhImageSquare class="pp-label-ico" aria-hidden="true" />Reference</span>
                      <template v-if="!refImage">
                        <!-- label 不在 Tab 序里,键盘用户进不来:补上焦点与两个激活键。
                             样式不另加 —— .ref-pick 自己的 :focus-visible 已经在管描边 -->
                        <label
                          class="ref-pick"
                          for="ref-file"
                          tabindex="0"
                          role="button"
                          @keydown.enter.prevent="pickRef"
                          @keydown.space.prevent="pickRef"
                          >+ Choose a reference image</label
                        >
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

            <input ref="refInputEl" id="ref-file" type="file" accept="image/*" hidden @change="onPickRef" />
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

        <!-- 历史图墙:输入框下方展示最近生成的图,可收起。
             对比出图的各家结果也落进这里,和平时生成的图一视同仁 ——
             单独摆一排"对比面板"等于给同一批图两套呈现方式,关掉面板图就"消失"了,
             而它们本来就已经是历史记录 -->
        <div
          v-if="loading || feedItems.length"
          class="feed-zone"
          aria-live="polite"
        >
          <div class="section-head">
            <span v-if="!loading" class="sec-title">Recent creations</span>
            <!-- 生成中换成格子波 + 秒表:尺寸与字重都对齐 sec-title,
                 生成结束时从加载态切回标题不会跳一下 -->
            <LatticeLoader
              v-else
              class="sec-title"
              :label="runLabel"
              :font-size="20"
            />
            <div class="sec-tools">
              <!-- 挨个点骨架格上的停止键太费事时的出口。只在一张以上才出现 ——
                   只有一张时那格上的停止键就在眼前,多摆一个入口是噪声 -->
              <button v-if="activeSlots.length > 1" class="sec-stop" @click="stopAllSlots">
                <PhStop weight="fill" aria-hidden="true" />
                Stop all
              </button>
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
                <!-- 占位格与在跑的那几张一一对应,不是一堆一模一样的空块:
                     每格有自己的尺寸比例、自己的停止键 —— 点一下就只停这一张 -->
                <div
                  v-for="s in activeSlots"
                  :key="s.id"
                  class="tile tile-skel"
                  :style="{ aspectRatio: String(tileRatio(s.size)) }"
                >
                  <div class="skel-shimmer"></div>
                  <!-- 模型名只在对比时写:同一个模型出四张、四格都写一遍同样的名字,
                       除了噪声没有别的用 -->
                  <span v-if="multiModel" class="skel-label" :title="s.label">{{ s.label }}</span>
                  <button
                    class="skel-stop"
                    :aria-label="`Stop generating with ${s.label}`"
                    data-tip="Stop this one"
                    @click="stopSlot(s.id)"
                  >
                    <PhStop weight="fill" aria-hidden="true" />
                  </button>
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

      <!-- 角色 -->
      <CharacterPage
        v-else-if="page === 'chars'"
        ref="charPageRef"
        :characters="characters"
        :views="charViews"
        :stats="charStats"
        :works="charWorks"
        :busy="charViewBusy"
        :text-config="textConfig || undefined"
        :vision-config="visionConfig || undefined"
        :tts-config="ttsConfig || undefined"
        @save="saveCharFromPage"
        @remove="deleteChar"
        @duplicate="duplicateChar"
        @export="exportChar"
        @import="importCharFile"
        @open="loadCharViews"
        @create="createWithCharacter"
        @generate="genCharView"
        @generate-all="genRemainingViews"
        @stop-view="stopCharView"
        @preview="openPreview"
        @chat="openChat"
      />

      <!-- 角色对话。与角色页是同一个对象的两个面:一个造它,一个跟它说话 -->
      <ChatPage
        v-else-if="page === 'chat'"
        :characters="characters"
        :messages="chatMessages"
        :last-msg="chatLast"
        :busy="chatBusy"
        :active="chatCharId"
        :has-more="!!chatHasMore[chatCharId]"
        :summary="chatSummary[chatCharId]"
        :text-config="textConfig || undefined"
        :vision-config="visionConfig || undefined"
        :tts-config="ttsConfig || undefined"
        @select="chatCharId = $event"
        @send="sendChat"
        @stop="stopChat"
        @regenerate="regenerateChat"
        @edit-summary="editChatSummary"
        @forget-summary="forgetChatSummary"
        @notice="notice = $event"
        @clear="clearChat"
        @load-earlier="loadEarlierChat"
        @goto-chars="page = 'chars'"
        @goto-settings="page = 'settings'"
      />

      <!-- 历史记录 -->
      <HistoryPage
        v-else-if="page === 'history'"
        :items="history"
        :collections="collections"
        @open="openPreview"
        @use="usePreviewPrompt"
      @remove="removeHistoryEntry"
      @mark="toggleMark"
      @edit="openCanvas"
      @create-collection="createCollection"
      @delete-collection="deleteCollection"
      />

      <!-- 接口设置。
           刻意写成 v-else-if 而不是 v-else:画布那一页不在这条链里
           (它常驻挂载,见文件末尾),漏这一笔会让画布页下面同时铺着设置页 -->
      <SettingsPage
        v-else-if="page === 'settings'"
        :configs="configs"
        :active-id="activeId"
        :active-text-id="activeTextId"
        :active-vision-id="activeVisionId"
        :active-tts-id="activeTtsId"
        :mode="cfgView"
        :seed="cfgSeed"
        :capability-note="capabilityNote"
        @activate="activateConfig"
        @activate-text="activateTextConfig"
        @activate-vision="activateVisionConfig"
        @activate-tts="activateTtsConfig"
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
      :collections="collections"
      :characters="characters"
      @close="closePreview"
      @navigate="openPreview"
      @use-prompt="usePreviewPrompt"
      @favorite="favoriteFromPreview"
      @reference="setAsReference"
      @edit="editFromPreview"
      @remove="removeHistoryItem"
      @mark="toggleMark"
      @assign-collection="assignCollection"
      @create-collection="createAssignCollection"
    />

    <!-- 中性提示(存好了、空间快满、覆盖未保存):以前只在生图工作台里铺一块,
         切到别的页面就看不见了,所以提到全局浮层。
         几秒后自己收起(见 clearNotice),指针停上去时不计时;
         想提前关掉也留了个叉 -->
    <div
      v-if="notice"
      class="note"
      role="status"
      @pointerenter="holdNotice"
      @pointerleave="releaseNotice"
    >
      <span class="note-msg">{{ notice }}</span>
      <button class="note-close" @click="clearNotice" aria-label="Got it">
        <PhX aria-hidden="true" />
      </button>
    </div>

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

    <!-- 挑角色时的悬停预览:角色面板里那排头像用(见 showCharPeek)。
         它是 fixed 定位,挂在这一层是为了不被任何滚动容器裁掉 ——
         角色面板自己就会滚,卡片放在里面只能看到一半。
         常驻而不是 v-if:挂载当帧就带 .on 的节点不播入场过渡,那样就成了硬出现 -->
    <div
      class="char-peek"
      :class="{ on: peekOn, up: charPeek.up }"
      :style="{ left: charPeek.x + 'px', top: charPeek.y + 'px' }"
      aria-hidden="true"
    >
      <span class="char-peek-frame">
        <img :src="charPeek.src || undefined" alt="" />
        <b>{{ charPeek.name }}</b>
      </span>
    </div>
  </div>

  <!-- 自由画布:整页工作台,刻意放在 .shell 之外 ——
       它要铺满视口,不能被那根 1080px 的栏宽与内边距框住。
       它是平级页面,但不跟着上面那条 v-if 链走:常驻挂载、靠 active 开关显隐,
       理由见组件顶部(切去历史挑张图再切回来,手上那半张裁剪框不该没) -->
  <CanvasEditor
    ref="canvasRef"
    :active="page === 'canvas'"
    :item="canvasItem"
    :config="config"
    @save="saveEdit"
    @discard="discardCanvas"
    @pick="page = 'history'"
    @upload="openCanvasFile"
  />
</template>

<style scoped>
.shell {
  max-width: 1080px;
  margin: 0 auto;
  padding: 0 clamp(16px, 4vw, 40px) 64px;
}
/* 对话页例外:它是"一块要一直待着的面板",不是一栏内容 ——
   1080px 的居中栏留给别的页面(那些页是"读一段、做一件事"),
   而这里左右各空出一大片、对话挤在中间,看着就像没铺满。
   仍然留一个上限:超宽屏上把消息挤在两千多像素中间的空白里同样不好看 ——
   两侧说话的人离得太远,一句话要横跨半个屏幕才接得上。

   左右内边距**另给一档**,和下面那道缝取同一个数。
   别的页面那个 clamp(16px, 4vw, 40px) 是给"读一段就走"的排版留的呼吸,
   而这一页要的是"贴边铺开" —— 面板四周该是同一圈留白,
   三边 16px、一边 40px 看着就是没对齐。
   下面那 16px 不在 padding 里,它挪进了 .chat 的高度算式(见那边的注释),
   所以这三个数是一对:改这里要连着改那两处。
   只覆盖左右:上下各有各的账,用 padding 简写会把它们一起冲掉。

   底下那 64px 也归零:那是按"读完一段就走"的页面留的,
   对一块要占满视口的面板来说,它只是在底下空出一条。
   底部那点余量改由下面 height 里留出的 16px(--sp-4)承担 ——
   与 ChatPage 里那条高度算式是一对,改一个要改另一个。

   **锁死一屏**:这一页整页不该出现滚动。
   它的高度算式里有一项是 JS 量出来的顶栏高度(offsetHeight,取整到像素),
   末位对不上就会多出不到 1px;而 html 上挂着 scroll-behavior: smooth、
   滚动条又被全局隐藏(见 style.css),那点溢出既看不见滚动条、又能用触控板滑出来,
   手感正是"整页在滑"。与其去追那不到 1px,不如把这一页钉住:
   height 钉到视口,多出来的直接裁掉。
   注意 height 走 border-box,已含内边距,所以内容正好差 16px 落在那条余量上 */
.shell-wide {
  /* 1760 而不是 1600:1600 在 16 寸 Mac(1728)这类屏上已经开始居中留边,
     而那部分留白和 padding 叠在一起,看着就是"又白了一条"。
     1760 撑住这一档常见的宽屏;再往上的超宽屏仍然收在中间,
     否则两侧气泡会离得太远 */
  max-width: 1760px;
  /* 与 .chat 算式里那道底部余量同一个数(--sp-4)——
     面板四周是同一圈留白。下面那处不在这里,别忘了改的时候连它一起改 */
  padding-left: var(--sp-4);
  padding-right: var(--sp-4);
  padding-bottom: 0;
  height: 100vh;
  height: 100dvh;
  /* 用 clip 而不是 hidden:hidden 会把 .shell 变成滚动容器,
     而聚焦底部那个输入框时浏览器可能把它滚一下 —— 整页跟着挪,
     就又成了"滑一下"。clip 只裁切、不产生滚动容器,也就不可能被滚。
     老浏览器不认 clip 时退回 hidden */
  overflow: hidden;
  overflow: clip;
}
/* 屏确实太矮时(与 .chat 的 min-height: 420px 同一条理由):
   宁可让整页滚,也不要压成一条缝。这时把上面那把锁解开 */
@media (max-height: 520px) {
  .shell-wide {
    height: auto;
    overflow: visible;
  }
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
  /* 中间那枚导航的居中靠的是两侧 1fr 等宽,而 1fr 轨道的最小尺寸默认是内容宽度:
     页面名一长("Prompt Library")文字就会把导航顶偏。放开这一条才压得下去,
     压不下时也只会裁掉字标尾巴,不会动到导航与主题键 */
  min-width: 0;
  overflow: hidden;
  /* 裁切是按盒子算的,而手写体的字形比同号的几何体高得多:
     Pacifico 的字面(升部+降部)是 1.756em,24px 就是 42px,
     比它自己那份 1.2 倍的行盒多出一截 —— 手写体的尾巴就是这么被裁掉的。
     行高已在 .title-script 上提到装得下字形的 1.8,
     这里再补 4px 内边距做余量(裁切按内边距盒子算)。
     同时用 -6px 外边距把那点占位收回来,让它的外框不超过导航那 40px ——
     横条高度因此仍停在 72px,不因为一个字母的尾巴长高 */
  padding-block: 4px;
  margin-block: -6px;
}
.title {
  /* 品牌锁形:几何粗体主打 + 手写体后缀。
     两截字上下居中,而不是按基线对齐 —— 两者的字面盒差得太远
     (Poppins 1.4em、Pacifico 1.756em),按基线对起来手写体整个往上冒 */
  font-family: var(--font-wordmark);
  font-size: 21px; /* 品牌锁形的一部分,随字标字体一起定,不进正文字阶 */
  font-weight: 700;
  letter-spacing: -0.01em;
  /* 行盒正好等于 Poppins 的字面高度:半个行距为 0,字形盒因此与行盒重合,
     居中才是真的居中(否则居中的是一个带上下留白的盒子,不是字本身) */
  line-height: 1.4;
  color: var(--text);
  display: inline-flex;
  align-items: center;
  gap: 7px;
  white-space: nowrap;
}
.title-script {
  font-family: var(--font-script);
  /* 手写体字面小、上下留白多,要放大一档才和左边的字重们等高 */
  font-size: 24px; /* 同上:手写体后缀,品牌锁形的一部分,不进正文字阶 */
  font-weight: 400;
  /* 行高要装得下这个字体本身:Pacifico 的字面有 1.756em(见其 hhea 表),
     24px 就是 42px;跟着 .title 那份给几何体定的 1.2 走,行盒只有 28.8px,
     超出的那截会落到盒外 —— 字标外层是 overflow: hidden,落到外面就被切掉。
     1.8 够它了(43.2px),这才是有余量的写法,不是拿内边距去凑 */
  line-height: 1.8;
}
.mast-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  /* 靠第 3 列的起始边,于是紧挨着中间的滑块;
     若改成 end 会退回右端,中间的滑块也就不再居中 */
  justify-self: start;
}
/* 居中的视图切换。justify-self 兜住 grid 的默认 stretch,避免被拉伸。
   图标尺寸与齿轮标红那两条跟着组件走了(见 NavSegment)——
   槽位里的图标是在那个组件的作用域里编译的,写在这里会匹配不上 */
.nav-seg {
  justify-self: center;
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
  /* 光晕用更长的时长淡入淡出,避免收放时显得突兀。
     边框不参与过渡:这两态里它始终是那条 --line */
  transition: box-shadow 340ms var(--ease);
}
/* 聚焦只亮光晕,不给边框上色:这一圈由内向外渗出的柔光已经说清了
   "焦点在这儿",再把边框描深一道只是把同一件事说了两遍,
   而且描深之后框里那层"可以随便写字"的感觉会收紧。
   于是边框自始至终就是那一条 --line */
.prompt-box:focus-within {
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
  transition: opacity 220ms var(--ease);
}
.prompt-box textarea:focus,
.prompt-box textarea:focus-visible {
  border: none;
  box-shadow: none;
  outline: none;
}
/* 改写中的那几行旧字正被整段换掉:压暗它,一来明说"这会儿先别读这段",
   二来给"换完了"一个可见的落点 —— 结果写回时它跟着亮回去。
   只压暗不隐藏:输入框还是那个输入框,不该看成被禁用了 */
.prompt-box.halo-breathe textarea {
  opacity: 0.45;
}
/* AI 在写的时候那圈金光是主角。点改写键会把焦点留在框里,
   于是聚焦那套墨色漫反射也亮着 —— 墨色垫在金底下会把它拖脏,
   所以这段时间让它歇着,只留投影(边框照旧不动) */
.prompt-box.halo-breathe:focus-within {
  box-shadow: var(--sh-float);
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
/* 角色有头像时胶囊里放头像:一张脸比一个通用的人形图标好认得多 */
.param-avatar {
  width: 26px;
  height: 26px;
  border-radius: 50%;
  object-fit: cover;
  display: block;
}
/* 角色胶囊外面这层只为给"移除"角标当定位基准 ——
   角标要探出胶囊一点,不包一层就只能被胶囊自己的圆角框住 */
.param-char {
  position: relative;
  display: inline-flex;
}
/* 已选中角色的胶囊:悬停时右上角冒出移除钮。
   这里刻意不做悬停看正脸 —— 那张卡片是"挑人"时用的(见 .char-peek),
   选完之后要回答的是另一个问题:怎么把它摘下来 */
.param-char .char-drop {
  position: absolute;
  top: -4px;
  right: -4px;
  /* 压住:角标与胶囊有一小块重叠,得在上面才点得到 */
  z-index: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 17px;
  height: 17px;
  border-radius: 50%;
  color: var(--cta-text);
  background: var(--cta);
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.28);
  opacity: 0;
  /* 收起时不挡点击:它压在胶囊角上,否则那一个角就点不开面板了 */
  pointer-events: none;
  transform: scale(0.6);
  transition: opacity 140ms var(--ease), transform 160ms var(--ease);
}
/* 悬停胶囊(或鼠标已经移到角标上)与键盘聚焦时出现。
   键盘这条路要走 :has(:focus-visible):角标自己拿到焦点时也要留着 */
.param-char:hover .char-drop,
.param-char:has(:focus-visible) .char-drop {
  opacity: 1;
  pointer-events: auto;
  transform: scale(1);
  /* 稍等一拍:鼠标扫过参数行时不该一路闪出摘除钮 */
  transition-delay: 60ms;
}
.param-char .char-drop:hover {
  background: var(--accent-strong);
}
.param-char .char-drop svg {
  width: 11px;
  height: 11px;
}
/* 头像悬停时展开的那张正脸 —— 只在角色面板里那排头像上用(见 showCharPeek)。
   它 fixed 挂到最外层,坐标由 JS 按被悬停的头像现算(见 showCharPeek):
   角色面板自己会滚、也会裁掉溢出,卡片放在头像里面只能看到一半。
   节点常驻、只切 .on,收起时保留上一次的内容,收起动画才接得上 */
.char-peek {
  position: fixed;
  z-index: 30;
  width: 168px;
  opacity: 0;
  pointer-events: none;
  /* 收起态:缩小一点、向下错开,像从这颗头像上"长"出来 */
  transform: translateX(-50%) translateY(6px) scale(0.92);
  transform-origin: 50% 0;
  transition: opacity 160ms var(--ease), transform 260ms var(--ease);
}
.char-peek.on {
  opacity: 1;
  transform: translateX(-50%) translateY(0) scale(1);
  /* 稍等一下再出现:鼠标横扫过一排头像时不该一张张弹出来 */
  transition-delay: 120ms;
}
/* 下面放不下时翻到头像上方(见 showCharPeek 的 up):原点与入场方向一起翻过来 */
.char-peek.up {
  transform: translateX(-50%) translateY(-6px) scale(0.92);
  transform-origin: 50% 100%;
}
.char-peek.up.on {
  transform: translateX(-50%) translateY(0) scale(1);
}
.char-peek-frame {
  position: relative;
  display: block;
  border-radius: 14px;
  overflow: hidden;
  background: var(--bg-elev);
  box-shadow: var(--sh-md);
}
.char-peek img {
  display: block;
  width: 100%;
  /* 与角色卡片同一个 3:4 海报比例,同一张脸在两处裁切一致 */
  aspect-ratio: 3 / 4;
  object-fit: cover;
  /* 出场时轻轻收一下:像从远处推近到眼前,而不是整块贴上来 */
  transform: scale(1.06);
  transition: transform 460ms var(--ease);
}
.char-peek.on img {
  transform: scale(1);
  transition-delay: 120ms;
}
/* 名字压在图上:一层自下而上的暗幕把它托住(与角色卡片同一套做法) */
.char-peek b {
  position: absolute;
  inset: auto 0 0 0;
  padding: 18px 10px 8px;
  font-size: var(--fs-xs);
  font-weight: 600;
  line-height: 1.3;
  color: #fff;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.5);
  background: linear-gradient(
    to top,
    rgba(24, 24, 22, 0.6) 0%,
    rgba(24, 24, 22, 0.28) 60%,
    transparent 100%
  );
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
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
/* 参数名是每组选项的锚点:比选项更沉一点,扫读时才找得到自己要看的那一组。
   但仍然小于选项本身 —— 它是标签,不是内容 */
.pp-label {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: var(--fs-xs);
  font-weight: 600;
  color: var(--text-2);
  margin-right: 2px;
}
/* 图标与文字同色同重,不再额外减淡 —— 一弱就白加了 */
.pp-label-ico {
  flex: none;
  width: 14px;
  height: 14px;
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

/* —— 角色 ——
   选谁在参数行的角色胶囊里(与模型并排),列表在它展开的面板里 */
/* 角色选择:一圈一个头像,名字在 title 里。选中态用全站"当前项"那套墨色描边
   (导航滑块、选中胶囊同一套语言),不是给头像换底色 —— 头像的底色是它自己。
   这里是"选谁",不是"看谁":完整档案卡在角色页,不在这条参数行里 */
.char-pick {
  flex: none;
  width: 40px;
  height: 40px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  border: 2px solid var(--line);
  border-radius: 50%;
  background: var(--bg-elev);
  color: var(--text-3);
  cursor: pointer;
  transition: border-color var(--dur) var(--ease), transform var(--dur) var(--ease);
}
.char-pick:hover {
  border-color: var(--line-strong);
  transform: translateY(-1px);
}
.char-pick.on {
  border-color: var(--cta);
}
.char-pick-img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.char-pick-ph {
  width: 18px;
  height: 18px;
}
.pp-action:disabled {
  opacity: 0.5;
  cursor: default;
}

.err {
  margin-top: var(--sp-2);
  color: var(--danger);
  font-size: var(--fs-sm);
  padding: 8px 12px;
  background: color-mix(in oklch, var(--danger) 10%, transparent);
  border-radius: var(--r-sm);
}
/* 存储清理提示:提醒而非错误,用中性色,不与报错抢注意力。
   现在挂在全局层(所有页面共用),所以做成居中浮条而非流内一方块:
   触发点和当前页面无关,固定在最底部才保证任何页面都能看见 */
.note {
  position: fixed;
  left: 50%;
  /* 抬高到撤销浮条(底部 28px)之上,两者几乎不会同屏,但一旦撞上不至于盖住操作 */
  bottom: 76px;
  transform: translateX(-50%);
  z-index: 40;
  display: flex;
  align-items: flex-start;
  gap: var(--sp-3);
  max-width: min(520px, calc(100vw - 32px));
  padding: 8px 12px;
  font-size: var(--fs-sm);
  /* 与撤销浮条同一套墨底白字。它浮在什么画面上都有可能(画布页整屏都是图),
     浅底浅字压上去就糊了 —— 深底才是在任何背景上都读得清的那一种。
     深色模式下 --cta 自己会翻成浅色,这套不用跟着写第二遍 */
  color: var(--cta-text);
  background: var(--cta);
  /* 这里原本写的是 --shadow-sm,那个变量根本不存在(全站只有 --sh-sm / --sh-md),
     等于没有阴影 —— 浮条和底下的画糊成一片,这也是"看不清"的一半原因 */
  box-shadow: var(--sh-md);
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
  /* 叉比正文轻一档:它是个出口,不是内容 */
  color: color-mix(in srgb, var(--cta-text) 58%, transparent);
  border-radius: 999px;
  transition: color var(--dur) var(--ease), background var(--dur) var(--ease);
}
.note-close svg {
  width: 13px;
  height: 13px;
}
.note-close:hover {
  color: var(--cta-text);
  background: color-mix(in srgb, var(--cta-text) 14%, transparent);
}

/* 长报错默认一行截断:上游原文动辄上百字,整段铺开会把输入区顶得很高 */
.err-msg {
  line-height: 1.6;
  overflow-wrap: anywhere;
  /* 上游原文里的换行是它自己的格式,留着;对比出图全军覆没时,
     这里也是一行一家的错误 */
  white-space: pre-wrap;
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
/* 全部停下:与 View all / Collapse 同一排,沿同一套文字按钮语言 */
.sec-stop {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 6px 10px;
  font-size: var(--fs-sm);
  color: var(--text-3);
  border-radius: 999px;
  transition: color var(--dur) var(--ease), background var(--dur) var(--ease);
}
.sec-stop svg {
  width: 11px;
  height: 11px;
}
.sec-stop:hover {
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

/* 停止键:每格一个,只停它自己。
   常驻而不是悬停才浮出 —— 触屏没有悬停,一个"看不见的停止键"等于没有;
   这是用户唯一的停止入口(生成键不再兼任),更不该藏 */
.skel-stop {
  position: absolute;
  right: 10px;
  bottom: 10px;
  z-index: 2;
  width: 34px;
  height: 34px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 999px;
  /* 墨底白图标:骨架本身是浅灰的一整块,浅色按钮压上去看不出边界在哪 */
  background: var(--cta);
  color: var(--cta-text);
  box-shadow: var(--sh-sm);
  cursor: pointer;
  transition: transform var(--dur) var(--ease), box-shadow var(--dur) var(--ease);
}
.skel-stop svg {
  width: 13px;
  height: 13px;
}
.skel-stop:hover {
  transform: scale(1.06);
  box-shadow: var(--sh-md);
}
/* 模型名:对比出图时几格长得一模一样,不写清哪格是哪家就只能靠猜。
   右边界给停止键让位,不然长名字会钻到按钮底下 */
.skel-label {
  position: absolute;
  left: 10px;
  right: 52px;
  bottom: 13px;
  z-index: 2;
  font-size: var(--fs-xs);
  font-weight: 500;
  color: var(--text-2);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
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
