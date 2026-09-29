<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import {
  PhMaskHappy,
  PhPlus,
  PhCalendar,
  PhClockCounterClockwise,
  PhTrash,
  PhSparkle,
  PhArrowLeft,
  PhArrowRight,
  PhArrowsClockwise,
  PhArrowsOutSimple,
  PhCaretLeft,
  PhCaretRight,
  PhCheck,
  PhEye,
  PhLockSimple,
  PhX
} from '@phosphor-icons/vue'
import { CHARACTER_VIEWS, coverSrc, draftCharacterFields } from '../api'
import LatticeLoader from './LatticeLoader.vue'
import type {
  ApiConfig,
  Character,
  CharacterFields,
  CharacterStat,
  CharacterView,
  CharacterViewKind
} from '../types'

/* 角色:网站的重点页面。
   一个角色 = 一组设定图 + 一段结构化设定。设定图是它的骨架 ——
   正脸当锚,其余四张都以正脸为参考图生成,这是跨图保持同一张脸的唯一办法。

   这一页只管展示与编排:生成、落盘、存储都在主界面 ——
   参考图与设定的字节归 App/IndexedDB 管,这里只发意图(与预览卡同一套分工) */

const props = defineProps<{
  characters: Character[]
  // 按角色 id 缓存的设定图。主界面按需从 IndexedDB 取,这里只读
  views: Record<string, CharacterView[]>
  /* 按角色 id 聚合的用量(生成次数 / 最后使用时间)。源数据是历史记录,
     主界面算好传进来 —— 这一页不碰历史 */
  stats: Record<string, CharacterStat>
  // 正在生成哪一张视图(空 = 空闲)。同一时间只跑一张
  busy: string
  // 起稿要用的文本模型配置。没配就走不了 AI 起稿,但手填照常
  textConfig?: ApiConfig
}>()

/** 表单草稿:设定拆成五项,参考图先收成 data URL ——
 *  压小成 Blob 是主界面的事(与参考图存档同一档参数) */
type DraftForm = { name: string; fields: CharacterFields; desc: string; ref: string }

const emit = defineEmits<{
  (e: 'save', payload: { name: string; fields: CharacterFields; desc: string; refData: string }): void
  (e: 'remove', id: string): void
  (e: 'open', id: string): void
  // 拿这个角色去开画:套上角色并切回工作台,由主界面负责跳转
  (e: 'create', id: string): void
  (e: 'generate', charId: string, kind: CharacterViewKind): void
  (e: 'generateAll', charId: string): void
  (e: 'useRef', charId: string, kind: CharacterViewKind): void
}>()

function emptyFields(): CharacterFields {
  return { identity: '', hair: '', eyes: '', outfit: '', marks: '' }
}

/* 两个视图态:列表(空)与详情(有 id)。
   设定图与五项设定都挪进详情 —— 五张图加五项挤在一张卡上,
   既不好看也点不明白:点已有图会重新生成、想看大图又没地方看 */
const detailId = ref('')
// 正在全屏看的那张视图(空 = 没在看)
const viewer = ref<CharacterViewKind | ''>('')
// 正在编辑(新建)的表单
const editing = ref(false)
const draft = ref<DraftForm>({ name: '', fields: emptyFields(), desc: '', ref: '' })
// 起稿:一句话 + 请求状态 + 它自己的报错(不占用生图那套错误出口)
const idea = ref('')
const drafting = ref(false)
const draftError = ref('')

const detailChar = computed(() => props.characters.find((c) => c.id === detailId.value))

function viewOf(charId: string, kind: CharacterViewKind): CharacterView | undefined {
  return props.views[charId]?.find((v) => v.kind === kind)
}

/* 还没用过的角色:给一个共享的空值,省得每次渲染都造新对象 */
const NO_STAT: CharacterStat = { count: 0, lastAt: 0 }
function statOf(id: string): CharacterStat {
  return props.stats[id] || NO_STAT
}

/** 时间戳的短格式,与历史页同一档:只到分钟,不带年份 */
function fmtStamp(ts: number) {
  const d = new Date(ts)
  const p = (x: number) => String(x).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** 只到日的写法:卡片上的"创建 / 最后使用"要的是哪一天,不是几点 */
function fmtDay(ts: number) {
  const d = new Date(ts)
  const p = (x: number) => String(x).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** 卡片上的身份行:设定的第一项就是"这是谁"(摄影师、赛博武士)。
 *  老角色只有自由描述时退回描述 —— 不摆一句 "No spec yet" 让人以为数据丢了 */
function roleOf(c: Character) {
  return (c.fields?.identity || '').trim() || (c.desc || '').trim() || 'No spec yet'
}

/** 特征胶囊:设定的后四项,最多三枚 —— 卡片上只放得下这么多,
 *  完整的五项在详情页 */
function traitsOf(c: Character): string[] {
  const f = c.fields
  if (!f) return []
  return [f.hair, f.eyes, f.outfit, f.marks]
    .map((s) => (s || '').trim())
    .filter(Boolean)
    .slice(0, 3)
}

/** 详情页那一行用量:生成次数 → 创建时间 → 最后使用。
 *  没有的部分不占位 —— 一个刚建的角色只该说"还没用过",不该出现空的"最后使用" */
const heroMeta = computed(() => {
  const c = detailChar.value
  if (!c) return []
  const s = statOf(c.id)
  const out = [
    s.count ? `${s.count} generations` : 'Not used yet',
    `Created ${fmtStamp(c.createdAt)}`
  ]
  if (s.lastAt) out.push(`Last used ${fmtStamp(s.lastAt)}`)
  return out
})

/** 头像优先用正脸:圆形容器裁的是一张脸。主参考图可能被设成全身图,
 *  裁进圆里就只剩半截身子。没有正脸时才退回主参考图 */
const avatarSrc = computed(() => {
  const c = detailChar.value
  if (!c) return ''
  return coverSrc(viewOf(c.id, 'front')?.data ?? c.ref)
})

/** 设定图网格的五格:修饰词与取景来自 CHARACTER_VIEWS,内容是当前已有的那张 */
const sheetCells = computed(() =>
  CHARACTER_VIEWS.map((v) => ({ ...v, view: viewOf(detailId.value, v.kind) }))
)

const filledCount = computed(() => sheetCells.value.filter((c) => c.view).length)
const missingCount = computed(() => sheetCells.value.length - filledCount.value)

/** 正脸在不在。其余四张都以它为参考图,所以它是这条流水线的前置 ——
 *  没有它时那四格是"上锁"而不是"可点但会报错"(见 App 的 genCharView 守卫) */
const hasFront = computed(() => !!viewOf(detailId.value, 'front'))

/** 这一格现在能不能点。除正脸外的空格子,要先有正脸 ——
 *  与其让它点下去弹一句"先生成正脸",不如直接锁住,把顺序摆在明面上 */
function isLocked(kind: CharacterViewKind) {
  return kind !== 'front' && !hasFront.value
}

/** 主参考图来自哪张视图。不比对 Blob:刷新后主图与视图是两次独立的读取,不是同一个实例 */
const refKind = computed(() => detailChar.value?.refKind)
const refLabel = computed(() => CHARACTER_VIEWS.find((v) => v.kind === refKind.value)?.label || '')

/** 正在生成的那张是哪个视图。面板下方要说清在等哪一张 */
const busyLabel = computed(() => CHARACTER_VIEWS.find((v) => v.kind === props.busy)?.label || '')

/* 一次补齐的按钮文案。五张齐了就该停下 —— 原来写成"Generate the rest",
   全部齐了也能点,点了却什么都不发生,看着像坏了 */
const generateAllLabel = computed(() => {
  if (!missingCount.value) return 'All views ready'
  return viewOf(detailId.value, 'front') ? `Generate ${missingCount.value} more` : 'Generate all views'
})

// 大图里能翻的只有"已经有图"的那几张,空位不参与
const viewerKinds = computed(() =>
  CHARACTER_VIEWS.map((v) => v.kind).filter((k) => viewOf(detailId.value, k))
)
const viewerSrc = computed(() => {
  if (!viewer.value) return ''
  const v = viewOf(detailId.value, viewer.value)
  return v ? coverSrc(v.data) : ''
})
const viewerLabel = computed(
  () => CHARACTER_VIEWS.find((v) => v.kind === viewer.value)?.label || ''
)

function isBusy(kind: string) {
  return props.busy === kind
}

function openDetail(id: string) {
  detailId.value = id
  viewer.value = ''
  // 进详情才去取图:列表阶段一张都不读 IndexedDB
  emit('open', id)
  window.scrollTo({ top: 0, behavior: 'smooth' })
}

function backToList() {
  detailId.value = ''
  viewer.value = ''
}

/* 大图是个模态框:打开时把焦点收进来,关闭时还回原来那张格子 ——
   不还回去的话,键盘用户关掉大图后焦点会掉到 body 上,得从头 Tab 一遍 */
const viewerBox = ref<HTMLElement | null>(null)
let restoreFocus: HTMLElement | null = null

function openViewer(kind: CharacterViewKind) {
  restoreFocus = document.activeElement as HTMLElement | null
  viewer.value = kind
  nextTick(() => viewerBox.value?.focus())
}
function closeViewer() {
  viewer.value = ''
  nextTick(() => restoreFocus?.focus())
  restoreFocus = null
}
/** 把 Tab 圈在大图内部。不用 inert 关掉整个应用 —— 那要动主界面,
 *  而这个框里只有几个按钮,一个循环就够了 */
function trapTab(e: KeyboardEvent) {
  const box = viewerBox.value
  if (!box) return
  const items = Array.from(box.querySelectorAll<HTMLElement>('button:not([disabled])'))
  if (!items.length) return
  const first = items[0]
  const last = items[items.length - 1]
  const at = document.activeElement as HTMLElement | null
  // 焦点还停在容器本身(刚打开时):下一个 Tab 直接进第一个控件
  if (!at || !items.includes(at)) {
    e.preventDefault()
    ;(e.shiftKey ? last : first).focus()
    return
  }
  if (e.shiftKey && at === first) {
    e.preventDefault()
    last.focus()
  } else if (!e.shiftKey && at === last) {
    e.preventDefault()
    first.focus()
  }
}
/** 在大图里前后翻。到头就绕回另一头:只有几张图,循环比禁用更好用 */
function stepViewer(dir: number) {
  const cur = viewer.value
  const list = viewerKinds.value
  if (!cur || list.length < 2) return
  const at = list.indexOf(cur)
  viewer.value = list[(at + dir + list.length) % list.length]
}

// 大图上的两个动作:针对"正在看的那张"。空态直接不发,免得把空串当视图名传下去
function regenerateViewer() {
  const c = detailChar.value
  if (c && viewer.value) emit('generate', c.id, viewer.value)
}
function applyViewerRef() {
  const c = detailChar.value
  if (c && viewer.value) emit('useRef', c.id, viewer.value)
}

/* Esc 逐层退:先关大图,再回列表 ——
   开着大图按 Esc 直接退出详情会让人丢掉"我看的是哪个角色"。
   左右键在大图里翻页,和预览卡同一套操作 */
function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    if (viewer.value) closeViewer()
    else if (detailId.value) backToList()
    return
  }
  if (!viewer.value) return
  if (e.key === 'Tab') trapTab(e)
  else if (e.key === 'ArrowLeft') stepViewer(-1)
  else if (e.key === 'ArrowRight') stepViewer(1)
}
onMounted(() => window.addEventListener('keydown', onKey))
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))

