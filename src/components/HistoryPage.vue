<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import {
  PhHeart,
  PhArrowLineUp,
  PhTrash,
  PhClockCounterClockwise,
  PhDownloadSimple,
  PhCheckCircle,
  PhCircle
} from '@phosphor-icons/vue'
import { exportImages, imageSrc, reuseParamsOf, thumbSrc } from '../api'
import { blobToDataURL } from '../lib/idb'
import type { HistoryEntry, ResultItem, ReuseParams } from '../types'

/* 历史记录:独立页面。
   展示沿用首页「Recent creations」图墙的做法 —— 一条记录里的多张图摊平成一块块图,
   每块按自己的出图比例定尺寸,默认只露图,提示词与参数悬停时才浮出来。
   这和首页图墙是同一套词汇,两处不必再学两种看图的习惯。 */

type Tile = { key: string; entry: HistoryEntry; index: number; item: ResultItem }

const props = defineProps<{
  items: HistoryEntry[]
}>()

const emit = defineEmits<{
  (e: 'open', entry: HistoryEntry): void
  (e: 'use', params: ReuseParams): void
  (e: 'remove', entry: HistoryEntry): void
  (e: 'mark', entry: HistoryEntry, index: number): void
}>()

/* 交回整条配方(提示词、参数、种子、当时的模型配置、参考图)。
   参考图存的是 Blob,要转成 data URL 才交得出去 —— 所以这里是异步的,
   与预览卡那边的 Reuse 是同一套做法,两个入口不该给出不同的配方 */
async function reuse(entry: HistoryEntry) {
  const ref = entry.ref ? await blobToDataURL(entry.ref) : undefined
  emit('use', { ...reuseParamsOf(entry), ref })
}

// 摊平:一条记录三张图就是三块,每块都能点开预览,标记也各标各的
const tiles = computed<Tile[]>(() =>
  props.items.flatMap((entry) =>
    entry.results.map((item, index) => ({ key: `${entry.id}-${index}`, entry, index, item }))
  )
)
const imageCount = computed(() => tiles.value.length)

// 筛选的是图块,所以数量按张算而不是按条算
const onlyMarked = ref(false)
const markedCount = computed(() => tiles.value.filter((t) => t.item.marked).length)
const shownTiles = computed(() =>
  onlyMarked.value ? tiles.value.filter((t) => t.item.marked) : tiles.value
)

/* —— 多选下载 ——
   下载不写死"已标记的那些":标记是一份长期收藏,而"这次要带走哪几张"
   往往只是一次性的挑选。所以走一次显式的多选 —— 进来选,选完下载,退出即清空。
   选择按图块记(与 tiles 同粒度),所以一条记录里可以只挑一张 */
const selecting = ref(false)
const selected = ref(new Set<string>())
const selectedCount = computed(() => selected.value.size)

function toggleSelect(t: Tile) {
  const s = selected.value
  if (s.has(t.key)) s.delete(t.key)
  else s.add(t.key)
}
function startSelect() {
  selecting.value = true
  selected.value = new Set()
}
function endSelect() {
  selecting.value = false
  selected.value = new Set()
}
/* 进入选择后,整块图砖就是勾选框 —— 不再开预览,这里统一出口 */
function onTileClick(t: Tile) {
  if (selecting.value) toggleSelect(t)
  else emit('open', t.entry)
}
/* 「全选」作用于当前筛出来的那些:切到 Marked 再全选,正好就是标记过的那批 */
const allShownSelected = computed(
  () => shownTiles.value.length > 0 && shownTiles.value.every((t) => selected.value.has(t.key))
)
function toggleAll() {
  const next = new Set(selected.value)
  if (allShownSelected.value) shownTiles.value.forEach((t) => next.delete(t.key))
  else shownTiles.value.forEach((t) => next.add(t.key))
  selected.value = next
}

const exporting = ref(false)
const exportDone = ref(0)
const exportTotal = ref(0)
const exportMsg = ref('')
const exportErr = ref('')
let msgTimer: number | undefined

/** 打包进度放在按钮左边的状态位里,按钮文案保持不变 ——
    否则逐张读字节时按钮会一直改宽度,右缘固定也照样晃 */
