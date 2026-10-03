import { describe, expect, it } from 'vitest'
import {
  FREE_SIZES,
  acceptableSize,
  configKindOf,
  defaultSizeFor,
  extraParamsFor,
  mergeHistory,
  normalizeSize,
  pickActiveByKind,
  seedFor,
  sizeClosestTo,
  sizeForVendor,
  shouldProcessNow,
  sizeIsFree,
  sizeOptionsFor,
  thumbsToFill
} from './api'
import type { ApiConfig, HistoryEntry } from './types'

/* 造一条配置。只有 id 与 kind 参与挑选,其余字段给最小值即可 */
function cfg(id: string, kind?: ApiConfig['kind']): ApiConfig {
  return { id, name: id, baseUrl: 'https://example.com/v1', apiKey: 'k', model: 'm', kind }
}

describe('configKindOf · 用途归一', () => {
  it('缺省(加 kind 之前存下来的老配置)按出图算', () => {
    expect(configKindOf(cfg('a'))).toBe('image')
  })

  it('四类原样返回', () => {
    for (const k of ['image', 'text', 'vision', 'tts'] as const) {
      expect(configKindOf(cfg('a', k))).toBe(k)
    }
  })
})

describe('pickActiveByKind · 按用途挑当前生效的那条', () => {
  it('存着的 id 命中且用途一致时,就用它', () => {
    const list = [cfg('a', 'image'), cfg('b', 'image')]
    expect(pickActiveByKind(list, 'image', 'b')?.id).toBe('b')
  })

  it('存着的 id 已不存在时,退到同类第一条', () => {
    const list = [cfg('a', 'image'), cfg('b', 'image')]
    expect(pickActiveByKind(list, 'image', 'gone')?.id).toBe('a')
  })

  it('存着的 id 被改成别的用途后不再命中,退到同类第一条', () => {
    // b 原来是出图配置,用户把它改成了朗读
    const list = [cfg('a', 'image'), cfg('b', 'tts')]
    expect(pickActiveByKind(list, 'image', 'b')?.id).toBe('a')
  })

  /* 这一组是本次修复的核心:原来的谓词写作 `kind !== 'text'`,
     于是只配了朗读配置时,朗读那条会被挑成"当前出图配置" */
  it('出图只认 kind === image,不会把 tts / vision 配置挑进来', () => {
    expect(pickActiveByKind([cfg('a', 'tts')], 'image', 'a')).toBeUndefined()
    expect(pickActiveByKind([cfg('a', 'vision')], 'image', 'a')).toBeUndefined()
    expect(pickActiveByKind([cfg('a', 'text')], 'image', 'a')).toBeUndefined()
    // 混在一起时挑到的是真正的出图那条,而不是排在前面的朗读
    const mixed = [cfg('t', 'tts'), cfg('v', 'vision'), cfg('i', 'image')]
    expect(pickActiveByKind(mixed, 'image', '')?.id).toBe('i')
  })

  it('老配置没有 kind 字段时按出图参与挑选', () => {
    const list = [cfg('legacy'), cfg('t', 'tts')]
    expect(pickActiveByKind(list, 'image', '')?.id).toBe('legacy')
  })

  it('每一类各自挑各自的,互不串台', () => {
    const list = [cfg('i', 'image'), cfg('x', 'text'), cfg('v', 'vision'), cfg('s', 'tts')]
    expect(pickActiveByKind(list, 'image', '')?.id).toBe('i')
    expect(pickActiveByKind(list, 'text', '')?.id).toBe('x')
    expect(pickActiveByKind(list, 'vision', '')?.id).toBe('v')
    expect(pickActiveByKind(list, 'tts', '')?.id).toBe('s')
  })

  it('列表为空、或这一类一条都没有时返回 undefined', () => {
    expect(pickActiveByKind([], 'image', 'a')).toBeUndefined()
    expect(pickActiveByKind([cfg('x', 'text')], 'tts', 'x')).toBeUndefined()
  })
})

/* ===== T2.3 尺寸与扩展参数门控 =====
   这些判断原来散在主界面里，要开浏览器 + 配一条对应厂商的接口才碰得到 */

