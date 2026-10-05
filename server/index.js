import express from 'express'
import dotenv from 'dotenv'
import path from 'node:path'
import fs from 'node:fs'
import net from 'node:net'
import { randomUUID } from 'node:crypto'
import { lookup as dnsLookup } from 'node:dns/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { ProxyAgent } from 'undici'
import { splitTags, stripStandaloneTags, tailHold } from './chatTags.js'
import { timeContext } from './chatTime.js'
import { ENHANCE_PROMPTS, ENHANCE_TEMPERATURE } from './enhancePrompts.js'

dotenv.config()

/* Node 的 fetch(undici)不读 macOS 的系统代理设置,只认显式配置。
   于是会出现「浏览器/curl 走代理能通,服务端却 fetch failed」的情况。
   这里让被阻断的境外接口可选地走代理,国内接口仍直连(见 NO_PROXY),
   不配 UPSTREAM_PROXY 时全程直连,行为不变。 */
const UPSTREAM_PROXY = process.env.UPSTREAM_PROXY || ''
/* 火山有**两套域名**,别被名字骗了:
 *   控制台与方舟           *.volces.com
 *   语音技术(TTS/复刻)     openspeech.bytedance.com —— 是 *.bytedance.com
 * 只写 volces.com 的话,TTS 会兜一圈境外代理再回来:能出声,但每句都要
 * 多等好几秒(实测反应就是这个"生成很慢")。两家都列上 */
const NO_PROXY = (process.env.NO_PROXY || 'localhost,127.0.0.1,volces.com,bytedance.com,aliyuncs.com')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)

const proxyAgent = UPSTREAM_PROXY ? new ProxyAgent(UPSTREAM_PROXY) : null
if (proxyAgent) {
  console.log(`[KImage] 上游代理: ${UPSTREAM_PROXY}(以下域名直连: ${NO_PROXY.join(', ')})`)
}
/** 命中的域名直连,其余走代理;没配代理则一律直连(返回 undefined 用默认调度器) */
function dispatcherFor(target) {
  if (!proxyAgent) return undefined
  const host = new URL(target).hostname
  return NO_PROXY.some((s) => host === s || host.endsWith(`.${s}`)) ? undefined : proxyAgent
}

/* 代理是"路上多一跳",它随时可能掉线 —— 节点过期、规则改了、客户端在切节点都会。
   而目标域名往往直连是通的(尤其是国内的中转站)。所以配了代理的目标按
   [代理, 直连] 依次尝试:只有连接层失败才走下一跳,上游真回了错误码就照常透出。
   反过来不成立:没配代理的目标不会去猜一个代理来试。 */
function dispatchAttempts(target) {
  const proxy = dispatcherFor(target)
  return proxy ? [proxy, undefined] : [undefined]
}

/* ===== 目标地址校验(防 SSRF) ========================================
   这个接口按请求体里的 baseUrl 转发,等于把"发起请求"这件事交给了调用方。
   不加限制时任何人都能拿它探测内网(如 http://127.0.0.1:1、169.254.169.254)。
   规则:只允许 http(s);域名先解析一遍,命中私网/回环/链路本地等网段即拒绝。
   注意:解析与真正连接之间理论上存在 DNS 重绑定的窗口,对个人工具可接受;
   需要连本机/内网服务调试时,设 ALLOW_PRIVATE_TARGETS=1 显式放行。
   ------------------------------------------------------------------ */
const ON_SERVERLESS = !!process.env.VERCEL
/** 是否按"生产环境"对待:决定是否拦截私网目标、是否回显完整目标地址 */
const PROD_LIKE = ON_SERVERLESS || process.env.NODE_ENV === 'production'
const ALLOW_PRIVATE_TARGETS = process.env.ALLOW_PRIVATE_TARGETS === '1' || !PROD_LIKE

/** 判断 IP 是否落在不该被代理访问的网段里 */
function isBlockedAddress(ip) {
  // IPv4-mapped IPv6(::ffff:127.0.0.1)按里层的 IPv4 判断
  const v4 = ip.toLowerCase().startsWith('::ffff:') ? ip.slice(7) : ip
  if (net.isIPv4(v4)) {
    const [a, b] = v4.split('.').map(Number)
    if (a === 0 || a === 10 || a === 127 || a >= 224) return true // 本机 / 私网 / 保留 / 组播
    if (a === 100 && b >= 64 && b <= 127) return true // 运营商级 NAT
    if (a === 169 && b === 254) return true // 链路本地(含云元数据地址)
    if (a === 172 && b >= 16 && b <= 31) return true // 私网
    if (a === 192 && (b === 168 || b === 0)) return true // 私网 / 保留段
    if (a === 198 && (b === 18 || b === 19 || b === 51)) return true // 基准测试 / 文档段
    if (a === 203 && b === 0) return true // 文档段
    return false
  }
  if (net.isIPv6(v4)) {
    const s = v4.toLowerCase()
    if (s === '::' || s === '::1') return true
    if (s.startsWith('fc') || s.startsWith('fd')) return true // 唯一本地地址
    if (/^fe[89ab]/.test(s)) return true // 链路本地
    if (s.startsWith('ff')) return true // 组播
    if (s.startsWith('2001:db8')) return true // 文档段
    return false
  }
  return true // 认不出来的地址一律拒绝
}

/** 校验目标并返回解析后的 URL;不合法就抛错(调用方转成 400) */
async function assertSafeTarget(target) {
  let url
  try {
    url = new URL(target)
  } catch {
    throw new Error('Enter a valid Base URL')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Base URL must start with http:// or https://')
  }
  if (ALLOW_PRIVATE_TARGETS) return url

  const host = url.hostname.replace(/^\[|\]$/g, '') // URL 里的 IPv6 字面量带方括号
  if (net.isIP(host)) {
    if (isBlockedAddress(host)) throw new Error(`Blocked: ${host} is a private or reserved address`)
    return url
  }
  let addrs = []
  try {
    addrs = await dnsLookup(host, { all: true })
  } catch {
    throw new Error(`Can't resolve host ${host} — check the address`)
  }
  const bad = addrs.find((a) => isBlockedAddress(a.address))
  if (bad) throw new Error(`Blocked: ${host} points to a private address`)
  return url
}

/* ===== 滥用防护与超时 ================================================
   配置全在前端,这个代理没有鉴权(设计如此),至少要挡住两件事:
   ① 网页跨站调用 —— 不挂 cors() 后浏览器会自己拦下;
   ② 脚本直连刷量 —— 一个内存滑窗限流(Serverless 下按实例生效)。
   ------------------------------------------------------------------ */
const RATE_WINDOW_MS = 60_000
const RATE_MAX = 30
const rateHits = new Map()
function rateLimit(req, res, next) {
  const ip =
    String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
    req.socket.remoteAddress ||
    'unknown'
  const now = Date.now()
  const hits = (rateHits.get(ip) || []).filter((t) => now - t < RATE_WINDOW_MS)
  if (hits.length >= RATE_MAX) {
    return res.status(429).json({ error: 'Too many requests. Try again in a minute.' })
  }
  hits.push(now)
  rateHits.set(ip, hits)
  // 访客多了以后顺手清掉过期的键,避免这张表只涨不落
  if (rateHits.size > 500) {
    for (const [key, times] of rateHits) {
      if (!times.some((t) => now - t < RATE_WINDOW_MS)) rateHits.delete(key)
    }
  }
  next()
}

/** 上游多久没响应就中断。Vercel 上另有平台执行上限,两者独立 */
const UPSTREAM_TIMEOUT_MS = 120_000

/* 提示词改写 / 起稿 / 识图 / 摘要的系统提示与温度搬去了 server/enhancePrompts.js ——
   那两段角色提示词引用了 charSpec 的行清单,放在这里既不好找,也没法在单测里直接读
   (这个文件一 import 就会拉起 dotenv、express 与静态目录) */

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
- Most of your messages have no picture in them, and that is normal. Send one only when the picture is the point of the message: they asked to see you, or something is happening right now that you would actually take a photo of. Being somewhere is not a reason by itself - do not attach one just because you can. When you do send one, put a photo tag on its own line at the very end, after everything else you have to say (the mood tag goes after it): [photo:a description of the scene from your point of view]. Nothing may come after it - if you have more to say, say it before the tag. Up to 400 characters, one line. If you are in the picture yourself, start that description with "self:" - for example [photo:self:me on the balcony, hair down]. Leave the prefix off when it is only what you are looking at, because a picture without it is generated without your reference sheet: a view stays a view. Never use the tag as a substitute for actually saying something. Do not comment on the tag or explain it.
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


