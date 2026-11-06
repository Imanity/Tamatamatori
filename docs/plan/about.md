# About 与版权信息收束

## 范围与验收

本轮将预览底部的版权、数据来源和衍生数据下载统一移到 header 的 About 弹窗，解决深空署名换行挤压取景框的问题。弹窗始终提供所有已接入来源，独立于图层开关。地图角落保留 MapLibre 紧凑署名控件，完整来源同时列入 About。

使用原生模态 dialog，内容独立滚动，关闭按钮持续可达，支持 Escape、焦点约束与关闭后的焦点返回。打开、关闭不修改拍摄计划或重建地图。地图服务自动署名仍由 SDK 按实际样式提供。

核对自动交互、来源完整性、共享影像下载去重、子路径构建，以及刷新后 Chrome 的小桌面窗口和手机尺寸。JSDOM 不提供真实布局和模态焦点行为，两项由浏览器核对。

## 问题复现

2026-11-06，Chrome 1280×740、默认布局、深空图层开启时，DOM 测得预览面板约 310×270 px，版权列表高 537 px，取景框实际为 0×0。同次最初截图采集于重置布局绘制完成前，保留为[旧版过渡画面](about-evidence/before-layout-transition.png)，不能当作零尺寸状态的画面对照。

## 署名依据

完整作者文字、来源链接、许可及修改说明保持可访问。地图使用紧凑 SDK 署名控件，并在 About 重复提供完整数据来源。ESO 影像的完整作者文字逐幅保留，明确标识对应目标及衍生处理。[OSM 指引](https://osmfoundation.org/wiki/Licence/Attribution_Guidelines)，[ESO 使用说明](https://www.eso.org/public/outreach/copyright/)，[OpenFreeMap 接入说明](https://openfreemap.org/quick_start/)，[Mapterhorn 来源](https://mapterhorn.com/attribution/)

## 执行结果

2026-11-06 已完成本地验证。

- 171 项自动检查通过，新增 About 汇集完整署名、18 个唯一下载、图层独立性及打开/关闭生命周期检查。JSDOM 仅替代原生 dialog 方法入口，未模拟 GPU 或原生焦点管理。
- TypeScript 与 `/Tamatamatori/` 子路径构建通过。14 份生成纹理及发布许可文件与源码逐字节一致，保留既有大 chunk 提示。
- 刷新后 Chrome 1280×740 默认布局，深空开启时取景框恢复为约 261×174 px。390×700 和 360×560 窄屏预览分别约为 332×221、302×201 px，实际地形与蛇夫座影像正常绘制。
- About 在三种尺寸内保留至少 16 px 窗口边距，内容独立滚动，无横向溢出。顶部关闭按钮持续可见，键盘可从关闭按钮进入内容并返回，Escape 返回 About 入口。截图与 DOM 状态分别保存。
- 弹窗列出 14 份影像完整署名，共享的马头／火树合并为一个 PNG 下载。关闭图层仍可查询全部来源。小屏隐藏“工作区原型”徽标，为 About 入口留空间。
- 本轮浏览器错误日志为空，测试视口覆盖已恢复。地图采用 SDK 原生紧凑署名，初始显示署名并可折叠，自动来源随地图样式更新；About 同时汇总项目固定数据来源。

| 场景 | 画面 |
| --- | --- |
| 小桌面预览恢复 | [1280×740](about-evidence/after-small.png) |
| 桌面 About 顶部与底部 | [顶部](about-evidence/about-desktop.png)、[底部](about-evidence/about-desktop-bottom.png) |
| 手机预览 | [390×700](about-evidence/preview-mobile.png)、[360×560](about-evidence/preview-360.png) |
| 手机 About 完整署名与最小宽度 | [顶部](about-evidence/about-mobile-top.png)、[影像署名](about-evidence/about-mobile.png)、[360px 宽](about-evidence/about-360.png) |

[浏览器 DOM 记录](about-evidence/browser-records.json)与[版本及验证汇总](about-evidence/verification.json)保存资源和截图哈希。About 只呈现来源及许可，既有影像的注册、分辨率与定性色彩边界仍见各目标验收记录。
