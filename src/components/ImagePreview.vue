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
              <span class="tb-title">生成记录</span>
            </div>
            <div v-if="imgs.length > 1" class="tb-count">{{ active + 1 }} / {{ imgs.length }}</div>
            <div class="tool-actions">
              <span class="menu-wrap">
                <button class="tbtn" @click="menuOpen = !menuOpen" title="更多操作" aria-label="更多操作">
                  <svg viewBox="0 0 24 24" fill="currentColor">
                    <circle cx="12" cy="5.5" r="1.6" />
                    <circle cx="12" cy="12" r="1.6" />
                    <circle cx="12" cy="18.5" r="1.6" />
                  </svg>
                </button>
                <Transition name="po">
                  <div v-if="menuOpen" class="menu">
                    <button class="mitem" @click="menuAction('favorite')">收藏到提示词库</button>
                    <button class="mitem" @click="menuAction('reference')">用作参考图</button>
                    <button class="mitem danger" @click="menuAction('remove')">删除该条历史</button>
                  </div>
                </Transition>
              </span>
              <button class="tbtn" @click="close" title="关闭 (Esc)" aria-label="关闭">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">
                  <path d="M6 6l12 12M18 6L6 18" />
                </svg>
              </button>
            </div>
          </div>

          <!-- 主体:左图右信息 -->
          <div class="body no-bar">
            <!-- 图片区 -->
            <div class="stage">
              <div class="img-wrap">
                <img :src="imgs[active]" :alt="`生成结果 ${active + 1}`" />
                <button v-if="imgs.length > 1" class="nav prev" @click="prev" title="上一张" aria-label="上一张">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M15 6l-6 6 6 6" />
                  </svg>
                </button>
                <button v-if="imgs.length > 1" class="nav next" @click="next" title="下一张" aria-label="下一张">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M9 6l6 6-6 6" />
                  </svg>
                </button>
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
            <aside class="side no-bar">
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
  /* 与抽屉同一套蒙层:主题化半透明黑 + 轻毛玻璃 */
  background: color-mix(in oklch, #000 30%, transparent);
  backdrop-filter: blur(6px) saturate(130%);
  -webkit-backdrop-filter: blur(6px) saturate(130%);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: clamp(12px, 4vw, 40px);
}
.preview {
  width: min(960px, 100%);
  /* 高度取确定值,不随内容伸缩:展开提示词只在侧栏内部滚动,卡片尺寸保持不变 */
  height: min(92vh, 880px);
  background: var(--bg);
  border: 1px solid var(--line);
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
  gap: var(--sp-3);
  flex-shrink: 0;
  padding: var(--sp-4) var(--sp-5);
  border-bottom: 1px solid var(--line);
}
.tb-left {
  flex: 1;
}
/* 标题走 font-display,与抽屉头部、图墙小节标题同一套字号体系 */
.tb-title {
  font-family: var(--font-display);
  font-size: 17px;
  font-weight: 600;
  letter-spacing: -0.01em;
  color: var(--text);
}
.tb-count {
  position: absolute;
  left: 50%;
  transform: translateX(-50%);
  font-size: 13px;
  color: var(--text-3);
  font-variant-numeric: tabular-nums;
}
.tool-actions {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: var(--sp-1);
}
/* 与抽屉/设置列表里的图标按钮同一套尺寸与状态 */
.tbtn {
  flex-shrink: 0;
  width: 30px;
  height: 30px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--line);
  border-radius: var(--r-sm);
  color: var(--text-3);
  background: none;
  cursor: pointer;
  transition: color var(--dur) var(--ease), background var(--dur) var(--ease),
    border-color var(--dur) var(--ease);
}
.tbtn svg {
  width: 15px;
  height: 15px;
}
.tbtn:hover {
  color: var(--text);
  border-color: var(--line-strong);
  background: var(--bg-elev);
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
  border-radius: var(--r-sm);
  transition: background var(--dur) var(--ease), color var(--dur) var(--ease);
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
  /* 行高填满 body:两栏等高,侧栏内容再多也只在自己内部滚动 */
  grid-template-rows: minmax(0, 1fr);
  min-height: 0;
  flex: 1;
}

