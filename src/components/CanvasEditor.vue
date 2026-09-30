<script setup lang="ts">
import { ref, computed, nextTick, onBeforeUnmount, watch } from 'vue'
import {
  PhArrowsOutCardinal,
  PhCrop,
  PhLasso,
  PhEraser,
  PhSelection,
  PhArrowCounterClockwise,
  PhArrowClockwise,
  PhArrowUUpLeft,
  PhArrowUUpRight,
  PhFlipHorizontal,
  PhFlipVertical,
  PhMagnifyingGlassPlus,
  PhMagnifyingGlassMinus,
  PhCornersOut,
  PhClockCounterClockwise,
  PhCaretRight,
  PhFloppyDisk,
  PhX,
  PhTrash,
  PhPlus,
  PhMinus,
  PhMountains,
  PhUploadSimple,
  PhCheckerboard,
  PhMagicWand,
  PhSparkle,
  PhPaperPlaneRight,
  PhStop
} from '@phosphor-icons/vue'
import { editImage, extOf, generateFrom, imageSrc } from '../api'
import type { ApiConfig, EditMode, ResultItem } from '../types'

/* 自由画布 · P0:本地变换 + 保存成一条新记录。
   这里刻意不接任何出图接口 —— 裁剪、旋转、翻转都是确定性操作,
   当场算完就是最终像素,没有"再问一次模型"的余地。

   一条设计主线:图像状态由「原始位图 + 操作序列」推导,而不是层层叠加的结果位图。
   撤销就是把操作弹掉重放一遍。这样撤销栈天然可逆、内存恒定,
   而且操作序列本身就是这张图"经历过什么"的完整说明(将来要回放/继续编辑都用它)。 */

/* ===== 操作序列 =====================================================
   三种操作,坐标都相对"执行到它那一刻的图像"。按顺序重放必然自洽:
   用户是在当时看到的画面上画的裁剪框,重放时看到的也正是同一个画面。
   ------------------------------------------------------------------ */
type Rect = { x: number; y: number; w: number; h: number }
type Point = { x: number; y: number }
/* 几何操作:坐标相对"执行到它那一刻的图像",重放必然自洽。
   AI 编辑是另一支,见 AiOp */
type Op =
  | { k: 'rotate'; deg: number }
  | { k: 'flip'; axis: 'h' | 'v' }
  | { k: 'crop'; rect: Rect }
  | AiOp

/* AI 编辑那一步。它与上面三种有个根本差别:后者的结果是算出来的,
   而"去掉背景之后长什么样"只有上游知道 —— 所以这一支自己带着结果位图,
   applyOp 遇到它就直接换上,不重算。撤销之后重做、直接跳到某一步,
   走的都是同一份结果,不会二次调用接口(那既慢又要花钱)。

   存位图而不是 Blob:重放是同步的(见 rebuild 与 buildSteps),
   而 Blob 得异步解码。这份内存由 resetAll 收口 —— 换图、撤图时统一 close */
type AiOp = {
  k: 'ai'
  /* 左栏与步骤条上的说法,如 'Background removed'。
     存下来是因为事后从位图上认不出这一步做了什么 */
  label: string
  bitmap: ImageBitmap
}

const props = defineProps<{
  /* 这一页是不是当前显示的那一页。画布常驻挂载(v-show 切换),
     这样切去历史挑张图再切回来,手上的裁剪框还在 —— 它是工作台,不是弹窗 */
  active: boolean
  item: ResultItem | null
  /* AI 编辑要用它发请求。这一页平时不发请求(保存与上传都交给主界面),
     唯独局部编辑不能转那一手:结果要当场换成画布上的一帧,
     来回传递的话,中间那张位图的生命周期没人管得住 */
  config: ApiConfig | null
}>()

const emit = defineEmits<{
  // 把编辑结果交出去落盘。一张图存成一条新记录,不是覆盖原图
  (e: 'save', payload: { blob: Blob; w: number; h: number }): void
  // 把图从画布上撤下(回空态)。状态由主界面持有,所以这里只说一声
  (e: 'discard'): void
  // 空态里的去处:去历史挑一张
  (e: 'pick'): void
  /* 选好的一张本地图片。解码与落盘归主界面 ——
     这一页只认"画布上摆着哪张图",不管它从哪来 */
  (e: 'upload', file: File): void
}>()

/* ===== 本地上传 =====
   input 藏在按钮后面。它的 value 每次都要清掉:
   文件选完之后不清,同一张图再选一次不会触发 change */
const fileEl = ref<HTMLInputElement | null>(null)
function pickFile() {
  fileEl.value?.click()
}
function onFileChange(e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  // 只认图片。挑到别的东西时安静地忽略,不必为一次误触弹一条错误
  if (!file || !file.type.startsWith('image/')) return
  emit('upload', file)
}

/* ===== 左栏的悬停提示 =====
   走事件委托:这一条上十几个键,不必每个都挂一对进出监听。
   指针或焦点落到带 data-tip 的键上,就把提示摆到它右手边 ——
   位置每次现算,所以展开、滚动都不会错位 */
let tipTimer = 0
function showRailTip(e: Event) {
  const el = (e.target as HTMLElement | null)?.closest<HTMLElement>('[data-tip]')
  const body = bodyEl.value
  window.clearTimeout(tipTimer)
  if (!el || !body) return hideRailTip()
  const r = el.getBoundingClientRect()
  const b = body.getBoundingClientRect()
  const text = el.dataset.tip ?? ''
  // 与全站的悬停气泡同一个节奏:稍等一下再冒出来,
  // 鼠标扫过一排键时才不会闪成一片(那边是 250ms 的 transition-delay)
  tipTimer = window.setTimeout(() => {
    railTip.value = {
      text,
      // 贴着这个键的右缘(与全站的 calc(100% + 8px) 同一个间距),竖直居中
      x: r.right - b.left + 8,
      y: r.top - b.top + r.height / 2
    }
  }, 250)
}
function hideRailTip() {
  window.clearTimeout(tipTimer)
  if (!railTip.value.text) return
  railTip.value = { ...railTip.value, text: '' }
}

/* ===== 视图状态 ===== */
/* 四种工具:平移看图、矩形裁剪、套索框选、橡皮。
   后三种都是"先圈一块地方,再决定拿它做什么",区别在形状 ——
   裁剪只认矩形(它有八个手柄、要贴合边界),套索认任意形状,
   橡皮则是"抹"出来的:细长的、断续的、边擦边看的那些活只有它顺手 */
const tool = ref<'pan' | 'crop' | 'lasso' | 'eraser'>('pan')
/* 左栏那几组低频操作展开着没有。它纯粹是个界面开关,不属于编辑状态 ——
   所以换图、复位都不用管它 */
const showMore = ref(false)
/* 左栏键的悬停提示。它渲染在 .cv-body 这一层、不在按钮里 ——
   左栏内部有滚动容器,跟在按钮旁边的那种气泡会被那块裁掉半个 */
const railTip = ref({ text: '', x: 0, y: 0 })
// 当前图像(已应用全部操作)的像素尺寸。响应式是因为要显示在顶栏
const imgW = ref(0)
const imgH = ref(0)
// view.x/y 是图像左上角在舞台里的 CSS 像素位置(不是图像坐标)
const view = ref({ scale: 1, x: 0, y: 0 })

const loading = ref(true)
const saving = ref(false)
const error = ref('')
/* 在途的是哪一件。四类编辑各有自己的起点,而"照这张再画一张"不在 EditMode 里
   (它打的是出图那条端点),所以并成一支 */
type JobKind = EditMode | 'create'

/* 在途的那一次 AI 请求,以及它是哪一件。有值时画布上要说清"正在算",
   也不再接第二个请求。
   记着 kind 是为了让对应的那颗键变成"停止" —— 只看"有没有在途"的话,
   三颗 AI 键会一起转圈,而停止键会同时冒出三个。

   它放在这一堆界面状态里而不是紧挨着 runJob:左栏、步骤条、取景都要看它,
   而它们散在这个文件的前半段 —— 声明得太晚,那几处就只能读到未初始化 */
const job = ref<{ kind: JobKind; label: string } | null>(null)

/* 刚被停下来的那一下要有个交代:盘子撤掉和"算失败了"看起来一模一样,
   不吭声的话用户分不清是停了还是坏了 */
const stopped = ref(false)
let stopTimer = 0
// 有未保存的改动时,关掉之前先问一句 —— 转了半天随手按 Esc 就白干最伤人
const confirmDiscard = ref(false)

const bodyEl = ref<HTMLElement | null>(null)
const stageEl = ref<HTMLElement | null>(null)
const canvasEl = ref<HTMLCanvasElement | null>(null)
/* 两块浮层(左上工具条、左下步骤条)。它们压在画布上,
   取景时要按实际尺寸把它们占的地方让出来,所以得量一量 */
const railEl = ref<HTMLElement | null>(null)
const stripEl = ref<HTMLElement | null>(null)

/* 非响应式的那几份:位图与画布是活的 DOM 对象,
   套上响应式代理既没意义,还会在上游(IndexedDB 结构化克隆)出问题 */
let source: ImageBitmap | null = null
let base: HTMLCanvasElement | null = null
/* 第几次载入。异步解码回来时对不上就说明这张已经过时了(见 load) */
let loadToken = 0

/* 操作序列本身用响应式,界面要靠它算撤销/重做按钮的可用状态 */
const ops = ref<Op[]>([])
const redoOps = ref<Op[]>([])
const cropRect = ref<Rect | null>(null)
/* 套索圈出来的多边形,图像坐标。它和 cropRect 一样只是"还没落地的选区":
   不参与操作序列,真正的改动发生在用户点"清除"之后(见 eraseSelection) */
const lassoPath = ref<Point[] | null>(null)
/* 橡皮抹过的痕迹。一串独立的笔画 —— 与套索那个"一个闭合多边形"不同:
   橡皮可以提起再落下,每一次起落各算一笔,合起来才是要擦的范围 */
const strokes = ref<Point[][]>([])
/* 笔头直径,图像坐标(不是屏幕坐标)。定在图像这一侧才说得通:
   它是"擦掉多大的像素块",放大看再擦时该变细,而不是跟着屏幕一起变粗 */
const eraserSize = ref(80)
/* 光标在图像坐标里的位置。橡皮得让用户看清这一下会盖多宽 ——
   没有这个圈,大小只能靠试 */
const hoverPt = ref<Point | null>(null)

/* 局部重绘那句话。开着的时候套索那条浮条从"三个按钮"换成"一个输入框" ——
   同一个位置、同一块选区,先圈地方再说是要把这块改成什么 */
const regenOpen = ref(false)
const regenText = ref('')
const regenEl = ref<HTMLTextAreaElement | null>(null)

/* 换背景那句话。与上面那条分开,是因为它没有选区可依附:
   改的是整幅图,输入框按"整幅"的位置摆(见 .cv-bar 的定位) */
const bgOpen = ref(false)
const bgText = ref('')
const bgEl = ref<HTMLTextAreaElement | null>(null)

/* 按这张图再画一张。参考图不用挑 —— 就是画布现在这张,
   所以要写的只有"画成什么样"。与换背景那张同占舞台顶上,靠 genOpen 互斥 */
const genOpen = ref(false)
const genText = ref('')
const genEl = ref<HTMLTextAreaElement | null>(null)

const canUndo = computed(() => ops.value.length > 0)
const canRedo = computed(() => redoOps.value.length > 0)
const dirty = computed(
  () =>
    ops.value.length > 0 ||
    !!cropRect.value ||
    !!lassoPath.value ||
    strokes.value.length > 0
)

/* 画面改到第几版了。ops / redoOps 一动就 +1。
   存完不再撤图,所以"这一下点保存,会不会又存出一条一模一样的"需要有人记着:
   记的是上一次存的时候画面是第几版(见 save 与 finishSave) */
const rev = ref(0)
watch([ops, redoOps], () => {
  rev.value++
})
/* 上一次成功保存时的版本。存过之后画面没再动过,这个键就该是灰的 ——
   而不是让人多点一次,多出一条自己都不知道从哪来的记录 */
const savedRev = ref(-1)
const canSave = computed(
  () => !!props.item && !saving.value && rev.value !== savedRev.value
)

/* 三个选区工具各有各的用处。切进其中一个时,把另外两个收掉 ——
   留着它会在切回来那一刻突然冒出来,像是自己长出来的;而且底下那条浮条
   是先看裁剪框的,留着会让它认错对象。
   切到平移一律不清:那是"换个角度看",手上的选区还该在(按空格临时平移同理) */
watch(tool, (t, prev) => {
  if (t === 'pan' || t === prev) return
  if (t !== 'crop') cropRect.value = null
  if (t !== 'lasso') lassoPath.value = null
  if (t !== 'eraser') strokes.value = []
  schedule()
})

/* 选区在舞台里的位置(舞台坐标系)。浮在选区旁的那条上下文操作靠它定位 ——
   跟着拖动实时走,所以从图像坐标换算一次,而不是在事件里各算一遍 */
const selBox = computed(() => {
  const v = view.value
  const r = cropRect.value
  if (r) {
    return {
      x: v.x + r.x * v.scale,
      y: v.y + r.y * v.scale,
      w: r.w * v.scale,
      h: r.h * v.scale
    }
  }
  /* 套索没有"宽高"可言,浮条要的只是它占了哪块地方 ——
     取外接矩形就够:它只用来决定浮条摆哪儿 */
  const path = lassoPath.value
  if (!path?.length) return null
  let x1 = Infinity
  let y1 = Infinity
  let x2 = -Infinity
  let y2 = -Infinity
  for (const p of path) {
    x1 = Math.min(x1, p.x)
    y1 = Math.min(y1, p.y)
    x2 = Math.max(x2, p.x)
    y2 = Math.max(y2, p.y)
  }
  return {
    x: v.x + x1 * v.scale,
    y: v.y + y1 * v.scale,
    w: (x2 - x1) * v.scale,
    h: (y2 - y1) * v.scale
  }
})
/* 贴边时把浮条夹回舞台内,别让它半个身子探出去。
   宽高是估的 —— 它只是用来夹边界,不参与布局。
   写指令那会儿它换成一整块输入区,比胶囊宽也高,所以尺寸跟着形态走 */
const CTX_W = 300
const CTX_H = 44
const CTX_W_COMPOSE = 320
const CTX_H_COMPOSE = 110
const ctxStyle = computed(() => {
  const b = selBox.value
  const s = stageEl.value
  if (!b || !s) return {}
  const w = regenOpen.value ? CTX_W_COMPOSE : CTX_W
  const h = regenOpen.value ? CTX_H_COMPOSE : CTX_H
  const above = b.y - h - 10 >= 0
  const x = clamp(b.x + b.w / 2, w / 2 + 8, s.clientWidth - w / 2 - 8)
  return {
    left: `${x}px`,
    top: above ? `${b.y - 10}px` : `${b.y + b.h + 10}px`,
    transform: above ? 'translate(-50%, -100%)' : 'translate(-50%, 0)'
  }
})
const zoomPct = computed(() => Math.round(view.value.scale * 100))

const MIN_ZOOM = 0.05
const MAX_ZOOM = 8
/* 选区小于这个像素数就当作误触丢弃(图像坐标,不是屏幕坐标) */
const MIN_CROP = 8
/* 笔头直径的两端(图像坐标)。上限给得比较宽 —— 整幅擦掉一块背景也是橡皮
   的正当用法,那种时候需要一把很宽的刷子 */
