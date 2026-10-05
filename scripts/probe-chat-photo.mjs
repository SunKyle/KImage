/* ===== 对话出图整条链的端到端探针（不花钱，也不联网）=====================
 *
 *  起一个假上游，把 KImage 自己的服务端跑起来，然后打它三个端点：
 *  `/api/chat`（流式）→ `/api/enhance`（photo 档）→ `/api/generate`。
 *
 *  —— 为什么需要它 ——
 *
 *  单测只能证明"纯函数算得对"。这一条链上真正会出事的地方全在接缝上，
 *  而它们的表现都是**静默**的：
 *  - 扣尾算错 → 用户看见半截 `[pho` 闪出来，而正文内容一个字不差；
 *  - photo 档格式崩 → 摄影指导那一层悄悄降级回模板，出图照样成功；
 *  - 场景被截断 → 图能出来，只是和它说的话对不上。
 *  三种都不会报错，只会"图不太对味"。
 *
 *  用法：node scripts/probe-chat-photo.mjs
 *  退出码 0 = 全过。
 * ==================================================================== */

import { spawn } from 'node:child_process'
import http from 'node:http'
import { once } from 'node:events'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const UPSTREAM_PORT = 18431
const APP_PORT = 18432

/* ===== 假上游 ========================================================= */

/** 一次 `/api/chat` 要吐出来的正文。由每个用例自己设 */
let chatReply = ''
/** 让假上游在出图那一步回 401（用来验失败原因有没有传到浏览器） */
let FAIL_GENERATE = false
/** 每个用例要断言的请求：上游收到什么，探针就看什么 */
const seen = { chat: null, enhance: null, generate: null }

/** 把一段文本切成**很小**的增量 —— 扣尾的 bug 只在增量的边界上出现，
 *  一次吐一大块是测不出来的（那正是它会在生产里翻车的原因） */
function tinyChunks(s, size = 3) {
  const out = []
  for (let i = 0; i < s.length; i += size) out.push(s.slice(i, i + size))
  return out
}

function sse(res, pieces) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive'
  })
  /* **每个数据帧之间必须有换行** —— 少了它,所有帧会挤成一行,
     而服务端是逐行解析上游的。上一版这里用的是 '' 连接,
     结果服务端只认到第一帧,后面全当杂质丢了 ——
     表现是"客户端只收到第一个分片",看着像扣尾坏了,其实是假上游坏了 */
  const frames = pieces.map(
    (p) => `data: ${JSON.stringify({ choices: [{ delta: { content: p } }] })}\n\n`
  )
  frames.push(
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`,
    'data: [DONE]\n\n'
  )
  res.end(frames.join(''))
}

const upstream = http.createServer((req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    let json = {}
    try {
      json = JSON.parse(body)
    } catch {
      /* 空体也算合法（例如只读请求） */
    }
    if (req.url.endsWith('/chat/completions')) {
      /* 同一个地址上三种用途，靠 caller 记下来的顺序区分：
         第 1 次是 /api/chat，第 2 次是 /api/enhance（photo 档），
         它们的请求体长得很不一样，直接按形状分 */
      const isDirector = (json.messages || []).some(
        (m) => typeof m.content === 'string' && m.content.includes('You are the photographer')
      )
      if (isDirector) {
        seen.enhance = json
        const out = [
          'Shot: selfie',
          'Camera: held at arm\u2019s length, slightly above eye level',
          'Lens: shallow focus, the wall soft behind the shoulders',
          'Light: a cool streetlight just off frame to the right, catching the wet rail',
          'Environment: the harbour below, masts and lamps receding into haze'
        ].join('\n')
        res.writeHead(200, { 'Content-Type': 'application/json' })
        return res.end(JSON.stringify({ choices: [{ message: { content: out } }] }))
      }
      seen.chat = json
      return sse(res, tinyChunks(chatReply))
    }
    if (req.url.includes('images/generations') || req.url.includes('image')) {
      seen.generate = json
      /* 出图失败那条路:让假上游按真上游的样子回一个 401 加一句人话。
         这一条是"图片生成失败没提示"那次报错的回归 —— 服务端得把
         `error` 与 `detail` 原样带给浏览器,前端才有东西可显示 */
      if (FAIL_GENERATE) {
        res.writeHead(401, { 'Content-Type': 'application/json' })
        return res.end(
          JSON.stringify({
            error: 'Upstream returned an error (401)',
            detail: 'invalid api key'
          })
        )
      }
      /* 一张 1×1 的 PNG。出图那条路只要求"拿得到一个可转成 Blob 的 src" */
      const px =
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=='
      res.writeHead(200, { 'Content-Type': 'application/json' })
      return res.end(
        JSON.stringify({ data: [{ b64_json: px }] })
      )
    }
    res.writeHead(404).end('{}')
  })
})

/* ===== 断言 =========================================================== */

let failed = 0
function ok(name, cond, extra = '') {
  if (cond) {
    console.log(`  ✓ ${name}`)
  } else {
    failed++
    console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`)
  }
}

