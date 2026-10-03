import { computed, ref, toRaw, type ComputedRef, type Ref } from 'vue'
import {
  acceptableSize,
  enhancePrompt,
  extraParamsFor,
  normalizeSize,
  characterFaceDesc,
  generate,
  imageSrc,
  makeThumb,
  uid,
  seedFor,
  sizeForVendor
} from '../api'
import { REF_ARCHIVE_EDGE, REF_IMAGE_EDGE } from '../lib/payload'
import { planChatPhoto } from '../lib/chatPhoto'
import { urlToBlob } from '../lib/idb'
import type { EnhanceMode, Provider } from '../api'
import type { ApiConfig, Character, HistoryEntry, ResultItem } from '../types'

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
  charRefSrcs: () => Promise<string[]>
  /** 按 id 取某个角色的图(对话发图要走它,不能认创作区选中的那个) */
  charRefSrcsOf: (charId: string) => Promise<string[]>
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
// 默认交给上游自决:'auto' 在大多数字段里是"最不会错"的一档,选错尺寸比不选更糟
const size = ref('auto')
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

/* 扩展参数与逐模型尺寸也只看能力表(见 api.ts 的 extraParamsFor / sizeForVendor)。
   对比出图时逐个传入 —— 同一次对比里各模型的可用参数并不一样,
   不能拿一家的能力套所有家 */
function extraParams(cfg: ApiConfig = deps.config.value): Record<string, string> {
  return extraParamsFor(cfg, quality.value, background.value)
}
function sizeFor(cfg: ApiConfig): string {
  return sizeForVendor(cfg, size.value)
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


  /* 对话里"角色发一张图"的场景描述上限。与 server/chatTags.js 的
     PHOTO_SCENE_CHARS 同一口径 —— 那边剪下来时已经截过一次,这里是第二道 */
  const CHAT_PHOTO_SCENE_CHARS = 120

  /** 对话里现场画一张:只在被要求或确实合适时由那一轮的标签触发。
   *  **不进历史**(见 doc/角色配图设计.md):图只活在对话里,
   *  所以这条路刻意不走 persist/recordFor —— 只把 Blob 交给调用方,
   *  由它塞进 chat_images。
   *
   *  `self` = 这一张里有没有**它本人**(见 lib/chatPhoto 的说明):
   *  有 → 拼上外貌设定、把设定图当参考图,这是"同一张脸"的保证;
   *  没有 → 提示词只有场景、一张参考图都不发 —— 一张风景照带上设定图,
   *  模型会被拽着往那个人的脸和衣服上靠,画面就跑偏了 */
  async function generateChatPhoto(
    charId: string,
    scene: string,
    self: boolean
  ): Promise<Blob | undefined> {
    const text = String(scene || '').trim().slice(0, CHAT_PHOTO_SCENE_CHARS)
    if (!text || !deps.configured()) return undefined
    /* **认对话里那个角色**,不认创作区选中的那个:设定与参考图都按 charId 取。
       这一点错了就会"一点不像" —— 参考图是空的,等于纯文生图 */
    const who = deps.characters.value.find((c) => c.id === charId)
    const plan = planChatPhoto(text, self, who ? characterFaceDesc(who) : '')
    const refList = plan.useRefs ? await deps.charRefSrcsOf(charId) : []
    const ctrl = new AbortController()
    try {
      const res = await generate(
        {
          prompt: plan.prompt,
          /* **对话里的图永远 auto,不跟创作区那个尺寸走**:
             创作区选的是"我这次要多大",而角色发一张照片该由**场景**决定构图 ——
             横着拍的窗、竖着站的人,同一套尺寸设置管不了两件事。
             仍然过 sizeForVendor:厂商认 auto 就用 auto,不认(只有固定枚举的
             那几家)就退到它认的第一档,绝不发一个非法的值出去 */
          size: sizeForVendor(deps.config.value, 'auto'),
          n: 1,
          ...(refList.length ? { images: refList } : {}),
          ...extraParams()
        },
        deps.config.value,
        ctrl.signal
      )
      const first = res?.[0]
      if (!first) return undefined
      return await urlToBlob(imageSrc(first))
    } catch {
      // 画不出来不该影响它说的话(见设计文档:失败不阻断文字)
      return undefined
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
    recordFor,
    runBatch,
    persistBatch,
    doRace,
    stopSlot,
    stopAllSlots,
    retry
  }
}