function startEdit() {
  draft.value = { name: '', fields: emptyFields(), desc: '', ref: '' }
  idea.value = ''
  draftError.value = ''
  // 向导从头开始:上一次留下的 id 与步数必须清掉,否则会直接跳进旧角色的第 3 步
  step.value = 1
  wizardId.value = ''
  editing.value = true
}

/* —— 新建向导 ——
   建角色本来是"填表 → 存 → 出图"一条线,拆成两页看着像两件事。
   现在摊成三步:基础信息(或参考图)→ 主视图 → 其余设定图,
   每步一张卡,步骤条在卡头上说明"现在在哪、还差什么"。

   角色在第 1 步保存时落库 —— 第 2、3 步都要 charId 才能出图。
   所以第 1 步存下之后转成只读摘要:这一页没有"改角色",
   留着可编辑的表单只会让人再点一次保存,多出一个副本 */
type WizardStep = 1 | 2 | 3

const STEPS: Array<{ n: WizardStep; label: string }> = [
  { n: 1, label: 'Basics' },
  { n: 2, label: 'Main view' },
  { n: 3, label: 'Other views' }
]

const step = ref<WizardStep>(1)
// 向导进行中的角色 id。第 1 步存完才有,后两步都靠它取图
const wizardId = ref('')

const wizardChar = computed(() => props.characters.find((c) => c.id === wizardId.value))
function wizardViewOf(kind: CharacterViewKind): CharacterView | undefined {
  return props.views[wizardId.value]?.find((v) => v.kind === kind)
}
const wizardFront = computed(() => wizardViewOf('front'))
// 第 3 步的四张,主视图不在其中
const wizardRest = computed(() =>
  CHARACTER_VIEWS.filter((v) => v.kind !== 'front').map((v) => ({ ...v, view: wizardViewOf(v.kind) }))
)
const restMissing = computed(() => wizardRest.value.filter((c) => !c.view).length)
/* 一次补齐的按钮文案。四张齐了就该停下 —— 齐了还能点、点了没反应,看着像坏了 */
const restLabel = computed(() =>
  restMissing.value ? `Generate ${restMissing.value} remaining` : 'All views ready'
)

/** 这一步能不能进。第 2 步要有角色,第 3 步要有主视图 ——
 *  前置没做完的那一步直接锁住,点不动,顺序就不必靠弹错来教 */
function stepUnlocked(n: WizardStep): boolean {
  if (n === 1) return true
  if (n === 2) return !!wizardId.value
  return !!wizardFront.value
}
/** 这一步做完没有。做完的在步骤条上打勾,和"正在这一步"区分开 */
function stepDone(n: WizardStep): boolean {
  if (n === 1) return !!wizardId.value
  if (n === 2) return !!wizardFront.value
  return false
}
function goStep(n: WizardStep) {
  if (stepUnlocked(n)) step.value = n
}
/** 步骤条上两段连接线:x-1 与 x 之间那段,只在前一步做完时才点亮 */
function lineDone(n: WizardStep): boolean {
  return n > 1 && stepDone((n - 1) as WizardStep)
}
function backStep() {
  if (step.value > 1) step.value = (step.value - 1) as WizardStep
}

/** 第 1 步存完由父组件回调:拿到 id,推进到主视图那一步。
 *  中间不退到列表 —— 这条向导是一口气走完的 */
function onSaved(id: string) {
  wizardId.value = id
  step.value = 2
  // 后两步要读这个角色的图,先把它的图取出来
  emit('open', id)
}
defineExpose({ onSaved })

/** 退出向导。第 1 步还没存,退了就当没发生;
 *  存过之后角色已经在库里,退了它自己会出现在列表里 */
function closeWizard() {
  editing.value = false
  step.value = 1
  wizardId.value = ''
  draftError.value = ''
}

/** 走完三步:把角色交给详情页 —— 那里是它的"落地页",
 *  有完整设定表、大图查看,以及"用它开画" */
function finishWizard() {
  const id = wizardId.value
  closeWizard()
  if (id) openDetail(id)
}

/* 起稿:一句话交给文本模型拆成五项设定,回填后可逐项修改。
   只填字段、不出图 —— 先校对再花钱。结果只落在这张表单里,不写库 */
async function draftWithAI() {
  const text = idea.value.trim()
  if (!text || drafting.value) return
  const cfg = props.textConfig
  if (!cfg || !cfg.model || !cfg.baseUrl) {
    draftError.value = 'Set up prompt enhancing in API settings first.'
    return
  }
  drafting.value = true
  draftError.value = ''
  try {
    const f = await draftCharacterFields(cfg, text)
    // 一项都没解出来 = 模型没按那个格式回。如实说,别假装已经填好了
    if (!Object.values(f).some((s) => s.trim())) {
      draftError.value =
        'The model did not return a usable spec. Fill the fields by hand, or try another text model.'
      return
    }
    draft.value.fields = f
  } catch (e: any) {
    draftError.value = e?.message || 'Could not draft the character'
  } finally {
    drafting.value = false
  }
}

function onPickRef(e: Event) {
  const file = (e.target as HTMLInputElement).files?.[0]
  if (!file) return
  const reader = new FileReader()
  reader.onload = () => (draft.value.ref = String(reader.result))
  reader.readAsDataURL(file)
  ;(e.target as HTMLInputElement).value = ''
}

function submit() {
  const d = draft.value
  if (!d.name.trim()) return
  // 字段与参考图各拷一份交出去,免得表单被继续改动时牵动已经发出的这次保存
  emit('save', { name: d.name, fields: { ...d.fields }, desc: d.desc, refData: d.ref })
  /* 这里不推进也不关表单:存完由父组件回调 onSaved 推向导走下一步 ——
     save 是异步的,现在改步数会在角色还没进列表时先跳到"主视图",
     那一格既没有 id 也没有图。存失败时表单留着,改完可以直接再点一次 */
}

