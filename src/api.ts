import type { ApiConfig, GenParams, HistoryEntry, PromptItem, ResultItem, ReuseParams } from './types'
import type { PruneResult } from './lib/idb'
import {
  getAll,
  pruneHistory,
  putOne,
  deleteOne,
  urlToBlob,
  base64ToBlob,
  detectMimeFromDataUrl
} from './lib/idb'

const CONFIG_KEY = 'kimage.apiConfigs'
const CONFIG_ACTIVE_KEY = 'kimage.apiActive'
// 「当前生效的文本配置」记录的 id:文本类别也有自己的当前项,与出图那条各自独立
const TEXT_ACTIVE_KEY = 'kimage.apiActiveText'

export function uid(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36)
}

/* ===== 厂商能力表 =====================================================
   各家的扩展参数、尺寸取值、图生图端点都不一样,集中在这里声明,
   界面按它决定显示什么、代理按它决定打哪个端点。
   要支持新厂商,或某家改了规则,只改这一处。
   -------------------------------------------------------------------- */
export type Cap = 'yes' | 'no' | 'unknown'

/* 出图走哪套协议。不是"厂商"的另一种说法 —— 同一家中转上,
   OpenAI 系模型打 /images/generations,Gemini 系模型得打原生的
   :generateContent,两条路的请求体和响应体都不一样 */
export type Protocol = 'openai' | 'gemini'

export interface Provider {
  id: string
  label: string
  baseUrl: string
  model: string
  quality: Cap
  background: Cap
  /** 允许的尺寸;'free' 表示由接口自行决定 */
  sizes: string[] | 'free'
  /* 上游有没有"自己决定尺寸"这一档。
     size: "auto" 是一个真实取值(让模型按 prompt 定比例),不等于"不发这个参数" ——
     不发时上游用自己的默认尺寸,多数就是 1:1。所以只有认 auto 的厂商才给这一档,
     其余厂商的候选列表里不能出现 auto,否则界面在骗人,发出去的请求跟没选一样 */
  autoSize: boolean
  /** 图生图打哪个端点 */
  edit: 'generations' | 'edits'
  protocol: Protocol
}

// 兜底项:baseUrl 认不出来时的归宿
const CUSTOM: Provider = {
  id: 'custom',
  label: 'Custom / OpenAI-compatible',
  baseUrl: '',
  model: '',
  // 未知厂商一律按"不确定"处理:照常展示参数,但不静默丢弃
  quality: 'unknown',
  background: 'unknown',
  sizes: 'free',
  /* 未知厂商按"认 auto"处理:这里的兜底对象就是 OpenAI 兼容代理,
     如实转发比静默降级好 —— 真发错了会报错提示,而静默丢掉参数只会让人
     以为模型没按 prompt 定比例 */
  autoSize: true,
  edit: 'generations',
  protocol: 'openai'
}

/* Gemini 出图:走原生 :generateContent,不是 OpenAI 的 /images/generations。
   实测(2026-09,对一家中转):原生路径同步返回,出图在
   candidates[].content.parts[].inlineData.data,宽高比走
   generationConfig.imageConfig.aspectRatio —— 传 2:3 拿到 848×1264。
   注意不要用它的 OpenAI 兼容层:那条路上中转会回
   "Images API is not supported for this platform" */
const GEMINI: Provider = {
  id: 'gemini',
  label: 'Google Gemini',
  /* 主机根地址,不带版本号:原生路径由代理拼成
     {baseUrl}/v1beta/models/{model}:generateContent。
     中转站也按同一套拼(前提是把中转地址填成它的根,如 https://xxx.com),
     所以同一条预设同时服务"Google 直连"和"中转"两种填法 */
  baseUrl: 'https://generativelanguage.googleapis.com',
  model: 'gemini-2.5-flash-image',
  /* 原生请求体里根本没有 quality / background 这两个字段,多给一个未知字段
     会被 Google 拒掉。标成不支持,界面就不会给出按不动的开关 */
  quality: 'no',
  background: 'no',
  /* 给的都是能干净约分成 Gemini 认的宽高比的档位:
     1024x1024→1:1、1536x1024→3:2、1024x1536→2:3、1792x1024→16:9、1024x1792→9:16。
     约不出来的值不发这个参数(见 server 的 geminiRatio),不做隐式近似 */
  sizes: ['auto', '1024x1024', '1536x1024', '1024x1536', '1792x1024', '1024x1792'],
  /* 实测:不发宽高比时它自己给 16:9,所以 auto 是实打实的"模型自决",不是空话 */
  autoSize: true,
  /* 图生图暂不可用。原生协议其实能收参考图(parts 里再放一段 inlineData),
     但那条路还没接,界面允许挂参考图而它会失败,所以先只在文档里记着 */
  edit: 'generations',
  protocol: 'gemini'
}

