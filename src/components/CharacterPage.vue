<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch, type Component } from 'vue'
import {
  PhMaskHappy,
  PhTextAa,
  PhSquaresFour,
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
  PhPencilSimple,
  PhSpeakerHigh,
  PhStopCircle,
  PhX,
  PhChatCircleDots
} from '@phosphor-icons/vue'
import {
  CHARACTER_VIEWS,
  cloneVoice,
  coverSrc,
  draftCharacterFields,
  draftCharacterFromImage,
  emptyCharFields,
  emptyCharPersona,
  emptyCharVoice,
  hasPersona,
  imageSrc,
  newVoiceId,
  TTS_AUDITION_TEXT
} from '../api'
import LatticeLoader from './LatticeLoader.vue'
import type {
  ApiConfig,
  Character,
  CharacterDraft,
  CharacterFields,
  CharacterPersona,
  CharacterStat,
  CharacterView,
  CharacterViewKind,
  CharacterVoice,
  CharacterWork,
  HistoryEntry
} from '../types'
import { vGrow } from '../lib/grow'
import { deleteVoiceSample, putVoiceSample } from '../lib/idb'
// 送去模型的参考图长边上限(与首页、画布共用同一个数)
import { REF_IMAGE_EDGE } from '../lib/payload'
import { speak, speakingId, stopSpeaking } from '../lib/speech'

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
  /* 按角色 id 归拢的作品:用这个角色出过的图。源数据同样是历史记录,
     与 stats 一起在主界面算好 —— 这一页不碰历史,只负责摆 */
  works: Record<string, CharacterWork[]>
  /* 各角色正在生成哪几张视图(没有该角色的键 = 空闲)。
     必须按角色分开 —— A 的正脸在跑时切到 B,B 的格子不该跟着显示"生成中" */
  busy: Record<string, CharacterViewKind[]>
  // 起稿要用的文本模型配置。没配就走不了 AI 起稿,但手填照常
  textConfig?: ApiConfig
  /* 识图要用的视觉模型配置。上传参考图后就是它在读这张图 ——
     没配也不拦着上传:图本身当参考照常用得着,只是不会反填设定 */
  visionConfig?: ApiConfig
  /* 朗读要用的合成配置。没配时音色区会提示去配一条,而朗读会退回浏览器自带的语音 ——
     "能出声"和"是这个角色自己的嗓子"之间的分界线就在这一条配置上 */
  ttsConfig?: ApiConfig
}>()

/** 表单草稿:设定拆成五项,参考图先收成 data URL ——
 *  压小成 Blob 是主界面的事(与参考图存档同一档参数)。
 *  编辑已有角色时 ref 为空表示"没换参考图",那一边就不动库里那张 */
type DraftForm = {
  name: string
  fields: CharacterFields
  /* 人格设定。与 fields 一起编辑,但存的时候分开走(见 types 的 CharacterPersona)——
     它只服务对话,混进 fields 会被拼进每一张出图的提示词 */
  persona: CharacterPersona
  /* 嗓音(朗读时听起来什么样)。与 persona 同为"只服务对话"的一类,同样分开存 */
  voice: CharacterVoice
  desc: string
  ref: string
}

const emit = defineEmits<{
  /* 带 id 是改这一条,不带是新建 —— 落盘由主界面按这个分支走 */
  (e: 'save', payload: {
    id?: string
    name: string
    fields: CharacterFields
    persona: CharacterPersona
    voice: CharacterVoice
    desc: string
    refData: string
  }): void
  (e: 'remove', id: string): void
  // 复制:目录与图都由主界面拷一份(这一页不碰字节)
  (e: 'duplicate', id: string): void
  // 导出成一个 zip。文件本身也由主界面生成 —— 打包要读图,那不归这一页管
  (e: 'export', id: string): void
  // 导入:只把选中的文件交出去,怎么读怎么落盘由主界面决定(与上面同一条分工)
  (e: 'import', file: File): void
  (e: 'open', id: string): void
  /* 点开一件作品:交出去的是那条历史记录本身,由主界面开预览 ——
     与历史图墙、首页图砖走同一个入口 */
  (e: 'preview', entry: HistoryEntry): void
  // 拿这个角色去开画:套上角色并切回工作台,由主界面负责跳转
  (e: 'create', id: string): void
  // 跟这个角色说话:跳到对话页并选中它,由主界面负责跳转
  (e: 'chat', id: string): void
  (e: 'generate', charId: string, kind: CharacterViewKind): void
  (e: 'generateAll', charId: string): void
  // 停掉某个角色正在跑的那一张设定图(只停它)。中断手柄在主界面(请求从那里发出)
  (e: 'stopView', charId: string, kind: CharacterViewKind): void
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
function editFromCard(id: string) {
  closeCardMenu()
  // 找不到就是这一条正好被删了:startEdit() 不带角色会当成新建,不能那样兜底
  const c = props.characters.find((x) => x.id === id)
  if (c) startEdit(c)
}
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
   设定图与整套设定都挪进详情 —— 五张图加整套设定挤在一张卡上,
   既不好看也点不明白:点已有图会重新生成、想看大图又没地方看 */
const detailId = ref('')
// 正在全屏看的那张视图(空 = 没在看)
const viewer = ref<CharacterViewKind | ''>('')
// 正在编辑(新建)的表单
const editing = ref(false)
/* 这一轮向导改的是哪个已保存角色(空 = 新建)。
   刻意不和 wizardId 合并:wizardId 是"向导进行中的角色",新建时第 1 步存完才有,
   而它同时是第 2、3 步的解锁条件(stepUnlocked)—— 编辑一条已有的角色时
   这两步不该解锁,那一轮只做第 1 步 */
const editingId = ref('')
const isEditing = computed(() => !!editingId.value)
const editingChar = computed(() => props.characters.find((c) => c.id === editingId.value))
/* 编辑态下参考图的预览地址:draft.ref 只在"换了新图"时才有值,
   没换的时候要显示库里那张。这一页不碰字节,地址交给 coverSrc */
const editRefSrc = computed(() => (isEditing.value ? coverSrc(editingChar.value?.sourceRef) : ''))
const draft = ref<DraftForm>({
  name: '',
  fields: emptyCharFields(),
  persona: emptyCharPersona(),
  voice: emptyCharVoice(),
  desc: '',
  ref: ''
})
// 起稿:一句话 + 请求状态 + 它自己的报错(不占用生图那套错误出口)
const idea = ref('')
const drafting = ref(false)
const draftError = ref('')
/* 起稿请求的代次。等待中关掉向导、或重新开一轮时,上一次的结果回来后
   会把新表单里刚写的东西整个盖掉 —— 加一条代次,对不上就整份丢弃 */
let draftSeq = 0
/** 作废在途的起稿请求。只加代次不够:drafting 得一起松开,
 *  否则下一轮起稿键会一直点不动 */
function cancelDraft() {
  draftSeq++
  drafting.value = false
}

/* 起稿填过、而用户还没动过的字段。
   校对要有个落点 —— 提示写着 "check what it got wrong",但看不出哪几项是
   模型编的:模型给的值和人手写的值在界面上长得一模一样。
   改一下那一项就抹掉标记(见 markEdited),扫一眼就知道还剩哪几处没看过。

   键是长相与人格两套字段的并集。两套的键不重合,所以标在同一份里不会打架 ——
   而图例说的是"这枚点是模型写的",本来就该把两套一起算 */
type DraftFieldKey = keyof CharacterFields | keyof CharacterPersona
const aiFilled = ref<Partial<Record<DraftFieldKey, boolean>>>({})
// 有标记 ⇒ 组说明换成那条图例,不然用户不知道这枚点是什么意思
const hasAiFilled = computed(() => Object.values(aiFilled.value).some(Boolean))
/* 已经填过内容 ⇒ 起稿键变成 "Draft again"。
   人格也算:它同样是起稿会覆盖的东西 */
const hasSpec = computed(
  () =>
    Object.values(draft.value.fields).some((s) => (s || '').trim()) ||
    hasPersona(draft.value.persona)
)

function markEdited(key: DraftFieldKey) {
  if (aiFilled.value[key]) aiFilled.value[key] = false
}

/* —— 识图:把上传的参考图读成设定 ——
   与上面那条"一句话起稿"是并行的两个入口,共用同一份回填规矩(applyDraft)。
   状态与报错也自成一套:draftError 那块在起稿框里,而这里出错的地方在参考图旁边 */
const visionBusy = ref(false)
const visionError = ref('')
// 这张图已经读过至少一次了 ⇒ 按钮从 "Read the spec" 变成 "Read again"
const visionRead = ref(false)
/* 这一行要不要摆取景框:没跑过(也没失败过)时它只是一句提示,
   摆一个不动的取景框反而像坏了。跑过之后才把结果留在原地 */
const visionRan = computed(() => visionBusy.value || !!visionError.value || visionRead.value)
/** 取景框的状态:busy 之外只有"刚读完"和"刚失败"两种收尾 */
const visionLoader = computed<'working' | 'done' | 'error'>(() =>
  visionBusy.value ? 'working' : visionError.value ? 'error' : 'done'
)
/* 代次:和起稿同一个理由 —— 等待中换了一张图、关掉向导,上一次的结果回来时
   不能落到新表单里 */
let visionSeq = 0
/** 作废在途的识图请求,并把 loading 松开(只加代次的话按钮会一直点不动) */
function cancelVision() {
  visionSeq++
  visionBusy.value = false
}

/* 一次起稿的结果落进表单。文字起稿与识图共用 —— 两条路拿到的是同一份
   「名字 + 结构化设定」,回填的规矩就该一模一样 */
function applyDraft(d: CharacterDraft) {
  /* 名字只在还空着的时候补:它是这张卡的标题,用户自己敲进去的那个
     不该被一次起稿顶掉。想换成模型起的名字,先清空再点一次 */
  if (!draft.value.name.trim() && d.name) draft.value.name = d.name
  draft.value.fields = d.fields
  /* 人格只有模型真写出来了才覆盖。这里与 fields 不同,是有意的 ——
     那十二行是必答项,而这四行是后加的:一次回不来时
     把用户自己写好的人格抹成空,比"这次没更新"糟得多 */
  if (hasPersona(d.persona)) draft.value.persona = { ...d.persona }
  /* 记下这一趟哪些栏是模型填的。空着的那些不标 —— 标了反而像在说
     "这里有什么要看",而它们本来就该留空(见 server 那条提示) */
  const marks: Partial<Record<DraftFieldKey, boolean>> = {}
  for (const k of Object.keys(d.fields) as Array<keyof CharacterFields>) {
    if (d.fields[k].trim()) marks[k] = true
  }
  for (const k of Object.keys(d.persona) as Array<keyof CharacterPersona>) {
    if (d.persona[k].trim()) marks[k] = true
  }
  aiFilled.value = marks
}

/* 规格字段是 textarea,随内容长高。
   为什么不用 <input>:字段值上限 12 个词(约 70 字符),两列之后每栏只有 338px,
   在 13px 下约 55 字符 —— 边界值会被截在视野外,只能靠方向键摸。
   封顶三行、再多内部滚(见样式),不然一栏长起来会把整行拉高 */
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

/** 特征胶囊:最多三枚 —— 卡片上只放得下这么多,完整的规格表在详情页。
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

/** 角色卡的封面 = 主视图。生成正脸时会把它写回 c.ref(见 App 的 genCharView),
 *  所以列表上读 ref 就够,不必为每张卡去加载设定图;
 *  ref 空的极少数情况(老数据从没生成过正脸)再退回已经取过的正脸 */
function coverOf(c: Character): Blob | undefined {
  return c.ref ?? viewOf(c.id, 'front')?.data
}

/** 头像优先用正脸:圆形容器裁的是一张脸。没有正脸时才退回封面那张 */
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

/* 这个角色出过的图(主界面按 characterId 归拢好传进来)。
   与上面那张设定图网格是两回事:设定图是参考料,这里是作品 */
const works = computed(() => props.works[detailId.value] || [])
/* 只摆最近这一批:一个用久了的角色能攒下几百张,全铺出来会把下面的 Spec
   顶到几屏之外。多出来的交给历史页 —— 那里才是"翻全部"的地方 */
const WORKS_SHOWN = 12
const worksShown = computed(() => works.value.slice(0, WORKS_SHOWN))
const worksRest = computed(() => Math.max(0, works.value.length - WORKS_SHOWN))

/* 网格里用小缩略图:原图是整尺寸的,十几张一起挂上去浏览器会连续做十几次全尺寸解码。
   老记录没有 thumb,那时才退回原图(与历史图墙同一条回退) */
function workSrc(w: CharacterWork) {
  return w.entry.thumb ? coverSrc(w.entry.thumb) : imageSrc(w.item)
}

/** 正脸在不在。其余四张都以它为参考图,所以它是这条流水线的前置 ——
 *  没有它时那四格是"上锁"而不是"可点但会报错"(见 App 的 genCharView 守卫) */
const hasFront = computed(() => !!viewOf(detailId.value, 'front'))

/** 这一格现在能不能点。除正脸外的空格子,要先有正脸 ——
 *  与其让它点下去弹一句"先生成正脸",不如直接锁住,把顺序摆在明面上 */
function isLocked(kind: CharacterViewKind) {
  return kind !== 'front' && !hasFront.value
}

/** 主视图只有一个:正面。
 *  其余四张都是"照正面生的派生图",拿它们当主图会把脸串掉 ——
 *  所以这里没有"选"这件事,只有正面在不在(有无即状态,不必再存一个 refKind) */
function isMainView(kind: CharacterViewKind) {
  return kind === 'front' && !!viewOf(detailId.value, kind)
}

/** 某个角色正在生成哪几张视图 */
function busyKinds(charId: string): CharacterViewKind[] {
  return props.busy[charId] || []
}
function isBusy(charId: string, kind: string) {
  return busyKinds(charId).includes(kind as CharacterViewKind)
}
/* 正脸有没有在跑。它是其余四张的参考图 —— 在重跑正脸的窗口里开始生成别的张,
   那几张拿到的会是上一版正脸,"同一张脸"这个前提就破了。
   所以这个窗口里要停用的只是"非正脸"那些入口;正脸自己不依赖任何视图。
   其余时候几张就该能同时跑:它们之间没有依赖(见 App 的 genCharView),
   整片灰着不让点,顺手把"一次多发几张"这件事也挡掉了 */
function frontBusy(charId: string) {
  return busyKinds(charId).includes('front')
}
/** 这一格(或这个入口)现在要不要停用。不含"还没有正脸"那种锁 —— 那个是 isLocked */
function viewBlocked(charId: string, kind: CharacterViewKind) {
  return kind !== 'front' && frontBusy(charId)
}

/** 详情页这个角色在生成的那几张。文案与进度条只提它自己的 ——
 *  把别的角色的进度报到这一页上,看着就像这一页自己卡住了 */
const detailBusy = computed(() => busyKinds(detailId.value))
/** 大图里那个 Regenerate 能不能点:非正面的视图在正脸重跑期间要等一等 */
const viewerRegenBlocked = computed(() => viewer.value !== 'front' && frontBusy(detailId.value))
/** 正在生成的这一批叫什么。按钮与进度条上都用它,所以直接给能读的短语;
 *  同时跑几张时不列名字,报个数就够 —— 哪几格在转,网格上一眼看得见 */
const busyLabel = computed(() => {
  const list = detailBusy.value
  if (list.length === 1) {
    return `${CHARACTER_VIEWS.find((v) => v.kind === list[0])?.label || ''} view`
  }
  return `${list.length} views`
})

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
/* 翻到第几张 / 共几张。只有一张时不摆 —— "1 / 1" 是废话,
   而且它本来就是为"左右翻"这件事服务的 */
const viewerPos = computed(() => {
  const list = viewerKinds.value
  return { i: list.indexOf(viewer.value as CharacterViewKind) + 1, n: list.length }
})

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
 *  大图里只有按钮,向导里还有起稿框与规格字段的 textarea —— 都得收进来:
 *  漏掉的那些会让焦点落到圈外,被下面的兜底逻辑拽回第一个控件,
 *  于是从 textarea 往后怎么按 Tab 都出不去 */
function trapTab(box: HTMLElement | null, e: KeyboardEvent) {
  if (!box) return
  const items = Array.from(
    box.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled])'
    )
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

// 大图上的动作:针对"正在看的那张"。空态直接不发,免得把空串当视图名传下去
function regenerateViewer() {
  const c = detailChar.value
  if (c && viewer.value) emit('generate', c.id, viewer.value)
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
  /* 离开这一页就把嘴闭上:试听不属于"后台也该继续"的那类东西 */
  stopSpeaking()
})

/** 开向导。不带角色是新建,带角色是改它 ——
 *  两种都从第 1 步那张表单开始,差别只在预填与"存下去是新的一条还是改这一条" */
