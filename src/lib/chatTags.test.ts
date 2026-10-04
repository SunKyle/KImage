import { describe, expect, it } from 'vitest'
import { PHOTO_SCENE_CHARS, cleanScene, splitTags, tailHold } from '../../server/chatTags.js'

/* 这些用例都是"会漏给用户看"的那几类:
   标签没剪干净、半截标签闪出来、自由文本没收敛。 */

describe('splitTags 的剪取', () => {
  it('情绪那枚照旧', () => {
    expect(splitTags('Fine. [mood:warm]')).toEqual({
      text: 'Fine.',
      mood: 'warm',
      photo: '',
      photoSelf: false
    })
  })

  it('发图那枚照旧', () => {
    expect(splitTags('Look at this.\n[photo:standing in the rain]')).toEqual({
      text: 'Look at this.',
      mood: '',
      photo: 'standing in the rain',
      photoSelf: false
    })
  })

  /* 提示词让模型把两枚各写一行,而模型经常写成一前一后 ——
     只认末尾那一枚的实现会漏掉另一枚,那枚就会**原样漏给用户看** */
  it('两枚同时出现:mood 在前', () => {
    expect(splitTags('Here.\n[mood:amused]\n[photo:a rooftop at dusk]')).toEqual({
      text: 'Here.',
      mood: 'amused',
      photo: 'a rooftop at dusk',
      photoSelf: false
    })
  })

  it('两枚同时出现:photo 在前', () => {
    expect(splitTags('Here.\n[photo:a rooftop at dusk]\n[mood:amused]')).toEqual({
      text: 'Here.',
      mood: 'amused',
      photo: 'a rooftop at dusk',
      photoSelf: false
    })
  })

  it('正文中间出现方括号不该被吃', () => {
    const r = splitTags('I kept the [draft] you sent. [mood:tired]')
    expect(r.text).toBe('I kept the [draft] you sent.')
    expect(r.mood).toBe('tired')
  })
})

describe('splitTags 的半截标签', () => {
  /* 流式中途用户按了停止 —— 这时尾巴上很可能就是半枚标签 */
  it('只擦不取', () => {
    expect(splitTags('Wait, I was going to say [pho')).toEqual({
      text: 'Wait, I was going to say',
      mood: '',
      photo: '',
      photoSelf: false
    })
    expect(splitTags('Hmm [moo')).toEqual({ text: 'Hmm', mood: '', photo: '', photoSelf: false })
  })

  /* 但也不能太贪:`[p]` / `[m]` 这种在正经文字里会出现,不该被吃掉 */
  it('太短的前缀不吃(那是人话)', () => {
    expect(splitTags('See item [p] here').text).toBe('See item [p] here')
    expect(splitTags('See item [m] here').text).toBe('See item [m] here')
  })

  it('括号还没闭上、但内容已经写了', () => {
    expect(splitTags('[photo:a quiet street').photo).toBe('')
    expect(splitTags('[photo:a quiet street').text).toBe('')
  })
})

