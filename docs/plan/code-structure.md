# 代码结构整理

状态：2026-11-14 用户认为代码文件“全都是平铺的”，确认先提交第十六轮（`cb60407`），再按本文分步整理。本文属于“整理收尾”。同日完成第一步、第二步与第三步的第一部分，分别提交为 `a73b65d`、`4ad525d`、`0499dc1`，并按用户授权推送。更新：2026-11-14。

## 1. 现状

- `src/` 下有 125 个文件，分三层平铺：
  - `domain/`：52 个，约 1 万行，纯函数；
  - `components/`：38 个，约 8 千行，界面组件，混有数据钩子（`use*.ts`）与 Worker 分派（`solve-runner.ts`）；
  - `preview/`：35 个，既有 WebGL 图层与着色器，也有联网或读文件的加载器和后台线程。
- 另有 `src/map/`（地图 SDK 入口与样式）。
- 同一功能分散在各层的平铺目录中。例如推算：`domain` 10 个文件、`components` 5 个、`preview` 3 个。
- 大文件：
  - `MapPanel.tsx` 1037 行、`Composition.tsx` 973 行、`ScenePanels.tsx` 873 行、`starfield-layer.ts` 878 行、`App.tsx` 627 行；
  - 全局样式 `styles.css` 1640 行；
  - 交互测试 `interactions.test.mjs` 3594 行，94 项。
- 依赖方向：唯一的反向引用是 `domain/buildings.ts` 从 `preview/terrain-perspective-math.ts` 引用类型。该文件只依赖领域层，本身就是纯计算。
- 测试：44 个文件平铺，`package.json` 逐个列出。

## 2. 原则

1. **行为不变**。每步结束都要通过：
   - 全部自动检查；
   - `tsc`、`formats:verify`、`landmarks:verify` 与子路径构建；
   - 内置浏览器的冒烟检查（地图、预览、右栏、推算面板正常加载，控制台无错误）。
2. **只移动，不改文件名**。文档中大量只写文件名（如 `alignment.ts`），保留文件名后这些写法仍然成立，按名搜索也照常可用。用 `git mv` 移动，保留历史。
3. **领域层仍只放纯函数**。新增一项检查约束依赖方向：
   - `domain` 只引用 `domain` 与 `data`；
   - `io` 不引用 `render` 与 `ui`；
   - `render` 不引用 `ui`。
4. **路径引用一并更新**，包括：
   - 源码与测试中的相对引用、Worker 地址与 `?raw` 着色器；
   - 测试按路径替身的模块；
   - `vite.config.ts` 中的补丁输入；
   - `package.json` 与 CI；
   - Markdown 文档中的路径与链接。

   不改：
   - 证据目录中的数据文件（JSON、TXT、CSV、图片）。它们是当时的记录，其中的路径与哈希属于当时的文件。
   - 生成数据中记录的来源脚本路径。
5. **不引入路径别名**。同一份领域代码要被浏览器、Worker、命令行和 Node 测试直接加载，别名需要在四处分别配置，相对路径不需要。
6. 每步单独提交。推送按用户当轮授权。

## 3. 目标布局

文件名不变，只换目录。

```text
src/
  App.tsx  main.tsx  vite-env.d.ts
  styles/                  全局样式按区域分文件，index.css 按原顺序引入
  data/                    静态数据（不变）
  domain/                  纯函数
    core/                  计划、坐标、地图几何、地形取样、星历、折射、投影、可见性、站点
    time/                  时区、时间轴、日内事件
    sun-moon/              太阳、日月食、日月轨迹与方位线
    sky/                   亮星、星座、深空、天空亮度、固定方向天体、目标搜索、流星雨
    comets/  stations/     彗星；空间站
    environment/           天气、光污染、Open-Meteo 用量、潮汐、极光
    buildings/             建筑与地标
    shots/                 机位格式与机位库
    solve/                 推算：求解器、构图约束、执行器、推算请求、报告、日历、机位检查
  io/                      加载器与后台线程（14 个，平铺）
  render/
    scene/                 地形投影、相机、校准、环境光、建筑图层、地形着色器与样式
    sky/                   星空、日月、彗尾、流星、深空与银河纹理、天气着色器
  ui/
    common/                图标、分组、数值框、读数、图层开关定义
    map/                   地图面板、地点搜索、机位条、SDK 入口与地图样式
    preview/               预览、相机条、建筑读数
    workspace/             右栏、About、时间轴、时区
    sky/  environment/  shots/  solve/   各分组的界面与数据钩子
tests/
  core/  sky/  environment/  buildings/  time/  shots/  feeds/  solve/
  ui/                      交互测试按功能拆分，共用 harness.mjs
  fixtures/                不变
```

