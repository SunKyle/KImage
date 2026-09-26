<script setup lang="ts">
import { computed, ref, watch, onMounted, onBeforeUnmount } from 'vue'
import { PROVIDERS, getProvider, inferVendor } from '../api'
import type { Provider } from '../api'
import type { ApiConfig } from '../types'

/* 接口设置:独立页面。
   骨架和提示词库、历史记录一致(标题行 → 分区行 → 内容),只是内容以表单为主。
   表单改的是自己的草稿副本,不直接写父级的「当前生效配置」——
   于是「返回列表」是真的放弃修改,而不是把半成品留在生效配置里。 */

const props = defineProps<{
  configs: ApiConfig[]
  activeId: string
  mode: 'list' | 'form'
  /* 编辑/复制的来源;null 表示新增空白 */
  seed: ApiConfig | null
  /* 当前生效接口的能力说明,由父级按生效配置算好传进来。
     不在这里按草稿算:参数栏的门控跟的是生效配置,说明文字必须跟它一致 */
  capabilityNote: string
}>()

const emit = defineEmits<{
  (e: 'activate', c: ApiConfig): void
  (e: 'edit', c: ApiConfig): void
  (e: 'duplicate', c: ApiConfig): void
  (e: 'remove', c: ApiConfig): void
  (e: 'create'): void
  (e: 'cancel'): void
  (e: 'save', draft: ApiConfig): void
  (e: 'import', list: ApiConfig[]): void
}>()

const menuOpen = ref(false)
// 菜单展开后点别处收起:低频动作,不该逼用户再点一次 ⋮ 才能走
const menuEl = ref<HTMLElement | null>(null)
function onDocPointerDown(e: PointerEvent) {
  if (!menuOpen.value) return
  const t = e.target as Node | null
  if (t && menuEl.value?.contains(t)) return
  menuOpen.value = false
}
onMounted(() => document.addEventListener('pointerdown', onDocPointerDown))
onBeforeUnmount(() => document.removeEventListener('pointerdown', onDocPointerDown))

function blank(): ApiConfig {
  return { id: '', name: '', baseUrl: '', apiKey: '', model: '', vendor: 'custom' }
}

// 灌草稿:seed 一变就重置一次,编辑、复制、新增都走这里
const draft = ref<ApiConfig>(blank())
watch(
  () => props.seed,
  (v) => {
    draft.value = v ? { ...v } : blank()
  },
  { immediate: true }
)

// 选厂商:已知厂商顺带填入它的默认地址与模型;自定义只记身份,不动用户已填的内容
function applyProvider(p: Provider) {
  draft.value.vendor = p.id
  if (p.baseUrl) draft.value.baseUrl = p.baseUrl
  if (p.model) draft.value.model = p.model
}

// 表单校验:接口地址填错就完全发不出请求,所以提交前拦一下并说清原因
const urlError = ref('')
function submit() {
  const url = draft.value.baseUrl.trim()
  if (!url) {
    urlError.value = 'Enter a Base URL'
    return
  }
  let ok = false
  try {
    const u = new URL(url)
    ok = (u.protocol === 'http:' || u.protocol === 'https:') && !!u.hostname
  } catch {
    ok = false
  }
  if (!ok) {
    urlError.value = 'Must start with http:// or https://'
    return
  }
  urlError.value = ''
  emit('save', { ...draft.value, baseUrl: url })
}

// 配置行上的厂商名:老配置没写 vendor 就按域名猜,和主页面用的是同一套推断
function vendorLabel(c: ApiConfig) {
  return getProvider(c.vendor || inferVendor(c.baseUrl)).label
}

/* 模型在前、厂商在后合成一句。
   顺序有讲究:截断只会发生在末尾,所以把更重要的放前面 ——
   模型是这条配置真正发出去的东西,厂商从模型名和地址基本能看出来 */
function identLine(c: ApiConfig) {
  return [c.model, vendorLabel(c)].filter(Boolean).join(' · ')
}

/* 地址只显示主机名 + 路径:https:// 这种前缀在窄卡里最先被吃掉,
   而"这是哪个服务"靠的恰恰是后面那截。完整地址挂 title,悬停能看全 */
function endpointLine(url: string) {
  try {
    const u = new URL(url)
    return u.host + u.pathname.replace(/\/$/, '')
  } catch {
    return url
  }
}

