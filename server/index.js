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

  const body = {
    model: model || undefined,
    prompt,
    n,
    size,
    ...(responseFormat ? { response_format: responseFormat } : {})
  }

  // 图生图:OpenAI 兼容接口通过 image_url 传入参考图(Data URL)
  if (image && typeof image === 'string' && image.startsWith('data:image')) {
    body.image = [image]
  }

  const headers = { 'Content-Type': 'application/json' }
  if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`
  }

  try {
    const upstream = await fetch(target, {
      method: 'POST',
      headers,
      body: JSON.stringify(body)
    })

    const text = await upstream.text()

    if (!upstream.ok) {
      let detail = text
      // 豆包 Seedream 3.0-t2i 等纯文生图模型不接受参考图,给出明确指引
      if (/base64_input_not_supported|b64传参|multipart/i.test(text)) {
        detail =
          '当前模型不支持参考图(图生图)。若用的是豆包,请将模型换成支持图生图的版本(如 doubao-seedream-4.0 / 4.5 / 5.0),3.0-t2i 为纯文生图。原始错误: ' +
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