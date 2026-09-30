// 极简 IndexedDB 封装:用来持久化历史记录与提示词封面(比 localStorage 容量大得多)
const DB_NAME = 'kimage.db'
const STORE = 'history'
/* 提示词封面单独一个 store。它们原来是 base64 塞在 localStorage 条目里的,
   而 localStorage 一共只有约 5MB —— 五六十张封面就顶到天花板,写不下时
   只能把所有封面整批丢掉(见 git 历史的 savePrompts)。挪到这里之后,
   封面与历史图共用浏览器级配额,那个"整批丢封面"的降级路径也就不需要了 */
const COVER_STORE = 'covers'
/* 角色的参考图单独一个 store,不和提示词封面挤在一起 ——
   putCovers 会按"目录里现存的封面"反向裁剪,角色图混进去会被当成孤儿删掉 */
const CHAR_STORE = 'chars'
/* 角色的设定图与主参考图共用一个 store:
   主图 key 是裸的角色 id(启动时要读它),视图 key 是 `${角色id}:${视图}`(按需取) */
const VIEW_SEP = ':'
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
    const req = indexedDB.open(DB_NAME, 4)
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
      // v4 新增:角色的参考图
      if (!db.objectStoreNames.contains(CHAR_STORE)) {
        db.createObjectStore(CHAR_STORE, { keyPath: 'id' })
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

/* ===== 角色的参考图 =====
   与提示词封面同一套做法:名字与描述在 localStorage 目录里,图按 id 存在这里 */
export interface CharRefRecord {
  id: string
  data: Blob
}

/** 读出全部角色参考图。角色不会太多,一次读完最简单,调用方按 id 贴回条目 */
export async function getAllCharRefs(): Promise<Map<string, Blob>> {
  try {
    const db = await openDB()
    const rows = await new Promise<Array<{ id: string; data: Blob }>>((resolve, reject) => {
      const req = db.transaction(CHAR_STORE, 'readonly').objectStore(CHAR_STORE).getAll()
      req.onsuccess = () => resolve(req.result as Array<{ id: string; data: Blob }>)
      req.onerror = () => reject(req.error)
    })
    const out = new Map<string, Blob>()
    for (const row of rows) {
      // 这个 store 是新加的,不会有老的 data URL 数据;但脏数据仍要跳过
      if (row.data instanceof Blob) out.set(row.id, row.data)
    }
    return out
  } catch {
    // 读不出来就当没有:角色本身还能用,不该因为一张图而整块打不开
    return new Map()
  }
}

/**
 * 写回角色参考图:整批覆盖写,并删掉已经不在目录里的那些。
 *
 * 为什么不能"只补库里还没有的":角色的主参考图是会被改的 ——
 * 「Use as reference」就是把主图换成另一张视图。跳过错在的 key,
 * 内存里当场生效、刷新后却读回旧的那张,用户看到的就是"改了又弹回去"。
 * 每个角色最多一张、都是 512px 的压缩图,全量重写这点开销不值得省
 */
export async function putCharRefs(refs: CharRefRecord[]): Promise<void> {
  const db = await openDB()
  const keep = new Set(refs.map((r) => r.id))
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(CHAR_STORE, 'readwrite')
    const store = tx.objectStore(CHAR_STORE)
    const keysReq = store.getAllKeys()
    keysReq.onsuccess = () => {
      const keys = keysReq.result.map(String)
      /* 设定图的 key 是 `${角色id}:${视图}`,不是裸的角色 id。
         只比对裸 id 的话,每次保存角色都会把刚生成好的设定图整批删掉 ——
         所以凡是"某个还在的角色名下"的 key 都算保留。
         角色 id 是 uuid,不含冒号,按第一个冒号切归属是安全的。
         反过来说:角色从列表里移除后,它的主图与全部视图会在这里一起被收走,
         不需要另写一套"删角色的图" */
      for (const k of keys) {
        const cut = k.indexOf(VIEW_SEP)
        const owner = cut > 0 ? k.slice(0, cut) : k
        if (!keep.has(owner)) store.delete(k)
      }
      for (const r of refs) store.put(r)
    }
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

/* ===== 角色的设定图 =====
   只在这个界面打开时才取,不在启动时加载:5 张图 × N 个角色全部读进内存太重 */

/* 上传底图在这个 store 里的 key 后缀。与设定图共用 `${角色id}:${后缀}` 这套前缀,
   所以 putCharRefs 按归属裁剪时,它会跟着角色一起被收走,不必另写一套删除逻辑 */
const SOURCE_KEY = 'source'

/** 某个角色"第一步上传的那张底图"在 store 里的 key */
export function charSourceKey(id: string): string {
  return id + VIEW_SEP + SOURCE_KEY
}

/** 读出某个角色的全部设定图。先按 key 前缀筛出自己那几张,再逐张取 ——
 *  不整车读进来,免得把别的角色的图也拉进内存 */
export async function getCharViews(charId: string): Promise<Array<{ kind: string; data: Blob }>> {
  try {
    const db = await openDB()
    const prefix = charId + VIEW_SEP
    const keys = await new Promise<string[]>((resolve, reject) => {
      const req = db.transaction(CHAR_STORE, 'readonly').objectStore(CHAR_STORE).getAllKeys()
      req.onsuccess = () => resolve(req.result.map(String))
      req.onerror = () => reject(req.error)
    })
    const out: Array<{ kind: string; data: Blob }> = []
    for (const key of keys.filter((k) => k.startsWith(prefix))) {
      // 底图的 key 也挂在这个前缀下,但它不是一张视图(见 charSourceKey)
      if (key === charSourceKey(charId)) continue
      const data = await new Promise<Blob | undefined>((resolve, reject) => {
        const req = db.transaction(CHAR_STORE, 'readonly').objectStore(CHAR_STORE).get(key)
        req.onsuccess = () => {
          const row = req.result as { data?: Blob } | undefined
          resolve(row?.data)
        }
        req.onerror = () => reject(req.error)
      })
      if (data instanceof Blob) out.push({ kind: key.slice(prefix.length), data })
    }
    return out
  } catch {
    // 读不出来就当没有:角色本身还能用,不该因为设定图而整块打不开
    return []
  }
}

/** 写入一张视图。同一个 kind 再写就是覆盖(重生成) */
export async function putCharView(charId: string, kind: string, data: Blob): Promise<void> {
  const db = await openDB()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(CHAR_STORE, 'readwrite')
    tx.objectStore(CHAR_STORE).put({ id: `${charId}${VIEW_SEP}${kind}`, data })
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

/**
 * 空间吃紧时清掉最旧的一批历史;还宽裕就原样返回 null。
 * 替代了原来的「按固定条数淘汰」——那个会在空间充裕时就静默删记录。
 * 归属某个作品集(collectionId 不为空)的记录是用户特意归拢的,
 * 绝不在此自动清掉 —— 哪怕它们是同类里最旧的。
 * 返回清了多少条,交由界面告知用户。
 */
export async function pruneHistory(): Promise<PruneResult | null> {
  const db = await openDB()

  const est = await storageUsage()
  const usageRatio = est ? est.usage / est.quota : 0
  // 有余量就不动历史
  if (est && usageRatio < HIGH_WATER) return null

  /* 全表读「id / 归属 / 时间」:要避让挂了作品集的记录,只凭 createdAt 键做不到 */
  const all = await new Promise<Array<{ id: string; collectionId?: string; createdAt: number }>>(
    (resolve, reject) => {
      const req = db.transaction(STORE, 'readonly').objectStore(STORE).getAll()
      req.onsuccess = () =>
        resolve(
          (req.result as Array<{ id: string; collectionId?: string; createdAt: number }>).map(
            (r) => ({
              id: r.id,
              ...(r.collectionId !== undefined ? { collectionId: r.collectionId } : {}),
              createdAt: r.createdAt
            })
          )
        )
      req.onerror = () => reject(req.error)
    }
  )
  // 配额驱动时按比例清;拿不到配额则退回条数兜底
  const want = est ? Math.ceil(all.length * PRUNE_RATIO) : Math.max(0, all.length - HARD_LIMIT)
  const count = Math.min(Math.max(0, all.length - MIN_KEEP), want)
  if (count <= 0) return null

  // 从最旧的往新挑,只挑没挂作品集的;挂了的不进候选,空间留给能看到的那批去腾
  const removedIds = all
    .filter((r) => !r.collectionId)
    .sort((a, b) => a.createdAt - b.createdAt)
    .slice(0, count)
    .map((r) => r.id)
  // 全部都在作品集里就什么都不清:宁可空间继续吃紧,也不动用户归拢的作品
  if (removedIds.length === 0) return null

  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    const store = tx.objectStore(STORE)
    for (const id of removedIds) store.delete(id)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })

  return { removed: removedIds.length, removedIds, usageRatio }
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