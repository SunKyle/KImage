/* 对话里"角色发一张图"这一步的四个决定:
   ① 这张里有没有它本人(要不要拼外貌、要不要发参考图);
   ② 这一张是自拍、他拍还是空镜(镜头);
   ③ 拼进提示词的是"锚点句"还是那份全量设定表;
   ④ 这一张要不要补机位、光、环境 —— 以及**只补空着的位**。
 *
 *  —— 为什么这里不再是"场景 + 设定表"两个字符串相加 ——
 *
 *  从前这一层的产出是 `scene + ", " + characterFaceDesc`,即把外貌设定的
 *  二十个逗号短语整份接在场景后面。实测出来的图很死:平光、平视、居中、纯背景。
 *  原因不是模型不行,是那段提示词**只有"画什么"、没有"怎么拍"**:
 *  一个摄影师要拍出一张照片至少要定六件事(谁在拍、机位在哪、什么镜头、光从哪来、
 *  几点、背景有什么),而 120 字的场景串只回答了"在哪"。
 *  剩下的空位模型会自己补 —— 补出来的是它的缺省值,而死板正是缺省值的样子。
 *
 *  更隐蔽的一层:那份外貌清单不只在锁长相,它把**表情、姿态、机位一起锁住了**。
 *  "oval face, high cheekbones, ... clean-shaven"这种 token 密度下,模型最省力的
 *  解法就是交一张证件照 —— 而参考图恰好也是一张纯背景、中性表情、居中的证件照,
 *  两者互相加强。所以这一层的改法是**做减法**:只留几个不可变的身份特征
 *  (见 characterAnchor),把表情、姿态、光的方向、景深全部让出来。
 *
 *  —— 四层提示词,顺序不能反 ——
 *
 *      shot(这一张怎么拍) → scene(画的是什么) → anchor(是谁)
 *      → camera/light/environment(补空的位) → negative(挡证件照)
 *
 *  顺序既是权重也是语义:
 *  - shot 排最前是因为没有它,"自拍"就只是场景里的一个词。图像模型没有"自拍"
 *    这个概念,depth 上它只有"画一个人";能把"画一个人"掰成一张自拍的,
 *    是"前置摄像头 + 臂展 + 手入画 + 轻微广角"这几个具体的词。
 *  - scene 必须在 anchor 之前。反过来写等于把固定的长相顶在最前面,
 *    "这一张要画什么"被压到最后 —— 与 composedPrompt 是同一条纪律。
 *  - camera/light/environment 在 anchor 之后:它们修饰的是画面,不是这个人。
 *
 *  —— 只补不覆盖 ——
 *
 *  模板绝不能无脑写死 `warm afternoon light, shallow depth of field`。
 *  场景里已经写了 "at dusk, rain on the glass" 时,再塞一句暖光就是自相矛盾,
 *  模型会挑一处当噪声丢掉、或者把两者硬凑成一张谁都不像的图。
 *  所以模板只补**场景没说的**位(见 missingSlots);一个位推不出来时宁可留空 ——
 *  留空至少让出图模型按场景自己长,塞一个错的默认值比留空更糟。
 *
 *  抽出来还有一个实际理由:真正的出图要花钱、要联网、靠手测试不全,
 *  而上面每一条判据都是纯字符串处理,可以直接断言。
 */

import { sizeClosestTo } from '../api'

/** 拼给图模型的那一整段提示词的上限。
 *
 *  2026-10-04 从 1200 放宽到 6000:场景串的上限从 120 提到了 400
 *  (时间/天气/周围有什么 —— 那些只有聊天模型看得见的信息要写进去),
 *  锚点句那一层也可能上百字,几层相加很容易撞到 1200。而**截断发生在拼接的
 *  最后一步**,砍掉的正好是垫在末尾的负面约束(挡"证件照"那套默认构图的话)。
 *  放宽它不产生任何新调用,只是不再让最后那几层被无声吃掉。 */
export const CHAT_PHOTO_PROMPT_CHARS = 6000

/** 一张照片怎么拍。三档足够,再多就变成让聊天模型做摄影决定了(见下) */
export type ChatShot = 'selfie' | 'third' | 'scene'