/** 设定的摘要:把非空的项连起来给卡片当副标题 */
function summary(c: Character) {
  const f = c.fields
  if (!f) return c.desc || 'No spec yet'
  return [f.identity, f.hair, f.eyes, f.outfit, f.marks].filter((s) => s && s.trim()).join(' · ')
}

// 详情页的规格表:五项固定设定按顺序排,再做一条可选的备注
const SPEC_LABELS: Array<[keyof CharacterFields, string]> = [
  ['identity', 'Identity'],
  ['hair', 'Hair'],
  ['eyes', 'Eyes'],
  ['outfit', 'Outfit'],
  ['marks', 'Marks']
]
function specRows(c: Character) {
  const f = c.fields || emptyFields()
  const rows = SPEC_LABELS.map(([k, label]) => ({ label, value: (f[k] || '').trim() }))
  const notes = (c.desc || '').trim()
  if (notes) rows.push({ label: 'Notes', value: notes })
  return rows
}
</script>

<template>
  <div class="chars">
    <!-- —— 列表 —— -->
    <template v-if="!detailChar">
      <header class="chars-head">
        <div>
          <h1 class="chars-title">Characters</h1>
          <p class="chars-sub">
            A fixed spec plus a set of reference views. Pick a character while composing and both are
            applied, so the face stays the same across images.
          </p>
        </div>
        <button v-if="!editing" class="chars-new" @click="startEdit">
          <PhPlus aria-hidden="true" />
          New character
        </button>
      </header>

      <!-- —— 新建向导 ——
           三步摊成一张卡:步骤条在头上,内容在中间,进退在脚下。
           没做到的那一步在条上是锁的,点不动 —— 顺序靠结构说,不靠报错说 -->
      <section v-if="editing" class="wizard">
        <nav class="wz-steps" aria-label="Creation steps">
          <template v-for="s in STEPS" :key="s.n">
            <span
              v-if="s.n > 1"
              class="wz-line"
              :class="{ 'is-done': lineDone(s.n) }"
              aria-hidden="true"
            ></span>
            <button
              class="wz-step"
              :class="{
                'is-active': step === s.n,
                'is-done': stepDone(s.n) && step !== s.n,
                'is-locked': !stepUnlocked(s.n)
              }"
              :disabled="!stepUnlocked(s.n)"
              :aria-current="step === s.n ? 'step' : undefined"
              @click="goStep(s.n)"
            >
              <span class="wz-dot">
                <PhCheck v-if="stepDone(s.n) && step !== s.n" weight="bold" aria-hidden="true" />
                <template v-else>{{ s.n }}</template>
              </span>
              <span class="wz-name">{{ s.label }}</span>
            </button>
          </template>
        </nav>

        <!-- 第 1 步:基础信息 / 参考图。存下之前是可填的表单,
             存下之后换成只读摘要(角色已经落库,再点一次保存只会多一个副本) -->
        <div v-if="step === 1" class="wz-pane">
          <template v-if="!wizardId">
            <div class="wz-lead">
              <h3 class="wz-h">Basics</h3>
              <p class="wz-p">
                One line is enough — let the model draft the spec, then fix what it got wrong. A
                reference image is optional, but it pins the shape far better than words can.
              </p>
            </div>

            <input
              v-model="draft.name"
              class="ed-input"
              placeholder="Name"
              aria-label="Character name"
            />

            <div class="ed-draft">
              <input
                v-model="idea"
                class="ed-input"
                placeholder="One line, e.g. cyberpunk female warrior"
                aria-label="Character idea"
                @keyup.enter="draftWithAI"
              />
              <button class="ed-btn primary" :disabled="drafting || !idea.trim()" @click="draftWithAI">
                <PhSparkle aria-hidden="true" />
                {{ drafting ? 'Drafting…' : 'Draft with AI' }}
              </button>
            </div>

            <div class="ed-fields">
              <label class="ed-label" for="cp-identity">Identity</label>
              <input
                id="cp-identity"
                v-model="draft.fields.identity"
                class="ed-input"
                placeholder="cyberpunk female warrior"
              />
              <label class="ed-label" for="cp-hair">Hair</label>
              <input
                id="cp-hair"
                v-model="draft.fields.hair"
                class="ed-input"
                placeholder="short silver hair"
              />
              <label class="ed-label" for="cp-eyes">Eyes</label>
              <input
                id="cp-eyes"
                v-model="draft.fields.eyes"
                class="ed-input"
                placeholder="glowing blue optics"
              />
              <label class="ed-label" for="cp-outfit">Outfit</label>
              <input
                id="cp-outfit"
                v-model="draft.fields.outfit"
                class="ed-input"
                placeholder="armored jacket, neon trim"
              />
              <label class="ed-label" for="cp-marks">Marks</label>
              <input
                id="cp-marks"
                v-model="draft.fields.marks"
                class="ed-input"
                placeholder="scar over left brow, chrome arm"
              />
            </div>

            <input
              v-model="draft.desc"
              class="ed-input"
              placeholder="Anything else (optional)"
              aria-label="Extra notes"
            />

            <!-- 参考图可选:有图时它能直接定形状,比让模型照文字猜准得多 -->
            <div class="ed-ref">
              <img v-if="draft.ref" class="ed-thumb" :src="draft.ref" alt="Reference" />
              <label v-else class="ed-pick" for="cp-file">+ Reference image (optional)</label>
              <button v-if="draft.ref" class="ed-btn" @click="draft.ref = ''">Remove image</button>
            </div>

            <p v-if="draftError" class="ed-err" role="alert">{{ draftError }}</p>
          </template>

          <template v-else-if="wizardChar">
            <div class="wz-lead">
              <h3 class="wz-h">Basics</h3>
              <p class="wz-p">Saved. This spec is what every view is built from.</p>
            </div>
            <div class="wz-sum">
              <span class="wz-sum-name">{{ wizardChar.name }}</span>
              <img
                v-if="wizardChar.ref"
                class="ed-thumb"
                :src="coverSrc(wizardChar.ref)"
                alt="Reference"
              />
            </div>
            <dl class="spec">
              <template v-for="r in specRows(wizardChar)" :key="r.label">
                <dt class="spec-k">{{ r.label }}</dt>
                <dd class="spec-v" :class="{ dim: !r.value }">{{ r.value || '—' }}</dd>
              </template>
            </dl>
          </template>
        </div>

        <!-- 第 2 步:主视图。它是整条流水线的锚,其余四张都照它生成 -->
        <div v-else-if="step === 2" class="wz-pane">
          <div class="wz-lead">
            <h3 class="wz-h">Main view</h3>
            <p class="wz-p">
              The anchor every other view is built from, so it pays to get this one right before
              moving on. Uploaded a reference image? That already works as the main one.
            </p>
          </div>

          <div class="wz-focus">
            <div class="cell">
              <button
                v-if="wizardFront"
                class="cell-img has-img"
                :disabled="!!props.busy"
                aria-label="Regenerate the main view"
                @click="emit('generate', wizardId, 'front')"
              >
                <img :src="coverSrc(wizardFront.data)" alt="" />
                <span class="cell-zoom" aria-hidden="true"><PhArrowsClockwise /></span>
              </button>
              <button
                v-else
                class="cell-img start"
                :class="{ busy: isBusy('front') }"
                :disabled="!!props.busy"
                aria-label="Generate the main view"
                @click="emit('generate', wizardId, 'front')"
              >
                <span class="cell-ph" aria-hidden="true">+</span>
              </button>
              <span class="cell-label">{{ isBusy('front') ? 'Generating…' : 'Front' }}</span>
            </div>
          </div>
        </div>

        <!-- 第 3 步:其余四张。一律以主视图为参考图 —— 这就是"同一张脸"的保证 -->
        <div v-else class="wz-pane">
          <div class="wz-lead">
            <div class="wz-lead-row">
              <h3 class="wz-h">Other views</h3>
              <button
                class="ed-btn"
                :disabled="!!props.busy || !restMissing"
                @click="emit('generateAll', wizardId)"
              >
                <PhSparkle aria-hidden="true" />
                {{ restLabel }}
              </button>
            </div>
            <p class="wz-p">
              Each of these is built from the main view. Generate them one at a time, or all at
              once — failing early stops the run instead of burning four more calls.
            </p>
          </div>

          <div class="wz-grid">
            <div v-for="cell in wizardRest" :key="cell.kind" class="cell">
              <button
                v-if="cell.view"
                class="cell-img has-img"
                :disabled="!!props.busy"
                :aria-label="`Regenerate the ${cell.label} view`"
                @click="emit('generate', wizardId, cell.kind)"
              >
                <img :src="coverSrc(cell.view.data)" alt="" />
                <span class="cell-zoom" aria-hidden="true"><PhArrowsClockwise /></span>
              </button>
              <button
                v-else
                class="cell-img"
                :class="{ busy: isBusy(cell.kind) }"
                :disabled="!!props.busy"
                :aria-label="`Generate the ${cell.label} view`"
                @click="emit('generate', wizardId, cell.kind)"
              >
                <span class="cell-ph" aria-hidden="true">+</span>
              </button>
              <span class="cell-label">{{ cell.label }}</span>
            </div>
          </div>
        </div>

        <div class="wz-foot">
          <button
            v-if="step === 1 && !wizardId"
            class="ed-btn primary"
            :disabled="!draft.name.trim()"
            @click="submit"
          >
            Save &amp; continue
          </button>
          <button v-else-if="step === 1" class="ed-btn primary" @click="goStep(2)">
            Next: main view
          </button>
          <button
            v-else-if="step === 2"
            class="ed-btn primary"
            :disabled="!wizardFront"
            @click="goStep(3)"
          >
            Next: other views
          </button>
          <button v-else class="ed-btn primary" @click="finishWizard">Done</button>

          <button v-if="step > 1" class="ed-btn" @click="backStep">Back</button>
          <button class="ed-btn" @click="closeWizard">
            {{ step === 1 && !wizardId ? 'Cancel' : 'Close' }}
          </button>
        </div>
      </section>

      <!-- 列表:角色海报卡。顶图全出血铺满整张卡,底部渐变暗幕托起白字;
           无边框、靠阴影浮起,圆角加大到 24px。
           卡里有两个动作:点空白处进详情(一张透明覆盖按钮),以及
           "Create with this character" 直接拿这个角色开画 ——
           按钮不能嵌在按钮里,所以整卡命中区改成覆盖式的一层,内容区透传点击 -->
      <div v-if="props.characters.length" class="grid">
        <article v-for="c in props.characters" :key="c.id" class="ctile">
          <div class="ctile-main">
            <!-- 顶图:绝对铺满,海报式取景 -->
            <span class="ctile-img">
              <img v-if="c.ref" :src="coverSrc(c.ref)" alt="" loading="lazy" decoding="async" />
              <span v-else class="ctile-ph" aria-hidden="true">
                <PhMaskHappy />
              </span>
            </span>
            <!-- 底部渐变暗幕:透明→深,白字在任何图上都可读。
                 覆盖照片(非界面),刻意不走 token,与预览卡/详情格同一套 -->
            <span class="ctile-veil" aria-hidden="true"></span>

            <!-- 文本叠在暗幕上,白字,贴底排列。
                 pointer-events 由 CSS 透传,只有下面的 CTA 例外 -->
            <span class="ctile-content">
              <!-- 名字与快捷开画同一行:名字占满剩余,按钮靠右收在末尾 -->
              <span class="ctile-head">
                <span class="ctile-name">{{ c.name }}</span>
                <!-- 快捷开画:套上这个角色直接回工作台,省掉"进详情→记住名字→
                     切回首页→再选一次"那条绕路。
                     卡最窄只有 260px,一行里放不下整句,所以按钮上只写 Create ——
                     完整含义留在 aria-label 里,读屏拿得到 -->
                <button
                  class="ctile-cta"
                  :aria-label="`Create with ${c.name}`"
                  @click="emit('create', c.id)"
                >
                  <span>Create</span>
                  <PhArrowRight class="ctile-cta-ico" aria-hidden="true" />
                </button>
              </span>
              <span class="ctile-role">{{ roleOf(c) }}</span>
              <span v-if="traitsOf(c).length" class="ctile-chips">
                <span v-for="t in traitsOf(c)" :key="t" class="chip">{{ t }}</span>
              </span>

              <!-- 用量:三格 + 竖向分隔,白字压在暗幕上。
                   全是真数(从历史记录按 characterId 聚合,见 App 的 charStats) -->
              <span class="ctile-stats">
                <span class="cstat">
                  <span class="cstat-h">
                    <PhSparkle class="cstat-ico" aria-hidden="true" />
                    <span class="cstat-v">{{ statOf(c.id).count }}</span>
                  </span>
                  <span class="cstat-k">images</span>
                </span>
                <span class="cstat">
                  <span class="cstat-h">
                    <PhCalendar class="cstat-ico" aria-hidden="true" />
                    <span class="cstat-v">{{ fmtDay(c.createdAt) }}</span>
                  </span>
                  <span class="cstat-k">created</span>
                </span>
                <span class="cstat">
                  <span class="cstat-h">
                    <PhClockCounterClockwise class="cstat-ico" aria-hidden="true" />
                    <span class="cstat-v">
                      {{ statOf(c.id).lastAt ? fmtDay(statOf(c.id).lastAt) : '—' }}
                    </span>
                  </span>
                  <span class="cstat-k">updated</span>
                </span>
              </span>
            </span>

            <!-- 整卡命中区:透明,压在内容之下,点空白处进详情 -->
            <button
              class="ctile-open"
              :aria-label="`Open ${c.name}`"
              @click="openDetail(c.id)"
            ></button>
          </div>
          <button
            class="ctile-del"
            :aria-label="`Delete ${c.name}`"
            @click.stop="emit('remove', c.id)"
          >
            <PhTrash aria-hidden="true" />
          </button>
        </article>
      </div>

      <div v-else-if="!editing" class="empty">
        <PhMaskHappy class="empty-ico" aria-hidden="true" />
        <h3 class="empty-title">No characters yet</h3>
        <p class="empty-sub">
          Describe one in a line and let the model draft the spec, or fill the fields by hand.
          Then generate a reference sheet to keep the same face everywhere.
        </p>
        <button class="ed-btn primary" @click="startEdit">Create a character</button>
      </div>
    </template>

    <!-- —— 详情 —— -->
    <template v-else-if="detailChar">
      <div class="dt-bar">
        <button class="back" @click="backToList">
          <PhArrowLeft aria-hidden="true" />
          All characters
        </button>
        <button class="dt-del" @click="emit('remove', detailChar.id)">
          <PhTrash aria-hidden="true" />
          Delete
        </button>
      </div>

      <!-- 身份区:头像用正脸,名字和设定一眼看全,进度与参考图作为标签摆在下面 -->
      <header class="hero">
        <span class="hero-avatar">
          <img v-if="avatarSrc" :src="avatarSrc" alt="" />
          <PhMaskHappy v-else aria-hidden="true" />
        </span>
        <div class="hero-body">
          <h2 class="hero-name">{{ detailChar.name }}</h2>
          <p class="hero-sub">{{ summary(detailChar) }}</p>
          <!-- 用量:这个角色到底干了多少活。放在设定摘要下面、标签上面 ——
               它比"几张图"更像这个角色的成绩单 -->
          <p class="hero-meta">
            <span v-for="m in heroMeta" :key="m">{{ m }}</span>
          </p>
          <div class="hero-tags">
            <span class="tag">{{ filledCount }} / {{ sheetCells.length }} views</span>
            <span v-if="refLabel" class="tag tag-on">
              <PhEye weight="fill" aria-hidden="true" />
              Main view · {{ refLabel }}
            </span>
            <span v-else class="tag">No main view yet</span>
          </div>
        </div>
        <!-- 生成中按钮自己也要说出来:它是刚才被点的那个,状态留在原地最容易被看到 -->
        <button
          class="ed-btn primary hero-cta"
          :disabled="!!props.busy || !missingCount"
          @click="emit('generateAll', detailChar.id)"
        >
          <PhSparkle v-if="!props.busy" aria-hidden="true" />
          {{ props.busy ? `Generating ${busyLabel}…` : generateAllLabel }}
        </button>
      </header>

      <section class="panel">
        <div class="panel-head">
          <h3 class="panel-title">Reference sheet</h3>
          <!-- 生成中就把说明换成进度:在标题旁边,是这一屏视线必经的位置。
               放在网格下面用一行小字写"Generating…"几乎等于没写 -->
          <LatticeLoader
            v-if="props.busy"
            class="panel-progress"
            :label="`Generating ${busyLabel} view`"
            :grid="3"
            :cell-size="5"
            :gap="2"
            :font-size="12"
          />
          <span v-else class="panel-note">
            {{
              hasFront
                ? 'Every other view is built from the front view.'
                : 'Start with the front view — the other four unlock once it exists.'
            }}
          </span>
        </div>

        <!-- 空格点一下即生成;有图的点开看大图,重新生成与设为主参考图都在大图里 ——
             原来这两件事挤在每格底下的小字上,既难点也说不清在做什么 -->
        <div class="sheet">
          <div
            v-for="cell in sheetCells"
            :key="cell.kind"
            class="cell"
            :class="{ 'is-ref': refKind === cell.kind }"
          >
            <button
              v-if="cell.view"
              class="cell-img has-img"
              :aria-label="`View ${cell.label}`"
              @click="openViewer(cell.kind)"
            >
              <img :src="coverSrc(cell.view.data)" alt="" />
              <span class="cell-zoom" aria-hidden="true"><PhArrowsOutSimple /></span>
              <span v-if="refKind === cell.kind" class="cell-mark" title="Main view">
                <PhEye weight="fill" aria-hidden="true" />
              </span>
            </button>
            <button
              v-else
              class="cell-img"
              :class="{
                busy: isBusy(cell.kind),
                locked: isLocked(cell.kind),
                start: cell.kind === 'front'
              }"
              :disabled="!!props.busy || isLocked(cell.kind)"
              :aria-label="
                isLocked(cell.kind)
                  ? `${cell.label} view — generate the front view first`
                  : `Generate ${cell.label} view`
              "
              @click="emit('generate', detailChar.id, cell.kind)"
            >
              <PhLockSimple v-if="isLocked(cell.kind)" class="cell-lock" aria-hidden="true" />
              <span v-else class="cell-ph" aria-hidden="true">+</span>
            </button>

            <span class="cell-label">{{ cell.label }}</span>
          </div>
        </div>

      </section>

      <section class="panel">
        <h3 class="panel-title">Spec</h3>
        <dl class="spec">
          <template v-for="r in specRows(detailChar)" :key="r.label">
            <dt class="spec-k">{{ r.label }}</dt>
            <dd class="spec-v" :class="{ dim: !r.value }">{{ r.value || '—' }}</dd>
          </template>
        </dl>
      </section>
    </template>

    <!-- 看大图:同一张图上顺手做决定 —— 重新生成、设为主参考图,以及左右翻 -->
    <div v-if="viewer" class="viewer" @click="closeViewer">
      <div
        ref="viewerBox"
        class="viewer-box"
        role="dialog"
        aria-modal="true"
        :aria-label="`${viewerLabel} view`"
        tabindex="-1"
        @click.stop
      >
        <div class="viewer-top">
          <span class="viewer-label">{{ viewerLabel }}</span>
          <button class="viewer-x" aria-label="Close" @click="closeViewer">
            <PhX aria-hidden="true" />
          </button>
        </div>

        <div class="viewer-stage">
          <button
            v-if="viewerKinds.length > 1"
            class="viewer-nav"
            aria-label="Previous view"
            @click="stepViewer(-1)"
          >
            <PhCaretLeft aria-hidden="true" />
          </button>
          <img class="viewer-img" :src="viewerSrc" alt="" />
          <button
            v-if="viewerKinds.length > 1"
            class="viewer-nav"
            aria-label="Next view"
            @click="stepViewer(1)"
          >
            <PhCaretRight aria-hidden="true" />
          </button>
        </div>

        <div class="viewer-acts">
          <button class="ed-btn" :disabled="!!props.busy" @click="regenerateViewer">
            <PhArrowsClockwise aria-hidden="true" />
            Regenerate
          </button>
          <button
            class="ed-btn"
            :class="{ 'is-on': refKind === viewer }"
            :disabled="refKind === viewer"
            @click="applyViewerRef"
          >
            <PhEye weight="fill" aria-hidden="true" />
            {{ refKind === viewer ? 'This is the main view' : 'Use as main view' }}
          </button>
        </div>
      </div>
    </div>

    <input id="cp-file" type="file" accept="image/*" hidden @change="onPickRef" />
  </div>
