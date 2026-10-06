import { computed, ref, toRaw, type ComputedRef, type Ref } from 'vue'
import {
  FREE_SIZES,
  acceptableSize,
  allowedSizes,
  chatExtraParams,
  enhancePrompt,
  extraParamsFor,
  normalizeSize,
  characterFaceDesc,
  generate,
  imageSrc,
  photoFailureText,
  makeThumb,
  uid,
  seedFor,
  sizeForVendor
} from '../api'
import { REF_ARCHIVE_EDGE, REF_IMAGE_EDGE } from '../lib/payload'
/* 场景串的长度上限。**权威定义住在服务端**(剪标签那一层就在用),
   这里与 api.ts 的导入校验都引它 —— 同一个数抄成三份,已经漏改过一次 */
import { PHOTO_SCENE_CHARS } from '../../server/chatTags.js'
import {
  backdropViewOrder,
  characterAnchor,
  characterGender,
  chatPhotoSize,
  planChatBackdrop,
  planChatPhoto,
  shotViewOrder
} from '../lib/chatPhoto'
import type { ChatPhotoPlan } from '../lib/chatPhoto'
import { DIRECTOR_SLOTS, applyDirector, directorTask, parseDirector } from '../lib/photoDirector'
import { urlToBlob } from '../lib/idb'
import type { EnhanceMode, Provider } from '../api'
import type { ApiConfig, Character, HistoryEntry, HistorySource, ResultItem } from '../types'

/* ===== 出图参数：提示词、尺寸、张数、画质、种子、参考图 ================
   这一层的每一条都受"当前生效的那个接口"约束:能力表说不支持,界面上就不该
   给这个档位。所以它拿的是配置域算好的 provider / defaultSize,而不是自己再判断。

   编排那一层(生成槽、并发、对比出图、落盘)留在主界面,下一次再搬。
   -------------------------------------------------------------------- */

export interface GenerationDeps {
  /** 当前生效的出图配置:尺寸与扩展参数都要过它的能力表 */
  config: Ref<ApiConfig>
  /** 当前生效的文本模型:提示词改写用它 */
  textConfig: Ref<ApiConfig | null>
  /** 能力表(配置域算好) */
  provider: ComputedRef<Provider>
  /** "更多"里那份默认尺寸(配置域算好) */
  defaultSize: ComputedRef<string>
  /** 统一的错误出口 */
  fail: (msg: string, retryable?: boolean) => void
  /** 显示级压缩(主界面那份) */
  compressImage: (
    dataUrl: string,
    maxEdge?: number,
    quality?: number,
    force?: boolean
  ) => Promise<string>

  /** 统一的错误出口与中性提示 */
  notice: Ref<string>
  /** 落一条历史记录(见 useHistory) */
  persist: (record: HistoryEntry) => Promise<void>
  /** 当前角色的图 → data URL,发请求时并进参考图(见 useCharacters) */
  charRefSrcs: (order?: string[]) => Promise<string[]>
  /** 按 id 取某个角色的图(对话发图要走它,不能认创作区选中的那个)。
   *  order 由这一张的镜头决定(见 lib/chatPhoto 的 shotViewOrder) */
  charRefSrcsOf: (charId: string, order?: string[]) => Promise<string[]>
  /** 当前角色:它决定自动并进提示词的那段设定 */
  activeCharacter: ComputedRef<Character | undefined>
  /** 全部角色:对话里发图要按**对话中那个角色**取设定与参考图 */
  characters: Ref<Character[]>
  /** 这次要跑哪几个模型(见 useConfigs) */
  selectedConfigs: ComputedRef<ApiConfig[]>
  /** 参数面板的开合:发起生成时要把它收掉 */
  openPanel: Ref<string>
  /** 画布的"这一条接在谁下面"(见 CanvasEditor 的编辑链) */
  pendingParentId: Ref<string | undefined>
  /** 当前角色 id:落盘时要把它记进记录里 */
  activeCharId: Ref<string>
  /** 一条配置都没有时,发起生成会把人送去设置页(见 useConfigs) */
  openConfigManager: () => void
  /** 出图那条配置配好了没有(见 useConfigs) */
  configured: () => boolean
  /** 这一批是不是多模型对比(见 useConfigs) */
  compareMode: ComputedRef<boolean>
  /** 错误条与"可否重试"(见 useFeedback) */
  error: Ref<string>
  canRetry: Ref<boolean>
}