export const PROVIDERS: Provider[] = [
  {
    id: 'openai',
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-image-1',
    quality: 'yes',
    background: 'yes',
    sizes: ['auto', '1024x1024', '1536x1024', '1024x1536'],
    autoSize: true,
    edit: 'edits',
    protocol: 'openai'
  },
  {
    id: 'ark',
    label: 'Doubao Seedream (Volcengine Ark)',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    model: 'doubao-seedream-3-0-t2i',
    quality: 'no',
    background: 'no',
    sizes: 'free',
    // Ark 的 size 是枚举,收到 "auto" 会直接报错;它也没有"模型自定比例"这一档
    autoSize: false,
    edit: 'generations',
    protocol: 'openai'
  },
  {
    id: 'dashscope',
    label: 'Tongyi Wanxiang (Bailian)',
    baseUrl: 'https://dashscope.aliyuncs.com/api/v1',
    model: 'wanx2.1-t2i-turbo',
    quality: 'no',
    background: 'no',
    sizes: 'free',
    // 万相的 size 同样是枚举,没有 auto 档
    autoSize: false,
    edit: 'generations',
    protocol: 'openai'
  },
  GEMINI,
  CUSTOM
]

/* Gemini 系图像模型的模型名:各家中转给它们起的别名五花八门(banana2-4k、
   nano-banana-pro…),但都绕不开这几个词根 */
const GEMINI_IMAGE_RE = /^(gemini|imagen|banana|nano-?banana)/i

/* 能力表按 (厂商, 模型) 解析,不只是厂商 ——
   中转站自己就是看模型名决定后端的,我们必须跟它一致:同一个地址上,
   OpenAI 系模型走 /images/generations,Gemini 系模型走原生 :generateContent,
   判错就会打到对方不实现的那条路上(实测会回
   "Images API is not supported for this platform")。
   model 参数可选,不传时退回按厂商判断 */
export function getProvider(id: string | undefined, model = ''): Provider {
  const p = PROVIDERS.find((x) => x.id === id)
  if (!p) return CUSTOM
  if (p.id === 'custom' && GEMINI_IMAGE_RE.test(model)) return GEMINI
  return p
}

/** 老配置没有 vendor 字段时按域名猜,省得用户重配一遍 */
export function inferVendor(baseUrl: string): string {
  const h = (baseUrl || '').toLowerCase()
  /* gemini 必须排在 openai 前面:Gemini 的 OpenAI 兼容层地址是
     .../v1beta/openai,含 "openai" 这个词,顺序反了就会把它当成 OpenAI,
     于是尺寸候选、quality/background 门控、出图协议全都按错的那家来。
     只认 generativelanguage(AI Studio 的 Gemini API 主机),故意不认
     aiplatform.googleapis.com —— 那是 Vertex,鉴权要 GCP access token、
     模型名还带 google/ 前缀,和这里不是一套,硬认出来只会误导 */
  if (h.includes('generativelanguage')) return 'gemini'
  if (h.includes('openai')) return 'openai'
  if (h.includes('volces') || h.includes('ark.cn')) return 'ark'
  if (h.includes('dashscope') || h.includes('aliyun')) return 'dashscope'
  return 'custom'
}

/** OpenAI 两代模型认的尺寸不同,这里再细分一层;其余厂商不限 */
export function allowedSizes(vendorId: string | undefined, model: string): string[] | 'free' {
  if (vendorId === 'openai') {
    return /dall-e-3/i.test(model || '')
      ? ['1024x1024', '1792x1024', '1024x1792']
      : ['auto', '1024x1024', '1536x1024', '1024x1536']
  }
  return getProvider(vendorId).sizes
}

/* ===== 提示词增强的文本模型预设 ======================================
   服务于表单里「用途 = text」时的预设行。与出图的 PROVIDERS 分开:
   两者要填的模型不是一回事(出图填图像模型,这里填对话模型),
   共用一份预设会互相误导。
   地址与出图厂商同源,但百炼要单独列一条 —— 它的 /api/v1 是原生协议,
   对话得走 /compatible-mode/v1,填错会直接 404。
   -------------------------------------------------------------------- */
