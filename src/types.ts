// 用户自定义的接口配置,持久化到 localStorage
export interface ApiConfig {
  baseUrl: string // 例如 https://ark.cn-beijing.volces.com/api/v3
  apiKey: string
  model: string
}

// 生成参数
export interface GenParams {
  prompt: string
  size: string
  n: number
  // 图生图:参考图(data URL / base64),可选
  image?: string
}

// 提示词库收藏项
export interface PromptItem {
  id: string
  title: string // 用户命名
  prompt: string
  category: string // 分类/标签
  size?: string
  createdAt: number
}

// 参数预设:打包可复用配方
export interface Preset {
  id: string
  name: string
  size: string
  n: number
}

// 一条生成记录
export interface HistoryEntry {
  id: string
  prompt: string
  size: string
  model?: string
  createdAt: number
  // 上游可能返回一张或多张图,存 base64 或 url
  results: Array<{ type: 'b64' | 'url'; data: string }>
}

// 通用 OpenAI /images/generations 响应格式
export interface ImagesResponse {
  created?: number
  data: Array<{ url?: string; b64_json?: string; revised_prompt?: string }>
}