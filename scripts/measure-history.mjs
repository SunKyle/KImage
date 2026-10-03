#!/usr/bin/env node
/* ===== 历史页性能测量 ==================================================
   用无头 Chrome + DevTools 协议量三件事,给出"改动前后"能对比的数字:

   1. 启动:导航开始 → 首页图墙出现第一块(含 loadHistory 读库 + 渲染)
   2. 历史页:点导航 → 图块铺出来(这是 T3.1 要盯的那条)
   3. DOM 规模:节点总数与 <img> 数(全量渲染会随条数线性涨)

   为什么要真开一个浏览器:这些数字里没有一个能在 Node 里算出来 ——
   它们取决于真实布局、图片解码与 Vue 的挂载成本。

   用法(先起一个服务):
     npx vite preview --port 4173 &
     node scripts/measure-history.mjs --url http://localhost:4173/ --records 500

   只依赖 undici(项目已有依赖,它带 WebSocket),不引入 puppeteer。
   -------------------------------------------------------------------- */

import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { deflateSync } from 'node:zlib'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocket } from 'undici'

const args = process.argv.slice(2)
const arg = (name, def) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] ? args[i + 1] : def
}

const URL_ = arg('url', 'http://localhost:4173/')
const RECORDS = Number(arg('records', 500))
const IMAGES = Number(arg('images', 2))
const IMG_SIZE = Number(arg('img-size', 256))
/* 造不带缩略图的老数据:这样 backfillThumbs 才有活干(它只补缺的) */
const NO_THUMB = args.includes('--no-thumb')
/* 启动之后观察多久的长任务(毫秒) */
const SETTLE_MS = Number(arg('settle-ms', 4000))
/* 顺带量一下编码成本:画布那条路把位图编成 data URL 是不是真的卡主线程 */
const PROBE_ENCODE = args.includes('--probe-encode')
/* 探一下存储层的让位与重开:另一个连接要删库时,应用必须让开并且能重新开起来 */
const PROBE_REOPEN = args.includes('--probe-reopen')
/* 开第二个标签页,验证跨页同步真的把改动传过去了 */
const PROBE_TWO_TABS = args.includes('--probe-two-tabs')
/* 探画布的操作序列:上传一张图,旋转 → 撤销 → 重做 → 跳步,看步骤条对不对 */
const PROBE_CANVAS = args.includes('--probe-canvas')
/* 探接口配置那一域:设置页新增一条 → 回首页看参数行胶囊是不是它 */
const PROBE_CONFIG = args.includes('--probe-config')
/* 探历史那一域:删一条 → 撤销把它放回来;再建一个作品集 */
const PROBE_HISTORY = args.includes('--probe-history')
/* 探角色那一域:新建一个角色 → 卡片出现 → 拿它开画 */
const PROBE_CHARS = args.includes('--probe-chars')
/* 探对话那一域:播种一段对话与记忆 → 渲染 → 清空 */
const PROBE_CHAT = args.includes('--probe-chat')
/* 探出图参数那一层:尺寸档位、参考图上传与清除 */
const PROBE_PARAMS = args.includes('--probe-params')
/* 调试端口每轮随机取一个:固定端口会与上一次没退干净的实例撞车,
   而那种撞车表现为"连上了,但连到的是别人",量出来的数看着正常其实全错 */
const PORT = Number(arg('cdp-port', 0)) || 9300 + Math.floor(Math.random() * 600)
/* Chrome 的位置按平台找:本地(macOS)与 CI(Linux)要都能跑起来。
   找不到就交给 PATH —— GitHub 的 runner 上 google-chrome 就在 PATH 里 */
function defaultChrome() {
  const candidates = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser'
  ]
  for (const p of candidates) if (existsSync(p)) return p
  return 'google-chrome'
}
const CHROME = arg('chrome', process.env.CHROME_PATH || defaultChrome())

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/* 探画布时要塞一个真文件进 <input type=file>:CDP 只能注入磁盘上的路径,
   所以这里现造一张 PNG。
   **别用"背下来的 base64"** —— 我第一版就是这么干的,那张图是坏的:
   解码失败 → source 为 null → rebuild() 直接清空步骤,于是表现为
   "点了旋转但什么都没发生"。按规范拼一张(CRC 也算对)才是可靠的 */
const UPLOAD_PNG = join(tmpdir(), `kimage-probe-${process.pid}.png`)
writeFileSync(UPLOAD_PNG, makePng(64))

function crc32(buf) {
  let c = ~0
  for (const b of buf) {
    c ^= b
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1))
  }
  return ~c >>> 0
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([len, body, crc])
}

/** 一张 size×size 的 8 位 RGB PNG(渐变 + 每行不同,够画布做旋转/翻转) */
function makePng(size) {
  const stride = size * 3 + 1
  const raw = Buffer.alloc(stride * size)
  for (let y = 0; y < size; y++) {
    raw[y * stride] = 0 // 过滤器:None
    for (let x = 0; x < size; x++) {
      const i = y * stride + 1 + x * 3
      raw[i] = (x * 4) % 256
      raw[i + 1] = (y * 4) % 256
      raw[i + 2] = 128
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // 位深
  ihdr[9] = 2 // 颜色类型:真彩
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0))
  ])
}

/* —— 启动 Chrome —— */
const profile = mkdtempSync(join(tmpdir(), 'kimage-perf-'))
const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    /* 这几条是在受限环境(容器/沙箱)里跑起来的必要条件:
       Chrome 自己的沙箱初始化会被外层沙箱拒掉("sandbox initialization failed"),
       渲染与网络进程随即崩溃、CDP 连接被关(1006)。关掉它的沙箱并把
       crashpad 一并关掉,才能稳定跑完测量。仅用于本地测量,不是产品配置 */
    '--no-sandbox',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--disable-crashpad',
    '--disable-crash-reporter',
    // Chrome 111+ 默认拒绝带 Origin 的调试连接
    '--remote-allow-origins=*',
    // 关掉节流:无头下 rAF/定时器会被压制,量出来的"渲染完成"会假慢
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    URL_
  ],
  { stdio: 'ignore', detached: false }
)

let ws
let msgId = 0
const pending = new Map()

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++msgId
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`CDP 超时: ${method}`))
    }, 60_000)
    pending.set(id, (msg) => {
      clearTimeout(timer)
      if (msg.error) reject(new Error(`${method}: ${msg.error.message}`))
      else resolve(msg.result)
    })
    ws.send(JSON.stringify({ id, method, params }))
  })
}

/** 在页面里跑一段脚本并等它的 promise 结果 */
async function evaluate(fn, ...fnArgs) {
  const { result, exceptionDetails } = await send('Runtime.evaluate', {
    expression: `(${fn.toString()})(${fnArgs.map((a) => JSON.stringify(a)).join(', ')})`,
    awaitPromise: true,
    returnByValue: true
  })
  if (exceptionDetails) throw new Error(exceptionDetails.exception?.description || '页面脚本抛错')
  return result.value
}