/** 一层提示词:槽名 + 这一层的正文。槽名决定**这一位归谁管** ——
 *  摄影指导那一层只能改 camera / lens / light / env(见 lib/photoDirector),
 *  其余几个槽(medium / scene / anchor / action / negative)它连值都拿不到 */
export type ChatLayer = [string, string]

export interface ChatPhotoPlan {
  /** 真正发给上游的提示词。由 composeChatPrompt(layers) 拼出来 */
  prompt: string
  /** 要不要把角色的设定图/主参考图当参考图发出去 */
  useRefs: boolean
  /** 这一张怎么拍。调用方据它挑参考图与尺寸(自拍竖一点、空镜横一点)。
   *  **摄影指导有权改它** —— 见 lib/photoDirector 的 applyDirector */
  shot: ChatShot
  /** 它是不是在画面里。**这是聊天模型唯一回答的那件事**,
   *  存下来是因为摄影指导改视角时要重拼模板,而"画面里有没有人"是那道护栏:
   *  没有人时视角只能是空镜,谁都不许改成自拍(见 planChatPhoto 的 resolved) */
  self: boolean
  /** 收敛成一行之后的场景原文。摄影指导那一层要用它作输入,
   *  而它**永远原样进提示词** —— 谁都不许改写它 */
  scene: string
  /** 分层结构。摄影指导写回来的那几句要能逐位替换,所以必须留到这一层 */
  layers: ChatLayer[]
}

/* ===== 锚点句 =========================================================
 *  从结构化设定里只取**跨场景不该变、且模型光看图认不出来**的那几项。
 *
 *  为什么不能继续用全量的 characterFaceDesc:它把十几项平铺成同级权重,
 *  build 的"tall and lean"和 face 的"oval face"在模型眼里是同一层东西,
 *  而里面混着的 style(媒介)、facialHair(表情相关)、faceMarks(是否为空)
 *  一起构成了"档案照"的语境。这里只留身份,其余交给参考图。
 *
 *  **刻意不进锚点句的两项:**
 *  - style:它是"用哪种媒介画",属于第一层的介质,由 shotTemplate 给
 *    ("photographic")。两边都写会重复,而重复一旦措辞不一致,模型丢掉一个;
 *  - identity:"a night-shift nurse in a coastal town" 是**身份叙事,不是长相**。
 *    它进画面提示词会把模型引去做角色扮演式构图(制服、道具、环境全都跟着来),
 *    而"穿什么"本来就该由具体场景决定。要它出镜时由场景描述自己说。
 *
 *  上限定在 6 项:锚点句的用处是"给模型一个可锚的具体特征",不是把脸重述一遍。
 *  超过这个数之后,它又会变回那份 token 清单 —— 也就是这一层要治的东西。
 *
 *  **顺序就是取舍的优先级**(触到上限时从后往前丢):脸 → 头发 → 眼睛 → 眉毛 →
 *  鼻嘴 → 胡须 → 体型。眼睛、眉毛、鼻嘴靠前是因为它们对人脸识别的贡献最大;
 *  体型垫底,因为它是唯一一项"在大部分近景里根本看不见"的特征,而且参考图里
 *  那张全身像本来就在管它。
 *
 *  上限定在 7(= 上面那张清单的长度):锚点句的用处是"给模型一个可锚的具体特征",
 *  不是把脸重述一遍。再多就又会变回那份 token 清单 —— 也就是这一层要治的东西。
 *  ==================================================================== */
const ANCHOR_KEYS = ['face', 'hair', 'eyes', 'brows', 'noseMouth', 'facialHair', 'build'] as const
const ANCHOR_MAX = ANCHOR_KEYS.length

function inline(s: string | undefined): string {
  return (s || '').replace(/\s+/g, ' ').trim()
}

/**
 * 角色设定 → 一小段身份锚点句。
 *
 * 入参刻意只声明"有一个 fields"而不是 import Character:这个模块是纯函数层,
 * 少一个类型依赖就少一圈耦合。任何带 fields 的角色卡都能直接传进来。
 *
 * @returns 逗号分隔、最多 5 项;没有结构化字段(加字段之前的老角色)时返回空串 ——
 *          那种角色仍然靠参考图锁脸,而不是退回全量描述。
 *          **这里不退回 characterFaceDesc 是有意的**:老角色的 desc 里什么都有
 *          (身份、性格、穿什么),把它当锚点句用等于把治好的病再请回来。
 */
