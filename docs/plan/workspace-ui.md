# 工作区信息精简与联动

本轮围绕工作区操作与信息组织调整，更新于 2026-11-07。

## 范围

- 左栏仅保留图层开关及设置入口，星座设置归入星空，银河对比度归入银河。
- 右栏以默认折叠的分组集中信息，全局信息排首位。左栏入口展开并定位对应分组，桌面和移动端采用同一交互。
- 移除工作区装饰性标题、常驻操作说明和页脚。保留必要的失败、覆盖、过期与精度反馈，来源继续集中在 About。
- 预览上方汇总镜头、画幅、相机响应、高程与离地高度，画布内保留构图和天体标记。
- 预览滚轮调节 8—1000 mm 焦距，日期和时间滑杆并排，时区和折射并排，相机响应放在相机配置末尾。
- 修复画幅切换后的画布尺寸同步，机位更新保留上一画面，持续等待后才显示加载提示。

## 验收

自动检查覆盖左右栏定位、子设置、时间与时区、滚轮焦距边界、画幅尺寸更新及异步机位生命周期。执行全量测试和 GitHub Pages 子路径构建。

Chrome 实际画面分别验证桌面、窄桌面与移动端，核对折叠、定位、搜索、滚轮、拖拽、1:1 和竖幅切换。数值与 DOM 检查、真实 GPU 画面分别记录。

## 执行记录

2026-11-07 完成本地验收。

### 实现

左栏保留六个图层开关与各自的设置入口。右栏共有七个默认折叠分组，全局信息置首，其余分别对应太阳、月亮、星空、银河、深空天体和空间站。入口会清除搜索、打开右栏、展开目标并定位焦点，移动端同时关闭左栏抽屉。

星座开关归入星空，关闭星空时一起关闭星座，搜索并开启星座时同时开启星空。银河对比度归入银河分组，关闭图层时禁用滑杆并保留数值。光照与天空明暗反馈集中到全局信息。

预览信息条汇总镜头、传感器、画幅、相机响应、高程与离地高度，引擎避让反馈也在画布外显示。滚轮按比例改变焦距，处理像素、行、页三种增量并保留 Ctrl/Meta 浏览器操作。日期编辑保留当地钟点和秒，时间另有秒级输入，滑杆继续按分钟操作，夏令时重复或跳过时拒绝修改。

`data-ready` 表示当前机位已应用，`data-rendered` 控制保留有效画布。新高程等待期间保留旧画面，高程信息显示待更新，持续等待 800 ms 后提示暂留上一机位画面。地形及星空纹理的短暂加载均延迟反馈，错误即时显示。瓦片细化期间继续绘制星空，但遮挡查询与读数等待数据就绪。应用相机姿态前同步真实容器尺寸，取景框宽高均显式约束。

### 自动检查

- `npm test` 全部 189 项通过，包含日期秒钟与 DST、滚轮边界与连续增量、右栏定位与焦点、子设置、保留画布和延迟提示、过期高程取消与错误恢复。
- 画幅回归检查在未触发 ResizeObserver 的情况下改变容器尺寸与比例，确认先 resize 再应用相机。
- GL 替身检查确认瓦片未就绪时继续绘制，遮挡查询不发布已就绪状态，宿主 GL 状态恢复。
- `npm run build -- --base /Tamatamatori/` 通过，沿用现有 MapLibre 大包体积提示。

### Chrome 画面

使用实际 Chrome/WebGL、真实 DEM 与水体，保存 [17 张截图与 DOM 记录](workspace-ui-evidence/browser-results.json)。桌面为 1440×900，窄桌面为 1120×700，手机为 390×844 和 360×640。可见场景的取景框与画布 CSS 宽高均在 1 px 内一致。手机参数及 About 场景隐藏预览，记录的 0×0 尺寸按隐藏处理。

- [默认桌面](workspace-ui-evidence/01-desktop-default.png)核对精简文案与全部分组初始折叠，[方形画幅](workspace-ui-evidence/02-desktop-square-sun.png)与[竖幅](workspace-ui-evidence/04-desktop-portrait.png)核对完整地形渲染。
- [原生滚轮与拖拽](workspace-ui-evidence/03-desktop-wheel-drag.png)将焦距由 35 调至 45.8 mm，方位由 247° 调至约 244.9°，地图与参数同步。机位标记实际拖动后，高程待更新时画布保持可见，新高程完成后继续绘制，见[移动后画面](workspace-ui-evidence/14-desktop-moving-station.png)。
- [星空设置](workspace-ui-evidence/05-desktop-stars.png)、[银河设置](workspace-ui-evidence/06-desktop-galaxy.png)、[全局信息](workspace-ui-evidence/15-desktop-global.png)和[月亮信息](workspace-ui-evidence/17-desktop-final.png)分别核对内容归属与展开。
- [移动端预览](workspace-ui-evidence/08-mobile-preview.png)、[左右栏跳转](workspace-ui-evidence/09-mobile-layer-link.png)、[紧凑参数](workspace-ui-evidence/10-mobile-parameters.png)、[小屏方形与改机信息](workspace-ui-evidence/11-small-mobile-square.png)及[搜索](workspace-ui-evidence/12-mobile-search.png)核对操作入口和尺寸。Escape 先清空搜索，再关闭信息抽屉。
- [空间站分组](workspace-ui-evidence/13-mobile-stations.png)正确保留历元与更新提示。本地附带快照的检查时间早于浏览器已有缓存，页面提示回退并保留缓存，未直接请求轨道上游。
- [About 小屏](workspace-ui-evidence/16-small-mobile-about.png)核对版权入口、滚动和关闭按钮。发现共用按钮样式被清理波及后已恢复，并刷新复验。

01—13 记录工作区交互构建，14—17 刷新到恢复 About 按钮样式后的最终构建。最终入口为 `index-Cr5GaIE-.js`，样式为 `index-TxJyk9lC.css`，与本地子路径构建产物一致，控制台未记录错误。每张截图的资源版本均单独保存。

### 验证边界

请求失败、持续等待和取消通过组件替身检查，真实 Chrome 验收覆盖正常数据与实际手势。800 ms 是显示反馈的等待阈值，地形仍会随瓦片加载细化。上述画面验收验证布局与渲染一致性，地形实景精度沿用既有边界。