const exportProgress = computed(() =>
  exporting.value && exportTotal.value ? `Packing ${exportDone.value} of ${exportTotal.value}…` : ''
)

async function downloadSelected() {
  if (exporting.value || !selectedCount.value) return
  /* 按 tiles 的顺序取,而不是按点击顺序:导出结果与图墙从左到右的排布一致,
     回头核对时不用在两张表之间找对应 */
  const picks = tiles.value
    .filter((t) => selected.value.has(t.key))
    .map((t) => ({ prompt: t.entry.prompt, item: t.item }))

  exporting.value = true
  exportMsg.value = ''
  exportErr.value = ''
  exportDone.value = 0
  exportTotal.value = picks.length
  try {
    const out = await exportImages(picks, (done, total) => {
      exportDone.value = done
      exportTotal.value = total
    })
    const total = out.exported + out.skipped
    if (!out.exported) {
      // 全是远端 URL 且都被跨域拦下时会走到这里:如实报错,不要静默什么都不发生
      exportErr.value = `Couldn't read any of the ${total} ${total === 1 ? 'image' : 'images'}`
    } else if (out.skipped) {
      /* 少了几张必须说出来:不然用户以为"导出了 10 张",实际只拿到 8 张。
         这一趟没交付完整,所以留在选择态里,让他能就着原选择重试 */
      exportMsg.value = `Exported ${out.exported} of ${total} — ${out.skipped} couldn't be read`
    } else {
      exportMsg.value = `Exported ${out.exported} ${out.exported === 1 ? 'image' : 'images'}`
      // 整套都拿到手了,选择态就没有留着的理由,自动收起
      endSelect()
    }
  } catch (e) {
    exportErr.value = e instanceof Error ? e.message : 'Export failed'
  } finally {
    exporting.value = false
    // 这条状态回答的是"刚刚发生了什么",过一会儿就该让位,不该一直挂着
    window.clearTimeout(msgTimer)
    msgTimer = window.setTimeout(() => {
      exportMsg.value = ''
      exportErr.value = ''
    }, 6000)
  }
}

/* 选择态是个模式,Esc 是最自然的出口。预览的 Esc 只在它自己可见时生效,
   而选择态下根本开不了预览,两者不会撞 */
function onKey(e: KeyboardEvent) {
  if (selecting.value && e.key === 'Escape') endSelect()
}
onMounted(() => window.addEventListener('keydown', onKey))
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey)
  window.clearTimeout(msgTimer)
})

/** 记录的尺寸解析成宽高比;'auto' 之类解析不出来时返回 null */
function ratioOfSize(size: string): number | null {
  const [w, h] = size.split('x').map(Number)
  if (!w || !h) return null
  return Math.min(2, Math.max(0.5, w / h))
}

/* 缩略块按图片真实比例排,而不是按当初选的尺寸 —— 上游可能返回不同比例的图。
   优先级:加载时量到的真实比例 → 入库时量到的 w/h → 解析 entry.size → 方形兜底。
   尺寸解析不出来时先按方形占位,免得图还没到、高度算成 0、整墙塌一下再撑开 */
const measured = ref<Record<string, number>>({})
function tileRatio(t: Tile) {
  const m = measured.value[t.key]
  if (m) return m
  const { w, h } = t.entry
  if (w && h) return Math.min(2, Math.max(0.5, w / h))
  return ratioOfSize(t.entry.size) ?? 1
}
function onTileLoad(t: Tile, e: Event) {
  // 已经有精确比例(量过,或入库记了 w/h)就不再重复量
  if (measured.value[t.key] || (t.entry.w && t.entry.h)) return
  const img = e.target as HTMLImageElement
  if (!img.naturalWidth || !img.naturalHeight) return
  measured.value[t.key] = Math.min(2, Math.max(0.5, img.naturalWidth / img.naturalHeight))
}

/* 低清底图:先把入库时存的缩略图铺上,原图到了再盖住。
   这样整墙不会先是一片色块、再一起跳出来 */
function tileBg(entry: HistoryEntry) {
  return entry.thumb ? { backgroundImage: `url(${thumbSrc(entry)})` } : undefined
}

