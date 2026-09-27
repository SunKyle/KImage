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
  // 这条配置的用途:'image' 出图,'text' 改写提示词。
  // 两类要填的模型不是一回事,但地址与密钥常常同源,所以放同一个列表里按用途分区。
  // 可选是为了兼容加这个字段之前存下来的配置,读的时候一律按 'image' 处理
  kind?: 'image' | 'text'
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
  /* 随机种子。留空表示交给上游随机 —— 我们不存"上游实际用的那个数":
     响应里从来没有这个字段,谁也拿不回来。所以它只在用户自己填了之后
     才有意义:同样的 seed + 同样的参数,才有机会拿到同一张图
     (部分接口根本不认这个参数,见厂商能力表的 seed) */
  seed?: number
}

// 提示词库收藏项
export interface PromptItem {
  id: string
  prompt: string
  /* 标签。一条提示词可以挂多个 —— 原先只有一个 category 字符串,
     加这个字段时把它并了进来(见 api.ts 的 normalizePrompt) */
  tags?: string[]
  // 自定义标题。空着就按提示词开头派生一个(见 lib/text.ts)
  title?: string
  // 存进库时用的是哪个模型。手动新建的没有
  model?: string
  /* 取用次数。它回答的是"我到底在用哪些提示词",不是社交意义上的热度 ——
     数据全在本机,也没有别人可以比较 */
  uses?: number
  // 收藏时一并记下这几个参数,从库里取用时才能完整复现,而不是只填回提示词
  size?: string
  quality?: string
  background?: string
  /* 卡片封面。存的是原图,不是缩略图 —— 它同时铺在库页卡片和详情左栏上,
     320px 的缩略图在那个尺寸下一眼就糊。存在 IndexedDB 里(浏览器级配额),
     所以不必再为几 KB 牺牲清晰度。用 Blob 而不是 data URL:base64 会膨胀 33%,
     而且整段进 JS 堆。仅当长边超过 1600 时才等比缩一次(见 App.vue 的 coverOf) */
  cover?: Blob
  // 旧字段:封面曾经是 data URL 字符串(还是压到 320px 的缩略图)。读入时并进 cover
  thumb?: string
  createdAt: number
  // 旧字段:加 tags 之前只有一个分类字符串。读入时并进 tags,不再写回
  category?: string
}

// 预览里「收藏到提示词库」时一起交出来的内容:
// 提示词 + 当时真正发出去的参数 + 出这张图的原始载荷(用来生成封面)
export interface FavoritePayload {
  prompt: string
  // 出这张图用的模型。库里存下来,以后翻卡才看得出"这张是谁出的"
  model?: string
  size: string
  quality?: string
  background?: string
  /* 出这张图的原始载荷。封面要的是原图,而预览那边拿得出手的只有渲染地址 ——
     交出载荷让主界面自己决定怎么取回字节(新记录是 Blob,老记录是 data URL) */
  image?: ResultItem
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
  /* 当时用的那条接口配置的 id。有了它,"沿用这条记录的配方"才能连配置一起还原 ——
     否则改一个变量重跑时,用的其实是当前生效的那个模型,对比就失真了。
     可选:老记录没有,配置被删后也对不上,两种情况都退回当前配置 */
  configId?: string
  // 当时指定的随机种子(没填就没有这个字段)。上游不告诉我们它实际用了哪个数
  seed?: number
  /* 参考图的存档副本(压到最长边 512)。配方要能完整复现,就得连参考图一起留下 ——
     hasRef 只能说明"用过参考图",给不出是哪张。可选:老记录与纯文生图都没有 */
  ref?: Blob
  /* 对比出图(Model Race)的分组 id:同一次对比里各模型的结果共用一个值。
     派生关系(版本树)也将挂在同一个字段上,所以它是"这一批从哪来"的标识,
     不限于对比。可选:普通生成与加这个字段之前的记录都没有 */
  groupId?: string
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
  /* 以下三项是"完整配方"的其余部分:有了它们,从历史重跑才真的等于当时那一次,
     而不是"提示词一样、其他都不一样"。缺任何一项都按当前界面上的值处理 */
  configId?: string
  seed?: number
  // 参考图(data URL)。记录里存的是 Blob,取用时才转成 data URL
  ref?: string
}