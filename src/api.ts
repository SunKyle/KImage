import type { ApiConfig, GenParams, HistoryEntry, ImagesResponse, PromptItem, ResultItem, ReuseParams } from './types'
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

export function uid(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36)
}

/* ===== 厂商能力表 =====================================================
   各家的扩展参数、尺寸取值、图生图端点都不一样,集中在这里声明,
   界面按它决定显示什么、代理按它决定打哪个端点。
   要支持新厂商,或某家改了规则,只改这一处。
   -------------------------------------------------------------------- */
export type Cap = 'yes' | 'no' | 'unknown'

export interface Provider {
  id: string
  label: string
  baseUrl: string
  model: string
  quality: Cap
  background: Cap
  /** 允许的尺寸;'free' 表示由接口自行决定 */
  sizes: string[] | 'free'
  /** 图生图打哪个端点 */
  edit: 'generations' | 'edits'
}

// 兜底项:baseUrl 认不出来时的归宿
const CUSTOM: Provider = {
  id: 'custom',
  label: '自定义 / 兼容接口',
  baseUrl: '',
  model: '',
  // 未知厂商一律按"不确定"处理:照常展示参数,但不静默丢弃
  quality: 'unknown',
  background: 'unknown',
  sizes: 'free',
  edit: 'generations'
}

export const PROVIDERS: Provider[] = [
  {
    id: 'openai',
    label: 'OpenAI(海外)',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-image-1',
    quality: 'yes',
    background: 'yes',
    sizes: ['auto', '1024x1024', '1536x1024', '1024x1536'],
    edit: 'edits'
  },
  {
    id: 'ark',
    label: '豆包 Seedream(火山方舟)',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    model: 'doubao-seedream-3-0-t2i',
    quality: 'no',
    background: 'no',
    sizes: 'free',
    edit: 'generations'
  },
  {
    id: 'dashscope',
    label: '通义万相(百炼)',
    baseUrl: 'https://dashscope.aliyuncs.com/api/v1',
    model: 'wanx2.1-t2i-turbo',
    quality: 'no',
    background: 'no',
    sizes: 'free',
    edit: 'generations'
  },
  CUSTOM
]

export function getProvider(id: string | undefined): Provider {
  return PROVIDERS.find((p) => p.id === id) || CUSTOM
}

/** 老配置没有 vendor 字段时按域名猜,省得用户重配一遍 */
export function inferVendor(baseUrl: string): string {
  const h = (baseUrl || '').toLowerCase()
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

/* ===== 扩展参数的取值与界面文案 =====================================
   放在这里是为了让主界面和历史预览共用同一份文案,避免两处各写一套
   后出现「面板显示低、预览显示 low」这类不一致。
   hint 是界面上给档位的代价注解。
   ------------------------------------------------------------------ */
export const QUALITY_OPTIONS = [
  { value: 'auto', label: '自动', hint: '由上游决定' },
  { value: 'low', label: '低', hint: '更快更省' },
  { value: 'medium', label: '中', hint: '均衡' },
  { value: 'high', label: '高', hint: '更细更慢' }
]
export const BACKGROUND_OPTIONS = [
  { value: 'auto', label: '自动' },
  { value: 'transparent', label: '透明' },
  { value: 'opaque', label: '不透明' }
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
      if (Array.isArray(arr)) return (arr as ApiConfig[]).map(withVendor)
    }
  } catch {
    /* ignore */
  }
  // 兼容旧的单份配置格式
  try {
    const raw = localStorage.getItem('kimage.apiConfig')
    if (raw) {
      const c = JSON.parse(raw)
      const list: ApiConfig[] = [withVendor({ id: uid(), name: '默认配置', ...c })]
      saveConfigs(list)
      return list
    }
  } catch {
    /* ignore */
  }
  return []
}

