/* 服务端那个模块是纯 JS(它跑在 Node 里,不参与前端的构建)。
   这里补一份声明,好让单测能带着类型引用它 —— 不然 vitest 里那个 import
   在 typecheck 阶段会被当成 any,测试本身就没人管了 */
export declare const PHOTO_SCENE_CHARS: number
export declare function cleanScene(s: unknown): string
/** 这一截尾巴**可以放出去多长**(不是"要扣住多少")。调用方发
 *  `tail.slice(0, tailHold(tail))`,剩下那截留在手里 */
export declare function tailHold(buffer: unknown): number
/** 拆出"场景 + 有没有它本人"。charName 用于兜底判据:描述里点了自己的名字 */
export declare function parsePhotoIntent(
  raw: unknown,
  charName?: string
): { scene: string; self: boolean }
export declare function splitTags(
  s: unknown,
  charName?: string
): {
  text: string
  mood: string
  photo: string
  /** 这张图里有没有它本人。true 才把角色设定与设定图发给出图模型 */
  photoSelf: boolean
}
