import { describe, expect, it } from 'vitest'
import {
  isDeadConnectionError,
  planPrune,
  retryOnDeadConnection,
  shouldCheckStorage,
  type PruneCandidate
} from './idb'

/* 造一条候选记录。id 用时间戳序号,u 开头便于在断言里看清"
   第几条"—— createdAt 决定清理顺序,所以测试里两者保持一致 */
function rec(
  n: number,
  extra: { collectionId?: string; hasMarked?: boolean } = {}
): PruneCandidate {
  return { id: `e${n}`, createdAt: n, ...extra }
}

describe('planPrune · 该清哪些历史', () => {
  it('空间吃紧时从最旧的开始清,数量恰好是 count', () => {
    const all = [rec(1), rec(2), rec(3), rec(4), rec(5)]
    const { removedIds } = planPrune(all, 2)
    expect(removedIds).toEqual(['e1', 'e2'])
  })

  it('挂在作品集里的记录不参与清理', () => {
    const all = [rec(1), rec(2, { collectionId: 'c1' }), rec(3), rec(4)]
    const { removedIds } = planPrune(all, 2)
    // 第 2 条被保护,于是往后顺延到第 3 条 —— 清的数量仍是 2
    expect(removedIds).toEqual(['e1', 'e3'])
  })

  /* 这一条是本次修复的核心:修复前 .filter 只认 collectionId,
     最早的那条带标记记录会被当"最旧的"清掉 */
  it('含标记图的记录不参与清理,哪怕它是最旧的', () => {
    const all = [rec(1, { hasMarked: true }), rec(2), rec(3), rec(4)]
    const { removedIds } = planPrune(all, 2)
    expect(removedIds).not.toContain('e1')
    expect(removedIds).toEqual(['e2', 'e3'])
  })

  it('作品集与标记同时保护,清理窗口继续往后顺延', () => {
    const all = [
      rec(1, { hasMarked: true }),
      rec(2, { collectionId: 'c1' }),
      rec(3),
      rec(4),
      rec(5)
    ]
    const { removedIds } = planPrune(all, 2)
    expect(removedIds).toEqual(['e3', 'e4'])
  })

  it('keptMarked 只数"本来会被清、因标记而留下"的那些', () => {
    const all = [
      rec(1, { hasMarked: true }),
      rec(2),
      rec(3, { hasMarked: true }),
      rec(4)
    ]
    // count=2:本来会清 e1、e2;其中 e1 靠标记留下来
    expect(planPrune(all, 2).keptMarked).toBe(1)
    // 标记的那条排在很新(count=1 只涉及 e1),没有"多留一命"这回事
    const fresh = [rec(1), rec(2), rec(3, { hasMarked: true })]
    expect(planPrune(fresh, 1).keptMarked).toBe(0)
  })

  it('候选全被保护时,一条都不清(宁可空间吃紧)', () => {
    const all = [rec(1, { hasMarked: true }), rec(2, { collectionId: 'c1' })]
    const { removedIds } = planPrune(all, 2)
    expect(removedIds).toEqual([])
  })

  it('count 为 0 或负数时不清任何东西', () => {
    const all = [rec(1), rec(2)]
    expect(planPrune(all, 0)).toEqual({ removedIds: [], keptMarked: 0 })
    expect(planPrune(all, -3)).toEqual({ removedIds: [], keptMarked: 0 })
  })

  it('要清的比能清的还多时,只清到没有候选为止(不清空历史)', () => {
    const all = [rec(1), rec(2, { hasMarked: true })]
    expect(planPrune(all, 10).removedIds).toEqual(['e1'])
  })

  it('输入顺序不影响结果(内部按时间排)', () => {
    const asc = [rec(1), rec(2), rec(3), rec(4)]
    const shuffled = [rec(3), rec(1), rec(4), rec(2)]
    expect(planPrune(shuffled, 2).removedIds).toEqual(planPrune(asc, 2).removedIds)
  })

  it('不修改传入的数组', () => {
    const all = [rec(3), rec(1), rec(2)]
    const before = all.map((r) => r.id)
    planPrune(all, 1)
    expect(all.map((r) => r.id)).toEqual(before)
  })
})