export function useGeneration(deps: GenerationDeps) {
const prompt = ref('')
// 提示词改写中(防连点、按钮切文案)
const enhancing = ref(false)
// 改写请求的中断手柄,与生图的 controller 各管各的:两件事互不影响
const enhanceController = ref<AbortController | null>(null)
// 改写前的原稿,空串表示当前没有可撤销的内容。只在点 Undo 或再次改写时更新
const preEnhance = ref('')
/* 起始尺寸取**这条配置的默认档**(见 api.ts 的 defaultSizeFor),而不是写死 'auto':
   'auto' 对多数厂商是"最不会错"的一档,但对豆包不是 —— 它的 auto 是"不发 size,
   按上游默认出图",而那个默认是 2K,按像素计费,约等于 1024×1024 的四倍。
   写死 'auto' 会让"刚打开页面什么都没选"变成按最贵的那档出图 */
const size = ref(deps.defaultSize.value)
const n = ref(1)
// 'auto' 表示交给上游自己决定,请求时不带这个参数
const quality = ref('auto')
const background = ref('auto')
/* 随机种子。留空表示"不发这个参数",交给上游随机。
   注意它和 quality/background 的 auto 不是一回事:那两个的 'auto' 是"不传"的哨兵值,
   这里空着才是"不传"。上游从不告诉我们它实际用了哪个数,所以这里只能由用户自己填,
   填了才有"同一张图再微调"可言 */
const seed = ref('')
const refImage = ref('') // 图生图参考图 (data URL)
const moreCustom = computed(
  () =>
    n.value !== 1 ||
    size.value !== deps.defaultSize.value ||
    quality.value !== 'auto' ||
    background.value !== 'auto' ||
    (deps.provider.value.seed !== 'no' && !!seed.value.trim()) ||
    !!refImage.value
)

/* 种子的实际取值:留空、认不出、或厂商明确不支持就不发(见 api.ts 的 seedFor) */
function seedForConfig(cfg: ApiConfig = deps.config.value): number | undefined {
  return seedFor(cfg, seed.value)
}
// 手填种子:失焦/回车时收敛成整数并回写输入框;认不出来就清空(= 交给上游随机)
function commitSeed(e: Event) {
  const el = e.target as HTMLInputElement
  const v = Math.round(Number(el.value))
  seed.value =
    el.value.trim() !== '' && Number.isFinite(v) && Math.abs(v) <= 2147483647 ? String(v) : ''
  el.value = seed.value
}

// 张数上限:多数生图接口一次最多 10 张
const N_MAX = 10

// 'auto' 是给上游的值,界面上叫"自动"
function sizeLabel(s: string) {
  return s === 'auto' ? 'Auto' : s.replace(/x/g, '×')
}

/**
 * 上游确实回了一张图,我们却把它落不成 Blob 时该说什么。
 *
 * 最典型的一种是**它回的是图片链接**:豆包的 response_format 默认就是 `url`,
 * 而那张链接是给浏览器之外的地方下载的 —— 前端拿到 url 还得再跨域拉一次,
 * 被 CORS 挡住、或 24 小时过期,拉不动就是拉不动。
 * 这时说"上游没给可用的图"会把人送去查模型,而该查的是响应格式 ——
 * 所以两种情形分开说(见 api.ts 能力表的 responseFormat:认这一项的厂商
 * 我们已经直接要 base64 了)。
 */
function unusableImageText(first: ResultItem): string {
  return first.type === 'url'
    ? 'The upstream returned an image link this browser could not download — blocked cross-origin, or the link has expired. Check the vendor in API Settings: providers that can return base64 are asked for it, and that removes the second hop.'
    : 'The image API returned something that is not a usable image.'
}

/* 扩展参数与逐模型尺寸也只看能力表(见 api.ts 的 extraParamsFor / sizeForVendor)。
   对比出图时逐个传入 —— 同一次对比里各模型的可用参数并不一样,
   不能拿一家的能力套所有家 */
function extraParams(cfg: ApiConfig = deps.config.value): Record<string, string> {
  return extraParamsFor(cfg, quality.value, background.value)
}
function sizeFor(cfg: ApiConfig): string {
  return sizeForVendor(cfg, size.value)
}

/* 一条配置下"可以挑的显式尺寸"。厂商不限尺寸时用应用自己那组常用值 ——
   与角色设定图那条路(useCharacters 的 viewSize)同一个口径:
   两边都是"按比例挑最接近的一档",所以两边都吃同一份 FREE_SIZES */
function sizeChoicesOf(cfg: ApiConfig): string[] {
  const a = allowedSizes(cfg.vendor, cfg.model || '')
  return a === 'free' ? FREE_SIZES : a
}

// 自定义张数:允许手输,失焦/回车时收敛到 1..N_MAX 的整数并回写输入框
function clampN(e: Event) {
  const el = e.target as HTMLInputElement
  const v = Math.round(Number(el.value))
  n.value = Number.isFinite(v) && v >= 1 ? Math.min(N_MAX, v) : n.value
  el.value = String(n.value)
}

// 自定义尺寸:失焦/回车时归一化;认不出来就还原成当前生效值,不做隐式猜测
function commitSize(e: Event) {
  const el = e.target as HTMLInputElement
  const norm = normalizeSize(el.value.trim())
  if (norm) size.value = norm
  // 两种情况都回写:成功显示归一化结果,失败还原当前值(值没变时 Vue 不会重渲染)
  el.value = size.value
}

/* 套用尺寸(从库取用、或复现某条记录):合不合法由 api.ts 判(见 acceptableSize)。
   原来这里只查了一遍候选列表,漏掉了"auto 不在列表里、而是单独一档能力"——
   于是一条存着 auto 的记录套到豆包那种认枚举尺寸的配置上,会把 auto 原样发出去,
   而它收到枚举外的值直接报 400 */
function applySize(s?: string) {
  const next = acceptableSize(deps.config.value, s)
  if (next) size.value = next
}

// —— 图生图:读取本地图片为 data URL(压缩到最长边 REF_IMAGE_EDGE,避免请求体过大 413) ——
function onPickRef(e: Event) {
  const file = (e.target as HTMLInputElement).files?.[0]
  if (!file) return
  // 角色与参考图是两个独立输入,自己挑图不动角色(见 types.ts 的 characterId 注释)
  const reader = new FileReader()
  reader.onload = () => {
    const url = String(reader.result)
    deps.compressImage(url, REF_IMAGE_EDGE).then((out) => (refImage.value = out))
  }
  reader.readAsDataURL(file)
  ;(e.target as HTMLInputElement).value = ''
}
/* 键盘也能选参考图。那个入口是 <label for>:它不在 Tab 序里,而点它才触发
   file input —— 补上 tabindex 与回车/空格之后,把触发这件事显式写出来 */
const refInputEl = ref<HTMLInputElement | null>(null)
function pickRef() {
  refInputEl.value?.click()
}
/* 参考图的存档副本:配方要能完整复现,就得连参考图一起留下 ——
   hasRef 只说得出"用过参考图",说不出是哪一张,重跑时就会悄悄退化成文生图。
   压到最长边 512(它只当参考用,不需要原分辨率),存 Blob 不存 data URL,
   与结果图同一套。压不出来就返回 undefined,按"没存档"处理,不阻断生成 */
async function refThumbOf(src: string): Promise<Blob | undefined> {
  if (!src) return undefined
  try {
    const out = await deps.compressImage(src, REF_ARCHIVE_EDGE, 0.72)
    return /^data:image\//.test(out) ? await urlToBlob(out) : undefined
  } catch {
    return undefined
  }
}

/* 改写与撤销共用同一个按钮:两件事不会同时可用,拆成两个会让按钮区
   在"有没有原稿"之间来回换宽度,旁边的清除键跟着跳。
   三态由现有状态推出来,不另存一份 */
const canUndo = computed(() => !enhancing.value && !!preEnhance.value)
/* 按钮上只写档位名:"enhance" 已经在四角星图标和它所在的位置里说完了,
   再写一遍只是把按钮撑长。改写中同样带档位,顺带说明这次跑的是哪一档 */
const enhanceText = computed(() => {
  if (enhancing.value) return 'Stop'
  if (canUndo.value) return 'Undo'
  return enhanceMode.value === 'creative' ? 'Creative' : 'Quick'
})
/* 只有"空闲、没得可撤、输入框也空着"才禁用。
   改写中必须可点 —— 那个位置就是中断键,和生成键跑起来变方块停止是同一套;
   可撤销时同样可点,哪怕输入框被清空了:原稿还在,那正是要撤回来的场景 */
const enhanceDisabled = computed(() => !enhancing.value && !canUndo.value && !prompt.value.trim())

/* 悬停提示:说清这次点下去会用哪一档。
   选了参考图时补一句 —— 那时改写是"改什么"而不是"画什么",结果明显更短,
   不点明会让人以为是自己写坏了或者模型变笨了 */
const enhanceTip = computed(() => {
  if (enhancing.value) return 'Stop rewriting'
  if (canUndo.value) return 'Undo'
  const mode = enhanceMode.value === 'creative' ? 'Creative' : 'Quick'
  return `Rewrite the prompt · ${mode}${refImage.value ? ' · Image-to-image' : ''}`
})
// 读屏也该知道是图生图:它看不到悬停提示,更看不到参考图缩略图
const enhanceAria = computed(() => {
  if (enhancing.value) return 'Stop rewriting'
  if (canUndo.value) return 'Undo prompt rewrite'
  return `Rewrite the prompt, ${enhanceMode.value} mode${refImage.value ? ', image-to-image' : ''}`
})

/* 改写档位:只两档,所以切换键直接来回切,不做下拉菜单 ——
   两种状态用不着菜单那套浮层、外部点击收起和箭头图标。
   只存在内存里:刷新后回到保守档,重构档是"这次想放开一点"的临时选择 */
const enhanceMode = ref<EnhanceMode>('quick')
function toggleEnhanceMode() {
  enhanceMode.value = enhanceMode.value === 'quick' ? 'creative' : 'quick'
}
const nextModeLabel = computed(() => (enhanceMode.value === 'quick' ? 'Creative' : 'Quick'))

/* 提示词改写:用文本模型把当前提示词扩写得更具体,结果填回输入框。
   改写前的原稿另存一份供 Undo 撤销 —— 不做历史记录,只留最近一次。 */
async function doEnhance() {
  // 进行中不重入,防连点
  if (enhancing.value) return
  const src = prompt.value.trim()
  if (!src) return
  // 改写模型和地址都要有:缺一个都打不通 /chat/completions,借现有的错误出口提示去设置页配
  const cfg = deps.textConfig.value
  if (!cfg || !cfg.model || !cfg.baseUrl) {
    deps.fail('Set up prompt enhancing in API settings first.')
    return
  }
  enhancing.value = true
  enhanceController.value = new AbortController()
  try {
    const out = await enhancePrompt(
      cfg,
      src,
      {
        mode: enhanceMode.value,
        // 这次改写是给出图那条配置的:各家偏好不同,写法要跟着变
        targetVendor: deps.provider.value.id,
        targetModel: deps.config.value.model,
        // 有参考图时提示词该写成"改什么",而不是重新描述整幅画面
        hasRef: !!refImage.value
      },
      enhanceController.value.signal
    )
    // 原稿存的是改写前的完整文本(含可能的首尾空白),Undo 才能一字不差地还原
    preEnhance.value = prompt.value
    prompt.value = out
  } catch (e: any) {
    // 主动中断不算失败:不报错,输入框保持原样(和生成那边的处理一致)
    if (e?.name === 'AbortError') return
    deps.fail(e?.message || 'Prompt enhancing failed')
  } finally {
    enhancing.value = false
    enhanceController.value = null
  }
}

// 中断改写:断开请求。服务端那边会跟着中断对上游的调用(见 /api/enhance 的 res.on('close'))
function stopEnhance() {
  enhanceController.value?.abort()
}

/* 按钮一个位置承担三件事:改写、中断、撤销。同一时刻只会有一件是当前的,
   拆成三个按钮会把按钮区撑宽,而且用户还得先找哪个是自己的状态 */
function onEnhanceClick() {
  if (enhancing.value) stopEnhance()
  else if (canUndo.value) undoEnhance()
  else doEnhance()
}

// 撤销改写:把原稿写回输入框,并清掉撤销点
function undoEnhance() {
  if (!preEnhance.value) return
  prompt.value = preEnhance.value
  preEnhance.value = ''
}


  /* 摄影指导这一跳最多等多久。它不是用户主动发起的(用户只看到"图在画"),
     所以不能无限等 —— 卡住时宁可交一张模板拼的图,也不能让骨架一直转。
     但**它耽误的只是"图晚多久出来",不是正文**(正文早就流完在屏幕上了),
     所以这个数该按"文本模型能有多慢"来定,而不是按"别让骨架转多久":

     - 服务端那一侧给的是 UPSTREAM_TIMEOUT_MS = 120 秒 —— 也就是说 2 分钟以内,
       它**不会**替我们放弃;
     - 而这一层打的是"当前生效的文本配置",它很可能是**思考型**模型:
       思考也走这段路,一个短任务花 20 秒以上是常事。

     15 秒是原值,实测经常不够(用户 2026-10-06:"角色生图前的 enhance 经常
     超时失败"),而它一超时就**整层丢掉**、退回模板 —— 那正是"图看着没用上
     摄影指导"的样子。30 秒是个折中:覆盖绝大多数思考时间,又不至于真卡住时
     让骨架转太久。

     **真正该换的是模型**:如果 30 秒仍然经常不够,下一步不是继续加这个数,
     而是给"提示词改写"配一条非思考型的文本配置 —— 它这一跳要的只是一段
     四行的短回答。 */
  const DIRECTOR_TIMEOUT_MS = 30_000

  /** 让摄影指导写这一张的机位、镜头、光与环境。
   *
   *  **失败一律返回 null,绝不抛** —— 调用方据此退回模板那一层。
   *  这条约定与 generateChatPhoto 的"失败只返回 undefined"同源:
   *  多出来的一层不许成为"这张图出不来了"的新理由。
   *
   *  三处刻意的取舍:
   *  - **走 /api/enhance 的 photo 档**,不新开端点:它已经解决了上游超时、
   *    代理直连重试、错误回显这些事,而多一条端点就是多一处要跟着改的地方;
   *  - **用当前生效的文本配置**,与提示词改写同一个来源。没配就跳过一次 ——
   *    这不该是这个功能的硬依赖(用户可能只配了出图那条);
   *  - **等它,但不与出图并行**:它改的就是出图要用的那段提示词。
   *
   *  —— 每一处跳过都留一行 console.debug(2026-10-06 补)——
   *
   *  这一层从前**完全静默**:没配文本模型、超时、上游报错,在界面上长得一模一样
   *  (都是"图看起来没用上摄影指导"),而这三件事要做的事完全不同 ——
   *  没配要去配,超时要换模型或调时限,报错要去看那一句 detail。
   *  与 [chat] photo intent 那行同一套:详细级别、不落盘、不上报。
   *  **看之前要把控制台的 Verbose 打开**(debug 默认是折叠的)。 */
  async function withDirector(base: ChatPhotoPlan, cfg: ApiConfig): Promise<ChatPhotoPlan | null> {
    const textCfg = deps.textConfig.value
    if (!textCfg?.baseUrl || !textCfg.model) {
      console.debug('[chat] photo director skipped: no text model configured')
      return null
    }
    const ac = new AbortController()
    /* 计时只为那一行日志:它同时回答"这次等了多久"与"30 秒够不够" */
    const startedAt = Date.now()
    const timer = setTimeout(() => ac.abort(), DIRECTOR_TIMEOUT_MS)
    try {
      const raw = await enhancePrompt(
        textCfg,
        directorTask(base),
        {
          mode: 'photo',
          /* 目标模型那两项在 photo 档不会进系统提示(服务端刻意跳过),
             但仍然要传:EnhanceOpts 里它们不是可选的 */
          targetVendor: cfg.vendor || '',
          targetModel: cfg.model || '',
          hasRef: false
        },
        ac.signal
      )
      const written = parseDirector(raw)
      /* 一位都没解析出来 = 它没按格式回。这时**整层当作不可用**,
         而不是逐位退回 —— 一个都没认出来说明格式已经崩了,
         再从碎片里挑可信的只会引入噪声。
         **视角与景别都不在它那几位里**(2026-10-05 / 10-06 起它不判这两样,
         只被告知),所以这里只看那四位 */
      const ms = Date.now() - startedAt
      if (!DIRECTOR_SLOTS.some((s) => written[s])) {
        console.debug('[chat] photo director: nothing usable in its answer', ms, 'ms', raw.slice(0, 80))
        return null
      }
      console.debug('[chat] photo director:', ms, 'ms', Object.keys(written).join('/'))
      return applyDirector(base, written)
    } catch (e) {
      /* AbortError 只可能是上面那个定时器:这条链上没有第二处会 abort 它
         (用户按 Stop 中断的是对话流,不是这一跳) */
      console.debug(
        '[chat] photo director skipped after',
        Date.now() - startedAt,
        'ms:',
        (e as Error)?.name === 'AbortError'
          ? `no answer within ${DIRECTOR_TIMEOUT_MS / 1000}s`
          : (e as Error)?.message || e
      )
      return null
    } finally {
      clearTimeout(timer)
    }
  }

  /** 聊天里画出来的那张图**连同它的配方**一起交回调用方。
   *
   *  从前只交一个 Blob。现在这两张图也要落进历史(见 App 的 saveChatWork),
   *  而历史记录里那几项(提示词、尺寸、模型、配置)全是在这一层定下来的 ——
   *  调用方手上没有,不交回去就只能记个大概,而"配方记不全"等于以后没法复现。
   *  `elapsedMs` 同理:出图耗时的表在这里,调用方那边已经是一段 await 之后了 */
  type ChatWorkOut = {
    blob: Blob
    /** 真正发给上游的那一整段(含机位、焦段、光、负面约束) */
    prompt: string
    /** 真正发出去的尺寸。由这一张的镜头定(见 chatPhotoSize),不由创作区决定 */
    size: string
    model: string
    /** 当时那条出图配置的 id。配置被改/被删之后仍能说清这张是谁出的 */
    configId: string
    elapsedMs: number
  }

  /** 画一张的结果:要么给图,要么给**原因**。两者必有一个。
   *
   *  从前这里返回 `Blob | undefined`,而 undefined 是**一个**值 ——
   *  "没配出图模型""上游说密钥不对""参考图读不出来""上游回了个空数组"
   *  全都被压成它,界面于是只能说一句"生成失败"。用户既不知道是配置问题
   *  还是模型问题,也不知道下一步该改什么。 */
  type ChatPhotoResult = ChatWorkOut | { blob?: undefined; error: string }

  /* 出图那条配置**缺在哪儿**,说成人话。比"没配好"具体得多 ——
     用户看到"缺模型名"就知道去哪儿补,看到"生成失败"只能来问你 */
  function imageConfigGap(cfg: ApiConfig): string {
    if (!cfg.baseUrl) return 'No image API is configured — set one up in Settings.'
    if (!cfg.model) return 'The image API has no model name — fill it in under Settings.'
    return ''
  }

  /** 对话里现场画一张:只在被要求或确实合适时由那一轮的标签触发。
   *  **画出来的图由调用方落两处**(见 App 的 saveChatWork 与 drawChatPhoto):
   *  一处进 chat_images(消息要显示它、清空对话要回收它),一处进历史
   *  (它也是一张作品,该被翻到、该归到角色名下)。这一层仍然不碰存储 ——
   *  它只把 Blob 连同配方一起交出去,免得生成这一层去认 IndexedDB。
   *
   *  四个输入都是"这一张怎么拍"的一部分(见 lib/chatPhoto 的文件头):
   *  - `self` = 这一张里有没有**它本人**。有 → 拼身份锚点、把设定图当参考图,
   *    这是"同一张脸"的保证;没有 → 提示词里只有场景、一张参考图都不发
   *    —— 一张风景照带上设定图,模型会被拽着往那个人的脸和衣服上靠;
   *  - `shot` = **谁拿的相机**,由聊天模型写在标签前缀里(selfie: / third:)。
   *    它才是知道这件事的那一层(见 lib/chatPhoto 的 planChatPhoto);
   *    空串 = 它没说,由场景文本判、再不行默认自拍;
   *  - `frame` = **离得多近**,同样由聊天模型写在标签前缀里(close: / medium: /
   *    full:,2026-10-06 加)。空串/认不出的词 = 它没说,由场景文本判、再不行
   *    落回这一档视角的缺省景别。**它是"让角色拍特写却总变成臂展自拍"的解药**:
   *    在它之前,景别写死在模板的机位句里,谁都说不动;
   *  - 拼进提示词的是**锚点句**而不是那份全量设定表 —— 后者正是"死板"的来源;
   *  - 尺寸与参考图顺序也跟着镜头与景别走:自拍竖、空镜横;他拍与全身那两档拿
   *    全身像打头才交代得住体型,而**特写那一档反过来把全身像摘掉** ——
   *    参考图是这条链上最强的机位来源(见 lib/chatPhoto 的 FRAME_REF_ORDER);
   *
   *  **绝不 reject**:这条链是后台跑的,往外抛没有调用方接得住
   *  (见 App 的 drawChatPhoto)。所以一律返回上面那个结果对象。 */
  async function generateChatPhoto(
    charId: string,
    scene: string,
    self: boolean,
    shot = '',
    frame = ''
  ): Promise<ChatPhotoResult> {
    /* 场景串的第二道收口。上限引的是**服务端那一份**(剪标签时已经截过一次)——
       从前这里是另抄的一个 400,而同一个数在导入校验那处抄漏成了 120 */
    const text = String(scene || '').trim().slice(0, PHOTO_SCENE_CHARS)
    if (!text) return { error: 'There is no scene to draw for this message.' }
    /* **认对话里那个角色**,不认创作区选中的那个:设定与参考图都按 charId 取。
       这一点错了就会"一点不像" —— 参考图是空的,等于纯文生图 */
    const who = deps.characters.value.find((c) => c.id === charId)
    /* 视角只认标签给的那两个词 —— 它是库里的字段、也是模型写的自由文本,
       认不出的当"没说",由 planChatPhoto 按场景判(见那个函数的说明)。
       景别同理,只认那三档 */
    const wantShot = shot === 'selfie' || shot === 'third' ? shot : undefined
    const wantFrame = frame === 'close' || frame === 'medium' || frame === 'full' ? frame : undefined
    const basePlan = planChatPhoto(
      text,
      self,
      who ? characterAnchor(who) : '',
      wantShot,
      wantFrame,
      /* 性别只服务特写那一档(见 lib/chatPhoto 的 partLine):那一段画面里
         往往没有脸,而锚点句那七项全是头部特征 —— 它是"这个人是谁"唯一的
         接续。有脸的那些图用不上它,所以不加进锚点句、不改动它们 */
      who ? characterGender(who) : ''
    )
    const cfg = deps.config.value
    const gap = imageConfigGap(cfg)
    if (gap) return { error: gap }
    const ctrl = new AbortController()
    try {
      /* —— 摄影指导层(见 lib/photoDirector 与设计文档 §四)——
         插在"剪完标签"和"发图"之间。这一段本来就是异步的(正文早就可读,
         用户在等的是图),所以多一次文本调用只增加出图延迟,不影响聊天。

         **没有文本模型、或它挂了,都只是降级**:退回模板那一层(见 lib/chatPhoto),
         不阻断这张图。所以这里吞掉它的原因,不冒到外层 */
      const plan = (await withDirector(basePlan, cfg)) || basePlan
      /* 取参考图这一步**也要在 try 里**:它会读 IndexedDB、把 Blob 转成 data URL,
         是这条链上最容易真抛出来的一步。抛出去有两个后果,都不能接受 ——
         一是"同一张脸"的依据没了却照样发请求(画出来是个陌生人),
         二是**这个函数往外抛时调用方那侧会静默**:界面既没有提示,
         那条消息还永远停在骨架上(见 App 的 drawChatPhoto) */
      let refList: string[] = []
      if (plan.useRefs) {
        try {
          /* 顺序由 **shot + frame** 一起给:视角定"哪一类照片"(自拍以正面为主、
             他拍以全身打头),景别定"离得多近"(特写把全身像摘掉、全身把全身像
             提到最前,见 lib/chatPhoto 的 FRAME_REF_ORDER)。
             **少传 frame 那一半就等于上一版** —— 参考图是这条链上最强的机位来源,
             只改提示词那一侧是不够的(那正是"特写仍拿全身像当参考"的旧毛病) */
          refList = await deps.charRefSrcsOf(charId, shotViewOrder(plan.shot, plan.frame))
        } catch {
          /* 参考图读不出来仍然照画(纯文生图),但要说明"这张可能不像它" */
          refList = []
        }
      }
      /* 尺寸在这里定一次、两处用:发请求用它,落历史也用它。从前它只出现在
         请求体里,记录那边就无从知道这一张究竟多大(与工作台记录的 size 同义) */
      const usedSize = chatPhotoSize(sizeChoicesOf(cfg), plan.shot, true)
      /* 计时从真正发请求这一刻起:取参考图与摄影指导那一段不是用户在等的
         "出图时间"(与工作台里的 elapsedMs 同口径) */
      const startedAt = Date.now()
      const res = await generate(
        {
          prompt: plan.prompt,
          /* **对话里的图由场景决定尺寸,不跟创作区那个尺寸走** ——
             创作区选的是"我这次要多大"。从前这里写死 'auto',而它对只认固定
             枚举的厂商会被 sizeForVendor 退到 allowed[0](通常 1024×1024):
             横着拍的窗、竖着站的人全被塞进同一个方框。
             现在按镜头挑最接近的一档比例(见 lib/chatPhoto 的 chatPhotoSize) */
          size: usedSize,
          n: 1,
          ...(refList.length ? { images: refList } : {}),
          /* 画质显式给一档,而**创作区那个 background 一概不带**(2026-10-06)。
             画质:对话这条路此前没有让用户选过 quality,于是 extraParamsFor 永远
             看到 'auto'、永远不发这个参数 —— 等于把画质交给厂商的默认档,
             而那一档多半是给"快速预览"用的。'high' 与创作区那一档同名同值。
             背景:它原先读的是创作区面板上那一项,用户在那儿设成非 auto,对话里的
             图也跟着带上。
             **两者都由 chatExtraParams 收口** —— 那个函数签名里就没有 background,
             所以这条路上再也漏不进来(见它的说明)。

             **但仍然要走能力表**:从前这里是先摊 extraParams 再写死
             `quality: 'high'`,后写的把前者的门控整个盖掉 —— 豆包/万相这些
             请求体里没有 quality 的厂商照样收到它,整条请求 400(实测) */
          ...chatExtraParams(cfg)
        },
        cfg,
        ctrl.signal
      )
      const first = res?.[0]
      /* 上游 200 但一张图都没有 —— 这是最容易被压成"生成失败"的一种,
         而它其实通常是内容被安全策略拦了,或者中转回了个空壳 */
      if (!first) return { error: 'The image API returned no image for this prompt.' }
      try {
        return {
          blob: await urlToBlob(imageSrc(first)),
          prompt: plan.prompt,
          size: usedSize,
          model: cfg.model || '',
          configId: cfg.id,
          elapsedMs: Date.now() - startedAt
        }
      } catch {
        return { error: unusableImageText(first) }
      }
    } catch (e) {
      /* 上游/代理的真实错误。`generate()` 抛的就是 /api/generate 回给我们的
         那句话(例如"密钥不对""模型不存在"),它比任何我们编的文案都有用 */
      return { error: photoFailureText(e) }
    }
  }

  /**
   * 画**这一场戏的背景图**（沉浸页铺满屏幕的那一张）。
   *
   * 与 `generateChatPhoto` 的三处不同，都是刻意的：
   * - 提示词走 `planChatBackdrop`（横构图、主体靠右、左边留给字）；
   * - **不进消息流**：它不属于哪一条消息，画完由调用方写进 `chat_backdrops`；
   * - **不过摄影指导那一层**：那是"这一张照片怎么拍"的层，而背景图自己已经把
   *   机位与光写死了（见那段提示词的注释）。多一次文本调用换不到什么，
   *   而它正好压在"进沉浸页"这条路上 —— 那条路该尽量短。
   *
   * 与 `generateChatPhoto` 同一条约定：**失败只返回 error，绝不往外抛**。
   * 返回的形状也一并对齐（连配方一起交回去）—— 背景图同样要落进历史，
   * 理由与那张照片一样（见 ChatWorkOut）。
   */
  async function generateChatBackdrop(charId: string, scene: string): Promise<ChatPhotoResult> {
    const who = deps.characters.value.find((c) => c.id === charId)
    const plan = planChatBackdrop(scene, who ? characterAnchor(who) : '')
    if (!plan.prompt) return { error: 'There is no scene to draw a background for yet.' }
    const cfg = deps.config.value
    const gap = imageConfigGap(cfg)
    if (gap) return { error: gap }
    const ctrl = new AbortController()
    try {
      let refList: string[] = []
      try {
        refList = await deps.charRefSrcsOf(charId, backdropViewOrder())
      } catch {
        /* 参考图读不出来仍然照画（纯文生图），背景不像它总好过一片空 */
        refList = []
      }
      /* 横构图。复用"空镜"那一档比例（3:2）—— 它比人像档宽，
         又比 16:9 更容易在各家的档位表里找到。
         定一次、两处用（请求 + 落历史），与那张照片同一条 */
      const usedSize = chatPhotoSize(sizeChoicesOf(cfg), 'scene', true)
      const startedAt = Date.now()
      const res = await generate(
        {
          prompt: plan.prompt,
          size: usedSize,
          n: 1,
          ...(refList.length ? { images: refList } : {}),
          /* 与那张照片同一条规矩:画质显式给 'high'、创作区那个 background 一概
             不带,两项都过能力表(没有 quality 字段的厂商一个字节都不发)。
             见 chatExtraParams 那一段说明 */
          ...chatExtraParams(cfg)
        },
        cfg,
        ctrl.signal
      )
      const first = res?.[0]
      if (!first) return { error: 'The image API returned no image for this prompt.' }
      try {
        return {
          blob: await urlToBlob(imageSrc(first)),
          prompt: plan.prompt,
          size: usedSize,
          model: cfg.model || '',
          configId: cfg.id,
          elapsedMs: Date.now() - startedAt
        }
      } catch {
        return { error: unusableImageText(first) }
      }
    } catch (e) {
      return { error: photoFailureText(e) }
    }
  }

  /** 清掉参考图(与角色无关:角色是另一个输入,见 types.ts 的 characterId 注释) */
  function clearRef() {
    refImage.value = ''
  }

type GenSlot = {
  id: string
  /* 落盘归并键。同一批里同键的槽合成一条历史记录:
     单模型出 4 张 → 一条记录带 4 张图(与从前一致);
     对比 3 个模型 → 三条记录(也与从前一致) */
  recordKey: string
  /* 这一次点击共用的分组 id,与对比出图沿用同一个字段语义(见 HistoryEntry.groupId) */
  groupId: string
  /* —— 发起时锁死的整套条件 ——
     中途改提示词、尺寸或配置,都不该影响已经发出去的那几张 */
  config: ApiConfig
  // 展示用的模型名(槽位上要写清这是哪家)
  label: string
  model: string
  prompt: string
  size: string
  extras: Record<string, string>
  seed?: number
  refList: string[]
  // 用户自己挑的那张参考图(角色的不算)。存快照是为了落盘时记下"当时用的哪张"
  refSrc?: string
  characterId?: string
  parentId?: string
  startedAt: number
  state: 'running' | 'done' | 'stopped' | 'error'
  results: ResultItem[]
  error?: string
  elapsedMs?: number
}
const genSlots = ref<GenSlot[]>([])
/* 中断手柄按槽各存一个。同一时刻可能有好几批在跑(生成键不再锁死),
   共用一个手柄的话,停一张会把别张一起掐掉 */
const slotControllers = new Map<string, AbortController>()
/* 正在跑的槽。骨架格、忙闲、进度条都读它 —— 只有还没结束的槽才占位 */
const activeSlots = computed(() => genSlots.value.filter((s) => s.state === 'running'))
const loading = computed(() => genSlots.value.some((s) => s.state === 'running'))
/* 这一批是不是在多模型对比(落盘键按模型分,所以键多于一个就是对比)。
   骨架格上要不要写模型名、进度条上说"Comparing"还是"Generating",都看它 */
const multiModel = computed(() => new Set(activeSlots.value.map((s) => s.recordKey)).size > 1)
/* 进度条上那句话。单模型出几张时报个数 —— 用户想知道的是"还有几张在路上" */
const runLabel = computed(() => {
  if (multiModel.value) return 'Comparing'
  const n = activeSlots.value.length
  return n > 1 ? `Generating ${n} images` : 'Generating'
})
/* 会自动并进提示词的那一段(角色设定) */
const charSpecPrefix = computed(() =>
  deps.activeCharacter.value ? characterFaceDesc(deps.activeCharacter.value) : ''
)

/** 这次真正要发出去的提示词:用户自己写的在前,角色设定接在后面。
 *  顺序不能反 —— 前段权重更高,把固定的那套长相顶在最前面,
 *  "这一张要画什么"就被压到最后了。角色是加在场景上的,不是反过来 */
function composedPrompt(): string {
  const spec = charSpecPrefix.value
  const text = prompt.value.trim()
  if (!spec) return prompt.value
  return text ? `${text}, ${spec}` : spec
}

async function doGenerate() {
  /* 这里不再用"正在生成"拦第二次点击:那正是要解决的问题 ——
     生成键在跑的时候变成暂停键,于是生成中途发不出新的了。
     现在每次点击各自成批,可以叠着跑 */
  /* 改写回来时会整体覆盖提示词。此刻发出去的图,用的是改写到一半的内容,
     而用户看到的输入框马上就要变成另一段文字 —— 这批图会和界面对不上。
     改写按钮那边也置灰了,这里再拦一道是因为回车也能触发生成 */
  if (enhancing.value) return
  if (!prompt.value.trim()) {
    deps.fail('Enter a prompt first')
    return
  }
  if (!deps.configured()) {
    /* 用 notice 而不是 fail:这条路径紧接着就跳到设置页,而 fail 写的是 home
       那条 .err —— 页面已经切走,提示留在不渲染的 DOM 里等于没提示 */
    deps.notice.value = 'Set an API base URL in Settings first'
    deps.openConfigManager()
    return
  }
  /* 发出去了,参数面板就没有再开着的理由:它是"发之前调一调"的东西,
     而这一批的参数此刻已经锁进槽里,面板留着只会挡住下面的图墙 */
  deps.openPanel.value = ''
  // 选了多个模型时走另一条链路:一次发给每个模型,结果并排
  if (deps.compareMode.value) {
    await doRace()
    return
  }

  /* 发起前锁定这一批的参数,后面一律读快照,避免中途改参数串味。
     套了角色时这里锁的是合成后的提示词 —— 真正发出去的就是它 */
  const runPrompt = composedPrompt()
  const runSize = size.value
  const runN = Math.max(1, n.value)
  /* 同一次点生成就是一批。group 让生成的结果在图墙上可归拢,
     和对比出图共用同一个字段语义(见 groupId 注释) */
  const genGroupId = `gen-${Date.now().toString(36)}`
  // 扩展参数与参考图同样要快照:它们在 await 期间可能被改动
  const extras = extraParams()
  // 种子也是快照的一部分:中途改它不该影响已经发出的这一批
  const seedNum = seedForConfig()
  const refSrc = refImage.value
  /* 参考图可以不止一张:用户自己挑的图 + 角色的那几张一起送 ——
     单张太弱,多视图才锁得住同一张脸。用户那张排最前,它多半就是这次要改的底图 */
  const refList: string[] = []
  if (refSrc) refList.push(refSrc)
  for (const s of await deps.charRefSrcs()) if (!refList.includes(s)) refList.push(s)

  /* 张数就是槽数。种子要逐张错开:原来一个请求带 n=4 时,上游按序号派生四张;
     拆成四次请求后如果都传同一个种子,四次会拿到同一张图。
     填了种子就 S、S+1、S+2 …… —— 指定种子仍然可复现,只是从"上游派生"
     变成"我们自己接管这件事" */
  const slots: GenSlot[] = Array.from({ length: runN }, (_, i) => {
    const s = seedNum === undefined ? undefined : seedNum + i
    return {
      id: uid(),
      // 单模型出几张 = 一条记录带几张图(与拆分前的粒度一致)
      recordKey: genGroupId,
      groupId: genGroupId,
      config: deps.config.value,
      label: deps.config.value.name || deps.config.value.model || deps.config.value.baseUrl || 'Model',
      model: deps.config.value.model || '',
      prompt: runPrompt,
      size: runSize,
      extras,
      ...(s !== undefined ? { seed: s } : {}),
      refList,
      refSrc: refSrc || undefined,
      characterId: deps.activeCharId.value || undefined,
      parentId: deps.pendingParentId.value,
      startedAt: Date.now(),
      state: 'running' as const,
      results: []
    }
  })
  await runBatch(slots)
}

/* 同时在跑的请求数上限。拆开之后"张数 = 请求数",一次 10 张原样并发
   很容易被上游限流(429),而限流的报错长得像"这个模型坏了"。
   排队只让慢的那几张等一等,不影响结果 */
const SLOT_CONCURRENCY = 3

/** 按上限并发跑。够用就好的轮子 —— 不引依赖,也不做动态调参 */
async function runWithLimit<T>(items: T[], limit: number, run: (t: T) => Promise<void>) {
  const queue = [...items]
  const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    for (let next = queue.shift(); next !== undefined; next = queue.shift()) await run(next)
  })
  await Promise.all(workers)
}

