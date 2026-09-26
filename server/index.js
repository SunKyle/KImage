import express from 'express'
import dotenv from 'dotenv'
import path from 'node:path'
import fs from 'node:fs'
import net from 'node:net'
import { lookup as dnsLookup } from 'node:dns/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { ProxyAgent } from 'undici'

dotenv.config()

/* Node 的 fetch(undici)不读 macOS 的系统代理设置,只认显式配置。
   于是会出现「浏览器/curl 走代理能通,服务端却 fetch failed」的情况。
   这里让被阻断的境外接口可选地走代理,国内接口仍直连(见 NO_PROXY),
   不配 UPSTREAM_PROXY 时全程直连,行为不变。 */
const UPSTREAM_PROXY = process.env.UPSTREAM_PROXY || ''
const NO_PROXY = (process.env.NO_PROXY || 'localhost,127.0.0.1,volces.com,aliyuncs.com')
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

/* 提示词改写的系统提示,两档:
   quick 保守补细节 —— 结构与主体一律不动,只把缺的画面要素补上;
   creative 允许重构 —— 换构图、光线、色调、风格,但不许换主体,
   否则改写会变成另一个需求,用户按了反而得重新写一遍。
   两档都限词数,回填到输入框还得能一眼读完。 */
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
- Stay under 110 words, one paragraph.`
}

// 改写强度:保守档给低温度,让它贴着原句走;重构档放开,否则出来的东西没差别
const ENHANCE_TEMPERATURE = { quick: 0.4, creative: 0.9 }

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DIST = path.resolve(__dirname, '../dist')

const app = express()
// 不挂 cors():前端与 /api 同源(本地走 vite 代理),不需要 CORS;
// 挂着反而会让任意网站都能借用这个代理发请求
app.use(express.json({ limit: '15mb' }))

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

/**
 * 通用图像生成代理。
 * 前端把配置(prompt / size / n / model / baseUrl / apiKey)POST 过来,
 * 后端转发给任意 OpenAI 兼容的 /images/generations 接口。
 * 这样可兼容豆包 Seedream、通义万相、Flux、以及各大模型生图 API,
 * 同时避免前端直接调第三方接口遇到跨域问题。
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
    quality,
    background,
    vendor
  } = req.body || {}

  if (!prompt) {
    return res.status(400).json({ error: 'Enter a prompt first' })
  }
  // baseUrl 必须由用户显式提供;apiKey 允许为空(部分本地服务无需鉴权)
  if (!baseUrl) {
    return res.status(400).json({ error: 'Configure your Base URL first' })
  }

  const isImageGen = image && typeof image === 'string' && image.startsWith('data:image')

  // OpenAI 的图生图走 /images/edits,其余厂商仍在 /images/generations 上用 multipart 传参考图
  const endpoint = isImageGen && vendor === 'openai' ? '/images/edits' : '/images/generations'
  const target = baseUrl.replace(/\/+$/, '') + endpoint

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

  // quality / background 是 OpenAI 系的扩展参数,不少接口不认,所以只在显式选择时带上
  const extras = {
    ...(responseFormat ? { response_format: responseFormat } : {}),
    ...(quality ? { quality } : {}),
    ...(background ? { background } : {})
  }

  /* 'auto' 是我们自己的语义(交给上游自决),不能把字面量透传:
     只有 OpenAI 系认 size: "auto",其余厂商收到这个值会直接报错。
     不带该参数时上游就用它自己的默认尺寸 —— 与 quality / background
     的"选了 auto 就不发"是同一条规矩。 */
  const sendSize = !!size && size !== 'auto'

  // 图生图:gpt-image 等模型不接受 JSON 里的 data-url base64,
  // 必须走 multipart 文件上传(或在个别服务下传公网 URL)。
  let payload
  if (isImageGen) {
    const [meta, b64] = image.split(',')
    const mime = (meta.match(/data:([^;]+)/) || [])[1] || 'image/jpeg'
    const type = mime.includes('png') ? 'png' : 'jpeg'
    const fd = new FormData()
    if (model) fd.append('model', model)
    fd.append('prompt', prompt)
    fd.append('n', String(n))
    if (sendSize) fd.append('size', size)
    for (const [k, v] of Object.entries(extras)) fd.append(k, String(v))
    fd.append('image', new Blob([Buffer.from(b64, 'base64')], { type: mime }), `image.${type}`)
    payload = fd // fetch 自动设置 multipart boundary
  } else {
    headers['Content-Type'] = 'application/json'
    payload = JSON.stringify({
      model: model || undefined,
      prompt,
      n,
      ...(sendSize ? { size } : {}),
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

  try {
    const upstream = await fetch(target, {
      method: 'POST',
      headers,
      body: payload,
      signal: ac.signal,
      dispatcher: dispatcherFor(target)
    })

    const text = await upstream.text()

    if (!upstream.ok) {
      let detail = text
      // 收到 base64_input_not_supported 等错误,给出明确指引
      if (/base64_input_not_supported|b64传参|multipart/i.test(text)) {
        detail =
          "This endpoint doesn't accept the reference image as a file upload. It may need a public image URL or a specific file field name — check the image input spec of the endpoint behind your Base URL. Original error: " +
          text
      } else if (/unknown (parameter|argument)|unrecognized|unexpected.*parameter|invalid.*(parameter|param)/i.test(text)) {
        // 大多是不支持 quality / background 这类扩展参数
        detail =
          'The upstream doesn\'t recognize a parameter, usually quality or background (OpenAI-only extensions). In "Interface Settings", pick the right vendor, or set quality/background back to "Auto". Original error: ' +
          text
      }
      return res.status(upstream.status).json({
        error: `Upstream returned an error (${upstream.status})`,
        detail
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
    const hint = CONNECT_HINTS[code] || ''
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
 * 提示词改写代理。
 * 图像模型只出图、改不了提示词,所以这里不转发给 /images/*,而是把请求
 * 交给文本模型的 /chat/completions,让上游把提示词扩写得更具体、更有画面感。
 * baseUrl / apiKey / textModel 由前端单独一份「提示词增强」配置提供,
 * 与生图的接口配置互不影响 —— 两件事常常不是同一个服务商。
 */
app.post('/api/enhance', rateLimit, async (req, res) => {
  const { prompt, textModel, baseUrl, apiKey, mode } = req.body || {}

  // 只认两档,其余(含老前端不传)一律按保守档处理
  const enhanceMode = mode === 'creative' ? 'creative' : 'quick'

  if (!prompt) {
    return res.status(400).json({ error: 'Enter a prompt first' })
  }
  if (!baseUrl) {
    return res.status(400).json({ error: 'Configure your Base URL first' })
  }
  // 文本模型单独配:出图模型是图像模型,打不通 /chat/completions
  if (!textModel) {
    return res.status(400).json({ error: 'Set a text model in API settings first' })
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

  try {
    const upstream = await fetch(target, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: textModel,
        messages: [
          { role: 'system', content: ENHANCE_PROMPTS[enhanceMode] },
          { role: 'user', content: prompt }
        ],
        temperature: ENHANCE_TEMPERATURE[enhanceMode]
      }),
      signal: ac.signal,
      dispatcher: dispatcherFor(target)
    })

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
    const hint = CONNECT_HINTS[code] || ''
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

app.get('/api/health', (_req, res) => {
  res.json({ ok: true })
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