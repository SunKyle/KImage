import type { Page } from './nav'

/* ===== 轻量 Hash 路由与深链接 ==========================================
   没有引入 vue-router 是这个项目的既有决定(保持单页、无多余依赖)。
   但刷新强制回首页、无法把某个角色或某段对话发给人是一个明显痛点。
   这里用 window.location.hash 提供极简的深链接支持:
   - '#/' 或空 -> home
   - '#/chars' / '#/chars/:id'
   - '#/chat' / '#/chat/:id'
   - '#/canvas' / '#/lib' / '#/history' / '#/settings'
   -------------------------------------------------------------------- */

export interface RouteState {
  page: Page
  id?: string
}

export const VALID_PAGES: readonly Page[] = [
  'home',
  'chars',
  'chat',
  'canvas',
  'lib',
  'history',
  'settings'
] as const

/** 解析当前的 hash 字符串 */
export function parseHash(hash: string): RouteState {
  const clean = hash.replace(/^#\/?/, '').trim()
  if (!clean) return { page: 'home' }
  const [segment, id] = clean.split('/')
  if (!VALID_PAGES.includes(segment as Page)) {
    return { page: 'home' }
  }
  const page = segment as Page
  return { page, ...(id ? { id } : {}) }
}

/** 将页面与参数格式化为 hash */
export function formatHash(page: Page, id?: string): string {
  if (page === 'home' && !id) return '#/'
  return id ? `#/${page}/${id}` : `#/${page}`
}
