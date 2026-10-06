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
/* 尺寸 → 宽高比那条换算归 generate 那一份(见那里的 geminiRatio) ——
   编辑这条路只是复用同一个换算,不另写一遍 */
import { geminiRatio } from './generate.js'

export function registerEditRoute(app) {
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
        upstream = await safeFetch(target, {
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

}
