import express from 'express'
import cors from 'cors'
import dotenv from 'dotenv'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'

dotenv.config()

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DIST = path.resolve(__dirname, '../dist')

const app = express()
app.use(cors())
app.use(express.json({ limit: '15mb' }))

// 连接层失败的常见原因与排查方向,附在报错里,避免只看到一句 "fetch failed"
const CONNECT_HINTS = {
  ENOTFOUND: '域名解析失败,请检查 Base URL 拼写与本机 DNS。',
  ECONNREFUSED: '目标拒绝连接,请检查地址与端口是否正确。',
  ETIMEDOUT: '连接超时,通常是网络不通或该接口被阻断,可改用国内可达的接口。',
  UND_ERR_CONNECT_TIMEOUT:
    '连接超时,通常是网络不通或该接口被阻断;海外接口在国内直连会被丢包,需换用国内节点或为服务端配置代理。',
  UNABLE_TO_VERIFY_LEAF_SIGNATURE:
    'TLS 证书不被 Node 信任,多见于本地代理软件的根证书,需把根证书加入 NODE_EXTRA_CA_CERTS。',
  SELF_SIGNED_CERT_IN_CHAIN:
    'TLS 证书链含自签证书,多见于本地代理软件,需把根证书加入 NODE_EXTRA_CA_CERTS。'
}

/**
 * 通用图像生成代理。
 * 前端把配置(prompt / size / n / model / baseUrl / apiKey)POST 过来,
 * 后端转发给任意 OpenAI 兼容的 /images/generations 接口。
 * 这样可兼容豆包 Seedream、通义万相、Flux、以及各大模型生图 API,
 * 同时避免前端直接调第三方接口遇到跨域问题。
 */
app.post('/api/generate', async (req, res) => {
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
    return res.status(400).json({ error: 'prompt 不能为空' })
  }
  // baseUrl 必须由用户显式提供;apiKey 允许为空(部分本地服务无需鉴权)
  if (!baseUrl) {
    return res.status(400).json({ error: '请先配置接口地址 Base URL' })
  }

  const isImageGen = image && typeof image === 'string' && image.startsWith('data:image')

  // OpenAI 的图生图走 /images/edits,其余厂商仍在 /images/generations 上用 multipart 传参考图
  const endpoint = isImageGen && vendor === 'openai' ? '/images/edits' : '/images/generations'
  const target = baseUrl.replace(/\/+$/, '') + endpoint

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
    fd.append('size', size)
    for (const [k, v] of Object.entries(extras)) fd.append(k, String(v))
    fd.append('image', new Blob([Buffer.from(b64, 'base64')], { type: mime }), `image.${type}`)
    payload = fd // fetch 自动设置 multipart boundary
  } else {
    headers['Content-Type'] = 'application/json'
    payload = JSON.stringify({
      model: model || undefined,
      prompt,
      n,
      size,
      ...extras
    })
  }

  // 前端点"终止"会断开连接;这里同步中断对上游的请求,
  // 并借此判断连接是否还在,避免往已断开的响应里写数据
  const ac = new AbortController()
  res.on('close', () => {
    if (!res.writableEnded) ac.abort()
  })

  try {
    const upstream = await fetch(target, {
      method: 'POST',
      headers,
      body: payload,
      signal: ac.signal
    })

    const text = await upstream.text()

    if (!upstream.ok) {
      let detail = text
      // 收到 base64_input_not_supported 等错误,给出明确指引
      if (/base64_input_not_supported|b64传参|multipart/i.test(text)) {
        detail =
          '图生图已改用 multipart 文件上传发送参考图。若仍报该错,说明该接口需要图片公网 URL 或对文件字段命名有要求,请检查你的 baseUrl 对应接口的图生图规范。原始错误: ' +
          text
      } else if (/unknown (parameter|argument)|unrecognized|unexpected.*parameter|invalid.*(parameter|param)/i.test(text)) {
        // 大多是不支持 quality / background 这类扩展参数
        detail =
          '上游不认识请求里的某个参数,最常见的是 quality / background —— 这两个是 OpenAI 系的扩展参数。请到「接口设置」把厂商选对(选对后界面会隐藏不支持的参数),或把参数面板里的画质/背景改回「自动」。原始错误: ' +
          text
      }
      return res.status(upstream.status).json({
        error: `上游接口错误 ${upstream.status}`,
        detail
      })
    }

    // 透传上游返回体
    res.setHeader('Content-Type', 'application/json')
    res.send(text)
  } catch (e) {
    // 客户端点了"终止"(fetch 被中断),或响应已经发出:都无需也无法再回响应
    if (e?.name === 'AbortError' || res.headersSent) return
    // undici(Node fetch)遇到连接层失败时只抛 "fetch failed",
    // 真正的原因(DNS/TCP/TLS)藏在 e.cause 里,这里一并透出,否则无法排查
    const cause = e?.cause
    const code = cause?.code || cause?.errno || ''
    const reason = [code, cause?.message].filter(Boolean).join(' ') || String(e)
    const hint = CONNECT_HINTS[code] || ''
    return res.status(502).json({
      error: '无法连接上游服务',
      detail: `${target} — ${reason}。${hint}`
    })
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