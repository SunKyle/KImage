<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import {
  PhPlus,
  PhDotsThreeVertical,
  PhArrowLineUp,
  PhTrash,
  PhArchive,
  PhImage
} from '@phosphor-icons/vue'
import { BACKGROUND_OPTIONS, QUALITY_OPTIONS, optionLabel } from '../api'
import type { PromptItem } from '../types'

/* 提示词库:独立页面,不再是抽屉。
   整页宽度替代了原来的 410px 窄栏,卡片因此能排成网格、正文能给到两行。
   挂载由 App.vue 用 v-if 控制,所以切走再回来时搜索词和展开状态会自然重置。 */

const props = defineProps<{
  items: PromptItem[]
}>()

const emit = defineEmits<{
  (e: 'use', item: PromptItem): void
  (e: 'remove', id: string): void
  (e: 'add', item: PromptItem): void
  (e: 'import', items: PromptItem[]): void
}>()

const query = ref('')
const filter = ref('All')
const menuOpen = ref(false)
// 菜单展开后点别处收起:低频动作,不该逼用户再点一次 ⋮ 才能走
const menuEl = ref<HTMLElement | null>(null)
function onDocPointerDown(e: PointerEvent) {
  if (!menuOpen.value) return
  const t = e.target as Node | null
  if (t && menuEl.value?.contains(t)) return
  menuOpen.value = false
}
onMounted(() => document.addEventListener('pointerdown', onDocPointerDown))
onBeforeUnmount(() => document.removeEventListener('pointerdown', onDocPointerDown))
const showAdd = ref(false)
const draftPrompt = ref('')
const draftCategory = ref('')

const categories = computed(() => {
  const set = new Set(props.items.map((i) => i.category || 'Uncategorized'))
  return ['All', ...set]
})

const filtered = computed(() => {
  let list = props.items
  if (filter.value !== 'All') list = list.filter((i) => (i.category || 'Uncategorized') === filter.value)
  const q = query.value.trim().toLowerCase()
  if (q) list = list.filter((i) => i.prompt.toLowerCase().includes(q))
  return list
})

/* 参数拼成一行用 · 连接。原来三个描边小胶囊在 322px 的卡里是三个小盒子,
   跟提示词抢视线;拼成一行之后它退成背景信息,提示词才立得住 */
function paramLine(item: PromptItem): string {
  const out: string[] = []
  if (item.size) out.push(item.size === 'auto' ? 'Auto' : item.size)
  if (item.quality) out.push(optionLabel(QUALITY_OPTIONS, item.quality))
  if (item.background) out.push(optionLabel(BACKGROUND_OPTIONS, item.background))
  return out.join(' · ')
}

// 搜索和分类是两套筛选,空态里要能一键把两个都清掉
function resetFilter() {
  query.value = ''
  filter.value = 'All'
}

function startAdd() {
  menuOpen.value = false
  showAdd.value = true
}

function addCurrent() {
  const text = draftPrompt.value.trim()
  if (!text) return
  emit('add', {
    id: Date.now() + Math.random().toString(16).slice(2),
    prompt: text,
    category: draftCategory.value.trim() || 'Uncategorized',
    createdAt: Date.now()
  })
  draftPrompt.value = ''
  draftCategory.value = ''
  showAdd.value = false
}

function exportJson() {
  menuOpen.value = false
  const blob = new Blob([JSON.stringify(props.items, null, 2)], {
    type: 'application/json'
  })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = `kimage-prompts-${Date.now()}.json`
  a.click()
  // 立刻 revoke 在 WebKit 下偶尔会把下载掐断,等浏览器把文件接走再撤
  setTimeout(() => URL.revokeObjectURL(a.href), 1500)
}