async function post(port, url, body) {
  const r = await fetch(`http://127.0.0.1:${port}${url}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
  return r
}

/** 读服务端吐回来的流。
 *
 *  **不是 SSE** —— 它在这一层已经从上游的 `data: {...}` 转成了 NDJSON:
 *  一行一个 JSON 对象,`{"delta":"…"}` 与收尾那一帧 `{"done":true,…,photo,…}`。
 *  解析方式与客户端 chatStream 逐行处理的那一套必须一致(见 src/api.ts),
 *  否则这里过了、浏览器里不过。 */
async function readChat(res) {
  const deltas = []
  let done = null
  const reader = res.body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  for (;;) {
    const { value, done: end } = await reader.read()
    if (end) break
    buf += dec.decode(value, { stream: true })
    const lines = buf.split('\n')
    buf = lines.pop() || ''
    for (const line of lines) {
      const text = line.trim()
      if (!text) continue
      let evt
      try {
        evt = JSON.parse(text)
      } catch {
        continue
      }
      if (typeof evt.delta === 'string') deltas.push(evt.delta)
      if (evt.done) done = evt
    }
  }
  return { deltas, text: deltas.join(''), done }
}

/* ===== 用例 =========================================================== */

const SCENE_FULL =
  'self:me leaning on the balcony rail at dusk, the rain just stopped, ' +
  'streetlights coming on below, hair still wet from the shower, ' +
  'the harbour lights doubled in the puddles on the deck'

async function main() {
  console.log('对话出图端到端探针\n')

  await new Promise((r) => upstream.listen(UPSTREAM_PORT, '127.0.0.1', r))

  const app = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(APP_PORT) },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  const appErr = []
  app.stderr.on('data', (d) => appErr.push(String(d)))
  /* 等它开始监听 */
  for (let i = 0; i < 60; i++) {
    try {
      await fetch(`http://127.0.0.1:${APP_PORT}/api/health`)
      break
    } catch {
      await new Promise((r) => setTimeout(r, 100))
    }
  }

  const cfg = {
    textModel: 'fake',
    baseUrl: `http://127.0.0.1:${UPSTREAM_PORT}/v1`,
    apiKey: 'k',
    character: { name: 'Alice' }
  }

  try {
    /* —— 用例 1：短场景，末尾两枚标签 —— */
    console.log('用例 1 · 普通回复 + 两枚标签')
    chatReply = 'Rain again. I am so tired of it.\n[photo:self:me on the balcony]\n[mood:tired]'
    let r = await post(APP_PORT, '/api/chat', { ...cfg, messages: [{ role: 'user', content: 'hi' }] })
    let out = await readChat(r)
    ok('正文里没有标签残留', !/\[(photo|mood)/.test(out.text), JSON.stringify(out.text))
    ok('正文完整（末句没被扣掉）', out.text.trim().endsWith('tired of it.'), JSON.stringify(out.text))
    ok('photo 剪出来了且 self 前缀被剪掉', out.done?.photo === 'me on the balcony', String(out.done?.photo))
    ok('photoSelf = true', out.done?.photoSelf === true)
    ok('mood = tired', out.done?.mood === 'tired', String(out.done?.mood))
    ok(
      '流式期间没有任何一帧露出半截标签',
      out.deltas.every((d) => !/\[(p|ph|pho|m|mo|moo)/.test(d)),
      JSON.stringify(out.deltas.filter((d) => d.includes('[')))
    )
    /* 这一条量的是"扣尾有没有把正文也一起停住"。**不是**量分了多少帧 ——
       扣尾会让释放的批次变少(那是它的正常工作),所以只要求正文被分成了
       多帧、而不是等到流末才一次吐出来 */
    const proseFrames = out.deltas.filter((d) => !d.includes('[photo') && d.trim())
    ok('正文是分多帧流出来的(扣尾没有把正文停住)', proseFrames.length > 3, String(proseFrames.length))

    /* —— 用例 2：接近上限的长场景 —— */
    console.log('\n用例 2 · 长场景（' + SCENE_FULL.length + ' 字）')
    chatReply = `Look at this.\n[photo:${SCENE_FULL}]\n[mood:warm]`
    r = await post(APP_PORT, '/api/chat', { ...cfg, messages: [{ role: 'user', content: 'hi' }] })
    out = await readChat(r)
    /* 场景原文里的 `self:` 是**标记不是内容**,服务端会连冒号一起剪掉 ——
       所以比对的是剪过的那一份。用显式的去前缀而不是数下标:
       标记的字符数一变,数下标就会静静地错一位 */
    const sceneText = SCENE_FULL.replace(/^self:/, '')
    ok('长场景整段保住', out.done?.photo === sceneText, `len=${out.done?.photo?.length} 期望 ${sceneText.length}`)
    ok('photoSelf = true', out.done?.photoSelf === true)
    ok('正文里没有标签残留', !/\[photo/.test(out.text))
    ok('正文本身完整', out.text.trim() === 'Look at this.', JSON.stringify(out.text))
    /* 关键：正文必须在场景那 400 字还没写完时就已经到了客户端。
       否则等于"扣尾把整条回复停到了流末" —— 那正是旧版按长度预留的毛病 */
    ok(
      '正文在场景写完之前就已经流出去了（扣尾没把整条回复停住）',
      out.text.trim() === 'Look at this.' && out.deltas.length > 3,
      JSON.stringify(out.deltas.slice(0, 5))
    )

    /* —— 用例 3：场景照（不写 self:）—— */
    console.log('\n用例 3 · 场景照')
    chatReply = 'It is coming down hard.\n[photo:rain on the window at dawn]'
    r = await post(APP_PORT, '/api/chat', { ...cfg, messages: [{ role: 'user', content: 'hi' }] })
    out = await readChat(r)
    ok('photo 剪出来了', out.done?.photo === 'rain on the window at dawn')
    ok('photoSelf = false（不写前缀就是它看到的东西）', out.done?.photoSelf === false)
    ok('没有 mood 时 mood 是空串', out.done?.mood === '')

    /* —— 用例 4：photo 档确实按五行回 —— */
    console.log('\n用例 4 · /api/enhance 的 photo 档')
    r = await post(APP_PORT, '/api/enhance', {
      prompt: 'scene: me on the balcony',
      mode: 'photo',
      textModel: 'fake',
      baseUrl: `http://127.0.0.1:${UPSTREAM_PORT}/v1`,
      apiKey: 'k'
    })
    const enh = await r.json()
    ok('HTTP 200', r.status === 200, JSON.stringify(enh))
    ok('回了五行', String(enh.prompt || '').trim().split('\n').length === 5, JSON.stringify(enh.prompt))
    ok('第一行是 Shot', /^Shot: (selfie|third)$/m.test(String(enh.prompt)))
    ok('四行标签齐全', ['Camera', 'Lens', 'Light', 'Environment'].every((k) => String(enh.prompt).includes(`${k}:`)))
    ok(
      '系统提示里用的是 photo 档（不是 quick）',
      (seen.enhance?.messages || [])[0]?.content?.includes('You are the photographer'),
      JSON.stringify((seen.enhance?.messages || [])[0]?.content?.slice(0, 60))
    )
    ok(
      '没把 REF_NOTE / 目标模型偏好塞进 photo 档',
      !String((seen.enhance?.messages || [])[0]?.content || '').includes('This is an image-to-image edit')
    )
    ok('温度是 0.6', seen.enhance?.temperature === 0.6, String(seen.enhance?.temperature))

    /* —— 用例 5：/api/generate 收到的是什么 —— */
    console.log('\n用例 5 · /api/generate 收到的载荷')
    r = await post(APP_PORT, '/api/generate', {
      prompt: 'photographic, shot on a phone front camera, me on the balcony, selfie at arm\u2019s length',
      size: '1024x1536',
      n: 1,
      quality: 'high',
      model: 'fake-img',
      baseUrl: `http://127.0.0.1:${UPSTREAM_PORT}/v1`,
      apiKey: 'k',
      vendor: 'openai'
    })
    ok('HTTP 200', r.status === 200, String(r.status))
    ok('提示词原样透传（服务端不二次加工）', String(seen.generate?.prompt || '').startsWith('photographic'))
    ok('quality 带上了', seen.generate?.quality === 'high')
    ok('size 是竖幅', seen.generate?.size === '1024x1536', String(seen.generate?.size))

    /* —— 用例 6：出图失败时，原因必须传到浏览器 ——
       这一条是"图片生成失败根本没有详细提示"那次报错的回归。
       浏览器那边只显示 `photoFailureText(e.message)`，所以**服务端把原话
       传没传出来**就是这条链的全部 —— 传丢了，界面上就只剩"生成失败"。 */
    console.log('\n用例 6 · 出图失败时原因要传到浏览器')
    FAIL_GENERATE = true
    r = await post(APP_PORT, '/api/generate', {
      prompt: 'a rooftop at dawn',
      size: '1024x1536',
      n: 1,
      model: 'fake-img',
      baseUrl: `http://127.0.0.1:${UPSTREAM_PORT}/v1`,
      apiKey: 'wrong',
      vendor: 'openai'
    })
    const failBody = await r.json().catch(() => ({}))
    ok('上游 401 映射成非 200', r.status !== 200, String(r.status))
    ok(
      '错误里带上上游的原话（不是一句笼统的"失败"）',
      String(failBody.error || '').includes('401'),
      JSON.stringify(failBody).slice(0, 160)
    )
    ok(
      'detail 也带上了（invalid api key）',
      String(failBody.detail || '').includes('invalid api key'),
      JSON.stringify(failBody.detail)
    )
    FAIL_GENERATE = false

    /* —— 用例 7：时间那一块 ——
       "现在几点 / 上次说话"由前端算好、服务端拼进 system（见 server/chatTime.js）。
       这一条链上会静默出错的正是**接缝**：前端没把字段发出来、服务端没接住、
       或者接住了却插错位置 —— 三种都不会报错，角色只是变得不知道时间，
       而"它不知道时间"这件事在产品上完全看不出来（它照聊不误）。 */
    console.log('\n用例 7 · 时间那一块')
    chatReply = 'Sure.'
    const STAMP = '2026-10-05T23:41:07+08:00'
    const STAMP_MS = Date.parse(STAMP)
    const systemOf = () => String(seen.chat?.messages?.[0]?.content || '')

    r = await post(APP_PORT, '/api/chat', {
      ...cfg,
      nowLocal: STAMP,
      lastAt: STAMP_MS - 3 * 24 * 60 * 60 * 1000,
      memory: 'They met in Lisbon.',
      messages: [{ role: 'user', content: 'hi' }]
    })
    await readChat(r)
    ok('当前时间进去了（含星期几）', systemOf().includes('Right now: 2026-10-05 23:41, Monday'), JSON.stringify(systemOf().slice(0, 120)))
    ok('没有秒（秒是机器的时间）', !systemOf().includes('23:41:07'))
    ok('上次说话的间隔进去了', /^You two last spoke 3 days ago\.$/m.test(systemOf()))
    ok('角色资料还在（没把别的块挤掉）', systemOf().includes('Name: Alice'))
    ok(
      '时间排在记忆之前 —— 记忆是一段成篇的叙述，夹在两块短事实中间会被切碎',
      systemOf().indexOf('Right now: 2026') < systemOf().indexOf('What has happened so far')
    )
    ok('规则里带着"别每句都报时"', systemOf().includes('it is a clock'))

    /* 没给时间（老前端、手搓请求、时钟坏掉）→ 整块不出现，且**不影响这一轮**。
       判据用行首锚定的正则、**不是 includes('Right now')** ——
       规则里本来就有"the time"这类字眼，拿子串判会误判成通过（第一版就踩了） */
    r = await post(APP_PORT, '/api/chat', { ...cfg, messages: [{ role: 'user', content: 'hi' }] })
    await readChat(r)
    ok('不给时间时整块消失', !/^Right now: /m.test(systemOf()))
    ok('也不留 "last spoke" 的空壳', !/^You two last spoke /m.test(systemOf()))

    r = await post(APP_PORT, '/api/chat', {
      ...cfg,
      nowLocal: 'today',
      lastAt: STAMP_MS,
      messages: [{ role: 'user', content: 'hi' }]
    })
    await readChat(r)
    ok('时间给坏了也只是没有这一块（不报错、不挡话）', !/^Right now: /m.test(systemOf()))
  } finally {
    app.kill()
    upstream.close()
    await once(app, 'exit').catch(() => {})
    if (appErr.length) console.log('\n[服务端 stderr]\n' + appErr.join('').slice(0, 2000))
  }

  console.log(failed === 0 ? '\n全部通过' : `\n${failed} 条没过`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