// 选厂商时先讲清它能吃什么:界面上的参数门控就是照着这份声明来的
// 能力说明由父级传入(按当前生效接口算),不在本地按草稿算
const section = computed(() =>
  props.mode === 'form' ? (draft.value.id ? 'Edit config' : 'New config') : 'Saved configs'
)

/* 导出把配置原样写成 JSON —— 包括 API Key。
   不带 Key 的备份没有意义(换台机器导回去还是要一条条补),
   所以菜单上直接把这件事写明白,别让人以为导出的是脱敏版本 */
function exportJson() {
  menuOpen.value = false
  const blob = new Blob([JSON.stringify(props.configs, null, 2)], { type: 'application/json' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = `kimage-configs-${Date.now()}.json`
  a.click()
  // 立刻 revoke 在 WebKit 下偶尔会把下载掐断,等浏览器把文件接走再撤
  setTimeout(() => URL.revokeObjectURL(a.href), 1500)
}

// 只负责读文件:内容是不是配置由主界面规整(它才知道现有 id 有哪些)
function onImportFile(e: Event) {
  menuOpen.value = false
  const file = (e.target as HTMLInputElement).files?.[0]
  if (!file) return
  const reader = new FileReader()
  reader.onload = () => {
    try {
      const arr = JSON.parse(String(reader.result))
      if (Array.isArray(arr)) emit('import', arr)
    } catch {
      /* 选错了文件就当作没选,不打断 */
    }
  }
  reader.readAsText(file)
  ;(e.target as HTMLInputElement).value = ''
}
</script>

<template>
  <section class="pg" aria-label="API settings">
    <header class="pg-head">
      <div>
        <h1 class="pg-title">API settings</h1>
        <p class="pg-sub">Works with any OpenAI-compatible image API. Configs are stored locally.</p>
      </div>
      <div v-if="mode === 'list'" class="pg-ops">
        <button class="pg-new" @click="emit('create')">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
            <path d="M12 5v14M5 12h14" />
          </svg>
          New config
        </button>
        <!-- 导入导出低频,收进菜单,不给标题行添按钮 -->
        <span ref="menuEl" class="menu-wrap">
          <button class="icon-ghost" :aria-expanded="menuOpen" aria-label="More" @click="menuOpen = !menuOpen">
            <svg viewBox="0 0 24 24" fill="currentColor">
              <circle cx="12" cy="5.5" r="1.6" />
              <circle cx="12" cy="12" r="1.6" />
              <circle cx="12" cy="18.5" r="1.6" />
            </svg>
          </button>
          <Transition name="po">
            <div v-if="menuOpen" class="menu">
              <!-- 导出不脱敏,菜单上就写明:这是给备份/迁移用的 -->
              <button class="mitem" @click="exportJson">Export JSON (includes key)</button>
              <label class="mitem file">
                Import configs
                <input type="file" accept=".json" hidden @change="onImportFile" />
              </label>
            </div>
          </Transition>
        </span>
      </div>
    </header>

    <!-- 分区行:列表显示条数,表单显示当前在新增还是编辑,并给一条回程 -->
    <div class="pg-bar">
      <span class="pg-label">
        {{ section }}<template v-if="mode === 'list'"> · {{ configs.length }}</template>
      </span>
      <button v-if="mode === 'form'" class="pg-back" @click="emit('cancel')">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M15 6l-6 6 6 6" />
        </svg>
        Back to list
      </button>
    </div>

    <!-- 内容收在 640px 一列:设置页是表单,铺满 1080 会读得很散 -->
    <div class="pg-wrap">
      <!-- ===== 视图一:已保存的接口列表 ===== -->
      <template v-if="mode === 'list'">
        <ul v-if="configs.length" class="cfg-grid">
          <li v-for="c in configs" :key="c.id" class="cfg-card" :class="{ on: c.id === activeId }">
            <!-- 主体点击 = 切为当前生效。操作按钮不能塞进来(按钮不能嵌套),所以是兄弟节点,
                 靠绝对定位落在右上角,顺带省掉了一整行高度 -->
            <button class="cfg-main" @click="emit('activate', c)">
              <span class="cfg-head">
                <span class="cfg-name">{{ c.name || 'Untitled config' }}</span>
                <span v-if="c.id === activeId" class="cfg-active">Current</span>
              </span>
              <span class="cfg-ident">{{ identLine(c) }}</span>
              <span class="cfg-url" :title="c.baseUrl">{{ endpointLine(c.baseUrl) }}</span>
            </button>
            <div class="cfg-ops">
              <button class="cfg-op" :aria-label="`Edit: ${c.name || 'Untitled config'}`" @click="emit('edit', c)">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M12 20h9" />
                  <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
                </svg>
              </button>
              <button class="cfg-op" :aria-label="`Duplicate: ${c.name || 'Untitled config'}`" @click="emit('duplicate', c)">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                  <rect x="9" y="9" width="11" height="11" rx="2" />
                  <path d="M5 15V6a1 1 0 0 1 1-1h9" />
                </svg>
              </button>
              <button class="cfg-op danger" :aria-label="`Delete: ${c.name || 'Untitled config'}`" @click="emit('remove', c)">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6 7l1 12a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-12" />
                </svg>
              </button>
            </div>
          </li>
        </ul>

        <div v-else class="pg-none">
          <div class="none-ico" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
              <path d="M12 22v-5M9 8V2M15 8V2" />
              <path d="M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z" />
            </svg>
          </div>
          <h2 class="none-title">No configs yet</h2>
          <p class="none-sub">Works with any OpenAI-compatible image API. Configs stay local and are never uploaded.</p>
          <button class="none-action" @click="emit('create')">New config</button>
        </div>
      </template>

      <!-- ===== 视图二:新增/编辑接口表单 ===== -->
      <form v-else class="cfg-form" @submit.prevent="submit">
        <div class="presets" role="group" aria-label="Select provider">
          <span class="pg-label">Provider</span>
          <button
            v-for="p in PROVIDERS"
            :key="p.id"
            type="button"
            class="preset"
            :class="{ on: (draft.vendor || 'custom') === p.id }"
            @click="applyProvider(p)"
          >
            {{ p.label }}
          </button>
        </div>
        <p class="vendor-note">{{ capabilityNote }}</p>

        <label class="field">
          <span class="flabel">Name</span>
          <input v-model="draft.name" placeholder="e.g. Doubao primary / Tongyi backup" spellcheck="false" />
        </label>
        <label class="field" :class="{ 'has-err': urlError }">
          <span class="flabel">Base URL</span>
          <input
            v-model="draft.baseUrl"
            placeholder="https://example.com/api/v3"
            spellcheck="false"
            @input="urlError = ''"
          />
          <span v-if="urlError" class="field-err">{{ urlError }}</span>
        </label>
        <label class="field">
          <span class="flabel">API Key</span>
          <input
            v-model="draft.apiKey"
            type="password"
            autocomplete="off"
            placeholder="sk-…  (optional for local services)"
          />
        </label>
        <label class="field">
          <span class="flabel">Model name</span>
          <input v-model="draft.model" placeholder="doubao-seedream-3-0-t2i" spellcheck="false" />
        </label>

        <div class="form-foot">
          <button class="save-btn" type="submit">Save</button>
        </div>
      </form>
    </div>
  </section>
</template>

<style scoped>
/* 页面骨架:与提示词库、历史记录同一套规格 */
.pg-head {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  justify-content: space-between;
  gap: var(--sp-4);
  padding-top: var(--sp-2);
}
.pg-title {
  font-family: var(--font-display);
  font-size: 28px;
  font-weight: 700;
  letter-spacing: -0.02em;
}
.pg-sub {
  margin-top: 6px;
  font-size: 13px;
  color: var(--text-2);
}
/* 与提示词库的「New prompt」同款:黑药丸,标题行主操作 */
.pg-new {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 34px;
  padding: 0 14px;
  border-radius: 999px;
  background: var(--cta);
  color: var(--cta-text);
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  transition: background var(--dur) var(--ease);
}
.pg-new svg {
  width: 16px;
  height: 16px;
}
.pg-new:hover {
  background: var(--cta-hover);
}
.pg-ops {
  display: flex;
  align-items: center;
  gap: 8px;
}
/* 标题行上的次要动作:和提示词库的 ⋮ 按钮同一套 */
.icon-ghost {
  width: 34px;
  height: 34px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--line);
  border-radius: 999px;
  color: var(--text-2);
  background: var(--surface);
  cursor: pointer;
  transition: color var(--dur) var(--ease), border-color var(--dur) var(--ease),
    background var(--dur) var(--ease);
}
.icon-ghost svg {
  width: 15px;
  height: 15px;
}
.icon-ghost:hover {
  color: var(--text);
  border-color: var(--line-strong);
  background: var(--bg-elev);
}
/* 导入导出低频,收进菜单,不给标题行添按钮 */
.menu-wrap {
  position: relative;
  display: inline-flex;
}
.menu {
  position: absolute;
  top: calc(100% + 6px);
  right: 0;
  z-index: 6;
  /* 比提示词库那个略宽:这一项要把「含 Key」写进去 */
  min-width: 172px;
  padding: 4px;
  display: flex;
  flex-direction: column;
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: var(--r-sm);
  box-shadow: var(--sh-md);
}
.mitem {
  padding: 8px 10px;
  text-align: left;
  font-size: 13px;
  color: var(--text-2);
  border-radius: 6px;
  cursor: pointer;
  transition: background var(--dur) var(--ease), color var(--dur) var(--ease);
}
.mitem:hover {
  background: var(--bg-elev);
  color: var(--text);
}
.file {
  display: block;
}
.po-enter-active,
.po-leave-active {
  transition: opacity 140ms var(--ease), transform 140ms var(--ease);
}
.po-enter-from,
.po-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}
.pg-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-3);
  margin-top: var(--sp-5);
  padding-bottom: var(--sp-4);
  border-bottom: 1px solid var(--line);
}
.pg-label {
  font-size: 12px;
  color: var(--text-2);
}
.pg-back {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 28px;
  padding: 0 10px 0 6px;
  border-radius: 999px;
  border: 1px solid var(--line);
  background: none;
  color: var(--text-2);
  font-size: 12px;
  cursor: pointer;
  transition: border-color var(--dur) var(--ease), color var(--dur) var(--ease),
    background var(--dur) var(--ease);
}
.pg-back svg {
  width: 15px;
  height: 15px;
}
.pg-back:hover {
  border-color: color-mix(in oklch, var(--accent) 45%, var(--line));
  background: var(--accent-soft);
  color: var(--accent-strong);
}
.pg-wrap {
  max-width: 640px;
  margin-top: var(--sp-5);
}