describe('shouldCheckStorage · 体检节奏', () => {
  it('本会话第一次写入必查', () => {
    expect(shouldCheckStorage(1_000, 0, 0)).toBe(true)
  })

  it('刚查过、又没攒够条数就不查', () => {
    // 距上次 1 秒,才写了 3 条
    expect(shouldCheckStorage(1_000, 0 + 1_000, 3)).toBe(false)
  })

  it('攒够 20 条就提前查(不必等满 30 秒)', () => {
    expect(shouldCheckStorage(1_000, 1_000, 20)).toBe(true)
  })

  it('隔满 30 秒就查(哪怕只写了 1 条)', () => {
    expect(shouldCheckStorage(31_000, 1_000, 1)).toBe(true)
  })

  it('边界:差 1 毫秒不查,正好到点就查', () => {
    expect(shouldCheckStorage(1_000 + 29_999, 1_000, 1)).toBe(false)
    expect(shouldCheckStorage(1_000 + 30_000, 1_000, 1)).toBe(true)
  })

  it('节流参数可覆盖(便于将来按场景调整)', () => {
    expect(shouldCheckStorage(2_000, 1_000, 5, 1_000, 5)).toBe(true)
    expect(shouldCheckStorage(1_500, 1_000, 4, 1_000, 5)).toBe(false)
  })
})

/* ===== A1 缓存连接的健壮性 =====
   把连接改成缓存之后，"连接意外关闭"这条路上必须能自愈 ——
   否则后续每一次读写都打在死连接上，而每一处调用都把失败 catch 成"空"，
   在用户眼里就是"我的东西全没了" */

describe('isDeadConnectionError · 什么算“连接已死”', () => {
  it('认 InvalidStateError（在死连接上建事务时的报法）', () => {
    expect(isDeadConnectionError({ name: 'InvalidStateError' })).toBe(true)
  })

  it('也认 DatabaseClosedError（个别实现的叫法）', () => {
    expect(isDeadConnectionError({ name: 'DatabaseClosedError' })).toBe(true)
  })

  it('别的错误不算 —— 那些重试也没用，重试会把一次失败变成一次挂死', () => {
    for (const name of ['AbortError', 'QuotaExceededError', 'VersionError', 'UnknownError']) {
      expect(isDeadConnectionError({ name }), name).toBe(false)
    }
  })

  it('退化输入不抛异常', () => {
    expect(isDeadConnectionError(null)).toBe(false)
    expect(isDeadConnectionError(undefined)).toBe(false)
    expect(isDeadConnectionError('boom')).toBe(false)
    expect(isDeadConnectionError(new Error('x'))).toBe(false)
  })
})

describe('retryOnDeadConnection · 连接死了就重开一次', () => {
  const dead = () => Object.assign(new Error('dead'), { name: 'InvalidStateError' })
  const fakeDB = (tag: string) => ({ tag }) as unknown as IDBDatabase

  it('一切正常时只取一次连接、只跑一次', async () => {
    let opens = 0
    const res = await retryOnDeadConnection(
      async () => { opens++; return fakeDB('a') },
      () => {},
      (db) => (db as unknown as { tag: string }).tag
    )
    expect(res).toBe('a')
    expect(opens).toBe(1)
  })

  it('连接已死：清缓存、重开、再跑一次并成功', async () => {
    let opens = 0
    let resets = 0
    const res = await retryOnDeadConnection(
      async () => { opens++; return fakeDB(opens === 1 ? 'dead' : 'fresh') },
      () => { resets++ },
      (db) => {
        if ((db as unknown as { tag: string }).tag === 'dead') throw dead()
        return (db as unknown as { tag: string }).tag
      }
    )
    expect(res).toBe('fresh')
    expect(resets).toBe(1)
    expect(opens).toBe(2)
  })

  it('重试仍失败就如实抛出（不无限重试）', async () => {
    let opens = 0
    await expect(
      retryOnDeadConnection(
        async () => { opens++; return fakeDB('dead') },
        () => {},
        () => { throw dead() }
      )
    ).rejects.toThrow('dead')
    expect(opens).toBe(2) // 只重开一次
  })

  it('不是“连接已死”的错误直接抛，不清缓存也不重开', async () => {
    let opens = 0
    let resets = 0
    const boom = Object.assign(new Error('bad data'), { name: 'DataError' })
    await expect(
      retryOnDeadConnection(
        async () => { opens++; return fakeDB('a') },
        () => { resets++ },
        () => { throw boom }
      )
    ).rejects.toThrow('bad data')
    expect(opens).toBe(1)
    expect(resets).toBe(0)
  })

  it('run 返回 promise 时，异步失败同样触发重试', async () => {
    let opens = 0
    const res = await retryOnDeadConnection(
      async () => { opens++; return fakeDB(opens === 1 ? 'dead' : 'fresh') },
      () => {},
      async (db) => {
        if ((db as unknown as { tag: string }).tag === 'dead') throw dead()
        return 'ok'
      }
    )
    expect(res).toBe('ok')
    expect(opens).toBe(2)
  })
})