function fmt(ts: number) {
  const d = new Date(ts)
  const p = (x: number) => String(x).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}
</script>

<template>
  <section class="lib" aria-label="History">
    <header class="lib-head">
      <div class="lib-title-wrap">
        <h1 class="lib-title">History</h1>
        <p class="lib-sub">
          {{ items.length }} {{ items.length === 1 ? 'record' : 'records' }} · {{ imageCount }} {{ imageCount === 1 ? 'image' : 'images' }}
        </p>
      </div>
      <!-- 页级动作:常态是「进入多选」,进了多选就换成那一套动作。
           整个块跟着一起收 —— 空的历史页不该在标题旁留一段空白 -->
      <div v-if="tiles.length || exportMsg || exportErr || exportProgress" class="lib-acts">
        <p
          v-if="exportErr || exportMsg || exportProgress"
          class="dl-msg"
          :class="{ bad: !!exportErr }"
          role="status"
        >
          {{ exportErr || exportMsg || exportProgress }}
        </p>
        <template v-if="selecting">
          <button v-if="shownTiles.length" type="button" class="lib-btn" @click="toggleAll">
            {{ allShownSelected ? 'Deselect all' : 'Select all' }}
          </button>
          <button
            type="button"
            class="lib-dl"
            :disabled="exporting || !selectedCount"
            @click="downloadSelected"
          >
            <PhDownloadSimple aria-hidden="true" />
            Download{{ selectedCount ? ` (${selectedCount})` : '' }}
          </button>
          <button type="button" class="lib-btn" @click="endSelect">Cancel</button>
        </template>
        <!-- 没有图可挑时不给这个入口,免得点进一个空的选择态 -->
        <button v-else-if="tiles.length" type="button" class="lib-btn" @click="startSelect">
          Select
        </button>
      </div>
    </header>

    <!-- 保留规则单独占一行:不写出来,记录被自动清掉时用户会以为丢了 -->
    <div class="lib-tools">
      <div class="mark-filter" role="group" aria-label="Filter">
        <button class="chip" :class="{ on: !onlyMarked }" :aria-pressed="!onlyMarked" @click="onlyMarked = false">
          All
        </button>
        <button class="chip" :class="{ on: onlyMarked }" :aria-pressed="onlyMarked" @click="onlyMarked = true">
          Marked <span class="chip-n">{{ markedCount }}</span>
        </button>
      </div>
      <p class="lib-note">
        {{
          selecting
            ? 'Pick images to download, then hit Download.'
            : 'Saved locally. Oldest records are cleared automatically when storage runs low.'
        }}
      </p>
    </div>

    <div
      v-if="shownTiles.length"
      class="wall"
      :role="selecting ? 'group' : undefined"
      :aria-label="selecting ? 'Select images to download' : undefined"
    >
      <div
        v-for="t in shownTiles"
        :key="t.key"
        class="tile"
        :class="{ picking: selecting, sel: selecting && selected.has(t.key) }"
        :style="{ aspectRatio: String(tileRatio(t)) }"
        @click="onTileClick(t)"
      >
        <!-- 画面单占一层:选择态要淡出的是"画面",而砖自己那层画布底必须留着。
             整块一起淡出会让页面纹理从图后透出来,和图片糊成一片 -->
        <div class="tile-media" :style="tileBg(t.entry)">
          <img
            loading="lazy"
            decoding="async"
            :src="imageSrc(t.item)"
            alt=""
            @load="onTileLoad(t, $event)"
          />
        </div>
        <!-- 整块覆盖的按钮:键盘与读屏都走它;
             外层 div 上的点击只给鼠标兜个底(点浮层空白处也算) -->
        <button
          type="button"
          class="tile-open"
          :aria-label="
            selecting ? `Select: ${t.entry.prompt}` : `Open preview: ${t.entry.prompt}`
          "
          :aria-pressed="selecting ? selected.has(t.key) : undefined"
          @click.stop="onTileClick(t)"
        ></button>
        <!-- 标记过的角标常驻:不悬停也要看得出哪些标了。
             选择态里它不撤 —— "哪些是我标过的"与"这次挑哪几张"是两件事,
             同时看得见才知道自己在挑的是不是收藏的那批 -->
        <span v-if="t.item.marked" class="tile-mark" aria-hidden="true">
          <PhHeart weight="fill" aria-hidden="true" />
        </span>
        <!-- 勾选角标只在选择态出现,放左上角,与右上的收藏角标各占一隅。
             两态同为圆形轮廓,只差中间有没有那枚勾 —— 不垫底、不换形状 -->
        <span v-if="selecting" class="tile-pick" aria-hidden="true">
          <PhCheckCircle v-if="selected.has(t.key)" weight="bold" aria-hidden="true" />
          <PhCircle v-else aria-hidden="true" />
        </span>
        <!-- 悬停/聚焦才浮出:图墙默认只应该是图 -->
        <div class="tile-veil">
          <div class="tile-text">{{ t.entry.prompt }}</div>
          <div class="tile-foot">
            <span class="tile-meta">
              {{ fmt(t.entry.createdAt) }} · {{ t.entry.size === 'auto' ? 'Auto' : t.entry.size.replace('x', '×') }}<template
                v-if="t.entry.results.length > 1"
              > · {{ t.entry.results.length }} images</template>
            </span>
            <!-- 图块本身的点击是打开预览(选择态下是勾选),这几个必须 stop。
                 选择态里收起这排操作:这一刻整块砖的语义是勾选框,
                 混进收藏/复用/删除只会让人点错 -->
            <div v-if="!selecting" class="tile-ops">
              <button
                class="top"
                :class="{ 'top-on': t.item.marked }"
                :aria-label="t.item.marked ? 'Unmark image' : 'Mark image'"
                :aria-pressed="!!t.item.marked"
                @click.stop="emit('mark', t.entry, t.index)"
              >
                <PhHeart :weight="t.item.marked ? 'fill' : 'regular'" aria-hidden="true" />
              </button>
              <button
                class="top"
                :aria-label="`Use prompt: ${t.entry.prompt.slice(0, 20)}`"
                @click.stop="reuse(t.entry)"
              >
                <PhArrowLineUp aria-hidden="true" />
              </button>
              <button
                class="top top-del"
                :aria-label="`Delete: ${t.entry.prompt.slice(0, 20)}`"
                @click.stop="emit('remove', t.entry)"
              >
                <PhTrash aria-hidden="true" />
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>

    <div v-else class="lib-none">
      <div class="none-ico" aria-hidden="true">
        <PhHeart v-if="onlyMarked" aria-hidden="true" />
        <PhClockCounterClockwise v-else aria-hidden="true" />
      </div>
      <h2 class="none-title">{{ onlyMarked ? 'No marked images yet' : 'No generations yet' }}</h2>
      <p class="none-sub">
        {{
          onlyMarked
            ? 'Hover an image and click the heart to mark it. Marks are per image, so images in a record stay independent.'
            : 'Generate from the home page and your results are saved here automatically, ready to revisit and reuse.'
        }}
      </p>
      <button v-if="onlyMarked" class="none-action" @click="onlyMarked = false">View all</button>
    </div>
  </section>