function startEdit(c?: Character) {
  // 上一轮可能在等起稿或识图结果:整份作废,免得它回来盖掉这次打开的表单
  cancelDraft()
  cancelVision()
  // 参考图那一块的状态也跟着清:上一轮读过的图不该在新表单里留着"已读"的痕迹
  visionError.value = ''
  visionRead.value = false
  idea.value = ''
  draftError.value = ''
  editingId.value = c?.id || ''
  /* 这条角色**已经记着**的那段样本算是"有主"的。开一轮新表单时先认下来,
     否则编辑一个已克隆过的角色、什么都不动就退出,会把它的样本删掉 */
  committedSampleId = c?.voice?.sampleId || ''
  draft.value = c
    ? {
        name: c.name,
        fields: c.fields ? { ...c.fields } : emptyCharFields(),
        /* 老角色没有 persona(loadCharacters 会补一份空的,这里再兜一层):
           与 fields 分开拷一份,表单被继续改动时才不会牵动已经存下的那份 */
        persona: { ...emptyCharPersona(), ...(c.persona || {}) },
        /* 嗓音同样兜一层:老角色没有这一项。深拷一份 —— 表单里改音色时
           不该牵动已经存下的那份 */
        voice: { ...emptyCharVoice(), ...(c.voice || {}) },
        desc: c.desc || '',
        // 预填页面上那张图由 editRefSrc 负责,这里只表示"还没换"
        ref: ''
      }
    : {
        name: '',
        fields: emptyCharFields(),
        persona: emptyCharPersona(),
        voice: emptyCharVoice(),
        desc: '',
        ref: ''
      }
  /* 向导从头开始:上一次留下的 id、步数与起稿标记必须清掉,否则会直接跳进旧角色的第 3 步。
     编辑态也归零 —— 那一轮只做第 1 步,第 2、3 步锁着不动 */
  step.value = 1
  wizardId.value = ''
  aiFilled.value = {}
  /* 上一轮的"存完跳到哪一步"不能留到这一轮:上一次若存失败,标记还在,
     这次随便存点什么都跳到第 3 步去了 */
  afterSaveStep = 0
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

/* 三步各配一枚图标,给步骤条上那个圆点用(见模板里的 .wz-dot)。
   挑的是"这一步在做什么",不是"它的序号是几":
     Basics  填名字、性别与那份设定 —— 收的全是字
     Voice   这个角色的嗓子:用系统的,还是自己配一把
     Views   先出一张正脸,再以它为参考出其余四张 —— 同一张脸的保证

   为什么把"声音"从第 1 步里分出来:那一屏原本同时回答"这个人是谁"与
   "它听起来什么样",而后半比前半复杂得多(两层选择 + 输入 + 试听),
   堆在一屏会让信息量翻倍 —— 而它其实与设定、参考图之间没有任何先后依赖。
   原来的第 2、3 步则合成一步:正脸与其余四张本来就是**同一件事的两轮**
   (先定基准、再照它长),而合成一屏之后"先出正脸"这句话只要说一次 */
const STEPS: Array<{ n: WizardStep; label: string; icon: Component }> = [
  { n: 1, label: 'Basics', icon: PhTextAa },
  { n: 2, label: 'Voice', icon: PhSpeakerHigh },
  { n: 3, label: 'Views', icon: PhSquaresFour }
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
 *  有参考图就是图生图,没有就是纯文字生图 —— 出来的东西差别很大。
 *  指的是第一步上传的那张底图(见 types.ts 的 sourceRef);
 *  老角色没有这一项,退回主图 —— 那批的 ref 里存的就是图本身 */
const heroSource = computed(() => {
  const c = wizardChar.value
  return c?.sourceRef || c?.ref ? 'Your reference image' : 'Text only — no reference image'
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

/* —— 右栏:这个角色"是什么" ——
   三步共用一栏。左边是此刻在做的事(填设定 / 出正脸 / 出其余四张),
   右边始终是这个人本身。

   有已保存的角色就读它,没有(第 1 步还没存下)就读手上这份草稿 ——
   于是"一句话起稿 → 逐栏校对"这条路上右栏一直是活的,
   而不必等到保存之后才出现 */
function railFields(): CharacterFields {
  /* 编辑态读手上的草稿:用户正在改的就是它,右栏得跟着动才叫摘要。
     新建态第 1 步还没存,读的也是草稿;只有"已存下、正在走出图那两步"才读库里的那份 */
  if (isEditing.value) return draft.value.fields
  return wizardChar.value?.fields || draft.value.fields
}
const railName = computed(() =>
  (isEditing.value ? draft.value.name : wizardChar.value?.name || draft.value.name).trim()
)
/* 身份那项提出来当副标题(名字底下写"这是谁"),所以不在下面的清单里重复。
   空着就空着 —— 不摆一句 "No spec yet",那和没填是一个意思 */
const railSub = computed(() => (railFields().identity || '').trim())
const railRows = computed(() =>
  ALL_FIELDS.filter((f) => f.key !== 'identity')
    .map((f) => ({ label: f.label, value: (railFields()[f.key] || '').trim() }))
    .filter((r) => r.value)
)

/** 这一步能不能进。声音与设定图都挂在角色上,所以后两步的前提是同一个:
 *  角色已经在库里(第 1 步存过)。
 *  **第 3 步不再要求先有正脸** —— 正脸现在就在那一屏里,是它的第一件事 */
function stepUnlocked(n: WizardStep): boolean {
  if (n === 1) return true
  return !!wizardId.value
}
/** 这一步做完没有。做完的在步骤条上打勾,和"正在这一步"区分开 */
function stepDone(n: WizardStep): boolean {
  /* 第 1、2 步同一个条件:声音没有"做完"这回事 —— 不配就是系统自带的那把嗓子,
     同样是一种选好的状态。角色存下来了,这两步就都算走过。
     (曾把第 2 步写成"配了自定义音色才算",可那样保持默认的人会在步骤条上
     看到一个永远不打勾的第 2 步,像是漏了什么,回头去看又没什么可填的) */
  if (n === 1 || n === 2) return !!wizardId.value
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

/* 向导走到有角色的那一步就先把它的设定图取出来 ——
   第 2、3 步要读五格的状态,不取的话"正在生成"的那格看起来和空格子一样。
   只在编辑态里取:列表页不碰这些图(与 App 的 loadCharViews 同一约定) */
watch([editing, wizardId], () => {
  if (editing.value && wizardId.value) emit('open', wizardId.value)
})

/** 第 1 步存完由父组件回调:拿到 id,推进到主视图那一步。
 *  中间不退到列表 —— 这条向导是一口气走完的 */
function onSaved(id: string) {
  wizardId.value = id
  step.value = 2
  // 后两步要读这个角色的图:取图由上面的 watch 负责,拿到 id 就会去取
}

/** 存完之后要跳到哪一步。0 = 不跳(收尾回详情)。
 *
 *  为什么需要它:父组件只知道"存好了",不知道这一轮是**从详情页进来改设定**
 *  还是**在向导里改声音** —— 前者要收尾,后者要接着往下走。
 *  而"存完该去哪"本来就归这一页管(步数在这里),所以这个标记也留在这里 */
let afterSaveStep = 0

/** 改完一条已有角色,由父组件回调。
 *  默认收尾:关掉向导回到详情页 —— 从详情页进来那一轮到此为止。
 *  但向导中途的保存(第 2 步存声音)不算收尾,接着往下走 */
function onUpdated(id: string) {
  /* -1:向导已经关了(用户在声音那一步直接按了 Close,我们顺手把改动存了)——
     存完什么都不做。不拦这一下的话,他会从当前页面被拽去这个角色的详情页 */
  if (afterSaveStep === -1) {
    afterSaveStep = 0
    return
  }
  if (afterSaveStep) {
    step.value = afterSaveStep as WizardStep
    afterSaveStep = 0
    return
  }
  /* 与 finishWizard 一样是"换页"而不是"关浮层":列表里那个按钮已经不在,
     焦点还回去只会掉在 body 上 */
  restoreWizardFocus = null
  editing.value = false
  editingId.value = ''
  draftError.value = ''
  openDetail(id)
}
defineExpose({ onSaved, onUpdated })

/** 退出向导。第 1 步还没存,退了就当没发生;
 *  存过之后角色已经在库里,退了它自己会出现在列表里 */
function closeWizard() {
  // 关掉这一轮就把在途的起稿与识图一并作废:它们的结果不该落到下一次打开的表单里
  cancelDraft()
  cancelVision()
  /* 声音那一步的改动还没提交就走人 —— 顺手把它存了。
     那一步只有一个"Save & continue"的提交入口,而按 Close 的意图是"结束",
     不该因为没点那个按钮就把刚配好的嗓子丢掉(见 saveFromVoiceStep 的 -1)。
     **必须排在 dropOrphanVoiceSample 之前**:保存会把 sampleId 记成"有主",
     那之后清理才不会把刚认领的样本删掉 */
  if (step.value === 2 && wizardId.value) saveFromVoiceStep(-1)
  /* 正念着的试听也停掉,并把这一轮建出来、却没人认领的那段克隆录音清掉 ——
     它是用户的录音,留着既没用又该清 */
  stopSpeaking()
  void dropOrphanVoiceSample()
  editing.value = false
  editingId.value = ''
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

/* 回车起稿,Shift+回车换行。
   与首页那条同一笔账:输入法用回车「上屏」时也会发 keydown.enter,
   那一下既不能当提交、也不能 preventDefault(一 prevent 拼音就上不了屏了)。
   现在这一栏是 textarea,回车默认是换行 —— 所以这个 preventDefault 非写不可 */
function onIdeaEnter(e: KeyboardEvent) {
  if (e.isComposing || e.keyCode === 229) return
  e.preventDefault()
  draftWithAI()
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
  const seq = ++draftSeq
  try {
    const d = await draftCharacterFields(cfg, text)
    /* 回来时表单可能已经换了一轮(关掉向导又重开、或去编辑了别的角色):
       这一趟属于上一轮,整份丢掉 —— 否则会把用户刚写的内容覆盖掉 */
    if (seq !== draftSeq) return
    // 一项都没解出来 = 模型没按那个格式回。如实说,别假装已经填好了
    if (!Object.values(d.fields).some((s) => s.trim())) {
      draftError.value =
        'The model did not return a usable spec. Fill the fields by hand, or try another text model.'
      return
    }
    applyDraft(d)
  } catch (e: any) {
    if (seq !== draftSeq) return
    draftError.value = e?.message || 'Could not draft the character'
  } finally {
    // 只有还是自己那一次才复位:新一轮已经在跑时,别把它的 loading 关掉
    if (seq === draftSeq) drafting.value = false
  }
}

/* 送去识图模型的那一份:最长边压到上限的 JPEG。
   上传的原图可能有几十 MB,而请求体上限是 15MB —— 原样发过去会直接 413。
   上限与其余几处参考图共用同一个常量(见 lib/payload.ts 的 REF_IMAGE_EDGE)。
   存档用的仍是原图(见 submit 那条路),这张副本只给模型看 */
const VISION_MAX_EDGE = REF_IMAGE_EDGE
function visionCopy(dataUrl: string): Promise<string> {
  return new Promise((resolve) => {
    const img = new Image()
    img.onload = () => {
      const scale = Math.min(1, VISION_MAX_EDGE / Math.max(img.width, img.height))
      if (scale >= 1) return resolve(dataUrl) // 本来就小,原样发
      const c = document.createElement('canvas')
      c.width = Math.max(1, Math.round(img.width * scale))
      c.height = Math.max(1, Math.round(img.height * scale))
      const ctx = c.getContext('2d')
      if (!ctx) return resolve(dataUrl)
      // 透明 PNG 转 JPEG 会变黑底,先铺一层白
      ctx.fillStyle = '#fff'
      ctx.fillRect(0, 0, c.width, c.height)
      ctx.drawImage(img, 0, 0, c.width, c.height)
      resolve(c.toDataURL('image/jpeg', 0.85))
    }
    img.onerror = () => resolve(dataUrl)
    img.src = dataUrl
  })
}

/* 识图:把这张参考图交给视觉模型,读成同一份「名字 + 结构化设定」。
   上传完自动跑一次(见 onPickRef)——"传张图上去"的意图本来就是照着它填,
   再让用户找一下按钮是多余的一步;旁边那个按钮留着是为了重读与改配置后重试 */
async function draftFromImage() {
  const src = draft.value.ref
  if (!src || visionBusy.value) return
  const cfg = props.visionConfig
  if (!cfg || !cfg.model || !cfg.baseUrl) {
    visionError.value = 'Set up an image-recognition config in API settings first.'
    return
  }
  visionBusy.value = true
  visionError.value = ''
  const seq = ++visionSeq
  try {
    const d = await draftCharacterFromImage(cfg, await visionCopy(src))
    /* 回来时可能已经换了一张图、或关掉了向导:这一趟属于上一轮,整份丢掉 */
    if (seq !== visionSeq) return
    if (!Object.values(d.fields).some((s) => s.trim())) {
      visionError.value =
        'The model did not return a usable spec. Fill the fields by hand, or try another vision model.'
      return
    }
    applyDraft(d)
    visionRead.value = true
  } catch (e: any) {
    if (seq !== visionSeq) return
    visionError.value = e?.message || 'Could not read this image'
  } finally {
    // 只有还是自己那一次才复位:重新挑过图时别把新一轮的 loading 关掉
    if (seq === visionSeq) visionBusy.value = false
  }
}

/* 参考图的上限。FileReader 会把整张读成 data URL 进内存,几百 MB 能把标签页顶掉;
   而这张图随后还要进 localStorage / IndexedDB 的队列,不是"随便传多大的都行" */
const MAX_REF_BYTES = 32 * 1024 * 1024

function onPickRef(e: Event) {
  const el = e.target as HTMLInputElement
  const file = el.files?.[0]
  // 清空 input:同一个文件选第二次也要能触发 change
  el.value = ''
  if (!file) return
  /* 下面两条以前没有:accept 只是选择器上的过滤,用户能强制改选任意文件,
     真把上百 MB 的东西塞进来的话是这一页自己先卡住 */
  if (!file.type.startsWith('image/')) {
    draftError.value = 'That file is not an image.'
    return
  }
  if (file.size > MAX_REF_BYTES) {
    draftError.value = 'That image is too large to use as a reference.'
    return
  }
  draftError.value = ''
  const reader = new FileReader()
  reader.onload = () => {
    // 换了一张图 ⇒ 上一张的读取结论与在途请求一起作废
    cancelVision()
    visionError.value = ''
    visionRead.value = false
    draft.value.ref = String(reader.result)
    /* 传完顺手读一次:这个动作的意图本来就是"照着这张图填设定"。
       没配识图接口时不报错 —— 图当参考照常用,只在那一行里说明怎么开。
       编辑态不读:用户是来换参考图的,不是让模型把他校对过的那份设定重写一遍 */
    if (props.visionConfig && !isEditing.value) void draftFromImage()
  }
  reader.readAsDataURL(file)
}

/* 撤掉参考图:连它读出来的那些状态一起清掉 —— 留着"已读"会像是这张图还在 */
function clearRef() {
  cancelVision()
  draft.value.ref = ''
  visionError.value = ''
  visionRead.value = false
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
  // 姓名与性别是仅有的两条必填:一个给卡片当标题,一个给模型定这张脸
  if (!d.name.trim() || !d.fields.gender.trim()) return
  /* 字段与参考图各拷一份交出去,免得表单被继续改动时牵动已经发出的这次保存。
     编辑态带上 id:主界面据此改这一条,而不是多存一个副本;
     refData 为空则表示"没换参考图",那一边不会去动库里那张 */
  emit('save', {
    ...(editingId.value ? { id: editingId.value } : {}),
    name: d.name,
    fields: { ...d.fields },
    persona: { ...d.persona },
    // 嗓音浅拷一份就够:它底下的值全是字符串与数字,没有嵌套
    voice: { ...d.voice },
    desc: d.desc,
    refData: d.ref
  })
  /* 这一次交出去的嗓音里如果带着一段克隆样本,它就是**有主**的了 ——
     下面那次取消不该把它删掉(见 dropOrphanVoiceSample)。
     存失败时这里会偏保守地留着它:宁可多留一段录音,也不能删掉一个角色正指着的样本 */
  committedSampleId = d.voice.sampleId || ''
  /* 这里不推进也不关表单:存完由父组件回调 onSaved 推向导走下一步 ——
     save 是异步的,现在改步数会在角色还没进列表时先跳到"主视图",
     那一格既没有 id 也没有图。存失败时表单留着,改完可以直接再点一次 */
}

/** 第 2 步(声音)的保存。
 *
 *  **不能直接复用 submit**:那个按 editingId 判断"改这一条还是新建",
 *  而走出向导的新建流程里 editingId 一直是空的 —— 角色是第 1 步存下的,
 *  它不是"正在编辑的对象"。照那个判断会把同一个角色再存出一条副本。
 *  所以这里显式带上 wizardId,并交代"存完跳到第 3 步"。
 *
 *  它同时把整份草稿交出去(名字、设定、参考图都一样)—— 不只是声音:
 *  这一屏能改的其实只有声音,但交一份残缺的表单反而要父组件去猜哪几项没动 */
function saveFromVoiceStep(nextStep: number) {
  const id = wizardId.value
  if (!id) return
  const d = draft.value
  /* 存完去哪由调用方定:从"Save & continue"来的是 3(接着去出图),
     从关闭按钮来的是 -1(向导已经关了,存完什么都别做 ——
     否则父组件的收尾会把人从当前页拽到这个角色的详情页去) */
  afterSaveStep = nextStep
  emit('save', {
    id,
    name: d.name,
    fields: { ...d.fields },
    persona: { ...d.persona },
    voice: { ...d.voice },
    desc: d.desc,
    refData: d.ref
  })
  committedSampleId = d.voice.sampleId || ''
}

/** 身份区的副标题:只用"身份"这一句 */
function heroSub(c: Character) {
  /* 只取"身份"这一项。原来是把 identity · face · hair · eyes · outfit
     五段用 · 连成一行 —— 那读起来是一行字段清单,"这一页像表单"有一半是它给的。
     而这一页该先回答的只有一句"这是谁";其余的字段下面那张规格表里都有,
     在这里再抄一遍只是噪声 */
  return (c.fields?.identity || '').trim()
}

/* —— 表单里的字段 ——
   键、标签、占位示例,集中在这里。分两组的原因与 api.ts 一致:
   面貌特征会跟着每一张成品走,后两项只塑造设定图。
   表单、详情页的规格表都由这张表生成,所以标签不会两处走样。

   这里没有"可选"这一项:全表只有姓名与性别必填(它们不在这张表里,
   由模板单独渲染),其余一律可留空 —— 所以"不标星号"已经说完了这件事,
   不必再反过来给每一栏挂一枚 Optional */
type FieldSpec = {
  key: keyof CharacterFields
  label: string
  // 占位示例:写具体值而不是"请输入",它同时是这一栏该写什么的示范
  hint: string
}

/* 性别不进 FACE_FIELDS —— 它不是一个填文字的栏位,而是一排按钮,
   由模板单独渲染(见下面那一段)。但它仍然是一条规格:会拼进提示词、
   也要进详情页的规格表,所以它得出现在 ALL_FIELDS 里 */
const GENDER_FIELD: FieldSpec = { key: 'gender', label: 'Gender', hint: 'female' }

/** 两个固定选项。不做输入框:图像模型认的就是这两个词,
 *  而这一栏的意义恰恰是"别让模型自己挑" */
const GENDERS = ['female', 'male']

const FACE_FIELDS: FieldSpec[] = [
  { key: 'identity', label: 'Identity', hint: 'veteran space smuggler, worn flight jacket' },
  { key: 'face', label: 'Face', hint: 'angular jaw, warm tan skin, late 30s' },
  { key: 'hair', label: 'Hair', hint: 'short silver hair, undercut' },
  { key: 'brows', label: 'Brows', hint: 'thick straight black brows' },
  { key: 'eyes', label: 'Eyes', hint: 'glowing blue optics' },
  { key: 'noseMouth', label: 'Nose & mouth', hint: 'narrow straight nose, full lips' },
  { key: 'facialHair', label: 'Facial hair', hint: 'clean-shaven' },
  { key: 'faceMarks', label: 'Face marks', hint: 'scar over left brow' }
]

const SHEET_FIELDS: FieldSpec[] = [
  { key: 'outfit', label: 'Outfit', hint: 'armored jacket, neon trim' },
  { key: 'marks', label: 'Marks', hint: 'chrome right arm, engraved dog tags' }
]

/* 全部规格的完整顺序 —— 详情页的规格表、右栏摘要都按它排。
   性别排在首位:它与其余各项一样是一条规格,只是表单上换了种控件 */
const ALL_FIELDS: FieldSpec[] = [GENDER_FIELD, ...FACE_FIELDS, ...SHEET_FIELDS]

/** 性别那排要摆出来的选项。模型偶尔会写出 female / male 之外的值(比如 non-binary)——
 *  把它当成第三枚显示出来:已填的值在界面上看不见,比"选不中"更难理解,
 *  一栏空着却拦不住保存,用户会以为是坏了 */
const genderOptions = computed(() => {
  const v = (draft.value.fields.gender || '').trim()
  return v && !GENDERS.includes(v) ? [...GENDERS, v] : GENDERS
})

function pickGender(v: string) {
  draft.value.fields.gender = v
  markEdited('gender')
}

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

/* —— 人格四项 ——
   只有对话用得上,与上面两组是**完全分开**的一件事:那两组管"它长什么样",
   这一组管"它是个什么样的人"。刻意不进 AI 起稿的十二行,也不并进
   Spec 的字段顺序 —— 它不影响任何一张图,混进去只会让那条界线变糊。

   为什么 traits 与 voice 要分成两栏:写在同一栏里模型会把两者平均掉,
   结果是性格写了、说话方式被稀释成通用口吻 —— 而"像人"主要靠后者。

   **"Voice" 这个词归嗓音(听得到的那个),这里不让它出现。**
   这一组讲的是"这个人是个什么样的人、话怎么说出来",所以组名是 Personality;
   第二个字段管"话怎么说出来",叫 Speech style。
   把音频音色那一档功能加进来之后,一个叫 Voice 的文字栏会和它彻底混淆 ——
   用户会以为在这里写字就能改变角色听起来的声音 */
type PersonaSpec = { key: keyof CharacterPersona; label: string; hint: string }

const PERSONA_FIELDS: PersonaSpec[] = [
  { key: 'traits', label: 'Traits', hint: 'guarded, dry humor, slow to trust' },
  { key: 'voice', label: 'Speech style', hint: 'short clipped sentences, rarely asks questions' },
  { key: 'address', label: 'Address', hint: "calls you 'kid', an old partner" },
  { key: 'boundaries', label: 'Boundaries', hint: 'never breaks character, never mentions AI' }
]

/* 详情页的规格表:固定的那几项按顺序排,再做一条可选的备注 */
const SPEC_LABELS: Array<[keyof CharacterFields, string]> = ALL_FIELDS.map((f) => [f.key, f.label])
function specRows(c: Character) {
  const f = c.fields || emptyCharFields()
  const rows = SPEC_LABELS.map(([k, label]) => ({ label, value: (f[k] || '').trim(), wide: false }))
  const notes = (c.desc || '').trim()
  // 备注是自由文本,回看时占满整行
  if (notes) rows.push({ label: 'Notes', value: notes, wide: true })
  return rows
}

/** 人格那一段的读法。与 specRows 同一形状,但单独成表 ——
 *  它回答的是"这个人怎么说话",不是"这个人长什么样" */
function personaRows(c: Character) {
  const p = { ...emptyCharPersona(), ...(c.persona || {}) }
  return PERSONA_FIELDS.map((f) => ({ label: f.label, value: (p[f.key] || '').trim() }))
}

/* ===== 嗓音 =====
   这一块管"朗读时它听起来什么样",与上面那组人格字段是两件事:
   那边是**文字**(话怎么说出来),这里是**声音本身**。

   三种来源只在"voice 从哪来"上不同,合成请求的形状是一样的(见 api.ts 的
   synthesizeSpeech)。所以界面上的分叉也只有那三行输入,底下走的是同一条路 */
/* 三档的 hint 就是**选它之后要做什么** —— 用户站在这一排前面的问题只有一个:
   "我该选哪个、然后填什么"。所以每句都写成一句可执行的指路,不描述概念 */
const VOICE_SOURCES = [
  {
    id: 'preset' as const,
    label: 'Built-in',
    hint: 'A stock voice from your provider. Paste its voice ID below — copy one from your provider’s voice library.'
  },
  {
    id: 'describe' as const,
    label: 'Describe',
    hint: 'No ID and no recording — write a line describing how it sounds and the model invents the voice. Nothing to prepare.'
  },
  {
    id: 'clone' as const,
    label: 'Clone',
    hint: 'A voice you made from a recording. Already have its ID? Paste it below. Don’t? Upload a recording instead.'
  }
]
type VoiceSource = (typeof VOICE_SOURCES)[number]['id']

function voiceSource(): VoiceSource {
  return draft.value.voice.source || 'preset'
}
/* 当前那一档的指路语。以前这三个 hint 写好了却没接到界面上(见上面的注释) */
const voiceSourceHint = computed(
  () => VOICE_SOURCES.find((s) => s.id === voiceSource())?.hint || ''
)
function setVoiceSource(s: VoiceSource) {
  draft.value.voice.source = s
}
/* 换引擎时把鉴权性质的那几个字段留着(改回来时不用重填),
   但**不自动建号**:该不该花钱是用户按下去的那一刻决定的,不是切一下开关就定的 */

/* —— 试听 ——
   用的是**固定短句**(见 api.ts 的 TTS_AUDITION_TEXT)。用户每改一次描述都会点一次它,
   而每一次都是真请求 —— 同一句话配同一个音色在缓存里必然命中,所以从第二次起试听不花钱。
   这一条是整个功能里唯一能"边调边听"的入口,没有它音色就没法调 */
const AUDITION_ID = 'voice-audition'
const auditioning = computed(() => speakingId.value === AUDITION_ID)
const voiceError = ref('')

async function auditionVoice() {
  if (auditioning.value) {
    stopSpeaking()
    return
  }
  if (voiceSource() === 'preset' && !draft.value.voice.vendorVoice?.trim()) {
    voiceError.value = 'Paste a voice ID from your provider console first.'
    return
  }
  /* 描述那一档只要一段描述 —— **不需要底子音色**(见模板里那段注释) */
  if (voiceSource() === 'describe' && !draft.value.voice.describe?.trim()) {
    voiceError.value = 'Describe the voice first — that description is the whole voice.'
    return
  }
  if (voiceSource() === 'clone' && !draft.value.voice.vendorVoice) {
    voiceError.value = 'Paste a cloned voice ID, or upload a recording to build one.'
    return
  }
  voiceError.value = ''
  const said = await speak(
    TTS_AUDITION_TEXT,
    // 没保存过的新角色拿一个临时的 charId:浏览器那条路要它来挑固定的嗓子
    { charId: editingId.value || 'preview', voice: draft.value.voice, cfg: props.ttsConfig },
    AUDITION_ID
  )
  // 退回浏览器声音是有原因的(没配、被拒、超时),那件事得说出来
  if (said) voiceError.value = said
}

/* —— 克隆 ——
   选一段录音,**顺手就把号建了**。为什么不拖到"保存"那一步:
   建号要几秒、还会被上游按套餐拒掉,放在保存里就变成"保存按钮卡几秒然后整份失败"。
   而按下文件那一刻建号,用户马上就能试听 —— 这才叫试。

   代价是"建了号又反悔":那段录音会留在库里没人认领(见 closeWizard 的清理)。
   上游那个号留着不花钱 —— 上游是**首次拿它合成**才收音色槽位费 */
const cloneBusy = ref(false)
const cloneError = ref('')

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(new Error('Could not read that file'))
    reader.readAsDataURL(file)
  })
}

/* 样本上限与上游一致(10MB),这里收到 8MB。上限是对着 base64 定的 ——
   整份要过服务端那道 15mb 的 JSON 闸,而 base64 会涨到约 1.34 倍 */
const MAX_SAMPLE_BYTES = 8 * 1024 * 1024

async function onVoiceSample(e: Event) {
  const el = e.target as HTMLInputElement
  const file = el.files?.[0]
  // 清空 input:同一个文件选第二次也要能触发 change
  el.value = ''
  if (!file) return
  if (!file.type.startsWith('audio/')) {
    cloneError.value = 'That file is not audio.'
    return
  }
  if (file.size > MAX_SAMPLE_BYTES) {
    cloneError.value = 'That recording is too large (max 8MB).'
    return
  }
  const cfg = props.ttsConfig
  if (!cfg) {
    cloneError.value = 'Add a Voice config in Settings first.'
    return
  }
  cloneBusy.value = true
  cloneError.value = ''
  try {
    const data = await readAsDataUrl(file)
    const id = newVoiceId()
    const out = await cloneVoice(cfg, data, id, file.name)
    /* 样本先落库、号后写进表单:号指着样本,反过来写的话,
       中途失败会留下一个指向不存在样本的号 */
    await putVoiceSample({
      id,
      name: file.name,
      blob: file,
      bytes: file.size,
      createdAt: Date.now()
    })
    const v = draft.value.voice
    v.source = 'clone'
    v.vendorVoice = out.vendorVoice
    v.sampleId = id
    v.sampleName = file.name
  } catch (err) {
    cloneError.value = err instanceof Error ? err.message : 'Could not clone that voice'
  } finally {
    cloneBusy.value = false
  }
}

/* 这一轮里**已经存下去过**的样本 id。克隆是按下文件那一刻就落库的,
   所以"取消"必须分清两件事:这一段录音已经属于某个角色了,还是只是个草稿。
   光看 editingId 不够 —— 新建流程第一步存完之后 editingId 仍是空的 */
let committedSampleId = ''

/** 丢掉这一轮建出来、却没人认领的那段录音。
 *  留着它没有任何用处,而它是**用户的录音**,更该清掉 */
async function dropOrphanVoiceSample() {
  const staged = draft.value.voice.sampleId
  if (!staged || staged === committedSampleId) return
  draft.value.voice.sampleId = undefined
  draft.value.voice.sampleName = undefined
  await deleteVoiceSample(staged)
}

/** 手动改 Voice ID = 这个号是用户自己带进来的,与刚才可能上传过的那段录音无关。
 *  所以把指向样本的那两样撤掉:名字留着会显示成"这个号来自那段录音"(不实),
 *  而样本本身也没人认领了 —— 那是用户的录音,比占空间更该清掉。
 *
 *  已经保存过的样本不动(committedSampleId):编辑一个现有角色时,
 *  那份样本仍是它自己的,撤引用可以,删掉就越界了 */
function onCloneIdTyped() {
  const v = draft.value.voice
  if (!v.sampleId) return
  const stale = v.sampleId
  v.sampleId = undefined
  v.sampleName = undefined
  if (stale !== committedSampleId) void deleteVoiceSample(stale)
}

/** 详情页那份只读的嗓音摘要。空字段不摆出来 ——
 *  与 personaRows 同一条规矩,没填就是没填,不占一行 */
function voiceRows(c: Character) {
  const v = { ...emptyCharVoice(), ...(c.voice || {}) }
  if (v.engine !== 'tts') return [{ label: 'Engine', value: 'Browser voice' }]
  const rows = [
    { label: 'Engine', value: 'Custom voice' },
    {
      label: 'Source',
      value:
        v.source === 'clone'
          ? v.sampleName
            ? 'Cloned from a recording'
            : 'Cloned voice'
          : v.source === 'describe'
            ? 'Described in words'
            : 'Built-in voice'
    }
  ]
  if (v.source === 'clone') {
    rows.push({ label: 'Voice ID', value: v.vendorVoice || '' })
    if (v.sampleName) rows.push({ label: 'Sample', value: v.sampleName })
  } else if (v.source === 'describe') {
    rows.push({ label: 'Description', value: v.describe || '' })
  } else {
    rows.push({ label: 'Voice ID', value: v.vendorVoice || '' })
  }
  return rows.filter((r) => r.value.trim())
}

/* 详情页也能试听:刚建好的角色,第一件想做的事就是听听它什么嗓子 */
async function auditionChar(c: Character) {
  const id = `audition:${c.id}`
  if (speakingId.value === id) {
    stopSpeaking()
    return
  }
  const said = await speak(
    TTS_AUDITION_TEXT,
    { charId: c.id, voice: c.voice, cfg: props.ttsConfig },
    id
  )
  if (said) voiceError.value = said
}
</script>

<template>
  <div class="chars">
    <!-- —— 列表 —— -->
    <template v-if="!detailChar">
      <header class="chars-head">
        <!-- 页面名不在这儿写第二遍:顶部横条的字标已经在说"Characters" -->
        <p class="chars-sub">
          A fixed spec plus a set of reference views. Pick a character while composing and both are
          applied, so the face stays the same across images.
        </p>
        <!-- 导入放页头:它是一次针对整个角色区的动作(一个包里可能有多个角色),
             不属于某一张卡。按钮用 <button> 触发那个隐藏 input 而不是用 label ——
             label 本身进不了 Tab 键序,键盘用户就点不到 -->
        <div v-if="!editing" class="chars-acts">
          <button class="chars-import" @click="importInput?.click()">
            <PhUploadSimple aria-hidden="true" />
            Import
          </button>
          <button class="chars-new" @click="startEdit()">
            <PhPlus aria-hidden="true" />
            New character
          </button>
        </div>
      </header>

    </template>

    <!-- 浮层**不能待在列表那个分支里**:它要在两个地方都能开 —— 列表页的
         "New character" 和详情页的 "Edit"。原先它嵌在 `v-if="!detailChar"`
         的列表分支内,于是从详情页点 Edit 时它根本不在 DOM 里(点了没反应)。
         所以这里把列表分支切成两段,让浮层落在中间、两个分支之外 -->

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
        :aria-label="isEditing ? 'Edit character' : 'New character'"
        tabindex="-1"
      >
        <!-- 编辑态没有三步可走:设定改完就回详情,出图那两步是另一件事。
             摆一条点不动的步骤条只会让人以为还要走下去 -->
        <div v-if="isEditing" class="wz-edit-head">
          <h3 class="wz-edit-title">Edit {{ editingChar?.name }}</h3>
          <p class="wz-edit-sub">
            The spec is what every image of this character is built from — the reference views
            stay as they are.
          </p>
        </div>
        <nav v-else class="wz-steps" aria-label="Creation steps">
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
              <!-- 圆点里放这一步的图标,不写序号:
                   旁边就是这一步的名字,一枚图标比一个数字更早被认出来,
                   而三枚图标本身也把"从哪儿走到哪儿"画出来了。
                   做完的那枚换成对勾(图标的位置留给"已经过站"这件事)。
                   两枚都 aria-hidden —— 这一步叫什么,由旁边的 .wz-name 说 -->
              <span class="wz-dot">
                <PhCheck v-if="stepDone(s.n) && step !== s.n" weight="bold" aria-hidden="true" />
                <component :is="s.icon" v-else weight="bold" aria-hidden="true" />
              </span>
              <span class="wz-name">{{ s.label }}</span>
            </button>
          </template>
        </nav>

        <div class="wz-body">
          <!-- 右栏:这个角色"是什么"。左栏是此刻在做的事,右栏三步都在。
               DOM 里它排在信息区前面 —— 窄屏要把它落到信息区上面,
               row-reverse 才能既保住这个次序、又让宽屏时它落在右边

               为什么值得常驻:第 3 步要判断"这四张是不是同一个人",
               而原来那一屏上只有四张图 —— 设定与主视图都不在场,只能凭记忆比。
               第 1 步同样用得着:一句话起稿会一次填进所有栏位,
               这是一份"它到底读出了什么"的连读清单,不必在两组网格里来回找 -->
          <aside class="wz-rail" aria-label="Character summary">
            <!-- 主视图:第 3 步判断"这四张是不是同一个人"的基准。
                 第 2 步不放 —— 那一步的正文里就是它 -->
            <div v-if="step === 3 && wizardFront" class="wz-rail-shot">
              <img :src="coverSrc(wizardFront.data)" alt="" />
              <span class="wz-rail-shot-k">Main view</span>
            </div>

            <div class="wz-rail-head">
              <span class="wz-rail-name">{{ railName || 'Untitled' }}</span>
              <span v-if="railSub" class="wz-rail-sub">{{ railSub }}</span>
            </div>

            <!-- 只列填了的项:空项在左边那两组网格里已经有一栏了,
                 右栏再列一遍 "—" 只是把"还没填"重复一遍 -->
            <dl v-if="railRows.length" class="wz-rail-rows">
              <div v-for="r in railRows" :key="r.label" class="wz-rail-row">
                <dt class="wz-rail-k">{{ r.label }}</dt>
                <dd class="wz-rail-v">{{ r.value }}</dd>
              </div>
            </dl>
            <p v-else-if="!railSub" class="wz-rail-none">
              Nothing yet — fill the spec on the left, or let the model draft it from one line.
            </p>
          </aside>

          <!-- 第 1、2 步共用这一屏。第 1 步是"这个人是谁"(存下之前是可填的表单,
               存下之后换成只读摘要 —— 角色已经落库,再点一次只会多一个副本);
               第 2 步是"它听起来什么样",整组声音字段见下面那个 step === 2 -->
          <div v-if="step === 1 || step === 2" class="wz-pane wz-form">
            <template v-if="step === 1 && !wizardId">
              <!-- 起稿块是这一页的重点:大多数人是一句话起稿、再逐栏校对,
                   而不是从空白一栏栏手填。所以它拿的是整张卡上唯一一块"区域"待遇,
                   并且自带标题与引导语 —— 标题问的是人,不是这个工具;
                   引导语只说"一句话就能开工、出来的东西还能改",
                   不描述机器在背后做什么(原来那句 "Fills the name and the spec —
                   check what it got wrong" 就是后一种,读起来像说明书)。
                   报错与状态仍旧留在这块里,离触发它的按钮最近。
                   起稿中整块走等待态光晕:光晕只能画在能放伪元素的元素上,
                   而 textarea 是替换元素、::after 不生效,所以挂在这块上 ——
                   它正是这次起稿要交付的那一件东西 -->
              <!-- 起稿块只在新建时给:编辑是"改几栏",不是"让模型重编一份" ——
                   摆在这里会变成一个大号的"覆盖我刚写的东西" -->
              <div v-if="!isEditing" class="wz-draft" :class="{ 'halo-breathe': drafting }">
                <div class="wz-draft-head">
                  <h3 class="wz-draft-title">Who are you creating?</h3>
                  <p class="wz-draft-sub">
                    A sentence, a vibe, a half-formed idea — start anywhere. The details below
                    are only a starting point.
                  </p>
                </div>
                <!-- 这一栏收的是"一个人的样子",不是一个词,所以给的是一个 textarea:
                     两行起步、随内容长高(见 vGrow),写满一句不用横向滚动;
                     长到 6 行封顶,再多转内部滚动(见 textarea.wz-idea) -->
                <textarea
                  v-model="idea"
                  v-grow
                  rows="2"
                  class="ed-input wz-idea"
                  aria-label="Describe the character"
                  placeholder="A retired sea captain in her sixties, sun-beaten and quiet"
                  @keydown.enter="onIdeaEnter"
                ></textarea>
                <!-- 提示/报错占左边的余量,主按钮靠右钉住 —— 没有提示时按钮也不动位置 -->
                <div class="wz-draft-foot">
                  <p v-if="draftError" class="wz-err" role="alert">{{ draftError }}</p>
                  <p v-else-if="drafting" class="wz-draft-hint">Filling in the spec…</p>
                  <!-- 有标出来的栏时换成图例。图例放在这里而不是各组的说明里:
                       标记是这一块产生的,而且两组里都可能有 —— 挂在哪一组都是偏的 -->
                  <p v-else-if="hasAiFilled" class="wz-draft-hint">
                    <span class="wz-ai" aria-hidden="true"></span>
                    written by the model — the dot clears once you edit that line
                  </p>
                  <button
                    class="ed-btn primary"
                    :disabled="drafting || !idea.trim()"
                    @click="draftWithAI"
                  >
                    <PhSparkle aria-hidden="true" />
                    {{ drafting ? 'Drafting…' : hasSpec ? 'Draft again' : 'Draft the spec' }}
                  </button>
                </div>
              </div>

              <!-- 基础信息:全表仅有的两条必填,而且都是"这个人是谁"的一部分 ——
                   姓名是给这张卡的,性别是给模型定脸的第一道条件。
                   它们和下面的 Spec / Reference sheet only 是平级的一组,
                   所以同样有组标题。

                   必填靠字段名后面那枚星号,不写 "Required" 这个词:
                   "Required" 有八九个字符,挂在 88px 的标签列里会把
                   放得下的行和放不下的行推成两种版式,而且一路念下来,
                   到第二行它就不再是信息、只是噪音了(见 .wz-mark)。
                   星号给读屏留了 aria-hidden,必填这件事由控件自己的
                   aria-required 说 —— 语义不走装饰

                   性别给按钮而不是输入框:模型只认 female / male 这两个词,
                   留一栏自由文字等于又把这件事交回给它去猜 -->
              <div class="wz-group">
                <div class="wz-group-head">
                  <h4 class="wz-group-title">Basics</h4>
                  <span class="wz-group-hint">
                    The name on the card, and the word the model uses to place a face.
                  </span>
                </div>

                <div class="wz-basics">
                  <label class="wz-field">
                    <span class="wz-label">
                      Name
                      <span class="wz-mark" aria-hidden="true">*</span>
                    </span>
                    <input
                      v-model="draft.name"
                      class="ed-input"
                      placeholder="Name this character"
                      aria-required="true"
                    />
                  </label>

                  <div
                    class="wz-field"
                    role="radiogroup"
                    aria-label="Gender"
                    aria-required="true"
                  >
                    <span class="wz-label">
                      Gender
                      <span class="wz-mark" aria-hidden="true">*</span>
                      <template v-if="aiFilled.gender">
                        <span class="wz-ai" aria-hidden="true"></span>
                        <span class="sr-only">drafted by the model</span>
                      </template>
                    </span>
                    <div class="wz-sex">
                      <label v-for="g in genderOptions" :key="g" class="wz-sex-opt">
                        <input
                          type="radio"
                          name="char-gender"
                          :checked="draft.fields.gender.trim() === g"
                          @change="pickGender(g)"
                        />
                        <span class="wz-sex-cap">{{ g }}</span>
                      </label>
                    </div>
                  </div>
                </div>
              </div>

              <!-- 设定分成两组,各有自己的标题。
                   这条界线的分量值得一个标题:Spec 那一组会进你每一张成品,
                   Reference sheet only 那组只塑造设定图 ——
                   它是这份设定里最要紧的一条区分。
                   两组都由 FORM_GROUPS 生成,栏位的模板只写一遍 -->
              <div v-for="g in FORM_GROUPS" :key="g.title" class="wz-group">
                <div class="wz-group-head">
                  <h4 class="wz-group-title">{{ g.title }}</h4>
                  <span class="wz-group-hint">{{ g.hint }}</span>
                </div>

                <div class="wz-fields">
                  <label v-for="f in g.fields" :key="f.key" class="wz-field">
                    <!-- 不标星号 = 可选。全表只有姓名与性别要标,
                         所以"可选"不必再写一遍(见 .wz-mark 那条注释) -->
                    <span class="wz-label">
                      {{ f.label }}
                      <template v-if="aiFilled[f.key]">
                        <span class="wz-ai" aria-hidden="true"></span>
                        <span class="sr-only">drafted by the model</span>
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

                  <!-- 备注不进 CharacterFields(它是自由文本,不参与起稿的那份固定行),
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

              <!-- 人格:第三组,但它与前两组不是一类东西 ——
                   那两组决定每张图长什么样,这一组只在对话里起作用。
                   所以标题不叫 "Spec",也点明它不会进出图提示词。
                   标题用 Personality 而不是 Voice:Voice 归嗓音(听得到的那个),
                   见 PERSONA_FIELDS 上面的注释 -->
              <div class="wz-group">
                <div class="wz-group-head">
                  <h4 class="wz-group-title">Personality</h4>
                  <span class="wz-group-hint">
                    Who they are and how they talk. Used in Chat only — never in your prompts.
                  </span>
                </div>

                <div class="wz-fields">
                  <label v-for="f in PERSONA_FIELDS" :key="f.key" class="wz-field">
                    <span class="wz-label">
                      {{ f.label }}
                      <!-- 起稿也会填这四栏,所以这里的标记规矩与前两组一致 -->
                      <template v-if="aiFilled[f.key]">
                        <span class="wz-ai" aria-hidden="true"></span>
                        <span class="sr-only">drafted by the model</span>
                      </template>
                    </span>
                    <textarea
                      v-grow
                      rows="1"
                      v-model="draft.persona[f.key]"
                      class="ed-input"
                      :placeholder="f.hint"
                      @input="markEdited(f.key)"
                    ></textarea>
                  </label>
                </div>
              </div>

            </template>

            <!-- 第 2 步:声音。它自成一屏 —— 上面那些字段回答"这个人是谁",
                 这一组回答"它听起来什么样"。两者没有先后依赖,
                 但堆在同一屏里会让信息量翻倍,而这一组本身就比别的组复杂
                 (两层选择 + 输入 + 试听)。
                 代码留在原地、只在这里切一刀:整块挪走的话,那 170 行的
                 缩进与顺序全要重排,而它本来就在这儿不需要动 -->
            <template v-if="step === 2">
              <!-- 嗓音:朗读时它听起来什么样。与上面那组人格字段是两件事 ——
                   那边是**文字**(话怎么说出来),这里是**声音本身** -->
              <div class="wz-group">
                <div class="wz-group-head">
                  <h4 class="wz-group-title">Voice</h4>
                  <span class="wz-group-hint">
                    How it sounds when read aloud. Used in Chat only — never in your prompts.
                  </span>
                </div>

                <!-- 这一组的东西比别处多(两层选择 + 输入 + 动作),而且形状和
                     上面那些"行"完全不是一回事。直接铺在表单里就会和它们糊成
                     一片 —— 给它一块自己的底,是这里唯一的边界手段 -->
                <div class="voice-panel">
                  <div class="voice-block">
                    <span class="voice-cap">Engine</span>
                    <div class="voice-seg" role="group" aria-label="Voice engine">
                      <button
                        type="button"
                        :class="{ on: draft.voice.engine === 'browser' }"
                        :aria-pressed="draft.voice.engine === 'browser' ? 'true' : 'false'"
                        @click="draft.voice.engine = 'browser'"
                      >
                        Browser voice
                      </button>
                      <button
                        type="button"
                        :class="{ on: draft.voice.engine === 'tts' }"
                        :aria-pressed="draft.voice.engine === 'tts' ? 'true' : 'false'"
                        @click="draft.voice.engine = 'tts'"
                      >
                        Custom voice
                      </button>
                    </div>
                    <p class="voice-note">
                      {{
                        draft.voice.engine === 'browser'
                          ? 'Played by your system’s own voices. Free and instant — different characters just get different voices.'
                          : !ttsConfig
                            ? 'Needs a config first: open Interface Settings, add one with the purpose “Voice”. Base URL, API key and Resource ID all live there.'
                            : 'Synthesised by your voice provider. Slower and billed per character, but this is the character’s own voice.'
                      }}
                    </p>
                  </div>

                  <template v-if="draft.voice.engine === 'tts'">
                    <div class="voice-block">
                      <span class="voice-cap">Voice source</span>
                      <div class="voice-seg" role="group" aria-label="Voice source">
                        <button
                          v-for="s in VOICE_SOURCES"
                          :key="s.id"
                          type="button"
                          :class="{ on: voiceSource() === s.id }"
                          :aria-pressed="voiceSource() === s.id ? 'true' : 'false'"
                          @click="setVoiceSource(s.id)"
                        >
                          {{ s.label }}
                        </button>
                      </div>
                      <!-- 选完这一档接着要做什么,就写在这排键底下 —— 三档的入口
                           长得一样(都是一个输入框),差别全在这句话里 -->
                      <p class="voice-note">{{ voiceSourceHint }}</p>
                    </div>

                    <!-- 要填的那一格。上面全是灰字与胶囊,这里画了整组唯一的框 ——
                         "哪些是要填的"由这个框说,不再靠一句提示 -->
                    <div class="voice-block">
                      <label v-if="voiceSource() === 'preset'" class="voice-field">
                        <span class="voice-label">Voice ID</span>
                        <span class="voice-control">
                          <input
                            v-model="draft.voice.vendorVoice"
                            class="ed-input"
                            spellcheck="false"
                            placeholder="e.g. zh_female_vv_uranus_bigtts"
                          />
                        </span>
                        <span class="voice-hint">
                          The ID, not the display name. If it looks like <em>S_xxxxxxxx</em>
                          or a custom name, that is a cloned voice — use the Clone slot.
                        </span>
                      </label>

                      <label v-else-if="voiceSource() === 'describe'" class="voice-field">
                        <!-- 这一档**不需要底子音色**。上游那条"音频生成"的纯文本模式
                             什么都不用给 —— 一段描述就是全部输入(见 server 的 ttsDesignPrompt)。
                             曾经误按"音色设计"那条端点实现过,那条要一个买过的底子音色,
                             界面上因此多出过一格 Voice ID,已经撤掉 -->
                        <span class="voice-label">Description</span>
                        <span class="voice-control">
                          <textarea
                            v-grow
                            rows="2"
                            v-model="draft.voice.describe"
                            class="ed-input"
                            placeholder="e.g. young male, bright and a little hoarse, fast, big pitch swings"
                          ></textarea>
                        </span>
                        <span class="voice-hint">
                          Sound words only — age, pitch, pace, texture, mood.
                          <em>This description is the voice.</em>
                        </span>
                      </label>

                      <template v-else>
                        <!-- 复刻音色有两条来路,而它们是**并列**的,不是二选一:
                             号已经在手(控制台自己复刻过)就直接填;没有就上传一段录音当场建。
                             上传建完会把号回填到下面这一格,所以两条路的终点是同一个字段 -->
                        <label class="voice-field">
                          <span class="voice-label">Voice ID</span>
                          <span class="voice-control">
                            <input
                              v-model="draft.voice.vendorVoice"
                              class="ed-input"
                              spellcheck="false"
                              placeholder="e.g. S_xxxxxxxx"
                              @input="onCloneIdTyped"
                            />
                          </span>
                          <span class="voice-hint">
                            A cloned ID looks like <em>S_xxxxxxxx</em> or a custom name. If it
                            looks like <em>zh_female_…_bigtts</em>, that is a built-in voice —
                            use the Built-in slot.
                          </span>
                        </label>

                        <div class="voice-field">
                          <span class="voice-label">Recording</span>
                          <div class="voice-clone">
                            <label class="ed-btn file">
                              <PhUploadSimple aria-hidden="true" />
                              {{ cloneBusy ? 'Cloning…' : 'Choose a recording' }}
                              <input
                                type="file"
                                accept="audio/*"
                                hidden
                                :disabled="cloneBusy"
                                @change="onVoiceSample"
                              />
                            </label>
                            <span v-if="draft.voice.sampleName" class="voice-sample">
                              {{ draft.voice.sampleName }}
                            </span>
                          </div>
                          <span v-if="cloneError" class="voice-err" role="alert">{{ cloneError }}</span>
                          <span v-else class="voice-hint">
                            10–60s, one speaker, no music. Registering is free — billing only starts
                            when you first speak with it.
                          </span>
                        </div>
                      </template>

                      <div class="voice-audition">
                        <button type="button" class="ed-btn" @click="auditionVoice">
                          <PhStopCircle v-if="auditioning" aria-hidden="true" />
                          <PhSpeakerHigh v-else aria-hidden="true" />
                          {{ auditioning ? 'Stop' : 'Hear it' }}
                        </button>
                      </div>
                      <p v-if="voiceError" class="voice-err" role="alert">{{ voiceError }}</p>
                    </div>
                  </template>
                </div>
              </div>

            </template>

            <template v-if="step === 1 && !wizardId">
              <!-- 参考图:比文字更能定形状,但是可选的,所以放在最后 -->
              <div class="wz-group">
                <div class="wz-group-head">
                  <h4 class="wz-group-title">Reference image</h4>
                </div>

                <!-- 空态与有图态占同样的高度:挑完图不该整块往上跳一下。
                     编辑态一来就有图(库里那张),所以判条件要把 editRefSrc 也算上 -->
                <div v-if="draft.ref || editRefSrc" class="wz-ref-wrap">
                  <!-- 读取中整行走那圈金色呼吸光晕(与起稿块同一套):
                       机器在动这件事,靠"框外的光"说出来,框本身不动。
                       光晕的定位基准就是这一行(见样式里的 position: relative) -->
                  <div class="wz-ref" :class="{ 'halo-breathe': visionBusy }">
                    <img
                      class="wz-ref-thumb"
                      :src="draft.ref || editRefSrc"
                      alt="Reference image"
                    />
                    <span class="wz-ref-body">
                      <span class="wz-ref-main">Reference image</span>
                      <span class="wz-ref-hint">
                        {{
                          isEditing
                            ? 'The starting point for this character’s faces'
                            : 'Applied on top of the spec when generating'
                        }}
                      </span>
                    </span>
                    <!-- 编辑态只能换、不能删:底图是其余四张设定图的一张参考资料,
                         删掉它那些图就失去了"原本是什么样子"这一半信息。
                         移除有它自己的场合(还没出过图时),那种场合在新建那一步 -->
                    <label v-if="isEditing" class="ed-btn" for="cp-file">Replace</label>
                    <button v-else class="ed-btn" @click="clearRef">Remove</button>
                  </div>

                  <!-- 识图那一行:图与上面那份设定之间的桥。
                       在跑 / 跑过 / 跑失败都用取景框 + 秒表 ——
                       与出图、起稿两处的等待态是同一样东西,只是换了个动词。
                       没配识图接口时不说"失败",而是给出下一步 ——
                       图本身当参考照常用得着,只是不会反填 -->
                  <div v-if="!isEditing" class="wz-scan">
                    <div class="wz-scan-main">
                      <LatticeLoader
                        v-if="visionRan"
                        :label="'Reading the image'"
                        :done-label="'Read in'"
                        :error-label="'Failed after'"
                        :status="visionLoader"
                        :font-size="12"
                      />
                      <p v-else-if="!visionConfig" class="wz-scan-hint">
                        Add an image-recognition config in API settings to read the spec from this image.
                      </p>
                      <p v-else class="wz-scan-hint">
                        Read the spec straight from this image — the fields above fill in from it.
                      </p>
                      <!-- 填完得说清"上面变了":这一行在表单最底下,
                           用户未必回头看一眼那两组输入框 -->
                      <p v-if="visionRead && !visionBusy && !visionError" class="wz-scan-hint">
                        Filled the spec above — the dots mark what it read.
                      </p>
                      <p v-if="visionError" class="wz-scan-err" role="alert">{{ visionError }}</p>
                    </div>
                    <button
                      v-if="visionConfig && !visionBusy"
                      class="ed-btn"
                      type="button"
                      @click="draftFromImage"
                    >
                      <PhSparkle aria-hidden="true" />
                      {{ visionRead ? 'Read again' : 'Read the spec' }}
                    </button>
                  </div>
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

            <!-- 条件里必须带 step === 1:上面那三个 v-if 是各自独立的,
                 少了它,走到第 2 步时这里会当作"第 1 步的另一半"一起渲染,
                 于是声音那一屏下面会多出一块第 1 步的只读摘要 -->
            <template v-else-if="step === 1 && wizardChar">
              <!-- 存下之后这一步就没有可填的了(再点一次保存只会多一个副本),
                   所以不再重复名字与那份设定 —— 右栏就在同一屏上,列两遍是同一份东西。
                   这里只剩一句交接:设定从这一刻起归右栏,而下一步会拿什么当输入 -->
              <h3 class="wz-h">Saved</h3>
              <p class="wz-p">
                The spec is on the right from here on — it is what every view, and every image you
                generate with this character, is built from. Nothing left to fill on this step.
              </p>
              <div v-if="wizardChar.ref" class="wz-ref">
                <img class="wz-ref-thumb" :src="coverSrc(wizardChar.ref)" alt="" />
                <span class="wz-ref-body">
                  <span class="wz-ref-main">Reference image</span>
                  <span class="wz-ref-hint">The front view will be built from it</span>
                </span>
              </div>
            </template>
          </div>

          <!-- 第 2 步:主视图。它是整条流水线的锚,其余四张都照它生成。
               左图右事:空态、生成中、已有图共用同一个框,所以点下去之后画面不跳。
               右边那一栏回答两件这一屏最该说清的事 ——
               它会拿哪张图当参考,以及"接下来该点哪里" -->
          <!-- 第 3 步:设定图。一屏两轮 —— 先出正脸(它是基准),再出其余四张。
               原来这是两步,而它们本来就是同一件事的两半:"先定基准、再照它长"
               那句话说了两遍,中间还隔着一次点按 -->
          <div v-else class="wz-pane">
            <div class="wz-lead">
              <h3 class="wz-h">Views</h3>
              <p class="wz-p">
                Two rounds. The main view comes first — it is the anchor every other view is built
                from, so it pays to get it right before moving on.
              </p>
            </div>

            <div class="wz-hero">
              <div class="wz-hero-shot">
                <div class="cell">
                  <!-- 生成中:整格换成停止入口,与详情页那排设定图同一套 -->
                  <button
                    v-if="isBusy(wizardId, 'front')"
                    class="cell-img is-busy"
                    :class="{ 'has-img': !!wizardFront }"
                    aria-label="Stop generating the main view"
                    @click="emit('stopView', wizardId, 'front')"
                  >
                    <img v-if="wizardFront" :src="coverSrc(wizardFront.data)" alt="" />
                    <span class="cell-busy" aria-hidden="true">
                      <span class="cell-busy-stop"></span>
                    </span>
                  </button>
                  <button
                    v-else-if="wizardFront"
                    class="cell-img has-img"
                    aria-label="Regenerate the main view"
                    @click="emit('generate', wizardId, 'front')"
                  >
                    <img :src="coverSrc(wizardFront.data)" alt="" />
                    <span class="cell-zoom" aria-hidden="true"><PhArrowsClockwise /></span>
                  </button>
                  <button
                    v-else
                    class="cell-img start"
                    aria-label="Generate the main view"
                    @click="emit('generate', wizardId, 'front')"
                  >
                    <span class="cell-ph" aria-hidden="true">+</span>
                  </button>
                  <span class="cell-label">{{ isBusy(wizardId, 'front') ? 'Generating…' : 'Front' }}</span>
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
                  :disabled="isBusy(wizardId, 'front')"
                  @click="emit('generate', wizardId, 'front')"
                >
                  <PhSparkle v-if="!isBusy(wizardId, 'front')" aria-hidden="true" />
                  {{
                    isBusy(wizardId, 'front')
                      ? 'Generating…'
                      : wizardFront
                        ? 'Regenerate'
                        : 'Generate main view'
                  }}
                </button>
              </div>
            </div>

            <!-- 四张那一排:说明与"一次补齐"并排 —— 它们讲的是同一件事,
                 这批图从主视图长出来,而且可以一次全出。
                 主视图还没出时按钮点不动:没有基准,那四张就没有依据 -->
            <div class="wz-lead-row">
              <p class="wz-p">
                Each of these is built from the main view. Generate them one at a time, or all at
                once — failing early stops the run instead of burning four more calls.
              </p>
              <button
                class="ed-btn"
                :disabled="!restMissing || frontBusy(wizardId) || !wizardFront"
                @click="emit('generateAll', wizardId)"
              >
                <PhSparkle aria-hidden="true" />
                {{ restLabel }}
              </button>
            </div>

            <div class="wz-grid">
              <div
                v-for="cell in wizardRest"
                :key="cell.kind"
                class="cell"
                :class="{ 'is-portrait': cell.framing === 'portrait' }"
              >
                <!-- 生成中:整格换成停止入口,与详情页那排设定图同一套 -->
                <button
                  v-if="isBusy(wizardId, cell.kind)"
                  class="cell-img is-busy"
                  :class="{ 'has-img': !!cell.view }"
                  :aria-label="`Stop generating the ${cell.label} view`"
                  @click="emit('stopView', wizardId, cell.kind)"
                >
                  <img v-if="cell.view" :src="coverSrc(cell.view.data)" alt="" />
                  <span class="cell-busy" aria-hidden="true">
                    <span class="cell-busy-stop"></span>
                  </span>
                </button>
                <button
                  v-else-if="cell.view"
                  class="cell-img has-img"
                  :disabled="viewBlocked(wizardId, cell.kind)"
                  :aria-label="`Regenerate the ${cell.label} view`"
                  @click="emit('generate', wizardId, cell.kind)"
                >
                  <img :src="coverSrc(cell.view.data)" alt="" />
                  <span class="cell-zoom" aria-hidden="true"><PhArrowsClockwise /></span>
                </button>
                <button
                  v-else
                  class="cell-img"
                  :disabled="viewBlocked(wizardId, cell.kind)"
                  :aria-label="`Generate the ${cell.label} view`"
                  @click="emit('generate', wizardId, cell.kind)"
                >
                  <span class="cell-ph" aria-hidden="true">+</span>
                </button>
                <span class="cell-label">{{
                  isBusy(wizardId, cell.kind) ? 'Generating…' : cell.label
                }}</span>
              </div>
            </div>
          </div>
        </div>

        <div class="wz-foot">
          <button
            v-if="step === 1 && !wizardId"
            class="ed-btn primary"
            :disabled="!draft.name.trim() || !draft.fields.gender.trim()"
            @click="submit"
          >
            {{ isEditing ? 'Save' : 'Save & continue' }}
          </button>
          <button v-else-if="step === 1" class="ed-btn primary" @click="goStep(2)">
            Next: voice
          </button>
          <!-- 声音那一步没有非填不可的东西(不配就是系统自带的嗓子),所以这里的
               按钮一直是主按钮。但它**必须存一下**:嗓音是随角色存在库里的,
               不存就白填了 —— 而进到这一步时角色早就在库里(第 1 步存的),
               所以这是一次"更新",得走 saveFromVoiceStep(见那边的说明) -->
          <button v-else-if="step === 2" class="ed-btn primary" @click="saveFromVoiceStep(3)">
            Save & continue
          </button>
          <!-- 最后一步的收尾。主按钮永远只该有一个:还没有正脸时,主按钮是卡身里
               那个"Generate main view"(见那边的条件 class),Done 退一档;
               出了正脸才轮到它。两个都涂黑会让"接下来做什么"变得含糊 -->
          <button v-else class="ed-btn" :class="{ primary: !!wizardFront }" @click="finishWizard">
            Done
          </button>

          <button v-if="step > 1" class="ed-btn" @click="backStep">Back</button>
          <button class="ed-btn" @click="closeWizard">
            {{ step === 1 && !wizardId ? 'Cancel' : 'Close' }}
          </button>
        </div>
      </section>

      <!-- 列表接着上面被切开的那一段继续(见浮层之前那段说明) -->
      <template v-if="!detailChar">

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
              <img
                v-if="coverOf(c)"
                :src="coverSrc(coverOf(c))"
                alt=""
                loading="lazy"
                decoding="async"
              />
              <span v-else class="ctile-ph" aria-hidden="true">
                <PhMaskHappy />
              </span>
            </span>

            <!-- 文本贴底排列。毛玻璃与暗幕都是这一层自己的 ::before(见样式),
                 所以玻璃永远贴着信息区,和卡片多大无关。
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
              <button class="mitem" role="menuitem" @click.stop="editFromCard(c.id)">
                <PhPencilSimple aria-hidden="true" />Edit
              </button>
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
        <button class="ed-btn primary" @click="startEdit()">Create a character</button>
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
          <!-- 编辑排在最前:改一个已有的比复制一个更常做,而它也是进向导的唯一入口 -->
          <button class="dt-act" @click="startEdit(detailChar)">
            <PhPencilSimple aria-hidden="true" />
            Edit
          </button>
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

      <!-- 身份区:一张卡把"这是谁、进行到哪、能做什么"说全。
           主视觉用**正脸那张大图**,而不是一枚小圆头像 —— 88px 的圆是
           "通讯录条目"的形状,而这一页要看起来像一个人。
           3:4 与列表里的角色卡同一个比例:这一页就是那张卡"打开之后"的样子,
           同一个人该是同一个形状,只是尺寸大了一档 -->
      <header class="hero">
        <div class="hero-shot">
          <img v-if="avatarSrc" :src="avatarSrc" alt="" />
          <PhMaskHappy v-else aria-hidden="true" />
        </div>
        <div class="hero-body">
          <h2 class="hero-name">{{ detailChar.name }}</h2>
          <p v-if="heroSub(detailChar)" class="hero-sub">{{ heroSub(detailChar) }}</p>
          <!-- 用量:这个角色到底干了多少活。放在设定摘要下面、标签上面 ——
               它比"几张图"更像这个角色的成绩单 -->
          <p class="hero-meta">
            <span v-for="m in heroMeta" :key="m">{{ m }}</span>
          </p>
          <div class="hero-tags">
            <span class="tag">{{ filledCount }} / {{ sheetCells.length }} views</span>
            <span v-if="hasFront" class="tag tag-on">
              <PhEye weight="fill" aria-hidden="true" />
              Main view · Front
            </span>
            <span v-else class="tag">No main view yet</span>
          </div>

          <div class="hero-actions">
          <!-- 跟这个人说话。它比"补齐设定图"更常点,但这一页的主动作仍是补齐
               (那件事只有在这儿能做),所以这一枚用描边样式 —— 同一时刻
               只该有一个涂黑的主按钮,否则"下一步做什么"就含糊了 -->
          <button class="ed-btn hero-chat" @click="emit('chat', detailChar.id)">
            <PhChatCircleDots aria-hidden="true" />
            Chat
          </button>
          <!-- 生成中按钮自己也要说出来:它是刚才被点的那个,状态留在原地最容易被看到 -->
          <button
            class="ed-btn primary hero-cta"
            :disabled="!missingCount || frontBusy(detailChar.id)"
            @click="emit('generateAll', detailChar.id)"
          >
            <PhSparkle v-if="!detailBusy.length" aria-hidden="true" />
            {{ detailBusy.length ? `Generating ${busyLabel}…` : generateAllLabel }}
          </button>
          </div>
        </div>
      </header>

      <section class="panel">
        <div class="panel-head">
          <h3 class="panel-title">Reference sheet</h3>
          <!-- 生成中就把说明换成进度:在标题旁边,是这一屏视线必经的位置。
               放在网格下面用一行小字写"Generating…"几乎等于没写 -->
          <LatticeLoader
            v-if="detailBusy.length"
            class="panel-progress"
            :label="`Generating ${busyLabel}`"
            :font-size="12"
          />
          <span v-else class="panel-note">
            {{
              hasFront
                ? detailChar.sourceRef
                  ? 'Every other view is built from the front view and your reference image.'
                  : 'Every other view is built from the front view.'
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
            :class="{ 'is-ref': isMainView(cell.kind), 'is-portrait': cell.framing === 'portrait' }"
          >
            <!-- 正在跑的那一张:整格换成"停止"入口。
                 原来只有空格子有生成中的样式,而重跑一张已经有的图时
                 格子和平时长得一模一样 —— 看不出在跑,也没地方停 -->
            <button
              v-if="isBusy(detailId, cell.kind)"
              class="cell-img is-busy"
              :class="{ 'has-img': !!cell.view }"
              :aria-label="`Stop generating the ${cell.label} view`"
              @click="emit('stopView', detailId, cell.kind)"
            >
              <img v-if="cell.view" :src="coverSrc(cell.view.data)" alt="" />
              <span class="cell-busy" aria-hidden="true">
                <span class="cell-busy-stop"></span>
              </span>
            </button>
            <button
              v-else-if="cell.view"
              class="cell-img has-img"
              :aria-label="`View ${cell.label}`"
              @click="openViewer(cell.kind)"
            >
              <img :src="coverSrc(cell.view.data)" alt="" />
              <span class="cell-zoom" aria-hidden="true"><PhArrowsOutSimple /></span>
              <span v-if="isMainView(cell.kind)" class="cell-mark" title="Main view">
                <PhEye weight="fill" aria-hidden="true" />
              </span>
            </button>
            <button
              v-else
              class="cell-img"
              :class="{ locked: isLocked(cell.kind), start: cell.kind === 'front' }"
              :disabled="isLocked(cell.kind) || viewBlocked(detailId, cell.kind)"
              :aria-label="
                isLocked(cell.kind)
                  ? `${cell.label} view — generate the front view first`
                  : viewBlocked(detailId, cell.kind)
                    ? `${cell.label} view — waiting for the main view`
                    : `Generate ${cell.label} view`
              "
              @click="emit('generate', detailChar.id, cell.kind)"
            >
              <PhLockSimple v-if="isLocked(cell.kind)" class="cell-lock" aria-hidden="true" />
              <span v-else class="cell-ph" aria-hidden="true">+</span>
            </button>

            <span class="cell-label">{{
              isBusy(detailId, cell.kind) ? 'Generating…' : cell.label
            }}</span>
          </div>
        </div>

      </section>

      <!-- 用这个角色出过的图。排在设定图之后:上面是"材料",这里是"产出"。
           图来自历史记录(按 characterId 归拢,见 App 的 charWorks),
           点开走的是与历史图墙、首页图砖同一个预览入口 -->
      <section v-if="works.length" class="panel">
        <div class="panel-head">
          <h3 class="panel-title">Made with this character</h3>
          <span class="panel-note">
            {{ works.length }} {{ works.length === 1 ? 'image' : 'images' }} · newest first
          </span>
        </div>
        <div class="works">
          <button
            v-for="w in worksShown"
            :key="w.key"
            class="work"
            :aria-label="`Open the image from ${fmtDay(w.entry.createdAt)}`"
            @click="emit('preview', w.entry)"
          >
            <img :src="workSrc(w)" alt="" loading="lazy" decoding="async" />
          </button>
        </div>
        <!-- 只摆最近这一批,其余的指个去处。不做"展开全部":
             这一页是看角色的,翻作品该去历史页 -->
        <p v-if="worksRest" class="works-more">{{ worksRest }} more in History.</p>
      </section>

      <!-- 三张资料表并排成一段"附录"(见 .dt-facts 的说明)。
           它们同等次要,所以每一张都得是个完整的卡:标题 + 一句话(说明它管哪一头) -->
      <div class="dt-facts">
      <section class="panel">
        <div class="panel-head">
          <h3 class="panel-title">Spec</h3>
          <span class="panel-note">Merged into every image you make.</span>
        </div>
        <dl class="spec">
          <template v-for="r in specRows(detailChar)" :key="r.label">
            <dt class="spec-k">{{ r.label }}</dt>
            <dd class="spec-v" :class="{ dim: !r.value }">{{ r.value || '—' }}</dd>
          </template>
        </dl>
      </section>

      <!-- 人格单独一段:上面那张表里的每一项都会进你每一张成品,
           这一段一项都不会 —— 它只在对话里起作用。混在同一张表里,
           用户会以为改"说话方式"也会改变出图。
           标题同向导那边:用 Personality,把 Voice 让给嗓音 -->
      <section class="panel">
        <div class="panel-head">
          <h3 class="panel-title">Personality</h3>
          <span class="panel-note">Used in Chat only — never merged into your prompts.</span>
        </div>
        <dl class="spec">
          <template v-for="r in personaRows(detailChar)" :key="r.label">
            <dt class="spec-k">{{ r.label }}</dt>
            <dd class="spec-v" :class="{ dim: !r.value }">{{ r.value || '—' }}</dd>
          </template>
        </dl>
      </section>

      <!-- 嗓音:与上面那段同一条理由(只在对话里起作用),
           但它比人格多一件事 —— 可以直接听。刚建好的角色,
           第一件想做的事就是听听它什么嗓子,所以这里给一枚试听键 -->
      <section class="panel">
        <div class="panel-head">
          <h3 class="panel-title">Voice</h3>
          <button type="button" class="ed-btn" @click="auditionChar(detailChar)">
            <PhStopCircle v-if="speakingId === `audition:${detailChar.id}`" aria-hidden="true" />
            <PhSpeakerHigh v-else aria-hidden="true" />
            {{ speakingId === `audition:${detailChar.id}` ? 'Stop' : 'Hear it' }}
          </button>
        </div>
        <dl class="spec">
          <template v-for="r in voiceRows(detailChar)" :key="r.label">
            <dt class="spec-k">{{ r.label }}</dt>
            <dd class="spec-v" :class="{ dim: !r.value }">{{ r.value || '—' }}</dd>
          </template>
        </dl>
        <p v-if="voiceError" class="voice-err" role="alert">{{ voiceError }}</p>
      </section>
      </div>
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
          <span class="viewer-head">
            <span class="viewer-label">{{ viewerLabel }}</span>
            <!-- 翻到第几张:图多于一屏时才有意义,一张时不摆 -->
            <span v-if="viewerPos.n > 1" class="viewer-pos">{{ viewerPos.i }} / {{ viewerPos.n }}</span>
          </span>
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

        <!-- 只剩下"重新生成"一个动作:设为主视图那件事没有了 ——
             主视图只能是正面,其余四张都是照它生的派生图,拿它们当主图会串脸 -->
        <div class="viewer-acts">
          <!-- 正在重跑这一张:原地把它换成"停止" -->
          <button
            v-if="isBusy(detailId, viewer)"
            class="ed-btn"
            @click="emit('stopView', detailId, viewer as CharacterViewKind)"
          >
            <span class="ed-stop" aria-hidden="true"></span>
            Stop
          </button>
          <button
            v-else
            class="ed-btn"
            :disabled="viewerRegenBlocked"
            @click="regenerateViewer"
          >
            <PhArrowsClockwise aria-hidden="true" />
            Regenerate
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
   这里是三张平级的卡,不是一张套三张:
     卡头  流程引导 —— 三步走到哪儿
     卡身  下方信息区域 —— 左边要填的表单 + 右边这个角色"是什么"(一张卡)
     卡脚  进退动作
   所以 .wizard 这一层自己不再是卡(无底色、无描边、无圆角、无影子),
   只是给这三张卡排版的一画布:三张卡之间、以及与视口之间,都隔 16px。
   原先是一张大卡包住三块 —— 那等于把"这是一层壳"和"这是三件事"
   同时说了,四道圆角一层层套下去还会越看越像弹窗套弹窗 */


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
  /* 卡头 / 卡身 / 卡脚三行。卡身(wz-body)自己再分两列:信息区 + 右栏。
     宽度比原来宽一档:右栏 248px 是从表单那边让出来的,
     不把卡放宽,两列字段每栏就只剩 230px 上下,一行放不下几个词 */
  display: flex;
  flex-direction: column;
  /* 三张卡之间 16px、外圈也是 16px —— 同一个档 */
  gap: var(--sp-4);
  padding: var(--sp-4);
  width: min(960px, calc(100% - 2 * var(--sp-4)));
  max-height: calc(100vh - 2 * var(--sp-4));
  /* 这一层不再是卡:没有底色、描边、圆角、影子。
     它只是一块排版用的画布 —— 三张卡各自"浮"在这上面 */
  background: none;
}
/* 卡身:信息区在左、右栏在右,两块各自滚。
   这一层用 flex 而不是 grid:卡片高度是内容决定的(auto + max-height),
   而 grid 的 1fr 行在容器高度不确定时会按内容撑开,撑开之后被 max-height 一夹,
   里面的 overflow 就不起作用了 —— 卡脚会被直接裁掉。flex 的 flex:1 + min-height:0
   在同一条件下是有保证的(这也正是改之前的样子)。
   DOM 里右栏排在前面,所以要 row-reverse 才落在右边;窄屏换成 column,
   它自然就到信息区上面去了 */
.wz-body {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: row-reverse;
  /* 第二张卡:下方信息区域。左边是此刻要填的东西,右边是这个角色"是什么" ——
     两块合成一张卡,而不是并排两张:它们是同一件事的两面
     (填进去的,与填成什么样了),拆成两张卡反而要读者自己把它们对起来 */
  border-radius: var(--r);
  background: var(--surface);
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.05), var(--sh-sm);
  /* 右栏那层 --bg 与两块的滚动内容都要被这张卡的圆角切齐 */
  overflow: hidden;
}
/* 步骤条:横向三步,中间用短线连起来。
   线点亮 = 前一步做完了 —— 进度不必靠读文字,余光扫一眼就知道走到哪 */
/* 编辑态的卡头:这一趟只有一步,摆一条点不动的步骤条只会让人以为还要走下去,
   所以换成一行字说清"在改谁"。占的是同一个位置,也同样是那张独立的卡 */
.wz-edit-head {
  flex: none;
  padding: 13px var(--sp-4);
  border-radius: var(--r);
  background: var(--surface);
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.05), var(--sh-sm);
}
.wz-edit-title {
  font-size: var(--fs-md);
  font-weight: 600;
  letter-spacing: var(--ls-tight);
  color: var(--text);
}
.wz-edit-sub {
  margin-top: 2px;
  font-size: var(--fs-xs);
  line-height: 1.5;
  color: var(--text-3);
}

/* 第一张卡:流程引导。间距全部由 .wizard 的 padding 与 gap 给,
   这儿不再自己写 margin —— 卡与卡的距离只该有一处定义 */
.wz-steps {
  flex: none;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px var(--sp-4);
  border-radius: var(--r);
  background: var(--surface);
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.05), var(--sh-sm);
}
/* 连接线:走过的那一段整条转成墨色 —— 它和左边那枚墨色圆点连成一段实心的墨,
   于是"走到哪儿了"不用读文字,一条深浅就看出来了。
   高度给到 2px 并做圆头:1px 的线在视网膜屏上几乎是一条影子,
   而这一条正是进度唯一的读数 */
.wz-line {
  flex: 1;
  height: 2px;
  border-radius: 2px;
  background: var(--line);
  transition: background var(--dur) var(--ease);
}
.wz-line.is-done {
  background: var(--accent);
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
/* 三态各占一档色深:当前(满墨)> 走过(--text-2)> 未到(--text-3) */
.wz-step.is-active {
  color: var(--text);
}
.wz-step.is-done {
  color: var(--text-2);
}
.wz-step:not(.is-active):not(:disabled):hover {
  color: var(--text);
}
.wz-step:not(.is-active):not(:disabled):hover .wz-dot {
  border-color: var(--text-3);
}
/* 圆点里装的是这一步的图标(见模板)。当前那枚实心墨 + 一圈淡墨晕;
   走过的收成一枚淡墨底的对勾;未到的只留一圈细描边 ——
   三样排在一起,顺序本身就看得出 */
.wz-dot {
  flex: none;
  width: 24px;
  height: 24px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--line-strong);
  border-radius: 50%;
  color: var(--text-3);
  transition: background var(--dur) var(--ease), border-color var(--dur) var(--ease),
    box-shadow var(--dur) var(--ease), color var(--dur) var(--ease);
}
/* 14px:图标要在 24px 的圆里留得出边距,又要认得清是什么 */
.wz-dot svg {
  width: 14px;
  height: 14px;
}
/* 当前这一步。只把它涂黑还不够 —— 三步并排时"现在在这儿"要有别的东西托着,
   所以在圆点外补一圈 accent-soft 的晕:它是这条线上唯一带光的东西 */
.wz-step.is-active .wz-dot {
  border-color: var(--accent);
  background: var(--accent);
  color: var(--accent-contrast);
  box-shadow: 0 0 0 4px var(--accent-soft);
}
.wz-step.is-done .wz-dot {
  border-color: transparent;
  background: var(--accent-soft);
  color: var(--text-2);
}
.wz-name {
  font-size: var(--fs-sm);
  font-weight: 500;
  white-space: nowrap;
}
.wz-step.is-active .wz-name {
  font-weight: 600;
}

/* 信息区:当前这一步的内容,间距 10px 一档。
   它就是那个滚动区 —— 卡自己不滚,滚的是这一层(见 .wz-body)。
   这一步的内容装不下时只有中间这段滑动,卡头卡脚不动,
   这才是"信息区域滚动"该有的样子。
   min-height:0 是关键:少了它 flex 子项不肯缩,滚动条根本出不来。
   内边距 12px 一档:下面每一行自己还有 12px 横向内边距,
   两层加起来 24px,正好是卡里那一档留白 */
.wz-pane {
  flex: 1;
  min-width: 0;
  min-height: 0;
  overflow-y: auto;
  /* 滚到底不再把滚动传给后面的页面 —— 否则滚过头会连背景一起滚走 */
  overscroll-behavior: contain;
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: var(--sp-3);
}

/* —— 右栏 ——
   这个角色"是什么",三步都在。左边是此刻在做的事,右边是这个人本身。
   它借用卡头卡脚那层 --bg:卡身于是被上下两条同色的边夹住,
   "这里是恒定的、那里是流动的"不必再靠标题去说(见模板里的注释) */
.wz-rail {
  flex: none;
  width: 248px;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
  /* 与信息区同档 12px:两块合在一张卡里,左右两边那一圈留白得一样宽 */
  padding: var(--sp-3);
  border-left: 1px solid var(--line);
  background: var(--bg);
}
/* 主视图缩略:第 3 步的比对基准 */
.wz-rail-shot {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.wz-rail-shot img {
  width: 100%;
  aspect-ratio: 1;
  object-fit: cover;
  border-radius: var(--r-sm);
  border: 1px solid var(--line);
  background: var(--image-bg);
}
.wz-rail-shot-k {
  font-size: var(--fs-xs);
  color: var(--text-3);
}
.wz-rail-head {
  display: flex;
  flex-direction: column;
  gap: 2px;
  /* 名字那一块与下面的清单之间压一条短线:这里断句,不靠间距猜 */
  padding-bottom: var(--sp-3);
  border-bottom: 1px solid var(--line);
}
.wz-rail-name {
  font-size: var(--fs-lg);
  font-weight: 600;
  color: var(--text);
  overflow-wrap: anywhere;
}
.wz-rail-sub {
  font-size: var(--fs-sm);
  line-height: 1.5;
  color: var(--text-2);
}
/* 清单与信息区里的字段同一套字号:标签 12 灰、值 13 满墨。
   这里是窄栏,标签压在值上面(详情页的规格表是 84px 的两列,塞不进 216px) */
.wz-rail-rows {
  display: grid;
  gap: 9px;
}
.wz-rail-row {
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.wz-rail-k {
  font-size: var(--fs-xs);
  color: var(--text-3);
}
.wz-rail-v {
  font-size: var(--fs-base);
  line-height: 1.6;
  color: var(--text);
  overflow-wrap: anywhere;
}
.wz-rail-none {
  font-size: var(--fs-sm);
  line-height: 1.6;
  color: var(--text-2);
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
/* 向导里这一格是整屏最大的:中间的 "+" 也跟着放大一档,
   否则一枚 34px 的小圆落在这么大的空位里会显得没精神 */
.wz-hero-shot .cell-ph,
.wz-hero-shot .cell-lock,
.wz-hero-shot .cell-busy-stop {
  width: 46px;
  height: 46px;
}
.wz-hero-shot .cell-ph {
  font-size: var(--fs-xl);
}
.wz-hero-shot .cell-lock {
  padding: 13px;
}
/* 停止钮里那个方块跟着放大一档,不然圆变大、方块还是 11px 会显得空 */
.wz-hero-shot .cell-busy-stop::after {
  width: 14px;
  height: 14px;
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
  font-size: var(--fs-base);
  color: var(--text);
}
/* 其余四张:一排四格,与详情页的设定图同一套格子语言 */
.wz-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: var(--sp-3);
}

/* 第三张卡:进退动作。主操作在左,回退与退出紧跟其后
   (与表单里一贯的主次排法一致)。
   它不在滚动区里,所以滚动的永远是卡身,它自己不动 */
.wz-foot {
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  padding: 10px var(--sp-4);
  border-radius: var(--r);
  background: var(--surface);
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.05), var(--sh-sm);
}

/* —— 第 1 步的表单 ——
   整屏内容装在**一张**卡里(见 .wz-body),卡内再分成几段:
   起稿 / 基础信息 / Spec / Reference sheet only / 参考图。
   段与段靠留白和段标题分层,不再是"一段一张卡" ——
   卡本身已经说了"这一整块是一件事",里面再切四张,
   边界就把同一句话说四遍,而这里真正要区分的是"段"。

     重点   —— 只有起稿那一段有底色(一块淡底圆角槽),另外四段都是白面上的清单
     段标题 —— 15px/600 满墨 + 一句 12px 的说明(见 .wz-group-head)
     行     —— 段内每一栏是"标签在左、内容在右"的列表行,四段同一形状:
               同一个宽度、同一条 88px 标签列、同一条 12px 发丝线
     控件   —— 输入框一律无框无底:可写这件事由行的底色和左缘那道短竖线去说
   字号**五档**(整个向导只有这五档,任何一处都该能对上其中一档):
       20 页面主标题   —— 只有起稿那一块
       16 段标题       —— 各段题头,以及第 2、3 步的标题
       14 值 / 正文    —— 输入框、右栏的值、详情
       13 说明         —— 段说明、步骤说明、状态提示
       12 标签         —— 行标签、键、图注
   上一版是 20/15/13/12 四档,问题出在 13 与 12 只差 1px:密集的行里
   这两档在视觉上根本分不开,整页就只剩"满墨"与"灰"两种重量,
   于是"信息没有差距"。拉开到 14 对 12 之后,相邻两档至少差 1px、
   多则 4px,且每一档都对应一个**固定的语义角色** —— 不再出现
   "同一个角色在这个段里 12、在那个段里 13"这种说法。

   间距同时承担分组:段与段 32px、段内标题到内容是 8px —— 四倍的落差 */
.wz-form {
  gap: var(--sp-6);
}
/* 姓名 + 性别:一个段(题头是 Basics)。
   卡身比照 .wz-fields —— 行与行之间一条发丝线,行内标签左、值右。
   它自己不再是卡:这一整块已经是卡里的一段 */
.wz-basics {
  display: flex;
  flex-direction: column;
  gap: 0;
}
/* 按首行对齐,不按中线 —— 标签现在是两行(字段名 + 标记),
   整块居中的话"Name"会比输入框里那行字高出四五个像素,
   而这两行本来就该齐在第一条基线上 */
.wz-basics > .wz-field {
  align-items: flex-start;
}

/* 起稿是这一页的第一段,也是它最常用的入口 —— 一句话交给模型,
   下面所有栏位由它填出来。整段坐在一块淡底圆角槽里:
   这是这张卡上唯一一块有底色的地方,另外四段都是白面上一行行的清单 ——
   "重点"靠的是"这一块跟别的不一样",而不是把标题再放大一号 */
.wz-draft {
  /* 起稿中那圈呼吸光晕要拿它当定位基准(见 .halo-breathe)。
     光晕只加在槽外,槽本身全程不动 —— 与首页那个输入框同一套:
     槽还是那个槽,变的是槽外的光 */
  position: relative;
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
  /* 12px:与下面每一行的横向内边距同档,于是槽里的字仍然落在
     距卡边 24px 那条竖线上,和另外四段对齐 */
  padding: var(--sp-3);
  border-radius: var(--r-sm);
  background: var(--bg-elev);
  transition: background var(--dur) var(--ease), box-shadow var(--dur) var(--ease);
}
/* 光标进到这一栏时,槽从淡底翻成白面并亮起一圈淡墨。
   全站不给输入框画焦点描边(见 style.css),这一下就是它的焦点信号 */
.wz-draft:has(textarea:focus) {
  background: var(--surface);
  box-shadow: inset 0 0 0 1px color-mix(in oklch, var(--accent) 18%, transparent);
}
/* 标题与引导语贴成一组:两者是一句话的两半(问什么 + 怎么答) */
.wz-draft-head {
  display: flex;
  flex-direction: column;
  gap: 3px;
}
/* 这一页最大的字(20px,--fs-xl),比第二档的段标题高整整五档。
   层次要的是这种一眼可见的落差;此前它只比段标题大一档(16 对 15),
   等于把"最大"和"次大"糊在一起,一页自然没有重点 */
.wz-draft-title {
  font-size: var(--fs-xl);
  font-weight: 600;
  letter-spacing: var(--ls-tight);
  color: var(--text);
}
.wz-draft-sub {
  max-width: 56ch;
  font-size: var(--fs-sm);
  line-height: 1.6;
  color: var(--text-2);
}
/* 输入槽。字号抬到 15px 并给正文色 ——
   这一栏收的是"一个人的样子",是整页唯一写给人看的话,而下面各栏是填给模型的参数;
   字号与颜色把这两件事分开(15px 与首页的提示词框同档,不是新开的尺寸)。
   它自己不画边框也不画底线:外面那层淡底槽就是它的边界,
   再描一道线等于把"这是一块能写字的地方"说两遍。
   选择器带上 textarea 是为了压过 .ed-input 那几条:两个单类分处文件两头,
   靠先后顺序去赢太脆 */
textarea.wz-idea {
  padding: 0;
  font-size: var(--fs-md);
  line-height: 1.6;
  resize: none;
  /* 随内容长高(见 vGrow),但最多长到 6 行 —— 与首页那个提示词框同一档
     (见 App.vue 的 INPUT_MAX_ROWS)。封顶之后转成内部滚动。
     不封顶的代价在这一页比首页还大:起稿块在整张卡的最上面,
     一段半页长的描述会把下面整套设定、连右栏那份摘要一起顶出视口,
     而用户填到一半最需要看的恰恰是"它到底读出了什么"。
     em 跟着自身的字号走,窄屏那条 16px 的规则一改,这里也自己跟着涨 */
  max-height: calc(1.6em * 6);
  /* 只放行纵向:一长串没有空格的字符不该顶出一条横向滚动条 */
  overflow-x: hidden;
  overflow-y: auto;
}
/* 动作行:提示与报错占左边的余量,主按钮钉在右边。
   用 flex-end + margin-right:auto 而不是 space-between —— 没有提示时按钮也不挪位 */
.wz-draft-foot {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  flex-wrap: wrap;
  gap: 8px var(--sp-3);
}
.wz-draft-foot .wz-err,
.wz-draft-foot .wz-draft-hint {
  margin-right: auto;
  min-width: 0;
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
  font-size: var(--fs-sm);
  line-height: 1.5;
  color: var(--text-2);
}
.wz-err {
  font-size: var(--fs-sm);
  line-height: 1.5;
  color: var(--danger);
}

/* 组:卡外一行标题(带一句副题)+ 一张装内容的卡 */
.wz-group {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
}
/* 段与段之间:一条两端内缩的发丝线。
   原来只靠留白分层("留白已经说了这是新的一段"),可每一段如今都挂着三四行
   内容,那点留白被内容吃掉了 —— "几块糊在一起"是连着的两次反馈。
   线两端各空 12px,和行内那条发丝线同一个规矩:横贯到边会把整段封死 */
.wz-group + .wz-group {
  position: relative;
}
/* 线画在**段间留白的正中**(gap 是 32px,见 .wz-form),上下各 16px。
   它不占布局 —— 段与段的节奏仍旧由那一处留白说了算,这条线只是把
   "这里是两段"指出来,不再往上加一层间距(见下面这段被推翻的注释) */
.wz-group + .wz-group::before {
  content: '';
  position: absolute;
  top: -16px;
  left: 12px;
  right: 12px;
  height: 1px;
  background: var(--line);
}
/* 段标题与副题上下排,像小节的题头。
   标题行下面仍然不压横线 —— 那条线已经画在段与段之间了,
   同一个分隔说两遍才是多余的 */
.wz-group-head {
  display: flex;
  flex-direction: column;
  gap: 3px;
  /* 与下面每一行的内容同一条左边缘:行自己有 12px 横向内边距,
     眉标就得补上同样那 12px,否则它会比它管的那些行往里缩 */
  padding: 0 var(--sp-3);
}
/* 段标题:15px / 600 / 满墨 —— 一个实打实的标题。
   上一版把它做成 12px 全大写的眉标,想靠"换一种写法"分层;
   可眉标和行标签同为 12px,一页里就只剩"起稿标题 16、其余全 12"两档,
   反而比原来更平。层次终究要靠字号差,字距与大小写是辅助。

   这一页的**五档**(全向导统一,见 .wz-form 那段的总说明):
     20 页面主标题 / 16 段标题 / 14 行值 / 13 说明 / 12 标签
   段标题原来是 15,而第 2、3 步的标题是 16 —— 同一个角色两种字号,
   这正是"字很乱"的来源。现在统一到 16 */
.wz-group-title {
  display: inline-flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 8px;
  font-size: var(--fs-lg);
  font-weight: 600;
  letter-spacing: var(--ls-tight);
  color: var(--text);
}
/* 段说明:压在标题下面,与标题差三档。
   原来是 12px + text-3,而"说明"这一角色在别的段里时而是 12、时而是 13,
   颜色时而 text-2 时而 text-3 —— 现在统一到 13px/text-2 这一档:
   它是要读的一句话,不是可以扫过去的脚注(--text-3 那档留给标签) */
.wz-group-hint {
  font-size: var(--fs-sm);
  line-height: 1.5;
  color: var(--text-2);
}
/* "必填"用一枚墨色星号,不写 "Required" 这个词 ——
   星号是表单里通用的约定,一眼认得,而且只占一个字宽;
   写成词(八九个字符)会把这 88px 的标签列挤成两种版式:
   放得下的挤成一行、放不下的折成两行,同一张卡里两行标签就不是一个形状。
   颜色用 --accent(与字段值同色的墨),不是 --text-3:
   它是这几个字里唯一一条"约束",该压得住旁边那行灰标签。
   读屏不听它(aria-hidden),必填由控件自己的 aria-required 说 */
.wz-mark {
  flex: none;
  font-size: var(--fs-xs);
  font-weight: 600;
  line-height: 1;
  color: var(--accent);
}

/* 字段区:一列"标签在左、值在右"的列表行 ——
   与详情页那张规格表(.spec,84px 标签列)是同一套读法,只是这里可以就地改。
   为什么是一列而不是两列 —— 四段必须长得一样宽才看得出是一份表:
   两列时 Spec 那一段是两个半宽的行,而 Basics 与 Reference image 是整宽的行,
   并排放在一张卡里,每一段的边界都落在不同的横线上,越看越乱。
   值那一栏有 700px 上下,13px 的字一行放得下十二个词,
   所以改成一列并没有把行撑高多少 —— 换来的是四段同一个形状 */
.wz-fields {
  display: grid;
  grid-template-columns: 1fr;
  /* 行与行不留缝:相邻两行的发丝线正好是一条分界。
     内外留白全部交给每一行自己(见 .wz-field)—— 它不再是卡,是卡里的一段 */
  gap: 0;
}
/* 一行。它自己就是可悬停的那一块(与设置页的 .row 同一套做法):
   底色一深,既说明"这一格能写",也把这一行从上下两行里挑出来 */
.wz-field {
  position: relative;
  display: flex;
  flex-direction: row;
  align-items: flex-start;
  gap: var(--sp-3);
  min-width: 0;
  padding: 10px 12px;
  border-radius: var(--r-sm);
  transition: background var(--dur) var(--ease);
}
/* ===== 嗓音 =====
   两块:上面一排引擎(系统嗓子 / 自己配的那把),下面按来源分叉。
   分叉只有一行输入 —— 因为三种来源在请求那边本来就只差"voice 从哪来" */
/* 这一组的容器。给一块淡底,把它从上面的"行"里挑出来(见模板里的注释)。
   内边距 12/14 与 .wz-field 那一档对齐,里面的东西不必再自己撑边距 */
.voice-panel {
  display: flex;
  flex-direction: column;
  padding: 14px;
  border-radius: var(--r-sm);
  background: var(--bg-elev);
}
/* 面板里分三块:引擎 → 来源 → 要填的那一格。
   三块的形状各不相同(一排胶囊、一排胶囊、一个输入框),不划线就会糊成一片 ——
   块与块之间一条发丝线,两端内缩,与卡里别处的分隔同一个规矩 */
.voice-block + .voice-block {
  margin-top: 16px;
  padding-top: 16px;
  border-top: 1px solid var(--line);
}
/* 组内的小标题(Engine / Voice source)。
   满墨 + 大写 + 字距:这一组里除了字段名,别的字都是 --text-2 的灰 ——
   标题只有用最重的那档墨色才压得住,分块才立得起来 */
.voice-cap {
  display: block;
  margin: 0 0 8px;
  font-size: var(--fs-sm);
  font-weight: 600;
  letter-spacing: var(--ls-eyebrow);
  text-transform: uppercase;
  color: var(--text);
}
.voice-seg {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.voice-seg button {
  min-height: 36px;
  padding: 0 13px;
  border: 1px solid var(--line);
  border-radius: 999px;
  background: none;
  color: var(--text-2);
  font-size: var(--fs-sm);
  cursor: pointer;
  transition: border-color var(--dur) var(--ease), background var(--dur) var(--ease),
    color var(--dur) var(--ease);
}
.voice-seg button:hover {
  border-color: var(--line-strong);
  color: var(--text);
}
/* 选中的那枚用实心纸色 —— 与查看器的主操作同一个说法:
   这一组里"现在哪一档"必须一眼看得出来 */
.voice-seg button.on {
  border-color: var(--cta);
  background: var(--cta);
  color: var(--cta-text);
}
/* 说明:解释"这一档是什么意思"。它是要读的一句话,留在 13px/--text-2 */
.voice-note {
  margin: 8px 0 0;
  font-size: var(--fs-sm);
  line-height: 1.5;
  color: var(--text-2);
}

/* —— 要填的那一格 ——
   上面全是灰字,这里必须一眼看出"框里才是要写的"。所以三件事同时做:
   字段名压成 12px 的墨色小标、控件套一个白面描边的框、注脚退回框外的灰字。
   框是这一组里唯一的"可写"信号 —— 它也是"哪些是要填的"这句话的答案 */
.voice-field {
  display: block;
}
/* 块里第一格贴块顶(上边距由块自己出),后面的格与它拉开一档 */
.voice-block > .voice-field:first-child {
  margin-top: 0;
}
.voice-field + .voice-field {
  margin-top: 14px;
}
/* 墨色而不是灰:它是"这一格填什么",就压在框的上沿,该比注脚重 */
.voice-label {
  display: block;
  margin-bottom: 6px;
  font-size: var(--fs-xs);
  font-weight: 600;
  color: var(--text);
}
/* 框。白面托在淡灰面板上,再描一道发丝线 —— 深色主题下两者明暗相反,
   但"这里是一个框"这件事两边都成立。
   min-height 40px 是这一页可点区域的底线(与性别那枚分段控件同档) */
.voice-control {
  display: flex;
  align-items: center;
  min-height: 40px;
  padding: 8px 12px;
  border: 1px solid var(--line);
  border-radius: var(--r-sm);
  background: var(--surface);
  transition: border-color var(--dur) var(--ease), box-shadow var(--dur) var(--ease);
}
.voice-control:hover {
  border-color: var(--line-strong);
}
/* 焦点落在框上,而不是里面那条无框的字(.ed-input 自己的焦点样式是空的),
   否则"光标落在这格"就没有任何信号 */
.voice-control:focus-within {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-soft);
}
/* 内边距由框来撑,里面的控件不再自己留上下余量(否则会多出 4px) */
.voice-control .ed-input {
  flex: 1;
  padding: 0;
}
/* 描述那一档的 textarea 随内容长高(见 vGrow),框也跟着长 */
.voice-control textarea.ed-input {
  resize: none;
  line-height: 1.5;
}
/* 注脚:框下面那行解释。与 .voice-note 同档 —— 两者的分界交给位置,
   一句在选项下、一句在框下 */
.voice-hint {
  display: block;
  margin-top: 6px;
  font-size: var(--fs-sm);
  line-height: 1.5;
  color: var(--text-2);
}
/* 注脚里的强调句(如 "This description is the voice.")。
   原来 em 被抹成和正文一样的灰,等于没强调 —— 它该压得住旁边那句解释 */
.voice-hint em {
  font-style: normal;
  font-weight: 600;
  color: var(--text);
}
.voice-clone {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.voice-sample {
  font-size: var(--fs-xs);
  color: var(--text-3);
  overflow-wrap: anywhere;
}
.voice-audition {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-top: 14px;
}
/* 报错。display:block 是给 clone 那一条(它是 span)补的 ——
   行内元素上写 margin-top 本来就不生效 */
.voice-err {
  display: block;
  margin: 8px 0 0;
  font-size: var(--fs-sm);
  line-height: 1.5;
  color: var(--danger);
}
/* 行与行之间的发丝线。两端各空 12px —— 一条横贯到卡边的线会把每一行封死 */
.wz-field::before {
  content: '';
  position: absolute;
  top: 0;
  left: 12px;
  right: 12px;
  height: 1px;
  background: var(--line);
}
/* 一段的第一行不画:它上面是段标题,不是另一行 */
.wz-fields > .wz-field:first-child::before,
.wz-basics > .wz-field:first-child::before {
  opacity: 0;
}
/* 焦点标记:左缘一条 accent 短竖线。
   全站不给输入框画焦点描边(见 style.css),只靠"底色深了一档"
   在键盘操作时太轻,加这一道就知道光标落在哪一行 */
.wz-field::after {
  content: '';
  position: absolute;
  left: 2px;
  top: 10px;
  bottom: 10px;
  width: 2px;
  border-radius: 2px;
  background: var(--accent);
  opacity: 0;
  transform: scaleY(0.4);
  transition: opacity var(--dur) var(--ease), transform var(--dur) var(--ease);
}
.wz-field:hover,
.wz-field:focus-within {
  background: var(--bg-elev);
}
.wz-field:focus-within::after {
  opacity: 1;
  transform: none;
}
/* 值占满标签右边的那点余量。它自己不带边框也不带底 ——
   行的底色与左缘那道线已经说清了"这一格能写" */
.wz-field > .ed-input {
  flex: 1;
  min-width: 0;
  width: auto;
}
/* 备注是自由文本,占满两列 */
.wz-field.is-wide {
  grid-column: 1 / -1;
}

/* —— 性别:一枚分段控件 ——
   原来是并列的两枚描边胶囊、各占一半宽,与上下那些输入框一样重,
   读起来像"两颗待按的按钮"。现在收成一枚系统设置那样的分段控件:
   一条浅槽 + 一枚落在槽里的墨色药丸。
   选中态涂实心是刻意的:两枚里那个默认值本来就已经是"选好的那个",
   换个说法喊出来(药丸)比再画一圈描边更一眼看得懂,也正是这种控件的惯例。
   外面那层 .wz-field 与 Name 完全一样,只把控件换掉 */
.wz-sex {
  display: inline-flex;
  flex: none;
  /* 不留 margin-left:auto —— 它也是"这一行的值",要和 Name 的输入框、
     以及下面每组里的值一样从那条 88px 的竖线起排。
     推到最右会把同一张卡里的两个值分成两种落点(一个贴标签、一个贴右边缘),
     这一页的读法本来就是"标签一列、值一列" */
  gap: 2px;
  padding: 3px;
  border-radius: 999px;
  background: var(--bg-elev);
}
.wz-sex-opt {
  /* 隐藏的 radio 是绝对定位的,得有个定位锚点收住它 */
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  /* 40px 是这一页所有可点区域的底线:再矮在触屏上就点不准了 */
  min-height: 40px;
  padding: 0 16px;
  border-radius: 999px;
  color: var(--text-2);
  font-size: var(--fs-sm);
  cursor: pointer;
  transition: background var(--dur) var(--ease), color var(--dur) var(--ease);
}
/* 未选中的那枚悬停只提亮文字 —— 槽里的空白不该再长出第二个色块 */
.wz-sex-opt:not(:has(input:checked)):hover {
  color: var(--text);
}
/* 原生 radio 藏起来但留在 Tab 键序里:方向键切换、读屏念"已选中",
   都是它自带的。换成 button 就得把这些重写一遍 */
.wz-sex-opt input {
  position: absolute;
  opacity: 0;
  pointer-events: none;
}
/* 值按原样存(提示词里要的就是那个词),只有摆在界面上时才首字母大写 */
.wz-sex-cap {
  text-transform: capitalize;
}
.wz-sex-opt:has(input:checked) {
  background: var(--accent);
  color: var(--accent-contrast);
}
/* 全站不画焦点描边(见 style.css 的 :focus-visible),所以键盘聚焦
   也走"描边 + 一圈晕"这条路 */
.wz-sex-opt:has(input:focus-visible) {
  box-shadow: 0 0 0 3px var(--accent-soft);
}
/* 行标签:定宽 88px 的左边一列 —— 所有字段值于是从同一条竖线起排。
   88px 与详情页规格表的 84px 同一档(这里多 4px,是因为表单里的字要首字母大写、
   最长的一条 "Nose & mouth" 得留出富余)。

   字号与颜色都压到最安静那一档(12px / 500 / text-3):
   这一段里标签只是"这一格填什么"的提示,真正的内容是右边那个值,
   而值给的是 13px 的满墨 —— 两者差的不只是 1px,还有一整档色深。
   标签再重一点,一行里就会变成两段同样有分量的字,谁也不让谁。

   这一行里还会跟两枚小东西:必填的星号(.wz-mark)、
   "模型填过"的小点(.wz-ai)—— 都是字段名的一部分,跟它同一行 */
.wz-label {
  flex: none;
  width: 88px;
  display: flex;
  align-items: center;
  gap: 6px;
  /* 与右边的值对齐首行基线:值的输入框自带 4px 上内边距 */
  padding-top: 4px;
  font-size: var(--fs-xs);
  font-weight: 500;
  line-height: 1.4;
  color: var(--text-3);
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
/* 给读屏的"这栏是模型填的"。视觉上靠那枚点,但那枚点不值得被念出来 ——
   样式在 style.css 的 .sr-only,这里不另立一份 */
/* 参考图:空态与有图态同一个高度 —— 挑完图不该整块往上跳一下。
   它就是段里的一行:横向内边距与 .wz-field 同档(12px),
   于是它的外框与上面那些行的悬停底色同起同止,
   里面的图与字也落在距卡边 24px 那条竖线上。
   这里不再额外收 margin —— 卡自己已经收了 12px,
   再收一层会让这一段的框比别的段窄一圈(就是"宽度不一致"的由来) */
.wz-ref {
  /* 读取中那圈呼吸光晕的定位基准(见模板里的 halo-breathe)。
     光晕只加在卡外,卡本身全程不动 */
  position: relative;
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  min-height: 68px;
  padding: 10px var(--sp-3);
  border-radius: var(--r-sm);
}
/* 空态只留一条虚线槽:它此刻是个"往这儿放图"的入口,还不是一行内容 */
.wz-ref-pick {
  border: 1px dashed var(--line-strong);
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
  font-size: var(--fs-base);
  font-weight: 500;
  color: var(--text);
}
.wz-ref-hint {
  font-size: var(--fs-sm);
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
/* 有图之后这一块多一行识图状态,所以外面包一层纵向容器。
   图片那一行本身的高度不变(见上面的 min-height) */
.wz-ref-wrap {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
}
/* 识图状态行:左边是取景框与说明,右边是重读按钮。
   min-height 兜住基线 —— 从"读取中"到"已读"再到"又跟了一行说明",
   每次换态整块不该抽一下 */
.wz-scan {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  min-height: 34px;
  /* 与上下那两行的内容同一条左边缘(上面 .wz-ref 自己收了 12px 外边距) */
  padding: 0 var(--sp-3);
}
/* 取景框与它下面那几句说明竖着排。颜色定在这里:
   LatticeLoader 的 label 走 currentColor,跟着它就有了深浅两种主题下的正确墨色 */
.wz-scan-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
  color: var(--text-2);
}
.wz-scan-hint {
  font-size: var(--fs-sm);
  line-height: 1.5;
  color: var(--text-2);
}
.wz-scan-err {
  font-size: var(--fs-sm);
  line-height: 1.5;
  color: var(--danger);
}

/* —— 表单控件:所有文本输入共用 ——
   无框、无底、无圆角:它现在是"列表行里的一段可写文字",不是一个盒子。
   行的底色与左缘那道短竖线负责说"这一格能写、光标正落在这儿"(见 .wz-field),
   盒子只会把一行行东西重新切回原来那种方框阵 —— 那正是这一版要丢掉的 */
.ed-input {
  width: 100%;
  min-width: 0;
  padding: 4px 0;
  border: 0;
  border-radius: 0;
  background: none;
  color: var(--text);
  /* 14px:整份表单里"值"的统一档。原来是 13,和 12 的标签只差 1px ——
     两者在密集的行里几乎分不出来,"信息没有差距"说的就是这一处 */
  font-size: var(--fs-base);
}
/* 占位符显式定色:浏览器默认那一档灰在浅色面上过不了 4.5:1 */
.ed-input::placeholder {
  color: var(--text-3);
}
.ed-input:focus {
  outline: none;
  box-shadow: none;
}
/* 规格字段是 textarea,随内容长高(见 vGrow),但三行封顶。
   为什么不封顶:一行行往下摞的表里,只要有一格长起来,
   整份表的分栏线就跟着塌一格 —— 用户扫的时候会以为那是一片空白,
   而不是"这一栏我写多了"。封顶之后每一行的高度是稳定的。
   封顶就要配内部滚动(不能让它溢出),这是这一版认下的代价:
   一页里两条滚动条,好过一次把整张表的节奏打乱。
   1.5em × 3 跟着自身字号走,窄屏那条 16px 的规则一改,这里也自己跟着涨 */
.wz-field textarea.ed-input {
  resize: none;
  line-height: 1.5;
  max-height: calc(1.5em * 3);
  overflow-x: hidden;
  overflow-y: auto;
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
/* 停止符号:一个方块,和设定图格子上那枚同源(都用 CSS 画,不引图标)。
   currentColor 让它跟着按钮的文字色走,深浅两种底都成立 */
.ed-stop {
  width: 9px;
  height: 9px;
  flex: none;
  border-radius: 2px;
  background: currentColor;
}

/* —— 列表:角色海报卡 —— */
/* 顶图全出血铺满整张卡,底部的毛玻璃与暗幕挂在信息区上(见 .ctile-content::before)。
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
  /* 悬停时整张卡抬起一点。位移必须挂在这一层,不能挂 .ctile-main:
     右上角那枚 ⋮ 菜单是 .ctile-main 的兄弟节点,挂在内层就只有卡片自己动、
     菜单原地不动。影子仍归 .ctile-main(它是那张有圆角的卡面),各归各。
     4px 是刚好看得见、又不至于跳出来的一档 */
  transition: transform var(--dur) var(--ease);
}
.ctile:hover {
  transform: translateY(-4px);
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
/* 只换影子是"变重",不是"浮起来" —— 补一点位移才有离开纸面的分量 */
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
/* —— 毛玻璃 + 暗幕 ——
   只有一层 ::before,挂在信息区自己身上,不是按卡片高度的百分比铺。
   卡片是 3:4 比例,一变宽就变高,而信息区的高度基本是固定的 ——
   按百分比铺的话,卡越大玻璃就越比文字高出几倍(之前几轮一直调不准就是这个)。
   锚在信息区上,玻璃就永远贴着文字那一块,卡片多大都一样。

   为什么必须是"一层":暗幕曾经拆成独立的 ::after(横跨整卡宽度的矩形),
   想靠两个元素的边界错位做出"模糊比变暗伸得更远"。
   结果就是露出一个淡淡的矩形 —— 两个矩形叠在一起,
   各自的收口位置不重合,轮廓就显出来了。

   正确做法是留在同一层里、但仍然让两者错开:
   让背景渐变(暗幕)在 80% 处就归零,而 mask 的羽化一直拉到 100%。
   于是暗幕自己先收干净、模糊继续往上化 —— 错位保住了,
   而且两者被同一个软 mask 裁,没有任何一条硬的矩形边。

   mask 下面 62% 全浓(正好盖住信息区),再往上 38%(约 90px)渐隐。
   backdrop-filter 只留 blur,不带 brightness/saturate:
   那两个改的是"整体色调",mask 羽化到半透明处会露出一块色调被平移的矩形;
   模糊只降低细节、不动平均色调,所以羽化处不会显形。 */
.ctile-content::before {
  content: '';
  position: absolute;
  inset: -90px 0 0 0;
  z-index: -1;
  pointer-events: none;
  /* 明暗的重心压在底部(参考稿是"上面透、下面沉"),且在 80% 就收干净 ——
     底部是小字(用量、标签),最难读所以要暗;名字是 20px 粗体,
     本身压得住,放在亮底上反而能让照片透出来 */
  background: linear-gradient(
    to top,
    rgba(24, 24, 22, 0.4) 0%,
    rgba(24, 24, 22, 0.34) 30%,
    rgba(24, 24, 22, 0.2) 55%,
    rgba(24, 24, 22, 0.06) 70%,
    transparent 80%
  );
  backdrop-filter: blur(24px);
  -webkit-backdrop-filter: blur(24px);
  -webkit-mask-image: linear-gradient(
    to top,
    #000 0%,
    #000 62%,
    rgba(0, 0, 0, 0.5) 82%,
    transparent 100%
  );
  mask-image: linear-gradient(
    to top,
    #000 0%,
    #000 62%,
    rgba(0, 0, 0, 0.5) 82%,
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
/* 焦点环全站关闭,见 style.css 的 :focus-visible */

/* 文本叠层:贴底,白字,左下 16px。
   只留三样:名字(+CTA)、特征、用量 ——
   简介那一行(身份/描述)与名字说的是同一件事,重复;分隔线是纯装饰。
   两者都删掉,卡片下方才不挤。
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
  gap: 10px;
  padding: 17px 17px 16px;
  pointer-events: none;
  /* 两道投影:贴边那道定字缘,大范围那道在字周围压出一圈局部对比 ——
     暗幕调轻之后,名字落在亮底上就得靠它撑住 */
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.5), 0 2px 14px rgba(0, 0, 0, 0.45);
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
/* 特征胶囊:玻璃感白字,一行 */
.ctile-chips {
  display: flex;
  gap: 6px;
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

/* 用量三格 + 竖向分隔,白字压在暗幕上。
   上边距比常规段距再大一档(10px)—— 参考稿就是靠这段留白把
   "标签"和"数据"分成两段,不靠分隔线,也不显挤 */
.ctile-stats {
  display: flex;
  margin-top: 10px;
}
.cstat {
  flex: 1 1 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
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
  /* 图与文字之间留一档半的呼吸:200px 的图旁边紧贴文字会读起来像"图注" */
  gap: var(--sp-5);
  padding: var(--sp-5);
  border: 1px solid var(--line);
  border-radius: var(--r);
  background: var(--surface);
}
/* 主视觉:正脸那张图。3:4 与列表里的角色卡同一个比例,圆角也同一档 ——
   这一页是那张卡"打开之后",同一个人不该换个形状。
   影是贴边接触影(见 --sh-sm):浅色主题里照片边缘不托一道会糊在卡面上。
   没有正脸时是一块淡底的占位框,尺寸不塌 —— 那一栏的存在感先立住 */
.hero-shot {
  flex: none;
  /* 240 × 320。内容区约 1040px,它占四分之一 —— 再小就只是"配图",
     再大又会把下面那五张设定图压成附属品,而它们才是这一页的正文 */
  width: 240px;
  aspect-ratio: 3 / 4;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  border-radius: 24px;
  background: var(--image-bg);
  color: var(--text-4);
  box-shadow: var(--sh-sm);
}
.hero-shot img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.hero-shot svg {
  width: 40px;
  height: 40px;
}
.hero-body {
  flex: 1;
  min-width: 0;
}
/* 名字是这一页的标题,而它旁边现在站的是一张 267px 高的图 ——
   22px 的名字配那个体量会显得像图注。抬到 28px(fs-3xl,与各页页标题同档) */
.hero-name {
  font-size: var(--fs-3xl);
  line-height: 1.2;
  letter-spacing: var(--ls-tight);
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
/* 两枚动作同排(Chat + 一次补齐)。它们是这一列的收尾,跟在标签下面 ——
   不再是右侧独立的一列:左边站着 267px 的图,再切出第三列按钮,
   那一列会孤零零地悬在中线上,读起来像工具栏而不是一个人。
   整条 hero 在窄屏会换行,这一组自己也留一条换行的余地 */
.hero-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--sp-2);
  margin-top: var(--sp-4);
}
.hero-chat {
  min-height: 40px;
  padding: 10px 15px;
}

.panel {
  margin-top: var(--sp-4);
  padding: var(--sp-4);
  border: 1px solid var(--line);
  border-radius: var(--r);
  background: var(--surface);
}
/* 三张资料表(Spec / Personality / Voice)并排,收成一段"附录"。
   它们原来是三张上下堆叠的卡,一路读下来就是一堵"表单墙" ——
   可它们其实是同等次要的东西:都是"要用的时候才查"的资料,
   而这一页的主角是上面那张脸,以及它那五张设定图。
   并排之后它们从"页面正文"退成一段注脚,视线扫过就行。
   用 auto-fit 而不是写死三列:窄屏自己落成两列、一列,不必再挂一条媒体查询 */
.dt-facts {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
  gap: var(--sp-4);
  align-items: start;
  margin-top: var(--sp-4);
}
/* 并排之后卡自己那条上边距要去掉:间隙由 grid 的 gap 统一给,
   否则三张卡会一起再往下挪一格 */
.dt-facts > .panel {
  margin-top: 0;
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

/* —— 设定图 ——
   原来是五格并排。但四张方块(1:1)与 Full body 那张竖幅(2:3)同排并立时,
   竖幅会比旁人高出一大截,一行里参差不齐 —— 改成"左四右一":
   四张方块拼成 2×2,竖幅独占右列。这个分法也正好对上信息层级:
   左边是同一张脸的四个方向,右边是整个人 */
.sheet {
  display: grid;
  /* 1.4fr 是算出来的:要让左边 2×2 的总高与右边那张 2:3 的总高相等,
     竖幅这列就得比一个方块宽 1.4 倍。按内容区 1040px 宽算,两边差 6px 上下 ——
     落在标签的字里行间,看不出来 */
  grid-template-columns: 1fr 1fr 1.4fr;
  gap: var(--sp-3);
  align-items: start;
}
/* 竖幅挪到第三列并纵向跨两行;四张方块随之自动落进左边的 2×2 */
.cell.is-portrait {
  grid-column: 3;
  grid-row: 1 / span 2;
}
.cell {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
}
/* 设定图格子:和角色海报卡同一套"照片优先"的语言 —— 圆角 + 一道极淡的接触影,
   有图的靠图本身撑住,没图的靠一块淡底。
   刻意不用"虚线框 → 实线框":那是线框稿的写法,读起来像待填的表单,
   而不是一个已经有设计的产品界面 */
.cell-img {
  position: relative;
  aspect-ratio: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  border: none;
  /* 比 --r-sm(8px)大一档:海报卡是 24px,这里取中间值,
     一排小片才不会显得比卡片"硬" */
  border-radius: 12px;
  background: var(--bg-elev);
  color: var(--text-3);
  cursor: pointer;
  transition: background var(--dur) var(--ease), color var(--dur) var(--ease),
    box-shadow var(--dur) var(--ease), opacity var(--dur) var(--ease);
}
/* 有图:照片优先。底换成图片画布色,再压一道接触影把它从页面上托起来 */
.cell-img.has-img {
  background: var(--image-bg);
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.05);
}
.cell-img.has-img:hover {
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.05), var(--sh-sm);
}
/* 竖幅的输出只有 Full body 一张(见 api.ts 的 framing)。
   它按 2:3 生成(App 的 PORTRAIT_RATIO),塞进 1:1 的格子会被 cover 上下各切掉约 1/6 ——
   头和脚都没了。所以这一格改用同一个 2:3 装它:比例对齐,cover 一点不裁;
   方块图仍用 1:1,它们的输出本来就是方的 */
.cell.is-portrait .cell-img {
  aspect-ratio: 2 / 3;
}
/* 空格子上的"+"做成一枚圆形按钮:说的是"这里可以生成",
   而不是"这里缺一件东西"。悬停时它转成墨色实心 ——
   反馈落在按钮自己身上,不必再给整格描一圈边 */
.cell-ph {
  width: 34px;
  height: 34px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  background: var(--surface);
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.05);
  font-size: var(--fs-lg);
  line-height: 1;
  color: var(--text-2);
  transition: background var(--dur) var(--ease), color var(--dur) var(--ease);
}
.cell-img:not(.has-img):hover:not(:disabled) .cell-ph {
  background: var(--accent);
  color: var(--accent-contrast);
}
/* 该停用的入口要看得出来,否则和平时长得一样、点了却没反应。
   只有一种情况会停用:正脸正在重跑 —— 那时其余几张拿到的会是上一版正脸。
   别的组合都允许同时跑,各自有自己的进度与停止位 ——
   正在跑的那一格不走这里,它换成了停止位,是可点的 */
.cell-img:disabled {
  cursor: default;
  opacity: 0.4;
}
/* 正在跑的那一张(含重跑):整格换成"停止"入口。
   旧写法只给空格子加个呼吸,重跑一张已有的图时格子毫无变化 ——
   看不出在跑,也没地方停。现在无论空格还是有图,这一格都变成可点的停止位 */
.cell-img.is-busy {
  cursor: pointer;
  box-shadow: none;
}
/* 暗幕把底下的旧图压住:一是说明"这一格正被占用",
   二是让中间的停止钮在亮图上也有对比 */
.cell-busy {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(24, 24, 22, 0.5);
}
/* 停止:一枚玻璃圆 + 中间一个方块(停止的通用符号,不必再引一个图标)。
   呼吸做在这枚圆的外圈上 —— 让它一直在"动",而按钮本身保持清晰 */
.cell-busy-stop {
  position: relative;
  width: 34px;
  height: 34px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  background: rgba(252, 251, 249, 0.22);
  animation: charBusy 1.6s var(--ease) infinite;
}
.cell-busy-stop::after {
  content: '';
  width: 11px;
  height: 11px;
  border-radius: 2px;
  background: #fbfaf7;
}
.cell-img.is-busy:hover .cell-busy-stop {
  background: rgba(252, 251, 249, 0.36);
}
@keyframes charBusy {
  50% {
    box-shadow: 0 0 0 7px rgba(252, 251, 249, 0.1);
  }
}
.cell-img img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
  transition: transform 700ms var(--ease);
}
.cell-img.has-img:hover img {
  transform: scale(1.05);
}
/* 锁住的那几格:先有正脸才轮得到它们。
   图标比 "+" 小一档 —— 它说的是"还不能点",不该和可点的格子抢注意力 */
.cell-lock {
  width: 34px;
  height: 34px;
  padding: 10px;
  border-radius: 50%;
  background: var(--surface);
  color: var(--text-4);
}
/* 整条流水线的起点:正脸格是这一屏唯一该被点的东西 ——
   给它一枚 accent 淡底的 "+"(比描边含蓄,又比旁人醒目) */
.cell-img.start:not(.has-img) .cell-ph {
  background: var(--accent-soft);
  color: var(--accent-strong);
}
/* 悬停铺一层柔幕 + 一枚圆形放大按钮:说清"这张点得开",而不是点下去才知道。
   遮罩必须与主题无关(它盖在照片上,不盖在界面上),所以这里是全站少数
   刻意不走 token 的地方 —— 但仍按暖白纸的调子避开纯黑纯白 */
.cell-zoom {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(24, 24, 22, 0.3);
  color: #fbfaf7;
  opacity: 0;
  transition: opacity var(--dur) var(--ease);
}
/* 图标外面套一枚玻璃圆:裸图标浮在照片上会显得没落点 */
.cell-zoom svg {
  width: 36px;
  height: 36px;
  padding: 9px;
  border-radius: 50%;
  background: rgba(252, 251, 249, 0.2);
}
.cell-img:hover .cell-zoom {
  opacity: 1;
}
/* 主视图:右上角一枚眼睛。星标是"收藏"的语言,眼睛才是"就是这张" ——
   比在格子下面挂一行小字醒目得多 */
.cell-mark {
  position: absolute;
  top: 8px;
  right: 8px;
  width: 24px;
  height: 24px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  background: var(--accent);
  color: var(--accent-contrast);
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.18);
}
.cell-mark svg {
  width: 14px;
  height: 14px;
}
/* 标签做成 editor 式小眉标:全大写 + 拉开字距。
   它本来是"Front""3/4 left"这种短语,放大写加字距之后
   就从"说明文字"变成了"排版的一部分" */
.cell-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-align: center;
  font-size: var(--fs-micro);
  font-weight: 600;
  letter-spacing: var(--ls-eyebrow);
  text-transform: uppercase;
  color: var(--text-3);
}
.cell.is-ref .cell-label {
  color: var(--accent-strong);
}

/* —— 这个角色出过的图 ——
   这里是小样,不是作品墙:一律裁成正方形(cover),不按每张的真实比例摆 ——
   那会让格子高低不齐。点开才是完整的那张 */
.works {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(96px, 1fr));
  gap: var(--sp-2);
}
.work {
  position: relative;
  aspect-ratio: 1;
  overflow: hidden;
  padding: 0;
  border: 1px solid var(--line);
  border-radius: var(--r-sm);
  background: var(--image-bg);
  cursor: pointer;
  transition: border-color var(--dur) var(--ease), transform var(--dur) var(--ease);
}
.work img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
  transition: transform 700ms var(--ease);
}
/* 与角色卡同一套悬停语言:抬一点、图放大一点 */
.work:hover {
  border-color: var(--line-strong);
  transform: translateY(-2px);
}
.work:hover img {
  transform: scale(1.06);
}
.works-more {
  margin-top: var(--sp-3);
  font-size: var(--fs-xs);
  color: var(--text-3);
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

/* —— 看大图 ——
   从"白卡 + 顶部标题条 + 底部按钮条"的工具型弹窗,改成照片浏览器:
   图自己浮在深底上,控件是压在图上的玻璃件。

   深色遮罩是刻意的、与主题无关 —— 和角色卡、设定图格子一样,
   凡是"衬着照片"的表面都不走 token:照片需要一层中性的暗底才看得出影调,
   浅色主题下把页面糊成浅灰反而会让图发飘 */
.viewer {
  position: fixed;
  inset: 0;
  z-index: 60;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--sp-5);
  background: rgba(16, 16, 18, 0.86);
  backdrop-filter: blur(20px) saturate(120%);
  -webkit-backdrop-filter: blur(20px) saturate(120%);
}
/* 盒子收缩到图的大小、且不带底色 —— 白卡一撤,图才真的"浮"起来 */
.viewer-box {
  position: relative;
  display: inline-flex;
  flex-direction: column;
  max-width: 100%;
  max-height: 100%;
  min-width: 0;
}
.viewer-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-3);
  min-height: 40px;
  margin-bottom: 12px;
  padding-left: 2px;
}
/* 与设定图格子同一套眉标写法:它答的是同一个问题(这是哪一视图) */
.viewer-head {
  display: flex;
  align-items: baseline;
  gap: 10px;
  min-width: 0;
}
.viewer-label {
  font-size: var(--fs-xs);
  font-weight: 600;
  letter-spacing: var(--ls-eyebrow);
  text-transform: uppercase;
  color: rgba(252, 251, 249, 0.78);
}
/* 翻到第几张:比标签再淡一档 —— 它是注解,不是标题 */
.viewer-pos {
  flex: none;
  font-size: var(--fs-xs);
  font-variant-numeric: tabular-nums;
  color: rgba(252, 251, 249, 0.42);
}
.viewer-x {
  flex: none;
  width: 40px;
  height: 40px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 999px;
  background: rgba(252, 251, 249, 0.12);
  color: #fbfaf7;
  cursor: pointer;
  transition: background var(--dur) var(--ease);
}
.viewer-x:hover {
  background: rgba(252, 251, 249, 0.24);
}
.viewer-x svg {
  width: 16px;
  height: 16px;
}
.viewer-stage {
  position: relative;
  display: flex;
  align-items: center;
  min-height: 0;
}
.viewer-img {
  display: block;
  max-width: 100%;
  max-height: calc(100vh - 210px);
  object-fit: contain;
  border-radius: var(--r-lg);
  background: var(--stage-bg);
  box-shadow: 0 24px 60px rgba(0, 0, 0, 0.45);
}
/* 翻页钮压在图的两侧边上,而不是把图挤窄 ——
   和角色卡、设定图格子是同一套"浮层压在照片上"的语言。
   两只钮靠 :first-of-type / :last-of-type 分左右(图不是 button,不参与) */
