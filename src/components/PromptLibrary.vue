<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import {
  PhPlus,
  PhDotsThreeVertical,
  PhTrash,
  PhImage,
  PhCaretLeft,
  PhPencilSimple,
  PhCaretDown,
  PhCopy,
  PhArrowUpRight,
  PhDownloadSimple,
  PhUploadSimple,
  PhX
} from '@phosphor-icons/vue'
import { BACKGROUND_OPTIONS, QUALITY_OPTIONS, optionLabel, coverSrc } from '../api'
import { titleFromPrompt } from '../lib/text'
import type { PromptItem } from '../types'

/* 提示词库:独立页面,分两屏 —— 网格(browse)与表单(新建/编辑)。
   两屏合一而不是各占一个导航项:表单只从库里进出,给它一个平级入口没有意义。
   这与接口设置页是同一套做法(草稿由表单自己持有,所以"返回"就是真正的放弃)。 */

const props = defineProps<{
  items: PromptItem[]
}>()

const emit = defineEmits<{
  (e: 'use', item: PromptItem): void
  (e: 'remove', id: string): void
  (e: 'save', item: PromptItem): void
  (e: 'import', items: PromptItem[]): void
}>()

const MENU_MORE = 'more'
const MENU_SORT = 'sort'
const view = ref<'grid' | 'form'>('grid')
const query = ref('')
// 标签筛选。'All' 是"不筛",与标签同处一排,所以单独用一个哨兵值而不是空串
const tagFilter = ref('All')
type SortKey = 'recent' | 'title' | 'uses'
const sort = ref<SortKey>('recent')
// 哪个菜单开着(卡片菜单用 id,顶部两个用固定键)。同时只开一个
const openMenu = ref<string>('')
// 复制成功的短暂回执:库里没有通知系统,就地在这张卡的元信息位置显示一下
const copiedId = ref('')
let copiedTimer: number | undefined
/* 卡片菜单默认朝下开。最后一行离视口底部不够高时改朝上 —— 否则菜单会伸到屏幕外,
   "删除"那一项根本够不着(实测末行卡片就是这样) */
const menuUp = ref(false)
// 菜单大致高度(三项 + 内边距 + 与按钮的间距),留一点余量
const MENU_ROOM = 130

function toggleMenu(key: string, e: MouseEvent) {
  if (openMenu.value === key) {
    openMenu.value = ''
    return
  }
  const r = (e.currentTarget as HTMLElement | null)?.getBoundingClientRect()
  menuUp.value = !!r && r.bottom + MENU_ROOM > window.innerHeight
  openMenu.value = key
}

/* 菜单展开后点别处收起:管理动作低频,不该逼用户再点一次 ⋮ 才能走。
   用 closest 判断"点的是不是某个菜单内部",而不是记住某一个容器 ——
   这一页有三个菜单(顶部管理、排序、每张卡各一个),一个 ref 挂多处只会拿到最后一个 */
function onDocPointerDown(e: PointerEvent) {
  if (!openMenu.value) return
  const t = e.target as Element | null
  if (t && typeof t.closest === 'function' && t.closest('.menu-wrap')) return
  openMenu.value = ''
}
onMounted(() => document.addEventListener('pointerdown', onDocPointerDown))
onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onDocPointerDown)
  window.clearTimeout(copiedTimer)
})

// —— 筛选与排序 ——

/* 标签及其条数。按条数从多到少:用得多的排前面,一条的沉在后面。
   条数直接摆在标签上,不用点进去才知道里面有几条 */