</template>

<style scoped>
/* 页容器与左右留白都由 .shell 给(App.vue),这一页不再自己套一层
   —— 原来那层 max-width + padding 让内容比别的页多缩进一圈,左边缘对不齐 */
.chars {
  min-width: 0;
}
/* 以下骨架与历史 / 提示词库 / 设置三页保持一致 */
.chars-head {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  justify-content: space-between;
  gap: var(--sp-4);
  padding-top: var(--sp-2);
}
.chars-title {
  font-family: var(--font-sans);
  font-size: var(--fs-3xl);
  font-weight: 700;
  letter-spacing: var(--ls-tight);
}
.chars-sub {
  margin-top: 6px;
  max-width: 60ch;
  font-size: var(--fs-sm);
  line-height: 1.6;
  color: var(--text-2);
}
/* 与设置页「Add config」、提示词库「New prompt」同款:黑药丸,标题行主操作 */
.chars-new {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex: none;
  height: 34px;
  padding: 0 14px;
  border-radius: 999px;
  background: var(--cta);
  color: var(--cta-text);
  font-size: var(--fs-sm);
  font-weight: 500;
  cursor: pointer;
  transition: background var(--dur) var(--ease);
}
.chars-new:hover {
  background: var(--cta-hover);
}
.chars-new svg {
  width: 15px;
  height: 15px;
}

