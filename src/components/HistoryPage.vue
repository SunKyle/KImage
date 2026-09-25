<script setup lang="ts">
import { computed, ref } from 'vue'
import { imageSrc, reuseParamsOf, thumbSrc } from '../api'
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

/** 记录的尺寸解析成宽高比;'auto' 之类解析不出来时返回 null */
function ratioOfSize(size: string): number | null {
  const [w, h] = size.split('x').map(Number)
  if (!w || !h) return null
  return Math.min(2, Math.max(0.5, w / h))
}

/* 解析不出比例时,等图加载完用它的真实比例补上 —— 否则 'auto' 的记录会被
   硬塞进方形里裁掉一截。先按方形占位,免得图还没到高度算成 0、整墙塌一下再撑开 */
const measured = ref<Record<string, number>>({})
function tileRatio(t: Tile) {
  return ratioOfSize(t.entry.size) ?? measured.value[t.key] ?? 1
}
function onTileLoad(t: Tile, e: Event) {
  if (ratioOfSize(t.entry.size)) return
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
  <section class="lib" aria-label="历史记录">
    <header class="lib-head">
      <div class="lib-title-wrap">
        <h1 class="lib-title">历史记录</h1>
        <p class="lib-sub">共 {{ items.length }} 条 · {{ imageCount }} 张图</p>
      </div>
    </header>

    <!-- 保留规则单独占一行:不写出来,记录被自动清掉时用户会以为丢了 -->
    <div class="lib-tools">
      <div class="mark-filter" role="group" aria-label="筛选">
        <button class="chip" :class="{ on: !onlyMarked }" :aria-pressed="!onlyMarked" @click="onlyMarked = false">
          全部
        </button>
        <button class="chip" :class="{ on: onlyMarked }" :aria-pressed="onlyMarked" @click="onlyMarked = true">
          标记 <span class="chip-n">{{ markedCount }}</span>
        </button>
      </div>
      <p class="lib-note">历史保存在本地，存储空间接近上限时会自动清理最旧的记录</p>
    </div>

    <div v-if="shownTiles.length" class="wall">
      <div
        v-for="t in shownTiles"
        :key="t.key"
        class="tile"
        role="button"
        tabindex="0"
        :style="{ aspectRatio: String(tileRatio(t)), ...tileBg(t.entry) }"
        :aria-label="t.entry.prompt"
        @click="emit('open', t.entry)"
        @keydown.enter.self.prevent="emit('open', t.entry)"
        @keydown.space.self.prevent="emit('open', t.entry)"
      >
        <img
          loading="lazy"
          decoding="async"
          :src="imageSrc(t.item)"
          alt=""
          @load="onTileLoad(t, $event)"
        />
        <!-- 标记过的角标常驻:不悬停也要看得出哪些标了 -->
        <span v-if="t.item.marked" class="tile-mark" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 3.6l2.63 5.33 5.88.86-4.25 4.14 1 5.86L12 17.03l-5.26 2.76 1-5.86-4.25-4.14 5.88-.86z" />
          </svg>
        </span>
        <!-- 悬停/聚焦才浮出:图墙默认只应该是图 -->
        <div class="tile-veil">
          <div class="tile-text">{{ t.entry.prompt }}</div>
          <div class="tile-foot">
            <span class="tile-meta">
              {{ fmt(t.entry.createdAt) }} · {{ t.entry.size === 'auto' ? '自动' : t.entry.size }}<template
                v-if="t.entry.results.length > 1"
              > · {{ t.entry.results.length }} 张</template>
            </span>
            <!-- 图块本身的点击是打开预览,这几个必须 stop,否则点它们也会跟着开预览 -->
            <div class="tile-ops">
              <button
                class="top"
                :class="{ 'top-on': t.item.marked }"
                :aria-label="t.item.marked ? '取消标记' : '标记这张图'"
                :aria-pressed="!!t.item.marked"
                @click.stop="emit('mark', t.entry, t.index)"
              >
                <svg
                  viewBox="0 0 24 24"
                  :fill="t.item.marked ? 'currentColor' : 'none'"
                  stroke="currentColor"
                  stroke-width="1.9"
                  stroke-linejoin="round"
                >
                  <path d="M12 3.6l2.63 5.33 5.88.86-4.25 4.14 1 5.86L12 17.03l-5.26 2.76 1-5.86-4.25-4.14 5.88-.86z" />
                </svg>
              </button>
              <button
                class="top"
                :aria-label="`使用提示词：${t.entry.prompt.slice(0, 20)}`"
                @click.stop="emit('use', reuseParamsOf(t.entry))"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M12 20V8M8 12l4-4 4 4" />
                  <path d="M4 20h16" />
                </svg>
              </button>
              <button
                class="top top-del"
                :aria-label="`删除记录：${t.entry.prompt.slice(0, 20)}`"
                @click.stop="emit('remove', t.entry)"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6 7l1 12a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-12" />
                </svg>
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>

    <div v-else class="lib-none">
      <div class="none-ico" aria-hidden="true">
        <svg v-if="onlyMarked" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round">
          <path d="M12 3.6l2.63 5.33 5.88.86-4.25 4.14 1 5.86L12 17.03l-5.26 2.76 1-5.86-4.25-4.14 5.88-.86z" />
        </svg>
        <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="9" />
          <path d="M12 7.4V12l2.8 1.9" />
        </svg>
      </div>
      <h2 class="none-title">{{ onlyMarked ? '还没有标记的图片' : '还没有生成记录' }}</h2>
      <p class="none-sub">
        {{
          onlyMarked
            ? '把鼠标移到图片上，点星标即可标记；标记是按张记的，同一条记录里的不同图互不影响。'
            : '在首页输入提示词并生成后，结果会自动保存在这里，随时回看与复用。'
        }}
      </p>
      <button v-if="onlyMarked" class="none-action" @click="onlyMarked = false">查看全部图片</button>
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
  font-family: var(--font-display);
  font-size: 28px;
  font-weight: 700;
  letter-spacing: -0.02em;
}
.lib-sub {
  margin-top: 6px;
  font-size: 13px;
  color: var(--text-2);
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
  font-size: 12px;
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
  font-size: 12px;
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
  /* 底色 + 低清底图:原图没到之前先占住位置,不至于整墙空一片 */
  background-color: var(--image-bg);
  background-size: cover;
  background-position: center;
  cursor: zoom-in;
  outline: none;
  transition: box-shadow var(--dur) var(--ease);
}
.tile:hover,
.tile:focus-visible {
  box-shadow: var(--sh-md);
}
.tile:focus-visible {
  box-shadow: var(--sh-md), 0 0 0 3px var(--accent-soft);
}
.tile img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
  transition: transform 600ms var(--ease);
}
.tile:hover img {
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
.tile:hover .tile-veil,
.tile:focus-visible .tile-veil,
.tile:focus-within .tile-veil {
  opacity: 1;
  /* 只有浮出来的时候才接事件,否则它会挡住图块本身的点击 */
  pointer-events: auto;
}
.tile-text {
  font-size: 12px;
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
  font-size: 11px;
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
  font-size: 13px;
  cursor: pointer;
  transition: border-color var(--dur) var(--ease), background var(--dur) var(--ease);
}
.none-action:hover {
  border-color: var(--line-strong);
  background: var(--bg-elev);
}
</style>
