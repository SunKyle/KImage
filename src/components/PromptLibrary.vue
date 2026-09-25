<script setup lang="ts">
import { ref, computed } from 'vue'
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
const filter = ref('全部')
const menuOpen = ref(false)
const showAdd = ref(false)
const draftPrompt = ref('')
const draftCategory = ref('')

const categories = computed(() => {
  const set = new Set(props.items.map((i) => i.category || '未分类'))
  return ['全部', ...set]
})

const filtered = computed(() => {
  let list = props.items
  if (filter.value !== '全部') list = list.filter((i) => (i.category || '未分类') === filter.value)
  const q = query.value.trim().toLowerCase()
  if (q) list = list.filter((i) => i.prompt.toLowerCase().includes(q))
  return list
})

// 搜索和分类是两套筛选,空态里要能一键把两个都清掉
function resetFilter() {
  query.value = ''
  filter.value = '全部'
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
    category: draftCategory.value.trim() || '未分类',
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
  URL.revokeObjectURL(a.href)
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
  <section class="lib" aria-label="提示词库">
    <header class="lib-head">
      <div class="lib-title-wrap">
        <h1 class="lib-title">提示词库</h1>
        <p class="lib-sub">
          共 {{ items.length }} 条<template v-if="filter !== '全部'"> · 当前分类「{{ filter }}」</template>
        </p>
      </div>
      <div class="lib-ops">
        <button class="lib-new" @click="startAdd">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
            <path d="M12 5v14M5 12h14" />
          </svg>
          新建提示词
        </button>
        <!-- 管理动作低频,收进菜单,不给标题行添按钮 -->
        <span class="menu-wrap">
          <button class="icon-ghost" :aria-expanded="menuOpen" aria-label="更多" @click="menuOpen = !menuOpen">
            <svg viewBox="0 0 24 24" fill="currentColor">
              <circle cx="12" cy="5.5" r="1.6" />
              <circle cx="12" cy="12" r="1.6" />
              <circle cx="12" cy="18.5" r="1.6" />
            </svg>
          </button>
          <Transition name="po">
            <div v-if="menuOpen" class="menu">
              <button class="mitem" @click="exportJson">导出为 JSON</button>
              <label class="mitem file">
                导入 JSON
                <input type="file" accept=".json" hidden @change="onImportFile" />
              </label>
            </div>
          </Transition>
        </span>
      </div>
    </header>

    <!-- 工具栏:整页宽度下分类直接换行,不再像窄抽屉那样横向滚动藏起来 -->
    <div class="lib-tools">
      <input v-model="query" class="search" placeholder="搜索提示词…" spellcheck="false" />
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
      <input v-model="draftPrompt" placeholder="输入一段提示词" @keydown.enter="addCurrent" />
      <input v-model="draftCategory" placeholder="分类（默认：未分类）" @keydown.enter="addCurrent" />
      <div class="add-ops">
        <button class="add-go" @click="addCurrent">保存到库</button>
        <button class="add-cancel" @click="showAdd = false">取消</button>
      </div>
    </div>

    <ul v-if="filtered.length" class="lib-grid">
      <li v-for="item in filtered" :key="item.id" class="card">
        <!-- 整块可点 = 使用该提示词;操作按钮单独放,不能嵌在 button 里 -->
        <button class="card-main" :title="item.prompt" @click="emit('use', item)">
          <img v-if="item.thumb" class="cover" :src="item.thumb" alt="" />
          <span v-else class="cover cover-none" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
              <path d="M4 6h16M4 12h10M4 18h13" />
            </svg>
          </span>
          <span class="main-body">
            <span class="card-meta">
              <span class="cat-tag">{{ item.category || '未分类' }}</span>
              <span class="card-time">{{ fmt(item.createdAt) }}</span>
            </span>
            <span class="card-text">{{ item.prompt }}</span>
          </span>
        </button>

        <!-- hover 才显形:整卡本身就是主操作,常驻按钮会跟它抢注意力 -->
        <div class="ops">
          <button
            class="op"
            data-tip="使用该提示词"
            :aria-label="`使用：${item.prompt.slice(0, 20)}`"
            @click="emit('use', item)"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
              <path d="M12 20V8M8 12l4-4 4 4" />
              <path d="M4 20h16" />
            </svg>
          </button>
          <button
            class="op op-del"
            data-tip="删除"
            :aria-label="`删除：${item.prompt.slice(0, 20)}`"
            @click="emit('remove', item.id)"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
              <path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6 7l1 12a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-12" />
            </svg>
          </button>
        </div>

        <div v-if="item.size || item.quality || item.background" class="card-foot">
          <span v-if="item.size" class="pill">{{ item.size === 'auto' ? '自动' : item.size }}</span>
          <span v-if="item.quality" class="pill">{{ optionLabel(QUALITY_OPTIONS, item.quality) }}</span>
          <span v-if="item.background" class="pill">{{ optionLabel(BACKGROUND_OPTIONS, item.background) }}</span>
        </div>
      </li>
    </ul>

    <!-- 空态分两种:库里真没有(引到新建) / 筛选没命中(给一键清空) -->
    <div v-else class="lib-none">
      <div class="none-ico" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M5 8a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2" />
          <path d="M6 8v10a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V8" />
          <path d="M9 12h6" />
        </svg>
      </div>
      <h2 class="none-title">{{ items.length ? '没有匹配的提示词' : '还没有提示词' }}</h2>
      <p class="none-sub">
        {{
          items.length
            ? '换个关键词，或把分类切回「全部」。'
            : '生成图片后打开预览，用「更多操作 → 收藏到提示词库」存下来；也可以直接新建一条。'
        }}
      </p>
      <button v-if="items.length" class="none-action" @click="resetFilter">清空筛选</button>
      <button v-else class="none-action" @click="startAdd">新建第一条</button>
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
  font-family: var(--font-display);
  font-size: 28px;
  font-weight: 700;
  letter-spacing: -0.02em;
}
.lib-sub {
  margin-top: 6px;
  font-size: 13px;
  color: var(--text-3);
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
  font-size: 13px;
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
  color: var(--text-3);
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
  font-size: 13px;
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
  font-size: 14px;
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
  font-size: 12px;
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
  font-size: 13px;
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
  padding: 8px;
  border-radius: var(--r-sm);
  background: var(--cta);
  color: var(--cta-text);
  font-size: 13px;
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
  font-size: 13px;
  cursor: pointer;
}
.add-cancel:hover {
  border-color: var(--line-strong);
  color: var(--text);
}

