import {
  CHAR_KEY,
  COLL_KEY,
  CONFIG_ACTIVE_KEY,
  CONFIG_KEY,
  LIB_KEY,
  TEXT_ACTIVE_KEY,
  TTS_ACTIVE_KEY,
  VISION_ACTIVE_KEY
} from '../api'

/* ===== 跨标签页同步 ==================================================
   为什么需要它:localStorage 里的几份目录都是**整份覆盖写**的
   (见 api.ts 的 saveCharacters / savePrompts / saveCollections / saveConfigs)。
   两个标签页同时开着时,A 页删掉一个角色,B 页内存里还留着那份旧目录 ——
   B 页下一次保存会把它整个写回去,用户看到的是"我删掉的东西自己回来了"。

   storage 事件正好给出我们要的信号:**只有其他标签页写入时才会触发**,
   本页自己的写入不会惊动自己。所以处理方式就是"把这一份目录重新读一遍"。

   只重载目录,不碰任何正在编辑的草稿:向导里的表单、未提交的提示词都存在
   组件自己的状态里,换掉 props 不会动它们(代价是:如果另一个标签页改了
   你正在编辑的同一条,存盘时以本页为准 —— 这比"静默丢弃别人的改动"更可预期)。
   -------------------------------------------------------------------- */

/** 一次重载要动的目录 */
export type SyncTarget = 'configs' | 'characters' | 'collections' | 'prompts'

/* 键常量一律从 api.ts 取,不在这里重抄一遍字符串 ——
   抄一份的后果是"哪天改了键名,同步就悄悄不工作了",而且不报错 */
export const SYNC_KEYS: Record<SyncTarget, readonly string[]> = {
  // 四类用途的「当前生效」也一起看着:另一个标签页换了当前配置,本页要跟上
  configs: [
    CONFIG_KEY,
    CONFIG_ACTIVE_KEY,
    TEXT_ACTIVE_KEY,
    VISION_ACTIVE_KEY,
    TTS_ACTIVE_KEY
  ],
  characters: [CHAR_KEY],
  collections: [COLL_KEY],
  prompts: [LIB_KEY]
}

/**
 * 一个 storage 事件该触发哪些目录的重载。
 *
 * key 为 null 表示另一个标签页调用了 localStorage.clear() —— 那种情况下
 * 什么都可能变,四个目录一律重读。
 */
export function syncTargetsOf(key: string | null): SyncTarget[] {
  const targets = Object.keys(SYNC_KEYS) as SyncTarget[]
  if (key === null) return targets
  return targets.filter((t) => SYNC_KEYS[t].includes(key))
}