const tagCounts = computed(() => {
  const map = new Map<string, number>()
  for (const it of props.items) for (const t of it.tags || []) map.set(t, (map.get(t) || 0) + 1)
  return [...map.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
})

const SORTS: Array<{ key: SortKey; label: string }> = [
  { key: 'recent', label: 'Most recent' },
  { key: 'uses', label: 'Most used' },
  { key: 'title', label: 'Title A–Z' }
]
const sortLabel = computed(() => SORTS.find((s) => s.key === sort.value)?.label || 'Most recent')
function pickSort(key: SortKey) {
  sort.value = key
  openMenu.value = ''
}

function titleOf(item: PromptItem): string {
  return item.title?.trim() || titleFromPrompt(item.prompt)
}

/* 封面左上角那枚是模型名(见模板),分类改到下沿显示:
   第一个标签,加上"还有几个" —— 多个标签全铺开会把下沿挤到贴住按钮 */
function leadTag(item: PromptItem): string {
  return (item.tags || [])[0] || ''
}
function extraTags(item: PromptItem): number {
  return Math.max(0, (item.tags || []).length - 1)
}

const filtered = computed(() => {
  let list = props.items
  if (tagFilter.value !== 'All') {
    list = list.filter((i) => (i.tags || []).includes(tagFilter.value))
  }
  const q = query.value.trim().toLowerCase()
  if (q) {
    /* 标题与标签一起参与搜索:只看正文的话,记得住标题或标签的人反而搜不到 */
    list = list.filter((i) =>
      `${i.title || ''} ${i.prompt} ${(i.tags || []).join(' ')}`.toLowerCase().includes(q)
    )
  }
  const out = [...list]
  if (sort.value === 'title') out.sort((a, b) => titleOf(a).localeCompare(titleOf(b)))
  else if (sort.value === 'uses') out.sort((a, b) => (b.uses || 0) - (a.uses || 0) || b.createdAt - a.createdAt)
  // 默认:最近存的在最前(props.items 本身已是这个顺序,这里显式写出来免得依赖上游)
  else out.sort((a, b) => b.createdAt - a.createdAt)
  return out
})

/* 表单右栏那份只读的参数摘要。它们是收藏时自动记下的,改参数去生成页那边改。
   尺寸写成 × 而不是 x:界面上其他地方都是这么写的 */
function paramLine(item: PromptItem): string {
  const out: string[] = []
  if (item.quality) out.push(optionLabel(QUALITY_OPTIONS, item.quality))
  if (item.background) out.push(optionLabel(BACKGROUND_OPTIONS, item.background))
  return out.join(' · ')
}
function savedParams(item: PromptItem): string {
  const size = item.size === 'auto' ? 'Auto' : item.size?.replace('x', '×')
  return [size, paramLine(item)].filter(Boolean).join(' · ')
}

function fmtDate(t: number) {
  const d = new Date(t)
  const p = (x: number) => String(x).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

// 搜索与标签是两套筛选,空态里要能一键把两个都清掉
function resetFilter() {
  query.value = ''
  tagFilter.value = 'All'
}

// —— 表单 ——

const draft = ref<PromptItem>(blank())
const draftTag = ref('')
// 已经有别的条目在用的标签:点一下就加,免得到处是拼写只差一点点的重名标签
const suggestedTags = computed(() =>
  tagCounts.value.map(([t]) => t).filter((t) => !(draft.value.tags || []).includes(t))
)
const draftTitle = computed(() => titleOf(draft.value))

function blank(): PromptItem {
  return { id: '', prompt: '', tags: [], title: '', createdAt: Date.now() }
}

function startNew() {
  draft.value = blank()
  draftTag.value = ''
  openMenu.value = ''
  view.value = 'form'
}

function startEdit(item: PromptItem) {
  // 复制一份:表单改的是草稿,取消就等于没发生过
  draft.value = { ...item, tags: [...(item.tags || [])] }
  draftTag.value = ''
  openMenu.value = ''
  view.value = 'form'
}

function cancelForm() {
  view.value = 'grid'
}

function addDraftTag(raw?: string) {
  const t = (raw ?? draftTag.value).trim()
  if (!t) return
  const tags = draft.value.tags || []
  // 大小写不同的同一个词不该并存,但保留用户第一次写下的那种拼法
  if (!tags.some((x) => x.toLowerCase() === t.toLowerCase())) tags.push(t)
  draft.value.tags = tags
  draftTag.value = ''
}

function dropDraftTag(t: string) {
  draft.value.tags = (draft.value.tags || []).filter((x) => x !== t)
}

/* 草稿里只留用户真正填过的东西:空标签数组、空标题、空参数的字段
   存下来只会让 JSON 变长,读取时还要多一层判断 */
function saveForm() {
  const prompt = draft.value.prompt.trim()
  if (!prompt) return
  const item: PromptItem = {
    ...draft.value,
    prompt,
    title: draft.value.title?.trim() || undefined,
    model: draft.value.model?.trim() || undefined,
    tags: (draft.value.tags || []).map((t) => t.trim()).filter(Boolean),
    id: draft.value.id || Date.now() + Math.random().toString(16).slice(2)
  }
  emit('save', item)
  view.value = 'grid'
}

// —— 卡片动作 ——

async function copyPrompt(item: PromptItem) {
  openMenu.value = ''
  try {
    await navigator.clipboard.writeText(item.prompt)
    copiedId.value = item.id
    window.clearTimeout(copiedTimer)
    copiedTimer = window.setTimeout(() => (copiedId.value = ''), 1600)
  } catch {
    /* 剪贴板写不进去时什么都不做:回执说"已复制"而实际没写,
       比没有回执更糟 —— 用户会关掉页面才发现粘贴出来是旧的 */
  }
}

function removeItem(item: PromptItem) {
  openMenu.value = ''
  emit('remove', item.id)
}

// —— 导入导出 ——

function exportJson() {
  openMenu.value = ''
  /* 封面不进备份:它是原图,几十条能凑出几百 MB 的 JSON,而这份文件的用处是
     "把提示词与参数搬到别处" —— 图本来就在别处。以前封面是张 6KB 的缩略图,
     顺带打包无所谓;现在得显式摘掉,否则 JSON.stringify 会把 Blob 写成 {} */
  const slim = props.items.map((i) => {
    const copy = { ...i }
    delete copy.cover
    delete copy.thumb
    return copy
  })
  const blob = new Blob([JSON.stringify(slim, null, 2)], { type: 'application/json' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = `kimage-prompts-${Date.now()}.json`
  a.click()
  // 立刻 revoke 在 WebKit 下偶尔会把下载掐断,等浏览器把文件接走再撤
  setTimeout(() => URL.revokeObjectURL(a.href), 1500)
}

function onImportFile(e: Event) {
  openMenu.value = ''
  const file = (e.target as HTMLInputElement).files?.[0]
  if (!file) return
  const reader = new FileReader()
  reader.onload = () => {
    try {
      const arr = JSON.parse(String(reader.result))
      if (Array.isArray(arr)) emit('import', arr)
    } catch {
      /* ignore invalid */
    }
  }
  reader.readAsText(file)
  ;(e.target as HTMLInputElement).value = ''
}
</script>

<template>
  <section class="lib" aria-label="Prompt library">
    <!-- ===== 浏览 ===== -->
    <template v-if="view === 'grid'">
      <header class="lib-head">
        <div>
          <h1 class="lib-title">Prompt Library</h1>
          <p class="lib-sub">
            {{ items.length }} {{ items.length === 1 ? 'prompt' : 'prompts' }} · saved in this
            browser
          </p>
        </div>
        <!-- 导入导出是低频管理动作,收进菜单,不给标题行添按钮 -->
        <span class="menu-wrap">
          <button
            class="icon-ghost"
            :aria-expanded="openMenu === MENU_MORE"
            aria-label="More actions"
            @click="toggleMenu(MENU_MORE, $event)"
          >
            <PhDotsThreeVertical weight="bold" aria-hidden="true" />
          </button>
          <Transition name="po">
            <div v-if="openMenu === MENU_MORE" class="menu" :class="{ up: menuUp }">
              <button class="mitem" @click="exportJson">
                <PhDownloadSimple aria-hidden="true" />
                Export JSON
              </button>
              <label class="mitem file">
                <PhUploadSimple aria-hidden="true" />
                Import JSON
                <input type="file" accept=".json" hidden @change="onImportFile" />
              </label>
            </div>
          </Transition>
        </span>
      </header>

      <!-- 一行:搜索 + 新建。标题独占上排之后,这两个最常用的动作在同一行里相遇 -->
      <div class="lib-tools">
        <input
          v-model="query"
          class="search"
          type="search"
          placeholder="Search prompts, titles or tags…"
          spellcheck="false"
          aria-label="Search prompts"
        />
        <button class="lib-new" @click="startNew">
          <PhPlus aria-hidden="true" />
          New prompt
        </button>
      </div>

      <div v-if="items.length" class="lib-filter">
        <div class="cat-row">
          <button class="cat" :class="{ on: tagFilter === 'All' }" @click="tagFilter = 'All'">
            All
            <span class="cat-n">{{ items.length }}</span>
          </button>
          <button
            v-for="[t, n] in tagCounts"
            :key="t"
            class="cat"
            :class="{ on: tagFilter === t }"
            @click="tagFilter = t"
          >
            {{ t }}
            <span class="cat-n">{{ n }}</span>
          </button>
        </div>
        <span class="menu-wrap">
          <button
            class="sort-btn"
            :aria-expanded="openMenu === MENU_SORT"
            aria-label="Sort prompts"
            @click="toggleMenu(MENU_SORT, $event)"
          >
            {{ sortLabel }}
            <PhCaretDown aria-hidden="true" />
          </button>
          <Transition name="po">
            <div v-if="openMenu === MENU_SORT" class="menu" :class="{ up: menuUp }">
              <button
                v-for="s in SORTS"
                :key="s.key"
                class="mitem"
                :class="{ on: sort === s.key }"
                @click="pickSort(s.key)"
              >
                {{ s.label }}
              </button>
            </div>
          </Transition>
        </span>
      </div>

      <ul v-if="filtered.length" class="lib-grid">
        <!-- 封面与正文是一整块可点区域:点开就是这条的详情兼编辑。
             取用/删除留在下沿 —— 它们是"动作",不该和"打开"抢同一次点击 -->
        <li v-for="item in filtered" :key="item.id" class="card" :class="{ 'menu-open': openMenu === item.id }">
          <button
            class="card-open"
            :aria-label="`Open ${titleOf(item)}`"
            @click="startEdit(item)"
          >
            <span class="cover">
              <img v-if="item.cover" :src="coverSrc(item.cover)" alt="" />
              <!-- 手动新建的提示词没有配图。做成一块安静的底,不画"缺图"的警示 ——
                   它只是没存过封面,不是出错 -->
              <span v-else class="cover-none" aria-hidden="true"><PhImage /></span>
              <!-- 封面上这枚是模型名:一张图"是谁出的"是看图时最想知道的事,
                   它跟着图走,所以贴在图角上。分类挪到下沿(见 .card-tag) -->
              <span v-if="item.model" class="cover-tag">{{ item.model }}</span>
              <!-- 次数摆在封面上:它回答"这条我到底用过没有",而不占正文的行 -->
              <span v-if="item.uses" class="cover-uses">{{ item.uses }}×</span>
            </span>
            <span class="card-body">
              <b class="card-title">{{ titleOf(item) }}</b>
              <span class="card-text">{{ item.prompt }}</span>
            </span>
          </button>
          <div class="card-foot">
            <span v-if="copiedId === item.id" class="card-meta copied">Copied</span>
            <!-- 分类从封面挪到下沿:有分类就显示分类(第一个 + 其余几个),
                 手写的、没分类的条目退回显示时间 -->
            <span v-else-if="leadTag(item)" class="card-tag" :title="fmtDate(item.createdAt)">
              {{ leadTag(item) }}
              <template v-if="extraTags(item)">+{{ extraTags(item) }}</template>
            </span>
            <span v-else class="card-meta" :title="fmtDate(item.createdAt)">{{
              fmtDate(item.createdAt)
            }}</span>
            <div class="ops">
              <!-- 取用是卡片上最高频的动作,所以留在卡面上,不进菜单。
                   用图标而不是"Use"两个字:下沿这一行还要挤分类与 ⋮,
                   文字按钮占的宽度是图标的近三倍,而它的名字靠 tooltip 补 -->
              <button
                class="icon-ghost sm"
                data-tip="Use this prompt"
                :aria-label="`Use: ${titleOf(item)}`"
                @click="emit('use', item)"
              >
                <PhArrowUpRight aria-hidden="true" />
              </button>
              <span class="menu-wrap">
                <button
                  class="icon-ghost sm"
                  data-tip="More actions"
                  :aria-expanded="openMenu === item.id"
                  :aria-label="`Actions for ${titleOf(item)}`"
                  @click="toggleMenu(item.id, $event)"
                >
                  <PhDotsThreeVertical weight="bold" aria-hidden="true" />
                </button>
                <Transition name="po">
                  <div v-if="openMenu === item.id" class="menu" :class="{ up: menuUp }">
                    <button class="mitem" @click="copyPrompt(item)">
                      <PhCopy aria-hidden="true" />
                      Copy prompt
                    </button>
                    <button class="mitem" @click="startEdit(item)">
                      <PhPencilSimple aria-hidden="true" />
                      Edit
                    </button>
                    <button class="mitem danger" @click="removeItem(item)">
                      <PhTrash aria-hidden="true" />
                      Delete
                    </button>
                  </div>
                </Transition>
              </span>
            </div>
          </div>
        </li>
      </ul>

      <!-- 空态分两种:库里真没有(引到新建) / 筛选没命中(给一键清空) -->
      <div v-else class="lib-none">
        <h2 class="none-title">{{ items.length ? 'No matching prompts' : 'No prompts yet' }}</h2>
        <p class="none-sub">
          {{
            items.length
              ? 'Try another keyword, or switch the tag back to "All".'
              : 'Generate an image, then open the preview and choose "More actions → Save to library". You can also write one here.'
          }}
        </p>
        <button v-if="items.length" class="none-action" @click="resetFilter">Clear filters</button>
        <button v-else class="none-action" @click="startNew">New prompt</button>
      </div>
    </template>

    <!-- ===== 新建 / 编辑 ===== -->
    <template v-else>
      <header class="form-head">
        <button class="back" @click="cancelForm">
          <PhCaretLeft aria-hidden="true" />
          Library
        </button>
        <h1 class="lib-title">{{ draft.id ? 'Edit prompt' : 'New prompt' }}</h1>
        <p class="lib-sub">
          {{
            draft.id
              ? 'Change anything here. The saved parameters stay as they were.'
              : 'Write a prompt you want to keep. Tags are yours — a prompt can carry several.'
          }}
        </p>
      </header>

      <div class="form-grid">
        <div class="form-main">
          <label class="field">
            <span class="field-label">Title</span>
            <input
              v-model="draft.title"
              class="field-input"
              :placeholder="draft.prompt ? draftTitle : 'Optional — taken from the prompt'"
              spellcheck="false"
            />
          </label>

          <label class="field">
            <span class="field-label">Prompt</span>
            <textarea
              v-model="draft.prompt"
              class="field-area"
              rows="9"
              placeholder="Describe the image…"
              spellcheck="false"
            ></textarea>
          </label>

          <div class="field">
            <span class="field-label">Tags</span>
            <div class="tag-edit">
              <span v-for="t in draft.tags || []" :key="t" class="tag-chip">
                {{ t }}
                <button :aria-label="`Remove tag ${t}`" @click="dropDraftTag(t)">
                  <PhX aria-hidden="true" />
                </button>
              </span>
              <input
                v-model="draftTag"
                class="tag-input"
                placeholder="Add a tag and press Enter"
                spellcheck="false"
                aria-label="Add tag"
                @keydown.enter.prevent="addDraftTag()"
              />
            </div>
            <!-- 已经在别处用过的标签:点一下就加。不给这一步的话,
                 同一个词会以几种拼法各存一份,标签就失去了分类的意义 -->
            <div v-if="suggestedTags.length" class="tag-suggest">
              <span class="tag-suggest-label">Used before</span>
              <button
                v-for="t in suggestedTags.slice(0, 8)"
                :key="t"
                class="tag-suggest-item"
                @click="addDraftTag(t)"
              >
                {{ t }}
              </button>
            </div>
          </div>
        </div>

        <aside class="form-side">
          <div class="field">
            <span class="field-label">Cover</span>
            <span class="side-cover">
              <img v-if="draft.cover" :src="coverSrc(draft.cover)" alt="" />
              <span v-else class="cover-none" aria-hidden="true"><PhImage /></span>
            </span>
            <span class="side-hint">
              {{
                draft.cover
                  ? 'Kept from the image this prompt came from.'
                  : 'No cover — this prompt was written by hand.'
              }}
            </span>
          </div>

          <label class="field">
            <span class="field-label">Model</span>
            <input v-model="draft.model" class="field-input" placeholder="Not recorded" spellcheck="false" />
          </label>

          <div v-if="savedParams(draft)" class="field">
            <span class="field-label">Saved parameters</span>
            <span class="side-hint">{{ savedParams(draft) }}</span>
            <span class="side-hint dim">Changing these happens on the generate page.</span>
          </div>

          <div v-if="draft.id" class="field">
            <span class="field-label">Saved</span>
            <span class="side-hint">
              {{ fmtDate(draft.createdAt) }}
              <template v-if="draft.uses"> · used {{ draft.uses }}×</template>
            </span>
          </div>
        </aside>
      </div>

      <div class="form-ops">
        <button class="ops-cancel" @click="cancelForm">Cancel</button>
        <button class="ops-save" :disabled="!draft.prompt.trim()" @click="saveForm">
          {{ draft.id ? 'Save changes' : 'Save to library' }}
        </button>
      </div>
    </template>
  </section>
</template>

<style scoped>
/* ===== 浏览 ===== */
.lib-head {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  justify-content: space-between;
  gap: var(--sp-4);
  padding-top: var(--sp-2);
}
.lib-title {
  font-family: var(--font-sans);
  font-size: var(--fs-3xl);
  font-weight: 700;
  letter-spacing: var(--ls-tight);
}
.lib-sub {
  margin-top: 6px;
  font-size: var(--fs-sm);
  /* 用 text-2 而不是 text-3:#999 在浅色面上只有 2.85:1,正文级文字要达到 4.5:1 */
  color: var(--text-2);
}
/* 搜索与新建同处一行:两者都是"从这里开始"的动作,分到两行就散了 */
.lib-tools {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  margin-top: var(--sp-5);
}
.search {
  flex: 1;
  min-width: 0;
  height: 40px;
  padding: 0 14px;
  border: 1px solid var(--line);
  border-radius: 999px;
  background: var(--surface);
  font-size: var(--fs-base);
  transition: border-color var(--dur) var(--ease), box-shadow var(--dur) var(--ease);
}
.search:focus {
  outline: none;
  border-color: color-mix(in oklch, var(--accent) 45%, var(--line));
  box-shadow: 0 6px 22px -10px color-mix(in oklch, var(--accent) 40%, transparent);
}
.search::-webkit-search-cancel-button {
  -webkit-appearance: none;
}
.lib-new {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex: none;
  height: 40px;
  padding: 0 16px;
  border-radius: 999px;
  background: var(--cta);
  color: var(--cta-text);
  font-size: var(--fs-sm);
  font-weight: 500;
  transition: background var(--dur) var(--ease);
}
.lib-new svg {
  width: 15px;
  height: 15px;
}
.lib-new:hover {
  background: var(--cta-hover);
}

/* 标签与排序同处一行:一个筛、一个排,是同一层级的"看哪几条、按什么顺序" */
.lib-filter {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-3);
  margin-top: var(--sp-4);
  padding-bottom: var(--sp-4);
  border-bottom: 1px solid var(--line);
}
.cat-row {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.cat {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 5px 11px;
  border-radius: 999px;
  font-size: var(--fs-xs);
  border: 1px solid var(--line);
  color: var(--text-2);
  cursor: pointer;
  transition: background var(--dur) var(--ease), border-color var(--dur) var(--ease),
    color var(--dur) var(--ease);
}
.cat:hover {
  color: var(--text);
  border-color: var(--line-strong);
}
/* 选中态用 accent-soft 而不是实心填充,与参数面板的 .param-btn.on 同一档 */
.cat.on {
  background: var(--accent-soft);
  border-color: color-mix(in oklch, var(--accent) 35%, var(--line));
  color: var(--accent);
  font-weight: 500;
}
/* 条数:小一号且更淡,它是注解不是标签名的一部分 */
.cat-n {
  font-size: var(--fs-micro);
  color: var(--text-3);
  font-variant-numeric: tabular-nums;
}
.cat.on .cat-n {
  color: color-mix(in oklch, var(--accent) 70%, transparent);
}
.sort-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex: none;
  height: 32px;
  padding: 0 12px;
  border: 1px solid var(--line);
  border-radius: 999px;
  font-size: var(--fs-xs);
  color: var(--text-2);
  transition: color var(--dur) var(--ease), border-color var(--dur) var(--ease);
}
.sort-btn svg {
  width: 12px;
  height: 12px;
}
.sort-btn:hover {
  color: var(--text);
  border-color: var(--line-strong);
}

/* ===== 卡片 ===== */
/* 用 grid 而不是多列瀑布流:封面固定 1:1、正文固定两行,卡片本来就等高,
   多列反而会让行与行错开 */
.lib-grid {
  list-style: none;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(228px, 1fr));
  gap: var(--sp-4);
  margin-top: var(--sp-5);
}
.card {
  display: flex;
  flex-direction: column;
  /* 不设 overflow:hidden —— 卡片菜单是它的绝对定位子元素,会被一起裁掉。
     封面圆角改由 .cover 自己带(见下),底部的圆角由卡片的背景与边框负责 */
  position: relative;
  border: 1px solid var(--line);
  border-radius: var(--r);
  background: var(--surface);
  transition: border-color var(--dur) var(--ease), box-shadow var(--dur) var(--ease),
    transform var(--dur) var(--ease);
}
/* 悬停/聚焦时整张卡离开纸面一点。只抬 2px —— 再多会像在跳,
   这里要的只是"这张被指到了";阴影升到 --sh-md,与首页图砖取齐 */
.card:hover,
.card:focus-within {
  transform: translateY(-2px);
  box-shadow: var(--sh-md);
  border-color: var(--line-strong);
}
/* transform 会让这张卡自己形成一个层叠上下文,于是排在它后面的兄弟卡会盖住菜单。
   菜单开着的那张必须显式抬到它们之上 */
.card.menu-open {
  z-index: 2;
}
.card-open {
  display: block;
  width: 100%;
  padding: 0;
  text-align: left;
  cursor: pointer;
}
.cover {
  position: relative;
  display: grid;
  place-items: center;
  aspect-ratio: 1;
  overflow: hidden;
  background: var(--image-bg);
  /* 顶部两个角自己圆掉:卡片不再裁子元素了,这里要跟卡片内沿对齐(减去 1px 边框) */
  border-top-left-radius: calc(var(--r) - 1px);
  border-top-right-radius: calc(var(--r) - 1px);
}
.cover img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  transition: transform 600ms var(--ease);
}
.card:hover .cover img {
  transform: scale(1.04);
}
.cover-none {
  display: grid;
  place-items: center;
  width: 100%;
  height: 100%;
  color: var(--text-4);
}
.cover-none svg {
  width: 26px;
  height: 26px;
}
/* 封面上的两个角标:模型名在左上,取用次数在右下。
   都压在图上,所以都要自带底衬,不然浅色图上读不出来 */
.cover-tag,
.cover-uses {
  position: absolute;
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 3px 8px;
  border-radius: 999px;
  font-size: var(--fs-micro);
  font-weight: 500;
  color: #fff;
  background: rgba(0, 0, 0, 0.55);
  -webkit-backdrop-filter: blur(6px);
  backdrop-filter: blur(6px);
}
.cover-tag {
  top: 8px;
  left: 8px;
  /* block 而不是沿用上面的 inline-flex:模型名比分类长得多
     (gemini-2.5-flash-image-preview 这类),得真截断 ——
     flex 容器里文字是 flex item,text-overflow 不生效 */
  display: block;
  max-width: calc(100% - 16px);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.cover-uses {
  right: 8px;
  bottom: 8px;
  font-variant-numeric: tabular-nums;
}
.card-body {
  display: block;
  padding: 12px 14px 10px;
}
.card-title {
  display: block;
  font-size: var(--fs-base);
  font-weight: 600;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* 正文固定两行:封面已经占了整张卡的上半,正文再放开会让卡片长成一条竖条,
   整页扫不动 —— 完整提示词点开卡片就能看到 */
.card-text {
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  overflow: hidden;
  margin-top: 4px;
  font-size: var(--fs-xs);
  line-height: 1.5;
  color: var(--text-2);
}
.card-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-2);
  margin-top: auto;
  padding: 10px 12px 10px 14px;
  border-top: 1px solid var(--line);
}
.card-meta {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--fs-micro);
  color: var(--text-3);
}
/* 卡片下沿的分类。用 --accent-soft 底 + accent 字:标签在这个页面一直是这套语言
   (见表单里的 .tag-chip),换个底色会让"分类"看着像另一种东西。
   min-width:0 是必须的 —— 没有它,flex 子项不会收缩,长标签会把右边的按钮顶出去 */
