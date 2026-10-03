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
  uid,
  loadConfigs,
  characterDesc,
  chatPayloadOf,
  CHAT_WINDOW,
  chatStream,
  loadCharacters,
  saveCharacters,
  exportCharacter,
  readCharacterZip,
  getProvider,
  vendorOf,
  imageSrc,
  coverSrc,
  releaseSrc,
  QUALITY_OPTIONS,
  BACKGROUND_OPTIONS,
  CHARACTER_VIEWS
} from './api'
import {
  blobToDataURL,
  urlToBlob,
  // 这几个仍被留下的流式链路、删角色连带删对话、以及删单条消息的附图回收用着
  deleteChatMessage,
  putChatMessage,
  deleteChatOf,
  deleteChatImage,
  getCharViews,
  putCharView,
  deleteVoiceSample,
  putChatImage,
  getChatImage
} from './lib/idb'
import { titleFromPrompt } from './lib/text'
import { stopSpeaking } from './lib/speech'
import { contextText } from './lib/chatContext'
import { NAV_ITEMS } from './lib/nav'
import { useFeedback } from './composables/useFeedback'
import { useConfigs } from './composables/useConfigs'
import { useHistory } from './composables/useHistory'
import { useCharacters } from './composables/useCharacters'
import { useChat } from './composables/useChat'
import { useGeneration } from './composables/useGeneration'
// 另一个标签页改了 localStorage 里的目录时,本页要跟着重载(见 lib/crossTab.ts)
import {
  openSyncChannel,
  syncTargetsOf,
  type SyncChannel,
  type SyncKind,
  type SyncMessage
} from './lib/crossTab'
// 图片尺寸上限的唯一来源(参考图 / 存档 / 编辑载荷),别再各写一个字面量
import { REF_IMAGE_EDGE } from './lib/payload'
// 浮层的公共行为(点外收起 / Esc 逐层退)
import { isInside } from './lib/ui'
import {
  applyTheme,
  currentTheme,
  saveTheme,
  watchSystemTheme,
  type Theme
} from './lib/theme'
import type { ApiConfig, FavoritePayload, HistoryEntry, PromptItem, ResultItem, ReuseParams, Character, CharacterFields, CharacterPersona, CharacterViewKind, CharacterVoice, ChatMessage, ImportedCharacter } from './types'

// —— 状态 ——
/* 反馈三通道(错误 / 中性提示 / 删除撤销)收在 composables/useFeedback.ts ——
   它们是每一块业务域都要用的东西,留在主界面里会让后面每抽一个域都反向依赖它 */
const {
  error,
  errorOpen,
  canRetry,
  errorLong,
  fail,
  notice,
  clearNotice,
  holdNotice,
  releaseNotice,
  pendingUndo,
  UNDO_MS,
  scheduleUndo,
  commitUndo,
  runUndo
} = useFeedback()

/* 接口配置这一域(列表 / 四类当前生效 / 能力派生 / 增删改与导入导出)收在
   composables/useConfigs.ts —— 它只依赖「删除的撤销窗口」与「怎么进设置页」两件事 */
const {
  configs,
  config,
  activeId,
  textConfig,
  activeTextId,
  visionConfig,
  activeVisionId,
  ttsConfig,
  activeTtsId,
  cfgView,
  cfgSeed,
  selectedIds,
  RACE_MAX,
  activeConfigName,
  activeTextName,
  imageConfigs,
  textConfigs,
  visionConfigs,
  provider,
  capabilityNote,
  sizeOptions,
  sizeFree,
  defaultSize,
  selectedConfigs,
  compareMode,
  configured,
  initConfigs,
  repickActiveImage,
  repickActiveText,
  repickActiveVision,
  repickActiveTts,
  activateConfig,
  activateTextConfig,
  activateVisionConfig,
  activateTtsConfig,
  newConfig,
  duplicateConfig,
  editConfig,
  cancelConfig,
  openConfigManager,
  saveSettings,
  removeConfig,
  importConfigs,
} = useConfigs({
  scheduleUndo,
  // 从参数面板进设置页:切页与收起面板都归主界面
  enterSettings: () => {
    page.value = 'settings'
    openPanel.value = ''
  }
})