const ERASER_MIN = 4
const ERASER_MAX = 1200
/* 画布单边的安全上限。各家浏览器的真上限不一样(桌面很高,iOS 上约 4096,
   而且是按面积算的),但一张手机原片随手就超过 4000。超了不是报错,
   是 drawImage 静默失败 —— 屏幕上一片空白,连原因都看不出来。
   所以进来的图先按这个上限缩一次:丢的是原始分辨率,换的是这张图能编辑 */
const MAX_EDGE = 3840
/* 步骤小图的边长(位图)。CSS 里显示成一半,视网膜屏上才够清楚 */
const STEP_PX = 96

/* ===== 图像管线 =====================================================
   把操作序列重放到原始位图上,得到当前图像。
   每次改动都从头重放而不是增量修改:一张 4096 的图像重放一次是毫秒级,
   而增量方案要在每次撤销时反推"上一步做了什么",那是自找麻烦。
   ------------------------------------------------------------------ */
function newCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas')
  c.width = Math.max(1, Math.round(w))
  c.height = Math.max(1, Math.round(h))
  return c
}

/** 原图那一帧 */
function firstFrame(src: ImageBitmap): HTMLCanvasElement {
  const c = newCanvas(src.width, src.height)
  c.getContext('2d')!.drawImage(src, 0, 0)
  return c
}

/** 把一步操作应用到当前画面上,交出新的画布(原画布不动) */
function applyOp(cur: HTMLCanvasElement, op: Op): HTMLCanvasElement {
  if (op.k === 'ai') {
    /* 结果位图自己就是完整的一幅新画面,与"上一帧"无关 ——
       这里不读 cur,只把它按自己的尺寸铺出来 */
    const out = newCanvas(op.bitmap.width, op.bitmap.height)
    out.getContext('2d')!.drawImage(op.bitmap, 0, 0)
    return out
  }
  if (op.k === 'rotate') {
    const deg = ((op.deg % 360) + 360) % 360
    // 90° / 270° 要交换画布宽高,否则转完会被裁掉一条
    const swap = deg === 90 || deg === 270
    const out = newCanvas(swap ? cur.height : cur.width, swap ? cur.width : cur.height)
    const c = out.getContext('2d')!
    c.translate(out.width / 2, out.height / 2)
    c.rotate((deg * Math.PI) / 180)
    c.drawImage(cur, -cur.width / 2, -cur.height / 2)
    return out
  }
  if (op.k === 'flip') {
    const out = newCanvas(cur.width, cur.height)
    const c = out.getContext('2d')!
    c.translate(op.axis === 'h' ? cur.width : 0, op.axis === 'v' ? cur.height : 0)
    c.scale(op.axis === 'h' ? -1 : 1, op.axis === 'v' ? -1 : 1)
    c.drawImage(cur, 0, 0)
    return out
  }
  const r = clampToImage(op.rect, cur.width, cur.height)
  const out = newCanvas(r.w, r.h)
  out.getContext('2d')!.drawImage(cur, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h)
  return out
}

function replay(src: ImageBitmap, list: Op[]): HTMLCanvasElement {
  let cur = firstFrame(src)
  for (const op of list) cur = applyOp(cur, op)
  return cur
}

/* ===== 步骤条 ======================================================
   底部那条缩略图:第一张是原图,之后每加一个操作多一张。
   数据直接从操作序列推出来,不额外存状态 ——
   撤销掉的那一步自然就从条上消失了。
   点其中一张就回到那一步(见 goStep)。
   ------------------------------------------------------------------ */
const stepUrls = ref<string[]>([])
const trackEl = ref<HTMLElement | null>(null)

/* 步骤条什么时候露面。动过图之后它才出现 —— 它说的是"改到哪一步了",
   没动过图时那一排只有原图,白占位置。
   在途那一次是例外:结果还没回来,但"有件事正在算"得立刻看得见,
   而且它算完要落在哪儿,也得先把格子腾出来 */
const showStrip = computed(() => !!props.item && (stepUrls.value.length > 1 || !!job.value))

/* 步骤条有多高,得让左栏知道 —— 它俩都在左下角抢同一块地方,
   不报出去的话那条竖栏会一路铺到卡片底下,被步骤条压住
   (见 .cv-rail 的 max-height)。
   只把"被占掉多少"写成 CSS 变量,不在 JS 里替左栏算高度:高度是 CSS 的事 */
function measureStrip() {
  bodyEl.value?.style.setProperty('--strip-h', `${stripEl.value?.offsetHeight ?? 0}px`)
}

/* 步数一多,条会横向长出去,最新那一步就落在框外 ——
   而它恰恰是最该被看见的那个,所以每加一步就把它带进视野。
   在途时最该看见的是那枚转圈,不是"当前那一步" */
watch(
  () => [ops.value.length, !!job.value] as const,
  () => {
    nextTick(() => {
      const el = job.value
        ? trackEl.value?.querySelector('.step.is-job')
        : trackEl.value?.querySelector('.step.on')
      el?.scrollIntoView({ inline: 'nearest', block: 'nearest' })
    })
  }
)

/* 步骤条是动过图之后才出现的,它一出现,画布下沿就多出一块浮层。
   这时候重新取一次景:不然图的下边正好被它压住(只在这一下重新取景,
   之后不再动 —— 用户自己调过的视角不该被后面的操作打断)。
   判断依据和那条 v-if 用同一份,在途时占位把它带出来的那一下也算 */
watch(showStrip, async (on) => {
  /* 等它真的挂上去才量得到高度 —— 这一下也是它第一次有机会被量 */
  await nextTick()
  measureStrip()
  if (on && base) fit()
})

/** 一张方形的步骤小图。用 data URL 而不是 object URL:
 *  它跟着这份列表一起换掉,不必再操心释放 */
function stepShot(c: HTMLCanvasElement): string {
  const t = newCanvas(STEP_PX, STEP_PX)
  const ctx = t.getContext('2d')!
  const k = Math.min(STEP_PX / c.width, STEP_PX / c.height)
  const w = c.width * k
  const h = c.height * k
  // 按长边贴合、居中留白:方框里能一眼看出这张是横是竖
  ctx.drawImage(c, (STEP_PX - w) / 2, (STEP_PX - h) / 2, w, h)
  return t.toDataURL()
}

function buildSteps() {
  if (!source) {
    stepUrls.value = []
    return
  }
  /* 撤掉的那几步也要画出来。它们没消失,只是退到了重做栈里 ——
     条上留着它们,才看得出"刚才改到哪儿",也才能一点就回去。
     两段接起来正好是完整的时间线:重做栈的栈顶就是紧接着当前的那一步 */
  const urls: string[] = []
  let cur = firstFrame(source)
  urls.push(stepShot(cur))
  for (const op of [...ops.value, ...redoOps.value]) {
    const next = applyOp(cur, op)
    /* 上一帧用完了就把画布清空:一张 4000px 的画布是几十 MB,
       十几步攒下来会把内存吃光(显式清空比等 GC 更稳) */
    cur.width = 0
    cur.height = 0
    cur = next
    urls.push(stepShot(cur))
  }
  cur.width = 0
  cur.height = 0
  stepUrls.value = urls
}

/** 重放一遍并刷新画面。两种选区都属于"还没落地的操作",每次重放都要清掉 ——
 *  它们是相对当时那张画面画的,画面变了就不再指同一块地方 */
function rebuild(refit = true) {
  if (!source) return
  base = replay(source, ops.value)
  imgW.value = base.width
  imgH.value = base.height
  cropRect.value = null
  lassoPath.value = null
  strokes.value = []
  buildSteps()
  if (refit) fit()
  schedule()
}

/* ===== 视图:适配 / 缩放 / 平移 ===== */
function fit() {
  const s = stageEl.value
  if (!s || !imgW.value || !imgH.value) return
  /* 工具条在左上、步骤条在左下,它们浮在画布上。
     图就在整块画布里居中,但可用范围要把这两块让出来 ——
     否则大图的一角正好压在它们底下,而那块是看不到的 */
  const PAD = 24
  const railW = railEl.value?.offsetWidth ?? 0
  const stripH = stripEl.value?.offsetHeight ?? 0
  const left = PAD + (railW ? railW + PAD : 0)
  const bottom = PAD + (stripH ? stripH + PAD : 0)
  const w = s.clientWidth - left - PAD
  const h = s.clientHeight - PAD - bottom
  if (w <= 0 || h <= 0) return
  // 小图也允许放大:细看几个像素的时候,把 200px 的图缩在中间是没法用的
  const k = clamp(Math.min(w / imgW.value, h / imgH.value), MIN_ZOOM, MAX_ZOOM)
  view.value = {
    scale: k,
    x: left + (w - imgW.value * k) / 2,
    y: PAD + (h - imgH.value * k) / 2
  }
  schedule()
}

/** 以某个舞台内坐标为锚点缩放:光标底下的那个像素保持不动 */
function zoomAt(px: number, py: number, factor: number) {
  const v = view.value
  const k = clamp(v.scale * factor, MIN_ZOOM, MAX_ZOOM)
  if (k === v.scale) return
  const f = k / v.scale
  view.value = { scale: k, x: px - (px - v.x) * f, y: py - (py - v.y) * f }
  schedule()
}

function zoomStep(factor: number) {
  const s = stageEl.value
  if (!s) return
  zoomAt(s.clientWidth / 2, s.clientHeight / 2, factor)
}

/** 回到 1:1(一个图像像素对一个 CSS 像素)。比值而不是倍数 ——
 *  缩放系数是相对当前比例算的,传 1 等于什么都没做 */
function zoomTo100() {
  const s = stageEl.value
  if (!s) return
  zoomAt(s.clientWidth / 2, s.clientHeight / 2, 1 / view.value.scale)
}

/* ===== 绘制 ========================================================
   每帧整体重画:图像一张 drawImage,选区几笔路径。
   分两层画布(图像/选区)在这里没有收益,反而多一份显存。
   ------------------------------------------------------------------ */
let frame = 0
function schedule() {
  if (frame) return
  frame = requestAnimationFrame(() => {
    frame = 0
    draw()
  })
}

function draw() {
  const c = canvasEl.value
  const s = stageEl.value
  if (!c || !s) return
  const dpr = window.devicePixelRatio || 1
  const w = s.clientWidth
  const h = s.clientHeight
  const bw = Math.max(1, Math.round(w * dpr))
  const bh = Math.max(1, Math.round(h * dpr))
  if (c.width !== bw || c.height !== bh) {
    c.width = bw
    c.height = bh
  }
  const ctx = c.getContext('2d')
  if (!ctx) return
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, w, h)
  if (!base) return

  const v = view.value
  const dw = imgW.value * v.scale
  const dh = imgH.value * v.scale
  // 缩小看大图时用高质量重采样,否则细密纹理会出现摩尔纹
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(base, v.x, v.y, dw, dh)

  const r = cropRect.value
  const path = lassoPath.value

  /* 套索圈出来的那块:与裁剪框同一套画法 ——
     选区之外压暗,让圈住的地方自己亮着。
     松手之前也在画,不然手上那条线没有反馈 */
  if (path && path.length > 1) {
    const pts = path.map((q) => ({ x: v.x + q.x * v.scale, y: v.y + q.y * v.scale }))
    const trace = () => {
      ctx.moveTo(pts[0].x, pts[0].y)
      for (const q of pts.slice(1)) ctx.lineTo(q.x, q.y)
      ctx.closePath()
    }
    ctx.beginPath()
    ctx.rect(0, 0, w, h)
    trace()
    ctx.fillStyle = 'rgba(0, 0, 0, 0.45)'
    ctx.fill('evenodd')

    ctx.beginPath()
    trace()
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)'
    ctx.lineWidth = 1
    ctx.stroke()
  }

  /* 橡皮抹过的地方:半透明红盖上去。
     这里没用"选区之外压暗"那一套 —— 笔迹是零散断续的,压暗会把整张图弄黑,
     而用户要看的恰恰是"我擦到了哪几片"。红是这类工具的通用说法:这块要没了。
     画的条件不看当前工具:切去平移只是"换个角度看",手上这些笔迹不该消失 */
  const marks = strokes.value
  if (marks.length) {
    ctx.save()
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.lineWidth = eraserSize.value * v.scale
    ctx.strokeStyle = 'rgba(255, 82, 82, 0.42)'
    for (const s of marks) {
      if (!s.length) continue
      const x = v.x + s[0].x * v.scale
      const y = v.y + s[0].y * v.scale
      ctx.beginPath()
      ctx.moveTo(x, y)
      if (s.length === 1) {
        // 点一下没拖:圆头描边画不出东西,补一段零长的线
        ctx.lineTo(x + 0.01, y)
      } else {
        for (const q of s.slice(1)) ctx.lineTo(v.x + q.x * v.scale, v.y + q.y * v.scale)
      }
      ctx.stroke()
    }
    ctx.restore()
  }

  /* 光标底下那个圈:这一下会盖多宽,得在落笔之前就看得见 */
  const hp = hoverPt.value
  if (tool.value === 'eraser' && hp) {
    ctx.save()
    ctx.beginPath()
    ctx.arc(
      v.x + hp.x * v.scale,
      v.y + hp.y * v.scale,
      (eraserSize.value * v.scale) / 2,
      0,
      Math.PI * 2
    )
    /* 一道白线加一圈黑影:图的明暗是用户自己的,单一颜色总会撞上某一处 */
    ctx.shadowColor = 'rgba(0, 0, 0, 0.6)'
    ctx.shadowBlur = 3
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)'
    ctx.lineWidth = 1
    ctx.stroke()
    ctx.restore()
  }

  if (!r) return
  const x = v.x + r.x * v.scale
  const y = v.y + r.y * v.scale
  const rw = r.w * v.scale
  const rh = r.h * v.scale

  /* 选区之外压暗。用 evenodd 一次填充挖洞 ——
     先铺暗再 clearRect 会把图也一起擦掉 */
  ctx.fillStyle = 'rgba(0, 0, 0, 0.45)'
  ctx.beginPath()
  ctx.rect(0, 0, w, h)
  ctx.rect(x, y, rw, rh)
  ctx.fill('evenodd')

  ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)'
  ctx.lineWidth = 1
  ctx.strokeRect(x + 0.5, y + 0.5, rw - 1, rh - 1)

  // 三分线:裁剪时判断重心全靠它,值这几笔
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.35)'
  ctx.beginPath()
  for (let i = 1; i < 3; i++) {
    ctx.moveTo(x + (rw * i) / 3, y)
    ctx.lineTo(x + (rw * i) / 3, y + rh)
    ctx.moveTo(x, y + (rh * i) / 3)
    ctx.lineTo(x + rw, y + (rh * i) / 3)
  }
  ctx.stroke()

  // 八个手柄:白底深边,压在任何颜色的图上都看得见
  const hs = 4
  ctx.fillStyle = '#ffffff'
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.6)'
  for (const p of handlePoints(r)) {
    const hx = v.x + p.x * v.scale
    const hy = v.y + p.y * v.scale
    ctx.beginPath()
    ctx.rect(hx - hs, hy - hs, hs * 2, hs * 2)
    ctx.fill()
    ctx.stroke()
  }
}

/* ===== 选区几何 ===== */
type Handle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w'

