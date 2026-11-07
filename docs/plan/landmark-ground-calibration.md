# 远景地标地表衔接校准

2026-11-07，继续排查约 30/50 km 地标塔脚与地表的间隙。范围限已固定晴空塔模型及共用地形投影，不新增地标、纹理、虚构地面或高程常数。按用户要求，修正、验证并整理既有建筑工作后提交推送。

先区分实际 DEM 高程、SDK 所选网格覆盖/几何、真实 GPU 位置与深度、雾颜色造成的视觉差异。沿用相同模型文件、锚点和注册尺度，保留修正前画面。坐标数值、SDK CPU 覆盖、GPU 探针、实际画面和性能分开记录；远距、近距、横竖幅、原始地图及失败恢复均需回归，未执行或未通过的项不标为通过。

## 结论与实施（2026-11-08）

已修正固定场景中 30/50 km 的悬空间隙。原因是 **地形覆盖不足**：低海拔、接近水平的相机在 SDK 的平面覆盖计算中，原生远裁剪约为 19–20 km，目标脚下没有进入绘制网格；有限地标采用独立摄影投影，仍可绘制到 50 km。模型本身的位置、总高、基座采样和投影没有改变。

应用通过既有公开 Source 的 `calculateTileZoom` 回调附带自有 `terrain-range.v1` 标记。建筑开启、晴空塔距机位超过五公里且在 50 km 内时启用 75 km 的覆盖远裁剪下限。固定 SDK 的 `coveringTiles` 仅在地形启用、标记匹配且投影为 Mercator 时克隆变换扩展覆盖，DEM 读取和地形网格共用这一路径。实际相机、模型矩阵、雾矩阵及深度范围不变；普通地图和未标记回调保持原路径，关闭建筑或离开范围后恢复。

没有读取发布 Map API 隐藏的 `Map.transform`；该候选在类型核查时被否决。SDK 内部的变换克隆限于兼容补丁，应用只提供自有回调标记。不改 SDK 相机原始裁剪，不以移动/缩放模型、改 DEM、补假地面或套 geoid 常数消除间隙。

## SDK CPU 对照

使用安装的真实 SDK Camera、覆盖遍历与 TerrainTileManager，只有高程包围盒注入合成 0–30 m。这是覆盖选择验证，**不是实际 DEM、GPU 或实景测量**。视窗约 1238.5×825.7，离地 100 m、朝南，机位沿用前轮固定场景。

| 场景 | 实际相机原生远裁剪 | 原网格数 / 塔址覆盖 | 扩展后网格数 / 塔址覆盖 | 理想 DEM 瓦片数 |
| --- | ---: | --- | --- | ---: |
| 约 10 km，200 mm | 18.46 km | 16 / 有 | 33 / 有 | 15 |
| 约 30 km，600 mm | 19.23 km | 16 / 无 | 53 / 有 | 12 |
| 约 49.9 km，1000 mm | 20.25 km | 14 / 无 | 64 / 有 | 9 |

扩展只作用于覆盖克隆，表中实际相机原生远裁剪值保持不变，模型视场也不改变。固定比较见[原始调查](landmark-ground-evidence/coverage-before.json)和[覆盖修正](landmark-ground-evidence/coverage-after.json)；可用[CPU 回放脚本](../../scripts/check-terrain-coverage.mjs)重现。原始调查的扩展控制曾直接覆盖测试相机裁剪，实际实现改为克隆，修正记录中可见相机仍保持原值。

八组补充广角/长焦与横竖幅（8/35/200/1000 mm）最多 59 网格、17 个理想 DEM 瓦片；不计加载父瓦片或纹理源。既有 30 组地形回归仍为最多 117 网格、42 个理想 DEM 瓦片，原始地图不受标记扩展影响。不能以理想数量代替实际流量或显存。

## 自动检查与安装