export interface TextProvider {
  id: string
  label: string
  baseUrl: string
  /* 推荐模型。留空表示这家没有能安全写死的默认值:模型名多带日期版本号,
     写死很快过期,不如留空让用户自己填 */
  model?: string
}

export const TEXT_PROVIDERS: TextProvider[] = [
  {
    id: 'openai',
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini'
  },
  {
    id: 'dashscope-compat',
    label: 'Bailian (compatible mode)',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen-plus'
  },
  {
    id: 'ark',
    label: 'Volcengine Ark',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3'
  }
]

/* ===== 扩展参数的取值与界面文案 =====================================
   放在这里是为了让主界面和历史预览共用同一份文案,避免两处各写一套
   后出现「面板显示低、预览显示 low」这类不一致。
   hint 是界面上给档位的代价注解。
   ------------------------------------------------------------------ */
export const QUALITY_OPTIONS = [
  { value: 'auto', label: 'Auto', hint: 'Model decides' },
  { value: 'low', label: 'Low', hint: 'Fast, cheaper' },
  { value: 'medium', label: 'Medium', hint: 'Balanced' },
  { value: 'high', label: 'High', hint: 'Finer, slower' }
]
export const BACKGROUND_OPTIONS = [
  { value: 'auto', label: 'Auto' },
  { value: 'transparent', label: 'Transparent' },
  { value: 'opaque', label: 'Opaque' }
]

/** 取值 → 界面文案;认不出来的值原样返回,不至于显示空白 */
export function optionLabel(list: Array<{ value: string; label: string }>, v?: string) {
  if (!v) return ''
  return list.find((o) => o.value === v)?.label || v
}

// 读取全部接口配置列表
export function loadConfigs(): ApiConfig[] {
  try {
    const raw = localStorage.getItem(CONFIG_KEY)
    if (raw) {
      const arr = JSON.parse(raw)
      if (Array.isArray(arr)) return (arr as ApiConfig[]).map(normalizeConfig)
    }
  } catch {
    /* ignore */
  }
  // 兼容旧的单份配置格式
  try {
    const raw = localStorage.getItem('kimage.apiConfig')
    if (raw) {
      const c = JSON.parse(raw)
      const list: ApiConfig[] = [normalizeConfig({ id: uid(), name: 'Default config', ...c })]
      saveConfigs(list)
      return list
    }
  } catch {
    /* ignore */
  }
  return []
}

/* 补齐加字段之前存下来的配置缺的字段:
   - vendor:没有就按域名猜;
   - kind:没有(或读到别的值)一律当 'image' —— 加这个字段之前存的都是出图配置,
     而且外部脏数据不该让这条配置错类或消失 */
function normalizeConfig(c: ApiConfig): ApiConfig {
  return {
    ...c,
    vendor: c.vendor || inferVendor(c.baseUrl),
    kind: c.kind === 'text' ? 'text' : 'image'
  }
}

export function saveConfigs(list: ApiConfig[]) {
  localStorage.setItem(CONFIG_KEY, JSON.stringify(list))
}

export function loadActiveId(): string {
  return localStorage.getItem(CONFIG_ACTIVE_KEY) || ''
}

export function saveActiveId(id: string) {
  localStorage.setItem(CONFIG_ACTIVE_KEY, id)
}

// 文本类别的当前生效配置 id:与出图那条互不影响,两条各存各的
export function loadActiveTextId(): string {
  return localStorage.getItem(TEXT_ACTIVE_KEY) || ''
}

export function saveActiveTextId(id: string) {
  localStorage.setItem(TEXT_ACTIVE_KEY, id)
}

/**
 * 调用后端代理生图。
 * 返回标准化后的 ResultItem 列表(图片载荷统一是 Blob)。
 */
