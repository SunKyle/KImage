import { ref, toRaw, watch } from 'vue'
import {
  CHAT_EXPORT_MSGS,
  CHAT_SUMMARIZE_AFTER,
  CHAT_SUMMARY_CAP,
  CHAT_WINDOW,
  summarizeChat,
  uid
} from '../api'
import {
  CHAT_PAGE,
  countChatMessages,
  deleteChatImage,
  deleteChatOf,
  getChatImage,
  getChatMessages,
  getChatMessagesToSummarize,
  getChatSummary,
  getLastChatLine,
  putChatMessage,
  putChatSummary
} from '../lib/idb'
import { stopSpeaking } from '../lib/speech'
import type { ApiConfig, Character, ChatMessage, ChatSummary, ImportedChat } from '../types'

/* ===== 角色对话：消息、长期记忆、以及读写 ==============================
   一期一个角色一条连续对话,所以状态都按 charId 索引(没有 sessionId)。
   这里搬的是**非流式**的那一半:读取与分页、记忆的压缩与编辑、清空、
   导入导出。真正的流式一轮(runChat / sendChat / regenerate / stop)
   留在主界面 —— 它要动出图配置、角色参考图与请求中断,归属还没定清。
   -------------------------------------------------------------------- */

export interface ChatDeps {
  characters: { value: Character[] }
  /** 当前生效的文本模型:压缩记忆要用它 */
  textConfig: { value: ApiConfig | null }
  notice: { value: string }
  announce: (kind: 'chat', charId?: string) => void
  scheduleUndo: (item: { label: string; undo: () => void; purge: () => void }) => void
}