export function characterAnchor(c: { fields?: unknown } | undefined): string {
  const f = c?.fields as Record<string, unknown> | undefined
  if (!f || typeof f !== 'object') return ''
  return ANCHOR_KEYS.map((k) => inline(typeof f[k] === 'string' ? (f[k] as string) : ''))
    .filter(Boolean)
    .slice(0, ANCHOR_MAX)
    .join(', ')
}

/* ===== 场景里已经说了什么 =============================================
 *  模板"只补不覆盖"的全部依据。宁可漏判(以为没写、于是补一句)也不能误判,
 *  所以词表取窄:只认那些**一旦出现就基本可以确定**该位已有内容的词。
 *
 *  为什么同时认中英文:这张图的场景串是聊天模型写的,它跟着用户的语言走
 *  (见 CHAT_RULES 的"用用户那种语言"一条),中文对话里就是中文串。
 *  ==================================================================== */
function mentions(text: string, en: RegExp, zh: string[]): boolean {
  /* 英文用词边界(免得 "sunny" 被判成 sun、"lens" 被判成"提到镜头");
     中文没有词边界,子串命中即可 —— 中文里"黄昏"出现在任何位置都是黄昏 */
  if (en.test(text)) return true
  return zh.some((w) => text.includes(w))
}

/** 光:已经写了光就不补 —— 这是"只补不覆盖"里最要紧的一位 */
const LIGHT_RE = /\b(light|lighting|lit|glow|glowing|backlit|rim light|silhouette|shadow|shadows|sunlight|moonlight|lamp|lantern|candle|neon|beam)\b/i
const LIGHT_ZH = ['光', '灯光', '阳光', '月光', '影子', '阴影', '逆光', '烛光', '霓虹', '照亮']

/** 镜头/景深:已经写了就不补,免得两个焦段打架 */
const LENS_RE = /\b(lens|focal|\d{2,3}\s*mm|bokeh|depth of field|shallow focus|blurred|blurry|out of focus|telephoto|wide[- ]angle|macro|close[- ]up)\b/i
const LENS_ZH = ['镜头', '焦段', '景深', '虚化', '模糊', '广角', '长焦', '特写']

export interface SceneSlots {
  light: boolean
  lens: boolean
}

/**
 * 场景串里还没给出的位。模板只补 true 的那几个。
 *
 *  **为什么没有"环境"这一位**:环境是**事实**,该由场景自己说("在阳台"),
 *  而"前景 / 中景 / 远景"是**相机原理**,两者不冲突 —— 场景说了地点,
 *  照样需要一句"画面要有纵深"(那正是"人和环境融不进去"的药)。
 *  把纵深也做成"没说才补",结果是几乎每个场景都提过窗、桌、墙,
 *  于是这一句永远不出现,等于没有。
 *
 *  **也没有"时间/天气"**:那两样是事实,不是修辞。场景没说几点,
 *  模板猜"黄昏"就可能和对话里的时间矛盾(它明明在值夜班)。
 *  能推的只有一件事:已经在下雨时,补一句"湿的地方反光" —— 那是天气的**必然推论**,
 *  不是新事实(见 isWet 与模板的 lightWet)。
 */
export function missingSlots(scene: string): SceneSlots {
  const t = String(scene || '')
  return {
    light: !mentions(t, LIGHT_RE, LIGHT_ZH),
    lens: !mentions(t, LENS_RE, LENS_ZH)
  }
}

/** 场景里在下雨/下雪吗。只用来决定要不要补"湿处反光"那一句 */
const WET_RE = /\b(rain|rainy|raining|drizzle|snow|snowy|sleet|hail|wet|puddle|splash)\b/i
const WET_ZH = ['雨', '雪', '冰雹', '湿', '水洼', '积水']

export function isWet(scene: string): boolean {
  return mentions(String(scene || ''), WET_RE, WET_ZH)
}

