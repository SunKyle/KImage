<script setup lang="ts">
import { ref, computed, nextTick, onMounted, onUnmounted, watch } from 'vue'
import { BACKGROUND_OPTIONS, QUALITY_OPTIONS, imageSrc, optionLabel, reuseParamsOf } from '../api'
import type { HistoryEntry, ResultItem, ReuseParams, FavoritePayload } from '../types'
import { detectMimeFromDataUrl } from '../lib/idb'

const props = defineProps<{
  visible: boolean
  entry: HistoryEntry | null
  // 全部历史,用于上下翻页在记录之间切换
  items: HistoryEntry[]
}>()
const emit = defineEmits<{
  (e: 'close'): void
  (e: 'navigate', entry: HistoryEntry): void
  (e: 'usePrompt', params: ReuseParams): void
  (e: 'favorite', payload: FavoritePayload): void
  (e: 'reference', item: ResultItem): void
  (e: 'remove'): void
  (e: 'mark', entry: HistoryEntry, index: number): void
}>()

const active = ref(0)
const menuOpen = ref(false)
// 菜单展开后点别处收起。ref 挂在包着按钮和菜单的那层上:
// 只监听菜单的话,点按钮收起会先被判成"外部点击",关掉又被 click 打开,反而关不上
const menuEl = ref<HTMLElement | null>(null)
function onDocPointerDown(e: PointerEvent) {
  if (!menuOpen.value) return
  const t = e.target as Node | null
  if (t && menuEl.value?.contains(t)) return
  menuOpen.value = false
}
// 复制后的短暂回执:复制 Prompt 现在是显眼的主操作,必须有反馈
const copied = ref(false)
// 复制失败也是一种必须给出的回执:写不进剪贴板时不能假装成功
const copyFailed = ref(false)
let copiedTimer: number | undefined
// 弹层的焦点管理:打开时记住原来的焦点,关闭时还回去;容器负责接住初始焦点
const panelEl = ref<HTMLElement | null>(null)
let lastFocused: HTMLElement | null = null

const imgs = computed(() => {
  return props.entry ? props.entry.results.map(imageSrc) : []
})

// 记录里的尺寸能解析出比例就直接用;'auto' 之类解析不出来时返回 0
const sizeRatio = computed(() => {
  const [w, h] = (props.entry?.size || '').split('x').map(Number)
  return w > 0 && h > 0 ? w / h : 0
})
// 缩略图收窄极端比例,免得竖条太细、横条太扁
const thumbRatio = computed(() => Math.min(2, Math.max(0.5, sizeRatio.value || 1)))

// 主图盒子:优先用记录里的尺寸。取不到才等图片加载,而且只锁第一张 ——
// 同一条记录里的图尺寸一致,锁定它才不会在左右翻页时反复改卡片宽度
const loadedRatio = ref(0)
const boxRatio = computed(() => sizeRatio.value || loadedRatio.value || 1)
function onImgLoad(e: Event) {
  if (loadedRatio.value) return
  const el = e.target as HTMLImageElement
  if (el.naturalWidth && el.naturalHeight) loadedRatio.value = el.naturalWidth / el.naturalHeight
}

// 每次打开、或上下翻到另一条记录,都回到初始视图
function resetView() {
  active.value = 0
  menuOpen.value = false
  copied.value = false
  copyFailed.value = false
  loadedRatio.value = 0
}
watch(
  () => props.visible,
  (v) => {
    if (v) {
      lastFocused = (document.activeElement as HTMLElement) || null
      resetView()
      // 焦点先落到弹层上:Tab 从这里开始走,读屏也会念出对话框
      nextTick(() => panelEl.value?.focus({ preventScroll: true }))
    } else {
      lastFocused?.focus?.()
      lastFocused = null
    }
  }
)
// 翻到别的记录时,单独重置(此时 visible 不变,上面那个 watch 不会触发)
watch(
  () => props.entry?.id,
  () => {
    if (props.visible) resetView()
  }
)

