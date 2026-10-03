/* 服务端那个模块是纯 JS(它跑在 Node 里,不参与前端的构建)。
   这里补一份声明,好让单测能带着类型引用它 —— 不然 vitest 里那个 import
   在 typecheck 阶段会被当成 any,测试本身就没人管了 */
export declare const PHOTO_SCENE_CHARS: number
export declare const TAG_HOLD: number
export declare function cleanScene(s: unknown): string
export declare function splitTags(s: unknown): {
  text: string
  mood: string
  photo: string
}
