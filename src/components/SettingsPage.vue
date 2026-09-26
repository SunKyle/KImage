<script setup lang="ts">
import { computed, ref, watch, onMounted, onBeforeUnmount } from 'vue'
import {
  PhPlus,
  PhDotsThreeVertical,
  PhCaretRight,
  PhCheck,
  PhEye,
  PhEyeSlash
} from '@phosphor-icons/vue'
import { PROVIDERS, TEXT_PROVIDERS, getProvider, inferVendor } from '../api'
import type { Provider, TextProvider } from '../api'
import type { ApiConfig } from '../types'

/* 接口设置:独立页面。
   骨架和提示词库、历史记录一致(标题行 → 内容),只是内容以表单为主。
   表单改的是自己的草稿副本,不直接写父级的「当前生效配置」——
   于是「返回列表」是真的放弃修改,而不是把半成品留在生效配置里。 */

const props = defineProps<{
  configs: ApiConfig[]
  /* 出图类别里当前生效那条的 id */
  activeId: string
  /* 提示词增强类别里当前生效那条的 id。与 activeId 各自独立:
     两类配置同在一个列表里,但「当前」是分开记的 */
  activeTextId: string
  mode: 'list' | 'form'
  /* 编辑/复制的来源;null 表示新增空白 */
  seed: ApiConfig | null
  /* 当前生效接口的能力说明,由父级按生效配置算好传进来。
     不在这里按草稿算:参数栏的门控跟的是生效配置,说明文字必须跟它一致 */
  capabilityNote: string
}>()

const emit = defineEmits<{
  (e: 'activate', c: ApiConfig): void
  (e: 'activateText', c: ApiConfig): void
  (e: 'edit', c: ApiConfig): void
  (e: 'duplicate', c: ApiConfig): void
  (e: 'remove', c: ApiConfig): void
  /* seed 可选:空态里点某家厂商时带一份预填好的配置,标题行的「New config」不带 */
  (e: 'create', seed?: ApiConfig): void
  (e: 'cancel'): void
  (e: 'save', draft: ApiConfig): void
  (e: 'import', list: ApiConfig[]): void
}>()

/* 标题行那个导出/导入菜单的开关。和下面的行菜单是两件事:
   它不挂在某一行上,所以仍是一个布尔 */
const menuOpen = ref(false)
// 菜单展开后点别处收起:低频动作,不该逼用户再点一次 ⋮ 才能走
const menuEl = ref<HTMLElement | null>(null)

/* 行的溢出菜单:记住是哪一行开着,而不是一个布尔 ——
   列表里有很多行,一个布尔表达不了「这个菜单是给谁的」。
   同一时刻只开一个,切换行时旧的自动让位 */
const openRow = ref<string | null>(null)
/* 删除的二次确认:记着哪一行已经点过第一次。
   删除不可撤销,而菜单里手滑点一下的概率并不低,所以进危险态再问一次。
   不用弹窗:这个项目的语言里没有 modal */
const confirmId = ref<string | null>(null)

// 密钥显隐:默认遮住。声明在灌草稿的 watch 之前 —— 那个 watch 是 immediate,会立刻用到它
const showKey = ref(false)

function onDocPointerDown(e: PointerEvent) {
  const t = e.target as (Element & Node) | null
  if (menuOpen.value && !(t && menuEl.value?.contains(t))) menuOpen.value = false
  /* 行的菜单:点在菜单里、或点在触发它的 ⋮ 上都不收 —— 后者由那个按钮自己的点击去切换。
     这里按祖先类名判而不是拿一个 ref 存元素:菜单是随行渲染的,
     一个 ref 装不住多行,而类名判断天然只看当前这一棵子树 */
  if (openRow.value && !(t instanceof Element && t.closest('.row-menu, .row-more'))) {
    openRow.value = null
    confirmId.value = null
  }
}
onMounted(() => document.addEventListener('pointerdown', onDocPointerDown))
onBeforeUnmount(() => document.removeEventListener('pointerdown', onDocPointerDown))

// 开/收某一行的菜单。顺手清掉删除确认态 —— 换了行就不该还停在上一次的「再点一次」上
function toggleRow(id: string) {
  confirmId.value = null
  openRow.value = openRow.value === id ? null : id
}