/* 再连一个页面 target(第二个标签页要单独一条通道) */
async function connectTarget(wsUrl) {
  const sock = new WebSocket(wsUrl)
  const pend = new Map()
  let n = 0
  sock.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data)
    const f = m.id && pend.get(m.id)
    if (f) {
      pend.delete(m.id)
      f(m)
    }
  })
  await new Promise((r) => sock.addEventListener('open', r, { once: true }))
  const sendTo = (method, params = {}) =>
    new Promise((res, rej) => {
      const id = ++n
      const timer = setTimeout(() => {
        pend.delete(id)
        rej(new Error(`CDP 超时(第二页): ${method}`))
      }, 30_000)
      pend.set(id, (m) => {
        clearTimeout(timer)
        if (m.error) rej(new Error(m.error.message))
        else res(m.result)
      })
      sock.send(JSON.stringify({ id, method, params }))
    })
  const runOn = async (fn, ...a) => {
    const { result, exceptionDetails } = await sendTo('Runtime.evaluate', {
      expression: `(${fn.toString()})(${a.map((x) => JSON.stringify(x)).join(', ')})`,
      awaitPromise: true,
      returnByValue: true
    })
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description || '第二页脚本抛错')
    return result.value
  }
  return { send: sendTo, evaluate: runOn, close: () => sock.close() }
}

/** 让另一个标签页切到历史页。
 *  用真实鼠标事件:分段控件是 @pointerdown 驱动的,合成 click 不生效 */
async function gotoHistory(client) {
  await client.send('Runtime.enable')
  await client.send('Page.enable')
  // 应用挂载完才有导航按钮(新标签页要等它加载)
  for (let i = 0; i < 60; i++) {
    if (await client.evaluate(() => !!document.querySelector('button[aria-label="History"]')))
      break
    await sleep(250)
  }
  const box = await client.evaluate(() => {
    const b = document.querySelector('button[aria-label="History"]')
    if (!b) return null
    const r = b.getBoundingClientRect()
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
  })
  if (!box) throw new Error('另一个标签页找不到导航按钮')
  for (const type of ['mousePressed', 'mouseReleased']) {
    await client.send('Input.dispatchMouseEvent', {
      type,
      x: box.x,
      y: box.y,
      button: 'left',
      clickCount: 1
    })
  }
  // 等图块铺出来
  for (let i = 0; i < 80; i++) {
    const n = await client.evaluate(() => document.querySelectorAll('section.lib .tile').length)
    if (n > 0) return n
    await sleep(100)
  }
  return 0
}

/* 等某个 CDP 事件到达(只在需要时挂一次监听) */
function onceEvent(method, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.removeEventListener('message', onMsg)
      reject(new Error(`等不到事件: ${method}`))
    }, timeoutMs)
    const onMsg = (ev) => {
      const msg = JSON.parse(ev.data)
      if (msg.method === method) {
        clearTimeout(timer)
        ws.removeEventListener('message', onMsg)
        resolve(msg.params)
      }
    }
    ws.addEventListener('message', onMsg)
  })
}

/* 等页面里某个条件成立。比"等 load 事件"可靠:应用的落库是异步的 */
async function waitFor(label, checkFn, timeoutMs = 30_000) {
  const started = Date.now()
  let lastErr = null
  for (;;) {
    try {
      if (await evaluate(checkFn)) return Date.now() - started
    } catch (e) {
      // 文档正在切换时取数会抛(见上面那段)。这不是失败,下一轮再看
      lastErr = e
    }
    if (Date.now() - started > timeoutMs) {
      throw new Error(`等不到: ${label}${lastErr ? ` (最后一次: ${lastErr.message})` : ''}`)
    }
    await sleep(50)
  }
}

