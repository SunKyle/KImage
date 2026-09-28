<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import {
  PhMaskHappy,
  PhPlus,
  PhTrash,
  PhSparkle,
  PhArrowLeft,
  PhArrowsClockwise,
  PhStar,
  PhCaretRight,
  PhX
} from '@phosphor-icons/vue'
import { CHARACTER_VIEWS, coverSrc, draftCharacterFields } from '../api'
import type { ApiConfig, Character, CharacterFields, CharacterView, CharacterViewKind } from '../types'

/* 角色:网站的重点页面。
   一个角色 = 一组设定图 + 一段结构化设定。设定图是它的骨架 ——
   正脸当锚,其余四张都以正脸为参考图生成,这是跨图保持同一张脸的唯一办法。

   这一页只管展示与编排:生成、落盘、存储都在主界面 ——
   参考图与设定的字节归 App/IndexedDB 管,这里只发意图(与预览卡同一套分工) */

const props = defineProps<{
  characters: Character[]
  // 按角色 id 缓存的设定图。主界面按需从 IndexedDB 取,这里只读
  views: Record<string, CharacterView[]>
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
  (e: 'generate', charId: string, kind: CharacterViewKind): void
  (e: 'generateAll', charId: string): void
  (e: 'useRef', charId: string, kind: CharacterViewKind): void
}>()

function emptyFields(): CharacterFields {
  return { identity: '', hair: '', eyes: '', outfit: '', marks: '' }
}

/* 两个视图态:列表(空)与详情(有 id)。
   设定图不再摊在卡片里 —— 五张图加五项设定挤在一张卡上,既不好看也点不明白:
   点已有图会重新生成、想看大图又没地方看。详情页把这些一次解决 */
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

/** 设定图网格的五格:修饰词与取景来自 CHARACTER_VIEWS,内容是当前已有的那张 */
const sheetCells = computed(() =>
  CHARACTER_VIEWS.map((v) => ({ ...v, view: viewOf(detailId.value, v.kind) }))
)

/** 主参考图来自哪张视图。不比对 Blob:刷新后主图与视图是两次独立的读取,不是同一个实例 */
const refKind = computed(() => detailChar.value?.refKind)

/** 正在生成的那张是哪个视图。面板下方要说清在等哪一张 */
const busyLabel = computed(() => CHARACTER_VIEWS.find((v) => v.kind === props.busy)?.label || '')

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

/* 看大图 / 关大图。Esc 逐层退:先关大图,再回列表 ——
   开着大图按 Esc 直接退出详情会让人丢掉"我看的是哪个角色" */
function openViewer(kind: CharacterViewKind) {
  viewer.value = kind
}
function closeViewer() {
  viewer.value = ''
}
function onKey(e: KeyboardEvent) {
  if (e.key !== 'Escape') return
  if (viewer.value) closeViewer()
  else if (detailId.value) backToList()
}
onMounted(() => window.addEventListener('keydown', onKey))
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))

function startEdit() {
  draft.value = { name: '', fields: emptyFields(), desc: '', ref: '' }
  idea.value = ''
  draftError.value = ''
  editing.value = true
}