/* —— 接口卡片 ——
   和提示词库、历史图墙同一套观感:定宽多列,列数由容器宽度自己算 */
.cfg-grid {
  list-style: none;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
  gap: var(--sp-3);
}
.cfg-card {
  /* 操作的定位锚点(见 .cfg-ops) */
  position: relative;
  display: flex;
  flex-direction: column;
  border: 1px solid var(--line);
  border-radius: var(--r);
  background: var(--surface);
  transition: border-color var(--dur) var(--ease), background var(--dur) var(--ease),
    box-shadow var(--dur) var(--ease);
}
.cfg-card:hover {
  border-color: var(--line-strong);
}
/* 当前生效的那条:用强调色描边 + 淡底,一眼看出生成走的是谁 */
.cfg-card.on {
  border-color: color-mix(in oklch, var(--accent) 45%, var(--line));
  background: var(--accent-soft);
  box-shadow: 0 6px 18px -10px color-mix(in oklch, var(--accent) 60%, transparent);
}
/* 主体是整块可点区域;按钮不能嵌套,所以操作按钮是它的兄弟节点,
   靠绝对定位落在右上角 —— 顺带省掉了原本垫在最下面的那一行高度 */
.cfg-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 5px;
  padding: 13px 14px 14px;
  border: none;
  background: none;
  color: var(--text);
  text-align: left;
  cursor: pointer;
}
.cfg-main:hover .cfg-name {
  color: var(--accent);
}
.cfg-head {
  display: flex;
  align-items: center;
  gap: 8px;
  /* 至少和右上角那三个按钮一样高:这样它们只压住第一行,
     下面两行(模型/地址)不会被盖住,也就不用跟着留白 */
  min-height: 28px;
  min-width: 0;
  /* 给右上角的操作让位:名字再长也不会钻到按钮底下 */
  padding-right: 100px;
}
.cfg-name {
  min-width: 0;
  font-size: 15px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  transition: color var(--dur) var(--ease);
}
/* 模型 · 厂商:比名字轻、比地址重,夹在中间。
   厂商不再用描边胶囊 —— 提示词库的卡片也把胶囊去掉了,两处保持一致 */