/** 跑一批槽,结束再落盘、收尾。单模型多张与多模型对比共用这一条 */
async function runBatch(slots: GenSlot[]) {
  genSlots.value = [...genSlots.value, ...slots]
  deps.error.value = ''
  deps.notice.value = ''
  deps.canRetry.value = false
  /* 跑的是 genSlots 里那份响应式代理,而不是传进来的本地数组。
     ref 的深层代理只在**读取**时才套上,而 runSlot 直接改原对象的
     state / results —— 不经过 set trap,逐格的完成与失败就不会触发渲染,
     整批跑完才一起变(点掉一张的停止键,那格骨架会一直转到最后)。
     按 id 取回代理,顺序与 slots 一致,下面 persistBatch 照旧读原数组 */
  const ids = new Set(slots.map((s) => s.id))
  const live = genSlots.value.filter((s) => ids.has(s.id))
  try {
    /* 上限内并发 —— 既不串成一条长队(多张的总耗时等于各张之和),
       也不一次性全丢出去(自己把自己限流) */
    await runWithLimit(live, SLOT_CONCURRENCY, runSlot)
  } finally {
    await persistBatch(slots)
    /* 结束的槽立刻撤出图墙:留下的只有图和提示。
       骨架格一直挂在那儿会让人以为还在跑 */
    genSlots.value = genSlots.value.filter((s) => !ids.has(s.id))
  }
  reportBatch(slots)
}