/* ===== 三套镜头模板 ===================================================
 *  两条机位句是这一层存在的理由:**图像模型没有"自拍"这个概念**,
 *  它只有"画一个人"。能把"画一个人"掰成一张自拍的,是下面这几个具体的词。
 *
 *  每一句都写成"缺省值"而不是"必须出现":调用方按 missingSlots 逐位决定要不要。
 *  lens 那句在自拍/他拍两档都出现,是因为景深决定了**人和环境贴不贴**——
 *  这正是"人物与环境融不进去"的一半原因。
 *  ==================================================================== */
const NEGATIVE =
  'not a character sheet, not a passport or ID photo, not centered neutral expression, not flat lighting'

interface ShotTemplate {
  medium: string
  /** 机位。自拍与第三人称差别最大的就是这一句 */
  camera: string
  lens: string
  light: string
  /** 场景里已经在下雨/下雪时改用这一句:只补"湿处反光"这个必然推论,不编新事实 */
  lightWet: string
  /** 纵深。**不是"没说才补"** —— 它是相机原理,与场景说了什么地点无关 */
  env: string
  /** 这个人此刻在做什么。只在场景没交代动作时补 —— 补错了比不补更糟 */
  action?: string
  /** "画面里没有人"这条硬约束。**只有空镜有** ——
   *  它不并进 camera 是因为摄影指导会整句换掉 camera(见 lib/photoDirector),
   *  而这一条是空镜唯一挡得住"风景里长出一个人"的东西 */
  noPeople?: string
}

const TEMPLATES: Record<ChatShot, ShotTemplate> = {
  /* 自拍:关键是"相机在它手上"。前置摄像头、臂展距离、手臂入画、
     轻微广角畸变 —— 这四个词缺一个,模型就会退回第三人称的构图 */
  selfie: {
    medium: 'photographic, shot on a phone front camera',
    camera:
      'selfie taken at arm\u2019s length, front camera, face and shoulders filling the upper half of the frame, slight wide-angle distortion, the arm holding the phone partly visible in frame',
    lens: 'shallow depth of field, background softly out of focus',
    /* 自拍的光必须落在脸上 —— 手臂挡不住的那种环境光 */
    light: 'natural light falling on the face and lighting it from one side, unposed',
    lightWet: 'overcast light with wet reflections catching on every surface, the face softly lit by it',
    env: 'the place clearly readable right behind the shoulders, close enough to touch',
    action: 'mid-moment, looking into the camera'
  },
  /* 他拍:关键是"相机不在它手上",而且环境要有纵深。
     前景遮挡 / 中景主体 / 光源在画面里可见 —— 这三样是"人和环境融在一起"的配方 */
  third: {
    medium: 'photographic',
    camera:
      'third-person view, camera not held by the subject, eye-level, subject off-center, generous headroom, full figure and hands inside the frame',
    lens: 'shallow depth of field separating the subject from the background',
    light: 'directional light with a clear source, one side of the face brighter than the other',
    lightWet: 'soft overcast light with wet reflections on the ground and walls, the subject rimmed by it',
    env: 'the scene layered with depth: something in the foreground, the subject in the middle, the rest falling away behind',
    action: 'caught mid-movement, unaware of the camera'
  },
  /* 空镜:画面里没有它本人(见 photoSelf)。模板只管"这是一张照片"与景深,
     一个字都不许提到人 —— 提到就是把"风景里凭空长出一个人"请回来 */
  scene: {
    medium: 'photographic',
    /* **"没有人"单独成一层,不并进 camera** —— 摄影指导会整句换掉 camera,
       而这一条是空镜唯一的挡人防线:换掉它就有可能在空镜里长出一个人。
       见 planChatPhoto 里那一层的槽名 */
    noPeople: 'a single unposed shot of the place itself, no people in frame',
    camera: 'the camera set down or held steady, an ordinary vantage point on the place',
    lens: 'shallow depth of field with a soft, readable foreground',
    light: 'light from a visible source, falling across the scene',
    lightWet: 'overcast light with wet reflections catching on every surface',
    env: 'depth in the frame: foreground, middle ground, and something further back'
  }
}

/* ===== 拼装 =========================================================== */

/* 场景里已经交代了动作时,别再补一句"它在做什么" —— 两句会互相打架。
   词表取"人在动"的那类,窄一点:宁可漏判也不误判(漏判的代价是多一句动作提示,
   误判的代价是把它正在做的事改掉) */