.viewer-nav {
  position: absolute;
  top: 50%;
  z-index: 2;
  width: 40px;
  height: 40px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 999px;
  background: rgba(24, 24, 22, 0.44);
  color: #fbfaf7;
  backdrop-filter: blur(10px);
  -webkit-backdrop-filter: blur(10px);
  transform: translateY(-50%);
  cursor: pointer;
  transition: background var(--dur) var(--ease);
}
.viewer-nav:first-of-type {
  left: 10px;
}
.viewer-nav:last-of-type {
  right: 10px;
}
.viewer-nav:hover {
  background: rgba(24, 24, 22, 0.68);
}
.viewer-nav svg {
  width: 16px;
  height: 16px;
}
/* 动作排在图下方、居中。
   只剩一个动作了(重新生成 / 停止),所以它直接是纸色实心 ——
   在深底上必须一眼看得出这是可点的;两枚淡玻璃的旧写法连边界都看不清 */
.viewer-acts {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  margin-top: 16px;
}
.viewer-acts .ed-btn {
  padding: 10px 20px;
  border-color: transparent;
  background: #fbfaf7;
  color: #1a1a18;
  font-weight: 600;
}
.viewer-acts .ed-btn:hover:not(:disabled) {
  border-color: transparent;
  background: #fff;
  color: #000;
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

/* 放不下两栏时右栏落到信息区上面,成为一条横向摘要。
   断点定在 860px:再窄下去,信息区就只剩 500px 出头,
   两列字段每栏 230px 上下,一个 12 词的字段值要折三行 */
@media (max-width: 860px) {
  .wz-body {
    flex-direction: column;
  }
  .wz-rail {
    width: auto;
    max-height: 32vh;
    border-left: 0;
    border-bottom: 1px solid var(--line);
  }
  /* 竖向的那张缩略图在这一条里太占地方,收成一行:小图 + 标签 */
  .wz-rail-shot {
    flex-direction: row;
    align-items: center;
    gap: var(--sp-2);
  }
  .wz-rail-shot img {
    width: 64px;
    flex: none;
  }
}

@media (max-width: 720px) {
  /* 窄屏时标签左、值右会挤不下(88 + 12 + 分段控件 ~150 就顶到边了):
     标签回到值上面,行变成上下两段 */
  .wz-fields > .wz-field,
  .wz-basics > .wz-field {
    flex-direction: column;
    align-items: stretch;
    gap: 6px;
  }
  /* 标签在值上方,88px 那一列不复存在,自然拿到整行宽 */
  .wz-label {
    width: auto;
    padding-top: 0;
  }
  .wz-sex {
    align-self: flex-start;
  }
  /* 上下两段之后"左缘那条短竖线"要跟着缩:它标的是这一行,不是这一整块 */
  .wz-field::after {
    top: 9px;
    bottom: auto;
    height: 18px;
  }
  /* 列里不能让输入框 flex:1 —— 主轴变成竖的,flex-basis:0 会把文本域压没 */
  .wz-field > .ed-input {
    flex: none;
    width: 100%;
  }
  /* 16px 以下 iOS Safari 聚焦时会放大整页(与提示词库同一档处理)。
     名字那栏现在也用 .ed-input,所以一并覆盖到了。
     起稿那一栏得单独写一遍:它的选择器是 textarea.wz-idea(为了压过 .ed-input),
     那一条比这儿的 .ed-input 高一档,不重申就还是 15px */
  .ed-input,
  textarea.wz-idea {
    font-size: 16px;
  }
  /* 窄屏:提示与按钮各占一行(按钮满宽,触控目标也够大)——
     原来这一行是"输入框 + 按钮挤在一起",输入框只剩十来厘米宽 */
  .wz-draft-foot .wz-err,
  .wz-draft-foot .wz-draft-hint {
    width: 100%;
  }
  .wz-draft-foot .ed-btn {
    width: 100%;
    height: 44px;
  }
  /* 窄屏:三步的标签一起挤会先被截断的是第三段,
     所以把连接线收短、步间距压小 —— 圆点比标签更需要留在原地 */
  .wz-steps {
    gap: 6px;
    padding: 12px var(--sp-4);
  }
  /* 三张卡之间、以及卡与屏幕边之间的留白都收一档:
     视口本来就窄,给表单多留一点宽度 */
  .wizard {
    gap: var(--sp-3);
    padding: var(--sp-3);
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
     但留白仍比桌面端紧不了太多 —— 信息已经只剩三行了 */
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
  .hero-shot {
    width: 104px;
    border-radius: 16px;
  }
  .hero-cta {
    width: 100%;
  }
  /* 窄屏放不下"左四右一":竖幅那一列会被压成细条。
     改成方块自己 2×2,竖幅另起一行居中,并给它一个高度上限 ——
     2:3 的图占满整屏宽会长到屏幕外面去 */
  .sheet {
    grid-template-columns: 1fr 1fr;
  }
  .cell.is-portrait {
    grid-column: 1 / -1;
    grid-row: auto;
  }
  .cell.is-portrait .cell-img {
    height: 46vh;
    width: auto;
    align-self: center;
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

</style>