/* 删除:第一次只是把这一项变成危险态,第二次才真的删。
   菜单本身不收起,用户能看到那一行字变了,才知道「第一次点生效了」 */
function askRemove(c: ApiConfig) {
  if (confirmId.value !== c.id) {
    confirmId.value = c.id
    return
  }
  confirmId.value = null
  openRow.value = null
  emit('remove', c)
}

// 换视图(列表 ↔ 表单)时收起行菜单:回到列表不该还开着上次那个菜单
watch(
  () => props.mode,
  () => {
    openRow.value = null
    confirmId.value = null
  }
)

function blank(): ApiConfig {
  // 新增默认做出图:绝大多数人的第一诉求是出图,文本配置是后来才补的
  return { id: '', name: '', baseUrl: '', apiKey: '', model: '', vendor: 'custom', kind: 'image' }
}

// 灌草稿:seed 一变就重置一次,编辑、复制、新增都走这里
const draft = ref<ApiConfig>(blank())
watch(
  () => props.seed,
  (v) => {
    draft.value = v ? { ...v } : blank()
    // 换一条配置就把密钥收回去:上一条的显隐状态不该被带过来
    showKey.value = false
  },
  { immediate: true }
)

// 草稿当前用途:老配置没有 kind 时按出图算
const isText = computed(() => (draft.value.kind || 'image') === 'text')

/* 切换用途:只切 kind 并换掉下面的预设行。
   已填的 baseUrl / apiKey 保留 —— 地址与密钥常常同源,用户可能刚填好,不该被清掉;
   但 model 一定要清空:图像模型名拿去打 /chat/completions 必错,反过来也一样,
   留着只会让人以为还能用。 */
function setPurpose(kind: 'image' | 'text') {
  if (draft.value.kind === kind) return
  draft.value.kind = kind
  draft.value.model = ''
}

/* 预设只补地址与推荐模型,密钥一律不动 —— 换一家预设不该把已填的 key 冲掉。
   与下面的 applyProvider 同一套规矩。 */
function applyTextProvider(p: TextProvider) {
  draft.value.baseUrl = p.baseUrl
  if (p.model) draft.value.model = p.model
}

/* 高亮当前地址命中哪个预设:草稿里没有 vendor 字段,直接比地址,
   省得为了高亮再存一个状态。尾斜杠与大小写不该影响判断 */
function textPresetOn(p: TextProvider) {
  const norm = (u: string) => (u || '').trim().replace(/\/+$/, '').toLowerCase()
  return norm(draft.value.baseUrl) === norm(p.baseUrl)
}

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
    // 只说「必填」用户还是不知道填什么,所以原因和建议一起给
    urlError.value = 'No Base URL yet — paste the endpoint your provider gave you, e.g. https://api.openai.com/v1'
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
    urlError.value = 'This is not a valid http(s) URL — it must start with http:// or https://'
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

/* 地址只显示主机名 + 路径:https:// 这种前缀在窄行里最先被吃掉,
   而"这是哪个服务"靠的恰恰是后面那截。
   空态的入口也复用它渲染"会替你填好什么" */
function endpointLine(url: string) {
  try {
    const u = new URL(url)
    return u.host + u.pathname.replace(/\/$/, '')
  } catch {
    return url
  }
}

/* 列表按用途分两组渲染:两组各自判「当前」(出图比 activeId,文本比 activeTextId),
   所以把组连同判据一起列成数据,模板里只写一份行。空组直接滤掉,不渲染 */
const groups = computed(() =>
  [
    {
      key: 'image',
      label: 'Image generation',
      items: props.configs.filter((c) => c.kind !== 'text'),
      activeId: props.activeId
    },
    {
      key: 'text',
      label: 'Prompt enhancing',
      items: props.configs.filter((c) => c.kind === 'text'),
      activeId: props.activeTextId
    }
  ].filter((g) => g.items.length)
)

// 表单标题:新增还是编辑,保持英文文案
const section = computed(() => (draft.value.id ? 'Edit config' : 'New config'))

