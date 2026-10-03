import { computed, ref } from 'vue'
import {
  configKindOf,
  defaultSizeFor,
  getProvider,
  loadActiveId,
  loadActiveTextId,
  loadActiveTtsId,
  loadActiveVisionId,
  loadConfigs,
  pickActiveByKind,
  saveActiveId,
  saveActiveTextId,
  saveActiveTtsId,
  saveActiveVisionId,
  saveConfigs,
  sizeIsFree,
  sizeOptionsFor,
  uid,
  vendorOf
} from '../api'
import type { Cap, Provider } from '../api'
import type { ApiConfig } from '../types'

/* ===== 接口配置:四类用途共用一份列表,各自记一个「当前生效」 ==========
   出图 / 改写(文本) / 识图 / 朗读四类配置放在同一个列表里,因为地址与密钥
   常常同源;但它们的「当前」是分开记的,而且**挑法必须是同一套** ——
   原来这段挑选散在主界面八处,其中出图那条写成 `kind !== 'text'`,
   漏掉了 tts:只配了一条朗读配置时,朗读那条会被当成出图配置。

   所以这里只有一条规则(见 api.ts 的 pickActiveByKind),八处调用都走它。
   -------------------------------------------------------------------- */

export interface ConfigDeps {
  /** 删除的后悔药(见 composables/useFeedback.ts) */
  scheduleUndo: (item: { label: string; undo: () => void; purge: () => void }) => void
  /** 从参数面板进设置页:由主界面负责切页与收起面板 */
  enterSettings: () => void
}