/* 历史 / 作品集 / 提示词库这一域收在 composables/useHistory.ts ——
   它只依赖「广播给别的标签页」「删除的撤销窗口」「中性提示」三件事 */
const {
  history,
  collections,
  libItems,
  feedOpen,
  feedItems,
  tileRatio,
  onFeedLoad,
  initHistory,
  initCollections,
  initLibrary,
  reloadHistoryFromDb,
  reloadCollectionsFromDb,
  reloadLibraryFromDb,
  persist,
  removeHistoryEntry,
  toggleMark,
  createCollection,
  deleteCollection,
  assignCollectionTo,
  createAndAssign,
  persistLib,
  saveLibItem,
  removeLibItem,
  importLibItems
} = useHistory({ announce, scheduleUndo, notice })

/* 从提示词库取用一条:把它的提示词与参数套到创作区,并把库页收掉。
   这一支留在主界面,因为它要动的是**出图那一侧的状态**(提示词/尺寸/画质/背景)
   与页面切换 —— 那是另一个域的事 */
async function useLibItem(item: PromptItem) {
  prompt.value = item.prompt
  applySize(item.size)
  // 画质/背景同样过一遍能力表:库里存的可能是别家厂商支持的档位
  if (item.quality && provider.value.quality !== 'no') quality.value = item.quality
  if (item.background && provider.value.background !== 'no') background.value = item.background
  /* 记一次取用。这是库里唯一一个"随时间变化"的数字,它回答的是
     "我到底在用哪些提示词" —— 不记的话,一年后翻库只能靠感觉 */
  item.uses = (item.uses || 0) + 1
  /* 这里刻意不走 saveLibItem:它按 id 找不到时会**插一条新的**,
     而"另一页刚好把这条删了"这种情况不该让它复活。取用只改了一份计数,
     整份写回 + 广播就够了 */
  await persistLib()
  announce('library')
  // 关掉库页就等于切回首页;回顶部由 navView 的 watch 统一负责,这里不必再来一次
  page.value = 'home'
}

/* —— 角色 ——
   一个角色 = 一组设定图 + 一段固定描述。目录(名字/描述)放 localStorage,
   图是 Blob,按 id 存在 IndexedDB(见 api.ts 的 loadCharacters)。
   角色是独立的输入:它不占表单里的参考图槽,只在发请求那一刻并进参考图一起送
   (见 charRefSrcs)。表单上看到的是什么,发出去的参考图就由这里决定 */
/* 角色这一域(目录 / 设定图缓存 / 读取侧原语)收在 composables/useCharacters.ts。
   写入那一侧(saveCharFromPage / deleteChar / duplicateChar / genCharView /
   导入导出)暂时留在主界面:它们要么跨到对话域(删角色连带删对话、导出带上记忆),
   要么要动出图配置与页面切换 —— 归属没定清之前先不搬 */
const {
  characters,
  activeCharId,
  charViews,
  charViewBusy,
  charViewControllers,
  charPageRef,
  charViewKey,
  activeCharacter,
  activeCharSrc,
  charStats,
  charWorks,
  normalizeChar,
  detachCharacter,
  toggleChar,
  viewOf,
  viewSize,
  charImageBlob,
  resultRefBlob,
  reBlob,
  charRefSrcs,
  charRefSrcsOf,
  stopCharView,
  loadCharViews,
  reloadCharViewsFromDb
} = useCharacters({
  history,
  provider,
  // 挑不出合适档位时退回创作区当前尺寸(惰性读:那一刻它已经就位)
  coverSize: () => size.value,
  // 角色图要给人看,走显示级压缩那条路
  compressImage
})

/** 从角色卡直接开画:套上这个角色并切回工作台。
 *  交给 toggleChar 会变成"再点一次取消",这里要的是明确的选中,所以直接赋值。
 *  回顶部由 navView 的 watch 统一负责(见 useLibItem 同一条路径) */
function createWithCharacter(id: string) {
  activeCharId.value = id
  page.value = 'home'
}

/** 面板里点一个头像:选定/取消,顺手把悬停预览收掉。
 *  光靠 mouseleave 收不干净:点完指针还停在原处,那张正脸会一直压在面板上,
 *  挡住的正是刚点过的那一排 —— 而这会儿人已经选完了,不需要再看它 */