/* 空态的四条入口:前三条从厂商表里取(跳过兜底的 custom)。
   地址、模型、名称全部由它推导 —— 厂商表改地址时这里不会漏掉,
   也不该在界面里再抄一份地址 */
const quickPicks = PROVIDERS.filter((p) => p.id !== 'custom').slice(0, 3)

// 点某家厂商 = 开一张已经填好的表单,只差一个 key。id 留空,由父级落库时再生成
function seedFor(p: Provider): ApiConfig {
  return {
    id: '',
    name: p.label,
    baseUrl: p.baseUrl,
    model: p.model,
    apiKey: '',
    vendor: p.id,
    kind: 'image'
  }
}

// 入口副标题:会替你填好的地址与模型
function quickHint(p: Provider) {
  return `Fills ${endpointLine(p.baseUrl)} · ${p.model}`
}

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
        <p class="pg-sub">Works with any OpenAI-compatible API. Configs are stored locally and never uploaded.</p>
      </div>
      <div v-if="mode === 'list'" class="pg-ops">
        <button class="pg-new" @click="emit('create')">
          <PhPlus aria-hidden="true" />
          New config
        </button>
        <!-- 导入导出低频,收进菜单,不给标题行添按钮 -->
        <span ref="menuEl" class="menu-wrap">
          <button class="icon-ghost" :aria-expanded="menuOpen" aria-label="More" @click="menuOpen = !menuOpen">
            <PhDotsThreeVertical weight="bold" aria-hidden="true" />
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

    <!-- 内容收在 640px 一列:设置页是表单,铺满 1080 会读得很散 -->
    <div class="pg-wrap">
      <!-- ===== 视图一:已保存的接口列表 ===== -->
      <template v-if="mode === 'list'">
        <!-- 一整张纸包住所有分组:主页的容器语言是「浮在纸上的柔光」,
             不再是一格一格的卡片。分组只用一条两端留空的细线分开。
             纸不设 overflow: hidden —— 行内的溢出菜单要能浮到纸外 -->
        <div v-if="groups.length" class="sheet">
          <div class="list">
            <div v-for="g in groups" :key="g.key" class="group">
              <div class="group-label"><b>{{ g.label }}</b> · {{ g.items.length }}</div>

              <div
                v-for="c in g.items"
                :key="c.id"
                class="row"
                :class="{ 'is-current': c.id === g.activeId, 'is-open': openRow === c.id }"
              >
                <!-- 行本体是 <button>:整行可点 = 把这条设为该类别的当前生效
                     (出图走 activate,文本走 activateText)。
                     状态列定宽,于是所有行的名字都从同一条竖线起排 -->
                <button
                  class="row-main-btn"
                  :aria-current="c.id === g.activeId ? 'true' : undefined"
                  @click="g.key === 'text' ? emit('activateText', c) : emit('activate', c)"
                >
                  <span class="dot-col">
                    <span v-if="c.id === g.activeId" class="pill-current"><i aria-hidden="true"></i>Current</span>
                  </span>
                  <span class="row-main">
                    <span class="row-name">{{ c.name || 'Untitled config' }}</span>
                    <!-- 地址不再出现在列表里:编辑表单里本来就有完整地址 -->
                    <span class="row-sub">{{ identLine(c) }}</span>
                  </span>
                </button>

                <!-- 常态隐去,行 hover / 聚焦时显形 ——
                     三个常驻的方形图标键正是「管理后台」味道的来源 -->
                <button
                  class="row-more"
                  :aria-label="`Actions for ${c.name || 'Untitled config'}`"
                  aria-haspopup="menu"
                  :aria-expanded="openRow === c.id"
                  @click="toggleRow(c.id)"
                >
                  <PhDotsThreeVertical weight="bold" aria-hidden="true" />
                </button>

                <Transition name="po">
                  <!-- 用 role=group 而不是 menu:menu 在 ARIA 里承诺方向键导航,
                       这里只有 Tab,声明成 menu 等于许了做不到的事 -->
                  <div
                    v-if="openRow === c.id"
                    class="row-menu"
                    role="group"
                    :aria-label="`Actions for ${c.name || 'Untitled config'}`"
                  >
                    <button class="mitem" @click="openRow = null; emit('edit', c)">Edit</button>
                    <button class="mitem" @click="openRow = null; emit('duplicate', c)">
                      Duplicate
                    </button>
                    <!-- 第一次点只是进危险态,第二次才真的删:删除不可撤销 -->
                    <button
                      class="mitem danger"
                      :class="{ confirm: confirmId === c.id }"
                      @click="askRemove(c)"
                    >
                      {{ confirmId === c.id ? 'Click again to delete' : 'Delete' }}
                    </button>
                  </div>
                </Transition>
              </div>
            </div>
          </div>
        </div>

        <!-- 空态:不是「什么都没有」,而是四条能一键预填的入口 -->
        <div v-else class="sheet">
          <div class="empty">
            <h2>Add your first API</h2>
            <p class="empty-sub">
              Pick a provider and the address and model get filled in for you. You only need to paste your key.
            </p>

            <div class="quick">
              <button
                v-for="p in quickPicks"
                :key="p.id"
                class="quick-item"
                @click="emit('create', seedFor(p))"
              >
                <span class="qm">
                  <b>{{ p.label }}</b>
                  <span>{{ quickHint(p) }}</span>
                </span>
                <span class="go"><PhCaretRight aria-hidden="true" /></span>
              </button>
              <button class="quick-item" @click="emit('create')">
                <span class="qm">
                  <b>My own endpoint</b>
                  <span>Any OpenAI-compatible base URL</span>
                </span>
                <span class="go"><PhCaretRight aria-hidden="true" /></span>
              </button>
            </div>

            <p class="empty-foot">Your key stays in this browser. Nothing is sent anywhere except your own API.</p>
          </div>
        </div>
      </template>

      <!-- ===== 视图二:新增/编辑接口表单 ===== -->
      <form v-else class="sheet" @submit.prevent="submit">
        <div class="form-head">
          <h2>{{ section }}</h2>
          <p>Only Base URL is required. Everything else can stay as the preset filled it.</p>
        </div>

        <div class="form-body">
          <div class="block">
            <!-- 用途:这条配置用来出图还是改写提示词。它决定后面所有字段的含义,
                 所以给两行带说明的选项,而不是一排只有名字的胶囊 -->
            <span class="block-label">What is this config for?</span>
            <div class="purpose" role="radiogroup" aria-label="Config purpose">
              <label class="purpose-opt">
                <input type="radio" name="purpose" :checked="!isText" @change="setPurpose('image')" />
                <span class="pm">
                  <b>Image generation</b>
                  <span>Used when you press Generate. Fill in an image model.</span>
                </span>
                <span class="tick" aria-hidden="true"><PhCheck /></span>
              </label>
              <label class="purpose-opt">
                <input type="radio" name="purpose" :checked="isText" @change="setPurpose('text')" />
                <span class="pm">
                  <b>Prompt enhancing</b>
                  <span>Used by Quick / Creative. Fill in a chat model.</span>
                </span>
                <span class="tick" aria-hidden="true"><PhCheck /></span>
              </label>
            </div>
          </div>

          <div class="block">
            <span class="block-label">Provider</span>
            <!-- 预设随用途切换数据源:出图用图像模型预设,文本用对话模型预设 -->
            <div class="presets" role="group" aria-label="Select provider">
              <template v-if="!isText">
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
              </template>
              <template v-else>
                <button
                  v-for="p in TEXT_PROVIDERS"
                  :key="p.id"
                  type="button"
                  class="preset"
                  :class="{ on: textPresetOn(p) }"
                  @click="applyTextProvider(p)"
                >
                  {{ p.label }}
                </button>
              </template>
            </div>
            <p class="note">
              {{
                isText
                  ? 'Text models are called through /chat/completions. For Bailian, pick the compatible-mode address.'
                  : capabilityNote
              }}
            </p>

            <label class="field">
              <span class="flabel">Name <em>— optional</em></span>
              <span class="input-wrap">
                <input
                  v-model="draft.name"
                  placeholder="e.g. Doubao primary / Tongyi backup"
                  spellcheck="false"
                />
              </span>
            </label>

            <label class="field" :class="{ 'has-err': urlError }">
              <span class="flabel">Base URL</span>
              <span class="input-wrap">
                <input
                  v-model="draft.baseUrl"
                  placeholder="https://example.com/api/v3"
                  spellcheck="false"
                  @input="urlError = ''"
                />
              </span>
              <!-- 报错顶掉说明行,不叠成两段小字:错误已经把该填什么说清楚了 -->
              <span v-if="urlError" class="field-err">{{ urlError }}</span>
              <span v-else class="note">
                Include everything up to and including the version segment, e.g. <code>/api/v3</code>. No trailing
                slash needed.
              </span>
            </label>

            <label class="field field-key">
              <span class="flabel">API Key</span>
              <span class="input-wrap">
                <input
                  v-model="draft.apiKey"
                  :type="showKey ? 'text' : 'password'"
                  autocomplete="off"
                  placeholder="sk-…  (optional for local services)"
                />
                <button
                  type="button"
                  class="reveal"
                  :aria-label="showKey ? 'Hide key' : 'Show key'"
                  :aria-pressed="showKey"
                  @click="showKey = !showKey"
                >
                  <PhEyeSlash v-if="showKey" aria-hidden="true" />
                  <PhEye v-else aria-hidden="true" />
                </button>
              </span>
              <span class="note">Stored in this browser only. Check your provider's console for where to create one.</span>
            </label>

            <label class="field">
              <span class="flabel">Model</span>
              <span class="input-wrap">
                <input
                  v-model="draft.model"
                  :placeholder="isText ? 'gpt-4o-mini' : 'doubao-seedream-3-0-t2i'"
                  spellcheck="false"
                />
              </span>
              <span class="note">
                The model ID your API expects — for some providers this is an endpoint ID like <code>ep-2024…</code>.
              </span>
            </label>
          </div>

          <div class="form-foot">
            <button class="btn-ink" type="submit">Save</button>
            <button class="btn-line" type="button" @click="emit('cancel')">Cancel</button>
            <span class="hint">Saved configs appear on the home page in one click.</span>
          </div>
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
  font-family: var(--font-sans);
  font-size: var(--fs-3xl);
  font-weight: 700;
  letter-spacing: var(--ls-tight);
}
.pg-sub {
  margin-top: 6px;
  font-size: var(--fs-sm);
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
  font-size: var(--fs-sm);
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
  padding: var(--sp-1);
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
  font-size: var(--fs-sm);
  color: var(--text-2);
  border-radius: 6px;
  cursor: pointer;
  transition: background var(--dur) var(--ease), color var(--dur) var(--ease);
}
.mitem:hover {
  background: var(--bg-elev);
  color: var(--text);
}
/* 行菜单里的删除:中性色里唯一的红,和编辑/复制区分开 */
.mitem.danger {
  color: var(--danger);
}
/* 已点过一次的删除:底色也铺上红,否则用户以为第一次点没生效 */
.mitem.danger.confirm {
  background: color-mix(in oklch, var(--danger) 12%, transparent);
  font-weight: 500;
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
.pg-wrap {
  max-width: 640px;
  margin-top: var(--sp-5);
}

/* —— 一张纸,不是一组卡片 ——
   主页的容器语言是「浮在纸上的柔光」:大圆角 + 弥散投影。
   原来那种 16px 方角 + 1px 描边的卡片网格是另一套语言。
   刻意不设 overflow: hidden —— 行内的溢出菜单要能浮到纸外 */
.sheet {
  border-radius: var(--r-lg);
  background: var(--surface);
  box-shadow: var(--sh-float);
}
.list {
  padding: var(--sp-2);
}
/* 分组:一个小标签 + 一条细线,不做卡片 */
.group-label {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: var(--sp-1) var(--sp-3) 10px;
  font-size: var(--fs-xs);
  color: var(--text-3);
}
.group-label b {
  font-weight: 500;
  color: var(--text-2);
}
.group + .group {
  position: relative;
  margin-top: var(--sp-1);
  padding-top: 14px;
}
/* 分组分隔线两端各留 12px:一条横贯整张纸的线会把纸切成两半,
   和主页那种「有呼吸感」的分隔语言不搭 */
.group + .group::before {
  content: '';
  position: absolute;
  top: 0;
  left: var(--sp-3);
  right: var(--sp-3);
  height: 1px;
  background: var(--line);
}

/* —— 行 ——
   三段:状态列(定宽) / 主体 / 溢出菜单(仅 hover 与键盘聚焦时出现)。
   行本体是 <button>,所以整行可点又天然可 Tab 到;
   ⋮ 是它的兄弟节点(按钮不能嵌套),靠 flex 排在最后 */
.row {
  position: relative;
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  padding: 11px 12px;
  border-radius: var(--r-sm);
  transition: background var(--dur) var(--ease);
}
.row:hover,
.row:focus-within,
.row.is-open {
  background: var(--bg-elev);
}
.row-main-btn {
  flex: 1;
  min-width: 0;
  display: grid;
  grid-template-columns: 68px 1fr;
  align-items: center;
  gap: var(--sp-3);
}
/* 状态列:定宽 + 左对齐,于是所有行的名字都从同一条竖线起排。
   当前生效那条在这一列放一个墨色实心药丸,其余留空 ——
   「现在走的是哪条」不用读名字就能扫到 */
.dot-col {
  display: flex;
  align-items: center;
}
.pill-current {
  display: inline-flex;
  align-items: center;
  gap: var(--sp-1);
  padding: 2px 8px 2px 7px;
  border-radius: 999px;
  background: var(--cta);
  color: var(--cta-text);
  font-size: var(--fs-micro);
  font-weight: 500;
  white-space: nowrap;
}
.pill-current i {
  width: 5px;
  height: 5px;
  border-radius: 999px;
  background: currentColor;
  opacity: 0.55;
}
.row-main {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.row-name {
  font-size: var(--fs-md);
  font-weight: 600;
  color: var(--text-2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  transition: color var(--dur) var(--ease);
}
/* 当前那条用正文色,其余退一档:靠字色而不是整行铺色块表达「最实」 */
.row.is-current .row-name {
  color: var(--text);
}
/* 模型 · 厂商:比名字轻、比正文轻,地址不再出现在列表里 */
.row-sub {
  font-size: var(--fs-xs);
  color: var(--text-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.row-more {
  flex-shrink: 0;
  width: 32px;
  height: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 999px;
  color: var(--text-3);
  /* 常态隐去:三个常驻图标键正是「管理后台」的味道。
     用 opacity 而不是 display —— 键盘 Tab 仍能聚焦,聚焦后自动显形 */
  opacity: 0;
  transition: opacity var(--dur) var(--ease), color var(--dur) var(--ease),
    background var(--dur) var(--ease);
}
.row:hover .row-more,
.row:focus-within .row-more,
.row.is-open .row-more,
.row-more:focus-visible {
  opacity: 1;
}
.row-more:hover {
  color: var(--text);
  background: var(--surface);
}
/* 触屏没有 hover:⋮ 会一直隐形,行菜单就点不到。
   这类设备上让它常驻 —— 常驻一个 32px 的圆键,比"三个方形图标键"轻得多 */
@media (hover: none) {
  .row-more {
    opacity: 1;
  }
}
.row-more svg {
  width: 16px;
  height: 16px;
}
/* 菜单挂在行上(行是定位锚点),浮到纸外也不被裁 —— 纸本身没有 overflow: hidden。
   祖先链(.shell / .frame / .page-in / .pg)也都没有裁剪容器 */
.row-menu {
  position: absolute;
  top: calc(100% - 6px);
  right: 6px;
  z-index: 5;
  min-width: 168px;
  padding: var(--sp-1);
  display: flex;
  flex-direction: column;
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: var(--r-sm);
  box-shadow: var(--sh-float);
}

/* —— 空态 ——
   不再是「什么都没有」,而是能一键预填的入口 */
.empty {
  padding: var(--sp-6) var(--sp-5) var(--sp-5);
  text-align: center;
}
.empty h2 {
  font-size: var(--fs-xl);
  font-weight: 600;
  letter-spacing: var(--ls-tight);
}
.empty-sub {
  margin: var(--sp-2) auto 0;
  max-width: 46ch;
  font-size: var(--fs-sm);
  color: var(--text-2);
}
.quick {
  margin-top: var(--sp-5);
  display: flex;
  flex-direction: column;
  gap: 6px;
  /* 外层的居中到入口这一层收住:入口里是左对齐的两行字 */
  text-align: left;
}
.quick-item {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  padding: var(--sp-3) 14px;
  border: 1px solid var(--line);
  border-radius: var(--r);
  transition: border-color var(--dur) var(--ease), background var(--dur) var(--ease);
}
.quick-item:hover {
  border-color: var(--line-strong);
  background: var(--bg-elev);
}
.qm {
  min-width: 0;
  display: flex;
  flex-direction: column;
}
.qm b {
  font-size: var(--fs-base);
  font-weight: 600;
}
.qm span {
  font-size: var(--fs-xs);
  color: var(--text-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.quick-item .go {
  margin-left: auto;
  color: var(--text-3);
  flex-shrink: 0;
}
.quick-item .go svg {
  width: 15px;
  height: 15px;
  display: block;
}
.empty-foot {
  margin-top: 18px;
  font-size: var(--fs-xs);
  color: var(--text-3);
}

/* —— 表单 —— */
.form-head {
  padding: var(--sp-5) var(--sp-5) 0;
}
.form-head h2 {
  font-size: var(--fs-xl);
  font-weight: 600;
  letter-spacing: var(--ls-tight);
}
.form-head p {
  margin-top: var(--sp-1);
  font-size: var(--fs-xs);
  color: var(--text-2);
}
.form-body {
  padding: var(--sp-5);
}
.block + .block {
  margin-top: var(--sp-5);
}
.block-label {
  display: block;
  margin-bottom: var(--sp-2);
  font-size: var(--fs-sm);
  color: var(--text-2);
}

/* 用途二选一:它决定后面所有字段的含义,所以给两行带说明的选项,
   而不是一排只有名字的胶囊 */
.purpose {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
}
.purpose-opt {
  /* 隐藏的原生 radio 是绝对定位的,得有个定位锚点收住它 */
  position: relative;
  display: flex;
  gap: 10px;
  padding: var(--sp-3) 14px;
  border: 1px solid var(--line);
  border-radius: var(--r);
  cursor: pointer;
  transition: border-color var(--dur) var(--ease), background var(--dur) var(--ease),
    box-shadow var(--dur) var(--ease);
}
.purpose-opt:hover {
  border-color: var(--line-strong);
}
.purpose-opt input {
  position: absolute;
  opacity: 0;
  pointer-events: none;
}
.pm {
  min-width: 0;
  color: var(--text-2);
}
.pm b {
  display: block;
  font-size: var(--fs-base);
  font-weight: 600;
}
.pm span {
  display: block;
  margin-top: 2px;
  font-size: var(--fs-xs);
  line-height: 1.5;
  color: var(--text-3);
}
.tick {
  flex-shrink: 0;
  width: 18px;
  height: 18px;
  margin-top: 1px;
  border: 1px solid var(--line-strong);
  border-radius: 999px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: transparent;
  transition: background var(--dur) var(--ease), border-color var(--dur) var(--ease),
    color var(--dur) var(--ease);
}
.tick svg {
  width: 11px;
  height: 11px;
}
.purpose-opt input:checked ~ .pm {
  color: var(--text);
}
.purpose-opt input:checked ~ .pm + .tick {
  background: var(--cta);
  border-color: var(--cta);
  color: var(--cta-text);
}
/* 选中的那行:墨色描边 + 抬高一点,不用紫色 */
.purpose-opt:has(input:checked) {
  border-color: var(--text);
  background: var(--surface);
  box-shadow: var(--sh-sm);
}

/* 厂商预设:999px 药丸,选中 = 墨色实心(与主页的参数胶囊同一套) */
.presets {
  display: flex;
  flex-wrap: wrap;
  gap: var(--sp-2);
}
.preset {
  padding: 6px 13px;
  font-size: var(--fs-sm);
  border: 1px solid var(--line);
  border-radius: 999px;
  color: var(--text-2);
  background: var(--surface);
  cursor: pointer;
  transition: border-color var(--dur) var(--ease), color var(--dur) var(--ease),
    background var(--dur) var(--ease);
}
.preset:hover {
  border-color: var(--line-strong);
  color: var(--text);
}
.preset.on {
  background: var(--cta);
  border-color: var(--cta);
  color: var(--cta-text);
}
.preset.on:hover {
  background: var(--cta-hover);
  border-color: var(--cta-hover);
  color: var(--cta-text);
}
/* 厂商能力说明:紧贴在厂商按钮下方,说明界面为何只露出这些参数 */
.note {
  margin-top: var(--sp-2);
  font-size: var(--fs-xs);
  line-height: 1.6;
  color: var(--text-3);
}
/* 说明里的字面值(地址片段、模型 ID)用等宽,和正文区分开 */
.note code {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.94em;
  padding: 1px 5px;
  border-radius: 5px;
  background: var(--bg-elev);
}

.field {
  display: block;
  margin-top: var(--sp-4);
}
.flabel {
  display: block;
  margin-bottom: 6px;
  font-size: var(--fs-sm);
  color: var(--text-2);
}
.flabel em {
  font-style: normal;
  color: var(--text-3);
}
.input-wrap {
  position: relative;
  display: flex;
}
.field input {
  width: 100%;
  padding: 11px 14px;
  border: 1px solid var(--line);
  border-radius: var(--r-sm);
  background: var(--surface);
  font-size: var(--fs-base);
  transition: border-color var(--dur) var(--ease), box-shadow var(--dur) var(--ease);
}
.field input:focus {
  border-color: var(--accent);
  box-shadow: 0 6px 22px -8px color-mix(in oklch, var(--accent) 40%, transparent);
}
.field input:disabled {
  color: var(--text-3);
  background: var(--bg-elev);
  cursor: not-allowed;
}
.field.has-err input {
  border-color: var(--danger);
}
/* 显隐键压在输入框右端,正文得让出来 */
.field-key input {
  padding-right: 44px;
}
.field-err {
  display: block;
  margin-top: 6px;
  font-size: var(--fs-xs);
  color: var(--danger);
}
.reveal {
  position: absolute;
  top: 50%;
  right: 6px;
  transform: translateY(-50%);
  width: 30px;
  height: 30px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 999px;
  color: var(--text-3);
  transition: color var(--dur) var(--ease), background var(--dur) var(--ease);
}
.reveal:hover {
  color: var(--text);
  background: var(--bg-elev);
}
.reveal svg {
  width: 15px;
  height: 15px;
}

.form-foot {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: var(--sp-5);
  padding-top: var(--sp-5);
  border-top: 1px solid var(--line);
}
.form-foot .hint {
  margin-left: auto;
  font-size: var(--fs-xs);
  color: var(--text-3);
}
/* 主行动:墨色药丸,与主页的生成键同一套 */
.btn-ink {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 36px;
  padding: 0 var(--sp-4);
  border-radius: 999px;
  background: var(--cta);
  color: var(--cta-text);
  font-size: var(--fs-sm);
  font-weight: 500;
  transition: background var(--dur) var(--ease);
}
.btn-ink:hover:not(:disabled) {
  background: var(--cta-hover);
}
.btn-ink:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
/* 放弃修改:描边药丸,比主行动轻 */
.btn-line {
  height: 36px;
  padding: 0 var(--sp-4);
  border: 1px solid var(--line);
  border-radius: 999px;
  color: var(--text-2);
  font-size: var(--fs-sm);
  transition: color var(--dur) var(--ease), border-color var(--dur) var(--ease),
    background var(--dur) var(--ease);
}
.btn-line:hover {
  color: var(--text);
  border-color: var(--line-strong);
  background: var(--bg-elev);
}

/* 窄屏:输入框提到 16px,防止 iOS Safari 聚焦时放大整页 */
@media (max-width: 640px) {
  .field input {
    font-size: var(--fs-lg);
  }
  /* 用途改单列;状态列不再定宽,名字多拿 68px 的横向空间 */
  .purpose {
    grid-template-columns: 1fr;
  }
  .pm b {
    font-size: var(--fs-lg);
  }
  .row-main-btn {
    grid-template-columns: auto 1fr;
  }
}
</style>
