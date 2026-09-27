// 极简 IndexedDB 封装:用来持久化历史记录与提示词封面(比 localStorage 容量大得多)
const DB_NAME = 'kimage.db'
const STORE = 'history'
/* 提示词封面单独一个 store。它们原来是 base64 塞在 localStorage 条目里的,
   而 localStorage 一共只有约 5MB —— 五六十张封面就顶到天花板,写不下时
   只能把所有封面整批丢掉(见 git 历史的 savePrompts)。挪到这里之后,
   封面与历史图共用浏览器级配额,那个"整批丢封面"的降级路径也就不需要了 */
const COVER_STORE = 'covers'
/* ===== 历史容量 =====================================================
   不按固定条数淘汰,而是看浏览器给的配额:只有占用接近上限时才清理最旧的一批。
   固定条数会在空间还很宽裕时就静默删记录,而每条记录的体积差很多,
   「50 条」到底占多少空间其实无从预估。
   拿不到配额信息(旧浏览器/隐私模式)时退回条数兜底,避免历史无限增长。
   ------------------------------------------------------------------ */
/** 占用超过这条水位线才开始清理 */
const HIGH_WATER = 0.8
/** 一次清掉最旧的这个比例:0.8 × (1 − 0.3) ≈ 0.56,能压回水位线以下 */
const PRUNE_RATIO = 0.3
/** 无论如何都至少留这么多条,避免把历史清空 */
const MIN_KEEP = 20
/** 拿不到配额信息时的兜底上限 */
const HARD_LIMIT = 500

