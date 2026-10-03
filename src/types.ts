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
  /* 这条配置的用途:'image' 出图,'text' 改写提示词,'vision' 识图
     (把上传的参考图读成角色设定 —— 与改写一样走对话模型,但要求它会看图),
     'tts' 朗读(把角色说的话合成成音频)。
     四类要填的模型不是一回事,但地址与密钥常常同源,所以放同一个列表里按用途分区。
     可选是为了兼容加这个字段之前存下来的配置,读的时候一律按 'image' 处理 */
  kind?: 'image' | 'text' | 'vision' | 'tts'
  /* 服务级资源标识。目前只有 TTS 用得上:火山引擎拿它选模型版本、
     而它同时决定计费商品(seed-tts-2.0 是自带音色 / seed-icl-2.0 是复刻音色),
     所以填错不是"效果差一点",而是直接被拒(access denied)。
     放在配置上而不是角色上:它是"你开通了哪个商品",属于账号,不属于某个角色 */
  resourceId?: string
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

/* ===== 画布里的局部编辑 ==============================================
   AI 编辑与几何变换不是一回事:它要调接口、要等几秒、会失败。
   但"去背景 / 消除 / 局部重绘"三者要的输入是同一套 ——
   原图、要动的那块区域、以及怎么动(可空)。差别只在哪一项为空:
   去背景是整幅区域、无指令;消除是涂抹区域、无指令;重绘是涂抹区域 + 指令。
   所以参数收成一个对象,而不是给三个功能各开一条接口。
   -------------------------------------------------------------------- */

/** 这次编辑要让上游做什么。四个模式的处理逻辑在服务端,
 *  前端只负责如实上报"这是哪一类",由它按模式挑对应的提示词。
 *
 *  前三者的差别在 mask 与指令;replace-bg 与 remove-bg 用的是同一种 mask
 *  (整幅),只差指令 —— 但分成两个模式是因为"把背景换成什么"要用户给话,
 *  而 remove-bg 不需要,两者的校验规则不一样 */
export type EditMode = 'remove-bg' | 'erase' | 'regen' | 'replace-bg'