function pickChar(id: string) {
  toggleChar(id)
  hideCharPeek()
}

/* 对话这一域的非流式那一半收在 composables/useChat.ts（消息、长期记忆、
   清空、导入导出）。**流式那一轮留在这里**:runChat / sendChat / regenerate /
   stop 要动出图配置、角色参考图与请求中断,归属还没定清 */
const {
  chatCharId,
  chatMessages,
  chatHasMore,
  chatSummary,
  chatLast,
  chatBusy,
  chatControllers,
  bumpChatSeq,
  loadChatLast,
  setChatLast,
  dropChatLast,
  loadChatMessages,
  loadEarlierChat,
  maybeSummarize,
  editChatSummary,
  forgetChatSummary,
  readChatForExport,
  writeImportedChat,
  clearChat
} = useChat({ characters, textConfig, notice, announce, scheduleUndo })

type Page = 'home' | 'chars' | 'chat' | 'canvas' | 'lib' | 'history' | 'settings'
const page = ref<Page>('home')
const previewEntry = ref<HistoryEntry | null>(null)
/* 预览打开时落在第几张。与 previewEntry 一起设:历史页是按张摊平的,
   "点的是哪一张"是打开动作的一部分,不该由预览卡自己从头数 */
const previewIndex = ref(0)

/** 角色 id → 名字。历史搜索要按"跟谁那张"找,而记录里存的是 id ——
 *  这份反查表由主界面给历史页(角色目录本来就在这边手上),那一页不碰它 */
const charNames = computed(() =>
  Object.fromEntries(characters.value.map((c) => [c.id, c.name]))
)

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

/* 出图参数这一层(提示词 / 尺寸 / 张数 / 画质 / 背景 / 种子 / 参考图 / 改写)
   收在 composables/useGeneration.ts。**编排那一层**(生成槽、并发、对比出图、
   落盘)暂时留在这里,下一次再搬 */
const {
  prompt,
  enhancing,
  preEnhance,
  size,
  n,
  quality,
  background,
  seed,
  refImage,
  moreCustom,
  commitSeed,
  N_MAX,
  sizeLabel,
  clampN,
  commitSize,
  applySize,
  refInputEl,
  pickRef,
  onPickRef,
  clearRef,
  canUndo,
  enhanceText,
  enhanceDisabled,
  enhanceTip,
  enhanceAria,
  nextModeLabel,
  toggleEnhanceMode,
  onEnhanceClick,
  activeSlots,
  loading,
  multiModel,
  runLabel,
  generateChatPhoto,
  recordFor,
  doGenerate,
  stopSlot,
  stopAllSlots,
  retry
} = useGeneration({
  config,
  textConfig,
  provider,
  defaultSize,
  fail,
  compressImage,
  notice,
  persist,
  charRefSrcs,
  charRefSrcsOf,
  characters,
  activeCharacter,
  selectedConfigs,
  openPanel,
  pendingParentId,
  activeCharId,
  openConfigManager,
  configured,
  compareMode,
  error,
  canRetry
})
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
onBeforeUnmount(() => syncChannel?.close())

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
/* —— 对比出图(Model Race) ——
   把同一句提示词一次发给多个出图配置,并排看结果。这是"自带多家模型"才有的事:
   官方 app 只能跑自家模型。代价是花费按模型数翻倍。
   没有单独的"对比"开关:芯片本来就是多选,选一个 = 平时那样,选两个以上 = 对比 */