/** 一个槽 = 一次请求 = 一张图。异常在这一层吃掉 ——
 *  一张失败不该拖累同批的其它张,这正是拆开跑最值钱的地方 */
async function runSlot(slot: GenSlot) {
  // 排队期间被停掉的:不必再发出去
  if (slot.state !== 'running') return
  const ctl = new AbortController()
  slotControllers.set(slot.id, ctl)
  try {
    const res = await generate(
      {
        prompt: slot.prompt,
        size: slot.size,
        n: 1,
        ...(slot.refList.length ? { images: slot.refList } : {}),
        ...(slot.seed !== undefined ? { seed: slot.seed } : {}),
        // 由厂商能力表决定带哪些扩展参数:auto 与已知不支持的都不发
        ...slot.extras
      },
      slot.config,
      ctl.signal
    )
    slot.results = res
    slot.state = 'done'
  } catch (e: any) {
    // 主动终止不是失败,但要说清是"你停的",不是模型坏了
    slot.state = e?.name === 'AbortError' ? 'stopped' : 'error'
    // 上游原文可能很长,槽位里放不下;完整内容留到汇总那条提示里
    if (slot.state === 'error') {
      slot.error = String(e?.message || 'Generation failed').slice(0, 300)
    }
  } finally {
    slot.elapsedMs = Date.now() - slot.startedAt
    slotControllers.delete(slot.id)
  }
}

