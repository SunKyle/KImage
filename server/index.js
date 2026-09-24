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
    image
  } = req.body || {}

  if (!prompt) {
    return res.status(400).json({ error: 'prompt 不能为空' })
  }
  // baseUrl 必须由用户显式提供;apiKey 允许为空(部分本地服务无需鉴权)
  if (!baseUrl) {
    return res.status(400).json({ error: '请先配置接口地址 Base URL' })
  }

  const target = baseUrl.replace(/\/+$/, '') + '/images/generations'

  const isImageGen = image && typeof image === 'string' && image.startsWith('data:image')

  const headers = {}
  if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`
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
    if (responseFormat) fd.append('response_format', responseFormat)
    fd.append('image', new Blob([Buffer.from(b64, 'base64')], { type: mime }), `image.${type}`)
    payload = fd // fetch 自动设置 multipart boundary
  } else {
    headers['Content-Type'] = 'application/json'
    payload = JSON.stringify({
      model: model || undefined,
      prompt,
      n,
      size,
      ...(responseFormat ? { response_format: responseFormat } : {})
    })
  }

  try {
    const upstream = await fetch(target, {
      method: 'POST',
      headers,
      body: payload
    })

    const text = await upstream.text()

    if (!upstream.ok) {
      let detail = text
      // 收到 base64_input_not_supported 等错误,给出明确指引
      if (/base64_input_not_supported|b64传参|multipart/i.test(text)) {
        detail =
          '图生图已改用 multipart 文件上传发送参考图。若仍报该错,说明该接口需要图片公网 URL 或对文件字段命名有要求,请检查你的 baseUrl 对应接口的图生图规范。原始错误: ' +
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
    return res.status(502).json({ error: '无法连接上游服务', detail: String(e) })
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