<script setup lang="ts">
import type { HistoryEntry } from '../types'

defineProps<{
  items: HistoryEntry[]
  visible: boolean
}>()

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'open', entry: HistoryEntry): void
  (e: 'use', prompt: string): void
  (e: 'remove', entry: HistoryEntry): void
}>()

function fmt(ts: number) {
  const d = new Date(ts)
  const p = (x: number) => String(x).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

function renderData(item: { type: 'b64' | 'url'; data: string }) {
  if (item.data.startsWith('data:')) return item.data
  return item.type === 'b64' ? `data:image/png;base64,${item.data}` : item.data
}
</script>

<template>
  <Teleport to="body">
    <Transition name="drawer">
      <div v-if="visible" class="scrim" @click.self="emit('close')">
        <aside class="drawer" role="dialog" aria-label="历史记录">
          <header class="d-head">
            <div>
              <h2>历史记录</h2>
              <span class="d-count">{{ items.length }} 条</span>
            </div>
            <button class="d-close" @click="emit('close')" aria-label="关闭">✕</button>
          </header>

          <ul class="d-list">
            <li v-for="entry in items" :key="entry.id" class="d-item">
              <div class="d-line">
                <button
                  class="d-card"
                  @click="emit('open', entry)"
                  :title="entry.prompt"
                >
                  <img loading="lazy" :src="renderData(entry.results[0])" :alt="entry.prompt" />
                  <span class="d-body">
                    <span class="d-text">{{ entry.prompt }}</span>
                    <span class="d-tags">
                      <span class="tag">{{ fmt(entry.createdAt) }}</span>
                      <span class="tag">{{ entry.size }}</span>
                      <span v-if="entry.model" class="tag tag-model">{{ entry.model }}</span>
                    </span>
                  </span>
                </button>
                <button
                  class="d-use"
                  @click="emit('use', entry.prompt)"
                  title="使用该提示词"
                >
                  使用
                </button>
                <button
                  class="d-del"
                  @click="emit('remove', entry)"
                  title="删除该条历史"
                  aria-label="删除该条历史"
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6 7l1 12a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-12" />
                  </svg>
                </button>
              </div>
            </li>
            <li v-if="!items.length" class="d-none">
              <p>还没有生成记录</p>
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
.d-list {
  list-style: none;
  margin-top: var(--sp-5);
  overflow-y: auto;
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
}
.d-line {
  display: flex;
  align-items: center;
  gap: 8px;
}
.d-card {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 10px;
  text-align: left;
  padding: 8px;
  border-radius: var(--r-sm);
  transition: background var(--dur) var(--ease);
}
.d-card:hover {
  background: var(--bg-elev);
}
.d-card img {
  width: 48px;
  height: 48px;
  object-fit: cover;
  border-radius: var(--r-sm);
  flex-shrink: 0;
}
.d-body {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.d-text {
  font-size: 13px;
  color: var(--text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.d-tags {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  margin-top: 4px;
}
.tag {
  font-size: 11px;
  color: var(--text-2);
  background: var(--bg-elev);
  border: 1px solid var(--line);
  border-radius: 999px;
  padding: 2px 8px;
}
.tag-model {
  color: var(--accent);
  border-color: color-mix(in oklch, var(--accent) 30%, var(--line));
  background: var(--accent-soft);
}
.d-use {
  flex-shrink: 0;
  padding: 6px 10px;
  font-size: 12px;
  border: 1px solid var(--line);
  border-radius: var(--r-sm);
  color: var(--text-2);
}
.d-use:hover {
  border-color: var(--accent);
  color: var(--accent);
}
.d-del {
  flex-shrink: 0;
  width: 28px;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--line);
  border-radius: var(--r-sm);
  color: var(--text-3);
  background: none;
  cursor: pointer;
  transition: all var(--dur) var(--ease);
}
.d-del svg {
  width: 15px;
  height: 15px;
}
.d-del:hover {
  border-color: var(--danger);
  color: var(--danger);
  background: color-mix(in oklch, var(--danger) 8%, transparent);
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