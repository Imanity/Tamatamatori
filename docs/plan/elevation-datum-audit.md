# 现用 DEM 高程基准核查

本篇保留高程核查轮次结果。后续已按用户要求完成[参考曲面的默认空间投影](terrain-perspective.md)，本篇的数据精度限制继续适用。

更新：2026-11-04。状态：本轮核查完成；现有证据不足以启用正式自动椭球高转换，条件几何原型可继续推进。

## 本轮范围与判据

接续[曲率对照](curvature-validation.md)，核查当前 Mapterhorn TileJSON、覆盖索引、处理代码及来源声明，判断是否足以自动转换成椭球高。只读取少量公开元数据与固定点覆盖瓦片；不下载区域 DEM，不更换正式数据源、不实现曲率地形或改变日月星历。

正式自动转换需要四项证据：当前瓦片版本可定位、眼点与目标所在像素的来源及混合方式可追溯、源高程基准与历元明确、适配转换模型及覆盖/许可明确。数据不足时保留“未知”，不从数值接近推定基准。

## 已执行的核查

`node --experimental-strip-types scripts/audit-elevation-datum.mjs` 成功执行。固定读取 2 个 JSON 元数据、2 个覆盖 MVT、3 个已审阅的处理代码文件，共 7 次有界请求、19677 字节响应体；没有下载 DEM 或区域数据。每次请求有 15 秒超时和 64 KiB 响应上限。结果、时间、URL、ETag/Last-Modified（如有）与 SHA-256 见 [audit.json](elevation-datum-evidence/audit.json)。脚本复用锁文件中随 MapLibre 安装的 vector-tile/PBF 读取器，不加入应用依赖或 CI 网络请求。

| 检查项 | 实际发现 | 能说明什么 |
| --- | --- | --- |
| 正式 DEM TileJSON | XYZ、Terrarium、512 像素与全球 Mercator 范围；无垂直基准、生成版本或像素来源声明 | 可以正确解码，不能据此转换为椭球高 |
| 眼点所在覆盖瓦片 z12/3628/1616 | 列出 glo30、jpdem1a、jpdem5a、jpdem5b、jpdem10a、jpdem10b | 仅为瓦片中出现的来源集合，不证明每项覆盖眼点或参与该像素 |
| 剣ヶ峰所在覆盖瓦片 z12/3626/1617 | 列出 glo30、jpdem1a、jpdem5a、jpdem10a、jpdem10b | 同样不能确定实际选源与混合权重 |
| 固定代码快照 | `2c4195dd90b91a8dde5cfa3e27a1167f64808a41`：重投影目标为 EPSG:3857，填补缺失并在来源交界混合 | 未建立统一椭球高契约；快照也未与在线瓦片生成版本绑定 |
| 上游基准讨论 | 维护者在 2026-05-08 说明尚未处理垂直基准，issue #255 当前仍 open | 不能把全局数据默认视为统一 EGM2008 或椭球高 |
| 上游转换 PR | #274 当前 open，尚未合入 | 候选实现不能当作线上已经完成转换的依据 |

上游证据：[维护者说明](https://github.com/mapterhorn/mapterhorn/issues/255#issuecomment-4403693294)、[转换 PR #274](https://github.com/mapterhorn/mapterhorn/pull/274)、[固定重投影代码](https://github.com/mapterhorn/mapterhorn/blob/2c4195dd90b91a8dde5cfa3e27a1167f64808a41/pipelines/aggregation_reproject.py)、[来源交界混合](https://github.com/mapterhorn/mapterhorn/blob/2c4195dd90b91a8dde5cfa3e27a1167f64808a41/pipelines/aggregation_merge.py)。issue 状态、PR 状态及当前主分支快照均于本轮联网核对；上述历史维护者说明与当前端点缺少声明相互印证，仍不证明每个像素实际采用哪一种基准。

## 转换依据与候选边界

[GSI 测地系说明](https://www.gsi.go.jp/sokuchikijun/datum-main)明确区分标高与椭球高；其[当前 geoid 提供说明](https://service.gsi.go.jp/kiban/app/geoid/)还列出基准面补正与使用条件。不能只因来源名称带 GSI，就断定瓦片使用哪个年度成果，再统一加 JPGEO2024；格网模型必须与源成果匹配，眼点与目标分别转换。当前没有取得可证明匹配的逐像素输入，也没有计算富士山实测 geoid 值。

[PLATEAU-Terrain 官方说明](https://docs.plateauview.mlit.go.jp/datasets/terrain/)明确声明当前 quantized-mesh 数据已转为椭球高；但 raster-dem 端点及请求时切换高度基准仍在调整，不能直接替换当前 Terrarium URL。它是后续已知高度基准路线的候选，本轮未接入、未完成许可/覆盖/精度及运行验收，不认定为已获选。

## 高度敏感度实验

复用前轮真实 Chrome 的 1000 mm 横幅、1152×768、实际眼点与同源目标高程，在离线椭球几何中加入**合成**偏移。未重新请求地形，未应用真实 geoid 或大气模型。完整输入和结果见 [height-sensitivity.json](elevation-datum-evidence/height-sensitivity.json)。

复现：仓库根目录执行 `node --experimental-strip-types scripts/generate-height-sensitivity.mjs`，读取既有测量记录并重新生成该 JSON；此命令不联网。

| 合成变化 | 相对原条件的高度角变化 | 垂直像素变化 |
| --- | --- | --- |
| 眼点和目标同时加 40 m | −0.000065776° | 向下 0.0367 px |
| 仅目标加 1 m | +0.003781607° | 向上 2.1121 px |
| 仅眼点加 1 m | −0.003783346° | 向下 2.1130 px |

40 m 是演示输入，不是日本地区实测值或拟采用修正。共同偏移与两端高差的影响不同；不能用统一常数修正去解释前轮约 77.51 / 49.20 px 的完整模型差。实际 geoid 的空间变化、源数据基准及网格混合仍未知，不外推现场误差。

## 决策与下一小步

决策见[高度基准使用规则](../architecture/elevation-datum.md)：正式预览继续使用原有同源高度，不自动套用 EGM2008、JPGEO2024 或固定偏移；条件对照继续明确假设，不称为实景校正。

核查到此结束，原型无需等待全球统一基准。下一小步为**开发模式下的固定场景曲面网格原型**：暂将同源 DEM 视为统一椭球高，使用 ECEF → 眼点 ENU 生成实际网格，与平面网格对照，先检查网格顶点方向、镜头投影和真实 GPU 轮廓。保留正常 MapLibre 预览，不自动替换正式渲染，不把点标记或整片垂直平移当作网格曲率。水体与日月共享深度作为原型通过后的独立小步，本轮没有实现原型。

本轮仅改核查脚本和文档，检查脚本实际执行、JSON 可读性、链接和差异格式；未重复运行前轮 89 项测试或浏览器验收，不将既有结果描述为本轮重跑。