/* 图片区 */
.stage {
  position: relative;
  display: flex;
  /* 与 padding 取同一档:缩略图条左右两侧的间距才相等(8px 的 gap 会显得左边挤) */
  gap: var(--sp-4);
  padding: var(--sp-4);
  min-height: 0;
}
.img-wrap {
  position: relative;
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--image-bg);
  border-radius: var(--r);
  overflow: hidden;
}
.img-wrap img {
  /* 百分比高度依赖父级的确定高度(stage 撑满网格行),这样图不会顶破卡片 */
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
  display: block;
}
/* 压在图上的翻页键:圆形毛玻璃,同主页面输入框按钮的造型 */
.nav {
  position: absolute;
  top: 50%;
  transform: translateY(-50%);
  width: 36px;
  height: 36px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-2);
  background: color-mix(in oklch, var(--surface) 80%, transparent);
  border: 1px solid var(--line);
  border-radius: 999px;
  backdrop-filter: blur(6px) saturate(130%);
  -webkit-backdrop-filter: blur(6px) saturate(130%);
  cursor: pointer;
  transition: color var(--dur) var(--ease), background var(--dur) var(--ease),
    border-color var(--dur) var(--ease), transform 120ms var(--ease);
}
.nav svg {
  width: 16px;
  height: 16px;
}
.nav:hover {
  background: var(--surface);
  border-color: color-mix(in oklch, var(--accent) 45%, var(--line));
  color: var(--accent);
}
.nav:active {
  transform: translateY(-50%) scale(0.94);
}
.nav.prev {
  left: 12px;
}
.nav.next {
  right: 12px;
}
.thumbs {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  /* 画布改为撑满高度后,缩略图条要自己保持垂直居中 */
  align-self: center;
}
.thumb {
  width: 52px;
  height: 52px;
  border-radius: var(--r-sm);
  overflow: hidden;
  border: 2px solid transparent;
  opacity: 0.55;
  cursor: pointer;
  transition: opacity var(--dur) var(--ease), border-color var(--dur) var(--ease);
}
.thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.thumb:hover {
  opacity: 0.85;
}
.thumb.active {
  border-color: color-mix(in oklch, var(--accent) 70%, transparent);
  opacity: 1;
}
/* 信息侧栏 */
.side {
  display: flex;
  flex-direction: column;
  padding: var(--sp-5);
  border-left: 1px solid var(--line);
  gap: var(--sp-5);
  overflow-y: auto;
}
.side-head {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
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
  align-self: flex-start;
  margin-top: var(--sp-2);
  padding: 5px 10px;
  margin-left: -10px;
  font-size: 12px;
  color: var(--accent);
  border-radius: 999px;
  transition: background var(--dur) var(--ease);
}
.expand-btn:hover {
  background: var(--accent-soft);
}
.side-actions {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  margin-top: auto;
}
.act {
  padding: 11px;
  border-radius: var(--r-sm);
  font-size: 14px;
  border: 1px solid var(--line);
  color: var(--text);
  cursor: pointer;
  transition: border-color var(--dur) var(--ease), background var(--dur) var(--ease),
    box-shadow var(--dur) var(--ease);
}
.act:hover {
  border-color: var(--line-strong);
  background: var(--bg-elev);
}
.act.primary {
  background: var(--accent);
  color: var(--accent-contrast);
  border-color: var(--accent);
}
.act.primary:hover {
  background: var(--accent-strong);
  border-color: var(--accent-strong);
  box-shadow: 0 8px 22px -12px color-mix(in oklch, var(--accent) 70%, transparent);
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
    /* 窄屏改为上下堆叠:行高交还给内容,由 body 整体滚动 */
    grid-template-rows: auto auto;
    overflow-y: auto;
  }
  .stage {
    min-height: 320px;
  }
  .side {
    border-left: none;
    border-top: 1px solid var(--line);
    overflow-y: visible;
  }
}
</style>