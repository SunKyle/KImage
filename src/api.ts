import type { ApiConfig, GenParams, ImagesResponse, PromptItem, Preset } from './types'
import { getAll, putAll, putOne, deleteOne, urlToDataURL, detectMimeFromDataUrl } from './lib/idb'

const CONFIG_KEY = 'kimage.apiConfig'

export function loadConfig(): ApiConfig {
  try {
    const raw = localStorage.getItem(CONFIG_KEY)
    if (raw) return JSON.parse(raw)
  } catch {
    /* ignore */
  }
  return { baseUrl: '', apiKey: '', model: '' }
}

export function saveConfig(cfg: ApiConfig) {
  localStorage.setItem(CONFIG_KEY, JSON.stringify(cfg))
}

/**
 * 调用后端代理生图。
 * 返回标准化后的 [{ type, data }] 列表。
 */
export async function generate(
  params: GenParams,
  config: ApiConfig
): Promise<Array<{ type: 'b64' | 'url'; data: string }>> {
  const resp = await fetch('/api/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...params,
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      model: config.model || undefined
    })
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

  // 把结果标准化;URL 形式尽量转成本地 base64,避免历史预览因外链过期失效
  // b64 内容按真实格式(JPEG/PNG/…)包装成 Data URL,避免硬编码 png 导致裂图
  return await Promise.all(
    data.data.map(async (item) => {
      if (item.b64_json) {
        const mime = detectMimeFromDataUrl(item.b64_json)
        return { type: 'b64', data: `data:${mime};base64,${item.b64_json}` }
      }
      if (item.url) {
        try {
          const local = await urlToDataURL(item.url)
          return { type: 'b64', data: local }
        } catch {
          return { type: 'url', data: item.url }
        }
      }
      return { type: 'url', data: '' }
    })
  )
}

/* ===== 历史记录(IndexedDB,容量不受限、真正持久) ===== */
export async function loadHistory() {
  try {
    const list = await getAll<any>()
    return list.sort((a, b) => b.createdAt - a.createdAt)
  } catch {
    return []
  }
}
export async function addHistoryRecord(record: any) {
  await putOne(record)
  const all = await loadHistory()
  await putAll(all, 50)
}
export async function removeHistoryRecord(id: string) {
  await deleteOne(id)
  const all = await loadHistory()
  await putAll(all, 50)
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
export function savePrompts(list: PromptItem[]) {
  localStorage.setItem(LIB_KEY, JSON.stringify(list))
}

/* ===== 参数预设 ===== */
const PRESET_KEY = 'kimage.presets'
export const DEFAULT_PRESETS: Preset[] = [
  { id: 'p-square', name: '方图', size: '1024x1024', n: 1 },
  { id: 'p-portrait', name: '竖幅', size: '1024x1792', n: 1 },
  { id: 'p-landscape', name: '横版', size: '1792x1024', n: 1 },
  { id: 'p-wide', name: '超宽屏', size: '2560x1440', n: 1 }
]
export function loadPresets(): Preset[] {
  try {
    const raw = localStorage.getItem(PRESET_KEY)
    if (raw) return JSON.parse(raw) as Preset[]
    return DEFAULT_PRESETS
  } catch {
    return DEFAULT_PRESETS
  }
}
export function savePresets(list: Preset[]) {
  localStorage.setItem(PRESET_KEY, JSON.stringify(list))
}

/* ===== 风格快捷词 ===== */
export const STYLE_WORDS = [
  { label: '电影感', word: 'cinematic, film grain, anamorphic' },
  { label: '写实', word: 'photorealistic, natural lighting, high detail' },
  { label: '插画', word: 'illustration, hand-drawn, storybook style' },
  { label: '赛博朋克', word: 'cyberpunk, neon, futuristic cityscape' },
  { label: '极简', word: 'minimalist, clean composition, negative space' },
  { label: '梦幻', word: 'ethereal, dreamy, soft glowing light' }
]