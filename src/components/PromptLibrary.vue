<script setup lang="ts">
import { ref, computed } from 'vue'
import type { PromptItem } from '../types'

const props = defineProps<{
  items: PromptItem[]
  visible: boolean
}>()

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'use', item: PromptItem): void
  (e: 'remove', id: string): void
  (e: 'add', item: PromptItem): void
  (e: 'import', items: PromptItem[]): void
}>()

const query = ref('')
const filter = ref('全部')
const showAdd = ref(false)
const draftTitle = ref('')
const draftCategory = ref('')

const categories = computed(() => {
  const set = new Set(props.items.map((i) => i.category || '未分类'))
  return ['全部', ...set]
})

const filtered = computed(() => {
  let list = props.items
  if (filter.value !== '全部') list = list.filter((i) => i.category === filter.value)
  const q = query.value.trim().toLowerCase()
  if (q) list = list.filter((i) => i.prompt.toLowerCase().includes(q) || i.title.toLowerCase().includes(q))
  return list
})

function addCurrent() {
  if (!draftTitle.value.trim()) return
  emit('add', {
    id: Date.now() + Math.random().toString(16).slice(2),
    title: draftTitle.value.trim(),
    prompt: draftTitle.value.trim(),
    category: draftCategory.value.trim() || '未分类',
    createdAt: Date.now()
  })
  draftTitle.value = ''
  showAdd.value = false
}

function exportJson() {
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
  <Teleport to="body">
    <Transition name="drawer">
      <div v-if="visible" class="scrim" @click.self="emit('close')">
        <aside class="drawer" role="dialog" aria-label="提示词库" @keydown.esc="emit('close')">
          <header class="d-head">
            <div>
              <h2>提示词库</h2>
              <span class="d-count">{{ props.items.length }} 条</span>
            </div>
            <button class="d-close" @click="emit('close')" aria-label="关闭">✕</button>
          </header>

          <!-- 工具栏 -->
          <div class="d-tools">
            <input v-model="query" class="search" placeholder="搜索提示词…" spellcheck="false" />
            <div class="cat-row">
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
            <div class="io">
              <button class="io-btn" @click="showAdd = !showAdd">+ 新建</button>
              <button class="io-btn" @click="exportJson">导出</button>
              <label class="io-btn file">
                导入
                <input type="file" accept=".json" hidden @change="onImportFile" />
              </label>
            </div>
            <div v-if="showAdd" class="add-form">
              <input v-model="draftTitle" placeholder="存一段提示词(%当前内容)" />
              <input v-model="draftCategory" placeholder="分类(默认:未分类)" />
              <button class="add-go" @click="addCurrent">保存到库</button>
            </div>
          </div>

          <!-- 列表 -->
          <ul class="d-list">
            <li v-for="item in filtered" :key="item.id" class="d-item">
              <button class="d-card" @click="emit('use', item)">
                <span class="d-cat">{{ item.category }}</span>
                <span class="d-text">{{ item.prompt }}</span>
                <span class="d-time">{{ fmt(item.createdAt) }}</span>
              </button>
              <button class="d-del" :aria-label="`删除 ${item.title}`" @click="emit('remove', item.id)">
                删除
              </button>
            </li>
            <li v-if="!filtered.length" class="d-none">
              <p>还没有提示词，先在生成框输入后点“收藏”。</p>
            </li>
          </ul>
        </aside>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.scrim {
  position: fixed;
  inset: 0;
  z-index: 50;
  background: color-mix(in oklch, #000 30%, transparent);
  display: flex;
  justify-content: flex-end;
}
.drawer {
  width: min(420px, 92vw);
  height: 100%;
  background: var(--bg);
  border-left: 1px solid var(--line);
  box-shadow: var(--sh-md);
  display: flex;
  flex-direction: column;
  padding: var(--sp-5);
}
.d-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
}
.d-head h2 {
  font-family: var(--font-display);
  font-weight: 500;
  font-size: 22px;
}
.d-count {
  font-size: 12px;
  color: var(--text-3);
}
.d-close {
  font-size: 16px;
  color: var(--text-2);
  padding: 4px;
  border-radius: var(--r-sm);
}
.d-close:hover {
  color: var(--text);
}
.d-tools {
  margin-top: var(--sp-4);
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
}
.search {
  padding: 9px 12px;
  border: 1px solid var(--line);
  border-radius: var(--r-sm);
  background: var(--surface);
  font-size: 14px;
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
}
.cat.on {
  background: var(--accent);
  border-color: var(--accent);
  color: oklch(0.985 0.01 45);
}
.io {
  display: flex;
  gap: 8px;
}
.io-btn {
  padding: 6px 12px;
  font-size: 13px;
  border: 1px solid var(--line);
  border-radius: var(--r-sm);
  color: var(--text-2);
}
.io-btn:hover {
  border-color: var(--accent);
  color: var(--accent);
}
.file {
  position: relative;
  cursor: pointer;
}
.add-form {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: var(--sp-3);
  border: 1px solid var(--line-strong);
  border-radius: var(--r-sm);
}
.add-form input {
  padding: 8px 10px;
  border: 1px solid var(--line);
  border-radius: var(--r-sm);
  background: var(--surface);
  font-size: 13px;
}
.add-go {
  padding: 8px;
  border-radius: var(--r-sm);
  background: var(--accent);
  color: oklch(0.985 0.01 45);
  font-size: 13px;
}
.d-list {
  list-style: none;
  margin-top: var(--sp-5);
  overflow-y: auto;
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
}
.d-item {
  display: flex;
  align-items: center;
  gap: 8px;
}
.d-card {
  flex: 1;
  text-align: left;
  padding: 10px 12px;
  border: 1px solid transparent;
  border-radius: var(--r-sm);
  display: flex;
  flex-direction: column;
  gap: 4px;
  transition: background var(--dur) var(--ease);
}
.d-card:hover {
  background: var(--bg-elev);
}
.d-cat {
  font-size: 11px;
  color: var(--accent);
}
.d-text {
  font-size: 13px;
  color: var(--text);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.d-time {
  font-size: 11px;
  color: var(--text-3);
}
.d-del {
  font-size: 12px;
  color: var(--text-3);
  padding: 4px 6px;
  border-radius: var(--r-sm);
  flex-shrink: 0;
}
.d-del:hover {
  color: var(--danger);
}
.d-none {
  color: var(--text-3);
  font-size: 13px;
  text-align: center;
  padding: var(--sp-6) var(--sp-3);
}

.drawer-enter-active,
.drawer-leave-active {
  transition: transform var(--dur) var(--ease);
}
.drawer-enter-from,
.drawer-leave-to {
  transform: translateX(100%);
}
</style>