function cancelEdit() {
  editing.value = false
  draftError.value = ''
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
  editing.value = false
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
          <h2 class="chars-title">Characters</h2>
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

      <!-- 编辑/新建:AI 起稿在上,五项设定在下,参考图可选 -->
      <section v-if="editing" class="editor">
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

        <div class="ed-actions">
          <button class="ed-btn primary" :disabled="!draft.name.trim()" @click="submit">
            Save character
          </button>
          <button class="ed-btn" @click="cancelEdit">Cancel</button>
        </div>
      </section>

      <!-- 列表:头像用圆形 —— 它是"一个人",不是一张作品缩略图。
           整行可点进详情,删除单独一个按钮,避免误触 -->
      <div v-if="props.characters.length" class="grid">
        <article v-for="c in props.characters" :key="c.id" class="card">
          <button class="card-main" @click="openDetail(c.id)">
            <img v-if="c.ref" class="card-avatar" :src="coverSrc(c.ref)" alt="" />
            <span v-else class="card-avatar card-avatar-ph" aria-hidden="true">
              <PhMaskHappy />
            </span>
            <span class="card-text">
              <span class="card-name">{{ c.name }}</span>
              <span class="card-sub">{{ summary(c) }}</span>
            </span>
            <PhCaretRight class="card-arrow" aria-hidden="true" />
          </button>
          <button
            class="card-del"
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

    <!-- —— 详情:身份在上,设定图一行,规格垫底 —— -->
    <template v-else-if="detailChar">
      <button class="back" @click="backToList">
        <PhArrowLeft aria-hidden="true" />
        All characters
      </button>

      <header class="dt-head">
        <img v-if="detailChar.ref" class="dt-avatar" :src="coverSrc(detailChar.ref)" alt="" />
        <span v-else class="dt-avatar dt-avatar-ph" aria-hidden="true"><PhMaskHappy /></span>
        <div class="dt-id">
          <h2 class="dt-name">{{ detailChar.name }}</h2>
          <p class="dt-sub">{{ summary(detailChar) }}</p>
        </div>
        <div class="dt-acts">
          <button
            class="ed-btn primary"
            :disabled="!!props.busy"
            @click="emit('generateAll', detailChar.id)"
          >
            {{ viewOf(detailChar.id, 'front') ? 'Generate the rest' : 'Generate front view' }}
          </button>
          <button class="ed-btn danger" @click="emit('remove', detailChar.id)">
            <PhTrash aria-hidden="true" />
            Delete
          </button>
        </div>
      </header>

      <section class="panel">
        <div class="panel-head">
          <h3 class="panel-title">Reference sheet</h3>
          <span class="panel-note">
            {{
              viewOf(detailChar.id, 'front')
                ? 'Every other view is built from the front view.'
                : 'Start with the front view — the others are built from it.'
            }}
          </span>
        </div>

        <div class="sheet-grid">
          <div v-for="cell in sheetCells" :key="cell.kind" class="cell">
            <!-- 有图 = 看大图,空格 = 生成。以前两者都是"重新生成",
                 点一下就把花钱跑出来的图覆盖掉了 -->
            <button
              v-if="cell.view"
              class="cell-img has-img"
              :aria-label="`View ${cell.label}`"
              @click="openViewer(cell.kind)"
            >
              <img :src="coverSrc(cell.view.data)" alt="" />
            </button>
            <button
              v-else
              class="cell-img"
              :class="{ busy: isBusy(cell.kind) }"
              :disabled="!!props.busy"
              :aria-label="`Generate ${cell.label} view`"
              @click="emit('generate', detailChar.id, cell.kind)"
            >
              <span class="cell-ph" aria-hidden="true">+</span>
            </button>

            <span class="cell-label">{{ cell.label }}</span>

            <div v-if="cell.view" class="cell-acts">
              <button
                class="cell-act"
                :disabled="!!props.busy"
                :aria-label="`Regenerate ${cell.label} view`"
                @click="emit('generate', detailChar.id, cell.kind)"
              >
                <PhArrowsClockwise aria-hidden="true" />
                Redo
              </button>
              <button
                class="cell-act"
                :class="{ on: refKind === cell.kind }"
                :disabled="refKind === cell.kind"
                @click="emit('useRef', detailChar.id, cell.kind)"
              >
                <PhStar aria-hidden="true" />
                {{ refKind === cell.kind ? 'In use' : 'Use as ref' }}
              </button>
            </div>
          </div>
        </div>

        <p v-if="props.busy" class="panel-busy">Generating {{ busyLabel }} view…</p>
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

    <!-- 看大图:点任意处关闭,Esc 同样 -->
    <div v-if="viewer" class="viewer" @click="closeViewer">
      <div class="viewer-box" @click.stop>
        <img class="viewer-img" :src="viewerSrc" alt="" />
        <div class="viewer-bar">
          <span class="viewer-label">{{ viewerLabel }}</span>
          <button class="viewer-x" aria-label="Close" @click="closeViewer">
            <PhX aria-hidden="true" />
          </button>
        </div>
      </div>
    </div>

    <input id="cp-file" type="file" accept="image/*" hidden @change="onPickRef" />
  </div>
</template>

<style scoped>
.chars {
  max-width: 1100px;
  margin: 0 auto;
  padding: var(--sp-6) var(--sp-5) var(--sp-8);
}
.chars-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--sp-4);
}
.chars-title {
  font-size: var(--fs-xl);
  color: var(--text);
}
.chars-sub {
  margin-top: 6px;
  max-width: 60ch;
  font-size: var(--fs-sm);
  line-height: 1.6;
  color: var(--text-2);
}
.chars-new {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex: none;
  padding: 9px 14px;
  border-radius: 999px;
  background: var(--cta);
  color: var(--cta-text);
  font-size: var(--fs-sm);
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

/* —— 编辑表单 —— */
.editor {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-top: var(--sp-5);
  padding: var(--sp-4);
  border: 1px solid var(--line);
  border-radius: var(--r);
  background: var(--surface);
}
.ed-draft,
.ed-ref,
.ed-actions {
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
  gap: 6px;
  flex: none;
  padding: 9px 14px;
  border: 1px solid var(--line);
  border-radius: 999px;
  background: none;
  color: var(--text-2);
  font-size: var(--fs-sm);
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
.ed-btn.danger:hover:not(:disabled) {
  color: var(--danger);
  border-color: var(--danger);
  background: color-mix(in oklch, var(--danger) 8%, transparent);
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

/* —— 列表 —— */
/* 卡片是"一行":头像 + 名字 + 进入箭头 + 删除。
   整行可点,删除单独拎出来 —— 两者挤在一个按钮里必然误触 */
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
  gap: var(--sp-3);
  margin-top: var(--sp-5);
}
.card {
  display: flex;
  align-items: center;
  gap: 2px;
  padding: var(--sp-2) var(--sp-2) var(--sp-2) var(--sp-3);
  border: 1px solid var(--line);
  border-radius: var(--r);
  background: var(--surface);
  transition: border-color var(--dur) var(--ease), background var(--dur) var(--ease);
}
.card:hover {
  border-color: var(--line-strong);
}
.card-main {
  display: flex;
  align-items: center;
  gap: 12px;
  flex: 1;
  min-width: 0;
  padding: 6px 0;
  text-align: left;
}
.card-avatar {
  flex: none;
  width: 52px;
  height: 52px;
  object-fit: cover;
  border-radius: 50%;
  border: 1px solid var(--line);
}
.card-avatar-ph {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: var(--bg-elev);
  color: var(--text-3);
}
.card-avatar-ph svg {
  width: 20px;
  height: 20px;
}
.card-text {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-width: 0;
}
.card-name {
  font-size: var(--fs-base);
  color: var(--text);
}
/* 设定摘要:可能很长,给两行就够了 */
.card-sub {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  margin-top: 3px;
  font-size: var(--fs-xs);
  line-height: 1.5;
  color: var(--text-3);
}
.card-arrow {
  flex: none;
  width: 15px;
  height: 15px;
  color: var(--text-3);
  transition: color var(--dur) var(--ease), transform var(--dur) var(--ease);
}
.card:hover .card-arrow {
  color: var(--text-2);
  transform: translateX(2px);
}
.card-del {
  flex: none;
  width: 34px;
  height: 34px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 999px;
  color: var(--text-3);
  cursor: pointer;
  transition: color var(--dur) var(--ease), background var(--dur) var(--ease);
}
.card-del:hover {
  color: var(--danger);
  background: color-mix(in oklch, var(--danger) 10%, transparent);
}
.card-del svg {
  width: 15px;
  height: 15px;
}

/* —— 详情 —— */
.back {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-bottom: var(--sp-4);
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
.dt-head {
  display: flex;
  align-items: center;
  gap: var(--sp-4);
}
.dt-avatar {
  flex: none;
  width: 76px;
  height: 76px;
  object-fit: cover;
  border-radius: 50%;
  border: 1px solid var(--line);
}
.dt-avatar-ph {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: var(--bg-elev);
  color: var(--text-3);
}
.dt-avatar-ph svg {
  width: 28px;
  height: 28px;
}
.dt-id {
  flex: 1;
  min-width: 0;
}
.dt-name {
  font-size: var(--fs-2xl);
  color: var(--text);
}
.dt-sub {
  margin-top: 5px;
  font-size: var(--fs-sm);
  line-height: 1.6;
  color: var(--text-2);
}
.dt-acts {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: none;
}
.panel {
  margin-top: var(--sp-5);
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
.panel-busy {
  margin-top: 10px;
  font-size: var(--fs-xs);
  color: var(--accent);
}
/* 带 panel-head 的那块由 panel-head 自己留白,只有 Spec 这种裸标题才要补 */
.panel > .panel-title {
  margin-bottom: var(--sp-3);
}

/* —— 设定图 —— */
.sheet-grid {
  display: grid;
  grid-template-columns: repeat(5, 1fr);
  gap: 10px;
}
.cell {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}
/* 空格子是虚线框(点一下即生成),有图的转实线(点一下看大图) */
.cell-img {
  aspect-ratio: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  border: 1px dashed var(--line-strong);
  border-radius: var(--r-sm);
  background: var(--bg);
  color: var(--text-3);
  cursor: pointer;
  transition: border-color var(--dur) var(--ease), opacity var(--dur) var(--ease),
    color var(--dur) var(--ease);
}
.cell-img.has-img {
  border-style: solid;
  border-color: var(--line);
}
.cell-img:hover:not(:disabled) {
  border-color: var(--accent);
  color: var(--text);
}
.cell-img:disabled {
  cursor: default;
}
/* 正在出的那一张:实线 accent 描边 + 呼吸,和"还没生成"区分开 */
.cell-img.busy {
  border-style: solid;
  border-color: var(--accent);
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
.cell-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-align: center;
  font-size: var(--fs-micro);
  color: var(--text-3);
}
.cell-acts {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
}
.cell-act {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: var(--fs-micro);
  color: var(--text-3);
  cursor: pointer;
  transition: color var(--dur) var(--ease);
}
.cell-act:hover:not(:disabled) {
  color: var(--accent);
}
.cell-act:disabled {
  cursor: default;
}
.cell-act.on {
  color: var(--accent);
}
.cell-act svg {
  width: 11px;
  height: 11px;
}

/* —— 规格表 —— */
.spec {
  display: grid;
  grid-template-columns: 84px 1fr;
  gap: 8px 12px;
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
  max-width: min(760px, 100%);
  max-height: 100%;
  border-radius: var(--r);
  overflow: hidden;
  background: var(--surface);
  box-shadow: var(--sh-md);
}
.viewer-img {
  max-width: 100%;
  max-height: calc(100vh - 160px);
  object-fit: contain;
  display: block;
  background: var(--stage-bg);
}
.viewer-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-3);
  padding: 10px var(--sp-3) 10px var(--sp-4);
}
.viewer-label {
  font-size: var(--fs-sm);
  color: var(--text-2);
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

/* —— 空态 —— */
.empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  margin-top: var(--sp-7);
  text-align: center;
}
.empty-ico {
  width: 34px;
  height: 34px;
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
  .chars {
    padding: var(--sp-5) var(--sp-4) var(--sp-7);
  }
  .chars-head {
    flex-direction: column;
    gap: 12px;
  }
  .ed-fields {
    grid-template-columns: 1fr;
    gap: 6px;
  }
  .ed-label {
    margin-top: 4px;
  }
  .grid {
    grid-template-columns: 1fr;
  }
  /* 五格一排会把每格压到看不清,窄屏改成三列两行 */
  .sheet-grid {
    grid-template-columns: repeat(3, 1fr);
  }
  .dt-head {
    flex-wrap: wrap;
    gap: var(--sp-3);
  }
  .dt-acts {
    width: 100%;
    flex-wrap: wrap;
  }
  .spec {
    grid-template-columns: 1fr;
    gap: 2px var(--sp-3);
  }
  .spec-v {
    margin-bottom: 8px;
  }
  /* 触控目标放大到 40px */
  .card-del,
  .viewer-x {
    width: 40px;
    height: 40px;
  }
}
</style>
