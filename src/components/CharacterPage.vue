<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import {
  PhMaskHappy,
  PhPlus,
  PhCalendar,
  PhClockCounterClockwise,
  PhCopy,
  PhDownloadSimple,
  PhDotsThreeVertical,
  PhTrash,
  PhSparkle,
  PhUploadSimple,
  PhArrowLeft,
  PhArrowRight,
  PhArrowsClockwise,
  PhArrowsOutSimple,
  PhCaretLeft,
  PhCaretRight,
  PhCheck,
  PhEye,
  PhImage,
  PhLockSimple,
  PhX
} from '@phosphor-icons/vue'
import { CHARACTER_VIEWS, coverSrc, draftCharacterFields, emptyCharFields } from '../api'
import LatticeLoader from './LatticeLoader.vue'
import type {
  ApiConfig,
  Character,
  CharacterFields,
  CharacterStat,
  CharacterView,
  CharacterViewKind
} from '../types'

/* 角色:网站的重点页面。
   一个角色 = 一组设定图 + 一段结构化设定。设定图是它的骨架 ——
   正脸当锚,其余四张都以正脸为参考图生成,这是跨图保持同一张脸的唯一办法。

   这一页只管展示与编排:生成、落盘、存储都在主界面 ——
   参考图与设定的字节归 App/IndexedDB 管,这里只发意图(与预览卡同一套分工) */

const props = defineProps<{
  characters: Character[]
  // 按角色 id 缓存的设定图。主界面按需从 IndexedDB 取,这里只读
  views: Record<string, CharacterView[]>
  /* 按角色 id 聚合的用量(生成次数 / 最后使用时间)。源数据是历史记录,
     主界面算好传进来 —— 这一页不碰历史 */
  stats: Record<string, CharacterStat>
  // 正在生成哪一张视图(空 = 空闲)。同一时间只跑一张
  busy: string
  // 起稿要用的文本模型配置。没配就走不了 AI 起稿,但手填照常
  textConfig?: ApiConfig
}>()

/** 表单草稿:设定拆成五项,参考图先收成 data URL ——
 *  压小成 Blob 是主界面的事(与参考图存档同一档参数) */
type DraftForm = { name: string; fields: CharacterFields; desc: string; ref: string }

const emit = defineEmits<{
  (e: 'save', payload: { name: string; fields: CharacterFields; desc: string; refData: string }): void
  (e: 'remove', id: string): void
  // 复制:目录与图都由主界面拷一份(这一页不碰字节)
  (e: 'duplicate', id: string): void
  // 导出成一个 zip。文件本身也由主界面生成 —— 打包要读图,那不归这一页管
  (e: 'export', id: string): void
  // 导入:只把选中的文件交出去,怎么读怎么落盘由主界面决定(与上面同一条分工)
  (e: 'import', file: File): void
  (e: 'open', id: string): void
  // 拿这个角色去开画:套上角色并切回工作台,由主界面负责跳转
  (e: 'create', id: string): void
  (e: 'generate', charId: string, kind: CharacterViewKind): void
  (e: 'generateAll', charId: string): void
  (e: 'useRef', charId: string, kind: CharacterViewKind): void
}>()

// 导入用的隐藏 file input:页头那个按钮点它(见模板里的注释)
const importInput = ref<HTMLInputElement | null>(null)

/* 卡上那三枚管理动作(复制 / 导出 / 删除)收进一个 ⋮ 菜单。
   三枚圆钮常驻在每张图的右上角太吵,而它们都是低频动作。
   同一时刻只开一个:键是角色 id,同一套写法见 PromptLibrary */
const openCardMenu = ref('')
// 菜单默认朝下开。最后一行离视口底部不够高时改朝上 —— 否则菜单会伸到屏幕外
const cardMenuUp = ref(false)
// 菜单大致高度(三项 + 内边距 + 与按钮的间距),留一点余量
const MENU_ROOM = 130
/* 指针离开这张卡就把菜单收掉。⋮ 本来就是悬停才出现的,菜单却不跟着走 ——
   指针一挪开,图上就剩一块没有锚点的浮层挂在那儿。
   两个细节:① 留 120ms 宽限,⋮ 与菜单之间隔了 6px,横穿那一下不算"离开";
   ② 只认鼠标 —— 触摸抬手时浏览器也会发 pointerleave,照做会把刚点开的菜单立刻收掉 */
const MENU_GRACE = 120
let menuLeaveTimer: number | undefined

/** 收起菜单。几条收起的路径(再点 ⋮、点别处、Esc、选中动作)都走这里,
 *  顺手把宽限计时器清掉 —— 否则它晚一步才响,会把刚重新打开的那张收掉 */
function closeCardMenu() {
  window.clearTimeout(menuLeaveTimer)
  openCardMenu.value = ''
}

function toggleCardMenu(id: string, e: MouseEvent) {
  if (openCardMenu.value === id) {
    closeCardMenu()
    return
  }
  const r = (e.currentTarget as HTMLElement | null)?.getBoundingClientRect()
  cardMenuUp.value = !!r && r.bottom + MENU_ROOM > window.innerHeight
  window.clearTimeout(menuLeaveTimer)
  openCardMenu.value = id
}

/* 指针从 ⋮ 挪向菜单要穿过那道 6px 的缝,缝里既不在 ⋮ 上也不在菜单上 ——
   于是先起倒计时,人重新落回这一片(pointerenter)就把倒计时撤掉 */
function onMenuEnter() {
  window.clearTimeout(menuLeaveTimer)
}
function onMenuLeave(e: PointerEvent) {
  if (e.pointerType !== 'mouse') return
  window.clearTimeout(menuLeaveTimer)
  menuLeaveTimer = window.setTimeout(closeCardMenu, MENU_GRACE)
}

/* 展开后点别处收起:管理动作低频,不该逼用户再点一次 ⋮ 才能走。
   用 closest 判断"点的是不是某个菜单内部",而不是记住某一个容器 ——
   列表里每张卡都挂着一个菜单,一个 ref 挂多处只会拿到最后一个 */
function onDocPointerDown(e: PointerEvent) {
  if (!openCardMenu.value) return
  const t = e.target as Element | null
  if (t && typeof t.closest === 'function' && t.closest('.menu-wrap')) return
  closeCardMenu()
}

/* 三个动作各自包一层:先收起菜单再交出去。
   菜单留着不关会盖住卡片,而这三个动作都会让主界面改 props、重渲染这张卡 */
function duplicateFromCard(id: string) {
  closeCardMenu()
  emit('duplicate', id)
}
function exportFromCard(id: string) {
  closeCardMenu()
  emit('export', id)
}
function removeFromCard(id: string) {
  closeCardMenu()
  emit('remove', id)
}

/* 两个视图态:列表(空)与详情(有 id)。
   设定图与整套设定都挪进详情 —— 五张图加十项挤在一张卡上,
   既不好看也点不明白:点已有图会重新生成、想看大图又没地方看 */
const detailId = ref('')
// 正在全屏看的那张视图(空 = 没在看)
const viewer = ref<CharacterViewKind | ''>('')
// 正在编辑(新建)的表单
const editing = ref(false)
const draft = ref<DraftForm>({ name: '', fields: emptyCharFields(), desc: '', ref: '' })
// 起稿:一句话 + 请求状态 + 它自己的报错(不占用生图那套错误出口)
const idea = ref('')
const drafting = ref(false)
const draftError = ref('')

/* 起稿填过、而用户还没动过的字段。
   校对要有个落点 —— 提示写着 "check what it got wrong",但看不出哪几项是
   模型编的:模型给的值和人手写的值在界面上长得一模一样。
   改一下那一项就抹掉标记(见 markEdited),扫一眼就知道还剩哪几处没看过 */
const aiFilled = ref<Partial<Record<keyof CharacterFields, boolean>>>({})
// 有标记 ⇒ 组说明换成那条图例,不然用户不知道这枚点是什么意思
const hasAiFilled = computed(() => Object.values(aiFilled.value).some(Boolean))
// 已经填过内容 ⇒ 起稿按钮变成 Re-draft(不然想重来一次只能手动清十栏)
const hasSpec = computed(() => Object.values(draft.value.fields).some((s) => (s || '').trim()))

function markEdited(key: keyof CharacterFields) {
  if (aiFilled.value[key]) aiFilled.value[key] = false
}

/* 规格字段是 textarea,随内容长高。
   为什么不用 <input>:字段值上限 12 个词(约 70 字符),两列之后每栏只有 338px,
   在 13px 下约 55 字符 —— 边界值会被截在视野外,只能靠方向键摸。
   封顶三行、再多内部滚(见样式),不然一栏长起来会把整行拉高 */
const vGrow = {
  mounted(el: HTMLTextAreaElement) {
    grow(el)
  },
  updated(el: HTMLTextAreaElement) {
    grow(el)
  }
}
function grow(el: HTMLTextAreaElement) {
  // 先归零再量:不归零的话 scrollHeight 只会越量越大,永远缩不回去
  el.style.height = 'auto'
  el.style.height = `${el.scrollHeight}px`
}

const detailChar = computed(() => props.characters.find((c) => c.id === detailId.value))

function viewOf(charId: string, kind: CharacterViewKind): CharacterView | undefined {
  return props.views[charId]?.find((v) => v.kind === kind)
}

/* 还没用过的角色:给一个共享的空值,省得每次渲染都造新对象 */
const NO_STAT: CharacterStat = { count: 0, lastAt: 0 }
function statOf(id: string): CharacterStat {
  return props.stats[id] || NO_STAT
}

/** 时间戳的短格式,与历史页同一档:只到分钟,不带年份 */
function fmtStamp(ts: number) {
  const d = new Date(ts)
  const p = (x: number) => String(x).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** 只到日的写法:卡片上的"创建 / 最后使用"要的是哪一天,不是几点 */
function fmtDay(ts: number) {
  const d = new Date(ts)
  const p = (x: number) => String(x).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** 卡片上的身份行:设定的第一项就是"这是谁"(摄影师、赛博武士)。
 *  老角色只有自由描述时退回描述 —— 不摆一句 "No spec yet" 让人以为数据丢了 */
function roleOf(c: Character) {
  return (c.fields?.identity || '').trim() || (c.desc || '').trim() || 'No spec yet'
}

/** 特征胶囊:最多三枚 —— 卡片上只放得下这么多,完整的十项在详情页。
 *  候选多于三枚是有意的:跨场景不变的面貌特征排在前面,后两项兜底 ——
 *  老角色没有 face,靠它们仍能凑出三枚,不会只剩一行空白 */
function traitsOf(c: Character): string[] {
  const f = c.fields
  if (!f) return []
  return [f.face, f.hair, f.eyes, f.outfit, f.marks]
    .map((s) => (s || '').trim())
    .filter(Boolean)
    .slice(0, 3)
}

/** 详情页那一行用量:生成次数 → 创建时间 → 最后使用。
 *  没有的部分不占位 —— 一个刚建的角色只该说"还没用过",不该出现空的"最后使用" */
const heroMeta = computed(() => {
  const c = detailChar.value
  if (!c) return []
  const s = statOf(c.id)
  const out = [
    s.count ? `${s.count} generations` : 'Not used yet',
    `Created ${fmtStamp(c.createdAt)}`
  ]
  if (s.lastAt) out.push(`Last used ${fmtStamp(s.lastAt)}`)
  return out
})

/** 头像优先用正脸:圆形容器裁的是一张脸。主参考图可能被设成全身图,
 *  裁进圆里就只剩半截身子。没有正脸时才退回主参考图 */
const avatarSrc = computed(() => {
  const c = detailChar.value
  if (!c) return ''
  return coverSrc(viewOf(c.id, 'front')?.data ?? c.ref)
})

/** 设定图网格的五格:修饰词与取景来自 CHARACTER_VIEWS,内容是当前已有的那张 */
const sheetCells = computed(() =>
  CHARACTER_VIEWS.map((v) => ({ ...v, view: viewOf(detailId.value, v.kind) }))
)

const filledCount = computed(() => sheetCells.value.filter((c) => c.view).length)
const missingCount = computed(() => sheetCells.value.length - filledCount.value)

/** 正脸在不在。其余四张都以它为参考图,所以它是这条流水线的前置 ——
 *  没有它时那四格是"上锁"而不是"可点但会报错"(见 App 的 genCharView 守卫) */
const hasFront = computed(() => !!viewOf(detailId.value, 'front'))

/** 这一格现在能不能点。除正脸外的空格子,要先有正脸 ——
 *  与其让它点下去弹一句"先生成正脸",不如直接锁住,把顺序摆在明面上 */
function isLocked(kind: CharacterViewKind) {
  return kind !== 'front' && !hasFront.value
}

/** 主参考图来自哪张视图。不比对 Blob:刷新后主图与视图是两次独立的读取,不是同一个实例 */
const refKind = computed(() => detailChar.value?.refKind)
const refLabel = computed(() => CHARACTER_VIEWS.find((v) => v.kind === refKind.value)?.label || '')

/** 正在生成的那张是哪个视图。面板下方要说清在等哪一张 */
const busyLabel = computed(() => CHARACTER_VIEWS.find((v) => v.kind === props.busy)?.label || '')

/* 一次补齐的按钮文案。五张齐了就该停下 —— 原来写成"Generate the rest",
   全部齐了也能点,点了却什么都不发生,看着像坏了 */
const generateAllLabel = computed(() => {
  if (!missingCount.value) return 'All views ready'
  return viewOf(detailId.value, 'front') ? `Generate ${missingCount.value} more` : 'Generate all views'
})

// 大图里能翻的只有"已经有图"的那几张,空位不参与
const viewerKinds = computed(() =>
  CHARACTER_VIEWS.map((v) => v.kind).filter((k) => viewOf(detailId.value, k))
)
const viewerSrc = computed(() => {
  if (!viewer.value) return ''
  const v = viewOf(detailId.value, viewer.value)
  return v ? coverSrc(v.data) : ''
})
const viewerLabel = computed(
  () => CHARACTER_VIEWS.find((v) => v.kind === viewer.value)?.label || ''
)

function isBusy(kind: string) {
  return props.busy === kind
}

function openDetail(id: string) {
  detailId.value = id
  viewer.value = ''
  closeCardMenu()
  // 进详情才去取图:列表阶段一张都不读 IndexedDB
  emit('open', id)
  window.scrollTo({ top: 0, behavior: 'smooth' })
}

function backToList() {
  detailId.value = ''
  viewer.value = ''
}

/* 大图是个模态框:打开时把焦点收进来,关闭时还回原来那张格子 ——
   不还回去的话,键盘用户关掉大图后焦点会掉到 body 上,得从头 Tab 一遍 */
const viewerBox = ref<HTMLElement | null>(null)
let restoreFocus: HTMLElement | null = null

function openViewer(kind: CharacterViewKind) {
  restoreFocus = document.activeElement as HTMLElement | null
  viewer.value = kind
  nextTick(() => viewerBox.value?.focus())
}
function closeViewer() {
  viewer.value = ''
  nextTick(() => restoreFocus?.focus())
  restoreFocus = null
}
/** 把一个浮层里的 Tab 圈在它自己内部。不用 inert 关掉整个应用 —— 那要动主界面,
 *  而浮层里的控件就那么几个,一个循环就够了。
 *  大图里只有按钮,向导里还有输入框,所以两者都收 */
function trapTab(box: HTMLElement | null, e: KeyboardEvent) {
  if (!box) return
  const items = Array.from(
    box.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled])')
  )
  if (!items.length) return
  const first = items[0]
  const last = items[items.length - 1]
  const at = document.activeElement as HTMLElement | null
  // 焦点还停在容器本身(刚打开时):下一个 Tab 直接进第一个控件
  if (!at || !items.includes(at)) {
    e.preventDefault()
    ;(e.shiftKey ? last : first).focus()
    return
  }
  if (e.shiftKey && at === first) {
    e.preventDefault()
    last.focus()
  } else if (!e.shiftKey && at === last) {
    e.preventDefault()
    first.focus()
  }
}
/** 在大图里前后翻。到头就绕回另一头:只有几张图,循环比禁用更好用 */
function stepViewer(dir: number) {
  const cur = viewer.value
  const list = viewerKinds.value
  if (!cur || list.length < 2) return
  const at = list.indexOf(cur)
  viewer.value = list[(at + dir + list.length) % list.length]
}