function handlePoints(r: Rect): Array<{ h: Handle; x: number; y: number }> {
  const x2 = r.x + r.w
  const y2 = r.y + r.h
  const mx = r.x + r.w / 2
  const my = r.y + r.h / 2
  return [
    { h: 'nw', x: r.x, y: r.y },
    { h: 'n', x: mx, y: r.y },
    { h: 'ne', x: x2, y: r.y },
    { h: 'e', x: x2, y: my },
    { h: 'se', x: x2, y: y2 },
    { h: 's', x: mx, y: y2 },
    { h: 'sw', x: r.x, y: y2 },
    { h: 'w', x: r.x, y: my }
  ]
}

function clampToImage(r: Rect, w: number, h: number): Rect {
  const x1 = clamp(Math.min(r.x, r.x + r.w), 0, w)
  const y1 = clamp(Math.min(r.y, r.y + r.h), 0, h)
  const x2 = clamp(Math.max(r.x, r.x + r.w), 0, w)
  const y2 = clamp(Math.max(r.y, r.y + r.h), 0, h)
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 }
}

/** 夹进图像范围内。套索的点在收进来时就夹好 ——
 *  手可以划出画布,但记录下来的形状不该超出边界 */
function clampPoint(p: Point): Point {
  return { x: clamp(p.x, 0, imgW.value), y: clamp(p.y, 0, imgH.value) }
}

/** 舞台坐标 → 图像坐标 */
function toImage(clientX: number, clientY: number) {
  const s = stageEl.value!
  const box = s.getBoundingClientRect()
  return {
    x: (clientX - box.left - view.value.x) / view.value.scale,
    y: (clientY - box.top - view.value.y) / view.value.scale
  }
}

/* ===== 指针交互 ====================================================
   指针用 Pointer Events 统一处理:鼠标、触控笔、手指走同一条路,
   不必为触屏另写一套。双指缩放单独一条分支(见 pinch)。
   ------------------------------------------------------------------ */
type Drag =
  | { mode: 'pan'; sx: number; sy: number; ox: number; oy: number }
  | { mode: 'new'; ax: number; ay: number }
  | { mode: 'move'; sx: number; sy: number; rect: Rect }
  | { mode: 'resize'; handle: Handle; rect: Rect }
  | { mode: 'lasso' }
  | { mode: 'eraser' }

let drag: Drag | null = null
const pointers = new Map<number, { x: number; y: number }>()
let pinch: { d: number; scale: number; cx: number; cy: number; vx: number; vy: number } | null = null
// 按住空格临时切到平移:正在涂抹/框选时不必先切工具再切回来
const spaceDown = ref(false)

function startPinch() {
  const s = stageEl.value
  const [a, b] = [...pointers.values()]
  if (!s || !a || !b) return
  const box = s.getBoundingClientRect()
  pinch = {
    d: Math.hypot(a.x - b.x, a.y - b.y) || 1,
    scale: view.value.scale,
    cx: (a.x + b.x) / 2 - box.left,
    cy: (a.y + b.y) / 2 - box.top,
    vx: view.value.x,
    vy: view.value.y
  }
}

function updatePinch() {
  const [a, b] = [...pointers.values()]
  if (!pinch || !a || !b) return
  const d = Math.hypot(a.x - b.x, a.y - b.y) || 1
  const k = clamp(pinch.scale * (d / pinch.d), MIN_ZOOM, MAX_ZOOM)
  const f = k / pinch.scale
  view.value = {
    scale: k,
    x: pinch.cx - (pinch.cx - pinch.vx) * f,
    y: pinch.cy - (pinch.cy - pinch.vy) * f
  }
  schedule()
}

function onPointerDown(e: PointerEvent) {
  if (loading.value || !base) return
  const s = stageEl.value
  if (!s) return
  s.setPointerCapture(e.pointerId)
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
  if (pointers.size === 2) {
    drag = null
    startPinch()
    return
  }
  if (pointers.size > 2) return

  if (tool.value === 'pan' || spaceDown.value || e.button === 1) {
    drag = { mode: 'pan', sx: e.clientX, sy: e.clientY, ox: view.value.x, oy: view.value.y }
    return
  }

  const p = toImage(e.clientX, e.clientY)

  /* 套索:从这里起笔,一路记点(见 onPointerMove),松手闭合。
     它不像裁剪框那样事后还能拖手柄 —— 形状是手画出来的,
     要改形状就重画一遍,所以这里没有"移动/缩放"那两条分支 */
  if (tool.value === 'lasso') {
    /* 重新圈一块的话,输入框先收起来:它压在图上,拦着看不清画到哪了。
       但那句话留着 —— 多半只是嫌刚才圈歪了,重圈一下接着用 */
    regenOpen.value = false
    drag = { mode: 'lasso' }
    lassoPath.value = [clampPoint(p)]
    schedule()
    return
  }

  /* 橡皮:落笔就开一笔,一路记点(见 onPointerMove)。
     它不像套索那样"一笔定稿"—— 抹歪了补两下就行,所以每次起落各记一笔,
     合起来才是要擦的范围 */
  if (tool.value === 'eraser') {
    const q = clampPoint(p)
    drag = { mode: 'eraser' }
    strokes.value = [...strokes.value, [q]]
    hoverPt.value = q
    schedule()
    return
  }

  const r = cropRect.value
  if (r) {
    // 手柄的判定半径按屏幕像素给,再折算回图像坐标 —— 缩放多少都好点
    const hit = handlePoints(r).find(
      (h) => Math.abs(h.x - p.x) * view.value.scale <= 10 && Math.abs(h.y - p.y) * view.value.scale <= 10
    )
    if (hit) {
      drag = { mode: 'resize', handle: hit.h, rect: { ...r } }
      return
    }
    if (p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h) {
      drag = { mode: 'move', sx: p.x, sy: p.y, rect: { ...r } }
      return
    }
  }
  // 其余一律当作"重新拉一个框":这是裁剪工具最常做的动作
  drag = { mode: 'new', ax: p.x, ay: p.y }
  cropRect.value = { x: p.x, y: p.y, w: 0, h: 0 }
  schedule()
}

function onPointerMove(e: PointerEvent) {
  if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
  if (pinch) {
    if (pointers.size >= 2) updatePinch()
    return
  }
  /* 没在拖的时候橡皮也要跟着走:那个圈说的是"这一下会盖多宽",
     等到落了笔才知道就太晚了 */
  if (!drag) {
    if (tool.value === 'eraser' && !loading.value) {
      hoverPt.value = toImage(e.clientX, e.clientY)
      schedule()
    }
    return
  }

  if (drag.mode === 'pan') {
    view.value = {
      ...view.value,
      x: drag.ox + (e.clientX - drag.sx),
      y: drag.oy + (e.clientY - drag.sy)
    }
    schedule()
    return
  }

  const p = toImage(e.clientX, e.clientY)
  if (drag.mode === 'lasso') {
    const path = lassoPath.value
    const last = path?.[path.length - 1]
    if (!path || !last) return
    /* 采样:离上一个点够远才记一个。指针事件一秒能来上百次,
       全记下来会在一条直边上留下几百个几乎重合的点,
       而这个多边形后面还要填充成 mask、跟着请求发出去 */
    const q = clampPoint(p)
    if (Math.hypot(q.x - last.x, q.y - last.y) * view.value.scale < 3) return
    lassoPath.value = [...path, q]
    schedule()
    return
  }
  if (drag.mode === 'eraser') {
    const q = clampPoint(p)
    // 圈跟着笔尖走,采样挡住的那几帧也不例外
    hoverPt.value = q
    const list = strokes.value
    const cur = list[list.length - 1]
    const last = cur?.[cur.length - 1]
    if (!cur || !last) return
    // 与套索同一套采样与阈值,理由也一样:后面每一步都要描成 mask
    if (Math.hypot(q.x - last.x, q.y - last.y) * view.value.scale < 3) return
    strokes.value = [...list.slice(0, -1), [...cur, q]]
    schedule()
    return
  }
  if (drag.mode === 'new') {
    cropRect.value = clampToImage(
      { x: drag.ax, y: drag.ay, w: p.x - drag.ax, h: p.y - drag.ay },
      imgW.value,
      imgH.value
    )
  } else if (drag.mode === 'move') {
    const dx = p.x - drag.sx
    const dy = p.y - drag.sy
    cropRect.value = {
      ...drag.rect,
      // 移动只夹住位置,不改尺寸:贴边时框子不该被挤扁
      x: clamp(drag.rect.x + dx, 0, Math.max(0, imgW.value - drag.rect.w)),
      y: clamp(drag.rect.y + dy, 0, Math.max(0, imgH.value - drag.rect.h))
    }
  } else {
    cropRect.value = resizeRect(drag.rect, drag.handle, p)
  }
  schedule()
}

function onPointerUp(e: PointerEvent) {
  const wasLasso = drag?.mode === 'lasso'
  pointers.delete(e.pointerId)
  if (pointers.size < 2) pinch = null
  drag = null
  const r = cropRect.value
  // 点一下(而不是拖)会在原地留下一个零尺寸的框,那种误触直接丢掉
  if (r && (r.w < MIN_CROP || r.h < MIN_CROP)) cropRect.value = null
  /* 套索同理:三个点以下围不出面积(一次误触、一条直线),丢掉。
     点本身在收进来时已经夹过边界了,这里不用再夹一遍 */
  if (wasLasso && (lassoPath.value?.length ?? 0) < 3) lassoPath.value = null
  schedule()
}

/** 指针离开舞台:把橡皮那个圈收掉,别让它留在图上 */
function onStageLeave() {
  if (!hoverPt.value) return
  hoverPt.value = null
  schedule()
}

/** 拖手柄改尺寸:只动被拖的那条边(或那个角),另外几条边钉住 */
function resizeRect(rect: Rect, handle: Handle, p: { x: number; y: number }): Rect {
  let x1 = rect.x
  let y1 = rect.y
  let x2 = rect.x + rect.w
  let y2 = rect.y + rect.h
  if (handle.includes('w')) x1 = clamp(p.x, 0, x2 - MIN_CROP)
  if (handle.includes('e')) x2 = clamp(p.x, x1 + MIN_CROP, imgW.value)
  if (handle.includes('n')) y1 = clamp(p.y, 0, y2 - MIN_CROP)
  if (handle.includes('s')) y2 = clamp(p.y, y1 + MIN_CROP, imgH.value)
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 }
}

function onWheel(e: WheelEvent) {
  e.preventDefault()
  // 空态这块区域里没有可缩放的东西(它总是装着,所以得自己挡一下)
  if (!props.item) return
  const s = stageEl.value
  if (!s) return
  const box = s.getBoundingClientRect()
  /* 触控板捏合在浏览器里就是带 ctrlKey 的滚轮事件,而它的 deltaY 小得多,
     所以两种输入要给不同的系数,否则捏合几乎推不动 */
  const k = e.ctrlKey ? 0.01 : 0.0015
  zoomAt(e.clientX - box.left, e.clientY - box.top, Math.exp(-e.deltaY * k))
}

/* ===== 变换动作 ===== */
function pushOp(op: Op, force = false) {
  /* AI 那一步在途时不接受别的改动:它算的是发起那一刻的画面,
     中途再改一笔,结果回来就会把那一笔整个盖掉。
     force 只有 runEdit 用 —— 它要落的正是这次在途算出来的结果 */
  if (job.value && !force) return
  ops.value = [...ops.value, op]
  // 新动作走的是新分支,原来的重做链就作废了
  redoOps.value = []
  rebuild()
}

function rotate(deg: number) {
  pushOp({ k: 'rotate', deg })
}
function flip(axis: 'h' | 'v') {
  pushOp({ k: 'flip', axis })
}

function applyCrop() {
  const r = cropRect.value
  if (!r || r.w < MIN_CROP || r.h < MIN_CROP) return
  // 取整:裁剪框是像素级操作,留下 0.4 个像素的偏移只会让边缘发灰
  pushOp({
    k: 'crop',
    rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.w), h: Math.round(r.h) }
  })
}

function undo() {
  if (!ops.value.length) return
  const last = ops.value[ops.value.length - 1]
  ops.value = ops.value.slice(0, -1)
  redoOps.value = [last, ...redoOps.value]
  rebuild()
}

function redo() {
  const [next, ...rest] = redoOps.value
  if (!next) return
  redoOps.value = rest
  ops.value = [...ops.value, next]
  rebuild()
}

/** 跳到某一步(步骤条上点了一张)。
 *  比连按撤销快,而且只重放一次 —— 中间那些帧根本不必画出来 */
function goStep(i: number) {
  const n = ops.value.length
  if (i === n) return
  if (i < n) {
    // 退回去的这几步进重做栈,栈顶放最近的那一步,重做的顺序才接得上
    redoOps.value = [...ops.value.slice(i), ...redoOps.value]
    ops.value = ops.value.slice(0, i)
  } else {
    const take = i - n
    ops.value = [...ops.value, ...redoOps.value.slice(0, take)]
    redoOps.value = redoOps.value.slice(take)
  }
  rebuild()
}

/** 复位 = 回到原图。走的是"一路撤销到底"那条路:
 *  这些步骤仍旧躺在重做栈里 —— 步骤条上看得见,也点得回来。
 *  以前是直接清空两个栈,等于把走过的路一并抹掉了。
 *  不重置视图缩放 —— 那是"换个角度看"的临时状态,不属于编辑 */
function reset() {
  goStep(0)
}

/* ===== AI 编辑 ======================================================
   它和上面那些动作有个根本差别:要等,而且可能失败。
   所以不走 pushOp 那条同步的路 —— 先在途,算出来才落地。
   这样它照样可撤销、可重做,步骤条上也看得见这一步做过什么。
   ------------------------------------------------------------------ */

/* 取消用的信号。换图、撤图时都要掐掉它 ——
   否则一个已经不成立的结果会在几秒后突然落到画布上 */
let editAbort: AbortController | null = null

/* 在途期间不接受新的改图动作:它算的是发起那一刻的画面,
   中途再改一笔,结果回来就会把那一笔盖掉。
   视图操作(缩放、平移)不受影响 —— 那些不改内容 */
const locked = computed(() => !props.item || !!job.value)

/** 当前画面编成 data URL。送出去编辑的是它,而不是原图 ——
 *  用户是在"已经裁过、转过"的画面上动的手,送原图等于让他白改一遍 */
function currentImage(): string {
  const c = base
  if (!c) throw new Error('There is nothing on the canvas to edit')
  return c.toDataURL('image/png')
}

/** 整幅都重做的 mask:一张全透明、尺寸与原图一致的 PNG。
 *  去背景用这种 —— 它没有"要保留"的部分,主体在哪由模型自己认 */
function fullMask(): string {
  const c = base
  if (!c) throw new Error('There is nothing on the canvas to edit')
  // 什么都不画就是全透明,别多此一举地先铺一层再擦掉
  return newCanvas(c.width, c.height).toDataURL('image/png')
}

/** 把上游回来的那张对回画布原来的画幅。
 *
 *  请求那边已经按原尺寸去要了(见 api.ts 的 editSize),但上游听不听话不由我们 ——
 *  只认固定几档画幅的厂商,一张 16:9 的图也只能给到 3:2。这里再兜一道,
 *  让"编辑不改变画幅"这件事在本地成立,而不是托付给别人。
 *
 *  贴法是"填满再居中裁":宁可裁掉一点边,也不要整幅被拉伸变形 ——
 *  变形是每一帧都看得见的错,裁边只在极端比例下才明显 */