/** 时间戳取 "Sep 26, 18:52":toLocaleString 近 20 个字符,定宽侧栏里会被省略号吃掉 */
function fmtTime(ts: number) {
  return new Date(ts).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  })
}

// —— 记录导航:上下翻的是历史,左右翻的是本条内的多张图 ——
const entryIndex = computed(() => {
  const cur = props.entry
  return cur ? props.items.findIndex((e) => e.id === cur.id) : -1
})
const canGoUp = computed(() => entryIndex.value > 0)
const canGoDown = computed(() => entryIndex.value >= 0 && entryIndex.value < props.items.length - 1)
/** 沿历史列表上下移动:history 是最新在前,所以 -1 是更新的那条 */
function goEntry(step: number) {
  const next = props.items[entryIndex.value + step]
  if (next) emit('navigate', next)
}

function close() {
  emit('close')
}

function prev() {
  active.value = (active.value - 1 + imgs.value.length) % imgs.value.length
}
function next() {
  active.value = (active.value + 1) % imgs.value.length
}

/** 按载荷真实类型推下载扩展名:结果可能是 jpeg / webp,写死 png 名不对 */
function extOf(item: ResultItem | undefined): string {
  const data = item?.data
  if (data instanceof Blob) {
    const t = data.type
    if (t.includes('jpeg')) return 'jpg'
    if (t.includes('webp')) return 'webp'
    if (t.includes('gif')) return 'gif'
    return 'png'
  }
  if (typeof data === 'string') {
    const mime = detectMimeFromDataUrl(data)
    return mime === 'image/jpeg' ? 'jpg' : mime.split('/')[1] || 'png'
  }
  return 'png'
}

function download() {
  const url = imgs.value[active.value]
  if (!url) return
  const a = document.createElement('a')
  a.href = url
  if (/^https?:/.test(url)) {
    // 远端图源跨域,download 属性会被浏览器忽略:新窗口打开让用户自行另存
    a.target = '_blank'
    a.rel = 'noopener'
  } else {
    a.download = `kimage-${Date.now()}.${extOf(props.entry?.results[active.value])}`
  }
  a.click()
}

async function copyPrompt() {
  if (!props.entry) return
  copyFailed.value = false
  try {
    await navigator.clipboard.writeText(props.entry.prompt)
    copied.value = true
  } catch {
    // 写不进剪贴板(无权限 / 非安全上下文)就如实报错,别显示"已复制"
    copyFailed.value = true
  }
  window.clearTimeout(copiedTimer)
  copiedTimer = window.setTimeout(() => {
    copied.value = false
    copyFailed.value = false
  }, 1600)
}

function useThisPrompt() {
  if (!props.entry) return
  emit('usePrompt', reuseParamsOf(props.entry))
  close()
}

// 标记标的是"当前这张图",所以要跟着 active 走:一条记录里几张图各标各的。
// 字段和历史图墙共用(entry.results[].marked),这边只负责触发,落盘在主界面
const marked = computed(() => !!props.entry?.results[active.value]?.marked)
function toggleMark() {
  if (!props.entry) return
  emit('mark', props.entry, active.value)
}

// 耗时:10 秒以内保留一位小数,再长就取整,避免数字跳动太碎
function fmtElapsed(ms: number) {
  const s = ms / 1000
  return s >= 10 ? `${Math.round(s)}s` : `${s.toFixed(1)}s`
}

