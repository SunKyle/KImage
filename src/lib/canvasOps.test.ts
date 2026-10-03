import { describe, expect, it } from 'vitest'
import {
  clampRectToImage,
  describeOp,
  goToStep,
  pushOp,
  redoOp,
  rotatedSize,
  roundRect,
  stepCountOf,
  stepIndexOf,
  undoOp,
  type OpStacks
} from './canvasOps'

/* 位图一律用字符串冒充:引擎这一层不碰像素,测试里也就不需要真的 ImageBitmap。
   这也顺带说明位图类型参数确实是泛型的 —— 组件里给 ImageBitmap,这里给 string */

describe('pushOp · 入栈与新分支', () => {
  it('追加到末尾', () => {
    const r = pushOp({ ops: ['a'], redo: [] }, 'b')
    expect(r.next.ops).toEqual(['a', 'b'])
  })

  /* 编辑器通行规矩:拐了弯,原来那条重做链就不再存在 */
  it('作废原来的重做链,并把作废的那些交回来(调用方要负责释放位图)', () => {
    const r = pushOp({ ops: ['a'], redo: ['x', 'y'] }, 'b')
    expect(r.next.redo).toEqual([])
    expect(r.dropped).toEqual(['x', 'y'])
  })

  it('没有重做链时 dropped 是空的', () => {
    expect(pushOp({ ops: [], redo: [] }, 'a').dropped).toEqual([])
  })

  it('不改动传入的两个栈', () => {
    const s: OpStacks<string> = { ops: ['a'], redo: ['x'] }
    pushOp(s, 'b')
    expect(s).toEqual({ ops: ['a'], redo: ['x'] })
  })
})

describe('undoOp / redoOp · 一步进退', () => {
  it('撤销:末尾那步挪到重做栈栈顶', () => {
    expect(undoOp({ ops: ['a', 'b'], redo: [] })).toEqual({ ops: ['a'], redo: ['b'] })
  })

  it('撤销时重做栈原有内容排在后面(重做顺序才接得上)', () => {
    expect(undoOp({ ops: ['a', 'b'], redo: ['x'] })).toEqual({ ops: ['a'], redo: ['b', 'x'] })
  })

  it('没得撤销就原样返回(返回同一个引用,调用方可以据此省掉一次重放)', () => {
    const s: OpStacks<string> = { ops: [], redo: ['x'] }
    expect(undoOp(s)).toBe(s)
  })

  it('重做:把重做栈栈顶接回末尾', () => {
    expect(redoOp({ ops: ['a'], redo: ['b', 'x'] })).toEqual({ ops: ['a', 'b'], redo: ['x'] })
  })

  it('没得重做就原样返回', () => {
    const s: OpStacks<string> = { ops: ['a'], redo: [] }
    expect(redoOp(s)).toBe(s)
  })

  it('撤销再重做回到原样', () => {
    const s: OpStacks<string> = { ops: ['a', 'b'], redo: [] }
    expect(redoOp(undoOp(s))).toEqual(s)
  })
})

describe('goToStep · 跳到某一步', () => {
  it('往回:退掉的那几步按顺序进重做栈', () => {
    expect(goToStep({ ops: ['a', 'b', 'c'], redo: [] }, 1)).toEqual({
      ops: ['a'],
      redo: ['b', 'c']
    })
  })

  it('往回时接在原有重做链**前面**(它们比原有那些更近)', () => {
    expect(goToStep({ ops: ['a', 'b', 'c'], redo: ['x'] }, 1)).toEqual({
      ops: ['a'],
      redo: ['b', 'c', 'x']
    })
  })

  it('往前:从重做栈取够数量接回末尾', () => {
    expect(goToStep({ ops: ['a'], redo: ['b', 'c', 'x'] }, 3)).toEqual({
      ops: ['a', 'b', 'c'],
      redo: ['x']
    })
  })

  it('跳到当前所在的那一步:原样返回', () => {
    const s: OpStacks<string> = { ops: ['a', 'b'], redo: ['c'] }
    expect(goToStep(s, 2)).toBe(s)
  })

  it('复位到 0 步:全部进重做栈(所以还能点回来)', () => {
    expect(goToStep({ ops: ['a', 'b'], redo: [] }, 0)).toEqual({ ops: [], redo: ['a', 'b'] })
  })

  it('跳到时间线末尾:重做栈清空', () => {
    expect(goToStep({ ops: ['a'], redo: ['b', 'c'] }, 3)).toEqual({ ops: ['a', 'b', 'c'], redo: [] })
  })

  it('越界与负数都夹回有效范围,不抛异常', () => {
    const s: OpStacks<string> = { ops: ['a', 'b'], redo: ['c'] }
    expect(goToStep(s, -5)).toEqual({ ops: [], redo: ['a', 'b', 'c'] })
    expect(goToStep(s, 99)).toEqual({ ops: ['a', 'b', 'c'], redo: [] })
  })

  it('小数索引向下取整(步骤条给的总是整数,但别让脏值把栈切歪)', () => {
    expect(goToStep({ ops: ['a', 'b', 'c'], redo: [] }, 1.9)).toEqual({
      ops: ['a'],
      redo: ['b', 'c']
    })
  })

  it('在时间线上来回跳,最终位置总是对得上', () => {
    let s: OpStacks<string> = { ops: ['a', 'b', 'c', 'd'], redo: [] }
    for (const i of [0, 2, 4, 1, 3, 4, 0]) {
      s = goToStep(s, i)
      expect(stepIndexOf(s)).toBe(i)
      expect(stepCountOf(s)).toBe(4)
    }
  })

  it('不改动传入的栈', () => {
    const s: OpStacks<string> = { ops: ['a', 'b'], redo: [] }
    goToStep(s, 0)
    expect(s).toEqual({ ops: ['a', 'b'], redo: [] })
  })
})

