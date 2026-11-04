# 远山地形细节与 SDK 兼容修正

更新：2026-11-04。沿用同源 Terrarium DEM，最高 z12，图像始终为 512 像素；本轮调整采样与绘制层级，不增加源数据精度。

## 下载与绘制采用同一策略

MapLibre 6.16.0 的公开源 `calculateTileZoom` 回调用于 DEM 下载，但地形的 `TerrainTileManager.update` 覆盖计算漏传该回调，仍沿用默认地图浏览策略。仅调用 `setSourceTileLodParams` 增加下载不能改变实际网格。

固定 SDK 为 6.16.0，安装时由 [patch-maplibre.mjs](../../scripts/patch-maplibre.mjs) 在该覆盖调用中补充 `calculateTileZoom: this.getSource().calculateTileZoom`。同时修正实际使用的 ESM 和 CPU 测试使用的源代码；不修改 Worker，也不访问运行时私有字段。脚本检查版本及唯一片段后再写入，重复运行无变化；签名不匹配即失败，升级 SDK 必须重新验证。移除失配的 ESM source-map 声明，保留原版权与完整许可。

`npm ci` 自动运行安装脚本。跳过安装脚本的环境需手动运行该文件；自动检查会核对源代码及 ESM 的补丁存在，并实际运行 SDK 的网格管理器，避免只修测试路径。

## 摄影视场策略与资源边界

预览通过公开 Map LOD setter 使覆盖失效，再设置公开 Source 的计算回调。以取景框 CSS 高度、SDK 传入的实际垂直视场和候选瓦片距离估算每个网格单元的屏幕尺寸，目标为约 8 CSS px。网格有 128 个分段，归一化 Mercator 空间中单元宽度为 `1 / (128 × 2^z)`；按透视尺寸求所需 z，限制在 0—14。实际地形高度、斜视和边界影响结果，该目标不是严格的像素误差承诺。

- 512 像素 z12 DEM 的水平采样间距与 128 分段 z14 网格相当；禁止近处继续细分到 z22，避免对同一数据过度插值及大量 RTT 分配。
- 下载仍受来源 maxzoom 12 限制。远方或较小取景框可使用较粗层级；长焦和大取景框按投影需要细化，不按焦距单独判定，更不全局强制 z12。
- 地形源的样式 `tileSize` 设为 128。该属性是**最小视觉尺寸**，并非图像尺寸；独立解码和 SDK DEM 图像仍是 512 像素。SDK 的 RTT 为该视觉尺寸的 2 倍，再乘 2 倍颜色质量，主颜色纹理约为 512×512，理论约 1 MiB/张，不含其他纹理、缓存和图层。原 512 视觉尺寸对应的主颜色纹理为 2048×2048。
- 回调随 SDK 每次传入的视场自动变化；只有取景框高度变化才重装回调。变焦和换向不重建地图，不重新请求机位高程；普通地图底图和水体矢量来源不应用该策略。

开发校准器额外读取参考点 z9—z12 的少量同源瓦片，保留当前绘制高程和独立采样，不用其中某个数值覆盖实际网格。实际相机仍按[相机校准设计](camera-calibration.md)读取，日月继续共享当前地形深度。

参考：[Map LOD API](https://maplibre.org/maplibre-gl-js/docs/API/classes/Map/#setsourcetilelodparams)、[栅格 DEM 样式与 tileSize](https://maplibre.org/maplibre-style-spec/sources/#raster-dem)。SDK 细节同时核对当前安装源码；本地补丁不代表上游已合并。

执行结果与边界见[远山 DEM 验收](../plan/terrain-detail.md)。这解决层级一致性，不替代 DEM 垂直基准、真实控制点或地球曲率校准。
