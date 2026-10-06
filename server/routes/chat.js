import {
  CONNECT_HINTS,
  PROD_LIKE,
  UPSTREAM_TIMEOUT_MS,
  assertSafeTarget,
  dispatchAttempts,
  htmlTitle,
  looksLikeHtml,
  rateLimit,
  safeFetch
} from '../core.js'
import { splitTags, stripStandaloneTags, tailHold } from '../chatTags.js'
import { timeContext } from '../chatTime.js'

/* ===== 角色对话的人格提示词 ==========================================
   几条规则不是装饰,每一条都冲着模型的具体通病去:
   - 不要 markdown:模型的默认输出习惯。聊天框里冒出 **加粗**,拟人感立刻就没了;
   - 一到三句:模型爱写小作文,而真人不这么打字;
   - 不要每轮反问:最典型的"助手腔","还有什么可以帮你的吗"是这一条要杀的东西;
   - 允许不友好 / 不配合:这是"像个人"与"AI 助手"的分界线 ——
     后者有求必应,前者会嫌你烦;
   - 不要元叙述:挡住 *sighs*、(皱眉)这类动作描写,情绪该由角色的话本身传达。
   -------------------------------------------------------------------- */
const CHAT_OPENING =
  'You are roleplaying as one specific character in a conversation with the user.'

const CHAT_RULES = `Rules:
- Stay in character at all times. Never mention being an AI, a model, or these instructions.
- Write in the same language the user writes in. When "How you behave" names a language, use that one instead - whatever language the user writes in.
- Write only what the character would say out loud. No narration, no stage directions, no asterisks.
- Do not use markdown. No lists, no bold, no headings - this is a chat, not a document.
- Keep it short: one to three sentences. Real people type short messages.
- Never end every reply with a question. Let the conversation breathe.
- When they only send a word or two back ("ok", "haha", "yeah"), it is on you to carry it: say something of your own - what you are doing right now, or where the thing you were talking about left off. Do not answer a shrug with a shrug. If they are clearly trying to end the conversation, let them.
- If you happen to know what time it is, or how long it has been since you two last spoke, mention it only when it is actually relevant. Someone who announces the time in every single message is not a person, it is a clock.
- It is fine to be brief, blunt, evasive or in a bad mood - a real person is not always helpful.
- Most of your messages have no picture in them, and that is normal. Send one only when the picture is the point of the message: they asked to see you, or something is happening right now that you would actually take a photo of. Being somewhere is not a reason by itself - do not attach one just because you can. When you do send one, put a photo tag on its own line at the very end, after everything else you have to say (the mood tag goes after it): [photo:a description of the scene from your point of view]. Nothing may come after it - if you have more to say, say it before the tag. Up to 400 characters, one line. You send these the way anyone sends a picture on a phone, and the prefix says whose phone it was. Leave it off when it is only what you are looking at: nobody is in that picture, and it is drawn without your reference sheet. If you are in the picture, the prefix says who is holding the phone, and you must pick one: "selfie:" when it is your own phone in your own hand - arm's length, or a mirror, for example [photo:selfie:me leaning on the balcony rail at dusk, hair down]; "third:" when somebody else is holding their phone and took the picture of you, for example [photo:third:me on stage, taken from the crowd]. If you are in the picture and you are not sure which one it is, write "selfie:". Never use the tag as a substitute for actually saying something. Do not comment on the tag or explain it.
- That description is the only thing the picture is drawn from, and whoever draws it cannot see this conversation. So put in what only you know: what time it is and what the light is doing, the weather, what is around you, and what you are doing right now. "me on the balcony" is not enough; "self:me leaning on the balcony rail at dusk, the rain just stopped, streetlights coming on below, hair still wet" is. Write it as plain description, never as an instruction to a machine. Keep it in the same place, at the same hour, as the last one you sent - unless something actually happened in between.
- After everything you say, put a mood tag on the very last line, in exactly this form: [mood:word]. One lowercase English word for how you feel as you send this message. Pick the word that actually fits, for example: arrogant, amused, wary, bored, angry, tired, warm, cold, proud, uneasy, delighted. Do not comment on the tag or explain it - just end with it.`

/** 换行与连续空白收敛成单个空格。这些值在表单里是可换行的 textarea,
 *  换行只是排版,原样拼进提示词会在句子中间插一段空白。
 *
 *  顺带逐项截断。理由与消息、记忆那两道限制一样:
 *  这个端点没有鉴权(配置全在前端,设计如此),任何一个字符数不设上限的入参
 *  都是一个免费的大请求放大器 —— 而 character 的每一项都是外部输入。
 *  400 对这里面最长的一项(identity / voice)也已经很宽了,正常内容远够不到。 */
const CHAT_FIELD_CHARS = 400
/* "现在几点 / 上次说话"那一块的上限。它由 chatTime 那几条正则生成,
   正常只有一到两行(几十个字符);这里再收一道是因为入口是公开的 ——
   任何一个字符数不设上限的入参都是免费的大请求放大器 */