/** 弹层里当前可见的可聚焦元素,供 Tab 循环使用 */
function focusables(): HTMLElement[] {
  const root = panelEl.value
  if (!root) return []
  return Array.from(
    root.querySelectorAll<HTMLElement>(
      'button:not([disabled]), a[href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    )
  ).filter((el) => el.getClientRects().length > 0)
}
/** 把 Tab 关在弹层里:走到首/尾时绕回另一端,不让焦点跑到背后的页面 */
function trapTab(e: KeyboardEvent) {
  const els = focusables()
  if (!els.length) return
  const first = els[0]
  const last = els[els.length - 1]
  const cur = document.activeElement as HTMLElement | null
  if (e.shiftKey) {
    if (cur === first || cur === panelEl.value) {
      e.preventDefault()
      last.focus()
    }
  } else if (cur === last) {
    e.preventDefault()
    first.focus()
  }
}
// 键盘:左右翻本条的多张图,上下翻历史记录;Esc 分两级,Tab 锁在弹层内
function onKey(e: KeyboardEvent) {
  if (!props.visible) return
  if (e.key === 'Escape') {
    // 菜单开着先收菜单,再按一次才关预览
    if (menuOpen.value) menuOpen.value = false
    else close()
  } else if (e.key === 'Tab') trapTab(e)
  else if (e.key === 'ArrowLeft') prev()
  else if (e.key === 'ArrowRight') next()
  else if (e.key === 'ArrowUp') {
    // 拦下默认行为,否则上下键会去滚侧栏
    e.preventDefault()
    goEntry(-1)
  } else if (e.key === 'ArrowDown') {
    e.preventDefault()
    goEntry(1)
  }
}
onMounted(() => {
  window.addEventListener('keydown', onKey)
  document.addEventListener('pointerdown', onDocPointerDown)
})
onUnmounted(() => {
  window.removeEventListener('keydown', onKey)
  document.removeEventListener('pointerdown', onDocPointerDown)
  window.clearTimeout(copiedTimer)
})

// 菜单动作
function menuAction(kind: 'favorite' | 'reference' | 'remove') {
  if (!props.entry) return
  if (kind === 'favorite') {
    // 连参数和当前这张图一起交出去,库里才能既复现参数、又留下封面
    const item = props.entry.results[active.value]
    emit('favorite', {
      prompt: props.entry.prompt,
      size: props.entry.size,
      quality: props.entry.quality,
      background: props.entry.background,
      src: item ? imageSrc(item) : ''
    })
  } else if (kind === 'reference') {
    // 交出原始载荷而不是渲染用的 src:主界面要转成 data URL 才能当参考图
    const item = props.entry.results[active.value]
    if (item) emit('reference', item)
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
        <div
          ref="panelEl"
          class="preview"
          role="dialog"
          aria-modal="true"
          aria-label="Image preview"
          tabindex="-1"
          :style="{ '--ratio': String(boxRatio), '--rail': imgs.length > 1 ? 1 : 0 }"
        >
          <!-- 主体:左图右信息 -->
          <div class="body no-bar">
            <!-- 图片区 -->
            <div class="stage">
              <div class="img-wrap" :style="{ aspectRatio: String(boxRatio) }">
                <img :src="imgs[active]" :alt="`Result ${active + 1}`" @load="onImgLoad" />
                <button v-if="imgs.length > 1" class="nav prev tip-below" @click="prev" data-tip="Previous (←)" aria-label="Previous">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M15 6l-6 6 6 6" />
                  </svg>
                </button>
                <button v-if="imgs.length > 1" class="nav next tip-below" @click="next" data-tip="Next (→)" aria-label="Next">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M9 6l6 6-6 6" />
                  </svg>
                </button>
              </div>
              <!-- 缩略图导航:按出图比例成条,图多时这一列自己滚 -->
              <div v-if="imgs.length > 1" class="thumbs no-bar">
                <button
                  v-for="(src, i) in imgs"
                  :key="i"
                  class="thumb"
                  :class="{ active: i === active }"
                  :style="{ aspectRatio: String(thumbRatio) }"
                  :aria-label="`Image ${i + 1}`"
                  @click="active = i"
                >
                  <img :src="src" :alt="`Thumbnail ${i + 1}`" />
                </button>
              </div>
            </div>

            <!-- 信息侧栏 -->
            <aside class="side no-bar">
              <!-- 顶行分两组:左边翻记录,右边是当前这条的操作 -->
              <div class="toolbar">
                <!-- 上下翻历史:history 最新在前,所以 ↑ 是更新的那条 -->
                <div v-if="items.length > 1" class="tnav">
                  <button
                    class="tpill tip-below"
                    :disabled="!canGoUp"
                    @click="goEntry(-1)"
                    data-tip="Newer (↑)"
                    aria-label="Newer"
                  >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                      <path d="M6 15l6-6 6 6" />
                    </svg>
                  </button>
                  <span class="tpos">{{ entryIndex + 1 }} / {{ items.length }}</span>
                  <button
                    class="tpill tip-below"
                    :disabled="!canGoDown"
                    @click="goEntry(1)"
                    data-tip="Older (↓)"
                    aria-label="Older"
                  >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                      <path d="M6 9l6 6 6-6" />
                    </svg>
                  </button>
                </div>

                <div class="toolbar-main">
                  <span ref="menuEl" class="menu-wrap">
                    <button class="tpill tip-below" @click="menuOpen = !menuOpen" data-tip="More actions" aria-label="More actions">
                      <svg viewBox="0 0 24 24" fill="currentColor">
                        <circle cx="12" cy="5.5" r="1.6" />
                        <circle cx="12" cy="12" r="1.6" />
                        <circle cx="12" cy="18.5" r="1.6" />
                      </svg>
                    </button>
                    <Transition name="po">
                      <div v-if="menuOpen" class="menu">
                        <button class="mitem" @click="menuAction('favorite')">Save to library</button>
                        <button class="mitem" @click="menuAction('reference')">Use as reference</button>
                        <button class="mitem danger" @click="menuAction('remove')">Delete</button>
                      </div>
                    </Transition>
                  </span>
                  <button class="tpill tip-below" @click="close" data-tip="Close (Esc)" aria-label="Close">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">
                      <path d="M6 6l12 12M18 6L6 18" />
                    </svg>
                  </button>
                </div>
              </div>

              <!-- 提示词:小节标题带分隔线,复制收在标题右侧,贴着它作用的内容 -->
              <section class="block">
                <header class="blk-head">
                  <span class="blk-title">Prompt</span>
                  <!-- 两个动作收在一组:blk-head 是 space-between,直接并排会被推到中间去 -->
                  <div class="blk-acts">
                    <button
                      class="blk-act tip-left"
                      :class="{ done: copied, fail: copyFailed }"
                      @click="copyPrompt"
                      :data-tip="copyFailed ? 'Copy failed — select the text manually' : 'Copy to clipboard'"
                      :aria-label="copyFailed ? 'Copy failed' : copied ? 'Copied' : 'Copy to clipboard'"
                    >
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                        <rect x="9" y="9" width="11" height="11" rx="2" />
                        <path d="M5 15V6a1 1 0 0 1 1-1h9" />
                      </svg>
                      <span>{{ copyFailed ? 'Copy failed' : copied ? 'Copied' : 'Copy' }}</span>
                    </button>
                    <button
                      class="blk-act"
                      :class="{ on: marked }"
                      @click="toggleMark"
                      :aria-pressed="marked"
                      :aria-label="marked ? 'Unmark image' : 'Mark image'"
                    >
                      <svg
                        viewBox="0 0 24 24"
                        :fill="marked ? 'currentColor' : 'none'"
                        stroke="currentColor"
                        stroke-width="1.8"
                        stroke-linejoin="round"
                      >
                        <path d="M12 3.6l2.63 5.33 5.88.86-4.25 4.14 1 5.86L12 17.03l-5.26 2.76 1-5.86-4.25-4.14 5.88-.86z" />
                      </svg>
                      <span>{{ marked ? 'Marked' : 'Mark' }}</span>
                    </button>
                  </div>
                </header>
                <div class="prompt-scroll">
                  <p class="prompt">{{ entry.prompt }}</p>
                </div>
              </section>

              <!-- 参数与时间:放在提示词之后,作为这条记录的"底注" -->
              <div class="side-head">
                <div class="side-tags">
                  <!-- 模型放首位:它是这条记录最关键的来源信息,尺寸退到其后 -->
                  <span v-if="entry.model" class="tag tag-model">{{ entry.model }}</span>
                  <span class="tag">{{ entry.size === 'auto' ? 'Auto' : entry.size.replace('x', '×') }}</span>
                  <!-- 扩展参数只在非默认档时出现:全都是「自动」的记录不必堆一排无信息的标签 -->
                  <span v-if="entry.quality" class="tag">
                    Quality · {{ optionLabel(QUALITY_OPTIONS, entry.quality) }}
                  </span>
                  <span v-if="entry.background" class="tag">
                    Background · {{ optionLabel(BACKGROUND_OPTIONS, entry.background) }}
                  </span>
                  <span v-if="entry.hasRef" class="tag">Reference</span>
                  <span v-if="entry.elapsedMs" class="tag tag-dim">{{ fmtElapsed(entry.elapsedMs) }}</span>
                </div>
                <span class="meta">{{ fmtTime(entry.createdAt) }}</span>
              </div>

              <!-- 底部操作:主次并排,占满侧栏宽度 -->
              <div class="side-actions">
                <button class="act primary" @click="useThisPrompt">Use prompt</button>
                <button class="act" @click="download">Download</button>
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
  /* 出图比例(--ratio)与是否带缩略图条(--rail,0/1)由组件按当前这张图注入 */
  --prev-h: min(92vh, 880px);
  --stage-pad: var(--sp-4);
  /* 320px 而不是 300px:300 减去左右各 24 的内边距只剩 252,
     提示词换行太密、参数标签一行排不下三个 */
  --side-w: 320px;
  --thumb-w: 46px;

  /* 高度取确定值,不随内容伸缩:展开提示词只在侧栏内部滚动,卡片高度保持不变 */
  height: var(--prev-h);
  /* 宽度跟着图片比例走:图占满可用高度后推出来的宽度 + 缩略图条 + 内边距 + 侧栏。
     这样竖图不再左右留空,横图也挤不掉侧栏 */
  width: min(
    100%,
    calc(
      (var(--prev-h) - 2 * var(--stage-pad)) * var(--ratio, 1) + var(--rail, 0) *
        (var(--thumb-w) + var(--sp-4)) + 2 * var(--stage-pad) + var(--side-w)
    )
  );
  background: var(--bg);
  border: 1px solid var(--line);
  border-radius: var(--r-lg);
  overflow: hidden;
  display: flex;
  flex-direction: column;
  box-shadow: var(--sh-md);
}

/* 顶行分两组:左=翻记录,右=本条的操作;两组各自成团 */
.toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-3);
}
/* 翻记录的箭头组:两个圆钮夹一个位置指示 */
.tnav {
  display: flex;
  align-items: center;
  gap: 4px;
}
.tpos {
  min-width: 46px;
  text-align: center;
  font-size: 12px;
  color: var(--text-3);
  font-variant-numeric: tabular-nums;
}
/* 没有翻记录那组时,右侧这组也要靠右 */
.toolbar-main {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-left: auto;
}
/* 圆形图标按钮:与主页面的 .param-btn / .icob 同一套造型。
   宽高必须相等 —— 靠左右 padding 撑宽会变成椭圆 */