/* —— 生成中的每一张 = 一个槽 ——
   为什么不是"一次点击一个槽"而是一张一个:用户要的是每格能单独停,
   而"一次请求出 4 张"没法停下其中一张 —— 上游回来就是一整包。
   所以张数 4 就发 4 次各出一张,多模型对比则是每模型一个槽。

   代价是请求数等于张数。换来的是:每格自己转、自己停、先回来先出图。
   落盘仍按"一次点击 = 一条记录"归并(见 recordKey),
   所以历史里看到的条数和以前一模一样 */
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
  // 四类「当前生效」的启动挑选(含「存的 id 已失效 / 用途被改」的回退)
  initConfigs()
  /* 库封面存在 IndexedDB 里,读取因此是异步的(见 api.ts 的 loadPrompts)。
     不 await —— 首页不必等它,提示词库页挂载时数据早到了 */
  // 三份目录:历史(含缩略图后台补齐)、作品集、提示词库
  void initHistory()
  initCollections()
  void initLibrary()
  // 角色要连 IndexedDB 里的参考图一起取,所以是异步的
  loadCharacters().then((list) => {
    characters.value = list.map(normalizeChar)
    /* 左栏那行"最后说了什么"需要每个角色各读一条 ——
       没打开过的角色在 chatMessages 里没有键,光靠它是读不到的(见 loadChatLast)。
       启动时补一趟就够:之后每一句都由 sendChat / runChat 就地更新 */
    void loadChatLast()
  })
  window.addEventListener('storage', onStorageSync)
  /* 记录与字节那一侧走广播(BroadcastChannel)。它与上面的 storage 事件
     互不重复:那个管被整份覆盖写的目录,这个管 IndexedDB 里的记录 */
  syncChannel = openSyncChannel((batch) => void handleRemoteSync(batch))
})

/* 跨标签页广播:另一页改了 IndexedDB 里的东西(历史/设定图/对话)时,
   本页把受影响的那一类重读一遍。localStorage 那条(storage 事件)只管目录,
   改记录与字节不会触发它 —— 见 lib/crossTab.ts 的说明 */
let syncChannel: SyncChannel | null = null
function announce(kind: SyncKind, charId?: string) {
  syncChannel?.post(charId ? { kind, charId } : { kind })
}

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
    reloadCollectionsFromDb()
    labels.push('collections')
  }
  if (targets.includes('prompts')) {
    void reloadLibraryFromDb()
    labels.push('prompt library')
  }

  /* 说一声。不说的话用户只会觉得"我明明没动,列表却变了" ——
     这是同步本身带来的观感问题,不是噪音 */
  notice.value = `Updated from another tab — reloaded ${labels.join(' and ')}.`
}

/* —— 另一页改了 IndexedDB 里的东西 ——
   粒度是"哪一类变了",收到就把那一类重读一遍。重读是幂等的,所以消息即使
   合并、乱序或重复也不会让两端对不上 —— 代价只是多读几条记录 */
async function handleRemoteSync(batch: SyncMessage[]) {
  const labels: string[] = []

  if (batch.some((m) => m.kind === 'history')) {
    await reloadHistoryFromDb()
    labels.push('history')
  }

  const viewIds = batch.filter((m) => m.kind === 'charViews').map((m) => m.charId)
  if (viewIds.length) {
    /* 没带 charId 的(删角色)就把已缓存的都过一遍 —— 反正只动内存里已有的那几格 */
    const ids = viewIds.some((id) => !id) ? Object.keys(charViews.value) : (viewIds as string[])
    for (const id of ids) await reloadCharViewsFromDb(id)
    labels.push('characters')
  }

  const chatIds = batch.filter((m) => m.kind === 'chat').map((m) => m.charId).filter(Boolean) as string[]
  if (chatIds.length) {
    for (const id of chatIds) await reloadChatFromDb(id)
    labels.push('conversations')
  }

  if (batch.some((m) => m.kind === 'library')) {
    await reloadLibraryFromDb()
    labels.push('prompt library')
  }

  if (labels.length) {
    notice.value = `Updated from another tab — reloaded ${[...new Set(labels)].join(' and ')}.`
  }
}

/** 重读历史。**合并而不是整份替换**,理由见 api.ts 的 mergeHistory */
/** 重读某个角色的设定图。缓存那一格本身就是"已加载过"的标记(loader 见到就返回),
 *  所以要先把这一格丢掉再取 */
/** 重读某个角色的对话。**正在流式说话时跳过**:库里的副本还没有刚落下的这句,
 *  重读会把流式的正文抹掉 —— 那一轮说完还会再广播一次,那时再对齐也不迟 */
