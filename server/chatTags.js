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
   流式期间其实轮不到它:尾巴是扣着发的(见 tailHold),只有"正好停在半个
   词上"的那一下(用户按 Stop)才会走到这儿 */
const MOOD_PARTIAL_RE = /\[\s*moo[\s\S]*$/i

/** 发图意图:回复最末尾那枚 [photo:<场景>]。
 *  与 mood 不同，它带的是**自由文本**而不是枚举值，所以这里只做形状约束:
 *  长度 1..400、不含方括号(否则会把下一枚标签一起吞进来)、不含换行。
 *
 *  400 是 2026-10-04 从 120 放宽的:120 字的场景串只装得下"在哪",
 *  而时间/天气/周围有什么这些**只有聊天模型看得见**的信息一个都装不下 ——
 *  它们恰好是下游摄影指导最缺的输入(见 doc/角色配图构图与光影设计.md)。
 *  放宽之后正文的流式不受影响:扣尾是按"标签从哪开始"算的,不是按长度预留
 *  (见 tailHold)。 */
export const PHOTO_SCENE_CHARS = 400
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

/* —— 这一张里有没有它本人 ——
   有的图跟这个人长什么样无关(窗外的雨、桌上的咖啡)，有的图就是它自己。
   两者的出图条件正好相反:**带设定图**是"同一张脸"的唯一保证，而在一张风景里
   带上设定图，模型会被拽着往那个人的脸和衣服上靠 —— 画面跑偏。

   判据由模型自己写在标签里:`[photo:self:me on the balcony]` 表示它在画面里，
   不写前缀就是"它看到的东西"。为什么不让客户端猜:只有它知道自己在描述什么，
   而猜错的代价是双向的(风景里长出一个人 / 自拍画成陌生人)。

   认三种写法，都不要求它一丝不差:
   1. `self:` / `myself:` —— 纯标记，剪掉(它不是内容);
   2. `me:` / `me,` / `me -` —— 带分隔符的标记，剪掉;
   3. `me at my desk` / `I'm on the balcony` —— **代词本身是描述的一部分**，
      只置位不剪(剪掉就只剩 "at my desk"，画面里少了主语)。
   `\b` 保证 "meeting" / "selfish" 不会被误判成 me / self */
const SELF_STRIP_RE = /^\s*(?:self|myself)\b\s*[:：,，\-–—]?\s*/i
const SELF_MARK_RE = /^\s*(?:me|i\s*'?m|i\s+am)\b\s*[:：,，\-–—]\s*/i
const SELF_PLAIN_RE = /^\s*(?:me|i\s*'?m|i\s+am)\b/i
/** 模型偶尔会画蛇添足写个 scene: / view: —— 那不是内容，抹掉 */
const SCENE_PREFIX_RE = /^\s*(?:scene|view|no-?self)\s*[:：,，\-–—]\s*/i

/**
 * 拆出"场景 + 有没有它本人"。
 *
 * @param raw      标签里那段自由文本
 * @param charName 角色名。**描述里点了自己的名字**也算它在画面里 ——
 *                 这是给"没写 self: 前缀但显然在说自己"的那种回复兜底。
 *                 名字为空(没传)时这条不生效。
 * @returns {{ scene: string, self: boolean }}
 */
export function parsePhotoIntent(raw, charName = '') {
  const s = String(raw || '')
  let self = false
  let base = s

  const strip = SELF_STRIP_RE.exec(s)
  if (strip) {
    self = true
    base = s.slice(strip[0].length)
  } else {
    const marked = SELF_MARK_RE.exec(s)
    if (marked) {
      self = true
      base = s.slice(marked[0].length)
    } else if (SELF_PLAIN_RE.test(s)) {
      // 代词留在描述里(它是内容)，只置位
      self = true
    }
  }
  base = base.replace(SCENE_PREFIX_RE, '')

  const scene = cleanScene(base)
  const name = String(charName || '').trim().toLowerCase()
  const named = !!name && !!scene && scene.toLowerCase().includes(name)
  return { scene, self: self || named }
}

/**
 * 把**独占一行的**标签摘出来（不限于末尾）。
 *
 * —— 为什么还需要它 ——
 *
 * `splitTags` 只认**末尾**那一枚，那是为了不误吃正文里的方括号（`[注]`、`[1]`）。
 * 但模型并不总把标签写在最后：它会先写一句、再决定给你看张图、然后又补一句
 * 收尾的话 —— 于是那枚 `[photo:…]` 落在**中间**，`splitTags` 够不着，
 * 它会原样流给用户看（用户的原话是"为什么会有这种生成对话记录"）。
 *
 * 判据很窄，所以不会误伤：**这一行除了这枚标签什么都没有**。
 * 夹在句子中间、或者行里还有别的话的方括号，一律不碰（那是正文）。
 *
 * 与末尾那条路的分工：末尾的标签尾巴会被 `tailHold` 扣住、由 `splitTags` 收走，
 * 走不到这里；能走到这里的就是"被正文顶到中间去"的那几枚。
 *
 * @returns text 摘干净之后的正文；photo / mood 是顺手取出来的意图（没有就是空串）。
 *          同一类标签出现多次时**取第一枚** —— 它就是这一轮想说的事。
 */
export function stripStandaloneTags(s, charName = '') {
  const lines = String(s || '').split('\n')
  const kept = []
  let photo = ''
  let photoSelf = false
  let mood = ''
  let removed = false
  for (const line of lines) {
    const m = /^\[\s*(photo|mood)\s*[:=]\s*([^[\]]*?)\s*\]\s*[.!?]?$/i.exec(line.trim())
    if (!m) {
      kept.push(line)
      continue
    }
    const kind = m[1].toLowerCase()
    if (kind === 'photo') {
      if (!photo) {
        const shot = parsePhotoIntent(m[2], charName)
        photo = shot.scene
        photoSelf = shot.self
      }
    } else if (!mood) {
      mood = m[2].trim().toLowerCase()
    }
    /* 这一行整个吃掉 —— 连它那个换行一起（不然正文里会多出一行空白） */
    removed = true
  }
  /* 标签常常是**空行包着**写的。抽掉那一行之后剩下连着的空行要收一收,
     否则用户看到的是一段话、两个空行、再一段话(收成一段一处空行)。
     没抽掉任何东西时一个字都不动 —— 不借着这个机会去改别人的正文 */
  const text = removed ? kept.join('\n').replace(/\n{3,}/g, '\n\n') : kept.join('\n')
  return { text, photo, photoSelf, mood }
}

/* 一枚标签的**名字**。**必须与那两条正则认的前缀一致** ——
   放宽一处、这里不放宽,边界就会算错;收窄一处、这里不收窄,正文会被多扣一段。
   只写名字而不是整条正则:下面那个回溯是从末尾逐段剥,剥到哪一段不是标签就停 */
const PHOTO_NAME = 'photo'
const MOOD_NAME = 'mood'

/* 还没闭合的那一段:某个 `[` 之后既没有 `]` 也没有换行,一直延伸到末尾。
   它可能是"正在写"的标签(`[pho`、`[photo:self:me on the bal`),
   也可能只是一句人话里的方括号。

   用**贪婪**匹配取最后那个 `[`:未闭合只可能发生在末尾,取靠后的那个才不会
   把前面已经写完的标签一起卷进来(它们由 completeTagStart 负责)。

   这个候选**只有在没有完整标签可剥时才用得上** —— 见 tailHold 里的优先级。 */
const OPEN_TAIL_RE = /\[[^\]\n]*$/

/**
 * 这一截尾巴**可以放出去多长** —— 调用方发 `tail.slice(0, tailHold(tail))`,
 * 剩下那截留在手里。返回值 0 表示整截都还不能发。
 *
 * —— 要守住的不变量 ——
 *
 * 放出去的那一段里,**绝不能含有任何可能长成一枚标签的前缀**。
 * 用户看着 `[photo:self:me on the bal` 从聊天框里划过去,比图晚出来几秒难看得多。
 *
 * —— 为什么是"放到哪"而不是"扣多少" ——
 *
 * 前三版都在算"要扣住多少个字符",三版都漏了。"扣多少"这个量在标签开合之间
 * **不连续**:同一截缓冲,标签没闭合时要整段扣住,闭合之后又要放出去 ——
 * 而流到一半时根本无从判断它闭没闭合(整截缓冲**就是**那枚标签,
 * 后面还有没有正文只有流末才知道)。任何基于"闭合与否"的公式都会在那一瞬间放错。
 *
 * "放到哪"是连续的:它就是**末尾那枚标签的起点**。两个候选,有优先级:
 * 1. 末尾那几枚**已经长成形**的标签的起点(`completeTagStart`)—— 有它就返回它;
 * 2. 没有完整标签时,才看末尾那段**还没闭合**的 `[`(`OPEN_TAIL_RE`)。
 *
 * **不能把两者取更靠前的那个**:超长场景里末尾刚冒出一个 `[` 时,
 * 完整的标签还在它左边压着,而那个 `[` 因为落在正文中间没被剥干净 ——
 * 取 min 会选中它,等于把左边那枚完整标签整枚放了出去(探针抓到过)。
 *
 * —— 为什么边界要从末尾逐段剥出来 ——
 *
 * 早先这里是"从末尾往回读,允许跳过空白与标点"。那个启发式错在
 * **两枚标签相邻**的瞬间:`…balcony]` + `\n` + `[m` 里,剥 `[m` 时会把
 * 上一枚的 `]` 当成"末尾标点"跳过去,于是边界落在 `[m` 上 ——
 * 上一枚完整标签正好被挤进放出去的区间里。试出来的症状就是
 * 用户看见 `[photo:self:me on the balcony]` 从聊天框划过去。
 *
 * 所以不再猜:从末尾往前,**只在"这一段确实是一枚标签、而且它后面除了空白再无别的东西"
 * 时才继续剥**,剥不动就停 —— 边界就是停下的地方。
 *
 * @param buffer 还没发出去的那一截
 * @returns 可以放出去的长度(0 = 这一截全扣住)
 */
export function tailHold(buffer) {
  const s = String(buffer || '')
  /* 两个候选,前提写清楚:
     1. **末尾有已经长成形的标签** —— 边界就是它的起点。它一定比那个
        未闭合的 `[` 更靠左(后者在它右边),所以直接返回,不必再比;
     2. **没有完整标签** —— 才去看末尾那个还没闭合的 `[`。

     反过来"两个都算、取更靠左的那个"看着更稳,其实会错:超长场景里
     末尾刚冒出一个 `[` 时,完整的标签还在它左边压着没剥掉,
     而那个 `[` 因为落在正文中间(inner 里带换行)没被剥干净 ——
     取 min 会选中它,等于把左边那枚完整标签整枚放了出去。 */
  const closed = completeTagStart(s)
  const cut = closed >= 0 ? closed : (OPEN_TAIL_RE.exec(s)?.index ?? s.length)
  /* 再把末尾那段空白一起扣住 —— **它不是正文,而是"标签前面那个换行"**。
   *
   * 模型把标签写在单独一行,所以正文尾巴上总挂着一个 `\n`,而它**总是比标签先到**
   * (那时标签还没开这个头)。上面两条算出来的边界正好落在它后面,于是这个换行
   * 会被当成正文发出去 —— 界面上就是气泡底下多出一行空行
   * (`white-space: pre-wrap` 会把结尾的 `\n` 如实渲染出来),
   * 而收尾那次 `splitTags` 的 `trimEnd` 已经追不回来了:字早发出去了。
   *
   * 扣住它没有代价:后面一来非空白字符(或标签自己开了头),它就跟着放出去。
   * 代价只有一个:整条回复全是空白时什么都放不出去 —— 那本来也没有正文。 */
  let end = cut
  while (end > 0 && /\s/.test(s[end - 1])) end--
  return end
}

/** 末尾那几枚已经长成形的标签从哪开始。没有就返回 -1。
 *
 *  做法:**从右往左逐段剥**。每一轮取当前区段里最靠右的 `]`,
 *  找与它配对的 `[`,认它是不是一枚标签,然后把待处理区段收缩到它左边,
 *  直到某一段不是标签为止。
 *
 *  三处判断都不能省:
 * 1. `[` 与 `]` 之间必须**以标签名开头** —— 否则它只是正文里的一个方括号
 *    (`[1]`、`[注]` 都靠这一条挡掉);
 * 2. 这一段的**右边**只允许空白或另一枚正在长的标签(`isTagRoom`)——
 *    右边夹着正文就说明它不是"末尾的那一枚";
 * 3. `]` 要在**当前区段内**找,不能全局找。 */

/** 这一段是标签的话,它开头的名字是什么;不是标签就返回空串。
 *  判据只有名字 —— 正文段落不会以 `photo` / `mood` 开头 */
function head0(inner) {
  const h = inner.trim().toLowerCase()
  return h.startsWith(PHOTO_NAME) || h.startsWith(MOOD_NAME) ? h : ''
}

function completeTagStart(s) {
  let cut = -1
  let end = s.length
  /* 无限回溯的护栏:正常人话里不会连着十几枚标签 */
  for (let guard = 0; guard < 12; guard++) {
    const close = s.lastIndexOf(']', end - 1)
    if (close < 0) break
    const open = s.lastIndexOf('[', close)
    if (open < 0) break
    /* 这一段右边(到当前区段末尾为止)只允许空白与**标签名的部分前缀** ——
       后者正是"另一枚标签还没写完"的样子(`\n[m` 里的 `[m`)。
       出现别的可见字符就说明右边夹着正文,这一段不是末尾标签 */
    if (!isTagRoom(s.slice(close + 1, end))) break
    const inner = s.slice(open + 1, close)
    /* 内层方括号:说明这不是一枚标签,边界停在它这里 */
    if (inner.includes('[') || inner.includes(']')) break
    /* **刻意不检查换行** —— 场景描述本身就可能很长、还会带换行,
       任何"含换行就不是标签"的规则都会把合法标签判掉,边界于是跑到
       末尾那个没闭合的 `[` 上,把整枚标签放出去(探针抓到过两次)。
       跨行散文被误当成标签的风险由下面那条 `head` 判据挡住:
       正文段落不会以 `photo` / `mood` 开头。 */
    if (head0(inner) === '') break
    cut = open
    end = open
  }
  return cut
}

/** 这一段文字里是不是**只有标签结构**(没有正文)。
 *
 *  末尾往回剥的时候,已经剥掉的那部分右边常有东西,可能有两种:
 * - 一枚**已经写完**的标签 —— 剥到第二枚时就会看到它;
 * - 一枚**正在长**的标签头(`[m`、`[mood:t`、甚至只有一个 `[`)。
 *
 *  所以往右扫的时候,逐段吃掉"空白"或"一支标签段"。
 *
 *  —— 三种写法都试过,记下来免得再走一遍 ——
 *
 * 1. **逐字符判断**"`[` `]` `:` `=` 字母空白之外还有没有别的字符":
 *    简单,但区分不出 `[m`(标签头,该放行)与 `[1]`、`[注]`
 *    (正文里的方括号,该拦住);
 * 2. **只认完整标签**:漏掉 `[m`/`[` 这些"刚开个头"的形态,
 *    而它们恰恰是这个函数存在的理由;
 * 3. **要求名字后必须跟分隔符**:漏掉孤零零一个 `[`(它是下一枚标签的第一个字符,
 *    下一块增量来了才会接着长),而流式里这个瞬间每轮都会出现。
 *
 *  现在这版:名字与后面那整块都**可选**,`[photo]` 这种没有分隔符的仍然被当作正文
 *  —— 那是对的,splitTags 也不认它。 */
function isTagRoom(s) {
  let i = 0
  while (i < s.length) {
    if (/\s/.test(s[i])) {
      i++
      continue
    }
    /* 一支"标签段":`[` + 名字(可只写一半)+ 可选分隔符 + 可选内容(未闭合也行)。
       **分隔符与闭合方括号都不要求** —— gap 里出现的正是"下一枚刚写到一半"
       (`[m`、`[mood:ti`),要求它们会把这个函数变成"只认完整标签",
       而那样一来第二枚还没写完时,第一枚完整标签就会被当成正文放出去。

       **换行必须排除在内容之外** —— 不然 `[^\]]*` 会一路跨过换行,
       把"超长场景里第一个换行之前的那一段"也当成标签内容,
       于是它右边判成"没有正文",边界一路往左跑到前一枚标签前面。 */
    /* `\[` 之后那一整块整体可选 —— **孤零零一个 `[` 也是合法的标签开头**
       (它是下一枚标签的第一个字符,下一块增量来了才会接着长)。 */
    /* 内容里允许换行 —— 场景描述可能很长并带换行 */
    const tag = /^\[(?:(?:p(?:h(?:o(?:t(?:o)?)?)?)?|m(?:o(?:o(?:d)?)?)?)\s*[:=]?[^\]]*\]?)?/.exec(s.slice(i))
    if (tag) {
      i += tag[0].length
      continue
    }
    return false
  }
  return true
}

/**
 * 剪掉末尾的元数据标签。
 * @param s        整段回复
 * @param charName 角色名。只用于判断"这一张里有没有它本人"(见 parsePhotoIntent)——
 *                 传空也能用,只是少一条兜底判据
 * @returns {{ text: string, mood: string, photo: string, photoSelf: boolean }}
 *   - text      真正要说的话(标签连同它前面那个换行一起收走)
 *   - mood      小写情绪词，空串表示这一轮没给
 *   - photo     场景描述(已收敛成一行、已剪掉 self: 前缀)，空串表示这一轮不发图
 *   - photoSelf 这张图里有没有它本人。true 才把角色设定与设定图发给出图模型
 */
export function splitTags(s, charName = '') {
  const str = s || ''

  const m = MOOD_RE.exec(str)
  if (m) {
    // 标签可能不止一枚:先剪 mood，再看剩下的尾巴里有没有 photo
    const head = str.slice(0, m.index).trimEnd()
    const p = PHOTO_RE.exec(head)
    if (p) {
      const shot = parsePhotoIntent(p[1], charName)
      return {
        text: head.slice(0, p.index).trimEnd(),
        mood: m[1].toLowerCase(),
        photo: shot.scene,
        photoSelf: shot.self
      }
    }
    return { text: head, mood: m[1].toLowerCase(), photo: '', photoSelf: false }
  }

  const p = PHOTO_RE.exec(str)
  if (p) {
    const head = str.slice(0, p.index).trimEnd()
    const shot = parsePhotoIntent(p[1], charName)
    const mm = MOOD_RE.exec(head)
    if (mm) {
      return {
        text: head.slice(0, mm.index).trimEnd(),
        mood: mm[1].toLowerCase(),
        photo: shot.scene,
        photoSelf: shot.self
      }
    }
    return { text: head, mood: '', photo: shot.scene, photoSelf: shot.self }
  }

  /* 两枚都没写全:把半截的擦掉、只擦不取。
     顺序上先看 photo —— 它的括号更长，半截的 mood 只可能出现在它之后 */
  const pp = PHOTO_PARTIAL_RE.exec(str)
  if (pp) return { text: str.slice(0, pp.index).trimEnd(), mood: '', photo: '', photoSelf: false }
  const mp = MOOD_PARTIAL_RE.exec(str)
  if (mp) return { text: str.slice(0, mp.index).trimEnd(), mood: '', photo: '', photoSelf: false }
  /* 一枚标签都没有。**末尾空白照样收掉** —— 这里以前是原样返回,于是
     "模型忘了写标签、但结尾带了个换行"的回复会把那行空行留在气泡里。
     它与上面几条分支做的事其实是同一件:末尾的空白不是它要说的话 */
  return { text: str.trimEnd(), mood: '', photo: '', photoSelf: false }
}


