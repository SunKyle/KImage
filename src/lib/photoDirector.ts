/* ===== 摄影指导 =======================================================
 *  对话出图那条路的"第三层"(见 doc/角色配图构图与光影设计.md 的 §四):
 *  在标签剪下来之后、真正发图之前,把一句短场景描述交给一次文本模型调用,
 *  由它写出**这个场景**该怎么拍 —— 机位、镜头、光、环境纵深。
 *
 *  —— 为什么需要它 ——
 *
 *  lib/chatPhoto.ts 里的 TEMPLATES 是查表:同一位空着时,烛光晚餐和雨夜巷口
 *  拿到的是同一句 "directional light with a clear source"。它有用(图像模型确实
 *  缺这些构图词汇),但它不知道你这张图具体该是什么光。模型才知道。
 *
 *  —— 为什么补上的字不能直接信 ——
 *
 *  一次自由文本生成会以三种方式破坏已经拼好的提示词,这三种都不能靠
 *  "在提示词里多叮嘱一句"解决:
 *
 *  1. **它顺手把场景改写一遍**。那等于把主体换掉了 —— 而主体是用户的意图,
 *     不是它可以优化的东西。所以**场景原文永远不由它提供**,它只写字。
 *  2. **它编时间/天气**。场景没说几点,它写一句 "at dusk" 就可能和对话里
 *     正在值夜班的它矛盾。这是"新事实",比留空更糟。
 *  3. **它写焦段**。`85mm f/1.4` 是最容易被编出来的一项,而它与这个场景
 *     毫无关系,乱写的焦段只会把构图带偏。
 *
 *  所以这个模块的职责不是"解析模型输出",而是**在解析之后逐项验收**:
 *  带时间词的整行丢掉、带焦段的整行丢掉、场景已经说过的那一位不接受覆盖、
 *  超长的截断、破坏行结构的字符抹掉。任何一项没过 → 该位退回模板。
 *  这一层与 chatPhoto 的"失败只降级、绝不 reject"是同一条纪律:
 *  摄影指导挂了,这张图照样得出得来。
 *
 *  抽成纯函数是为了能直接断言 —— 上面每一条护栏都是"出错时画面会变形、
 *  但不会报错"的那类问题,而真正的出图要花钱、要联网,靠手测试不全。
 */

import type { ChatLayer, ChatPhotoPlan, ChatShot } from './chatPhoto'
import { composeChatPrompt, missingSlots, planChatPhoto } from './chatPhoto'

/** 摄影指导能补的四位。**它不许碰 medium / 场景 / 锚点 / 负面约束** ——
 *  那几样分别是"媒介""内容""这个人是谁"与"挡什么",都不是"怎么拍" */
export const DIRECTOR_SLOTS = ['camera', 'lens', 'light', 'env'] as const
export type DirectorSlot = (typeof DIRECTOR_SLOTS)[number]

/** 它唯一有权"选一个词"的地方:视角。**不是 DIRECTOR_SLOTS 的一员** ——
 *  那四位是"往提示词里填的句子",而这一位是"用哪套模板",去向不同
 *  (它要变成 shot,进而决定参考图顺序与画幅比例) */
export const SHOT_LABEL = 'shot'

/** 每一行的长度上限。提示词里写的是"under 20 words",这里按字符收口 ——
 *  字数它不总数得清,而一行写到 400 字符就开始喧宾夺主 */
export const DIRECTOR_LINE_CHARS = 220

/* 时间词。命中就丢整行:那条规则("不要编时间")是最容易破的一条,
   而破了之后画面与对话矛盾是**看不出来**的 —— 用户只会觉得"这图不对味" */
const TIME_WORD_RE =
  /\b(dawn|sunrise|sunset|dusk|midnight|noon|midday|afternoon|evening|tonight|golden hour|blue hour|morning|night)\b/i

/* 焦段与光圈。同上,命中就丢整行 —— 它不是"不准确",是"和场景无关的噪声" */
const FOCAL_RE = /\b\d{1,3}\s*mm\b|\bf\/\d/i

/* 行结构的破坏者。`:()` 会与标签语法打架,句号/引号/markdown 会把一句短语
   变成一段话。**逗号不在此列** —— 四条规则里明说了要逗号分隔的短语 */