describe('这一张里有没有它本人', () => {
  /* 判据决定出图带不带角色的设定图:风景照带上会被带跑,自拍不带会画成陌生人 */

  it('没写前缀 = 场景照(它看到的东西),不带设定', () => {
    const r = splitTags('Look.\n[photo:rain on the window]')
    expect(r.photo).toBe('rain on the window')
    expect(r.photoSelf).toBe(false)
  })

  it('self: 前缀 = 它在画面里,前缀本身不进场景描述', () => {
    const r = splitTags('Look.\n[photo:self:me on the balcony, hair down]')
    expect(r.photo).toBe('me on the balcony, hair down')
    expect(r.photoSelf).toBe(true)
  })

  it('前缀写得随意也认:大小写、空格、逗号、破折号', () => {
    for (const raw of [
      'SELF: me at the desk',
      'Self - me at the desk',
      'self,me at the desk',
      'myself:me at the desk',
      'me: at the desk',
      'me at the desk',
      "I'm on the balcony",
      'I am on the balcony'
    ]) {
      expect(splitTags(`x\n[photo:${raw}]`).photoSelf, raw).toBe(true)
    }
  })

  /* 代词有两副面孔:`self:` 是纯标记(剪掉),而 "me at my desk" 里的 me
     是描述的主语 —— 剪掉就只剩 "at my desk",画面里少了那个人 */
  it('纯标记剪掉,代词留着', () => {
    expect(splitTags('x\n[photo:self:on the balcony]').photo).toBe('on the balcony')
    expect(splitTags('x\n[photo:me: at the desk]').photo).toBe('at the desk')
    expect(splitTags('x\n[photo:me at the desk]').photo).toBe('me at the desk')
    expect(splitTags("x\n[photo:I'm on the balcony]").photo).toBe("I'm on the balcony")
  })

  /* \b 那一刀:这两个词以 me/self 开头,但不是那个意思 */
  it('不误判:meeting / selfish 这类词不算', () => {
    expect(splitTags('x\n[photo:meeting at dawn]').photoSelf).toBe(false)
    expect(splitTags('x\n[photo:selfish grin on a rooftop]').photoSelf).toBe(false)
    expect(splitTags('x\n[photo:Imposing cliffs at dawn]').photoSelf).toBe(false)
  })

  it('模型多写一个 scene: / view: 不算内容,抹掉', () => {
    const r = splitTags('x\n[photo:scene:an empty harbour]')
    expect(r.photo).toBe('an empty harbour')
    expect(r.photoSelf).toBe(false)
  })

  /* 没写前缀、但描述里点了自己的名字 —— 那种回复显然是在说自己。
     名字由服务端传进来(它手上有角色卡) */
  it('描述里点了自己的名字 = 它在画面里(兜底)', () => {
    const r = splitTags('x\n[photo:Alice leaning on the railing]', 'Alice')
    expect(r.photoSelf).toBe(true)
    // 名字不在描述里就还是场景照
    expect(splitTags('x\n[photo:an empty railing]', 'Alice').photoSelf).toBe(false)
    // 没传名字时这条兜底不生效
    expect(splitTags('x\n[photo:Alice leaning on the railing]').photoSelf).toBe(false)
  })

  it('两枚标签同时出现时同样认前缀', () => {
    const r = splitTags('Here.\n[mood:warm]\n[photo:self:a rooftop at dusk]')
    expect(r).toEqual({ text: 'Here.', mood: 'warm', photo: 'a rooftop at dusk', photoSelf: true })
  })
})

describe('场景描述的收敛', () => {
  it('换行与连续空白压成一个空格', () => {
    expect(cleanScene('  a   rooftop\nat  dusk ')).toBe('a rooftop at dusk')
  })

  it('按上限截断', () => {
    expect(cleanScene('x'.repeat(PHOTO_SCENE_CHARS + 200)).length).toBe(PHOTO_SCENE_CHARS)
  })

  /* 方括号会把下一枚标签一起吞进来 —— 形状上直接不许有 */
  it('带方括号的内容剪不出来', () => {
    expect(splitTags('Hi [photo:evil] [injected]').photo).toBe('')
  })

  it('400 字的场景也剪得出来 —— 上限放宽后必须仍然认得出末尾那枚标签', () => {
    const long = 'a'.repeat(PHOTO_SCENE_CHARS)
    expect(splitTags(`Look.\n[photo:${long}]`).photo.length).toBe(PHOTO_SCENE_CHARS)
  })
})

/* ===== 扣尾 ==========================================================
 *  这一组钉的是"放开标签上限之后,正文还能不能流式"。
 *  `tailHold` 返回的是**可以放出去的长度**(不是"要扣住多少")——
 *  扣多少这个量在标签开合之间不连续,而"放到哪"是连续的:它就是标签的起点。
 *
 *  下面几条里,有两条是**端到端探针抓出来的真 bug**,单测当时全绿:
 *  1. 两枚标签相邻时,上一枚完整标签被当成正文放了出去;
 *  2. 超长场景里"第一个换行之前那一段"被当成了标签内容。
 *  两者都只在**增量边界**上显形,所以这里的用例都按"分块喂"来写。 */