.cfg-ident {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12.5px;
  color: var(--text-2);
}
/* 地址单独占一行:它是这张卡里最长的字段,和别的挤一行只会被截得更短 */
.cfg-url {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  color: var(--text-2);
}
.cfg-active {
  flex-shrink: 0;
  /* 靠右:名字被截断时标记也还在右边，不会跟着内容跑 */
  margin-left: auto;
  padding: 2px 8px;
  font-size: 11px;
  border-radius: 999px;
  color: var(--accent-strong);
  background: color-mix(in oklch, var(--accent) 14%, transparent);
  border: 1px solid color-mix(in oklch, var(--accent) 30%, transparent);
}
/* 操作压在右上角:DOM 上排在主体之后且带定位,所以点击落在按钮上、
   不会穿透到下面那层"切为当前" */
.cfg-ops {
  position: absolute;
  top: 12px;
  right: 12px;
  display: flex;
  gap: 4px;
}
.cfg-op {
  width: 28px;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--line);
  border-radius: var(--r-sm);
  background: none;
  color: var(--text-2);
  cursor: pointer;
  transition: border-color var(--dur) var(--ease), color var(--dur) var(--ease),
    background var(--dur) var(--ease);
}
.cfg-op svg {
  width: 15px;
  height: 15px;
}
.cfg-op:hover {
  border-color: color-mix(in oklch, var(--accent) 45%, var(--line));
  background: var(--accent-soft);
  color: var(--accent-strong);
}
.cfg-op.danger:hover {
  border-color: var(--danger);
  background: none;
  color: var(--danger);
}