async function fitToCanvas(bmp: ImageBitmap, w: number, h: number): Promise<ImageBitmap> {
  if (bmp.width === w && bmp.height === h) return bmp
  const c = newCanvas(w, h)
  const ctx = c.getContext('2d')
  if (ctx) {
    ctx.imageSmoothingQuality = 'high'
    const k = Math.max(w / bmp.width, h / bmp.height)
    const dw = bmp.width * k
    const dh = bmp.height * k
    ctx.drawImage(bmp, (w - dw) / 2, (h - dh) / 2, dw, dh)
  }
  bmp.close()
  return createImageBitmap(c)
}

/** 让浏览器真的画一帧再往下走。
 *
 *  单等一个微任务(或 nextTick)是不够的:那只是把回调排到队尾,浏览器要等
 *  主线程整条空下来才会绘制。而紧接着那几件取原图、编码 mask 的事是几百毫秒的
 *  同步活儿,排在它们后面等于没让 —— 占位会跟着一起卡在那儿不动。
 *  两帧是因为第一帧的 rAF 回调仍在绘制之前,要到第二次才算画过。
 *
 *  另外压一条超时:标签页切到后台时 rAF 会被冻住,不兜底的话这次编辑就
 *  发不出去了。给 200ms 封顶 —— 让帧是为了观感,不该真的耽误正事 */
function nextPaint(): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, 200)
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        clearTimeout(timer)
        resolve()
      })
    )
  })
}

/**
 * 一次 AI 请求的公共骨架:先把占位交出去、接住取消、把回来的那张对回画幅、入栈。
 *
 * 做成一层是因为"要算什么"有两条路 —— 在图上改一块(mask + 模式),
 * 和照这张再画一张(参考图 + 提示词)—— 它们打的是两条不同的端点,
 * 但"怎么等、怎么落地、失败怎么收场"完全一样,那部分只该有一份。
 *
 * 结果不在这里算,而是等回来之后作为一步进操作序列 ——
 * 于是撤销、重做、直接跳到某一步都自动成立。
 * 失败则什么都不留:一个没算出来的操作不该占着步骤条一格。
 */
async function runJob(
  kind: JobKind,
  label: string,
  produce: (frame: HTMLCanvasElement, cfg: ApiConfig, signal: AbortSignal) => Promise<ResultItem>
) {
  const cfg = props.config
  if (!base || job.value) return
  if (!cfg) {
    error.value = 'Add an image model in Settings before using AI editing.'
    return
  }
  error.value = ''
  stopped.value = false
  job.value = { kind, label }
  const ctl = new AbortController()
  editAbort = ctl
  try {
    /* 先把"正在算"那一格交给浏览器画出去,再去做下面几件费时的编码。
       顺序反过来的话,那几百毫秒里界面是冻的,占位等于没有 */
    await nextPaint()
    /* 这一帧里用户可能已经把图撤了(见 resetAll):
       那种情况下 base 没了,这次请求也就不成立 */
    if (ctl.signal.aborted || !base) return
    /* 画幅在这一刻取定。接口回来要几秒,
       中途用户碰了什么,都不该改变已经发出去的这一次 */
    const frame = base
    /* produce 里那几件取原图、编码 mask / 参考图的事同样是费时的同步活儿,
       所以一律等让帧之后再叫它 */
    const item = await produce(frame, cfg, ctl.signal)
    /* 先解码成位图再入栈:操作序列的重放是同步的(见 applyOp),
       而 Blob 得异步解码 —— 在这里解一次,之后每一次重放都用它 */
    const raw = await createImageBitmap(await (await fetch(imageSrc(item))).blob())
    // 回来时这张图可能已经被换掉了(见 resetAll 里的 abort)
    if (ctl.signal.aborted) {
      raw.close()
      return
    }
    // 上游给的画幅未必是我们要的那个,对回来再入栈
    const bmp = await fitToCanvas(raw, frame.width, frame.height)
    if (ctl.signal.aborted) {
      bmp.close()
      return
    }
    /* 先撤掉在途标记再入栈:pushOp 会拦下"在途期间的操作",
       而这一步正是这次在途本身的结果 */
    job.value = null
    pushOp({ k: 'ai', label, bitmap: bmp }, true)
  } catch (e) {
    /* 主动取消不算失败:用户已经换了图,再弹一条错误只是噪声 */
    if (!ctl.signal.aborted) error.value = e instanceof Error ? e.message : 'Edit failed'
  } finally {
    /* 只在还是自己那一次时才收摊。
       stop() 会立刻把 job 清掉(界面要当场回到可用状态),于是用户可能马上
       按下新的一次 —— 那时候 editAbort 已经换成别人了,这里再清一手
       就会把新那一次的"在途"标记抹掉,而它的结果还在路上 */
    if (editAbort === ctl) {
      editAbort = null
      job.value = null
    }
  }
}

/** 在图上改一块。原图、mask、画幅都在同一刻取定 */
async function runEdit(
  mode: EditMode,
  label: string,
  maskOf: () => string,
  prompt?: string
) {
  await runJob(mode, label, (frame, cfg, signal) =>
    editImage(
      {
        image: currentImage(),
        mask: maskOf(),
        mode,
        prompt,
        size: `${frame.width}x${frame.height}`
      },
      cfg,
      signal
    )
  )
}

/** 照这张再画一张。参考图就是画布现在这张,不用挑 —— 挑的是"画成什么样" */
async function runGenerate(prompt: string) {
  await runJob('create', shortLabel(prompt), (frame, cfg, signal) => {
    const ref = refShot()
    if (!ref) throw new Error('There is nothing on the canvas to hand over')
    return generateFrom({ prompt, image: ref, size: `${frame.width}x${frame.height}` }, cfg, signal)
  })
}

/** 掐掉在途的那一次。
 *
 *  它算的是几秒前那张图,结果落下来只会把中间发生的事盖掉 ——
 *  按停止的意思就是"这次不要了"。
 *  失败那条路不做声(见 runJob 的 catch),所以这里要自己说一句:
 *  否则盘子凭空消失,和"算坏了"长得一模一样 */
function stop() {
  if (!job.value) return
  editAbort?.abort()
  editAbort = null
  job.value = null
  stopped.value = true
  window.clearTimeout(stopTimer)
  stopTimer = window.setTimeout(() => (stopped.value = false), 2600)
}

/** 一键去背景:整幅重做,不需要用户先画选区 */
function removeBackground() {
  runEdit('remove-bg', 'Background removed', fullMask)
}

/** 套索那块变成 mask。与 fullMask 只差形状:一个整幅透明,一个按路径挖空。
 *
 *  先铺满不透明黑(=整幅都保留),再用 destination-out 把选区的透明度擦成 0 ——
 *  mask 里透明才是"要改",所以这里要的是"挖掉",不是"填上" */
function lassoMask(): string {
  const c = base
  const path = lassoPath.value
  if (!c || !path || path.length < 3) throw new Error('There is no selection to edit')
  const m = newCanvas(c.width, c.height)
  const ctx = m.getContext('2d')
  if (ctx) {
    ctx.fillStyle = '#000'
    ctx.fillRect(0, 0, m.width, m.height)
    ctx.globalCompositeOperation = 'destination-out'
    ctx.beginPath()
    ctx.moveTo(path[0].x, path[0].y)
    for (const q of path.slice(1)) ctx.lineTo(q.x, q.y)
    ctx.closePath()
    ctx.fill()
  }
  return m.toDataURL('image/png')
}

/** 清掉套索圈住的那块内容。它和去背景走同一条路,
 *  差别只在送上去的区域是"这一块"而不是"整幅" */
function eraseSelection() {
  runEdit('erase', 'Erased the selection', lassoMask)
}

/** 橡皮抹过的那几片变成 mask。与套索同一套规矩(黑底 + 挖空),
 *  只是形状由描边决定:圆头圆角,粗细就是笔头直径 */
function eraserMask(): string {
  const c = base
  const list = strokes.value
  if (!c || !list.length) throw new Error('There is nothing painted to erase')
  const m = newCanvas(c.width, c.height)
  const ctx = m.getContext('2d')
  if (ctx) {
    ctx.fillStyle = '#000'
    ctx.fillRect(0, 0, m.width, m.height)
    ctx.globalCompositeOperation = 'destination-out'
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.lineWidth = eraserSize.value
    for (const s of list) {
      if (!s.length) continue
      ctx.beginPath()
      ctx.moveTo(s[0].x, s[0].y)
      // 单点那一笔得补一段零长的线,否则圆头描边什么都画不出来
      if (s.length === 1) ctx.lineTo(s[0].x + 0.01, s[0].y)
      else for (const q of s.slice(1)) ctx.lineTo(q.x, q.y)
      ctx.stroke()
    }
  }
  return m.toDataURL('image/png')
}

/** 清掉橡皮抹过的那几片。它和套索的消除是同一步,只是形状从描边来 */
function erasePainted() {
  runEdit('erase', 'Erased the painted area', eraserMask)
}

/** 笔头大小按几何级数走:等差的加减在两端的体感差太远 ——
 *  80px 上点一下几乎没变,8px 上一点就翻倍 */
function eraserStep(k: number) {
  eraserSize.value = Math.round(clamp(eraserSize.value * k, ERASER_MIN, ERASER_MAX))
  schedule()
}

/** 收回笔迹,但留着笔头大小 —— 那个是"我习惯多粗",不该跟着一起没 */
function clearStrokes() {
  strokes.value = []
  schedule()
}

/** 步骤与气泡上那句说明。整句话可能很长而位置就那么点,
 *  截一段够认出来就行;完整的那句照原样送上去 */
function shortLabel(text: string): string {
  const t = text.trim()
  return t.length > 48 ? `${t.slice(0, 48)}…` : t
}

/** 局部重绘:把套索圈住的那块交给模型,照着这句话重做。
 *  与去背景、消除是同一条路 —— 差别只在 mask 从哪来、指令从哪来 */
function regenSelection() {
  const p = regenText.value.trim()
  if (!p) return
  runEdit('regen', shortLabel(p), lassoMask, p)
}

/** 换背景:整幅交给模型,换成用户说的那个。
 *  mask 与去背景一模一样(整幅透明)—— 差别只在服务端挑的指令 */
function replaceBackground() {
  const p = bgText.value.trim()
  if (!p) return
  runEdit('replace-bg', `Background · ${shortLabel(p)}`, fullMask, p)
}

/* 三处指令框:局部重绘那条贴着选区走,换背景与"照这张再创作"都挂在舞台顶上。
   同时开着两张输入框没有意义,后两张还抢同一块地方 ——
   所以一律"开一个、收另外两个"。收起时顺手清掉那句话:
   它没被发出去,留着只会在下次打开时莫名其妙地冒出来 */
function closeComposers() {
  closeRegen()
  closeBg()
  closeGen()
}

/** 打开"这块要改成什么"。它顶掉套索那条按钮浮条,腾出的位置放输入框 ——
 *  出现即可打字,否则点一下还要再点一次框,白费一步 */
async function openRegen() {
  closeComposers()
  regenOpen.value = true
  await nextTick()
  regenEl.value?.focus()
}

function closeRegen() {
  regenOpen.value = false
  regenText.value = ''
}

/** 换背景那个输入框。它没有选区可依附,所以按整幅的位置摆(见 .cv-ctx.is-bar) */
async function openBg() {
  closeComposers()
  bgOpen.value = true
  await nextTick()
  bgEl.value?.focus()
}

function closeBg() {
  bgOpen.value = false
  bgText.value = ''
}

/** 照这张再创作的输入框。与换背景同占舞台顶上,靠 closeComposers 互斥 */
async function openGen() {
  closeComposers()
  genOpen.value = true
  await nextTick()
  genEl.value?.focus()
}

function closeGen() {
  genOpen.value = false
  genText.value = ''
}

/** 两处输入框的键盘规矩一样:回车提交、Esc 收起,换行交给 Shift+Enter。
 *  调用处都带 .stop,因为全局那套快捷键认的是单个字母(见 onKeyDown)——
 *  在里面打字时一个 "v" 就会把工具切成平移 */
function composerKey(e: KeyboardEvent, submit: () => void, close: () => void) {
  if (e.key === 'Escape') {
    e.preventDefault()
    close()
    return
  }
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    submit()
  }
}

/* 选区没了,那句话也就没了对象。成功落地后 rebuild 会清掉套索,
   输入框跟着收起来;失败时选区还在,那句话也留着,可以直接再点一次发 */
watch(lassoPath, (p) => {
  if (!p) closeRegen()
})

/* ===== 载入 / 保存 ===== */
function resetAll() {
  /* 在途的那次编辑跟着作废 —— 它算的是上一张图 */
  editAbort?.abort()
  editAbort = null
  job.value = null
  /* 先把 AI 那几步带着的位图放掉再清空。它们是全尺寸的图像资源,
     等 GC 不如显式 close(与 buildSteps 里"用完就清空画布"同一个理由) */
  for (const op of [...ops.value, ...redoOps.value]) {
    if (op.k === 'ai') op.bitmap.close()
  }
  ops.value = []
  redoOps.value = []
  stepUrls.value = []
  cropRect.value = null
  /* 套索与笔迹也是"还没落地的选区",而且记的是上一张图的坐标 ——
     留着会在新图上画出一块对不上任何东西的选区 */
  lassoPath.value = null
  strokes.value = []
  hoverPt.value = null
  closeComposers()
  stopped.value = false
  error.value = ''
  saving.value = false
  confirmDiscard.value = false
  /* 换图之后是新的一张,上一张"存到第几版"与它无关 */
  savedRev.value = -1
  tool.value = 'pan'
  imgW.value = 0
  imgH.value = 0
  view.value = { scale: 1, x: 0, y: 0 }
  base = null
  source?.close?.()
  source = null
  // 撤下这张图的同时作废任何在途的解码
  loadToken++
}

/* 现在装在画布上的是哪一张。它把"换图"和"切回这一页"分开:
   前者要重载,后者什么都不该动(见下面那个 watch) */
let loadedItem: ResultItem | null = null

async function load() {
  resetAll()
  /* 解码是异步的,中途用户可能已经换了另一张图(甚至撤下了这张)。
     用一个自增号标记"这一次",回来时对不上就把位图丢掉 ——
     否则一张已经作废的图会被装进状态,既漏内存又让画面显示成上一张 */
  const token = ++loadToken
  const src = props.item ? imageSrc(props.item) : ''
  if (!src) {
    loading.value = false
    error.value = 'This image cannot be opened for editing.'
    return
  }
  loading.value = true
  try {
    /* 走一遍 fetch 拿到字节再解码,而不是把 src 直接塞给 <img>:
       我们要的是 ImageBitmap(能直接喂给 drawImage),而且这样拿到的
       是一份独立的字节,不会跟别处的 object URL 生命周期纠缠 */
    let bmp = await createImageBitmap(await (await fetch(src)).blob())
    if (token !== loadToken) {
      bmp.close()
      return
    }
    /* 超过安全上限的先缩一次(见 MAX_EDGE)。本地上传的图最容易撞上这条 ——
       从历史打开的生成图通常本来就在两千上下 */
    const edge = Math.max(bmp.width, bmp.height)
    if (edge > MAX_EDGE) {
      const k = MAX_EDGE / edge
      const c = newCanvas(bmp.width * k, bmp.height * k)
      const ctx = c.getContext('2d')!
      ctx.imageSmoothingQuality = 'high'
      ctx.drawImage(bmp, 0, 0, c.width, c.height)
      const small = await createImageBitmap(c)
      if (token !== loadToken) {
        small.close()
        return
      }
      // 缩好的那份留下,原图那份当场还回去
      bmp.close()
      bmp = small
    }
    source = bmp
    // 解码成功了才算"这张装上了"。失败或中途作废时留空,下次进来还会再试
    loadedItem = props.item
    loading.value = false
    // 等舞台量出尺寸再适配,否则第一次 fit 算出来的是 0
    await nextTick()
    if (token !== loadToken) return
    base = replay(bmp, [])
    imgW.value = base.width
    imgH.value = base.height
    /* 笔头一开始给短边的 6%:一张 4000px 的图和一张 400px 的图上,
       "看着差不多大"才是合理的默认 —— 写死一个像素值必然有一头不好用 */
    eraserSize.value = Math.round(clamp(Math.min(base.width, base.height) * 0.06, 12, 400))
    buildSteps()
    fit()
  } catch {
    loading.value = false
    error.value = 'Could not decode this image.'
  }
}