/* —— 新建向导 ——
   一张卡分三层:卡头步骤条 / 卡身当前步 / 卡脚进退。
   overflow:hidden 让卡头卡脚的底色被圆角切齐,不然会顶出四个直角 */
.wizard {
  display: flex;
  flex-direction: column;
  margin-top: var(--sp-5);
  border: 1px solid var(--line);
  border-radius: var(--r);
  background: var(--surface);
  overflow: hidden;
}
/* 步骤条:横向三步,中间用短线连起来。
   线点亮 = 前一步做完了 —— 进度不必靠读文字,余光扫一眼就知道走到哪 */
.wz-steps {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 13px var(--sp-4);
  border-bottom: 1px solid var(--line);
  background: var(--bg);
}
.wz-line {
  flex: 1;
  height: 1px;
  background: var(--line);
  transition: background var(--dur) var(--ease);
}
.wz-line.is-done {
  background: color-mix(in oklch, var(--accent) 55%, var(--line));
}
.wz-step {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 2px 0;
  color: var(--text-3);
  cursor: pointer;
  transition: color var(--dur) var(--ease);
}
/* 没到的步骤点不动。光标也不给手指,免得看着像能点 */
.wz-step:disabled {
  cursor: default;
}
.wz-step.is-locked {
  opacity: 0.5;
}
.wz-step.is-active {
  color: var(--text);
}
.wz-step:not(.is-active):not(:disabled):hover {
  color: var(--text-2);
}
/* 序号圆点:当前步实心 accent,做完的转成勾,没到的只有一圈描边 */
.wz-dot {
  flex: none;
  width: 22px;
  height: 22px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--line-strong);
  border-radius: 50%;
  font-size: var(--fs-micro);
  font-variant-numeric: tabular-nums;
}
.wz-dot svg {
  width: 12px;
  height: 12px;
}
.wz-step.is-active .wz-dot {
  border-color: var(--accent);
  background: var(--accent);
  color: var(--accent-contrast);
}
.wz-step.is-done .wz-dot {
  border-color: color-mix(in oklch, var(--accent) 35%, var(--line));
  background: var(--accent-soft);
  color: var(--accent-strong);
}
.wz-name {
  font-size: var(--fs-sm);
  font-weight: 500;
  white-space: nowrap;
}
.wz-step.is-active .wz-name {
  font-weight: 600;
}

/* 卡身:当前这一步的内容。间距与旧表单一致(10px 一档) */
.wz-pane {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: var(--sp-4);
}
/* 每步开头的一段说明:标题 + 一句人话。
   向导里这行不是装饰 —— 它替用户回答"这一步在干嘛、为什么有顺序" */
.wz-lead {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.wz-lead-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 8px 12px;
}
.wz-h {
  font-size: var(--fs-lg);
  color: var(--text);
}
.wz-p {
  max-width: 64ch;
  font-size: var(--fs-sm);
  line-height: 1.6;
  color: var(--text-2);
}

/* 主视图那一步整屏就一张图,给它一个固定的大框 ——
   它是这一屏唯一要看的东西,不该和四张小格平分宽度 */