// 大图上的两个动作:针对"正在看的那张"。空态直接不发,免得把空串当视图名传下去
function regenerateViewer() {
  const c = detailChar.value
  if (c && viewer.value) emit('generate', c.id, viewer.value)
}
function applyViewerRef() {
  const c = detailChar.value
  if (c && viewer.value) emit('useRef', c.id, viewer.value)
}

/* Esc 逐层退:先关大图,再关向导,最后回列表 ——
   开着大图按 Esc 直接退出详情会让人丢掉"我看的是哪个角色"。
   左右键在大图里翻页,和预览卡同一套操作 */
function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    if (viewer.value) closeViewer()
    else if (openCardMenu.value) closeCardMenu()
    else if (editing.value) closeWizard()
    else if (detailId.value) backToList()
    return
  }
  // 大图与向导都是模态,但同一时刻只会开一个(一个在详情里,一个在列表里)
  if (viewer.value) {
    if (e.key === 'Tab') trapTab(viewerBox.value, e)
    else if (e.key === 'ArrowLeft') stepViewer(-1)
    else if (e.key === 'ArrowRight') stepViewer(1)
  } else if (editing.value && e.key === 'Tab') {
    trapTab(wizardBox.value, e)
  }
}
onMounted(() => {
  window.addEventListener('keydown', onKey)
  document.addEventListener('pointerdown', onDocPointerDown)
})
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey)
  document.removeEventListener('pointerdown', onDocPointerDown)
  window.clearTimeout(menuLeaveTimer)
})

function startEdit() {
  draft.value = { name: '', fields: emptyCharFields(), desc: '', ref: '' }
  idea.value = ''
  draftError.value = ''
  // 向导从头开始:上一次留下的 id、步数与起稿标记必须清掉,否则会直接跳进旧角色的第 3 步
  step.value = 1
  wizardId.value = ''
  aiFilled.value = {}
  editing.value = true
  /* 向导是漂浮卡,相当于开了一层模态:焦点得收进卡里。
     落点选卡片本身而不是第一个输入框 —— 先让读屏念出这张卡是什么,
     再让用户自己 Tab 进"名字"那一栏 */
  restoreWizardFocus = document.activeElement as HTMLElement | null
  nextTick(() => wizardBox.value?.focus())
}

/* —— 新建向导 ——
   建角色本来是"填表 → 存 → 出图"一条线,拆成两页看着像两件事。
   现在摊成三步:基础信息(或参考图)→ 主视图 → 其余设定图,
   每步一张卡,步骤条在卡头上说明"现在在哪、还差什么"。

   角色在第 1 步保存时落库 —— 第 2、3 步都要 charId 才能出图。
   所以第 1 步存下之后转成只读摘要:这一页没有"改角色",
   留着可编辑的表单只会让人再点一次保存,多出一个副本 */
type WizardStep = 1 | 2 | 3

const STEPS: Array<{ n: WizardStep; label: string }> = [
  { n: 1, label: 'Basics' },
  { n: 2, label: 'Main view' },
  { n: 3, label: 'Other views' }
]

const step = ref<WizardStep>(1)
// 向导进行中的角色 id。第 1 步存完才有,后两步都靠它取图
const wizardId = ref('')
// 漂浮卡本身:用来把焦点收进来、把 Tab 圈住(与看大图的 viewerBox 同一套)
const wizardBox = ref<HTMLElement | null>(null)
// 打开向导时焦点在哪,关掉要还回去
let restoreWizardFocus: HTMLElement | null = null

const wizardChar = computed(() => props.characters.find((c) => c.id === wizardId.value))
function wizardViewOf(kind: CharacterViewKind): CharacterView | undefined {
  return props.views[wizardId.value]?.find((v) => v.kind === kind)
}
const wizardFront = computed(() => wizardViewOf('front'))

/** 生成正脸会拿哪张图当参考。这是第 2 步最该说清的一件事:
 *  有主参考图就是图生图,没有就是纯文字生图 —— 出来的东西差别很大。
 *  主参考图可能来自第一步上传的图,也可能是被"设为主视图"的某张设定图,
 *  两者的说法不一样,所以要分开说(见 App 的 genCharView 与 useViewAsRef) */
const heroSource = computed(() => {
  const c = wizardChar.value
  if (!c?.ref) return 'Text only — no reference image'
  const kind = CHARACTER_VIEWS.find((v) => v.kind === c.refKind)?.label
  return kind ? `${kind} view, set as the main one` : 'The reference image you uploaded'
})
// 第 3 步的四张,主视图不在其中
const wizardRest = computed(() =>
  CHARACTER_VIEWS.filter((v) => v.kind !== 'front').map((v) => ({ ...v, view: wizardViewOf(v.kind) }))
)
const restMissing = computed(() => wizardRest.value.filter((c) => !c.view).length)
/* 一次补齐的按钮文案。四张齐了就该停下 —— 齐了还能点、点了没反应,看着像坏了 */
const restLabel = computed(() =>
  restMissing.value ? `Generate ${restMissing.value} remaining` : 'All views ready'
)

/** 这一步能不能进。第 2 步要有角色,第 3 步要有主视图 ——
 *  前置没做完的那一步直接锁住,点不动,顺序就不必靠弹错来教 */
function stepUnlocked(n: WizardStep): boolean {
  if (n === 1) return true
  if (n === 2) return !!wizardId.value
  return !!wizardFront.value
}
/** 这一步做完没有。做完的在步骤条上打勾,和"正在这一步"区分开 */
function stepDone(n: WizardStep): boolean {
  if (n === 1) return !!wizardId.value
  if (n === 2) return !!wizardFront.value
  return false
}
function goStep(n: WizardStep) {
  if (stepUnlocked(n)) step.value = n
}
/** 步骤条上两段连接线:x-1 与 x 之间那段,只在前一步做完时才点亮 */
function lineDone(n: WizardStep): boolean {
  return n > 1 && stepDone((n - 1) as WizardStep)
}
function backStep() {
  if (step.value > 1) step.value = (step.value - 1) as WizardStep
}

/** 第 1 步存完由父组件回调:拿到 id,推进到主视图那一步。
 *  中间不退到列表 —— 这条向导是一口气走完的 */
function onSaved(id: string) {
  wizardId.value = id
  step.value = 2
  // 后两步要读这个角色的图,先把它的图取出来
  emit('open', id)
}
defineExpose({ onSaved })

/** 退出向导。第 1 步还没存,退了就当没发生;
 *  存过之后角色已经在库里,退了它自己会出现在列表里 */
function closeWizard() {
  editing.value = false
  step.value = 1
  wizardId.value = ''
  draftError.value = ''
  /* 焦点还回当初点开的那个按钮 —— 不还的话键盘用户关掉浮层后
     焦点会掉到 body 上,得从头 Tab 一遍(与关大图同一条理由) */
  const back = restoreWizardFocus
  restoreWizardFocus = null
  if (back) nextTick(() => back.focus())
}

/** 走完三步:把角色交给详情页 —— 那里是它的"落地页",
 *  有完整设定表、大图查看,以及"用它开画" */
function finishWizard() {
  const id = wizardId.value
  /* 走完是"换页"而不是"关浮层",所以不留焦点还回目标 ——
     列表里那个按钮已经不在页面上了,还回去只会把焦点丢在 body */
  restoreWizardFocus = null
  closeWizard()
  if (id) openDetail(id)
}

/* 起稿:一句话交给文本模型拆成这套设定 + 一个名字,回填后可逐项修改。
   只填字段、不出图 —— 先校对再花钱。结果只落在这张表单里,不写库 */
async function draftWithAI() {
  const text = idea.value.trim()
  if (!text || drafting.value) return
  const cfg = props.textConfig
  if (!cfg || !cfg.model || !cfg.baseUrl) {
    draftError.value = 'Set up prompt enhancing in API settings first.'
    return
  }
  drafting.value = true
  draftError.value = ''
  try {
    const d = await draftCharacterFields(cfg, text)
    // 一项都没解出来 = 模型没按那个格式回。如实说,别假装已经填好了
    if (!Object.values(d.fields).some((s) => s.trim())) {
      draftError.value =
        'The model did not return a usable spec. Fill the fields by hand, or try another text model.'
      return
    }
    /* 名字只在还空着的时候补:它是这张卡的标题,用户自己敲进去的那个
       不该被一次起稿顶掉。想换成模型起的名字,先清空再点一次 */
    if (!draft.value.name.trim() && d.name) draft.value.name = d.name
    draft.value.fields = d.fields
    /* 记下这一趟哪些栏是模型填的。空着的那些不标 —— 标了反而像在说
       "这里有什么要看",而它们本来就该留空(见 server 那条提示) */
    const marks: Partial<Record<keyof CharacterFields, boolean>> = {}
    for (const k of Object.keys(d.fields) as Array<keyof CharacterFields>) {
      if (d.fields[k].trim()) marks[k] = true
    }
    aiFilled.value = marks
  } catch (e: any) {
    draftError.value = e?.message || 'Could not draft the character'
  } finally {
    drafting.value = false
  }
}

function onPickRef(e: Event) {
  const file = (e.target as HTMLInputElement).files?.[0]
  if (!file) return
  const reader = new FileReader()
  reader.onload = () => (draft.value.ref = String(reader.result))
  reader.readAsDataURL(file)
  ;(e.target as HTMLInputElement).value = ''
}

/* 导入:只把文件交出去。zip 要解包、图要落 IndexedDB —— 那是主界面的活,
   这一页从头到尾不碰字节(与参考图那条路同一分工) */