function onImportFile(e: Event) {
  menuOpen.value = false
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

function fmt(t: number) {
  const d = new Date(t)
  const p = (x: number) => String(x).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}
</script>

<template>
  <section class="lib" aria-label="Prompt library">
    <header class="lib-head">
      <div class="lib-title-wrap">
        <h1 class="lib-title">Prompt Library</h1>
        <p class="lib-sub">
          {{ items.length }} {{ items.length === 1 ? 'prompt' : 'prompts' }}<template v-if="filter !== 'All'"> · Current category "{{ filter }}"</template>
        </p>
      </div>
      <div class="lib-ops">
        <button class="lib-new" @click="startAdd">
          <PhPlus aria-hidden="true" />
          New prompt
        </button>
        <!-- 管理动作低频,收进菜单,不给标题行添按钮 -->
        <span ref="menuEl" class="menu-wrap">
          <button class="icon-ghost" :aria-expanded="menuOpen" aria-label="More" @click="menuOpen = !menuOpen">
            <PhDotsThreeVertical weight="bold" aria-hidden="true" />
          </button>
          <Transition name="po">
            <div v-if="menuOpen" class="menu">
              <button class="mitem" @click="exportJson">Export JSON</button>
              <label class="mitem file">
                Import JSON
                <input type="file" accept=".json" hidden @change="onImportFile" />
              </label>
            </div>
          </Transition>
        </span>
      </div>
    </header>

    <!-- 工具栏:整页宽度下分类直接换行,不再像窄抽屉那样横向滚动藏起来 -->
    <div class="lib-tools">
      <input v-model="query" class="search" placeholder="Search prompts…" spellcheck="false" />
      <div v-if="categories.length > 1" class="cat-row">
        <button
          v-for="c in categories"
          :key="c"
          class="cat"
          :class="{ on: filter === c }"
          @click="filter = c"
        >
          {{ c }}
        </button>
      </div>
    </div>

    <div v-if="showAdd" class="add-form">
      <input v-model="draftPrompt" placeholder="Enter a prompt" @keydown.enter="addCurrent" />
      <input v-model="draftCategory" placeholder="Category (default: Uncategorized)" @keydown.enter="addCurrent" />
      <div class="add-ops">
        <button class="add-go" @click="addCurrent">Save to library</button>
        <button class="add-cancel" @click="showAdd = false">Cancel</button>
      </div>
    </div>

    <ul v-if="filtered.length" class="lib-grid">
      <!-- 卡片不再整块可点:以前点一下是翻面看封面,而那一面是唯一有图的地方,
           既没有视觉提示、也只是把 320px 的图放大到卡宽。现在封面直接铺在正面,
           点击这个动作就没有必要了 —— 留在卡上的只有两个真动作(取用 / 删除) -->
      <li v-for="item in filtered" :key="item.id" class="card">
        <div class="cover">
          <img v-if="item.thumb" :src="item.thumb" alt="" />
          <!-- 手动新建的提示词没有配图。做成一块安静的底,不画"缺图"的警示 ——
               它只是没存过封面,不是出错 -->
          <span v-else class="cover-none" aria-hidden="true">
            <PhImage />
          </span>
        </div>
        <div class="card-body">
          <div class="card-meta">
            <span class="card-cat">{{ item.category || 'Uncategorized' }}</span>
            <span class="card-time">{{ fmt(item.createdAt) }}</span>
          </div>
          <div class="card-text">{{ item.prompt }}</div>
        </div>
        <div class="card-foot">
          <span class="card-params">{{ paramLine(item) }}</span>
          <div class="ops">
            <button
              class="op"
              data-tip="Use prompt"
              :aria-label="`Use: ${item.prompt.slice(0, 20)}`"
              @click="emit('use', item)"
            >
              <PhArrowLineUp aria-hidden="true" />
            </button>
            <button
              class="op op-del"
              data-tip="Delete"
              :aria-label="`Delete: ${item.prompt.slice(0, 20)}`"
              @click="emit('remove', item.id)"
            >
              <PhTrash aria-hidden="true" />
            </button>
          </div>
        </div>
      </li>
    </ul>

    <!-- 空态分两种:库里真没有(引到新建) / 筛选没命中(给一键清空) -->
    <div v-else class="lib-none">
      <div class="none-ico" aria-hidden="true">
        <!-- Phosphor 的 Archive:表达"库还是空的" -->
        <PhArchive aria-hidden="true" />
      </div>
      <h2 class="none-title">{{ items.length ? 'No matching prompts' : 'No prompts yet' }}</h2>
      <p class="none-sub">
        {{
          items.length
            ? 'Try another keyword, or switch the category back to "All".'
            : 'Generate an image, then open the preview and choose "More actions → Save to library". You can also add one here.'
        }}
      </p>
      <button v-if="items.length" class="none-action" @click="resetFilter">Clear filters</button>
      <button v-else class="none-action" @click="startAdd">New prompt</button>
    </div>
  </section>
</template>

<style scoped>
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
.lib-ops {
  display: flex;
  align-items: center;
  gap: 8px;
  /* 与标题基线对齐时略微抬起,避免贴着页面下沿 */
  padding-bottom: 2px;
}
.lib-new {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 34px;
  padding: 0 14px;
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
.icon-ghost {
  width: 34px;
  height: 34px;
  display: flex;
  align-items: center;
  justify-content: center;
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
.icon-ghost:hover {
  color: var(--text);
  border-color: var(--line-strong);
  background: var(--bg-elev);
}

/* 右上角菜单:管理动作低频,收进来给列表让出空间 */
.menu-wrap {
  position: relative;
  display: inline-flex;
}
.menu {
  position: absolute;
  top: calc(100% + 6px);
  right: 0;
  z-index: 6;
  min-width: 148px;
  padding: 4px;
  display: flex;
  flex-direction: column;
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: var(--r-sm);
  box-shadow: var(--sh-md);
}
.mitem {
  padding: 8px 10px;
  text-align: left;
  font-size: var(--fs-sm);
  color: var(--text-2);
  border-radius: 6px;
  cursor: pointer;
  transition: background var(--dur) var(--ease), color var(--dur) var(--ease);
}
.mitem:hover {
  background: var(--bg-elev);
  color: var(--text);
}
.file {
  display: block;
}

.lib-tools {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--sp-3);
  margin-top: var(--sp-5);
  padding-bottom: var(--sp-4);
  border-bottom: 1px solid var(--line);
}
.search {
  flex: 1 1 220px;
  max-width: 420px;
  padding: 9px 12px;
  border: 1px solid var(--line);
  border-radius: var(--r-sm);
  background: var(--surface);
  font-size: var(--fs-base);
  transition: border-color var(--dur) var(--ease), box-shadow var(--dur) var(--ease);
}
.search:focus {
  outline: none;
  border-color: color-mix(in oklch, var(--accent) 45%, var(--line));
  box-shadow: 0 6px 22px -10px color-mix(in oklch, var(--accent) 40%, transparent);
}
.cat-row {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.cat {
  padding: 4px 10px;
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
  border-color: color-mix(in oklch, var(--accent) 45%, transparent);
  color: var(--accent-strong);
}

.add-form {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: var(--sp-4);
  padding: var(--sp-3);
  border: 1px solid var(--line-strong);
  border-radius: var(--r-sm);
  background: var(--surface);
}
.add-form input {
  padding: 8px 10px;
  border: 1px solid var(--line);
  border-radius: var(--r-sm);
  background: var(--surface);
  font-size: var(--fs-sm);
}
.add-form input:focus {
  outline: none;
  border-color: color-mix(in oklch, var(--accent) 45%, var(--line));
}
.add-ops {
  display: flex;
  gap: 8px;
}
.add-go {
  flex: 1;
  /* 撑满剩余宽度,文案本该居中;全局 button 重置改成 text-align: inherit 后,
     这里不再有浏览器默认的居中,得就地写回来 */
  text-align: center;
  padding: 8px;
  border-radius: var(--r-sm);
  background: var(--cta);
  color: var(--cta-text);
  font-size: var(--fs-sm);
  cursor: pointer;
  transition: background var(--dur) var(--ease);
}
.add-go:hover {
  background: var(--cta-hover);
}
.add-cancel {
  padding: 8px 14px;
  border: 1px solid var(--line);
  border-radius: var(--r-sm);
  color: var(--text-2);
  font-size: var(--fs-sm);
  cursor: pointer;
}
.add-cancel:hover {
  border-color: var(--line-strong);
  color: var(--text);
}

/* 网格:定宽多列,与首页图墙、历史图墙同一套排法 ——
   卡片高矮不一,定宽多列比 auto-fill 网格更能把空格子吃掉,排得紧凑 */
.lib-grid {
  list-style: none;
  margin-top: var(--sp-5);
  column-width: 240px;
  column-gap: var(--sp-3);
  /* 提示词的显示上限(行数)。封面已经占了上半张卡,正文再给满会让卡片长成
     一条 1:2 的白条,整墙扫不动 —— 完整提示词去预览卡读。
     要调卡片的最大高度只改这一个值,.card-text 那边不用动 */
  --card-text-lines: 4;
}
.card {
  /* 多列布局下纵向间距要靠 margin:column-gap 只管列与列之间,管不了上下;
     break-inside 防止一张卡被拆到两列去 */
  margin: 0 0 var(--sp-3);
  break-inside: avoid;
  /* 圆角靠 overflow 裁封面:图要铺到卡片边缘,不能留白边 */
  overflow: hidden;
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
  border-color: var(--line-strong);
  box-shadow: var(--sh-md);
  transform: translateY(-2px);
}

/* —— 封面 ——
   库页原先把封面藏在翻面背后,那是全站唯一一处"图不在正面"的地方,而翻面这件事
   没有任何视觉提示 —— 于是整墙读起来是一叠白纸。库里存的是提示词,但提示词是
   写给图看的,封面放正面之后这一页才和首页图墙、历史图墙是同一套语言 */
.cover {
  position: relative;
  /* 固定正方形并裁切,不跟每张图的真实比例走 ——
     提示词长短本来就不一,封面高度再浮动的话,每张卡的正文起点都不一样,整墙扫不动。
     选 1:1 是因为它对混合比例是最不亏的那一档:本站最常见的输出就是 1024×1024,
     那它是零裁切;横图(3:2)保留 2/3 宽度,竖图(2:3)保留 2/3 高度。
     换成 4:3 看着更"照片",但竖图只剩一半高度,封面就认不出是哪张了 */
  aspect-ratio: 1 / 1;
  overflow: hidden;
  background: var(--image-bg);
}
.cover img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
  transition: transform 600ms var(--ease);
}
/* 与首页图砖同一档反馈:悬停时封面极缓推近 */
.card:hover .cover img {
  transform: scale(1.04);
}
/* 手动新建的提示词没有配图,做成一块安静的底。
   不画"缺图"的警示 —— 它只是没存过封面,不是出错 */
.cover-none {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-4);
}
.cover-none svg {
  width: 24px;
  height: 24px;
}
/* 脚注与正文之间靠留白分开,不画横线 */
.card-body {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  padding: var(--sp-4) var(--sp-4) var(--sp-3);
}

/* 分类是全大写微标签,和首屏标题上方那行是同一档读音 ——
   全站只有这两处用这种"拉开字距的小字",于是它们自动成了一组:
   一处说这是什么站,一处说这条属于哪一类。
   字号压到 11px 是为了让它安静下来:提示词才是这张卡最重的元素 */
.card-meta {
  display: flex;
  align-items: baseline;
  gap: var(--sp-2);
  font-size: var(--fs-micro);
  line-height: 1.4;
  color: var(--text-3);
}
.card-cat {
  /* 分类是用户自己填的,可能很长;列变窄后要能自己截断,不能把右边的时间挤掉 */
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 500;
  letter-spacing: var(--ls-eyebrow);
  text-transform: uppercase;
}
.card-time {
  /* 时间不能被压:分类已经会自己截断,这里再跟着缩就两边都读不全 */
  flex: none;
  margin-left: auto;
  font-variant-numeric: tabular-nums;
}
.card-text {
  /* 提示词是这张卡的主角:字号最大、颜色最深。
     line-clamp 就是这张卡的最大高度:几行就显示几行,行数由
     .lib-grid 上的 --card-text-lines 统一控制 */
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: var(--card-text-lines, 4);
  overflow: hidden;
  font-size: var(--fs-md);
  line-height: 1.58;
  color: var(--text);
}
.ops {
  display: flex;
  flex-shrink: 0;
  gap: 2px;
  margin-left: auto;
}
/* 图标用 --text-2:比 --text-3 重一档,悬停前的分量和正文里的动作图标一致 */
.op {
  width: 28px;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px solid transparent;
  border-radius: var(--r-sm);
  color: var(--text-2);
  background: none;
  cursor: pointer;
  transition: color var(--dur) var(--ease), border-color var(--dur) var(--ease),
    background var(--dur) var(--ease), transform 120ms var(--ease);
}
.op svg {
  width: 15px;
  height: 15px;
}
.op:hover {
  color: var(--accent-strong);
  border-color: color-mix(in oklch, var(--accent) 45%, transparent);
  background: var(--accent-soft);
}
.op:active {
  transform: scale(0.94);
}
.op-del:hover {
  color: var(--danger);
  border-color: color-mix(in oklch, var(--danger) 45%, var(--line));
  background: color-mix(in oklch, var(--danger) 8%, transparent);
}
.card-foot {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  padding: 0 var(--sp-4) var(--sp-4);
}
/* 参数是一行文字,不是三个小胶囊:它只是背景信息,
   拼成一行之后不再跟提示词抢视线,一行也够放下 */
.card-params {
  min-width: 0;
  font-size: var(--fs-xs);
  font-variant-numeric: tabular-nums;
  color: var(--text-2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.lib-none {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  padding: var(--sp-8) var(--sp-4);
}
.none-ico {
  width: 44px;
  height: 44px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-3);
  opacity: 0.7;
}
.none-ico svg {
  width: 28px;
  height: 28px;
}
.none-title {
  margin-top: var(--sp-3);
  font-size: var(--fs-lg);
  font-weight: 600;
  color: var(--text-2);
}
.none-sub {
  margin-top: 8px;
  max-width: 380px;
  font-size: var(--fs-sm);
  line-height: 1.7;
  color: var(--text-2);
}
.none-action {
  margin-top: var(--sp-5);
  height: 34px;
  padding: 0 16px;
  border: 1px solid var(--line);
  border-radius: 999px;
  color: var(--text);
  font-size: var(--fs-sm);
  cursor: pointer;
  transition: border-color var(--dur) var(--ease), background var(--dur) var(--ease);
}
.none-action:hover {
  border-color: var(--line-strong);
  background: var(--bg-elev);
}

.po-enter-active,
.po-leave-active {
  transition: opacity 140ms var(--ease), transform 140ms var(--ease);
}
.po-enter-from,
.po-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}

/* 窄屏:标题收一档避免与右上角操作按钮挤压;
   输入框提到 16px,防止 iOS Safari 聚焦时放大整页 */
@media (max-width: 640px) {
  .lib-title {
    font-size: var(--fs-xl);
  }
  .search {
    font-size: var(--fs-lg);
  }
  .add-form input {
    font-size: var(--fs-lg);
  }
}
</style>
