<script setup lang="ts">
import { imageSrc, reuseParamsOf } from '../api'
import type { HistoryEntry, ReuseParams } from '../types'

defineProps<{
  items: HistoryEntry[]
  visible: boolean
}>()

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'open', entry: HistoryEntry): void
  (e: 'use', params: ReuseParams): void
  (e: 'remove', entry: HistoryEntry): void
}>()

function fmt(ts: number) {
  const d = new Date(ts)
  const p = (x: number) => String(x).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
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
            <button class="d-close tip-left" @click="emit('close')" aria-label="关闭" data-tip="关闭">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
            </button>
          </header>

          <ul class="d-list no-bar">
            <li v-for="entry in items" :key="entry.id" class="d-item">
              <div class="d-line">
                <button
                  class="d-card"
                  @click="emit('open', entry)"
                  :title="entry.prompt"
                >
                  <img loading="lazy" :src="imageSrc(entry.results[0])" :alt="entry.prompt" />
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
                  class="d-use tip-left"
                  @click="emit('use', reuseParamsOf(entry))"
                  data-tip="使用该提示词"
                  aria-label="使用该提示词"
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M12 20V8M8 12l4-4 4 4" />
                    <path d="M4 20h16" />
                  </svg>
                </button>
                <button
                  class="d-del tip-left"
                  @click="emit('remove', entry)"
                  data-tip="删除该条历史"
                  aria-label="删除该条历史"
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6 7l1 12a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-12" />
                  </svg>
                </button>
              </div>
            </li>
            <li v-if="!items.length" class="d-none">
              <div class="d-none-ico" aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                  <circle cx="12" cy="12" r="9" />
                  <path d="M12 7.4V12l2.8 1.9" />
                </svg>
              </div>
              <p class="d-none-title">还没有生成记录</p>
              <p class="d-none-sub">输入提示词并生成后，结果会自动保存在这里，随时回看与复用。</p>
            </li>
            <!-- 说明保留规则:空间吃紧时会自动清最旧的,不写出来用户会以为记录丢了 -->
            <li v-if="items.length" class="d-note">
              历史保存在本地，存储空间接近上限时会自动清理最旧的记录
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
  /* 蒙层做轻微毛玻璃,抽屉浮在内容之上而不是糊一层黑 */
  backdrop-filter: blur(6px) saturate(130%);
  -webkit-backdrop-filter: blur(6px) saturate(130%);
  display: flex;
  justify-content: flex-end;
}
.drawer {
  width: min(420px, 92vw);
  height: 100%;
  background: var(--bg);
  border-left: 1px solid var(--line);
  box-shadow: -30px 0 70px -28px rgba(0, 0, 0, 0.28);
  display: flex;
  flex-direction: column;
  padding: var(--sp-5);
}
.d-head {
  flex-shrink: 0;
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  padding-bottom: var(--sp-4);
  border-bottom: 1px solid var(--line);
}
.d-head h2 {
  font-family: var(--font-display);
  font-weight: 600;
  font-size: 22px;
  letter-spacing: -0.01em;
}
.d-count {
  font-size: 12px;
  color: var(--text-3);
}
.d-close {
  flex-shrink: 0;
  width: 30px;
  height: 30px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--line);
  border-radius: 999px;
  color: var(--text-3);
  transition: all var(--dur) var(--ease);
  cursor: pointer;
}
.d-close svg {
  width: 15px;
  height: 15px;
}
.d-close:hover {
  border-color: var(--line-strong);
  color: var(--text);
  background: var(--bg-elev);
}
.d-list {
  list-style: none;
  margin-top: var(--sp-4);
  padding-right: 2px;
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
.d-use svg {
  width: 15px;
  height: 15px;
}
.d-use:hover {
  border-color: var(--accent);
  color: var(--accent);
  background: var(--accent-soft);
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
  border: 1px dashed var(--line-strong);
  border-radius: var(--r);
}
.d-none-ico {
  width: 40px;
  height: 40px;
  margin: 0 auto var(--sp-2);
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-3);
  opacity: 0.7;
}
.d-none-ico svg {
  width: 24px;
  height: 24px;
}
.d-none-title {
  font-family: var(--font-display);
  font-size: 15px;
  color: var(--text-2);
}
.d-none-sub {
  margin-top: 6px;
  font-size: 12px;
  line-height: 1.6;
  color: var(--text-3);
  max-width: 260px;
  margin-left: auto;
  margin-right: auto;
}
/* 列表末尾的保留规则说明:比列表内容再低一级,不抢视线 */
.d-note {
  padding: var(--sp-4) var(--sp-2) var(--sp-2);
  font-size: 12px;
  line-height: 1.6;
  text-align: center;
  color: var(--text-3);
}

/* 蒙层淡入淡出,面板单独横向滑入(此前是整体平移,蒙层会跟着甩) */
.drawer-enter-active,
.drawer-leave-active {
  transition: opacity var(--dur) var(--ease);
}
.drawer-enter-active .drawer,
.drawer-leave-active .drawer {
  transition: transform var(--dur) var(--ease);
}
.drawer-enter-from,
.drawer-leave-to {
  opacity: 0;
}
.drawer-enter-from .drawer,
.drawer-leave-to .drawer {
  transform: translateX(100%);
}
</style>