.tpill {
  flex-shrink: 0;
  width: 34px;
  height: 34px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--line);
  border-radius: 999px;
  background: var(--surface);
  color: var(--text-2);
  cursor: pointer;
  transition: color var(--dur) var(--ease), border-color var(--dur) var(--ease),
    background var(--dur) var(--ease);
}
.tpill svg {
  width: 17px;
  height: 17px;
}
/* 只有禁用态(翻到头的那一端)不参与悬停反馈 */
.tpill:not(:disabled):hover {
  color: var(--text);
  border-color: var(--line-strong);
  background: var(--bg-elev);
}
.tpill:disabled {
  opacity: 0.4;
  cursor: not-allowed;
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
  /* 图片列必须写 minmax(0, …):1fr 的自动最小尺寸会被图盒的固有宽度顶开,
     结果就是宽图把固定宽度的侧栏挤扁 */
  grid-template-columns: minmax(0, 1fr) var(--side-w);
  /* 行高填满 body:两栏等高,侧栏内容再多也只在自己内部滚动 */
  grid-template-rows: minmax(0, 1fr);
  min-height: 0;
  flex: 1;
}

/* 图片区:图与缩略图作为一组居中,不再让图盒撑满整列 */
.stage {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  /* 与 padding 取同一档:缩略图条左右两侧的间距才相等(8px 的 gap 会显得左边挤) */
  gap: var(--sp-4);
  padding: var(--sp-4);
  min-height: 0;
  background: var(--stage-bg);
}
/* 图盒按出图比例收缩:高度吃满可用空间,宽度由 aspect-ratio 推出。
   max-width 兜住超宽图 */
