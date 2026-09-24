<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import type { HistoryEntry } from '../types'

const props = defineProps<{
  visible: boolean
  entry: HistoryEntry | null
}>()
const emit = defineEmits<{
  (e: 'close'): void
  (e: 'usePrompt', prompt: string): void
  (e: 'favorite', prompt: string): void
  (e: 'reference', activeSrc: string): void
  (e: 'remove'): void
}>()

const active = ref(0)
const expanded = ref(false)
const menuOpen = ref(false)

const imgs = computed(() => {
  return props.entry ? props.entry.results.map((r) => renderData(r)) : []
})

function renderData(item: { type: 'b64' | 'url'; data: string }) {
  if (item.data.startsWith('data:')) return item.data
  return item.type === 'b64' ? `data:image/png;base64,${item.data}` : item.data
}

// 每次打开时重置到第一张
watch(
  () => props.visible,
  (v) => {
    if (v) {
      active.value = 0
      expanded.value = false
      menuOpen.value = false
    }
  }
)

function close() {
  emit('close')
}

function prev() {
  active.value = (active.value - 1 + imgs.value.length) % imgs.value.length
}
function next() {
  active.value = (active.value + 1) % imgs.value.length
}

function download() {
  const url = imgs.value[active.value]
  const a = document.createElement('a')
  a.href = url
  a.download = `kimage-${Date.now()}.png`
  a.click()
}

function copyPrompt() {
  if (!props.entry) return
  navigator.clipboard?.writeText(props.entry.prompt).catch(() => {})
}

function useThisPrompt() {
  if (!props.entry) return
  emit('usePrompt', props.entry.prompt)
  close()
}

// 键盘支持
function onKey(e: KeyboardEvent) {
  if (!props.visible) return
  if (e.key === 'Escape') close()
  if (e.key === 'ArrowLeft') prev()
  if (e.key === 'ArrowRight') next()
}
onMounted(() => window.addEventListener('keydown', onKey))
onUnmounted(() => window.removeEventListener('keydown', onKey))

// 菜单动作
function menuAction(kind: 'favorite' | 'reference' | 'remove') {
  if (!props.entry) return
  if (kind === 'favorite') {
    emit('favorite', props.entry.prompt)
  } else if (kind === 'reference') {
    emit('reference', imgs.value[active.value])
  } else if (kind === 'remove') {
    emit('remove')
  }
  menuOpen.value = false
}
</script>

<template>
  <Teleport to="body">
    <Transition name="modal">
      <div v-if="visible && entry" class="mask" @click.self="close">
        <div class="preview">
          <!-- 顶部工具栏 -->
          <div class="toolbar">
            <div class="tb-left">
              <span class="badge">生成记录</span>
            </div>
            <div v-if="imgs.length > 1" class="tb-count">{{ active + 1 }} / {{ imgs.length }}</div>
            <div class="tool-actions">
              <span class="menu-wrap">
                <button class="tbtn" @click="menuOpen = !menuOpen" title="更多操作" aria-label="更多">⋮</button>
                <Transition name="po">
                  <div v-if="menuOpen" class="menu">
                    <button class="mitem" @click="menuAction('favorite')">收藏到提示词库</button>
                    <button class="mitem" @click="menuAction('reference')">用作参考图</button>
                    <button class="mitem danger" @click="menuAction('remove')">删除该条历史</button>
                  </div>
                </Transition>
              </span>
              <button class="tbtn close" @click="close" title="关闭 (Esc)" aria-label="关闭">×</button>
            </div>
          </div>

          <!-- 主体:左图右信息 -->
          <div class="body">
            <!-- 图片区 -->
            <div class="stage">
              <div class="img-wrap">
                <img :src="imgs[active]" :alt="`生成结果 ${active + 1}`" />
                <button v-if="imgs.length > 1" class="nav prev" @click="prev">‹</button>
                <button v-if="imgs.length > 1" class="nav next" @click="next">›</button>
              </div>
              <!-- 缩略图导航 -->
              <div v-if="imgs.length > 1" class="thumbs">
                <button
                  v-for="(src, i) in imgs"
                  :key="i"
                  class="thumb"
                  :class="{ active: i === active }"
                  @click="active = i"
                >
                  <img :src="src" :alt="`缩略图 ${i + 1}`" />
                </button>
              </div>
            </div>

            <!-- 信息侧栏 -->
            <aside class="side">
              <div class="side-head">
                <div class="side-tags">
                  <span class="tag">{{ entry.size }}</span>
                  <span v-if="entry.model" class="tag tag-model">{{ entry.model }}</span>
                </div>
                <span class="meta">{{ new Date(entry.createdAt).toLocaleString() }}</span>
              </div>

              <div class="prompt-block">
                <label class="sec-label">提示词</label>
                <p class="prompt" :class="{ clipped: !expanded }">{{ entry.prompt }}</p>
                <button v-if="entry.prompt.length > 120" class="expand-btn" @click="expanded = !expanded">
                  {{ expanded ? '收起' : '展开' }}
                </button>
              </div>

              <div class="side-actions">
                <button class="act" @click="copyPrompt">复制 Prompt</button>
                <button class="act primary" @click="useThisPrompt">使用 Prompt</button>
                <button class="act primary" @click="download">下载</button>
              </div>
            </aside>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.mask {
  position: fixed;
  inset: 0;
  z-index: 60;
  background: rgba(20, 15, 10, 0.55);
  backdrop-filter: blur(4px);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: clamp(12px, 4vw, 40px);
}
.preview {
  width: min(960px, 100%);
  max-height: 92vh;
  background: var(--bg);
  border-radius: var(--r-lg);
  overflow: hidden;
  display: flex;
  flex-direction: column;
  box-shadow: var(--sh-md);
}