export interface EditParams {
  /** 原图。data URL —— 与图生图那条路一致,服务端按同一套解析 */
  image: string
  /** 要重做的区域。按 OpenAI 定下的规矩:透明像素才是要动的部分,
   *  不透明处原样保留 —— 所以去背景是整张透明(它没有"要保留"的部分),
   *  套索是"不透明黑底上挖出选区的形状"。
   *  data URL(PNG),尺寸必须与 image 一致,否则上游会当成参数错误 */
  mask: string
  /** 怎么改这一块。只有局部重绘有;去背景与消除都留空 */
  prompt?: string
  mode: EditMode
  /** 期望的输出画幅,`WxH`。编辑不该改变画幅 ——
   *  不讲这一条的话上游按自己的默认来,而那个默认通常是 1:1,
   *  于是改完一张 3:2 的图会变成方的。
   *  发出去之前会收窄成目标厂商真认的取值(见 api.ts 的 allowedSizeFor) */
  size?: string
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

/* 角色的结构化设定。生成时按固定顺序拼成一段描述,前置到提示词最前面。
   拆成字段而不是一整段自由文本,是为了让「AI 创建」能逐项填、用户也能逐项校对。

   前九项是"面貌特征",会跟着每一张成品走(见 api.ts 的 characterFaceDesc)——
   它们回答的是"这个人长什么样",跨场景不该变。后两项只喂给设定图:
   衣服与装备属于"这一张发生什么",该由场景决定 */
export interface CharacterFields {
  /* 性别。"female" / "male"。
     排在第一位而不是塞进 identity:它是这张脸最基础的一条条件 ——
     不写死的话,同一个角色换个场景就会被重新决定一次性别,
     而 identity 那句话里有没有带性别词、带对了没有,都不可靠 */
  gender: string
  // 身份 / 职业 / 风格,如 "veteran space smuggler, worn flight jacket"
  identity: string
  // 脸型与骨相、肤色、看起来的年龄
  face: string
  hair: string
  // 眉形、粗细、眉色
  brows: string
  eyes: string
  // 鼻梁鼻头、唇形厚薄
  noseMouth: string
  // 胡须 / 胡茬 / 无须。必须有个明确值,否则每张图横跳
  facialHair: string
  /* 面部疤痕、痣、胎记、面纹、面部义体。
     这一项只在设定里明说时才该有值 —— 默认长出来等于给每个角色都添一道疤 */
  faceMarks: string
  outfit: string
  marks: string
}

/* 角色的"人格":只有聊天用得上的一组设定。
   刻意与 CharacterFields 分开存 —— 那边是长相,会被 characterFaceDesc 拼进
   每一张出图的提示词;把性格混进去,等于让"它是什么人"去污染"它长什么样"
   的像素级约束。

   四个字段而不是一整段自由文本:traits 与 voice 必须分开 ——
   "是个什么样的人"和"话怎么说出来"是两件事,写在同一段里会被模型平均掉,
   结果是性格写了、说话方式被稀释成通用口吻。而"像人"主要靠后者 */
export interface CharacterPersona {
  // 性格:是个什么样的人。如 "guarded, dry humor, slow to trust"
  traits: string
  // 说话方式:怎么说话。如 "short clipped sentences, rarely asks questions"
  voice: string
  // 怎么称呼用户,以及它和用户是什么关系。如 "calls you 'kid', an old partner"
  address: string
  // 禁区:这个角色绝不会做的事。如 "never breaks character, never mentions AI"
  boundaries: string
}

/* 一条对话消息。存在 IndexedDB,按 charId 索引 ——
   一期一个角色一条连续对话,所以没有 sessionId;将来要开多段会话时再加这个字段 */
export interface ChatMessage {
  id: string
  /* 属于哪个角色。与 HistoryEntry.characterId 同一个口径:
     角色被删时它的消息一并清掉(见 App 的 deleteChar) */
  charId: string
  role: 'user' | 'assistant'
  content: string
  createdAt: number
  /* 用户中途按了 Stop,这条只说到一半。与"上游报错"分开记 ——
     截断是我们自己按的,不是坏数据,拼上下文时它照样是一条正常的历史消息 */
  stopped?: boolean
  /* 上游因为撞上 max_tokens 而停下(它给的 finish_reason 是 'length')。
     与 stopped 分开:那个是人按的,这个是模型的额度用完了。
     不记这一项的话,前端看到的和"正常说完"一模一样 ——
     用户会以为角色话说一半是它自己的风格 */
  truncated?: boolean
  /* 这一轮的情绪,一个英文小写词(见服务的 CHAT_MOOD_RE)。
     它是模型写在回复最末尾的元数据,由服务端剪下来单独送 ——
     正文里永远不含它,所以这不是"从文本里解析出来的",是原样收到的。
     只对助手消息有意义;空/缺省 = 这一轮没给 */
  mood?: string
  /* 用户这条消息附的图。存的是 IndexedDB 里的 id,**不是字节** ——
     消息是一条几十字节的记录(一次要读一整屏),图为几百 KB,
     两者的读法完全不同,所以分开存(见 idb.ts 的 chat_images)。
     只有用户消息会带它 */
  imageId?: string
}

/** 聊天里用户附的那张图。与 ChatMessage 分开存,理由见上面的 imageId */
export interface ChatImage {
  id: string
  blob: Blob
  createdAt: number
}

/* 一段对话的长期记忆:滑出窗口的那些消息被压成的一段简报。
   与消息分开存,因为读法完全不同 —— 消息按条读,这份一次读一条。

   为什么记三个字段而不是一句文本:
   - upToAt/upToId 回答"从哪一条之后还没进摘要",下一批从这儿往后接;
   - covered 是"已经进去多少条",配上总条数才知道该不该再压一次 ——
     有了它就不必为了判断这件事再把消息读一遍。
   三者缺一个,都会退化成"每次都要全量读一遍才知道该不该压" */
export interface ChatSummary {
  charId: string
  /** 简报正文。空串 = 还没压过 */
  text: string
  /** 覆盖到最后哪一条(含) */
  upToId: string
  /** upToId 那条的时间戳。游标按时间走,只有 id 是找不到它的 */
  upToAt: number
  /** 已经被摘要覆盖的条数 */
  covered: number
  /** 最后一次压缩的时间。界面拿它显示"记忆更新于…" */
  updatedAt: number
}

/* 一次 AI 起稿的结果:名字 + 结构化设定 + 人格。
   名字不是 CharacterFields 的一员 —— 它是个标识(卡片的标题、消息里的称呼),
   不参与任何提示词的拼装,所以和"这个人长什么样"那套字段分开。
   人格同样分开存:它只服务对话,不进任何出图的提示词(见 CharacterPersona) */
export interface CharacterDraft {
  name: string
  fields: CharacterFields
  persona: CharacterPersona
}

/* 设定图里的一张视图。kind 是索引里的键(存进 IndexedDB 时按它定位),
   所以改语义可以改 label 与提示词,但别改这个字符串 —— 改了库里已存的图会对不上。

   两个相邻的名字不是笔误:detail 是头部转面那张 2×2(标签 Angles),
   closeups 是细部特写那张 2×2(标签 Details)。前者是历史键名,留它是为了
   库里已经生成好的 Angles 图还能对上;新加的就照内容老实叫 closeups */
export type CharacterViewKind = 'front' | 'detail' | 'full' | 'closeups' | 'expression'

export interface CharacterView {
  kind: CharacterViewKind
  data: Blob
}

/* 一个角色的**嗓音**:朗读时它听起来是什么样的。
   与 CharacterPersona 是两件事,别混 —— persona 里那个 voice 字段管的是
   "话怎么说出来"(短句、少提问),是**文字**;这一份管的是"声音本身"。
   所以 persona 那边的标签已经从 Voice 改成 Speech style,把这个词让了出来。

   为什么挂在角色上而不是全局:嗓音与"说话方式"一样属于这个人,不属于这台机器。

   三档来源只在"voice 从哪来"上不同,合成请求的形状是一样的:
   - preset   用厂商自带的一款音色(一个音色名)
   - describe 写一段话描述,交给认 instructions / text_prompt 的上游现场塑造
   - clone    传一段音频样本,上游建号时返回一个音色 id */
export interface CharacterVoice {
  /* 走哪条路。缺省 = browser,于是老角色与没配过 TTS 的人照旧用浏览器念 */
  engine: 'browser' | 'tts'
  /* browser 档:系统音色名(getVoices() 的 name)。留空 = 按角色 id 挑一个 */
  voiceName?: string
  /* browser 档的语速与音高,1 为原速 */
  rate?: number
  pitch?: number
  /* tts 档:用哪条 TTS 配置(见 ApiConfig.kind = 'tts') */
  configId?: string
  /* tts 档的三种来源之一。缺省按 preset 处理 */
  source?: 'preset' | 'describe' | 'clone'
  /* preset 的音色名,或 clone 建号拿到的音色 id —— 都是"上游那一把嗓子" */
  vendorVoice?: string
  /* describe 档:那段描述 */
  describe?: string
  /* clone 档:本地样本的引用。建号之后合成不再用它,
     留它是为了"重新克隆 / 删掉样本 / 界面上回显当初用的是哪一段" */
  sampleId?: string
  /* clone 档:那段样本的原始文件名。只有界面回显用得上 ——
     真要拿它去认人,用户认的是文件名,不是一串 id */
  sampleName?: string
  /* tts 档的语速。上游的刻度是 [-50,100],0 为原速 */
  speed?: number
  /* tts 档的资源标识覆盖。留空时按来源推断:
     复刻音色必须用复刻那个计费商品(clone ⇒ seed-icl-2.0),
     其余用配置里填的那个(自带音色 ⇒ seed-tts-2.0)。
     留着这一项是为了"我开的是复刻 1.0"这种情况有地方写 */
  resourceId?: string
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
  /* 人格设定,只有聊天用得上(见 CharacterPersona)。
     可选是为了兼容加它之前存下来的角色,读入时补空串(coerceCharPersona),
     所以读的地方可以当它一定存在 */
  persona?: CharacterPersona
  /* 朗读用的嗓音(见 CharacterVoice)。可选是为了兼容加它之前存下来的角色 ——
     没有就是"按系统音色挑一个"(browser 档的缺省行为) */
  voice?: CharacterVoice
  /* 封面与头像用的那张图。生成正脸成功后它就是正脸本身(见 App 的 genCharView),
     所以列表、详情、创作区三处读它读到的都是同一张脸 */
  ref?: Blob
  /* 第一步上传的那张底图(也含"从作品提升为参考"的那一张)。
     它有两处用处:生成正脸时的参考图,以及其余四张设定图与正脸一起送出去的第二张参考图 ——
     正脸定的是"这张脸长什么样",底图定的是"这个人原本是什么样子"
     (发型轮廓、体态、服装这些一张正面头像交代不了的东西)。

     为什么不复用 ref:正脸生成成功后 ref 就换成正脸了,底图放在那儿会被顶掉,
     而其余四张还要用它 */
  sourceRef?: Blob
  /* 这份记录里的 ref 指的是哪张视图。老数据里可能留着被设成别张的值,
     读入时会清掉(那个"选主视图"的功能已经去掉) —— 留着只为让老导出包读得进来 */
  refKind?: CharacterViewKind
  /* 设定图里正脸以外的视图(Angles、全身、Details、表情)。
     只用于查看与挑选主图、不参与生成,所以不在启动时加载 */
  views?: CharacterView[]
}

/* 从一个角色 zip 里读出来的角色。刻意不带 id ——
   文件里的 id 可能与现有的撞上,而列表里两条同 id 会让渲染和删除都错乱,
   所以导入这一步的职责之一就是换新的(见 api.ts 的 readCharacterZip) */
/* 角色包里带回来的**一条消息**。
   比 ChatMessage 少两样东西 —— id 与 charId —— 因为它们都是本地身份:
   文件里的 id 到了这边一定是新的(见 App 的 writeImportedChat),
   而 charId 属于接收方刚建出来的那个角色。带着它们反而多一层校验 */
export interface ImportedChatMessage {
  role: 'user' | 'assistant'
  content: string
  createdAt: number
  stopped?: boolean
  truncated?: boolean
  mood?: string
  /* 这条消息附的图。**这里不换新的**:它就是本地那个 imageId,
     而包里的图片文件也按这个名字存放(见 ImportedChat.images)——
     换个新名字只会让消息与图对不上,而这串 id 本来就只是"引用的键" */
  imageId?: string
}

/* 角色包里带回来的那段对话。**记忆是主,消息是辅** ——
   分享一个养熟了的角色,对方最该拿到的是"它记得我们之间发生过什么";
   消息只是让那段记忆有个能对照的来处。
   记忆的游标(upToAt / covered)不带过来:那些 id 与时间戳在本地不成立,
   由导入方按收到的消息重新推平(见 App 的 writeImportedChat) */
export interface ImportedChat {
  messages: ImportedChatMessage[]
  /** 记忆正文。空串 = 这个包没带记忆 */
  memory: string
  /* 包里的附图。id 与消息里的 imageId 一一对应。
     老包、或没发过图的对话没有这一项 —— 那种情况下消息照常导入,
     只是那条消息上的图没了(界面不会画,也不会报错) */
  images?: Array<{ id: string; blob: Blob }>
}

export interface ImportedCharacter {
  name: string
  createdAt: number
  fields?: CharacterFields
  desc?: string
  persona?: CharacterPersona
  ref?: Blob
  sourceRef?: Blob
  refKind?: CharacterViewKind
  /* 包内带过来的设定图。没带的视图就是没有 —— 与库里那五格一一对应 */
  views: CharacterView[]
  /* 包内带过来的那段对话。老包、或没聊过的角色没有这一项 */
  chat?: ImportedChat
}

/* 一个角色的用量:被拿去出过多少张作品、最后一次是什么时候。
   不落盘 —— 全部从历史记录里按 characterId 聚合出来(记录自己带着出处)。
   与提示词短标题同理:派生得出来的东西不再存一份,老角色也立刻就有数 */
export interface CharacterStat {
  // 拿这个角色生成过的记录条数。设定图那五张不进历史,所以只算作品
  count: number
  // 最后一次生成的时间戳(毫秒)。0 表示还没用过
  lastAt: number
}

/* 一个角色名下的一件作品:历史里一条带 characterId 的记录中的一张图。
   与 CharacterStat 同源 —— 从记录里派生,不落盘。
   entry 整个带着:预览是"按记录"打开的(见 App 的 openPreview),
   而一条记录可能不止一张图,index 说明点的是其中哪一张 */
export interface CharacterWork {
  // 记录 id + 序号,做列表 key 用
  key: string
  entry: HistoryEntry
  index: number
  item: ResultItem
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