.wz-focus {
  display: flex;
  justify-content: center;
  padding: var(--sp-2) 0 var(--sp-3);
}
.wz-focus .cell {
  width: min(300px, 100%);
}
/* 其余四张:一排四格,与详情页的设定图同一套格子语言 */
.wz-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: var(--sp-3);
}

/* 第 1 步回看时的只读摘要 */
.wz-sum {
  display: flex;
  align-items: center;
  gap: 10px;
}
.wz-sum-name {
  font-size: var(--fs-lg);
  font-weight: 600;
  letter-spacing: var(--ls-tight);
  color: var(--text);
}

/* 卡脚:主操作在左,回退与退出紧跟其后(与表单里一贯的主次排法一致) */
.wz-foot {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  padding: var(--sp-3) var(--sp-4);
  border-top: 1px solid var(--line);
  background: var(--bg);
}

/* —— 编辑表单 —— */
.ed-draft,
.ed-ref {
  display: flex;
  align-items: center;
  gap: 8px;
}
.ed-input {
  width: 100%;
  min-width: 0;
  padding: 9px 12px;
  border: 1px solid var(--line);
  border-radius: var(--r-sm);
  background: var(--bg);
  color: var(--text);
  font-size: var(--fs-sm);
  transition: border-color var(--dur) var(--ease);
}
.ed-draft .ed-input {
  flex: 1;
}
.ed-input:focus {
  border-color: var(--accent);
}
/* 五项设定:左标签右输入 */
.ed-fields {
  display: grid;
  grid-template-columns: 78px 1fr;
  align-items: center;
  gap: 8px 10px;
}
.ed-label {
  font-size: var(--fs-xs);
  color: var(--text-3);
}
.ed-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  flex: none;
  padding: 9px 14px;
  border: 1px solid var(--line);
  border-radius: 999px;
  background: none;
  color: var(--text-2);
  font-size: var(--fs-sm);
  font-weight: 500;
  white-space: nowrap;
  cursor: pointer;
  transition: color var(--dur) var(--ease), border-color var(--dur) var(--ease),
    background var(--dur) var(--ease);
}
.ed-btn:hover:not(:disabled) {
  color: var(--text);
  border-color: var(--line-strong);
  background: var(--bg-elev);
}
.ed-btn:disabled {
  opacity: 0.5;
  cursor: default;
}
.ed-btn svg {
  width: 15px;
  height: 15px;
}
.ed-btn.primary {
  border-color: var(--cta);
  background: var(--cta);
  color: var(--cta-text);
}
.ed-btn.primary:hover:not(:disabled) {
  border-color: var(--cta-hover);
  background: var(--cta-hover);
}
/* 已选中的状态(主参考图):墨色描边 + 实心底,和别处"当前项"同一套 */
.ed-btn.is-on {
  border-color: var(--cta);
  color: var(--text);
  background: var(--bg-elev);
}
.ed-pick {
  padding: 9px 14px;
  border: 1px dashed var(--line-strong);
  border-radius: var(--r-sm);
  color: var(--text-2);
  font-size: var(--fs-sm);
  cursor: pointer;
}
.ed-thumb {
  width: 56px;
  height: 56px;
  object-fit: cover;
  border-radius: var(--r-sm);
  border: 1px solid var(--line);
}
.ed-err {
  font-size: var(--fs-sm);
  color: var(--danger);
}

/* —— 列表:角色海报卡 —— */
/* 顶图全出血铺满整张卡,底部渐变暗幕托起白字,像电影海报的下三分之一。
   无边框,靠阴影浮起;圆角加大到 24px 更软,与白纸档案卡区分开 */
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
  gap: var(--sp-5);
  margin-top: var(--sp-5);
}
.ctile {
  position: relative;
  min-width: 0;
}
/* 海报卡:固定 3:4 比例,无边框,圆角 24px,overflow 让图与暗幕切出弧形。
   它现在是容器而不是按钮 —— 卡里有两个动作,按钮不能嵌套按钮 */
.ctile-main {
  position: relative;
  display: block;
  width: 100%;
  aspect-ratio: 3 / 4;
  padding: 0;
  border-radius: var(--r-lg);
  overflow: hidden;
  background: var(--image-bg);
  /* 卡片本身要有一点"浮在纸面上"的分量:
     一枚贴边的接触影让四边站得住 + 系统那道柔和弥散影。
     接触影用纯黑(与 --sh-* 同一套语言),深浅主题都成立 */
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.05), var(--sh-sm);
  text-align: left;
  cursor: pointer;
  transition: box-shadow var(--dur) var(--ease);
}
.ctile-main:hover {
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.05), var(--sh-md);
}
/* 顶图:绝对铺满,object-fit cover;hover 轻微放大制造呼吸 */
.ctile-img {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-3);
}
.ctile-img img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
  transition: transform 700ms var(--ease);
}
.ctile-main:hover .ctile-img img {
  transform: scale(1.045);
}
.ctile-ph svg {
  width: 34px;
  height: 34px;
}
/* 暗幕:比原来淡,让照片的形状还能透出来 —— 参考图里"双手与相机被揉成
   模糊的形"靠的就是这一点:玻璃不是一块死黑的板,是能看见底下的。
   零点的位置与下面毛玻璃的零点对齐(卡高 42%),两层一起化开 */
.ctile-veil {
  position: absolute;
  inset: 0;
  z-index: 1;
  background: linear-gradient(
    to top,
    rgba(24, 24, 22, 0.6) 0%,
    rgba(24, 24, 22, 0.52) 25%,
    rgba(24, 24, 22, 0.34) 45%,
    rgba(24, 24, 22, 0.14) 52%,
    transparent 58%
  );
  pointer-events: none;
}
/* 毛玻璃层:矩形铺满下半张卡,mask 提供"从清晰到模糊"的浓度渐变。
   关键是渐变的形状:每一条横截面浓度都相同,所以这块玻璃是规整的矩形,
   不会出现异型的斜边;而过渡拉得够长,底下的照片是"慢慢化开"的,
   不是被一条线切断 —— 与参考图里那种有机的羽化一致。 */
.ctile-veil::before {
  content: '';
  position: absolute;
  inset: 42% 0 0 0;
  /* brightness 略提一点:玻璃微微发亮才像"磨"过的,
     纯模糊会显得只是脏;幅度很小,不影响白字的对比 */
  backdrop-filter: blur(20px) saturate(115%) brightness(1.04);
  -webkit-backdrop-filter: blur(20px) saturate(115%) brightness(1.04);
  -webkit-mask-image: linear-gradient(
    to top,
    #000 0%,
    #000 45%,
    rgba(0, 0, 0, 0.5) 72%,
    transparent 100%
  );
  mask-image: linear-gradient(
    to top,
    #000 0%,
    #000 45%,
    rgba(0, 0, 0, 0.5) 72%,
    transparent 100%
  );
}

/* 整卡命中区:透明按钮铺满卡片,压在文本之下 ——
   "点空白处进详情"的直觉还在,而 CTA 可以正常浮在它上面 */
.ctile-open {
  position: absolute;
  inset: 0;
  z-index: 2;
  cursor: pointer;
}
/* 焦点环画在里面:这个按钮被 .ctile-main 的 overflow 裁着,默认那圈外描边看不见。
   它盖在照片上,所以用纸色而不是 --accent */
.ctile-open:focus-visible {
  outline: 2px solid #fbfaf7;
  outline-offset: -5px;
  border-radius: var(--r-lg);
}

/* 文本叠层:贴底,白字,左下 16px。
   只留四样:名字(+CTA)、身份、特征、用量 ——
   描述在身份行下面只是重复一遍同一件事,分隔线是纯装饰,
   两者都删掉,省下的高度还给段间距,信息区才有呼吸感。
   补一道微弱投影,别让大名字压在亮图上糊掉。
   pointer-events:none 让点击穿到下面的整卡命中区,只有 CTA 自己收回来 */
.ctile-content {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 3;
  display: flex;
  flex-direction: column;
  gap: 9px;
  padding: 16px 16px 15px;
  pointer-events: none;
  text-shadow: 0 1px 12px rgba(0, 0, 0, 0.35);
}
/* 名字 + 快捷开画同一行 */
.ctile-head {
  display: flex;
  align-items: center;
  gap: 10px;
}
.ctile-name {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--fs-xl);
  line-height: 1.2;
  font-weight: 700;
  letter-spacing: var(--ls-tight);
  color: #fff;
}
.ctile-role {
  margin-top: -3px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  line-height: 1.3;
  font-size: var(--fs-sm);
  color: rgba(255, 255, 255, 0.78);
}
/* 特征胶囊:玻璃感白字,一行 */
.ctile-chips {
  display: flex;
  gap: 5px;
  overflow: hidden;
}
.chip {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  padding: 3px 10px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.16);
  line-height: 1.2;
  font-size: var(--fs-xs);
  color: #fff;
}