function onImportFile(e: Event) {
  const file = (e.target as HTMLInputElement).files?.[0]
  // 清空 input:同一个文件选第二次也要能触发 change
  ;(e.target as HTMLInputElement).value = ''
  if (file) emit('import', file)
}

function submit() {
  const d = draft.value
  if (!d.name.trim()) return
  // 字段与参考图各拷一份交出去,免得表单被继续改动时牵动已经发出的这次保存
  emit('save', { name: d.name, fields: { ...d.fields }, desc: d.desc, refData: d.ref })
  /* 这里不推进也不关表单:存完由父组件回调 onSaved 推向导走下一步 ——
     save 是异步的,现在改步数会在角色还没进列表时先跳到"主视图",
     那一格既没有 id 也没有图。存失败时表单留着,改完可以直接再点一次 */
}

/** 设定的摘要:挑最能认出这个人的几项连起来当副标题。
 *  不是全部十项 —— 完整的规格表就在下面那个面板里,副标题再抄一遍只是噪声 */
function summary(c: Character) {
  const f = c.fields
  if (!f) return c.desc || 'No spec yet'
  return [f.identity, f.face, f.hair, f.eyes, f.outfit]
    .map((s) => (s || '').trim())
    .filter(Boolean)
    .join(' · ')
}

/* —— 表单里的字段 ——
   键、标签、占位示例、能否留空,集中在这里。分两组的原因与 api.ts 一致:
   面貌特征会跟着每一张成品走,后两项只塑造设定图。
   表单、详情页的规格表都由这张表生成,所以标签不会两处走样。

   optional 只影响界面上那个 Optional 标记 —— 起稿时谁必须编、谁可以留空,
   由 server 那条提示决定(那里才说得出"编出来会不会改变人物") */
type FieldSpec = {
  key: keyof CharacterFields
  label: string
  // 占位示例:写具体值而不是"请输入",它同时是这一栏该写什么的示范
  hint: string
  optional?: boolean
}

const FACE_FIELDS: FieldSpec[] = [
  { key: 'identity', label: 'Identity', hint: 'cyberpunk female warrior' },
  { key: 'face', label: 'Face', hint: 'angular jaw, warm tan skin, late 30s' },
  { key: 'hair', label: 'Hair', hint: 'short silver hair, undercut' },
  { key: 'brows', label: 'Brows', hint: 'thick straight black brows' },
  { key: 'eyes', label: 'Eyes', hint: 'glowing blue optics' },
  { key: 'noseMouth', label: 'Nose & mouth', hint: 'narrow straight nose, full lips' },
  { key: 'facialHair', label: 'Facial hair', hint: 'clean-shaven' },
  { key: 'faceMarks', label: 'Face marks', hint: 'scar over left brow', optional: true }
]

const SHEET_FIELDS: FieldSpec[] = [
  { key: 'outfit', label: 'Outfit', hint: 'armored jacket, neon trim' },
  { key: 'marks', label: 'Marks', hint: 'chrome right arm, engraved dog tags', optional: true }
]

/* 表单里十栏的完整顺序 —— 详情页的规格表按它排 */
const ALL_FIELDS: FieldSpec[] = [...FACE_FIELDS, ...SHEET_FIELDS]

/* 两组字段,各有自己的标题。
   为什么要分成两组而不是一组加一条分界线 —— 这两组的差别是"会不会进你每一张图",
   是这个角色设定里最要紧的一条界线。脚注语气(11px 灰字)压不住它,
   所以给它一个与 Spec 平级的标题,让它自己成为一段 */
type FormGroup = {
  title: string
  hint: string
  fields: FieldSpec[]
  // 这一组末尾再补一个自由备注栏(占满两列)。备注不是 CharacterFields 的成员
  notes?: boolean
}

const FORM_GROUPS: FormGroup[] = [
  {
    title: 'Spec',
    hint: 'The face travels with every image you generate.',
    fields: FACE_FIELDS
  },
  {
    title: 'Reference sheet only',
    hint: 'Outfit, marks and notes — never merged into your prompts.',
    fields: SHEET_FIELDS,
    notes: true
  }
]

/* 详情页的规格表:十项固定设定按顺序排,再做一条可选的备注 */
const SPEC_LABELS: Array<[keyof CharacterFields, string]> = ALL_FIELDS.map((f) => [f.key, f.label])
function specRows(c: Character) {
  const f = c.fields || emptyCharFields()
  const rows = SPEC_LABELS.map(([k, label]) => ({ label, value: (f[k] || '').trim(), wide: false }))
  const notes = (c.desc || '').trim()
  // 备注是自由文本,回看时占满整行
  if (notes) rows.push({ label: 'Notes', value: notes, wide: true })
  return rows
}
</script>