/* 目标出图模型对提示词结构的偏好。改写是写给下游那个模型看的,
   同一段文字喂给 gpt-image 和喂给 SD 系模型,该有的样子完全不同:
   前者自己会再改写一遍,堆标签只会被削掉;后者恰恰靠标签密度吃饭。
   表里没有的厂商走 GENERIC —— 不硬套已知风格,宁可给一句中性的结构建议。 */
const NATURAL_STYLE = `Structure: natural-language sentences with dense, concrete detail. A narrative flow is welcome and multi-clause sentences are fine.`
const TARGET_STYLE = {
  // 服务端还会用 GPT 再改写一次,所以"少而清楚"比"多而杂"更容易被保留下来
  openai: `Structure: one flowing descriptive sentence. This model rewrites prompts on its own before generating, so stacked keyword tags and piled-up adjectives tend to get trimmed or conflict — say fewer things, more clearly.`,
  ark: NATURAL_STYLE,
  dashscope: NATURAL_STYLE
}
const GENERIC_STYLE = `Structure: a comma-separated series of short phrases rather than full sentences. Keyword density matters more than grammar.`

/* 图生图时的附加要求。改写模型看不到参考图,只能靠用户这句话判断,
   不点明这一点它会把整幅画面重新描述一遍 —— 参考图里已有的东西白写一次,
   还会和参考图打架;更糟的是它可能编出参考图里根本没有的元素。 */
const REF_NOTE = `\n\nThis is an image-to-image edit. The image model receives a reference image that you cannot see.
- Describe only what should change and what must be preserved. Do not re-describe the whole scene.
- Never assume or invent details about the reference image beyond what the prompt itself states.`

/** 把目标模型与其结构偏好拼成一段附加说明;认不出来就只说清目标是谁 */
function targetNote(vendor, model) {
  const style = TARGET_STYLE[vendor] || GENERIC_STYLE
  return `\n\nTarget image model: ${model || 'unspecified'}\n${style}`
}

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DIST = path.resolve(__dirname, '../dist')

const app = express()
// 单次请求体的上限。别只改这一处,下面还有一条把它翻成人话的错误处理
const JSON_LIMIT = '15mb'
// 不挂 cors():前端与 /api 同源(本地走 vite 代理),不需要 CORS;
// 挂着反而会让任意网站都能借用这个代理发请求
app.use(express.json({ limit: JSON_LIMIT }))

// 连接层失败的常见原因与排查方向,附在报错里,避免只看到一句 "fetch failed"
const CONNECT_HINTS = {
  ENOTFOUND: "Can't resolve the host. Check the Base URL spelling.",
  ECONNREFUSED: 'The host refused the connection. Check the address and port.',
  ETIMEDOUT: 'The connection timed out. The endpoint may be unreachable or blocked.',
  ECONNRESET:
    'The connection was reset in transit — the domain is likely blocked. ' +
    'Configure UPSTREAM_PROXY on the server, or use an endpoint reachable from your region.',
  EPIPE: 'The connection closed early, usually a proxy or firewall. Check the network path.',
  UND_ERR_CONNECT_TIMEOUT:
    'The connection timed out; overseas endpoints are often blocked on direct connections. ' +
    'Use a local endpoint or configure UPSTREAM_PROXY.',
  UND_ERR_SOCKET: 'The socket closed mid-stream, usually a proxy or firewall. Check the network path.',
  UNABLE_TO_VERIFY_LEAF_SIGNATURE:
    'Node does not trust the TLS certificate, often from a local proxy tool. Add the root certificate to NODE_EXTRA_CA_CERTS.',
  SELF_SIGNED_CERT_IN_CHAIN:
    'The TLS chain includes a self-signed certificate, often from a local proxy tool. Add the root certificate to NODE_EXTRA_CA_CERTS.'
}

/* Gemini 认的宽高比是它自己那套字符串(见其图像模型规格)。我们把 size 里的
   "WxH" 约分后去匹配;匹配不上就不发这个参数,让模型用默认比例 ——
   而不是硬近似到某个比例上(项目里一贯不做隐式猜测)。
   实测:不发时它默认给 16:9(1408×768);发 2:3 拿到 848×1264。 */