.img-wrap {
  position: relative;
  height: 100%;
  min-width: 0;
  max-width: 100%;
  flex: 0 1 auto;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--r);
  overflow: hidden;
}
.img-wrap img {
  /* 撑满已定比例的盒子;比例与图一致时不留边,不一致时 contain 也不会变形 */
  width: 100%;
  height: 100%;
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
  width: 18px;
  height: 18px;
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
  /* 图多时这一列自己滚,不把卡片撑高 */
  max-height: 100%;
  overflow-y: auto;
  padding: 2px;
}
.thumb {
  flex-shrink: 0;
  width: 46px;
  /* 高由 aspect-ratio 决定:与出图比例一致,一眼看出竖幅还是横幅 */
  border-radius: 8px;
  overflow: hidden;
  border: 1px solid var(--line);
  opacity: 0.5;
  cursor: pointer;
  transition: opacity var(--dur) var(--ease), border-color var(--dur) var(--ease),
    box-shadow var(--dur) var(--ease);
}
.thumb img {
  width: 100%;
  height: 100%;
  display: block;
  object-fit: cover;
}
.thumb:hover {
  opacity: 0.85;
}
.thumb.active {
  border-color: color-mix(in oklch, var(--accent) 70%, transparent);
  opacity: 1;
  box-shadow: 0 0 0 1px color-mix(in oklch, var(--accent) 70%, transparent);
}
/* 信息侧栏 */
.side {
  display: flex;
  flex-direction: column;
  /* 顶边收到 16px 与左栏图片对齐:头部行去掉后,这条基准线才露出来 */
  padding: var(--sp-4) var(--sp-5) var(--sp-5);
  border-left: 1px solid var(--line);
  gap: var(--sp-5);
  /* 整栏不滚:只有提示词那块在自己内部滚,工具栏、参数与底部操作始终留在原位 */
  overflow: hidden;
}
/* 参数标签与时间是一组:时间贴着标签下方,间距比小节之间紧一档 */
.side-head {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  /* 胶囊的左右内边距。时间要靠它对齐到标签内的文字,而不是对齐到胶囊边框 */
  --tag-pad-x: 9px;
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
  padding: 2px var(--tag-pad-x);
}
.tag-model {
  color: var(--accent);
  border-color: color-mix(in oklch, var(--accent) 30%, var(--line));
  background: var(--accent-soft);
}
/* 耗时属于度量值,比参数标签更低一级,再退一档灰 */
.tag-dim {
  color: var(--text-3);
  /* 耗时是度量值,等宽数字免得 1.2s 与 12.3s 宽窄不一 */
  font-variant-numeric: tabular-nums;
}
/* 时间已压到 "Sep 26, 18:52",仍留截断兜底:不同语言环境长度会变 */
.meta {
  /* 补上与胶囊等宽的缩进,让时间戳的文字和标签内的文字共用一条左边线 */
  padding-left: var(--tag-pad-x);
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  color: var(--text-3);
  font-variant-numeric: tabular-nums;
}
/* 提示词小节吃掉侧栏的剩余高度,再在里面划出滚动区:
   长提示词只把这一个区域撑出滚动条,不会把下面的参数和按钮推出视野 */