<template>
  <div class="chars">
    <!-- —— 列表 —— -->
    <template v-if="!detailChar">
      <header class="chars-head">
        <div>
          <h1 class="chars-title">Characters</h1>
          <p class="chars-sub">
            A fixed spec plus a set of reference views. Pick a character while composing and both are
            applied, so the face stays the same across images.
          </p>
        </div>
        <!-- 导入放页头:它是一次针对整个角色区的动作(一个包里可能有多个角色),
             不属于某一张卡。按钮用 <button> 触发那个隐藏 input 而不是用 label ——
             label 本身进不了 Tab 键序,键盘用户就点不到 -->
        <div v-if="!editing" class="chars-acts">
          <button class="chars-import" @click="importInput?.click()">
            <PhUploadSimple aria-hidden="true" />
            Import
          </button>
          <button class="chars-new" @click="startEdit">
            <PhPlus aria-hidden="true" />
            New character
          </button>
        </div>
      </header>

      <!-- —— 新建向导:漂浮卡 ——
           创建是一条独立流程,不该插进列表里把页面顶开 —— 它是盖在这一页之上的一层,
           关掉就回到原样。三步摊成一张卡:步骤条在头上,内容在中间,进退在脚下;
           没做到的那一步在条上是锁的,点不动 —— 顺序靠结构说,不靠报错说。
           暗幕是与卡片平级的另一个 fixed 元素,不是把卡包起来(理由见样式注释) -->
      <div v-if="editing" class="wz-veil" aria-hidden="true"></div>
      <section
        v-if="editing"
        ref="wizardBox"
        class="wizard"
        role="dialog"
        aria-modal="true"
        aria-label="New character"
        tabindex="-1"
      >
        <nav class="wz-steps" aria-label="Creation steps">
          <template v-for="s in STEPS" :key="s.n">
            <span
              v-if="s.n > 1"
              class="wz-line"
              :class="{ 'is-done': lineDone(s.n) }"
              aria-hidden="true"
            ></span>
            <button
              class="wz-step"
              :class="{
                'is-active': step === s.n,
                'is-done': stepDone(s.n) && step !== s.n,
                'is-locked': !stepUnlocked(s.n)
              }"
              :disabled="!stepUnlocked(s.n)"
              :aria-current="step === s.n ? 'step' : undefined"
              @click="goStep(s.n)"
            >
              <span class="wz-dot">
                <PhCheck v-if="stepDone(s.n) && step !== s.n" weight="bold" aria-hidden="true" />
                <template v-else>{{ s.n }}</template>
              </span>
              <span class="wz-name">{{ s.label }}</span>
            </button>
          </template>
        </nav>

        <!-- 第 1 步:基础信息 / 参考图。存下之前是可填的表单,
             存下之后换成只读摘要(角色已经落库,再点一次保存只会多一个副本) -->
        <div v-if="step === 1" class="wz-pane wz-form">
          <template v-if="!wizardId">
            <!-- 一句话 → 整套设定。放在最上面:这是这一页最常用的入口 ——
                 大多数人是一句话起稿、再逐栏校对,而不是从空白一栏栏手填。
                 它是件工具,不是又一项要填的内容,所以给它一整块自己的底;
                 模型要填的是下面的字段,报错也留在它旁边而不是表单末尾 -->
            <div class="wz-draft">
              <label class="wz-draft-label" for="cp-idea">Describe it in a sentence</label>
              <div class="wz-draft-row">
                <input
                  id="cp-idea"
                  v-model="idea"
                  class="ed-input"
                  placeholder="cyberpunk female warrior"
                  @keyup.enter="draftWithAI"
                />
                <button
                  class="ed-btn primary"
                  :disabled="drafting || !idea.trim()"
                  @click="draftWithAI"
                >
                  <PhSparkle aria-hidden="true" />
                  {{ drafting ? 'Drafting…' : hasSpec ? 'Re-draft' : 'Draft with AI' }}
                </button>
              </div>
              <p v-if="draftError" class="wz-err" role="alert">{{ draftError }}</p>
              <p v-else-if="drafting" class="wz-draft-hint">Filling the name and spec…</p>
              <!-- 有标出来的栏时换成图例。图例放在这里而不是各组的说明里:
                   标记是这一块产生的,而且两组里都可能有 —— 挂在哪一组都是偏的 -->
              <p v-else-if="hasAiFilled" class="wz-draft-hint">
                <span class="wz-ai" aria-hidden="true"></span>
                written by the model — clears once you edit that field
              </p>
              <p v-else class="wz-draft-hint">
                Fills the name and the spec — check what it got wrong.
              </p>
            </div>

            <!-- 名字单独一栏,不与下面十项同组:它是这个角色的标识,
                 不进任何提示词(见 types.ts 的 CharacterFields 注释),
                 而下面十项都是"发给模型的条件"。两者性质不同,所以分开放。

                 它同时也是全表唯一必填的一栏,所以要有一个讲出来的标记 ——
                 原来靠"禁用的 Save 按钮"暗示,而按钮在卡脚,离这里很远。
                 字号回到与其它输入框同档:它上面就是起稿块,
                 再拿 20px/600 当标题,在一排 12–15px 里只会显得不搭 -->
            <label class="wz-field">
              <span class="wz-label">
                Name
                <span class="wz-mark is-required">Required</span>
              </span>
              <input
                v-model="draft.name"
                class="ed-input"
                placeholder="Name this character"
                aria-required="true"
              />
            </label>

            <!-- 十栏设定分成两组,各有自己的标题。
                 这条界线的分量值得一个标题:上面八项会进你每一张成品,
                 下面三项只塑造设定图 —— 它是这份设定里最要紧的一条区分。
                 两组都由 FORM_GROUPS 生成,栏位的模板只写一遍 -->
            <div v-for="g in FORM_GROUPS" :key="g.title" class="wz-group">
              <div class="wz-group-head">
                <h4 class="wz-group-title">{{ g.title }}</h4>
                <span class="wz-group-hint">{{ g.hint }}</span>
              </div>

              <div class="wz-fields">
                <label v-for="f in g.fields" :key="f.key" class="wz-field">
                  <span class="wz-label">
                    {{ f.label }}
                    <span v-if="f.optional" class="wz-mark">Optional</span>
                    <template v-if="aiFilled[f.key]">
                      <span class="wz-ai" aria-hidden="true"></span>
                      <span class="wz-sr">drafted by the model</span>
                    </template>
                  </span>
                  <textarea
                    v-grow
                    rows="1"
                    v-model="draft.fields[f.key]"
                    class="ed-input"
                    :placeholder="f.hint"
                    @input="markEdited(f.key)"
                  ></textarea>
                </label>

                <!-- 备注不进 CharacterFields(它是自由文本,不参与起稿的十行),
                     所以单独写一格,占满两列 -->
                <label v-if="g.notes" class="wz-field is-wide">
                  <span class="wz-label">Notes</span>
                  <textarea
                    v-grow
                    rows="1"
                    v-model="draft.desc"
                    class="ed-input"
                    placeholder="Anything else worth pinning down"
                  ></textarea>
                </label>
              </div>
            </div>

            <!-- 参考图:比文字更能定形状,但是可选的,所以放在最后 -->
            <div class="wz-group">
              <div class="wz-group-head">
                <h4 class="wz-group-title">
                  Reference image
                  <span class="wz-mark">Optional</span>
                </h4>
              </div>

              <!-- 空态与有图态占同样的高度:挑完图不该整块往上跳一下 -->
              <div v-if="draft.ref" class="wz-ref">
                <img class="wz-ref-thumb" :src="draft.ref" alt="Reference image" />
                <span class="wz-ref-body">
                  <span class="wz-ref-main">Reference image</span>
                  <span class="wz-ref-hint">Applied on top of the spec when generating</span>
                </span>
                <button class="ed-btn" @click="draft.ref = ''">Remove</button>
              </div>
              <label v-else class="wz-ref wz-ref-pick" for="cp-file">
                <PhImage aria-hidden="true" />
                <span class="wz-ref-body">
                  <span class="wz-ref-main">Add an image</span>
                  <span class="wz-ref-hint">Pins the shape far better than words can</span>
                </span>
              </label>
            </div>
          </template>

          <template v-else-if="wizardChar">
            <div class="wz-sum">
              <h4 class="wz-sum-name">{{ wizardChar.name }}</h4>
              <span class="wz-sum-note">Saved</span>
            </div>
            <img
              v-if="wizardChar.ref"
              class="wz-sum-thumb"
              :src="coverSrc(wizardChar.ref)"
              alt=""
            />
            <div class="wz-group">
              <div class="wz-group-head">
                <h4 class="wz-group-title">Spec</h4>
                <span class="wz-group-hint">This is what every view is built from.</span>
              </div>
              <div class="wz-fields">
                <div
                  v-for="r in specRows(wizardChar)"
                  :key="r.label"
                  class="wz-field is-readonly"
                  :class="{ 'is-wide': r.wide }"
                >
                  <span class="wz-label">{{ r.label }}</span>
                  <span class="wz-value" :class="{ dim: !r.value }">{{ r.value || '—' }}</span>
                </div>
              </div>
            </div>
          </template>
        </div>

        <!-- 第 2 步:主视图。它是整条流水线的锚,其余四张都照它生成。
             左图右事:空态、生成中、已有图共用同一个框,所以点下去之后画面不跳。
             右边那一栏回答两件这一屏最该说清的事 ——
             它会拿哪张图当参考,以及"接下来该点哪里" -->
        <div v-else-if="step === 2" class="wz-pane">
          <div class="wz-lead">
            <h3 class="wz-h">Main view</h3>
            <p class="wz-p">
              The anchor every other view is built from — so it pays to get this one right before
              moving on.
            </p>
          </div>

          <div class="wz-hero">
            <div class="wz-hero-shot">
              <div class="cell">
                <button
                  v-if="wizardFront"
                  class="cell-img has-img"
                  :disabled="!!props.busy"
                  aria-label="Regenerate the main view"
                  @click="emit('generate', wizardId, 'front')"
                >
                  <img :src="coverSrc(wizardFront.data)" alt="" />
                  <span class="cell-zoom" aria-hidden="true"><PhArrowsClockwise /></span>
                </button>
                <button
                  v-else
                  class="cell-img start"
                  :class="{ busy: isBusy('front') }"
                  :disabled="!!props.busy"
                  aria-label="Generate the main view"
                  @click="emit('generate', wizardId, 'front')"
                >
                  <span class="cell-ph" aria-hidden="true">+</span>
                </button>
                <span class="cell-label">{{ isBusy('front') ? 'Generating…' : 'Front' }}</span>
              </div>
            </div>

            <div class="wz-hero-body">
              <p class="wz-hero-note">
                {{
                  wizardFront
                    ? 'Every other view is generated from this one — that is what keeps the face the same.'
                    : 'One front-facing headshot. It becomes the reference every other view is built from.'
                }}
              </p>

              <!-- 这一步最该说清、而界面上一直没地方说的一件事:正脸会拿哪张图当参考。
                   有主参考图就是图生图,没有就是纯文字生图 —— 出来的东西差别很大 -->
              <dl class="wz-facts">
                <dt class="wz-facts-k">Generated from</dt>
                <dd class="wz-facts-v">{{ heroSource }}</dd>
              </dl>

              <!-- 主按钮永远代表"接下来该做的那件事":还没有正脸时是它;
                   有了之后主按钮交给卡脚那个 Next(见卡脚上的条件 class) -->
              <button
                class="ed-btn"
                :class="{ primary: !wizardFront }"
                :disabled="!!props.busy"
                @click="emit('generate', wizardId, 'front')"
              >
                <PhSparkle v-if="!props.busy" aria-hidden="true" />
                {{ props.busy ? 'Generating…' : wizardFront ? 'Regenerate' : 'Generate main view' }}
              </button>
            </div>
          </div>
        </div>

        <!-- 第 3 步:其余四张。一律以主视图为参考图 —— 这就是"同一张脸"的保证 -->
        <div v-else class="wz-pane">
          <div class="wz-lead">
            <div class="wz-lead-row">
              <h3 class="wz-h">Other views</h3>
              <button
                class="ed-btn"
                :disabled="!!props.busy || !restMissing"
                @click="emit('generateAll', wizardId)"
              >
                <PhSparkle aria-hidden="true" />
                {{ restLabel }}
              </button>
            </div>
            <p class="wz-p">
              Each of these is built from the main view. Generate them one at a time, or all at
              once — failing early stops the run instead of burning four more calls.
            </p>
          </div>

          <div class="wz-grid">
            <div
              v-for="cell in wizardRest"
              :key="cell.kind"
              class="cell"
              :class="{ 'is-portrait': cell.framing === 'portrait' }"
            >
              <button
                v-if="cell.view"
                class="cell-img has-img"
                :disabled="!!props.busy"
                :aria-label="`Regenerate the ${cell.label} view`"
                @click="emit('generate', wizardId, cell.kind)"
              >
                <img :src="coverSrc(cell.view.data)" alt="" />
                <span class="cell-zoom" aria-hidden="true"><PhArrowsClockwise /></span>
              </button>
              <button
                v-else
                class="cell-img"
                :class="{ busy: isBusy(cell.kind) }"
                :disabled="!!props.busy"
                :aria-label="`Generate the ${cell.label} view`"
                @click="emit('generate', wizardId, cell.kind)"
              >
                <span class="cell-ph" aria-hidden="true">+</span>
              </button>
              <span class="cell-label">{{ cell.label }}</span>
            </div>
          </div>
        </div>

        <div class="wz-foot">
          <button
            v-if="step === 1 && !wizardId"
            class="ed-btn primary"
            :disabled="!draft.name.trim()"
            @click="submit"
          >
            Save &amp; continue
          </button>
          <button v-else-if="step === 1" class="ed-btn primary" @click="goStep(2)">
            Next: main view
          </button>
          <!-- 主按钮永远只该有一个:第 2 步还没有正脸时,主按钮是卡身里那个
               "Generate main view";出了正脸才轮到这里的 Next(见卡身的条件 class)。
               两个都涂黑会让"下一步做什么"变得含糊 -->
          <button
            v-else-if="step === 2"
            class="ed-btn"
            :class="{ primary: !!wizardFront }"
            :disabled="!wizardFront"
            @click="goStep(3)"
          >
            Next: other views
          </button>
          <button v-else class="ed-btn primary" @click="finishWizard">Done</button>

          <button v-if="step > 1" class="ed-btn" @click="backStep">Back</button>
          <button class="ed-btn" @click="closeWizard">
            {{ step === 1 && !wizardId ? 'Cancel' : 'Close' }}
          </button>
        </div>
      </section>

      <!-- 列表:角色海报卡。顶图全出血铺满整张卡,底部渐变暗幕托起白字;
           无边框、靠阴影浮起,圆角加大到 24px。
           卡里有两个动作:点空白处进详情(一张透明覆盖按钮),以及
           "Create with this character" 直接拿这个角色开画 ——
           按钮不能嵌在按钮里,所以整卡命中区改成覆盖式的一层,内容区透传点击 -->
      <div v-if="props.characters.length" class="grid">
        <article v-for="c in props.characters" :key="c.id" class="ctile">
          <div class="ctile-main">
            <!-- 顶图:绝对铺满,海报式取景 -->
            <span class="ctile-img">
              <img v-if="c.ref" :src="coverSrc(c.ref)" alt="" loading="lazy" decoding="async" />
              <span v-else class="ctile-ph" aria-hidden="true">
                <PhMaskHappy />
              </span>
            </span>
            <!-- 底部渐变暗幕:透明→深,白字在任何图上都可读。
                 覆盖照片(非界面),刻意不走 token,与预览卡/详情格同一套 -->
            <span class="ctile-veil" aria-hidden="true"></span>

            <!-- 文本叠在暗幕上,白字,贴底排列。
                 pointer-events 由 CSS 透传,只有下面的 CTA 例外 -->
            <span class="ctile-content">
              <!-- 名字与快捷开画同一行:名字占满剩余,按钮靠右收在末尾 -->
              <span class="ctile-head">
                <span class="ctile-name">{{ c.name }}</span>
                <!-- 快捷开画:套上这个角色直接回工作台,省掉"进详情→记住名字→
                     切回首页→再选一次"那条绕路。
                     卡最窄只有 260px,一行里放不下整句,所以按钮上只写 Create ——
                     完整含义留在 aria-label 里,读屏拿得到 -->
                <button
                  class="ctile-cta"
                  :aria-label="`Create with ${c.name}`"
                  @click="emit('create', c.id)"
                >
                  <span>Create</span>
                  <PhArrowRight class="ctile-cta-ico" aria-hidden="true" />
                </button>
              </span>
              <span class="ctile-role">{{ roleOf(c) }}</span>
              <span v-if="traitsOf(c).length" class="ctile-chips">
                <span v-for="t in traitsOf(c)" :key="t" class="chip">{{ t }}</span>
              </span>

              <!-- 用量:三格 + 竖向分隔,白字压在暗幕上。
                   全是真数(从历史记录按 characterId 聚合,见 App 的 charStats) -->
              <span class="ctile-stats">
                <span class="cstat">
                  <span class="cstat-h">
                    <PhSparkle class="cstat-ico" aria-hidden="true" />
                    <span class="cstat-v">{{ statOf(c.id).count }}</span>
                  </span>
                  <span class="cstat-k">images</span>
                </span>
                <span class="cstat">
                  <span class="cstat-h">
                    <PhCalendar class="cstat-ico" aria-hidden="true" />
                    <span class="cstat-v">{{ fmtDay(c.createdAt) }}</span>
                  </span>
                  <span class="cstat-k">created</span>
                </span>
                <span class="cstat">
                  <span class="cstat-h">
                    <PhClockCounterClockwise class="cstat-ico" aria-hidden="true" />
                    <span class="cstat-v">
                      {{ statOf(c.id).lastAt ? fmtDay(statOf(c.id).lastAt) : '—' }}
                    </span>
                  </span>
                  <span class="cstat-k">updated</span>
                </span>
              </span>
            </span>

            <!-- 整卡命中区:透明,压在内容之下,点空白处进详情 -->
            <button
              class="ctile-open"
              :aria-label="`Open ${c.name}`"
              @click="openDetail(c.id)"
            ></button>
          </div>
          <!-- 图右上角一枚 ⋮:复制 / 导出 / 删除都收在它后面。
               三枚圆钮常驻太吵,窄屏上还会占掉整条上沿(小卡只有约 176px 宽) -->
          <div
            class="ctile-menu menu-wrap"
            :class="{ open: openCardMenu === c.id }"
            @pointerenter="onMenuEnter"
            @pointerleave="onMenuLeave"
          >
            <button
              class="ctile-dots"
              :aria-label="`More actions for ${c.name}`"
              aria-haspopup="menu"
              :aria-expanded="openCardMenu === c.id"
              @click.stop="toggleCardMenu(c.id, $event)"
            >
              <PhDotsThreeVertical aria-hidden="true" />
            </button>
            <div v-if="openCardMenu === c.id" class="menu" :class="{ up: cardMenuUp }" role="menu">
              <button class="mitem" role="menuitem" @click.stop="duplicateFromCard(c.id)">
                <PhCopy aria-hidden="true" />Duplicate
              </button>
              <button class="mitem" role="menuitem" @click.stop="exportFromCard(c.id)">
                <PhDownloadSimple aria-hidden="true" />Export
              </button>
              <button class="mitem danger" role="menuitem" @click.stop="removeFromCard(c.id)">
                <PhTrash aria-hidden="true" />Delete
              </button>
            </div>
          </div>
        </article>
      </div>

      <div v-else class="empty">
        <PhMaskHappy class="empty-ico" aria-hidden="true" />
        <h3 class="empty-title">No characters yet</h3>
        <p class="empty-sub">
          Describe one in a line and let the model draft the spec, or fill the fields by hand.
          Then generate a reference sheet to keep the same face everywhere.
        </p>
        <button class="ed-btn primary" @click="startEdit">Create a character</button>
      </div>
    </template>

    <!-- —— 详情 —— -->
    <template v-else-if="detailChar">
      <div class="dt-bar">
        <button class="back" @click="backToList">
          <PhArrowLeft aria-hidden="true" />
          All characters
        </button>
        <!-- 三个动作都收在这一行:复制(改一个变体)、导出(带走)、删除(破坏性)。
             删除仍然压成静默的字、悬停才亮红 —— 三个都是同样的份量会读不出主次 -->
        <div class="dt-acts">
          <button class="dt-act" @click="emit('duplicate', detailChar.id)">
            <PhCopy aria-hidden="true" />
            Duplicate
          </button>
          <button class="dt-act" @click="emit('export', detailChar.id)">
            <PhDownloadSimple aria-hidden="true" />
            Export
          </button>
          <button class="dt-del" @click="emit('remove', detailChar.id)">
            <PhTrash aria-hidden="true" />
            Delete
          </button>
        </div>
      </div>

      <!-- 身份区:头像用正脸,名字和设定一眼看全,进度与参考图作为标签摆在下面 -->
      <header class="hero">
        <span class="hero-avatar">
          <img v-if="avatarSrc" :src="avatarSrc" alt="" />
          <PhMaskHappy v-else aria-hidden="true" />
        </span>
        <div class="hero-body">
          <h2 class="hero-name">{{ detailChar.name }}</h2>
          <p class="hero-sub">{{ summary(detailChar) }}</p>
          <!-- 用量:这个角色到底干了多少活。放在设定摘要下面、标签上面 ——
               它比"几张图"更像这个角色的成绩单 -->
          <p class="hero-meta">
            <span v-for="m in heroMeta" :key="m">{{ m }}</span>
          </p>
          <div class="hero-tags">
            <span class="tag">{{ filledCount }} / {{ sheetCells.length }} views</span>
            <span v-if="refLabel" class="tag tag-on">
              <PhEye weight="fill" aria-hidden="true" />
              Main view · {{ refLabel }}
            </span>
            <span v-else class="tag">No main view yet</span>
          </div>
        </div>
        <!-- 生成中按钮自己也要说出来:它是刚才被点的那个,状态留在原地最容易被看到 -->
        <button
          class="ed-btn primary hero-cta"
          :disabled="!!props.busy || !missingCount"
          @click="emit('generateAll', detailChar.id)"
        >
          <PhSparkle v-if="!props.busy" aria-hidden="true" />
          {{ props.busy ? `Generating ${busyLabel}…` : generateAllLabel }}
        </button>
      </header>

      <section class="panel">
        <div class="panel-head">
          <h3 class="panel-title">Reference sheet</h3>
          <!-- 生成中就把说明换成进度:在标题旁边,是这一屏视线必经的位置。
               放在网格下面用一行小字写"Generating…"几乎等于没写 -->
          <LatticeLoader
            v-if="props.busy"
            class="panel-progress"
            :label="`Generating ${busyLabel} view`"
            :grid="3"
            :cell-size="5"
            :gap="2"
            :font-size="12"
          />
          <span v-else class="panel-note">
            {{
              hasFront
                ? 'Every other view is built from the front view.'
                : 'Start with the front view — the other four unlock once it exists.'
            }}
          </span>
        </div>

        <!-- 空格点一下即生成;有图的点开看大图,重新生成与设为主参考图都在大图里 ——
             原来这两件事挤在每格底下的小字上,既难点也说不清在做什么 -->
        <div class="sheet">
          <div
            v-for="cell in sheetCells"
            :key="cell.kind"
            class="cell"
            :class="{ 'is-ref': refKind === cell.kind, 'is-portrait': cell.framing === 'portrait' }"
          >
            <button
              v-if="cell.view"
              class="cell-img has-img"
              :aria-label="`View ${cell.label}`"
              @click="openViewer(cell.kind)"
            >
              <img :src="coverSrc(cell.view.data)" alt="" />
              <span class="cell-zoom" aria-hidden="true"><PhArrowsOutSimple /></span>
              <span v-if="refKind === cell.kind" class="cell-mark" title="Main view">
                <PhEye weight="fill" aria-hidden="true" />
              </span>
            </button>
            <button
              v-else
              class="cell-img"
              :class="{
                busy: isBusy(cell.kind),
                locked: isLocked(cell.kind),
                start: cell.kind === 'front'
              }"
              :disabled="!!props.busy || isLocked(cell.kind)"
              :aria-label="
                isLocked(cell.kind)
                  ? `${cell.label} view — generate the front view first`
                  : `Generate ${cell.label} view`
              "
              @click="emit('generate', detailChar.id, cell.kind)"
            >
              <PhLockSimple v-if="isLocked(cell.kind)" class="cell-lock" aria-hidden="true" />
              <span v-else class="cell-ph" aria-hidden="true">+</span>
            </button>

            <span class="cell-label">{{ cell.label }}</span>
          </div>
        </div>

      </section>

      <section class="panel">
        <h3 class="panel-title">Spec</h3>
        <dl class="spec">
          <template v-for="r in specRows(detailChar)" :key="r.label">
            <dt class="spec-k">{{ r.label }}</dt>
            <dd class="spec-v" :class="{ dim: !r.value }">{{ r.value || '—' }}</dd>
          </template>
        </dl>
      </section>
    </template>

    <!-- 看大图:同一张图上顺手做决定 —— 重新生成、设为主参考图,以及左右翻 -->
    <div v-if="viewer" class="viewer" @click="closeViewer">
      <div
        ref="viewerBox"
        class="viewer-box"
        role="dialog"
        aria-modal="true"
        :aria-label="`${viewerLabel} view`"
        tabindex="-1"
        @click.stop
      >
        <div class="viewer-top">
          <span class="viewer-label">{{ viewerLabel }}</span>
          <button class="viewer-x" aria-label="Close" @click="closeViewer">
            <PhX aria-hidden="true" />
          </button>
        </div>

        <div class="viewer-stage">
          <button
            v-if="viewerKinds.length > 1"
            class="viewer-nav"
            aria-label="Previous view"
            @click="stepViewer(-1)"
          >
            <PhCaretLeft aria-hidden="true" />
          </button>
          <img class="viewer-img" :src="viewerSrc" alt="" />
          <button
            v-if="viewerKinds.length > 1"
            class="viewer-nav"
            aria-label="Next view"
            @click="stepViewer(1)"
          >
            <PhCaretRight aria-hidden="true" />
          </button>
        </div>

        <div class="viewer-acts">
          <button class="ed-btn" :disabled="!!props.busy" @click="regenerateViewer">
            <PhArrowsClockwise aria-hidden="true" />
            Regenerate
          </button>
          <button
            class="ed-btn"
            :class="{ 'is-on': refKind === viewer }"
            :disabled="refKind === viewer"
            @click="applyViewerRef"
          >
            <PhEye weight="fill" aria-hidden="true" />
            {{ refKind === viewer ? 'This is the main view' : 'Use as main view' }}
          </button>
        </div>
      </div>
    </div>

    <input id="cp-file" type="file" accept="image/*" hidden @change="onPickRef" />
    <!-- 导入用的 file input:页头那个按钮点它。这里只认 .zip ——
         角色包一定是 zip(设定 + 图),`.json` 那种没有脸的包不该被导进来 -->
    <input
      ref="importInput"
      type="file"
      accept=".zip,application/zip"
      hidden
      @change="onImportFile"
    />
  </div>