export interface PruneResult {
  /** 清掉了几条 */
  removed: number
  /** 被清掉的记录 id:界面据此把内存里的条目一并摘掉,并释放其图片地址 */
  removedIds: string[]
  /** 清理前的占用比例,用于向用户解释为什么会清 */
  usageRatio: number
}

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 3)
    req.onupgradeneeded = () => {
      const db = req.result
      const tx = req.transaction
      if (!tx) return
      const store = db.objectStoreNames.contains(STORE)
        ? // 从 v1 升上来时 store 已存在,从升级事务里取出来补索引
          tx.objectStore(STORE)
        : db.createObjectStore(STORE, { keyPath: 'id' })
      // createdAt 索引让"淘汰最旧"只需读主键,不必把整表记录读出来
      if (!store.indexNames.contains('createdAt')) store.createIndex('createdAt', 'createdAt')
      // v3 新增:提示词封面
      if (!db.objectStoreNames.contains(COVER_STORE)) {
        db.createObjectStore(COVER_STORE, { keyPath: 'id' })
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

/* 申请持久化存储。不申请的话,浏览器在磁盘吃紧时可以把整个 origin 的数据清掉,
   而这里存的正是用户唯一的作品与提示词库。浏览器多半要求"这个站点正在被使用"
   才给,所以在第一次真正写入时申请,不在启动时空喊。
   结果不往上抛:它只影响"磁盘满时会不会被回收",而这件事在正常使用中不该打断用户 */
let askedPersist = false
export async function ensurePersisted(): Promise<boolean> {
  if (askedPersist) return true
  askedPersist = true
  try {
    if (await navigator.storage?.persisted?.()) return true
    return (await navigator.storage?.persist?.()) ?? false
  } catch {
    return false
  }
}

/* ===== 提示词封面 =====
   存的是原图(仅长边超 1600 时缩一次),不是缩略图。用 Blob 不用 data URL:
   base64 会膨胀 33%,而且整段字符串要进 JS 堆;Blob 由浏览器放在堆外。
   封面按 id 存,与提示词目录(localStorage)分开 —— 目录每条只有几百字节 */
export interface CoverRecord {
  id: string
  data: Blob
}

/** 读出全部封面。库不大,一次读完最简单,调用方按 id 贴回条目 */
export async function getAllCovers(): Promise<Map<string, Blob>> {
  // 库里存着的形状不一定等于 CoverRecord:封面刚挪进 IDB 那版存的是 data URL 字符串
  type CoverRow = { id: string; data: Blob | string }
  try {
    const db = await openDB()
    const rows = await new Promise<CoverRow[]>((resolve, reject) => {
      const req = db.transaction(COVER_STORE, 'readonly').objectStore(COVER_STORE).getAll()
      req.onsuccess = () => resolve(req.result as CoverRow[])
      req.onerror = () => reject(req.error)
    })
    const out = new Map<string, Blob>()
    for (const row of rows) {
      if (row.data instanceof Blob) {
        out.set(row.id, row.data)
      } else if (typeof row.data === 'string' && row.data.startsWith('data:image/')) {
        // 封面刚一挪进 IDB 那版存的是 data URL 字符串,这里统一转成 Blob,
        // 让上层只需要认一种形状;转不出来的坏数据跳过
        try {
          out.set(row.id, await urlToBlob(row.data))
        } catch {
          /* ignore */
        }
      }
    }
    return out
  } catch {
    // 拿不到就当没有封面:库还能用,不该因为封面读不出来而整页打不开
    return new Map()
  }
}

/**
 * 写回封面:只补库里还没有的那几张,并删掉已经不在库里的那些
 * (删掉一条提示词,它的封面不该留下)。
 * 不做全量重写是有意的 —— 封面是原图,而每次保存提示词(取用一次也算)都会
 * 走到这里,全量重写就是几十上百 MB 的写入。封面只会新增,不会改。
 */
export async function putCovers(covers: CoverRecord[]): Promise<void> {
  const db = await openDB()
  const keep = new Set(covers.map((c) => c.id))
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(COVER_STORE, 'readwrite')
    const store = tx.objectStore(COVER_STORE)
    const keysReq = store.getAllKeys()
    keysReq.onsuccess = () => {
      const existing = new Set(keysReq.result.map(String))
      for (const k of keysReq.result) if (!keep.has(String(k))) store.delete(k)
      for (const c of covers) if (!existing.has(c.id)) store.put(c)
    }
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

async function txStore(mode: IDBTransactionMode): Promise<IDBObjectStore> {
  const db = await openDB()
  return db.transaction(STORE, mode).objectStore(STORE)
}

export async function getAll<T>(): Promise<T[]> {
  const store = await txStore('readonly')
  return new Promise((resolve, reject) => {
    const req = store.getAll()
    req.onsuccess = () => resolve(req.result as T[])
    req.onerror = () => reject(req.error)
  })
}

/** 读取浏览器给的存储配额;隐私模式等场景会抛,一律当作"拿不到" */
async function storageUsage(): Promise<{ usage: number; quota: number } | null> {
  try {
    const est = await navigator.storage?.estimate?.()
    if (est && est.usage != null && est.quota) return { usage: est.usage, quota: est.quota }
  } catch {
    /* ignore */
  }
  return null
}

/** 按 createdAt 升序取主键,最旧的排在最前 */
function oldestKeys(db: IDBDatabase): Promise<IDBValidKey[]> {
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE, 'readonly').objectStore(STORE).index('createdAt').getAllKeys()
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

/**
 * 空间吃紧时清掉最旧的一批历史;还宽裕就原样返回 null。
 * 替代了原来的「按固定条数淘汰」——那个会在空间充裕时就静默删记录。
 * 返回清了多少条,交由界面告知用户。
 */
export async function pruneHistory(): Promise<PruneResult | null> {
  const db = await openDB()

  const est = await storageUsage()
  const usageRatio = est ? est.usage / est.quota : 0
  // 有余量就不动历史
  if (est && usageRatio < HIGH_WATER) return null

  const keys = await oldestKeys(db)
  // 配额驱动时按比例清;拿不到配额则退回条数兜底
  const want = est ? Math.ceil(keys.length * PRUNE_RATIO) : Math.max(0, keys.length - HARD_LIMIT)
  const count = Math.min(Math.max(0, keys.length - MIN_KEEP), want)
  if (count <= 0) return null

  const removedIds = keys.slice(0, count).map((k) => String(k))
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    const store = tx.objectStore(STORE)
    // keys 已按 createdAt 升序,前面的是最旧的
    for (let i = 0; i < count; i++) store.delete(keys[i])
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })

  return { removed: count, removedIds, usageRatio }
}

export async function putOne<T extends { id: string }>(item: T): Promise<void> {
  const store = await txStore('readwrite')
  return new Promise((resolve, reject) => {
    const req = store.put(item)
    req.onsuccess = () => resolve()
    req.onerror = () => reject(req.error)
  })
}

export async function deleteOne(id: string): Promise<void> {
  const store = await txStore('readwrite')
  return new Promise((resolve, reject) => {
    const req = store.delete(id)
    req.onsuccess = () => resolve()
    req.onerror = () => reject(req.error)
  })
}

/* ===== 图片载荷的编解码 =====
   历史里存 Blob 而不是 data URL:base64 会膨胀 33%,
   而且字符串要整段进 JS 堆;Blob 由浏览器放在堆外,只在渲染时按需读。 */

export async function urlToBlob(url: string): Promise<Blob> {
  const resp = await fetch(url, { mode: 'cors' })
  if (!resp.ok) throw new Error(`Couldn't fetch the image (${resp.status})`)
  return await resp.blob()
}

/** base64(不含 data: 前缀)→ Blob */
export function base64ToBlob(b64: string, mime = 'image/png'): Blob {
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return new Blob([bytes], { type: mime })
}

/** Blob → data URL。接口只认 data URL,用作参考图时需要这一趟转换 */
export function blobToDataURL(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob)
  })
}

/** 根据 base64 内容探测真实图片 MIME(避免写死 png 导致 JPEG 裂图) */
export function detectMimeFromDataUrl(dataUrl: string): string {
  // 已是完整 Data URL,直接沿用其 MIME
  const m = /^data:(image\/[a-z+]+);base64,/.exec(dataUrl)
  if (m) return m[1]

  // 纯 base64,按字节头判断(全部转大写比较)
  const head = dataUrl.slice(0, 22).toUpperCase()
  if (head.startsWith('/9J/') || head.startsWith('/9')) return 'image/jpeg'
  if (head.startsWith('IVBOR')) return 'image/png'
  if (head.startsWith('R0LG')) return 'image/gif'
  if (head.startsWith('UKLGR')) return 'image/webp'
  return 'image/png'
}