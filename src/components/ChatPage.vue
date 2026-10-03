<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, onUpdated, ref, watch } from 'vue'
import {
  PhArrowDown,
  PhArrowUp,
  PhArrowsClockwise,
  PhBrain,
  PhCaretDown,
  PhChatCircleDots,
  PhDotsThree,
  PhEraser,
  PhImage,
  PhMaskHappy,
  PhPencilSimple,
  PhSlidersHorizontal,
  PhSpeakerHigh,
  PhStopCircle,
  PhTrash,
  PhX
} from '@phosphor-icons/vue'
import type { ApiConfig, Character, ChatMessage, ChatSummary } from '../types'
import { CHAT_MAX_CHARS, coverSrc, hasPersona } from '../api'
import { getChatImage } from '../lib/idb'
import { growTextarea, vGrow } from '../lib/grow'
import { speak, speechSupported, speakingId, speakingLoading, stopSpeaking, warmUpSpeech } from '../lib/speech'

/* 角色对话页。它是一个平级页面(见 lib/nav.ts),不是浮层 ——
   所以骨架是"左栏角色 + 右栏对话",与角色页/历史页同一套页面结构。

   这一页只做展示与编排:消息从哪来、请求怎么发、字节怎么写盘,
   全归主界面(它才碰 IndexedDB 与网络)。与 CharacterPage 是同一条分工 */
const props = defineProps<{
  characters: Character[]
  /** 已取到的消息,按角色 id 缓存。取出来的事归主界面 */
  messages: Record<string, ChatMessage[]>
  /* 每个角色的最后一条消息,只用来画左栏那一行摘要、并给左栏排序。
     消息按角色懒加载,没打开过的读不到 —— 少了这一份,
     它们在左栏一律显示 No messages yet 并排到最后(明明聊过,看着像没聊过) */
  lastMsg: Record<string, ChatMessage>
  /** 各角色正在生成中(没有该角色的键 = 空闲)。
   *  必须按角色分开 —— A 在说话时切到 B,B 的界面不该跟着显示"正在输入" */
  busy: Record<string, boolean>
  /** 当前选中的角色 id。空 = 还没挑 */
  active: string
  /* 前面还有更早的消息没读。库里装的是这个角色**最近一档** ——
     没有这一项就分不清"这是第一句"和"只读到这里" */
  hasMore: boolean
  /* 长期记忆:滑出窗口的消息压成的那段简报。
     有它就得让用户看得见 —— 它是模型"记得什么"的全部依据,
     藏起来就没法解释"它为什么会突然提起那件很久以前的事" */
  summary?: ChatSummary
  /** 对话要用的文本模型配置。没配就走不了,但历史照常能看 */
  textConfig?: ApiConfig
  /* 发图那一轮改用它。**看图得有看图的模型** —— 文本模型多半不支持,
     而上游的拒绝只是一句参数错,用户看不出"该换个模型了"。
     配了识图那条就优先用它;没配就照旧用文本配置(会报错,但那是实情) */
  visionConfig?: ApiConfig
  /* 朗读要用的合成配置。没配就退回浏览器自带的语音(见 lib/speech)——
     它是"能用就行"与"这个角色自己的嗓子"之间的那条分界线 */
  ttsConfig?: ApiConfig
}>()

const emit = defineEmits<{
  (e: 'select', charId: string): void
  /* image 是用户这一轮附的图(已经压到长边 1024)。存库与转 data URL
     归主界面 —— 与"消息从哪来、字节怎么写盘"同一条分工(见文件头) */
  (e: 'send', charId: string, text: string, image?: Blob): void
  (e: 'stop', charId: string): void
  (e: 'regenerate', charId: string): void
  /* 用户把那段记忆改成了别的。只换正文,覆盖进度(upToAt/covered)不动 ——
     那些消息本来就已经进去过了,改了正文不等于要重压一遍 */
  (e: 'editSummary', charId: string, text: string): void
  /* 忘掉这段记忆。**消息一条都不动** —— "角色不再记得"与"这事发生过"
     是两回事(见 App 的 forgetChatSummary) */
  (e: 'forgetSummary', charId: string): void
  (e: 'clear', charId: string): void
  // 往前再读一档。只影响显示,库里一条都不会少
  (e: 'loadEarlier', charId: string): void
  /* 一句要给用户看的话。目前只有一处会用到:朗读退回了浏览器声音 ——
     那件事必须说出来,否则用户会以为音色配置生效了、只是"听起来不对" */
  (e: 'notice', text: string): void
  (e: 'gotoChars'): void
  (e: 'gotoSettings'): void
}>()

/* ===== 取用的那一份 =================================================
   这一页只认"当前这个角色",其余角色的消息留在 props 里不动 ——
   切回去时不必重读 IndexedDB */
const current = computed(() => props.characters.find((c) => c.id === props.active) || null)
const msgs = computed(() => props.messages[props.active] || [])
const streaming = computed(() => !!props.busy[props.active])

function avatarOf(c: Character): string {
  return coverSrc(c.ref)
}

/* 最近活跃在前:聊过的按最后一条消息的时间排,没聊过的排在后面(按创建时间)。
   这份顺序是派生的,不落盘 —— 与 charStats / charWorks 同一条规矩。
   注意列的是**全部**角色,不是"聊过的那些":只列聊过的,新角色就永远开不了头 */
/* 某个角色最后一句。**内存里那份优先,库里那份兜底** ——
   内存里的更新(刚说完的话就在里面),而 lastMsg 是给没打开过的角色用的:
   消息按角色懒加载,不补这一路的话它们在左栏一律显示 No messages yet */
function lastOf(id: string): ChatMessage | undefined {
  const list = props.messages[id]
  if (list && list.length) return list[list.length - 1]
  return props.lastMsg[id]
}

const ordered = computed(() =>
  [...props.characters].sort(
    (a, b) => (lastOf(b.id)?.createdAt || 0) - (lastOf(a.id)?.createdAt || 0) || b.createdAt - a.createdAt
  )
)

/** 左栏那一行摘要:最后一句说了什么 */
function lastLine(c: Character): string {
  const m = lastOf(c.id)
  if (!m) return 'No messages yet'
  const t = m.content.replace(/\s+/g, ' ').trim()
  if (!t) return m.stopped ? '…' : 'Empty message'
  return (m.role === 'user' ? 'You: ' : '') + t
}

/* ===== 消息流的时间分隔 =============================================
   不逐条显示时间戳 —— 那是噪声。只在跨天、或两条之间隔得够久时插一条:
   它回答的是"这是一段旧对话还是接着刚才说的" */
const SEP_GAP = 30 * 60 * 1000

/* 时间一律钉死 en-US:全站界面是英文,而 toLocaleString 跟随系统 ——
   在中文机器上它会给出"10月2日",夹在一片英文里很跳。
   (ImagePreview 的时间戳也是这么钉的,同一套理由) */