export function useChat(deps: ChatDeps) {
const chatCharId = ref('')
/* 已取到的消息,按角色 id 缓存。进对话页时才读,启动时不碰。
   注意这里装的是**最近一档**(见 idb.ts 的 CHAT_PAGE),不是全部历史 */
const chatMessages = ref<Record<string, ChatMessage[]>>({})
/* 前面还有更早的没读。界面据此决定要不要给"加载更早" ——
   没有它就分不清"这是第一句"和"只读到这里" */
const chatHasMore = ref<Record<string, boolean>>({})
/* 长期记忆:滑出窗口的消息压成的一段简报,按角色各一份。
   有没有这个键 = 这个角色压过没有 */
const chatSummary = ref<Record<string, ChatSummary>>({})
/* 每个角色的**最后一条**消息,只用来喂左栏(摘要那一行 + 最近活跃排序)。
   单独存一份是因为消息是按角色懒加载的:没打开过的角色 chatMessages 里没有键,
   左栏就会把它当成"从没聊过" —— 明明聊过,却显示 No messages yet 并排到最后。
   取法见 idb.ts 的 getLastChatLine,代价与消息条数无关 */
const chatLast = ref<Record<string, ChatMessage>>({})
/* 正在压记忆的角色。压缩是后台动作,但同一个角色不该叠两个 */
const chatSummarizing = new Set<string>()
/* "这段对话还作数吗"的代次。压缩是异步的,回来时得知道这期间它有没有被清掉 ——
   不查的话,一次后台整理会把用户刚清掉的记忆又写回去。
   与角色起稿的 draftSeq 是同一套做法:对不上就整份丢弃 */
const chatSeq = new Map<string, number>()
function bumpChatSeq(id: string) {
  chatSeq.set(id, (chatSeq.get(id) || 0) + 1)
}
/* 各角色正在生成中(没有该角色的键 = 空闲) */
const chatBusy = ref<Record<string, boolean>>({})
/* 一轮对话的中断手柄,按角色各存一个 —— 与 charViewControllers 同一个理由 */
const chatControllers = new Map<string, AbortController>()
/* 正在读取的角色。同一 id 可能被两处同时触发(选角色的 watch 与角色页的入口) */
const chatLoading = new Map<string, Promise<void>>()
// 七个平级页面:首页 / 角色 / 对话 / 画布 / 提示词库 / 历史记录 / 接口设置,同时只挂载一个
async function readChatForExport(id: string): Promise<ImportedChat> {
  const [sum, page] = await Promise.all([
    chatSummary.value[id] ? Promise.resolve(chatSummary.value[id]) : getChatSummary(id),
    getChatMessages(id, CHAT_EXPORT_MSGS)
  ])
  const messages = page.list.map((m) => ({
    role: m.role,
    content: m.content,
    createdAt: m.createdAt,
    ...(m.stopped ? { stopped: true } : {}),
    ...(m.truncated ? { truncated: true } : {}),
    ...(m.mood ? { mood: m.mood } : {}),
    ...(m.imageId ? { imageId: m.imageId } : {}),
    /* 角色发的那张也要带走。**两条都要**:漏了 photo 这枚标记,
       导进来的记录会少一张图;漏了 photoId 就只剩一句"我给你看个东西" */
    ...(m.photo ? { photo: m.photo } : {}),
    ...(m.photoId ? { photoId: m.photoId } : {})
  }))
  /* 附图一起带走。**缺了它们,对方拿到的是一串"不知道在说什么的回复"** ——
     消息在,而消息指着的那张图不在。读不回来的那张跳过:
     少一张图不该让整份导出失败 */
  const ids = [
    ...new Set(
      messages
        .flatMap((m) => [m.imageId, m.photoId])
        .filter((x): x is string => !!x)
    )
  ]
  const images: Array<{ id: string; blob: Blob }> = []
  for (const imgId of ids) {
    const rec = await getChatImage(imgId)
    if (rec) images.push({ id: imgId, blob: rec.blob })
  }
  return {
    messages,
    // 忘掉过的角色导出的就是空串(库里那条正文为空),包里也就不带记忆
    memory: sum?.text || '',
    ...(images.length ? { images } : {})
  }
}

/** 把角色包里带回来的那段对话写进库。
 *
 *  消息 id 一律换新(与角色 id 同一条理由:不沿用文件里的标识)。
 *  记忆则按**收到的这些消息**重新对游标 —— 不能照抄包里那份:
 *  那些 id 与时间戳在本地已经不成立,照抄会让下一轮压缩要么把导入的这段
 *  整段重新压一遍,要么一条都不压。 */
async function writeImportedChat(charId: string, chat: ImportedChat) {
  const msgs: ChatMessage[] = chat.messages.map((m) => ({ id: uid(), charId, ...m }))
  for (const m of msgs) await putChatMessage(m)
  if (!chat.memory) return
  const last = msgs[msgs.length - 1]
  await putChatSummary({
    charId,
    text: chat.memory,
    upToId: last?.id || '',
    upToAt: last?.createdAt || 0,
    covered: msgs.length,
    /* 这份记忆是跟着包过来的,不是此刻压出来的。界面上那行"多久没动过"
       显示的是它落到这台机器上的时间 —— 除此之外没有更早的时刻可写 */
    updatedAt: Date.now()
  })
}

async function loadChatLast() {
  const ids = deps.characters.value.map((c) => c.id)
  if (!ids.length) return
  const got = await getLastChatLine(ids)
  if (!got.size) return
  const next = { ...chatLast.value }
  for (const [id, msg] of got) {
    const known = next[id]
    if (!known || known.createdAt < msg.createdAt) next[id] = msg
  }
  chatLast.value = next
}

/* 说完一句就地把左栏那行更新掉,不必整批重读 */
function setChatLast(id: string, msg: ChatMessage) {
  chatLast.value = { ...chatLast.value, [id]: msg }
}
/* 清空/删除之后要把那行也撤掉,否则左栏还留着已经不存在的摘要 */
function dropChatLast(id: string) {
  if (!chatLast.value[id]) return
  const next = { ...chatLast.value }
  delete next[id]
  chatLast.value = next
}

/** 取某个角色的对话。与 loadCharViews 同一套懒加载 + 去重:
 *  同一个 id 可能被选角色的 watch 与角色页的入口同时触发 */
async function loadChatMessages(id: string) {
  if (!id || chatMessages.value[id]) return
  const inflight = chatLoading.get(id)
  if (inflight) return inflight
  const task = (async () => {
    try {
      /* 消息与记忆一起取:两者是同一屏的两半,
         分两趟只会让记忆晚一拍出现 */
      const [page, sum] = await Promise.all([getChatMessages(id, CHAT_PAGE), getChatSummary(id)])
      chatMessages.value = { ...chatMessages.value, [id]: page.list }
      chatHasMore.value = { ...chatHasMore.value, [id]: page.hasMore }
      if (sum) chatSummary.value = { ...chatSummary.value, [id]: sum }
    } finally {
      chatLoading.delete(id)
    }
  })()
  chatLoading.set(id, task)
  return task
}
watch(chatCharId, (id) => {
  if (id) loadChatMessages(id)
})

/**
 * 往前再读一档。**这只是显示上限,库里一条都没少** ——
 * 和"清空"完全是两回事,所以它不该有任何破坏性的味道。
 *
 * 这里不走 loadChatMessages:它会把内存里那份整个换掉,
 * 而读的这段时间里可能刚说完一句 —— 用库里那份盖上去就把新句子抹了。
 * 所以按 id 并一遍:老的在前面,内存里那份新的接在后面。
 */
async function loadEarlierChat(id: string) {
  if (!chatHasMore.value[id] || chatLoading.has(id)) return
  const cur = chatMessages.value[id] || []
  const task = (async () => {
    try {
      const { list, hasMore } = await getChatMessages(id, cur.length + CHAT_PAGE)
      const seen = new Set(list.map((m) => m.id))
      chatMessages.value = {
        ...chatMessages.value,
        [id]: [...list, ...cur.filter((m) => !seen.has(m.id))].sort(
          (a, b) => a.createdAt - b.createdAt
        )
      }
      chatHasMore.value = { ...chatHasMore.value, [id]: hasMore }
    } finally {
      chatLoading.delete(id)
    }
  })()
  chatLoading.set(id, task)
  return task
}

/**
 * 看一眼要不要把滑出窗口的消息压进记忆 —— 每一轮说完之后顺手跑,不挡用户看回复。
 *
 * "该不该压"由三个数算出来:**总条数 − 窗口大小 − 已覆盖条数**。
 * 减掉窗口,是因为最近那些条本来就还在上下文里,压了也是白压;
 * 结果够 CHAT_SUMMARIZE_AFTER 才值得花一次调用。
 *
 * 全程静默:它是一次后台整理,失败就从这一轮退出,covered 不推进,
 * 下一轮再试 —— 不弹提示,也不会因此丢东西。
 */
async function maybeSummarize(id: string) {
  const cfg = deps.textConfig.value
  if (!cfg || chatSummarizing.has(id)) return
  chatSummarizing.add(id)
  const seq = chatSeq.get(id) || 0
  try {
    const cur = chatSummary.value[id]
    const total = await countChatMessages(id)
    const want = total - CHAT_WINDOW - (cur?.covered || 0)
    if (want < CHAT_SUMMARIZE_AFTER) return

    /* 由旧往新收。收多少条正是上面那个 want(封顶 CHAT_SUMMARY_CAP),
       这样算出来的边界刚好落在"最近窗口"前面,窗口里的原话一句都不会被压掉 */
    const batch = await getChatMessagesToSummarize(
      id,
      cur?.upToAt || 0,
      Math.min(want, CHAT_SUMMARY_CAP)
    )
    if (!batch.length) return

    const text = await summarizeChat(cfg, cur?.text || '', batch)
    /* 这期间对话被清掉过(或角色被删)就别写了 ——
       否则一次后台整理会把用户刚清掉的记忆又请回来 */
    if ((chatSeq.get(id) || 0) !== seq) return

    /* 这期间用户亲手改过记忆:他写的那个版本,比这轮重回炉压出来的更算数。
       这一轮就丢掉 —— covered 没动,消息一条不少,下一轮连着他的新版本一起再压 */
    if ((chatSummary.value[id]?.text || '') !== (cur?.text || '')) return

    const last = batch[batch.length - 1]
    const next: ChatSummary = {
      charId: id,
      text,
      upToId: last.id,
      upToAt: last.createdAt,
      covered: (cur?.covered || 0) + batch.length,
      updatedAt: Date.now()
    }
    await putChatSummary(next)
    chatSummary.value = { ...chatSummary.value, [id]: next }
  } catch {
    /* 见上:后台整理失败不打扰用户 */
  } finally {
    chatSummarizing.delete(id)
  }
}

/** 用户亲手改那段记忆。
 *  只换正文:upToAt / covered 说的是"哪些消息已经进去过了",
 *  改几个字不改变这件事 —— 动了它们,下一轮会把老消息重新压一遍。
 *  updatedAt 跟着刷,因为界面拿它显示"多久没动过了":
 *  用户刚写完的这一版,就不该还挂着"3 天前" */
async function editChatSummary(id: string, text: string) {
  const cur = chatSummary.value[id]
  if (!cur) return
  const next: ChatSummary = { ...cur, text, updatedAt: Date.now() }
  chatSummary.value = { ...chatSummary.value, [id]: next }
  await putChatSummary(next)
  // 另一个标签页里的这个角色也该按新记忆说话
  deps.announce('chat', id)
}

/** 忘掉这段记忆。**消息一条都不删** —— "角色不再记得"和"这事发生过"是两回事,
 *  那份原文还在库里,想回看随时能往上翻。
 *
 *  关键在于**不能只把正文清空**。压缩是从 upToAt 之后接着取的:
 *  正文一空而游标没动,下一轮就会把刚忘掉的那段重新压回来 —— 等于没忘。
 *  所以连游标一起推到最后一条:忘掉的那一段从此不再进记忆,
 *  而**在这之后**说的新话照常重新积累起来。
 *  记录本身留着(正文为空),因为那个"从哪之后不再记得"的游标得有地方待;
 *  界面据此不再显示记忆块(见 ChatPage 的 hasMemory)。 */
async function forgetChatSummary(id: string) {
  const before = chatSummary.value[id]
  const list = chatMessages.value[id] || []
  const last = list[list.length - 1]
  if (!before || !last) return
  /* 在途的压缩要是正跑着,回来会把记忆写回来 —— 作废那一轮 */
  bumpChatSeq(id)
  const total = await countChatMessages(id)
  const next: ChatSummary = {
    charId: id,
    text: '',
    /* covered 与 upToAt 一起推平到"最后一条为止"。
       covered 宁可算多一点:多算了只是下一轮少压一次,
       算少了会把已经忘掉的那段重新捞回来 */
    upToId: last.id,
    upToAt: last.createdAt,
    covered: total,
    updatedAt: Date.now()
  }
  chatSummary.value = { ...chatSummary.value, [id]: next }
  /* 与"清空对话"不同,这一步**立刻落盘**:忘掉就该马上生效,
     而且只有一条记录,写它不心疼。撤销再把老的那版写回去 */
  await putChatSummary(next)
  // 另一页里的这个角色不该再提起刚被忘掉的那一段
  deps.announce('chat', id)
  deps.scheduleUndo({
    label: 'Memory forgotten',
    undo: () => {
      chatSummary.value = { ...chatSummary.value, [id]: before }
      void putChatSummary(before)
    },
    /* 上面已经落过笔了,窗口结束没有别的事要做 ——
       记忆是模型生成的,撤销窗口一过就真的找不回来了 */
    purge: () => {}
  })
}

/** 进对话页时挑一个角色:留着上次那个(还在的话),否则取列表第一个。
 *  一个角色都没有时保持空 —— 页面自己会给"先去建一个"的空态 */
function clearChat(id: string) {
  const list = chatMessages.value[id] || []
  const beforeSummary = chatSummary.value[id]
  const beforeLast = chatLast.value[id]
  if (!list.length && !beforeSummary) return
  // 正在说话的先掐掉,否则它会往上文里补一句刚落空的消息
  chatControllers.get(id)?.abort()
  /* 正在念的那句也一起停:它念的正是一条马上就不存在的消息 */
  stopSpeaking()
  /* 也让在途的压缩作废:它回来时这段对话已经不是原来那段了 */
  bumpChatSeq(id)
  const before = list.map((m) => ({ ...toRaw(m) }))
  // 清空之后前面当然没有更早的了,顺手把"加载更早"收掉
  const hadMore = !!chatHasMore.value[id]
  chatMessages.value = { ...chatMessages.value, [id]: [] }
  chatHasMore.value = { ...chatHasMore.value, [id]: false }
  /* 屏幕上是立刻空的,但库里要等撤销窗口结束才真清(见下面的 purge),
     所以广播放在 purge 里 —— 提前广播的话,另一页会在我们还能撤销时
     就把这段对话当成不存在了 */

  /* 记忆必须跟着一起清 —— 消息没了而记忆还留着,下一句开口就会提起
     一段用户刚刚清掉的旧事,那比失忆更糟 */
  const sumRest = { ...chatSummary.value }
  delete sumRest[id]
  chatSummary.value = sumRest
  // 左栏那行也得跟着空掉,不然它还挂着一段已经不存在的对话
  dropChatLast(id)
  deps.scheduleUndo({
    label: 'Conversation cleared',
    undo: () => {
      chatMessages.value = { ...chatMessages.value, [id]: before }
      chatHasMore.value = { ...chatHasMore.value, [id]: hadMore }
      if (beforeSummary) chatSummary.value = { ...chatSummary.value, [id]: beforeSummary }
      if (beforeLast) setChatLast(id, beforeLast)
      /* 撤销要立刻落盘:窗口里别的操作可能已经把"它是空的"写进去了 */
      void (async () => {
        await deleteChatOf(id)
        for (const m of before) await putChatMessage(m)
        if (beforeSummary) await putChatSummary(beforeSummary)
      })()
    },
    purge: () => {
      /* 附过的图也跟着走(与 deleteChar 同一处说明)。
         这里用它开头取的那份 list —— purge 执行时 chatMessages 里
         那一份已经被清空了,问不出来 */
      for (const m of list) {
        if (m.imageId) void deleteChatImage(m.imageId)
      }
      void deleteChatOf(id)
      // 到这里这一整段对话才算真的没了 —— 撤销窗口里它还在,另一页不该先清掉
      deps.announce('chat', id)
    }
  })
}

  return {
    chatCharId,
    chatMessages,
    chatHasMore,
    chatSummary,
    chatLast,
    chatBusy,
    chatControllers,
    bumpChatSeq,
    loadChatLast,
    setChatLast,
    dropChatLast,
    loadChatMessages,
    loadEarlierChat,
    maybeSummarize,
    editChatSummary,
    forgetChatSummary,
    readChatForExport,
    writeImportedChat,
    clearChat
  }
}