const ACTION_RE = /\b(holding|sitting|standing|leaning|walking|lying|looking|smiling|laughing|drinking|smoking|reading|typing|cooking|reaching|waving|turning|dancing|running|waiting)\b/i
const ACTION_ZH = ['拿着', '坐着', '站着', '靠着', '倚着', '走着', '躺着', '看着', '望着', '笑着', '喝着', '抽着', '读着', '正在', '转头', '挥手']

function hasAction(scene: string): boolean {
  return mentions(scene, ACTION_RE, ACTION_ZH)
}

/**
 * 这一张该怎么拼。
 *
 * @param scene  模型给的场景描述(已由 server/chatTags.js 收敛成一行)
 * @param self   它是不是在画面里。**这是聊天模型唯一要回答的那件事** ——
 *               它可靠地知道"我在不在画面里";而"这张照片该谁拿相机"是摄影判断,
 *               不该由它顺手写进标签(见下)
 * @param anchor 角色的身份锚点句(characterAnchor)。空串表示这个角色没填过设定 ——
 *               这时**不要**退回全量描述,参考图仍然锁得住脸
 * @param shot   **这一张怎么拍。不传就现认一个**
 *
 * —— 视角是谁定的 ——
 *
 * `self` 只回答"画面里有没有人",回答不了"谁拿的相机":人在画面里既可能是自拍,
 * 也可能是别人拍的。从前这里是拿 isSelfie() 的词表去场景串里找"自拍"这两个字,
 * 找不到就当第三人称 —— 那等于**用比模型更少的信息替模型做判断**,
 * 而这个判断随后还被当成事实告诉摄影指导("这是第三人称,别改"),它连纠正的机会都没有。
 *
 * 现在视角归摄影指导(见 lib/photoDirector 的 parseDirector / applyDirector),
 * 这个参数就是那个分工的接口:传了就用它(摄影指导判出来的),
 * 不传就退回词表 —— 那是**没有摄影指导时的降级路径**,不是主路径。
 * 词表仍然有用:它认得准明确写了"自拍"的场景,而那种场景恰好是猜错代价最大的。
 */
export function planChatPhoto(
  scene: string,
  self: boolean,
  anchor = '',
  shot?: ChatShot
): ChatPhotoPlan {
  const text = String(scene || '')
    .replace(/\s+/g, ' ')
    .trim()
  /* 没有场景就没有要画的东西。这里先收口,免得拼出 "photographic, oval face, …"
     这种只剩外貌的提示词 —— 那会画出一张没有场景的人像,而调用方本该放弃这一张 */
  if (!text) return { prompt: '', useRefs: false, shot: 'scene', self, scene: '', layers: [] }

  /* 画面里没有人时视角只能是空镜:**由 self 定死,不由任何人推断** ——
     一张"我看到的东西"里长出一个人,比视角选错严重得多 */
  const resolved: ChatShot = !self
    ? 'scene'
    : shot === 'selfie' || shot === 'third'
      ? shot
      : isSelfie(text)
        ? 'selfie'
        : 'third'
  const tpl = TEMPLATES[resolved]
  const miss = missingSlots(text)
  const spec = inline(anchor)

  /* —— 分层是要紧的,不是排版 ——
     每一层前面那句都是**这一位归谁管**的标记:
     `medium` / `scene` / `anchor` / `negative` 不在 DIRECTOR_SLOTS 里,
     所以摄影指导那一层(见 photoDirector.applyDirector)结构上就改不到它们。
     场景原文进 layers 时带的是 `scene` 槽 —— 它永远原样保留,不改写 */
  const layers: ChatLayer[] = [
    ['medium', tpl.medium],
    ['scene', text]
  ]
  /* 锚点句排在场景之后:它是"这个人是谁"的约束,不是这一张的内容。
     只有它在画面里时才拼 —— 这正是把风景画成人的原因(见文件头) */
  if (self && spec) layers.push(['anchor', spec])
  /* 空镜那句"没有人"垫在机位之前,而且是独立一层(见 ShotTemplate.noPeople):
     摄影指导换得掉 camera,换不掉这一层 */
  if (tpl.noPeople) layers.push(['noPeople', tpl.noPeople])
  layers.push(['camera', tpl.camera])
  if (miss.lens) layers.push(['lens', tpl.lens])
  if (miss.light) {
    /* 场景没说光时,先看它说没说不好的天气:下雨/下雪是**已经给出的事实**,
       而"湿的地方反光"是这个事实的必然推论 —— 补它不算替场景编新事实,
       却正好把光带进画面(阴天平光下,这是最容易丢的一种光) */
    layers.push(['light', isWet(text) ? tpl.lightWet : tpl.light])
  }
  /* 纵深是无条件的(见 missingSlots 的说明):它不是事实,是相机原理,
     场景说了地点照样需要这一句 —— 而它正是"人和环境融不进去"的药 */
  layers.push(['env', tpl.env])
  /* 动作只在场景真的没交代时才补。补出来的动作是模板的猜测,
     而它比光和环境更容易和场景矛盾(场景说"靠栏杆",模板说"走在路上") */
  if (tpl.action && !hasAction(text)) layers.push(['action', tpl.action])
  /* 负面约束垫在最后:它挡的是"证件照"那套默认构图,不是内容本身 */
  layers.push(['negative', NEGATIVE])

  return {
    prompt: composeChatPrompt(layers),
    /* 参考图与外貌设定同一个开关:场景照不带参考图 —— 它跟"同一张脸"无关 */
    useRefs: self,
    shot: resolved,
    self,
    scene: text,
    layers
  }
}