async function save() {
  if (!base || !canSave.value) return
  saving.value = true
  try {
    // 还挂着的裁剪框先落地:屏幕上看到的是什么,存下来的就该是什么
    if (cropRect.value) applyCrop()
    await nextTick()
    const c = base
    if (!c) {
      saving.value = false
      return
    }
    const blob = await encode(c)
    if (!blob) {
      error.value = 'Could not encode this image.'
      saving.value = false
      return
    }
    /* 这里不复位 saving:主界面接过去还要落盘,那段时间里再点一次会存出两条。
       复位与"已保存"的记账都由主界面在落盘结束后回执(见 finishSave) */
    emit('save', { blob, w: c.width, h: c.height })
  } catch {
    error.value = 'Could not encode this image.'
    saving.value = false
  }
}

/**
 * 由主界面在落盘结束后回执。
 *
 * 放在那边回执、而不是这里乐观记账:失败时不该把这一版标成已存 ——
 * 那样保存键会灰着,而记录其实并不存在。
 * 存完不撤图(见 App 的 saveEdit),所以这一下回执就是"现在手上这份已经存过了"的唯一凭据
 */
function finishSave() {
  saving.value = false
  savedRev.value = rev.value
}
defineExpose({ finishSave })

/** 这一帧里有没有透明像素。
 *
 *  去背景产出的就是透明区,而 JPEG 没有 alpha 通道 —— 把带透明的画面按 JPEG
 *  编码,透明区会被压成黑块。下面那条老注释其实早就写过这件事,
 *  只是判断依据取错了对象:它看的是"源图是什么格式"。而这是两码事 ——
 *  一张 JPEG 拿去做去背景,源图仍然是 JPEG,结果却是带透明的。
 *
 *  只探 alpha,而且探的是一张缩过的图:getImageData 是唯一能问到像素的办法,
 *  它会把整幅读回 CPU,一张 4000px 的图就是几十 MB。缩小取的是平均,
 *  全不透明的图缩完仍然处处是 255,所以不会把不透明误判成有透明;
 *  反过来,极小的一个透明点可能被平均掉 —— 那种漏网只是那一小块变黑,
 *  比整幅变黑轻得多 */
function hasAlpha(c: HTMLCanvasElement): boolean {
  const edge = 512
  const scale = Math.min(1, edge / Math.max(c.width, c.height))
  const w = Math.max(1, Math.round(c.width * scale))
  const h = Math.max(1, Math.round(c.height * scale))
  const probe = newCanvas(w, h)
  const ctx = probe.getContext('2d', { willReadFrequently: true })
  if (!ctx) return false
  ctx.drawImage(c, 0, 0, w, h)
  const { data } = ctx.getImageData(0, 0, w, h)
  // alpha 落在每 4 个字节的第 4 个上
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] < 255) return true
  }
  return false
}

/** 编码成 Blob。
 *
 *  有没有透明决定用哪一族格式,而不是源图是什么 —— 前者是这一帧的事实,
 *  后者只是它的来路。有透明就绝不能走 JPEG(见 hasAlpha);
 *  没透明时仍旧跟着源图走,免得把一张照片平白撑大几倍 */
async function encode(c: HTMLCanvasElement): Promise<Blob | null> {
  if (hasAlpha(c)) {
    /* webp 的 alpha 是单独一层、无损存的,所以抠图的边不会被糊掉;
       体积又比 PNG 小一个量级。编码不可用的环境退回 PNG */
    return (
      (await toBlob(c, 'image/webp')) ?? (await toBlob(c, 'image/png'))
    )
  }
  const ext = extOf(props.item ?? undefined)
  const preferred = ext === 'jpg' ? 'image/jpeg' : ext === 'webp' ? 'image/webp' : 'image/png'
  const first = await toBlob(c, preferred)
  // webp 编码在个别环境里不可用,退回 png —— 丢了点体积,但图一定是完整的
  return first ?? (await toBlob(c, 'image/png'))
}

function toBlob(c: HTMLCanvasElement, type: string): Promise<Blob | null> {
  return new Promise((r) => c.toBlob(r, type, type === 'image/png' ? undefined : 0.92))
}

/* 参考图的长边上限。与首页把用户上传的图缩到 1024 是同一个数 ——
   它们进的是同一条请求,尺寸对不上只会在那边白白多背几百 KB */
const REF_EDGE = 1024

/** 当前画面,缩成一张能当参考图送上去的 data URL。没有图时给 null。
 *
 *  缩在这一侧做,而不是把整幅原图转成 data URL 再交给谁去缩:
 *  一张 4000px 的图那样一转就是十几 MB 的字符串,中间还要解码一次,
 *  而那几百毫秒正好压在"占位已经画出来、请求还没发"的那一帧上。
 *  这里手上就有像素,直接画进小画布最省。
 *
 *  透明的那张不能走 JPEG —— 那会把透明压成黑块(与存图那条同一个坑),
 *  送去当参考的图会顶着黑底。有透明就用 PNG,它本来也不大 */
function refShot(): string | null {
  const c = base
  if (!c) return null
  const scale = Math.min(1, REF_EDGE / Math.max(c.width, c.height))
  const t = newCanvas(c.width * scale, c.height * scale)
  const ctx = t.getContext('2d')
  if (ctx) {
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(c, 0, 0, t.width, t.height)
  }
  // 探的是刚缩好的这张:它最多 1024,比拿 4000px 的原图去探准得多
  return hasAlpha(t) ? t.toDataURL('image/png') : t.toDataURL('image/jpeg', 0.85)
}

/** 照画布上这张再画一张,画成什么样由用户那句话决定。
 *  参考图不用挑 —— 画布上摆着的就是 */
function createFromThis() {
  const p = genText.value.trim()
  if (!p) return
  runGenerate(p)
}

/* ===== 关闭 ===== */
/** 撤下这张图。改了一半先问一句:转了半天随手一撤就白干最伤人 */
function requestDiscard() {
  if (dirty.value) {
    confirmDiscard.value = true
    return
  }
  emit('discard')
}

/* ===== 键盘 =====
   绑在 window 上而不是这块区域上:焦点可能在按钮上,
   而 Cmd+Z / 空格拖拽这些不该因为焦点跑了就失效 */
function onKeyDown(e: KeyboardEvent) {
  // 不在这一页时一律不管 —— 首页的输入框、设置页的表单都要正常收字
  if (!props.active) return
  // 确认条开着时,键盘只服务于它
  if (confirmDiscard.value) {
    if (e.key === 'Escape') {
      e.preventDefault()
      confirmDiscard.value = false
    }
    return
  }
  /* 几处指令框开着时,Esc 先收它们 —— 否则一下就把整块选区连着那句话都丢了。
     只拦这一个键:焦点不在框里的时候,别的快捷键该照常管用 */
  if (e.key === 'Escape' && (regenOpen.value || bgOpen.value || genOpen.value)) {
    e.preventDefault()
    closeComposers()
    return
  }
  // 手上没图时这些键没有服务对象(工具、撤销都已经落回禁用态)
  if (!props.item) return
  const mod = e.metaKey || e.ctrlKey
  if (mod && e.key.toLowerCase() === 'z') {
    e.preventDefault()
    if (e.shiftKey) redo()
    else undo()
    return
  }
  if (e.key === 'Escape') {
    e.preventDefault()
    /* 第一下先撤掉手上的选区,第二下才撤图 —— 免得一按就把整轮编辑丢掉。
       笔迹也算在里面:抹了半天按一下就没掉最伤人 */
    if (cropRect.value || lassoPath.value || strokes.value.length) {
      cropRect.value = null
      lassoPath.value = null
      strokes.value = []
      schedule()
      return
    }
    requestDiscard()
    return
  }
  if (e.code === 'Space' && !spaceDown.value) {
    e.preventDefault()
    spaceDown.value = true
    return
  }
  if (e.key === 'v') tool.value = 'pan'
  else if (e.key === 'c') tool.value = 'crop'
  else if (e.key === 'l') tool.value = 'lasso'
  else if (e.key === 'e') tool.value = 'eraser'
  else if (e.key === 'Enter' && cropRect.value) applyCrop()
}

function onKeyUp(e: KeyboardEvent) {
  if (e.code === 'Space') spaceDown.value = false
}

/* 换图才重新载入。切走再切回来不动任何状态(见 active 的注释)——
   这里必须靠"还是不是同一张"来分辨,不能只看 active:
   它变回 true 的时候两次都满足,照着重载就等于把操作序列清空了 */
watch(
  () => [props.active, props.item] as const,
  ([isActive]) => {
    if (!isActive) return
    if (!props.item) {
      loadedItem = null
      resetAll()
      loading.value = false
      return
    }
    // 同一张图:多半只是从别的页面切回来,手上那些操作得留着
    if (props.item === loadedItem) return
    load()
  },
  { immediate: true }
)

const ro = typeof ResizeObserver !== 'undefined'
  ? new ResizeObserver(() => {
      /* 窗口一变,步骤条的高度也跟着变(窄屏下它的内边距与缩略图都更小),
         所以顺带重报一次,再重新取景 */
      measureStrip()
      // 舞台尺寸变了(窗口缩放、旋转屏幕)就重新适配,否则图会偏到看不见的地方。
      // 舞台现在空态也挂着,所以得确认手上真有图再去适配
      if (!loading.value && base) fit()
    })
  : null

watch(stageEl, (el) => {
  ro?.disconnect()
  if (el) ro?.observe(el)
})

onBeforeUnmount(() => {
  ro?.disconnect()
  window.removeEventListener('keydown', onKeyDown)
  window.removeEventListener('keyup', onKeyUp)
  if (frame) cancelAnimationFrame(frame)
  window.clearTimeout(tipTimer)
  window.clearTimeout(stopTimer)
  // 这一页要走了,在途的那次编辑再落地也没有意义
  editAbort?.abort()
  source?.close?.()
})

// 键盘是全局的,挂载即生效;active 在回调里判断
window.addEventListener('keydown', onKeyDown)
window.addEventListener('keyup', onKeyUp)

function clamp(n: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, n))
}
</script>

