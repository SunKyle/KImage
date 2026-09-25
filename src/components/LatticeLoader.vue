<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'

/* React Bits 的 LatticeLoader,移植成 Vue 3。
   波形完全交给 CSS:每个格子按图案里的顺序错开 animation-delay,自己循环,
   所以运行期没有逐帧 JS。唯一写 DOM 的地方是那个计时器(每 100ms 一次),
   走 ref 直接改 textContent,不触发组件重渲染 —— 和 RubberSegment 里
   滑块裁剪同一个理由:MotionValue / 定时器这类高频写入要绕开渲染周期。 */

type Plan = { cells: (number | null)[]; loop: number; scale: number; lit?: number }
type Mark = 'done' | 'error'

const PATTERNS: Record<string, Record<number, Plan>> = {
  arrow: { 3: { cells: [1, 2, 3, 0, 1, 2, 1, 2, 3], loop: 7.2, scale: 1 } },
  dots: { 3: { cells: [0, 1, 2, 0, 1, 2, 0, 1, 2], loop: 3, scale: 2.4 } },
  ripple: { 3: { cells: [2, 1, 2, 1, 0, 1, 2, 1, 2], loop: 4.8, scale: 1.5 } },
  spiral: { 3: { cells: [0, 1, 2, 7, 8, 3, 6, 5, 4], loop: 9, scale: 1.2, lit: 0.35 } },
  orbit: {
    3: { cells: [0, 1, 2, 7, null, 3, 6, 5, 4], loop: 8, scale: 1.2 },
    4: {
      cells: [0, 1, 2, 3, 11, null, null, 4, 10, null, null, 5, 9, 8, 7, 6],
      loop: 6,
      scale: 1.2,
      lit: 0.45
    }
  },
  snake: {
    3: { cells: [0, 1, 2, 5, 4, 3, 6, 7, 8], loop: 9, scale: 1, lit: 0.35 },
    4: {
      cells: [0, 1, 2, 3, 7, 6, 5, 4, 8, 9, 10, 11, 15, 14, 13, 12],
      loop: 16,
      scale: 1,
      lit: 0.25
    }
  },
  sweep: {
    4: { cells: [0, 1, 2, 3, 1, 2, 3, 4, 2, 3, 4, 5, 3, 4, 5, 6], loop: 5, scale: 1, lit: 0.45 }
  },
  spin: {
    4: {
      cells: [0, 0, 1, 1, 0, 0, 1, 1, 3, 3, 2, 2, 3, 3, 2, 2],
      loop: 4,
      scale: 1.6,
      lit: 0.35
    }
  },
  rain: {
    4: {
      cells: [0, 2, 1, 3, 1, 3, 2, 4, 2, 4, 3, 5, 3, 5, 4, 6],
      loop: 4,
      scale: 1.2,
      lit: 0.35
    }
  },
  pulse: {
    4: {
      cells: [2, 1, 1, 2, 1, 0, 0, 1, 1, 0, 0, 1, 2, 1, 1, 2],
      loop: 2.4,
      scale: 2.5,
      lit: 0.45
    }
  }
}
const DEFAULT_PATTERN: Record<3 | 4, string> = { 3: 'orbit', 4: 'sweep' }
const MARKS: Record<3 | 4, Record<Mark, number[]>> = {
  3: { done: [2, 3, 5, 7], error: [0, 2, 4, 6, 8] },
  4: { done: [7, 8, 10, 13], error: [0, 3, 5, 6, 9, 10, 12, 15] }
}

/** 具名图案缺这一档就退回该档的默认图案 */
function resolvePattern(pattern: string | CustomPattern, grid: 3 | 4): Plan {
  if (typeof pattern === 'string') {
    return PATTERNS[pattern]?.[grid] ?? PATTERNS[DEFAULT_PATTERN[grid]][grid]
  }
  const cells = Array.from({ length: grid * grid }, (_, i) => pattern.cells[i] ?? null)
  const max = Math.max(0, ...cells.filter((v): v is number => v != null))
  return {
    cells,
    loop: pattern.loop ?? max + 4.2,
    scale: pattern.scale ?? 1,
    lit: pattern.lit ?? 0.62
  }
}

