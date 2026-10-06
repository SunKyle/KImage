import { blobToDataURL } from './idb'
import { payloadOverBudget, payloadScaleFor, shrinkScaleFor } from './payload'

/* ===== 画布 AI 载荷编码与像素几何工具 ===================================
   负责将画布元素进行高保真缩放、异步有损/无损编码、透明通道探测与画幅适配。
   抽离底层 Canvas DOM 交互，使 CanvasEditor 保持纯粹的交互状态机。
   -------------------------------------------------------------------- */

export function newCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas')
  c.width = Math.max(1, Math.round(w))
  c.height = Math.max(1, Math.round(h))
  return c
}

export function toBlob(c: HTMLCanvasElement, type: string): Promise<Blob | null> {
  return new Promise((resolve) => c.toBlob(resolve, type))
}

/** 探测画布是否含有半透明或透明像素 */
export function hasAlpha(c: HTMLCanvasElement): boolean {
  const ctx = c.getContext('2d')
  if (!ctx) return false
  try {
    const data = ctx.getImageData(0, 0, c.width, c.height).data
    for (let i = 3; i < data.length; i += 4) {
      if (data[i] < 255) return true
    }
  } catch {
    /* 跨域或安全受限时安全回退 */
    return false
  }
  return false
}

/** 画布转为 PNG data URL（异步委托给浏览器底层编码） */
export function canvasDataUrl(c: HTMLCanvasElement): Promise<string> {
  return new Promise((resolve, reject) => {
    c.toBlob((b) => {
      if (!b) {
        reject(new Error('Could not encode the image'))
        return
      }
      blobToDataURL(b).then(resolve, reject)
    }, 'image/png')
  })
}

/** 按比例收窄并在必要时将无透明通道的图片转为 JPEG 降低传输体积 */
export async function encodeAt(c: HTMLCanvasElement, scale: number): Promise<string> {
  const t = scale >= 1 ? c : newCanvas(c.width * scale, c.height * scale)
  if (t !== c) {
    const ctx = t.getContext('2d')
    if (ctx) {
      ctx.imageSmoothingQuality = 'high'
      ctx.drawImage(c, 0, 0, t.width, t.height)
    }
  }
  const alpha = hasAlpha(t)
  const blob = await toBlob(t, alpha ? 'image/png' : 'image/jpeg')
  if (!blob) throw new Error('Could not encode the image')
  return blobToDataURL(blob)
}

/** 缩放已有的 data URL 图像（mask 统一保持 PNG 无损格式） */
export async function scaleDataUrl(url: string, scale: number): Promise<string> {
  if (scale >= 1) return url
  const bmp = await createImageBitmap(await (await fetch(url)).blob())
  const t = newCanvas(
    Math.max(1, Math.round(bmp.width * scale)),
    Math.max(1, Math.round(bmp.height * scale))
  )
  const ctx = t.getContext('2d')
  if (ctx) {
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(bmp, 0, 0, t.width, t.height)
  }
  bmp.close()
  const blob = await toBlob(t, 'image/png')
  return blob ? blobToDataURL(blob) : url
}

/** 计算当前画布画面与 mask 的传输载荷 */
export async function editPayload(
  base: HTMLCanvasElement,
  frame: { width: number; height: number },
  maskOf: () => Promise<string>
): Promise<{ image: string; mask: string }> {
  let scale = payloadScaleFor(frame.width, frame.height)
  for (;;) {
    const image = await encodeAt(base, scale)
    const mask = await scaleDataUrl(await maskOf(), scale)
    if (!payloadOverBudget([image, mask])) return { image, mask }
    const next = shrinkScaleFor(scale)
    if (next === null) return { image, mask }
    scale = next
  }
}

/** 把上游回来的位图裁切适配回原画布画幅 */
export async function fitToCanvas(bmp: ImageBitmap, w: number, h: number): Promise<ImageBitmap> {
  if (bmp.width === w && bmp.height === h) return bmp
  const c = newCanvas(w, h)
  const ctx = c.getContext('2d')
  if (ctx) {
    ctx.imageSmoothingQuality = 'high'
    const k = Math.max(w / bmp.width, h / bmp.height)
    const dw = bmp.width * k
    const dh = bmp.height * k
    ctx.drawImage(bmp, (w - dw) / 2, (h - dw) / 2, dw, dh)
  }
  bmp.close()
  return createImageBitmap(c)
}

/** 让浏览器绘制两帧后再继续执行异步工作 */
export function nextPaint(): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, 200)
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        clearTimeout(timer)
        resolve()
      })
    )
  })
}
