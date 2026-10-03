import { computed, ref, type ComputedRef, type Ref } from 'vue'
import {
  acceptableSize,
  enhancePrompt,
  extraParamsFor,
  normalizeSize,
  seedFor,
  sizeForVendor
} from '../api'
import { REF_ARCHIVE_EDGE, REF_IMAGE_EDGE } from '../lib/payload'
import { urlToBlob } from '../lib/idb'
import type { EnhanceMode, Provider } from '../api'
import type { ApiConfig } from '../types'

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


  /** 清掉参考图(与角色无关:角色是另一个输入,见 types.ts 的 characterId 注释) */
  function clearRef() {
    refImage.value = ''
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
    undoEnhance
  }
}