const STRUCTURE_RE = /[:：;；。！？!?"'`*#\r\n\t]/g

/**
 * 把摄影指导的原始输出解析成"视角 + 四位"。
 *
 * 认的是固定几行标签(`Shot: selfie` / `Camera: …`),不是散文 —— 散文没法逐位合并
 * (已经说过的那一位要拒绝覆盖,而那需要知道每一句属于哪一位)。
 *
 * `Shot:` 那一行只认两个词(见 shotOf)。认不出就当作"它没判" ——
 * 调用方据此保留原来那个视角,而不是猜一个。
 *
 * @returns 只含**解析成功且通过验收**的位。没提到的位、以及被丢掉的位,
 *          都不出现在结果里 —— 调用方据此逐位退回模板
 */
export function parseDirector(raw: string): Partial<Record<DirectorSlot, string>> {
  const out: Partial<Record<DirectorSlot, string>> = {}
  const text = String(raw || '')
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z ]{3,15})\s*[:：]\s*(.*)$/.exec(line)
    if (!m) continue
    /* 标签本身大小写与空格都不计较(模型会写 "Camera" 也会写 "camera ") */
    const label = m[1].trim().toLowerCase()
    const slot = label === 'environment' ? 'env' : (label as DirectorSlot)
    if (!DIRECTOR_SLOTS.includes(slot)) continue
    const value = lineValue(m[2])
    if (value) out[slot] = value
  }
  return out
}

/**
 * 从原始输出里取视角。**与四位分开解析**是因为它的去向不同:
 * 它不往提示词里填句子,而是换一整套模板(进而换参考图顺序与画幅)。
 *
 * 只认 `selfie` 与 `third` 两个词。其余一律当作"没判" ——
 * 让模型自由发挥一个视角词(比如 "portrait"、"close-up")没法映射到模板上,
 * 而归一化它的近义词是在替它猜,不如老实退回原值。
 */
export function parseDirectorShot(raw: string): 'selfie' | 'third' | '' {
  for (const line of String(raw || '').split(/\r?\n/)) {
    const m = /^\s*(?:shot|view|camera\s*angle)\s*[:：]\s*(.*)$/i.exec(line)
    if (!m) continue
    return shotOf(m[1])
  }
  return ''
}

/** 把一个词归一成视角。认不出返回空串(= 没判) */
function shotOf(raw: string): 'selfie' | 'third' | '' {
  const v = String(raw || '')
    .toLowerCase()
    .replace(/[^a-z]/g, '')
  if (!v) return ''
  if (v === 'selfie' || v === 'self' || v === 'selfportrait' || v === 'mirror') return 'selfie'
  if (v === 'third' || v === 'thirdperson' || v === 'other' || v === 'external') return 'third'
  return ''
}

/** 单行的验收与清洗。空串 = 这一位不要 */
function lineValue(raw: string): string {
  let v = String(raw || '').replace(/\s+/g, ' ').trim()
  if (!v) return ''
  /* 模型偶尔会写 "Camera:" 然后跟一句 "n/a" / "none" / "-" 表示这一位它没写 */
  if (/^(n\/?a|none|same|unchanged|-{1,2}|—)$/i.test(v)) return ''
  /* 时间词与焦段:丢整行而不是删掉那个词 —— 删完剩半句更糟 */
  if (TIME_WORD_RE.test(v)) return ''
  if (FOCAL_RE.test(v)) return ''
  v = v.replace(STRUCTURE_RE, ' ').replace(/\s+/g, ' ').trim()
  v = v.replace(/^[,，\s]+|[,，\s]+$/g, '')
  if (!v) return ''
  return v.slice(0, DIRECTOR_LINE_CHARS).trim()
}

/**
 * 摄影指导的结果并进方案。
 *
 * 四条不变量(每一条都有单测):
 * 1. **视角由它定,但"画面里有没有人"不由它定** —— 空镜场景里即便它写了 selfie
 *    也会被压回空镜(见 planChatPhoto 的 resolved)。一张"我看到的东西"里长出
 *    一个人,比视角选错严重得多;
 * 2. **场景已经说过的那一位不接受覆盖** —— 场景里写了光,模型再写一句光就是
 *    自相矛盾,而模型会挑一处当噪声丢掉、或者把两者硬凑成一张谁都不像的图;
 * 3. **没被补上或验收不过的位退回模板** —— 降级是逐位的,不是整层;
 * 4. **只换那四位 + 视角**。medium / 场景 / 锚点 / 动作 / 负面约束一律不动。
 *
 * @param patch.written parseDirector 的结果(只含通过验收的位)
 * @param patch.shot    parseDirectorShot 的结果,空串 = 它没判(保留原视角)
 */