const GEMINI_RATIOS = new Set(['1:1', '3:2', '2:3', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'])
function geminiRatio(size) {
  if (!size || size === 'auto') return ''
  const m = String(size).match(/^(\d{1,5})x(\d{1,5})$/i)
  if (!m) return ''
  const w = Number(m[1])
  const h = Number(m[2])
  const gcd = (a, b) => (b ? gcd(b, a % b) : a)
  const d = gcd(w, h)
  const r = `${w / d}:${h / d}`
  return GEMINI_RATIOS.has(r) ? r : ''
}

/* 上游回来的是一整页网页而不是 API 响应。两种场景都会撞上:
   - 上游挂了:Cloudflare / nginx 的 5xx 模板(十几 KB);
   - 路径打错:网站把 404 页面配成 200 回给你。
   两种都不该原样塞进错误框,也不该让前端在 JSON.parse 上炸出一句
   "Unexpected token '<'"。 */
function looksLikeHtml(body) {
  return /^\s*<(!doctype|html|\?xml)/i.test(body)
}
/** 抓 <title>:这类页面的标题通常正好是关键信息,比如 "域名 | 502: Bad gateway" */
function htmlTitle(html) {
  const t = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1]
  return t ? t.trim().replace(/\s+/g, ' ').slice(0, 160) : ''
}

/**
 * 通用图像生成代理。
 * 前端把配置(prompt / size / n / model / baseUrl / apiKey)POST 过来,
 * 后端按 protocol 转发:
 *   - 'openai'(默认):任意 OpenAI 兼容的 /images/generations ——
 *     豆包 Seedream、通义万相、Flux 以及各大中转都按这一套;
 *   - 'gemini':Gemini 原生的 :generateContent,路径、请求体、响应体都是另一套。
 * 两条都走同一个出口,是为了避开前端直调第三方接口的跨域问题。
 */
app.post('/api/generate', rateLimit, async (req, res) => {
  const {
    prompt,
    size = '1024x1024',
    n = 1,
    model,
    baseUrl,
    apiKey,
    responseFormat,
    image,
    images,
    quality,
    background,
    seed,
    vendor,
    protocol
  } = req.body || {}

  if (!prompt) {
    return res.status(400).json({ error: 'Enter a prompt first' })
  }
  // baseUrl 必须由用户显式提供;apiKey 允许为空(部分本地服务无需鉴权)
  if (!baseUrl) {
    return res.status(400).json({ error: 'Configure your Base URL first' })
  }

  /* 参考图:新前端发 images(数组)—— 角色的设定图就是"多张视图一起当参考";
     老前端仍发 image(单张)。两边都收,免得缓存里的旧包打过来时参考图被静默丢掉。
     上游收不收多张由它自己决定,我们只如实转发 */
  const refs = (Array.isArray(images) ? images : image ? [image] : []).filter(
    (s) => typeof s === 'string' && s.startsWith('data:image')
  )
  const isImageGen = refs.length > 0
  const isGemini = protocol === 'gemini'

  if (isGemini && !model) {
    return res.status(400).json({ error: 'Set an image model in API settings first' })
  }

  /* 两条协议的路径不一样。谁走哪条由前端按 (厂商, 模型) 判定 ——
     中转站自己也是按模型名分流,我们跟它不一致就会打到它不实现的那条路上
     (实测 Gemini 系模型打 /images/generations 会回
     "Images API is not supported for this platform") */
  const base = baseUrl.replace(/\/+$/, '')
  const target = isGemini
    ? `${base}/v1beta/models/${encodeURIComponent(model)}:generateContent`
    : // OpenAI 的图生图走 /images/edits,其余厂商仍在 /images/generations 上用 multipart 传参考图
      base + (isImageGen && vendor === 'openai' ? '/images/edits' : '/images/generations')

  // 目标校验:协议 + 网段(见 assertSafeTarget)。不通过就没必要再往下走
  let targetUrl
  try {
    targetUrl = await assertSafeTarget(target)
  } catch (e) {
    return res.status(400).json({ error: e.message })
  }

  const headers = {}
  if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`
  }

  /* quality / background 是 OpenAI 系的扩展参数,不少接口不认,所以只在显式选择时带上。
     Gemini 那条路一个都不带:原生请求体里没有这些字段,多给一个未知字段会被它拒掉
     (前端的厂商能力表已经把这两项标成不支持,正常也传不过来)
     seed 不同:它是用户自己填的"复现键",两条协议各有它的位置 ——
     OpenAI 系放请求体顶层(所以归在这批里),Gemini 放 generationConfig(见下面) */
  const extras = isGemini
    ? {}
    : {
        ...(responseFormat ? { response_format: responseFormat } : {}),
        ...(quality ? { quality } : {}),
        ...(background ? { background } : {}),
        ...(Number.isFinite(seed) ? { seed } : {})
      }

  /* size 如实转发(OpenAI 那条路),包括字面量 'auto' —— 它是上游的一个真实取值
     (模型按 prompt 定比例),跟"不发这个参数"不是一回事:不发时上游用自己的默认尺寸,
     多数是 1:1。哪些厂商认 auto 由前端判断(厂商表在 src/api.ts,只有那里知道
     baseUrl 是谁),不认的厂商候选里不会出现 auto,所以这里不需要再拦一道。
     注意 quality / background 的 auto 不同:那两个是我们的"不传"哨兵值,
     上游没有对应的 'auto' 取值,所以仍然只在显式选择时才带上。
     Gemini 那条路是例外:它根本没有 size 参数,size 会被约分成宽高比(见 geminiRatio)。 */

  /* 两条路的请求体完全不同,各自成段。
     做成"每次调用现造一份"而不是算好一个变量:代理那一跳失败要再直连试一次,
     而 FormData / 字符串体发过一次就被消耗掉了,得能重来。 */
  let buildBody
  if (isGemini) {
    headers['Content-Type'] = 'application/json'
    const ratio = geminiRatio(size)
    // 多图靠 candidateCount,只有真要不止一张时才带,不给默认路径添风险
    const gen = {}
    if (ratio) gen.imageConfig = { aspectRatio: ratio }
    if (n > 1) gen.candidateCount = n
    // 原生协议里 seed 在 generationConfig 下;图像模型认不认由上游决定(见厂商能力表)
    if (Number.isFinite(seed)) gen.seed = seed
    /* 图生图在原生协议里不是另一个端点,而是同一个端点多给一段 parts:
       文字在前、参考图在后。mime 必须从 data URL 里读,不能写死 ——
       参考图可能是历史里的 PNG/WebP(原样带过来),也可能是
       compressImage 压过的 JPEG */
    const parts = [{ text: prompt }]
    /* 原生协议天然能收多张:每张参考图各占一段 inlineData,
       所以角色的"正脸 + 全身 + 转面"可以一起送上去 */
    for (const ref of refs) {
      const [meta, b64] = ref.split(',')
      const mime = (meta.match(/data:([^;]+)/) || [])[1] || 'image/jpeg'
      parts.push({ inlineData: { mimeType: mime, data: b64 } })
    }
    buildBody = () =>
      JSON.stringify({
        contents: [{ parts }],
        ...(Object.keys(gen).length ? { generationConfig: gen } : {})
      })
  } else if (isImageGen) {
    // OpenAI 系图生图:gpt-image 等模型不接受 JSON 里的 data-url base64,
    // 必须走 multipart 文件上传(或在个别服务下传公网 URL)
    buildBody = () => {
      const fd = new FormData()
      if (model) fd.append('model', model)
      fd.append('prompt', prompt)
      fd.append('n', String(n))
      if (size) fd.append('size', size)
      for (const [k, v] of Object.entries(extras)) fd.append(k, String(v))
      /* 单张仍用 image —— 与一直以来的行为完全一致,不给最常见的那条路添风险;
         多张才改用 image[],那是 OpenAI 的 /images/edits 收多图时的字段名。
         字段名各家未必相同,上游拒绝时会原样透出来,照提示改即可 */
      const field = refs.length > 1 ? 'image[]' : 'image'
      refs.forEach((ref, i) => {
        const [meta, b64] = ref.split(',')
        const mime = (meta.match(/data:([^;]+)/) || [])[1] || 'image/jpeg'
        const type = mime.includes('png') ? 'png' : 'jpeg'
        fd.append(
          field,
          new Blob([Buffer.from(b64, 'base64')], { type: mime }),
          `image-${i + 1}.${type}`
        )
      })
      return fd // fetch 自动设置 multipart boundary
    }
  } else {
    headers['Content-Type'] = 'application/json'
    buildBody = () =>
      JSON.stringify({
        model: model || undefined,
        prompt,
        n,
        ...(size ? { size } : {}),
        ...extras
      })
  }

  // 前端点"终止"会断开连接;这里同步中断对上游的请求,
  // 并借此判断连接是否还在,避免往已断开的响应里写数据。
  // 另外挂一个超时:上游长时间不返回时主动中断,别把连接一直占着
  const ac = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    ac.abort()
  }, UPSTREAM_TIMEOUT_MS)
  res.on('close', () => {
    if (!res.writableEnded) ac.abort()
  })

  /* 依次尝试 [代理, 直连](没配代理就只有直连一次,见 dispatchAttempts)。
     换下一跳只看 fetch 本身有没有抛错:上游回了错误码是"这条配置能不能用"的答案,
     重试没有意义;用户点终止与超时中断抛 AbortError,同样直接交出去。
     reachedUpstream 用来区分"压根没连上"与"连上了但读响应失败",
     前者才该提代理,后者该按原来的连接码给提示。

     这几个游标必须留在 try 外面:catch 里要看它们,而 catch 是 try 的兄弟块 ——
     写在 try 里的 let 它看不见。之前写在里面,于是每一次连接失败都抛
     ReferenceError("reachedUpstream is not defined"),异步处理器又没人接,
     整个进程被带崩,前端只看到一句 Request failed (500) */
  let upstream = null
  let connectErr = null
  let proxyJumpFailed = false
  let reachedUpstream = false

  try {
    for (const dispatcher of dispatchAttempts(target)) {
      try {
        upstream = await fetch(target, {
          method: 'POST',
          headers,
          body: buildBody(),
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

    const text = await upstream.text()

    if (!upstream.ok) {
      /* 上游报错可能很长(整页 HTML,或回显了整段提示词的 JSON),先截断再回显 ——
         与 /api/enhance 那条同一套规矩 */
      const raw = text.slice(0, 600)
      let detail = raw
      /* 上游挂掉时回的多是 Cloudflare / nginx 的整页 HTML。塞进错误框既读不了也刷屏,
         所以只留标题那句,再补一句这是谁的问题。
         这条必须排在最前:HTML 里可能同时命中下面那些关键词 */
      if (looksLikeHtml(text)) {
        const title = htmlTitle(text)
        detail =
          `The upstream host returned an error page (HTTP ${upstream.status})` +
          (title ? `: ${title}` : '.') +
          ' This is on their side — retry in a few minutes.'
      } else if (/Images API is not supported for this platform/i.test(text)) {
        detail =
          'This endpoint has no OpenAI-compatible Images API — it routes by model name, and Gemini-family image models (banana / nano-banana / gemini-*-image) need the native :generateContent path instead. Original error: ' +
          raw
      } else if (/base64_input_not_supported|b64传参|multipart/i.test(text)) {
        detail =
          "This endpoint doesn't accept the reference image as a file upload. It may need a public image URL or a specific file field name — check the image input spec of the endpoint behind your Base URL. Original error: " +
          raw
      } else if (/unknown (parameter|argument)|unrecognized|unexpected.*parameter|invalid.*(parameter|param)/i.test(text)) {
        // 大多是不支持 quality / background 这类扩展参数
        detail =
          'The upstream doesn\'t recognize a parameter, usually quality or background (OpenAI-only extensions). In "Interface Settings", pick the right vendor, or set quality/background back to "Auto". Original error: ' +
          raw
      } else {
        /* 兜底:JSON 里的 message 才是给人看的那句,整个 JSON 塞过去只会让人先看到
           一堆括号。上游还常常把模型本人说的话放进 message(比如"请先上传参考图"),
           那更是这里唯一有用的信息,所以优先把它摆出来,错误码跟在后面当注脚 */
        try {
          const j = JSON.parse(text)
          const m = j?.error?.message ?? j?.message
          if (typeof m === 'string' && m.trim()) {
            // 数值型的 code(如 Google 的 400)是冗余的 —— HTTP 状态里已经有了
            const code = [j?.error?.code, j?.error?.type, j?.error?.status, j?.code].find(
              (c) => typeof c === 'string' && c
            )
            detail = code ? `${m.trim()} (${code})` : m.trim()
          }
        } catch {
          /* 不是 JSON 就保持原样 */
        }
      }
      /* 鉴权被拒时,把"我们实际发出去的东西"也说明白(不含 key 本身)。
         同一个 401 在桌面上和手机上长得一模一样,成因却常常是两件事:
         这台设备上**根本没配 key**(配置只存在各自浏览器的 localStorage 里,
         不跟账号走,也不会从桌面同步过去),或者 key 被手机键盘改过。
         不说出长度,用户没有任何办法分辨 —— 而这两者的下一步完全不同 */
      const authTrace =
        upstream.status === 401 || upstream.status === 403
          ? apiKey
            ? ` Sent ${String(apiKey).length} characters to ${PROD_LIKE ? targetUrl.host : target}. If the key on your other device differs in length, this one was typed or pasted wrong.`
            : ' No API key was sent: the active config in this browser has none. Configs are stored per browser and do not sync across devices — open Interface Settings on this device and add the key.'
          : ''
      return res.status(upstream.status).json({
        error: `Upstream returned an error (${upstream.status})`,
        detail: detail + authTrace
      })
    }

    /* 上游回了 200,给的却是一整页 HTML —— 多半是 Base URL 里的路径写错了,
       网站把它的 404 页面配成 200 返回。照原样透传的话前端会炸出一句
       "Unexpected token '<'",对用户没有任何意义,所以这里就判成网关错误。
       两条协议都要求响应是 JSON,所以这个判断不会误伤正常结果 */
    if (looksLikeHtml(text)) {
      const title = htmlTitle(text)
      return res.status(502).json({
        error: 'Upstream returned a web page instead of an API response',
        detail:
          `HTTP ${upstream.status} from ${PROD_LIKE ? targetUrl.host : target}` +
          (title ? ` (page title: ${title})` : '') +
          '. The path is probably wrong — check the Base URL in API settings.'
      })
    }

    // 透传上游返回体
    res.setHeader('Content-Type', 'application/json')
    res.send(text)
  } catch (e) {
    // 响应已经发出,无需也无法再回
    if (res.headersSent) return
    // 超时中断与"用户点了终止"都抛 AbortError,靠 timedOut 区分:
    // 前者要给出明确回执,后者静默收场
    if (e?.name === 'AbortError') {
      if (timedOut) {
        return res.status(504).json({
          error: 'Upstream timed out. Try again or use fewer images.',
          detail: `No response after ${UPSTREAM_TIMEOUT_MS / 1000} seconds. Try again or use fewer images.`
        })
      }
      return
    }
    // undici(Node fetch)遇到连接层失败时只抛 "fetch failed",
    // 真正的原因(DNS/TCP/TLS)藏在 e.cause 里,这里一并透出,否则无法排查
    const cause = e?.cause
    const code = cause?.code || cause?.errno || ''
    const reason = [code, cause?.message].filter(Boolean).join(' ') || String(e)
    /* 连不上且动过代理时,原样的提示会让人跑去"配置 UPSTREAM_PROXY" ——
       可它早就配好了,真正的毛病是那一跳不通。这时说清两跳都试过、问题在代理 */
    const hint =
      !reachedUpstream && proxyJumpFailed
        ? 'Tried both the configured UPSTREAM_PROXY and a direct connection — neither worked. ' +
          'Check that the proxy is running and its node is healthy, or unset UPSTREAM_PROXY to go direct.'
        : CONNECT_HINTS[code] || ''
    // 生产环境只回显目标主机名:完整地址会被当成内网探测器用
    const where = PROD_LIKE ? targetUrl.host : target
    return res.status(502).json({
      error: 'Upstream request failed',
      detail: `${where} — ${reason}. ${hint}`
    })
  } finally {
    clearTimeout(timer)
  }
})

/* ===== 局部编辑 ========================================================
   给一张原图和一块要重做的区域,让上游把那块像素重新生成一遍。
   去背景 / 消除 / 局部重绘 / 换背景共用这一条 —— 差别只在 mask 与指令。

   mask 的语义在这里统一成 OpenAI 定下的那条:透明像素才是要动的部分。
   前端就按这个规矩画(见 CanvasEditor 的 fullMask、lassoMask、brushMask),
   所以这里不需要再转一道格式。

   指令由这一侧按模式挑,前端只说"这是哪一类"。放服务端是有意的:
   改措辞不该要求用户重装前端,而这些句子本身就是效果的一部分。
   -------------------------------------------------------------------- */

/** 每种模式各自要让模型做什么。regen 不在表里 —— 那一种用户那句话就是指令本身。
 *  取一个对象而不是直接写死字符串,是因为两处要按参数变:
 *  去背景开了透明就不能再说"铺一层白底",换背景得把用户那句话嵌进去 */
const EDIT_INSTRUCTIONS = {
  'remove-bg': ({ transparent }) =>
    transparent
      ? 'Remove the background completely, leaving it fully transparent. ' +
        'Keep the subject exactly as it is — same shape, edges, lighting and colours. ' +
        'Do not put anything behind it.'
      : 'Remove the background completely. Keep the subject exactly as it is — ' +
        'same shape, edges, lighting and colours. Put the subject on a plain white background.',
  erase: () =>
    'Remove whatever the marked area contains, and reconstruct what should be behind it ' +
    'so the result blends seamlessly with its surroundings. ' +
    'Leave everything outside the marked area completely untouched.',
  'replace-bg': ({ prompt }) =>
    `Replace the background with ${prompt}. Keep the subject exactly as it is — ` +
    'same shape, edges, lighting and colours. Change nothing but the background.'
}

/* 这几种模式的指令要拼进用户那句话,空着拼出来就是句废话 ——
   在这一侧拦掉,并给一句对症的提示,而不是把空话发给上游 */
const PROMPT_HINT = {
  regen: 'Say what should change in that area',
  'replace-bg': 'Describe the background you want'
}

app.post('/api/edit', rateLimit, async (req, res) => {
  const {
    image,
    mask,
    mode = 'regen',
    prompt,
    model,
    size,
    background,
    baseUrl,
    apiKey,
    protocol
  } = req.body || {}

  if (!baseUrl) {
    return res.status(400).json({ error: 'Configure your Base URL first' })
  }
  if (typeof image !== 'string' || !image.startsWith('data:image')) {
    return res.status(400).json({ error: 'There is nothing on the canvas to edit' })
  }
  if (typeof mask !== 'string' || !mask.startsWith('data:image')) {
    return res.status(400).json({ error: 'The selected area could not be read' })
  }

  const wants = String(prompt || '').trim()
  if (PROMPT_HINT[mode] && !wants) {
    return res.status(400).json({ error: PROMPT_HINT[mode] })
  }

  const spec = EDIT_INSTRUCTIONS[mode]
  /* 空指令会让上游把整张图重画一遍,那就不是"编辑"了。
     regen 与 replace-bg 上面已经拦过空话,这里剩下的空串只可能是
     认不出来的 mode —— 一并按"没说清要改什么"处理 */
  const instruction = String(
    spec ? spec({ prompt: wants, transparent: background === 'transparent' }) : wants
  ).trim()
  if (!instruction) {
    return res.status(400).json({ error: 'Say what should change in that area' })
  }

  const isGemini = protocol === 'gemini'
  if (isGemini && !model) {
    return res.status(400).json({ error: 'Set an image model in API settings first' })
  }

  const base = baseUrl.replace(/\/+$/, '')
  const target = isGemini
    ? `${base}/v1beta/models/${encodeURIComponent(model)}:generateContent`
    : base + '/images/edits'

  try {
    await assertSafeTarget(target)
  } catch (e) {
    return res.status(400).json({ error: e.message })
  }

  const headers = {}
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`

  const [imgHead, imgB64] = String(image).split(',')
  const [maskHead, maskB64] = String(mask).split(',')
  const imgMime = (imgHead.match(/data:([^;]+)/) || [])[1] || 'image/png'
  const maskMime = (maskHead.match(/data:([^;]+)/) || [])[1] || 'image/png'
  const extOf = (m) => (m.includes('jpeg') ? 'jpg' : m.includes('webp') ? 'webp' : 'png')

  /* 两条路的请求体差得远,各自成段。做成"每次现造一份"是因为代理那一跳失败
     还要再直连试一次,而 FormData 发过一次就被消耗掉了(与 /api/generate 同一个理由) */
  let buildBody
  if (isGemini) {
    headers['Content-Type'] = 'application/json'
    /* 原生协议里没有 mask 字段 —— 只能把它当第二张图交上去,
       再在文字里点明哪一半是要改的。认不认由模型决定,但比直接拒绝强 */
    const ratio = geminiRatio(size)
    buildBody = () =>
      JSON.stringify({
        contents: [
          {
            parts: [
              {
                text:
                  `${instruction}\n\n` +
                  'The first image is the picture to edit. In the second image the transparent ' +
                  'area marks what to work on; everything else must stay exactly as it is.'
              },
              { inlineData: { mimeType: imgMime, data: imgB64 } },
              { inlineData: { mimeType: maskMime, data: maskB64 } }
            ]
          }
        ],
        /* 画幅要和原图一致,否则改完一张 3:2 的图会变成方的。
           约不出干净比例就不发这一项,交给它自己的默认(见 geminiRatio) */
        ...(ratio ? { generationConfig: { imageConfig: { aspectRatio: ratio } } } : {})
      })
  } else {
    buildBody = () => {
      const fd = new FormData()
      if (model) fd.append('model', model)
      fd.append('prompt', instruction)
      /* 画幅由前端按原图算好(见 api.ts 的 editSize):能自由定尺寸的厂商报原尺寸,
         只认枚举的挑最接近的一档。
         这里以前是故意不发的,想着"不发就等于保持原样" —— 恰恰相反:
         多数上游在缺省时退回自己的默认画幅,而那就是 1024x1024,
         于是一张 3:2 的图改完变成方的。 */
      if (size) fd.append('size', size)
      /* 透明底是 OpenAI 系的扩展项(与 /api/generate 同一套),前端只在
         厂商明确支持时才给 —— 认不出这一项的接口会整条请求 400 */
      if (background) fd.append('background', background)
      fd.append(
        'image',
        new Blob([Buffer.from(imgB64, 'base64')], { type: imgMime }),
        `image.${extOf(imgMime)}`
      )
      fd.append(
        'mask',
        new Blob([Buffer.from(maskB64, 'base64')], { type: maskMime }),
        `mask.${extOf(maskMime)}`
      )
      return fd
    }
  }

  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), UPSTREAM_TIMEOUT_MS)
  res.on('close', () => {
    if (!res.writableEnded) ac.abort()
  })

  try {
    let upstream = null
    let connectErr = null
    for (const dispatcher of dispatchAttempts(target)) {
      try {
        upstream = await fetch(target, {
          method: 'POST',
          headers,
          body: buildBody(),
          signal: ac.signal,
          dispatcher
        })
        break
      } catch (e) {
        if (e?.name === 'AbortError') throw e
        connectErr = e
      }
    }
    if (!upstream) throw connectErr

    const text = await upstream.text()

    if (!upstream.ok) {
      /* 与 /api/generate 同一套:上游的原话才是唯一有用的线索 ——
         这里尤其如此,因为"这个端点不认 mask"只会从它嘴里说出来 */
      let detail = text.slice(0, 600)
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
      return res.status(upstream.status).json({ error: 'Editing failed', detail })
    }

    // 响应形状与出图一致,于是前端复用同一套解析(见 api.ts 的 imagesFrom)
    res.type('application/json').send(text)
  } catch (e) {
    const aborted = e?.name === 'AbortError'
    return res.status(aborted ? 400 : 502).json({
      error: aborted ? 'Editing was stopped' : 'Could not reach the upstream host',
      detail: aborted ? undefined : String(e?.message || e)
    })
  } finally {
    clearTimeout(timer)
  }
})

