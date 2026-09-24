<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import { BACKGROUND_OPTIONS, QUALITY_OPTIONS, optionLabel, reuseParamsOf } from '../api'
import type { HistoryEntry, ReuseParams } from '../types'

const props = defineProps<{
  visible: boolean
  entry: HistoryEntry | null
}>()
const emit = defineEmits<{
  (e: 'close'): void
  (e: 'usePrompt', params: ReuseParams): void
  (e: 'favorite', prompt: string): void
  (e: 'reference', activeSrc: string): void
  (e: 'remove'): void
}>()

const active = ref(0)
const expanded = ref(false)
const menuOpen = ref(false)
// 复制后的短暂回执:复制 Prompt 现在是显眼的主操作,必须有反馈
const copied = ref(false)
let copiedTimer: number | undefined

const imgs = computed(() => {
  return props.entry ? props.entry.results.map((r) => renderData(r)) : []
})

// 缩略图按出图比例裁形:竖幅就是竖条,和主图对得上,而不是统一压成方块
const ratio = computed(() => {
  const [w, h] = (props.entry?.size || '').split('x').map(Number)
  return w && h ? Math.min(2, Math.max(0.5, w / h)) : 1
})

// 主图盒子的比例以真实像素为准:size 填 auto 时记录里算不出比例,
// 而且上游偶尔会返回与请求不一致的尺寸,读 naturalWidth 最可靠
const loadedRatio = ref(0)
const boxRatio = computed(() => loadedRatio.value || ratio.value)
function onImgLoad(e: Event) {
  const el = e.target as HTMLImageElement
  if (el.naturalWidth && el.naturalHeight) loadedRatio.value = el.naturalWidth / el.naturalHeight
}

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
      copied.value = false
      loadedRatio.value = 0
    }
  }
)

// 换张时先清掉比例,等新图 load 再定,避免沿用上一张的比例
watch(
  () => active.value,
  () => (loadedRatio.value = 0)
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
  copied.value = true
  window.clearTimeout(copiedTimer)
  copiedTimer = window.setTimeout(() => (copied.value = false), 1600)
}

function useThisPrompt() {
  if (!props.entry) return
  emit('usePrompt', reuseParamsOf(props.entry))
  close()
}

// 耗时:10 秒以内保留一位小数,再长就取整,避免数字跳动太碎
function fmtElapsed(ms: number) {
  const s = ms / 1000
  return s >= 10 ? `${Math.round(s)}s` : `${s.toFixed(1)}s`
}