type CustomPattern = { cells: (number | null)[]; loop?: number; scale?: number; lit?: number }

/** 十分之一秒 → “12.3s” / “1m 02.3s” */
function fmt(ds: number) {
  return ds < 600 ? `${(ds / 10).toFixed(1)}s` : `${Math.floor(ds / 600)}m ${((ds % 600) / 10).toFixed(1)}s`
}
/** 同上,给读屏用,不要缩写成 m/s */
function spoken(ds: number) {
  return ds < 600
    ? `${(ds / 10).toFixed(1)} seconds`
    : `${Math.floor(ds / 600)} minutes ${((ds % 600) / 10).toFixed(1)} seconds`
}

const props = withDefaults(
  defineProps<{
    /** 工作中的动词 */
    label?: string
    /** 完成后的动词,后面跟冻结的时间 */
    doneLabel?: string
    /** 出错后的动词 */
    errorLabel?: string
    status?: 'working' | 'done' | 'error'
    pattern?: string | CustomPattern
    grid?: 3 | 4
    shape?: 'square' | 'round'
    /** 格子、动词、计时器的墨色,默认继承当前文字颜色 */
    color?: string
    doneColor?: string
    errorColor?: string
    cellSize?: number
    gap?: number
    fontSize?: number
    /** 相邻格子的点亮间隔,整圈时长随它等比缩放 */
    step?: number
    /** 暗轮廓的可见度 */
    idleOpacity?: number
    glow?: boolean
    /** 空着就用墨色 */
    glowColor?: string
    showTimer?: boolean
    /** 受控的已用秒数;给了就不再自己计时 */
    elapsed?: number
  }>(),
  {
    label: 'Thinking',
    doneLabel: 'Done in',
    errorLabel: 'Failed after',
    status: 'working',
    pattern: 'orbit',
    grid: 3,
    shape: 'round',
    color: 'currentColor',
    doneColor: '#22c55e',
    errorColor: '#ef4444',
    cellSize: 6,
    gap: 2,
    fontSize: 14,
    step: 90,
    idleOpacity: 0.15,
    glow: false,
    glowColor: '',
    showTimer: true
  }
)

const n = computed<3 | 4>(() => (props.grid === 4 ? 4 : 3))
const plan = computed(() => resolvePattern(props.pattern, n.value))
const marks = computed(() => MARKS[n.value])
const d = computed(() => props.step * plan.value.scale)
const cycle = computed(() => Math.round(plan.value.loop * d.value))
/** 标记层只按下标摆位,图案里的 null 空洞与它无关 */
const slots = computed(() => plan.value.cells.map((_, i) => i))

const vars = computed(() => ({
  '--ll-n': String(n.value),
  '--ll-cell': `${props.cellSize}px`,
  '--ll-gap': `${props.gap}px`,
  '--ll-font': `${props.fontSize}px`,
  '--ll-color': props.color,
  '--ll-mark': props.status === 'error' ? props.errorColor : props.doneColor,
  '--ll-idle': String(props.idleOpacity),
  '--ll-glow': props.glowColor || props.color,
  '--ll-mark-glow': props.glowColor || (props.status === 'error' ? props.errorColor : props.doneColor),
  '--ll-cycle': `${cycle.value}ms`
}))

/* 标记层只在非工作态可见,工作途中要记住上一次是勾还是叉 */
const lastMark = ref<Mark>('done')
const mark = computed<Mark>(() => (props.status === 'working' ? lastMark.value : props.status))
const announce = ref('')

watch(
  () => props.status,
  (s) => {
    if (s !== 'working') lastMark.value = s
    announce.value =
      s === 'working'
        ? `${props.label}, in progress`
        : `${s === 'done' ? props.doneLabel : props.errorLabel}${props.showTimer ? ` ${spoken(ds)}` : ''}`
  },
  { immediate: true }
)

const timerEl = ref<HTMLElement | null>(null)
let ds = 0
let ticker: number | undefined

