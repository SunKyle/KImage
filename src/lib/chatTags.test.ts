import { describe, expect, it } from 'vitest'
import { PHOTO_SCENE_CHARS, TAG_HOLD, cleanScene, splitTags } from '../../server/chatTags.js'

/* 这些用例都是"会漏给用户看"的那几类:
   标签没剪干净、半截标签闪出来、自由文本没收敛。 */

describe('splitTags 的剪取', () => {
  it('情绪那枚照旧', () => {
    expect(splitTags('Fine. [mood:warm]')).toEqual({ text: 'Fine.', mood: 'warm', photo: '' })
  })

  it('发图那枚照旧', () => {
    expect(splitTags('Look at this.\n[photo:standing in the rain]')).toEqual({
      text: 'Look at this.',
      mood: '',
      photo: 'standing in the rain'
    })
  })

  /* 提示词让模型把两枚各写一行,而模型经常写成一前一后 ——
     只认末尾那一枚的实现会漏掉另一枚,那枚就会**原样漏给用户看** */
  it('两枚同时出现:mood 在前', () => {
    expect(splitTags('Here.\n[mood:amused]\n[photo:a rooftop at dusk]')).toEqual({
      text: 'Here.',
      mood: 'amused',
      photo: 'a rooftop at dusk'
    })
  })

  it('两枚同时出现:photo 在前', () => {
    expect(splitTags('Here.\n[photo:a rooftop at dusk]\n[mood:amused]')).toEqual({
      text: 'Here.',
      mood: 'amused',
      photo: 'a rooftop at dusk'
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
      photo: ''
    })
    expect(splitTags('Hmm [moo')).toEqual({ text: 'Hmm', mood: '', photo: '' })
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
