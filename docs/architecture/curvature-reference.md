# 曲率对照的坐标与边界

更新：2026-11-04。本篇记录初始开发对照，当时正式预览仍为 Mercator 地形。后续已在默认预览启用[实际网格空间投影](terrain-perspective.md)，共用坐标数学；下文的初期状态与试验结果作为历史记录保留。

## 独立坐标基准

`src/domain/geodesy.ts` 不依赖 MapLibre。采用 [NGA WGS84 定义](https://earth-info.nga.mil/index.php?action=wgs84&dir=wgs84)：长半轴 a = 6378137 m、扁率 f = 1 / 298.257223563，e² = f(2−f)。输入为测地经纬度和 **椭球高**，单位为度、米；字段显式命名 `ellipsoidalHeight`。

令纬度 φ、经度 λ、椭球高 h，N = a / √(1−e²sin²φ)。地心地固坐标为：

```text
X = (N+h) cosφ cosλ
Y = (N+h) cosφ sinλ
Z = (N(1−e²)+h) sinφ
```

目标 ECEF 减去眼点 ECEF 后，按眼点的测地经纬度旋转为 ENU。天方向使用椭球法线，北方向为局部真北，不用地心纬度替代测地纬度。与 [PROJ topocentric 约定](https://proj.org/en/stable/operations/conversions/topocentric.html)一致；几何视线为直线，未加入地面大气折射、垂线偏差或地形遮挡。

## 比较方式

开发页 `?calibration=fuji` 继续从公开绘制矩阵测量实际眼点。所有新增比较使用同一实际眼点、实际俯仰和方位、同一目标高程、传感器及画幅，避免把防碰撞避让误当作曲率。

`calibration-math.ts` 记录四组射线、角度和 CSS 像素：

| 模型 | 用途 |
| --- | --- |
| `mercator` | 当前 SDK 的平面参考；水平尺度用实际引擎中心纬度 |
| `sphere` | 既有 6371008.8 m 平均半径球面比较 |
| `ellipsoid` | WGS84 ECEF → ENU 独立几何方向 |
| `tangentControl` | 保留椭球射线 E/N，仅把 U 替换成目标高减眼点高，单独观察垂直曲率分量 |

最后一项只是受控比较，不是另一种地理投影。`verticalDrop = (目标高−眼点高)−U_ellipsoid`；其像素影响应比较 `ellipsoid` 与 `tangentControl`。完整 `ellipsoid − mercator` 还包含水平尺度和方位差，不能直接叫“纯曲率误差”。像素向右、向下为正；视线在相机后方返回空值。

绿色十字是当前 SDK DEM 高程的条件椭球投影，紫圈仍是 SDK 实际投影。它们只作二维参考，未写入 GL 深度，不参与日月遮挡，也不代表该山点一定能被看见。旧黄/红参考使用公布高程，与新同源 DEM 比较分开。诊断页明确显示高度假设、差值与完整 JSON，正常页面和生产 JS 不加载该计算器。

## 高程基准调查

Mapterhorn 的[日本来源元数据](https://github.com/mapterhorn/mapterhorn/blob/2c4195dd90b91a8dde5cfa3e27a1167f64808a41/source-catalog/jpdem5a/metadata.json)列出 GSI 基盘地图数值标高模型；[处理流程说明](https://github.com/mapterhorn/mapterhorn/blob/2c4195dd90b91a8dde5cfa3e27a1167f64808a41/pipelines/README.md)描述重投影、混合及降采样，但没有为当前所用瓦片提供逐像素来源和可核实的统一垂直基准转换承诺。[GSI 测地系说明](https://www.gsi.go.jp/sokuchikijun/datum-main)区分标高和椭球高，标高以平均海面为基准。以上资料于 2026-11-04 核对。

因此不能认定富士山当前瓦片的值已经是 WGS84 椭球高，也不能直接混用公布标高与 ECEF。当前诊断显式采用“输入高程暂视为椭球高”的条件假设，未应用未经核实的固定 geoid 偏移。正式校正需核实具体瓦片版本、源数据及其高程系统，并对眼点与目标分别作适配的垂直转换；水平参考框架、历元与参考点坐标精度也须独立评估。

后续已核对上游基准讨论、转换 PR 及固定点覆盖瓦片；结论与正式转换准入条件见[高度基准使用决策](elevation-datum.md)。条件几何原型可以继续，正式精度能力不因原型通过而获确认。

## 独立样本与复现

`tests/fixtures/geodetic-reference.json` 为 pyproj 3.7.2 / PROJ 9.5.1 输出，显式使用 WGS84，含 9 组 ECEF/ENU；CI 只读取 JSON，不安装 Python 或请求网络。可在隔离 Python 环境安装 `pyproj==3.7.2` 后，于仓库根目录执行 `python scripts/generate-geodetic-fixtures.py` 再生成。生成脚本不调用 TypeScript 实现；还保留 PROJ 文档的毫米取整样例，以及赤道轴、极点和垂直方向的解析检查。

执行结果见[曲率对照验收](../plan/curvature-validation.md)。下一步的真实地形曲率原型需要同时验证地形、水体、相机 ENU、日月方向与深度遮挡；不能仅移动参考十字或垂直平移山体后宣称实现。