/** 落盘:同一批里按 recordKey 归并。
 *  单模型的几张合成一条记录(与拆分前一致),对比的每模型一条(也与拆分前一致) */
async function persistBatch(slots: GenSlot[]) {
  const groups = new Map<string, GenSlot[]>()
  for (const s of slots) {
    const list = groups.get(s.recordKey)
    if (list) list.push(s)
    else groups.set(s.recordKey, [s])
  }
  for (const group of groups.values()) {
    const ok = group.filter((s) => s.state === 'done' && s.results.length)
    if (!ok.length) continue
    // 条件取第一个槽:同键的这几个除了种子逐张递进,其余完全一样
    const head = group[0]
    /* 必须取原始数组:槽上的 results 是响应式代理,而 indexedDB 用结构化克隆
       写盘,代理克隆不了(DataCloneError),记录会写不进去 —— 界面看着图还在
       (内存里有),刷新就没了,还会误报"没能保存到本地" */
    const results = ok.flatMap((s) => toRaw(s.results))
    const record = await recordFor(results, {
      prompt: head.prompt,
      size: head.size,
      model: head.model || undefined,
      // 只记真正发出去的扩展参数,免得预览里展示出当时并没生效的档位
      quality: head.extras.quality,
      background: head.extras.background,
      hasRef: !!head.refSrc,
      groupId: head.groupId,
      configId: head.config.id,
      seed: head.seed,
      refSrc: head.refSrc,
      /* 「拉自某条记录改一个变量重跑」的出处。普通手写提示词这里是空,不入链 */
      parentId: head.parentId,
      // 套了角色就记下是谁 —— 预览里才说得清"这条是照哪个角色出的"
      characterId: head.characterId,
      // 一批里各张耗时不同,记最慢的那张 = 这一批总共要等多久
      elapsedMs: Math.max(...ok.map((s) => s.elapsedMs || 0))
    })
    await deps.persist(record)
  }
}