async function reloadChatFromDb(id: string) {
  if (chatBusy.value[id]) return
  const drop = <T>(rec: Record<string, T>) => {
    const next = { ...rec }
    delete next[id]
    return next
  }
  chatMessages.value = drop(chatMessages.value)
  chatHasMore.value = drop(chatHasMore.value)
  /* 记忆也要先摘掉:loadChatMessages 只在"库里有"时才写回这一格,
     另一页刚点了"忘记"的话,留着旧的那份会让本页继续拿旧记忆说话 */
  chatSummary.value = drop(chatSummary.value)
  await loadChatMessages(id)
  // 左栏那行"最后说了什么"同样要跟上
  await loadChatLast()
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
/* —— 角色 ——
   一个角色 = 一组设定图 + 一段固定的描述。选中后分两路进这一批:
   脸部的三项设定接在提示词后面(见 composedPrompt),设定图并进参考图一起送
   (见 charRefSrcs),合成后的完整提示词才落进历史。
   于是"这条是照哪个角色出的"在记录上查得到(characterId) */
/** 当前套用的角色。没有就是 undefined —— 模板与合成提示词都读它 */
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

/* 置顶 / 取消置顶。
 *
 *  与删除、复制不同,**它不进撤销窗口**:置顶只是把这个人挪到列表最前面,
 *  一眼看得见、再点一次就回去了,没有"说没就没"的风险 ——
 *  给它配一条撤销条反而会让一次轻量操作显得很重(与标记一张图同一个分寸)。
 *
 *  直接落盘:置顶的意义就是下次打开还在最前面,缓冲一步再写没有好处。 */
async function togglePinChar(id: string) {
  const c = characters.value.find((x) => x.id === id)
  if (!c) return
  c.pinned = !c.pinned
  /* 取消置顶时把字段删掉而不是写 false:老角色与"从没置顶过"在数据里
     保持同一种形状,导出的包也才不会被一个 false 撑出一项 */
  if (!c.pinned) delete c.pinned
  await saveCharacters(characters.value)
  notice.value = c.pinned ? `Pinned “${c.name}”.` : `Unpinned “${c.name}”.`
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
      // 别的标签页若缓存着这个角色的设定图或对话,也要把它们放掉
      announce('charViews', id)
      announce('chat', id)
      /* 对话跟着角色一起走:人没了,跟他聊的那一段留着也没有对象了。
         放在这一步(真正落盘)而不是点删除那一刻 —— 撤销回来时对话还得在。
         **附图不在这里数**:deleteChatOf 会按 charId 把该角色的消息整批读出来,
         把 imageId 与 photoId 一并收掉。从前这里只遍历内存里那一档(最近 200 条)
         且只认 imageId —— 更早的附件与角色发的每一张图都成了孤儿 */
      chatControllers.get(id)?.abort()
      chatControllers.delete(id)
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
    /* 置顶**刻意不拷**:它是"我常找的就是这一个",而不是这个角色的一部分 ——
       复制出来的是另一个人,不该也占着最前面那一格 */
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
      if (known.has(r.kind)) {
        await putCharView(copy.id, r.kind, reBlob(r.data))
        announce('charViews', copy.id)
      }
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
      if (imp.views.length) announce('charViews', c.id)
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
/* —— 设定图 ——
   五张视图,正脸是锚:其余四张都以正脸为参考图生成 —— 这是"同一张脸"的唯一保证。
   结果只进角色自己的 views,不进历史 —— 它们是中转用的参考料,不是作品 */
/* —— 角色身上的图 ——
   角色有两处图:ref(卡面与头像)与 5 张设定图。它们和 record.ref 的用处不同 ——
   后者只是"当时用了哪张参考图"的复现凭据,只喂给模型,压到最长边 512 就够
   (见 refThumbOf);而角色这两处是要给人看的:角色卡封面、详情页头像、
   以及全屏查看器里能铺到 600px 宽 —— 2× 屏就是 1200px。
   512 一到那个尺寸一眼就糊,所以这条路按显示级编:最长边 1280、JPEG q0.88。
   1280 是照着全屏查看器定的(600 CSS px × 2),再大对观感没有增益,
   只是让一套 6 张图多占几 MB */
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
    const caps = getProvider(vendorOf(cfg), cfg.model)
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
    // 另一页若正开着这个角色的详情/向导,它该看到这张新图
    announce('charViews', c.id)
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
// 进对话页时确保手上有一个角色
watch(page, (p) => {
  if (p === 'chat') ensureChatChar()
})

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
     被截掉的旧消息**不从库里删** —— 它们还在,只是这一轮不带。

     正文过一道 contextText:空正文的消息(典型是"只发了一张图、一个字没打")
     不能以空串发出去 —— 上游会按内容为空拒掉整轮,而这条消息在历史里
     就是一条普通消息(见 lib/chatContext 的说明) */
  const context = (chatMessages.value[id] || [])
    .slice(-CHAT_WINDOW)
    .map((m) => ({ role: m.role, content: contextText(m) }))
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
  /* 这一轮它想给你看的画面(场景描述)。空串 = 不发图 */
  let photo = ''
  /* 这张里有没有它本人(模型写在 [photo:self:…] 里)。
     它决定出图时带不带设定图:场景照带上会被带跑,自拍不带会画成陌生人 */
  let photoSelf = false
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
    photo = out.photo
    photoSelf = out.photoSelf
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
  /* 它想发一张图:**先挂上场景描述**(界面据此立刻占一个骨架位),
     再在后台画。画不出来就把那个标记清掉,骨架随之消失 —— 正文照旧,
     一句"我画不出来"比什么都不说更打断对话(见 doc/角色配图设计.md) */
  if (photo && !stopped) {
    reply.photo = photo
    /* 意图一起落在这条消息上:导出这段对话时,对方若想重画这一张,
       依据该是同一个(是自拍还是只拍了个景) */
    if (photoSelf) reply.photoSelf = true
    void generateChatPhoto(id, photo, photoSelf).then(async (blob) => {
      if (!blob) {
        /* 这一条可能已经被删了(清空对话):那就别再往上写 */
        if (chatMessages.value[id]?.some((m) => m.id === reply.id)) reply.photo = ''
        return
      }
      const photoId = uid()
      try {
        await putChatImage({ id: photoId, blob, createdAt: Date.now() })
      } catch {
        reply.photo = ''
        return
      }
      reply.photoId = photoId
      /* 落库只是把这条消息补全:图不进历史,所以这里走的不是 persist,
         而是"把这一条改写回去"。失败也不回滚界面 —— 刷新后少一张图,
         比当场把它撤掉更不刺眼 */
      await putChatMessage(toRaw(reply)).catch(() => {})
    })
  }
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
    // 另一页的左栏与消息流都要跟上(它可能正开着这个角色)
    announce('chat', id)
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
  announce('chat', id)
  // 左栏那行摘要跟着这一句走 —— 不必为此重读一遍库
  setChatLast(id, mine)
  await runChat(id)
}

/** 重新生成:删掉最后那条助手消息再发一次。**用户那句不动** ——
 *  要重来的是它的回答,不是让用户再说一遍 */
async function regenerateChat(id: string) {
  if (chatBusy.value[id]) return
  /* 先确认这一轮真的发得出去,**再**删旧回复。反过来的话,下面 runChat
     的每一条提前返回都变成一次静默的数据丢失:旧回复已经删了,新的又没发 ——
     最容易撞上的是"文本模型被删掉/换设备后还没配",那时界面上还留着
     Regenerate(消息流不受 compose 的门控),点一下就永久丢一条(没有撤销窗口) */
  const c = characters.value.find((x) => x.id === id)
  if (!c) return
  if (!textConfig.value) {
    notice.value = 'Add a text model in API settings before chatting.'
    return
  }
  const list = chatMessages.value[id] || []
  const last = list[list.length - 1]
  if (!last) return
  /* 最后一条是助手消息 ⇒ 说了一半想重来,先把它删掉(用户那句留着)。
     是用户消息 ⇒ 上一轮压根没答上来(runChat 失败时会把空壳删掉),
     那就什么都不用删,直接重发。两种情况共用这一个入口,
     所以"报错之后重试"不需要另写一条链路 */
  if (last.role === 'assistant') {
    /* 删掉之后底下得有一条用户消息接着问 —— 没有的话这一轮本来就没得重发
       (runChat 也会直接返回),那就一条都别删。正常对话里走不到这里,
       但导入的包可以以助手消息开头 */
    if (list.length < 2 || list[list.length - 2].role !== 'user') return
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

/**
 * 删掉单独一条消息。
 *
 *  走撤销条 —— 与清空对话、删角色、清空历史同一套:一条消息也是这段对话的
 *  一部分,点错了却只能靠"重新生成"来补救是说不过去的。
 *
 *  **附图等到窗口结束才收**(purge):撤销要把这条消息原样放回去,
 *  字节先删了,恢复出来的就是一条指着空图的记录。
 *
 *  记忆的游标不用动:它按时间戳走(upToAt),而 covered 只是"已经压过多少条"。
 *  删掉一条已覆盖的消息之后 covered 会多数一条 —— 那只会让下一轮压缩晚一点
 *  触发,不会把删掉的东西捞回来(与 Forget 里"宁可算多一点"同一条取舍)。
 */
function deleteChatMessageFromPage(id: string, msgId: string) {
  /* 正在生成时不给删:那条占位的助手消息还没落盘,这一刻删它
     会与收尾那一步打架(界面上也把按钮收掉了,这里是第二道闸) */
  if (chatBusy.value[id]) return
  const list = chatMessages.value[id] || []
  const at = list.findIndex((m) => m.id === msgId)
  if (at < 0) return
  const gone = list[at]
  // 这条可能正在念:念着一条马上就不存在的消息没有道理
  stopSpeaking()
  chatMessages.value = { ...chatMessages.value, [id]: list.filter((m) => m.id !== msgId) }
  void deleteChatMessage(msgId)
  /* 左栏那行摘要可能就是这一条,得跟着回退到新的最后一条 */
  const rest = chatMessages.value[id] || []
  const last = rest[rest.length - 1]
  if (last) setChatLast(id, last)
  else dropChatLast(id)

  scheduleUndo({
    label: 'Message deleted',
    undo: () => {
      /* 放回**原来的位置**:对话的顺序就是它的意思,接到末尾等于改写了上下文。
         按 at 切,而不是按当前长度 —— 窗口里又说了几句的话,位置也不会错 */
      const cur = chatMessages.value[id] || []
      const next = [...cur.slice(0, at), gone, ...cur.slice(at)]
      chatMessages.value = { ...chatMessages.value, [id]: next }
      // 落盘要交原始对象:reactive 代理进不了 IndexedDB 的结构化克隆
      void putChatMessage(toRaw(gone))
      /* 左栏那行也回退:放回来的这条要是最后一句,它就该重新出现在左栏。
         重读一趟而不是自己算 —— 库里那份是权威,而这次恢复刚好也落盘了 */
      void loadChatLast()
    },
    purge: () => {
      /* 到这一步才真的把字节扔掉(理由见上面)。两个字段都要收:
         imageId 是用户附的,photoId 是角色发的 */
      if (gone.imageId) void deleteChatImage(gone.imageId)
      if (gone.photoId) void deleteChatImage(gone.photoId)
      // 别的一页也要知道这一条没了
      announce('chat', id)
    }
  })
}

/** 清空一个角色的对话。走撤销条 —— 与删除角色、清空历史同一套规矩:
 *  说没就没的东西得留一条退路 */
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

// —— 工具 ——
// 图墙角标用的紧凑时间:09-24 15:54
function fmtDate(ts: number) {
  const d = new Date(ts)
  const p = (x: number) => String(x).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/* 短标题的派生逻辑在 lib/text.ts:图砖角标与提示词库卡片共用同一个口径。
   完整提示词仍然只挂在 img 的 alt 上(读屏能拿到),角标里不出现,免得挡图 */

/* 打开预览。index 是"这条记录里的第几张" —— 历史页的图块与搜索结果是
   按张摊平的,点第 3 张就该看到第 3 张(不是永远从第一张开始)。
   默认 0 兼容"从记录进来"的那些入口(角色页作品、首页图砖) */
function openPreview(entry: HistoryEntry, index = 0) {
  previewIndex.value = index
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
/* 预览里那两个入口:它们要动的是"正在预览的那一条",而预览状态在主界面 ——
   所以这里只做转发,业务仍归 useHistory(见 assignCollectionTo / createAndAssign) */
function assignCollection(collectionId: string) {
  if (!previewEntry.value) return
  assignCollectionTo(previewEntry.value, collectionId)
}
function createAssignCollection(title: string) {
  createAndAssign(previewEntry.value, title)
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
        @pin="togglePinChar"
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
        @delete-message="deleteChatMessageFromPage"
        @pin="togglePinChar"
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
        :char-names="charNames"
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
      :start-index="previewIndex"
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