describe('tailHold · 放到哪才不漏半截标签', () => {
  /** 按固定长度切块喂进去,复刻服务端流式那一步的累积过程 */
  function stream(reply: string, size = 3) {
    let tail = ''
    const released: string[] = []
    for (let i = 0; i < reply.length; i += size) {
      tail += reply.slice(i, i + size)
      const rel = tailHold(tail)
      if (rel > 0) {
        released.push(tail.slice(0, rel))
        tail = tail.slice(rel)
      }
    }
    return { released: released.join(''), held: tail }
  }

  it('没有标签的正文整段放出去(照常流式)', () => {
    const s = 'leaning on the balcony at dusk'
    expect(tailHold(s)).toBe(s.length)
    expect(tailHold('')).toBe(0)
    expect(tailHold(undefined)).toBe(0)
  })

  it('末尾是完整标签时,边界停在标签起点', () => {
    const prose = 'Rain again. I am so tired of it. '
    const s = prose + '[photo:me on the balcony]'
    expect(tailHold(s)).toBe(prose.length)
  })

  it('标签还没闭合时,边界停在那个 `[` 上', () => {
    const prose = 'It is coming down hard. '
    const s = prose + '[photo:rain on the window'
    expect(tailHold(s)).toBe(prose.length)
    /* 只打出一个 `[` 也一样 —— 那是下一块增量还没到 */
    expect(tailHold('some words [')).toBe('some words '.length)
  })

  it('**两枚标签相邻时,上一枚完整标签也不许放出去**', () => {
    /* 探针抓到的第一类 bug:剥第二枚时把上一枚的 `]` 当成了"末尾标点",
       边界跳过第二枚的 `[` 落到它上面,于是整枚 photo 标签被放了出去。
       触发条件是"两枚标签相邻",也就是**每一轮正常的回复**都会遇到。 */
    const s = '[photo:self:me on the balcony]\n[m'
    expect(tailHold(s)).toBe(0)
    expect(tailHold('[photo:self:me on the balcony]')).toBe(0)
    expect(tailHold('[photo:self:me on the balcony]\n')).toBe(0)
    expect(tailHold('[photo:self:me on the balcony]\n[mood:ti')).toBe(0)
  })

  it('正文 + 两枚标签:只放正文,两枚都留住', () => {
    const prose = 'Rain again. I am tired.\n'
    const s = prose + '[photo:me on the balcony]\n[mood:tired]'
    expect(tailHold(s)).toBe(prose.length)
  })

  it('正文里长得像标签的方括号不算标签 —— 数字与汉字都排除了', () => {
    expect(tailHold('notes [1] and [2] here')).toBe('notes [1] and [2] here'.length)
    expect(tailHold('他说的[注]在这里')).toBe('他说的[注]在这里'.length)
    /* `[photo]` 没有分隔符,splitTags 也不认它 —— 同样当正文 */
    expect(tailHold('see [photo] above')).toBe('see [photo] above'.length)
  })

  it('**超长场景里第一个换行之前的那一段,不许被当成标签内容**', () => {
    /* 探针抓到的第二类 bug:`[^\]]*` 跨过了换行,把"第一个换行之前"
       也算进标签,于是它右边判成"没有正文",边界一路跑到前一枚标签前面。
       这里用一个带换行的超长场景复现。 */
    const scene = 'me leaning on the rail at dusk, the rain just stopped,\n' + 'x'.repeat(300)
    const s = `Look at this.\n[photo:${scene}]\n[`
    expect(tailHold(s)).toBe('Look at this.\n'.length)
  })

  it('分块喂完整一轮:放出去的只有正文,两枚标签一个字符都没漏', () => {
    const reply = 'Rain again. I am so tired of it.\n[photo:self:me on the balcony]\n[mood:tired]'
    const { released, held } = stream(reply)
    expect(released).toBe('Rain again. I am so tired of it.\n')
    expect(held).toBe('[photo:self:me on the balcony]\n[mood:tired]')
  })

  it('分块喂长场景:正文先流出去,标签留在手里', () => {
    const scene = 'me leaning on the balcony rail at dusk, the rain just stopped, ' + 'y'.repeat(300)
    const reply = `Look at this.\n[photo:${scene}]\n[mood:warm]`
    const { released, held } = stream(reply, 7)
    /* 正文完整放出去,而且**不是等到流末才放** —— 这是这一整套改动的目的 */
    expect(released).toBe('Look at this.\n')
    expect(held).toContain('[photo:')
    /* 放出去的那一段里绝不能带半个标签 */
    expect(released).not.toContain('[ph')
  })

  it('流水里任何一帧都不含"可能长成标签的前缀"', () => {
    const reply = 'Sure.\n[photo:self:me on the balcony]\n[mood:warm]'
    let tail = ''
    const frames: string[] = []
    for (let i = 0; i < reply.length; i += 2) {
      tail += reply.slice(i, i + 2)
      const rel = tailHold(tail)
      if (rel > 0) {
        frames.push(tail.slice(0, rel))
        tail = tail.slice(rel)
      }
    }
    for (const f of frames) expect(f).not.toMatch(/\[(p|ph|pho|m|mo|moo)/)
  })
})