export async function generate(
  params: GenParams,
  config: ApiConfig,
  signal?: AbortSignal
): Promise<ResultItem[]> {
  const resp = await fetch('/api/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...params,
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      model: config.model || undefined,
      /* 两条都发:vendor 决定 OpenAI 那条路打 /images/generations 还是 /images/edits,
         protocol 决定整条请求走 OpenAI 形状还是 Gemini 原生形状。
         两者分开是因为中转站上"厂商"和"协议"并不一一对应 ——
         同一个 custom 地址,Gemini 系模型必须走原生协议 */
      vendor: config.vendor || inferVendor(config.baseUrl),
      protocol: getProvider(config.vendor || inferVendor(config.baseUrl), config.model).protocol
    }),
    signal
  })

  if (!resp.ok) {
    let msg = `Request failed (${resp.status})`
    try {
      const body = await resp.json()
      if (body?.error) msg = body.error
      // 附带上游原始报错 detail，便于定位 503/4xx 原因
      if (body?.detail) msg = `${msg} — ${body.detail}`
    } catch {
      /* ignore */
    }
    throw new Error(msg)
  }

  /* 出图位置两家不一样,所以先把两条协议的结果都摊成同一个形状再看:
     - OpenAI:      data[].b64_json | data[].url
     - Gemini 原生: candidates[].content.parts[].inlineData.data
       字段名还有 camelCase(inlineData/mimeType)和 snake_case(inline_data/mime_type)
       两种 —— 我们实测那家中转的两种填法各回一套,都收 */
  const data = (await resp.json()) as {
    data?: Array<{ b64_json?: string; url?: string }>
    candidates?: Array<{
      content?: {
        parts?: Array<{
          inlineData?: { data?: string; mimeType?: string }
          inline_data?: { data?: string; mime_type?: string }
        }>
      }
    }>
  }
  const found: Array<{ b64?: string; url?: string }> = []
  for (const item of data.data || []) found.push({ b64: item.b64_json, url: item.url })
  for (const c of data.candidates || []) {
    for (const part of c.content?.parts || []) {
      const inline = part.inlineData || part.inline_data
      if (inline?.data) found.push({ b64: inline.data })
    }
  }
  if (!found.length) {
    throw new Error('No images returned by upstream')
  }

  // 结果统一落成 Blob:base64 会膨胀 33% 且整段进 JS 堆,Blob 由浏览器放在堆外。
  // b64 按真实格式(JPEG/PNG/…)标注 MIME,避免硬编码 png 导致裂图。
  return await Promise.all(
    found.map(async (item): Promise<ResultItem> => {
      if (item.b64) {
        const mime = detectMimeFromDataUrl(item.b64)
        return { type: 'b64', data: base64ToBlob(item.b64, mime) }
      }
      if (item.url) {
        try {
          // URL 结果抓成本地 Blob,避免历史预览因外链过期失效
          return { type: 'b64', data: await urlToBlob(item.url) }
        } catch {
          return { type: 'url', data: item.url }
        }
      }
      return { type: 'url', data: '' }
    })
  )
}

/* 改写强度:quick 保守补细节,creative 允许重构构图与风格。
   档位差异全在服务端的系统提示里,前端只负责把它传下去 */
export type EnhanceMode = 'quick' | 'creative'

// 改写请求里除提示词以外的输入。参数已经够多,收成一个对象免得调用点排成一长串
export interface EnhanceOpts {
  mode: EnhanceMode
  /* 这次改写最终要喂给谁(出图接口的厂商与模型):
     各家对提示词结构的偏好不一样,服务端据此调整输出的写法 */
  targetVendor: string
  targetModel: string
  /* 是否图生图。有参考图时提示词的角色完全不同 —— 是"改什么"而不是"画什么" */
  hasRef: boolean
}

/**
 * 调用后端代理改写提示词。
 * 走文本模型的 /chat/completions(图像模型只出图、改不了提示词),
 * 用的是「用途 = text」那条配置的地址、密钥与模型。返回扩写后的提示词。
 * 未配置时由调用方先拦下,这里不重复判断。
 */
export async function enhancePrompt(
  cfg: ApiConfig,
  prompt: string,
  opts: EnhanceOpts,
  signal?: AbortSignal
): Promise<string> {
  const resp = await fetch('/api/enhance', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal,
    body: JSON.stringify({
      prompt,
      mode: opts.mode,
      targetVendor: opts.targetVendor,
      targetModel: opts.targetModel,
      hasRef: opts.hasRef,
      // 后端 /api/enhance 收的字段名仍是 textModel,路由不用改
      textModel: cfg.model,
      baseUrl: cfg.baseUrl,
      apiKey: cfg.apiKey
    })
  })

  if (!resp.ok) {
    let msg = `Request failed (${resp.status})`
    try {
      const body = await resp.json()
      if (body?.error) msg = body.error
      // 附带上游原始报错 detail，便于定位 503/4xx 原因
      if (body?.detail) msg = `${msg} — ${body.detail}`
    } catch {
      /* ignore */
    }
    throw new Error(msg)
  }

  const data = (await resp.json()) as { prompt?: string }
  const out = typeof data.prompt === 'string' ? data.prompt.trim() : ''
  if (!out) throw new Error('Upstream returned no text to use')
  return out
}