function timeLabel(t: number): string {
  return new Date(t).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
}
function dayLabel(t: number): string {
  const d = new Date(t)
  const now = new Date()
  const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString()
  if (sameDay(d, now)) return 'Today'
  const y = new Date(now)
  y.setDate(y.getDate() - 1)
  if (sameDay(d, y)) return 'Yesterday'
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

type Row =
  | { kind: 'sep'; key: string; label: string }
  | { kind: 'msg'; key: string; msg: ChatMessage }

const rows = computed<Row[]>(() => {
  const out: Row[] = []
  let prev = 0
  for (const m of msgs.value) {
    const newDay = !prev || new Date(prev).toDateString() !== new Date(m.createdAt).toDateString()
    if (!prev || newDay || m.createdAt - prev > SEP_GAP) {
      out.push({
        kind: 'sep',
        key: `sep-${m.id}`,
        // 跨天时报全"哪天 + 几点",同一天只报几点
        label: newDay ? `${dayLabel(m.createdAt)} · ${timeLabel(m.createdAt)}` : timeLabel(m.createdAt)
      })
    }
    out.push({ kind: 'msg', key: m.id, msg: m })
    prev = m.createdAt
  }
  return out
})

/** 光标挂在正在说的那一条上。它同时说明"这会儿还在往下写" */
const cursorId = computed(() => {
  if (!streaming.value) return ''
  const last = msgs.value[msgs.value.length - 1]
  return last && last.role === 'assistant' ? last.id : ''
})

/* 重新生成:删掉最后那条助手消息、用同样的上文重发。
   用户那条不动。按过 Stop 的那条不提供 —— 它是"说到这儿够了",
   重发等于把用户的选择覆盖掉 */
const canRegenerate = computed(() => {
  if (streaming.value) return false
  const last = msgs.value[msgs.value.length - 1]
  return !!last && last.role === 'assistant' && !last.stopped
})

/* 重试:最后一条落在用户那句上,说明上一轮没答上来 ——
   runChat 失败时会把那条空壳摘掉(见主界面),消息流里因此只剩用户那句。
   与 Regenerate 共用同一个入口,只是文案不同 —— 同一次动作,
   在"想换个说法"和"刚才没发出去"两种情境下该叫不同的名字 */
const canRetry = computed(() => {
  if (streaming.value) return false
  const last = msgs.value[msgs.value.length - 1]
  return !!last && last.role === 'user'
})
const regenLabel = computed(() => (canRetry.value ? 'Try again' : 'Regenerate'))

const personaMissing = computed(() => !!current.value && !hasPersona(current.value.persona))

/* 此刻的情绪 = 最近那条回复带来的。**只看最后一条,不往前找** ——
   往前找会把一条很久以前的情绪一直挂在那儿,那就不是"此刻"了。
   流式期间那条占位消息还没有情绪,所以这枚药丸是在收尾那一刻才浮出来的 */
const mood = computed(() => {
  const last = msgs.value[msgs.value.length - 1]
  return last && last.role === 'assistant' ? last.mood || '' : ''
})

/* ===== 长期记忆 =====
   默认折起来:它是"它为什么还记得那件事"的解释,不是每屏都要读的东西。
   展开就能看到模型此刻真正"记得"的全部内容 —— 记忆是有损的,
   用户得能亲眼看到损掉了什么,才谈得上信它 */
const memoryOpen = ref(false)

/** 相对时间。只到"天"这一档就够 —— 记忆本来就是隔一阵才更新一次的 */
function ago(ts: number): string {
  const m = Math.round((Date.now() - ts) / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.round(h / 24)}d ago`
}
/* 有东西可看的记忆。看的是**正文非空**,不是记录在不在 ——
   忘掉之后库里会留一条正文为空的记录(那个"从哪之后不再记得"的游标
   总得有地方待),那种记录不该在界面上显出一个空的 Memory 块。
   直接把记录本身交出去,模板里 v-if="memory" 一过就能接着取正文 */
const memory = computed(() => (props.summary?.text ? props.summary : undefined))
const memoryWhen = computed(() => (memory.value ? ago(memory.value.updatedAt) : ''))

/* 记忆可改。压错了一处就得能就地改 —— 否则用户唯一的办法是清空整段对话,
   而那把整段历史也一起扔了,代价完全不成比例。
   编辑态是"这一页临时在做什么",归组件自己管;写回库里的动作交给主界面 */
const memoryEditing = ref(false)
const memoryDraft = ref('')

/* 正在改的时候别让头把它折起来 —— 折了就等于把手上正在写的东西藏了 */
function toggleMemory() {
  if (memoryEditing.value) return
  memoryOpen.value = !memoryOpen.value
}

/* 上限就用消息那一档:服务端对记忆收的正是 CHAT_MAX_CHARS,
   这里跟着同一个数,用户改到多少会被下游截断是可以预期的 */
const memoryTooLong = computed(() => memoryDraft.value.trim().length > CHAT_MAX_CHARS)

function startEditMemory() {
  memoryDraft.value = props.summary?.text || ''
  memoryOpen.value = true
  memoryEditing.value = true
}
function cancelEditMemory() {
  memoryEditing.value = false
  memoryDraft.value = ''
}
function saveMemory() {
  const t = memoryDraft.value.trim()
  /* 存空的没有意义:那等于"忘掉这段",而记忆与对话是绑在一起的 ——
     清空记忆该走"清空对话",不该在这里留下一个空壳 */
  if (!t || memoryTooLong.value) return
  emit('editSummary', props.active, t)
  memoryEditing.value = false
}
/* 换角色时把编辑态收掉:那块记忆已经属于另一个人了,
   留着草稿会让人以为改的是当前这个。
   正念着的那句也一起停 —— 换了人就换了一段对话,上一个人的声音不该还在响 */
watch(
  () => props.active,
  () => {
    cancelEditMemory()
    stopSpeaking()
  }
)

/* ===== 朗读 =========================================================
   用浏览器自带的语音(见 lib/speech)。**不支持就不给入口** ——
   一个点了没反应的按钮比没有更糟,所以这里先问一次 */
const canSpeak = speechSupported()

/** 念这一条。同一枚按钮管三件事:没在念就念,正在等就取消,正在响就停 ——
 *  再挂一枚"停止"在旁边,是在为一件只有两种状态的事多养一个按钮 */
async function toggleSpeak(msg: ChatMessage) {
  if (speakingId.value === msg.id) {
    stopSpeaking()
    return
  }
  const c = current.value
  if (!c) return
  /* 走哪条路由角色自己的嗓音决定(见 lib/speech):
     没配过的一律走浏览器,配了就走第三方 —— 失败会自己退回来,
     并把"退回来了"和原因一起交回来 */
  const said = await speak(
    msg.content,
    { charId: c.id, voice: c.voice, cfg: props.ttsConfig },
    msg.id
  )
  if (said) emit('notice', said)
}

/* ===== 自动跟随 =====================================================
   只在"用户本来就贴着底"时才跟着新消息走。正在往上翻历史时被拽回底部,
   是聊天界面最烦人的一件事 */
const streamEl = ref<HTMLElement | null>(null)
const FOLLOW_GAP = 80

/* 贴着底没有。这是"自动跟随"的开关 —— 只在贴底时把视口带下去,
   用户往上翻的时候要让他安静地看。
   做成响应式(原来是普通变量)是因为界面还要据此决定要不要给"回到最新" */
const atBottom = ref(true)
/* 翻上去之后又来了几条。说的不是"未读" —— 用户可能刚看过,
   只是此刻不在底部,所以文案用"N new"而不是红点角标 */
const pendingNew = ref(0)
/* 正在做"回到最新"的平滑滚动。滚动过程会一路触发 scroll 事件、
   把 atBottom 反复算成 false,那枚按钮就会自己闪一下 —— 用一个旗子按住 */
let jumping = false

function onStreamScroll() {
  if (jumping) return
  const el = streamEl.value
  if (!el) return
  atBottom.value = el.scrollHeight - el.scrollTop - el.clientHeight < FOLLOW_GAP
  // 自己滚回底部就等于看过了
  if (atBottom.value) pendingNew.value = 0
}
function toEnd(smooth = false) {
  const el = streamEl.value
  if (!el) return
  if (smooth) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
  else el.scrollTop = el.scrollHeight
  atBottom.value = true
  pendingNew.value = 0
}
/* 那枚"回到最新"。只在真有内容、而且不贴底时出现 */
const showJump = computed(() => !atBottom.value && msgs.value.length > 0)
function jumpToLatest() {
  if (jumping) return
  jumping = true
  toEnd(true)
  window.setTimeout(() => {
    jumping = false
  }, 400)
}

/* 放在 onUpdated 而不是 watch(messages):流式时改的是**同一条消息的内容**,
   数组长度没变,watch 抓不到 */
onUpdated(() => {
  if (atBottom.value) toEnd()
})

/* 不贴底的时候底下又长了东西 ⇒ 记一笔,好在那枚按钮上说出来。
   往前读一档不算:那是用户自己点出来的,而且内容插在**上面** ——
   那种情况下该做的是稳住视口(见下面的 earlierFrom) */
watch(
  () => msgs.value.length,
  (n, prev) => {
    if (!prev || earlierFrom) return
    if (!atBottom.value && n > prev) pendingNew.value += n - prev
  }
)

watch(
  () => props.active,
  async () => {
    // 换角色 = 进到另一段对话,该落在最新那一句上
    atBottom.value = true
    pendingNew.value = 0
    closeMenu()
    pickerOpen.value = false
    await nextTick()
    toEnd()
  }
)
onMounted(async () => {
  await nextTick()
  toEnd()
})

/* ===== 往前读一档 ===================================================
   库里装的是最近 CHAT_PAGE 条,更早的还在库里没读。
   往上面插内容时浏览器不一定能自己稳住视口,所以读之前先记下高度,
   回来后按"长高了多少"把滚动条往下推同样的距离 */
let earlierFrom = 0

function loadEarlier() {
  if (!props.hasMore || streaming.value) return
  const el = streamEl.value
  earlierFrom = el ? el.scrollHeight : 0
  /* 先把"贴着底"关掉:消息一回来组件就会重渲染,
     这时若还贴着底,onUpdated 会把视口拽到底部去 —— 那是反方向 */
  atBottom.value = false
  emit('loadEarlier', props.active)
}

watch(
  () => msgs.value.length,
  () => {
    if (!earlierFrom) return
    const el = streamEl.value
    const grew = el ? el.scrollHeight - earlierFrom : 0
    earlierFrom = 0
    if (el && grew > 0) el.scrollTop += grew
  },
  // post:要在 DOM 更新**之后**量,否则量到的还是插进来之前的高度
  { flush: 'post' }
)

/* ===== 输入 ========================================================= */
const text = ref('')
const inputEl = ref<HTMLTextAreaElement | null>(null)
/** 输入框最高长到六行,再多内部滚 —— 与角色向导的起稿块同一套 */
/* 长高那件事由 v-grow 指令负责(见 lib/grow.ts)。这里只在清空之后
   手动补一次 —— 清空会走到指令的 updated,但发送是同步的,
   补一次能让输入框在同一帧就收回去,不闪那一下 */
function grow() {
  const el = inputEl.value
  if (el) growTextarea(el)
}

/* 超长先拦在本地。服务端也会拒绝(它必须拒绝 —— 入口是公开的),
   但那时候用户手里那条已经被清空了,只能把一整段重打一遍。
   所以这里就挡住、原文留着、当场说清是哪一步过不去 */
const tooLong = computed(() => text.value.trim().length > CHAT_MAX_CHARS)

/* ===== 附图 =====
   用户可以把一张图发给角色看。上限长边 1024:它要作为 data URL 随请求
   发出去,而一张 4000px 的原图光 base64 就有几 MB —— 模型看的是内容,
   不是分辨率。压过的这一份同时是"发出去的那份"和"存下来的那份",
   所以库里不会白白胖一圈。
   一次只挂一张:多图对"它在看什么"帮助有限,而每张都是上千 token。
   ------------------------------------------------------------------ */
const CHAT_IMAGE_MAX = 1024
const imgInput = ref<HTMLInputElement | null>(null)
const attach = ref<{ blob: Blob; url: string } | null>(null)

function clearAttach() {
  if (attach.value) URL.revokeObjectURL(attach.value.url)
  attach.value = null
}

async function shrinkForChat(file: Blob): Promise<Blob> {
  const bmp = await createImageBitmap(file)
  const scale = Math.min(1, CHAT_IMAGE_MAX / Math.max(bmp.width, bmp.height))
  const c = document.createElement('canvas')
  c.width = Math.max(1, Math.round(bmp.width * scale))
  c.height = Math.max(1, Math.round(bmp.height * scale))
  const ctx = c.getContext('2d')
  if (!ctx) {
    bmp.close()
    return file
  }
  ctx.drawImage(bmp, 0, 0, c.width, c.height)
  bmp.close()
  /* 一律转 jpeg:png 截图动辄一两 MB,而聊天里这张图只用来"看",
     不需要无损。编码失败就退回原图,不因为这一步让人发不出去 */
  return (await new Promise<Blob | null>((r) => c.toBlob(r, 'image/jpeg', 0.85))) ?? file
}

async function onPickImage(e: Event) {
  const el = e.target as HTMLInputElement
  const file = el.files?.[0]
  // 清空 input:同一个文件选第二次也要能触发 change
  el.value = ''
  if (!file) return
  if (!file.type.startsWith('image/')) {
    emit('notice', 'That file is not an image.')
    return
  }
  try {
    const blob = await shrinkForChat(file)
    clearAttach()
    attach.value = { blob, url: URL.createObjectURL(blob) }
  } catch {
    emit('notice', 'Could not read that image.')
  }
}

/* 已经发出去的那些图:按需从库里读回来,读完缓存在这一层 ——
   一条消息一个 objectURL。不缓存的话每次重渲染都要再开一次事务 */
const imgUrls = ref<Record<string, string>>({})
const imgPending = new Set<string>()

/** 取某张附图的显示地址。还没读回来时返回空串(那一帧先不画图) */
function imgUrl(id: string): string {
  const have = imgUrls.value[id]
  if (have) return have
  if (!imgPending.has(id)) {
    imgPending.add(id)
    void getChatImage(id).then((rec) => {
      imgPending.delete(id)
      if (!rec) return
      imgUrls.value = { ...imgUrls.value, [id]: URL.createObjectURL(rec.blob) }
    })
  }
  return ''
}

function send() {
  const t = text.value.trim()
  const id = props.active
  const pic = attach.value
  /* 只有图没有字也放行 —— "看看这个"本身就是一句话 */
  if ((!t && !pic) || !id || streaming.value || !props.textConfig || tooLong.value) return
  const blob = pic?.blob
  text.value = ''
  clearAttach()
  nextTick(grow)
  /* 自己开口了就跟下去。不这么做的话,往上翻着忽然发一句会留在原地,
     然后那枚按钮上会冒出 "1 new" —— 数的是自己刚说的那句,很怪 */
  toEnd()
  emit('send', id, t, blob)
}

function onKeydown(e: KeyboardEvent) {
  if (e.key !== 'Enter' || e.shiftKey) return
  // 输入法组合中的回车是"确认候选词",不是发送 —— 中文输入法必然撞上
  if (e.isComposing || e.keyCode === 229) return
  e.preventDefault()
  send()
}

function pick(id: string) {
  if (id !== props.active) emit('select', id)
  /* 从窄屏那个浮层里挑的:关掉它并把焦点交给输入框 ——
     刚选完跟谁说话,下一步就是开口 */
  if (pickerOpen.value) {
    pickerOpen.value = false
    void nextTick(() => inputEl.value?.focus())
  }
}

/* ===== 头部那枚 ⋮ 菜单 ==============================================
   里面只有一项,但清空是个不可逆动作,摆在人眼前等于给误触留门 */
const menuOpen = ref(false)
const menuWrap = ref<HTMLElement | null>(null)
const pickerOpen = ref(false)
/* 浮层本身,以及打开它的那枚按钮。模态要求焦点收进来、关掉再还回去 ——
   缺了这两样,键盘与读屏用户打开浮层时焦点还留在背后的页面上,
   Tab 会一路穿到后面那些看不见的控件上 */
const pickerBox = ref<HTMLElement | null>(null)
const pickerTrigger = ref<HTMLElement | null>(null)

function closeMenu() {
  menuOpen.value = false
}

async function openPicker(e: MouseEvent) {
  pickerTrigger.value = (e.currentTarget as HTMLElement | null) ?? null
  pickerOpen.value = true
  await nextTick()
  // 焦点落在浮层本身而不是第一个条目:先让读屏念出"这是什么"
  pickerBox.value?.focus()
}

async function closePicker() {
  if (!pickerOpen.value) return
  pickerOpen.value = false
  await nextTick()
  // 物归原主。不收回去,焦点会掉在文档开头
  pickerTrigger.value?.focus()
  pickerTrigger.value = null
}

/** 把 Tab 圈在浮层里。与角色向导、设定图查看器是同一套写法 ——
 *  浮层里的控件就那么几个,一个循环就够了,不必去动主界面 */
function trapTab(box: HTMLElement | null, e: KeyboardEvent) {
  if (!box) return
  const items = Array.from(
    box.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled])'
    )
  )
  if (!items.length) return
  const first = items[0]
  const last = items[items.length - 1]
  const at = document.activeElement as HTMLElement | null
  // 焦点还停在容器本身(刚打开时):下一个 Tab 直接进第一个控件
  if (!at || !items.includes(at)) {
    e.preventDefault()
    ;(e.shiftKey ? last : first).focus()
    return
  }
  if (e.shiftKey && at === first) {
    e.preventDefault()
    last.focus()
  } else if (!e.shiftKey && at === last) {
    e.preventDefault()
    first.focus()
  }
}

function onPickerKey(e: KeyboardEvent) {
  if (e.key === 'Tab') trapTab(pickerBox.value, e)
}

function onDocPointerDown(e: PointerEvent) {
  if (!menuOpen.value) return
  const el = e.target as Node | null
  if (el && menuWrap.value?.contains(el)) return
  closeMenu()
}

/** Esc 是逐层退:先关角色浮层(并把焦点还回去),再关菜单 ——
 *  与角色页的查看器同一套规矩 */
function onKey(e: KeyboardEvent) {
  if (e.key !== 'Escape') return
  if (pickerOpen.value) {
    void closePicker()
    return
  }
  closeMenu()
}

function clearChat() {
  closeMenu()
  if (props.active) emit('clear', props.active)
}

/* 记忆块的入口在消息流最上面,而一进来视口是贴在底部的 ——
   偏偏"聊得够久"才有记忆,那时它已经被推到很远的上方,要往上翻很久。
   所以 ⋯ 菜单里再放一个常驻入口:点它直接滚到顶、展开、进入编辑 */
function editMemoryFromMenu() {
  closeMenu()
  startEditMemory()
  streamEl.value?.scrollTo({ top: 0, behavior: 'smooth' })
}

/* 忘掉这段记忆。**一条消息都不删** —— 它只是"角色不再记得",
   而这段对话确实发生过,想回看随时能往上翻。
   真正的难处在主界面:不能只把正文清空,还得把游标推到最新,
   否则下一轮压缩会把刚忘掉的那段重新压回来(见 App 的 forgetChatSummary) */
function forgetMemory() {
  closeMenu()
  cancelEditMemory()
  if (props.active) emit('forgetSummary', props.active)
}

onMounted(() => {
  document.addEventListener('pointerdown', onDocPointerDown)
  window.addEventListener('keydown', onKey)
  /* 进这一页就把音色表捞一次:它异步到达,而第一次朗读要用的就是它 */
  if (canSpeak) warmUpSpeech()
})
onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onDocPointerDown)
  window.removeEventListener('keydown', onKey)
  /* 离开这一页就把嘴闭上:语音不属于"后台也该继续"的那类东西 */
  stopSpeaking()
  /* 附图的 objectURL 是这一层开的,就由这一层收回 —— 不收回的话
     它们会一直扣着那份 Blob,直到整页刷新 */
  clearAttach()
  for (const u of Object.values(imgUrls.value)) URL.revokeObjectURL(u)
})
</script>

<template>
  <div class="chat">
    <!-- —— 左栏:角色。与对话是同一个对象的两个面 —— -->
    <aside class="chat-rail" aria-label="Characters">
      <p class="rail-eyebrow">Conversations</p>
      <div v-if="characters.length" class="rail-list no-bar">
        <button
          v-for="c in ordered"
          :key="c.id"
          class="rail-row"
          :class="{ on: c.id === active }"
          :aria-current="c.id === active ? 'true' : undefined"
          @click="pick(c.id)"
        >
          <span class="rail-ava">
            <img v-if="avatarOf(c)" :src="avatarOf(c)" alt="" />
            <PhMaskHappy v-else aria-hidden="true" />
          </span>
          <span class="rail-text">
            <span class="rail-name">{{ c.name }}</span>
            <span class="rail-last">{{ lastLine(c) }}</span>
          </span>
        </button>
      </div>
      <p v-else class="rail-empty">No characters yet.</p>
    </aside>

    <!-- —— 右栏:这一段对话 —— -->
    <section class="chat-main">
      <!-- 没有角色:整页只有一句话和一个去处 -->
      <div v-if="!characters.length" class="chat-empty">
        <span class="empty-ava"><PhMaskHappy aria-hidden="true" /></span>
        <p class="empty-title">Create a character first</p>
        <p class="empty-sub">Characters are who you talk to here.</p>
        <button class="ed-btn primary" @click="emit('gotoChars')">Go to Characters</button>
      </div>

      <div v-else-if="!current" class="chat-empty">
        <span class="empty-ava"><PhChatCircleDots aria-hidden="true" /></span>
        <p class="empty-title">Pick someone to talk to</p>
        <p class="empty-sub">Any character on the left — each one keeps its own conversation.</p>
      </div>

      <template v-else>
        <header class="chat-head">
          <!-- 窄屏下左栏是收起的,这里那枚头像就是"换一个角色"的入口 -->
          <button
            class="head-pick"
            aria-label="Choose a character"
            @click="openPicker"
          >
            <span class="head-ava">
              <img v-if="avatarOf(current)" :src="avatarOf(current)" alt="" />
              <PhMaskHappy v-else aria-hidden="true" />
            </span>
            <span class="head-text">
              <span class="head-top">
                <span class="head-name">{{ current.name }}</span>
                <span v-if="mood" :key="mood" class="mood">{{ mood }}</span>
              </span>
              <span v-if="current.fields?.identity" class="head-sub">
                {{ current.fields.identity }}
              </span>
            </span>
          </button>
          <span class="head-solo">
            <span class="head-ava">
              <img v-if="avatarOf(current)" :src="avatarOf(current)" alt="" />
              <PhMaskHappy v-else aria-hidden="true" />
            </span>
            <span class="head-text">
              <span class="head-top">
                <span class="head-name">{{ current.name }}</span>
                <span v-if="mood" :key="mood" class="mood">{{ mood }}</span>
              </span>
              <span v-if="current.fields?.identity" class="head-sub">
                {{ current.fields.identity }}
              </span>
            </span>
          </span>

          <div ref="menuWrap" class="chat-menu-wrap">
            <button
              class="icob"
              aria-label="Conversation options"
              :aria-expanded="menuOpen"
              @click="menuOpen = !menuOpen"
            >
              <PhDotsThree aria-hidden="true" />
            </button>
            <div v-if="menuOpen" class="chat-menu">
              <!-- 没有记忆就没东西可改也没东西可忘 ——
                   点了会滚到顶上撞见一片空,不如不给。
                   忘记忆排在清空对话前面,三档是"忘一点 / 忘干净"的递进 -->
              <button v-if="memory" @click="editMemoryFromMenu">
                <PhPencilSimple aria-hidden="true" />
                Edit memory
              </button>
              <button v-if="memory" @click="forgetMemory">
                <PhEraser aria-hidden="true" />
                Forget memory
              </button>
              <button :disabled="!msgs.length" @click="clearChat">
                <PhTrash aria-hidden="true" />
                Clear conversation
              </button>
            </div>
          </div>
        </header>

        <!-- 消息流:整页唯一滚动的那一块。
             role="log" + aria-live 让读屏在**整条说完**时播报一次。
             光有 aria-live 不够:流式时内容逐块在变,读屏会把整段逐字念一遍,
             比不播报还糟 —— 所以生成期间挂上 aria-busy,把播报压到收尾那一刻
             (aria-busy 必须挂在 live region 自己身上才管用) -->
        <div
          ref="streamEl"
          class="chat-stream no-bar"
          role="log"
          aria-live="polite"
          :aria-busy="streaming ? 'true' : 'false'"
          @scroll="onStreamScroll"
        >
          <!-- 还没聊过:给一句实话 + 一个去处。这里**不编角色的话** ——
               那句话得由模型说,本地假装它开口是不诚实的 -->
          <div v-if="!msgs.length" class="chat-empty is-inside">
            <span class="empty-ava">
              <img v-if="avatarOf(current)" :src="avatarOf(current)" alt="" />
              <PhMaskHappy v-else aria-hidden="true" />
            </span>
            <p class="empty-title">Say something to {{ current.name }}</p>
            <p class="empty-sub">
              {{
                streaming
                  ? 'Starting…'
                  : `Every reply is written in ${current.name}’s own voice.`
              }}
            </p>
            <button
              v-if="personaMissing"
              class="ed-btn"
              @click="emit('gotoChars')"
            >
              Add a personality to {{ current.name }}
            </button>
          </div>

          <div v-else class="chat-inner">
            <!-- 长期记忆。摆在最上面是因为它代表"比这些消息更早的那些" ——
                 顺序上它就该在最早的那条之前 -->
            <div v-if="memory" class="memory">
              <button
                class="memory-head"
                :aria-expanded="memoryOpen"
                @click="toggleMemory"
              >
                <PhBrain aria-hidden="true" />
                <span class="memory-label">Memory</span>
                <span class="memory-when">{{ memoryWhen }}</span>
                <PhCaretDown class="memory-caret" :class="{ open: memoryOpen }" aria-hidden="true" />
              </button>

              <template v-if="memoryOpen">
                <!-- 改这里的字,不是改历史 —— 那段对话已经压成这几十个字了,
                     改它等于给模型换一份"我记得的版本"。改得动,这功能才谈得上可信 -->
                <div v-if="memoryEditing" class="memory-edit">
                  <textarea
                    v-model="memoryDraft"
                    class="memory-input"
                    rows="4"
                    aria-label="Edit memory"
                  ></textarea>
                  <p v-if="memoryTooLong" class="memory-warn" role="alert">
                    Over {{ CHAT_MAX_CHARS }} characters. Trim it before saving.
                  </p>
                  <div class="memory-actions">
                    <button class="save-btn" :disabled="!memoryDraft.trim() || memoryTooLong" @click="saveMemory">
                      Save
                    </button>
                    <button class="quiet-btn" @click="cancelEditMemory">Cancel</button>
                  </div>
                </div>

                <template v-else>
                  <p class="memory-text">{{ memory.text }}</p>
                  <!-- 改是主操作,忘是次操作 —— 所以忘了的那枚悬停才染成危险色,
                       平时与"改"长得一样安静 -->
                  <div class="memory-actions">
                    <button class="quiet-btn" @click="startEditMemory">
                      <PhPencilSimple aria-hidden="true" />
                      Edit memory
                    </button>
                    <button class="quiet-btn danger" @click="forgetMemory">
                      <PhEraser aria-hidden="true" />
                      Forget memory
                    </button>
                  </div>
                </template>
              </template>
            </div>

            <!-- 更早的还在库里,只是没读。这是一枚"往前翻"的入口,
                 不是"加载中" —— 所以措辞里不带任何等待或危险的意味 -->
            <div v-if="hasMore" class="earlier">
              <button class="earlier-btn" @click="loadEarlier">Load earlier messages</button>
            </div>

            <template v-for="r in rows" :key="r.key">
              <p v-if="r.kind === 'sep'" class="sep">{{ r.label }}</p>
              <div v-else class="msg" :class="r.msg.role">
                <div class="bubble">
                  <!-- 说了谁说的。左右对齐和底色是给眼睛的,
                       读屏读不出这两种区别,不补一句就只剩一堆光秃秃的句子 -->
                  <span class="sr-only">
                    {{ r.msg.role === 'user' ? 'You said: ' : `${current.name} said: ` }}
                  </span>
                  <!-- 用户附的图。压在文字上面:那张图是这句话的前提,
                       先看图再读字才顺。图还没从库里读回来时先不画(见 imgUrl) -->
                  <img
                    v-if="r.msg.imageId && imgUrl(r.msg.imageId)"
                    class="bubble-img"
                    :src="imgUrl(r.msg.imageId)"
                    alt="Attached image"
                  />
                  {{ r.msg.content }}<span v-if="r.msg.id === cursorId" class="cursor" aria-hidden="true"></span>
                  <!-- 朗读。贴着气泡外侧下角,绝对定位 —— 它不该挤占气泡的宽度。
                       只在悬停时浮出来(触屏没有 hover,那时让它常驻,见样式)。
                       正在生成的那条不给:半句话念出来只会更难听 -->
                  <button
                    v-if="canSpeak && r.msg.role === 'assistant' && r.msg.id !== cursorId"
                    class="speak-btn"
                    :class="{
                      on: speakingId === r.msg.id,
                      busy: speakingId === r.msg.id && speakingLoading
                    }"
                    :aria-label="
                      speakingId === r.msg.id
                        ? speakingLoading
                          ? 'Cancel reading'
                          : 'Stop reading this out loud'
                        : `Read ${current.name}’s reply out loud`
                    "
                    @click="toggleSpeak(r.msg)"
                  >
                    <PhStopCircle v-if="speakingId === r.msg.id" aria-hidden="true" />
                    <PhSpeakerHigh v-else aria-hidden="true" />
                  </button>
                </div>
                <!-- 上游撞上 max_tokens 停下。不标这一句的话,
                     它和"正常说完"在界面上长得一模一样 ——
                     用户会以为角色话说一半是它自己的风格 -->
                <p v-if="r.msg.truncated" class="cut">Cut off at the length limit</p>
              </div>
            </template>

            <!-- 重新生成 / 重试:都只在消息流末尾出现,两者是同一件事的两种叫法。
                 它是这一页最次要的动作,所以做成一条无底无边的细文字 -->
            <div v-if="canRegenerate || canRetry" class="regen">
              <button class="quiet-btn" @click="emit('regenerate', current.id)">
                <PhArrowsClockwise aria-hidden="true" />
                {{ regenLabel }}
              </button>
            </div>
          </div>
        </div>

        <!-- 输入区:固定在底部,不跟消息一起滚走 -->
        <div class="chat-compose">
          <!-- 回到最新。贴在输入区上沿(bottom: 100%)而不是写死一个像素值 ——
               输入区的高度会变(多一条超长警告、或没配模型时换成另一块),
               写死了就会在那些时候错位 -->
          <div v-if="showJump" class="jump">
            <button class="jump-btn" @click="jumpToLatest">
              <PhArrowDown aria-hidden="true" />
              {{ pendingNew ? `${pendingNew} new` : 'Latest' }}
            </button>
          </div>
          <div v-if="!textConfig" class="compose-off">
            <PhSlidersHorizontal aria-hidden="true" />
            <span>Add a text model in API settings to start talking.</span>
            <button class="ed-btn" @click="emit('gotoSettings')">Open settings</button>
          </div>
          <!-- 超长当场说清:文案里带上限,免得用户去猜是多少。
               包一层 template 是因为它和下面那张卡片是一组 v-if / v-else ——
               直接并排写会把上面那条 "没配模型" 的分支拆断 -->
          <template v-else>
            <!-- 待发的图。压在输入框**上面**而不是挤进框里:它只是这一句
                 要带的东西,不该把输入区挤窄;取消就按它右上角那一枚 -->
            <div v-if="attach" class="attach">
              <img :src="attach.url" alt="Attachment preview" />
              <button
                type="button"
                class="attach-x"
                aria-label="Remove the image"
                @click="clearAttach"
              >
                <PhX aria-hidden="true" />
              </button>
            </div>
            <p v-if="tooLong" class="compose-warn" role="alert">
              That message is over {{ CHAT_MAX_CHARS }} characters. Trim it before sending.
            </p>
            <div v-else class="compose-box">
              <!-- 附图键放最左:右端那一枚永远留给"把这句话发出去" -->
              <button
                type="button"
                class="img-btn"
                :disabled="streaming"
                aria-label="Attach an image"
                title="Attach an image"
                @click="imgInput?.click()"
              >
                <PhImage aria-hidden="true" />
              </button>
              <input ref="imgInput" type="file" accept="image/*" hidden @change="onPickImage" />
              <textarea
                ref="inputEl"
                v-grow
                v-model="text"
                class="no-bar"
                rows="1"
                :placeholder="`Message ${current.name}…`"
                :aria-label="`Message ${current.name}`"
                @keydown="onKeydown"
              ></textarea>
              <!-- 生成中把这一枚原地换成停止键 —— 不是并排多一个按钮 -->
              <button
                v-if="streaming"
                class="send-btn"
                aria-label="Stop"
                @click="emit('stop', current.id)"
              >
                <span class="stop-sq" aria-hidden="true"></span>
              </button>
              <button
                v-else
                class="send-btn"
                :disabled="(!text.trim() && !attach) || tooLong"
                aria-label="Send"
                @click="send"
              >
                <PhArrowUp aria-hidden="true" />
              </button>
            </div>
          </template>
        </div>
      </template>
    </section>

    <!-- 窄屏下换角色:左栏收起了,这一层顶上。
         遮罩取值与设定图查看器同一套(深色 + 模糊,与主题无关) -->
    <div v-if="pickerOpen" class="picker" @click="closePicker">
      <div
        ref="pickerBox"
        class="picker-box no-bar"
        role="dialog"
        aria-modal="true"
        aria-label="Choose a character"
        tabindex="-1"
        @click.stop
        @keydown="onPickerKey"
      >
        <p class="rail-eyebrow">Conversations</p>
        <div class="rail-list">
          <button
            v-for="c in ordered"
            :key="c.id"
            class="rail-row"
            :class="{ on: c.id === active }"
            @click="pick(c.id)"
          >
            <span class="rail-ava">
              <img v-if="avatarOf(c)" :src="avatarOf(c)" alt="" />
              <PhMaskHappy v-else aria-hidden="true" />
            </span>
            <span class="rail-text">
              <span class="rail-name">{{ c.name }}</span>
              <span class="rail-last">{{ lastLine(c) }}</span>
            </span>
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.chat {
  /* 页面高度 = 视口 − 顶栏 − frame 上边距 − 底部余量。
     --mast-h 由主界面量出来挂在根元素上(见 App 的 mastRO),顶栏换行变高时这里跟着变。
     用 dvh 而不是 vh:移动端地址栏收起时 vh 会让底部被切掉一截。
     最后那个 --sp-4 就是面板与视口底边之间那道缝 —— 它已经从
     .shell-wide 的 padding 挪进了这条算式(那边现在是 0),
     两边是一对,改一个要改另一个 */
  height: calc(100vh - var(--mast-h, 72px) - var(--sp-2) - var(--sp-4));
  height: calc(100dvh - var(--mast-h, 72px) - var(--sp-2) - var(--sp-4));
  /* 屏很矮时宁可让整页滚,也不要压成一条缝 */
  min-height: 420px;
  display: grid;
  grid-template-columns: 240px minmax(0, 1fr);
  gap: var(--sp-4);
  min-width: 0;
}

/* ===== 左栏 ===== */
.chat-rail {
  display: flex;
  flex-direction: column;
  min-height: 0;
  padding: var(--sp-3) var(--sp-2);
  border: 1px solid var(--line);
  border-radius: var(--r);
  background: var(--surface);
}
.rail-eyebrow {
  margin: 0 0 var(--sp-3);
  padding: 0 6px;
  font-size: var(--fs-micro);
  font-weight: 600;
  letter-spacing: var(--ls-eyebrow);
  text-transform: uppercase;
  color: var(--text-3);
}
.rail-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-height: 0;
  overflow-y: auto;
}
.rail-row {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  /* 触控目标 ≥40px */
  min-height: 52px;
  padding: 6px 8px;
  border: 0;
  border-radius: var(--r-sm);
  background: none;
  color: inherit;
  text-align: left;
  cursor: pointer;
  transition: background var(--dur) var(--ease);
}
.rail-row:hover {
  background: var(--surface-hover);
}
/* 选中态只用淡底 + 字重,不用彩色 —— 与站内克制的灰度一致 */
.rail-row.on {
  background: var(--accent-soft);
}
.rail-ava {
  flex: none;
  display: grid;
  place-items: center;
  width: 36px;
  height: 36px;
  overflow: hidden;
  border-radius: 999px;
  background: var(--bg-elev);
  color: var(--text-3);
}
.rail-ava img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.rail-ava svg {
  font-size: 18px;
}
.rail-text {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
}
.rail-name {
  overflow: hidden;
  font-size: var(--fs-sm);
  color: var(--text-2);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.rail-row.on .rail-name {
  font-weight: 600;
  color: var(--text);
}
.rail-last {
  overflow: hidden;
  font-size: var(--fs-xs);
  color: var(--text-3);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.rail-empty {
  padding: 0 6px;
  font-size: var(--fs-sm);
  color: var(--text-3);
}

/* ===== 右栏 ===== */
.chat-main {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  /* 圆角靠子元素自己的内边距让开,不靠裁切 ——
     裁切会把底下那张悬浮卡片的投影也一起切掉 */
  border: 1px solid var(--line);
  border-radius: var(--r);
  background: var(--surface);
}
.chat-head {
  flex: none;
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  padding: var(--sp-3) var(--sp-4);
  border-bottom: 1px solid var(--line);
}
/* 宽屏用不可点的 head-solo,窄屏才换成可点的 head-pick ——
   宽屏下左栏就在旁边,再给一个"换角色"的入口是多余的 */
.head-solo {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}
.head-pick {
  display: none;
  align-items: center;
  gap: 10px;
  min-width: 0;
  padding: 0;
  border: 0;
  background: none;
  color: inherit;
  text-align: left;
  cursor: pointer;
}
.head-ava {
  flex: none;
  display: grid;
  place-items: center;
  width: 32px;
  height: 32px;
  overflow: hidden;
  border-radius: 999px;
  background: var(--bg-elev);
  color: var(--text-3);
}
.head-ava img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.head-ava svg {
  font-size: 16px;
}
.head-text {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
}
/* 名字与情绪同一行:情绪是"此刻的状态",贴着名字读最自然 ——
   挪到下面那行(身份)去会被 46ch 的截断吃掉,
   而那行是角色的定义,不该被一个每轮都在变的东西挤 */
.head-top {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.head-name {
  overflow: hidden;
  font-size: var(--fs-base);
  font-weight: 600;
  color: var(--text);
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* 这一轮的情绪。做成一枚小药丸而不是一行字 ——
   实心边界说明"这不是它说的话",它是关于这段话的元数据。
   刻意不上色:与站内克制的灰度一致,情绪由词本身表达 */
.mood {
  flex: none;
  padding: 1px 8px;
  border-radius: 999px;
  background: var(--bg-elev);
  color: var(--text-3);
  font-size: var(--fs-micro);
  font-weight: 600;
  /* key 绑在词上:词一变就换一个节点,这段入场动画于是重播一次 ——
     情绪变了该被看见,而不是悄无声息地换个字 */
  animation: mood-in 280ms var(--ease) both;
}
@keyframes mood-in {
  from {
    opacity: 0;
    transform: translateY(-3px) scale(0.92);
  }
}
@media (prefers-reduced-motion: reduce) {
  .mood {
    animation: none;
  }
}
.head-sub {
  overflow: hidden;
  max-width: 46ch;
  font-size: var(--fs-xs);
  color: var(--text-3);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.chat-menu-wrap {
  position: relative;
  flex: none;
  margin-left: auto;
}
.icob {
  display: grid;
  place-items: center;
  width: 40px;
  height: 40px;
  border: 0;
  border-radius: 999px;
  background: none;
  color: var(--text-2);
  cursor: pointer;
  transition: background var(--dur) var(--ease);
}
.icob:hover {
  background: var(--surface-hover);
}
.icob svg {
  font-size: 18px;
}
.chat-menu {
  position: absolute;
  top: calc(100% + 6px);
  right: 0;
  z-index: 20;
  min-width: 190px;
  padding: 5px;
  border: 1px solid var(--line);
  border-radius: var(--r-sm);
  background: var(--surface);
  box-shadow: var(--sh-md);
}
.chat-menu button {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  width: 100%;
  min-height: 36px;
  padding: 0 10px;
  border: 0;
  border-radius: var(--r-sm);
  background: none;
  color: var(--text);
  font-size: var(--fs-sm);
  text-align: left;
  cursor: pointer;
}
.chat-menu button:hover:not(:disabled) {
  background: var(--surface-hover);
}
.chat-menu button:disabled {
  color: var(--text-4);
  cursor: default;
}

/* ===== 消息流 ===== */
.chat-stream {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: var(--sp-4) var(--sp-4) var(--sp-3);
  /* 纵向 flex 是为了让里面的空态能撑满整格并居中 ——
     空态用 flex:1,而块级父容器下 flex:1 是不起作用的 */
  display: flex;
  flex-direction: column;
}
.chat-inner {
  display: flex;
  flex-direction: column;
  /* 两侧都是气泡了,间距就按"两块东西"给 —— 2px 会让相邻两个气泡粘在一起,
     看着像一个长气泡被切开 */
  gap: var(--sp-2);
  /* 铺满整块面板:不再收在中间一列里。收窄是为了"读起来舒服",
     但这块面板本来就只有一个说话对象,两侧再空出两百多像素,
     看着就是没铺满 —— 宽度交给气泡自己的 76% 上限去控 */
  width: 100%;
  /* 父级是纵向 flex:不加这一条,内容短时也会被拉着撑高 */
  flex: none;
}
.sep {
  align-self: center;
  margin: var(--sp-3) 0 var(--sp-2);
  font-size: var(--fs-micro);
  letter-spacing: 0.04em;
  color: var(--text-4);
}
.msg {
  display: flex;
  /* 竖着排,好让"被截断"那行小注落在气泡下面。
     整条靠哪一边由 .msg.user 决定 */
  flex-direction: column;
  align-items: flex-start;
}
.msg.user {
  align-items: flex-end;
}
/* 朗读那枚键贴着气泡外侧下角,绝对定位 —— 它**不该占气泡的宽度**。
   放进流里(哪怕用 opacity 藏起来)会实打实地把每个气泡压窄 40px,
   而不悬停的时候谁也看不见它,那份窄就成了一份没来由的窄 */
.msg.assistant .bubble {
  position: relative;
}
.speak-btn {
  position: absolute;
  left: 100%;
  /* 与气泡下沿对齐。40px 的触控目标比一行气泡略高,
     往上多出来的那 2px 落在消息之间那道 --sp-2 的缝里,不会压到上一条 */
  bottom: -2px;
  margin-left: 2px;
  display: grid;
  place-items: center;
  width: 40px;
  height: 40px;
  border: 0;
  border-radius: 999px;
  background: none;
  color: var(--text-4);
  cursor: pointer;
  /* 每条消息都挂着一枚喇叭会把对话流弄得很吵,所以手指悬上来它才浮出来。
     触屏没有 hover,那种设备上让它常驻但压暗一档(见下面的媒体查询) */
  opacity: 0;
  transition: opacity var(--dur) var(--ease), color var(--dur) var(--ease),
    background var(--dur) var(--ease);
}
.msg:hover .speak-btn {
  opacity: 1;
}
/* 正在念的那条常驻显示:它是"怎么让它停下来"的唯一入口,
   不该等手指找上来才出现 */
.speak-btn.on {
  opacity: 1;
  color: var(--text-2);
}
/* 还在等音频。这一档必须看得出来 —— 第三方合成要等几百毫秒到好几秒,
   而在它出声之前,"在等"和"已经念完了"长得一模一样:都是不出声。
   用呼吸动画说"我在干活"(与设定图生成中同一手法) */
.speak-btn.busy {
  animation: speak-wait 1.2s ease-in-out infinite;
}
@keyframes speak-wait {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.3;
  }
}
@media (prefers-reduced-motion: reduce) {
  .speak-btn.busy {
    animation: none;
  }
}
.speak-btn:hover {
  background: var(--accent-soft);
  color: var(--text-2);
}
.speak-btn svg {
  font-size: 15px;
}
@media (hover: none) {
  .speak-btn {
    opacity: 0.5;
  }
}
.bubble {
  max-width: 76%;
  /* 保留换行:角色可能分句写,压成一行就不是它写的样子了 */
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  padding: 9px 13px;
  border-radius: var(--r);
  font-size: var(--fs-base);
  line-height: 1.55;
  color: var(--text);
}
/* 角色那一侧:坐在站内已有的"抬起来"的底色上(输入框、标签都是它),
   不额外造一个色。靠说话人那一侧的角收窄,气泡才有"从这个人嘴里出来"的方向感 */
.msg.assistant .bubble {
  background: var(--bg-elev);
  border-bottom-left-radius: var(--r-sm);
}
/* 自己那一侧:用站内的主动色 —— 与发送键、Primary 按钮同一个 --cta。
   两侧都铺灰底是行不通的:这套调色板里几档灰差得太近,分不出谁是谁,
   而"谁说的"恰恰是对话里最不能含糊的一件事 */
.msg.user .bubble {
  background: var(--cta);
  color: var(--cta-text);
  border-bottom-right-radius: var(--r-sm);
}
/* 撞上长度上限的提示。压在气泡下面、跟气泡同一边 ——
   它说的是这一条消息,不是整段对话 */
.cut {
  margin: 3px 0 0;
  font-size: var(--fs-micro);
  color: var(--text-4);
}
/* ===== 长期记忆 =====
   虚线框是有意的:它不是对话的一部分,而是一段"关于这段对话"的派生文本 ——
   实线框会让人以为它也是一条消息 */
.memory {
  margin-bottom: var(--sp-3);
  border: 1px dashed var(--line);
  border-radius: var(--r);
}
.memory-head {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  min-height: 40px;
  padding: 0 12px;
  border: 0;
  border-radius: var(--r);
  background: none;
  color: var(--text-3);
  font-size: var(--fs-micro);
  text-align: left;
  cursor: pointer;
  transition: background var(--dur) var(--ease), color var(--dur) var(--ease);
}
.memory-head:hover {
  background: var(--accent-soft);
  color: var(--text-2);
}
.memory-head > svg {
  font-size: 14px;
}
.memory-label {
  font-weight: 600;
  letter-spacing: var(--ls-eyebrow);
  text-transform: uppercase;
}
.memory-when {
  color: var(--text-4);
}
.memory-caret {
  margin-left: auto;
  font-size: 12px;
  transition: transform var(--dur) var(--ease);
}
.memory-caret.open {
  transform: rotate(180deg);
}
.memory-text {
  margin: 0;
  padding: 0 12px;
  font-size: var(--fs-sm);
  line-height: 1.6;
  color: var(--text-2);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
/* 编辑态就地换成一只可写的框,不另起浮层 —— 这里改的只是一段文字,
   给一套弹窗+确认的仪式感,反而把它抬成了件大事 */
.memory-edit {
  padding: 0 12px;
}
.memory-input {
  display: block;
  width: 100%;
  padding: 9px 11px;
  border: 0;
  border-radius: var(--r-sm);
  background: var(--bg-elev);
  color: var(--text);
  font: inherit;
  font-size: var(--fs-sm);
  line-height: 1.6;
  /* 只放纵向:横向拉伸会顶破这张虚线卡 */
  resize: vertical;
  transition: box-shadow var(--dur) var(--ease);
}
.memory-input:focus {
  outline: none;
  box-shadow: 0 0 0 1px var(--line-strong);
}
/* 超长只在按下保存的那一刻拦。就贴在按钮上方 ——
   眼睛从框里出来,先撞到的是它 */
.memory-warn {
  margin: 6px 0 0;
  font-size: var(--fs-xs);
  color: var(--danger);
}
/* 动作行。左右留 2px 是补出来的:里头那两枚键各自有 10px 内边距,
   2 + 10 正好让按钮上的字与上面的正文对齐在同一条竖线上 */
.memory-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--sp-1);
  padding: 0 2px 4px;
}
/* 保存是这段编辑里唯一的主操作,给它实心。高度与 quiet-btn 齐平,
   两枚并排时下沿在同一条线上 */
.save-btn {
  min-height: 40px;
  padding: 0 10px;
  border: 0;
  border-radius: var(--r-sm);
  background: var(--cta);
  color: var(--cta-text);
  font-size: var(--fs-xs);
  font-weight: 600;
  cursor: pointer;
  transition: background var(--dur) var(--ease);
}
.save-btn:hover:not(:disabled) {
  background: var(--cta-hover);
}
/* 与发送键同一条规矩:不可用时用同族淡底,不用半透明黑(叠色会发脏) */
.save-btn:disabled {
  background: var(--accent-soft);
  color: var(--text-4);
  cursor: default;
}
/* 往前翻的入口。同样做成一条细字:它是一次翻页,不是一个动作按钮 */
.earlier {
  display: flex;
  justify-content: center;
  margin-bottom: var(--sp-2);
}
.earlier-btn {
  min-height: 40px;
  padding: 0 12px;
  border: 0;
  border-radius: var(--r-sm);
  background: none;
  color: var(--text-3);
  font-size: var(--fs-xs);
  cursor: pointer;
  transition: color var(--dur) var(--ease), background var(--dur) var(--ease);
}
.earlier-btn:hover {
  background: var(--accent-soft);
  color: var(--text);
}
/* 流式光标:用 CSS 画,不用图片/GIF(与设定图生成中的停止符号同一手法) */
.cursor {
  display: inline-block;
  width: 7px;
  height: 1em;
  margin-left: 2px;
  vertical-align: -0.15em;
  border-radius: 2px;
  background: var(--text-3);
  animation: cursor-breathe 1.1s ease-in-out infinite;
}
@keyframes cursor-breathe {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.25;
  }
}
@media (prefers-reduced-motion: reduce) {
  .cursor {
    animation: none;
  }
}
/* 重新生成是这一页最次要的动作 —— 它不该和对话争视线。
   做成一枚无底无边的细文字:眼睛扫过去几乎不占用注意力,
   但可点高度仍给到 40px,手按得着 */
.regen {
  display: flex;
  margin-top: var(--sp-1);
}
/* "最次要的动作"的统一长相:无底无边的一行细字,悬停才浮出淡底。
   重新生成与"改记忆"都用它 —— 它们都是"这一页顺带能做的事",
   做成按钮会和对话本身抢视线。
   可点高度仍留 40px:眼睛不被打断,手指按得着 */
.quiet-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  min-height: 40px;
  padding: 0 10px;
  border: 0;
  border-radius: var(--r-sm);
  background: none;
  color: var(--text-4);
  font-size: var(--fs-xs);
  cursor: pointer;
  transition: color var(--dur) var(--ease), background var(--dur) var(--ease);
}
.quiet-btn:hover {
  background: var(--accent-soft);
  color: var(--text-2);
}
.quiet-btn svg {
  font-size: 13px;
}
/* 破坏性的那一枚:平时与别的次要动作长得一模一样,只有手指真的悬上去
   才染成危险色 —— 它不该在静止时和"改一改"争同等分量。
   底色用与 --danger 同族的淡底(见 .compose-warn),不用半透明红 */
.quiet-btn.danger:hover {
  background: color-mix(in oklch, var(--danger) 8%, transparent);
  color: var(--danger);
}

/* ===== 输入区 ===== */
.chat-compose {
  flex: none;
  /* 给下面那枚"回到最新"当定位参照 —— 它挂在 bottom: 100% 上,
     也就是正好压在输入区的上沿 */
  position: relative;
  /* 底部留得比别处多:输入框是一张浮起来的卡片,投影要有地方落下去 */
  padding: var(--sp-3) var(--sp-4) var(--sp-5);
  /* 这里刻意没有分隔线 —— 卡片的边界由它自己的投影给出,
     再加一条通栏的横线就是两套边界在打架 */
}
/* 回到最新。用户往上翻的时候,底下长出来的东西他看不见 ——
   自动跟随刻意不拽他(见 .chat-stream 的 onUpdated),
   那就得给一个回去的入口,否则只能自己一路滚到底 */
.jump {
  position: absolute;
  left: 0;
  right: 0;
  /* 100% = 输入区的上沿。输入区高矮会变(超长警告、没配模型那块),
     贴在这里就不必跟着改 */
  bottom: 100%;
  display: flex;
  justify-content: center;
  padding-bottom: 10px;
  /* 只让按钮自己接收点击:这一层横跨整宽,接着会把下面的消息挡住 */
  pointer-events: none;
  z-index: 3;
}
.jump-btn {
  pointer-events: auto;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 32px;
  padding: 0 14px;
  /* 与输入框那张卡片同一套做法:淡底 + 一圈极淡的边 + 一层弥散影。
     影用 --sh-sm 而不是 --sh-md —— 后者是给大块悬浮组件的
     (20px 偏移 + 60px 模糊),套在一个 32px 的药丸上会糊成一团 */
  border: 1px solid var(--line);
  border-radius: 999px;
  background: var(--bg-elev);
  box-shadow: var(--sh-sm);
  color: var(--text-2);
  font: inherit;
  font-size: var(--fs-xs);
  font-weight: 600;
  cursor: pointer;
  transition: color 160ms var(--ease), background 160ms var(--ease);
}
.jump-btn svg {
  width: 14px;
  height: 14px;
}
.jump-btn:hover {
  color: var(--text-1);
  background: var(--surface-hover);
}
/* —— 附图 —— */
/* 待发的那张。压在输入框上面,宽度收到图片本身那么大 ——
   这么定是为了让右上角那枚取消键有地方可贴 */
.attach {
  position: relative;
  display: inline-block;
  margin-bottom: var(--sp-2);
}
.attach img {
  display: block;
  max-width: 132px;
  max-height: 132px;
  border-radius: var(--r-sm);
  border: 1px solid var(--line);
  object-fit: cover;
}
/* 取消。给一块深色玻璃底:图什么颜色都可能,只在图上描一圈边的话,
   压在浅色区域上就看不见了 */
.attach-x {
  position: absolute;
  top: 6px;
  right: 6px;
  display: grid;
  place-items: center;
  width: 24px;
  height: 24px;
  border: 0;
  border-radius: 50%;
  background: rgba(16, 16, 18, 0.72);
  color: #fff;
  cursor: pointer;
  transition: background var(--dur) var(--ease);
}
.attach-x:hover {
  background: rgba(16, 16, 18, 0.9);
}
.attach-x svg {
  width: 13px;
  height: 13px;
}
/* 附图键。与发送键同高同圆,但不涂实心 —— 同一个格子里它是次操作,
   涂黑的那一枚永远留给"把这句话发出去" */
.img-btn {
  flex: none;
  display: grid;
  place-items: center;
  width: 40px;
  height: 40px;
  border: 0;
  border-radius: 999px;
  background: none;
  color: var(--text-3);
  cursor: pointer;
  transition: color var(--dur) var(--ease), background var(--dur) var(--ease);
}
.img-btn:hover:not(:disabled) {
  color: var(--text);
  background: var(--bg-elev);
}
.img-btn:disabled {
  opacity: 0.4;
  cursor: default;
}
.img-btn svg {
  width: 19px;
  height: 19px;
}
/* 气泡里的图。圆角比气泡小一档,压在文字上方 */
.bubble-img {
  display: block;
  max-width: 100%;
  max-height: 320px;
  margin-bottom: 8px;
  border-radius: 12px;
  object-fit: cover;
}

.compose-box {
  display: flex;
  align-items: flex-end;
  gap: var(--sp-2);
  width: 100%;
  /* 横向左右都是 12px:左边给文字留呼吸,右边给发送键留同样一档 ——
     两边不一样宽,一条铺满全宽的卡片会把那点偏差放大成"歪"。
     纵向 6px:卡里只有一行字,而发送键自己有 40px,
     再厚的上下留白只是把卡片撑高 */
  padding: 6px 12px;
  border: 0;
  /* 圆角用 --r(16px),不用 --r-lg(24px):后者是给 Studio 那个"有厚度的
     提示词编辑器"定的。这张卡片铺满整块面板又只有一行高,
     24px 会让两端看起来各是半个圆 —— 整块变成一根横贯全宽的胶囊。
     16px 与气泡同档,两者才像同一套东西 */
  border-radius: var(--r);
  background: var(--surface);
  /* 悬浮卡片:白底 + 一圈极淡的边 + 一层弥散影。
     边用 box-shadow 补而不是 border —— border 会让里面整行文字在切换时挪一下 */
  box-shadow: 0 0 0 1px var(--line), var(--sh-sm);
  transition: box-shadow var(--dur) var(--ease);
}
.compose-box:hover {
  box-shadow: 0 0 0 1px var(--line), var(--sh-md);
}
/* 聚焦时把卡片再抬高一档:焦点本来就该看得出来 */
.compose-box:focus-within,
.compose-box:focus-within:hover {
  box-shadow: 0 0 0 1px var(--line-strong), var(--sh-md);
}
.compose-box textarea {
  flex: 1;
  min-width: 0;
  max-height: 132px;
  /* 单行时的高度 = 22(行高) + 18(上下内边距) = 40,与发送键一模一样高,
     两者的中线才对得齐 */
  padding: 9px 0;
  border: 0;
  background: none;
  color: var(--text);
  font-family: inherit;
  /* 与气泡里的正文同号:自己打的字和它说的话一样大。
     16px 那一档留给窄屏 —— 见下面媒体查询里的说明 */
  font-size: var(--fs-base);
  line-height: 22px;
  resize: none;
  overflow-y: auto;
}
.compose-box textarea:focus {
  outline: none;
}
.compose-box textarea::placeholder {
  color: var(--text-4);
  transition: color var(--dur) var(--ease);
}
/* 一进来就把提示语提亮一档:它是"这里可以说话"的唯一提示 */
.compose-box:focus-within textarea::placeholder {
  color: var(--text-3);
}
.send-btn {
  flex: none;
  display: grid;
  place-items: center;
  width: 40px;
  height: 40px;
  border: 0;
  border-radius: 999px;
  background: var(--cta);
  color: var(--cta-text);
  cursor: pointer;
  transition: background var(--dur) var(--ease), opacity var(--dur) var(--ease);
}
.send-btn:hover:not(:disabled) {
  background: var(--cta-hover);
}
/* 不可用时不给"半透明的黑":叠色之后会发脏,而且那一枚仍然像个实心按钮。
   换成与浅底同族的淡底 —— 它是"还没到能发的时候",不是"坏掉了" */
.send-btn:disabled {
  background: var(--accent-soft);
  color: var(--text-4);
  cursor: default;
}
.send-btn svg {
  font-size: 18px;
}
/* 停止符号也用 CSS 画(与光标同一条理由) */
.stop-sq {
  width: 11px;
  height: 11px;
  border-radius: 2px;
  background: currentColor;
}
/* 超长的提示。它顶掉的是输入卡片的位置,所以样式也做成"卡片那一格"
   —— 高度与卡片一致,底下的投影空间不动,切换时页面不跳 */
.compose-warn {
  display: flex;
  align-items: center;
  width: 100%;
  min-height: 52px;
  margin: 0;
  padding: 0 12px;
  border-radius: var(--r);
  background: color-mix(in oklch, var(--danger) 8%, transparent);
  color: var(--danger);
  font-size: var(--fs-sm);
}
.compose-off {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--sp-2);
  padding: 0 6px;
  font-size: var(--fs-sm);
  color: var(--text-3);
}
.compose-off svg {
  font-size: 16px;
}

/* ===== 空态 ===== */
.chat-empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--sp-2);
  padding: var(--sp-6);
  text-align: center;
}
.chat-empty.is-inside {
  /* 父级(.chat-stream)是纵向 flex,flex:1 就能撑满整格并居中 */
  flex: 1;
}
.empty-ava {
  display: grid;
  place-items: center;
  width: 64px;
  height: 64px;
  overflow: hidden;
  margin-bottom: var(--sp-2);
  border-radius: 999px;
  background: var(--bg-elev);
  color: var(--text-3);
}
.empty-ava img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.empty-ava svg {
  font-size: 28px;
}
.empty-title {
  margin: 0;
  font-size: var(--fs-lg);
  font-weight: 600;
  color: var(--text);
}
.empty-sub {
  margin: 0;
  max-width: 44ch;
  font-size: var(--fs-sm);
  line-height: 1.6;
  color: var(--text-3);
}

.ed-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  flex: none;
  margin-top: var(--sp-2);
  min-height: 40px;
  padding: 9px 14px;
  border: 1px solid var(--line);
  border-radius: 999px;
  background: none;
  color: var(--text-2);
  font-size: var(--fs-sm);
  font-weight: 500;
  cursor: pointer;
  transition: border-color var(--dur) var(--ease), color var(--dur) var(--ease),
    background var(--dur) var(--ease);
}
.ed-btn:hover {
  border-color: var(--line-strong);
  color: var(--text);
}
.ed-btn.primary {
  border-color: var(--cta);
  background: var(--cta);
  color: var(--cta-text);
}
.ed-btn.primary:hover {
  border-color: var(--cta-hover);
  background: var(--cta-hover);
}

/* ===== 窄屏的角色浮层 ===== */
.picker {
  position: fixed;
  inset: 0;
  z-index: 50;
  display: grid;
  place-items: center;
  padding: var(--sp-4);
  /* 与设定图查看器同一套:固定深色 + 模糊,与主题无关 */
  background: rgba(16, 16, 18, 0.86);
  -webkit-backdrop-filter: blur(20px);
  backdrop-filter: blur(20px);
}
.picker-box {
  width: min(420px, 100%);
  max-height: 70vh;
  overflow-y: auto;
  padding: var(--sp-3);
  border-radius: var(--r);
  background: var(--surface);
}
/* 浮层本身只是个容器(焦点先落在这里,好让读屏念出"这是什么"),
   围着它画一圈焦点框是噪声 —— 下一次 Tab 就进到条目上了 */
.picker-box:focus {
  outline: none;
}

/* ===== 窄屏 ===== */
@media (max-width: 860px) {
  .chat {
    /* 左栏收起,只剩一列。高度算式与桌面同一条,不另写 ——
       多减一次反而会把面板压短,底下空出一条 */
    grid-template-columns: minmax(0, 1fr);
  }
  .chat-rail {
    display: none;
  }
  .head-solo {
    display: none;
  }
  .head-pick {
    display: inline-flex;
  }
  .chat-stream {
    padding: var(--sp-4) var(--sp-3) var(--sp-3);
  }
  .chat-compose {
    padding: var(--sp-3) var(--sp-3) var(--sp-5);
    /* iPhone 底部横条:不加这一段,输入框会被那条横条压住 */
    padding-bottom: calc(var(--sp-5) + env(safe-area-inset-bottom));
  }
  /* 窄屏下 76% 太窄,读起来一直在换行 */
  .bubble {
    max-width: 88%;
  }
  /* 窄屏才把输入框字号提回 16px:低于这个值 iOS Safari 聚焦时会放大整页
     (站内硬约束,见 style.css 的 --fs-lg)。桌面没有这个问题,
     所以那一档只在需要它的地方出现 */
  .compose-box textarea {
    font-size: var(--fs-lg);
  }
}
</style>
