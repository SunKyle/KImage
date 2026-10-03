/* 对话里"角色发一张图"这一步的两个决定:
   提示词里要不要带这个角色的外貌设定、以及要不要把设定图当参考图发出去。
 *
 *  **不是每张都该带。** 发图的意图有两大类,它们的取舍正好相反:
 *  - 场景照("窗外的雨""我桌上那杯咖啡")—— 跟这个人长什么样无关。这时把外貌
 *    设定拼进提示词、把设定图当参考图送进去,模型会被拽着往那个人的脸、发型、
 *    衣着上靠:画面跑偏,甚至在一张风景里凭空长出一个穿那身衣服的人。
 *  - 有它本人的照片("我在阳台抽烟")—— 这时设定图是**唯一**能保证"同一张脸"
 *    的东西(见 doc/角色配图设计.md),少了它就会画出一个陌生人。
 *
 *  判据由**模型自己给**:它在标签里写 `self:` 前缀(见 server/chatTags.js)——
 *  它才知道自己在描述什么。客户端只按这个开关办事,不做猜测。
 *
 *  抽成纯函数是为了能直接断言:它是"这张图会不会被设定图带跑"的全部依据,
 *  而真正的出图要花钱、要联网,靠手测根本试不全。
 */

/** 场景描述 + 外貌设定的长度上限。与角色卡那条提示词的余量同一档 */
export const CHAT_PHOTO_PROMPT_CHARS = 1200

export interface ChatPhotoPlan {
  /** 真正发给上游的提示词 */
  prompt: string
  /** 要不要把角色的设定图/主参考图当参考图发出去 */
  useRefs: boolean
}

/**
 * @param scene    模型给的场景描述(已由 server/chatTags.js 收敛成一行)
 * @param self     它是不是在画面里(标签里的 self: 前缀,或描述里点了自己的名字)
 * @param faceDesc 角色的外貌设定(characterFaceDesc)。没填过设定的角色是空串
 */
export function planChatPhoto(scene: string, self: boolean, faceDesc: string): ChatPhotoPlan {
  const text = String(scene || '').trim()
  /* 没有场景就没有要画的东西。这里先收口,免得拼出 ", oval face, …" 这种
     只剩外貌的提示词 —— 那会画出一张没有场景的人像,而调用方本该放弃这一张 */
  if (!text) return { prompt: '', useRefs: false }
  const spec = String(faceDesc || '').trim()
  /* 只有它本人在画面里时才拼外貌:**场景在前、外貌在后** ——
     前段权重更高,先说"这一张要画什么"(与 composedPrompt 同一顺序) */
  const prompt = self && spec ? `${text}, ${spec}` : text
  return {
    prompt: prompt.slice(0, CHAT_PHOTO_PROMPT_CHARS),
    /* 参考图与外貌设定同一个开关:场景照不带参考图 —— 它跟"同一张脸"无关 */
    useRefs: self
  }
}
