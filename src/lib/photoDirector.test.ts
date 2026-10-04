import { describe, expect, it } from 'vitest'
import { planChatPhoto } from './chatPhoto'
import {
  DIRECTOR_LINE_CHARS,
  applyDirector,
  directorBrief,
  directorTask,
  parseDirector,
  parseDirectorShot
} from './photoDirector'

/* 这一层是"把一句短场景交给文本模型补成怎么拍"。而自由文本会以三种方式
   破坏已经拼好的提示词(改写场景 / 编时间 / 写焦段),这三种都**不会报错**,
   只会让画面变味。所以断言几乎全落在验收、护栏与降级上。 */

const ANCHOR = 'oval face, dark bob'
/** 一份"什么都没说"的场景:四位都得补 */
const BARE = 'leaning on the balcony'
/** 一份已经交代了光与景深的场景:那两位不该被覆盖 */
const COVERED = 'leaning on the balcony, warm lamp light, shallow depth of field'

const ANSWER = [
  'Shot: third',
  'Camera: hand-held at chest height, slightly below eye level',
  'Lens: shallow focus, the railing soft in the foreground',
  'Light: a warm lamp just off frame to the left, grazing the wall',
  'Environment: the city below falling away into haze'
].join('\n')

/** 把一段原始输出走完整条解析 + 合并,与 useGeneration 里的顺序一致 */
function merge(scene: string, self: boolean, raw: string) {
  const plan = planChatPhoto(scene, self, ANCHOR)
  return applyDirector(plan, { written: parseDirector(raw), shot: parseDirectorShot(raw) })
}

describe('parseDirector · 认固定几行', () => {
  it('四行都认出来', () => {
    const w = parseDirector(ANSWER)
    expect(w.camera).toContain('chest height')
    expect(w.lens).toContain('shallow focus')
    expect(w.light).toContain('warm lamp')
    expect(w.env).toContain('falling away into haze')
  })

  it('Shot 那行不进这四位 —— 它换的是模板,不是提示词里的一句话', () => {
    expect(parseDirector('Shot: selfie')).toEqual({})
  })

  it('标签大小写与空格都不计较 —— 模型不总写得一丝不差', () => {
    const w = parseDirector('camera : low angle\nLIGHT:  hard sun  ')
    expect(w.camera).toBe('low angle')
    expect(w.light).toBe('hard sun')
  })

  it('中文冒号也认', () => {
    expect(parseDirector('Camera：low angle').camera).toBe('low angle')
  })

  it('认不出的标签忽略,不影响认得出的', () => {
    const w = parseDirector('Mood: tense\nCamera: low angle\nFoo: bar')
    expect(w.camera).toBe('low angle')
    expect(Object.keys(w)).toEqual(['camera'])
  })

  it('散文、空行、前言都不认 —— 只认带标签的行', () => {
    expect(parseDirector('Sure! Here are the lines.\n\nThis is a balcony at night.')).toEqual({})
  })

  it('退化输入不抛', () => {
    expect(parseDirector('')).toEqual({})
    expect(parseDirector(undefined as unknown as string)).toEqual({})
  })

  it('空值行不算补上 —— 模型用空行表示"这一位留空"', () => {
    expect(parseDirector('Camera: \nLight: none')).toEqual({})
    expect(parseDirector('Camera: n/a\nLight: -')).toEqual({})
  })
})

describe('parseDirectorShot · 视角只认两个词', () => {
  it('selfie / third 各认几种写法', () => {
    expect(parseDirectorShot('Shot: selfie')).toBe('selfie')
    expect(parseDirectorShot('shot: Selfie')).toBe('selfie')
    expect(parseDirectorShot('Shot: self-portrait')).toBe('selfie')
    expect(parseDirectorShot('Shot: third')).toBe('third')
    expect(parseDirectorShot('Shot: third person')).toBe('third')
    expect(parseDirectorShot('View: external')).toBe('third')
  })

  it('认不出的词当"没判",不替它猜 —— 归一化近义词等于替模型判断', () => {
    expect(parseDirectorShot('Shot: portrait')).toBe('')
    expect(parseDirectorShot('Shot: close-up')).toBe('')
    expect(parseDirectorShot('Shot: ')).toBe('')
    expect(parseDirectorShot('Camera: low angle')).toBe('')
    expect(parseDirectorShot('')).toBe('')
  })
})