<template>
  <!-- v-show 而不是 v-if:它是工作台不是弹窗,切去历史挑张图再切回来,
       手上那半张裁剪框还得在 -->
  <Transition name="cv-page">
    <section v-show="active" class="canvas-page" aria-label="Free canvas">
      <!-- 主体:左工具条 + 舞台。有没有图的差别只落在舞台里面 ——
           框架照旧铺开,提示居中说明"这里缺的是什么",不另起一屏。
           这一页自己的操作全收在左边这条竖排里:顶部横条已经挂着全站导航,
           再叠一条工具栏,人就得在两处顶部找东西 -->
      <div
        ref="bodyEl"
        class="cv-body"
        @pointerover="showRailTip"
        @pointerleave="hideRailTip"
        @focusin="showRailTip"
        @focusout="hideRailTip"
      >
        <!-- AI 那三颗图标用的渐变。图标本身是单色的(Phosphor 把 fill 写在
             <svg> 上、path 靠继承),要给它铺渐变只能让 fill 指向一个
             paint server —— 而那个定义得先存在于文档里,所以这里放一个
             只装 defs 的空 svg。两端取的是主题变量,深浅两套各自成立 -->
        <svg class="cv-ai-defs" aria-hidden="true" focusable="false">
          <defs>
            <linearGradient id="cv-ai-grad" x1="0" y1="0" x2="1" y2="1">
              <stop class="cv-ai-from" offset="0%" />
              <stop class="cv-ai-to" offset="100%" />
            </linearGradient>
          </defs>
        </svg>

        <nav ref="railEl" class="cv-rail" :class="{ busy: !!job }" aria-label="Tools">
          <!-- 操作键都排在这一段里:左边一列是常用项,展开的那几组从它右手边长出来。
               放不下时滚的是这一段 -->
          <div class="rail-scroll">
            <!-- 常驻那一列。键上只留图标,名字与快捷键交给悬停提示 ——
                 一行字会把这条竖栏撑宽一倍,而它本身只是"认图标"的辅助 -->
            <div class="rail-col">
              <!-- AI 的那一组:凡是最后会走到模型那一步的,都收在这里。
                   前两颗是"先圈出要动的地方"(套索、橡皮)—— 它们自己不调接口,
                   但圈出来就是为了紧跟着按下 Erase / Reimagine,算同一条路,
                   所以摆在这一组的最前头。后三颗是整幅交给它。
                   全站只有这一组是彩色图标。
                   它也是唯一"要等上游"的一组:在途的那一颗会变成停止键
                   (只看"有没有在途"的话,会一起转圈,停止键也会同时冒出好几个) -->
              <div class="rail-grp rail-ai">
                <button
                  class="tool tip-right"
                  :class="{ on: tool === 'lasso' }"
                  :disabled="!item"
                  :aria-pressed="tool === 'lasso'"
                  data-tip="Lasso (L)"
                  aria-label="Lasso select"
                  @click="tool = 'lasso'"
                >
                  <PhLasso aria-hidden="true" />
                </button>
                <button
                  class="tool tip-right"
                  :class="{ on: tool === 'eraser' }"
                  :disabled="!item"
                  :aria-pressed="tool === 'eraser'"
                  data-tip="Eraser (E)"
                  aria-label="Mark an area to erase"
                  @click="tool = 'eraser'"
                >
                  <PhEraser aria-hidden="true" />
                </button>
                <button
                  class="tool tip-right"
                  :class="{ on: job?.kind === 'remove-bg' }"
                  :disabled="locked && job?.kind !== 'remove-bg'"
                  :data-tip="job?.kind === 'remove-bg' ? 'Stop' : 'Remove background'"
                  :aria-label="job?.kind === 'remove-bg' ? 'Stop' : 'Remove background'"
                  @click="job?.kind === 'remove-bg' ? stop() : removeBackground()"
                >
                  <PhStop v-if="job?.kind === 'remove-bg'" class="is-stop" aria-hidden="true" />
                  <PhCheckerboard v-else aria-hidden="true" />
                </button>
                <button
                  class="tool tip-right"
                  :class="{ on: bgOpen || job?.kind === 'replace-bg' }"
                  :disabled="locked && job?.kind !== 'replace-bg'"
                  :aria-expanded="bgOpen"
                  :data-tip="job?.kind === 'replace-bg' ? 'Stop' : 'Replace background'"
                  :aria-label="job?.kind === 'replace-bg' ? 'Stop' : 'Replace background'"
                  @click="job?.kind === 'replace-bg' ? stop() : bgOpen ? closeBg() : openBg()"
                >
                  <PhStop v-if="job?.kind === 'replace-bg'" class="is-stop" aria-hidden="true" />
                  <PhMountains v-else aria-hidden="true" />
                </button>
                <button
                  class="tool tip-right"
                  :class="{ on: genOpen || job?.kind === 'create' }"
                  :disabled="locked && job?.kind !== 'create'"
                  :aria-expanded="genOpen"
                  :data-tip="job?.kind === 'create' ? 'Stop' : 'Create from this picture'"
                  :aria-label="job?.kind === 'create' ? 'Stop' : 'Create a new picture from this one'"
                  @click="job?.kind === 'create' ? stop() : genOpen ? closeGen() : openGen()"
                >
                  <PhStop v-if="job?.kind === 'create'" class="is-stop" aria-hidden="true" />
                  <PhMagicWand v-else aria-hidden="true" />
                </button>
              </div>

              <span class="rail-sep" aria-hidden="true"></span>

              <!-- 基础的一组:这张图怎么来、怎么走、怎么存,以及不经过模型的
                   那些改法(平移、裁剪)。与上面那组的分界线是"会不会走到模型":
                   这里的每一下都是当场算出来的,不等谁。
                   存过之后画面没再动,保存键就是灰的 ——
                   也就是它同时回答了"现在有没有东西可存" -->
              <div class="rail-grp">
                <button
                  class="tool tip-right"
                  data-tip="Upload a picture"
                  aria-label="Upload a picture"
                  @click="pickFile"
                >
                  <PhUploadSimple aria-hidden="true" />
                </button>
                <button
                  class="tool tip-right"
                  :disabled="!item"
                  data-tip="Take this picture off the canvas"
                  aria-label="Take this picture off the canvas"
                  @click="requestDiscard"
                >
                  <PhX aria-hidden="true" />
                </button>
                <button
                  class="tool tip-right"
                  :disabled="!canSave"
                  :data-tip="rev === savedRev ? 'Saved' : 'Save as new'"
                  aria-label="Save as new"
                  @click="save"
                >
                  <PhFloppyDisk aria-hidden="true" />
                </button>
                <button
                  class="tool tip-right"
                  :class="{ on: tool === 'pan' }"
                  :disabled="!item"
                  :aria-pressed="tool === 'pan'"
                  data-tip="Move · zoom (V)"
                  aria-label="Move and zoom"
                  @click="tool = 'pan'"
                >
                  <PhArrowsOutCardinal aria-hidden="true" />
                </button>
                <button
                  class="tool tip-right"
                  :class="{ on: tool === 'crop' }"
                  :disabled="!item"
                  :aria-pressed="tool === 'crop'"
                  data-tip="Crop (C)"
                  aria-label="Crop"
                  @click="tool = 'crop'"
                >
                  <PhCrop aria-hidden="true" />
                </button>
              </div>

              <span class="rail-sep" aria-hidden="true"></span>

              <!-- 低频那几组的开关落在这一列的最后:它是个入口,不是常用键 -->
              <div class="rail-grp">
                <button
                  class="tool tip-right"
                  :class="{ on: showMore }"
                  :aria-expanded="showMore"
                  aria-controls="cv-more"
                  :data-tip="showMore ? 'Hide extra tools' : 'More tools'"
                  :aria-label="showMore ? 'Hide extra tools' : 'More tools'"
                  @click="showMore = !showMore"
                >
                  <PhCaretRight class="cv-caret" :class="{ flip: showMore }" aria-hidden="true" />
                </button>
              </div>
            </div>

            <!-- 低频的那几组折在右手边:从那一列的侧面长出来,
                 而不是继续往下堆 —— 这条竖栏的高度就不随展开变 -->
            <Transition name="rail-fold">
              <div v-if="showMore" id="cv-more" class="rail-fold">
                <div class="rail-grp">
                  <button
                    class="tool tip-right"
                    :disabled="locked"
                    data-tip="Rotate left"
                    aria-label="Rotate left"
                    @click="rotate(-90)"
                  >
                    <PhArrowCounterClockwise aria-hidden="true" />
                  </button>
                  <button
                    class="tool tip-right"
                    :disabled="locked"
                    data-tip="Rotate right"
                    aria-label="Rotate right"
                    @click="rotate(90)"
                  >
                    <PhArrowClockwise aria-hidden="true" />
                  </button>
                  <button
                    class="tool tip-right"
                    :disabled="locked"
                    data-tip="Flip horizontal"
                    aria-label="Flip horizontal"
                    @click="flip('h')"
                  >
                    <PhFlipHorizontal aria-hidden="true" />
                  </button>
                  <button
                    class="tool tip-right"
                    :disabled="locked"
                    data-tip="Flip vertical"
                    aria-label="Flip vertical"
                    @click="flip('v')"
                  >
                    <PhFlipVertical aria-hidden="true" />
                  </button>
                </div>

                <span class="rail-sep" aria-hidden="true"></span>

                <div class="rail-grp">
                  <button
                    class="tool tip-right"
                    :disabled="!item"
                    data-tip="Zoom out"
                    aria-label="Zoom out"
                    @click="zoomStep(1 / 1.25)"
                  >
                    <PhMagnifyingGlassMinus aria-hidden="true" />
                  </button>
                  <button
                    class="tool tip-right"
                    :disabled="!item"
                    data-tip="Zoom in"
                    aria-label="Zoom in"
                    @click="zoomStep(1.25)"
                  >
                    <PhMagnifyingGlassPlus aria-hidden="true" />
                  </button>
                  <button
                    class="tool tip-right"
                    :disabled="!item"
                    data-tip="Fit to view"
                    aria-label="Fit to view"
                    @click="fit"
                  >
                    <PhCornersOut aria-hidden="true" />
                  </button>
                </div>
              </div>
            </Transition>
          </div>
        </nav>

        <div
          ref="stageEl"
          class="cv-stage"
          :class="item && `is-${tool}`"
          @pointerdown="onPointerDown"
          @pointermove="onPointerMove"
          @pointerup="onPointerUp"
          @pointercancel="onPointerUp"
          @pointerleave="onStageLeave"
          @wheel="onWheel"
        >
          <!-- 空态:这块画布区域照旧在,只是里面摆着"去哪拿图" -->
          <div v-if="!item" class="cv-prompt">
            <PhSelection class="cv-empty-ico" aria-hidden="true" />
            <h2 class="cv-empty-title">Nothing on the canvas</h2>
            <p class="cv-empty-sub">
              Pick one from your history, or upload a picture from this device,
              to crop, rotate or flip it.
            </p>
            <div class="cv-empty-acts">
              <button class="btn is-cta" @click="emit('pick')">Browse history</button>
              <button class="btn" @click="pickFile">Upload image</button>
            </div>
          </div>
          <template v-else>
            <canvas ref="canvasEl" aria-label="Editing canvas"></canvas>
            <p v-if="loading" class="cv-hint">Opening image…</p>
            <p v-else-if="error" class="cv-hint is-error">{{ error }}</p>
            <!-- 停下来的那一下要应一声:盘子撤掉和"算坏了"长得一样,
                 不吭声的话分不清是停了还是失败了。它是中性的事,不走报错样式 -->
            <p v-else-if="stopped" class="cv-hint">Stopped.</p>
            <!-- 切到裁剪之后,得有人告诉用户下一步是"在图上拖一下"。
                手上已经有一个框时不重复说;框一拉出来这句自然消失 -->
            <p v-else-if="tool === 'crop' && !cropRect" class="cv-hint is-soft">
              Drag on the picture to draw a selection
            </p>
          </template>

          <!-- 选区旁浮出来的一小条:这个框接下来怎么办。
               贴着选区走(见 ctxStyle),不再另占一行把画面压矮。
               .stop 是必须的:它铺在舞台上,不拦的话点按钮会被当成"重新拉一个框" -->
          <div v-if="cropRect" class="cv-ctx" :style="ctxStyle" role="status" @pointerdown.stop>
            <span class="ctx-size">
              {{ Math.round(cropRect.w) }} × {{ Math.round(cropRect.h) }}
            </span>
            <button class="ctx-btn" @click="cropRect = null">
              <PhTrash aria-hidden="true" />
              Clear
            </button>
            <button class="ctx-btn is-cta" :disabled="locked" @click="applyCrop">Apply crop</button>
          </div>

          <!-- 套索那条:形状是手画出来的,所以这里报不出宽高,
               只说这一块能拿它做什么。
               三个出口里"重画"是主角 —— 它的落点是实心药丸,
               另外两个保持素色:清除只是收回选区,而消除完全可撤销 -->
          <div
            v-else-if="lassoPath && !regenOpen"
            class="cv-ctx"
            :style="ctxStyle"
            role="status"
            @pointerdown.stop
          >
            <span class="ctx-size">Selection</span>
            <button class="ctx-btn" @click="lassoPath = null">
              <PhTrash aria-hidden="true" />
              Clear
            </button>
            <button class="ctx-btn" :disabled="locked" @click="eraseSelection">Erase</button>
            <button class="ctx-btn is-cta" :disabled="locked" @click="openRegen">
              <PhSparkle aria-hidden="true" />
              Reimagine
            </button>
          </div>

          <!-- 写指令那一态:顶掉上面的胶囊,原地换成一块输入区。
               两者不并排 —— 选区旁边同时飘两块东西会打架。
               提交后它不收起:成功时 rebuild 会清掉套索、它自己跟着收,
               失败时那句话还在框里,回车就能再试一次 -->
          <div
            v-else-if="lassoPath"
            class="cv-ctx is-composer"
            :style="ctxStyle"
            @pointerdown.stop
          >
            <textarea
              ref="regenEl"
              v-model="regenText"
              class="ctx-input"
              rows="2"
              placeholder="Describe what should go here…"
              aria-label="Describe what should go here"
              @keydown.stop="composerKey($event, regenSelection, closeRegen)"
            ></textarea>
            <div class="ctx-acts">
              <button class="ctx-btn" @click="closeRegen">Cancel</button>
              <!-- 在途时它变成停止键:输入框已经开着、没法再发一次,
                   那这一下能做的就只剩"把在算的那件停掉" -->
              <button
                class="ctx-btn is-cta is-icon"
                :disabled="!job && (locked || !regenText.trim())"
                :aria-label="job ? 'Stop' : 'Apply the change'"
                @click="job ? stop() : regenSelection()"
              >
                <PhStop v-if="job" aria-hidden="true" />
                <PhPaperPlaneRight v-else aria-hidden="true" />
              </button>
            </div>
          </div>

          <!-- 橡皮的工具带。它挂在舞台顶上而不是贴着笔迹走 ——
               笔迹是散开的,贴谁都不对;而笔头大小得在落笔之前就能调,
               所以它只要工具选中就露面,不看有没有抹过 -->
          <div
            v-if="item && tool === 'eraser' && !bgOpen && !genOpen"
            class="cv-ctx is-bar"
            role="group"
            aria-label="Eraser"
            @pointerdown.stop
          >
            <span class="ctx-size">Eraser</span>
            <button
              class="ctx-btn is-icon"
              :disabled="eraserSize <= ERASER_MIN"
              aria-label="Smaller eraser"
              @click="eraserStep(1 / 1.25)"
            >
              <PhMinus aria-hidden="true" />
            </button>
            <span class="bar-val">{{ eraserSize }} px</span>
            <button
              class="ctx-btn is-icon"
              :disabled="eraserSize >= ERASER_MAX"
              aria-label="Bigger eraser"
              @click="eraserStep(1.25)"
            >
              <PhPlus aria-hidden="true" />
            </button>
            <span class="bar-sep" aria-hidden="true"></span>
            <button class="ctx-btn" :disabled="locked || !strokes.length" @click="clearStrokes">
              <PhTrash aria-hidden="true" />
              Clear
            </button>
            <button
              class="ctx-btn is-cta"
              :disabled="locked || !strokes.length"
              @click="erasePainted"
            >
              Erase
            </button>
          </div>

          <!-- 换背景:改的是整幅,没有选区可依附,所以按"整幅"的位置挂在顶上。
               与橡皮那条同占一个位置,靠 bgOpen 互斥(见 openBg 与 openRegen) -->
          <div
            v-if="item && bgOpen"
            class="cv-ctx is-composer is-bar"
            @pointerdown.stop
          >
            <p class="ctx-eyebrow">Replace background</p>
            <textarea
              ref="bgEl"
              v-model="bgText"
              class="ctx-input"
              rows="2"
              placeholder="Describe the new background…"
              aria-label="Describe the new background"
              @keydown.stop="composerKey($event, replaceBackground, closeBg)"
            ></textarea>
            <div class="ctx-acts">
              <button class="ctx-btn" @click="closeBg">Cancel</button>
              <button
                class="ctx-btn is-cta is-icon"
                :disabled="!job && (locked || !bgText.trim())"
                :aria-label="job ? 'Stop' : 'Apply the new background'"
                @click="job ? stop() : replaceBackground()"
              >
                <PhStop v-if="job" aria-hidden="true" />
                <PhPaperPlaneRight v-else aria-hidden="true" />
              </button>
            </div>
          </div>

          <!-- 照这张再画一张。参考图不用挑 —— 画布上摆着的就是,
               所以要写的只有"画成什么样"。与换背景那张同占舞台顶上,
               靠 closeComposers 互斥(见 openGen) -->
          <div v-if="item && genOpen" class="cv-ctx is-composer is-bar" @pointerdown.stop>
            <p class="ctx-eyebrow">Create from this picture</p>
            <textarea
              ref="genEl"
              v-model="genText"
              class="ctx-input"
              rows="2"
              placeholder="Describe what you want to make…"
              aria-label="Describe what you want to make"
              @keydown.stop="composerKey($event, createFromThis, closeGen)"
            ></textarea>
            <div class="ctx-acts">
              <button class="ctx-btn" @click="closeGen">Cancel</button>
              <button
                class="ctx-btn is-cta is-icon"
                :disabled="!job && (locked || !genText.trim())"
                :aria-label="job ? 'Stop' : 'Create from this picture'"
                @click="job ? stop() : createFromThis()"
              >
                <PhStop v-if="job" aria-hidden="true" />
                <PhPaperPlaneRight v-else aria-hidden="true" />
              </button>
            </div>
          </div>
        </div>

        <!-- 角落的一行注脚:多少像素、现在放到多大。
             点它就回到 1:1 —— 缩放按钮进了左栏,这个数字顺手顶上 -->
        <button
          v-if="item && imgW"
          class="cv-status"
          data-tip="Zoom to 100%"
          aria-label="Zoom to 100%"
          @click="zoomTo100"
        >
          {{ imgW }} × {{ imgH }} · {{ zoomPct }}%
        </button>

        <!-- 有未保存改动时的确认。它浮在画布上沿居中 ——
             底部已经给了步骤条,两件事挤在同一处会互相看不清 -->
        <div v-if="confirmDiscard" class="cv-ask" role="alertdialog" aria-label="Discard edits">
          <span class="cv-text">Discard your unsaved edits?</span>
          <button class="btn" @click="confirmDiscard = false">Keep editing</button>
          <button class="btn is-danger" @click="emit('discard')">Discard</button>
        </div>

        <!-- 编辑步骤:第一张是原图,之后每加一个操作多一张。
             点一张就回到那一步 —— 比连按撤销快,也看得见自己改到哪儿了。
             它和左侧工具条一样浮在画布上,所以归在 .cv-body 里面 -->
        <div
          v-if="showStrip"
          ref="stripEl"
          class="cv-strip"
          aria-label="Edit steps"
        >
          <!-- 只剩一枚图标:这一段是"步骤",旁边的缩略图自己会说这件事 -->
          <span class="strip-head" aria-hidden="true">
            <PhClockCounterClockwise />
          </span>
          <div ref="trackEl" class="strip-track">
            <template v-for="(u, i) in stepUrls" :key="i">
              <button
                class="step"
                :class="{ on: i === ops.length, future: i > ops.length }"
                :aria-current="i === ops.length ? 'true' : undefined"
                :aria-label="i === 0 ? 'Original' : `Step ${i}`"
                :title="i === 0 ? 'Original' : `Step ${i}`"
                @click="goStep(i)"
              >
                <img :src="u" alt="" />
              </button>

              <!-- 在途的那一格:结果还没回来,没有缩略图可画,先占住位置。
                   它同时是这一条上唯一能停的地方 —— 图算完之前,
                   用户能做的决定只有"还要不要它",那就把这一下给出来。
                   插在"当前那一步"之后而不是整条末尾:手里有撤回去的步骤时,
                   末尾站的是重做栈,而结果一落地就会把它清空 -->
              <button
                v-if="job && i === ops.length"
                class="step is-job"
                :data-tip="`Stop · ${job.label}`"
                :aria-label="`Stop: ${job.label}`"
                @click="stop"
              >
                <PhStop aria-hidden="true" />
              </button>
            </template>
          </div>

          <!-- 撤销 / 重做 / 复位挂在这一条上:它们本来就是"在步骤之间前后走",
               和上面这排缩略图说的是同一件事,没必要在左栏另占一格。
               它们只在有步骤时才露面 —— 没动过图的时候本来就是灰的 -->
          <div class="strip-acts">
            <button
              class="sbtn"
              :disabled="!canUndo"
              data-tip="Undo (⌘Z)"
              aria-label="Undo"
              @click="undo"
            >
              <PhArrowUUpLeft aria-hidden="true" />
            </button>
            <button
              class="sbtn"
              :disabled="!canRedo"
              data-tip="Redo (⇧⌘Z)"
              aria-label="Redo"
              @click="redo"
            >
              <PhArrowUUpRight aria-hidden="true" />
            </button>
            <button
              class="sbtn"
              :disabled="!canUndo"
              data-tip="Back to the original"
              aria-label="Back to the original"
              @click="reset"
            >
              <PhArrowCounterClockwise aria-hidden="true" />
            </button>
          </div>
        </div>

        <!-- 左栏键的悬停提示。渲染在这一层、不在按钮里面 ——
             那里面是滚动容器,跟着按钮走的气泡会被裁掉半个 -->
        <Transition name="cv-tip">
          <span
            v-if="railTip.text"
            class="rail-tip"
            :style="{ left: `${railTip.x}px`, top: `${railTip.y}px` }"
            aria-hidden="true"
          >{{ railTip.text }}</span>
        </Transition>
      </div>

      <!-- 两个上传入口都指向它:工具条上那枚键,和空态里的按钮 -->
      <input
        ref="fileEl"
        class="cv-file"
        type="file"
        accept="image/*"
        @change="onFileChange"
      />
    </section>
  </Transition>