/** 分层 → 发出去的提示词。顺序就是权重(见文件头),空值丢掉不留空逗号 */
/* ===== 对话背景图 =====================================================
 *  沉浸页铺满屏幕的那一张。**它与"角色发的那张图"是两件事**:
 *  - 它不进消息流,所以不该按"随手拍给人的"那种形状拼 —— 它是一张**给字让位的底**;
 *  - 它要横构图、主体靠右、左边留出暗而干净的余地。参考图那一屏能读,
 *    靠的就是这个构图(而不是把照片糊掉 —— 那条路走过,把"这一场戏"整个糊没了);
 *  - 它按"当前这一场戏"生成,换一场就该换一张(编排见 App 的 ensureBackdrop)。
 *
 *  与设定图、参考图、消息里的图**各存各的**(见 idb.ts 的 chat_backdrops)-
 *  用户特意交代过:它是一份单独的图,不该和那几样混在一起。
 */
export function planChatBackdrop(scene: string, anchor = ''): ChatPhotoPlan {
  const text = inline(scene)
  /* 没有场景就没有"这一场"可画。调用方据此放弃这一张,而不是画一张没有场景的人像 */
  if (!text) return { prompt: '', useRefs: false, shot: 'scene', self: true, scene: '', layers: [] }
  const spec = inline(anchor)
  const layers: ChatLayer[] = [
    ['medium', 'cinematic film still, wide landscape framing, made to sit behind text'],
    ['scene', text]
  ]
  /* 锚点句垫在场景之后:它是"这个人是谁"的约束,不是这一张的内容 */
  if (spec) layers.push(['anchor', spec])
  layers.push([
    'camera',
    'the subject stands in the right third of the frame at a medium distance, ' +
      'facing left into the empty half, the left two thirds of the frame fall into ' +
      'shadow and stay uncluttered \u2014 words are read there, the camera is off to their left'
  ])
  layers.push(['lens', 'shallow depth of field, the room falling away behind them'])
  layers.push([
    'light',
    'low natural light, the brightest part of the frame is on the right near the subject'
  ])
  layers.push([
    'env',
    'the place readable around them and deep enough to feel like a room, not a studio backdrop'
  ])
  /* 负面约束垫在最末:它挡的正是"证件照"那套默认构图,再补上背景图独有的两条 */
  layers.push([
    'negative',
    `${NEGATIVE}, no text, no watermark, no caption, no bright cluttered left side, ` +
      'the subject is not centred and not on the left half of the frame'
  ])
  return {
    prompt: composeChatPrompt(layers),
    useRefs: true,
    shot: 'scene',
    self: true,
    scene: text,
    layers
  }
}

export function composeChatPrompt(layers: ChatLayer[]): string {
  return layers
    .map(([, value]) => value)
    .filter(Boolean)
    .join(', ')
    .slice(0, CHAT_PHOTO_PROMPT_CHARS)
}

