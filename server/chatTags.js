/* ===== 回复里的元数据标签 ==============================================
   模型产出不了情绪，也产出不了图片字节 —— 它只能产出**意图**。所以这两件事
   都做成"写在回复最末尾的一枚标签"，由这一层负责剪下来:

   - `[mood:amused]`  情绪。给界面出一枚药丸，也是朗读的语调
   - `[photo:pacing by a window at dawn]`  让它发一张图。这一枚只表达
     "想给你看什么"，真正出图在客户端(它才拿得到出图配置与参考图)

   三条纪律，缺一条就会漏给用户看:
   1. 剪取只认**末尾**那一枚 —— 正文中间出现方括号是正常文字，不该被吃掉;
   2. 流式期间半截标签必须**扣在手里**先不发(见 holdTail)，否则 `[pho` 会闪出来;
   3. 标签里的内容是**外部输入**(模型写的自由文本)。它会被拼进出图提示词，
      所以在这里就截断、压成一行 —— 越靠近边界收口越好。

   单独成文件是为了测得了:它没有 IO、没有状态，只有几个正则和几行字符串处理。
   -------------------------------------------------------------------- */

/** 情绪标签:回复最末尾那枚 [mood:xxx]。
 *  容忍空格与 = 号，也容忍后面跟一个句号:模型不总写得一丝不差 */
const MOOD_RE = /\[\s*mood\s*[:=]\s*([a-z][a-z-]{1,19})\s*\]\s*[.!?]?\s*$/i
/** 收在半截上的标签(用户按了 Stop，或上游断了)。
 *  这时候**只擦不取** —— "gu" 不是一个情绪，宁可这一轮不出那枚药丸，
 *  也不出一个错的;但留在正文里的半截标签必须擦掉，那纯粹是难看 */
/* 允许词本身也被截断(`[moo` / `[pho`)—— 但只认到 3 个字母,再短的
   (`[m` / `[p`)在正经文字里太常见,宁可漏一枚半截标签也不吃掉一句人话。
   流式期间其实轮不到它:尾巴是扣着发的(见 TAG_HOLD),只有"正好停在半个
   词上"的那一下(用户按 Stop)才会走到这儿 */
const MOOD_PARTIAL_RE = /\[\s*moo[\s\S]*$/i

/** 发图意图:回复最末尾那枚 [photo:<场景>]。
 *  与 mood 不同，它带的是**自由文本**而不是枚举值，所以这里只做形状约束:
 *  长度 1..120、不含方括号(否则会把下一枚标签一起吞进来)、不含换行 */
export const PHOTO_SCENE_CHARS = 120
const PHOTO_RE = new RegExp(
  `\\[\\s*photo\\s*[:=]\\s*([^\\[\\]\\n]{1,${PHOTO_SCENE_CHARS}}?)\\s*\\]\\s*[.!?]?\\s*$`,
  'i'
)
const PHOTO_PARTIAL_RE = /\[\s*pho[\s\S]*$/i

/** 把场景描述收敛成一行:连续空白压成一个空格，两端去空白，按上限截断 */
export function cleanScene(s) {
  return String(s || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, PHOTO_SCENE_CHARS)
}

/* 扣在手里先不发的尾巴长度。要盖得住**最长的那一枚标签**:
   `[mood:delighted]` 是 17 个字符，而 `[photo:` 那一枚能到 1+120+8 ≈ 130 —— 
   按 mood 定的 24 在这件事上远远不够。
   两枚标签可能同时出现(模型会把它们各写一行)，所以取两者之和再留一点余量;
   这个值只影响"最后这几个字符晚多久发出去"，不影响内容。 */
export const TAG_HOLD = 24 + PHOTO_SCENE_CHARS + 16

/**
 * 剪掉末尾的元数据标签。
 * @returns {{ text: string, mood: string, photo: string }}
 *   - text  真正要说的话(标签连同它前面那个换行一起收走)
 *   - mood  小写情绪词，空串表示这一轮没给
 *   - photo 场景描述(已收敛成一行)，空串表示这一轮不发图
 */
export function splitTags(s) {
  const str = s || ''

  const m = MOOD_RE.exec(str)
  if (m) {
    // 标签可能不止一枚:先剪 mood，再看剩下的尾巴里有没有 photo
    const head = str.slice(0, m.index).trimEnd()
    const p = PHOTO_RE.exec(head)
    if (p) return { text: head.slice(0, p.index).trimEnd(), mood: m[1].toLowerCase(), photo: cleanScene(p[1]) }
    return { text: head, mood: m[1].toLowerCase(), photo: '' }
  }

  const p = PHOTO_RE.exec(str)
  if (p) {
    const head = str.slice(0, p.index).trimEnd()
    const mm = MOOD_RE.exec(head)
    if (mm) {
      return { text: head.slice(0, mm.index).trimEnd(), mood: mm[1].toLowerCase(), photo: cleanScene(p[1]) }
    }
    return { text: head, mood: '', photo: cleanScene(p[1]) }
  }

  /* 两枚都没写全:把半截的擦掉、只擦不取。
     顺序上先看 photo —— 它的括号更长，半截的 mood 只可能出现在它之后 */
  const pp = PHOTO_PARTIAL_RE.exec(str)
  if (pp) return { text: str.slice(0, pp.index).trimEnd(), mood: '', photo: '' }
  const mp = MOOD_PARTIAL_RE.exec(str)
  if (mp) return { text: str.slice(0, mp.index).trimEnd(), mood: '', photo: '' }
  return { text: str, mood: '', photo: '' }
}