.block {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
}
/* min-height 必须归零:flex 子项默认不肯收缩到内容以下,不归零滚动条就不出现 */
.prompt-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  /* 给滚动条留一点余地,免得文字贴着它 */
  padding-right: 4px;
}
/* 侧栏小节:标题带一条分隔线,把长侧栏切出层次 */
.blk-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-3);
  padding-bottom: 8px;
  margin-bottom: var(--sp-3);
  border-bottom: 1px solid var(--line);
}
.blk-title {
  font-size: 13px;
  font-weight: 600;
  letter-spacing: -0.005em;
  color: var(--text-2);
}
/* 小节内的图标动作:默认弱化,悬停才浮出,免得和正文抢注意力。
   两个动作收在 .blk-acts 里 —— blk-head 是 space-between,直接并排会被推到中间 */
.blk-acts {
  display: flex;
  align-items: center;
  gap: 2px;
}
.blk-act {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 9px;
  font-size: 12px;
  color: var(--text-3);
  border-radius: 999px;
  cursor: pointer;
  transition: color var(--dur) var(--ease), background var(--dur) var(--ease);
}
.blk-act svg {
  width: 15px;
  height: 15px;
}
.blk-act:hover {
  color: var(--accent);
  background: var(--accent-soft);
}
/* done = 复制成功后的短暂回执(1.6 秒);on = 这张图已被标记的常驻状态 */
.blk-act.done,
.blk-act.on {
  color: var(--accent-strong);
  background: var(--accent-soft);
}
/* fail = 复制没写进剪贴板,如实标红 */
.blk-act.fail {
  color: var(--danger);
  background: color-mix(in oklch, var(--danger) 10%, transparent);
}
/* 弹层容器只用来接住初始焦点,聚焦环由内部控件承担 */
.preview:focus {
  outline: none;
}
/* 提示词是这张卡真正的主角:给正文色、并比按钮再大一档,
   参数标签退到 --text-2 去当注脚 */