// 补齐 vendor(加这个字段之前存下来的配置没有它)
function withVendor(c: ApiConfig): ApiConfig {
  return c.vendor ? c : { ...c, vendor: inferVendor(c.baseUrl) }
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
      // 厂商决定代理打哪个端点(OpenAI 图生图走 /images/edits,其余走 /generations)
      vendor: config.vendor || inferVendor(config.baseUrl)
    }),
    signal
  })

  if (!resp.ok) {
    let msg = `请求失败 (${resp.status})`
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

  const data = (await resp.json()) as ImagesResponse
  if (!data.data || data.data.length === 0) {
    throw new Error('上游未返回任何图片')
  }

  // 结果统一落成 Blob:base64 会膨胀 33% 且整段进 JS 堆,Blob 由浏览器放在堆外。
  // b64 按真实格式(JPEG/PNG/…)标注 MIME,避免硬编码 png 导致裂图。
  return await Promise.all(
    data.data.map(async (item): Promise<ResultItem> => {
      if (item.b64_json) {
        const mime = detectMimeFromDataUrl(item.b64_json)
        return { type: 'b64', data: base64ToBlob(item.b64_json, mime) }
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

/* ===== 图片载荷 → 可渲染的 src =====================================
   新记录是 Blob,渲染时现造 object URL;旧记录是 data URL 字符串,原样返回。
   object URL 用 WeakMap 缓存且不回收:同一个 Blob 会被图墙、抽屉、预览同时取用,
   谁先卸载就 revoke 会把其它处弄裂;而 Blob 本身已被 history 持有,
   多留一个 URL 字符串不构成额外泄漏。
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

/* ===== 列表缩略图 ===================================================
   抽屉列表把图缩到 48px 显示,但浏览器仍按原始分辨率解码:几十条一起
   挂载就是几十次全尺寸解码,而打开抽屉的同时还有弹簧动画和抽屉滑入在
   跑,主线程被压满,表现就是「只有 home → 历史 会卡」。
   入库时顺手做一张小图,列表只渲染它。老记录没有 thumb,退回原图。
   ------------------------------------------------------------------ */
const THUMB_EDGE = 128

export async function makeThumb(item: ResultItem | undefined): Promise<Blob | undefined> {
  if (!item) return undefined
  try {
    const src = imageSrc(item)
    if (!src) return undefined
    const bmp = await createImageBitmap(await (await fetch(src)).blob())
    const scale = Math.min(1, THUMB_EDGE / Math.max(bmp.width, bmp.height))
    if (scale >= 1) {
      // 本来就比缩略图还小,不值得多存一份
      bmp.close()
      return undefined
    }
    const c = document.createElement('canvas')
    c.width = Math.max(1, Math.round(bmp.width * scale))
    c.height = Math.max(1, Math.round(bmp.height * scale))
    const ctx = c.getContext('2d')
    if (!ctx) {
      bmp.close()
      return undefined
    }
    ctx.drawImage(bmp, 0, 0, c.width, c.height)
    bmp.close()
    // webp 编码在个别环境下不可用,退回 png(透明图不能走 jpeg,会糊成黑底)
    return (
      (await new Promise<Blob | null>((r) => c.toBlob(r, 'image/webp', 0.8))) ??
      (await new Promise<Blob | null>((r) => c.toBlob(r, 'image/png'))) ??
      undefined
    )
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
 * 给加这个字段之前存下来的老记录补缩略图。
 * 每张之间留一段间隔,免得一上来就把主线程占满;补完落盘,只跑一次。
 * 任何一张失败都跳过,不影响使用。
 */
export async function backfillThumbs(list: HistoryEntry[]): Promise<void> {
  for (const entry of list) {
    if (entry.thumb) continue
    const t = await makeThumb(entry.results?.[0])
    if (!t) continue
    entry.thumb = t
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
    const list = await getAll<any>()
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

/* ===== 提示词库(收藏) ===== */
const LIB_KEY = 'kimage.prompts'
export function loadPrompts(): PromptItem[] {
  try {
    const raw = localStorage.getItem(LIB_KEY)
    if (raw) return JSON.parse(raw) as PromptItem[]
    return []
  } catch {
    return []
  }
}
export function savePrompts(list: PromptItem[]): boolean {
  try {
    localStorage.setItem(LIB_KEY, JSON.stringify(list))
    return true
  } catch {
    // 配额不够时退化成不带缩略图的版本:提示词本身比封面重要得多,
    // 宁可丢封面,也不能让整次保存失败(那样用户会以为存进去了)
    try {
      localStorage.setItem(LIB_KEY, JSON.stringify(list.map((p) => ({ ...p, thumb: undefined }))))
      return false
    } catch {
      return false
    }
  }
}