/* 快捷开画:浅色药丸压在暗幕上,是卡上对比度最高的元素(与设计稿的 CTA 同位阶)。
   固定浅底深字,不走 token —— 它盖在照片上,亮/暗主题下都该是"浅底深字"。
   与名字同行,所以收成紧凑的一枚(flex:none 不参与拉伸,名字那边让位)。
   pointer-events 单独收回,否则会被 .ctile-content 的透传连累点不动 */
.ctile-cta {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 6px 11px;
  border-radius: 999px;
  background: rgba(252, 251, 249, 0.94);
  color: #1a1a18;
  font-size: var(--fs-xs);
  font-weight: 600;
  white-space: nowrap;
  text-shadow: none;
  pointer-events: auto;
  cursor: pointer;
  transition: background var(--dur) var(--ease), transform var(--dur) var(--ease);
}
.ctile-cta:hover {
  background: #fff;
  transform: translateY(-1px);
}
.ctile-cta:active {
  transform: translateY(0);
}
.ctile-cta-ico {
  width: 13px;
  height: 13px;
  flex: none;
  transition: transform var(--dur) var(--ease);
}
.ctile-cta:hover .ctile-cta-ico {
  transform: translateX(2px);
}

/* 用量三格 + 竖向分隔,白字压在暗幕上 */
.ctile-stats {
  display: flex;
  margin-top: 4px;
}
.cstat {
  flex: 1 1 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
  padding: 0 10px;
  border-left: 1px solid rgba(255, 255, 255, 0.14);
}
.cstat:first-child {
  border-left: none;
  padding-left: 0;
}
.cstat:last-child {
  padding-right: 0;
}
.cstat-h {
  display: flex;
  align-items: center;
  gap: 4px;
}
.cstat-ico {
  width: 12px;
  height: 12px;
  flex: none;
  color: rgba(255, 255, 255, 0.7);
}
.cstat-v {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  line-height: 1.3;
  font-size: var(--fs-xs);
  font-weight: 600;
  color: #fff;
  font-variant-numeric: tabular-nums;
}
.cstat-k {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  line-height: 1.3;
  font-size: var(--fs-micro);
  color: rgba(255, 255, 255, 0.6);
}

/* 删除:浮在图右上角的玻璃圆钮,压在照片上,刻意不走 token ——
   仍按暖白纸调子避开纯黑纯白;加一道模糊让它"浮"住 */
.ctile-del {
  position: absolute;
  top: 16px;
  right: 16px;
  z-index: 4;
  width: 36px;
  height: 36px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 999px;
  background: rgba(24, 24, 22, 0.34);
  color: #fbfaf7;
  backdrop-filter: blur(8px);
  cursor: pointer;
  transition: opacity var(--dur) var(--ease), background var(--dur) var(--ease);
}
.ctile-del svg {
  width: 16px;
  height: 16px;
}
/* 能悬停的设备上才收起删除钮:每张图右上角常驻一枚深色圆点太吵。
   触摸设备没有悬停,收起来就等于删不掉 —— 所以用 hover 能力判断,而不是屏宽 */
@media (hover: hover) {
  .ctile-del {
    opacity: 0;
  }
  .ctile:hover .ctile-del,
  .ctile-del:focus-visible {
    opacity: 1;
  }
}
.ctile-del:hover {
  background: rgba(24, 24, 22, 0.56);
}

/* —— 详情 —— */
/* 详情页没有大标题,但顶部要与列表页及其他页的标题行对齐 */
.dt-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-3);
  padding-top: var(--sp-2);
  margin-bottom: var(--sp-4);
}
.back {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: var(--fs-sm);
  color: var(--text-2);
  cursor: pointer;
  transition: color var(--dur) var(--ease);
}
.back:hover {
  color: var(--text);
}
.back svg {
  width: 15px;
  height: 15px;
}
/* 删除是破坏性动作,平时压成静默的一行字,悬停才亮红 */
.dt-del {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  border-radius: 999px;
  font-size: var(--fs-sm);
  color: var(--text-3);
  cursor: pointer;
  transition: color var(--dur) var(--ease), background var(--dur) var(--ease);
}
.dt-del:hover {
  color: var(--danger);
  background: color-mix(in oklch, var(--danger) 8%, transparent);
}
.dt-del svg {
  width: 15px;
  height: 15px;
}

/* 身份区:一张卡把"这是谁、进行到哪、能做什么"说全 */
.hero {
  display: flex;
  align-items: center;
  gap: var(--sp-4);
  padding: var(--sp-5);
  border: 1px solid var(--line);
  border-radius: var(--r);
  background: var(--surface);
}
.hero-avatar {
  flex: none;
  width: 88px;
  height: 88px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  border-radius: 50%;
  border: 1px solid var(--line);
  background: var(--bg-elev);
  color: var(--text-3);
}
.hero-avatar img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.hero-avatar svg {
  width: 32px;
  height: 32px;
}
.hero-body {
  flex: 1;
  min-width: 0;
}
.hero-name {
  font-size: var(--fs-2xl);
  line-height: 1.25;
  color: var(--text);
}
.hero-sub {
  margin-top: 5px;
  font-size: var(--fs-sm);
  line-height: 1.6;
  color: var(--text-2);
}
/* 用量那一行:数字是主角,所以点用最淡的一档隔开,别和数字抢注意力 */
.hero-meta {
  margin-top: 8px;
  font-size: var(--fs-xs);
  color: var(--text-2);
  font-variant-numeric: tabular-nums;
}
.hero-meta span + span::before {
  content: '·';
  margin: 0 7px;
  color: var(--text-4);
}
.hero-tags {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  margin-top: 10px;
}
/* 底用 bg-elev 而不是 bg:卡片本身就是 surface,浅色主题下 bg 与它几乎同色,
   胶囊只剩一圈描边、没有实体感 */
.tag {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 9px;
  border: 1px solid var(--line);
  border-radius: 999px;
  background: var(--bg-elev);
  font-size: var(--fs-micro);
  color: var(--text-2);
}
.tag svg {
  width: 11px;
  height: 11px;
}
/* 主参考图是本页唯一需要"一眼看出是哪张"的状态,用 accent 标出来 */
.tag-on {
  border-color: color-mix(in oklch, var(--accent) 30%, var(--line));
  background: var(--accent-soft);
  color: var(--accent-strong);
  font-weight: 600;
}
.hero-cta {
  flex: none;
  padding: 10px 16px;
}

.panel {
  margin-top: var(--sp-4);
  padding: var(--sp-4);
  border: 1px solid var(--line);
  border-radius: var(--r);
  background: var(--surface);
}
.panel-head {
  display: flex;
  align-items: baseline;
  gap: 10px;
  margin-bottom: var(--sp-3);
}
.panel-title {
  font-size: var(--fs-lg);
  color: var(--text);
}
.panel-note {
  flex: 1;
  min-width: 0;
  font-size: var(--fs-xs);
  line-height: 1.5;
  color: var(--text-3);
}
/* 生成进度占的是"说明"那一格。loader 是一块方格,按基线对齐会歪,单独居中 */
.panel-progress {
  flex: 1;
  min-width: 0;
  align-self: center;
  color: var(--text-2);
}
/* 带 panel-head 的那块由 panel-head 自己留白,只有 Spec 这种裸标题才要补 */
.panel > .panel-title {
  margin-bottom: var(--sp-3);
}

/* —— 设定图 —— */
.sheet {
  display: grid;
  grid-template-columns: repeat(5, 1fr);
  gap: var(--sp-3);
}
.cell {
  display: flex;
  flex-direction: column;
  gap: 7px;
  min-width: 0;
}
/* 空格子是虚线框(点一下即生成),有图的转实线(点一下看大图) */
.cell-img {
  position: relative;
  aspect-ratio: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  border: 1px solid var(--line-strong);
  border-style: dashed;
  border-radius: var(--r-sm);
  background: var(--bg);
  color: var(--text-3);
  cursor: pointer;
  transition: border-color var(--dur) var(--ease), opacity var(--dur) var(--ease),
    color var(--dur) var(--ease), transform var(--dur) var(--ease);
}
.cell-img.has-img {
  border-style: solid;
}
/* 墨色描边只给空格子:那是"点一下就生成"的召唤。
   有图的格子不给描边反馈 —— 它的反馈是上面那层遮幕,
   而给每张图都点墨色会让主视图那枚标记失去分量(accent 是"当前项"的颜色) */