/* 网格:auto-fill 让列数跟着容器走,窄屏自然退成两列/一列 */
.lib-grid {
  list-style: none;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
  gap: var(--sp-3);
  margin-top: var(--sp-5);
}
.card {
  position: relative;
  display: flex;
  flex-direction: column;
  border: 1px solid var(--line);
  border-radius: var(--r);
  background: var(--surface);
  transition: border-color var(--dur) var(--ease), box-shadow var(--dur) var(--ease);
}
.card:hover,
.card:focus-within {
  border-color: var(--line-strong);
  box-shadow: var(--sh-sm);
}
/* flex:1 让卡片被文字撑高时脚注仍贴住底边,同一行的卡片视觉上齐平 */
.card-main {
  flex: 1;
  display: flex;
  align-items: flex-start;
  gap: var(--sp-3);
  width: 100%;
  padding: var(--sp-4);
  text-align: left;
  cursor: pointer;
}
.cover {
  width: 56px;
  height: 56px;
  flex: none;
  object-fit: cover;
  border-radius: var(--r-sm);
  background: var(--bg-elev);
}
.cover-none {
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-4);
}
.cover-none svg {
  width: 20px;
  height: 20px;
}
.main-body {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}
.card-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  /* 给右上角的操作按钮留位,时间不会被压在按钮底下 */
  padding-right: 58px;
}
.cat-tag {
  padding: 1px 7px;
  border-radius: 999px;
  border: 1px solid var(--line);
  background: var(--bg-elev);
  color: var(--text-2);
  font-size: 11px;
}
.card-time {
  margin-left: auto;
  font-size: 11px;
  color: var(--text-3);
}
.card-text {
  /* 两行截断:抽屉里只有一行,整页宽度下两行才够装常见提示词 */
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  overflow: hidden;
  font-size: 13px;
  line-height: 1.55;
  color: var(--text);
}
.ops {
  position: absolute;
  top: 11px;
  right: 11px;
  display: flex;
  gap: 4px;
}
.op {
  width: 28px;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px solid transparent;
  border-radius: var(--r-sm);
  color: var(--text-3);
  background: var(--surface);
  cursor: pointer;
  opacity: 0.55;
  transition: opacity var(--dur) var(--ease), color var(--dur) var(--ease),
    border-color var(--dur) var(--ease), background var(--dur) var(--ease);
}
.op svg {
  width: 15px;
  height: 15px;
}
.card:hover .op,
.card:focus-within .op {
  opacity: 1;
}
/* 触屏没有 hover,常驻显示,否则操作永远点不到 */
@media (hover: none) {
  .op {
    opacity: 1;
  }
}
.op:hover {
  color: var(--accent-strong);
  border-color: color-mix(in oklch, var(--accent) 45%, transparent);
  background: var(--accent-soft);
}
.op-del:hover {
  color: var(--danger);
  border-color: color-mix(in oklch, var(--danger) 45%, var(--line));
  background: color-mix(in oklch, var(--danger) 8%, transparent);
}
.card-foot {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  padding: 10px var(--sp-4);
  border-top: 1px solid var(--line);
}
.pill {
  padding: 2px 8px;
  border-radius: 999px;
  border: 1px solid var(--line);
  background: var(--bg-elev);
  color: var(--text-2);
  font-size: 11px;
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
  font-family: var(--font-display);
  font-size: 16px;
  font-weight: 600;
  color: var(--text-2);
}
.none-sub {
  margin-top: 8px;
  max-width: 380px;
  font-size: 13px;
  line-height: 1.7;
  color: var(--text-3);
}
.none-action {
  margin-top: var(--sp-5);
  height: 34px;
  padding: 0 16px;
  border: 1px solid var(--line);
  border-radius: 999px;
  color: var(--text);
  font-size: 13px;
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
</style>