</template>

<style scoped>
/* 以下骨架与提示词库页保持一致 */
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
  color: var(--text-2);
}

/* 页级动作与它的状态位同处一行:状态就贴在它说明的那个动作旁边。
   选择态下这里会并排三个按钮,窄屏靠换行收下去 */
.lib-acts {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  align-items: center;
  gap: var(--sp-2) var(--sp-3);
}
.dl-msg {
  font-size: var(--fs-xs);
  color: var(--text-2);
  font-variant-numeric: tabular-nums;
  text-align: right;
}
.dl-msg.bad {
  color: var(--danger);
}
/* 与提示词库页的「新建」同一套规格:页级主操作,40px 触控目标 */
.lib-dl {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex: none;
  height: 40px;
  padding: 0 16px;
  border: 0;
  border-radius: 999px;
  background: var(--cta);
  color: var(--cta-text);
  font-size: var(--fs-sm);
  font-weight: 500;
  white-space: nowrap;
  cursor: pointer;
  transition: background var(--dur) var(--ease), opacity var(--dur) var(--ease);
}
.lib-dl svg {
  width: 15px;
  height: 15px;
}
.lib-dl:hover:not(:disabled) {
  background: var(--cta-hover);
}
/* 打包期间置灰而不是换文案:逐张读字节时按钮一直改宽度会晃 */
.lib-dl:disabled {
  opacity: 0.6;
  cursor: default;
}
/* 次级动作:进入多选 / 全选 / 退出,与黑药丸主操作同一尺寸、更轻的分量 */
.lib-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex: none;
  height: 40px;
  padding: 0 16px;
  border: 1px solid var(--line);
  border-radius: 999px;
  background: none;
  color: var(--text);
  font-size: var(--fs-sm);
  font-weight: 500;
  white-space: nowrap;
  cursor: pointer;
  transition: border-color var(--dur) var(--ease), background var(--dur) var(--ease);
}
.lib-btn:hover {
  border-color: var(--line-strong);
  background: var(--bg-elev);
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
/* 筛选胶囊与提示词库页的分类胶囊同一套规格 */
.mark-filter {
  display: flex;
  gap: 6px;
}
.chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  border-radius: 999px;
  border: 1px solid var(--line);
  background: none;
  color: var(--text-2);
  font-size: var(--fs-xs);
  cursor: pointer;
  transition: background var(--dur) var(--ease), border-color var(--dur) var(--ease),
    color var(--dur) var(--ease);
}
.chip:hover {
  color: var(--text);
  border-color: var(--line-strong);
}
.chip.on {
  background: var(--accent-soft);
  border-color: color-mix(in oklch, var(--accent) 45%, transparent);
  color: var(--accent-strong);
}
.chip-n {
  font-variant-numeric: tabular-nums;
  opacity: 0.75;
}
.lib-note {
  margin-left: auto;
  font-size: var(--fs-xs);
  color: var(--text-2);
}