function paint(v: number) {
  ds = v
  if (timerEl.value) timerEl.value.textContent = fmt(v)
}

function startClock() {
  if (ticker !== undefined) {
    clearInterval(ticker)
    ticker = undefined
  }
  if (props.elapsed != null) {
    // 受控:外部给多少就是多少,不起自己的表
    paint(Math.round(props.elapsed * 10))
    return
  }
  if (props.status !== 'working') return
  const startedAt = performance.now()
  paint(0)
  ticker = window.setInterval(() => paint(Math.floor((performance.now() - startedAt) / 100)), 100)
}

onMounted(startClock)
watch(() => [props.status, props.elapsed], startClock)
onBeforeUnmount(() => {
  if (ticker !== undefined) clearInterval(ticker)
})
</script>

<template>
  <span
    class="lattice-loader"
    role="status"
    :data-status="status"
    :data-shape="shape"
    :data-glow="glow ? '' : undefined"
    :style="vars"
  >
    <span class="lattice-loader__grid" aria-hidden="true">
      <span class="lattice-loader__layer lattice-loader__run">
        <span
          v-for="(unit, i) in plan.cells"
          :key="i"
          class="lattice-loader__cell"
          :data-hole="unit == null ? '' : undefined"
          :data-lit="plan.lit && plan.lit !== 0.62 ? Math.round(plan.lit * 100) : undefined"
          :style="unit == null ? undefined : { animationDelay: `${Math.round(unit * d)}ms` }"
        />
      </span>
      <span class="lattice-loader__layer lattice-loader__mark">
        <span
          v-for="i in slots"
          :key="i"
          class="lattice-loader__cell"
          :data-on="marks[mark].includes(i) ? '' : undefined"
        />
      </span>
    </span>
    <span class="lattice-loader__label" aria-hidden="true">
      <span class="lattice-loader__text" :data-active="status === 'working' ? '' : undefined">{{ label }}</span>
      <span class="lattice-loader__text" :data-active="status === 'done' ? '' : undefined">{{ doneLabel }}</span>
      <span class="lattice-loader__text" :data-active="status === 'error' ? '' : undefined">{{ errorLabel }}</span>
    </span>
    <span v-if="showTimer" ref="timerEl" class="lattice-loader__timer" aria-hidden="true">0.0s</span>
    <span class="lattice-loader__sr">{{ announce }}</span>
  </span>
</template>

<style scoped>
.lattice-loader {
  --ll-n: 3;
  --ll-cell: 6px;
  --ll-gap: 2px;
  --ll-font: 14px;
  --ll-color: currentColor;
  --ll-mark: #22c55e;
  --ll-idle: 0.15;
  --ll-glow: currentColor;
  --ll-mark-glow: #22c55e;
  --ll-peak: 1;
  --ll-cycle: 864ms;
  --ll-ease-out: cubic-bezier(0.23, 1, 0.32, 1);
  --ll-ease-in-out: cubic-bezier(0.77, 0, 0.175, 1);

  position: relative;
  display: inline-flex;
  align-items: center;
  gap: calc(var(--ll-font) * 0.625);
  font-family: inherit;
  font-size: var(--ll-font);
  line-height: 1;
}

.lattice-loader__grid {
  display: grid;
  flex: none;
}

.lattice-loader__layer {
  grid-area: 1 / 1;
  display: grid;
  grid-template-columns: repeat(var(--ll-n), var(--ll-cell));
  gap: var(--ll-gap);
}

.lattice-loader__cell {
  width: var(--ll-cell);
  height: var(--ll-cell);
  border-radius: max(1px, calc(var(--ll-cell) * 0.25));
  background: var(--ll-color);
  opacity: var(--ll-idle);
}

.lattice-loader[data-shape='round'] .lattice-loader__cell {
  border-radius: 50%;
}

.lattice-loader[data-glow] .lattice-loader__run .lattice-loader__cell:not([data-hole]) {
  box-shadow: 0 0 calc(var(--ll-cell) * 1.2) calc(var(--ll-cell) * 0.12) var(--ll-glow);
}

