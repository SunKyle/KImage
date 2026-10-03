import { describe, expect, it } from 'vitest'
import { configKindOf, pickActiveByKind } from './api'
import type { ApiConfig } from './types'

/* 造一条配置。只有 id 与 kind 参与挑选,其余字段给最小值即可 */
function cfg(id: string, kind?: ApiConfig['kind']): ApiConfig {
  return { id, name: id, baseUrl: 'https://example.com/v1', apiKey: 'k', model: 'm', kind }
}

describe('configKindOf · 用途归一', () => {
  it('缺省(加 kind 之前存下来的老配置)按出图算', () => {
    expect(configKindOf(cfg('a'))).toBe('image')
  })

  it('四类原样返回', () => {
    for (const k of ['image', 'text', 'vision', 'tts'] as const) {
      expect(configKindOf(cfg('a', k))).toBe(k)
    }
  })
})

describe('pickActiveByKind · 按用途挑当前生效的那条', () => {
  it('存着的 id 命中且用途一致时,就用它', () => {
    const list = [cfg('a', 'image'), cfg('b', 'image')]
    expect(pickActiveByKind(list, 'image', 'b')?.id).toBe('b')
  })

  it('存着的 id 已不存在时,退到同类第一条', () => {
    const list = [cfg('a', 'image'), cfg('b', 'image')]
    expect(pickActiveByKind(list, 'image', 'gone')?.id).toBe('a')
  })

  it('存着的 id 被改成别的用途后不再命中,退到同类第一条', () => {
    // b 原来是出图配置,用户把它改成了朗读
    const list = [cfg('a', 'image'), cfg('b', 'tts')]
    expect(pickActiveByKind(list, 'image', 'b')?.id).toBe('a')
  })

  /* 这一组是本次修复的核心:原来的谓词写作 `kind !== 'text'`,
     于是只配了朗读配置时,朗读那条会被挑成"当前出图配置" */
  it('出图只认 kind === image,不会把 tts / vision 配置挑进来', () => {
    expect(pickActiveByKind([cfg('a', 'tts')], 'image', 'a')).toBeUndefined()
    expect(pickActiveByKind([cfg('a', 'vision')], 'image', 'a')).toBeUndefined()
    expect(pickActiveByKind([cfg('a', 'text')], 'image', 'a')).toBeUndefined()
    // 混在一起时挑到的是真正的出图那条,而不是排在前面的朗读
    const mixed = [cfg('t', 'tts'), cfg('v', 'vision'), cfg('i', 'image')]
    expect(pickActiveByKind(mixed, 'image', '')?.id).toBe('i')
  })

  it('老配置没有 kind 字段时按出图参与挑选', () => {
    const list = [cfg('legacy'), cfg('t', 'tts')]
    expect(pickActiveByKind(list, 'image', '')?.id).toBe('legacy')
  })

  it('每一类各自挑各自的,互不串台', () => {
    const list = [cfg('i', 'image'), cfg('x', 'text'), cfg('v', 'vision'), cfg('s', 'tts')]
    expect(pickActiveByKind(list, 'image', '')?.id).toBe('i')
    expect(pickActiveByKind(list, 'text', '')?.id).toBe('x')
    expect(pickActiveByKind(list, 'vision', '')?.id).toBe('v')
    expect(pickActiveByKind(list, 'tts', '')?.id).toBe('s')
  })

  it('列表为空、或这一类一条都没有时返回 undefined', () => {
    expect(pickActiveByKind([], 'image', 'a')).toBeUndefined()
    expect(pickActiveByKind([cfg('x', 'text')], 'tts', 'x')).toBeUndefined()
  })
})
