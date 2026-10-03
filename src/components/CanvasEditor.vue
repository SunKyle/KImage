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
// 编辑载荷的体积控制(收窄到上限、按内容选格式、超预算再退档)。见 lib/payload.ts
/* 操作序列的栈怎么进退、每一步怎么写、矩形怎么夹进画面 —— 那些都不碰像素,
   所以收在 lib/canvasOps.ts 里(能单测)。这里只留真正画像素的那一半 */
import {
  clampNum,
  clampRectToImage,
  describeOp,
  goToStep,
  /* 与组件自己的 pushOp 同名会让函数声明遮蔽掉导入(踩过一次),
     所以这一条改名引入 */
  pushOp as pushOntoStacks,
  redoOp,
  rotatedSize,
  roundRect,
  undoOp,
  type CanvasOp,
  type CanvasPoint,
  type CanvasRect
} from '../lib/canvasOps'
import {
  REF_IMAGE_EDGE,
  payloadOverBudget,
  payloadScaleFor,
  shrinkScaleFor
} from '../lib/payload'
import { blobToDataURL } from '../lib/idb'
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
/* 这两个别名保留是为了不动组件里几十处用法:形状与引擎里那份完全一样 */
type Rect = CanvasRect
type Point = CanvasPoint
/* 几何操作:坐标相对"执行到它那一刻的图像",重放必然自洽。
   AI 编辑是另一支,见 AiOp */
/* 位图由 AI 那一步自己带着(形状与理由见 lib/canvasOps.ts 的 CanvasAiOp)。
   这里定下具体的位图类型 —— 组件里是 ImageBitmap。
   存位图而不是 Blob:重放是同步的,而 Blob 得异步解码。
   这份内存由 resetAll 收口:换图、撤图时统一 close */
type Op = CanvasOp<ImageBitmap>