/** 这一批跑完说一句。全成败占用错误区(有原文和重试),部分失败走中性的 notice,
 *  一张都没失败就什么都不说 —— 图自己会出现在图墙里 */
function reportBatch(slots: GenSlot[]) {
  const failed = slots.filter((s) => s.state === 'error')
  if (!failed.length) return
  /* 同一个模型的几张失败时不必把名字念好几遍:按名字收一遍,
     一家的报错就用第一条(同一次请求失败,原因通常也只有一个) */
  const byName = new Map<string, string>()
  for (const s of failed) if (!byName.has(s.label)) byName.set(s.label, s.error || 'failed')
  const names = [...byName.keys()].join(', ')
  if (byName.size === new Set(slots.map((s) => s.label)).size) {
    deps.fail([...byName].map(([label, err]) => `${label}: ${err}`).join('\n'), true)
    return
  }
  deps.notice.value = `${failed.length} of ${slots.length} failed (${names}) — the rest are in your recent creations`
}

/* 把一组结果包成一条历史记录,并补上缩略图与真实像素。
   缩略图要在入列表和落盘之前补上:入列表后拿到的是响应式代理,
   在代理上改动不会回写到这里的原始对象,而 idb 又只接受原始对象。
   同时把量到的真实像素写进记录,图墙就能按真实比例排,而不是按所选尺寸 */