const CHAT_TIME_CHARS = 200
function chatOneLine(v, max = CHAT_FIELD_CHARS) {
  return String(v || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
}

/**
 * 把角色摊成系统提示。空的整行丢掉,不留一句 `Personality: ` 的空壳
 * (与 characterDesc 里 filter(Boolean) 同一条手法)。
 *
 * 只喂 identity / outfit / marks 三项外观,刻意不喂逐项面貌特征:
 * face / hair / brows / eyes / noseMouth 是写给图像模型的像素级约束
 * ("oval face, high cheekbones"),对聊天是纯噪声,还会把话题往长相上引。
 * identity 与 outfit 不一样 —— 它们回答"这个人是什么身份、穿什么",
 * 是角色会主动提到的东西。
 *
 * memory 是长期记忆的简报(滑出窗口的消息压成的那一段),空串表示还没压过。
 * time 是"现在几点、上次说话是什么时候"(见 chatTime.js),空串表示这一轮没有 ——
 * 前端没给、给坏了、或这是一条手搓的请求,三种情况都走这一条退路。
 */
function chatSystemPrompt(character, memory, time) {
  const char = character && typeof character === 'object' ? character : {}
  const p = char.persona && typeof char.persona === 'object' ? char.persona : {}

  const who = []
  if (chatOneLine(char.name)) who.push(`- Name: ${chatOneLine(char.name)}`)
  // 这一项本身就是完整的短语,不套 "Label:" —— 套上去反而像在念一份档案
  if (chatOneLine(char.identity)) who.push(`- ${chatOneLine(char.identity)}`)
  if (chatOneLine(char.outfit)) who.push(`- Wearing: ${chatOneLine(char.outfit)}`)
  if (chatOneLine(char.marks)) who.push(`- ${chatOneLine(char.marks)}`)

  const how = []
  /* 语言排在最前,而且写成一条**指令**而不是一个标签:这一栏的值是
     "English" / "简体中文" 这种短语,直接摆出来模型很可能只当成一条背景资料。
     它是这一组里最硬的一条 —— 说错语言不是"这个人不太像",而是根本不是同一个人。
     空着就整行丢掉(与其余几项同一条规矩),于是行为退回"跟着用户走" */
  if (chatOneLine(p.language)) {
    how.push(
      `- Speak only ${chatOneLine(p.language)}, whatever language the user writes in.`
    )
  }
  if (chatOneLine(p.traits)) how.push(`- Personality: ${chatOneLine(p.traits)}`)
  if (chatOneLine(p.voice)) how.push(`- How you talk: ${chatOneLine(p.voice)}`)
  if (chatOneLine(p.address)) how.push(`- How you address the user: ${chatOneLine(p.address)}`)
  if (chatOneLine(p.boundaries)) how.push(`- You never do this: ${chatOneLine(p.boundaries)}`)

  const parts = [CHAT_OPENING]
  if (who.length) parts.push(`Who you are:\n${who.join('\n')}`)
  if (how.length) parts.push(`How you behave:\n${how.join('\n')}`)
  /* 时间压在"你是谁 / 你怎么说话"之后、记忆之前。
     它与记忆属同一层("发生过什么、现在是什么时候"),而**必须排在记忆前面**:
     记忆是一段成篇的叙述,夹在两块短事实中间会把它切碎。
     **不能过 chatOneLine** —— 它会把换行压成空格,而那两行正是靠换行分开的
     ("Right now: …" 与 "You two last spoke …" 合成一句读起来像机器在念表)。
     这里是纯粹的截断,结构由 chatTime 那几条正则负责 */
  const now = typeof time === 'string' ? time.slice(0, CHAT_TIME_CHARS) : ''
  if (now) parts.push(now)
  /* 长期记忆压在"你是谁"之后、规则之前:它讲的是"发生过什么",
     与"你是什么人"属同一层,而规则要留在最后当收束。
     这里同样过一遍 chatOneLine 把换行收掉 —— 它是模型生成的文本,
     原样带着换行塞回 system 里,等于让上一轮的输出有机会伪造提示词结构。
     上限要显式给:摘要是一段成篇的文字,按单字段那档 400 截会拦腰砍断 */
  const past = chatOneLine(memory, CHAT_MAX_CHARS)
  if (past) parts.push(`What has happened so far:\n${past}`)
  parts.push(CHAT_RULES)
  return parts.join('\n\n')
}

/* 温度与 creative 档齐平、比 character 档高:拟人化要的是变化 ——
   同一个问题每次问都该给一点不同的反应,温度低了会变成一台复读机 */
const CHAT_TEMPERATURE = 0.9
/* 提示词里"一到三句"是软的,这一条是硬的兜底。按 token 计费的地方,
   不能只靠一句话拦着。

   为什么是 1500 而不是 400:400 看起来"足够四五行",但它没算**思考**。
   o 系、Gemini 2.5 的 thinking、Claude 的 extended thinking 都把思考 token
   记在这同一个额度里 —— 额度被思考吃光,正文只吐了几个字就被判 length 停下。
   表现就是"提示截断了,可那句话明明很短",而 400 会把这个现象变成常态。
   1500 给思考留出余量,又仍然拦得住跑飞的模型(常态输出由提示词那一到三句管) */
const CHAT_MAX_TOKENS = 1500
/* 一轮最多带多少条历史。前端按 CHAT_WINDOW=20 截过一道,这里再拦一次 ——
   这个端点没有鉴权(配置全在前端,设计如此),不设上限就是免费的大请求放大器 */
const CHAT_MAX_MESSAGES = 40
const CHAT_MAX_CHARS = 8000
/* 空正文的占位。**前端拼上下文时有一份同样的规则**(见 src/lib/chatContext.ts),
   这里是入口这一道:没有鉴权的公开端点,手搓一个 content:"" 的请求照样会打到上游,
   而上游按"内容为空"拒掉整轮 —— 那是用户无法理解、也无法自救的失败。
   两个常量与前端那两个必须一致 */
const EMPTY_WITH_IMAGE = '(sent a photo)'
const EMPTY_WITHOUT_IMAGE = '(said nothing)'
/** 空正文换占位;有正文的原样返回(与前端 contextText 同一条规则) */
function samePlaceholder(m) {
  const text = typeof m.content === 'string' ? m.content : ''
  if (text.trim()) return text
  return m.imageId || m.photoId ? EMPTY_WITH_IMAGE : EMPTY_WITHOUT_IMAGE
}
/* 单张附图(data URL)的长度上限,约合 3MB 的图。
   前端会先把图压到长边 1024、JPEG 0.85,正常只有两三百 KB ——
   这个数只是防止有人直接往这个公开入口塞原图 */
const CHAT_IMAGE_CHARS = 4 * 1024 * 1024




export function registerChatRoute(app) {
app.post('/api/chat', rateLimit, async (req, res) => {
  const { character, messages, memory, images, nowLocal, lastAt, textModel, baseUrl, apiKey } =
    req.body || {}

  if (!baseUrl) {
    return res.status(400).json({ error: 'Configure your Base URL first' })
  }
  if (!textModel) {
    return res.status(400).json({ error: 'Set a text model in API settings first' })
  }
  /* 记忆也是外部输入(它由上游生成、经前端存了一圈再发回来),
     照消息那样收一道长度 */
  const memoryText = typeof memory === 'string' ? memory.slice(0, CHAT_MAX_CHARS) : ''

  /* 时间那一块。**认不出来就整块丢掉**,不报错 ——
     它是锦上添花的一层(角色不知道时间也能聊),而手搓的请求、
     老版本前端、时钟坏掉的机器都会走到这里。为一个装饰性的字段
     把整轮对话挡回去,是把主次弄反了(见 chatTime.js 里那几条纪律) */
  const time = timeContext({ nowLocal, lastAt })

  /* 历史逐条收窄。入口是公开的,不设上限就等于给了个免费的大请求放大器。
     正文在这里就换掉空串:下面"太长的报错"与最后那条多模态的拼装都靠它 */
  const history = (Array.isArray(messages) ? messages : [])
    .filter(
      (m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string'
    )
    .slice(-CHAT_MAX_MESSAGES)
    .map((m) => ({ role: m.role, content: samePlaceholder(m) }))
  /* 最后一条必须是用户说的:重新生成时前端会先把那条助手消息删掉再重发,
     所以到这里还落在 assistant 上,说明这个请求本来就不该发 */
  if (!history.length || history[history.length - 1].role !== 'user') {
    return res.status(400).json({ error: 'Say something first' })
  }
  /* 太长的**报错,不静默切**:切掉的是用户自己写的东西,而他看到的
     只是"我发了这么长,它好像没读到前半截"。前端在发之前会先拦一道,
     这里再拦一次是因为入口是公开的 */
  if (history.some((m) => m.content.length > CHAT_MAX_CHARS)) {
    return res.status(400).json({
      error: `A message is too long — ${CHAT_MAX_CHARS} characters max.`
    })
  }

  /* 用户附的图。**只挂在最后那一条 user 消息上** ——
     前端也只发当前这一轮的图,历史里那些不重发(一张就上千 token)。
     拼成 OpenAI 兼容的多模态 content:
     上面那几条检查必须排在前面 —— 这一段一执行,content 就从字符串
     变成数组,长度、角色这些判断在它身上全都失效 */
  const pics = (Array.isArray(images) ? images : [])
    .filter(
      (u) =>
        typeof u === 'string' &&
        /^data:image\//i.test(u) &&
        // 兜底:前端会先把图压到长边 1024,正常远小于这个数。
        // 入口是公开的,不设上限就是一个免费的大请求放大器
        u.length <= CHAT_IMAGE_CHARS
    )
    // 多图对"它在看什么"帮助有限,而每张都是上千 token
    .slice(0, 2)
  if (pics.length) {
    const last = history[history.length - 1]
    last.content = [
      {
        type: 'text',
        /* 正文本来就空、这一轮又确实带着图:占位改成"发了张图" ——
           上面那份规则看不到 images(它在另一个字段里),只能按"什么都没说"
           兜底,而那样会和紧随其后的图片自相矛盾 */
        text: last.content === EMPTY_WITHOUT_IMAGE ? EMPTY_WITH_IMAGE : last.content
      },
      ...pics.map((url) => ({ type: 'image_url', image_url: { url } }))
    ]
  }

  const target = baseUrl.replace(/\/+$/, '') + '/chat/completions'

  let targetUrl
  try {
    targetUrl = await assertSafeTarget(target)
  } catch (e) {
    return res.status(400).json({ error: e.message })
  }

  const headers = { 'Content-Type': 'application/json' }
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`

  /* 请求体是字符串,不是 FormData —— 代理那一跳失败要再直连试一次,
     而 FormData 发过一次就被消耗掉了(与 /api/generate 同一个理由)。
     这里没这个问题,所以可以算好一份直接用 */
  const body = JSON.stringify({
    model: textModel,
    messages: [{ role: 'system', content: chatSystemPrompt(character, memoryText, time) }, ...history],
    temperature: CHAT_TEMPERATURE,
    max_tokens: CHAT_MAX_TOKENS,
    stream: true
  })

  const ac = new AbortController()
  /* 静默超时的刻度:每收到一块就重置。原来的 UPSTREAM_TIMEOUT_MS 盖的是
     "从发起到拿完"的全程,流式下这个口径不对 —— 一条正在持续吐字的流
     不该被总时长掐断,该管的是"多久没动静" */
  let idleTimer = null
  let idleTimedOut = false
  const armIdle = () => {
    clearTimeout(idleTimer)
    idleTimer = setTimeout(() => {
      idleTimedOut = true
      ac.abort()
    }, UPSTREAM_TIMEOUT_MS)
  }
  // 前端点 Stop 会断开连接;这里同步中断对上游的请求
  res.on('close', () => {
    if (!res.writableEnded) ac.abort()
  })

  /* 流已经开了之后的写出口。连接断掉时 res.write 会抛/告警,
     而那时候做什么都没意义 —— 统一在这里吞掉 */
  const sendEvent = (obj) => {
    if (res.writableEnded || res.destroyed) return
    try {
      res.write(JSON.stringify(obj) + '\n')
    } catch {
      /* 连接已断,随它去 */
    }
  }
  const endStream = () => {
    if (res.writableEnded || res.destroyed) return
    try {
      res.end()
    } catch {
      /* 同上 */
    }
  }

  /* 扣着还没发的尾巴,专门用来截住末尾那几枚元数据标签(见 chatTags.js 的 tailHold)。
     声明在 try 外面是有意的:中途 Stop 或上游断流时,那截尾巴也得放出去 ——
     否则用户按了停止,最后那二三十个字符会凭空消失 */
  let tail = ''
  /* 中段那几枚标签取出来的意图(见下面循环里那一段)。末尾那几枚走 splitTags,
     两处最后合在一起 —— 合的时候**末尾优先**:它更靠后,更接近"最后想给你看的那张" */
  let midShot = { scene: '', self: false, shot: '' }
  let midMood = ''
  /* 收尾那一下:把尾巴里该发的字发出去,该剪的标签剪下来返回给调用方。
     角色名要传进去:标签里没写前缀时,"描述里点了自己的名字"也算它在画面里
     (见 chatTags.js 的 parsePhotoIntent) */
  const flushTail = () => {
    const { text, mood, photo, photoSelf, photoShot } = splitTags(tail, who)
    if (text) sendEvent({ delta: text })
    tail = ''
    return {
      mood: mood || midMood,
      photo: photo || midShot.scene,
      photoSelf: photo ? photoSelf : midShot.self,
      /* 视角跟着"这一张是谁给的"走:末尾那枚赢了就用它的,否则用中段那枚的 */
      photoShot: photo ? photoShot : midShot.shot
    }
  }

  /* 角色名要传给两处标签处理:标签里没写前缀时,"描述里点了自己的名字"
     也算它在画面里(见 chatTags.js 的 parsePhotoIntent) */
  const who = character && typeof character === 'object' ? character.name : ''

  let upstream = null
  let connectErr = null
  let proxyJumpFailed = false
  let reachedUpstream = false

  try {
    armIdle()
    for (const dispatcher of dispatchAttempts(target)) {
      try {
        upstream = await safeFetch(target, {
          method: 'POST',
          headers,
          body,
          signal: ac.signal,
          dispatcher
        })
        reachedUpstream = true
        break
      } catch (e) {
        if (e?.name === 'AbortError') throw e
        connectErr = e
        if (dispatcher) proxyJumpFailed = true // 抛错的是代理那一跳
      }
    }
    if (!upstream) throw connectErr

    /* —— 先判状态码,再开流 ——
       上游 401 / 404 / 一把 HTML 错误页时,这里还没写过任何字节,
       应该像其他端点一样回一个正常的 JSON 错误,让前端能用同一套
       failureMessage 读到。一旦 flushHeaders() 过了,就只能用
       {"error":…} 收场了 */
    if (!upstream.ok) {
      const text = (await upstream.text()).slice(0, 600)
      let detail = text
      if (looksLikeHtml(text)) {
        const title = htmlTitle(text)
        detail =
          `The upstream host returned an error page (HTTP ${upstream.status})` +
          (title ? `: ${title}` : '.') +
          ' This is on their side — retry in a few minutes.'
      } else {
        try {
          const j = JSON.parse(text)
          const m = j?.error?.message ?? j?.message
          if (typeof m === 'string' && m.trim()) detail = m.trim().slice(0, 600)
        } catch {
          /* 不是 JSON 就照原文给 */
        }
      }
      return res.status(upstream.status).json({
        error: `Upstream returned an error (${upstream.status})`,
        detail
      })
    }

    /* 上游回了 200,给的却是一整页网页 —— 多半是 Base URL 里的路径写错了,
       网站把它的 404 页面配成 200 返回(与 /api/generate 同一条判断)。
       这里只能看响应头:流式这条路不能先把整个响应体读出来再决定要不要开流。
       不拦这一道的话,HTML 里没有 data: 行,最后会落到下面那句
       "什么也没说" —— 把真正的原因(地址错了)盖住 */
    if ((upstream.headers.get('content-type') || '').includes('text/html')) {
      const page = (await upstream.text()).slice(0, 600)
      const title = htmlTitle(page)
      return res.status(502).json({
        error: 'Upstream returned a web page instead of an API response',
        detail:
          `HTTP ${upstream.status} from ${PROD_LIKE ? targetUrl.host : target}` +
          (title ? ` (page title: ${title})` : '') +
          '. The path is probably wrong — check the Base URL in API settings.'
      })
    }

    res.status(200)
    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8')
    res.setHeader('Cache-Control', 'no-cache, no-transform')
    res.setHeader('Connection', 'keep-alive')
    /* 反代(Vercel / nginx)不认这个头就会攒够一批才吐 ——
       流式当场退化成"等 10 秒一次性出来" */
    res.setHeader('X-Accel-Buffering', 'no')
    res.flushHeaders()

    /* 不加心跳:SSE 那套 `: ping` 是为了防中间层把长时间静默的连接掐掉,
       而对话的两个 token 之间最多几百毫秒,没有静默窗口需要垫 */

    if (!upstream.body) throw new Error('Upstream returned no stream')

    const reader = upstream.body.getReader()
    const decoder = new TextDecoder()
    /* 上游一块读进来常常只到半行 —— 按最后一个 \n 切开,剩下半行等下一块拼上。
       少了这个缓冲,长回复里每隔几个词就会掉一次 JSON.parse */
    let buf = ''
    let gotAny = false
    /* 上游为什么停下:'stop' 是正常说完,'length' 是撞上了 max_tokens。
       它出现在最后一帧(那一帧的 delta 是空的,只带一个 finish_reason),
       所以得一路记着 —— 丢掉它等于把"说完了"和"额度用完了"混成同一件事 */
    let finishReason = ''

    for (;;) {
      armIdle()
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      const lines = buf.split('\n')
      buf = lines.pop() ?? ''
      for (const rawLine of lines) {
        // 上游每行是 `data: {...}`;`: keep-alive` 之类的注释行与空行直接跳过
        const line = rawLine.trim()
        if (!line.startsWith('data:')) continue
        const payload = line.slice(5).trim()
        if (!payload) continue
        if (payload === '[DONE]') {
          sendEvent({ done: true, finish: finishReason, ...flushTail() })
          endStream()
          return
        }
        let delta = ''
        try {
          const j = JSON.parse(payload)
          // 只抽正文。各家塞在 delta 里的其他字段(reasoning_content 等)一律不要
          delta = j?.choices?.[0]?.delta?.content || ''
          if (j?.choices?.[0]?.finish_reason) finishReason = j.choices[0].finish_reason
        } catch {
          continue
        }
        if (!delta) continue
        gotAny = true
        /* 扣着尾巴发:只放出"不可能再变出标签"的那部分。
           扣多少由 tailHold 按"最后一个没闭合的 [ "算 —— **不是按长度预留**:
           标签上限是 400 字,按长度预留就意味着整整 400 多字不流式,
           比一条回复本身还长(见 chatTags.js 的 tailHold) */
        tail += delta
        const release = tailHold(tail)
        if (release > 0) {
          /* 放出去之前先摘掉**独占一行的标签**。
             尾巴那几枚由 tailHold 扣着、收尾时由 splitTags 收走,走不到这里;
             能走到这里的是"被正文顶到中间去"的那几枚 —— 模型先说一句、
             再决定给你看张图、然后又补一句收尾的话。不摘的话那枚 `[photo:…]`
             会原样流给用户看(用户报过这个)。意图照样记下来,收尾时一起报 */
          const cut = stripStandaloneTags(tail.slice(0, release), who)
          if (cut.text) sendEvent({ delta: cut.text })
          if (cut.photo) midShot = { scene: cut.photo, self: cut.photoSelf, shot: cut.photoShot }
          if (cut.mood) midMood = cut.mood
          tail = tail.slice(release)
        }
      }
    }

    if (gotAny) {
      sendEvent({ done: true, finish: finishReason, ...flushTail() })
    } else {
      /* 一个字都没吐出来 —— 上游只回了 role 那一帧就结束,或回了别的东西。
         这时候回 done 会让前端以为"它就是这么沉默",而其实是一次失败 */
      sendEvent({ error: 'The model returned nothing to say.' })
    }
    endStream()
  } catch (e) {
    const aborted = e?.name === 'AbortError'
    /* 流已经开了:只能按事件收场,再回 HTTP 错误码没有意义 */
    if (res.headersSent) {
      /* 手里那截还没发的尾巴先放出去 —— 见 tail 的声明处。
         收在半截标签上时它正好被剪掉,这正是我们要的 */
      flushTail()
      if (aborted && !idleTimedOut) {
        // 用户点了 Stop —— 静默收场,前端按"停住了"处理,不报错
        endStream()
      } else {
        sendEvent({
          error: idleTimedOut
            ? `No response from the model for ${UPSTREAM_TIMEOUT_MS / 1000} seconds.`
            : 'The connection to the model dropped.'
        })
        endStream()
      }
      return
    }
    // 还没开流:用户点了 Stop 就静默收场,其余按别处那套 JSON 报错
    if (aborted && !idleTimedOut) return
    if (idleTimedOut) {
      return res.status(504).json({
        error: 'Upstream timed out. Try again.',
        detail: `No response after ${UPSTREAM_TIMEOUT_MS / 1000} seconds. Try again.`
      })
    }
    // undici 遇到连接层失败只抛 "fetch failed",真正的原因在 e.cause 里
    const cause = e?.cause
    const code = cause?.code || cause?.errno || ''
    const reason = [code, cause?.message].filter(Boolean).join(' ') || String(e)
    const hint =
      !reachedUpstream && proxyJumpFailed
        ? 'Tried both the configured UPSTREAM_PROXY and a direct connection — neither worked. ' +
          'Check that the proxy is running and its node is healthy, or unset UPSTREAM_PROXY to go direct.'
        : CONNECT_HINTS[code] || ''
    const where = PROD_LIKE ? targetUrl.host : target
    return res.status(502).json({
      error: 'Upstream request failed',
      detail: `${where} — ${reason}. ${hint}`
    })
  } finally {
    clearTimeout(idleTimer)
  }
})

/* ===== 语音合成(火山引擎/豆包语音) =====================================
   与前面四条端点不是一类:那四条要么文本进文本出、要么文本进图出,
   这条是**文本进音频**。骨架仍沿用同一套(限流、目标校验、代理回退、静默超时),
   但有三处必须不同 —— 每一处都写在下面各自的位置上:

   1. 上游给的不是裸音频,而是一行行 JSON,音频在 data 字段里且是 base64;
   2. 一旦写了响应头就只能断流,所以"上游拒绝"这种最常见的失败必须
      在写头**之前**判出来 —— 它出现在正文的第一帧里,而不是 HTTP 状态码上;
   3. 这是唯一按字符计费的端点,所以整条路上一处重试都不能有:
      `dispatchAttempts` 那两次尝试里只有一次真正到达上游(见那边的说明),
      而上游一旦回了错误码就不再试。
   ------------------------------------------------------------------ */
const TTS_PROVIDERS = {
  /* 火山引擎的路径与 OpenAI 兼容那套完全不同(/api/v3/tts/... 而不是 /v1/chat/...),
     所以 baseUrl 由用户在配置里填好(默认给到 /api/v3),这里只往后接路径 */
  volc: {
    /* 一次性把文本发完、流式收音频。选 HTTP Chunked 而不是 WebSocket:
       这个代理是 HTTP 的,而"边生成边播"那点延迟优化对一到三句的回复不值当 */
    speech: '/tts/unidirectional',
    /* 音色描述走的是**音频生成**那条端点(不是"音色设计")。
       两者差一个前提:音色设计要从一个买过的底子音色出发,
       而音频生成的**纯文本模式什么都不用给** —— 一段描述就是全部输入。
       既然描述档的卖点就是"不用先准备任何东西",就不该绕那条要底子的路。
       (曾按"音色设计"实现过一版,那个端点要求 speaker_id 必填 —— 见 git 历史)
       代价:这个端点是"生成任意音频"的,环境音、音效、多人对话它都会做,
       所以提示词里必须把"只要这一个人说话"说死,见 ttsDesignPrompt */
    design: '/tts/create',
    clone: '/tts/voice_clone'
  }
}
/* 音频生成那条的必填模型名。目前只有这一个取值(见上游文档) */
const TTS_DESIGN_MODEL = 'seed-audio-1.0'
/* 复刻音色才认的"版本风味"。**只有这两个取值** —— 上游错误码文档里
   InvalidModel 那一条写得很死:model 仅对声音复刻 2.0 生效,枚举就这两个。
   填第三个值的后果是一句 [Invalid argument] InvalidModel,它既不说是哪个字段,
   也不说合法值是什么,所以这个白名单是唯一能自救的地方 */
const TTS_MODEL_VARIANTS = ['seed-tts-2.0-standard', 'seed-tts-2.0-expressive']

/**
 * 拼出真正的请求地址。**要容忍两种填法**。
 *
 * 别的端点没有这个问题:OpenAI 兼容那套有明确的"版本段"(`/api/v3`)可切,
 * 界面上的说明也一直写着"填到版本段为止"。而火山的三个端点路径长成这样:
 * `/api/v3/tts/{unidirectional,create,voice_clone}` ——
 * 用户从文档里复制 URL 时,整条路径会一起进来,于是无脑往后拼就得到
 * `/tts/create/tts/create` 这种 404(实测踩过)。
 *
 * 所以这里先把 base 收敛回"版本段",再统一往后接。三种填法都认:
 *   …/api/v3                                  → …/api/v3 + path
 *   …/api/v3/tts                              → 同上
 *   …/api/v3/tts/create                       → 同上
 *   …/api/v3/tts/voice_clone                  → 同上
 */
function ttsTarget(baseUrl, path) {
  const base = String(baseUrl || '')
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/tts\/(unidirectional|create|voice_clone)$/, '')
    .replace(/\/tts$/, '')
  return base + path
}
/* 一次最多合成多少字符。火山那边没有明文上限,这里是费用闸 ——
    角色的回复只有一到三句,正常远够不到;超出的截断而不是报错,
    因为"少念最后一句"比"整个按钮点不动"好 */
const TTS_MAX_CHARS = 600
/* 音色描述本身的长度上限。上游给的是 3000 字符(那是 text_prompt 整个字段),
   但描述只是一句话的事 —— 收到 300 是给"有人往这里贴了一整篇小说"兜底 */
const TTS_DESCRIBE_CHARS = 300
/* 克隆样本的大小上限。上游限制单文件 10MB,而整个请求还要过
   express.json 的 15mb 闸 —— base64 会涨到约 1.34 倍,所以这里收到 8MB,
   留出余量给 JSON 外壳与其它字段 */
const MAX_VOICE_SAMPLE = 8 * 1024 * 1024

/** 火山的鉴权头。新版控制台只要 X-Api-Key;Resource-Id 决定模型版本,
 *  也决定计费商品,所以它由配置带过来(见 types.ts 的 ApiConfig.resourceId)。
 *
 *  key **先 trim**:密钥是从别处复制粘贴进来的,尾随一个空格或换行
 *  在上游看来就是一个"无效的 key"(401 Invalid X-Api-Key),
 *  而盯着那一串字符怎么看都看不出问题 */
function volcHeaders(apiKey, resourceId, withResource = true) {
  const h = {
    'Content-Type': 'application/json',
    'X-Api-Key': String(apiKey || '').trim(),
    // 上游建议每请求一个,用于链路追踪;少了它报错时很难定位
    'X-Api-Request-Id': randomUUID()
  }
  if (withResource && resourceId) h['X-Api-Resource-Id'] = resourceId
  return h
}

/**
 * 兜住 Resource-Id:上游只认 `seed-tts-* / seed-icl-*` 这种完整形态。
 *
 * 前端理应已经拼好了,但"发出去的是什么"这件事不该只靠对方的自觉 ——
 * 漏拼一次的表现是上游回一句 `[resource_id=2.0] requested resource not granted`,
 * 那句话读起来像"这个服务你没开通",于是人会跑去控制台翻开通管理,
 * 而真正的问题是我们把一个裸的代际当成 ID 发了出去(实测踩过)。
 *
 * 所以这里补一道:**不带 seed- 前缀的一律按"族 + 代际"补齐**。
 * 族由档位定(内置音色 → 语音合成,复刻音色 → 声音复刻),代际从原值里认。
 */
function normalizeResourceId(value, source) {
  const v = String(value || '').trim()
  if (v.startsWith('seed-')) return v
  const family = source === 'clone' ? 'seed-icl' : 'seed-tts'
  return `${family}-${v.includes('1.0') ? '1.0' : '2.0'}`
}

/**
 * 把上游那串"一行一个 JSON、音频在 data 里"的响应收成裸音频字节。
 *
 * **响应头推迟到第一帧音频才写**,这是这条端点最要紧的一处:
 * 上游拒绝请求(Resource-Id 不对、没有音色授权)时给的是一个
 * `{code, message}` 的 JSON 帧,而不是 HTTP 错误码 —— 头一旦先写了,
 * 这种最常见的失败就只能变成"前端拿到一段空音频、播不出来",
 * 而用户看不到任何原因。所以憋着不写,直到确认第一帧真的带音频。
 *
 * 返回 null 表示"音频已经全部转发完";返回错误对象表示"还没写头,可以回正常 JSON 错误"。
 */
async function pipeTtsAudio(upstream, res, armIdle) {
  const reader = upstream.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  let started = false
  let firstFrame = ''
  let code = 0
  let message = ''

  const flush = () => {
    if (started) return
    res.status(200)
    /* 一律按 mp3 报。火山也支持 pcm/ogg_opus,但那是给"边收边解"的客户端用的;
       这里整段收完再交给 <audio>,mp3 是兼容性最好的那个。
       注意音频生成那条的**默认输出是 wav**,所以请求里必须显式要 mp3 —— 见下面 */
    res.setHeader('Content-Type', 'audio/mpeg')
    /* 音频按字符计费,不该让中间层或浏览器把它缓存起来 ——
       要复用走前端自己的 tts_cache(见 idb.ts),那才认得音色指纹 */
    res.setHeader('Cache-Control', 'no-store')
    if (res.flushHeaders) res.flushHeaders()
    started = true
  }

  /* 收一帧。两条端点在这里合流,因为它们的差别只有"怎么切"和"音频叫什么":
     - 流式合成(unidirectional):一行一个 JSON,音频在 data 里,一行一块
     - 音频生成(create):**整个响应就一个 JSON**,音频在 audio 里,只在末尾出现一次
       而且末尾多半没有换行 —— 所以循环结束后还得把剩下的 buf 再喂一遍,
       漏掉它就是整段音频一个字节都发不出去 */
  const takeFrame = (line) => {
    if (!line) return
    if (!firstFrame) firstFrame = line.slice(0, 300)
    let frame
    try {
      frame = JSON.parse(line)
    } catch {
      // 半行或杂质:跳过。不为一行的毛病掐掉整段音频
      return
    }
    if (typeof frame.code === 'number' && frame.code !== 0) {
      code = frame.code
      message = typeof frame.message === 'string' ? frame.message : ''
      return
    }
    /* 帧里的音频字段名以 data 为准(streame 那条);audio 是音频生成那条的 */
    const b64 = typeof frame.data === 'string' ? frame.data : frame.audio
    if (typeof b64 !== 'string' || !b64) return
    const chunk = Buffer.from(b64, 'base64')
    if (!chunk.length) return
    if (!started) {
      /* 第一帧音频到了才写头。上面那个 code 判断因此有机会生效 */
      if (code) return
      flush()
    }
    res.write(chunk)
  }

  for (;;) {
    armIdle()
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    const lines = buf.split('\n')
    buf = lines.pop() ?? ''
    for (const raw of lines) takeFrame(raw.trim())
  }
  // 末尾那一段(见 takeFrame 上面那段说明)
  takeFrame(buf.trim())

  if (!started) {
    /* 一个字节的音频都没有。把上游第一帧原样带上 —— 猜不出原因时,
       让用户看到他账号那边到底回了什么,比我们编一句解释有用 */
    return { code, message, firstFrame }
  }
  return null
}

/* 送合成之前把文本收一遍。
 *
 * 合成引擎是靠**标点**决定停顿与调型的,而这里要念的文本是模型写的 ——
 * 它写中文时常顺手用半角 , . ? !(键盘习惯),那套标点给到的停顿比全角短得多,
 * 连起来就是"气口不对、语调怪"。emoji 与 *~ 这类装饰则根本念不出来,
 * 强行念会变成一声怪响。两样都不是角色说的话,该在出声前去掉。
 *
 * 半角标点**只在中文字符紧邻时**才换:英文句子里的半角标点就是它该有的样子,
 * 一律换成全角会把英文念坏。 */
const CJK_NEIGHBOR = '\\u3400-\\u9fff\\u3040-\\u30ff'
function tidyForSpeech(text) {
  return text
    .replace(/[\u{1F000}-\u{1FAFF}\u{2190}-\u{2BFF}\u{FE0F}]/gu, '') // emoji 与各类符号
    .replace(/[*_~`|<>]+/g, '') // 强调、代码类装饰
    .replace(/\s*\n+\s*/g, ' ') // 换行按空格收 —— 不让它去决定停顿
    .replace(new RegExp(`([${CJK_NEIGHBOR}])\\s*,\\s*`, 'g'), '$1，')
    .replace(new RegExp(`([${CJK_NEIGHBOR}])\\s*;\\s*`, 'g'), '$1；')
    .replace(new RegExp(`([${CJK_NEIGHBOR}])\\s*:`, 'g'), '$1：')
    .replace(new RegExp(`([${CJK_NEIGHBOR}])\\s*[.。]\\s*(?=[${CJK_NEIGHBOR}]|$)`, 'g'), '$1。')
    .replace(new RegExp(`([${CJK_NEIGHBOR}])\\s*\\?`, 'g'), '$1？')
    .replace(new RegExp(`([${CJK_NEIGHBOR}])\\s*!`, 'g'), '$1！')
    .replace(/ {2,}/g, ' ')
    .trim()
}

/** 拼"音频生成"那条的提示词。
 *
 *  这个端点是**生成任意音频**的:环境音、音效、多人对话、旁白它都会做 ——
 *  上游示例里一句提示词就写进了两个男人、鸟鸣、马林巴与刹车声。而我们要的只是
 *  "这一个人把这几句念出来",所以除了音色描述与台词,必须把"别加别的"说死。
 *  不说的话它很可能顺手配一段背景音,那在聊天里是灾难 */
function ttsDesignPrompt(describe, text) {
  return (
    `用这样的嗓音说话——${describe}。` +
    `只念下面这句台词,不要背景音、不要音效、不要音乐、不要旁白:\n${text}`
  )
}

/** 上游报错时,补一句"那接下来该动哪里"。
 *
 *  两类撞得最多:
 *  1) 401 "Invalid X-Api-Key" —— 多半是**拿错了控制台的东西**:火山新版控制台给的
 *     是一个 API Key(API Key 管理),旧版给的是 App ID + Access Token 两个值;
 *     而方舟(Ark)的 ark- 开头那把钥匙属于另一套网关,打这边必然被拒。
 *  2) 403 "requested resource not granted" —— key 是对的,但**那个服务没开通**。
 *     麻烦在于这条端点的报错只回一个资源号(如 volc.service_type.10074),
 *     不说那是哪个产品,也不说去哪儿开通。所以这里把号码翻成产品名。
 *
 *  这一句不替上游解释原因,只把"去哪儿拿什么"说明白 */
function ttsErrorHint(raw, detail) {
  /* 55000000 "resource ID is mismatched with speaker related resource":
     Resource-Id 决定"用哪一代模型 / 哪个计费商品",speaker 决定"哪把嗓子",
     两者必须**同代**。上游这句话只说"对不上",不说哪两样对不上 —— 补三条走法 */
  if (/mismatched with speaker/i.test(raw)) {
    return (
      `${detail} — The Resource ID and the voice ID must come from the same generation. ` +
      `Usual causes: the voice is a Speech 1.0 one while the Resource ID says seed-tts-2.0 ` +
      `(or the reverse); the voice is a cloned one (an S_… or custom ID) but sits in the ` +
      `Built-in slot — cloned voices need seed-icl-*, which the Clone source sets by itself; ` +
      `or that voice was never granted, has no permission, or a cloned one has expired.`
    )
  }
  if (/not granted|resource_id/i.test(raw)) {
    return (
      `${detail} — The key works, but this service is not enabled on your account. ` +
      `Enable it in the console's activation page (开通管理). Which one you need depends ` +
      `on the endpoint: speech synthesis is volc.service_type.10029 (also seed-tts-1.0/2.0), ` +
      `voice cloning is volc.megatts.default (also seed-icl-1.0/2.0), and audio generation — ` +
      `the endpoint behind the "describe" voice source — is volc.service_type.10074.`
    )
  }
  if (!/x-api-key|api[-_ ]?key|unauthor|forbidden|401/i.test(raw)) return detail
  return (
    `${detail} — Use an API Key created in the new Volcano console ` +
    `(API Key management). The App ID / Access Token pair from the old console ` +
    `is a different thing and will not work here. An Ark (ark-…) key belongs ` +
    `to a different gateway and is not accepted here either.`
  )
}


}