- `terrain-perspective-math.ts` 移入 `domain/core/`，消除反向引用。
- `io/` 只有 14 个文件，按文件名已能分辨功能，不再分子目录。
- `scripts/` 不移动。原因：
  - 文件名已按 `build-`、`check-`、`patch-`、`update-`、`generate-` 分组；
  - 生成数据（`deep-sky.json`、`meteor-showers.json`）与第三方声明记录了来源脚本的路径，移动后要么重新生成，要么手改生成文件；
  - Python 脚本按自身位置推算仓库根目录。

## 4. 分步

原提议的第二步“分层改名”与第三步“层内分子目录”合为一步，使每个文件只移动一次。

### 第一步：测试

- **测试运行方式**：`npm test` 改为按 `tests/**/*.test.mjs` 匹配，不再逐个列出；`test:terrain` 改为新路径。
- **拆分交互测试**：
  - 工作区准备代码（SDK 替身、全局对象、Vite 服务、各类等待与输入辅助）移到 `tests/ui/harness.mjs`；
  - 由测试改写的替身加载函数集中为一个导出对象；
  - 94 项按功能拆成数个文件，测试内容不改。
- **其余测试**按功能移入子目录。

验收：检查数仍为 484 项且全部通过；拆分前后每项测试名称一一对应。

### 第二步：源码分层与分组

- 按第 3 节一次移动，并更新所有引用。
- 新增依赖方向检查（`tests/core/boundaries.test.mjs`）。
- 同步更新以下文档中的目录说明：
  - [全局架构](../architecture/overview.md)；
  - `AGENTS.md` 与 `README.md`。

验收：除第一步的检查外，构建产物中的模块数与 Worker 包大小不变。

### 第三步：拆大文件

- **组件**：
  - `MapPanel`：按地图叠加层拆；
  - `Composition`：状态钩子与面板各分区分开；
  - `ScenePanels`：按右栏分组拆；
  - `App`：把机位、链接与布局状态拆到钩子。
- **样式**：`styles.css` 按功能拆成多个文件，按原顺序引入，保证层叠顺序不变。
- `starfield-layer.ts` 只在有清晰边界时拆。

验收：除第一步的检查外，构建产物中合并后的 CSS 与拆分前逐条相同（忽略空白）。

## 5. 风险

- 改动面大。每步只做移动与必要的引用更新，行为改动不混入。
- 测试按路径替身的模块若漏改，测试会加载真实模块。拆分后的测试检查数必须与拆分前相同。
- Worker 与 `?raw` 着色器的地址改错只在构建或浏览器中暴露。每步都执行子路径构建与浏览器冒烟检查。
- 移动后，历史提交中的文件需要用 `git log --follow` 查看。

## 6. 执行记录

### 第一步：测试（2026-11-14）

- **交互测试**：`tests/interactions.test.mjs` 拆为 `tests/ui/` 下 7 个文件，按原顺序连续分段：

  | 文件 | 项数 |
  | --- | --- |
  | `map-camera` | 7 |
  | `preview` | 15 |
  | `sky` | 15 |
  | `workspace` | 15 |
  | `shots-time` | 12 |
  | `layers` | 17 |
  | `solve-panel` | 13 |

  - 原文件的替身类、全局对象、Vite 服务与辅助函数移到 `tests/ui/harness.mjs` 并导出。
  - 由测试改写的三个加载函数改为 `stubs.groundResponse` 等。
  - 各文件只导入用到的名称（按语法树收集）。
  - 测试名称与顺序在拆分前后逐项相同。
- **其余 43 个测试**移入子目录：

  | 目录 | 个数 |
  | --- | --- |
  | `core` | 7 |
  | `sky` | 13 |
  | `environment` | 5 |
  | `buildings` | 2 |
  | `time` | 2 |
  | `shots` | 1 |
  | `feeds` | 2 |
  | `solve` | 11 |

  文件中指向 `src`、`public`、`node_modules`、`fixtures` 与 CI 配置的相对路径都加深一层。`dev-config` 测试写进临时项目的补丁脚本中的 `../src/…` 相对临时项目，保持不变。
- **运行方式**：
  - `npm test` 改为 `--test "tests/**/*.test.mjs"`；
  - `.gitignore` 的临时目录改为 `tests/**/.dev-config-*/`。
- **文档**：
  - 测试路径随之更新；
  - `reverse-planning.md` 中指向原交互测试的 7 处改为 `tests/ui/solve-panel.test.mjs`；
  - 证据目录中的 `verification.json` 记录的是当时的文件与哈希，不改。
- **检查**：484 项全部通过。交互测试可以并行运行后，本机整套用时由约 74 秒降到约 34 秒。

### 第二步：源码分层与分组（2026-11-14）