- `npm test` **246 项通过**，类型与 `/Tamatamatori/` 子路径构建通过；保留现有大包提示。
- 新增真实 SDK 远距覆盖/恢复检查、相机矩阵及原始远裁剪不变、三处塔址 DEM 包含性、八组镜头/横竖幅有界覆盖，以及源/ESM 标记与幂等核查。
- 已从 npm 离线缓存的官方 6.16.0 原包在忽略目录全新安装所有补丁，二次安装哈希相同；故意破坏源码签名会拒绝且不写 ESM，记录见[全新安装](landmark-ground-evidence/clean-install.json)。未修改工作目录 SDK 来做故障注入。
- Vite 输入及缓存签名包含新补丁，开发诊断仅允许 DEV 下 `?calibration=skytree`，正式页面没有诊断 DOM。

首次 SDK 覆盖恢复测试缺少释放空 RTT 时所需的 painter 替身，补齐纯 I/O/资源占位后通过；未把该失败当作 SDK 或画面通过。归档测试日志签名与资源版本见[verification.json](landmark-ground-evidence/verification.json)。

## 真实 GPU 与同源高程

开发诊断采样同一晴空塔锚点，分别记录独立 DEM、SDK 高程、实际相机和共享顶点核的 transform feedback，不读取 SDK 私有缓冲区或字段。

| 场景 | 独立 z12 DEM / SDK 读数 | GPU 与独立椭球投影差异 |
| --- | --- | ---: |
| 30 km，600 mm | 2.0 m / 2.0 m | 0.00004209 CSS px |
| 49.9 km，1000 mm | 2.0 m / 2.0 m | 0.00004837 CSS px |

两处实际离地分别约 100.00025 / 100.00027 m，计划高度仍为 100 m。数据见[30 km GPU](landmark-ground-evidence/gpu-30km.json)、[50 km GPU](landmark-ground-evidence/gpu-50km.json)。这是同源条件下的计算一致性，不能称绝对高程或实景精度。旧平面 SDK 的 map.project 位置与椭球位置仍不同，诊断用不同标记分别显示，没有把旧平面位置当作新地形基准。

## 实际画面

使用独立开发服务与独立正式子路径构建服务，真实 DEM 和 MVT。天气、光污染关闭，2026-11-04 12:00 Asia/Tokyo、全画幅；其余机位、方向、焦距与[前轮](landmark-distance.md)一致。正式构建没有校准标记。

- [30 km 正式画面](landmark-ground-evidence/production-30km.jpg)：塔脚下的真实 DEM 已绘制，原可见间隙消失。
- [50 km 正式画面](landmark-ground-evidence/production-50km.jpg)：下部按当前地形深度裁切，不再悬在地表上方。[竖幅](landmark-ground-evidence/production-50km-portrait.jpg)单独核对。
- [关闭](landmark-ground-evidence/production-buildings-off.jpg)及[重新开启](landmark-ground-evidence/production-reenabled.jpg)：关闭移除模型并恢复覆盖策略，重开后模型与地表恢复。
- [10 km](landmark-ground-evidence/production-10km.jpg)与[约 1.56 km 近景](landmark-ground-evidence/production-near.jpg)：地标存在；近景仍为 12,856 普通分部、299,969 面，没有扩大普通建筑窗口或改动预算。

[390×844 手机视口](landmark-ground-evidence/production-mobile-50km.jpg)已核对：预览隐藏期间切换到 49.9 km 机位后，恢复预览可见模型与地表，地图/预览切换后仍正常。临时视口已恢复；正式页面无校准诊断 DOM，最终控制台没有警告或错误。场景读数与资源 URL 见[browser-results.json](landmark-ground-evidence/browser-results.json)。截图中浏览器扩展的“文本高亮”按钮不属于应用界面。

## 保留边界

本轮解决确定的覆盖错误，不将未加载地形当作已绘制地面。75 km 是覆盖策略的远裁剪下限，不保证所有方向、任意高度或全球地形完整，也不是地标加载距离（仍为约 50 km）。高程基准、DEM 分辨率、三角网插值、模型约 6.48 m 水平轮廓注册残差、对称朝向和不透明玻璃等限制保持。普通建筑仍约五公里，远处实际建筑和植被不完整。

GPU 探针误差不能代替实拍控制点误差；本轮没有测实体手机或稳定 GPU 帧率。下一步可在已固定接地场景上比较远景 LOD 与交互成本，再选择新地标。用户已授权本轮验收后提交推送，包含此前建筑、无纹理地标和距离/预算优化。
