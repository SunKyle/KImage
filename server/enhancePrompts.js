/* 提示词改写 / 起稿 / 识图 / 摘要的系统提示与温度。
 *
 * 为什么单独一个文件:character 与 vision 那两段**引用** charSpec 的行清单,
 * 混在 2300 行的 server/index.js 里既不好找,也没法在单测里直接读
 * (那个文件一 import 就会连 dotenv、express、静态目录一起拉起来)。
 * 这里全是纯字符串与常量,零副作用,所以单测可以放心 import。
 * -------------------------------------------------------------------- */

import {
  CHAR_SPEC_LINE_COUNT,
  charSpecAlwaysSentence,
  charSpecLinesText
} from './charSpec.js'

/* 提示词改写的系统提示,三档:
   quick 保守补细节 —— 结构与主体一律不动,只把缺的画面要素补上;
   creative 允许重构 —— 换构图、光线、色调、风格,但不许换主体,
   否则改写会变成另一个需求,用户按了反而得重新写一遍;
   character 与上面两档不是一回事:它把一句话拆成可复用的角色设定。
   两档改写都限词数,回填到输入框还得能一眼读完。 */
const ENHANCE_PROMPTS = {
  quick: `You polish prompts for an image-generation model.

Rules:
- Output only the rewritten prompt. No preamble, no explanation, no quotes, no markdown.
- Keep the subject, the intent, any text to be rendered and the overall composition exactly as given.
- Add only what is missing and concrete: lighting, material, color, lens, mood.
- Never add new subjects, props or scene changes.
- Stay under 60 words, one paragraph.`,
  creative: `You reimagine prompts for an image-generation model.

Rules:
- Output only the rewritten prompt. No preamble, no explanation, no quotes, no markdown.
- Keep the subject, the intent and any text to be rendered exactly as given. Never swap the subject or change what the image is about.
- You may freely rework composition, framing, lighting, palette, materials, style and mood, and place the subject in a coherent setting.
- Prefer one strong visual direction over a pile of adjectives.
- Stay under 110 words, one paragraph.`,
  /* 拆角色设定用固定前缀而不是 JSON:少一整类"围栏/多余解释"的解析坑,
     而且人可以直接读懂回的是什么。标签用可读的多词写法,解析侧会把
     非字母去掉再查表,所以 "Nose & mouth" 也能对上。

     **那几行不写在这儿** —— 行清单、行数、必填枚举全部由 server/charSpec.js
     算出来(见那个文件顶上的说明)。这里只留"这一档独有的规则"。

     分两档是要紧的:有些字段编出来只是把描述写具体(好事,模糊才是漂移的源头),
     有些编出来等于改了这个角色是谁 —— 默认给每个人脸上添一道疤、或者按默认
     模板塞一身义体,是错的。所以后者只在原句真的提到时才写。 */
  character: `You turn a one-line idea into a reusable character spec for an image-generation model.

Rules:
- Output exactly ${CHAR_SPEC_LINE_COUNT} lines, in this order, and nothing else:
${charSpecLinesText('character')}
- The name must read as a name, not a description. Invent one that fits when the idea does not give a name.
- ${charSpecAlwaysSentence()} must always have a value. If the idea says nothing about one of them, invent something specific that fits the rest.
- Gender must be exactly the single word "female" or "male" — nothing else. Pick whichever fits the idea; when it says nothing, pick the one the rest of the description leans toward. It is the one field the image model cannot recover from the others.
- Style must be exactly one of the words listed for it — nothing else. Pick the medium the idea implies; use auto only when nothing in the idea points at one.
- Facial hair must always be stated explicitly, including when the answer is none. Leaving it blank makes the model guess differently in every image.
- Write "Face marks:" or "Marks:" with nothing after the colon when the idea gives no reason for them. Do not invent scars, tattoos or implants.
- Leave Language empty unless the idea actually says what language this character speaks. Never infer a language from a name, a nationality or how someone looks.
- Every appearance value (Style through Marks) is a short comma-separated phrase in English, under 12 words — except Style, which is a single word from its own list. The last five lines are not appearance — see below.
- Describe only the character itself. Never mention background, lighting, camera, lens or composition — the user supplies the scene separately.
- The last five lines describe how this character behaves in conversation, not how they look. Keep the two halves apart: never put behaviour into an appearance line, and never put appearance into a behaviour line.
- Those five are read by the model that will play this character, so write them as instructions it can follow. Language and Voice carry the most weight: get the language right, and make the way they talk concrete — a word they use for themselves, how long their sentences run — rather than a pile of adjectives.
- Unlike the appearance lines, the last five may quote words in the character's own language.
- No preamble, no explanation, no markdown, no quotes.`,
  /* 识图:输入是一张参考图,输出与 character 同一份行清单 ——
     解析侧(前端 parseCharacterDraft)因此完全不用改。
     与 character 的关键差别是"只写看得见的":文字起稿允许把没提到的东西编具体,
     而看图时凭空给一张脸上添疤、加义体,等于把用户上传的人改成另一个人。
     人格那几行(最后五行)是唯一的例外:图片里读不出一个人怎么说话,
     只能从穿着、站姿、神情去推 —— 所以那一段在提示里明确标成"推断",
     并要求写得平实,而不是替这个人编一段身世。

     **语言是例外里的例外**,所以它单独占一条规则:从长相推语言是这个功能里
     最容易滑向刻板印象的一步,而图里唯一站得住的证据是**真的出现了字**
     (招牌、徽章、制服、印字)。 */
  vision: `You look at a reference image of a person and write a reusable character spec for an image-generation model, describing exactly the person in it.

Rules:
- Output exactly ${CHAR_SPEC_LINE_COUNT} lines, in this order, and nothing else:
${charSpecLinesText('vision')}
- Read the image. Describe only what is actually visible in it: never invent scars, tattoos, implants, accessories or clothing that are not there.
- ${charSpecAlwaysSentence()} must always have a value. When the image is ambiguous about one of them, describe what is most likely rather than leaving it blank.
- Gender must be exactly the single word "female" or "male" — nothing else. Judge from how the person appears in the image.
- Style must be exactly one of the words listed for it — nothing else. Write the medium the image is actually drawn in; use auto only when the medium is genuinely unclear.
- Facial hair must always be stated explicitly, including when the answer is none.
- The name must read as a name, not a description. Invent one that fits the person when the image carries no name.
- Every appearance value (Style through Marks) is a short comma-separated phrase in English, under 12 words — except Style, which is a single word from its own list.
- Describe only the character itself. Never mention the background, the lighting, the camera, the lens or the composition of the reference image.
- The last five lines are the one place you go beyond what is visible: this is a still image, so how this person talks has to be inferred from how they look, dress, stand and hold themselves. Keep that inference plain and plausible — a voice that fits the picture, not a backstory you invented.
- Language is the exception even there: a still image rarely carries it. Write it only when the image itself shows it — a sign, a badge, a uniform or lettering — and leave it empty rather than guess from how someone looks.
- Never let behaviour leak into an appearance line, or appearance into a behaviour line.
- Unlike the appearance lines, the last five may quote words in the character's own language.
- No preamble, no explanation, no markdown, no quotes.`,
  /* 长期记忆的压缩:把一批滑出窗口的消息并进一段越来越短的简报。
     与上面几档都不同 —— 它产出的不是给人看的文本,而是之后会被塞回
     角色设定那个位置的一段"自我认知",所以写法要像简报,不像总结。
     反复强调"合并重写、不要追加"是要紧的:一旦变成追加,
     简报会随对话线性膨胀,最后比原文还长,而且最旧的信息永远压在底下 */
  summary: `You keep a running memory of a roleplay conversation between a user and the character that user is talking to.

Rules:
- Output only the updated memory. No preamble, no explanation, no quotes, no markdown.
- Write a compact briefing the character could read to catch up: who these two are to each other, what has happened, what was decided, what was promised, what is still unresolved.
- Keep names, places, objects, grudges, promises and anything the character would hold you to later. Drop small talk, pleasantries and anything that would not change a future reply.
- When you are given what you already remember, merge it with the new messages into one piece — rewrite and compress it. Never append to it, and never restate what is already covered.
- Stay under 200 words. When nothing important happened, a single sentence is the right answer.
- Write in English, but keep names, titles and terms in their original language.
- Write in the third person. Never write dialogue and never speak as either of them.`
}

// 改写强度:保守档给低温度,让它贴着原句走;重构档放开,否则出来的东西没差别。
// 拆角色要具体又不重复,取中间偏放开。识图要的是"照着图写",再放开就会开始编。
// 摘要要的是"忠实",温度再低也不过是变得啰嗦 —— 编出来的记忆比没有记忆更糟。
const ENHANCE_TEMPERATURE = {
  quick: 0.4,
  creative: 0.9,
  character: 0.7,
  vision: 0.4,
  summary: 0.3
}

export { ENHANCE_PROMPTS, ENHANCE_TEMPERATURE }
