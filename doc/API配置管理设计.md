# API 配置管理设计

> 本文总结 KImage 中「接口配置（ApiConfig）」的管理设计。
> 相关实现集中在这几处：
> - [SettingsPage.vue](../src/components/SettingsPage.vue) —— 设置页：列表、表单、连通性测试
> - [App.vue](../src/App.vue) —— 配置状态、增删改、导入导出、参数面板、对比出图
> - [api.ts](../src/api.ts) —— 厂商能力表、读写、域名推断、连通性测试
> - [server/index.js](../server/index.js) —— `/api/test` 探活、按厂商/协议转发
> - [types.ts](../src/types.ts) —— `ApiConfig`

---

## 1. 核心设计原则

1. **一个列表，三种用途。** 所有配置放在同一个 `configs[]` 里，靠 `kind` 区分用途：`image`（出图）/ `text`（提示词改写）/ `vision`（识图）。三者要填的模型不是一回事，但地址与密钥常常同源 —— 所以同列表、分区展示。
2. **三类各记各的「当前生效」。** 出图、改写、识图各有独立的 active id 与生效快照，**存一条不该把别类的当前项顶掉**。
3. **草稿与生效值分离。** 设置页表单改的是自己的草稿副本，不直接写父级的生效配置 —— 于是「返回列表」是真正的放弃修改，而不是把半成品留在生效配置里。
4. **能力表驱动界面。** 支持哪些参数、尺寸候选、图生图端点、走哪套协议，全部由 [PROVIDERS](../src/api.ts#L130-L183) 声明，界面按它决定显示什么、代理按它决定打哪个端点。加厂商只改一处。
5. **数据只在本机。** 配置存 localStorage，不上传（密钥也一样）。

---

## 2. 数据模型

`ApiConfig`（[types.ts](../src/types.ts#L1-L16)）：

| 字段 | 说明 |
| --- | --- |
| `id` | 主键 |
| `name` | 显示名。空着时落库按域名推导（`cfgNameFromUrl`） |
| `baseUrl` | 如 `https://ark.cn-beijing.volces.com/api/v3`。**只有它是必填** |
| `apiKey` | 密钥。本地服务可留空 |
| `model` | 模型名 / 推理接入点 id（如 `ep-2024…`） |
| `vendor` | 厂商 id，决定能力表与协议。可选是为了兼容加字段之前的老配置，读取时按域名回填 |
| `kind` | `'image' \| 'text' \| 'vision'`。可选，读取时一律按 `image` 兜底 |

---

## 3. 存储与读写

### 3.1 localStorage 键

| 键 | 内容 |
| --- | --- |
| `kimage.apiConfigs` | 全部配置列表（JSON） |
| `kimage.apiActive` | 出图类别当前生效配置 id |
| `kimage.apiActiveText` | 改写类别当前生效配置 id |
| `kimage.apiActiveVision` | 识图类别当前生效配置 id |
| `kimage.apiConfig` | **旧键**（单份配置格式），迁移后删除 |

### 3.2 读写（[api.ts#L336-L410](../src/api.ts#L336-L410)）

- `loadConfigs()`：读列表，逐条过 `normalizeConfig`；读不到新键时回退读**旧键**，搬成列表后写回新键，并**把旧键删掉** —— 一份密钥在站点上存两处不该是长期状态。删除单独兜一层：它失败不该把这次迁移一起判死。
- `saveConfigs(list)`：整表覆盖写。
- `normalizeConfig()`：补 `vendor`（没有就按域名猜）、规整 `kind`（只认 `text` / `vision`，其余一律 `image`）—— 加字段之前存的都是出图配置，外部脏数据不该让配置错类或消失。

四个 active id 各有 `loadActiveXxxId` / `saveActiveXxxId`。

---

## 4. 厂商能力表

### 4.1 Provider 与 Cap（[api.ts#L31-L128](../src/api.ts#L31-L128)）

`Cap = 'yes' | 'no' | 'unknown'` —— `unknown` 表示"填了就发"，既不假装支持也不假装不支持；**只拦明确知道的**（如 OpenAI Images API 没有 `seed`）。

| 字段 | 作用 |
| --- | --- |
| `quality` / `background` / `seed` / `multiImage` | 能力开关，界面据此决定给不给控件 |
| `sizes` / `autoSize` | 尺寸候选 / 有没有"模型自决"这一档 |
| `edit` | 图生图打 `generations` 还是 `edits` |
| `protocol` | `openai`（/images/generations）或 `gemini`（原生 `:generateContent`） |

各厂商要点：
- **OpenAI**：`quality/background` 支持；`seed` 不支持；`multiImage` 支持；尺寸随模型代次细分。
- **Doubao Seedream (Ark) / 通义万相 (DashScope)**：参数大多不支持；**单图**（`multiImage: 'no'`）；`sizes: 'free'` 且 **无 auto 档**。
- **Gemini**：走原生协议；`quality/background` 不支持（多给未知字段会被 Google 拒）；`multiImage` 支持（parts 里并列多段 inlineData）。
- **Custom**：兜底项，未知一律按"不确定"处理，照常展示但不静默丢弃。

### 4.2 按 (厂商, 模型) 解析

`getProvider(id, model)`：能力表**不只看厂商还看模型** —— 中转站自己就是看模型名决定后端的，我们必须跟它一致（同一个地址上 OpenAI 系走 `/images/generations`，Gemini 系走原生 `:generateContent`，判错会打到对方不实现的那条路）。`custom` + 模型名命中 `GEMINI_IMAGE_RE`（`gemini|imagen|banana|nano-banana`）时改判 Gemini。

### 4.3 域名推断（`inferVendor`）

老配置没有 `vendor` 时按域名猜。**`gemini` 必须排在 `openai` 前面**：Gemini 的 OpenAI 兼容层地址是 `…/v1beta/openai`，含 "openai"，顺序反了会把尺寸候选、门控、协议全按错的那家来。只认 `generativelanguage`（AI Studio），**故意不认 `aiplatform.googleapis.com`**（那是 Vertex，鉴权与模型名都不是一套）。

### 4.4 三份预设表

| 表 | 服务于 | 内容 |
| --- | --- | --- |
| `PROVIDERS` | 出图 | 含完整能力表与协议 |
| `TEXT_PROVIDERS` | 改写 | 只要 `id / label / baseUrl / model?`。DeepSeek 只在这份里（它没有出图模型，给出图那行放它等于骗人） |
| `VISION_PROVIDERS` | 识图 | 同上；要的是"能看图的对话模型"，百炼同样走 compatible-mode |

> 百炼要单列一条：它的 `/api/v1` 是原生协议，对话得走 `/compatible-mode/v1`，填错会 404。
> 文本与识图共用同一个回填函数 `applyTextProvider`（预设行不同，填法一样）。

---

## 5. 三类用途与「当前生效」

### 5.1 状态（[App.vue#L679-L698](../src/App.vue#L679-L698))

| 状态 | 含义 |
| --- | --- |
| `configs: ApiConfig[]` | 全部配置 |
| `config` | 出图当前生效的**副本**（生成请求照它发） |
| `activeId` | 出图当前生效 id |
| `textConfig \| null` | 改写当前生效副本；`null` = 列表里还没有文本配置 |
| `activeTextId` / `activeVisionId` | 各类当前 id |
| `cfgView` / `cfgSeed` | 设置页视图（list/form）与表单种子 |

拷贝而不是引用：改设置页表单不会动生效值，只有存下 / 设当前才会。

### 5.2 启动挑选（onMounted）

每类各一套"按存的 id 找 → 落空退第一条 → 都没有则保持空/`null`"：
- 出图：`find(id === activeId && kind !== 'text' && kind !== 'vision')` → 退第一条非文本非识图；回填 `activeId`（存着的 id 可能指向已删的配置，不同步的话设置页一条都不会亮）；
- 改写 / 识图：`find(id === activeXxxId && kind === 'xxx')` → 退第一条同类；没有则 `null`（增强按钮 / 角色向导会提示去配一条）。

### 5.3 重挑（repickActive*）

删除、改用途两条路共用。**不收拾的话生效值会悬空** —— 界面显示着它，它却已经发不出请求：
- `repickActiveImage`：按用途取第一条，没有就清空并写回空 id；
- `repickActiveText` / `repickActiveVision`：同构，没有则置 `null`。

---

## 6. 设置页

骨架与提示词库、历史页一致（标题行 → 内容），两个视图：

### 6.1 列表视图

- **一张纸，不是一组卡片**：大圆角 + 弥散投影；分组只用一条两端各留 12px 的细线分开（横贯整张纸的线会把纸切成两半，与"有呼吸感"的分隔语言不搭）。
- **按用途分三组**（`groups`）：`Image generation` / `Prompt enhancing` / `Image recognition`，空组直接滤掉。每组各自比自己的 activeId 判「Current」。
- **行本体是 `<button>`**：整行可点 = 把这条设为该类的当前生效（分别走 `activate` / `activateText` / `activateVision`）。状态列定宽 68px，所有行的名字从同一条竖线起排。
- **Current 徽标**：当前生效那条在状态列放一枚墨色实心药丸；其余留空 —— "现在走的是哪条"不读名字就能扫到。
- **行内副标题 = 模型 · 厂商**（`identLine`），地址不再出现在列表里（编辑表单里本来就有）。
- **⋮ 溢出菜单**（Edit / Duplicate / Delete）：常态 `opacity: 0`，行 hover / 聚焦 / 展开时显形 —— 三个常驻方形图标键正是"管理后台"味道的来源。触屏没有 hover，用 `@media (hover: none)` 让它常驻。菜单用 `role="group"` 而非 `menu`（`menu` 承诺方向键导航，这里只有 Tab，声明成 `menu` 等于许了做不到的事）。
- **删除一次点击即删**：删完有一条燃烧的撤销窗口兜着，比多一步确认更可逆。
- 标题行：**New config**（黑药丸）+ 一个 ⋮ 菜单（**Export JSON (includes key)** / **Import configs**，低频动作不给标题行添按钮）。

### 6.2 空态：四条能一键预填的入口

- 第一排：`PROVIDERS` 前三条（跳过 custom）+ **My own endpoint**；
- 第二排（单独起一排）：`VISION_PROVIDERS` —— 它解决的是另一个问题（把上传的参考图读成角色设定），混在第一排里会被当成又一个出图选项；
- 副标题写清"会替你填好的地址与模型"（`quickHint` / `endpointLine`），地址与模型由厂商表推导，界面不抄第二份。

### 6.3 表单视图（新增 / 编辑）

字段顺序即决策顺序：

1. **What is this config for?** —— 三个带说明的单选项（Image generation / Prompt enhancing / Image recognition）。用途决定后面所有字段的含义，所以给几行说明而不是一排只有名字的胶囊。
2. **Provider 预设行** —— 随用途切换数据源（图像 / 对话 / 视觉）。
3. **Name**（可选，空着按域名推导）
4. **Base URL**（唯一的必填，提交前校验）
5. **API Key**（默认 `password`，右侧有显隐键）
6. **Model**（placeholder 随用途变）

表单**收窄并居中**（`max-width: 720px`）：单行输入拉到 900px 宽会读得很散。列表则铺满（两侧徽标与菜单正好互为对边）。

### 6.4 草稿与预设回填（[SettingsPage.vue#L112-L174](../src/components/SettingsPage.vue#L112-L174)）

- `watch(props.seed)`（immediate）灌草稿：seed 变了就重置一次；顺手**收回密钥显隐**（上一条的状态不该带过来）并**清掉上一条的报错**（留着会被挂在刚打开的那条配置上）。
- `setPurpose(kind)`：只切 `kind` 并换预设行。**保留已填的 `baseUrl` / `apiKey`**（地址与密钥常常同源，用户可能刚填好），但**一定要清空 `model`**（图像模型名拿去打 `/chat/completions` 必错，留着只会让人以为还能用）。
- `applyProvider(p)`：**只补空，不覆盖** —— 换厂商常常只是想换个能力表或协议，而地址多半是自己粘的中转或自建接口，被预设覆盖掉就得重新找一遍。空着的字段才用预设补上。
- `applyTextProvider(p)`：地址照写（高亮比的就是地址，它是身份），模型只补空，**`vendor` 也要写下去** —— 它本来只在出图那条路上被写，于是文本配置的 `vendor` 一直是 `custom`，从 DeepSeek 换成 OpenAI 也照样顶着「接线」图标。
- 预设高亮 `presetOn`：直接比地址（忽略尾斜杠与大小写），不为了高亮再存一个状态。

> 与"新增配置"空态那四条入口区分：那条路走 `seedFor`，直接给一张填好的表（"从零开始"的语义），不受"只补空"约束。

### 6.5 提交校验

- 必填只有 `baseUrl`；空 → "paste the endpoint your provider gave you, e.g. …"；
- 必须能 `new URL()` 且协议为 `http(s)`；
- 报错**顶掉说明行**，不叠成两段小字；`role="alert"`（异步判定出来的，读屏要主动念）。

---

## 7. 连通性测试

[testConnection](../src/api.ts#L426-L462) → `POST /api/test`。

### 7.1 服务端策略（[server/index.js#L1086-L1216](../server/index.js#L1086-L1216)）

按顺序两条：
1. **GET /models** —— 顺带回答"目标模型在不在它的清单里"。两条协议回法不同：OpenAI 是 `{ data: [{ id }] }`，Gemini 是 `{ models: [{ name: 'models/xxx' }] }`；
2. **缺参探测**（那家没有 `/models`）—— 发一个空请求打真实端点，上游因缺参数回 400/422，**400 恰好证明地址、路径与密钥这条链是通的**。不会真的生成图，所以点几次都不花钱。

探活的端点是真实的那个：出图打 `/images/generations`，改写与识图都打 `/chat/completions`（识图只是消息里多带一张图）。

### 7.2 结果结构

`TestResult = { ok, code?, via?, modelListed?, status, ms, detail? }`
- `code`：`auth`（密钥被拒）/ `endpoint`（没有这个端点）/ `server`（上游自己出错）/ `network` / `timeout`；
- `via`：`models`（走 GET /models）或 `probe`（退回探测）。

### 7.3 文案翻译（`testMessage`）

服务端只回机器可读的 `code/status`，怎么说由前端定：
- 成功且 `via='models'` 时多说一句模型在不在清单里；**不在也不算失败**（清单常常列不全），只在中性色里提一句并写明生成仍可能可用；
- `server` 且 `status < 400` 时特判：地址少了 `/v1` 前缀时网站会把首页当 200 回，"answered 200"只会让人困惑 → 说成 "Answered with a web page instead of an API response"；
- 耗时 <1000ms 写 `xx ms`（局域网几十毫秒回来，写成 "0.0s" 会显得没测一样）。

### 7.4 前端一致性保护

- **草稿一动就清掉测试结果**：结果只对"当前这一版草稿"有效，留着上一次的 "Connected" 会让人以为新地址也验过了；
- **代次 + 快照**（`testSeq` + `sameDraft`）：用户可能在等待中改了草稿、切走或再点一次 —— 回来时对不上代次 / 快照就丢弃，避免"测的是 A，提示却说 B 可用"。

---

## 8. 增删改与导入导出

### 8.1 增 / 改（[saveSettings](../src/App.vue#L908-L962)）

按 `id` 判断插入还是覆盖；`name` 空着按 `cfgNameFromUrl` 推导。要点：

- **改用途必须从原那一侧退场**：记下 `prevKind`，若与新的 `kind` 不同，原侧的「当前」要重挑 —— 否则那边还留着它改之前的快照，界面说"当前用它"，实际发出去的却已经不是一回事。出图侧还要把它从多选集合里摘掉。
- **按用途分派到各自的「当前」**：三类各自独立。同步的是**副本**（`{...cfg}`），之后改表单草稿不能再牵动生效值。
- 出图侧还要维护多选集合：新建一条时直接收敛成只选它；改一条已有的缺了才补上（不能把正在做的多模型对比打散），已选满则同样收敛。
- 留在列表视图：刚存下的那条会带「Current」标记，比直接跳走更容易确认。

### 8.2 新增 / 复制 / 编辑入口

| 入口 | 行为 |
| --- | --- |
| `newConfig(seed?)` | 进入表单；`seed` 为厂商预填（空态四条入口带）/ `null` 为空白 |
| `duplicateConfig(c)` | `{...c, id: '', name: 'xxx copy'}` → 表单 |
| `editConfig(c)` | `{...c}` → 表单 |
| `cancelConfig()` | 回列表（**真正的放弃修改**，草稿是页面自己持有的） |

### 8.3 删除（[removeConfig](../src/App.vue#L1006-L1055)）

- 立即改列表 + 按用途重挑各类「当前」（删的可能是三类里任意一条）；
- 从多选集合摘掉它（留着会让长度算错：剩两条其实只剩一条，却仍被当成对比模式），摘完一个不剩就退回当前这条；
- 落盘推迟到撤销窗口结束；撤销时用**"当前列表 + 插回这一条"**而不是整份旧快照（窗口里万一改了别的配置，不该被一起回滚），并恢复「当前生效」指向。

### 8.4 导入（[importConfigs](../src/App.vue#L1155-L1199)）

外部文件逐条规整：
- 没有 `baseUrl` 的丢掉（存下来也发不出请求）；
- **id 撞了就换新**，并维护一份"这次已用掉的 id"（只跟现有列表比不够：map 期间 `configs` 不变，同一文件里两条同 id 会双双通过）；
- `kind` 只认 `text` / `vision`，其余一律 `image`；
- **追加而不是覆盖**（导入是补充）；
- 原本一条都没配时，顺手把导入里第一条出图配置设为当前（否则导完照样发不出请求）；文本 / 识图两侧同理，缺哪条补哪条。

### 8.5 导出 / 导入文件

- 导出（`exportJson`）：把 `configs` 原样写成 JSON，**包括 API Key**。菜单上直接写明 "includes key" —— 不带 Key 的备份没有意义（换台机器导回去还要一条条补），别让人以为导出的是脱敏版本。
- 导入（`onImportFile`）：只负责读文件、`Array.isArray` 校验，内容规整交给主界面（它才知道现有 id 有哪些）。选错文件就当作没选，不打断。

---

## 9. 参数面板与对比出图

### 9.1 面板分组（[App.vue#L2829-L2889](../src/App.vue#L2829-L2889)）

参数面板按用途分三组，各自标各自的"当前"：

| 组 | 交互 |
| --- | --- |
| Image model | **芯片即多选**：点一下加入/移出这次生成 |
| Text model | 单选（点了就设为当前） |
| Vision model | 单选 —— 它不进"这次跑哪几个模型"的选择集合，只在角色向导里读参考图 |

### 9.2 多选即对比（Model Race）

- **没有单独的"对比"开关**：芯片本来就是多选，选一个 = 平时那样，选两个以上 = 对比模式（`compareMode`）；
- `RACE_MAX = 4`（花费线性增长，四个已经排满一屏）；选满后其余芯片禁用，`title` 说明原因；
- `toggleSelectedId`：**至少留一个**（一个都不选，生成键就无事可做）；卸掉的正好是主模型时，顺位给剩下的第一个 —— 尺寸候选、画质门控、改写风格都照主模型来，不能让"当前"指向一个已经不在选择里的配置。

### 9.3 能力表驱动的门控

- `provider`：按 `(vendor||inferVendor, model)` 解析能力表；
- `capabilityNote`：**描述的是当前生效的接口，不是表单里正在挑的** —— 参数栏的门控跟的是生效配置，说明文字要是跟着草稿走两者就对不上。Gemini 的图生图没有独立端点（参考图是同一个 `:generateContent` 里的另一段 parts），所以要特判；
- `sizeOptions`：候选随厂商（以及 OpenAI 模型代次）变化；**上游没有 auto 档就把这一项摘掉** —— 留着会让界面显示"自动"，而请求里根本带不了这个参数（带了就 400），看起来像"模型没按 prompt 定比例"，其实是我们自己把这一档抹掉了；
- `watch(sizeOptions)`（immediate）换厂商 / 换模型后自动回退到第一个合法尺寸。

### 9.4 状态胶囊

- `activeConfigName`：名字优先，未配置显示占位；
- `imagePillName`：多选时写成「主模型 +N」—— 点一下就从单模型变成多模型，加选一个会变成一次双倍花费，不写明就有意外；
- `selectionTip` / `selectionAria`：同时报出出图与文本两个当前模型。

---

## 10. 关键约定与易错点

1. **三类「当前」互不隶属**：`activeId` / `activeTextId` / `activeVisionId` 各存各的，任何一条的读取、保存、删除、改用途都要按类别处理，不能一刀切。
2. **`inferVendor` 里 Gemini 必须排在 OpenAI 前面**（`/v1beta/openai` 含 "openai"，顺序反了会全按错的那家来）。
3. **文本 / 识图配置的 `vendor === 'custom'` 不可信**（字段是后加的，旧数据里都是 custom）——`vendorId()` 对这两类会按域名重新认一次；出图配置不动，那里的 custom 是用户明确选的。
4. **能力表按 (厂商, 模型) 解析**，不是只看厂商：中转站按模型名决定后端，我们必须跟它一致。
5. **`unknown` ≠ 不支持**：只拦明确知道的（如 OpenAI 的 seed、Ark/万泉的多图），其余"填了就发 / 能发就发"。
6. **导入 id 必须换新**，且要维护本次已用 id 集合。
7. **导出不脱敏**，这一点写在菜单文案里。
8. **生效值是副本**：表单草稿、多选集合、尺寸 / 画质 / 背景的门控都读生效配置，改草稿不应牵动它们。

---

## 11. 一句话回顾

> 一个列表装三类接口，各记各的「当前」；能力表按 (厂商, 模型) 声明差异，界面按它决定露出什么、代理按它决定打哪个端点；表单管草稿、生效值用副本，于是"返回"就是真的放弃；连通性靠真实端点上的空请求验活，点几次都不花钱。
