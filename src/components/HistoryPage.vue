<script setup lang="ts">
import { computed } from 'vue'
import { reuseParamsOf, thumbSrc } from '../api'
import type { HistoryEntry, ReuseParams } from '../types'

/* 历史记录:独立页面,与提示词库共用同一套骨架。
   原来 410px 的抽屉只能排单列,整页宽度下改成网格。
   封面用的是入库时存下的 128px 缩略图,64px 的显示尺寸在 2x 屏上正好不糊。 */

const props = defineProps<{
  items: HistoryEntry[]
}>()

const emit = defineEmits<{
  (e: 'open', entry: HistoryEntry): void
  (e: 'use', params: ReuseParams): void
  (e: 'remove', entry: HistoryEntry): void
}>()

// 一条记录可能带多张图,条数说明不了总量,两个都给出来
const imageCount = computed(() => props.items.reduce((n, e) => n + e.results.length, 0))

function fmt(ts: number) {
  const d = new Date(ts)
  const p = (x: number) => String(x).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}
</script>

<template>
  <section class="lib" aria-label="历史记录">
    <header class="lib-head">
      <div class="lib-title-wrap">
        <h1 class="lib-title">历史记录</h1>
        <p class="lib-sub">共 {{ items.length }} 条 · {{ imageCount }} 张图</p>
      </div>
    </header>

    <!-- 保留规则单独占一行:不写出来,记录被自动清掉时用户会以为丢了 -->
    <div class="lib-tools">
      <p class="lib-note">历史保存在本地，存储空间接近上限时会自动清理最旧的记录</p>
    </div>

    <ul v-if="items.length" class="lib-grid">
      <li v-for="entry in items" :key="entry.id" class="card">
        <!-- 整块可点 = 打开预览;操作按钮单独放,不能嵌在 button 里 -->
        <button class="card-main" :title="entry.prompt" @click="emit('open', entry)">
          <img
            v-if="entry.results.length"
            class="cover cover-md"
            loading="lazy"
            decoding="async"
            :src="thumbSrc(entry)"
            alt=""
          />
          <span v-else class="cover cover-md cover-none" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
              <rect x="3" y="4" width="18" height="16" rx="2.5" />
              <path d="M4 17.5l4.5-4.5L12 16.5l3-3 5 5" />
            </svg>
          </span>
          <span class="main-body">
            <span class="card-meta">
              <span class="card-time">{{ fmt(entry.createdAt) }}</span>
            </span>
            <span class="card-text">{{ entry.prompt }}</span>
          </span>
        </button>

        <!-- hover 才显形:整卡本身就是主操作,常驻按钮会跟它抢注意力 -->
        <div class="ops">
          <button
            class="op"
            data-tip="使用该提示词"
            :aria-label="`使用提示词：${entry.prompt.slice(0, 20)}`"
            @click="emit('use', reuseParamsOf(entry))"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
              <path d="M12 20V8M8 12l4-4 4 4" />
              <path d="M4 20h16" />
            </svg>
          </button>
          <button
            class="op op-del"
            data-tip="删除该条历史"
            :aria-label="`删除记录：${entry.prompt.slice(0, 20)}`"
            @click="emit('remove', entry)"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
              <path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6 7l1 12a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-12" />
            </svg>
          </button>
        </div>

        <div class="card-foot">
          <span class="pill">{{ entry.size === 'auto' ? '自动' : entry.size }}</span>
          <span v-if="entry.results.length > 1" class="pill">{{ entry.results.length }} 张</span>
          <span v-if="entry.model" class="pill">{{ entry.model }}</span>
        </div>
      </li>
    </ul>

    <div v-else class="lib-none">
      <div class="none-ico" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="9" />
          <path d="M12 7.4V12l2.8 1.9" />
        </svg>
      </div>
      <h2 class="none-title">还没有生成记录</h2>
      <p class="none-sub">在首页输入提示词并生成后，结果会自动保存在这里，随时回看与复用。</p>
    </div>
  </section>
</template>

<style scoped>
/* 以下骨架与提示词库页保持一致:两页共用同一套标题行、网格与卡片规格 */
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

.lib-tools {
  display: flex;
  align-items: center;
  margin-top: var(--sp-5);
  padding-bottom: var(--sp-4);
  border-bottom: 1px solid var(--line);
}
.lib-note {
  font-size: 13px;
  color: var(--text-3);
}

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
  flex: none;
  object-fit: cover;
  border-radius: var(--r-sm);
  background: var(--bg-elev);
}
/* 记录里存的是 128px 缩略图,64px × 2 倍屏正好一一对应,不会糊 */
.cover-md {
  width: 64px;
  height: 64px;
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
.card-time {
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
  max-width: 100%;
  padding: 2px 8px;
  border-radius: 999px;
  border: 1px solid var(--line);
  background: var(--bg-elev);
  color: var(--text-2);
  font-size: 11px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
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
</style>
