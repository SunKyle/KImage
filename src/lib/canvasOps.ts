/* ===== 画布的操作序列引擎 ==============================================
   自由画布的图像状态不是"层层叠加的结果位图",而是「原始位图 + 操作序列」推导
   出来的。撤销就是把操作弹掉重放一遍 —— 栈天然可逆、内存恒定,而且序列本身
   就是这张图"经历过什么"的完整说明。

   这里只放**不碰像素**的那一半:栈怎么进退、每一步怎么描述、矩形怎么夹进画面。
   真正画像素的 applyOp / replay 留在组件里(它们要 DOM 画布,搬过来也没法测)。
   分出来的收益正是"能测":这些边界(重做链何时作废、跳步时两个栈怎么对接)
   原来只能靠手点画布去试。
   -------------------------------------------------------------------- */

export type CanvasRect = { x: number; y: number; w: number; h: number }
export type CanvasPoint = { x: number; y: number }

/* 几何操作:坐标相对"执行到它那一刻的图像"。按顺序重放必然自洽 ——
   用户是在当时看到的画面上画的裁剪框,重放时看到的也正是同一个画面 */
export type GeometryOp =
  | { k: 'rotate'; deg: number }
  | { k: 'flip'; axis: 'h' | 'v' }
  | { k: 'crop'; rect: CanvasRect }

/**
 * AI 编辑那一步。它与几何操作有个根本差别:后者的结果是算出来的,
 * 而"去掉背景之后长什么样"只有上游知道 —— 所以这一支自己带着结果位图,
 * 重放到它时直接换上,不重算(也就不会二次调用接口)。
 *
 * 位图的类型是泛型:组件里是 `ImageBitmap`,测试里给个字符串就够了 ——
 * 引擎这一层根本不碰像素,只要求它带着"这一步做了什么"的说法。
 */
export interface CanvasAiOp<B = unknown> {
  k: 'ai'
  /** 这一步做了什么,如 'Background removed'。事后从位图上认不出它 */
  label: string
  /** 副题:用户写的那句指令,或者改动幅度 */
  sub: string
  bitmap: B
}

export type CanvasOp<B = unknown> = GeometryOp | CanvasAiOp<B>

/** 一条时间线的两个栈:已执行(ops)与可重做(redo,栈顶在最前) */
export interface OpStacks<O> {
  ops: O[]
  redo: O[]
}

export interface PushResult<O> {
  next: OpStacks<O>
  /**
   * 被这次入栈作废掉的重做链。**调用方要负责释放它们** ——
   * AI 那几步各自带着一张全尺寸位图,等 GC 不如自己 close。
   */
  dropped: O[]
}

/**
 * 新动作入栈。
 *
 * 关键在"新动作走的是新分支":原来的重做链就此作废(这正是编辑器的通行规矩,
 * 也是唯一说得通的一条 —— 重做链描述的是"如果继续沿着刚才那条路走会到哪",
 * 一旦拐了弯,那条路就不再存在)。作废的那些交回给调用方去释放。
 */
export function pushOp<O>(stacks: OpStacks<O>, op: O): PushResult<O> {
  return {
    next: { ops: [...stacks.ops, op], redo: [] },
    dropped: stacks.redo
  }
}

/** 撤销一步:栈顶那一步挪到重做栈的栈顶(重做栈顶 = 下一个会被重做的) */
export function undoOp<O>(stacks: OpStacks<O>): OpStacks<O> {
  if (!stacks.ops.length) return stacks
  const last = stacks.ops[stacks.ops.length - 1]
  return { ops: stacks.ops.slice(0, -1), redo: [last, ...stacks.redo] }
}

/** 重做一步 */
export function redoOp<O>(stacks: OpStacks<O>): OpStacks<O> {
  const [next, ...rest] = stacks.redo
  if (next === undefined) return stacks
  return { ops: [...stacks.ops, next], redo: rest }
}

