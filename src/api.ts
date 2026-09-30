import type { ApiConfig, EditParams, GenParams, HistoryEntry, PromptItem, ResultItem, ReuseParams, Collection, Character, CharacterDraft, CharacterFields, CharacterView, CharacterViewKind, ImportedCharacter } from './types'
import type { PruneResult, CoverRecord, CharRefRecord } from './lib/idb'
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
  getAllCharRefs,
  putCharRefs,
  charSourceKey,
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
  /* 认不认多张参考图。标 'no' 的只送一张 ——
     设定图那条流水线会退化成"只拿正脸当参考"(见 App 的 genCharView),
     而不是发两张过去把整个请求弄失败。
     未知的按"能发就发"处理,与上面几项一致:这里只拦明确知道的单图模型 */
  multiImage: Cap
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
  /* 未知厂商按"发"处理:中转站背后多数是能收多张的 OpenAI / Gemini 系,
     真发错了上游会报错说清楚,而静默退回单图是用户看不见的信息损失 */
  multiImage: 'unknown',
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
  // 原生请求体的 parts 里可以并列多段 inlineData,多张参考图是它本来就认的形态
  multiImage: 'yes',
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
    // /images/edits 的 image[] 本来就收多张;dall-e-2 时代只收一张,但那条路已经不用了
    multiImage: 'yes',
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
    // Seedream 的图像编辑只收一张参考图
    multiImage: 'no',
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
    // 万相的图像编辑同样是单图
    multiImage: 'no',
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
   ------------------------------------------------------------------ */