</template>

<style scoped>
/* 页容器与左右留白都由 .shell 给(App.vue),这一页不再自己套一层
   —— 原来那层 max-width + padding 让内容比别的页多缩进一圈,左边缘对不齐 */
.chars {
  min-width: 0;
}
/* 以下骨架与历史 / 提示词库 / 设置三页保持一致 */
.chars-head {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  justify-content: space-between;
  gap: var(--sp-4);
  padding-top: var(--sp-2);
}
.chars-title {
  font-family: var(--font-sans);
  font-size: var(--fs-3xl);
  font-weight: 700;
  letter-spacing: var(--ls-tight);
}
.chars-sub {
  margin-top: 6px;
  max-width: 60ch;
  font-size: var(--fs-sm);
  line-height: 1.6;
  color: var(--text-2);
}
/* 页头右侧一组动作。页头只该有一个实心按钮,所以导入用描边款 ——
   两个都涂黑等于没有主次 */
.chars-acts {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: none;
}
.chars-import {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex: none;
  height: 34px;
  padding: 0 14px;
  border: 1px solid var(--line-strong);
  border-radius: 999px;
  color: var(--text-2);
  font-size: var(--fs-sm);
  font-weight: 500;
  cursor: pointer;
  transition: color var(--dur) var(--ease), border-color var(--dur) var(--ease),
    background var(--dur) var(--ease);
}
.chars-import:hover {
  color: var(--text);
  background: var(--bg-elev);
}
.chars-import:focus-visible {
  outline: none;
  border-color: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-soft);
}
.chars-import svg {
  width: 15px;
  height: 15px;
}
/* 与设置页「Add config」、提示词库「New prompt」同款:黑药丸,标题行主操作 */
.chars-new {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex: none;
  height: 34px;
  padding: 0 14px;
  border-radius: 999px;
  background: var(--cta);
  color: var(--cta-text);
  font-size: var(--fs-sm);
  font-weight: 500;
  cursor: pointer;
  transition: background var(--dur) var(--ease);
}
.chars-new:hover {
  background: var(--cta-hover);
}
.chars-new svg {
  width: 15px;
  height: 15px;
}

/* —— 新建向导:漂浮卡 ——
   创建是一条独立流程,不该插进列表里把页面顶开 —— 它是盖在这一页之上的一层,
   关掉就回到原样。与全屏看大图(viewer)同一套模态语言:暗幕 + 模糊 + 居中的卡。
   一张卡分三层:卡头步骤条 / 卡身当前步 / 卡脚进退。
   overflow:hidden 让卡头卡脚的底色被圆角切齐,不然会顶出四个直角 */

/* 暗幕。与卡片是平级的两个 fixed 元素,而不是"卡包在暗幕里":
   卡片要 overflow:hidden 来切圆角,一旦套进暗幕里,那层 overflow
   会顺手把铺满视口的背景裁掉 */
.wz-veil {
  position: fixed;
  inset: 0;
  z-index: 70;
  background: color-mix(in srgb, var(--stage-bg) 86%, transparent);
  backdrop-filter: blur(6px);
}
.wizard {
  /* 用 top/left 50% + translate 居中,而不是外面再套一个 flex 容器:
     卡片高度由内容决定,auto 高度下 margin:auto 居中并不成立,
     而套容器就得把整块模板再缩进一级 —— 为居中多包一层不划算 */
  position: fixed;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  z-index: 71;
  display: flex;
  flex-direction: column;
  width: min(720px, calc(100% - 2 * var(--sp-4)));
  max-height: calc(100vh - 2 * var(--sp-4));
  border: 1px solid var(--line);
  border-radius: var(--r);
  background: var(--surface);
  box-shadow: var(--sh-md);
  /* 卡片自己不滚 —— 只有中间的信息区滚(见 .wz-pane)。
     卡头卡脚于是天然钉在原地:滚动的是信息区,它们根本不在那个滚动容器里 */
  overflow: hidden;
}
/* 步骤条:横向三步,中间用短线连起来。
   线点亮 = 前一步做完了 —— 进度不必靠读文字,余光扫一眼就知道走到哪 */
.wz-steps {
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 11px var(--sp-4);
  border-bottom: 1px solid var(--line);
  background: var(--bg);
}
.wz-line {
  flex: 1;
  height: 1px;
  background: var(--line);
  transition: background var(--dur) var(--ease);
}
.wz-line.is-done {
  background: color-mix(in oklch, var(--accent) 55%, var(--line));
}
.wz-step {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 2px 0;
  color: var(--text-3);
  cursor: pointer;
  transition: color var(--dur) var(--ease);
}
/* 没到的步骤点不动。光标也不给手指,免得看着像能点 */
.wz-step:disabled {
  cursor: default;
}
.wz-step.is-locked {
  opacity: 0.5;
}
.wz-step.is-active {
  color: var(--text);
}
.wz-step:not(.is-active):not(:disabled):hover {
  color: var(--text-2);
}
/* 序号圆点:当前步实心 accent,做完的转成勾,没到的只有一圈描边 */
.wz-dot {
  flex: none;
  width: 22px;
  height: 22px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--line-strong);
  border-radius: 50%;
  font-size: var(--fs-micro);
  font-variant-numeric: tabular-nums;
}
.wz-dot svg {
  width: 12px;
  height: 12px;
}
.wz-step.is-active .wz-dot {
  border-color: var(--accent);
  background: var(--accent);
  color: var(--accent-contrast);
}
.wz-step.is-done .wz-dot {
  border-color: color-mix(in oklch, var(--accent) 35%, var(--line));
  background: var(--accent-soft);
  color: var(--accent-strong);
}
.wz-name {
  font-size: var(--fs-sm);
  font-weight: 500;
  white-space: nowrap;
}
.wz-step.is-active .wz-name {
  font-weight: 600;
}

/* 卡身:当前这一步的内容,间距 10px 一档。
   它就是那个滚动区 —— 卡片不滚,滚的是这一层(见 .wizard)。
   十一栏加两组标题装不下时只有中间这段滑动,卡头卡脚不动,
   这才是"信息区域滚动"该有的样子。
   min-height:0 是关键:少了它 flex 子项不肯缩,滚动条根本出不来 */
.wz-pane {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  /* 滚到底不再把滚动传给后面的页面 —— 否则滚过头会连背景一起滚走 */
  overscroll-behavior: contain;
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: var(--sp-4);
}
/* 每步开头的一段说明:标题 + 一句人话。
   向导里这行不是装饰 —— 它替用户回答"这一步在干嘛、为什么有顺序" */
.wz-lead {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.wz-lead-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 8px 12px;
}
.wz-h {
  font-size: var(--fs-lg);
  color: var(--text);
}
.wz-p {
  max-width: 64ch;
  font-size: var(--fs-sm);
  line-height: 1.6;
  color: var(--text-2);
}