describe('describeOp · 每一步怎么写', () => {
  it('旋转:半圈与顺/逆时针分开说', () => {
    expect(describeOp({ k: 'rotate', deg: 180 }, 10, 10).sub).toBe('Half turn')
    expect(describeOp({ k: 'rotate', deg: -180 }, 10, 10).sub).toBe('Half turn')
    expect(describeOp({ k: 'rotate', deg: 90 }, 10, 10).sub).toBe('A quarter turn clockwise')
    expect(describeOp({ k: 'rotate', deg: -90 }, 10, 10).sub).toBe(
      'A quarter turn counter-clockwise'
    )
  })

  it('翻转:两个轴向分开说', () => {
    expect(describeOp({ k: 'flip', axis: 'h' }, 1, 1).sub).toBe('Left to right')
    expect(describeOp({ k: 'flip', axis: 'v' }, 1, 1).sub).toBe('Top to bottom')
  })

  it('裁剪:副题写的是重放之后的画面尺寸', () => {
    expect(describeOp({ k: 'crop', rect: { x: 0, y: 0, w: 1, h: 1 } }, 800, 600)).toEqual({
      title: 'Cropped',
      sub: '800 × 600'
    })
  })

  it('AI 那一步用入栈时写定的说法', () => {
    expect(describeOp({ k: 'ai', label: 'Erased', sub: 'The lassoed area', bitmap: 'x' }, 1, 1)).toEqual(
      { title: 'Erased', sub: 'The lassoed area' }
    )
  })

  it('AI 那一步没写副题时退回尺寸', () => {
    expect(describeOp({ k: 'ai', label: 'Erased', sub: '', bitmap: 'x' }, 640, 480).sub).toBe(
      '640 × 480'
    )
  })
})

describe('clampRectToImage · 裁剪框夹进画面', () => {
  it('超出右边/下边的部分被切掉', () => {
    expect(clampRectToImage({ x: 90, y: 90, w: 50, h: 50 }, 100, 100)).toEqual({
      x: 90,
      y: 90,
      w: 10,
      h: 10
    })
  })

  /* 用户完全可以从右下往左上拖,那时 w/h 是负的 —— 先规范化再夹 */
  it('负的宽高被规范化成正的', () => {
    expect(clampRectToImage({ x: 60, y: 60, w: -40, h: -40 }, 100, 100)).toEqual({
      x: 20,
      y: 20,
      w: 40,
      h: 40
    })
  })

  it('完全在画面外时得到零尺寸(而不是负数)', () => {
    const r = clampRectToImage({ x: 200, y: 200, w: 50, h: 50 }, 100, 100)
    expect(r.w).toBe(0)
    expect(r.h).toBe(0)
  })

  it('本来就在画面里就原样返回', () => {
    expect(clampRectToImage({ x: 10, y: 20, w: 30, h: 40 }, 100, 100)).toEqual({
      x: 10,
      y: 20,
      w: 30,
      h: 40
    })
  })
})

describe('roundRect / rotatedSize', () => {
  it('取整到整像素', () => {
    expect(roundRect({ x: 10.4, y: 20.6, w: 30.5, h: 40.2 })).toEqual({ x: 10, y: 21, w: 31, h: 40 })
  })

  it('90° / 270° 交换宽高,180° 与 0° 不换', () => {
    expect(rotatedSize(800, 600, 90)).toEqual({ w: 600, h: 800 })
    expect(rotatedSize(800, 600, 270)).toEqual({ w: 600, h: 800 })
    expect(rotatedSize(800, 600, 180)).toEqual({ w: 800, h: 600 })
    expect(rotatedSize(800, 600, 0)).toEqual({ w: 800, h: 600 })
  })

  it('负数角度先归一到 0~360', () => {
    expect(rotatedSize(800, 600, -90)).toEqual({ w: 600, h: 800 })
    expect(rotatedSize(800, 600, -180)).toEqual({ w: 800, h: 600 })
    expect(rotatedSize(800, 600, 450)).toEqual({ w: 600, h: 800 })
  })
})