export const QUALITY_OPTIONS = [
  { value: 'auto', label: 'Auto' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' }
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

  return await imagesFrom(resp)
}

/* 把上游的响应摊成同一个形状的图列表。出图与局部编辑共用 ——
   两处各写一套解析,迟早有一边漏掉 Gemini 的 snake_case 变体。

   出图位置两家不一样,所以先摊平再看:
   - OpenAI:      data[].b64_json | data[].url
   - Gemini 原生: candidates[].content.parts[].inlineData.data
     字段名还有 camelCase(inlineData/mimeType)和 snake_case(inline_data/mime_type)
     两种 —— 我们实测那家中转的两种填法各回一套,都收 */
async function imagesFrom(resp: Response): Promise<ResultItem[]> {
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

/* ===== 画布里的 AI 编辑 ==============================================
   给原图和一块区域,让上游重做那块像素。去背景 / 消除 / 局部重绘共用它,
   差别只在 mask 怎么来、有没有指令(见 types.ts 的 EditParams)。

   与 generate 分成两条端点:那条的语义是"画一张新图"(参考图只是引导),
   这条是"在这张图上改一块"。合成一条的话,服务端没法按模式挑提示词,
   客户端也得靠一个布尔值去分辨两种截然不同的意图。
   -------------------------------------------------------------------- */

/**
 * 把想要的画幅收窄成目标厂商真认的取值。认不出来就给 undefined(等于不发)。
 *
 * 编辑那条路是不发 size 的,理由是"不发就等于保持原样" —— 恰恰相反:
 * 多数上游在没收到 size 时退回自己的默认画幅,而那就是 1024x1024,
 * 于是一张 3:2 的图改完变成方的(autoSize 那段注释早就写了这件事,
 * 只是编辑这条路没跟上)。画布上"按参考图再生成一张"也吃同一个亏。
 *
 * 能自由定尺寸的厂商直接报原尺寸;只认枚举的按宽高比挑最接近的一档。
 * auto 一律跳过 —— 它的意思是"模型自己定比例",正是要避开的那个。
 */
export function allowedSizeFor(
  vendorId: string | undefined,
  model: string,
  want?: string
): string | undefined {
  if (!want) return undefined
  const allowed = allowedSizes(vendorId, model)
  if (allowed === 'free') return want
  const m = String(want).match(/^(\d{1,5})x(\d{1,5})$/i)
  if (!m) return undefined
  const target = Number(m[1]) / Number(m[2])
  let best: string | undefined
  let gap = Infinity
  for (const s of allowed) {
    if (s === 'auto') continue
    const sm = s.match(/^(\d{1,5})x(\d{1,5})$/i)
    if (!sm) continue
    /* 比的是比例的对数距离:1:1 偏到 2:1 和偏到 1:2 该算同样的偏差,
       直接用差值算会把竖图一律判给横图 */
    const d = Math.abs(Math.log(Number(sm[1]) / Number(sm[2]) / target))
    if (d < gap) {
      gap = d
      best = s
    }
  }
  return best
}

/**
 * 在这一张图上改一块。
 * 返回一张新图 —— 局部编辑不存在"给我四张选一张":区域是用户画出来的,
 * 四张里挑一张等于让他重画四次选区。
 */
export async function editImage(
  params: EditParams,
  config: ApiConfig,
  signal?: AbortSignal
): Promise<ResultItem> {
  const vendor = config.vendor || inferVendor(config.baseUrl)
  const provider = getProvider(vendor, config.model)
  /* 去背景要的是"抠出来",所以能要透明就要透明 —— 白底是当年没有这个
     参数时的将就,不是用户想要的。只在厂商明确支持时才发:这一项被拒
     会导致整条请求 400,而 background 的候选值里没有"auto"这种安全档
     (见带 autoSize 那段注释的同一套取舍) */
  const background = params.mode === 'remove-bg' && provider.background === 'yes' ? 'transparent' : ''
  const resp = await fetch('/api/edit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...params,
      /* 收窄成目标厂商真认的取值。undefined 会被 JSON 丢掉,等于不发 */
      size: allowedSizeFor(vendor, config.model || '', params.size),
      background: background || undefined,
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      model: config.model || undefined,
      /* 与 generate 同一套:vendor 决定打哪个端点,protocol 决定请求体走
         OpenAI 形状还是 Gemini 原生形状(见 getProvider 的说明) */
      vendor,
      protocol: provider.protocol
    }),
    signal
  })

  if (!resp.ok) {
    let msg = `Request failed (${resp.status})`
    try {
      const body = await resp.json()
      if (body?.error) msg = body.error
      if (body?.detail) msg = `${msg} — ${body.detail}`
    } catch {
      /* ignore */
    }
    throw new Error(msg)
  }

  const items = await imagesFrom(resp)
  return items[0]
}

/**
 * 以一张图作参考再画一张。画布上那条"按这张继续创作"走这里。
 *
 * 它打的是出图那条端点,不是编辑那条 —— 两者要的东西根本不同:
 * 编辑是"在这张图上改一块",参考图是"照它的样子另画一张",画成什么样由提示词说。
 *
 * 只有一处收窄:size 要按厂商能力挑。画布那边的画幅是用户自己裁出来的,
 * 直接原样发过去,只认枚举的厂商会整条 400。
 * 只出四张选一张没有意义 —— 参考图是当前这张,出的就是接着要用的那一张 */