async function main() {
  // 等 CDP 端口就绪
  let version = null
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`)
      version = await r.json()
      break
    } catch {
      await sleep(250)
    }
  }
  if (!version) {
    throw new Error(
      `Chrome 的调试端口没起来(用的是 ${CHROME})。本地可用 --chrome <路径> 指定,或设 CHROME_PATH`
    )
  }

  // 找到我们那个页面(启动时就带了 URL)
  let page = null
  for (let i = 0; i < 40; i++) {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
    page = list.find((t) => t.type === 'page' && t.url.startsWith(URL_.split('?')[0]))
    if (page) break
    await sleep(250)
  }
  if (!page) throw new Error('找不到打开的页面')

  ws = new WebSocket(page.webSocketDebuggerUrl)
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data)
    if (msg.id && pending.has(msg.id)) {
      const done = pending.get(msg.id)
      pending.delete(msg.id)
      done(msg)
    }
  })
  await new Promise((r) => ws.addEventListener('open', r, { once: true }))
  await send('Runtime.enable')
  await send('Page.enable')

  /* 先把文档"落定"。启动时带的那个 URL 在导航开始后 target.url 就变了,
     但文档可能还是旧的 about:blank —— 这时候 Runtime.evaluate 作用在旧文档上,
     indexedDB 会以 SecurityError 被拒(第一版就撞上过这个)。主动 reload 一次、
     等 load 事件,才能保证后面每一条脚本都跑在我们的页面上 */
  const firstLoad = onceEvent('Page.loadEventFired')
  await send('Page.reload', { ignoreCache: true })
  await firstLoad

  // 应用自己会建库(表结构都在它那儿),所以要等它先跑过一轮
  await waitFor('应用建好 IndexedDB', () =>
    indexedDB.databases().then((d) => d.some((x) => x.name === 'kimage.db'))
  )

  // —— 造数据。直接写 IndexedDB,绕开应用自己的清理逻辑 ——
  const seeded = await evaluate(
    async (n, images, size, noThumb) => {
      const c = document.createElement('canvas')
      c.width = c.height = size
      const ctx = c.getContext('2d')
      const g = ctx.createLinearGradient(0, 0, size, size)
      g.addColorStop(0, '#2b6cb0')
      g.addColorStop(1, '#f6ad55')
      ctx.fillStyle = g
      ctx.fillRect(0, 0, size, size)
      // 撒点噪声,别让图片压成几百字节 —— 解码成本要接近真实
      const px = ctx.getImageData(0, 0, size, size)
      for (let i = 0; i < px.data.length; i += 4) px.data[i] = (px.data[i] + Math.random() * 60) % 255
      ctx.putImageData(px, 0, 0)
      const blob = await new Promise((r) => c.toBlob(r, 'image/webp', 0.85))

      const db = await new Promise((res, rej) => {
        const r = indexedDB.open('kimage.db')
        r.onsuccess = () => res(r.result)
        r.onerror = () => rej(r.error)
      })
      const tx = db.transaction('history', 'readwrite')
      const store = tx.objectStore('history')
      const now = Date.now()
      for (let i = 0; i < n; i++) {
        store.put({
          id: `perf-${i}`,
          prompt: `performance probe record ${i}`,
          size: '1024x1024',
          model: 'perf-model',
          createdAt: now - i * 60_000,
          results: Array.from({ length: images }, () => ({ type: 'b64', data: blob })),
          // 老记录没有缩略图与尺寸 —— backfillThumbs 要补的正是这两项
          ...(noThumb ? {} : { thumb: blob, w: size, h: size })
        })
      }
      await new Promise((r) => (tx.oncomplete = r))
      db.close()
      return n
    },
    RECORDS,
    IMAGES,
    IMG_SIZE,
    NO_THUMB
  )

  /* 长任务观察器要在**页面脚本之前**装好,否则会漏掉启动那一段 ——
     而"启动之后还在跑的后台活儿"正是 backfillThumbs 那类问题的形状 */
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `
      window.__lt = [];
      try {
        new PerformanceObserver((l) => {
          for (const e of l.getEntries()) window.__lt.push(Math.round(e.duration));
        }).observe({ entryTypes: ['longtask'] });
      } catch (e) { window.__ltError = String(e); }
    `
  })

  /* —— 启动路径:重载 → 新文档 load → 首页图墙出现第一块 ——
     必须等 loadEventFired:在此之前量到的 performance.now() 还是**旧文档**的,
     两个文档的 timeOrigin 不同,混在一起算出来的数没有意义 */
  const loaded = onceEvent('Page.loadEventFired')
  await send('Page.reload', { ignoreCache: true })
  await loaded
  // 此刻 performance.now() 已经是新文档里相对 navigationStart 的毫秒数
  await waitFor('首页图墙首块', () => document.querySelectorAll('.feed-grid .tile').length > 0)
  const startupMs = await evaluate(() => performance.now())
  const navTiming = await evaluate(() => {
    const n = performance.getEntriesByType('navigation')[0]
    return n
      ? { domContentLoaded: Math.round(n.domContentLoadedEventEnd), loadEnd: Math.round(n.loadEventEnd) }
      : null
  })

  // —— 历史页:点导航 → 图块铺出来 ——
  /* 点导航必须走**真实输入**:分段控件是 @pointerdown 驱动的,
     合成一次 click() 不会切页(第一版就踩了这个坑,量到的一直是首页) */
  const btnBox = await evaluate(() => {
    const b = document.querySelector('button[aria-label="History"]')
    if (!b) return null
    const r = b.getBoundingClientRect()
    window.__t0 = performance.now()
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
  })
  if (!btnBox) throw new Error('找不到 History 导航按钮')
  for (const type of ['mousePressed', 'mouseReleased']) {
    await send('Input.dispatchMouseEvent', {
      type,
      x: btnBox.x,
      y: btnBox.y,
      button: 'left',
      clickCount: 1
    })
  }

  const history = await evaluate(async () => {
    const nav = document.querySelector('button[aria-label="History"]')
    const t0 = window.__t0 || performance.now()
    const deadline = t0 + 30_000
    /* 两段等待缺一不可:
       1. 导航真的切过去(aria-checked)—— 首页那 12 块 .tile 在切换瞬间还在
          DOM 里,只等 .tile 出现会立刻"成功",量到的是上一页
       2. 图块数量稳定下来 —— 这才是"全部铺完"的那一刻,DOM 计数才有意义 */
    while (nav?.getAttribute('aria-checked') !== 'true' && performance.now() < deadline) {
      await new Promise((r) => requestAnimationFrame(r))
    }
    const switched = nav?.getAttribute('aria-checked') === 'true'
    let last = -1
    let stable = 0
    while (performance.now() < deadline && stable < 3) {
      const n = document.querySelectorAll('section.lib .tile').length
      if (n === last) stable++
      else {
        stable = 0
        last = n
      }
      await new Promise((r) => requestAnimationFrame(r))
    }
    /* 只数这一页自己的子树:无头模式下离场页的过渡可能不结束,
       残留的上一页会混进文档级计数(第一版就把首页那 12 块算进来了) */
    const page = document.querySelector('section.lib')
    return {
      switched,
      msToStable: +(performance.now() - t0).toFixed(1),
      tiles: page ? page.querySelectorAll('.tile').length : 0,
      imgs: page ? page.querySelectorAll('img').length : 0,
      domNodes: page ? page.getElementsByTagName('*').length : 0,
      // 顺带报一下文档级:能看出残留页有多大
      docDomNodes: document.getElementsByTagName('*').length,
      pageCount: document.querySelectorAll('main.frame > section').length
    }
  })

  /* —— 启动之后的后台活儿 ——
     静置一段时间,看主线程被长任务占了多少(>50ms 的才算),
     以及多少条老记录被补上了缩略图 */
  await sleep(SETTLE_MS)
  const background = await evaluate(async (settleMs) => {
    const lt = window.__lt || []
    const stats = {
      settleMs,
      longTasks: lt.length,
      totalBlockingMs: lt.reduce((a, b) => a + b, 0),
      maxTaskMs: lt.length ? Math.max(...lt) : 0
    }
    const db = await new Promise((res, rej) => {
      const r = indexedDB.open('kimage.db')
      r.onsuccess = () => res(r.result)
      r.onerror = () => rej(r.error)
    })
    const all = await new Promise((res, rej) => {
      const r = db.transaction('history', 'readonly').objectStore('history').getAll()
      r.onsuccess = () => res(r.result)
      r.onerror = () => rej(r.error)
    })
    db.close()
    stats.records = all.length
    stats.withThumb = all.filter((r) => r.thumb && r.w && r.h).length
    return stats
  }, SETTLE_MS)

  /* —— 编码探针 ——
     画布那条路要交的是 data URL,而 toDataURL 是**全同步**的:
     大图那一下会把主线程按住(原地编辑的"点了没反应"多半来自这里)。
     同尺寸下再量一遍 toBlob + FileReader 那条异步路做对照。 */
  const encode = PROBE_ENCODE
    ? await evaluate(async (size) => {
        const c = document.createElement('canvas')
        c.width = size
        c.height = Math.round((size * 9) / 16)
        const ctx = c.getContext('2d')
        const g = ctx.createLinearGradient(0, 0, c.width, c.height)
        g.addColorStop(0, '#2b6cb0')
        g.addColorStop(1, '#f6ad55')
        ctx.fillStyle = g
        ctx.fillRect(0, 0, c.width, c.height)
        // 撒噪声:纯色图 PNG 只要几十 KB,量不出真实编码成本
        const px = ctx.getImageData(0, 0, c.width, c.height)
        for (let i = 0; i < px.data.length; i += 4) px.data[i] = (px.data[i] + Math.random() * 60) % 255
        ctx.putImageData(px, 0, 0)

        const time = (fn) => {
          const t = performance.now()
          const v = fn()
          return { ms: +(performance.now() - t).toFixed(1), v }
        }
        const jpeg = time(() => c.toDataURL('image/jpeg', 0.92))
        const png = time(() => c.toDataURL('image/png'))
        const blobStart = performance.now()
        const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.92))
        const blobMs = +(performance.now() - blobStart).toFixed(1)
        const readStart = performance.now()
        const url = await new Promise((resolve, reject) => {
          const fr = new FileReader()
          fr.onload = () => resolve(String(fr.result))
          fr.onerror = () => reject(fr.error)
          fr.readAsDataURL(blob)
        })
        const readMs = +(performance.now() - readStart).toFixed(1)
        return {
          size: `${c.width}x${c.height}`,
          // 同步:这两下期间主线程什么都干不了
          jpegDataUrlSyncMs: jpeg.ms,
          pngDataUrlSyncMs: png.ms,
          jpegDataUrlMB: +(jpeg.v.length / 1048576).toFixed(2),
          pngDataUrlMB: +(png.v.length / 1048576).toFixed(2),
          // 异步:编码交给浏览器,主线程只在回调时被占用
          toBlobMs: blobMs,
          blobToDataUrlMs: readMs,
          asyncTotalMs: +(blobMs + readMs).toFixed(1),
          sameBytes: url.length === jpeg.v.length
        }
      }, Number(arg('probe-size', 2560)))
    : null

  /* —— 让位与重开探针 ——
     缓存了连接之后,"别人要删库/升级"这条路上必须做两件事:
     ① 让开(否则对方的 deleteDatabase 会一直卡在 blocked)
     ② 之后还能重新开起来并写入(否则缓存就永久指向一个死连接)
     单测覆盖不到这一段(要真的 IndexedDB),所以在真浏览器里走一遍:
     标记一张图触发一次写 → 从页面里删库 → 再标记一次触发写 → 读回来确认 */
  const reopen = PROBE_REOPEN
    ? await evaluate(async () => {
        const out = { steps: [] }
        const open = () =>
          new Promise((res, rej) => {
            const r = indexedDB.open('kimage.db')
            r.onsuccess = () => res(r.result)
            r.onerror = () => rej(r.error)
          })
        const readCount = async () => {
          const db = await open()
          const all = await new Promise((res, rej) => {
            const r = db.transaction('history', 'readonly').objectStore('history').getAll()
            r.onsuccess = () => res(r.result)
            r.onerror = () => rej(r.error)
          })
          db.close()
          return all
        }
        const clickMark = () => {
          const b = [...document.querySelectorAll('button')].find(
            (x) => (x.getAttribute('aria-label') || '').startsWith('Mark image')
          )
          if (!b) return false
          b.click()
          return true
        }
        const settle = () => new Promise((r) => setTimeout(r, 400))

        // ① 先写一次(标记一张图),确认正常
        out.steps.push(['click first mark', clickMark()])
        await settle()
        const afterFirst = await readCount()
        out.markedAfterFirst = afterFirst.filter((r) => r.results?.some((x) => x.marked)).length

        // ② 从页面里删库:应用的连接必须让开,否则这里会一直 blocked
        const delStart = performance.now()
        out.deleteResult = await new Promise((res) => {
          const req = indexedDB.deleteDatabase('kimage.db')
          req.onsuccess = () => res('success')
          req.onerror = () => res('error')
          req.onblocked = () => res('blocked')
          setTimeout(() => res('timeout'), 5000)
        })
        out.deleteMs = +(performance.now() - delStart).toFixed(1)

        // ③ 再写一次:应用应当重新开库(顺带重建表结构)并写进去
        await settle()
        out.steps.push(['click mark after delete', clickMark()])
        await settle()
        try {
          const afterSecond = await readCount()
          out.recordsAfterReopen = afterSecond.length
        } catch (e) {
          out.reopenError = String(e)
        }
        return out
      })
    : null

  /* —— 跨标签页同步探针 ——
     同一个 Chrome profile 下的两个标签页共享 IndexedDB 与 BroadcastChannel。
     在 A 页标记一张图,看 B 页(已经开着历史页)会不会跟着亮出标记角标。
     这是 A2 唯一的真实验证方式:纯函数单测只能证明"合并逻辑对",
     证明不了"广播真的送到了、而且对面真的重读了"。 */
  let twoTabs = null
  if (PROBE_TWO_TABS) {
    twoTabs = { steps: [] }
    const created = await fetch(
      `http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(URL_)}`,
      { method: 'PUT' }
    ).then((r) => (r.ok ? r.json() : null))
    if (!created?.webSocketDebuggerUrl) {
      twoTabs.error = '开不了第二个标签页'
    } else {
      const other = await connectTarget(created.webSocketDebuggerUrl)
      try {
        twoTabs.tilesInB = await gotoHistory(other)
        const countMarked = () =>
          other.evaluate(() => document.querySelectorAll('section.lib .tile-mark').length)
        twoTabs.markedInB_before = await countMarked()

        // 在 A 页标记第一张(点的是真实按钮,走的是应用自己的落库与广播)
        twoTabs.clickedInA = await evaluate(() => {
          const b = [...document.querySelectorAll('button')].find((x) =>
            (x.getAttribute('aria-label') || '').startsWith('Mark image')
          )
          if (!b) return false
          b.click()
          return true
        })
        // 等广播(收拢窗口 250ms)+ 对面重读
        await sleep(2000)
        twoTabs.markedInB_after = await countMarked()
        /* 顺带把"提示条"也验了:同步之后 B 页应当弹一句"从另一个标签页更新"。
           这条通道(useFeedback)平时没有自动化覆盖,而它每一块业务域都要用 */
        twoTabs.noticeInB = await other.evaluate(
          () => document.querySelector('.note')?.textContent?.trim().slice(0, 48) || ''
        )
        twoTabs.passed =
          twoTabs.markedInB_after > twoTabs.markedInB_before &&
          /another tab/i.test(twoTabs.noticeInB)
      } catch (e) {
        twoTabs.error = String(e.message || e)
      } finally {
        /* 收尾必须**关掉那个标签页并回到前台**:留着它的话,后面探针发给
           主标签页的鼠标事件会不再生效(连跑时表现成"点了新建角色却什么都没有",
           单独跑却一路通过 —— 就是被这个坑掉的)。 */
        try {
          await other.send('Page.close')
        } catch {
          /* 关不掉也不该让测量整体失败 */
        }
        try {
          await send('Page.bringToFront')
        } catch {
          /* 同上 */
        }
        other.close()
        await sleep(400)
      }
    }
  }

  /* —— 画布操作序列探针 ——
     撤销/重做/跳步这套栈逻辑刚被搬进 lib/canvasOps.ts,那里有单测;
     但"组件真的接上了没有"只有真点一遍才知道。步骤条上的 .step 与
     aria-current 正好把"现在停在第几步、一共有几步"暴露在 DOM 上。 */
  let canvas = null
  if (PROBE_CANVAS) {
    canvas = { steps: [] }
    const readSteps = () =>
      evaluate(() => {
        const all = [...document.querySelectorAll('.step')]
        const btn = (l) => document.querySelector(`button[aria-label="${l}"]`)
        /* 按钮不在 DOM 里(比如左栏那组折叠着)时要报出来,而不是被
           `!undefined` 算成"可用" —— 那种假绿比红更糟 */
        return {
          total: all.length,
          current: all.findIndex((el) => el.getAttribute('aria-current') === 'true'),
          hasButtons: !!btn('Undo') && !!btn('Rotate right'),
          canUndo: btn('Undo') ? !btn('Undo').disabled : null,
          canRedo: btn('Redo') ? !btn('Redo').disabled : null
        }
      })
    /* 点击结果要记下来:找不到按钮、或按钮是 disabled(那时 click 是空操作),
       这两种"没点动"最容易被当成"点了但功能坏了" */
    const click = (label) =>
      evaluate((l) => {
        const b = document.querySelector(`button[aria-label="${l}"]`)
        if (!b) return 'missing'
        if (b.disabled) return 'disabled'
        b.click()
        return 'clicked'
      }, label)
    const settle = () => sleep(300)

    try {
      // 进画布页(与历史页同一套:分段控件是 pointerdown 驱动的)
      const box = await evaluate(() => {
        const b = document.querySelector('button[aria-label="Canvas"]')
        if (!b) return null
        const r = b.getBoundingClientRect()
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
      })
      if (!box) throw new Error('找不到画布导航')
      for (const type of ['mousePressed', 'mouseReleased']) {
        await send('Input.dispatchMouseEvent', {
          type,
          x: box.x,
          y: box.y,
          button: 'left',
          clickCount: 1
        })
      }
      await sleep(600)

      /* 左栏那几组低频工具默认是折着的(showMore=false),Rotate / Flip 都在里面。
         不展开的话按钮根本不在 DOM 里,而"点不到"会被静默当成"点了没用" */
      const expanded = await evaluate(() => {
        const b = document.querySelector('button[aria-label="More tools"]')
        if (!b) return false
        b.click()
        return true
      })
      canvas.steps.push(['expanded more tools', expanded])
      await sleep(400)

      // 把一张真图塞进那个隐藏的 input(用 CDP 的文件注入,不是合成事件)
      const { root } = await send('DOM.getDocument', { depth: -1 })
      const { nodeId } = await send('DOM.querySelector', {
        nodeId: root.nodeId,
        selector: 'input.cv-file'
      })
      if (!nodeId) throw new Error('找不到上传用的 input')
      await send('DOM.setFileInputFiles', { nodeId, files: [UPLOAD_PNG] })
      await sleep(1200)
      canvas.steps.push(['after upload', await readSteps()])

      // 旋转两次、翻转一次
      canvas.steps.push(['click Rotate right', await click('Rotate right')])
      await settle()
      canvas.steps.push(['after rotate', await readSteps()])
      await click('Rotate right')
      await settle()
      await click('Flip horizontal')
      await settle()
      canvas.steps.push(['after 3 ops', await readSteps()])

      // 撤销两步
      canvas.steps.push(['click Undo', await click('Undo')])
      await settle()
      await click('Undo')
      await settle()
      canvas.steps.push(['after undo x2', await readSteps()])

      // 重做一步
      canvas.steps.push(['click Redo', await click('Redo')])
      await settle()
      canvas.steps.push(['after redo', await readSteps()])

      // 跳回第 1 步(点步骤条上第一张缩略图)
      canvas.jumped = await evaluate(() => {
        const target = document.querySelectorAll('.step')[1]
        if (!target) return 'missing'
        target.click()
        return 'clicked'
      })
      await settle()
      canvas.steps.push(['after jump to step 1', await readSteps()])

      // 复位到底
      canvas.steps.push(['click Back to the original', await click('Back to the original')])
      await settle()
      canvas.steps.push(['after reset', await readSteps()])

      const at = (name) => canvas.steps.find(([n]) => n === name)[1]
      canvas.passed =
        canvas.jumped === 'clicked' &&
        // 原图 + 3 步 = 4 格
        at('after 3 ops').total === 4 &&
        at('after 3 ops').current === 3 &&
        at('after undo x2').current === 1 &&
        at('after undo x2').canRedo === true &&
        at('after redo').current === 2 &&
        at('after jump to step 1').current === 1 &&
        // 复位回到原图,而走过的三步仍留在重做栈里(所以还能点回来)
        at('after reset').current === 0 &&
        at('after reset').canRedo === true
    } catch (e) {
      canvas.error = String(e.message || e)
    }
  }

  /* —— 接口配置域探针 ——
     新增一条配置走的是「预设 → 表单 → 保存 → 设为当前」这条链,
     它横跨 useConfigs 的 saveSettings / 四类挑选 / 主界面参数行胶囊。
     纯函数单测覆盖不到"点了一遍到底成没成",所以在真页面里走一遍。 */
  let configProbe = null
  if (PROBE_CONFIG) {
    configProbe = { steps: [] }
    const clickNav = async (label) => {
      const box = await evaluate((l) => {
        const b = document.querySelector(`button[aria-label="${l}"]`)
        if (!b) return null
        const r = b.getBoundingClientRect()
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
      }, label)
      if (!box) return false
      for (const type of ['mousePressed', 'mouseReleased']) {
        await send('Input.dispatchMouseEvent', {
          type,
          x: box.x,
          y: box.y,
          button: 'left',
          clickCount: 1
        })
      }
      return true
    }
    try {
      configProbe.openedSettings = await clickNav('Settings')
      await sleep(700)
      /* 空态给的是"四条能一键预填的入口"(.quick-item),点它会直接进表单并带好
         地址与模型;已经有配置时才是列表页。两种都认,免得探针只在一种状态下有效 */
      configProbe.clickedPreset = await evaluate(() => {
        const quick = document.querySelector('.quick .quick-item')
        if (quick) {
          quick.click()
          return 'quick:' + quick.textContent.trim().slice(0, 20)
        }
        const preset = document.querySelector('.presets button.preset')
        if (preset) {
          preset.click()
          return 'preset:' + preset.textContent.trim().slice(0, 20)
        }
        // 列表页:点"新增"进表单
        const add = [...document.querySelectorAll('button')].find((b) =>
          /new config|add/i.test(b.textContent.trim())
        )
        if (add) {
          add.click()
          return 'add'
        }
        return 'missing'
      })
      await sleep(400)
      configProbe.formShown = await evaluate(() => !!document.querySelector('input[type="url"], input#base-url, form input'))
      // 填表:v-model 认 input 事件,所以赋值之后要派发一次
      configProbe.filled = await evaluate(() => {
        const set = (el, v) => {
          if (!el) return false
          el.value = v
          el.dispatchEvent(new Event('input', { bubbles: true }))
          return true
        }
        /* 这些 input 没有 id,只能按 placeholder 认 —— 表单里还有用途单选框,
           所以"第 0 个 input"根本不是 Name 那一格(踩过) */
        const inputs = [...document.querySelectorAll('form input')]
        const name = inputs.find((i) => /e\.g\. Doubao/.test(i.placeholder || ''))
        const url = inputs.find((i) => /^https:\/\/example\.com/.test(i.placeholder || ''))
        const key = inputs.find((i) => i.type === 'password')
        const okName = set(name, 'Probe config')
        const okUrl = set(url, 'https://example.com/v1')
        const okKey = set(key, 'sk-probe')
        return { okName, okUrl, okKey, count: inputs.length, radios: inputs.filter((i) => i.type === 'radio').length }
      })
      await sleep(300)
      configProbe.saved = await evaluate(() => {
        const btn = [...document.querySelectorAll('form button')].find((b) =>
          /^save$/i.test(b.textContent.trim())
        )
        if (!btn) return 'missing'
        btn.click()
        return 'clicked'
      })
      await sleep(600)
      configProbe.listedAfterSave = await evaluate(() =>
        /Probe config/.test(document.body.textContent || '')
      )
      // 回首页:参数行那个胶囊应当显示刚存的这条(说明"设为当前"这一步生效了)
      configProbe.backHome = await clickNav('Studio')
      await sleep(700)
      configProbe.pillText = await evaluate(() => {
        const pill = document.querySelector('.param-btn .param-val-name')
        return pill ? pill.textContent.trim() : ''
      })
      configProbe.passed =
        configProbe.openedSettings === true &&
        configProbe.saved === 'clicked' &&
        configProbe.listedAfterSave === true &&
        configProbe.pillText === 'Probe config'
    } catch (e) {
      configProbe.error = String(e.message || e)
    }
  }

  /* —— 历史域探针 ——
     删除走的是"立刻生效 + 撤销窗口 + 窗口结束才落盘"这一套(见 useFeedback),
     单测只能证明 scheduleUndo 自己没错,证明不了"界面上的删除真的接上了它"。 */
  let historyProbe = null
  if (PROBE_HISTORY) {
    historyProbe = { steps: [] }
    const settle = () => sleep(350)
    const tileCount = () => evaluate(() => document.querySelectorAll('section.lib .tile').length)
    try {
      /* 先自己切到历史页再动手。别的探针会把页面切走(canvas / settings),
         而离场页在无头下可能仍留在 DOM 里 —— "section.lib 有图块"并不等于
         "用户正看着这一页"(连跑时踩过:删除点了却什么都没发生) */
      const navBox = await evaluate(() => {
        const b = document.querySelector('button[aria-label="History"]')
        if (!b) return null
        const r = b.getBoundingClientRect()
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
      })
      if (navBox) {
        for (const type of ['mousePressed', 'mouseReleased']) {
          await send('Input.dispatchMouseEvent', {
            type,
            x: navBox.x,
            y: navBox.y,
            button: 'left',
            clickCount: 1
          })
        }
        await sleep(700)
      }
      historyProbe.tilesBefore = await tileCount()
      // 点第一块砖上的删除(操作排在 DOM 里,悬停才显形,但 .click() 照常触发)
      historyProbe.clickedDelete = await evaluate(() => {
        const b = [...document.querySelectorAll('section.lib button')].find((x) =>
          (x.getAttribute('aria-label') || '').startsWith('Delete:')
        )
        if (!b) return 'missing'
        b.click()
        return 'clicked'
      })
      await settle()
      historyProbe.tilesAfterDelete = await tileCount()
      // 撤销条:把这条放回来
      historyProbe.undoToast = await evaluate(() => !!document.querySelector('.undo .undo-btn'))
      historyProbe.clickedUndo = await evaluate(() => {
        const b = document.querySelector('.undo .undo-btn')
        if (!b) return 'missing'
        b.click()
        return 'clicked'
      })
      await settle()
      historyProbe.tilesAfterUndo = await tileCount()

      /* 新建作品集要从**预览卡**里进:历史页那一行筛选在"一个集都没有"时
         是有意不渲染的(免得空页面多一行噪声),所以空态下它没有入口 ——
         第一版探针就在这里扑了空 */
      historyProbe.openedPreview = await evaluate(() => {
        const b = document.querySelector('section.lib .tile .tile-open')
        if (!b) return 'missing'
        b.click()
        return 'clicked'
      })
      await sleep(500)
      historyProbe.clickedNewCollection = await evaluate(() => {
        const b = [...document.querySelectorAll('button[aria-label="New collection"]')].pop()
        if (!b) return 'missing'
        b.click()
        return 'clicked'
      })
      await settle()
      historyProbe.typedTitle = await evaluate(() => {
        const input = [...document.querySelectorAll('input.coll-input')].pop()
        if (!input) return 'missing'
        input.value = 'Probe set'
        input.dispatchEvent(new Event('input', { bubbles: true }))
        return 'typed'
      })
      /* 确认键要**下一拍**再点:它的 disabled 绑的是 v-model,
         而 Vue 更新 DOM 是异步的 —— 刚派发完 input 的那一刻它还是灰的,
         点上去等于没点(这个坑在探针里踩过两次了) */
      await settle()
      historyProbe.clickedConfirm = await evaluate(() => {
        const b = [...document.querySelectorAll('button.coll-confirm')].pop()
        if (!b) return 'missing'
        if (b.disabled) return 'disabled'
        b.click()
        return 'clicked'
      })
      await settle()
      // 关掉预览,回历史页看那一行筛选是否出现了新集
      await evaluate(() => {
        document.querySelector('button[aria-label="Close"]')?.click()
      })
      await settle()
      historyProbe.chipAppeared = await evaluate(() =>
        [...document.querySelectorAll('.coll-chip')].some((c) =>
          /Probe set/.test(c.textContent || '')
        )
      )

      historyProbe.passed =
        historyProbe.clickedDelete === 'clicked' &&
        historyProbe.tilesAfterDelete === historyProbe.tilesBefore - 1 &&
        historyProbe.undoToast === true &&
        historyProbe.clickedUndo === 'clicked' &&
        historyProbe.tilesAfterUndo === historyProbe.tilesBefore &&
        historyProbe.clickedNewCollection === 'clicked' &&
        historyProbe.clickedConfirm === 'clicked' &&
        historyProbe.chipAppeared === true
    } catch (e) {
      historyProbe.error = String(e.message || e)
    }
  }

  /* —— 角色域探针 ——
     新建角色 → 卡片出现 → 拿它开画。这条链穿过 useCharacters 的状态与派生
     （characters / charStats / activeCharacter / activeCharSrc）,
     以及留在主界面的写入侧（saveCharFromPage）。 */
  let charsProbe = null
  if (PROBE_CHARS) {
    charsProbe = {}
    const settle = () => sleep(350)
    const clickNav = async (label) => {
      const box = await evaluate((l) => {
        const b = document.querySelector(`button[aria-label="${l}"]`)
        if (!b) return null
        const r = b.getBoundingClientRect()
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
      }, label)
      if (!box) return false
      for (const type of ['mousePressed', 'mouseReleased']) {
        await send('Input.dispatchMouseEvent', {
          type,
          x: box.x,
          y: box.y,
          button: 'left',
          clickCount: 1
        })
      }
      return true
    }
    try {
      charsProbe.nav = await clickNav('Characters')
      await sleep(700)
      // 诊断:此刻到底停在哪一页、有哪些页面的根节点还在 DOM 里
      charsProbe.state = await evaluate(() => {
        const checked = [...document.querySelectorAll('.rs-item')].find(
          (b) => b.getAttribute('aria-checked') === 'true'
        )
        return {
          navLabel: checked ? checked.getAttribute('aria-label') : '',
          pages: [...document.querySelectorAll('main.frame > section')].map((s) => s.className),
          hasCharsNew: !!document.querySelector('button.chars-new'),
          hasWizard: !!document.querySelector('.wizard')
        }
      })
      /* 注意:aria-label="New character" 在**向导对话框**上,不在触发键上;
         触发键是 .chars-new 那个按钮(文本 "New character")。按 aria-label 找
         会找到 section —— 于是"找到了却不是按钮"(第一版就扑了空) */
      charsProbe.clickedNew = await evaluate(() => {
        const b = document.querySelector('button.chars-new')
        if (!b) return 'missing'
        b.click()
        return 'clicked'
      })
      await settle()
      charsProbe.filledName = await evaluate(() => {
        const input = document.querySelector('input[placeholder="Name this character"]')
        if (!input) return 'missing'
        input.value = 'Probe captain'
        input.dispatchEvent(new Event('input', { bubbles: true }))
        return 'filled'
      })
      /* 性别是必填(Save 的 disabled 同时看名字与性别),它是视觉隐藏的真 radio */
      charsProbe.pickedGender = await evaluate(() => {
        const radio = document.querySelector('.wz-sex-opt input')
        if (!radio) return 'missing'
        radio.click()
        return 'clicked'
      })
      /* 又是那个坑:Save 的 disabled 绑在 v-model 上,要等下一拍再点 */
      await settle()
      charsProbe.saved = await evaluate(() => {
        const b = [...document.querySelectorAll('button')].find((x) =>
          /^Save & continue$/.test(x.textContent.trim())
        )
        if (!b) return 'missing'
        if (b.disabled) return 'disabled'
        b.click()
        return 'clicked'
      })
      await sleep(900)
      charsProbe.cardAppeared = await evaluate(
        () => /Probe captain/.test(document.body.textContent || '')
      )
      // 关掉向导回列表
      charsProbe.closed = await evaluate(() => {
        const b = [...document.querySelectorAll('button')].find((x) =>
          /^(Close|Cancel)$/.test(x.textContent.trim())
        )
        if (!b) return 'missing'
        b.click()
        return 'clicked'
      })
      await settle()
      // 拿这个角色开画
      charsProbe.usedForCreate = await evaluate(() => {
        const btn = [...document.querySelectorAll('.ctile button')].find((b) =>
          /Create/.test(b.textContent || '')
        )
        if (!btn) return 'missing'
        btn.click()
        return 'clicked'
      })
      await sleep(700)
      charsProbe.pillTip = await evaluate(() => {
        const b = document.querySelector('.param-char button')
        return (b && (b.getAttribute('data-tip') || '')) || ''
      })
      charsProbe.passed =
        charsProbe.clickedNew === 'clicked' &&
        charsProbe.filledName === 'filled' &&
        charsProbe.pickedGender === 'clicked' &&
        charsProbe.saved === 'clicked' &&
        charsProbe.cardAppeared === true &&
        charsProbe.usedForCreate === 'clicked' &&
        /Probe captain/.test(charsProbe.pillTip)
    } catch (e) {
      charsProbe.error = String(e.message || e)
    }
  }

  /* —— 出图参数层探针 ——
     这一层(尺寸 / 张数 / 画质 / 种子 / 参考图)每一格都受能力表约束,
     而能力表是配置域算出来的 —— 单测覆盖不到"点下去界面认不认"。 */
  let paramsProbe = null
  if (PROBE_PARAMS) {
    paramsProbe = {}
    const settle = () => sleep(400)
    try {
      // 回创作区
      const navBox = await evaluate(() => {
        const b = document.querySelector('button[aria-label="Studio"]')
        if (!b) return null
        const r = b.getBoundingClientRect()
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
      })
      if (navBox) {
        for (const type of ['mousePressed', 'mouseReleased']) {
          await send('Input.dispatchMouseEvent', {
            type,
            x: navBox.x,
            y: navBox.y,
            button: 'left',
            clickCount: 1
          })
        }
        await sleep(700)
      }

      // ① 打开「更多参数」
      paramsProbe.openedMore = await evaluate(() => {
        const b = document.querySelector('button[aria-label="More parameters"]')
        if (!b) return 'missing'
        b.click()
        return 'clicked'
      })
      await settle()
      paramsProbe.panels = await evaluate(() => ({
        bodies: document.querySelectorAll('.pp-body').length,
        sizeChips: [...document.querySelectorAll('.pp-body .preset')].filter((b) =>
          /^(Auto|\d+×\d+)$/.test(b.textContent.trim())
        ).length
      }))

      // ② 点一个具体尺寸档(不是 auto 的那一个)
      paramsProbe.clickedSize = await evaluate(() => {
        const chip = [...document.querySelectorAll('.pp-body .preset')].find((b) =>
          /^\d+×\d+$/.test(b.textContent.trim())
        )
        if (!chip) return 'missing'
        chip.click()
        return chip.textContent.trim()
      })
      await settle()
      /* 别去"找那个带着 on 的":张数那几个胶囊也是 .preset,第一版就抓成了
         "1 image"。按文本精确对上刚点的那一档才算数 */
      paramsProbe.sizeOn = await evaluate((want) => {
        const chip = [...document.querySelectorAll('.pp-body .preset')].find(
          (b) => b.textContent.trim() === want
        )
        if (!chip) return 'missing'
        return chip.className.includes('on')
      }, paramsProbe.clickedSize)

      // ③ 参考图:塞一张真图进隐藏 input,再点 Remove
      await evaluate(() => {
        const input = document.querySelector('#ref-file')
        return !!input
      })
      await send('DOM.enable')
      const doc = await send('DOM.getDocument', { depth: -1 })
      const node = await send('DOM.querySelector', {
        nodeId: doc.root.nodeId,
        selector: '#ref-file'
      })
      if (node.nodeId) {
        await send('DOM.setFileInputFiles', { nodeId: node.nodeId, files: [UPLOAD_PNG] })
      }
      await sleep(900)
      paramsProbe.refThumb = await evaluate(() => !!document.querySelector('img.pp-thumb'))
      paramsProbe.removed = await evaluate(() => {
        const b = [...document.querySelectorAll('.pp-action')].find((x) =>
          /^Remove$/.test(x.textContent.trim())
        )
        if (!b) return 'missing'
        b.click()
        return 'clicked'
      })
      await settle()
      paramsProbe.refThumbAfterRemove = await evaluate(() => !!document.querySelector('img.pp-thumb'))

      paramsProbe.passed =
        paramsProbe.panels?.sizeChips >= 2 &&
        /×/.test(paramsProbe.clickedSize || '') &&
        paramsProbe.sizeOn === true &&
        paramsProbe.refThumb === true &&
        paramsProbe.removed === 'clicked' &&
        paramsProbe.refThumbAfterRemove === false
    } catch (e) {
      paramsProbe.error = String(e.message || e)
    }
  }

  /* —— 对话域探针 ——
     真聊一句需要能用的文本模型(要联网、要密钥),这里做不到;但搬走的那一半
     (读取 / 记忆 / 清空)完全可以验证:把一段对话与一条记忆直接播进库,
     再看页面认不认、清空能不能撤销。 */
  let chatProbe = null
  if (PROBE_CHAT) {
    chatProbe = {}
    const settle = () => sleep(350)
    try {
      // ① 播种:一个角色(localStorage 目录) + 一段对话 + 一条记忆(IndexedDB)
      chatProbe.seeded = await evaluate(async () => {
        const charId = 'probe-chat-char'
        const now = Date.now()
        localStorage.setItem(
          'kimage.characters',
          JSON.stringify([
            {
              id: charId,
              name: 'Probe talker',
              createdAt: now,
              fields: { gender: 'female', identity: 'probe', outfit: '', marks: '' },
              persona: { traits: 'dry', voice: 'short', address: 'you', boundaries: 'none' }
            }
          ])
        )
        const db = await new Promise((res, rej) => {
          const r = indexedDB.open('kimage.db')
          r.onsuccess = () => res(r.result)
          r.onerror = () => rej(r.error)
        })
        const msgs = [
          { role: 'user', content: 'Are you awake?', dt: 3 },
          { role: 'assistant', content: 'Barely. It is early.', dt: 2 },
          { role: 'user', content: 'Same here.', dt: 1 }
        ].map((m, i) => ({
          id: `probe-msg-${i}`,
          charId,
          role: m.role,
          content: m.content,
          createdAt: now - m.dt * 60000
        }))
        await new Promise((res, rej) => {
          const tx = db.transaction(['chat_messages', 'chat_summaries'], 'readwrite')
          const store = tx.objectStore('chat_messages')
          for (const m of msgs) store.put(m)
          tx.objectStore('chat_summaries').put({
            charId,
            text: 'They met on a cold morning and agreed to keep it short.',
            upToId: 'probe-msg-1',
            upToAt: now - 2 * 60000,
            covered: 2,
            updatedAt: now
          })
          tx.oncomplete = res
          tx.onerror = () => rej(tx.error)
        })
        db.close()
        return msgs.length
      })

      // ② 重载,让应用从库里读这份播种数据
      const loaded = onceEvent('Page.loadEventFired')
      await send('Page.reload', { ignoreCache: true })
      await loaded
      await sleep(600)

      // ③ 进对话页
      const navBox = await evaluate(() => {
        const b = document.querySelector('button[aria-label="Chat"]')
        if (!b) return null
        const r = b.getBoundingClientRect()
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
      })
      if (navBox) {
        for (const type of ['mousePressed', 'mouseReleased']) {
          await send('Input.dispatchMouseEvent', {
            type,
            x: navBox.x,
            y: navBox.y,
            button: 'left',
            clickCount: 1
          })
        }
      }
      await sleep(900)
      chatProbe.rendered = await evaluate(() => {
        const bubbles = document.querySelectorAll('.bubble, .msg, .chat-msg').length
        return {
          bubbles,
          hasMemory: !!document.querySelector('.memory'),
          memoryLabel: document.querySelector('.memory-label')?.textContent?.trim() || '',
          charInRail: /Probe talker/.test(document.body.textContent || '')
        }
      })

      // ④ 清空对话(菜单里那一项)
      chatProbe.openedMenu = await evaluate(() => {
        const b = document.querySelector('button[aria-label="Conversation options"]')
        if (!b) return 'missing'
        b.click()
        return 'clicked'
      })
      await settle()
      chatProbe.clickedClear = await evaluate(() => {
        const b = [...document.querySelectorAll('.chat-menu button')].find((x) =>
          /Clear conversation/.test(x.textContent || '')
        )
        if (!b) return 'missing'
        if (b.disabled) return 'disabled'
        b.click()
        return 'clicked'
      })
      await sleep(600)
      chatProbe.afterClear = await evaluate(() => ({
        bubbles: document.querySelectorAll('.bubble, .msg, .chat-msg').length,
        undoToast: !!document.querySelector('.undo .undo-btn'),
        memoryGone: !document.querySelector('.memory')
      }))

      chatProbe.passed =
        chatProbe.seeded === 3 &&
        chatProbe.rendered?.bubbles >= 3 &&
        chatProbe.rendered?.hasMemory === true &&
        chatProbe.rendered?.charInRail === true &&
        chatProbe.clickedClear === 'clicked' &&
        chatProbe.afterClear?.bubbles === 0 &&
        chatProbe.afterClear?.memoryGone === true &&
        chatProbe.afterClear?.undoToast === true
    } catch (e) {
      chatProbe.error = String(e.message || e)
    }
  }

  const heap = await evaluate(() => {
    const m = performance.memory
    return m ? { usedMB: +(m.usedJSHeapSize / 1048576).toFixed(1) } : null
  })

  const report = {
    url: URL_,
    chrome: version.Browser,
    seededRecords: seeded,
    imagesPerRecord: IMAGES,
    imgSizePx: IMG_SIZE,
    // 相对 navigationStart 的毫秒数,可直接对比改动前后
    startup: { msToFeedFirstTile: +startupMs.toFixed(1), navTiming },
    background,
    encode,
    reopen,
    twoTabs,
    canvas,
    config: configProbe,
    historyDomain: historyProbe,
    chars: charsProbe,
    chat: chatProbe,
    params: paramsProbe,
    history,
    heap
  }

  console.log(JSON.stringify(report, null, 2))

  /* —— 预算断言 ——
     让这个脚本能当回归门用:超阈值就以非零码退出(手跑也能接进别的流程)。
     阈值由调用方给,不写死 —— 它取决于造了多少条数据,写死必然误报 */
  const budgets = [
    ['max-dom-nodes', arg('max-dom-nodes', null), history.domNodes, '历史页 DOM 节点'],
    ['max-ms', arg('max-ms', null), history.msToStable, '历史页铺完耗时(ms)'],
    ['max-heap-mb', arg('max-heap-mb', null), heap?.usedMB ?? 0, 'JS 堆(MB)']
  ].filter(([, limit]) => limit !== null)

  if (canvas) {
    const ok = canvas.passed === true
    console.log(
      `${ok ? '✅' : '❌'} 画布操作序列(上传→3 步→撤销 2 步→重做 1 步→跳步→复位)${
        canvas.error ? ` — ${canvas.error}` : ''
      }`
    )
    if (!ok) {
      console.log('   ', JSON.stringify(canvas.steps))
      process.exitCode = 1
    }
  }

  if (paramsProbe) {
    const ok = paramsProbe.passed === true
    console.log(
      `${ok ? '✅' : '❌'} 出图参数层(尺寸档位 → 参考图上传 → 清除)${
        ok ? '' : ` — ${JSON.stringify(paramsProbe)}`
      }`
    )
    if (!ok) process.exitCode = 1
  }

  if (chatProbe) {
    const ok = chatProbe.passed === true
    console.log(
      `${ok ? '✅' : '❌'} 对话域(播种对话与记忆 → 渲染 → 清空)${
        ok ? '' : ` — ${JSON.stringify(chatProbe)}`
      }`
    )
    if (!ok) process.exitCode = 1
  }

  if (charsProbe) {
    const ok = charsProbe.passed === true
    console.log(
      `${ok ? '✅' : '❌'} 角色域(新建 → 卡片出现 → 拿它开画)${
        ok ? '' : ` — ${JSON.stringify(charsProbe)}`
      }`
    )
    if (!ok) process.exitCode = 1
  }

  if (historyProbe) {
    const ok = historyProbe.passed === true
    console.log(
      `${ok ? '✅' : '❌'} 历史域(删除 → 撤销放回 → 新建作品集)${
        ok ? '' : ` — ${JSON.stringify(historyProbe)}`
      }`
    )
    if (!ok) process.exitCode = 1
  }

  if (configProbe) {
    const ok = configProbe.passed === true
    console.log(
      `${ok ? '✅' : '❌'} 接口配置域(设置页新增一条 → 回首页成为当前)${
        ok ? '' : ` — ${JSON.stringify(configProbe)}`
      }`
    )
    if (!ok) process.exitCode = 1
  }

  if (twoTabs) {
    const ok = twoTabs.passed === true
    console.log(`${ok ? '✅' : '❌'} 跨标签页同步:标记在另一页可见 (${twoTabs.markedInB_before} → ${twoTabs.markedInB_after})${twoTabs.error ? ` — ${twoTabs.error}` : ''}`)
    if (!ok) process.exitCode = 1
  }

  let breached = 0
  for (const [flag, limit, actual, label] of budgets) {
    const over = actual > Number(limit)
    if (over) breached++
    console.log(`${over ? '❌ 超预算' : '✅ 在预算内'} ${label}: ${actual} (--${flag} ${limit})`)
  }
  if (breached) process.exitCode = 1
}

main()
  .catch((e) => {
    console.error('测量失败:', e.message)
    process.exitCode = 1
  })
  .finally(async () => {
    try {
      ws?.close()
    } catch {
      /* ignore */
    }
    chrome.kill('SIGKILL')
    // 等 Chrome 真的退出再删 profile,否则会留下半截目录
    await sleep(500)
    try {
      rmSync(profile, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
    try {
      rmSync(UPLOAD_PNG, { force: true })
    } catch {
      /* ignore */
    }
  })