describe('parseDirector · 三条验收(每一条都丢整行)', () => {
  it('编时间就丢 —— 场景没说几点,它写黄昏会和对话里正在值夜班的它矛盾', () => {
    expect(parseDirector('Light: soft light at dusk, warm from the west').light).toBeUndefined()
    /* 丢的是整行,不是那个词 —— 删完剩半句更糟 */
    expect(parseDirector('Camera: low angle\nLight: at dusk').camera).toBe('low angle')
  })

  it('写焦段或光圈就丢 —— 那是和场景无关的噪声', () => {
    expect(parseDirector('Lens: shot at 85mm, shallow focus').lens).toBeUndefined()
    expect(parseDirector('Lens: 35 mm wide').lens).toBeUndefined()
    expect(parseDirector('Lens: wide open f/1.4').lens).toBeUndefined()
  })

  it('"midnight blue" 这种合法颜色也会被时间词误伤 —— 宁可丢一行也不放它进画面', () => {
    /* 这一条记录的是取舍,不是缺陷:误伤的代价是退回模板(少一句话),
       放过去的代价是画面与对话矛盾(整张不对味) */
    expect(parseDirector('Light: midnight blue cast').light).toBeUndefined()
  })

  it('破坏行结构的字符被抹掉,短语本身留着', () => {
    expect(parseDirector('Camera: **low angle**; "hand-held"').camera).toBe('low angle hand-held')
  })

  it('逗号留着 —— 规则里要的就是逗号分隔的短语', () => {
    expect(parseDirector('Camera: low angle, hand-held, off-center').camera).toBe(
      'low angle, hand-held, off-center'
    )
  })

  it('超长截断', () => {
    const long = 'Light: ' + 'x'.repeat(DIRECTOR_LINE_CHARS + 200)
    expect(parseDirector(long).light?.length).toBe(DIRECTOR_LINE_CHARS)
  })
})

describe('applyDirector · 视角归它判', () => {
  it('它判 selfie,就换成自拍那一整套模板', () => {
    const p = merge(BARE, true, 'Shot: selfie')
    expect(p.shot).toBe('selfie')
    expect(p.prompt).toContain('front camera')
    expect(p.prompt).toContain('arm\u2019s length')
  })

  it('它判 third,就换成第三人称那一套', () => {
    const p = merge(BARE, true, 'Shot: third')
    expect(p.shot).toBe('third')
    expect(p.prompt).toContain('third-person view')
    expect(p.prompt).not.toContain('arm\u2019s length')
  })

  it('它没判(没写 Shot 或写了个认不出的词)时保留原视角', () => {
    expect(merge('taking a selfie by the window', true, 'Camera: low angle').shot).toBe('selfie')
    expect(merge(BARE, true, 'Shot: portrait').shot).toBe('third')
  })

  it('**画面里没有人时它判 selfie 也不算** —— 空镜里长出一个人最严重', () => {
    const p = merge('an empty harbour at dawn', false, 'Shot: selfie\nCamera: low angle')
    expect(p.shot).toBe('scene')
    expect(p.prompt).toContain('no people in frame')
    /* 机位仍然听它的(空镜也要有人定机位),但绝不能出现自拍那套词 */
    expect(p.prompt).toContain('low angle')
    expect(p.prompt).not.toContain('arm\u2019s length')
    expect(p.prompt).not.toContain('front camera')
  })

  it('换视角会连媒介一起换 —— 不能留着"手机前置"却说第三人称', () => {
    /* 这是"重拼"而不是"打补丁"的理由:视角决定的是一整套,不只 camera 那一句 */
    const selfie = merge(BARE, true, 'Shot: selfie')
    const third = applyDirector(selfie, { written: {}, shot: 'third' })
    expect(third.prompt).toContain('third-person view')
    expect(third.prompt).not.toContain('shot on a phone front camera')
  })

  it('换视角不会丢掉身份锚点', () => {
    expect(merge(BARE, true, 'Shot: selfie').prompt).toContain(ANCHOR)
  })
})

