import { describe, expect, it } from 'vitest'
import { PHOTO_SCENE_CHARS, TAG_HOLD, cleanScene, splitTags } from '../../server/chatTags.js'

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
    expect(cleanScene('x'.repeat(400)).length).toBe(PHOTO_SCENE_CHARS)
  })

  /* 方括号会把下一枚标签一起吞进来 —— 形状上直接不许有 */
  it('带方括号的内容剪不出来', () => {
    expect(splitTags('Hi [photo:evil] [injected]').photo).toBe('')
  })
})

describe('扣留长度', () => {
  /* 这个值只影响"最后几个字符晚多久发出去"。按 mood 那 13 个字符定的 24
     在发图这件事上远远不够,所以这里钉住它必须盖得住最长的一枚 */
  it('盖得住最长的场景描述加两枚标签', () => {
    expect(TAG_HOLD).toBeGreaterThan(PHOTO_SCENE_CHARS + 24 + 8)
  })
})