.card-tag {
  min-width: 0;
  display: inline-block;
  padding: 2px 8px;
  border-radius: 999px;
  font-size: var(--fs-micro);
  background: var(--accent-soft);
  color: var(--accent);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.card-meta.copied {
  color: var(--accent);
  font-weight: 500;
}
.ops {
  display: flex;
  align-items: center;
  gap: 4px;
  flex: none;
}
/* ===== 菜单(顶部管理与卡片菜单共用一个外观) ===== */
.menu-wrap {
  position: relative;
  display: inline-flex;
}
.icon-ghost {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  border: 1px solid var(--line);
  border-radius: 999px;
  color: var(--text-2);
  background: var(--surface);
  cursor: pointer;
  transition: color var(--dur) var(--ease), border-color var(--dur) var(--ease),
    background var(--dur) var(--ease);
}
.icon-ghost svg {
  width: 15px;
  height: 15px;
}
/* 卡片下沿那两个小一号(取用与更多):40px 会把这一行顶高。
   它们都没有文字,靠 data-tip 说明用途 —— 图标按钮不给提示就只剩猜 */
.icon-ghost.sm {
  width: 30px;
  height: 30px;
  border-color: transparent;
}
.icon-ghost:hover {
  color: var(--text);
  border-color: var(--line-strong);
  background: var(--bg-elev);
}
.menu {
  position: absolute;
  top: calc(100% + 6px);
  right: 0;
  z-index: 6;
  min-width: 152px;
  padding: 4px;
  display: flex;
  flex-direction: column;
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: var(--r-sm);
  box-shadow: var(--sh-md);
}
/* 下方放不下时朝上开:末行的卡片用它,不然菜单会伸到视口外 */
.menu.up {
  top: auto;
  bottom: calc(100% + 6px);
}
.mitem {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  text-align: left;
  /* 菜单里既有 button 也有 label(Import 那一项):button 的 line-height 是 UA 的
     normal,而 label 会继承正文的 1.6,两个并排就一高一矮(实测 32px vs 37px)。
     这里统一成 normal,让它们回到同一个高度 */
  line-height: normal;
  font-size: var(--fs-sm);
  color: var(--text-2);
  border-radius: 6px;
  cursor: pointer;
  transition: background var(--dur) var(--ease), color var(--dur) var(--ease);
}
.mitem svg {
  width: 14px;
  height: 14px;
}
.mitem:hover {
  background: var(--bg-elev);
  color: var(--text);
}
.mitem.on {
  color: var(--accent);
  font-weight: 500;
}
.mitem.danger:hover {
  color: var(--danger, #b4232a);
}
/* Import 那一项是 label(里面藏着 file input)。这里不再覆盖 display:
   .mitem 的 flex + gap 才让图标与文字对齐 —— 覆盖成 block 时,
   SVG 只能跟文字靠基线对齐,会往下一截 */

/* ===== 空态 ===== */
.lib-none {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  padding: clamp(48px, 12vh, 110px) var(--sp-4);
}
.none-title {
  font-size: var(--fs-xl);
  font-weight: 600;
}
.none-sub {
  margin-top: 8px;
  max-width: 46ch;
  font-size: var(--fs-sm);
  line-height: 1.6;
  color: var(--text-2);
}
.none-action {
  margin-top: var(--sp-5);
  height: 36px;
  padding: 0 16px;
  border-radius: 999px;
  border: 1px solid var(--line-strong);
  font-size: var(--fs-sm);
  color: var(--text);
  transition: background var(--dur) var(--ease);
}
.none-action:hover {
  background: var(--surface-hover);
}

/* ===== 表单 ===== */
.form-head {
  padding-top: var(--sp-2);
}
.back {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin-bottom: var(--sp-4);
  font-size: var(--fs-sm);
  color: var(--text-2);
  transition: color var(--dur) var(--ease);
}
.back svg {
  width: 13px;
  height: 13px;
}
.back:hover {
  color: var(--text);
}
/* 左编辑右信息:右栏不是"设置",而是这条记录本身的样子(封面、模型、参数)。
   两栏都只在 860px 以上并排,窄屏一律单列 */
.form-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 300px;
  gap: var(--sp-6, 32px);
  margin-top: var(--sp-5);
}
.form-main,
.form-side {
  display: flex;
  flex-direction: column;
  gap: var(--sp-5);
  min-width: 0;
}
.field {
  display: flex;
  flex-direction: column;
  gap: 7px;
}
.field-label {
  font-size: var(--fs-xs);
  font-weight: 500;
  color: var(--text-2);
}
.field-input,
.field-area {
  width: 100%;
  padding: 10px 12px;
  border: 1px solid var(--line);
  border-radius: var(--r-sm);
  background: var(--surface);
  font-size: var(--fs-base);
  transition: border-color var(--dur) var(--ease), box-shadow var(--dur) var(--ease);
}
.field-area {
  line-height: 1.6;
  resize: vertical;
  min-height: 180px;
}
.field-input:focus,
.field-area:focus {
  outline: none;
  border-color: color-mix(in oklch, var(--accent) 45%, var(--line));
  box-shadow: 0 6px 22px -10px color-mix(in oklch, var(--accent) 40%, transparent);
}

.tag-edit {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  padding: 8px 10px;
  border: 1px solid var(--line);
  border-radius: var(--r-sm);
  background: var(--surface);
}
.tag-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 6px 4px 10px;
  border-radius: 999px;
  font-size: var(--fs-xs);
  background: var(--accent-soft);
  color: var(--accent);
}
.tag-chip button {
  display: grid;
  place-items: center;
  width: 18px;
  height: 18px;
  border-radius: 999px;
  color: inherit;
  opacity: 0.7;
  transition: opacity var(--dur) var(--ease), background var(--dur) var(--ease);
}
.tag-chip button:hover {
  opacity: 1;
  background: color-mix(in oklch, var(--accent) 15%, transparent);
}
.tag-chip svg {
  width: 11px;
  height: 11px;
}
.tag-input {
  flex: 1;
  min-width: 150px;
  padding: 4px 2px;
  font-size: var(--fs-base);
}
.tag-suggest {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}
.tag-suggest-label {
  font-size: var(--fs-micro);
  color: var(--text-3);
}
.tag-suggest-item {
  padding: 3px 9px;
  border: 1px dashed var(--line-strong);
  border-radius: 999px;
  font-size: var(--fs-micro);
  color: var(--text-2);
  transition: color var(--dur) var(--ease), border-color var(--dur) var(--ease);
}
.tag-suggest-item:hover {
  color: var(--text);
  border-color: var(--accent);
}
.side-cover {
  display: grid;
  place-items: center;
  aspect-ratio: 1;
  overflow: hidden;
  border: 1px solid var(--line);
  border-radius: var(--r);
  background: var(--image-bg);
}
.side-cover img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.side-hint {
  font-size: var(--fs-xs);
  line-height: 1.5;
  color: var(--text-2);
}
.side-hint.dim {
  color: var(--text-3);
}
.form-ops {
  display: flex;
  justify-content: flex-end;
  gap: var(--sp-3);
  margin-top: var(--sp-6, 32px);
  padding-top: var(--sp-5);
  border-top: 1px solid var(--line);
}
.ops-cancel,
.ops-save {
  height: 40px;
  padding: 0 20px;
  border-radius: 999px;
  font-size: var(--fs-sm);
  font-weight: 500;
  transition: background var(--dur) var(--ease), color var(--dur) var(--ease),
    border-color var(--dur) var(--ease);
}
.ops-cancel {
  border: 1px solid var(--line-strong);
  color: var(--text-2);
}
.ops-cancel:hover {
  color: var(--text);
  background: var(--surface-hover);
}
.ops-save {
  background: var(--cta);
  color: var(--cta-text);
}
.ops-save:hover:not(:disabled) {
  background: var(--cta-hover);
}
.ops-save:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

/* 窄屏:两栏并排要先有宽度,不够就单列;顺带把触控目标提到 40px */
@media (max-width: 860px) {
  .form-grid {
    grid-template-columns: minmax(0, 1fr);
  }
  /* 侧栏挪到正文之后:窄屏上先写内容,再看它长什么样 */
  .form-side {
    order: 2;
  }
}
@media (max-width: 720px) {
  .lib-tools {
    flex-wrap: wrap;
  }
  .lib-new {
    width: 100%;
    justify-content: center;
  }
  .icon-ghost.sm {
    min-width: 40px;
    height: 40px;
  }
  /* 标签上的 × 跟着放大一档。它嵌在胶囊里,做到 40px 会让标签本身变成一个大方块,
     所以取一个能稳稳点到的中间值 —— 它是个次要动作,主路径是输入框回车 */
  .tag-chip {
    padding: 6px 8px 6px 12px;
  }
  .tag-chip button {
    width: 24px;
    height: 24px;
  }
  .field-input,
  .field-area,
  .tag-input,
  .search {
    /* 16px 以下 iOS Safari 聚焦时会放大整页 */
    font-size: 16px;
  }
}
</style>