.cell-img:not(.has-img):hover:not(:disabled) {
  border-color: var(--accent);
  color: var(--text);
}
/* 一次只跑一张:生成期间其余空位是停用的,必须看得出来,
   否则和平时长得一样、点了却没反应 */
.cell-img:disabled:not(.busy) {
  cursor: default;
  opacity: 0.4;
}
/* 正在出的那一张:实线 accent 描边 + 呼吸,和"还没生成"区分开 */
.cell-img.busy {
  border-style: solid;
  border-color: var(--accent);
  /* 它也是停用的,别给指针光标 —— 点了没反应才是对的,但光标得说实话 */
  cursor: default;
  animation: charPulse 1.2s var(--ease) infinite;
}
@keyframes charPulse {
  50% {
    opacity: 0.45;
  }
}
.cell-img img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.cell-ph {
  font-size: var(--fs-xl);
  line-height: 1;
}
/* 锁住的那几格:先有正脸才轮得到它们。
   图标比 "+" 小一档 —— 它说的是"还不能点",不该和可点的格子抢注意力 */
.cell-lock {
  width: 15px;
  height: 15px;
}
/* 整条流水线的起点:正脸格永远亮着 accent 虚线,
   哪怕同一屏里还有四格在等它 —— 它是这一屏唯一该被点的东西 */
.cell-img.start:not(.has-img) {
  border-color: color-mix(in oklch, var(--accent) 45%, var(--line-strong));
}
/* 悬停铺一层淡幕 + 放大图标:说清"这张点得开",而不是点下去才知道。
   遮罩必须与主题无关(它盖在照片上,不盖在界面上),所以这里是全站少数
   刻意不走 token 的地方 —— 但仍按暖白纸的调子避开纯黑纯白 */
.cell-zoom {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(24, 24, 22, 0.34);
  color: #fbfaf7;
  opacity: 0;
  transition: opacity var(--dur) var(--ease);
}
.cell-zoom svg {
  width: 20px;
  height: 20px;
}
.cell-img:hover .cell-zoom {
  opacity: 1;
}
/* 主视图:右上角一枚眼睛。星标是"收藏"的语言,眼睛才是"就是这张" ——
   比在格子下面挂一行小字醒目得多 */
.cell-mark {
  position: absolute;
  top: 6px;
  right: 6px;
  width: 22px;
  height: 22px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  background: var(--accent);
  color: var(--accent-contrast);
}
.cell-mark svg {
  width: 14px;
  height: 14px;
}
.cell-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-align: center;
  font-size: var(--fs-micro);
  color: var(--text-3);
}
.cell.is-ref .cell-label {
  color: var(--accent-strong);
  font-weight: 600;
}

/* —— 规格表 —— */
.spec {
  display: grid;
  grid-template-columns: 84px 1fr;
  gap: 9px 12px;
  align-items: baseline;
}
.spec-k {
  font-size: var(--fs-xs);
  color: var(--text-3);
}
.spec-v {
  font-size: var(--fs-sm);
  line-height: 1.6;
  color: var(--text);
  overflow-wrap: anywhere;
}
.spec-v.dim {
  color: var(--text-3);
}

/* —— 看大图 —— */
.viewer {
  position: fixed;
  inset: 0;
  z-index: 60;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--sp-5);
  background: color-mix(in srgb, var(--stage-bg) 86%, transparent);
  backdrop-filter: blur(6px);
}
.viewer-box {
  display: flex;
  flex-direction: column;
  width: min(720px, 100%);
  max-height: 100%;
  border-radius: var(--r);
  overflow: hidden;
  background: var(--surface);
  box-shadow: var(--sh-md);
}
.viewer-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-3);
  padding: 10px var(--sp-3) 10px var(--sp-4);
}
.viewer-label {
  font-size: var(--fs-sm);
  font-weight: 600;
  color: var(--text);
}
.viewer-x {
  flex: none;
  width: 34px;
  height: 34px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 999px;
  color: var(--text-2);
  cursor: pointer;
  transition: color var(--dur) var(--ease), background var(--dur) var(--ease);
}
.viewer-x:hover {
  color: var(--text);
  background: var(--bg-elev);
}
.viewer-x svg {
  width: 16px;
  height: 16px;
}
.viewer-stage {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 var(--sp-3);
}
.viewer-img {
  flex: 1;
  min-width: 0;
  max-height: calc(100vh - 220px);
  object-fit: contain;
  display: block;
  border-radius: var(--r-sm);
  background: var(--stage-bg);
}
/* 翻页钮放在图片两侧:和预览卡同一套"图上左右翻"的语言 */
.viewer-nav {
  flex: none;
  width: 36px;
  height: 36px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--line);
  border-radius: 999px;
  background: var(--surface);
  color: var(--text-2);
  cursor: pointer;
  transition: color var(--dur) var(--ease), border-color var(--dur) var(--ease),
    background var(--dur) var(--ease);
}
.viewer-nav:hover {
  color: var(--text);
  border-color: var(--line-strong);
  background: var(--bg-elev);
}
.viewer-nav svg {
  width: 15px;
  height: 15px;
}
.viewer-acts {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  padding: var(--sp-3) var(--sp-4) var(--sp-4);
}

/* —— 空态 —— */
.empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  margin-top: var(--sp-7);
  text-align: center;
}
/* 与历史页的空态同一档尺寸与留白 */
.empty-ico {
  width: 44px;
  height: 44px;
  color: var(--text-3);
}
.empty-title {
  font-size: var(--fs-lg);
  color: var(--text);
}
.empty-sub {
  max-width: 48ch;
  font-size: var(--fs-sm);
  line-height: 1.6;
  color: var(--text-2);
}
.empty .ed-btn {
  margin-top: 6px;
}

@media (max-width: 720px) {
  /* 标题行靠 flex-wrap 自己换行(与设置页同一套),不改成 column ——
     改成 column 会让 action 按钮另起一行的位置和别的页不一样 */
  .ed-fields {
    grid-template-columns: 1fr;
    gap: 6px;
  }
  .ed-label {
    margin-top: 4px;
  }
  /* 窄屏:三步的标签一起挤会先被截断的是第三段,
     所以把连接线收短、步间距压小 —— 圆点比标签更需要留在原地 */
  .wz-steps {
    gap: 6px;
    padding: 12px var(--sp-3);
  }
  .wz-line {
    flex: 0 0 10px;
  }
  .wz-step {
    min-width: 0;
    gap: 6px;
  }
  .wz-name {
    overflow: hidden;
    text-overflow: ellipsis;
    font-size: var(--fs-xs);
  }
  /* 四张其余设定图两行两列:四格一排会把每格压到看不清 */
  .wz-grid {
    grid-template-columns: repeat(2, 1fr);
    gap: var(--sp-2);
  }
  /* 窄屏卡更小、一排两枚:auto-fill 自己退列,不用手写列数 */
  .grid {
    grid-template-columns: repeat(auto-fill, minmax(170px, 1fr));
    gap: var(--sp-3);
  }
  /* 海报卡在窄屏卡面更小:名字收一档,段距与内边距也各收一点,
     但留白仍比桌面端紧不了太多 —— 信息已经只剩四行了 */
  .ctile-name {
    font-size: var(--fs-lg);
  }
  .ctile-content {
    gap: 7px;
    padding: 13px 13px 12px;
  }
  /* 窄屏一行里要同时站住名字和 CTA:两边都收一档,给名字多留点位置 */
  .ctile-head {
    gap: 8px;
  }
  .ctile-cta {
    padding: 5px 9px;
    font-size: var(--fs-micro);
  }
  .ctile-cta-ico {
    width: 12px;
    height: 12px;
  }
  .hero {
    flex-wrap: wrap;
    padding: var(--sp-4);
  }
  .hero-avatar {
    width: 64px;
    height: 64px;
  }
  .hero-cta {
    width: 100%;
  }
  /* 五格一排会把每格压到看不清,窄屏改成三列两行 */
  .sheet {
    grid-template-columns: repeat(3, 1fr);
  }
  .spec {
    grid-template-columns: 1fr;
    gap: 2px var(--sp-3);
  }
  .spec-v {
    margin-bottom: 8px;
  }
  /* 触控目标放大到 40px */
  .ctile-del,
  .viewer-x,
  .viewer-nav {
    width: 40px;
    height: 40px;
  }
}

@media (max-width: 640px) {
  /* 标题收一档(与历史页同一档),免得与右上角的新建按钮在一行里挤 */
  .chars-title {
    font-size: var(--fs-xl);
  }
}
</style>