/* 主视图那一步:左图右事。
   为什么并排 —— 原来是"一个 300px 的方块浮在 720px 的卡中间",左右各空 390px,
   而这一屏最该说清的两件事(拿哪张图当参考、接下来点哪里)一个字都没说。
   并排之后图有分量,说明也有地方可放 */
.wz-hero {
  display: flex;
  align-items: center;
  gap: var(--sp-5);
}
.wz-hero-shot {
  flex: none;
  width: min(288px, 44%);
}
.wz-hero-body {
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
  flex: 1;
  min-width: 0;
}
.wz-hero-note {
  max-width: 46ch;
  font-size: var(--fs-sm);
  line-height: 1.6;
  color: var(--text-2);
}
/* 事实行:标签 + 值,与详情页规格表同一套语言(dt/dd 两列)——
   这里说的正是"这次会用到的条件",用同一套写法读者不必重新认 */
.wz-facts {
  display: grid;
  grid-template-columns: auto 1fr;
  align-items: baseline;
  gap: 4px var(--sp-3);
}
.wz-facts-k {
  font-size: var(--fs-xs);
  color: var(--text-3);
}
.wz-facts-v {
  font-size: var(--fs-sm);
  color: var(--text);
}
/* 其余四张:一排四格,与详情页的设定图同一套格子语言 */
.wz-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: var(--sp-3);
}

/* 卡脚:主操作在左,回退与退出紧跟其后(与表单里一贯的主次排法一致)。
   它不在滚动区里,所以滚动的永远是卡身,它自己不动 */
.wz-foot {
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  padding: 10px var(--sp-4);
  border-top: 1px solid var(--line);
  background: var(--bg);
}

/* —— 第 1 步的表单 ——
   这一页曾经是"九行控件同一个间距、同一种输入框、同一个视觉重量":
   角色名和 "Marks" 长得一模一样,看不出从哪儿下手,也看不出哪些是一段。

   现在分三档,每一档用不同的手段区分(面积 / 字号 / 颜色),不靠装饰:
     1 入口   起稿块   —— 淡墨底 + 描边,整张卡唯一一块"区域",重点在这
     2 分区   组标题   —— 15/600 满墨 + 下压一条横线
     3 字段   标签/提示 —— 12/500 灰、12/400 更灰,输入框一律 13px
   名字不在三档里:它是一栏普通字段(见模板里的注释),只是多一枚 Required 标记。
   间距同时承担分组:组与组 24px、组内 8–10px */
.wz-form {
  /* 组与组 24px(--sp-5)、组内 8–10px。三倍的落差就是分层的依据,不靠边框;
     滚动已经交给信息区了,这里不必再为了省高度把层次压平 */
  gap: var(--sp-5);
}

/* 起稿块是这一页的重点:它是最常用的入口 —— 一句话交给模型,
   下面十一栏由它填出来。所以它拿的是整张卡上唯一一块"区域"待遇:
   淡墨底 + 同色描边(别处的框都是白底细线),里面的输入框则是白的,
   于是"区域 - 输入槽 - 主按钮"三层一眼分得开。
   标题也跟着组标题同档(15/600 满墨),而不是又一个灰标签 */
.wz-draft {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: var(--sp-3);
  border: 1px solid color-mix(in oklch, var(--accent) 22%, var(--line));
  border-radius: var(--r-sm);
  background: var(--accent-soft);
}
.wz-draft-label {
  font-size: var(--fs-md);
  font-weight: 600;
  color: var(--text);
}
.wz-draft-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.wz-draft-row .ed-input {
  flex: 1;
}
/* 提示与报错都留在这块里:它们是"这一句交给模型"的结果。
   原本挂在表单最末尾,离触发它的按钮隔了四行。
   提示用 text-2 而不是 text-3:这块底是 bg-elev,text-3 在它上面只有 4.40:1,
   过不了正文的 4.5 —— text-3 的 4.6:1 是按 bg / surface 标的 */
.wz-draft-hint {
  /* flex 是为了让图例里那枚小点与文字对齐;纯文案时就是一个普通的文本行 */
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: var(--fs-xs);
  line-height: 1.5;
  color: var(--text-2);
}
.wz-err {
  font-size: var(--fs-sm);
  line-height: 1.5;
  color: var(--danger);
}

/* 组:标题 + 一句说明 + 内容 */
.wz-group {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
/* 组标题行下面压一条横线:它是"分层"最直接的凭据 ——
   光靠字号差,十栏的灰标签会把组标题淹掉 */
.wz-group-head {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 2px 10px;
  padding-bottom: 8px;
  border-bottom: 1px solid var(--line);
}
.wz-group-title {
  display: inline-flex;
  /* 基线对齐:标题里有 "Optional" 这种小一号的字,居中会看起来是斜的 */
  align-items: baseline;
  gap: 8px;
  /* 15px/600 满墨 —— 与字段标签(12/500 灰)差两档,
     原来 13/600 和标签几乎一样重,所以组与组之间看不出边界 */
  font-size: var(--fs-md);
  font-weight: 600;
  color: var(--text);
}
/* 说明用 text-3 而不是 text-4:后者在浅色面上过不了 4.5:1 */
.wz-group-hint {
  font-size: var(--fs-xs);
  color: var(--text-3);
}
/* 标签行里的小标记:Optional / Required 用同一套,位置也一样 ——
   有标记的那几栏一眼看得出来,没标记的就是普通栏。
   不做胶囊:一块 --surface-hover 的底会把 11px 的灰字压到 4.17:1,
   同一个意思,一行更淡的字就够了,也少一件装饰 */
.wz-mark {
  font-size: var(--fs-micro);
  font-weight: 400;
  color: var(--text-3);
}
/* "必填"要能压住视线:它是一条约束,不是一句补充。
   全表只有这一栏必填,所以不必再用星号加图例那种写法 */
.wz-mark.is-required {
  font-weight: 500;
  color: var(--text-2);
}

/* 字段区:两列,每格是"标签在上、输入在下"。
   为什么两列 —— 十栏一行一个往下堆时整张表约 890px,而卡身可用高度是
   「视口 − 卡头 48 − 卡脚 60 − 上下留白 32」,900px 的屏只有约 760px:
   校对十栏得上下翻。两列之后 11 行变 6 行,一屏能看全。
   为什么标签在上而不是在左 —— 在左的话每列只剩 338 − 96 − 12 = 230px,
   13px 下约 37 字符,而字段值上限是 12 个词(约 70 字符) */
.wz-fields {
  display: grid;
  grid-template-columns: 1fr 1fr;
  align-items: start;
  gap: var(--sp-3) var(--sp-4);
}
.wz-field {
  display: flex;
  flex-direction: column;
  gap: 5px;
  min-width: 0;
}
/* 备注是自由文本,占满两列 */
.wz-field.is-wide {
  grid-column: 1 / -1;
}
.wz-label {
  display: flex;
  align-items: center;
  gap: 6px;
  /* 12/500 灰 —— 字段标签是这一页的第四档,比组标题低两档。
     12px 与详情页规格表的 .spec-k 同一档,不是新开的尺寸 */
  font-size: var(--fs-xs);
  font-weight: 500;
  color: var(--text-2);
}
/* 起稿填过、还没动过的标记。一枚小点就够了 ——
   用户一改那一栏就消失(见 markEdited),组说明里同时换成对应图例 */
.wz-ai {
  flex: none;
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--accent);
}
/* 给读屏的"这栏是模型填的"。视觉上靠那枚点,但那枚点不值得被念出来 */
.wz-sr {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  padding: 0;
  border: 0;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
}
/* 只读回看与填表共用同一套字段网格:填进去的和读回来的长得一样 */
.wz-field.is-readonly .wz-label {
  font-weight: 400;
  color: var(--text-3);
}
.wz-value {
  font-size: var(--fs-sm);
  line-height: 1.6;
  color: var(--text);
  overflow-wrap: anywhere;
}
.wz-value.dim {
  color: var(--text-3);
}

/* 参考图:空态与有图态同一个外框、同一个高度 —— 挑完图不该整块往上跳一下 */
.wz-ref {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  min-height: 68px;
  padding: 9px var(--sp-3);
  border: 1px solid var(--line);
  border-radius: var(--r-sm);
  background: var(--bg);
}
.wz-ref-pick {
  border-style: dashed;
  border-color: var(--line-strong);
  cursor: pointer;
  transition: border-color var(--dur) var(--ease), background var(--dur) var(--ease);
}
.wz-ref-pick:hover {
  border-color: var(--accent);
  background: var(--bg-elev);
}
.wz-ref-pick > svg {
  flex: none;
  width: 20px;
  height: 20px;
  color: var(--text-3);
  transition: color var(--dur) var(--ease);
}
.wz-ref-pick:hover > svg {
  color: var(--text);
}
.wz-ref-body {
  display: flex;
  flex-direction: column;
  gap: 1px;
  flex: 1;
  min-width: 0;
}
.wz-ref-main {
  font-size: var(--fs-sm);
  font-weight: 500;
  color: var(--text);
}
.wz-ref-hint {
  font-size: var(--fs-xs);
  /* 同 text-3 的账:这块底是 bg,悬停时变 bg-elev,text-3 在后者上只有 4.40:1 */
  color: var(--text-2);
}
.wz-ref-thumb {
  flex: none;
  /* 48 + 上下内边距 18 + 边框 2 = 68,与空态的 min-height 分毫不差 ——
     挑完图那一行不会悄悄长高两像素 */
  width: 48px;
  height: 48px;
  object-fit: cover;
  border-radius: var(--r-sm);
  border: 1px solid var(--line);
}

/* 存下之后的回看:名字一行,下面是只读设定 */
.wz-sum {
  display: flex;
  align-items: baseline;
  gap: 10px;
}
.wz-sum-name {
  font-size: var(--fs-xl);
  font-weight: 600;
  letter-spacing: var(--ls-tight);
  color: var(--text);
}
.wz-sum-note {
  font-size: var(--fs-xs);
  color: var(--text-3);
}
.wz-sum-thumb {
  width: 64px;
  height: 64px;
  object-fit: cover;
  border-radius: var(--r-sm);
  border: 1px solid var(--line);
}

/* —— 表单控件:所有文本输入共用 —— */
.ed-input {
  width: 100%;
  min-width: 0;
  padding: 10px 12px;
  border: 1px solid var(--line);
  border-radius: var(--r-sm);
  background: var(--bg);
  color: var(--text);
  font-size: var(--fs-sm);
  transition: border-color var(--dur) var(--ease), box-shadow var(--dur) var(--ease);
}
/* 占位符显式定色:浏览器默认那一档灰在浅色面上过不了 4.5:1 */
.ed-input::placeholder {
  color: var(--text-3);
}
/* 聚焦给一圈晕(accent-soft 这个 token 本来就是留给聚焦的);
   只换描边色在键盘操作时太不起眼 */
.ed-input:focus {
  outline: none;
  border-color: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-soft);
}
/* 规格字段是 textarea,随内容长高(见 vGrow)。
   刻意不封顶:封顶就得配 overflow,字段里会多出一条自己的滚动条 ——
   一页里不该有两条。长内容让这一格变高,整张卡跟着长,滚动交给卡片自己 */
.wz-field textarea.ed-input {
  resize: none;
  line-height: 1.5;
  overflow: hidden;
}
.ed-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  flex: none;
  padding: 9px 14px;
  border: 1px solid var(--line);
  border-radius: 999px;
  background: none;
  color: var(--text-2);
  font-size: var(--fs-sm);
  font-weight: 500;
  white-space: nowrap;
  cursor: pointer;
  transition: color var(--dur) var(--ease), border-color var(--dur) var(--ease),
    background var(--dur) var(--ease);
}
.ed-btn:hover:not(:disabled) {
  color: var(--text);
  border-color: var(--line-strong);
  background: var(--bg-elev);
}
.ed-btn:disabled {
  opacity: 0.5;
  cursor: default;
}
/* 键盘走到哪个按钮上要看得见:这条以前是缺的,只有 hover 有反馈 */
.ed-btn:focus-visible {
  outline: none;
  border-color: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-soft);
}
.ed-btn svg {
  width: 15px;
  height: 15px;
}
.ed-btn.primary {
  border-color: var(--cta);
  background: var(--cta);
  color: var(--cta-text);
}
.ed-btn.primary:hover:not(:disabled) {
  border-color: var(--cta-hover);
  background: var(--cta-hover);
}
/* 已选中的状态(主参考图):墨色描边 + 实心底,和别处"当前项"同一套 */
.ed-btn.is-on {
  border-color: var(--cta);
  color: var(--text);
  background: var(--bg-elev);
}