</template>

<style scoped>
/* 整页工作台:铺在顶部横条之下,铺满其余视口。
   - 这一页自己的操作不占顶部那条带:横条上有字标(会写成"KImage Canvas")、
     居中的导航、主题键三组,再叠一条工具栏,人就得在两处顶部找东西。
     所以工具、撤销、撤图全部并进左侧竖排,顶部只留横条。
   - fixed 而不是"占满高度的一块内容":彻底脱离文档流,
     进出这一页都不会改变文档高度 —— 滚动条不会闪,也不用去动 .shell 的内边距。
   - 没有边框、圆角、阴影:这是页,不是卡片。 */
.canvas-page {
  position: fixed;
  inset: 0;
  /* 让出顶部横条。值由主界面量出来(窄屏下横条会变两行) */
  padding-top: var(--mast-h, 72px);
  z-index: 1;
  display: grid;
  /* 整页只剩画布那一块:顶部横条归全站,底部那条工具栏也收进左栏了 */
  grid-template-rows: 1fr;
  /* 画布铺满之后,这一层只在"让开顶部横条"的那条带上露出来 ——
     用页面底色,和全站连成一片 */
  background: var(--bg);
  overflow: hidden;
}

/* 键盘走查时得看得见落点。全局把 outline 关掉了(见 style.css),
   而这一页控件密,没有环就不知道焦点落在哪个键上 */
.canvas-page :focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

/* 上传用的 input。只由按钮代为点击,自己不出现在版面上 */
.cv-file {
  display: none;
}

/* 画布右上角的一行注脚:多少像素、现在放到多大。
   它是状态而不是操作,所以只占角落、不挡手 —— 点一下回到 1:1。
   放上面是因为下沿归步骤条:步数一多那条会横着铺过来,角落就没了 */
.cv-status {
  position: absolute;
  top: var(--sp-4);
  right: var(--sp-4);
  z-index: 1;
  padding: 2px 6px;
  border-radius: 6px;
  font-size: var(--fs-micro);
  color: var(--text-3);
  font-variant-numeric: tabular-nums;
  transition: background var(--dur) var(--ease), color var(--dur) var(--ease);
}
.cv-status:hover {
  background: var(--surface);
  color: var(--text);
}

/* —— 空态:画布区域照旧铺开,提示落在它正中 ——
   版面与有图时一模一样,变的只是这块区域里装的东西 */
.cv-prompt {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--sp-3);
  padding: var(--sp-6);
  text-align: center;
}
.cv-empty-ico {
  width: 32px;
  height: 32px;
  color: var(--text-4);
}
.cv-empty-title {
  font-size: var(--fs-xl);
  font-weight: 500;
  letter-spacing: var(--ls-tight);
}
.cv-empty-sub {
  max-width: 42ch;
  font-size: var(--fs-base);
  color: var(--text-2);
}
/* 空态的两个去处并排;窄到放不下就换行,别把按钮压扁 */
.cv-empty-acts {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: var(--sp-2);
}

/* —— 主体:画布铺满整块地方,工具条与步骤条浮在它上面 ——
   它们都脱离文档流,所以不再从画布身上切走一条边 ——
   中间这一整块都是用来改图的 */
.cv-body {
  position: relative;
  display: flex;
  min-height: 0;
}
/* 工具条浮在画布左上角。它不占版面 —— 画布从它底下铺过去,
   于是"能改图的地方"始终是整块,而不是被切掉一条的剩余 */
.cv-rail {
  position: absolute;
  left: var(--sp-4);
  top: var(--sp-4);
  z-index: 2;
  display: flex;
  flex-direction: column;
  /* 键靠着左沿排:分隔线按同一条线对位,底部那几件也才对得上 */
  align-items: flex-start;
  gap: var(--sp-2);
  /* 高度封顶,而且不许被内容撑破:展开的内容并排成第二列,
     所以展开前后这条的高度是一样的。真要放不下,滚的是里面那一截。
     左下角那条步骤条也得让出来 —— 它是后来才长出来的,不让就会压住这条。
     --strip-h 由 JS 量出来(见 measureStrip),量不到时按 0 算,
     于是没有步骤条的时候,这条和从前一样 */
  max-height: calc(100% - var(--strip-h, 0px) - var(--sp-6) - var(--sp-3));
  overflow: hidden;
  /* 12 而不是 8:选中那块底离卡片边再远一点,才不像贴边糊上去的 */
  padding: var(--sp-3);
  border-radius: var(--r);
  background: var(--surface);
  border: 1px solid var(--line);
  /* 贴边细影 + 一圈弥散。--sh-sm 单独用太散,卡片会显得飘 */
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.05), 0 6px 16px -4px rgba(0, 0, 0, 0.12);
}
/* AI 那一组的图标走渐变 —— 单色撑不住"这是 AI"这件事。
   SVG 的 fill 可以指向一个 paint server,所以渐变本体放在模板的 defs 里
   (见 .cv-ai-defs),这一条只把图标引过去。
   用 fill 而不是 color:color 只给得出单色,渐变必须走 fill。
   两端的色由主题给(见 style.css 的 --ai-from / --ai-to) */
.rail-ai .tool svg {
  /* 后面那个色是兜底:fill 指向的 paint server 一旦取不到(定义没挂上、
     或者被某个浏览器当成无效引用),整块就会画不出来 —— 图标直接消失。
     url() 后面允许跟一个颜色当退路,那就不会出现"键还在、图标没了" */
  fill: url(#cv-ai-grad) var(--ai-from);
}
/* 只装一个渐变定义,不参与布局。不用 display:none —— 那是"不渲染",
   某些浏览器会连里面的 gradient 一起不认,引用它的 fill 会退成黑色 */
.cv-ai-defs {
  position: absolute;
  width: 0;
  height: 0;
  overflow: hidden;
}
.cv-ai-from {
  stop-color: var(--ai-from);
}
.cv-ai-to {
  stop-color: var(--ai-to);
}
/* 两条例外。灰掉的键不该还亮着;
   停止键是这一组里唯一的破坏性动作,归 --danger —— 与步骤条上那一格同色。
   两条都要比上面那条更具体才盖得住 */
.rail-ai .tool:disabled svg {
  fill: var(--text-4);
}
.rail-ai .tool svg.is-stop {
  fill: var(--danger);
}
.rail-grp {
  display: flex;
  flex-direction: column;
  /* 4 而不是 8:一组之内这些键是"同一件事的几个选项",挨紧一点才像一簇。
     组与组那条短线两侧仍是 8(见 .rail-col 的 gap),于是"内紧外松" ——
     分组的层次靠这两档差撑起来,不必再加别的装饰 */
  gap: var(--sp-1);
  /* 不许被压缩:卡片限高时该滚动,而不是把每个键挤扁 */
  flex: none;
}
/* 组与组之间的一道短线。它要落在键的中线上:键宽 44、线宽 24,
   于是左偏 10px —— 不能用 align-self: center,列宽会随展开变化,
   那样线会跑到整条卡片的正中,而不是键的正中 */
.rail-sep {
  width: 24px;
  height: 1px;
  margin-left: 10px;
  background: var(--line);
  align-self: flex-start;
  flex: none;
}
/* 常用项那一截:超过卡片高度时只滚它 */
.rail-scroll {
  display: flex;
  flex-direction: row;
  align-items: flex-start;
  gap: var(--sp-2);
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  /* 滚就滚,不必再挂一条滚动条 */
  scrollbar-width: none;
}
.rail-scroll::-webkit-scrollbar {
  display: none;
}
/* 一列操作键。键与键之间一律 8px:分组已经靠"组"这个结构说清了,
   再用两档间距拉开,一列里就会有的密有的疏 */
.rail-col {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: var(--sp-2);
  flex: none;
}

/* 折起来的这几组:从常用项那一列的右手边长出来,展开的是宽度。
   max-width 只是给过渡用的上下限,不参与实际布局 */
.rail-fold {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: var(--sp-2);
  flex: none;
  overflow: hidden;
}
/* 展开:宽度与淡入同步走一条曲线 —— 时长错开的话会先亮起来再慢慢推开,像两下。
   给足 340ms,它是"推开一条边栏",快了像闪一下 */
.rail-fold-enter-active {
  transition: max-width 340ms var(--ease), opacity 340ms var(--ease);
}
/* 收起只收窄,不淡出也不位移。三件事一起做的时候,
   宽度还没收完内容就已经淡没了,末尾剩一段空收 —— 看着就是"卡了一下"。
   曲线换成先慢后快,让它越收越快、干脆让开 */
.rail-fold-leave-active {
  transition: max-width 200ms cubic-bezier(0.4, 0, 1, 1);
}
.rail-fold-enter-from {
  max-width: 0;
  opacity: 0;
}
.rail-fold-leave-to {
  max-width: 0;
}
.rail-fold-enter-to,
.rail-fold-leave-from {
  /* 44 就是内容本身的宽度(一个键)。再多给一截是空推,
     末尾那段没有内容跟上,看起来会"刹不住" */
  max-width: 44px;
  opacity: 1;
}

/* 一个工具键:只剩图标。名字与快捷键交给悬停提示 ——
   带一行字的话这条竖栏要宽出去近一倍,而字本身只是"认图标"的辅助。
   选中态只有一层淡底:不勾边,也不做实心 ——
   一圈描边会让这个键看着"被框住",实心块则把白卡片切成两半 */
.tool {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 44px;
  height: 44px;
  flex: none;
  /* 比卡片(16)小一档:内嵌一层的圆角要跟着内缩,不然两圈弧线会打架 */
  border-radius: 12px;
  color: var(--text-2);
  transition: background var(--dur) var(--ease), color var(--dur) var(--ease);
}
/* 所有键上的图标走同一条尺寸,而且不许被压扁 ——
   两列、常驻与展开的图标因此落在同一个视觉尺度上 */
.tool svg {
  display: block;
  width: 19px;
  height: 19px;
  flex: none;
}
.tool:hover:not(:disabled) {
  background: var(--bg-elev);
  color: var(--text);
}
.tool.on {
  background: var(--accent-soft);
  color: var(--text);
}
.tool:disabled {
  color: var(--text-4);
  cursor: default;
}
/* More 的箭头:朝右是"还能展开",翻过来是"现在能收起" */
.cv-caret {
  transition: transform var(--dur) var(--ease);
}
.cv-caret.flip {
  transform: rotate(180deg);
}
/* 这一页的键都不再走全站那套 ::after 气泡 —— 它挂在按钮旁边,
   而 rail 和步骤条内部都是滚动容器,气泡会被裁掉一半;
   步骤条那几个键还不在 rail 里,只关 rail 会让它们同时冒出两个。
   一律改由下面那个浮层承担 */
.cv-body [data-tip]::after,
.cv-body [data-tip]::before {
  display: none;
}
/* 左栏键的悬停提示。它挂在 .cv-body 上(不在按钮里),所以裁不到。
   观感与全站那套 data-tip 气泡逐项对齐:墨底白字、6px 圆角、同一个内边距与字号、
   同一个 130ms 与 4px 的入场位移 —— 只有位置改由 JS 现算 */
.rail-tip {
  position: absolute;
  z-index: 20;
  /* 竖直居中走独立的 translate,把 transform 让给入场那点位移 */
  translate: 0 -50%;
  padding: 5px 9px;
  border-radius: 6px;
  font-size: var(--fs-xs);
  font-weight: 400;
  line-height: 1.4;
  color: var(--cta-text);
  background: var(--cta);
  box-shadow: var(--sh-sm);
  white-space: nowrap;
  /* 它只负责显示,别把指针从按钮上抢走 */
  pointer-events: none;
}
/* 指向按钮的小三角 */
.rail-tip::before {
  content: '';
  position: absolute;
  top: 50%;
  right: 100%;
  width: 0;
  height: 0;
  border: 5px solid transparent;
  border-right-color: var(--cta);
  transform: translateY(-50%);
}
.cv-tip-enter-active,
.cv-tip-leave-active {
  transition: opacity 130ms var(--ease), transform 130ms var(--ease);
}
.cv-tip-enter-from,
.cv-tip-leave-to {
  opacity: 0;
  transform: translateX(-4px);
}
.cv-stage {
  position: relative;
  flex: 1;
  min-width: 0;
  /* 顶栏往下这一整块就是编辑区:铺满、不留边、不勾框。
     它是"能改图的地方",不是版面上的一张卡 ——
     画框会让人以为图只能待在框里 */
  background: var(--image-bg);
  overflow: hidden;
  /* 触屏上禁掉浏览器自己的手势,否则拖一下就变成滚页面 */
  touch-action: none;
  /* 拖拽过程中不能顺带把页面上的文字刷成选中态 */
  user-select: none;
  -webkit-user-select: none;
}
.cv-stage.is-pan {
  cursor: grab;
}
.cv-stage.is-pan:active {
  cursor: grabbing;
}
/* 两个"圈一块地方"的工具都用十字准星:它们要的都是精确落点 */
.cv-stage.is-crop,
.cv-stage.is-lasso {
  cursor: crosshair;
}
/* 橡皮自己画那个圈,系统的十字线叠上去只是噪声 */
.cv-stage.is-eraser {
  cursor: none;
}
.cv-stage canvas {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  display: block;
}
.cv-hint {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: var(--fs-base);
  color: var(--text-2);
  /* 这句话盖在画布上,不能把拖拽手势挡掉 */
  pointer-events: none;
}
.cv-hint.is-error {
  color: var(--danger);
}
/* 引导语靠底站:中间是图本身,提示压在脸上只会挡着人看 */
.cv-hint.is-soft {
  align-items: flex-end;
  padding-bottom: 24px;
  font-size: var(--fs-sm);
  color: var(--text-3);
}

/* —— 浮在选区旁的上下文条 ——
   贴在选区正上方(放不下就翻到下面),不占版面行高。
   它铺在画面上,所以得靠一层较重的阴影把自己托起来 */
.cv-ctx {
  position: absolute;
  z-index: 3;
  display: flex;
  align-items: center;
  gap: var(--sp-1);
  padding: 4px 4px 4px 14px;
  border-radius: 999px;
  background: var(--surface);
  border: 1px solid var(--line);
  /* 贴边细影 + 一圈弥散:--sh-md 的偏移太大,这么小的胶囊会看着"飞起来" */
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.06), 0 12px 32px rgba(0, 0, 0, 0.14);
  white-space: nowrap;
  cursor: default;
  /* 窄屏上让它收着走,别探出舞台 */
  max-width: calc(100% - 16px);
}
.ctx-size {
  font-size: var(--fs-xs);
  color: var(--text-2);
  font-variant-numeric: tabular-nums;
}
.ctx-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 32px;
  padding: 0 12px;
  border-radius: 999px;
  color: var(--text);
  font-size: var(--fs-sm);
  transition: background var(--dur) var(--ease);
}
.ctx-btn svg {
  width: 15px;
  height: 15px;
}
.ctx-btn:hover {
  background: var(--bg-elev);
}
.ctx-btn.is-cta {
  background: var(--cta);
  color: var(--cta-text);
}
.ctx-btn.is-cta:hover {
  background: var(--cta-hover);
}
.ctx-btn:disabled {
  opacity: 0.38;
  cursor: not-allowed;
}