.lattice-loader[data-glow] .lattice-loader__mark .lattice-loader__cell[data-on] {
  box-shadow: 0 0 calc(var(--ll-cell) * 1.2) calc(var(--ll-cell) * 0.12) var(--ll-mark-glow);
}

.lattice-loader__run {
  transition: opacity 200ms ease;
}

.lattice-loader__run .lattice-loader__cell {
  animation: lattice-on var(--ll-cycle) var(--ll-ease-in-out) infinite;
}

.lattice-loader__run .lattice-loader__cell[data-lit='45'] {
  animation-name: lattice-on-45;
}

.lattice-loader__run .lattice-loader__cell[data-lit='35'] {
  animation-name: lattice-on-35;
}

.lattice-loader__run .lattice-loader__cell[data-lit='25'] {
  animation-name: lattice-on-25;
}

.lattice-loader__run .lattice-loader__cell[data-hole] {
  animation: none;
  opacity: calc(var(--ll-idle) * 0.47);
}

.lattice-loader__mark {
  opacity: 0;
  transform: scale(0.9);
  transform-origin: center;
  transition:
    opacity 160ms var(--ll-ease-out),
    transform 160ms var(--ll-ease-out);
}

.lattice-loader__mark .lattice-loader__cell {
  transition:
    opacity 200ms ease,
    background-color 200ms ease;
}

.lattice-loader__mark .lattice-loader__cell[data-on] {
  background: var(--ll-mark);
  opacity: var(--ll-peak);
}

.lattice-loader:not([data-status='working']) .lattice-loader__run {
  opacity: 0;
}

.lattice-loader:not([data-status='working']) .lattice-loader__run .lattice-loader__cell {
  animation-play-state: paused;
}

.lattice-loader:not([data-status='working']) .lattice-loader__mark {
  opacity: 1;
  transform: none;
  transition:
    opacity 200ms ease,
    transform 200ms var(--ll-ease-out);
}

.lattice-loader__label {
  position: relative;
  display: inline-block;
  font-weight: 500;
}

.lattice-loader__text {
  position: absolute;
  top: 0;
  left: 0;
  white-space: nowrap;
  opacity: 0;
  filter: blur(2px);
  transition:
    opacity 200ms ease,
    filter 200ms ease;
}

.lattice-loader__text[data-active] {
  position: static;
  opacity: 1;
  filter: blur(0);
}

.lattice-loader__timer {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: calc(var(--ll-font) * 0.875);
  font-variant-numeric: tabular-nums;
  opacity: 0.6;
}

.lattice-loader__sr {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  padding: 0;
  border: 0;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
}

@keyframes lattice-on {
  0%,
  100% {
    opacity: var(--ll-idle);
  }

  18%,
  42% {
    opacity: var(--ll-peak);
  }

  62% {
    opacity: var(--ll-idle);
  }
}

@keyframes lattice-on-45 {
  0%,
  100% {
    opacity: var(--ll-idle);
  }

  13%,
  31% {
    opacity: var(--ll-peak);
  }

  45% {
    opacity: var(--ll-idle);
  }
}

@keyframes lattice-on-35 {
  0%,
  100% {
    opacity: var(--ll-idle);
  }

  10%,
  24% {
    opacity: var(--ll-peak);
  }

  35% {
    opacity: var(--ll-idle);
  }
}

@keyframes lattice-on-25 {
  0%,
  100% {
    opacity: var(--ll-idle);
  }

  7%,
  17% {
    opacity: var(--ll-peak);
  }

  25% {
    opacity: var(--ll-idle);
  }
}

@media (prefers-reduced-motion: reduce) {
  .lattice-loader__run {
    --ll-peak: 0.7;
  }

  .lattice-loader__run .lattice-loader__cell {
    animation-delay: 0ms !important;
    animation-duration: 1400ms !important;
  }

  .lattice-loader .lattice-loader__mark {
    transform: none;
  }

  .lattice-loader .lattice-loader__text {
    filter: none;
  }
}
</style>