/* —— 这一张是不是自拍 ——
 *  判据只在场景文本里。`photoSelf` 那个布尔回答不了这件事:它只说"它在画面里",
 *  而"在画面里"既可能是自拍,也可能是别人拍的。
 *
 *  词表同样取窄:只认**明确是自拍**的说法,认不出就当第三人称。
 *  这个方向的默认值是有意的 —— 猜错成自拍的代价(一张举着手机的怪图)比
 *  猜错成他拍(一张正常的照片,只是不像自拍)更大。
 *
 *  例:"taking a selfie" → 自拍;"me on the balcony" → 他拍;
 *      "自拍一张给你看" → 自拍;"我在阳台" → 他拍。 */
const SELFIE_RE = /\b(selfie|self-portrait|front camera|holding (?:my|the) phone|mirror shot|wefie)\b/i
const SELFIE_ZH = ['自拍', '自拍照', '对着镜头拍', '举着手机拍', '前置摄像头']

export function isSelfie(scene: string): boolean {
  return mentions(String(scene || ''), SELFIE_RE, SELFIE_ZH)
}

/* ===== 尺寸与参考图 ===================================================
 *  两个查表,由 shot 决定。它们放在这里而不是调用方,是因为"自拍该竖一点"
 *  与"全身该用全身那张参考图"是同一个决定的两种表现 —— 都属于"这一张怎么拍"。
 *  ==================================================================== */

/** 这一张想要的画幅比例(宽/高)。挑尺寸时按它找最接近的一档 */
export function shotRatio(shot: ChatShot): number {
  /* 有人竖、空镜横。方框是两者都不想选时的兜底,不是默认 */
  if (shot === 'scene') return 3 / 2
  return 2 / 3
}

/** 参考图按镜头挑:先取哪张视图、再按什么顺序补。
 *  自拍/半身以正面为主(它就是要看正脸),全身那张打头才交代得住体型与服装轮廓。
 *  值必须与 types.ts 的 CharacterViewKind 一致 —— 写错一个键不会报错,
 *  只会静静地少一张参考图(所以单测直接断言这张表) */
export function shotViewOrder(shot: ChatShot): string[] {
  if (shot === 'third') return ['full', 'front', 'detail', 'closeups', 'expression']
  return ['front', 'closeups', 'detail', 'full', 'expression']
}

/** 挑不出任何一档比例时的兜底:交给上游自己定 */
export const CHAT_PHOTO_SIZE_FALLBACK = 'auto'

/**
 * 这一张该发什么尺寸。
 *
 * 为什么不能继续用 `sizeForVendor(cfg, 'auto')`:那条路对只认固定枚举的厂商
 * 会退到 `allowed[0]`,通常是 1024×1024 —— 横着拍的窗、竖着站的人全被塞进方框。
 * 这张图该多大由**场景**决定,而 shot 就是场景的类型。
 *
 * @param candidates 厂商不认尺寸时给的那组常用值(api.ts 的 FREE_SIZES),
 *                   当前实现里不会走到(见下),留着是为了调用方能看着一处读完整条判断
 *
 * 两条取舍:
 * 1. **不挑 'auto'**。'auto' 是"上游自己定比例",而这张图的取景正是我们在决定的
 *    东西 —— 挑回 'auto' 等于把自己刚做的决定又交出去。所以先在去掉 'auto' 的
 *    候选里按比例挑;只有**一个显式比例都没有**时才退回 'auto'(那时确实没得挑)。
 * 2. 空字符串返回 'auto' 而不是 '' —— 调用方据此发请求,不该发一个空值出去。
 */
export function chatPhotoSize(allowed: string[], shot: ChatShot, autoOk: boolean): string {
  const list = Array.isArray(allowed) ? allowed : []
  const explicit = list.filter((s) => /^\d{1,5}x\d{1,5}$/i.test(String(s)))
  const best = sizeClosestTo(explicit, shotRatio(shot))
  if (best) return best
  /* 一个显式比例都没有:认 auto 的厂商就交给它,不认的用第一档兜底 */
  return autoOk && list.includes(CHAT_PHOTO_SIZE_FALLBACK)
    ? CHAT_PHOTO_SIZE_FALLBACK
    : list[0] || CHAT_PHOTO_SIZE_FALLBACK
}
