// 极简 IndexedDB 封装:用来持久化历史记录(比 localStorage 容量大得多)
const DB_NAME = 'kimage.db'
const STORE = 'history'

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id' })
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
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

export async function putAll<T extends { id: string }>(items: T[], slice = 50): Promise<void> {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    const store = tx.objectStore(STORE)
    store.clear()
    items.slice(0, slice).forEach((it) => store.put(it))
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
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

// 工具:把远端图片 URL 抓成 base64(Data URL),用于本地持久化预览
export async function urlToDataURL(url: string): Promise<string> {
  const resp = await fetch(url, { mode: 'cors' })
  if (!resp.ok) throw new Error('fetch failed')
  const blob = await resp.blob()
  return await new Promise<string>((resolve, reject) => {
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