export function useConfigs(deps: ConfigDeps) {
  const configs = ref<ApiConfig[]>([])
  const config = ref<ApiConfig>({ id: '', name: '', baseUrl: '', apiKey: '', model: '' })
  const activeId = ref('')
  const textConfig = ref<ApiConfig | null>(null)
  const activeTextId = ref(loadActiveTextId())
  const visionConfig = ref<ApiConfig | null>(null)
  const activeVisionId = ref(loadActiveVisionId())
  const ttsConfig = ref<ApiConfig | null>(null)
  const activeTtsId = ref(loadActiveTtsId())
  /* 设置页的两屏:列表与表单。它不是路由,只是这一页内部的状态 */
  const cfgView = ref<'list' | 'form'>('list')
  /* 表单的来源(编辑/复制的那条)。null 表示新增空白 */
  const cfgSeed = ref<ApiConfig | null>(null)
  /* 对比出图选中的那些配置。单选是常态,多选是用户一个个点出来的 */
  const selectedIds = ref<string[]>([])
  /** 一次对比最多几个模型 */
  const RACE_MAX = 4

  // 当前激活配置的名称(未配置时显示占位)
  const activeConfigName = computed(
    () => config.value.name || config.value.baseUrl || 'Not configured'
  )

  /* 文本模型与出图配置并排各占一个胶囊:改写用哪个模型也是一眼该看到的状态。
     名字优先,没起名字退回模型名 —— 裸地址在胶囊里太长,且对不上"这是哪个模型" */
  const activeTextName = computed(() => {
    const c = textConfig.value
    if (!c) return 'Not set'
    return c.name || c.model || 'Not configured'
  })

  /* 参数面板按用途分开列出:出图、改写、识图与朗读各有各的"当前",混在一排里点谁生效说不清,
     而且文本/识图配置被 activateConfig 选中会顶掉出图用的接口。
     出图那条要排掉另外三类 —— 它们也走配置列表,但打的是对话端点或语音端点,拿来出图必错 */
  const imageConfigs = computed(() =>
    configs.value.filter((c) => c.kind !== 'text' && c.kind !== 'vision' && c.kind !== 'tts')
  )
  const textConfigs = computed(() => configs.value.filter((c) => c.kind === 'text'))
  const visionConfigs = computed(() => configs.value.filter((c) => c.kind === 'vision'))

  // 当前生效的厂商:配置里没写就按域名猜(兼容加字段之前存的老配置)
  const vendorId = computed(() => vendorOf(config.value))
  const provider = computed<Provider>(() => {
    // 带上模型:能力表按 (厂商, 模型) 解析 —— 中转上同一个地址的模型可能走不同协议
    return getProvider(vendorId.value, config.value.model)
  })
  /* 设置页表头那句能力说明:描述的是当前生效的那个接口,不是表单里正在挑的。
     界面上的参数门控本来就照生效配置来,说明文字要是跟着草稿走,两者就对不上了 */
  const capabilityNote = computed(() => {
    const p = provider.value
    const t = (c: Cap) => (c === 'yes' ? 'Yes' : c === 'no' ? 'No' : 'Varies')
    const i2i =
      p.protocol === 'gemini'
        ? ':generateContent'
        : p.edit === 'edits'
          ? '/images/edits'
          : '/images/generations'
    return `Active API: quality ${t(p.quality)} · background ${t(p.background)} · image-to-image via ${i2i}`
  })
  // 尺寸候选、是否开放手填、默认档 —— 判断都在 api.ts（见 T2.3）
  const sizeOptions = computed(() => sizeOptionsFor(vendorId.value, config.value.model))
  const sizeFree = computed(() => sizeIsFree(vendorId.value, config.value.model))
  const defaultSize = computed(() => defaultSizeFor(sizeOptions.value))

  const selectedConfigs = computed(() =>
    selectedIds.value
      .map((id) => configs.value.find((c) => c.id === id))
      .filter((c): c is ApiConfig => !!c)
  )
  const compareMode = computed(() => selectedConfigs.value.length > 1)

  function configured() {
    return !!config.value.baseUrl
  }

  /* —— 挑「当前生效」 ——
     四类各挑各的。挑法统一在 api.ts 的 pickActiveByKind:认「id 对得上且用途
     仍是这一类」,落空退到同类第一条 —— 一条都没有时,出图那侧清空、其余置 null */
  function repickActiveImage() {
    const next = pickActiveByKind(configs.value, 'image', activeId.value)
    if (next) {
      config.value = { ...next }
      activeId.value = next.id
      saveActiveId(next.id)
    } else {
      config.value = { id: '', name: '', baseUrl: '', apiKey: '', model: '', vendor: 'custom' }
      activeId.value = ''
      saveActiveId('')
    }
  }
  // 文本侧同理。没有文本配置时 textConfig 为 null 是正常态,增强按钮会提示去配一条
  function repickActiveText() {
    const next = pickActiveByKind(configs.value, 'text', activeTextId.value)
    if (next) activateTextConfig(next)
    else {
      textConfig.value = null
      activeTextId.value = ''
      saveActiveTextId('')
    }
  }
  // 识图侧同理:没有识图配置时 visionConfig 为 null,角色向导里会提示去配一条
  function repickActiveVision() {
    const next = pickActiveByKind(configs.value, 'vision', activeVisionId.value)
    if (next) activateVisionConfig(next)
    else {
      visionConfig.value = null
      activeVisionId.value = ''
      saveActiveVisionId('')
    }
  }
  /* 朗读侧同理。**它与上面三条有一处不同**:ttsConfig 为 null 不是错误态 ——
     朗读会自动走浏览器自带的语音,只是听起来不是这个角色自己的嗓子 */
  function repickActiveTts() {
    const next = pickActiveByKind(configs.value, 'tts', activeTtsId.value)
    if (next) activateTtsConfig(next)
    else {
      ttsConfig.value = null
      activeTtsId.value = ''
      saveActiveTtsId('')
    }
  }

  // 设某条配置为激活
  function activateConfig(c: ApiConfig) {
    config.value = { ...c }
    activeId.value = c.id
    saveActiveId(c.id)
  }
  // 设某条文本配置为当前生效(与 activateConfig 同一套做法,只是走文本那条通道)
  function activateTextConfig(c: ApiConfig) {
    textConfig.value = { ...c }
    activeTextId.value = c.id
    saveActiveTextId(c.id)
  }
  // 设某条识图配置为当前生效(同上,走识图那条通道)
  function activateVisionConfig(c: ApiConfig) {
    visionConfig.value = { ...c }
    activeVisionId.value = c.id
    saveActiveVisionId(c.id)
  }
  // 设某条朗读配置为当前生效(同上,走朗读那条通道)
  function activateTtsConfig(c: ApiConfig) {
    ttsConfig.value = { ...c }
    activeTtsId.value = c.id
    saveActiveTtsId(c.id)
  }

  /** 开一次启动时的挑选:把存着的「当前生效」对齐到列表里真实存在的那条 */
  function initConfigs() {
    configs.value = loadConfigs()
    activeId.value = loadActiveId()
    // 选中激活配置;无激活则取第一条出图配置(文本配置不能顶出图的当前位置)
    const active = pickActiveByKind(configs.value, 'image', activeId.value)
    if (active) {
      config.value = { ...active }
      /* 存着的 activeId 可能指向已被删掉的配置:一并回填成真正选中的那条。
         设置页的「当前」标记就是按 activeId 比的,不同步的话一条都不会亮 */
      if (activeId.value !== active.id) {
        activeId.value = active.id
        saveActiveId(active.id)
      }
      // 选择集合起手就是"当前这一条":单选是常态,多选是用户一个个点出来的
      selectedIds.value = [active.id]
    }
    const activeText = pickActiveByKind(configs.value, 'text', activeTextId.value)
    if (activeText) {
      textConfig.value = { ...activeText }
      if (activeTextId.value !== activeText.id) {
        activeTextId.value = activeText.id
        saveActiveTextId(activeText.id)
      }
    }
    const activeVision = pickActiveByKind(configs.value, 'vision', activeVisionId.value)
    if (activeVision) {
      visionConfig.value = { ...activeVision }
      if (activeVisionId.value !== activeVision.id) {
        activeVisionId.value = activeVision.id
        saveActiveVisionId(activeVision.id)
      }
    }
    // 朗读配置:没配时 ttsConfig 为 null 是正常的 —— 朗读会退回浏览器自带的语音
    const activeTts = pickActiveByKind(configs.value, 'tts', activeTtsId.value)
    if (activeTts) {
      ttsConfig.value = { ...activeTts }
      if (activeTtsId.value !== activeTts.id) {
        activeTtsId.value = activeTts.id
        saveActiveTtsId(activeTts.id)
      }
    }
  }

  // 新建一份配置(进入独立的新增接口表单页)。空态的四条入口会带一份预填好的 seed
  function newConfig(seed?: ApiConfig) {
    cfgSeed.value = seed ?? null
    cfgView.value = 'form'
  }
  // 复制已有配置:基于它生成一份新编辑(切到表单页)
  function duplicateConfig(c: ApiConfig) {
    cfgSeed.value = { ...c, id: '', name: c.name ? `${c.name} copy` : 'Config copy' }
    cfgView.value = 'form'
  }
  // 编辑已有配置:带入该配置,切到表单页
  function editConfig(c: ApiConfig) {
    cfgSeed.value = { ...c }
    cfgView.value = 'form'
  }
  function cancelConfig() {
    cfgView.value = 'list'
  }
  // 从参数面板进入接口设置页
  function openConfigManager() {
    cfgView.value = configs.value.length ? 'list' : 'form'
    // 种子清空:空表单页不该带着上一次编辑的内容
    cfgSeed.value = null
    deps.enterSettings()
  }
  // 从地址推导一个默认名称
  function cfgNameFromUrl(url: string): string {
    try {
      return new URL(url).host
    } catch {
      return url.replace(/^https?:\/\//, '').split('/')[0] || 'New config'
    }
  }

  function saveSettings(draft: ApiConfig) {
    const cfg = {
      ...draft,
      id: draft.id || uid(),
      name: draft.name.trim() || cfgNameFromUrl(draft.baseUrl)
    }
    const idx = configs.value.findIndex((c) => c.id === cfg.id)
    /* 这一条原来是什么用途。表单允许改用途(见设置页的 setPurpose),
       改过之后它必须从原来那一侧退场 —— 否则那一侧的「当前生效」
       还留着它改之前的快照:界面说当前用它,实际发出去的却已经不是一回事了 */
    const prevKind = idx >= 0 ? configs.value[idx].kind : undefined
    const kind = configKindOf(cfg)
    if (idx >= 0) configs.value[idx] = cfg
    else configs.value.push(cfg)
    saveConfigs(configs.value)

    // 换了用途 ⇒ 原来那一侧的「当前」必须重挑,不能留着一个已经不属于它的快照
    if (prevKind && prevKind !== kind) {
      if (prevKind === 'text') {
        if (activeTextId.value === cfg.id) repickActiveText()
      } else if (prevKind === 'vision') {
        if (activeVisionId.value === cfg.id) repickActiveVision()
      } else if (prevKind === 'tts') {
        if (activeTtsId.value === cfg.id) repickActiveTts()
      } else {
        if (activeId.value === cfg.id) repickActiveImage()
        // 它也不再参与出图的选择集合(那个集合决定这次发给哪些模型)
        selectedIds.value = selectedIds.value.filter((id) => id !== cfg.id)
        if (!selectedIds.value.length && config.value.id) selectedIds.value = [config.value.id]
      }
    }

    /* 按用途分派到各自的「当前生效」:四类各自独立,存一条不该把别类的当前项顶掉
       (反之亦然)。同步成副本而不是直接用 cfg —— 之后改表单草稿不能再牵动生效值。 */
    if (kind === 'text') {
      textConfig.value = { ...cfg }
      activeTextId.value = cfg.id
      saveActiveTextId(cfg.id)
    } else if (kind === 'vision') {
      visionConfig.value = { ...cfg }
      activeVisionId.value = cfg.id
      saveActiveVisionId(cfg.id)
    } else if (kind === 'tts') {
      ttsConfig.value = { ...cfg }
      activeTtsId.value = cfg.id
      saveActiveTtsId(cfg.id)
    } else {
      config.value = { ...cfg }
      activeId.value = cfg.id
      saveActiveId(cfg.id)
      /* 选择集合里必须有"当前"这条,否则参数行胶囊写着它、生成用的却是别的。
         新建一条时直接收敛成只选它(刚建好就是要用它);改一条已有的,
         缺了才补上,不能把正在做的多模型对比打散。已经选满则同样收敛 */
      if (!selectedIds.value.includes(cfg.id)) {
        selectedIds.value =
          idx < 0 || selectedIds.value.length >= RACE_MAX
            ? [cfg.id]
            : [...selectedIds.value, cfg.id]
      }
    }
    // 留在设置页看列表:刚存下的那条会带「当前」标记,比直接跳走更容易确认
    cfgView.value = 'list'
  }

  /* 删除一条配置;若删的是激活项,自动激活剩余第一条。
     删除本身立刻改列表,但落盘推迟到撤销窗口结束 —— 于是"撤销"只要把这一条
     放回去、并把「当前生效」的指向恢复即可,不必从磁盘上搬回来。
     恢复时用的是"当前列表 + 插回这一条",不是整份旧快照:
     窗口里万一正好改了别的配置,不该被这次撤销一起回滚 */
  function removeConfig(c: ApiConfig) {
    const at = configs.value.findIndex((x) => x.id === c.id)
    if (at < 0) return
    const wasActive = activeId.value === c.id
    const wasActiveText = activeTextId.value === c.id
    const wasActiveVision = activeVisionId.value === c.id
    const wasActiveTts = activeTtsId.value === c.id
    const wasSelected = selectedIds.value.includes(c.id)

    /* 选择集合里也要摘掉它:被删的那条不再参与生成,但它留在集合里会让
       长度算错 —— 剩两条其实只剩一条,却仍被当成对比模式。摘完一个不剩就退回当前这条 */
    configs.value = configs.value.filter((x) => x.id !== c.id)
    // 占着各自「当前生效」的那条被删掉时,同样要按用途重新挑一条,免得生效值悬空
    if (wasActiveText) repickActiveText()
    if (wasActiveVision) repickActiveVision()
    if (wasActiveTts) repickActiveTts()
    if (wasActive) repickActiveImage()
    selectedIds.value = selectedIds.value.filter((id) => id !== c.id)
    if (!selectedIds.value.length && config.value.id) selectedIds.value = [config.value.id]

    deps.scheduleUndo({
      label: 'Config deleted',
      undo: () => {
        configs.value = [
          ...configs.value.slice(0, Math.min(at, configs.value.length)),
          c,
          ...configs.value.slice(Math.min(at, configs.value.length))
        ]
        if (wasSelected && !selectedIds.value.includes(c.id)) {
          selectedIds.value = [...selectedIds.value, c.id]
        }
        // 恢复「当前生效」的指向。它当初是被这次删除夺走的,现在物归原主
        if (wasActive) {
          config.value = { ...c }
          activeId.value = c.id
          saveActiveId(c.id)
        }
        if (wasActiveText) {
          textConfig.value = { ...c }
          activeTextId.value = c.id
          saveActiveTextId(c.id)
        }
        if (wasActiveVision) {
          visionConfig.value = { ...c }
          activeVisionId.value = c.id
          saveActiveVisionId(c.id)
        }
        if (wasActiveTts) {
          ttsConfig.value = { ...c }
          activeTtsId.value = c.id
          saveActiveTtsId(c.id)
        }
        saveConfigs(configs.value)
      },
      purge: () => saveConfigs(configs.value)
    })
  }

  /* 导入的配置来自外部文件,逐条规整:没有 baseUrl 的存下来也发不出请求;
     id 若和现有的撞了必须换新的,否则列表里两条同 id,渲染和删除都会错乱 */
  function importConfigs(list: ApiConfig[]) {
    /* 撞 id 就换新的。这里必须维护一份"这次已经用掉的 id",不能只跟现有列表比:
       map 期间 configs.value 不变,同一个文件里两条同 id 会双双通过 */
    const seen = new Set(configs.value.map((c) => c.id))
    const clean: ApiConfig[] = list
      .filter((c) => c && typeof c.baseUrl === 'string' && c.baseUrl.trim())
      .map((c) => {
        let id = typeof c.id === 'string' && c.id ? c.id : uid()
        if (seen.has(id)) id = uid()
        seen.add(id)
        return {
          id,
          name: typeof c.name === 'string' && c.name.trim() ? c.name : cfgNameFromUrl(c.baseUrl),
          baseUrl: c.baseUrl.trim(),
          apiKey: typeof c.apiKey === 'string' ? c.apiKey : '',
          model: typeof c.model === 'string' ? c.model : '',
          vendor: typeof c.vendor === 'string' ? c.vendor : 'custom',
          // 外部文件的脏数据不该让配置错类:只认得出 text / vision / tts,其余一律当出图
          kind:
            c.kind === 'text'
              ? ('text' as const)
              : c.kind === 'vision'
                ? ('vision' as const)
                : c.kind === 'tts'
                  ? ('tts' as const)
                  : ('image' as const),
          /* 朗读那条的资源标识。丢掉它的话,导入进来的朗读配置会变成
             "地址与密钥都对、但每次请求都被上游拒掉(access denied)",
             而原因藏在一格看不见的字段里 */
          ...(typeof c.resourceId === 'string' && c.resourceId.trim()
            ? { resourceId: c.resourceId.trim() }
            : {})
        }
      })
    if (!clean.length) return
    // 追加而不是覆盖:导入是补充,不该把现有配置清掉
    configs.value = [...clean, ...configs.value]
    saveConfigs(configs.value)
    /* 原本一条都没配(生成会被拦下来)时,顺手把导入里第一条出图配置设为当前,
       不然导完照样发不出请求 */
    if (!configured()) {
      const first = configs.value.find(
        (c) => c.kind !== 'text' && c.kind !== 'vision' && c.kind !== 'tts'
      )
      if (first) {
        config.value = { ...first }
        activeId.value = first.id
        saveActiveId(first.id)
      }
    }
    // 文本那边同理:还没有当前生效的文本配置时,取导入进来(或现有)的第一条文本配置
    if (!textConfig.value) {
      const nextText = configs.value.find((c) => c.kind === 'text')
      if (nextText) activateTextConfig(nextText)
    }
    // 识图那边同理 —— 三类「当前」互不隶属,缺哪一条就补哪一条
    if (!visionConfig.value) {
      const nextVision = configs.value.find((c) => c.kind === 'vision')
      if (nextVision) activateVisionConfig(nextVision)
    }
  }

  return {
    // 状态
    configs,
    config,
    activeId,
    textConfig,
    activeTextId,
    visionConfig,
    activeVisionId,
    ttsConfig,
    activeTtsId,
    cfgView,
    cfgSeed,
    selectedIds,
    RACE_MAX,
    // 派生
    activeConfigName,
    activeTextName,
    imageConfigs,
    textConfigs,
    visionConfigs,
    vendorId,
    provider,
    capabilityNote,
    sizeOptions,
    sizeFree,
    defaultSize,
    selectedConfigs,
    compareMode,
    // 读
    configured,
    // 挑与激活
    initConfigs,
    repickActiveImage,
    repickActiveText,
    repickActiveVision,
    repickActiveTts,
    activateConfig,
    activateTextConfig,
    activateVisionConfig,
    activateTtsConfig,
    // 增删改
    newConfig,
    duplicateConfig,
    editConfig,
    cancelConfig,
    openConfigManager,
    saveSettings,
    removeConfig,
    importConfigs,
    cfgNameFromUrl
  }
}

/** 这一组东西的形状:别处要声明"一整份配置域"时用它 */
export type ConfigsApi = ReturnType<typeof useConfigs>