.toolbar {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  border-bottom: 1px solid var(--line);
}
.tb-left {
  flex: 1;
}
.badge {
  font-size: 12px;
  color: var(--text-2);
  background: var(--bg-elev);
  border: 1px solid var(--line);
  padding: 3px 10px;
  border-radius: 999px;
}
.tb-count {
  position: absolute;
  left: 50%;
  transform: translateX(-50%);
  font-size: 13px;
  color: var(--text-2);
  font-variant-numeric: tabular-nums;
}
.tool-actions {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 2px;
}
.tbtn {
  font-size: 16px;
  color: var(--text-2);
  width: 34px;
  height: 34px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--r-sm);
  transition: background var(--dur) var(--ease), color var(--dur) var(--ease);
}
.tbtn:hover {
  color: var(--text);
  background: var(--bg-elev);
}
.tbtn.close {
  font-size: 20px;
}
.menu-wrap {
  position: relative;
  display: inline-flex;
}
.menu {
  position: absolute;
  right: 0;
  top: calc(100% + 6px);
  min-width: 150px;
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: var(--r-sm);
  box-shadow: var(--sh-md);
  padding: 4px;
  z-index: 5;
}
.mitem {
  display: block;
  width: 100%;
  text-align: left;
  padding: 8px 10px;
  font-size: 13px;
  color: var(--text-2);
  border-radius: 6px;
}
.mitem:hover {
  background: var(--bg-elev);
  color: var(--text);
}
.mitem.danger {
  color: var(--danger);
}
.po-enter-active,
.po-leave-active {
  transition: opacity 120ms var(--ease), transform 120ms var(--ease);
}
.po-enter-from,
.po-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}

.body {
  display: grid;
  grid-template-columns: 1fr 300px;
  min-height: 0;
  flex: 1;
}

/* 图片区 */
.stage {
  position: relative;
  display: flex;
  gap: 4px;
  padding: 16px;
  align-items: center;
}
.img-wrap {
  position: relative;
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 420px;
  background: var(--image-bg);
  border-radius: var(--r);
  overflow: hidden;
}
.img-wrap img {
  max-width: 100%;
  max-height: 70vh;
  object-fit: contain;
  display: block;
}
.nav {
  position: absolute;
  top: 50%;
  transform: translateY(-50%);
  width: 34px;
  height: 44px;
  font-size: 22px;
  color: var(--text-2);
  background: color-mix(in oklch, var(--surface) 78%, transparent);
  border: 1px solid var(--line);
  border-radius: var(--r-sm);
  backdrop-filter: blur(4px);
  transition: color var(--dur) var(--ease), background var(--dur) var(--ease);
}
.nav:hover {
  background: var(--surface);
  color: var(--accent);
}
.nav.prev {
  left: 10px;
}
.nav.next {
  right: 10px;
}
.thumbs {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.thumb {
  width: 52px;
  height: 52px;
  border-radius: var(--r-sm);
  overflow: hidden;
  border: 2px solid transparent;
  opacity: 0.6;
}
.thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.thumb.active {
  border-color: var(--accent);
  opacity: 1;
}
/* 信息侧栏 */
.side {
  display: flex;
  flex-direction: column;
  padding: 18px;
  border-left: 1px solid var(--line);
  gap: var(--sp-5);
  overflow-y: auto;
}
.side-head {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.side-tags {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}
.tag {
  font-size: 11px;
  color: var(--text-2);
  background: var(--bg-elev);
  border: 1px solid var(--line);
  border-radius: 999px;
  padding: 2px 9px;
}
.tag-model {
  color: var(--accent);
  border-color: color-mix(in oklch, var(--accent) 30%, var(--line));
  background: var(--accent-soft);
}
.meta {
  font-size: 12px;
  color: var(--text-3);
}
.sec-label {
  font-size: 12px;
  color: var(--text-3);
  margin-bottom: 8px;
  display: block;
}
.prompt {
  font-size: 13px;
  line-height: 1.7;
  color: var(--text-2);
  white-space: pre-wrap;
}
.prompt.clipped {
  display: -webkit-box;
  -webkit-line-clamp: 4;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.expand-btn {
  margin-top: 8px;
  font-size: 12px;
  color: var(--accent);
}
.side-actions {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-top: auto;
}
.act {
  padding: 11px;
  border-radius: var(--r-sm);
  font-size: 14px;
  border: 1px solid var(--line);
  color: var(--text);
  transition: all var(--dur) var(--ease);
}
.act:hover {
  border-color: var(--line-strong);
}
.act.primary {
  background: var(--accent);
  color: var(--accent-contrast);
  border-color: var(--accent);
}
.act.primary:hover {
  background: var(--accent-strong);
}

.modal-enter-active,
.modal-leave-active {
  transition: opacity var(--dur) var(--ease);
}
.modal-enter-active .preview,
.modal-leave-active .preview {
  transition: transform var(--dur) var(--ease);
}
.modal-enter-from,
.modal-leave-to {
  opacity: 0;
}
.modal-enter-from .preview,
.modal-leave-to .preview {
  transform: scale(0.96) translateY(8px);
}

@media (max-width: 720px) {
  .body {
    grid-template-columns: 1fr;
    overflow-y: auto;
  }
  .side {
    border-left: none;
    border-top: 1px solid var(--line);
  }
}
</style>