/* —— 写指令那一态 ——
   还是那条浮条,换了个形态:从横排胶囊变成一块小输入区。
   圆角收成 --r 而不是胶囊 —— 它现在是个面,不是一枚键 */
.cv-ctx.is-composer {
  display: block;
  width: 320px;
  padding: 10px 10px 8px;
  border-radius: var(--r);
  white-space: normal;
}
.ctx-input {
  display: block;
  width: 100%;
  max-height: 88px;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--text);
  /* 16px 是硬要求:iOS Safari 聚焦到比它小的框上会把整页放大 */
  font-size: 16px;
  line-height: 1.4;
  font-family: inherit;
  resize: none;
}
.ctx-input::placeholder {
  color: var(--text-3);
}
.ctx-input:focus {
  outline: none;
}
.ctx-acts {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-2);
  margin-top: 6px;
}
/* 图标键定宽:不写的话它比旁边的文字键窄,一行里居中不了 */
.ctx-btn.is-icon {
  width: 32px;
  padding: 0;
  justify-content: center;
}

/* —— 不带选区的那条 ——
   橡皮的工具带和换背景的输入框都作用于整体,没有"贴着谁"可言,
   所以统一挂在舞台顶上居中:左栏在左上角、历史条在左下角,
   这一条正好占中间那道空档 */
.cv-ctx.is-bar {
  top: 16px;
  left: 50%;
  transform: translateX(-50%);
  /* 它比贴选区那种胶囊离图更远,影得再散一点才托得起来 */
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.06), 0 16px 40px rgba(0, 0, 0, 0.18);
}
.bar-val {
  min-width: 52px;
  text-align: center;
  font-size: var(--fs-xs);
  color: var(--text-2);
  font-variant-numeric: tabular-nums;
}
/* 竖分隔:同样是"两组活儿",只是这条是横着排的 ——
   用 rail-sep 会画成横线,反倒把一排按键切成上下两半 */
.bar-sep {
  width: 1px;
  height: 18px;
  margin: 0 2px;
  background: var(--line);
}
/* 输入区顶上那行小字。与全站的眉标同一套写法 */
.ctx-eyebrow {
  margin: 0 0 6px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: var(--ls-eyebrow);
  text-transform: uppercase;
  color: var(--text-3);
}

.cv-text {
  font-size: var(--fs-sm);
  color: var(--text-2);
  font-variant-numeric: tabular-nums;
}

/* —— 步骤条 ——
   一条横向的缩略图:第一张是原图,之后每加一个操作多一张。
   它是"我改到哪儿了"的可视化 —— 点一张就回到那一步 */
.cv-strip {
  position: absolute;
  left: var(--sp-4);
  bottom: var(--sp-4);
  z-index: 2;
  display: flex;
  align-items: center;
  gap: var(--sp-4);
  /* 宽度收着长:右侧留一截,不顶到画布对面 */
  max-width: calc(100% - var(--sp-6));
  padding: var(--sp-2) var(--sp-4);
  border-radius: var(--r);
  background: var(--surface);
  border: 1px solid var(--line);
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.05), 0 12px 32px -6px rgba(0, 0, 0, 0.16);
  /* 它是"有操作之后才长出来"的,淡入比突然多出一条稳 */
  animation: cv-strip-in var(--dur) var(--ease);
}
@keyframes cv-strip-in {
  from {
    opacity: 0;
    transform: translateY(8px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}
/* 在途的那一格:结果还没回来,没有缩略图可画,先占住位置。
   它同时是"停"的入口 —— 图算完之前,用户能做的决定只有"还要不要它"。
   尺寸得跟真格子严丝合缝(52 的图 + 2×2 的内边距),否则它一出现,
   后面那几格会整体窜一下 —— 而那正是"结果快回来了"的一刻,不该抖 */
.step.is-job {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 56px;
  height: 56px;
  padding: 0;
  border: 1px dashed var(--line-strong);
  color: var(--text-3);
  background: transparent;
  /* 它是个按钮,得把浏览器给按钮的那套默认值摘掉 */
  font: inherit;
  cursor: pointer;
  transition: color var(--dur) var(--ease), border-color var(--dur) var(--ease);
  /* 呼吸:一个不动的虚线框看着像"这里坏了",动着才像"正在填" */
  animation: cv-slot 1.6s ease-in-out infinite;
}
.step.is-job svg {
  width: 20px;
  height: 20px;
}
/* 指着它时就别呼吸了 —— 眼下它是"等着被按",不是"正在填"。
   转成实线红边:停掉意味着这次算的全不要了,是这个动作里唯一的破坏性后果 */
.step.is-job:hover {
  animation: none;
  border-style: solid;
  border-color: var(--danger);
  color: var(--danger);
}
@keyframes cv-slot {
  0%,
  100% {
    border-color: var(--line);
    opacity: 0.7;
  }
  50% {
    border-color: var(--line-strong);
    opacity: 1;
  }
}
/* 只是一枚"这些是步骤"的标识,不再配文字 ——
   所以放大到和操作图标同档:孤零零一个小记号反而会显得没对上 */
.strip-head {
  display: flex;
  align-items: center;
  flex: none;
  color: var(--text-3);
}
.strip-head svg {
  display: block;
  width: 19px;
  height: 19px;
  flex: none;
}
/* 步数多了就横向滚,不换行 —— 换行会把底栏顶高,画布跟着缩 */
.strip-track {
  display: flex;
  align-items: center;
  gap: 10px;
  /* min-width: 0 是这条能滑起来的关键:flex 子项默认 min-width: auto,
     十几步之后它会被内容撑开,把整页的宽度带跑 ——
     左侧工具条会跟着挪位。归零之后它才老实横向滚动 */
  min-width: 0;
  padding: 2px;
  overflow-x: auto;
  /* 滑就滑,不必再给一条滚动条:两端的缩略图自己会说明还有 */
  scrollbar-width: none;
}
.strip-track::-webkit-scrollbar {
  display: none;
}
.step {
  display: block;
  flex: none;
  padding: 2px;
  border-radius: 10px;
}
/* 描边画在图上、不画在容器上:紧贴图片的那一圈才说得清"选中的是这张" */
.step img {
  display: block;
  width: 52px;
  height: 52px;
  border-radius: 8px;
  background: var(--bg-elev);
  box-shadow: 0 0 0 1px var(--line);
  transition: box-shadow var(--dur) var(--ease), opacity var(--dur) var(--ease);
}
.step:not(.on):hover img {
  box-shadow: 0 0 0 1px var(--line-strong);
}
.step.on img {
  box-shadow: 0 0 0 2px var(--accent);
}
/* 已经撤掉、但还回得去的那几步压淡一档:
   留在条上是让人看见"改到哪儿了",但不该和图上正生效的几步抢注意力 */
.step.future img {
  opacity: 0.4;
}
/* 撤销 / 重做 / 复位。它们站在缩略图右侧,用一道淡竖线隔开 ——
   左边是"我改到哪儿了",右边是对这段序列的三个动作 */
.strip-acts {
  display: flex;
  align-items: center;
  gap: var(--sp-1);
  flex: none;
  padding-left: var(--sp-3);
  border-left: 1px solid var(--line);
}
.sbtn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  /* 与左栏那些键一样守 40px 的触控底线 */
  width: 40px;
  height: 40px;
  flex: none;
  border-radius: 10px;
  color: var(--text-2);
  transition: background var(--dur) var(--ease), color var(--dur) var(--ease);
}
/* 与左栏那些键的图标同一个尺寸,跨区域看着才是一套 */
.sbtn svg {
  display: block;
  width: 19px;
  height: 19px;
  flex: none;
}
.sbtn:hover:not(:disabled) {
  background: var(--bg-elev);
  color: var(--text);
}
.sbtn:disabled {
  color: var(--text-4);
  cursor: default;
}

/* —— 确认条 ——
   浮在画布上沿居中。底部已经是步骤条的地盘,
   两件事挤在同一处会互相看不清 */
.cv-ask {
  position: absolute;
  top: var(--sp-4);
  left: 50%;
  transform: translateX(-50%);
  z-index: 3;
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  padding: var(--sp-1) var(--sp-1) var(--sp-1) var(--sp-4);
  border-radius: 999px;
  background: var(--surface);
  border: 1px solid var(--line);
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.06), 0 12px 32px rgba(0, 0, 0, 0.14);
  white-space: nowrap;
}

.btn {
  height: 40px;
  padding: 0 18px;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: var(--surface);
  font-size: var(--fs-base);
  transition: border-color var(--dur) var(--ease), background var(--dur) var(--ease);
}
.btn:hover:not(:disabled) {
  border-color: var(--line-strong);
  background: var(--bg-elev);
}
.btn.is-cta {
  background: var(--cta);
  color: var(--cta-text);
  border-color: var(--cta);
}
.btn.is-cta:hover:not(:disabled) {
  background: var(--cta-hover);
  border-color: var(--cta-hover);
}
.btn.is-danger {
  color: var(--danger);
  border-color: color-mix(in oklch, var(--danger) 40%, var(--line));
}
.btn.is-danger:hover {
  background: color-mix(in oklch, var(--danger) 10%, var(--surface));
}
.btn:disabled {
  opacity: 0.5;
  cursor: default;
}

/* 翻页动效自备一份,不复用主界面的 .page-*:
   那一组样式是 App 的 scoped CSS,能不能落到这里的根节点上要看作用域继承,
   而这一页本来就是个自足的组件 —— 自己写死更稳。
   时长与曲线与主界面那组保持一致,读起来才是同一个动效 */
.cv-page-enter-active {
  transition: opacity 320ms var(--ease), transform 320ms var(--ease);
}
.cv-page-enter-from {
  opacity: 0;
  transform: translateY(14px);
}
.cv-page-leave-active {
  transition: opacity 150ms ease-out, transform 150ms ease-out;
}
.cv-page-leave-to {
  opacity: 0;
  transform: translateY(-6px);
}

/* 窄屏:工具条从竖排改成横排,把宽度还给图片 —— 竖着一条在手机上
   占的是真正的作画区域。文字标签也收掉:横排七项带字会顶到屏幕外 */
@media (max-width: 720px) {
  /* 窄屏:工具条横过来,依旧浮在画布上,只是改成贴着上沿 */
  .cv-rail {
    flex-direction: row;
    align-items: center;
    /* 横过来之后限的是宽度不是高度 */
    max-height: none;
    padding: var(--sp-1) var(--sp-2);
    /* 八九项横排,极窄的机器上宁可横向滑,也不让它被裁掉 */
    overflow-x: auto;
  }
  .rail-grp {
    flex-direction: row;
  }

  /* 窄屏整条是横的:两列也跟着横过来,接成一条长带 */
  .rail-scroll {
    overflow: visible;
  }
  .rail-col {
    flex-direction: row;
  }
  /* 横过来之后短线转成竖的,偏移也从左改到上 —— 同样是为了对着键的中线 */
  .rail-sep {
    width: 1px;
    height: 24px;
    margin-left: 0;
    margin-top: 10px;
  }
  /* 横过来之后这一组也是横的,展开的是一长串而不是"一个键" */
  .rail-fold {
    flex-direction: row;
  }
  .rail-fold-enter-to,
  .rail-fold-leave-from {
    max-width: 420px;
  }
  .cv-strip {
    padding: var(--sp-2) var(--sp-3);
  }
  .step img {
    width: 40px;
    height: 40px;
  }
  /* 占位跟着缩略图一起收窄,不然窄屏上它比谁都大一圈 */
  .step.is-job {
    width: 44px;
    height: 44px;
  }
  /* 角落那行注脚在小屏上没地方站 */
  .cv-status {
    display: none;
  }
  /* 确认条放不下就换行,不让它顶出画布 */
  .cv-ask {
    flex-wrap: wrap;
    justify-content: center;
    max-width: calc(100% - var(--sp-8));
    padding: var(--sp-2);
    border-radius: var(--r);
    white-space: normal;
  }
  .cv-ask .cv-text {
    width: 100%;
    text-align: center;
  }
}
</style>
