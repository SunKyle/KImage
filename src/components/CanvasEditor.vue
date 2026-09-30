<script setup lang="ts">
import { ref, computed, nextTick, onBeforeUnmount, watch } from 'vue'
import {
  PhHand,
  PhCrop,
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
  PhX,
  PhTrash,
  PhUploadSimple
} from '@phosphor-icons/vue'
import { extOf, imageSrc } from '../api'
import type { ResultItem } from '../types'

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
type Op =
  | { k: 'rotate'; deg: number }
  | { k: 'flip'; axis: 'h' | 'v' }
  | { k: 'crop'; rect: Rect }

const props = defineProps<{
  /* 这一页是不是当前显示的那一页。画布常驻挂载(v-show 切换),
     这样切去历史挑张图再切回来,手上的裁剪框还在 —— 它是工作台,不是弹窗 */
  active: boolean
  item: ResultItem | null
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

/* ===== 视图状态 ===== */
const tool = ref<'pan' | 'crop'>('pan')
// 当前图像(已应用全部操作)的像素尺寸。响应式是因为要显示在顶栏
const imgW = ref(0)
const imgH = ref(0)
// view.x/y 是图像左上角在舞台里的 CSS 像素位置(不是图像坐标)
const view = ref({ scale: 1, x: 0, y: 0 })

const loading = ref(true)
const saving = ref(false)
const error = ref('')
// 有未保存的改动时,关掉之前先问一句 —— 转了半天随手按 Esc 就白干最伤人
const confirmDiscard = ref(false)

const stageEl = ref<HTMLElement | null>(null)
const canvasEl = ref<HTMLCanvasElement | null>(null)

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

const canUndo = computed(() => ops.value.length > 0)
const canRedo = computed(() => redoOps.value.length > 0)
const dirty = computed(() => ops.value.length > 0 || !!cropRect.value)
const zoomPct = computed(() => Math.round(view.value.scale * 100))

const MIN_ZOOM = 0.05
const MAX_ZOOM = 8
/* 选区小于这个像素数就当作误触丢弃(图像坐标,不是屏幕坐标) */
const MIN_CROP = 8
/* 画布单边的安全上限。各家浏览器的真上限不一样(桌面很高,iOS 上约 4096,
   而且是按面积算的),但一张手机原片随手就超过 4000。超了不是报错,
   是 drawImage 静默失败 —— 屏幕上一片空白,连原因都看不出来。
   所以进来的图先按这个上限缩一次:丢的是原始分辨率,换的是这张图能编辑 */
const MAX_EDGE = 3840

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

function replay(src: ImageBitmap, list: Op[]): HTMLCanvasElement {
  let cur = newCanvas(src.width, src.height)
  cur.getContext('2d')!.drawImage(src, 0, 0)
  for (const op of list) {
    if (op.k === 'rotate') {
      const deg = ((op.deg % 360) + 360) % 360
      // 90° / 270° 要交换画布宽高,否则转完会被裁掉一条
      const swap = deg === 90 || deg === 270
      const out = newCanvas(swap ? cur.height : cur.width, swap ? cur.width : cur.height)
      const c = out.getContext('2d')!
      c.translate(out.width / 2, out.height / 2)
      c.rotate((deg * Math.PI) / 180)
      c.drawImage(cur, -cur.width / 2, -cur.height / 2)
      cur = out
    } else if (op.k === 'flip') {
      const out = newCanvas(cur.width, cur.height)
      const c = out.getContext('2d')!
      c.translate(op.axis === 'h' ? cur.width : 0, op.axis === 'v' ? cur.height : 0)
      c.scale(op.axis === 'h' ? -1 : 1, op.axis === 'v' ? -1 : 1)
      c.drawImage(cur, 0, 0)
      cur = out
    } else {
      const r = clampToImage(op.rect, cur.width, cur.height)
      const out = newCanvas(r.w, r.h)
      out.getContext('2d')!.drawImage(cur, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h)
      cur = out
    }
  }
  return cur
}

/** 重放一遍并刷新画面。裁剪框属于"还没落地的操作",每次重放都要清掉 */
function rebuild(refit = true) {
  if (!source) return
  base = replay(source, ops.value)
  imgW.value = base.width
  imgH.value = base.height
  cropRect.value = null
  if (refit) fit()
  schedule()
}

/* ===== 视图:适配 / 缩放 / 平移 ===== */
function fit() {
  const s = stageEl.value
  if (!s || !imgW.value || !imgH.value) return
  const pad = 24
  const w = s.clientWidth - pad * 2
  const h = s.clientHeight - pad * 2
  if (w <= 0 || h <= 0) return
  // 小图也允许放大:细看几个像素的时候,把 200px 的图缩在中间是没法用的
  const k = clamp(Math.min(w / imgW.value, h / imgH.value), MIN_ZOOM, MAX_ZOOM)
  view.value = {
    scale: k,
    x: (s.clientWidth - imgW.value * k) / 2,
    y: (s.clientHeight - imgH.value * k) / 2
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
  if (!drag) return

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
  if (pointers.size < 2) pinch = null
  drag = null
  const r = cropRect.value
  // 点一下(而不是拖)会在原地留下一个零尺寸的框,那种误触直接丢掉
  if (r && (r.w < MIN_CROP || r.h < MIN_CROP)) cropRect.value = null
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
function pushOp(op: Op) {
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

/** 复位 = 清空操作序列。不重置视图缩放 —— 那是"换个角度看"的临时状态 */
function reset() {
  if (!ops.value.length && !redoOps.value.length) return
  ops.value = []
  redoOps.value = []
  rebuild()
}

/* ===== 载入 / 保存 ===== */
function resetAll() {
  ops.value = []
  redoOps.value = []
  cropRect.value = null
  error.value = ''
  saving.value = false
  confirmDiscard.value = false
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
    loading.value = false
    // 等舞台量出尺寸再适配,否则第一次 fit 算出来的是 0
    await nextTick()
    if (token !== loadToken) return
    base = replay(bmp, [])
    imgW.value = base.width
    imgH.value = base.height
    fit()
  } catch {
    loading.value = false
    error.value = 'Could not decode this image.'
  }
}

async function save() {
  if (!base || saving.value) return
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
    /* 这里不复位 saving:主界面接过去还要落盘,那段时间里再点一次就会存出两条。
       复位交给关闭时的 resetAll */
    emit('save', { blob, w: c.width, h: c.height })
  } catch {
    error.value = 'Could not encode this image.'
    saving.value = false
  }
}

/** 编码成 Blob。按源图格式走:JPEG 再存成 PNG 会把体积撑大好几倍,
 *  而 PNG(可能带透明)存成 JPEG 会把透明区压成黑块 */
async function encode(c: HTMLCanvasElement): Promise<Blob | null> {
  const ext = extOf(props.item ?? undefined)
  const preferred = ext === 'jpg' ? 'image/jpeg' : ext === 'webp' ? 'image/webp' : 'image/png'
  const first = await toBlob(c, preferred)
  // webp 编码在个别环境里不可用,退回 png —— 丢了点体积,但图一定是完整的
  return first ?? (await toBlob(c, 'image/png'))
}

function toBlob(c: HTMLCanvasElement, type: string): Promise<Blob | null> {
  return new Promise((r) => c.toBlob(r, type, type === 'image/png' ? undefined : 0.92))
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
    // 第一下先撤掉手上那个框,第二下才撤图 —— 免得一按就把整轮编辑丢掉
    if (cropRect.value) {
      cropRect.value = null
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
  else if (e.key === 'Enter' && cropRect.value) applyCrop()
}

function onKeyUp(e: KeyboardEvent) {
  if (e.code === 'Space') spaceDown.value = false
}

/* 换图才重新载入。切走再切回来不动任何状态(见 active 的注释) */
watch(
  () => [props.active, props.item] as const,
  ([isActive]) => {
    if (!isActive) return
    if (!props.item) {
      resetAll()
      loading.value = false
      return
    }
    load()
  },
  { immediate: true }
)

const ro = typeof ResizeObserver !== 'undefined'
  ? new ResizeObserver(() => {
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
      <div class="cv-body">
        <nav class="cv-rail" aria-label="Tools">
          <!-- 换一张图进来。放在最上面、跟下面两组都隔开:
               它是"往画布上放东西",既不是工具模式,也不是编辑历史 -->
          <div class="rail-grp">
            <button
              class="tb tip-right"
              data-tip="Upload a picture from this device"
              aria-label="Upload a picture"
              @click="pickFile"
            >
              <PhUploadSimple aria-hidden="true" />
            </button>
          </div>

          <span class="rail-sep" aria-hidden="true"></span>

          <div class="rail-grp">
            <button
              class="tb tip-right"
              :class="{ on: tool === 'pan' }"
              :disabled="!item"
              :aria-pressed="tool === 'pan'"
              data-tip="Move · zoom (V)"
              aria-label="Move and zoom"
              @click="tool = 'pan'"
            >
              <PhHand aria-hidden="true" />
            </button>
            <button
              class="tb tip-right"
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

          <!-- 编辑历史。跟上面两个工具隔开:那组改的是"看这张图的方式",
               这组改的是图本身 -->
          <div class="rail-grp">
            <button
              class="tb tip-right"
              :disabled="!canUndo"
              data-tip="Undo (⌘Z)"
              aria-label="Undo"
              @click="undo"
            >
              <PhArrowUUpLeft aria-hidden="true" />
            </button>
            <button
              class="tb tip-right"
              :disabled="!canRedo"
              data-tip="Redo (⇧⌘Z)"
              aria-label="Redo"
              @click="redo"
            >
              <PhArrowUUpRight aria-hidden="true" />
            </button>
            <button
              class="tb tip-right"
              :disabled="!canUndo"
              data-tip="Reset all edits"
              aria-label="Reset all edits"
              @click="reset"
            >
              <PhArrowCounterClockwise aria-hidden="true" />
            </button>
          </div>

          <!-- 撤图单独落到最底:它是唯一有破坏性的那个,离手边最常点的位置远点 -->
          <div class="rail-grp rail-end">
            <button
              class="tb tip-right"
              :disabled="!item"
              data-tip="Take this picture off the canvas (Esc)"
              aria-label="Take this picture off the canvas"
              @click="requestDiscard"
            >
              <PhX aria-hidden="true" />
            </button>
          </div>
        </nav>

        <div
          ref="stageEl"
          class="cv-stage"
          :class="item && (tool === 'crop' ? 'is-crop' : 'is-pan')"
          @pointerdown="onPointerDown"
          @pointermove="onPointerMove"
          @pointerup="onPointerUp"
          @pointercancel="onPointerUp"
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
          </template>
        </div>
      </div>

      <!-- 挂着裁剪框时才有的一行:把"这个框接下来怎么办"摆在最显眼处 -->
      <div v-if="cropRect" class="cv-context" role="status">
        <span class="cv-text">
          Selection {{ Math.round(cropRect.w) }} × {{ Math.round(cropRect.h) }}
        </span>
        <button class="ctx-btn" @click="cropRect = null">
          <PhTrash aria-hidden="true" />
          Clear
        </button>
        <button class="ctx-btn is-cta" @click="applyCrop">Apply crop</button>
      </div>

      <!-- 有未保存改动时的确认。就地铺在底栏上方,不用系统 confirm:
           那东西会挡住画面,而这里要让人还能看着图决定 -->
      <div v-if="confirmDiscard" class="cv-confirm" role="alertdialog" aria-label="Discard edits">
        <span class="cv-text">Discard your unsaved edits?</span>
        <button class="btn" @click="confirmDiscard = false">Keep editing</button>
        <button class="btn is-danger" @click="emit('discard')">Discard</button>
      </div>

      <footer class="cv-foot">
        <!-- 这张图的真实像素。原先在顶栏,顶栏撤掉后归到状态条的左端 -->
        <div class="grp">
          <span v-if="imgW" class="cv-dim">{{ imgW }} × {{ imgH }}</span>
        </div>

        <div class="grp">
          <button class="tb" :disabled="!item" data-tip="Rotate left" aria-label="Rotate left" @click="rotate(-90)">
            <PhArrowCounterClockwise aria-hidden="true" />
          </button>
          <button class="tb" :disabled="!item" data-tip="Rotate right" aria-label="Rotate right" @click="rotate(90)">
            <PhArrowClockwise aria-hidden="true" />
          </button>
          <button class="tb" :disabled="!item" data-tip="Flip horizontal" aria-label="Flip horizontal" @click="flip('h')">
            <PhFlipHorizontal aria-hidden="true" />
          </button>
          <button class="tb" :disabled="!item" data-tip="Flip vertical" aria-label="Flip vertical" @click="flip('v')">
            <PhFlipVertical aria-hidden="true" />
          </button>
        </div>

        <div class="grp">
          <button class="tb" :disabled="!item" data-tip="Zoom out" aria-label="Zoom out" @click="zoomStep(1 / 1.25)">
            <PhMagnifyingGlassMinus aria-hidden="true" />
          </button>
          <button class="pct" :disabled="!item" data-tip="Zoom to 100%" aria-label="Zoom to 100%" @click="zoomTo100">
            {{ zoomPct }}%
          </button>
          <button class="tb" :disabled="!item" data-tip="Zoom in" aria-label="Zoom in" @click="zoomStep(1.25)">
            <PhMagnifyingGlassPlus aria-hidden="true" />
          </button>
          <button class="tb" :disabled="!item" data-tip="Fit to view" aria-label="Fit to view" @click="fit">
            <PhCornersOut aria-hidden="true" />
          </button>
        </div>

        <div class="grp grp-end">
          <button class="btn is-cta" :disabled="!item || loading || saving || !!error" @click="save">
            {{ saving ? 'Saving…' : 'Save as new' }}
          </button>
        </div>
      </footer>

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
  /* 画布撑满,下面只留状态条那一条 —— 顶格不再有工具栏 */
  grid-template-rows: 1fr auto;
  /* 工作台用页面底色铺实:背景图那层山水在这里是干扰 */
  background: var(--bg);
  overflow: hidden;
}

/* 上传用的 input。只由按钮代为点击,自己不出现在版面上 */
.cv-file {
  display: none;
}

/* 底栏左端那行像素数 */
.cv-dim {
  font-size: var(--fs-xs);
  color: var(--text-3);
  font-variant-numeric: tabular-nums;
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

/* —— 主体:左工具条 + 舞台 —— */
.cv-body {
  display: flex;
  min-height: 0;
}
/* 竖排工具条:工具一组、编辑历史一组,中间一道分隔;
   撤图被 rail-end 推到最底,不跟常用键挤在一起 */
.cv-rail {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  padding: var(--sp-2);
  border-right: 1px solid var(--line);
}
.rail-grp {
  display: flex;
  flex-direction: column;
  gap: var(--sp-1);
}
/* 分隔线两端留白,不顶到边 */
.rail-sep {
  height: 1px;
  margin: 0 var(--sp-2);
  background: var(--line);
  flex: none;
}
.rail-end {
  margin-top: auto;
}
.cv-stage {
  position: relative;
  flex: 1;
  min-width: 0;
  /* 内凹的底:图片浮在它上面,边界一眼可辨 */
  background: var(--stage-bg);
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
.cv-stage.is-crop {
  cursor: crosshair;
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

/* —— 选区行 / 确认行 ——
   两行都是"上下文操作",共用同一套外观:铺在舞台与底栏之间,不遮画面 */
.cv-context,
.cv-confirm {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  padding: var(--sp-2) var(--sp-3) var(--sp-2) var(--sp-4);
  border-top: 1px solid var(--line);
  background: var(--bg-elev);
}
.cv-text {
  flex: 1;
  min-width: 0;
  font-size: var(--fs-sm);
  color: var(--text-2);
  font-variant-numeric: tabular-nums;
}
.ctx-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 40px;
  padding: 0 14px;
  border: 1px solid var(--line);
  border-radius: var(--r-sm);
  background: var(--surface);
  font-size: var(--fs-sm);
  transition: border-color var(--dur) var(--ease), background var(--dur) var(--ease);
}
.ctx-btn svg {
  width: 16px;
  height: 16px;
}
.ctx-btn:hover {
  border-color: var(--line-strong);
  background: var(--bg-elev);
}
.ctx-btn.is-cta {
  background: var(--cta);
  color: var(--cta-text);
  border-color: var(--cta);
}
.ctx-btn.is-cta:hover {
  background: var(--cta-hover);
  border-color: var(--cta-hover);
}

/* —— 底栏 —— */
.cv-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-3);
  padding: var(--sp-2) var(--sp-3);
  border-top: 1px solid var(--line);
}
.grp {
  display: flex;
  align-items: center;
  gap: var(--sp-1);
}
.grp-end {
  gap: var(--sp-2);
}
.pct {
  height: 40px;
  min-width: 58px;
  padding: 0 8px;
  border-radius: var(--r-sm);
  font-size: var(--fs-sm);
  color: var(--text-2);
  font-variant-numeric: tabular-nums;
  transition: background var(--dur) var(--ease), color var(--dur) var(--ease);
}
.pct:hover:not(:disabled) {
  background: var(--bg-elev);
  color: var(--text);
}
.pct:disabled {
  color: var(--text-4);
  cursor: default;
}

/* 图标按钮:统一 40px 触控目标 */
.tb {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  flex: none;
  border-radius: var(--r-sm);
  color: var(--text-2);
  transition: background var(--dur) var(--ease), color var(--dur) var(--ease);
}
.tb svg {
  width: 19px;
  height: 19px;
}
.tb:hover:not(:disabled) {
  background: var(--bg-elev);
  color: var(--text);
}
/* 选中的工具用墨色实心:与全站"强调 = 墨色"一致 */
.tb.on {
  background: var(--cta);
  color: var(--cta-text);
}
.tb:disabled {
  color: var(--text-4);
  cursor: default;
}
/* 工具条在空态是禁用的,选中那层实心底一并撤掉:
   否则灰字压在墨底上读不出来 */
.tb.on:disabled {
  background: transparent;
}

.btn {
  height: 40px;
  padding: 0 18px;
  border: 1px solid var(--line);
  border-radius: var(--r-sm);
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

/* 窄屏:工具条从竖排改成横排,把宽度还给图片 —— 56px 的竖条在手机上
   占的是真正的作画区域 */
@media (max-width: 720px) {
  .cv-body {
    flex-direction: column;
  }
  .cv-rail {
    flex-direction: row;
    border-right: none;
    border-bottom: 1px solid var(--line);
    /* 六个键横排,极窄的机器上宁可横向滑,也不让它被裁掉 */
    overflow-x: auto;
  }
  .rail-grp {
    flex-direction: row;
  }
  /* 横过来之后分隔线转成竖的,撤图从左下角挪到右端 */
  .rail-sep {
    width: 1px;
    height: auto;
    margin: var(--sp-2) 0;
    align-self: stretch;
  }
  .rail-end {
    margin-top: 0;
    margin-left: auto;
  }
  .cv-foot {
    flex-wrap: wrap;
    justify-content: center;
  }
  .grp-end {
    width: 100%;
    justify-content: flex-end;
  }
  /* 上下文行也换行:文案一行、按钮一行,不然「Selection 1024 × 768」会把按钮挤没 */
  .cv-context,
  .cv-confirm {
    flex-wrap: wrap;
    justify-content: flex-end;
  }
  .cv-text {
    flex: none;
    width: 100%;
  }
}
</style>