/* —— 表单 —— */
.presets {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--sp-2);
  margin-bottom: var(--sp-2);
}
.preset {
  padding: 6px 12px;
  font-size: 13px;
  border: 1px solid var(--line);
  border-radius: 999px;
  color: var(--text-2);
  background: var(--surface);
  cursor: pointer;
  transition: border-color var(--dur) var(--ease), color var(--dur) var(--ease),
    background var(--dur) var(--ease);
}
.preset:hover {
  border-color: var(--accent);
  color: var(--accent);
}
.preset.on {
  background: var(--accent-soft);
  border-color: var(--accent);
  color: var(--accent-strong);
}
/* 厂商能力说明:紧贴在厂商按钮下方,说明界面为何只露出这些参数 */
.vendor-note {
  margin: 0 0 var(--sp-5);
  font-size: 12px;
  line-height: 1.6;
  color: var(--text-2);
}
.field {
  display: block;
  margin-top: var(--sp-4);
}
.flabel {
  display: block;
  margin-bottom: 6px;
  font-size: 13px;
  color: var(--text-2);
}
.field input {
  width: 100%;
  padding: 11px 14px;
  border: 1px solid var(--line);
  border-radius: var(--r-sm);
  background: var(--surface);
  font-size: 14px;
  transition: border-color var(--dur) var(--ease), box-shadow var(--dur) var(--ease);
}
.field input:focus {
  border-color: var(--accent);
  box-shadow: 0 6px 22px -8px color-mix(in oklch, var(--accent) 40%, transparent);
}
.field.has-err input {
  border-color: var(--danger);
}
.field-err {
  display: block;
  margin-top: 6px;
  font-size: 12px;
  color: var(--danger);
}
.form-foot {
  margin-top: var(--sp-6);
}
.save-btn {
  padding: 10px 20px;
  border-radius: var(--r-sm);
  border: none;
  background: var(--accent);
  color: var(--accent-contrast);
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  transition: background var(--dur) var(--ease);
}
.save-btn:hover {
  background: var(--accent-strong);
}

/* —— 空态 —— */
.pg-none {
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

/* 窄屏:输入框提到 16px,防止 iOS Safari 聚焦时放大整页。
   字段行本就是 label 独占一行 + input 宽度 100% 的上下堆叠,无需改动 */
@media (max-width: 640px) {
  .field input {
    font-size: 16px;
  }
}
</style>