/**
 * 提示词改写代理。
 * 图像模型只出图、改不了提示词,所以这里不转发给 /images/*,而是把请求
 * 交给文本模型的 /chat/completions,让上游把提示词扩写得更具体、更有画面感。
 * 三个档位共用它:改写(quick / creative)、把一句话拆成角色设定(character)、
 * 以及把一张参考图读成角色设定(vision,多模态消息)。
 * baseUrl / apiKey / textModel 由前端单独一份配置提供 —— 改写用「提示词增强」那条,
 * 识图用「识图」那条;两者都与生图的接口配置互不影响:三件事常常不是同一个服务商。
 */
app.post('/api/enhance', rateLimit, async (req, res) => {
  const { prompt, textModel, baseUrl, apiKey, mode, targetVendor, targetModel, hasRef, image } =
    req.body || {}

  /* 识图那条的输入。图是 data URL —— 与生图、局部编辑两条路一致。
     认不出来的图按"没给"处理:那时它会退回文本那几档,而不是把一张空图发给上游 */
  const visionRef = typeof image === 'string' && image.startsWith('data:image') ? image : ''

  /* 只认这几档,其余(含老前端不传)一律按保守档处理。
     character 是"把一句话拆成角色设定",vision 是"把一张图读成角色设定",
     summary 是"把一批滑出窗口的消息压成一段长期记忆",
     photo 是"给一张对话里的图当摄影指导",
     四者都不是在改写出图提示词 */
  const enhanceMode =
    mode === 'creative'
      ? 'creative'
      : mode === 'character'
        ? 'character'
        : mode === 'vision' && visionRef
          ? 'vision'
          : mode === 'summary'
            ? 'summary'
            : mode === 'photo'
              ? 'photo'
              : 'quick'

  /* 拆角色、识图、压记忆、摄影指导这四档都不加图生图说明与目标模型偏好:
     前三条与"改写出图提示词"无关,加上只会让它们顺手把画面信息也写进去;
     摄影指导更相反 —— 它补的正是"怎么拍",而 REF_NOTE 那句
     "不要重新描述整个场景"与它的职责直接冲突 */
  const systemPrompt =
    enhanceMode === 'character' ||
    enhanceMode === 'vision' ||
    enhanceMode === 'summary' ||
    enhanceMode === 'photo'
      ? ENHANCE_PROMPTS[enhanceMode]
      : ENHANCE_PROMPTS[enhanceMode] +
        (hasRef ? REF_NOTE : '') +
        targetNote(targetVendor, targetModel)

  /* 识图可以没有文字输入 —— 图本身就是全部输入,所以只拦"两样都没有" */
  if (!prompt && !visionRef) {
    return res.status(400).json({ error: 'Enter a prompt first' })
  }
  if (!baseUrl) {
    return res.status(400).json({ error: 'Configure your Base URL first' })
  }
  // 模型名单独配:出图模型是图像模型,打不通 /chat/completions(识图同理,要的是能看图的对话模型)
  if (!textModel) {
    return res.status(400).json({
      error:
        enhanceMode === 'vision'
          ? 'Set a vision model in API settings first'
          : 'Set a text model in API settings first'
    })
  }

  const target = baseUrl.replace(/\/+$/, '') + '/chat/completions'

  // 目标校验:协议 + 网段(见 assertSafeTarget)。不通过就没必要再往下走
  let targetUrl
  try {
    targetUrl = await assertSafeTarget(target)
  } catch (e) {
    return res.status(400).json({ error: e.message })
  }

  const headers = { 'Content-Type': 'application/json' }
  if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`
  }

  // 前端点"终止"会断开连接;这里同步中断对上游的请求,
  // 并借此判断连接是否还在,避免往已断开的响应里写数据。
  // 另外挂一个超时:上游长时间不返回时主动中断,别把连接一直占着
  const ac = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    ac.abort()
  }, UPSTREAM_TIMEOUT_MS)
  res.on('close', () => {
    if (!res.writableEnded) ac.abort()
  })

  /* 识图那条走多模态:user 的 content 从字符串换成数组,文字在前、图在后
     (OpenAI 兼容的写法,豆包/百炼/OpenAI 都按这一套收 data URL)。
     图之外没有文字输入时补一句中性的指令 —— content 数组里必须有一段 text,
     这既是多数实现的要求,也避免上游对着空指令自由发挥 */
  const userContent = visionRef
    ? [
        { type: 'text', text: prompt || 'Describe the person in this image.' },
        { type: 'image_url', image_url: { url: visionRef } }
      ]
    : prompt

  const buildBody = () =>
    JSON.stringify({
      model: textModel,
      messages: [
        // 顺序有讲究:先两档的基本规则,再图生图的变更导向,最后目标模型的结构偏好
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userContent }
      ],
      temperature: ENHANCE_TEMPERATURE[enhanceMode]
    })

  // 与 /api/generate 同一套:代理那一跳连不上时再直连试一次(见 dispatchAttempts)。
  // 同样必须留在 try 外面 —— catch 里要读它们(同 /api/generate 那段注释)
  let upstream = null
  let connectErr = null
  let proxyJumpFailed = false
  let reachedUpstream = false

  try {
    for (const dispatcher of dispatchAttempts(target)) {
      try {
        upstream = await fetch(target, {
          method: 'POST',
          headers,
          body: buildBody(),
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

    const text = await upstream.text()

    if (!upstream.ok) {
      // 上游报错可能很长(堆栈/回显整段提示词),截断后再回显
      return res.status(upstream.status).json({
        error: `Upstream returned an error (${upstream.status})`,
        detail: text.slice(0, 600)
      })
    }

    // 取第一条回复的正文;解析失败或字段缺失都按"没拿到文本"处理
    let out = ''
    try {
      out = String(JSON.parse(text)?.choices?.[0]?.message?.content || '').trim()
    } catch {
      out = ''
    }
    if (!out) {
      return res.status(502).json({
        error: 'Upstream returned no text to use',
        detail: text.slice(0, 600)
      })
    }

    res.json({ prompt: out })
  } catch (e) {
    // 响应已经发出,无需也无法再回
    if (res.headersSent) return
    // 超时中断与"用户点了终止"都抛 AbortError,靠 timedOut 区分:
    // 前者要给出明确回执,后者静默收场
    if (e?.name === 'AbortError') {
      if (timedOut) {
        return res.status(504).json({
          error: 'Upstream timed out. Try again.',
          detail: `No response after ${UPSTREAM_TIMEOUT_MS / 1000} seconds. Try again.`
        })
      }
      return
    }
    // undici(Node fetch)遇到连接层失败时只抛 "fetch failed",
    // 真正的原因(DNS/TCP/TLS)藏在 e.cause 里,这里一并透出,否则无法排查
    const cause = e?.cause
    const code = cause?.code || cause?.errno || ''
    const reason = [code, cause?.message].filter(Boolean).join(' ') || String(e)
    // 与 /api/generate 同一套措辞:两跳都试过了,就别再让人去"配置 UPSTREAM_PROXY"
    const hint =
      !reachedUpstream && proxyJumpFailed
        ? 'Tried both the configured UPSTREAM_PROXY and a direct connection — neither worked. ' +
          'Check that the proxy is running and its node is healthy, or unset UPSTREAM_PROXY to go direct.'
        : CONNECT_HINTS[code] || ''
    // 生产环境只回显目标主机名:完整地址会被当成内网探测器用
    const where = PROD_LIKE ? targetUrl.host : target
    return res.status(502).json({
      error: 'Upstream request failed',
      detail: `${where} — ${reason}. ${hint}`
    })
  } finally {
    clearTimeout(timer)
  }
})

/**
 * 角色对话代理。与 /api/enhance 同源(都打 /chat/completions),但它是**流式**的:
 * 上游回的是 SSE,这一层把它收窄成"每行一个 JSON",前端只认一种事件。
 *
 * 为什么要重新打包而不是原样透传:与 api.ts 的 imagesFrom 摊平两种响应形状
 * 是同一条理由 —— 中转站的字段名、reasoning_content 之类的额外字段、
 * [DONE] 的写法各家都可能不同,把这些挡在服务端这一处,
 * 前端就不用为每家中转各写一段解析。
 */
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
  let midShot = { scene: '', self: false }
  let midMood = ''
  /* 收尾那一下:把尾巴里该发的字发出去,该剪的标签剪下来返回给调用方。
     角色名要传进去:标签里没写 self: 时,"描述里点了自己的名字"也算它在画面里
     (见 chatTags.js 的 parsePhotoIntent) */
  const flushTail = () => {
    const { text, mood, photo, photoSelf } = splitTags(tail, who)
    if (text) sendEvent({ delta: text })
    tail = ''
    return {
      mood: mood || midMood,
      photo: photo || midShot.scene,
      photoSelf: photo ? photoSelf : midShot.self
    }
  }

  /* 角色名要传给两处标签处理:标签里没写 self: 时,"描述里点了自己的名字"
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
        upstream = await fetch(target, {
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
          if (cut.photo) midShot = { scene: cut.photo, self: cut.photoSelf }
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

app.post('/api/tts', rateLimit, async (req, res) => {
  const { text, voice, baseUrl, apiKey, resourceId, model } = req.body || {}
  const say = typeof text === 'string' ? text.trim() : ''
  /* 密钥先 trim 再判空:粘贴带进来的空格/换行会让"非空"成立,
     却在上游看来是一个无效的 key(401)—— 那是最难自查的一类失败 */
  const key = typeof apiKey === 'string' ? apiKey.trim() : ''
  if (!say) return res.status(400).json({ error: 'Nothing to say' })
  if (!baseUrl) return res.status(400).json({ error: 'Configure your Base URL first' })
  if (!key) {
    return res.status(400).json({ error: 'Set the API key for your TTS config first' })
  }

  const v = voice && typeof voice === 'object' ? voice : {}
  const describe = v.source === 'describe' && typeof v.describe === 'string' ? v.describe.trim() : ''
  const speaker = typeof v.vendorVoice === 'string' ? v.vendorVoice.trim() : ''
  const speed = typeof v.speed === 'number' && Number.isFinite(v.speed) ? v.speed : 0
  /* req_params.model 那两层收(见 TTS_MODEL_VARIANTS):
       1. 内置音色一律不带 —— 文档写明它"仅当 speaker 为复刻音色时需指定";
       2. 复刻音色只在填了合法值时才带。老配置里可能存着"自由输入框"时代留下的
          脏值(最常见的是照 Resource ID 写成 seed-tts-2.0),那种值上游只会回
          InvalidModel —— 用户看不出这是自己两个月前填错的那一格,只能在这里挡掉 */
  const wantModel = typeof model === 'string' ? model.trim() : ''
  const variant = v.source === 'clone' && TTS_MODEL_VARIANTS.includes(wantModel) ? wantModel : ''

  /* 真正发出去的那个 Resource-Id。describe 那条不带它(见下),
     其余一律补成上游认的完整形态 —— 理由见 normalizeResourceId */
  const sentResourceId = describe ? '' : normalizeResourceId(resourceId, v.source)

  const provider = TTS_PROVIDERS.volc
  const path = describe ? provider.design : provider.speech
  /* 规整放在截断之后:规整只会变短,不会把内容顶出上限(见 tidyForSpeech) */
  const bodyText = tidyForSpeech(say.slice(0, TTS_MAX_CHARS))
  /* 全是 emoji / 装饰符号时会被规整成空 —— 那种请求发出去只会换回一句
     参数错,不如在这里就说清 */
  if (!bodyText) return res.status(400).json({ error: 'Nothing pronounceable in that message' })

  const target = ttsTarget(baseUrl, path)
  let targetUrl
  try {
    targetUrl = await assertSafeTarget(target)
  } catch (e) {
    return res.status(400).json({ error: e.message })
  }

  const payload = describe
    ? JSON.stringify({
        model: TTS_DESIGN_MODEL,
        text_prompt: ttsDesignPrompt(describe.slice(0, TTS_DESCRIBE_CHARS), bodyText),
        audio_config: {
          /* 这条端点**默认吐 wav**,而下面一律按 mp3 播报 —— 不显式要 mp3,
             浏览器拿到的是 wav 字节却挂着 audio/mpeg 的头,能不能放全看运气 */
          format: 'mp3',
          sample_rate: 24000,
          ...(speed ? { speech_rate: Math.max(-50, Math.min(100, Math.round(speed))) } : {})
        }
        /* 刻意**不传 references**:那条的参数说明里,"纯文本生成"就是
           "不传参考资源,按 text_prompt 中的提示词生成音频" ——
           一段描述直接生成,不需要底子音色,也不需要先买音色槽位 */
      })
    : JSON.stringify({
        user: { uid: 'kimage' },
        req_params: {
          text: bodyText,
          /* 空音色在这里拦掉:上游会回一个难懂的参数错,而真正的原因是
             "这个角色还没挑过音色" */
          speaker,
          audio_params: {
            format: 'mp3',
            sample_rate: 24000,
            ...(speed ? { speech_rate: Math.max(-50, Math.min(100, Math.round(speed))) } : {})
          },
          // 只有复刻 2.0 认这个(见上面 variant 的说明)
          ...(variant ? { model: variant } : {})
        }
      })

  if (!describe && !speaker) {
    return res.status(400).json({ error: 'Pick a voice for this character first' })
  }

  const ac = new AbortController()
  let idleTimer = null
  let idleTimedOut = false
  const armIdle = () => {
    clearTimeout(idleTimer)
    idleTimer = setTimeout(() => {
      idleTimedOut = true
      ac.abort()
    }, UPSTREAM_TIMEOUT_MS)
  }
  res.on('close', () => {
    if (!res.writableEnded) ac.abort()
  })

  let reachedUpstream = false
  let proxyJumpFailed = false

  try {
    let upstream = null
    let connectErr = null
    for (const dispatcher of dispatchAttempts(targetUrl)) {
      try {
        upstream = await fetch(targetUrl, {
          method: 'POST',
          /* 音频生成那条的文档里没有 X-Api-Resource-Id,所以走它时不带 ——
             一个用不上的头，最好的结果是被忽略，最坏的结果是被拒 */
          headers: volcHeaders(key, sentResourceId),
          body: payload,
          signal: ac.signal,
          dispatcher
        })
        reachedUpstream = true
        break
      } catch (e) {
        if (e?.name === 'AbortError') throw e
        connectErr = e
        if (dispatcher) proxyJumpFailed = true
      }
    }
    if (!upstream) throw connectErr

    /* 上游给的是 HTTP 层的错(401 / 404 / 一整页 HTML):这时还没写头,
       照别的端点那样回一个正常的 JSON 错误 */
    if (!upstream.ok) {
      const raw = await upstream.text()
      /* 鉴权被拒时把"我们实际发出去的东西"也说明白(不含 key 本身)。
         这个 key 只存在用户浏览器里,不把长度与去向说出来,他就没有任何办法
         判断是"我们发错了"还是"key 不对" —— 而这两件事的下一步完全不同:
         前者等我改,后者他去控制台查 */
      const trace =
        upstream.status === 401
          ? ` Sent ${key.length} characters to ${PROD_LIKE ? targetUrl.host : target}.`
          : describe
            ? ''
            : ` Sent Resource ID "${sentResourceId || '(none)'}" with speaker "${speaker || '(none)'}".`
      return res.status(upstream.status).json({
        error: `Upstream returned an error (${upstream.status})`,
        detail: ttsErrorHint(raw, shortDetail(raw)) + trace
      })
    }
    if (!upstream.body) throw new Error('Upstream returned no stream')

    const failed = await pipeTtsAudio(upstream, res, armIdle)
    if (failed) {
      /* 走到这里说明一个字都没写出去,所以还能回一个正常的错误。
         上游那句 message 直接端上来 —— "没有音色授权""Resource-Id 不对"
         这类话只有它说得准。

         再把**我们实际发出去的那两样**写上:这一大类拒绝(资源与音色对不上)
         全都发生在 "Resource-Id + speaker" 这一对上,不回显这两样,用户手里
         就只有一个"对不上",没有任何可以核对的凭据
         (与上面 401 那条回显 key 长度、目标 host 同一个理由) */
      const upstreamText = [failed.message, failed.firstFrame].filter(Boolean).join(' — ')
      const sent = describe
        ? ''
        : `Sent Resource ID "${sentResourceId || '(none)'}" with speaker "${speaker || '(none)'}".`
      const detail = ttsErrorHint(
        upstreamText,
        [sent, upstreamText].filter(Boolean).join(' ')
      ).slice(0, 400)
      return res.status(502).json({
        error: `The TTS service refused this request${failed.code ? ` (code ${failed.code})` : ''}`,
        detail: detail || 'It returned no audio and no explanation.'
      })
    }
    if (!res.writableEnded) res.end()
  } catch (e) {
    const aborted = e?.name === 'AbortError'
    if (res.headersSent) {
      /* 已经在放音频了:只能收场,再回错误码没有意义(与 /api/chat 同一条界线) */
      if (!res.writableEnded) res.end()
      return
    }
    if (aborted && idleTimedOut) {
      return res.status(504).json({
        error: 'Upstream timed out. Try again.',
        detail: `No audio after ${UPSTREAM_TIMEOUT_MS / 1000} seconds.`
      })
    }
    const cause = e?.cause
    const code = cause?.code || cause?.errno || ''
    const reason = [code, cause?.message].filter(Boolean).join(' ') || String(e)
    const hint =
      !reachedUpstream && proxyJumpFailed
        ? 'Tried both the configured UPSTREAM_PROXY and a direct connection — neither worked.'
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

/* 声音克隆:上传一段样本,换一个可以反复用的音色代号。
 *
 * 用的是**自定义音色代号**那条路(custom_speaker_id):代号由我们自己取名,
 * 所以这一步不需要从响应里读任何东西 —— 取好名、发出去、成了就记下来。
 * 样本走 base64 而不是 multipart:现有端点的 body 全是 JSON,而
 * dispatchAttempts 那两次尝试依赖 **body 字符串可复用**,multipart 发一次就消耗掉了。
 *
 * 计费提醒(这一条必须让用户知道):训练本身不贵,而**首次用这个音色合成时会
 * 收一次音色槽位费**。所以我们只建号,不在这里偷偷合成一次。 */
app.post('/api/voice/clone', rateLimit, async (req, res) => {
  const { sample, name, baseUrl, apiKey, customId, language } = req.body || {}
  // 与 /api/tts 同一条:先 trim 再判空(见那边的注释)
  const key = typeof apiKey === 'string' ? apiKey.trim() : ''
  if (typeof sample !== 'string' || !sample.startsWith('data:audio/')) {
    return res.status(400).json({ error: 'Attach an audio file (wav, mp3, m4a or ogg)' })
  }
  if (!baseUrl) return res.status(400).json({ error: 'Configure your Base URL first' })
  if (!key) return res.status(400).json({ error: 'Set the API key for your TTS config first' })

  /* 代号有格式要求(上游会拦):8~256 字符、只能数字字母与 - _、
     必须以字母开头、结尾不能是 - 或 _,也不能撞官方前缀。
     "kimage_" 开头天然满足全部条件 */
  const id = typeof customId === 'string' && customId.trim() ? customId.trim() : ''
  if (!/^[A-Za-z][A-Za-z0-9_-]{7,255}$/.test(id) || /[-_]$/.test(id)) {
    return res.status(400).json({
      error: 'That voice id is not usable',
      detail: 'Use 8-256 letters, digits, dashes or underscores, starting with a letter.'
    })
  }

  const comma = sample.indexOf(',')
  const head = sample.slice(5, comma)
  const b64 = sample.slice(comma + 1)
  const format = head.split(';')[0].split('/')[1] || 'mp3'
  /* 大小按 base64 长度反推:解码一遍只为了量尺寸太浪费,
     而 base64 的长度与字节数是固定比例(4 字符 → 3 字节) */
  const bytes = Math.floor((b64.length * 3) / 4)
  if (bytes > MAX_VOICE_SAMPLE) {
    return res.status(400).json({
      error: `That sample is too large (max ${Math.round(MAX_VOICE_SAMPLE / 1024 / 1024)}MB)`
    })
  }

  const target = ttsTarget(baseUrl, TTS_PROVIDERS.volc.clone)
  let targetUrl
  try {
    targetUrl = await assertSafeTarget(target)
  } catch (e) {
    return res.status(400).json({ error: e.message })
  }

  const payload = JSON.stringify({
    /* 自定义代号这条路要求 speaker_id 传这个固定值,真正的名字写在下面 */
    speaker_id: 'custom_speaker_id',
    custom_speaker_id: id,
    audio: { data: b64, format },
    ...(typeof language === 'number' ? { language } : {})
    /* 刻意**不带** extra_params.demo_text:上游可以借它顺便合一段试听,
       但那个 demo 音频在训练响应里的位置没有稳定文档 —— 带了就得解析它,
       解析不出来那一段就白费,而它还会拖长注册耗时(上游明说 demo 越长越慢)。
       试听改由前端那枚按钮走一次正常合成(界面会先讲清"这一步开始计费") */
  })

  try {
    let upstream = null
    let connectErr = null
    for (const dispatcher of dispatchAttempts(targetUrl)) {
      try {
        upstream = await fetch(targetUrl, {
          method: 'POST',
          headers: volcHeaders(key, ''),
          body: payload,
          dispatcher
        })
        break
      } catch (e) {
        connectErr = e
      }
    }
    if (!upstream) throw connectErr

    const raw = await upstream.text()
    if (!upstream.ok) {
      return res.status(upstream.status).json({
        error: `Upstream returned an error (${upstream.status})`,
        detail: ttsErrorHint(raw, shortDetail(raw))
      })
    }
    /* 上游的训练响应形状没有稳定文档,所以这里不解析它的内容 ——
       代号是我们自己取的(见上面),成没成由 HTTP 状态说明。
       但把原始响应留给前端放进回执里,出问题时用户手里有东西可查 */
    res.json({ vendorVoice: id, bytes, name: typeof name === 'string' ? name : '', raw: shortDetail(raw) })
  } catch (e) {
    const cause = e?.cause
    const code = cause?.code || cause?.errno || ''
    const reason = [code, cause?.message].filter(Boolean).join(' ') || String(e)
    const where = PROD_LIKE ? targetUrl.host : target
    return res.status(502).json({
      error: 'Upstream request failed',
      detail: `${where} — ${reason}. ${CONNECT_HINTS[code] || ''}`
    })
  }
})

app.get('/api/health', (_req, res) => {
  res.json({ ok: true })
})

/** 上游原文里那句给人看的话:整页 HTML 只取标题,JSON 取 message,其余截断 */
function shortDetail(text) {
  if (!text) return ''
  if (looksLikeHtml(text)) {
    const t = htmlTitle(text)
    return `The host answered with an HTML page${t ? `: ${t}` : ''}`
  }
  try {
    const j = JSON.parse(text)
    const m = j?.error?.message ?? j?.message
    if (typeof m === 'string' && m.trim()) return m.trim().slice(0, 300)
  } catch {
    /* 不是 JSON 就原样截断 */
  }
  return text.slice(0, 300)
}

/** 从 GET /models 的响应里取模型 id。两条协议的回法不一样:
    OpenAI 是 { data: [{ id }] },Gemini 是 { models: [{ name: 'models/xxx' }] } */
function parseModelIds(text, protocol) {
  try {
    const j = JSON.parse(text)
    if (protocol === 'gemini') {
      return (j?.models || [])
        .map((m) => String(m?.name || '').replace(/^models\//, ''))
        .filter(Boolean)
    }
    return (j?.data || []).map((m) => String(m?.id || '')).filter(Boolean)
  } catch {
    return []
  }
}

/**
 * 连通性测试。两段,先问再探:
 *   ① GET /models —— 顺带回答"这个模型在不在它那儿";
 *   ② 没有 /models 的站(那是可选端点,不少中转不实现),退回缺参探测:
 *      发一个空 JSON 到真实端点,上游因缺参数回 400,而 400 恰好证明地址、
 *      路径前缀、密钥这条链是通的 —— 401/403 才是密钥的问题。
 * 两段都不真的生成图,所以点几次都不花钱。
 *
 * 判决发回前端,文案由前端拼 —— 与 /api/generate 同一套分工。
 */
app.post('/api/test', rateLimit, async (req, res) => {
  const { baseUrl, apiKey, model, protocol, kind } = req.body || {}
  const base = String(baseUrl || '').replace(/\/+$/, '')
  if (!/^https?:\/\//i.test(base)) {
    return res.status(400).json({ error: 'Enter a valid Base URL' })
  }

  /* 打真实端点而不是固定的某个探活地址:测试要回答的是"这条配置能不能用",
     而能被用起来的前提正是这段路径前缀对得上 */
  const isGemini = protocol === 'gemini'
  const target = isGemini
    ? `${base}/v1beta/models/${encodeURIComponent(model || '')}:generateContent`
    : base + (kind === 'text' ? '/chat/completions' : '/images/generations')

  try {
    // 两个候选地址同主机,校验一次就够(它查的是协议与网段)
    await assertSafeTarget(target)
  } catch (e) {
    return res.status(400).json({ error: e.message })
  }

  const headers = { 'Content-Type': 'application/json' }
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`

  const started = Date.now()
  const ac = new AbortController()
  // 两段共用一份预算:测试不该等两分钟(生图的超时是 120s),十五秒没动静就当不可达
  const timer = setTimeout(() => ac.abort(), 15_000)
  try {
    /* —— ① GET /models ——
       比缺参探测多说一件事:目标模型在不在它给的清单里。 */
    const listUrl = isGemini ? `${base}/v1beta/models` : `${base}/models`
    try {
      const listed = await fetch(listUrl, {
        method: 'GET',
        headers,
        signal: ac.signal,
        dispatcher: dispatcherFor(listUrl)
      })
      const text = await listed.text()
      if (listed.ok) {
        /* 回了 200 却是一整页 HTML:地址里少写了 /v1 这类前缀时最常见,
           网站把它的首页给了你。当成上游出错,别报"连上了" */
        if (looksLikeHtml(text)) {
          return res.json({
            ok: false,
            code: 'server',
            status: listed.status,
            ms: Date.now() - started,
            detail: shortDetail(text)
          })
        }
        const ids = parseModelIds(text, protocol)
        return res.json({
          ok: true,
          via: 'models',
          status: listed.status,
          ms: Date.now() - started,
          /* 清单为空(有些站回 200 + 空数组)或没填模型时,判断不了在不在 —— 交给前端少说一句 */
          modelListed:
            model && ids.length
              ? ids.some((id) => id.toLowerCase() === String(model).toLowerCase())
              : null
        })
      }
      // 密钥被拒就到此为止:这一层比探测那条路更干净(请求里连参数都没有)
      if (listed.status === 401 || listed.status === 403) {
        return res.json({
          ok: false,
          code: 'auth',
          status: listed.status,
          ms: Date.now() - started,
          detail: shortDetail(text)
        })
      }
      // 其余(404/405/400…)一律理解为"这家没有 /models",落到下面的探测
    } catch (e) {
      // 网络层的问题再试一次也是同样的结果,直接报
      const code = e?.cause?.code || e?.code || ''
      const timedOut = e?.name === 'AbortError'
      return res.json({
        ok: false,
        code: timedOut ? 'timeout' : 'network',
        status: null,
        ms: Date.now() - started,
        detail: timedOut
          ? 'No response within 15 seconds. The endpoint may be unreachable or blocked.'
          : CONNECT_HINTS[code] || e?.message || 'Request failed'
      })
    }

    /* —— ② 缺参探测 —— */
    const upstream = await fetch(target, {
      method: 'POST',
      headers,
      body: '{}',
      signal: ac.signal,
      dispatcher: dispatcherFor(target)
    })
    const text = await upstream.text()
    const ms = Date.now() - started
    const status = upstream.status

    // 200(不该发生)与"缺参数被拒"都算通:端点存在、密钥被接受了
    if (upstream.ok || status === 400 || status === 422) {
      return res.json({ ok: true, via: 'probe', status, ms })
    }
    // 限流也算通 —— 它同样要过了鉴权才会被限
    if (status === 429) return res.json({ ok: true, via: 'probe', status, ms })

    const code =
      status === 401 || status === 403
        ? 'auth'
        : status === 404 || status === 405
          ? 'endpoint'
          : 'server'
    return res.json({ ok: false, code, status, ms, detail: shortDetail(text) })
  } catch (e) {
    const code = e?.cause?.code || e?.code || ''
    const timedOut = e?.name === 'AbortError'
    return res.json({
      ok: false,
      code: timedOut ? 'timeout' : 'network',
      status: null,
      ms: Date.now() - started,
      detail: timedOut
        ? 'No response within 15 seconds. The endpoint may be unreachable or blocked.'
        : CONNECT_HINTS[code] || e?.message || 'Request failed'
    })
  } finally {
    clearTimeout(timer)
  }
})