/* —— 列表:角色海报卡 —— */
/* 顶图全出血铺满整张卡,底部渐变暗幕托起白字,像电影海报的下三分之一。
   无边框,靠阴影浮起;圆角加大到 24px 更软,与白纸档案卡区分开 */
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
  gap: var(--sp-5);
  margin-top: var(--sp-5);
}
.ctile {
  position: relative;
  min-width: 0;
}
/* 海报卡:固定 3:4 比例,无边框,圆角 24px,overflow 让图与暗幕切出弧形。
   它现在是容器而不是按钮 —— 卡里有两个动作,按钮不能嵌套按钮 */
.ctile-main {
  position: relative;
  display: block;
  width: 100%;
  aspect-ratio: 3 / 4;
  padding: 0;
  border-radius: var(--r-lg);
  overflow: hidden;
  background: var(--image-bg);
  /* 卡片本身要有一点"浮在纸面上"的分量:
     一枚贴边的接触影让四边站得住 + 系统那道柔和弥散影。
     接触影用纯黑(与 --sh-* 同一套语言),深浅主题都成立 */
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.05), var(--sh-sm);
  text-align: left;
  cursor: pointer;
  transition: box-shadow var(--dur) var(--ease);
}
.ctile-main:hover {
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.05), var(--sh-md);
}
/* 顶图:绝对铺满,object-fit cover;hover 轻微放大制造呼吸 */
.ctile-img {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-3);
}
.ctile-img img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
  transition: transform 700ms var(--ease);
}
.ctile-main:hover .ctile-img img {
  transform: scale(1.045);
}
.ctile-ph svg {
  width: 34px;
  height: 34px;
}
/* 暗幕:比原来淡,让照片的形状还能透出来 —— 参考图里"双手与相机被揉成
   模糊的形"靠的就是这一点:玻璃不是一块死黑的板,是能看见底下的。
   零点的位置与下面毛玻璃的零点对齐(卡高 42%),两层一起化开 */
.ctile-veil {
  position: absolute;
  inset: 0;
  z-index: 1;
  background: linear-gradient(
    to top,
    rgba(24, 24, 22, 0.6) 0%,
    rgba(24, 24, 22, 0.52) 25%,
    rgba(24, 24, 22, 0.34) 45%,
    rgba(24, 24, 22, 0.14) 52%,
    transparent 58%
  );
  pointer-events: none;
}
/* 毛玻璃层:矩形铺满下半张卡,mask 提供"从清晰到模糊"的浓度渐变。
   关键是渐变的形状:每一条横截面浓度都相同,所以这块玻璃是规整的矩形,
   不会出现异型的斜边;而过渡拉得够长,底下的照片是"慢慢化开"的,
   不是被一条线切断 —— 与参考图里那种有机的羽化一致。 */
.ctile-veil::before {
  content: '';
  position: absolute;
  inset: 42% 0 0 0;
  /* brightness 略提一点:玻璃微微发亮才像"磨"过的,
     纯模糊会显得只是脏;幅度很小,不影响白字的对比 */
  backdrop-filter: blur(20px) saturate(115%) brightness(1.04);
  -webkit-backdrop-filter: blur(20px) saturate(115%) brightness(1.04);
  -webkit-mask-image: linear-gradient(
    to top,
    #000 0%,
    #000 45%,
    rgba(0, 0, 0, 0.5) 72%,
    transparent 100%
  );
  mask-image: linear-gradient(
    to top,
    #000 0%,
    #000 45%,
    rgba(0, 0, 0, 0.5) 72%,
    transparent 100%
  );
}

/* 整卡命中区:透明按钮铺满卡片,压在文本之下 ——
   "点空白处进详情"的直觉还在,而 CTA 可以正常浮在它上面 */
.ctile-open {
  position: absolute;
  inset: 0;
  z-index: 2;
  cursor: pointer;
}
/* 焦点环画在里面:这个按钮被 .ctile-main 的 overflow 裁着,默认那圈外描边看不见。
   它盖在照片上,所以用纸色而不是 --accent */
.ctile-open:focus-visible {
  outline: 2px solid #fbfaf7;
  outline-offset: -5px;
  border-radius: var(--r-lg);
}

/* 文本叠层:贴底,白字,左下 16px。
   只留四样:名字(+CTA)、身份、特征、用量 ——
   描述在身份行下面只是重复一遍同一件事,分隔线是纯装饰,
   两者都删掉,省下的高度还给段间距,信息区才有呼吸感。
   补一道微弱投影,别让大名字压在亮图上糊掉。
   pointer-events:none 让点击穿到下面的整卡命中区,只有 CTA 自己收回来 */
.ctile-content {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 3;
  display: flex;
  flex-direction: column;
  gap: 9px;
  padding: 16px 16px 15px;
  pointer-events: none;
  text-shadow: 0 1px 12px rgba(0, 0, 0, 0.35);
}
/* 名字 + 快捷开画同一行 */
.ctile-head {
  display: flex;
  align-items: center;
  gap: 10px;
}
.ctile-name {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--fs-xl);
  line-height: 1.2;
  font-weight: 700;
  letter-spacing: var(--ls-tight);
  color: #fff;
}
.ctile-role {
  margin-top: -3px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  line-height: 1.3;
  font-size: var(--fs-sm);
  color: rgba(255, 255, 255, 0.78);
}
/* 特征胶囊:玻璃感白字,一行 */
.ctile-chips {
  display: flex;
  gap: 5px;
  overflow: hidden;
}
.chip {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  padding: 3px 10px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.16);
  line-height: 1.2;
  font-size: var(--fs-xs);
  color: #fff;
}

/* 快捷开画:浅色药丸压在暗幕上,是卡上对比度最高的元素(与设计稿的 CTA 同位阶)。
   固定浅底深字,不走 token —— 它盖在照片上,亮/暗主题下都该是"浅底深字"。
   与名字同行,所以收成紧凑的一枚(flex:none 不参与拉伸,名字那边让位)。
   pointer-events 单独收回,否则会被 .ctile-content 的透传连累点不动 */
.ctile-cta {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 6px 11px;
  border-radius: 999px;
  background: rgba(252, 251, 249, 0.94);
  color: #1a1a18;
  font-size: var(--fs-xs);
  font-weight: 600;
  white-space: nowrap;
  text-shadow: none;
  pointer-events: auto;
  cursor: pointer;
  transition: background var(--dur) var(--ease), transform var(--dur) var(--ease);
}
.ctile-cta:hover {
  background: #fff;
  transform: translateY(-1px);
}
.ctile-cta:active {
  transform: translateY(0);
}
.ctile-cta-ico {
  width: 13px;
  height: 13px;
  flex: none;
  transition: transform var(--dur) var(--ease);
}
.ctile-cta:hover .ctile-cta-ico {
  transform: translateX(2px);
}

/* 用量三格 + 竖向分隔,白字压在暗幕上 */
.ctile-stats {
  display: flex;
  margin-top: 4px;
}
.cstat {
  flex: 1 1 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
  padding: 0 10px;
  border-left: 1px solid rgba(255, 255, 255, 0.14);
}
.cstat:first-child {
  border-left: none;
  padding-left: 0;
}
.cstat:last-child {
  padding-right: 0;
}
.cstat-h {
  display: flex;
  align-items: center;
  gap: 4px;
}
.cstat-ico {
  width: 12px;
  height: 12px;
  flex: none;
  color: rgba(255, 255, 255, 0.7);
}
.cstat-v {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  line-height: 1.3;
  font-size: var(--fs-xs);
  font-weight: 600;
  color: #fff;
  font-variant-numeric: tabular-nums;
}
.cstat-k {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  line-height: 1.3;
  font-size: var(--fs-micro);
  color: rgba(255, 255, 255, 0.6);
}

/* 图上角的管理入口:一枚 ⋮ 打开复制 / 导出 / 删除,压在照片上,
   刻意不走 token —— 仍按暖白纸调子避开纯黑纯白;加一道模糊让它"浮"住 */
.ctile-menu {
  position: absolute;
  top: 16px;
  right: 16px;
  z-index: 4;
}
.ctile-dots {
  width: 36px;
  height: 36px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 999px;
  background: rgba(24, 24, 22, 0.34);
  color: #fbfaf7;
  backdrop-filter: blur(8px);
  cursor: pointer;
  transition: opacity var(--dur) var(--ease), background var(--dur) var(--ease);
}
.ctile-dots svg {
  width: 16px;
  height: 16px;
}
/* 能悬停的设备上才收起这枚钮:每张图右上角常驻一枚深色圆点太吵。
   触摸设备没有悬停,收起来就等于点不到 —— 所以用 hover 能力判断,而不是屏宽。
   菜单开着时(.open)必须留下:⋮ 点开之后鼠标一移开就淡掉,
   连同菜单一起看不见了(Safari 点按钮还不给焦点,focus-within 兜不住) */
@media (hover: hover) {
  .ctile-menu {
    opacity: 0;
  }
  .ctile:hover .ctile-menu,
  .ctile-menu:focus-within,
  .ctile-menu.open {
    opacity: 1;
  }
}
.ctile-dots:hover {
  background: rgba(24, 24, 22, 0.56);
}

/* ===== 卡上的下拉菜单(与 PromptLibrary 同一套外观) =====
   .ctile-menu 自己就是绝对定位的,不用再给 .menu-wrap 一条相对定位 ——
   两条同权重、谁在后面谁生效,那样会把入口从右上角拽回文档流。
   模板里那个 menu-wrap 只是给"点别处收起"用的识别标记(见 onDocPointerDown) */
.menu {
  position: absolute;
  top: calc(100% + 6px);
  right: 0;
  z-index: 6;
  min-width: 152px;
  padding: 4px;
  display: flex;
  flex-direction: column;
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: var(--r-sm);
  box-shadow: var(--sh-md);
}
/* 下方放不下时朝上开:末行的卡片用它,不然菜单会伸到视口外 */
.menu.up {
  top: auto;
  bottom: calc(100% + 6px);
}
.mitem {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  text-align: left;
  line-height: normal;
  font-size: var(--fs-sm);
  color: var(--text-2);
  border-radius: 6px;
  cursor: pointer;
  transition: background var(--dur) var(--ease), color var(--dur) var(--ease);
}
.mitem svg {
  width: 14px;
  height: 14px;
}
.mitem:hover {
  background: var(--bg-elev);
  color: var(--text);
}
.mitem.danger:hover {
  color: var(--danger, #b4232a);
}

/* —— 详情 —— */
/* 详情页没有大标题,但顶部要与列表页及其他页的标题行对齐 */
.dt-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-3);
  padding-top: var(--sp-2);
  margin-bottom: var(--sp-4);
}
.back {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: var(--fs-sm);
  color: var(--text-2);
  cursor: pointer;
  transition: color var(--dur) var(--ease);
}
.back:hover {
  color: var(--text);
}
.back svg {
  width: 15px;
  height: 15px;
}
/* 顶栏右侧一组动作:复制 / 导出是常规动作,删除是破坏性的 ——
   前者悬停提亮到正文色,后者悬停才亮红。三个同重会读不出主次 */
.dt-acts {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-wrap: wrap;
}
.dt-act,
.dt-del {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  border-radius: 999px;
  font-size: var(--fs-sm);
  color: var(--text-3);
  cursor: pointer;
  transition: color var(--dur) var(--ease), background var(--dur) var(--ease);
}
.dt-act:hover {
  color: var(--text);
  background: var(--bg-elev);
}
.dt-del:hover {
  color: var(--danger);
  background: color-mix(in oklch, var(--danger) 8%, transparent);
}
.dt-act svg,
.dt-del svg {
  width: 15px;
  height: 15px;
}

/* 身份区:一张卡把"这是谁、进行到哪、能做什么"说全 */
.hero {
  display: flex;
  align-items: center;
  gap: var(--sp-4);
  padding: var(--sp-5);
  border: 1px solid var(--line);
  border-radius: var(--r);
  background: var(--surface);
}
.hero-avatar {
  flex: none;
  width: 88px;
  height: 88px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  border-radius: 50%;
  border: 1px solid var(--line);
  background: var(--bg-elev);
  color: var(--text-3);
}
.hero-avatar img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.hero-avatar svg {
  width: 32px;
  height: 32px;
}
.hero-body {
  flex: 1;
  min-width: 0;
}
.hero-name {
  font-size: var(--fs-2xl);
  line-height: 1.25;
  color: var(--text);
}
.hero-sub {
  margin-top: 5px;
  font-size: var(--fs-sm);
  line-height: 1.6;
  color: var(--text-2);
}
/* 用量那一行:数字是主角,所以点用最淡的一档隔开,别和数字抢注意力 */
.hero-meta {
  margin-top: 8px;
  font-size: var(--fs-xs);
  color: var(--text-2);
  font-variant-numeric: tabular-nums;
}
.hero-meta span + span::before {
  content: '·';
  margin: 0 7px;
  color: var(--text-4);
}
.hero-tags {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  margin-top: 10px;
}
/* 底用 bg-elev 而不是 bg:卡片本身就是 surface,浅色主题下 bg 与它几乎同色,
   胶囊只剩一圈描边、没有实体感 */
