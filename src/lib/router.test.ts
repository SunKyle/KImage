import { describe, expect, it } from 'vitest'
import { formatHash, parseHash } from './router'

describe('router · 轻量 Hash 路由与深链接', () => {
  it('空 hash 或 #/ 默认解析为 home', () => {
    expect(parseHash('')).toEqual({ page: 'home' })
    expect(parseHash('#')).toEqual({ page: 'home' })
    expect(parseHash('#/')).toEqual({ page: 'home' })
  })

  it('正确解析一级页面', () => {
    expect(parseHash('#/chars')).toEqual({ page: 'chars' })
    expect(parseHash('#/chat')).toEqual({ page: 'chat' })
    expect(parseHash('#/canvas')).toEqual({ page: 'canvas' })
    expect(parseHash('#/history')).toEqual({ page: 'history' })
    expect(parseHash('#/settings')).toEqual({ page: 'settings' })
    expect(parseHash('#/lib')).toEqual({ page: 'lib' })
  })

  it('正确解析带参数的深链接', () => {
    expect(parseHash('#/chat/char_abc123')).toEqual({ page: 'chat', id: 'char_abc123' })
    expect(parseHash('#/chars/captain')).toEqual({ page: 'chars', id: 'captain' })
  })

  it('未知页面安全降级回 home', () => {
    expect(parseHash('#/unknown_route')).toEqual({ page: 'home' })
    expect(parseHash('#/invalid/123')).toEqual({ page: 'home' })
  })

  it('formatHash 生成正确的 hash 路径', () => {
    expect(formatHash('home')).toBe('#/')
    expect(formatHash('chars')).toBe('#/chars')
    expect(formatHash('chat', 'char_456')).toBe('#/chat/char_456')
    expect(formatHash('history')).toBe('#/history')
  })
})