/**
 * 跳到第 i 步(步骤条上点了一张)。
 *
 * 索引的意思是"时间线上第 i 个位置",范围 0 到 ops.length + redo.length:
 * 0 = 原图,-1(或越界)= 原样不动。比连按撤销快,而且只重放一次 ——
 * 中间那些帧根本不必画出来。
 *
 * 两个方向都要把中间的步骤**按顺序**接到另一个栈上:
 * 往回退时,退掉的那几步是"从第 i 步往后"依次进重做栈(栈顶=最近的那一步);
 * 往前时正好相反。顺序错了,重做就会跳着走。
 */
export function goToStep<O>(stacks: OpStacks<O>, i: number): OpStacks<O> {
  const n = stacks.ops.length
  const total = n + stacks.redo.length
  const to = Math.max(0, Math.min(total, Math.trunc(i)))
  if (to === n) return stacks
  if (to < n) {
    return { ops: stacks.ops.slice(0, to), redo: [...stacks.ops.slice(to), ...stacks.redo] }
  }
  const take = to - n
  return { ops: [...stacks.ops, ...stacks.redo.slice(0, take)], redo: stacks.redo.slice(take) }
}

/** 时间线上现在停在第几步(步骤条高亮 + 复位/撤销按钮的可用状态都看它) */
export function stepIndexOf<O>(stacks: OpStacks<O>): number {
  return stacks.ops.length
}

/** 时间线一共有多少步(含被撤销、仍可重做的那些) */
export function stepCountOf<O>(stacks: OpStacks<O>): number {
  return stacks.ops.length + stacks.redo.length
}

/** 这一步在步骤条上怎么写。w/h 是**重放到这一步之后**的画面尺寸 */
export function describeOp(op: CanvasOp, w: number, h: number): { title: string; sub: string } {
  const size = `${w} × ${h}`
  switch (op.k) {
    case 'rotate':
      return {
        title: 'Rotated',
        sub:
          Math.abs(op.deg) === 180
            ? 'Half turn'
            : op.deg > 0
              ? 'A quarter turn clockwise'
              : 'A quarter turn counter-clockwise'
      }
    case 'flip':
      return { title: 'Flipped', sub: op.axis === 'h' ? 'Left to right' : 'Top to bottom' }
    case 'crop':
      return { title: 'Cropped', sub: size }
    default:
      /* AI 那几步的说法在入栈时就写定了(见组件的 runEdit)——
         事后从位图上认不出它做过什么 */
      return { title: op.label, sub: op.sub || size }
  }
}

/** 一个数夹在 [lo, hi] 之间 */
export function clampNum(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n))
}

/**
 * 把一个矩形夹进画面范围内(裁剪框可以画到画布外面一点)。
 * 先按两个角规范化(用户可能从右下往左上拖,那时 w/h 是负的),
 * 再各自夹一次 —— 于是结果一定是非负且落在画面里的。
 */
export function clampRectToImage(r: CanvasRect, w: number, h: number): CanvasRect {
  const x1 = clampNum(Math.min(r.x, r.x + r.w), 0, w)
  const y1 = clampNum(Math.min(r.y, r.y + r.h), 0, h)
  const x2 = clampNum(Math.max(r.x, r.x + r.w), 0, w)
  const y2 = clampNum(Math.max(r.y, r.y + r.h), 0, h)
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 }
}

/** 取整到整像素:裁剪是像素级操作,留下 0.4 个像素的偏移只会让边缘发灰 */
export function roundRect(r: CanvasRect): CanvasRect {
  return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.w), h: Math.round(r.h) }
}

/** 旋转之后的画面尺寸。90° / 270° 要把宽高换过来,否则转完会被裁掉一条 */
export function rotatedSize(w: number, h: number, deg: number): { w: number; h: number } {
  const d = ((deg % 360) + 360) % 360
  return d === 90 || d === 270 ? { w: h, h: w } : { w, h }
}