/* 图墙:固定列宽、列数由容器宽度自己算,不用媒体查询。
   多列布局天然错落,配合每块各自的出图比例就是首页图墙的样子 */
.wall {
  margin-top: var(--sp-4);
  column-width: 240px;
  column-gap: var(--sp-3);
}
.tile {
  position: relative;
  display: block;
  width: 100%;
  /* 多列布局下用 margin 撑开纵向间距,break-inside 防止一块被拆到两列 */
  margin: 0 0 var(--sp-3);
  border-radius: var(--r);
  overflow: hidden;
  break-inside: avoid;
  /* 画布底色:画面层淡出时露出来的就是它。它必须不透明 ——
     整块砖一起变透明的话,页面纹理会从图后透出来 */
  background-color: var(--image-bg);
  cursor: zoom-in;
  transition: box-shadow var(--dur) var(--ease);
}
/* 画面层:画布底图(缩略图)与原图同处这一层,要淡出的正是这一整层 */
.tile-media {
  position: absolute;
  inset: 0;
  background-size: cover;
  background-position: center;
  transition: opacity var(--dur) var(--ease);
}
/* 聚焦态跟着内部按钮走:焦点环由 :focus-within 表达 */
.tile:hover,
.tile:focus-within {
  box-shadow: var(--sh-md);
}
.tile:focus-within {
  box-shadow: var(--sh-md), 0 0 0 3px var(--accent-soft);
}
/* 选择态:整块砖是勾选框,所以光标从"放大看"变成"点选" */
.tile.picking,
.tile.picking .tile-open {
  cursor: pointer;
}
/* 没被挑中的退到背后:这一刻要看的不再是这一墙图,而是"我挑中了哪几张"。
   把其余的压暗,选中的那几张自然浮出来 —— 于是"选中"不必再往图上加东西:
   描边、底片、遮罩都是在图上多糊一层,压暗其余才是减法。
   淡的是画面层而不是整块砖:砖的画布底留在底下接着,页面纹理透不上来。
   刻意不给 hover 提亮:一墙里"亮的"只该有一个含义 —— 被选中了;
   悬停的反馈由 .tile:hover 那条投影负责 */