export async function generateFrom(
  params: { prompt: string; image: string; size: string },
  config: ApiConfig,
  signal?: AbortSignal
): Promise<ResultItem> {
  const vendor = config.vendor || inferVendor(config.baseUrl)
  const items = await generate(
    {
      prompt: params.prompt,
      size: allowedSizeFor(vendor, config.model || '', params.size) ?? params.size,
      n: 1,
      images: [params.image]
    },
    config,
    signal
  )
  return items[0]
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

/* ===== 角色的导入导出 =====
   与提示词库那处不同:角色**必须**带图。设定图只在 IndexedDB 里存一份
   (不进历史,见 App 的 genCharView),所以只导设定的 JSON 得到的是一个没有脸的角色 ——
   对方还得重新生成五张,而重新生成出来的脸已经不是同一个了。所以走 zip。

   包里图片的路径写在 manifest 里,不靠命名约定:读的一方按 manifest 取文件,
   于是单角色包可以平铺在根目录(好看),将来的多角色包放各自子目录,
   两边都不用改读取逻辑 */

/** 导出包的 manifest。版本号先留着:以后改结构时可以据此分支,而不是猜 */
type CharacterManifest = {
  format: 'kimage-character'
  version: 1
  characters: Array<{
    name: string
    createdAt: number
    fields?: CharacterFields
    desc?: string
    refKind?: CharacterViewKind
    /** zip 内的相对路径。没有这一项就是没有那张图 */
    ref?: string
    /* 第一步上传的那张底图。它不属于五张设定图,所以单独一项 ——
       少了它,导入回来的角色在重跑其余四张时就只剩正脸一张参考图 */
    source?: string
    views?: Partial<Record<CharacterViewKind, string>>
  }>
}

/** Blob → 扩展名。设定图统一是 JPEG,但参考图可能是用户上传的 PNG,
 *  所以照实判,不写死(与 extOf 同一份 MIME 表) */
function extOfBlob(blob: Blob): string {
  const t = (blob.type || '').toLowerCase()
  if (t.includes('jpeg') || t.includes('jpg')) return 'jpg'
  if (t.includes('webp')) return 'webp'
  if (t.includes('gif')) return 'gif'
  return 'png'
}

/** 按魔数认图片类型,不认扩展名:参考图是以 data URL 送给上游的,
 *  前缀里的 MIME 就是这里定的 —— 写错会被上游拒掉。
 *  (data URL 那个版本见 lib/idb.ts 的 detectMimeFromDataUrl) */
function sniffMime(b: Uint8Array): string {
  if (b[0] === 0xff && b[1] === 0xd8) return 'image/jpeg'
  if (b[0] === 0x89 && b[1] === 0x50) return 'image/png'
  if (b[0] === 0x47 && b[1] === 0x49) return 'image/gif'
  // WEBP 是 RIFF 容器:前 4 字节 "RIFF",第 8-11 字节 "WEBP"
  if (b[0] === 0x52 && b[8] === 0x57 && b[9] === 0x45) return 'image/webp'
  return 'image/jpeg'
}

/** 文件名里不能出现的字符去掉。名字可能很长,截一段够认出来就行 */
function safeFile(name: string, fallback: string): string {
  const cleaned = name.replace(/[\\/:*?"<>|]/g, '').replace(/\.+$/, '').trim().slice(0, 40)
  return cleaned || fallback
}

/** 包名带角色名,一堆下载里一眼认得出;同日导两次也不会互相覆盖 */
function characterZipName(name: string): string {
  const d = new Date()
  const p = (x: number) => String(x).padStart(2, '0')
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`
  return `kimage-character-${safeFile(name, 'character')}-${stamp}.zip`
}

/**
 * 导出一个角色:character.json + 主参考图 + 五张设定图,打成一个 zip。
 *
 * 与 exportImages 同一套:动态引入 fflate(导出是低频动作,不该进首屏那份包)、
 * level 0(图已是压缩格式,再压只是白烧 CPU)、串行读字节。
 * 返回包内实际写进去的图片张数,好在界面上如实回执 —— 一个只有设定的角色
 * 也能导出,那种包小得多,该让用户知道。
 */
export async function exportCharacter(c: Character, views: CharacterView[]): Promise<number> {
  const files: Record<string, Uint8Array> = {}
  const entry: CharacterManifest['characters'][number] = {
    name: c.name,
    createdAt: c.createdAt,
    ...(c.fields ? { fields: c.fields } : {}),
    ...(c.desc ? { desc: c.desc } : {}),
    ...(c.refKind ? { refKind: c.refKind } : {})
  }

  let images = 0
  if (c.ref) {
    const name = `ref.${extOfBlob(c.ref)}`
    files[name] = new Uint8Array(await c.ref.arrayBuffer())
    entry.ref = name
    images++
  }
  // 底图与封面图多数时候不是同一张(封面是生成出来的正脸),所以要分开写
  if (c.sourceRef) {
    const name = `source.${extOfBlob(c.sourceRef)}`
    files[name] = new Uint8Array(await c.sourceRef.arrayBuffer())
    entry.source = name
    images++
  }
  const map: Partial<Record<CharacterViewKind, string>> = {}
  for (const v of views) {
    const name = `${v.kind}.${extOfBlob(v.data)}`
    files[name] = new Uint8Array(await v.data.arrayBuffer())
    map[v.kind] = name
    images++
  }
  if (Object.keys(map).length) entry.views = map

  const manifest: CharacterManifest = { format: 'kimage-character', version: 1, characters: [entry] }
  files['character.json'] = new TextEncoder().encode(JSON.stringify(manifest, null, 2))

  const { zip } = await import('fflate')
  const bytes = await new Promise<Uint8Array>((resolve, reject) => {
    zip(files, { level: 0 }, (err, out) => (err ? reject(err) : resolve(out)))
  })
  /* fflate 的返回类型挂在 ArrayBufferLike 上,而 BlobPart 只收 ArrayBuffer 支撑的视图 ——
     拿到的确实是普通 Uint8Array,转一下类型即可(与 exportImages 同一处理) */
  downloadBlob(new Blob([bytes as BlobPart], { type: 'application/zip' }), characterZipName(c.name))
  return images
}

/** 读一个角色 zip。返回的每条都换过 id ——
 *  不沿用文件里的 id:它可能与现有的撞上,而列表里两条同 id 会让渲染与删除都错乱
 *  (与配置的导入同一条理由)。内容来自外部文件,所以逐项规整,坏的就丢掉。 */
export async function readCharacterZip(file: File): Promise<ImportedCharacter[]> {
  const { unzip } = await import('fflate')
  // 先把字节读出来:unzip 的回调不是 async,不能在里面 await
  const zipBytes = new Uint8Array(await file.arrayBuffer())
  const entries = await new Promise<Record<string, Uint8Array>>((resolve, reject) => {
    unzip(zipBytes, (err, out) => (err ? reject(err) : resolve(out)))
  })

  /* manifest 不一定在根目录:用户很可能解压看一眼再重新打包,于是整包多套了一层
     文件夹(macOS 还会塞一个 __MACOSX)。按 basename 找它,并以它所在的目录为基准
     解析图路径 —— 否则一个明明看得见 character.json 的包会被判成"不是角色包" */
  const manifestKey = Object.keys(entries).find(
    (k) => !k.startsWith('__MACOSX/') && k.split('/').pop() === 'character.json'
  )
  if (!manifestKey) {
    throw new Error('That zip has no character.json — it is not a character export.')
  }
  const base = manifestKey.slice(0, manifestKey.length - 'character.json'.length)
  // 基准目录下有就用它,没有就退回原路径(兼容手写/其它工具生成的包)
  const fileAt = (path: string): Uint8Array | undefined => entries[base + path] || entries[path]

  let parsed: CharacterManifest
  try {
    parsed = JSON.parse(new TextDecoder().decode(entries[manifestKey]))
  } catch {
    throw new Error('character.json inside that zip is not valid JSON.')
  }
  if (!Array.isArray(parsed?.characters)) {
    throw new Error('character.json inside that zip has no characters.')
  }

  const known = new Set<string>(CHARACTER_VIEWS.map((v) => v.kind))
  const out: ImportedCharacter[] = []
  for (const c of parsed.characters) {
    if (!c || typeof c.name !== 'string' || !c.name.trim()) continue

    const views: ImportedCharacter['views'] = []
    for (const [kind, path] of Object.entries(c.views || {})) {
      // 认不出的视图名丢掉:库里只认这五种(与 loadCharViews 同一条筛选)
      const bytes = typeof path === 'string' ? fileAt(path) : undefined
      if (!known.has(kind) || !bytes) continue
      views.push({
        kind: kind as CharacterViewKind,
        data: new Blob([bytes as BlobPart], { type: sniffMime(bytes) })
      })
    }

    const refBytes = typeof c.ref === 'string' ? fileAt(c.ref) : undefined
    // 老包(底图还是单独一项之前导的)没有 source,读到的就是空 —— 退化成单图参考
    const sourceBytes = typeof c.source === 'string' ? fileAt(c.source) : undefined
    out.push({
      name: c.name.trim(),
      createdAt: typeof c.createdAt === 'number' ? c.createdAt : Date.now(),
      // 补齐缺的键:外部文件里的设定可能是老版本写的(见 emptyCharFields)
      ...(c.fields ? { fields: { ...emptyCharFields(), ...c.fields } } : {}),
      ...(typeof c.desc === 'string' && c.desc.trim() ? { desc: c.desc.trim() } : {}),
      ...(refBytes
        ? { ref: new Blob([refBytes as BlobPart], { type: sniffMime(refBytes) }) }
        : {}),
      ...(sourceBytes
        ? { sourceRef: new Blob([sourceBytes as BlobPart], { type: sniffMime(sourceBytes) }) }
        : {}),
      // 主参考图取自哪张视图,只有在图确实带上了时才有意义
      ...(refBytes && typeof c.refKind === 'string' && known.has(c.refKind)
        ? { refKind: c.refKind as CharacterViewKind }
        : {}),
      views
    })
  }
  return out
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

/* ===== 角色 =====
   目录只有名字/设定/时间,每条几百字节,localStorage 足够;
   参考图是 Blob,按 id 存在 IndexedDB,读的时候贴回去(与提示词封面同一套做法) */
const CHAR_KEY = 'kimage.characters'

/* 面貌特征:跨场景不该变的那九项。这九项会并进每一张成品的提示词 ——
   只给头发和眼睛时,肤色、脸型、眉形全靠模型自己从零重编,换个场景就不是同一个人了 */
const CHAR_FACE_FIELDS: Array<keyof CharacterFields> = [
  /* 性别排在最前:顺序就是这个条件的强弱顺序。它是这张脸最基础的一档,
     而且只在用户没写、模型也没读到的时候才会出问题 —— 出了就是换一个人 */
  'gender',
  'identity',
  'face',
  'hair',
  'brows',
  'eyes',
  'noseMouth',
  'facialHair',
  'faceMarks'
]
/* 只塑造设定图的两项:衣服与装备属于"这一张发生什么",该由场景决定 ——
   你写"在太空里",前置的 armored jacket 就在跟它打架 */
const CHAR_SHEET_ONLY_FIELDS: Array<keyof CharacterFields> = ['outfit', 'marks']

/* 字段顺序。顺序固定很重要 —— 顺序一变,上游拿到的条件就变了,一致性也就无从谈起。
   两组拼在一起就是完整顺序,不含备注(备注单独接在最后) */
const CHAR_FIELD_ORDER: Array<keyof CharacterFields> = [
  ...CHAR_FACE_FIELDS,
  ...CHAR_SHEET_ONLY_FIELDS
]

/* 一份空设定:解析、新建表单、读入老数据都拿它当底。
   由 CHAR_FIELD_ORDER 生成而不是手写十遍 —— 加字段时只有一处要改 */
export function emptyCharFields(): CharacterFields {
  const out = {} as CharacterFields
  for (const k of CHAR_FIELD_ORDER) out[k] = ''
  return out
}

/* 字段值里的换行与连续空白收敛成单个空格。
   规格字段现在是可换行的 textarea(单行装不下 12 个词的字段值),
   换行只是排版,原样拼进提示词会在句子中间插一段空白 */
function inline(s: string | undefined): string {
  return (s || '').replace(/\s+/g, ' ').trim()
}

/* 角色描述文本:按固定顺序把结构化设定拼起来,再接上自由描述。
   加结构化字段之前存下来的角色只有 desc,那种情况整段返回,不做任何改写。
   这个"全量"版本只用在设定图自己的生成上(见 App 的 genCharView)—— */
export function characterDesc(c: Character): string {
  const f = c.fields
  const parts = f ? CHAR_FIELD_ORDER.map((k) => inline(f[k])).filter(Boolean) : []
  const free = inline(c.desc)
  if (free) parts.push(free)
  return parts.join(', ')
}

/* 并进普通创作提示词的只有面貌特征那八项(见 CHAR_FACE_FIELDS)。
   为什么会细分到眉毛和脸型:只给 hair 和 eyes 时,肤色、骨相、眉形全靠模型
   自己从零重编,场景一换就不是同一个人了。而 face marks 与 facialHair 之所以
   也在这里,是因为它们一旦只出现在设定图里、不进创作提示词,就会每张图丢一次。

   加结构化字段之前的老角色没有 fields,退回全量描述,总比什么都不送强 */
export function characterFaceDesc(c: Character): string {
  const f = c.fields
  if (!f) return characterDesc(c)
  return CHAR_FACE_FIELDS.map((k) => inline(f[k])).filter(Boolean).join(', ')
}

/* —— 角色的设定图 ——
   五张视图各自的修饰词与取景。顺序就是生成顺序:正脸是锚,其余四张都以它当参考图,
   才谈得上"同一张脸"。取景分方形与竖幅 —— 头像装得下方形,全身只有竖幅才放得开。

   顺序也按"它补上了什么"来排:脸定人 → 把这张脸转到别的方向看 →
   全身交代体型与服装轮廓 → 细部特写交代材质与零件 → 表情收情绪跨度。
   这个顺序只影响列表与"一次补齐"的先后,不影响任何一张的提示词。

   注意:修饰词里绝对不能出现 "character reference sheet" 这类词。
   它在图像模型那里是一个很强的排版概念(设定表 = 正面 + 侧面 + 背面并排 + 细节放大),
   写进去模型就真的给你画一张拼版,而不是一张干净的单人图。
   要的是"单个人物占画面主体",所以正面把 "single / one person" 说死。

   另外不写 "filling the frame":那是"把主体塞满画面"的意思,配上 headshot
   会让模型的头顶直接顶到画面上沿 —— 发型轮廓、头饰、帽子这些认人的线索
   第一个被切掉。改成"完整入画 + 头顶留白":要的是主体在框内,且框里有余量 */
export const CHARACTER_VIEWS: Array<{
  kind: CharacterViewKind
  label: string
  // 追加在角色设定之后的修饰词,写明取景与用途
  suffix: string
  framing: 'square' | 'portrait'
}> = [
  {
    kind: 'front',
    label: 'Front',
    suffix:
      'single front-facing headshot of one person, head and shoulders fully in frame with headroom above the head, neutral expression, plain background, centered',
    framing: 'square'
  },
  {
    /* 头部转面:左右正侧 + 上下 45° 俯仰,拼成一张 2×2。
       正脸只管正面那一张脸,"换个方向才看得见"的东西它一个都交代不了:
       正侧交代鼻梁高度、下颌线、耳朵位置与发型的侧面走向;
       俯视交代颅顶与发顶;仰视交代下颌底与鼻底。
       模型拿到这四格,画侧脸、抬头、低头时才不至于把人的脸重新编一个。

       俯仰指的是相机高度(高角度俯拍 / 低角度仰拍),不是让人自己抬低头 ——
       要的是"同一张脸换个方向看",不是四种表情。

       它排在正脸之后:原来这个位置是 3/4,而 3/4 只是"同一个方向的另一张头像",
       与这里第一格的正侧几乎重复;换成转面之后,五格里"脸"这条线才算走完。

       注意 kind 仍叫 detail 而不是 angles:它是索引里的键。
       改名会让库里已经存下的那些 detail 图对不上(见 App 的 loadCharViews
       会按已知 kind 过滤),图还在、但画面上会凭空少一格 */
    kind: 'detail',
    label: 'Angles',
    suffix:
      'a 2x2 turnaround grid of head angles of the same person, head and shoulders in every panel, identical framing, lighting and plain background: left side profile, right side profile, high angle from 45 degrees above eye level, low angle from 45 degrees below eye level, neutral expression',
    framing: 'square'
  },
  {
    kind: 'full',
    label: 'Full body',
    suffix:
      'single full-body shot of one person standing, the whole figure head to toe in frame with a small margin above the head and below the feet, plain background, centered',
    framing: 'portrait'
  },
  {
    /* 四格细部特写:眼睛、皮肤与脸部标记、手、面料与配件。
       这些是前面几张交代不了的 —— 头像里眼睛只占几十个像素,
       机械臂上的纹样、皮衣的缝线更是看不见。模型要画特写时(比如提示词里写
       "close-up of the hands"),没有这几格就只能凭空编,而编出来的
       多半和参考图里不是同一双手。

       四格必须点明"同一人、同一打光、同一背景",否则模型会画成四个不同的人;
       末尾压一句 no text, no labels —— 拼图里最容易被顺手加上的就是标注文字 */
    kind: 'closeups',
    label: 'Details',
    suffix:
      'a 2x2 grid of close-up detail shots of the same person under identical lighting on the same plain background, one detail per panel: the eyes, the skin and any face marks, the hands, the fabric and the accessories described above, no text, no labels',
    framing: 'square'
  },
  {
    kind: 'expression',
    label: 'Expressions',
    suffix: 'a 2x2 grid of different facial expressions, plain background',
    framing: 'square'
  }
]

/**
 * 用文本模型把一句话拆成角色的结构化设定。
 * 走 /api/enhance 那条路 —— 与提示词改写共用一套代理、鉴权与超时,只是档位不同。
 * 能拆多细取决于用户配的文本模型;返回的字段可能仍为空(模型没按格式回),
 * 那种情况由调用方决定怎么提示。
 *
 * 除结构化设定外还带一个名字:名字不进任何提示词(它是个标识,不是长相描述),
 * 但它是这张卡片的标题、也是"该叫什么"这件事的答案 —— 让模型顺手起一个,
 * 比让用户对着空输入框想一个更省事。起不来时调用方照旧可以手填
 */
export async function draftCharacterFields(
  cfg: ApiConfig,
  idea: string,
  signal?: AbortSignal
): Promise<CharacterDraft> {
  const resp = await fetch('/api/enhance', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal,
    body: JSON.stringify({
      prompt: idea,
      mode: 'character',
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
      if (body?.detail) msg = `${msg} — ${body.detail}`
    } catch {
      /* ignore */
    }
    throw new Error(msg)
  }
  const data = (await resp.json()) as { prompt?: string }
  return parseCharacterDraft(data.prompt || '')
}

/* 起稿模型常把"没有"写成 none / n/a 而不是留空,原样拼进提示词就是一段噪声。
   唯一的例外是 facialHair:那一项里"没有"是有意义的信息(无须),
   转成模型认得的 clean-shaven,其余一律清空 */
const NONE_ISH = /^(none|n\/?a|null|nothing|no|-|—|–)$/i

/**
 * 把模型回的那几行拆成「名字 + 结构化设定」。
 * 它偶尔会加粗、加项目符号、包代码围栏或写中文冒号,所以先剥掉这些装饰再按前缀认;
 * 认不出来的行直接丢掉,不报错 —— 少一两个字段不该让整次起稿失败。
 * 名字那行不一定有(老版本提示词没有它),缺了就是空串,由调用方决定怎么办。
 */
export function parseCharacterDraft(text: string): CharacterDraft {
  const fields = emptyCharFields()
  let name = ''
  /* 查表前把标签里的非字母全部去掉,所以 "Nose & mouth" / "Facial hair" /
     "Face marks" 这类多词标签怎么写都能对上 —— 起稿那条提示里用可读的两词
     标签,比为了迁就解析器写成 "NoseMouth" 好得多(人要能直接读懂回的是什么) */
  const keys: Record<string, keyof CharacterFields> = {
    gender: 'gender',
    identity: 'identity',
    face: 'face',
    hair: 'hair',
    brows: 'brows',
    eyes: 'eyes',
    nosemouth: 'noseMouth',
    facialhair: 'facialHair',
    facemarks: 'faceMarks',
    outfit: 'outfit',
    marks: 'marks'
  }
  for (const raw of text.split('\n')) {
    const line = raw
      // 加粗/斜体/行内代码,以及行首的项目符号与引号
      .replace(/[*`_"']/g, '')
      .replace(/^[\s>•·\-–—]+/, '')
      .trim()
    // 标签段允许空格与 & —— 不允许的话 "Nose & mouth:" 会因为 & 挡住冒号而整行作废
    const m = /^([A-Za-z][A-Za-z &]*?)\s*[:：]\s*(.+)$/.exec(line)
    if (!m) continue
    const label = m[1].toLowerCase().replace(/[^a-z]/g, '')
    const value = m[2].trim()
    if (label === 'name') {
      name = NONE_ISH.test(value) ? '' : value
      continue
    }
    const key = keys[label]
    if (!key) continue
    fields[key] = NONE_ISH.test(value) ? (key === 'facialHair' ? 'clean-shaven' : '') : value
  }
  return { name, fields }
}

/** 读出角色列表,并把参考图从 IndexedDB 贴回条目上 */
export async function loadCharacters(): Promise<Character[]> {
  let list: Character[] = []
  try {
    const raw = localStorage.getItem(CHAR_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    // 与作品集同理:本地数据也可能被写坏,不滤一遍会让角色区整块崩掉
    if (!Array.isArray(parsed)) return []
    list = parsed.filter(
      (c): c is Character => !!c && typeof c === 'object' && typeof (c as Character).name === 'string'
    )
  } catch {
    return []
  }
  const refs = await getAllCharRefs()
  for (const c of list) {
    /* 老角色的 fields 里没有后来加的字段(face / brows / noseMouth ...)。
       在入口补齐空串,后面所有读的地方就能当它们一定存在 —— 不补的话
       CharacterFields 这个类型就是在骗人,每读一处都得再防一次 undefined */
    if (c.fields) c.fields = { ...emptyCharFields(), ...c.fields }
    const ref = refs.get(c.id)
    if (ref) c.ref = ref
    // 底图另有 key,不是设定图之一(见 idb.ts 的 charSourceKey)
    const source = refs.get(charSourceKey(c.id))
    if (source) c.sourceRef = source
  }
  return list
}

/** 整份覆盖写回:目录小而全量重写最省心;参考图那边只补新增、删掉已经不在目录里的 */
export async function saveCharacters(list: Character[]): Promise<void> {
  try {
    /* Blob 进不了 JSON(会变成 {}),序列化前必须把两张图从条目上摘掉。
       底图也要摘 —— 漏掉它整条角色都写不进 localStorage,而且是不声不响地失败 */
    localStorage.setItem(
      CHAR_KEY,
      JSON.stringify(list.map(({ ref: _ref, sourceRef: _source, ...rest }) => rest))
    )
  } catch {
    /* ignore: 写不下就不写,下次改动再试 */
  }
  const refs: CharRefRecord[] = []
  for (const c of list) {
    if (c.ref instanceof Blob) refs.push({ id: c.id, data: c.ref })
    if (c.sourceRef instanceof Blob) refs.push({ id: charSourceKey(c.id), data: c.sourceRef })
  }
  await putCharRefs(refs)
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