/* ===== 请求体解析失败兜底 ============================================
   express.json 在请求体超限时抛 entity.too.large,而 Express 默认的错误处理
   会回一整页 HTML(开发模式下还带调用栈)。前端拿到非 JSON 只能显示一句
   "Request failed (413)" —— 用户根本不知道是"这张图太大",更不知道该做什么。
   这里翻成一句能照着做的话。
   放在所有路由之后、静态托管之前:这样 /api/* 的解析错误不会落进 SPA 兜底。
   -------------------------------------------------------------------- */
app.use((err, _req, res, next) => {
  if (err?.type === 'entity.too.large') {
    return res.status(413).json({
      error: 'The request body is too large',
      detail: `This server accepts up to ${JSON_LIMIT} per request. Images are the usual cause: the canvas already shrinks the picture and its mask before sending, so seeing this usually means an unusually large or noisy image. Try cropping it first.`
    })
  }
  if (err instanceof SyntaxError && 'body' in err) {
    return res.status(400).json({ error: 'The request body is not valid JSON' })
  }
  // 其余错误交回 Express 默认处理,不在这里吞掉
  return next(err)
})

// 生产模式：托管构建后的前端静态文件（dist 存在时）
if (fs.existsSync(DIST)) {
  app.use(express.static(DIST))
  app.get(/^\/(?!api\/).*/, (_req, res) => {
    res.sendFile(path.join(DIST, 'index.html'))
  })
  console.log('[KImage] 已托管前端静态文件:', DIST)
}

// Vercel：导出 app 供 serverless 使用
export { app }

// 本地直接运行时才监听端口（Vercel 场景会被 import，不监听）
const isEntry =
  process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url
if (isEntry) {
  const port = process.env.PORT || 3000
  app.listen(port, () => {
    console.log(`[KImage] 后端已启动: http://localhost:${port}`)
  })
}