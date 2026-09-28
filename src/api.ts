import type { ApiConfig, GenParams, HistoryEntry, PromptItem, ResultItem, ReuseParams, Collection } from './types'
import type { PruneResult, CoverRecord } from './lib/idb'
import { titleFromPrompt } from './lib/text'
import {
  getAll,
  pruneHistory,
  putOne,
  deleteOne,
  urlToBlob,
  base64ToBlob,
  detectMimeFromDataUrl,
  getAllCovers,
  putCovers,
  ensurePersisted
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
  /* 接口认不认 seed。OpenAI 的 Images API 没有这个参数,标 'no' ——
     界面就不会给出一个填了也白发、甚至被 400 拒掉的输入框。
     未知的按 'unknown' 处理:填了就照发,由上游自己决定收不收 */
  seed: Cap
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
  seed: 'unknown',
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
  /* 原生的 generationConfig 里有 seed 字段,但图像模型认不认没有实测过,
     所以标 unknown(填了就发),不假装支持也不假装不支持 */
  seed: 'unknown',
  /* 给的都是能干净约分成 Gemini 认的宽高比的档位:
     1024x1024→1:1、1536x1024→3:2、1024x1536→2:3、1792x1024→16:9、1024x1792→9:16。
     约不出来的值不发这个参数(见 server 的 geminiRatio),不做隐式近似 */
  sizes: ['auto', '1024x1024', '1536x1024', '1024x1536', '1792x1024', '1024x1792'],
  /* 实测:不发宽高比时它自己给 16:9,所以 auto 是实打实的"模型自决",不是空话 */
  autoSize: true,
  /* 这个字段只对 OpenAI 那条路有意义(决定打 /images/edits 还是 /images/generations)。
     Gemini 的图生图不是换端点,而是在同一个 :generateContent 的 parts 里多给一段
     inlineData,由代理按协议分支处理,所以这里填什么都用不上 */
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
    // Images API 没有 seed 参数(那是 ChatGPT 界面里的东西),发了只会被拒
    seed: 'no',
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
    // Ark 认不认 seed 没有实测过:按"填了就发"处理,真被拒了上游会报错
    seed: 'unknown',
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
    // 同 Ark:没有实测过,按"填了就发"处理
    seed: 'unknown',
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
  if (h.includes('deepseek')) return 'deepseek'
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
    /* DeepSeek 只有对话模型(deepseek-chat / deepseek-reasoner),没有出图,
       所以它只在这一份预设里,不进 PROVIDERS —— 出图那行给出一个画不了图的
       选项等于骗人 */
    id: 'deepseek',
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat'
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
    const LEGACY_KEY = 'kimage.apiConfig'
    const raw = localStorage.getItem(LEGACY_KEY)
    if (raw) {
      const c = JSON.parse(raw)
      const list: ApiConfig[] = [normalizeConfig({ id: uid(), name: 'Default config', ...c })]
      saveConfigs(list)
      /* 搬完就把旧键删掉:新键已经写好,它留着没有用,而里面带着 API Key ——
         "一份密钥在这个站点上存了两处"不该是长期状态。
         删除单独兜一层:它失败不该把这次迁移一起判死,否则好不容易读出来的配置会丢 */
      try {
        localStorage.removeItem(LEGACY_KEY)
      } catch {
        /* 读得到就删得掉,这里只是不把删除失败升级成"配置也读不出来" */
      }
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

/** 连通性测试的判决。判断在服务端做(只有它知道怎么打上游),文案在这里拼 */
export interface TestResult {
  ok: boolean
  /** auth=密钥被拒 endpoint=没有这个端点 server=上游自己出错 network/timeout=没连上 */
  code?: 'auth' | 'endpoint' | 'server' | 'network' | 'timeout'
  /** models=走的是 GET /models(顺带查了模型在不在)，probe=那家没有 /models，退回探测 */
  via?: 'models' | 'probe'
  /** 只在 via='models' 且有模型清单时有值：目标模型在不在清单里 */
  modelListed?: boolean | null
  status: number | null
  ms: number
  detail?: string
}

/* 测这条配置通不通。发的是真实端点上的一个空请求:上游会因缺参数回 400,
   而 400 恰好证明地址、路径与密钥这条链是通的(见 server 的 /api/test)。
   它不会真的生成图,所以点几次都不花钱 */
export async function testConnection(config: ApiConfig): Promise<TestResult> {
  try {
    const resp = await fetch('/api/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
        model: config.model,
        protocol: getProvider(config.vendor || inferVendor(config.baseUrl), config.model).protocol,
        kind: config.kind === 'text' ? 'text' : 'image'
      })
    })
    const data = await resp.json().catch(() => null)
    // 地址本身没通过校验这类情况,后端会以 400 + error 回,不是网络故障
    if (!resp.ok) {
      return {
        ok: false,
        code: 'network',
        status: resp.status,
        ms: 0,
        detail: data?.error || `Test failed (${resp.status})`
      }
    }
    return data as TestResult
  } catch (e) {
    return {
      ok: false,
      code: 'network',
      status: null,
      ms: 0,
      detail: e instanceof Error ? e.message : 'Request failed'
    }
  }
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
          text?: string
          inlineData?: { data?: string; mimeType?: string }
          inline_data?: { data?: string; mime_type?: string }
        }>
      }
    }>
  }
  const found: Array<{ b64?: string; url?: string }> = []
  // 模型只回了文字、没出图时,这些句子是唯一能说明原因的线索
  const said: string[] = []
  for (const item of data.data || []) found.push({ b64: item.b64_json, url: item.url })
  for (const c of data.candidates || []) {
    for (const part of c.content?.parts || []) {
      const inline = part.inlineData || part.inline_data
      if (inline?.data) found.push({ b64: inline.data })
      else if (typeof part.text === 'string' && part.text.trim()) said.push(part.text.trim())
    }
  }
  if (!found.length) {
    /* Gemini 系的图像模型本质上是对话模型:它可能不谈出图,只回一句话
       (最常见的是"请先给参考图",其次是安全拒绝)。那句话是这里唯一有用的信息,
       丢掉它只会剩下一句"上游没返回图片",等于什么都没说 —— 直接把它当报错抛出来 */
    throw new Error(
      said.length ? said.join(' ').slice(0, 400) : 'No images returned by upstream'
    )
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
function objectUrlOf(blob: Blob): string {
  let url = srcCache.get(blob)
  if (!url) {
    url = URL.createObjectURL(blob)
    srcCache.set(blob, url)
  }
  return url
}
export function imageSrc(item: ResultItem): string {
  if (typeof item.data === 'string') {
    // 旧数据若是纯 base64,补一个 png 前缀(尽力兼容)
    const s = item.data
    if (!s || s.startsWith('data:') || s.startsWith('blob:')) return s
    return item.type === 'b64' ? `data:image/png;base64,${s}` : s
  }
  return objectUrlOf(item.data)
}

/* 提示词封面 → 可渲染的 src。与历史图共用同一份缓存(Object URL 由 Blob 键控),
   所以从库里删掉一条时,要连它的封面一起 releaseSrc 掉 */
export function coverSrc(cover: Blob | undefined): string {
  return cover ? objectUrlOf(cover) : ''
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

/* ===== 批量导出选中的图 =============================================
   把挑好的图打包带走 —— "做一套素材"这个任务的最后一步。
   粒度是"图"而不是"记录":一条记录里只挑了一张,就只导出那一张,
   与历史图墙把记录摊平成图块的口径一致(见 HistoryPage 的 tiles)。

   这里刻意不认识"标记":标记是一份长期收藏,而"这次要带走哪几张"往往
   只是一次性的挑选。所以由调用方给出清单,这一层只负责取字节与打包。
   -------------------------------------------------------------------- */
export interface ExportPick {
  /** 属于哪条提示词 —— 只用来起文件名 */
  prompt: string
  item: ResultItem
}

export interface ExportOutcome {
  /** 真正打进包里的张数 */
  exported: number
  /** 取不回字节因而被跳过的张数(远端图被 CORS 拦、载荷损坏) */
  skipped: number
}

/** 按载荷真实类型推扩展名:结果可能是 jpeg / webp,写死 png 名不对。
 *  单张下载与批量导出共用同一份,两处各写一套迟早改歪一边 */
export function extOf(item: ResultItem | undefined): string {
  const data = item?.data
  if (data instanceof Blob) {
    const t = data.type
    if (t.includes('jpeg')) return 'jpg'
    if (t.includes('webp')) return 'webp'
    if (t.includes('gif')) return 'gif'
    return 'png'
  }
  if (typeof data === 'string') {
    const mime = detectMimeFromDataUrl(data)
    return mime === 'image/jpeg' ? 'jpg' : mime.split('/')[1] || 'png'
  }
  return 'png'
}

/* 读出一张图的字节。统一借 imageSrc 把三种载荷(Blob / data URL / 远端 URL)
   变成可 fetch 的地址,不必在调用点各判一次。
   远端图可能被跨域拦下 —— 返回 undefined 让调用方跳过:导出不该因为一张
   取不回来的老图而整批失败 */
async function itemBlob(item: ResultItem): Promise<Blob | undefined> {
  const src = imageSrc(item)
  if (!src) return undefined
  try {
    return await urlToBlob(src)
  } catch {
    return undefined
  }
}

/** 文件名里不能出现的字符去掉;标题派生不出来时退回一个通用名 */
function safeBase(prompt: string): string {
  const cleaned = titleFromPrompt(prompt)
    .replace(/[\\/:*?"<>|]/g, '')
    .replace(/\.+$/, '')
    .trim()
  return cleaned || 'image'
}

/** 触发一次下载。object URL 用完即撤,否则这份 zip 会被一直强引用住 */
function downloadBlob(blob: Blob, filename: string) {
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = filename
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 1500)
}

/** 包名带时间戳:同一天导两次不会互相覆盖 */
function zipName(): string {
  const d = new Date()
  const p = (x: number) => String(x).padStart(2, '0')
  return `kimage-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.zip`
}

/**
 * 把给出的一批图打包成一个 zip 下载。
 *
 * 逐张串行读字节:并发读会一次性解码多张大图、把整批请求同时压在主线程上,
 * 而这是一次手动动作,慢一点无妨。
 * 图片本身已是压缩格式,所以用 level 0(只打包不再压),省掉白烧的 CPU。
 * zip 库用动态引入:导出是低频动作,不该让它进首屏那份包。
 */
export async function exportImages(
  picks: ExportPick[],
  onProgress?: (done: number, total: number) => void
): Promise<ExportOutcome> {
  const files: Record<string, Uint8Array> = {}
  // 同一句提示词出的多张图会撞名,所以按标题分别计数编号
  const counters = new Map<string, number>()
  let skipped = 0

  for (let i = 0; i < picks.length; i++) {
    onProgress?.(i, picks.length)
    const { prompt, item } = picks[i]
    const blob = await itemBlob(item)
    if (!blob) {
      skipped++
      continue
    }
    const base = safeBase(prompt)
    const n = (counters.get(base) || 0) + 1
    counters.set(base, n)
    files[`kimage-${base}-${n}.${extOf(item)}`] = new Uint8Array(await blob.arrayBuffer())
  }
  onProgress?.(picks.length, picks.length)

  const exported = Object.keys(files).length
  if (!exported) return { exported: 0, skipped }

  const { zip } = await import('fflate')
  const bytes = await new Promise<Uint8Array>((resolve, reject) => {
    zip(files, { level: 0 }, (err, out) => (err ? reject(err) : resolve(out)))
  })
  /* fflate 的返回类型挂在 ArrayBufferLike 上(理论上可能是 SharedArrayBuffer),
     而 BlobPart 只收 ArrayBuffer 支撑的视图 —— 这里拿到的一定是普通 Uint8Array,
     转一下类型即可,不必白拷一份字节 */
  downloadBlob(new Blob([bytes as BlobPart], { type: 'application/zip' }), zipName())
  return { exported, skipped }
}

/* ===== 历史记录(IndexedDB,容量不受限、真正持久) ===== */
/** 把一条历史摊成可复现的完整配方,交给主界面按当前厂商的能力逐项套用。
 *  参考图不在返回值里 —— 记录里存的是 Blob,转 data URL 要异步,由调用方补上 */
export function reuseParamsOf(e: HistoryEntry): ReuseParams {
  return {
    prompt: e.prompt,
    size: e.size,
    // 实际拿到的张数,而不是当初请求的数值:上游少给了就以实际为准
    n: e.results.length,
    quality: e.quality,
    background: e.background,
    /* 配方里最容易漏掉的两项。不还原配置,重跑用的其实是"当前生效的那个模型",
       换了模型却以为是同一张图在微调,对比就失真了 */
    configId: e.configId,
    seed: e.seed,
    // 出处:主界面在落盘时把这条记录设为新生成的 parent,链就挂上了
    fromEntryId: e.id
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
  // 第一次真正写入时顺带申请持久化存储(见 idb.ts 的 ensurePersisted)
  await ensurePersisted()
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

/* ===== 作品集(Collection)目录 ===========================================
   作品集只存"标题 + id"的目录 —— 每条几百字节,localStorage 足够。
   归属关系(哪条记录属于哪个作品集)挂在记录自己的 collectionId 上,
   和记录一起存在 IndexedDB,所以这里不需要接触 IDB。
   ------------------------------------------------------------------------ */
const COLL_KEY = 'kimage.collections'

/** 读出作品集目录。目录是本地数据,但别信它一定干净:同步工具截断、手改时
    当数组直接用会让页面崩,滤一遍扔掉坏项 */
export function loadCollections(): Collection[] {
  try {
    const raw = localStorage.getItem(COLL_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (c): c is Collection =>
        !!c && typeof c === 'object' && typeof (c as Collection).title === 'string'
    )
  } catch {
    return []
  }
}

/** 整份覆盖写回。目录小,全量重写最省心 */
export function saveCollections(list: Collection[]): void {
  try {
    localStorage.setItem(COLL_KEY, JSON.stringify(list))
  } catch {
    /* ignore: 写不下就不写,下次改动再试 */
  }
}

/* ===== 提示词库(收藏) ===== */
const LIB_KEY = 'kimage.prompts'
/* 提示词库的读入规范化。老记录只有一个 category 字符串,新的是 tags 数组;
   两套字段的判断收口在这里,别散到各个组件里去分辨"这条是新的还是旧的"。
   'Uncategorized' 是当初的默认值,不是用户填的,转成标签只会多出一个噪声分类 */
export function normalizePrompt(p: PromptItem): PromptItem {
  const out: PromptItem = { ...p }
  if (!Array.isArray(out.tags)) {
    const legacy = (out.category || '').trim()
    out.tags = legacy && legacy !== 'Uncategorized' ? [legacy] : []
  }
  out.tags = [...new Set(out.tags.map((t) => String(t).trim()).filter(Boolean))]
  delete out.category
  return out
}

/* 读入库。封面不在 localStorage 里(那里只有约 5MB),而是按 id 存在 IndexedDB;
   所以这里要异步,并把封面贴回条目上。
   老数据(以及旧版导出文件)把封面写成条目里的 thumb —— data URL,而且是当年
   为了挤进 5MB 压到 320px 的缩略图。读到这里顺手转成 Blob 搬进 IDB,
   并从条目里摘掉,否则它一直占着那 5MB 不撒手。旧封面糊就糊了,没法凭空变清楚 */
export async function loadPrompts(): Promise<PromptItem[]> {
  let list: PromptItem[] = []
  try {
    const raw = localStorage.getItem(LIB_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    // 存的是本地数据,但别信它一定是好的:被写坏(同步工具截断、手改)时
    // 直接当数组用会让整个库页崩掉,这里滤一遍,坏项丢掉即可
    if (!Array.isArray(parsed)) return []
    list = parsed
      .filter(
        (p): p is PromptItem =>
          !!p && typeof p === 'object' && typeof (p as PromptItem).prompt === 'string'
      )
      .map(normalizePrompt)
  } catch {
    return []
  }

  const covers = await getAllCovers()
  let legacy = false
  for (const item of list) {
    const thumb = typeof item.thumb === 'string' ? item.thumb : ''
    if (thumb.startsWith('data:image/')) {
      legacy = true
      // 库里已经有这条封面(上次搬运成功过)就以库里那份为准
      if (!covers.has(item.id)) {
        try {
          covers.set(item.id, await urlToBlob(thumb))
        } catch {
          /* 转不出来:这条没封面,不影响其余 */
        }
      }
    }
    delete item.thumb
    const cover = covers.get(item.id)
    if (cover) item.cover = cover
  }
  if (legacy) {
    try {
      await putCovers([...covers].map(([id, data]) => ({ id, data })))
      /* 目录单独写,不走 savePrompts:那条路会按"条目里现存的封面"反向裁剪 IDB,
         而这里条目的封面还没摘(内存里要留着给界面用),一裁就把刚搬进去的全删了 */
      localStorage.setItem(LIB_KEY, JSON.stringify(slimList(list)))
    } catch {
      /* 搬不过去就先算了:下次加载会再试一遍,条目里那份还在,数据不会丢 */
    }
  }
  return list
}

/** 目录:localStorage 只存这个(没有封面,每条几百字节) */
function slimList(list: PromptItem[]): PromptItem[] {
  return list.map((item) => {
    const copy = { ...item }
    delete copy.cover
    delete copy.thumb
    return copy
  })
}

/** 封面:按 id 进 IndexedDB */
function coversOf(list: PromptItem[]): CoverRecord[] {
  return list
    .filter((i): i is PromptItem & { cover: Blob } => i.cover instanceof Blob)
    .map((i) => ({ id: i.id, data: i.cover }))
}

/* 存回库。封面与目录分开写:localStorage 只留目录(小),封面按 id 进 IndexedDB。
   以前两者都在 localStorage 里,装不下时只能整批丢封面 —— 去掉封面之后
   每条只剩几百字节,那一整套"逐级丢封面"的降级路径也就不需要了。
   返回 false 表示有东西没落盘,界面据此提示 */
export async function savePrompts(list: PromptItem[]): Promise<boolean> {
  const covers = coversOf(list)
  let ok = true
  try {
    await ensurePersisted()
    // 顺带清掉已经不在库里的封面:删掉一条提示词,它的封面不该永远留在这儿
    await putCovers(covers)
  } catch {
    ok = false
  }
  try {
    localStorage.setItem(LIB_KEY, JSON.stringify(slimList(list)))
  } catch {
    // 连目录都写不下(现实里到不了:去掉封面后每条只有几百字节),如实返回失败
    ok = false
  }
  return ok
}

