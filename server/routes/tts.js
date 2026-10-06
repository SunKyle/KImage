import { randomUUID } from 'node:crypto'
import {
  CONNECT_HINTS,
  PROD_LIKE,
  UPSTREAM_TIMEOUT_MS,
  assertSafeTarget,
  dispatchAttempts,
  htmlTitle,
  looksLikeHtml,
  rateLimit,
  safeFetch
} from '../core.js'

export function registerTtsRoutes(app) {
app.post('/api/tts', rateLimit, async (req, res) => {
  const { text, voice, baseUrl, apiKey, resourceId, model } = req.body || {}
  const say = typeof text === 'string' ? text.trim() : ''
  /* 密钥先 trim 再判空:粘贴带进来的空格/换行会让"非空"成立,
     却在上游看来是一个无效的 key(401)—— 那是最难自查的一类失败 */
  const key = typeof apiKey === 'string' ? apiKey.trim() : ''
  if (!say) return res.status(400).json({ error: 'Nothing to say' })
  if (!baseUrl) return res.status(400).json({ error: 'Configure your Base URL first' })
  if (!key) {
    return res.status(400).json({ error: 'Set the API key for your TTS config first' })
  }

  const v = voice && typeof voice === 'object' ? voice : {}
  const describe = v.source === 'describe' && typeof v.describe === 'string' ? v.describe.trim() : ''
  const speaker = typeof v.vendorVoice === 'string' ? v.vendorVoice.trim() : ''
  const speed = typeof v.speed === 'number' && Number.isFinite(v.speed) ? v.speed : 0
  /* req_params.model 那两层收(见 TTS_MODEL_VARIANTS):
       1. 内置音色一律不带 —— 文档写明它"仅当 speaker 为复刻音色时需指定";
       2. 复刻音色只在填了合法值时才带。老配置里可能存着"自由输入框"时代留下的
          脏值(最常见的是照 Resource ID 写成 seed-tts-2.0),那种值上游只会回
          InvalidModel —— 用户看不出这是自己两个月前填错的那一格,只能在这里挡掉 */
  const wantModel = typeof model === 'string' ? model.trim() : ''
  const variant = v.source === 'clone' && TTS_MODEL_VARIANTS.includes(wantModel) ? wantModel : ''

  /* 真正发出去的那个 Resource-Id。describe 那条不带它(见下),
     其余一律补成上游认的完整形态 —— 理由见 normalizeResourceId */
  const sentResourceId = describe ? '' : normalizeResourceId(resourceId, v.source)

  const provider = TTS_PROVIDERS.volc
  const path = describe ? provider.design : provider.speech
  /* 规整放在截断之后:规整只会变短,不会把内容顶出上限(见 tidyForSpeech) */
  const bodyText = tidyForSpeech(say.slice(0, TTS_MAX_CHARS))
  /* 全是 emoji / 装饰符号时会被规整成空 —— 那种请求发出去只会换回一句
     参数错,不如在这里就说清 */
  if (!bodyText) return res.status(400).json({ error: 'Nothing pronounceable in that message' })

  const target = ttsTarget(baseUrl, path)
  let targetUrl
  try {
    targetUrl = await assertSafeTarget(target)
  } catch (e) {
    return res.status(400).json({ error: e.message })
  }

  const payload = describe
    ? JSON.stringify({
        model: TTS_DESIGN_MODEL,
        text_prompt: ttsDesignPrompt(describe.slice(0, TTS_DESCRIBE_CHARS), bodyText),
        audio_config: {
          /* 这条端点**默认吐 wav**,而下面一律按 mp3 播报 —— 不显式要 mp3,
             浏览器拿到的是 wav 字节却挂着 audio/mpeg 的头,能不能放全看运气 */
          format: 'mp3',
          sample_rate: 24000,
          ...(speed ? { speech_rate: Math.max(-50, Math.min(100, Math.round(speed))) } : {})
        }
        /* 刻意**不传 references**:那条的参数说明里,"纯文本生成"就是
           "不传参考资源,按 text_prompt 中的提示词生成音频" ——
           一段描述直接生成,不需要底子音色,也不需要先买音色槽位 */
      })
    : JSON.stringify({
        user: { uid: 'kimage' },
        req_params: {
          text: bodyText,
          /* 空音色在这里拦掉:上游会回一个难懂的参数错,而真正的原因是
             "这个角色还没挑过音色" */
          speaker,
          audio_params: {
            format: 'mp3',
            sample_rate: 24000,
            ...(speed ? { speech_rate: Math.max(-50, Math.min(100, Math.round(speed))) } : {})
          },
          // 只有复刻 2.0 认这个(见上面 variant 的说明)
          ...(variant ? { model: variant } : {})
        }
      })

  if (!describe && !speaker) {
    return res.status(400).json({ error: 'Pick a voice for this character first' })
  }

  const ac = new AbortController()
  let idleTimer = null
  let idleTimedOut = false
  const armIdle = () => {
    clearTimeout(idleTimer)
    idleTimer = setTimeout(() => {
      idleTimedOut = true
      ac.abort()
    }, UPSTREAM_TIMEOUT_MS)
  }
  res.on('close', () => {
    if (!res.writableEnded) ac.abort()
  })

  let reachedUpstream = false
  let proxyJumpFailed = false

  try {
    let upstream = null
    let connectErr = null
    for (const dispatcher of dispatchAttempts(targetUrl)) {
      try {
        upstream = await safeFetch(targetUrl, {
          method: 'POST',
          /* 音频生成那条的文档里没有 X-Api-Resource-Id,所以走它时不带 ——
             一个用不上的头，最好的结果是被忽略，最坏的结果是被拒 */
          headers: volcHeaders(key, sentResourceId),
          body: payload,
          signal: ac.signal,
          dispatcher
        })
        reachedUpstream = true
        break
      } catch (e) {
        if (e?.name === 'AbortError') throw e
        connectErr = e
        if (dispatcher) proxyJumpFailed = true
      }
    }
    if (!upstream) throw connectErr

    /* 上游给的是 HTTP 层的错(401 / 404 / 一整页 HTML):这时还没写头,
       照别的端点那样回一个正常的 JSON 错误 */
    if (!upstream.ok) {
      const raw = await upstream.text()
      /* 鉴权被拒时把"我们实际发出去的东西"也说明白(不含 key 本身)。
         这个 key 只存在用户浏览器里,不把长度与去向说出来,他就没有任何办法
         判断是"我们发错了"还是"key 不对" —— 而这两件事的下一步完全不同:
         前者等我改,后者他去控制台查 */
      const trace =
        upstream.status === 401
          ? ` Sent ${key.length} characters to ${PROD_LIKE ? targetUrl.host : target}.`
          : describe
            ? ''
            : ` Sent Resource ID "${sentResourceId || '(none)'}" with speaker "${speaker || '(none)'}".`
      return res.status(upstream.status).json({
        error: `Upstream returned an error (${upstream.status})`,
        detail: ttsErrorHint(raw, shortDetail(raw)) + trace
      })
    }
    if (!upstream.body) throw new Error('Upstream returned no stream')

    const failed = await pipeTtsAudio(upstream, res, armIdle)
    if (failed) {
      /* 走到这里说明一个字都没写出去,所以还能回一个正常的错误。
         上游那句 message 直接端上来 —— "没有音色授权""Resource-Id 不对"
         这类话只有它说得准。

         再把**我们实际发出去的那两样**写上:这一大类拒绝(资源与音色对不上)
         全都发生在 "Resource-Id + speaker" 这一对上,不回显这两样,用户手里
         就只有一个"对不上",没有任何可以核对的凭据
         (与上面 401 那条回显 key 长度、目标 host 同一个理由) */
      const upstreamText = [failed.message, failed.firstFrame].filter(Boolean).join(' — ')
      const sent = describe
        ? ''
        : `Sent Resource ID "${sentResourceId || '(none)'}" with speaker "${speaker || '(none)'}".`
      const detail = ttsErrorHint(
        upstreamText,
        [sent, upstreamText].filter(Boolean).join(' ')
      ).slice(0, 400)
      return res.status(502).json({
        error: `The TTS service refused this request${failed.code ? ` (code ${failed.code})` : ''}`,
        detail: detail || 'It returned no audio and no explanation.'
      })
    }
    if (!res.writableEnded) res.end()
  } catch (e) {
    const aborted = e?.name === 'AbortError'
    if (res.headersSent) {
      /* 已经在放音频了:只能收场,再回错误码没有意义(与 /api/chat 同一条界线) */
      if (!res.writableEnded) res.end()
      return
    }
    if (aborted && idleTimedOut) {
      return res.status(504).json({
        error: 'Upstream timed out. Try again.',
        detail: `No audio after ${UPSTREAM_TIMEOUT_MS / 1000} seconds.`
      })
    }
    const cause = e?.cause
    const code = cause?.code || cause?.errno || ''
    const reason = [code, cause?.message].filter(Boolean).join(' ') || String(e)
    const hint =
      !reachedUpstream && proxyJumpFailed
        ? 'Tried both the configured UPSTREAM_PROXY and a direct connection — neither worked.'
        : CONNECT_HINTS[code] || ''
    const where = PROD_LIKE ? targetUrl.host : target
    return res.status(502).json({
      error: 'Upstream request failed',
      detail: `${where} — ${reason}. ${hint}`
    })
  } finally {
    clearTimeout(idleTimer)
  }
})

/* 声音克隆:上传一段样本,换一个可以反复用的音色代号。
 *
 * 用的是**自定义音色代号**那条路(custom_speaker_id):代号由我们自己取名,
 * 所以这一步不需要从响应里读任何东西 —— 取好名、发出去、成了就记下来。
 * 样本走 base64 而不是 multipart:现有端点的 body 全是 JSON,而
 * dispatchAttempts 那两次尝试依赖 **body 字符串可复用**,multipart 发一次就消耗掉了。
 *
 * 计费提醒(这一条必须让用户知道):训练本身不贵,而**首次用这个音色合成时会
 * 收一次音色槽位费**。所以我们只建号,不在这里偷偷合成一次。 */
app.post('/api/voice/clone', rateLimit, async (req, res) => {
  const { sample, name, baseUrl, apiKey, customId, language } = req.body || {}
  // 与 /api/tts 同一条:先 trim 再判空(见那边的注释)
  const key = typeof apiKey === 'string' ? apiKey.trim() : ''
  if (typeof sample !== 'string' || !sample.startsWith('data:audio/')) {
    return res.status(400).json({ error: 'Attach an audio file (wav, mp3, m4a or ogg)' })
  }
  if (!baseUrl) return res.status(400).json({ error: 'Configure your Base URL first' })
  if (!key) return res.status(400).json({ error: 'Set the API key for your TTS config first' })

  /* 代号有格式要求(上游会拦):8~256 字符、只能数字字母与 - _、
     必须以字母开头、结尾不能是 - 或 _,也不能撞官方前缀。
     "kimage_" 开头天然满足全部条件 */
  const id = typeof customId === 'string' && customId.trim() ? customId.trim() : ''
  if (!/^[A-Za-z][A-Za-z0-9_-]{7,255}$/.test(id) || /[-_]$/.test(id)) {
    return res.status(400).json({
      error: 'That voice id is not usable',
      detail: 'Use 8-256 letters, digits, dashes or underscores, starting with a letter.'
    })
  }

  const comma = sample.indexOf(',')
  const head = sample.slice(5, comma)
  const b64 = sample.slice(comma + 1)
  const format = head.split(';')[0].split('/')[1] || 'mp3'
  /* 大小按 base64 长度反推:解码一遍只为了量尺寸太浪费,
     而 base64 的长度与字节数是固定比例(4 字符 → 3 字节) */
  const bytes = Math.floor((b64.length * 3) / 4)
  if (bytes > MAX_VOICE_SAMPLE) {
    return res.status(400).json({
      error: `That sample is too large (max ${Math.round(MAX_VOICE_SAMPLE / 1024 / 1024)}MB)`
    })
  }

  const target = ttsTarget(baseUrl, TTS_PROVIDERS.volc.clone)
  let targetUrl
  try {
    targetUrl = await assertSafeTarget(target)
  } catch (e) {
    return res.status(400).json({ error: e.message })
  }

  const payload = JSON.stringify({
    /* 自定义代号这条路要求 speaker_id 传这个固定值,真正的名字写在下面 */
    speaker_id: 'custom_speaker_id',
    custom_speaker_id: id,
    audio: { data: b64, format },
    ...(typeof language === 'number' ? { language } : {})
    /* 刻意**不带** extra_params.demo_text:上游可以借它顺便合一段试听,
       但那个 demo 音频在训练响应里的位置没有稳定文档 —— 带了就得解析它,
       解析不出来那一段就白费,而它还会拖长注册耗时(上游明说 demo 越长越慢)。
       试听改由前端那枚按钮走一次正常合成(界面会先讲清"这一步开始计费") */
  })

  try {
    let upstream = null
    let connectErr = null
    for (const dispatcher of dispatchAttempts(targetUrl)) {
      try {
        upstream = await safeFetch(targetUrl, {
          method: 'POST',
          headers: volcHeaders(key, ''),
          body: payload,
          dispatcher
        })
        break
      } catch (e) {
        connectErr = e
      }
    }
    if (!upstream) throw connectErr

    const raw = await upstream.text()
    if (!upstream.ok) {
      return res.status(upstream.status).json({
        error: `Upstream returned an error (${upstream.status})`,
        detail: ttsErrorHint(raw, shortDetail(raw))
      })
    }
    /* 上游的训练响应形状没有稳定文档,所以这里不解析它的内容 ——
       代号是我们自己取的(见上面),成没成由 HTTP 状态说明。
       但把原始响应留给前端放进回执里,出问题时用户手里有东西可查 */
    res.json({ vendorVoice: id, bytes, name: typeof name === 'string' ? name : '', raw: shortDetail(raw) })
  } catch (e) {
    const cause = e?.cause
    const code = cause?.code || cause?.errno || ''
    const reason = [code, cause?.message].filter(Boolean).join(' ') || String(e)
    const where = PROD_LIKE ? targetUrl.host : target
    return res.status(502).json({
      error: 'Upstream request failed',
      detail: `${where} — ${reason}. ${CONNECT_HINTS[code] || ''}`
    })
  }
})


}