/* ===== 图片载荷 → 可渲染的 src =====================================
   新记录是 Blob,渲染时现造 object URL;旧记录是 data URL 字符串,原样返回。
   object URL 用 WeakMap 缓存:同一个 Blob 会被图墙、抽屉、预览同时取用,
   所以不能"谁先卸载谁 revoke";但也不能一直留着 —— blob URL 会强引用 Blob,
   记录被删除/清理后图片字节就回收不了。结论:由主界面在记录真正离开界面时
   调用 releaseEntryMedia 显式释放。
   ------------------------------------------------------------------ */
const srcCache = new WeakMap<Blob, string>()
export function imageSrc(item: ResultItem): string {
  if (typeof item.data === 'string') {
    // 旧数据若是纯 base64,补一个 png 前缀(尽力兼容)
    const s = item.data
    if (!s || s.startsWith('data:') || s.startsWith('blob:')) return s
    return item.type === 'b64' ? `data:image/png;base64,${s}` : s
  }
  let url = srcCache.get(item.data)
  if (!url) {
    url = URL.createObjectURL(item.data)
    srcCache.set(item.data, url)
  }
  return url
}

/** 释放一个载荷用过的 object URL:不撤销的话,blob URL 会一直强引用住 Blob */
export function releaseSrc(payload: ResultItem | Blob | undefined) {
  if (!payload) return
  const blob =
    payload instanceof Blob ? payload : typeof payload.data === 'string' ? undefined : payload.data
  if (!blob) return
  const url = srcCache.get(blob)
  if (!url) return
  URL.revokeObjectURL(url)
  srcCache.delete(blob)
}

/** 记录离开界面(删除/被清理)时,把它的原图与缩略图地址一起释放 */
export function releaseEntryMedia(entry: HistoryEntry) {
  for (const item of entry.results || []) releaseSrc(item)
  releaseSrc(entry.thumb)
}

/* ===== 列表缩略图 ===================================================
   抽屉列表把图缩到 48px 显示,但浏览器仍按原始分辨率解码:几十条一起
   挂载就是几十次全尺寸解码,而打开抽屉的同时还有弹簧动画和抽屉滑入在
   跑,主线程被压满,表现就是「只有 home → 历史 会卡」。
   入库时顺手做一张小图,列表只渲染它。老记录没有 thumb,退回原图。
   ------------------------------------------------------------------ */
const THUMB_EDGE = 128
/** 老记录补缩略图的上限:只补最近这些条,更早的沉在底部,不值得逐张全尺寸解码 */
const BACKFILL_MAX = 60

/**
 * 解码一张图,顺带量出真实像素尺寸,并尽量压一张列表缩略图。
 * 返回 undefined 表示拿不到这张图(item 缺失或解码失败);
 * 否则一定带回 w/h(图墙按真实比例排版要用),blob 会在图本来就很小、
 * 压缩无意义时缺省 —— 尺寸照量,缩略图不生成。
 */
export async function makeThumb(
  item: ResultItem | undefined
): Promise<{ blob?: Blob; w: number; h: number } | undefined> {
  if (!item) return undefined
  try {
    const src = imageSrc(item)
    if (!src) return undefined
    const bmp = await createImageBitmap(await (await fetch(src)).blob())
    const w = bmp.width
    const h = bmp.height
    const scale = Math.min(1, THUMB_EDGE / Math.max(bmp.width, bmp.height))
    if (scale >= 1) {
      // 本来就比缩略图还小,不值得多存一份;但尺寸仍要带回去给图墙用
      bmp.close()
      return { w, h }
    }
    const c = document.createElement('canvas')
    c.width = Math.max(1, Math.round(bmp.width * scale))
    c.height = Math.max(1, Math.round(bmp.height * scale))
    const ctx = c.getContext('2d')
    if (!ctx) {
      bmp.close()
      return { w, h }
    }
    ctx.drawImage(bmp, 0, 0, c.width, c.height)
    bmp.close()
    // webp 编码在个别环境下不可用,退回 png(透明图不能走 jpeg,会糊成黑底)
    const blob =
      (await new Promise<Blob | null>((r) => c.toBlob(r, 'image/webp', 0.8))) ??
      (await new Promise<Blob | null>((r) => c.toBlob(r, 'image/png'))) ??
      undefined
    return { blob, w, h }
  } catch {
    return undefined
  }
}

