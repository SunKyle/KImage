import { describe, expect, it } from 'vitest'
import { CHAT_PHOTO_PROMPT_CHARS, planChatPhoto } from './chatPhoto'

/* 这一条决定"角色发的那张图会不会被设定图带跑",而真正的出图要花钱、要联网,
   靠手测试不全 —— 所以判据放在这里直接断言 */

const FACE = 'oval face, high cheekbones, dark bob, worn flight jacket'

describe('planChatPhoto · 场景照不该带角色设定', () => {
  it('场景照:提示词只有场景,不发参考图', () => {
    const p = planChatPhoto('rain on the window at dawn', false, FACE)
    expect(p.prompt).toBe('rain on the window at dawn')
    expect(p.useRefs).toBe(false)
  })

  it('场景照:哪怕外貌设定写着,也不拼进去 —— 那正是把风景画成人的原因', () => {
    expect(planChatPhoto('an empty harbour', false, FACE).prompt).not.toContain('cheekbones')
  })
})

describe('planChatPhoto · 有它本人的照片要带上设定', () => {
  it('self:场景在前、外貌在后(前段权重更高)', () => {
    const p = planChatPhoto('leaning on the balcony at night', true, FACE)
    expect(p.prompt).toBe(`leaning on the balcony at night, ${FACE}`)
    expect(p.useRefs).toBe(true)
  })

  it('没填过外貌设定的角色照样发参考图 —— 参考图是图,不依赖那段文字', () => {
    const p = planChatPhoto('me, at my desk', true, '')
    expect(p.useRefs).toBe(true)
    expect(p.prompt).toBe('me, at my desk')
  })
})

describe('planChatPhoto · 边角', () => {
  it('两端空白先收掉,不留出多余的空格', () => {
    expect(planChatPhoto('  a rooftop  ', true, '  tall  ').prompt).toBe('a rooftop, tall')
  })

  it('空场景给空提示词(调用方据此直接放弃这一张)', () => {
    expect(planChatPhoto('', true, FACE).prompt).toBe('')
  })

  it('超长按上限截断', () => {
    const long = 'x'.repeat(CHAT_PHOTO_PROMPT_CHARS + 500)
    expect(planChatPhoto(long, false, FACE).prompt.length).toBe(CHAT_PHOTO_PROMPT_CHARS)
  })

  it('退化输入不抛', () => {
    expect(planChatPhoto(undefined as unknown as string, false, '').prompt).toBe('')
    expect(planChatPhoto('a', true, undefined as unknown as string).prompt).toBe('a')
  })
})