export function applyDirector(
  plan: ChatPhotoPlan,
  patch: { written: Partial<Record<DirectorSlot, string>>; shot?: 'selfie' | 'third' | '' }
): ChatPhotoPlan {
  /* —— 视角变了就换一整套模板 ——
     这是 applyDirector 里唯一一处"重拼"而不是"打补丁"的地方,而且是必须的:
     视角决定的不是一句话,是 medium/camera/lens/light/env/noPeople/action 一整组。
     只换 camera 而留着自拍的 medium("shot on a phone front camera")会拼出一张
     自称自拍、却按第三人称取景的图。

     两个细节都不能省:
     - **第三位参数传的是"底稿自己认为的视角"**,不是 `plan.shot`。
       `plan.shot` 是已经解析过的结果,拿它当输入会把"场景写着 selfie"与
       "模板用了 selfie"这两种状态搅在一起 —— 一旦它等于 'scene',
       自拍模板就再也回不来了;
     - **锚点要原样带过去**。它由调用方保证不变(视角不该动"这个人是谁"),
       而重拼会把它丢在原来的 layers 里,所以这里得取回来重新拼一遍。 */
  const shot = !plan.self
    ? 'scene'
    : patch.shot === 'selfie' || patch.shot === 'third'
      ? patch.shot
      : plan.shot
  const base =
    shot === plan.shot
      ? plan
      : rebuildForShot(plan, shot)

  /* 场景已经覆盖的位:即便模型写了也不采用(见不变量 2)。
     判据与模板同一处 —— missingSlots 是"这一位空着吗"的唯一权威 */
  const miss = missingSlots(base.scene)
  const allowed: Record<DirectorSlot, boolean> = {
    /* 机位与纵深是无条件补的(见 missingSlots 的说明),所以永远接受 */
    camera: true,
    env: true,
    lens: miss.lens,
    light: miss.light
  }

  const layers: ChatLayer[] = base.layers.map(([slot, value]) => {
    if (!DIRECTOR_SLOTS.includes(slot as DirectorSlot)) return [slot, value] as ChatLayer
    const s = slot as DirectorSlot
    const written = patch.written[s]
    if (!allowed[s] || !written) return [slot, value] as ChatLayer
    return [slot, written] as ChatLayer
  })

  return { ...base, prompt: composeChatPrompt(layers), layers }
}

/** 换一套模板重拼,同时把锚点这一层原样带过去(见 applyDirector 的说明)。
 *
 *  取锚点的办法是**从原 layers 里读回来**,不是让调用方再传一次 ——
 *  chatPhoto 的 layers 本来就是"哪一层归谁管"的权威记录,让调用方
 *  另存一份 anchor 只会多一处会漂的状态。 */
function rebuildForShot(plan: ChatPhotoPlan, shot: ChatShot): ChatPhotoPlan {
  const anchor = plan.layers.find(([slot]) => slot === 'anchor')?.[1] || ''
  return planChatPhoto(plan.scene, plan.self, anchor, shot)
}

/** 给摄影指导模型的那段活。**纯字符串**,所以能直接断言口径。
 *
 *  —— 为什么这里说的是"画面里有没有人"而不是"这是自拍" ——
 *
 *  视角现在是**它要判的那件事**,不是我们告诉它的前提。告诉它"这是自拍,
 *  别改"就等于把它唯一有权做的那个判断也收回来了 —— 而它手上的信息
 *  比那个词表多(它看得到整个场景和用户那句话说的事)。
 *
 *  我们只交代**一件它推不出来的事实**:画面里有没有人。那来自聊天模型的
 *  `photoSelf`,是这个协议里唯一可信的判据 —— 一张"我看到的东西"里
 *  长出一个人,比视角选错严重得多。
 *
 *  "do not change it" 那一句是要紧的,但管的是**场景**,不是视角。 */
export function directorTask(plan: ChatPhotoPlan): string {
  const subject = plan.self
    ? 'The character is in this image.'
    : 'There is no character in this image — it is a shot of the place itself, and nobody may appear in it.'
  return [
    'Scene, exactly as it must appear in the image, do not rewrite it and do not change it:',
    plan.scene,
    '',
    subject,
    directorBrief(plan),
    '',
    'Now write the five lines. Decide Shot yourself from the scene and from what is said above.'
  ].join('\n')
}

/** 哪些位场景已经有着落了。**判据必须与 applyDirector 同一处**(missingSlots)——
 *  告诉模型"这几位留空"、却在合并时接受了一位,或者反过来,都会让模型白写一句 */
export function directorBrief(plan: ChatPhotoPlan): string {
  const miss = missingSlots(plan.scene)
  const covered: string[] = []
  if (!miss.lens) covered.push('Lens')
  if (!miss.light) covered.push('Light')
  return covered.length
    ? `The scene already covers: ${covered.join(', ')}. Leave those lines empty.`
    : 'The scene covers none of the four.'
}