/* AI 编辑那一步。它与上面三种有个根本差别:后者的结果是算出来的,
   而"去掉背景之后长什么样"只有上游知道 —— 所以这一支自己带着结果位图,
   applyOp 遇到它就直接换上,不重算。撤销之后重做、直接跳到某一步,
   走的都是同一份结果,不会二次调用接口(那既慢又要花钱)。

   存位图而不是 Blob:重放是同步的(见 rebuild 与 replayAll),
   而 Blob 得异步解码。这份内存由 resetAll 收口 —— 换图、撤图时统一 close */
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
  /* 默认贴右缘。只有图片那条要反过来 —— 它本来就站在舞台右沿,
     气泡再往右就出了这一层,只能往左让 */
  const side = el.dataset.tipSide === 'left' ? 'left' : 'right'
  // 与全站的悬停气泡同一个节奏:稍等一下再冒出来,
  // 鼠标扫过一排键时才不会闪成一片(那边是 250ms 的 transition-delay)
  tipTimer = window.setTimeout(() => {
    railTip.value = {
      text,
      side,
      // 贴着这个键的右缘(与全站的 calc(100% + 8px) 同一个间距),竖直居中
      x: side === 'left' ? r.left - b.left - 8 : r.right - b.left + 8,
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
const railTip = ref({ text: '', x: 0, y: 0, side: 'right' })
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
   记着 kind 是为了让左栏"在跑的是哪一颗"说得清 —— 只看"有没有在途"的话,
   三颗 AI 键会一起亮起来。步骤条上那一格、输入框里的发送键也都靠它认人。

   它放在这一堆界面状态里而不是紧挨着 runJob:左栏、步骤条、取景都要看它,
   而它们散在这个文件的前半段 —— 声明得太晚,那几处就只能读到未初始化 */
const job = ref<{ kind: JobKind; label: string; sub: string } | null>(null)

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

/* 换背景那句话。它与局部重绘分开,是因为它没有选区可依附 ——
   改的是整幅图,所以要有个固定的落点(见 .cv-assist) */
const bgOpen = ref(false)
const bgText = ref('')
/* 按这张图再画一张。参考图不用挑 —— 就是画布现在这张,
   所以要写的只有"画成什么样"。与换背景共用同一块面板,靠 closeComposers 互斥 */
const genOpen = ref(false)
const genText = ref('')
/* 面板里那个输入框。两件事共用一个,所以 ref 也只有一个 */
const assistEl = ref<HTMLTextAreaElement | null>(null)

/* —— 助手面板 ——
   换背景与"照这张再画一张"改的都是整幅:没有哪一点可以依附,
   所以它们不该像局部重绘那样贴着"那一块"走,而要有块固定的地方。
   为什么是右侧而不是浮在画面上:这两句描述往往是一整句话,
   340px 的浮条写起来憋屈,而且它正好压在你要描述的那张图上。
   两件事共用一块面板 —— 它们在左栏上本来就是挨着的两颗键,
   来回切的时候这一块不该整个收掉再长出来 */
const assistOpen = computed(() => bgOpen.value || genOpen.value)

/* 输入框那条 v-model。两个 ref 各存各的那句话(收起时会清掉,见 closeBg),
   所以切来切去不会串味 */
const assistText = computed({
  get: () => (genOpen.value ? genText.value : bgText.value),
  set: (v: string) => {
    if (genOpen.value) genText.value = v
    else bgText.value = v
  }
})

/* 面板上随"替谁说"而变的那几处字样。除此之外两件事一模一样 ——
   两套外壳会让人以为是两个地方,而它们只是同一件事的两个由头 */
const assistSpec = computed(() => {
  if (genOpen.value) {
    return {
      label: 'Create from this picture',
      /* 标题左边那枚图标,用的就是刚才按下的那颗左栏键 ——
         面板与那颗键是同一件事的两半,长一样才连得上 */
      icon: PhMagicWand,
      placeholder: 'The same person, walking a rainy neon alley at night…',
      hint: 'The picture on the canvas goes in as the reference — say only what you want to see.',
      cta: 'Create',
      submit: createFromThis,
      close: closeGen
    }
  }
  /* 换背景是兜底那一档:面板开着时两者必有其一是真的,
     所以这里不必再判一次 —— 收起来的时候也没人读它 */
  return {
    label: 'Replace background',
    icon: PhMountains,
    placeholder: 'A sunlit studio with tall windows, concrete floor…',
    hint: 'The whole picture goes to the model — describe the setting, not the person in it.',
    cta: 'Replace',
    submit: replaceBackground,
    close: closeBg
  }
})

const canUndo = computed(() => ops.value.length > 0)
const canRedo = computed(() => redoOps.value.length > 0)
const dirty = computed(
  () =>
    ops.value.length > 0 ||
    !!cropRect.value ||
    !!lassoPath.value ||
    strokes.value.length > 0
)

/* 画面改到第几版。
   这里按操作序列本身认版本,而不是"动过几次":撤销一下再重做回来,
   画面与已经存过的那一版一模一样,而计数式的版本号已经 +2 ——
   保存键于是重新亮起,一点就多出一条重复的记录(rev 本来就是为了防这个)。
   每个 op 领一个稳定序号,序列的序号连起来就是这一版的身份 */
const opSeq = new WeakMap<object, number>()
let opSeqNext = 0
const rev = computed(() =>
  ops.value
    .map((op) => {
      let s = opSeq.get(op)
      if (s === undefined) {
        s = ++opSeqNext
        opSeq.set(op, s)
      }
      return s
    })
    .join(',')
)
/* 上一次成功保存时的版本。存过之后画面没再动过,这个键就该是灰的 ——
   而不是让人多点一次,多出一条自己都不知道从哪来的记录。
   空串是一个不会等于任何真实签名的初值 */
const savedRev = ref('')
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

/** 宽高比。约不干净就整个不给 —— 1241 × 855 除下来是 1241:855,
 *  比不写还碍事。两端都落进 20 以内才算一条能用的比例
 *  (1:1、4:3、3:2、16:9、2:3 都在这一档里) */
const ratioLabel = computed(() => {
  const w = imgW.value
  const h = imgH.value
  if (!w || !h) return ''
  let a = w
  let b = h
  while (b) {
    const t = b
    b = a % b
    a = t
  }
  const p = w / a
  const q = h / a
  return p <= 20 && q <= 20 ? `${p}:${q}` : ''
})

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
    // 90° / 270° 要交换画布宽高,否则转完会被裁掉一条(见引擎的 rotatedSize)
    const box = rotatedSize(cur.width, cur.height, deg)
    const out = newCanvas(box.w, box.h)
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

/* 重放时把每一帧交给调用方看一眼 —— 步骤条那排缩略图要的正是中间帧,
   于是两件事可以合成一趟(见 replayAll)。
   op 为空表示这是原图那一帧 */
function replay(
  src: ImageBitmap,
  list: Op[],
  onFrame?: (c: HTMLCanvasElement, op?: Op) => void
): HTMLCanvasElement {
  let cur = firstFrame(src)
  onFrame?.(cur)
  for (const op of list) {
    const next = applyOp(cur, op)
    /* 中间帧用完就置零:一张 4000px 的画布是几十 MB,
       交给 GC 只是"迟早会收",而这一串操作会连着造好几张
       (与步骤条那边同一处理) */
    cur.width = 0
    cur.height = 0
    cur = next
    onFrame?.(cur, op)
  }
  return cur
}

/* ===== 步骤条 ======================================================
   底部那条缩略图:第一张是原图,之后每加一个操作多一张。
   数据直接从操作序列推出来,不额外存状态 ——
   撤销掉的那一步自然就从条上消失了。
   点其中一张就回到那一步(见 goStep)。
   ------------------------------------------------------------------ */
/* 条上的一格 = 缩略图 + 它干了什么。
   只给缩略图的话,走到十几步就认不出哪张是哪张了 —— 而这几行字
   正是"重放出来的图"说不出口的那件事(见 describeOp) */
type StepRow = { url: string; title: string; sub: string }
const steps = ref<StepRow[]>([])
const trackEl = ref<HTMLElement | null>(null)

/* 步骤条什么时候露面。动过图之后它才出现 —— 它说的是"改到哪一步了",
   没动过图时那一排只有原图,白占位置。
   在途那一次是例外:结果还没回来,但"有件事正在算"得立刻看得见,
   而且它算完要落在哪儿,也得先把格子腾出来 */
const showStrip = computed(() => !!props.item && (steps.value.length > 1 || !!job.value))

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

/** 某一步"干了什么"。缩略图只说得清改完长什么样,
 *  说不清改的是背景还是画幅 —— 这一格补的就是那句话。
 *  尺寸取的是**这一步之后**的画幅:裁剪之后剩多少、转过来多宽,
 *  都是看这一步才用得上的数 */
/* 把操作序列重放一遍,顺手把步骤条那排缩略图取出来,交回当前画面。
 *
 *  合成一趟是有意的:步骤条要的缩略图恰好就是重放的中间帧。以前分两趟 ——
 *  rebuild 重放一次拿画面,buildSteps 再重放一次拿缩略图 —— 一条十几步的
 *  操作序列在大图上等于把同一件几百毫秒的活干两遍。
 *
 *  撤掉的那几步(重做栈)接着当前画面往下算:整条时间线本来就是
 *  ops + redoOps 拼起来的,从末尾往后放正好接得上,不必从原图重来 */
function replayAll(): HTMLCanvasElement | null {
  if (!source) {
    steps.value = []
    return null
  }
  const rows: StepRow[] = []
  const cur = replay(source, ops.value, (frame, op) => {
    rows.push(
      op
        ? { url: stepShot(frame), ...describeOp(op, frame.width, frame.height) }
        : { url: stepShot(frame), title: 'Original', sub: `${frame.width} × ${frame.height}` }
    )
  })
  /* applyOp 不改传进去的那张(它总是另造一张交出来),所以 cur 可以安全当起点 ——
     它自己还要给调用方当当前画面,所以下面只清中间帧 */
  let tail = cur
  for (const op of redoOps.value) {
    const next = applyOp(tail, op)
    if (tail !== cur) {
      tail.width = 0
      tail.height = 0
    }
    tail = next
    rows.push({ url: stepShot(tail), ...describeOp(op, tail.width, tail.height) })
  }
  if (tail !== cur) {
    tail.width = 0
    tail.height = 0
  }
  steps.value = rows
  return cur
}

/** 重放一遍并刷新画面。两种选区都属于"还没落地的操作",每次重放都要清掉 ——
 *  它们是相对当时那张画面画的,画面变了就不再指同一块地方 */
function rebuild(refit = true) {
  if (!source) return
  /* 一趟出两样:当前画面 + 步骤条那一排缩略图(见 replayAll) */
  const next = replayAll()
  if (!next) return
  base = next
  imgW.value = base.width
  imgH.value = base.height
  cropRect.value = null
  lassoPath.value = null
  strokes.value = []
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
  /* 守卫:下面那个 f = k / v.scale 一旦碰上 0 就是 Infinity,坐标会整片飞走。
     MIN_ZOOM 已经把它挡在 0.05 以上,这里只是不让"将来有人改了 MIN_ZOOM"
     变成一次静默的整屏错乱 */
  if (!v.scale) return
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

/* 夹进画面范围那一套(含"用户可能从右下往左上拖"的规范化)在 lib/canvasOps.ts,
   那里有单测。名字在这里保持短一点,调用处不必改 */
const clampToImage = clampRectToImage

/** 夹进图像范围内。套索的点在收进来时就夹好 ——
 *  手可以划出画布,但记录下来的形状不该超出边界 */
function clampPoint(p: Point): Point {
  return { x: clamp(p.x, 0, imgW.value), y: clamp(p.y, 0, imgH.value) }
}

/** 舞台坐标 → 图像坐标 */
function toImage(clientX: number, clientY: number) {
  const s = stageEl.value
  if (!s) return { x: 0, y: 0 }
  const box = s.getBoundingClientRect()
  // 同上:比例为 0 时不该得到 Infinity 的坐标,退回 1:1
  const k = view.value.scale || 1
  return {
    x: (clientX - box.left - view.value.x) / k,
    y: (clientY - box.top - view.value.y) / k
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

/** 收掉围不出面积的套索(少于三个点):一次误触、一条直线。
 *  点本身在收进来时已经夹过边界了,这里不用再夹一遍 */
function dropDegenerateLasso() {
  if ((lassoPath.value?.length ?? 0) < 3) lassoPath.value = null
}

function onPointerDown(e: PointerEvent) {
  if (loading.value || !base) return
  const s = stageEl.value
  if (!s) return
  /* 指针已经失效时按规范会抛 NotFoundError,而这一抛会把后面整套落笔状态
     一起丢掉。抓不到捕获不影响继续画,吞掉就好 */
  try {
    s.setPointerCapture(e.pointerId)
  } catch {
    /* ignore */
  }
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
  if (pointers.size === 2) {
    /* 第二指落下 = 用户要缩放,不是接着画。手上那一笔套索就地收掉 ——
       否则会留下一条两点直线选区:收尾的判断在 onPointerUp,
       而那里 drag 已经被清空,认不出刚才画的是套索 */
    dropDegenerateLasso()
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
  pointers.delete(e.pointerId)
  /* 手指数一变,双指缩放的基准就过期了:三指减到两指、或抬起一指再按下另一指,
     距离与中点已经换了人 —— 不重取基准,下一个 move 会拿"新人"去比"旧人",
     画面直接跳一下。还剩两指以上就按当前这两个重取 */
  if (pointers.size >= 2) startPinch()
  else pinch = null
  drag = null
  const r = cropRect.value
  // 点一下(而不是拖)会在原地留下一个零尺寸的框,那种误触直接丢掉
  if (r && (r.w < MIN_CROP || r.h < MIN_CROP)) cropRect.value = null
  dropDegenerateLasso()
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
  /* 入栈与"作废旧重做链"的规矩在引擎里(见 canvasOps 的 pushOp);
     作废掉的那些 AI 步骤各自带着一张全尺寸位图,得由这里显式放掉 ——
     等 GC 不如自己 close(与 resetAll 同一处理) */
  const { next, dropped } = pushOntoStacks({ ops: ops.value, redo: redoOps.value }, op)
  for (const o of dropped) {
    if (o.k === 'ai') o.bitmap.close()
  }
  ops.value = next.ops
  redoOps.value = next.redo
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
  pushOp({ k: 'crop', rect: roundRect(r) })
}

/* 下面三个都会改写操作序列,所以同样受 AI 那一步的在途锁约束:
   它算的是发起那一刻的画面,撤掉或跳走之后结果再落回来,
   序列与实际像素就对不上了。pushOp 那道锁拦的是"新动作",拦不住这几个。
   界面上它们会一起变灰(见步骤条那三个 .sbtn) */
function undo() {
  if (job.value) return
  const next = undoOp({ ops: ops.value, redo: redoOps.value })
  if (next === undefined || next.ops === ops.value) return
  ops.value = next.ops
  redoOps.value = next.redo
  rebuild()
}

function redo() {
  if (job.value) return
  const before = redoOps.value
  const next = redoOp({ ops: ops.value, redo: redoOps.value })
  // 没得重做时引擎原样返回(同一个引用),据此省掉一次重放
  if (next.redo === before) return
  ops.value = next.ops
  redoOps.value = next.redo
  rebuild()
}

/** 跳到某一步(步骤条上点了一张)。
 *  比连按撤销快,而且只重放一次 —— 中间那些帧根本不必画出来。
 *  复位也走这里,所以在途锁对它同样生效 */
function goStep(i: number) {
  if (job.value) return
  const before = ops.value
  /* 两个栈怎么对接(往回退的几步按什么顺序进重做栈)在引擎里,
     那里有单测;这里只管"在途时不许跳"与重放 */
  const next = goToStep({ ops: ops.value, redo: redoOps.value }, i)
  if (next.ops === before) return
  ops.value = next.ops
  redoOps.value = next.redo
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

/* 画布 → data URL,但把编码那一段让出去。
 *
 *  toDataURL 是全同步的:一张 3840px 的 PNG 编码能把主线程按住几百毫秒,
 *  这段时间里占位、进度条都动不了(正是 nextPaint 想避开的那件事)。
 *  toBlob 把编码交给浏览器,再由 FileReader 读成 data URL —— 那一步也是异步的。
 *  接口那边要的仍然是 data URL(见 types.ts 的 EditParams),最后一程不变 */
function canvasDataUrl(c: HTMLCanvasElement): Promise<string> {
  return new Promise((resolve, reject) => {
    c.toBlob((b) => {
      if (!b) {
        reject(new Error('Could not encode the image'))
        return
      }
      blobToDataURL(b).then(resolve, reject)
    }, 'image/png')
  })
}

/* —— 编辑载荷收窄 ——
   原图与 mask 是整幅位图,而这条请求是 JSON + data URL(base64 再放大三分之一)。
   实测一张 3840×2160 的照片编成 PNG 之后是 27.8MB,直接超过服务端 15MB 的
   请求体上限 —— 也就是说"在 4K 图上做局部编辑"过去必然失败。
   而厂商的编辑结果本身有上限(gpt-image-1 最大 1536,本站给的档位最大 2560),
   送更大的进去换不到更大的结果。所以这里按上限收窄,再按内容挑格式。 */
async function encodeAt(c: HTMLCanvasElement, scale: number): Promise<string> {
  const t = scale >= 1 ? c : newCanvas(c.width * scale, c.height * scale)
  if (t !== c) {
    const ctx = t.getContext('2d')
    if (ctx) {
      ctx.imageSmoothingQuality = 'high'
      ctx.drawImage(c, 0, 0, t.width, t.height)
    }
  }
  /* 带透明的只能走 PNG —— JPEG 会把透明压成黑块(与存图、参考图那两处同一个坑)。
     不透明的走 JPEG:实测同一张 2560 的照片,PNG 要 12.4MB,JPEG 只要 2.7MB。
     反过来的情形也存在(截图类 PNG 只要 0.02MB 而 JPEG 要 1.1MB),但 1.1MB
     离预算还远,不值得为它多编一次再比大小 */
  const alpha = hasAlpha(t)
  /* **不要用 toDataURL**:它是全同步的。实测 2560×1440 的 JPEG 要 34ms、
     PNG 要 102ms,全压在"点了按钮之后"那一下上 —— 60fps 下一帧只有 16.7ms,
     也就是用户会看到明显的卡住。toBlob 把编码交给浏览器(实测主线程只占 2.2ms),
     再由 FileReader 读成 data URL,产出的字节与 toDataURL 完全一致(已核对) */
  const blob = await toBlob(t, alpha ? 'image/png' : 'image/jpeg')
  if (!blob) throw new Error('Could not encode the image')
  return blobToDataURL(blob)
}

/** 把一张已经是 data URL 的图按同一比例缩一次(mask 由各自的生成器按整幅画布
 *  产出,这里统一收窄 —— 改那三个生成器不如在这一处收口)。
 *  mask 永远编回 PNG:它是硬边形状,有损编码会把边缘糊掉,而它本来就不大 */
async function scaleDataUrl(url: string, scale: number): Promise<string> {
  if (scale >= 1) return url
  const bmp = await createImageBitmap(await (await fetch(url)).blob())
  const t = newCanvas(
    Math.max(1, Math.round(bmp.width * scale)),
    Math.max(1, Math.round(bmp.height * scale))
  )
  const ctx = t.getContext('2d')
  if (ctx) {
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(bmp, 0, 0, t.width, t.height)
  }
  bmp.close()
  // 同样走异步那条:mask 多是平色(实测 2560 的 PNG 只有几十 KB),但没理由再留一处同步编码
  const blob = await toBlob(t, 'image/png')
  return blob ? blobToDataURL(blob) : url
}

/** 这一次编辑要送出去的两张图。**必须同一个缩放系数** ——
 *  尺寸对不上上游会直接判参数错误,所以系数只能算一次、两张图共用。
 *  超预算时再退一档重编(带透明的大图才可能走到,普通照片第一轮就进预算)。
 *
 *  送的是**当前画面**而不是原图:用户是在"已经裁过、转过"的画面上动的手,
 *  送原图等于让他白改一遍 */
async function editPayload(frame: { width: number; height: number }, maskOf: () => Promise<string>) {
  const c = base
  if (!c) throw new Error('There is nothing on the canvas to edit')
  let scale = payloadScaleFor(frame.width, frame.height)
  for (;;) {
    const image = await encodeAt(c, scale)
    const mask = await scaleDataUrl(await maskOf(), scale)
    if (!payloadOverBudget([image, mask])) return { image, mask }
    const next = shrinkScaleFor(scale)
    /* 缩到下限还是超预算:发出去让服务端明确拒绝(服务端会把 413 翻成人话),
       总比在本地下再缩一次、把用户的图糊掉强 */
    if (next === null) return { image, mask }
    scale = next
  }
}

/* 全透明 mask 的缓存。它是"整幅都要重做"那一类的输入(去背景、换背景),
   与画面内容无关 —— 尺寸一样就是同一份字节,不必每点一次都重新编一张全尺寸的图 */
let maskCache: { key: string; url: string } | null = null

/** 整幅都重做的 mask:一张全透明、尺寸与原图一致的 PNG。
 *  去背景用这种 —— 它没有"要保留"的部分,主体在哪由模型自己认 */
function fullMask(): Promise<string> {
  const c = base
  if (!c) return Promise.reject(new Error('There is nothing on the canvas to edit'))
  const key = `${c.width}x${c.height}`
  if (maskCache?.key === key) return Promise.resolve(maskCache.url)
  // 什么都不画就是全透明,别多此一举地先铺一层再擦掉
  return canvasDataUrl(newCanvas(c.width, c.height)).then((url) => {
    maskCache = { key, url }
    return url
  })
}

/** 把上游回来的那张对回画布原来的画幅。
 *
 *  请求那边已经按原尺寸去要了(见 api.ts 的 allowedSizeFor),但上游听不听话不由我们 ——
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
  sub: string,
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
  job.value = { kind, label, sub }
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
    pushOp({ k: 'ai', label, sub, bitmap: bmp }, true)
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
function runEdit(
  mode: EditMode,
  label: string,
  sub: string,
  maskOf: () => Promise<string>,
  prompt?: string
) {
  return runJob(mode, label, sub, async (frame, cfg, signal) => {
    /* 原图与 mask 一起算:两张图互不相干,没必要串成一条。
       两者都是"这一刻的画面",所以都等到让帧之后才取(见 runJob)。
       收窄与格式选择都在 editPayload 里,两张图共用同一个缩放系数 */
    const { image, mask } = await editPayload(frame, maskOf)
    return editImage(
      { image, mask, mode, prompt, size: `${frame.width}x${frame.height}` },
      cfg,
      signal
    )
  })
}

/** 照这张再画一张。参考图就是画布现在这张,不用挑 —— 挑的是"画成什么样" */
async function runGenerate(prompt: string) {
  await runJob('create', 'New picture', shortLabel(prompt), async (frame, cfg, signal) => {
    const ref = await refShot()
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
  runEdit('remove-bg', 'Background removed', 'Left transparent', fullMask)
}

/** 套索那块变成 mask。与 fullMask 只差形状:一个整幅透明,一个按路径挖空。
 *
 *  先铺满不透明黑(=整幅都保留),再用 destination-out 把选区的透明度擦成 0 ——
 *  mask 里透明才是"要改",所以这里要的是"挖掉",不是"填上" */
function lassoMask(): Promise<string> {
  const c = base
  const path = lassoPath.value
  if (!c || !path || path.length < 3)
    return Promise.reject(new Error('There is no selection to edit'))
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
  return canvasDataUrl(m)
}

/** 清掉套索圈住的那块内容。它和去背景走同一条路,
 *  差别只在送上去的区域是"这一块"而不是"整幅" */
function eraseSelection() {
  runEdit('erase', 'Erased', 'The lassoed area', lassoMask)
}

/** 橡皮抹过的那几片变成 mask。与套索同一套规矩(黑底 + 挖空),
 *  只是形状由描边决定:圆头圆角,粗细就是笔头直径 */
function eraserMask(): Promise<string> {
  const c = base
  const list = strokes.value
  if (!c || !list.length)
    return Promise.reject(new Error('There is nothing painted to erase'))
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
  return canvasDataUrl(m)
}

/** 清掉橡皮抹过的那几片。它和套索的消除是同一步,只是形状从描边来 */
function erasePainted() {
  runEdit('erase', 'Erased', 'The painted area', eraserMask)
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
 *  截一段够认出来就行;完整的那句照原样送上去。
 *  上限做成参数:步骤条上那行副题比悬停气泡窄得多 */
function shortLabel(text: string, max = 48): string {
  const t = text.trim()
  return t.length > max ? `${t.slice(0, max)}…` : t
}

/** 局部重绘:把套索圈住的那块交给模型,照着这句话重做。
 *  与去背景、消除是同一条路 —— 差别只在 mask 从哪来、指令从哪来 */
function regenSelection() {
  const p = regenText.value.trim()
  if (!p) return
  runEdit('regen', 'Reimagined', shortLabel(p, 30), lassoMask, p)
}

/** 换背景:整幅交给模型,换成用户说的那个。
 *  mask 与去背景一模一样(整幅透明)—— 差别只在服务端挑的指令 */
function replaceBackground() {
  const p = bgText.value.trim()
  if (!p) return
  runEdit('replace-bg', 'New background', shortLabel(p, 30), fullMask, p)
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

/** 换背景那块面板。它没有选区可依附,所以按整幅的位置摆(见 .cv-assist) */
async function openBg() {
  closeComposers()
  bgOpen.value = true
  await nextTick()
  assistEl.value?.focus()
}

function closeBg() {
  bgOpen.value = false
  bgText.value = ''
}

/** 照这张再创作的那块面板。与换背景共用外壳,靠 closeComposers 互斥 */
async function openGen() {
  closeComposers()
  genOpen.value = true
  await nextTick()
  assistEl.value?.focus()
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
     等 GC 不如显式 close(与 replayAll 里"用完就清空画布"同一个理由) */
  for (const op of [...ops.value, ...redoOps.value]) {
    if (op.k === 'ai') op.bitmap.close()
  }
  ops.value = []
  redoOps.value = []
  steps.value = []
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
  savedRev.value = ''
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
    /* 走同一条路:它顺手把"原图"那一格也备好了 ——
       ops 这时是空的,这一趟就是原图那一帧,不必再单跑一次 */
    const first = replayAll()
    if (!first) return
    base = first
    imgW.value = base.width
    imgH.value = base.height
    /* 笔头一开始给短边的 6%:一张 4000px 的图和一张 400px 的图上,
       "看着差不多大"才是合理的默认 —— 写死一个像素值必然有一头不好用 */
    eraserSize.value = Math.round(clamp(Math.min(base.width, base.height) * 0.06, 12, 400))
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

/* 参考图的长边上限。与首页那条参考图、角色识图共用同一个常量 ——
   它们进的是同一类请求,各写一份只会在改了其中一处时悄悄不一致 */
const REF_EDGE = REF_IMAGE_EDGE

/** 当前画面,缩成一张能当参考图送上去的 data URL。没有图时给 null。
 *
 *  缩在这一侧做,而不是把整幅原图转成 data URL 再交给谁去缩:
 *  一张 4000px 的图那样一转就是十几 MB 的字符串,中间还要解码一次,
 *  而那几百毫秒正好压在"占位已经画出来、请求还没发"的那一帧上。
 *  这里手上就有像素,直接画进小画布最省。
 *
 *  透明的那张不能走 JPEG —— 那会把透明压成黑块(与存图那条同一个坑),
 *  送去当参考的图会顶着黑底。有透明就用 PNG,它本来也不大 */
async function refShot(): Promise<string | null> {
  const c = base
  if (!c) return null
  const scale = Math.min(1, REF_EDGE / Math.max(c.width, c.height))
  const t = newCanvas(c.width * scale, c.height * scale)
  const ctx = t.getContext('2d')
  if (ctx) {
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(c, 0, 0, t.width, t.height)
  }
  // 探的是刚缩好的这张:它最多 REF_IMAGE_EDGE,比拿 4000px 的原图去探准得多
  const blob = await toBlob(t, hasAlpha(t) ? 'image/png' : 'image/jpeg')
  return blob ? blobToDataURL(blob) : null
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
/** 焦点是不是落在一个自己消化空格的控件上。
 *  拦空格是为了"按住空格拖动画布",但按钮的激活恰恰发生在 keyup 的空格上 ——
 *  keydown 一 preventDefault,整页的按钮就都按不动了(Enter 仍然可以)。
 *  所以按钮上的空格必须让过去 */
function ownsSpace(e: KeyboardEvent) {
  const t = e.target as HTMLElement | null
  return !!t?.closest('button, a[href], [role="button"], [contenteditable="true"]')
}

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
  /* 焦点在输入控件里时,下面这些全部让路:空格要能打出来,字母是打字,
     不该顺手把工具换掉。指令框自己 stop 了事件,这里再兜一道 ——
     免得以后在这页加个输入框又把同一件事重踩一次 */
  const target = e.target as HTMLElement | null
  if (
    target &&
    (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
  ) {
    return
  }
  /* 带 ⌘/Ctrl 的组合键交给浏览器:⌘C / ⌘V / ⌘L / ⌘E 都是系统自己的,
     不能因为字母恰好是 c / v / l / e 就把工具切走(z 那条已经单独处理过) */
  if (mod) return
  if (e.code === 'Space' && !spaceDown.value && !ownsSpace(e)) {
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
/* 按住空格切走窗口时,keyup 会落到别的窗口上 —— 回来后画布会一直"粘"在
   临时平移态。失焦就把它松开 */
function onBlur() {
  spaceDown.value = false
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
  window.removeEventListener('blur', onBlur)
  if (frame) cancelAnimationFrame(frame)
  window.clearTimeout(tipTimer)
  window.clearTimeout(stopTimer)
  // 这一页要走了,在途的那次编辑再落地也没有意义
  editAbort?.abort()
  source?.close()
  /* 操作序列里那几步 AI 位图、以及最后那张画布,同样是全尺寸的图像资源:
     整页卸载时一并放掉,不必等 GC —— 与 resetAll 走同一套 */
  for (const op of [...ops.value, ...redoOps.value]) {
    if (op.k === 'ai') op.bitmap.close()
  }
  if (base) {
    base.width = 0
    base.height = 0
  }
})

// 键盘是全局的,挂载即生效;active 在回调里判断
window.addEventListener('keydown', onKeyDown)
window.addEventListener('keyup', onKeyUp)
window.addEventListener('blur', onBlur)

/* 与引擎里那份是同一个函数:只在组件内部用,名字短一点、十几处调用不必改 */
const clamp = clampNum
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
        :class="{ 'has-assist': assistOpen }"
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
          <!-- 操作键都排在这一段里:上面是常用的两组,低频那几组折在它下面。
               放不下时滚的是这一段 -->
          <div class="rail-scroll">
            <!-- 常驻那一列。键上带名字,不再只靠图标 ——
                 前四个基础工具还好猜,但"套索"和"照着这张再画一张"之间,
                 图标是猜不出差别的。名字与快捷键仍然都挂在悬停提示里,
                 而提示留着是为了那个快捷键,不是为了名字 -->
            <div class="rail-col">
              <!-- AI 的那一组:凡是最后会走到模型那一步的,都收在这里。
                   前两颗是"先圈出要动的地方"(套索、橡皮)—— 它们自己不调接口,
                   但圈出来就是为了紧跟着按下 Erase / Reimagine,算同一条路,
                   所以摆在这一组的最前头。后三颗是整幅交给它。
                   全站只有这一组是彩色图标,而组标题要说的正是
                    "这条线为什么圈在这里"—— 那句话光靠图标颜色说不出来。
                   它也是唯一"要等上游"的一组:在途的那一颗会亮起来(见 .is-busy),
                   但图标与名字一个字都不换 —— 键说的是"它是什么",
                   认脸的东西在忙的时候改掉,下次找它就得多想一步 -->
              <div class="rail-grp rail-ai">
                <span class="rail-eyebrow">AI</span>
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
                  <span class="tool-name">Lasso</span>
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
                  <span class="tool-name">Eraser</span>
                </button>
                <!-- 这三颗在途时不换脸:键上的图标与名字说的是"它是什么",
                     在那一刻把它变成别的东西,下次要找它就认不出来了。
                     在途只补两层状态(见 .tool.is-busy):淡底 + 一圈呼吸的金光。
                     键本身在跑的时候是禁用的,所以也点不出第二下 ——
                     要停,去步骤条上那一格(它就在画面下沿、写着这次在算什么),
                     或者在右侧面板里按 Stop -->
                <button
                  class="tool tip-right"
                  :class="{ 'is-busy': job?.kind === 'remove-bg' }"
                  :disabled="locked"
                  data-tip="Remove background"
                  aria-label="Remove background"
                  @click="removeBackground"
                >
                  <PhCheckerboard aria-hidden="true" />
                  <!-- 名字只留动词,宾语交给图标(透明棋盘格)与悬停说明。
                       一行一个词的竖栏才扫得动 —— 完整说法都在 data-tip 里 -->
                  <span class="tool-name">Remove</span>
                </button>
                <button
                  class="tool tip-right"
                  :class="{ on: bgOpen, 'is-busy': job?.kind === 'replace-bg' }"
                  :disabled="locked"
                  :aria-expanded="bgOpen"
                  data-tip="Replace background"
                  aria-label="Replace background"
                  @click="bgOpen ? closeBg() : openBg()"
                >
                  <PhMountains aria-hidden="true" />
                  <span class="tool-name">Replace</span>
                </button>
                <button
                  class="tool tip-right"
                  :class="{ on: genOpen, 'is-busy': job?.kind === 'create' }"
                  :disabled="locked"
                  :aria-expanded="genOpen"
                  data-tip="Create from this picture"
                  aria-label="Create a new picture from this one"
                  @click="genOpen ? closeGen() : openGen()"
                >
                  <PhMagicWand aria-hidden="true" />
                  <span class="tool-name">Create</span>
                </button>
              </div>

              <span class="rail-sep" aria-hidden="true"></span>

              <!-- 基础的一组:怎么把图弄进来,以及不经过模型的那两个改法
                   (平移、裁剪),再加上这张图怎么走、怎么存。
                   与上面那组的分界线是"会不会走到模型":
                   这里的每一下都是当场算出来的,不等谁 ——
                   而这个区别靠组标题说了出来,只给图标上色的话,
                   用户看到的只是"这几个图标怎么是彩的"。
                   存过之后画面没再动,保存键就是灰的 ——
                   它同时回答了"现在有没有东西可存" -->
              <div class="rail-grp">
                <span class="rail-eyebrow">Picture</span>
                <button
                  class="tool tip-right"
                  data-tip="Upload a picture"
                  aria-label="Upload a picture"
                  @click="pickFile"
                >
                  <PhUploadSimple aria-hidden="true" />
                  <span class="tool-name">Upload</span>
                </button>
                <button
                  class="tool tip-right"
                  :disabled="!canSave"
                  :data-tip="rev === savedRev ? 'Saved' : 'Save as new'"
                  aria-label="Save as new"
                  @click="save"
                >
                  <PhFloppyDisk aria-hidden="true" />
                  <!-- "存成一条新记录"这层意思收进悬停说明里,
                       键上只留 Save —— 而存过之后它自己变成 Saved 并置灰,
                       所以那层意思在界面上也没丢 -->
                  <span class="tool-name">{{ rev === savedRev ? 'Saved' : 'Save' }}</span>
                </button>
                <button
                  class="tool tip-right"
                  :disabled="!item"
                  data-tip="Take this picture off the canvas"
                  aria-label="Take this picture off the canvas"
                  @click="requestDiscard"
                >
                  <PhX aria-hidden="true" />
                  <span class="tool-name">Discard</span>
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
                  <span class="tool-name">Move</span>
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
                  <span class="tool-name">Crop</span>
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
                  <span class="tool-name">{{ showMore ? 'Less' : 'More' }}</span>
                </button>
              </div>
            </div>

            <!-- 低频的那几组折在它下面:键是带字的,横着展开会顶出这条卡片,
                 所以改成往下长。代价是这条竖栏的高度随展开变 ——
                 那一截由 .rail-scroll 接住,放不下就滚 -->
            <!-- 动词放组标题,行里只留那一维:ROTATE 下面就是 Left / Right ——
                  一行一个词之后,"向左还是向右"这类差别才是一眼可辨的,
                  而"Rotate left / Rotate right"读起来要先在两个"Rotate"里跳一次 -->
            <Transition name="rail-fold">
              <div v-if="showMore" id="cv-more" class="rail-fold">
                <div class="rail-grp">
                  <span class="rail-eyebrow">Rotate</span>
                  <button
                    class="tool tip-right"
                    :disabled="locked"
                    data-tip="Rotate left"
                    aria-label="Rotate left"
                    @click="rotate(-90)"
                  >
                    <PhArrowCounterClockwise aria-hidden="true" />
                    <span class="tool-name">Left</span>
                  </button>
                  <button
                    class="tool tip-right"
                    :disabled="locked"
                    data-tip="Rotate right"
                    aria-label="Rotate right"
                    @click="rotate(90)"
                  >
                    <PhArrowClockwise aria-hidden="true" />
                    <span class="tool-name">Right</span>
                  </button>
                </div>

                <span class="rail-sep" aria-hidden="true"></span>

                <div class="rail-grp">
                  <span class="rail-eyebrow">Flip</span>
                  <button
                    class="tool tip-right"
                    :disabled="locked"
                    data-tip="Flip horizontal"
                    aria-label="Flip horizontal"
                    @click="flip('h')"
                  >
                    <PhFlipHorizontal aria-hidden="true" />
                    <span class="tool-name">Horizontal</span>
                  </button>
                  <button
                    class="tool tip-right"
                    :disabled="locked"
                    data-tip="Flip vertical"
                    aria-label="Flip vertical"
                    @click="flip('v')"
                  >
                    <PhFlipVertical aria-hidden="true" />
                    <span class="tool-name">Vertical</span>
                  </button>
                </div>

                <span class="rail-sep" aria-hidden="true"></span>

                <div class="rail-grp">
                  <span class="rail-eyebrow">Zoom</span>
                  <button
                    class="tool tip-right"
                    :disabled="!item"
                    data-tip="Zoom out"
                    aria-label="Zoom out"
                    @click="zoomStep(1 / 1.25)"
                  >
                    <PhMagnifyingGlassMinus aria-hidden="true" />
                    <span class="tool-name">Out</span>
                  </button>
                  <button
                    class="tool tip-right"
                    :disabled="!item"
                    data-tip="Zoom in"
                    aria-label="Zoom in"
                    @click="zoomStep(1.25)"
                  >
                    <PhMagnifyingGlassPlus aria-hidden="true" />
                    <span class="tool-name">In</span>
                  </button>
                  <button
                    class="tool tip-right"
                    :disabled="!item"
                    data-tip="Fit to view"
                    aria-label="Fit to view"
                    @click="fit"
                  >
                    <PhCornersOut aria-hidden="true" />
                    <span class="tool-name">Fit</span>
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
            <button class="ctx-btn is-cta" :disabled="locked" @click="applyCrop">
              <PhCrop aria-hidden="true" />
              Apply crop
            </button>
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
            <span class="ctx-tag">Selection</span>
            <button class="ctx-btn" @click="lassoPath = null">
              <PhTrash aria-hidden="true" />
              Clear
            </button>
            <button class="ctx-btn" :disabled="locked" @click="eraseSelection">
              <PhEraser aria-hidden="true" />
              Erase
            </button>
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
            v-if="item && tool === 'eraser'"
            class="cv-ctx is-bar"
            role="group"
            aria-label="Eraser"
            @pointerdown.stop
          >
            <span class="ctx-tag">Eraser</span>
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
              <PhEraser aria-hidden="true" />
              Erase
            </button>
          </div>

        </div>

        <!-- —— 助手面板 ——
             换背景与"照这张再画一张"改的都是整幅,没有哪一点可以依附,
             所以它们不该像局部重绘那样贴着"那一块"飘,而要有个固定的落点。
             落在右侧而不是浮在画面上:这两句描述常是一整句话,
             浮在顶上那块条子写起来憋屈,而且它正好压着你正要描述的那张图。

             它把画布挤窄、而不是盖上去 —— 挤窄之后舞台尺寸变了,
             ResizeObserver 会重新取景,于是图始终整幅看得见。
             这也是这两件事里唯一"值得把画布让出去"的时刻:
             用户此刻在写整幅的改法,他要看的就是整幅 -->
        <Transition name="assist">
          <aside
            v-if="assistOpen"
            class="cv-assist"
            :aria-label="assistSpec.label"
            @pointerdown.stop
          >
            <div class="assist-inner">
              <div class="assist-head">
                <!-- 这一块面板自己就是一页的头,所以标题是个真的标题,
                     不是那套 11px 的眉标 —— 眉标是给"一组东西的说明"用的,
                     而它是这张卡唯一的身份 -->
                <h2 class="assist-title">
                  <component :is="assistSpec.icon" class="assist-ico" aria-hidden="true" />
                  {{ assistSpec.label }}
                </h2>
                <button
                  class="assist-x"
                  aria-label="Close"
                  @click="assistSpec.close()"
                >
                  <PhX aria-hidden="true" />
                </button>
              </div>
              <textarea
                ref="assistEl"
                v-model="assistText"
                class="assist-input"
                rows="5"
                :placeholder="assistSpec.placeholder"
                :aria-label="assistSpec.label"
                @keydown.stop="composerKey($event, assistSpec.submit, assistSpec.close)"
              ></textarea>
              <p class="assist-hint">{{ assistSpec.hint }}</p>
              <div class="assist-acts">
                <button class="btn" @click="assistSpec.close()">Cancel</button>
                <!-- 在途时它变成停止键。写的动作已经发出去了,
                     这一下能做的就只剩"把在算的那件停掉" -->
                <button
                  class="btn is-cta"
                  :disabled="!job && (locked || !assistText.trim())"
                  @click="job ? stop() : assistSpec.submit()"
                >
                  {{ job ? 'Stop' : assistSpec.cta }}
                </button>
              </div>
            </div>
          </aside>
        </Transition>

        <!-- 右上角那枚读出:多少像素、什么比例、现在放到多大。
             点它就回到 1:1 —— 缩放按钮进了左栏,这个数字顺手顶上。
             三段各占一格而不是连成一句话:三个数是三件事,
             连排之后那串等宽数字糊在一起,反而谁也读不出来 -->
        <button
          v-if="item && imgW"
          class="cv-status"
          data-tip-side="left"
          data-tip="Zoom to 100%"
          aria-label="Zoom to 100%"
          @click="zoomTo100"
        >
          <span>{{ imgW }} × {{ imgH }}</span>
          <span v-if="ratioLabel" class="status-ratio">{{ ratioLabel }}</span>
          <span class="status-zoom">{{ zoomPct }}%</span>
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
            <template v-for="(s, i) in steps" :key="i">
              <!-- 每一格是"缩略图 + 它干了什么"。只摆缩略图时,
                   走到十几步就认不出哪张是哪张 —— 而这几行字才说得清
                   这一步动的是背景、画幅还是某一小块 -->
              <button
                class="step"
                :class="{ on: i === ops.length, future: i > ops.length }"
                :disabled="!!job"
                :aria-current="i === ops.length ? 'true' : undefined"
                :aria-label="`${s.title} — ${s.sub}`"
                @click="goStep(i)"
              >
                <img :src="s.url" alt="" />
                <span class="step-cap">
                  <span class="step-title">{{ s.title }}</span>
                  <span class="step-sub">{{ s.sub }}</span>
                </span>
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
                <span class="job-box">
                  <PhStop aria-hidden="true" />
                </span>
                <span class="step-cap">
                  <span class="step-title">Working…</span>
                  <span class="step-sub">{{ job.sub }}</span>
                </span>
              </button>
            </template>
          </div>

          <!-- 撤销 / 重做 / 复位挂在这一条上:它们本来就是"在步骤之间前后走",
               和上面这排缩略图说的是同一件事,没必要在左栏另占一格。
               它们只在有步骤时才露面 —— 没动过图的时候本来就是灰的 -->
          <div class="strip-acts">
            <button
              class="sbtn"
              :disabled="!canUndo || !!job"
              data-tip="Undo (⌘Z)"
              aria-label="Undo"
              @click="undo"
            >
              <PhArrowUUpLeft aria-hidden="true" />
            </button>
            <button
              class="sbtn"
              :disabled="!canRedo || !!job"
              data-tip="Redo (⇧⌘Z)"
              aria-label="Redo"
              @click="redo"
            >
              <PhArrowUUpRight aria-hidden="true" />
            </button>
            <button
              class="sbtn"
              :disabled="!canUndo || !!job"
              data-tip="Back to the original"
              aria-label="Back to the original"
              @click="reset"
            >
              <PhArrowCounterClockwise aria-hidden="true" />
            </button>
          </div>
        </div>

        <!-- 工具键的悬停提示。渲染在这一层、不在按钮里面 ——
             左栏内部是滚动容器,跟着按钮走的气泡会被那块裁掉半个 -->
        <Transition name="cv-tip">
          <span
            v-if="railTip.text"
            class="rail-tip"
            :class="{ 'is-left': railTip.side === 'left' }"
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
  /* 助手面板的宽度。一处定义,面板本身与那几个要让位的浮层共用 ——
     写两份的话,改宽度时总会漏掉一个 */
  --assist-w-open: 300px;
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

/* 画布右上角那枚读出:多少像素、什么比例、现在放到多大。
   它是状态而不是操作,所以只占角落、不挡手 —— 点一下回到 1:1。
   放上面是因为下沿归步骤条:步数一多那条会横着铺过来,角落就没了。

   它得做成实心一枚:纯文字飘在角落时,画布的底色会直接透上来,
   数字一落到深色画面上就没了 —— 而这几个数是"我在改哪张图"的唯一交代 */
.cv-status {
  position: absolute;
  top: var(--sp-4);
  /* 面板那一侧让出来:它量的是整块 .cv-body,不让就压到面板头上 */
  right: calc(var(--sp-4) + var(--assist-w));
  z-index: 1;
  display: inline-flex;
  align-items: center;
  gap: 7px;
  height: 30px;
  padding: 0 11px;
  border-radius: 999px;
  background: var(--surface);
  border: 1px solid var(--line);
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.05);
  font-size: var(--fs-xs);
  color: var(--text-2);
  font-variant-numeric: tabular-nums;
  /* right 那一项是给助手面板的:面板一开,这个数就得跟着"让"过去。
     不写它的话胶囊会瞬移 300px,而面板还在一点点铺开 */
  transition: background var(--dur) var(--ease), border-color var(--dur) var(--ease),
    right 320ms var(--ease);
}
/* 格与格之间那个点。写在 CSS 里而不是模板里 ——
   比例那格是可缺的,做成元素的话缺一次就多一个孤零零的点 */
.cv-status > span + span::before {
  content: '·';
  margin-right: 7px;
  color: var(--text-4);
}
/* 比例是算出来的副信息,压一档;缩放是这一下要去做的事,提一档 */
.status-ratio {
  color: var(--text-3);
}
.status-zoom {
  color: var(--text);
  font-weight: 500;
}
.cv-status:hover {
  background: var(--bg-elev);
  border-color: var(--line-strong);
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
  /* 画布底色铺在这一层,而不是铺在 .cv-stage 上。
     舞台与助手面板是并排的两个 flex 子项,宽度还是动画过来的小数 ——
     各自铺自己的底色,接缝处迟早会漏出一条一像素的线。
     提到共同的那一层之后,中间根本没有缝可漏,
     面板铺开就只是"画布变窄",看不出两块东西的相接。
     舞台这一块因此不再自带底色:它就是这层上"可以用来改图"的那一段 */
  background: var(--image-bg);
  /* 助手面板占掉的宽度。那几个绝对定位的浮层(尺寸读出、确认条)
     量的都是整块 .cv-body,面板一开它们就会跑到面板头上去 ——
     所以这个数得让它们看得见。
     不能改用 calc 去读面板自身的宽度:面板收起时它不在文档里 */
  --assist-w: 0px;
}
.cv-body.has-assist {
  --assist-w: var(--assist-w-open);
}
/* 工具条浮在画布左上角。它不占版面 —— 画布从它底下铺过去,
   于是"能改图的地方"始终是整块,而不是被切掉一条的剩余。

   宽度定死:键上现在带名字,宽度由最长的那条标签说了算。
   交给内容去撑的话,展开/收起、切语言都会让整条左右晃一下 */
.cv-rail {
  position: absolute;
  left: var(--sp-4);
  top: var(--sp-4);
  z-index: 2;
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  /* 宽度跟着最长的那条标签走。名字收成一个词之后最长的就剩 "Horizontal"
     (13px 下约 65px),剩下的余量不多。
     下限就在这儿:再窄就得截断,而一条被截断的工具名比没有更难认。
     真要更窄,只能动那两处 —— 标签降成 12px,或者把按键的左右内边距收一档。
       152 = 描边(2)+ 卡片内边距(24)+ 键内边距(20)+ 图标(18)+ 间距(10)+ 标签(78) */
  width: 152px;
  /* 高度封顶,而且不许被内容撑破。真要放不下,滚的是里面那一截。
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
  /* 这一组的图标比别处大一档。渐变的色相跨度要靠面积才看得出来 ——
     18px 的细描边扫过去还是一片灰,而这一组是整页的重点 */
  width: 20px;
  height: 20px;
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
/* 一条例外:灰掉的键不该还亮着渐变。
   要比上面那条更具体才盖得住 */
.rail-ai .tool:disabled svg {
  fill: var(--text-4);
}
/* 这一颗正在跑。它不换成停止键(见模板那条注释),只补两层状态:
   与选中态同一层淡底,再加一圈慢慢呼吸的金光 ——
   金在全站只用来报"机器在动"(见 style.css 的 .halo-breathe)。
   底下那两条 :disabled 得让开:它此刻正是"在跑的那件事"本身,
   灰掉之后渐变一没,这一组唯一的色彩就恰好在最要紧的时候消失了。
   (这三颗从来只当发射键用,不参与工具选中,所以这层淡底不会被误读成"选中了") */
.rail-ai .tool.is-busy,
.rail-ai .tool.is-busy:disabled {
  background: var(--accent-soft);
  color: var(--text);
  animation: rail-busy 1.8s ease-in-out infinite;
}
.rail-ai .tool.is-busy svg,
.rail-ai .tool.is-busy:disabled svg {
  fill: url(#cv-ai-grad) var(--ai-from);
}
@keyframes rail-busy {
  0%,
  100% {
    box-shadow: 0 0 0 0 transparent;
  }
  50% {
    box-shadow: 0 0 14px -2px color-mix(in oklch, var(--ai-halo) 58%, transparent);
  }
}
/* 动效被关掉之后呼吸会停在某一帧上 —— 可能正好停在最淡的那帧。
   这里直接给最亮那一帧,把"它正在忙"原样留下来 */
@media (prefers-reduced-motion: reduce) {
  .rail-ai .tool.is-busy,
  .rail-ai .tool.is-busy:disabled {
    animation: none;
    box-shadow: 0 0 14px -2px color-mix(in oklch, var(--ai-halo) 58%, transparent);
  }
}
.rail-grp {
  display: flex;
  flex-direction: column;
  /* 4 而不是 8:一组之内这些键是"同一件事的几个选项",挨紧一点才像一簇。
     组与组那道横线两侧仍是 8(见 .rail-col 的 gap),于是"内紧外松" ——
     分组的层次靠这两档差撑起来,不必再加别的装饰 */
  gap: var(--sp-1);
  /* 不许被压缩:卡片限高时该滚动,而不是把每个键挤扁 */
  flex: none;
}
/* 组标题。它回答的是"下面这几颗为什么是一组" ——
   字形与全站其它小标题同源(见 .ctx-eyebrow):全大写 + 字距。
   左右内边距与键取齐,标题才会和它管着的那些字落在同一条竖线上。
   多给 2px 下边距:4px 的组内间距对"标题 → 内容"这层关系来说太挤了 */
.rail-eyebrow {
  margin-bottom: 2px;
  padding: 0 10px;
  font-size: var(--fs-micro);
  font-weight: 600;
  letter-spacing: var(--ls-eyebrow);
  text-transform: uppercase;
  /* 比正文里那些眉标深一档:它是这条竖栏里唯一的层级说明,
     压到 --text-4 就等于没有 —— 上一版就是这样,分组等于白分 */
  color: var(--text-3);
}
/* 组与组之间一道横线。铺满整条 ——
   这一列现在是份带字的清单,一道 24px 的短线夹在带字的行之间,
   看着像个没写完的破折号 */
.rail-sep {
  width: 100%;
  height: 1px;
  background: var(--line);
  flex: none;
}
/* 常驻那一截:超过卡片高度时只滚它 */
.rail-scroll {
  display: flex;
  flex-direction: column;
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
  gap: var(--sp-2);
  flex: none;
}

/* 折起来的这几组:键盘上带字,横着展开会顶出卡片,所以改成往下长。
   max-height 只是给过渡用的上下限,不参与实际布局 */
.rail-fold {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  flex: none;
  overflow: hidden;
}
/* 展开:高度与淡入同步走一条曲线 —— 时长错开的话会先亮起来再慢慢长开,像两下。
   给足 340ms,它是"掀开一段清单",快了像闪一下 */
.rail-fold-enter-active {
  transition: max-height 340ms var(--ease), opacity 340ms var(--ease);
}
/* 收起只缩短,不淡出也不位移。三件事一起做的时候,
   高度还没收完内容就已经淡没了,末尾剩一段空收 —— 看着就是"卡了一下"。
   曲线换成先慢后快,让它越收越快、干脆让开 */
.rail-fold-leave-active {
  transition: max-height 200ms cubic-bezier(0.4, 0, 1, 1);
}
.rail-fold-enter-from {
  max-height: 0;
  opacity: 0;
}
.rail-fold-leave-to {
  max-height: 0;
}
.rail-fold-enter-to,
.rail-fold-leave-from {
  /* 比内容(两组七键 + 两枚标题 ≈ 400px)再放宽一点:
     卡在内容高度上,最后一帧会因为差几像素而"刹一下" */
  max-height: 440px;
  opacity: 1;
}

/* 一个工具键:图标 + 名字。名字不是装饰 ——
   "套索"和"照着这张再画一张"之间的差别,图标说不出来。
   选中态只有一层淡底:不勾边,也不做实心 ——
   一圈描边会让这个键看着"被框住",实心块则把白卡片切成两半 */
.tool {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  /* 40 是触控的底线。它比 44 略矮,是因为这一列现在有十来行 */
  height: 40px;
  flex: none;
  padding: 0 10px;
  /* 比卡片(16)小一档:内嵌一层的圆角要跟着内缩,不然两圈弧线会打架 */
  border-radius: 10px;
  color: var(--text-2);
  font-size: var(--fs-sm);
  font-weight: 500;
  /* 全站把 button 的 text-align 重置成了 inherit,这里要的是左对齐 */
  text-align: left;
  transition: background var(--dur) var(--ease), color var(--dur) var(--ease);
}
/* 所有键上的图标走同一条尺寸,而且不许被压扁 ——
   常驻与展开的图标因此落在同一个视觉尺度上 */
.tool svg {
  display: block;
  width: 18px;
  height: 18px;
  flex: none;
}
/* 名字自己收紧:min-width 归零之后,长了才会省略而不是把键撑出去 */
.tool-name {
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
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
/* More 的箭头:朝右是"还能展开",转下来是"现在能收起"。
   转 90 而不是 180:那几组是往下的,箭头也该指着那个方向 */
.cv-caret {
  transition: transform var(--dur) var(--ease);
}
.cv-caret.flip {
  transform: rotate(90deg);
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
/* 反过来贴左缘的那几处(图片那条站在舞台右沿,气泡只能往左让):
   整块按自身宽度左移,三角镜像到右侧,入场那 4px 也从左边来 */
.rail-tip.is-left {
  translate: -100% -50%;
}
.rail-tip.is-left::before {
  right: auto;
  left: 100%;
  border-right-color: transparent;
  border-left-color: var(--cta);
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
.rail-tip.is-left.cv-tip-enter-from,
.rail-tip.is-left.cv-tip-leave-to {
  transform: translateX(4px);
}
.cv-stage {
  position: relative;
  flex: 1;
  min-width: 0;
  /* 顶栏往下这一整块就是编辑区:铺满、不留边、不勾框。
     它是"能改图的地方",不是版面上的一张卡 ——
     画框会让人以为图只能待在框里。
     底色由 .cv-body 铺(见上),这一层不再自带 ——
     旁边那块助手面板要让出来的是"宽度",不是"换一个颜色" */
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

/* —— 助手面板 ——
   换背景与"照这张再画一张"的落点(见 assistOpen 那段注释)。

   两层要分清:外面那一条是"从画布里让出来的空地",里面那张才是面板。
   它不是浮层 —— 这一条是实切走的,画布跟着变窄。
   之所以肯把画布让出去:用户此刻在写整幅的改法,他要看的就是整幅,
   让出一条正好把图完整地留在剩下的地方。

   这一条不另铺底色:画布色铺在 .cv-body 上(见那段注释),它俩本就是一层。
   两种颜色之间会平白多出一条"到此为止"的界线,而这条界线什么也没说明 ——
   同色之后整块看起来还是画布,只是右边落了一张卡。
   卡片因此得自己站住:--surface 加上一圈描边和影,才不会糊进画布里。

   开合用宽度过渡。舞台尺寸会连着变几十帧,而 ResizeObserver 每帧都重新取景,
   于是图是"跟着收"过去的,不是跳一下。卡片宽度写死、由外层裁:
   内容一跟着回流,过渡里就看得到字在挤 */
.cv-assist {
  display: flex;
  flex: none;
  width: var(--assist-w-open);
  padding: var(--sp-4);
  overflow: hidden;
}
.assist-inner {
  display: flex;
  flex-direction: column;
  /* 减去两侧的 16:那一条里只落这张卡,宽就是空地的可用宽 */
  width: calc(var(--assist-w-open) - var(--sp-4) * 2);
  flex: none;
  /* 高度跟内容走,不撑满那一条。撑满之后中间那片输入区会摊成一大片空白,
     一屏上最显眼的就剩"什么都没写" —— 一块比内容大三倍的卡,
     读不出它到底想让你做什么。收成内容高度,它才是一个能一眼看完的东西 */
  align-self: flex-start;
  max-height: 100%;
  padding: var(--sp-4);
  border-radius: var(--r);
  background: var(--surface);
  border: 1px solid var(--line);
  /* 与左栏那条工具条同一套影:画面上浮着的两块东西不该长得像两套。
     底不是纯白而是画布色,所以这一圈影得比那边再托得住一点 ——
     卡要是不浮起来,它就只是画布上另一块浅色 */
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.06), 0 10px 24px -6px rgba(0, 0, 0, 0.16);
  transition: border-color var(--dur) var(--ease), box-shadow var(--dur) var(--ease);
}
/* 光标进去之后整张卡亮起来 —— 与首页那块输入区同一套漫反射柔光
   (见 App 的 .prompt-box:focus-within)。这是这块面板最该有的那个"重点":
   此刻屏幕上唯一在写东西的地方就是它 */
.assist-inner:focus-within {
  border-color: color-mix(in oklch, var(--accent) 34%, var(--line));
  box-shadow:
    0 1px 2px rgba(0, 0, 0, 0.06),
    0 10px 24px -6px rgba(0, 0, 0, 0.16),
    0 0 8px -3px color-mix(in oklch, var(--accent) 16%, transparent),
    0 0 20px -6px color-mix(in oklch, var(--accent) 22%, transparent),
    0 0 42px -14px color-mix(in oklch, var(--accent) 26%, transparent);
}
.assist-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--sp-2);
  margin-bottom: var(--sp-4);
}
.assist-title {
  display: flex;
  align-items: center;
  gap: 9px;
  min-width: 0;
  font-size: var(--fs-lg);
  font-weight: 600;
  line-height: 1.25;
  letter-spacing: var(--ls-tight);
  color: var(--text);
}
/* 与打开它的那颗左栏键同一个渐变(见 .rail-ai)。
   20px 是必要的:再小,那道七十度的色相跨度就看不出来了 */
.assist-ico {
  width: 20px;
  height: 20px;
  flex: none;
  fill: url(#cv-ai-grad) var(--ai-from);
}
.assist-x {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  flex: none;
  border-radius: 999px;
  color: var(--text-3);
  transition: background var(--dur) var(--ease), color var(--dur) var(--ease);
}
.assist-x svg {
  width: 16px;
  height: 16px;
}
.assist-x:hover {
  background: var(--bg-elev);
  color: var(--text);
}
/* 输入框无框无底,但不再吃掉中间那一整块 ——
   它的大小由"要写一句话"这件事定,不由屏幕高度定。
   给一圈框只会缩掉能写的地方,所以框还是没有,只是高度改成了定值 */
.assist-input {
  width: 100%;
  min-height: 108px;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--text);
  /* 16px 是硬要求:iOS Safari 聚焦到比它小的框上会把整页放大 */
  font-size: 16px;
  line-height: 1.55;
  font-family: inherit;
  /* 高度本来就跟着面板走,再给个拖拽手柄只会让人以为能拖 */
  resize: none;
}
.assist-input::placeholder {
  color: var(--text-4);
}
.assist-input:focus {
  outline: none;
}
/* 一句"这句话会怎么被用掉"。写在输入框下面而不是上面:
   上面那句该说"要写什么",这一句只负责兜住"要不要把人也写进去"这类误会。
   两者同色同重的话会分不清哪个是提示哪个是正文,所以它压一档 */
.assist-hint {
  margin-top: var(--sp-3);
  font-size: var(--fs-xs);
  line-height: 1.5;
  color: var(--text-3);
}
/* 两个键落在底沿,像一处对话的发送栏 ——
   中间那块输入区就是这一整块面板的主体 */
.assist-acts {
  display: flex;
  justify-content: flex-end;
  gap: var(--sp-2);
  margin-top: var(--sp-4);
}
/* 展开比收起慢:收起是"赶紧腾地方",铺开才是"请进来" */
.assist-enter-active {
  transition: width 320ms var(--ease), opacity 320ms var(--ease);
}
.assist-leave-active {
  transition: width 200ms cubic-bezier(0.4, 0, 1, 1), opacity 200ms var(--ease);
}
.assist-enter-from,
.assist-leave-to {
  width: 0;
  opacity: 0;
}

/* —— 浮在选区旁的上下文条 ——
   贴在选区正上方(放不下就翻到下面),不占版面行高。
   它铺在画面上,所以得靠一层较重的阴影把自己托起来。

   圆角用 --r 而不是胶囊:它装的是"一枚标签 + 几个键",是个盒子,不是一颗键。
   胶囊里再套一层胶囊,内外圆角同心不了 —— 那正是看着毛糙的源头。
   内边距 6 配内圆角 10(16 - 6),两层正好同心 */
.cv-ctx {
  position: absolute;
  z-index: 3;
  display: flex;
  align-items: center;
  gap: var(--sp-1);
  padding: 6px;
  border-radius: var(--r);
  background: var(--surface);
  border: 1px solid var(--line);
  /* 贴边细影 + 一圈弥散:--sh-md 的偏移太大,这么小的盒子会看着"飞起来" */
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.06), 0 12px 32px rgba(0, 0, 0, 0.14);
  white-space: nowrap;
  cursor: default;
  /* 窄屏上让它收着走,别探出舞台 */
  max-width: calc(100% - 16px);
  transition: border-color var(--dur) var(--ease);
}
/* 条首那枚标签("Selection"/"Eraser")。与输入区顶上那行眉标同一套写法 ——
   全站的小标题都长这样,它在这里的职责也一样:说清这一条在管什么。
   它和"键"必须一眼分得开,否则会被读成又一个按钮 */
.ctx-tag,
.ctx-eyebrow {
  font-size: var(--fs-micro);
  font-weight: 600;
  letter-spacing: var(--ls-eyebrow);
  text-transform: uppercase;
  color: var(--text-3);
}
/* 文字键的左右各有 12px 内边距,而标签只从卡片边缘起算 6 —— 补到 12,和键里的字齐平 */
.ctx-tag {
  padding: 0 2px 0 6px;
}

/* 数值读出(裁剪框的宽 × 高)。它是"值"不是"话":不走眉标那套 ——
   大写加字距会把 1024 × 768 拉得七零八落 */
.ctx-size {
  padding: 0 2px 0 6px;
  font-size: var(--fs-xs);
  color: var(--text-2);
  font-variant-numeric: tabular-nums;
}
/* 文字键:卡片里的"菜单项" —— 不描边,靠悬停底色交代可点 */
.ctx-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  height: 32px;
  padding: 0 12px;
  border-radius: 10px;
  color: var(--text);
  font-size: var(--fs-sm);
  font-weight: 500;
  transition: background var(--dur) var(--ease), color var(--dur) var(--ease),
    border-color var(--dur) var(--ease), box-shadow var(--dur) var(--ease),
    transform 120ms var(--ease);
}
.ctx-btn svg {
  width: 15px;
  height: 15px;
}
.ctx-btn:hover:not(:disabled) {
  background: var(--bg-elev);
}

/* 图标键单独立一套:圆形 + 描边,与主输入框那一排(34px 圆键)同一个造型。
   一列里只有图标、没有文字时,不描边它就散在空气里 */
.ctx-btn.is-icon {
  width: 32px;
  padding: 0;
  border: 1px solid var(--line);
  border-radius: 999px;
}
.ctx-btn.is-icon svg {
  width: 16px;
  height: 16px;
}
.ctx-btn.is-icon:hover:not(:disabled) {
  border-color: var(--line-strong);
}
.ctx-btn.is-icon:active:not(:disabled) {
  transform: scale(0.94);
}

/* 主操作:纸色实心。悬停只换底色 —— 叠一层 --bg-elev 会让它变成和素色键一样的东西 */
.ctx-btn.is-cta {
  background: var(--cta);
  color: var(--cta-text);
  border-color: var(--cta);
}
.ctx-btn.is-cta:hover:not(:disabled) {
  background: var(--cta-hover);
  border-color: var(--cta-hover);
}
.ctx-btn.is-icon.is-cta {
  box-shadow: 0 2px 8px color-mix(in oklch, var(--cta) 30%, transparent);
}
.ctx-btn.is-icon.is-cta:hover:not(:disabled) {
  box-shadow: 0 4px 12px color-mix(in oklch, var(--cta) 42%, transparent);
}
.ctx-btn:disabled {
  opacity: 0.38;
  cursor: not-allowed;
  box-shadow: none;
}

/* —— 写指令那一态 ——
   还是那条浮条,换了个形态:从横排换成一块小输入区。
   圆角收成 --r 而不是胶囊 —— 它现在是个面,不是一枚键。
   聚焦时给它一圈与主输入框同源的光晕(见 App 的 .prompt-box:focus-within):
   小卡片缺了这层交代,光标进去之后整块看着是"死的" */
.cv-ctx.is-composer {
  display: block;
  width: 340px;
  padding: 12px;
  border-radius: var(--r);
  white-space: normal;
}
.cv-ctx.is-composer:focus-within {
  border-color: color-mix(in oklch, var(--accent) 34%, var(--line));
  /* 用 outline 而不是 box-shadow:底部那条 is-bar 的影更散更大,
     改 box-shadow 会让它在聚焦那一刻突然变浅 */
  outline: 3px solid color-mix(in oklch, var(--accent) 9%, transparent);
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
/* 动作收在右下角成一组。铺满一行的话,"取消"和"发送"会被三百来像素的空白隔开,
   看着像两个不相干的东西 */
.ctx-acts {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: var(--sp-2);
  margin-top: 10px;
}
/* 取消是次级:降一档颜色,把重量让给主键 */
.ctx-acts .ctx-btn:not(.is-cta) {
  color: var(--text-2);
}
.ctx-acts .ctx-btn:not(.is-cta):hover:not(:disabled) {
  color: var(--text);
}

/* —— 不带选区的那条 ——
   只剩橡皮的工具带了。它作用于整幅、又没有"贴着谁"可言,
   所以挂在舞台顶上居中:左栏在左上角、历史条在左下角,
   这一条正好占中间那道空档。
   (换背景与"照这张再画一张"原来也占这里,现在归了右侧的助手面板) */
.cv-ctx.is-bar {
  top: 16px;
  left: 50%;
  transform: translateX(-50%);
  /* 它比贴选区那种胶囊离图更远,影得再散一点才托得起来 */
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.06), 0 16px 40px rgba(0, 0, 0, 0.18);
}
/* 笔头尺寸夹在两枚圆键中间。定宽 + 等宽数字:数字一跳,那两枚键就跟着左右挪 */
.bar-val {
  min-width: 56px;
  text-align: center;
  font-size: var(--fs-xs);
  color: var(--text-2);
  font-variant-numeric: tabular-nums;
}
/* 竖分隔:同样是"两组活儿",只是这条是横着排的 ——
   用 rail-sep 会画成横线,反倒把一排按键切成上下两半 */
.bar-sep {
  width: 1px;
  height: 20px;
  margin: 0 3px;
  background: var(--line);
}
/* 输入区顶上那行小字。字形与 .ctx-tag 同源(见上),这里只管它和输入框的距离 */
.ctx-eyebrow {
  margin: 0 0 8px;
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
  /* 宽度收着长:右侧留一截,不顶到画布对面。
     助手面板那一侧也要让出来,否则步数一多它就从面板底下钻过去了 */
  max-width: calc(100% - var(--sp-6) - var(--assist-w));
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
   虚框顶着真缩略图那么大、文字摆在同一档,否则它一出现,
   后面那几格会整体窜一下 —— 而那正是"结果快回来了"的一刻,不该抖 */
.step.is-job {
  color: var(--text-3);
}
.job-box {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 44px;
  height: 44px;
  flex: none;
  border: 1px dashed var(--line-strong);
  border-radius: 8px;
  /* 呼吸:一个不动的虚线框看着像"这里坏了",动着才像"正在填" */
  animation: cv-slot 1.6s ease-in-out infinite;
}
.job-box svg {
  width: 18px;
  height: 18px;
}
/* 指着它时就别呼吸了 —— 眼下它是"等着被按",不是"正在填"。
   转成实线红边:停掉意味着这次算的全不要了,是这个动作里唯一的破坏性后果 */
.step.is-job:hover {
  color: var(--danger);
}
.step.is-job:hover .job-box {
  animation: none;
  border-style: solid;
  border-color: var(--danger);
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
  width: 18px;
  height: 18px;
  flex: none;
}
/* 步数多了就横向滚,不换行 —— 换行会把底栏顶高,画布跟着缩。
   间距给到 24:步与步之间那道箭头(见 .step + .step::before)要站在这里 */
.strip-track {
  display: flex;
  align-items: center;
  gap: 24px;
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
/* 一步 = 缩略图 + 它干了什么。图只说得出"改完长什么样",
   说不清动的是背景还是画幅 —— 那两句话就摆在图右手边 */
.step {
  position: relative;
  display: flex;
  align-items: center;
  gap: 9px;
  flex: none;
  padding: 2px 8px 2px 2px;
  border-radius: 10px;
  /* 全站把 button 的 text-align 重置成了 inherit,这里要的是左对齐 */
  text-align: left;
  font: inherit;
  transition: background var(--dur) var(--ease), opacity var(--dur) var(--ease);
}
.step:not(.is-job):hover {
  background: var(--bg-elev);
}
/* AI 那一步在途时整条步骤条冻结(见 undo / goStep 的在途锁):
   跳走会让它的结果落回一个已经不是它发起时的序列上。
   唯一还能点的是旁边那格 Working… —— 它自带停止 */
.step:disabled {
  cursor: default;
  opacity: 0.5;
}
/* 步与步之间那道小箭头。步子挨着排的时候,"先做了什么"是靠左右顺序说的,
   但一条横排里这个顺序并不明显 —— 箭头把它挑明。
   绝对定位:它站在 24px 的间距里,不参与任何一格的实际宽度 */
.step + .step::before {
  content: '';
  position: absolute;
  left: -15px;
  top: 50%;
  width: 6px;
  height: 6px;
  /* 比分隔线深一档:它要说的是"先后",而 --line-strong 在画布色上
     只是两条若有若无的划痕 */
  border-top: 1.5px solid var(--text-4);
  border-right: 1.5px solid var(--text-4);
  transform: translateY(-50%) rotate(45deg);
}
/* 描边画在图上、不画在容器上:紧贴图片的那一圈才说得清"选中的是这张" */
.step img {
  display: block;
  width: 44px;
  height: 44px;
  flex: none;
  border-radius: 8px;
  background: var(--bg-elev);
  box-shadow: 0 0 0 1px var(--line);
  transition: box-shadow var(--dur) var(--ease);
}
/* 两行字。整条要能一眼扫过去,所以宁可省略也不让某一步长出去 ——
   一步拉长半条,后面的就全被推出视野了 */
.step-cap {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
  max-width: 132px;
}
.step-title,
.step-sub {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.step-title {
  font-size: var(--fs-xs);
  font-weight: 500;
  color: var(--text-2);
  transition: color var(--dur) var(--ease);
}
/* 副题原来用 --text-4,在浅色画布上几乎看不见 ——
   一行读不出来的字,等于那一格只有一张缩略图,补文案就白补了。
   它仍然比标题轻一档,但得在"看得清"这一侧 */
.step-sub {
  font-size: var(--fs-micro);
  color: var(--text-3);
}
.step:not(.on):hover img {
  box-shadow: 0 0 0 1px var(--line-strong);
}
.step.on img {
  box-shadow: 0 0 0 2px var(--accent);
}
/* 当前那一步的字提一档:一圈金边说的是"图在这",加粗的是"话也在这" */
.step.on .step-title {
  color: var(--text);
}
/* 已经撤掉、但还回得去的那几步压淡一档:
   留在条上是让人看见"改到哪儿了",但不该和图上正生效的几步抢注意力。
   指到它时又亮回来 —— 那说明用户正在考虑要不要重做这一步 */
.step.future {
  opacity: 0.45;
}
.step.future:hover {
  opacity: 1;
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
  width: 18px;
  height: 18px;
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
/* 壳与 .cv-ctx 同一套(见上):同样的面、同样的描边、同样的影。
   它俩占据的是同一个位置(舞台顶上居中),一个胶囊一个方盒会立刻露馅 */
.cv-ask {
  position: absolute;
  top: var(--sp-4);
  /* 居中要按"画布那一块"算,不是按整条 .cv-body ——
     面板开着的时候,居中的落点是画布的正中 */
  left: calc(50% - var(--assist-w) / 2);
  transform: translateX(-50%);
  z-index: 3;
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  padding: 6px;
  border-radius: var(--r);
  background: var(--surface);
  border: 1px solid var(--line);
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.06), 0 12px 32px rgba(0, 0, 0, 0.14);
  white-space: nowrap;
}
/* 里面的键左右各有 18px 内边距,这行字得跟着往里让一点才不贴边 */
.cv-ask .cv-text {
  padding-left: 6px;
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
  /* 这一页整块是 fixed 的,左下角那条步骤条又钉在它的下沿上。
     而 fixed 的包含块在部分浏览器里比真正看得见的那一块大
     (Android 上地址栏是浮在页面上方的,布局视口不跟着缩),
     照 inset:0 铺满,那条步骤条正好沉到地址栏底下 —— 点不到。
     用 dvh 把高度卡住:它是当前可视高度,与地址栏收放同步。
     高度一写死,bottom:0 就成了多余的那一项,自动让位。 */
  .canvas-page {
    bottom: auto;
    height: 100dvh;
    max-height: 100dvh;
  }
  /* 窄屏:工具条横过来,依旧浮在画布上,只是改成贴着上沿 */
  .cv-rail {
    flex-direction: row;
    align-items: center;
    /* 横过来之后限的是宽度不是高度 */
    width: auto;
    max-height: none;
    padding: var(--sp-1) var(--sp-2);
    /* 八九项横排,极窄的机器上宁可横向滑,也不让它被裁掉 */
    overflow-x: auto;
    /* 左右两条边都钉住 —— 这一条是必须的,不是收边距。
       只写 width:auto 时,这条工具条的宽度由**内容**决定(十几项排下来 568px),
       于是它自己就比屏幕宽,overflow-x:auto 永远没有可滚的余量,
       右边那几枚(Crop / More tools …)直接被 .canvas-page 的 overflow:hidden 裁掉 ——
       手指够不到,也没有任何办法滚过去。
       两边一钉,宽度改由视口定,里面那截才真的滚得起来。
       right 让开助手面板那 300px,与 .cv-status 同一个算法 */
    left: var(--sp-3);
    right: calc(var(--assist-w, 0px) + var(--sp-3));
  }
  /* 横排时名字与组标题一律收掉 —— 一行十几项带字会顶到屏幕外,
     而在手机上这条要的是"一眼看全有哪几个工具",不是把每个都说清。
     名字仍留在 aria-label 里,读屏照样念得出来 */
  .rail-eyebrow,
  .tool-name {
    display: none;
  }
  .rail-grp {
    flex-direction: row;
    align-items: center;
  }
  /* 键回到正方形:横排时宽度交给内容排,不必再撑满 */
  .tool {
    width: 44px;
    height: 44px;
    justify-content: center;
    padding: 0;
  }

  /* 窄屏整条是横的:两列也跟着横过来,接成一条长带 */
  .rail-scroll {
    flex-direction: row;
    align-items: center;
    overflow: visible;
  }
  .rail-col {
    flex-direction: row;
    align-items: center;
  }
  /* 横过来之后短线转成竖的。居中交给 flex 的 align-items,
     不必再像从前那样靠 margin-top 把它硬推到键的中线上 */
  .rail-sep {
    width: 1px;
    height: 24px;
  }
  /* 横过来之后这一组也是横的,展开的是一长串而不是"一段清单" */
  .rail-fold {
    flex-direction: row;
    align-items: center;
  }
  /* 窄屏改回按宽度展开:这两个值要把上面那套 max-height 一并顶掉,
     否则收起时高度也被压着,滑动看起来会卡一下 */
  .rail-fold-enter-active,
  .rail-fold-leave-active {
    transition: max-width 300ms var(--ease), opacity 300ms var(--ease);
  }
  .rail-fold-enter-from,
  .rail-fold-leave-to {
    max-height: none;
    max-width: 0;
  }
  .rail-fold-enter-to,
  .rail-fold-leave-from {
    max-height: none;
    max-width: 420px;
  }
  .cv-strip {
    padding: var(--sp-2) var(--sp-3);
  }
  /* 一步带字要将近 200px 宽,手机上一条只看得见两格 ——
     而步骤条本来就要"一眼看全".所以窄屏只留缩略图 */
  .step-cap {
    display: none;
  }
  .step {
    gap: 0;
    padding: 2px;
  }
  .step img {
    width: 40px;
    height: 40px;
  }
  /* 占位跟着缩略图一起收窄,不然窄屏上它比谁都大一圈 */
  .job-box {
    width: 40px;
    height: 40px;
  }
  /* 窄屏也不改形态:照样是从画布里切走的一条、上面落一张卡。
     换成盖上去的抽屉会丢掉"图始终整幅看得见"这件事,
     而那正是这块面板存在的理由 */
  .cv-assist {
    padding: var(--sp-3);
  }
  .assist-inner {
    width: calc(var(--assist-w-open) - var(--sp-3) * 2);
    padding: var(--sp-3);
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
