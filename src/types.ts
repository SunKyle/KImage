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
  /* 图生图:参考图(data URL / base64),可选。
     可以有多个 —— 角色的设定图就是"几张视图一起当参考",比单张锁得住脸。
     上游收不收多张由它定,收不了会把错误透回来 */
  images?: string[]
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
  /* 「拉自某条记录改一个变量重跑」时的出处:被复现的那条记录的 id。
      只有走 Reuse(预览卡 / 历史页的 use)才记,用户手动敲新提示词没有。
      一条链,不是树:父可以没有,也不能有多个。可选:老记录与普通手写生成都没有 */
  parentId?: string
  /* 归属的作品集 id(见 Collection)。把一组生成归拢时挂到某个作品集下,
     挂了的记录不会被存储清理自动淘汰。可选:老记录与未归类的都没有 */
  collectionId?: string
  /* 这次生成套用的角色预设 id(见 Character)。与 collectionId 同理,
     只在这条记录确实用了角色时才有;取消角色或手动换参考图都不会留下它 */
  characterId?: string
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

// 一个作品集(Collection):把若干条生成记录归拢成一组作品。
// 目录只存标题与 id —— 轻量,几百字节,放 localStorage 正合适;
// 归属关系(哪条记录属于哪个作品集)挂在记录自己的 collectionId 上,和记录同在 IndexedDB
export interface Collection {
  id: string
  // 作品集的标题(如"人物练习"/"参赛稿")。空内容允许为空串,但创建时尽量给一个
  title: string
  createdAt: number
}

// 角色的结构化设定。生成时按固定顺序拼成一段描述,前置到提示词最前面。
// 拆成字段而不是一整段自由文本,是为了让「AI 创建」能逐项填、用户也能逐项校对
export interface CharacterFields {
  // 身份 / 职业 / 风格,如 "cyberpunk female warrior"
  identity: string
  hair: string
  eyes: string
  outfit: string
  marks: string
}

/* 设定图里的一张视图。detail 是"细节图":服装、配件、身上特征的特写 ——
   全身图里这些只有几个像素,模型抓不住,单独来一张特写才说得清 */
export type CharacterViewKind = 'front' | 'threeQuarter' | 'full' | 'expression' | 'detail'

export interface CharacterView {
  kind: CharacterViewKind
  data: Blob
}

// 一个角色:可复用的出图预设 —— 一张主参考图 + 一段固定设定 + 名字。
// 参考图管"形状"、设定管"语义",两者一起注入才谈得上跨图的一致性。
// 名字与设定是轻量目录,放 localStorage;图是 Blob,按 id 存在 IndexedDB
export interface Character {
  id: string
  name: string
  createdAt: number
  /* 结构化设定。可选是为了兼容加它之前存下来的角色 —— 那些只有 desc */
  fields?: CharacterFields
  /* 自由描述。加结构化字段之前,角色的全部设定就写在这里;
     读入时原样保留,合成时排在结构化设定之后当补充 —— 老角色不该因为改了模型就变样 */
  desc?: string
  /* 主参考图。生成时送上上游的就是它 —— 单图,受现有接口限制。
     默认取设定图里的正脸,用户也可以改指另一张 */
  ref?: Blob
  /* 主参考图取自哪张视图。存它是因为刷新后 ref 与视图是两次独立的 IDB 读取,
     Blob 不是同一个实例,靠身份比较认不出"这张正在用";从外部上传的图没有这个值 */
  refKind?: CharacterViewKind
  /* 设定图里正脸以外的视图(3/4、全身、表情、动作)。
     只用于查看与挑选主图、不参与生成,所以不在启动时加载 */
  views?: CharacterView[]
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
  /* 「拉自某条记录」时的出处记录 id。带上来,主界面才知道这次生成
     把谁当父记录(parentId)。可选:手动手写提示词开始的生成没有 */
  fromEntryId?: string
}