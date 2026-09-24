// 用户自定义的接口配置,持久化到 localStorage(列表,可多份)
export interface ApiConfig {
  id: string
  name: string
  baseUrl: string // 例如 https://ark.cn-beijing.volces.com/api/v3
  apiKey: string
  model: string
  // 厂商 id(见 api.ts 的 PROVIDERS);决定支持哪些扩展参数、尺寸与图生图端点
  // 可选是为了兼容加这个字段之前存下来的配置,读的时候会按域名回填
  vendor?: string
}

// 生成参数
export interface GenParams {
  prompt: string
  size: string
  n: number
  // 图生图:参考图(data URL / base64),可选
  image?: string
  // 画质档位:auto / low / medium / high(部分接口不支持)
  quality?: string
  // 背景:auto / transparent / opaque(部分接口不支持)
  background?: string
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

// 一条图片结果。
// 新记录存 Blob:浏览器把它放在 JS 堆外,渲染时才按需读,避免整段 base64 常驻内存;
// 加这个改动之前存下来的记录是 data URL 字符串,读取时要能同时认这两种。
export type ResultItem = { type: 'b64' | 'url'; data: string | Blob }

// 一条生成记录
export interface HistoryEntry {
  id: string
  prompt: string
  size: string
  model?: string
  // 真正发出去的扩展参数(默认档不记,老记录也没有这些字段)
  quality?: string
  background?: string
  // 是否用了参考图(图生图)
  hasRef?: boolean
  // 这一批从发起到返回的耗时(毫秒)
  elapsedMs?: number
  createdAt: number
  // 上游可能返回一张或多张图
  results: ResultItem[]
}

// 「使用提示词」时带回的一组参数,用于一键复现当时的出图条件
// 全部可选:套用前要按当前厂商的能力逐项校验
export interface ReuseParams {
  prompt: string
  size?: string
  n?: number
  quality?: string
  background?: string
}

// 通用 OpenAI /images/generations 响应格式
export interface ImagesResponse {
  created?: number
  data: Array<{ url?: string; b64_json?: string; revised_prompt?: string }>
}