- **移动**：
  - 127 个文件按第 3 节移动，文件名不变；
  - `src/components`、`src/preview`、`src/map` 不再存在，`src/domain` 根目录不再有文件；
  - `terrain-perspective-math.ts` 移入 `domain/core/`，领域层不再引用 `preview`。
- **引用更新**：
  - 源码、测试与脚本中 874 处相对引用，包括动态 `import()`、Worker 地址、`?raw` 着色器与深空纹理地址；
  - 24 处按根路径写的字符串，包括测试替身、`vite.config.ts` 的补丁输入与 `ssrLoadModule`；
  - Markdown 文档中 96 处路径与链接。
- **手动处理三处**（都是由多个片段拼出或位于另一项目中的路径）：
  - `buildings` 测试拼接的着色器目录；
  - `camera-calibration` 测试中带条件表达式的着色器地址；
  - `dev-config` 测试写进临时项目的着色器路径与监视目录。
- **未改**：
  - 文档中 3 处指向第十轮已删除组件（`Alignment.tsx` 等）的历史记录；
  - 两处目录级提法：本文第 1 节的现状描述，以及 `reverse-planning.md` 中“求解器写在 `src/domain/`”，后者仍然成立。
- **依赖方向检查**：新增 `tests/core/boundaries.test.mjs`，含两项：
  - 各层只引用允许的层；
  - 领域、绘制与界面层根目录没有散放的文件。

  放入违规文件后两项都会失败。
- **检查**：
  - 486 项通过（新增上述 2 项）；
  - `tsc`、`formats:verify`、`landmarks:verify` 与子路径构建通过。
- **构建产物对照**：
  - 与移动前同为 221 个模块；
  - 分块名称与大小相同，`range.worker` 包的哈希不变；
  - 只有 `deep-sky-texture` 多 45 字节：15 个纹理地址各多一级 `../`。
- **内置浏览器**（子路径构建，面板隐藏，用文字与网络记录检查）：
  - 页面加载后地面高程读出约 980.5 m；
  - 打开“月亮落在塔尖”推算请求链接，载入并推算，3 秒得 7 天 18 段；
  - 所有分块与 `range.worker` 都返回 200，控制台没有错误。

### 第三步：拆大文件（第一部分，2026-11-14）

本次完成能机械验证的部分：按顶层声明移动，导入与导出自动补齐，其他文件的导入改为指向新文件。

- **样式**：
  - `styles.css` 按原有空行与注释边界切成 `src/styles/` 下 12 个文件，`index.css` 按原顺序 `@import`；
  - 最大的 `panels.css` 371 行；
  - 依赖整份样式的交互测试改为按 `index.css` 的顺序读入；
  - 构建合并出的 CSS 与拆分前逐字节相同（文件哈希不变）。
- **`Composition.tsx`**（973 行）拆为：

  | 文件 | 内容 | 行数 |
  | --- | --- | --- |
  | `Composition.tsx` | 面板 | 45 |
  | `useComposition.ts` | 状态与地图几何 | 374 |
  | `CompositionEditors.tsx` | 目标、范围、筛选分区 | 316 |
  | `CompositionResults.tsx` | 结果、剖面、机位列表 | 196 |
  | `composition-format.ts` | 时间、距离与百分比的写法 | 16 |

  - 引用 `useComposition`、`CompositionState`、`compositionGeometry` 的 5 个文件改为从 `useComposition.ts` 导入；
  - 删去面板文件中无人使用的 `LoadedSampler` 类型再导出（第十六轮遗留）。
- **`App.tsx`**（627 → 486 行）：
  - 面板、分隔条与窄屏判断移到 `src/ui/workspace/Layout.tsx`；
  - 窄屏断点的说明随之指向新位置。
- **检查**：
  - 486 项通过；`tsc` 与子路径构建通过；
  - 模块数 221 → 226（新增 5 个 TS 文件，CSS 分段经 `@import` 内联后只计 1 个）；
  - `range.worker` 包的哈希不变；
  - 内置浏览器（子路径构建）：推算面板的模板、目标、分区正常；同一推算请求仍得 7 天 18 段，用时 3.6 秒；分隔条与右栏宽度正常；控制台没有错误。
- **留待下一轮**：以下三处的主体都是单个大函数或类，拆分要改变闭包状态的传递，不再是单纯移动，需要逐段阅读并在可见的浏览器中核对画面。
  - `MapPanel.tsx`（1037 行）：一个 560 行的初始化效果，其中 188 行的 `style.load` 回调逐个加入地图图层，并改写外层的 4 个“已绘制”状态。
  - `ScenePanels.tsx`（873 行）：一个 807 行的组件。
  - `starfield-layer.ts`（878 行）：一个 728 行的 WebGL 图层类。