.tile.picking:not(.sel) .tile-media {
  opacity: 0.3;
}
/* 覆盖整块的打开按钮:透明无边框,聚焦环交给 .tile:focus-within */
.tile-open {
  position: absolute;
  inset: 0;
  padding: 0;
  border: 0;
  background: none;
  cursor: zoom-in;
  outline: none;
}
.tile-media img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
  transition: transform 600ms var(--ease);
}
.tile:hover .tile-media img {
  transform: scale(1.04);
}

/* 角标:默认隐去,悬停/聚焦时浮出提示词与参数 */
.tile-veil {
  position: absolute;
  inset: auto 0 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 26px 8px 8px;
  text-align: left;
  color: #fff;
  background: linear-gradient(to top, rgba(0, 0, 0, 0.62), transparent);
  opacity: 0;
  pointer-events: none;
  transition: opacity var(--dur) var(--ease);
}
/* 标记角标常驻:压在图上,用投影保住任何底色下的可读性 */
.tile-mark {
  position: absolute;
  top: 8px;
  right: 8px;
  color: #fff;
  filter: drop-shadow(0 1px 3px rgba(0, 0, 0, 0.55));
  pointer-events: none;
}
.tile-mark svg {
  display: block;
  width: 16px;
  height: 16px;
}
/* 勾选角标:放左上角,与右上的收藏角标各占一隅,互不遮挡。
   两态同为圆形轮廓,只差中间那枚勾;不垫底、不换形状 ——
   "选中"主要靠未选中的那些被压暗来读(见上面的 .tile.picking:not(.sel)),
   这一枚只负责把选中项本身点明。
   白色 + 投影那套与收藏角标一致,图墙什么底色上都能认出来 */
.tile-pick {
  position: absolute;
  top: 8px;
  left: 8px;
  display: flex;
  color: #fff;
  filter: drop-shadow(0 1px 3px rgba(0, 0, 0, 0.55));
  pointer-events: none;
}
.tile-pick svg {
  display: block;
  width: 20px;
  height: 20px;
}
.tile:hover .tile-veil,
.tile:focus-visible .tile-veil,
.tile:focus-within .tile-veil {
  opacity: 1;
  /* 只有浮出来的时候才接事件,否则它会挡住图块本身的点击 */
  pointer-events: auto;
}
.tile-text {
  font-size: var(--fs-xs);
  line-height: 1.5;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.tile-foot {
  display: flex;
  align-items: center;
  gap: 8px;
}
.tile-meta {
  min-width: 0;
  font-size: var(--fs-micro);
  font-variant-numeric: tabular-nums;
  opacity: 0.85;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tile-ops {
  display: flex;
  flex-shrink: 0;
  gap: 2px;
  margin-left: auto;
}
/* 压在图片+黑色渐变上,所以用半透明白底而不是主题色。
   24px 比图块外的按钮小一档:这里同时要放三个,再宽元信息就被挤没了 */
.top {
  width: 24px;
  height: 24px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 0;
  border-radius: var(--r-sm);
  color: #fff;
  background: rgba(255, 255, 255, 0.18);
  cursor: pointer;
  transition: background var(--dur) var(--ease), transform 120ms var(--ease);
}
.top svg {
  width: 14px;
  height: 14px;
}
.top:hover {
  background: rgba(255, 255, 255, 0.32);
}
.top:active {
  transform: scale(0.94);
}
/* 已标记:星标实心且底色加重,和未标记区分得开 */
.top-on {
  background: rgba(255, 255, 255, 0.9);
  color: #1a1a1a;
}
.top-on:hover {
  background: #fff;
}
.top-del:hover {
  background: color-mix(in oklch, var(--danger) 78%, transparent);
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
  color: var(--text-2);
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
  background: none;
  color: var(--text);
  font-size: var(--fs-sm);
  cursor: pointer;
  transition: border-color var(--dur) var(--ease), background var(--dur) var(--ease);
}
.none-action:hover {
  border-color: var(--line-strong);
  background: var(--bg-elev);
}

/* 窄屏:标题收一档,避免与右上角操作按钮挤压 */
@media (max-width: 640px) {
  .lib-title {
    font-size: var(--fs-xl);
  }
  /* 选择态下这里有三个按钮,挤不进标题那一行:让它独占据一行,自己再换行 */
  .lib-acts {
    width: 100%;
    justify-content: flex-start;
  }
}
</style>