function imgCfg(over: Partial<ApiConfig> = {}): ApiConfig {
  return { id: 'i', name: 'i', baseUrl: 'https://api.openai.com/v1', apiKey: 'k', model: 'gpt-image-1', ...over }
}

describe('normalizeSize · 手填尺寸归一', () => {
  it('容忍 × ✕ * 大写与空格', () => {
    expect(normalizeSize('1536×1024')).toBe('1536x1024')
    expect(normalizeSize('1536 ✕ 1024')).toBe('1536x1024')
    expect(normalizeSize(' 1536 * 1024 ')).toBe('1536x1024')
    expect(normalizeSize('1536X1024')).toBe('1536x1024')
  })

  it('auto 单独成档', () => {
    expect(normalizeSize('Auto')).toBe('auto')
    expect(normalizeSize('AUTO')).toBe('auto')
  })

  it('认不出来就返回 null —— 不隐式猜测(猜错等于替用户改了画幅)', () => {
    for (const bad of ['', 'abc', '1024', '1024x', 'x1024', '1024x0', '0x1024', '1024x1024x2']) {
      expect(normalizeSize(bad), bad).toBeNull()
    }
  })
})

describe('sizeOptionsFor · 这家厂商认哪些尺寸', () => {
  it('不认 auto 的厂商要把 auto 摘掉(留着它会显示"自动"却带不了这个参数)', () => {
    // 豆包 Seedream:autoSize=false 且 sizes=free
    expect(sizeOptionsFor('ark', 'doubao-seedream-3-0-t2i')).not.toContain('auto')
  })

  it('认 auto 的厂商保留它', () => {
    expect(sizeOptionsFor('openai', 'gpt-image-1')).toContain('auto')
    expect(sizeOptionsFor('gemini', 'gemini-2.5-flash-image')).toContain('auto')
  })

  it('OpenAI 两代模型给的档位不同(dall-e-3 没有 auto、也没有 1536 那几档)', () => {
    expect(sizeOptionsFor('openai', 'gpt-image-1')).toEqual([
      'auto',
      '1024x1024',
      '1536x1024',
      '1024x1536'
    ])
    expect(sizeOptionsFor('openai', 'dall-e-3')).toEqual(['1024x1024', '1792x1024', '1024x1792'])
  })

  it('不限尺寸的厂商拿到的是一组常用值(而不是空列表)', () => {
    // ark 的 autoSize 是 false:常用值里那份 auto 会被摘掉
    expect(sizeOptionsFor('ark', 'x')).toEqual(FREE_SIZES.filter((s) => s !== 'auto'))
    // 未知厂商按"认 auto"处理,于是原样拿到整份
    expect(sizeOptionsFor('custom', 'x')).toEqual(FREE_SIZES)
  })

  it('Gemini 的档位都能干净约成它认的宽高比(约不出来的会被服务端丢掉比例)', () => {
    // 服务端只认这几个比例字符串(见 server 的 GEMINI_RATIOS)
    const ok = new Set(['1:1', '3:2', '2:3', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'])
    const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a)
    for (const s of sizeOptionsFor('gemini', 'gemini-2.5-flash-image')) {
      if (s === 'auto') continue
      const [w, h] = s.split('x').map(Number)
      const d = gcd(w, h)
      expect(ok.has(`${w / d}:${h / d}`), s).toBe(true)
    }
  })
})

describe('sizeIsFree / defaultSizeFor', () => {
  it('不限尺寸 ⇔ 界面开放手填', () => {
    expect(sizeIsFree('ark', 'x')).toBe(true)
    expect(sizeIsFree('custom', 'x')).toBe(true)
    expect(sizeIsFree('openai', 'gpt-image-1')).toBe(false)
    expect(sizeIsFree('gemini', 'x')).toBe(false)
  })

  it('默认档:有 auto 用 auto,没有就用第一档(不能拿字面量 auto 当基线)', () => {
    expect(defaultSizeFor(['auto', '1024x1024'])).toBe('auto')
    expect(defaultSizeFor(['1024x1024', '1792x1024'])).toBe('1024x1024')
    expect(defaultSizeFor([])).toBe('auto')
  })
})

describe('sizeClosestTo · 按比例挑最接近的一档', () => {
  it('命中同一比例时直接选它', () => {
    expect(sizeClosestTo(['1024x1024', '1536x1024', '1024x1536'], 3 / 2)).toBe('1536x1024')
    expect(sizeClosestTo(['1024x1024', '1536x1024', '1024x1536'], 2 / 3)).toBe('1024x1536')
  })

  /* 这条是"为什么用对数距离"的判别用例:
     对 1:1 的目标,2:1 与 1:2 应当算同样远 —— 于是平手,谁排在前面选谁。
     换成直接减差值就做不到:0.5 比 2 更靠近 1,横档永远输给竖档,
     于是一张方图会被判给竖幅 */
  it('方图目标下横档与竖档同样远(平手由顺序决定)', () => {
    const wide = '1792x1024'
    const tall = '1024x1792'
    expect(sizeClosestTo([wide, tall], 1)).toBe(wide)
    expect(sizeClosestTo([tall, wide], 1)).toBe(tall)
  })

  it('角色全身像(2:3)在不限尺寸的厂商那里选到竖档', () => {
    expect(sizeClosestTo(FREE_SIZES, 2 / 3)).toBe('1024x1792')
  })

  it('认不出的档位跳过;一个都挑不出来时返回空串', () => {
    expect(sizeClosestTo(['auto', 'weird'], 1)).toBe('')
    expect(sizeClosestTo([], 1)).toBe('')
    expect(sizeClosestTo(['auto'], 0)).toBe('')
  })
})

describe('sizeForVendor · 对比出图时逐个模型校验', () => {
  it('不限尺寸的厂商原样用', () => {
    expect(sizeForVendor(imgCfg({ vendor: 'ark', model: 'x' }), '999x111')).toBe('999x111')
  })

  it('在列表里就用它', () => {
    expect(sizeForVendor(imgCfg({ vendor: 'openai' }), '1536x1024')).toBe('1536x1024')
  })

  it('不在列表里退回它的第一档(而不是硬发一个它不认的值)', () => {
    expect(sizeForVendor(imgCfg({ vendor: 'openai' }), '999x999')).toBe('auto')
    expect(sizeForVendor(imgCfg({ vendor: 'openai', model: 'dall-e-3' }), 'auto')).toBe('1024x1024')
  })

  it('老配置没有 vendor 时按域名回填,判断跟着走', () => {
    expect(sizeForVendor(imgCfg({ vendor: undefined, baseUrl: 'https://ark.cn-beijing.volces.com/api/v3' }), '2560x1440')).toBe('2560x1440')
  })
})

describe('seedFor · 种子发不发', () => {
  it('留空 / 认不出 / 超范围一律不发(= 交给上游随机)', () => {
    const cfg = imgCfg({ vendor: 'ark' })
    expect(seedFor(cfg, '')).toBeUndefined()
    expect(seedFor(cfg, '   ')).toBeUndefined()
    expect(seedFor(cfg, 'abc')).toBeUndefined()
    expect(seedFor(cfg, '99999999999')).toBeUndefined()
  })

  it('厂商明确不认 seed 时不发(OpenAI 的 Images API 没有这个参数)', () => {
    expect(seedFor(imgCfg({ vendor: 'openai' }), '42')).toBeUndefined()
  })

  it('标 unknown 的厂商填了就发(不假装支持、也不假装不支持)', () => {
    expect(seedFor(imgCfg({ vendor: 'ark' }), '42')).toBe(42)
    expect(seedFor(imgCfg({ vendor: 'gemini' }), ' 7 ')).toBe(7)
  })

  it('小数收敛成整数,负数原样接受(上游自己判合法性)', () => {
    expect(seedFor(imgCfg({ vendor: 'ark' }), '3.7')).toBe(4)
    expect(seedFor(imgCfg({ vendor: 'ark' }), '-12')).toBe(-12)
  })
})

describe('extraParamsFor · 按能力决定带哪些扩展参数', () => {
  it('不支持的厂商一项都不带', () => {
    expect(extraParamsFor(imgCfg({ vendor: 'ark' }), 'high', 'transparent')).toEqual({})
    expect(extraParamsFor(imgCfg({ vendor: 'gemini' }), 'high', 'transparent')).toEqual({})
  })

  it('支持的厂商带上非默认值', () => {
    expect(extraParamsFor(imgCfg({ vendor: 'openai' }), 'high', 'transparent')).toEqual({
      quality: 'high',
      background: 'transparent'
    })
  })

  it('默认档不发(发了等于把 auto 显式传给上游)', () => {
    expect(extraParamsFor(imgCfg({ vendor: 'openai' }), 'auto', 'auto')).toEqual({})
    expect(extraParamsFor(imgCfg({ vendor: 'openai' }), 'high', 'auto')).toEqual({ quality: 'high' })
  })

  it('老配置按域名回填后同样受能力表约束', () => {
    const legacy = imgCfg({ vendor: undefined, baseUrl: 'https://api.openai.com/v1' })
    expect(extraParamsFor(legacy, 'low', 'auto')).toEqual({ quality: 'low' })
  })
})

describe('acceptableSize · 套用历史/库里的尺寸', () => {
  it('认枚举的厂商:列表里的能套,列表外的不套(保留当前值)', () => {
    const dallE = imgCfg({ vendor: 'openai', model: 'dall-e-3' })
    expect(acceptableSize(dallE, '1792x1024')).toBe('1792x1024')
    expect(acceptableSize(dallE, '1536x1024')).toBeNull() // 那是 gpt-image-1 的档
    expect(acceptableSize(dallE, '999x999')).toBeNull()
    expect(acceptableSize(dallE, undefined)).toBeNull()
  })

  /* 这一条是补的洞:auto 不在任何列表里,它是"让上游自己定"这一档能力。
     以前只查列表,于是存着 auto 的记录套到豆包那种认枚举尺寸的配置上,
     会把 auto 原样发出去 —— 而它收到枚举外的值直接 400 */
  it('不认 auto 的厂商:套用 auto 要被拒(豆包、dall-e-3)', () => {
    expect(acceptableSize(imgCfg({ vendor: 'ark', model: 'doubao-seedream-3-0-t2i' }), 'auto')).toBeNull()
    expect(acceptableSize(imgCfg({ vendor: 'openai', model: 'dall-e-3' }), 'auto')).toBeNull()
  })

  it('认 auto 的厂商照常接受', () => {
    expect(acceptableSize(imgCfg({ vendor: 'openai', model: 'gpt-image-1' }), 'auto')).toBe('auto')
    expect(acceptableSize(imgCfg({ vendor: 'gemini', model: 'x' }), 'auto')).toBe('auto')
    expect(acceptableSize(imgCfg({ vendor: 'custom', model: 'x' }), 'auto')).toBe('auto')
  })

  it('不限尺寸的厂商:像素值照收,并顺手归一(历史里可能是 1536 × 1024)', () => {
    const ark = imgCfg({ vendor: 'ark', model: 'x' })
    expect(acceptableSize(ark, '1920x1080')).toBe('1920x1080')
    expect(acceptableSize(ark, '1536 × 1024')).toBe('1536x1024')
    expect(acceptableSize(ark, 'weird')).toBeNull()
  })
})

describe('thumbsToFill · 该给哪些记录补缩略图', () => {
  function rec(id: string, hasThumb: boolean): HistoryEntry {
    return {
      id,
      prompt: id,
      size: '1024x1024',
      createdAt: 0,
      results: [],
      ...(hasThumb ? { thumb: new Blob(['x']), w: 10, h: 10 } : {})
    } as HistoryEntry
  }

  it('只挑缺缩略图或尺寸的,并保持原顺序(新→旧)', () => {
    const list = [rec('a', true), rec('b', false), rec('c', true), rec('d', false)]
    expect(thumbsToFill(list).map((e) => e.id)).toEqual(['b', 'd'])
  })

  /* 这条是行为修正:原来是"扫前 N 条、遇到不缺的就跳过",
     于是前 N 条都补好时什么也不做,后面的照样缺 */
  it('前面都已补好时,照样去补后面的(先筛后取,不是先取后筛)', () => {
    const list = [rec('a', true), rec('b', true), rec('c', true), rec('d', false)]
    expect(thumbsToFill(list, 2).map((e) => e.id)).toEqual(['d'])
  })

  it('上限只限制"要补的条数",不限制扫描范围', () => {
    const list = Array.from({ length: 10 }, (_, i) => rec(`e${i}`, false))
    expect(thumbsToFill(list, 3)).toHaveLength(3)
  })

  it('都补好了就返回空(不必再逐条解码)', () => {
    expect(thumbsToFill([rec('a', true)])).toEqual([])
  })

  it('尺寸缺一项也算缺(图墙按真实比例排版要用)', () => {
    const half = { ...rec('h', false), thumb: new Blob(['x']) } as HistoryEntry
    expect(thumbsToFill([half]).map((e) => e.id)).toEqual(['h'])
  })
})

describe('shouldProcessNow · 空闲回调的余量判断', () => {
  it('余量够就做', () => {
    expect(shouldProcessNow(12, false)).toBe(true)
    expect(shouldProcessNow(4, false)).toBe(true)
  })

  it('余量不够就让给这一帧(用户正在滚动时那一帧要拿去画)', () => {
    expect(shouldProcessNow(3.9, false)).toBe(false)
    expect(shouldProcessNow(0, false)).toBe(false)
  })

  it('被 timeout 叫起来的照做 —— 否则一直不做', () => {
    expect(shouldProcessNow(0, true)).toBe(true)
  })

  it('阈值可覆盖', () => {
    expect(shouldProcessNow(5, false, 8)).toBe(false)
    expect(shouldProcessNow(9, false, 8)).toBe(true)
  })
})

describe('mergeHistory · 另一页改了历史之后怎么合', () => {
  function rec(id: string, createdAt: number, over: Partial<HistoryEntry> = {}): HistoryEntry {
    return { id, prompt: id, size: '1024x1024', createdAt, results: [], ...over } as HistoryEntry
  }

  it('库里有的以库为准(库是正本)', () => {
    const db = [rec('a', 3, { prompt: 'from db' })]
    const mem = [rec('a', 3, { prompt: 'stale in memory' })]
    expect(mergeHistory(db, mem, new Set()).map((h) => h.prompt)).toEqual(['from db'])
  })

  /* 这条是"幽灵条目"的关卡:库里没有、也不在写 = 别的标签页删了它 */
  it('库里没有、也没在写的丢掉(别处删了它)', () => {
    const db = [rec('a', 3)]
    const mem = [rec('a', 3), rec('gone', 2)]
    expect(mergeHistory(db, mem, new Set()).map((h) => h.id)).toEqual(['a'])
  })

  /* 这条是"刚落盘还没落地"的关卡:整份替换会把界面上这一条抹掉 */
  it('库里没有、但正在写的保住', () => {
    const db = [rec('a', 3)]
    const mem = [rec('a', 3), rec('in-flight', 5)]
    const out = mergeHistory(db, mem, new Set(['in-flight']))
    expect(out.map((h) => h.id)).toEqual(['in-flight', 'a'])
  })

  it('结果按时间倒序 —— 与 loadHistory 的顺序一致', () => {
    const db = [rec('a', 1), rec('b', 9), rec('c', 5)]
    expect(mergeHistory(db, [], new Set()).map((h) => h.id)).toEqual(['b', 'c', 'a'])
  })

  it('两边都空就是空', () => {
    expect(mergeHistory([], [], new Set())).toEqual([])
  })

  it('不改动传入的数组', () => {
    const db = [rec('a', 1)]
    const mem = [rec('b', 2)]
    mergeHistory(db, mem, new Set(['b']))
    expect(db.map((h) => h.id)).toEqual(['a'])
    expect(mem.map((h) => h.id)).toEqual(['b'])
  })
})