async function recordFor(
  res: ResultItem[],
  meta: {
    prompt: string
    size: string
    model?: string
    quality?: string
    background?: string
    hasRef?: boolean
    groupId?: string
    /* 这一批是「从某条记录拉下来改的」时的父记录 id。见 pendingParentId */
    parentId?: string
    /* 这一批套用的角色 id。见 Character */
    characterId?: string
    elapsedMs: number
    // 完整配方里其余的三项:重跑时要用它们还原当时的条件
    configId?: string
    seed?: number
    // 参考图本体(data URL)。存一份压过的小图,不然"当时用了哪张参考图"就丢了
    refSrc?: string
    /* —— 下面两项只有对话里生成的那两张图会带(见 types.ts 的 HistoryEntry.source)——
       工作台这条路不传,于是记录上就没有这两个字段(与老记录一致) */
    // 来自对话里的哪条路
    source?: HistorySource
    /* 对话里那一场戏的描述。它是这两张图"画的是什么"那句人话,
       而 prompt 是整段摄影指令 —— 界面上读的是它(见 lib/chatWork) */
    scene?: string
  }
): Promise<HistoryEntry> {
  const record: HistoryEntry = {
    id: Date.now() + Math.random().toString(16).slice(2),
    prompt: meta.prompt,
    size: meta.size,
    model: meta.model,
    quality: meta.quality,
    background: meta.background,
    hasRef: meta.hasRef,
    groupId: meta.groupId,
    parentId: meta.parentId,
    characterId: meta.characterId,
    configId: meta.configId,
    seed: meta.seed,
    elapsedMs: meta.elapsedMs,
    createdAt: Date.now(),
    results: res
  }
  if (meta.source) record.source = meta.source
  if (meta.scene) record.scene = meta.scene
  const t = await makeThumb(res[0])
  if (t) {
    record.thumb = t.blob
    record.w = t.w
    record.h = t.h
  }
  if (meta.refSrc) record.ref = await refThumbOf(meta.refSrc)
  return record
}