// 键盘支持
function onKey(e: KeyboardEvent) {
  if (!props.visible) return
  if (e.key === 'Escape') close()
  if (e.key === 'ArrowLeft') prev()
  if (e.key === 'ArrowRight') next()
}
onMounted(() => window.addEventListener('keydown', onKey))
onUnmounted(() => {
  window.removeEventListener('keydown', onKey)
  window.clearTimeout(copiedTimer)
})

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
        <div
          class="preview"
          :style="{ '--ratio': String(boxRatio), '--rail': imgs.length > 1 ? 1 : 0 }"
        >
          <!-- 主体:左图右信息 -->
          <div class="body no-bar">
            <!-- 图片区 -->
            <div class="stage">
              <div class="img-wrap" :style="{ aspectRatio: String(boxRatio) }">
                <img :src="imgs[active]" :alt="`生成结果 ${active + 1}`" @load="onImgLoad" />
                <button v-if="imgs.length > 1" class="nav prev tip-below" @click="prev" data-tip="上一张（←）" aria-label="上一张">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M15 6l-6 6 6 6" />
                  </svg>
                </button>
                <button v-if="imgs.length > 1" class="nav next tip-below" @click="next" data-tip="下一张（→）" aria-label="下一张">
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
                  :style="{ aspectRatio: String(ratio) }"
                  :aria-label="`第 ${i + 1} 张`"
                  @click="active = i"
                >
                  <img :src="src" :alt="`缩略图 ${i + 1}`" />
                </button>
              </div>
            </div>

            <!-- 信息侧栏 -->
            <aside class="side no-bar">
              <!-- 顶行只放操作控件,右对齐 -->
              <div class="toolbar">
                <span v-if="imgs.length > 1" class="tpill tcount">{{ active + 1 }} / {{ imgs.length }}</span>
                <span class="menu-wrap">
                  <button class="tpill tip-below" @click="menuOpen = !menuOpen" data-tip="更多操作" aria-label="更多操作">
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
                <button class="tpill tip-below" @click="close" data-tip="关闭（Esc）" aria-label="关闭">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">
                    <path d="M6 6l12 12M18 6L6 18" />
                  </svg>
                </button>
              </div>

              <!-- 提示词:小节标题带分隔线,复制收在标题右侧,贴着它作用的内容 -->
              <section class="block">
                <header class="blk-head">
                  <span class="blk-title">提示词</span>
                  <button
                    class="blk-act tip-left"
                    :class="{ done: copied }"
                    @click="copyPrompt"
                    data-tip="复制到剪贴板"
                    :aria-label="copied ? '已复制' : '复制到剪贴板'"
                  >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                      <rect x="9" y="9" width="11" height="11" rx="2" />
                      <path d="M5 15V6a1 1 0 0 1 1-1h9" />
                    </svg>
                    <span>{{ copied ? '已复制' : '复制' }}</span>
                  </button>
                </header>
                <p class="prompt" :class="{ clipped: !expanded }">{{ entry.prompt }}</p>
                <button v-if="entry.prompt.length > 120" class="expand-btn" @click="expanded = !expanded">
                  {{ expanded ? '收起' : '展开' }}
                </button>
              </section>

              <!-- 参数与时间:放在提示词之后,作为这条记录的"底注" -->
              <div class="side-head">
                <div class="side-tags">
                  <span class="tag">{{ entry.size }}</span>
                  <span v-if="entry.model" class="tag tag-model">{{ entry.model }}</span>
                  <!-- 扩展参数只在非默认档时出现:全都是「自动」的记录不必堆一排无信息的标签 -->
                  <span v-if="entry.quality" class="tag">
                    画质 · {{ optionLabel(QUALITY_OPTIONS, entry.quality) }}
                  </span>
                  <span v-if="entry.background" class="tag">
                    背景 · {{ optionLabel(BACKGROUND_OPTIONS, entry.background) }}
                  </span>
                  <span v-if="entry.hasRef" class="tag">参考图</span>
                  <span v-if="entry.elapsedMs" class="tag tag-dim">{{ fmtElapsed(entry.elapsedMs) }}</span>
                </div>
                <span class="meta">{{ new Date(entry.createdAt).toLocaleString() }}</span>
              </div>

              <!-- 底部操作:主次并排,占满侧栏宽度 -->
              <div class="side-actions">
                <button class="act primary" @click="useThisPrompt">使用 Prompt</button>
                <button class="act" @click="download">下载</button>
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
  --side-w: 300px;
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

/* 顶行只放操作控件,推到右侧 */
.toolbar {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
}
/* 胶囊按钮:计数、更多、关闭共用一套造型 */
.tpill {
  height: 34px;
  min-width: 34px;
  padding: 0 12px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  border: 1px solid var(--line);
  border-radius: 999px;
  background: var(--surface);
  color: var(--text-2);
  font-size: 13px;
  cursor: pointer;
  transition: color var(--dur) var(--ease), border-color var(--dur) var(--ease),
    background var(--dur) var(--ease);
}
.tpill svg {
  width: 15px;
  height: 15px;
}
/* 计数只是状态,不该有悬停反馈,所以把它排除在按钮态之外 */
.tpill:not(.tcount):hover {
  color: var(--text);
  border-color: var(--line-strong);
  background: var(--surface);
}
.tcount {
  cursor: default;
  color: var(--text-3);
  font-variant-numeric: tabular-nums;
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
}
/* 图盒按出图比例收缩:高度吃满可用空间,宽度由 aspect-ratio 推出。
   去掉灰底后,盒子有多余空间也看不见;max-width 兜住超宽图 */
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
  overflow-y: auto;
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
}
/* 时间可能被本地化成较长的串,允许截断,别把操作簇挤走 */
.meta {
  /* 补上与胶囊等宽的缩进,让时间戳的文字和标签内的文字共用一条左边线 */
  padding-left: var(--tag-pad-x);
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  color: var(--text-3);
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
/* 小节内的图标动作:默认弱化,悬停才浮出,免得和正文抢注意力 */
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
  width: 13px;
  height: 13px;
}
.blk-act:hover {
  color: var(--accent);
  background: var(--accent-soft);
}
/* 复制成功后的回执:换成强调色,1.6 秒后自行复原 */
.blk-act.done {
  color: var(--accent-strong);
  background: var(--accent-soft);
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
/* 底部操作并排,等分侧栏宽度,和顶部的胶囊形成一轻一重的收尾 */
.side-actions {
  display: flex;
  gap: var(--sp-2);
  margin-top: auto;
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
    overflow-y: visible;
  }
}
</style>