/** 列表用的地址:优先小缩略图,没有就退回原图 */
export function thumbSrc(e: HistoryEntry): string {
  const item: ResultItem | undefined = e.thumb ? { type: 'b64', data: e.thumb } : e.results?.[0]
  return item ? imageSrc(item) : ''
}

/**
 * 给加这个字段之前存下来的老记录补缩略图,顺带量出真实像素尺寸。
 * 每张之间留一段间隔,免得一上来就把主线程占满;补完落盘,只跑一次。
 * 任何一张失败都跳过,不影响使用。
 */
export async function backfillThumbs(list: HistoryEntry[]): Promise<void> {
  // 列表是从新到旧排的:几百条老记录逐条解码要跑好几分钟,只补最近这一段
  for (const entry of list.slice(0, BACKFILL_MAX)) {
    // 缩略图和尺寸都有了就不用再解码(尺寸是后来才加的字段,老记录通常缺)
    if (entry.thumb && entry.w && entry.h) continue
    const t = await makeThumb(entry.results?.[0])
    if (!t) continue
    if (t.blob) entry.thumb = t.blob
    entry.w = t.w
    entry.h = t.h
    try {
      await putOne(entry)
    } catch {
      /* 落盘失败就只留内存里这一份,下次打开还会再试 */
    }
    await new Promise((r) => setTimeout(r, 300))
  }
}

/* ===== 历史记录(IndexedDB,容量不受限、真正持久) ===== */
/** 把一条历史摊成可复现的参数,交给主界面按当前厂商的能力逐项套用 */
export function reuseParamsOf(e: HistoryEntry): ReuseParams {
  return {
    prompt: e.prompt,
    size: e.size,
    // 实际拿到的张数,而不是当初请求的数值:上游少给了就以实际为准
    n: e.results.length,
    quality: e.quality,
    background: e.background
  }
}
export async function loadHistory() {
  try {
    const list = await getAll<HistoryEntry>()
    return list.sort((a, b) => b.createdAt - a.createdAt)
  } catch {
    return []
  }
}
/**
 * 写入一条历史,并在空间吃紧时清理最旧的一批。
 * 返回 PruneResult 表示"确实清了",交由界面告知用户;空间宽裕时返回 null。
 */
export async function addHistoryRecord(record: HistoryEntry): Promise<PruneResult | null> {
  await putOne(record)
  return await pruneHistory()
}
export async function removeHistoryRecord(id: string) {
  // 删除不可能超出保留量,无需再裁剪
  await deleteOne(id)
}
/** 覆盖写回一条历史。改的是结果项上的「标记」,条目本身没变,所以不必重跑裁剪 */
export async function saveHistoryRecord(entry: HistoryEntry) {
  await putOne(entry)
}

/* ===== 提示词库(收藏) ===== */
const LIB_KEY = 'kimage.prompts'
export function loadPrompts(): PromptItem[] {
  try {
    const raw = localStorage.getItem(LIB_KEY)
    if (!raw) return []
    const list = JSON.parse(raw)
    // 存的是本地数据,但别信它一定是好的:被写坏(同步工具截断、手改)时
    // 直接当数组用会让整个库页崩掉,这里滤一遍,坏项丢掉即可
    if (!Array.isArray(list)) return []
    return list.filter(
      (p): p is PromptItem =>
        !!p && typeof p === 'object' && typeof (p as PromptItem).prompt === 'string'
    )
  } catch {
    return []
  }
}
export function savePrompts(list: PromptItem[]): boolean {
  try {
    localStorage.setItem(LIB_KEY, JSON.stringify(list))
    return true
  } catch {
    /* 配额不够时逐级丢封面:提示词本身比封面重要得多,宁可丢图也不能让整次保存失败
       (那样用户会以为存进去了)。列表是从新到旧排的,所以丢的是最旧那批的封面。

       降级按二分来:一条一条地试,每轮都要把整个列表重新序列化一遍,
       库稍大一点就会把主线程卡住;二分最多试 log2(n) 轮,几十条和几百条都没差别。 */
    for (let keep = Math.floor(list.length / 2); keep >= 0; keep = Math.floor(keep / 2)) {
      const next = list.map((p, i) => (i < keep ? { ...p } : { ...p, thumb: undefined }))
      try {
        localStorage.setItem(LIB_KEY, JSON.stringify(next))
        return false
      } catch {
        /* 还装不下,保留封面的大半再砍一半 */
      }
      if (keep === 0) break
    }
    return false
  }
}