/* 一条记录:入内存 + 落盘。裁剪与落盘失败的处置只有这一处,
   生成与对比出图的每条结果都走它 */
/* —— 对比出图 ——
   同一提示词并发发给每个选中的模型。单个槽位自己吞掉异常,一个失败不影响其他 ——
   这正是这个功能最值钱的地方:并排就能看出是"提示词不行"还是"某个模型不行" */
async function doRace() {
  // 没地址或没密钥的配置发不出去,先摘掉:参与生成的必须是能真跑的
  const targets = deps.selectedConfigs.value.filter((c) => c.baseUrl && c.apiKey)
  if (targets.length < 2) {
    deps.fail('Pick at least 2 image models with a base URL and an API key to compare')
    deps.openPanel.value = 'config'
    return
  }
  /* 与单模型那条路一致:套了角色就得把角色设定合成进去。
     下面参考图与 characterId 都照常备着,提示词少了这一段的话,
     出的图不像这个角色,记录却声称用了它 —— 预览里重跑还会再错一次 */
  const runPrompt = composedPrompt()
  const refSrc = refImage.value
  /* 角色在对比出图里同样要并进去:那是另一条链路,参考图得在这儿另做一份快照 */
  const refList: string[] = []
  if (refSrc) refList.push(refSrc)
  for (const s of await deps.charRefSrcs()) if (!refList.includes(s)) refList.push(s)
  const groupId = `race-${Date.now().toString(36)}`
  /* 尺寸与扩展参数在发起前逐配置定下来:中途改参数不该影响已经发出的这一批,
     而且各模型的合法尺寸/参数本来就不一样,不能拿一家的能力套所有家。
     张数固定 1:对比要看的是"哪个模型更好",不是每个模型各来三张 */
  const slots: GenSlot[] = targets.map((c) => {
    const s = seedForConfig(c)
    return {
      id: uid(),
      // 每个模型各自成一条记录:这正是对比的意义
      recordKey: c.id,
      groupId,
      config: c,
      label: c.name || c.model || c.baseUrl,
      model: c.model || '',
      prompt: runPrompt,
      size: sizeFor(c),
      extras: extraParams(c),
      ...(s !== undefined ? { seed: s } : {}),
      refList,
      refSrc: refSrc || undefined,
      characterId: deps.activeCharId.value || undefined,
      parentId: deps.pendingParentId.value,
      startedAt: Date.now(),
      state: 'running' as const,
      results: []
    }
  })
  await runBatch(slots)
}

/* 停掉一张。只掐这一个槽 —— 同一个模型出的另外几张、
   以及叠着跑的另一批,都不该被牵连 */
function stopSlot(id: string) {
  const ctl = slotControllers.get(id)
  if (ctl) {
    ctl.abort()
    return
  }
  /* 还没轮到它发出去(并发上限之外的那些)。不处理的话这一格会一直转 ——
     用户点了停止却什么都没发生,比按钮没反应更糟 */
  const slot = genSlots.value.find((s) => s.id === id)
  if (slot?.state === 'running') slot.state = 'stopped'
}
/** 全部停下。骨架格上各自有停止键,这个入口是给"一次跑了十来张、
 *  不想一个个点"的情况用的 */
function stopAllSlots() {
  for (const c of slotControllers.values()) c.abort()
  // 排队中的那几个没有手柄可掐,得单独标记
  for (const s of genSlots.value) if (s.state === 'running') s.state = 'stopped'
}

// 重试:按当前输入再发一次(用户可能已经改过提示词或参数,以界面上的为准)
function retry() {
  doGenerate()
}


  return {
    prompt,
    enhancing,
    enhanceController,
    preEnhance,
    size,
    n,
    quality,
    background,
    seed,
    refImage,
    moreCustom,
    seedForConfig,
    commitSeed,
    N_MAX,
    sizeLabel,
    extraParams,
    sizeFor,
    clampN,
    commitSize,
    applySize,
    refInputEl,
    pickRef,
    onPickRef,
    refThumbOf,
    clearRef,
    canUndo,
    enhanceText,
    enhanceMode,
    enhanceDisabled,
    enhanceTip,
    enhanceAria,
    nextModeLabel,
    toggleEnhanceMode,
    doEnhance,
    stopEnhance,
    onEnhanceClick,
    undoEnhance,
    genSlots,
    slotControllers,
    activeSlots,
    loading,
    multiModel,
    runLabel,
    charSpecPrefix,
    composedPrompt,
    doGenerate,
    generateChatPhoto,
    generateChatBackdrop,
    recordFor,
    runBatch,
    persistBatch,
    doRace,
    stopSlot,
    stopAllSlots,
    retry
  }
}