describe('applyDirector · 逐位合并与降级', () => {
  it('四位都写回来时,提示词里换成了模型写的那几句', () => {
    const p = merge(BARE, true, ANSWER)
    expect(p.prompt).toContain('chest height')
    expect(p.prompt).toContain('warm lamp')
    expect(p.prompt).toContain('falling away into haze')
    /* 模板那几句应当被换掉,而不是两份都在 */
    expect(p.prompt).not.toContain('third-person view')
    expect(p.prompt).not.toContain('layered with depth')
  })

  it('场景已经写了光,模型再写一句光也不采用 —— 两句光会互相打架', () => {
    const p = merge(COVERED, true, ANSWER)
    expect(p.prompt).toContain('warm lamp light')
    expect(p.prompt).not.toContain('warm lamp just off frame')
  })

  it('场景已经写了景深,模型再写一句镜头也不采用', () => {
    const p = merge(COVERED, true, ANSWER)
    expect(p.prompt).toContain('shallow depth of field')
    expect(p.prompt).not.toContain('railing soft in the foreground')
  })

  it('机位与纵深是无条件接受的 —— 它们不是事实,是相机原理', () => {
    const p = merge(COVERED, true, ANSWER)
    expect(p.prompt).toContain('chest height')
    expect(p.prompt).toContain('falling away into haze')
  })

  it('模型没写的位退回模板 —— 降级是逐位的,不是整层', () => {
    const p = merge(COVERED, true, 'Camera: low angle')
    expect(p.prompt).toContain('low angle')
    expect(p.prompt).toContain('warm lamp light')
    expect(p.prompt).toContain('layered with depth')
  })

  it('护栏丢掉的行,那一位退回模板', () => {
    const p = merge(BARE, true, 'Light: at dusk\nCamera: low angle')
    expect(p.prompt).toContain('low angle')
    expect(p.prompt).not.toContain('dusk')
    expect(p.prompt).toContain('directional light')
  })

  it('场景原文、锚点句、负面约束一个字都不许动', () => {
    const p = merge(BARE, true, ANSWER)
    expect(p.prompt).toContain(BARE)
    expect(p.prompt).toContain(ANCHOR)
    expect(p.prompt).toContain('not a character sheet')
  })

  it('空镜:摄影指导换得掉机位,却换不掉"画面里没有人"', () => {
    /* 防回归:那句约束原先是并进 camera 那一层的,而 applyDirector 会替换 camera ——
       于是空镜失去了唯一挡人的防线。现在它是独立一层(ShotTemplate.noPeople) */
    const p = merge('an empty harbour at dawn', false, ANSWER)
    expect(p.prompt).toContain('no people in frame')
    expect(p.prompt).toContain('chest height')
    expect(p.prompt).not.toContain('held steady')
  })

  it('有人那两档不带"没有人"这句话', () => {
    expect(merge(BARE, true, ANSWER).prompt).not.toContain('no people in frame')
  })

  it('合并后 prompt 与 layers 始终一致', () => {
    const p = merge(BARE, true, ANSWER)
    expect(p.prompt).toBe(p.layers.map(([, v]) => v).filter(Boolean).join(', '))
  })

  it('退化输入不抛(模型什么都没写)', () => {
    const plan = planChatPhoto(BARE, true, ANCHOR)
    expect(applyDirector(plan, { written: {} }).prompt).toBe(plan.prompt)
    expect(applyDirector(plan, { written: {}, shot: '' }).shot).toBe(plan.shot)
  })

  it('没场景时不动它(空计划没有层可换)', () => {
    const empty = planChatPhoto('', true, ANCHOR)
    expect(applyDirector(empty, { written: parseDirector(ANSWER), shot: 'selfie' }).prompt).toBe('')
  })
})

describe('directorTask / directorBrief · 告诉模型该干什么', () => {
  it('任务里带场景原文 —— 它必须基于这一场写,不是凭空写', () => {
    expect(directorTask(planChatPhoto(BARE, true, ANCHOR))).toContain(BARE)
  })

  it('只交代"画面里有没有人",不替它定视角', () => {
    /* 这一条记的是分工:视角是它要判的那件事,不是我们给它的前提。
       告诉它"这是自拍,别改"等于把它唯一有权做的判断收回来 */
    const withPerson = directorTask(planChatPhoto(BARE, true, ANCHOR))
    expect(withPerson).toContain('The character is in this image')
    expect(withPerson).not.toContain('This is a selfie')
    expect(withPerson).not.toContain('third-person shot')
    expect(withPerson).toContain('Decide Shot yourself')

    const scene = directorTask(planChatPhoto('an empty harbour', false, ''))
    expect(scene).toContain('no character in this image')
  })

  it('场景已经覆盖的位要明确告诉它留空', () => {
    const brief = directorBrief(planChatPhoto(COVERED, true, ANCHOR))
    expect(brief).toContain('Lens')
    expect(brief).toContain('Light')
    expect(brief).toContain('Leave those lines empty')
  })

  it('四位都空着时不说"留空"', () => {
    const brief = directorBrief(planChatPhoto(BARE, true, ANCHOR))
    expect(brief).toContain('covers none')
    expect(brief).not.toContain('Leave those lines empty')
  })
})
