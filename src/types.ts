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
  prompt: string
  category: string // 分类/标签
  // 收藏时一并记下这几个参数,从库里取用时才能完整复现,而不是只填回提示词
  size?: string
  quality?: string
  background?: string
  // 列表里做视觉锚点的小缩略图(data URL)。
  // 库存在 localStorage(配额约 5MB),所以压得很紧:160px / webp 0.6,通常 5~9KB
  thumb?: string
  createdAt: number
}

// 预览里「收藏到提示词库」时一起交出来的内容:
// 提示词 + 当时真正发出去的参数 + 当前这张图的渲染地址(用来生成封面缩略图)
export interface FavoritePayload {
  prompt: string
  size: string
  quality?: string
  background?: string
  src: string
}

// 一条图片结果。
// 新记录存 Blob:浏览器把它放在 JS 堆外,渲染时才按需读,避免整段 base64 常驻内存;
// 加这个改动之前存下来的记录是 data URL 字符串,读取时要能同时认这两种。
// marked 是「标记这张图」的标记:历史图墙是按张摊平的,所以标在图上而不是整条记录上。
// 叫标记而不是收藏,是为了跟「收藏到提示词库」区分开 —— 那个存的是提示词,进的是提示词库。
// 可选是为了兼容加这个字段之前存下来的记录。
export type ResultItem = { type: 'b64' | 'url'; data: string | Blob; marked?: boolean }

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
  // 列表用的小缩略图。抽屉里只显示 48px,但浏览器是按原始分辨率解码的,
  // 几十条一起挂载时会连续做几十次全尺寸解码,主线程被压住。
  // 可选:老记录没有这个字段,列表退回渲染原图
  thumb?: Blob
  // 图片真实像素尺寸。上游可能返回与所选 size 不同比例的图,
  // 图墙缩略块要按真实比例显示,所以在入库量缩略图时一并记下来。
  // 可选:老记录没有这两个字段,回退到解析 size
  w?: number
  h?: number
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