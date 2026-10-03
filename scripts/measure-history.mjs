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
import { mkdtempSync, rmSync } from 'node:fs'
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
/* 调试端口每轮随机取一个:固定端口会与上一次没退干净的实例撞车,
   而那种撞车表现为"连上了,但连到的是别人",量出来的数看着正常其实全错 */
const PORT = Number(arg('cdp-port', 0)) || 9300 + Math.floor(Math.random() * 600)
const CHROME = arg('chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

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
  if (!version) throw new Error('Chrome 的调试端口没起来')

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
    async (n, images, size) => {
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
          thumb: blob,
          w: size,
          h: size
        })
      }
      await new Promise((r) => (tx.oncomplete = r))
      db.close()
      return n
    },
    RECORDS,
    IMAGES,
    IMG_SIZE
  )

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
  })