.prompt {
  font-size: 15px;
  line-height: 1.75;
  color: var(--text);
  white-space: pre-wrap;
}
/* 提示词不再折叠:内容长了就在 .prompt-scroll 里滚,不必先点一次「展开」 */
/* 底部操作并排,等分侧栏宽度,和顶部的胶囊形成一轻一重的收尾。
   留白已由 .block 的 flex: 1 吃掉,不再需要 margin-top: auto 把它顶到底 */
.side-actions {
  display: flex;
  gap: var(--sp-2);
  padding-top: var(--sp-3);
}
.act {
  flex: 1;
  padding: 11px 16px;
  border-radius: var(--r-sm);
  font-size: 14px;
  border: 1px solid var(--line);
  background: var(--surface);
  color: var(--text);
  cursor: pointer;
  transition: border-color var(--dur) var(--ease), background var(--dur) var(--ease),
    box-shadow var(--dur) var(--ease);
}
.act:hover {
  border-color: var(--line-strong);
  background: var(--bg-elev);
}
/* 主操作用 --cta(黑药丸),与主页面发送键同一套 token:
   深色模式下它会自动反相成白底黑字,不用另写主题覆盖。
   accent 在这套设计里的职责是 AI 状态/高亮,不作为按钮底色。 */
.act.primary {
  background: var(--cta);
  color: var(--cta-text);
  border-color: var(--cta);
}
.act.primary:hover {
  background: var(--cta-hover);
  border-color: var(--cta-hover);
  box-shadow: 0 8px 22px -12px color-mix(in oklch, var(--cta) 55%, transparent);
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
  .preview {
    /* 竖排后侧栏在下方,按比例推出来的宽度不再成立,直接铺满可用宽度 */
    width: 100%;
  }
  .body {
    grid-template-columns: 1fr;
    /* 窄屏改为上下堆叠:行高交还给内容,由 body 整体滚动 */
    grid-template-rows: auto auto;
    overflow-y: auto;
  }
  .stage {
    /* 竖排后这一行的高度由内容决定,图盒的 height:100% 会失去依据,
       所以这里给一个确定高度,顺带保证图片有足够的展示空间 */
    height: 56vh;
    min-height: 260px;
  }
  .side {
    border-left: none;
    border-top: 1px solid var(--line);
    overflow: visible;
  }
  /* 竖排后卡片高度由内容决定,「区域内滚」失去约束:
     取消 flex 分配与滚动,把高度交还给内容,整页滚更自然 */
  .block {
    flex: none;
  }
  .prompt-scroll {
    overflow-y: visible;
    padding-right: 0;
  }
}
</style>