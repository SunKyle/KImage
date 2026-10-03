import { describe, expect, it } from 'vitest'
import { langTagOf } from './speech'

/* 角色设的"说哪种语言"要折成系统音色表认的那个 lang 前缀。
   这一栏是自由文本,所以认法有好几层 —— 而每层都有一种真实的写法会踩空:
   语言代码、写成哪种文字、常见语言名。测的就是这三层各自的边角。
   (挑错了嗓子不会报错,只会"我明明设了日语,它却用英语念" ——
   所以这几条只能靠测试盯着) */
describe('langTagOf · 角色设的语言 → 音色表认的 lang', () => {
  it('语言代码原样认,带地区后缀也只取前两位', () => {
    expect(langTagOf('en')).toBe('en')
    expect(langTagOf('en-US')).toBe('en')
    expect(langTagOf('zh_CN')).toBe('zh')
    expect(langTagOf('JA-jp')).toBe('ja')
  })

  it('常见语言名认得出', () => {
    expect(langTagOf('English')).toBe('en')
    expect(langTagOf('japanese')).toBe('ja')
    expect(langTagOf('Brazilian Portuguese')).toBe('pt')
  })

  it('写成哪种文字就是哪种语言,而且假名要先于汉字判', () => {
    // 「日本語」里有汉字,先判汉字就会认成中文 —— 这条就是防这个的
    expect(langTagOf('日本語')).toBe('ja')
    expect(langTagOf('中文')).toBe('zh')
    expect(langTagOf('简体中文')).toBe('zh')
    expect(langTagOf('한국어')).toBe('ko')
  })

  it('认不出来就返回空串,退回按文本猜', () => {
    // 三字母的代码不认:它会撞上 the / you 这类英文常用词
    expect(langTagOf('the')).toBe('')
    expect(langTagOf('Klingon')).toBe('')
    expect(langTagOf('')).toBe('')
    expect(langTagOf('   ')).toBe('')
  })
})
