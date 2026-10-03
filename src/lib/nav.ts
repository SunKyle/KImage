/* 站点的一级页面清单。
   两处要用它:顶部导航(分段控件)把它渲染成六个图标,
   顶部字标取"当前在哪一页"的那个名字。各写一份迟早对不上 ——
   加了页面只改一处,所以摆在这儿。

   顺序就是导航上的顺序;value 必须与 App 的 Page 联合类型一致。
   label 是给人看的完整名字:导航里它是悬停提示与读屏名(条目本身只显示图标),
   字标里则直接显示出来 */
export interface NavItem {
  value: string
  label: string
}

export const NAV_ITEMS: NavItem[] = [
  { value: 'home', label: 'Studio' },
  { value: 'chars', label: 'Characters' },
  // 对话紧跟角色:两者是同一个对象的两件事,一个造它,一个跟它说话
  { value: 'chat', label: 'Chat' },
  // 画布紧跟工作室:两者都是"干活的地方",一个是造、一个是改
  { value: 'canvas', label: 'Canvas' },
  { value: 'lib', label: 'Prompt Library' },
  { value: 'history', label: 'History' },
  { value: 'settings', label: 'Settings' }
]