.tag {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 9px;
  border: 1px solid var(--line);
  border-radius: 999px;
  background: var(--bg-elev);
  font-size: var(--fs-micro);
  color: var(--text-2);
}
.tag svg {
  width: 11px;
  height: 11px;
}
/* 主参考图是本页唯一需要"一眼看出是哪张"的状态,用 accent 标出来 */
.tag-on {
  border-color: color-mix(in oklch, var(--accent) 30%, var(--line));
  background: var(--accent-soft);
  color: var(--accent-strong);
  font-weight: 600;
}
.hero-cta {
  flex: none;
  padding: 10px 16px;
}

.panel {
  margin-top: var(--sp-4);
  padding: var(--sp-4);
  border: 1px solid var(--line);
  border-radius: var(--r);
  background: var(--surface);
}
.panel-head {
  display: flex;
  align-items: baseline;
  gap: 10px;
  margin-bottom: var(--sp-3);
}
.panel-title {
  font-size: var(--fs-lg);
  color: var(--text);
}
.panel-note {
  flex: 1;
  min-width: 0;
  font-size: var(--fs-xs);
  line-height: 1.5;
  color: var(--text-3);
}
/* 生成进度占的是"说明"那一格。loader 是一块方格,按基线对齐会歪,单独居中 */
.panel-progress {
  flex: 1;
  min-width: 0;
  align-self: center;
  color: var(--text-2);
}
/* 带 panel-head 的那块由 panel-head 自己留白,只有 Spec 这种裸标题才要补 */
.panel > .panel-title {
  margin-bottom: var(--sp-3);
}

/* —— 设定图 —— */
.sheet {
  display: grid;
  grid-template-columns: repeat(5, 1fr);
  gap: var(--sp-3);
}
.cell {
  display: flex;
  flex-direction: column;
  gap: 7px;
  min-width: 0;
  /* 竖幅那一格比别人高,同一行里它把整行撑起来。
     按底部对齐后,五张图的下沿与五个标签就落在同一条线上 ——
     这正是参考图的排法:图高低不同,但都站在同一道基线上 */
  justify-content: flex-end;
}
/* 空格子是虚线框(点一下即生成),有图的转实线(点一下看大图) */
.cell-img {
  position: relative;
  aspect-ratio: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  border: 1px solid var(--line-strong);
  border-style: dashed;
  border-radius: var(--r-sm);
  background: var(--bg);
  color: var(--text-3);
  cursor: pointer;
  transition: border-color var(--dur) var(--ease), opacity var(--dur) var(--ease),
    color var(--dur) var(--ease), transform var(--dur) var(--ease);
}
.cell-img.has-img {
  border-style: solid;
}
/* 竖幅的输出只有 Full body 一张(见 api.ts 的 framing)。
   它按 2:3 生成(App 的 PORTRAIT_RATIO),塞进 1:1 的格子会被 cover 上下各切掉约 1/6 ——
   头和脚都没了。所以这一格改用同一个 2:3 装它:比例对齐,cover 一点不裁;
   方块图仍用 1:1,它们的输出本来就是方的 */
.cell.is-portrait .cell-img {
  aspect-ratio: 2 / 3;
}
/* 墨色描边只给空格子:那是"点一下就生成"的召唤。
   有图的格子不给描边反馈 —— 它的反馈是上面那层遮幕,
   而给每张图都点墨色会让主视图那枚标记失去分量(accent 是"当前项"的颜色) */
.cell-img:not(.has-img):hover:not(:disabled) {
  border-color: var(--accent);
  color: var(--text);
}
/* 一次只跑一张:生成期间其余空位是停用的,必须看得出来,
   否则和平时长得一样、点了却没反应 */
.cell-img:disabled:not(.busy) {
  cursor: default;
  opacity: 0.4;
}
/* 正在出的那一张:实线 accent 描边 + 呼吸,和"还没生成"区分开 */
.cell-img.busy {
  border-style: solid;
  border-color: var(--accent);
  /* 它也是停用的,别给指针光标 —— 点了没反应才是对的,但光标得说实话 */
  cursor: default;
  animation: charPulse 1.2s var(--ease) infinite;
}
@keyframes charPulse {
  50% {
    opacity: 0.45;
  }
}
.cell-img img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.cell-ph {
  font-size: var(--fs-xl);
  line-height: 1;
}
/* 锁住的那几格:先有正脸才轮得到它们。
   图标比 "+" 小一档 —— 它说的是"还不能点",不该和可点的格子抢注意力 */
.cell-lock {
  width: 15px;
  height: 15px;
}
/* 整条流水线的起点:正脸格永远亮着 accent 虚线,
   哪怕同一屏里还有四格在等它 —— 它是这一屏唯一该被点的东西 */
.cell-img.start:not(.has-img) {
  border-color: color-mix(in oklch, var(--accent) 45%, var(--line-strong));
}
/* 悬停铺一层淡幕 + 放大图标:说清"这张点得开",而不是点下去才知道。
   遮罩必须与主题无关(它盖在照片上,不盖在界面上),所以这里是全站少数
   刻意不走 token 的地方 —— 但仍按暖白纸的调子避开纯黑纯白 */
.cell-zoom {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(24, 24, 22, 0.34);
  color: #fbfaf7;
  opacity: 0;
  transition: opacity var(--dur) var(--ease);
}
.cell-zoom svg {
  width: 20px;
  height: 20px;
}
.cell-img:hover .cell-zoom {
  opacity: 1;
}
/* 主视图:右上角一枚眼睛。星标是"收藏"的语言,眼睛才是"就是这张" ——
   比在格子下面挂一行小字醒目得多 */
.cell-mark {
  position: absolute;
  top: 6px;
  right: 6px;
  width: 22px;
  height: 22px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  background: var(--accent);
  color: var(--accent-contrast);
}
.cell-mark svg {
  width: 14px;
  height: 14px;
}
.cell-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-align: center;
  font-size: var(--fs-micro);
  color: var(--text-3);
}
.cell.is-ref .cell-label {
  color: var(--accent-strong);
  font-weight: 600;
}

/* —— 规格表 —— */
.spec {
  display: grid;
  grid-template-columns: 84px 1fr;
  gap: 9px 12px;
  align-items: baseline;
}
.spec-k {
  font-size: var(--fs-xs);
  color: var(--text-3);
}
.spec-v {
  font-size: var(--fs-sm);
  line-height: 1.6;
  color: var(--text);
  overflow-wrap: anywhere;
}
.spec-v.dim {
  color: var(--text-3);
}

/* —— 看大图 —— */
.viewer {
  position: fixed;
  inset: 0;
  z-index: 60;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--sp-5);
  background: color-mix(in srgb, var(--stage-bg) 86%, transparent);
  backdrop-filter: blur(6px);
}
.viewer-box {
  display: flex;
  flex-direction: column;
  width: min(720px, 100%);
  max-height: 100%;
  border-radius: var(--r);
  overflow: hidden;
  background: var(--surface);
  box-shadow: var(--sh-md);
}
.viewer-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-3);
  padding: 10px var(--sp-3) 10px var(--sp-4);
}
.viewer-label {
  font-size: var(--fs-sm);
  font-weight: 600;
  color: var(--text);
}
.viewer-x {
  flex: none;
  width: 34px;
  height: 34px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 999px;
  color: var(--text-2);
  cursor: pointer;
  transition: color var(--dur) var(--ease), background var(--dur) var(--ease);
}
.viewer-x:hover {
  color: var(--text);
  background: var(--bg-elev);
}
.viewer-x svg {
  width: 16px;
  height: 16px;
}
.viewer-stage {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 var(--sp-3);
}
.viewer-img {
  flex: 1;
  min-width: 0;
  max-height: calc(100vh - 220px);
  object-fit: contain;
  display: block;
  border-radius: var(--r-sm);
  background: var(--stage-bg);
}
/* 翻页钮放在图片两侧:和预览卡同一套"图上左右翻"的语言 */
.viewer-nav {
  flex: none;
  width: 36px;
  height: 36px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--line);
  border-radius: 999px;
  background: var(--surface);
  color: var(--text-2);
  cursor: pointer;
  transition: color var(--dur) var(--ease), border-color var(--dur) var(--ease),
    background var(--dur) var(--ease);
}
.viewer-nav:hover {
  color: var(--text);
  border-color: var(--line-strong);
  background: var(--bg-elev);
}
.viewer-nav svg {
  width: 15px;
  height: 15px;
}
.viewer-acts {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  padding: var(--sp-3) var(--sp-4) var(--sp-4);
}

/* —— 空态 —— */
.empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  margin-top: var(--sp-7);
  text-align: center;
}
/* 与历史页的空态同一档尺寸与留白 */
.empty-ico {
  width: 44px;
  height: 44px;
  color: var(--text-3);
}
.empty-title {
  font-size: var(--fs-lg);
  color: var(--text);
}
.empty-sub {
  max-width: 48ch;
  font-size: var(--fs-sm);
  line-height: 1.6;
  color: var(--text-2);
}
.empty .ed-btn {
  margin-top: 6px;
}

@media (max-width: 720px) {
  /* 窄屏放不下两列,退回一列。标签本来就在输入上方,所以结构不必再改,
     只要把网格收成一列 —— 上一版标签在左,窄屏还得额外把标签挪上去 */
  .wz-fields {
    grid-template-columns: 1fr;
  }
  /* 16px 以下 iOS Safari 聚焦时会放大整页(与提示词库同一档处理)。
     名字那栏现在也用 .ed-input,所以一并覆盖到了 */
  .ed-input {
    font-size: 16px;
  }
  /* 起稿那一行拆成上下:窄屏里输入框和按钮挤在一行,输入框只剩十来厘米宽 */
  .wz-draft-row {
    flex-wrap: wrap;
  }
  .wz-draft-row .ed-btn {
    width: 100%;
    height: 44px;
  }
  /* 窄屏:三步的标签一起挤会先被截断的是第三段,
     所以把连接线收短、步间距压小 —— 圆点比标签更需要留在原地 */
  .wz-steps {
    gap: 6px;
    padding: 12px var(--sp-4);
  }
  /* 卡片把留白收一档:视口本来就窄,给表单多留一点宽度。
     高度上限也用同一档 —— 上下各留这么点,卡不至于贴到屏幕边 */
  .wizard {
    width: calc(100% - 2 * var(--sp-3));
    max-height: calc(100vh - 2 * var(--sp-3));
  }
  .wz-line {
    flex: 0 0 10px;
  }
  .wz-step {
    min-width: 0;
    gap: 6px;
  }
  .wz-name {
    overflow: hidden;
    text-overflow: ellipsis;
    font-size: var(--fs-xs);
  }
  /* 四张其余设定图两行两列:四格一排会把每格压到看不清 */
  .wz-grid {
    grid-template-columns: repeat(2, 1fr);
    gap: var(--sp-2);
  }
  /* 窄屏并排会把图压到看不清:图上、事下 */
  .wz-hero {
    flex-direction: column;
    align-items: stretch;
    gap: var(--sp-4);
  }
  .wz-hero-shot {
    width: min(288px, 100%);
    align-self: center;
  }
  /* 窄屏卡更小、一排两枚:auto-fill 自己退列,不用手写列数 */
  .grid {
    grid-template-columns: repeat(auto-fill, minmax(170px, 1fr));
    gap: var(--sp-3);
  }
  /* 海报卡在窄屏卡面更小:名字收一档,段距与内边距也各收一点,
     但留白仍比桌面端紧不了太多 —— 信息已经只剩四行了 */
  .ctile-name {
    font-size: var(--fs-lg);
  }
  .ctile-content {
    gap: 7px;
    padding: 13px 13px 12px;
  }
  /* 窄屏一行里要同时站住名字和 CTA:两边都收一档,给名字多留点位置 */
  .ctile-head {
    gap: 8px;
  }
  .ctile-cta {
    padding: 5px 9px;
    font-size: var(--fs-micro);
  }
  .ctile-cta-ico {
    width: 12px;
    height: 12px;
  }
  .hero {
    flex-wrap: wrap;
    padding: var(--sp-4);
  }
  .hero-avatar {
    width: 64px;
    height: 64px;
  }
  .hero-cta {
    width: 100%;
  }
  /* 五格一排会把每格压到看不清,窄屏改成三列两行 */
  .sheet {
    grid-template-columns: repeat(3, 1fr);
  }
  .spec {
    grid-template-columns: 1fr;
    gap: 2px var(--sp-3);
  }
  .spec-v {
    margin-bottom: 8px;
  }
  /* 触控目标放大到 40px */
  .ctile-dots,
  .viewer-x,
  .viewer-nav {
    width: 40px;
    height: 40px;
  }
  /* 顶栏三枚动作在窄屏会挤:收一档内边距,别逼着它们换行 */
  .dt-act,
  .dt-del {
    padding: 6px 9px;
  }
}

@media (max-width: 640px) {
  /* 标题收一档(与历史页同一档),免得与右上角的新建按钮在一行里挤 */
  .chars-title {
    font-size: var(--fs-xl);
  }
}
</style>
