# 东京塔与上海中心无纹理地标

2026-11-08。上一轮建筑与远景校准已提交推送为 `cc1e200`，开始时工作区干净。本轮沿用用户的无纹理要求，在现有晴空塔之外接入东京塔、上海中心两处地标；不扩展整城精模、纹理、灯光、玻璃或后端。

## 实施范围

- 从 Sketchfab 正式下载入口取得东京塔候选和 NanoRay 的上海中心候选，核查 CC BY 4.0、实际文件、结构、单位与许可记录；元数据面数不充当下载文件的测量值。东京塔已下载的 zebadiahsantos 版本横纵比例偏差较大，补验 Void 候选后再决定是否准入。原始下载放忽略缓存，只分发转换后资源。
- 保持既有 TTLM 1、同源按需读取、WGS84/ENU 投影、DEM 基座和对数深度。每个模型独立校验与失败反馈；同城多地标共享 300,000 面总预算，普通建筑继续约 5 km、地标约 50 km。
- 近景按固定源瓦片、要素 ID、高度及位置确认粗分部后才替换，未确认或模型失败保留对应粗体块；远处未载粗体块时明确说明。一个地标失败不阻止其他已验证地标。转向、调焦和时间变化不重新下载模型。
- 既有远距地形覆盖扩展适用于本轮已接入地标，不改 SDK 补丁算法；不会因资料不足移动模型或套固定高程偏移。
- 右栏逐项反馈模型状态、距离和面数；来源、许可、加工记录与下载入口继续集中于 About。

## 验收

先固定输入哈希、作者/许可、变换、锚点、尺度、近似朝向及粗分部对应关系。源尺寸和官方总高核对、几何投影、预算、缓存、取消和失败分别检查，不把社区模型当测绘数据。

自动检查覆盖实际资产、双地标同时加载、一处失败、全部失败、跨城市缓存、近景替换、50 km 边界和既有晴空塔回归；执行类型检查及子路径构建。Chrome 检查近/远景、长焦、横竖幅、移动端恢复、关闭重开和 About。GPU 画面、CPU 数值与性能分开记录，未执行项不标通过。本轮新增实现不沿用“先提交现有工作”的授权自动发布。

## 执行记录

东京塔正式原格式下载曾返回 403，后通过正式下载选项取得 ZIP（3,233,062 B），内含 `model 2.glb`（3,232,928 B）。该文件的四脚宽度与总高比例偏差明显，未加入运行时目录。用户要求列出所有待下载文件后，已提供 Void 东京塔与 NanoRay 上海中心两份正式页面；不会用前者不合格版本补齐数量。

上海中心 GLB 的下载被 Chrome 以 `ERR_BLOCKED_BY_CLIENT` 拦截，回到正式页面交给用户手动下载，未绕过拦截或读取预览资源。当前已取得 `shanghai_tower.glb`，4,508,508 B，SHA-256 `c706244b1ae46cc0c0ccd15b52e7fde2bff03b0097569af2924c6597db737900`。浏览器下载事件超时与实际文件落盘分别判断；旧浏览器连接失效后只恢复到同一 RJ profile 的新连接，未继续依赖失效的窗口绑定。

## 上海中心转换与注册

源 GLB 实际包含七个网格、126,971 个顶点、121,254 个三角面、七个不透明材质，无纹理。公开元数据的 86,126 顶点 / 121,270 面与实际文件口径不同，以解码结果为准，见[元数据](landmark-expansion-evidence/sources.json)。

按节点实际世界变换恢复 Y 向上场景，以最低 Y 为基座，基座层 X/Z 包围盒中心为局部原点；均匀缩放至官方[632 m 总高](https://www.shanghaitower.com/ProjectIntroduction.html)，转为右手 ENU 并旋转法线。工具参数、输入/输出哈希及坐标范围见[发布清单](../../public/landmarks/shanghai-tower-v1.json)和[固定转换脚本](../../scripts/build-landmark-models.mjs)。

锚点来自实际 OpenFreeMap / OSM 塔身 WGS84 坐标：`31.235511180721934, 121.50132179260254`。近景确认三个源分部 `3760235552` / 360 m、`3760235562` / 540 m、`3760235582` / 632 m，均为零基底；保持周边楼房。使用隐藏总轮廓 `1657921232` 作朝向参考，不将其填充成实体。塔身、来源版本和瓦片哈希见[固定参考](landmark-expansion-evidence/registration-reference.json)。

源底部 0.2 m 横切面与完整 OSM 外轮廓每 0.25° 比较，选择 ENU 逆时针 136.25°；96 点双向最近点 RMS 约 4.83 m。此值仅比较社区外观模型与量化地图轮廓，不是现场误差，也未验证每层结构精度。参考点与候选角度见[注册记录](landmark-expansion-evidence/shanghai-registration.json)。DEM 提供运行时地面，不添加高程偏移。

| 转换项目 | 实际结果 |
| --- | ---: |
| 输出顶点 / 面 | 59,701 / 54,682 |
| gzip | 975,220 B，约 0.93 MiB |
| 解压几何含头 | 2,089,040 B，约 1.99 MiB |
| 工具绝对误差参数 | 0.1 m，锁边界及法线权重 0.01 |

独立 CPU 六方向源/减面轮廓并集检查通过，最小 IoU 约 0.9997408，最大行边界差 0.316 m（当前栅格一个像素）。[数值](landmark-expansion-evidence/shanghai-tower-cpu-coverage.json)、[对照图](landmark-expansion-evidence/shanghai-tower-cpu-coverage.png)及[回放脚本](../../scripts/check-landmark-coverage.mjs)只验证减面后的覆盖，不是 GPU 或实景精度。初次高度检查设为 1 mm，实际最高点在减面后低约 1.89 mm；改用既定 0.1 m 减面误差内的总高检查，没有为通过检查修改模型尺度或顶点。

当前阶段 `npm test` **249 项通过**，类型检查与 `/Tamatamatori/` 子路径构建通过，保留现有大包提示。新增独立资产校验、跨城市缓存、8 MiB / 三份缓存边界、清理时迟到请求、错误资产身份及上海三分部替换/失败保留。重复转换二进制与清单哈希一致，见[重复生成](landmark-expansion-evidence/rebuild-idempotence.json)。既有预算回放脚本固定为晴空塔资产集，防止后加地标改变旧比较的含义。

## 真实 Chrome 画面

2026-11-04 当地 12:00，全画幅、离地 100 m，天气/光污染关闭。开发版与独立正式子路径构建分别验证；这是实际 DEM/MVT/GPU 显示，不代表现场精度。

| 场景 | 结果与证据 |
| --- | --- |
| 北侧约 1.6 km / 50 mm | [模型与周边体块同时显示](landmark-expansion-evidence/shanghai-near-dev.jpg)，3,578 普通分部，127,122 面 |
| 南侧约 1.7 km / 50 mm | [正式构建](landmark-expansion-evidence/shanghai-final-production.jpg)可见立面和冠顶，4,360 普通分部、136,242 面，基座受近景建筑与地形遮挡 |
| 约 30 km / 600 mm | [远景](landmark-expansion-evidence/shanghai-30km-dev.jpg)只加载该处地标，不扫描目标附近的远方城市，地面与基座相接 |
| 约 49.8 km / 1000 mm | [横幅](landmark-expansion-evidence/shanghai-50km-production.jpg)和[竖幅](landmark-expansion-evidence/shanghai-50km-portrait-production.jpg)均可见；共 58,015 面，低部按实际 DEM 裁切，没有沿用前轮悬空间隙 |
| 正式文件临时缺失 | 仅移走 `dist` 中该模型，[提示未应用](landmark-expansion-evidence/shanghai-missing-asset-production.jpg)，仅余 3,333 普通面；没有宣称远景存在粗体块回退 |
| 恢复及重试 | 还原原始哈希后通过 UI 重试，[模型和地表恢复](landmark-expansion-evidence/shanghai-recovered-production.jpg)；源文件未被移走或修改 |
| 越过 50 km | 纬度 31.69、同经度时[地标清除](landmark-expansion-evidence/shanghai-outside-production.jpg)，右栏无旧地标条目，只剩 3,166 普通面 |
| 关闭重开 | [关闭](landmark-expansion-evidence/shanghai-off-production.jpg)移除建筑，重开后模型与普通建筑恢复 |
| 390×844 手机视口 | [约 49.8 km 画面](landmark-expansion-evidence/shanghai-mobile-production.jpg)可见；地图/预览切换后恢复，临时视口已复位。此处没有在隐藏期间改机位，不扩大为该项验收 |
| 晴空塔回归 | [原用户机位](landmark-expansion-evidence/skytree-regression-production.jpg)仍为 12,856 普通分部、299,969 面 / 17.03 MiB，模型字节未改 |

正式页面没有校准诊断 DOM；最终控制台无警告或错误。About 已核对两位作者、CC BY 4.0 与四个子路径下载入口。故障注入第一次同步读取仍是上一轮状态，以后续抓取时间推进及稳定回退/恢复为准，未当作即时通过。图中的“文本高亮”按钮属于浏览器扩展。场景、资源版本及限制见[browser-results.json](landmark-expansion-evidence/browser-results.json)，日志及文件签名见[verification.json](landmark-expansion-evidence/verification.json)。

## 尚待完成

东京塔 Void 候选尚未出现在默认下载目录，仍待用户手动下载，原始候选不合格时不强行入库。尚未验证东京塔或同城两个精模同时显示；缓存/逐项预算和状态支持不能替代该画面验收。没有实体手机或稳定 GPU 帧率测量，没有玻璃、灯光或实景测绘精度承诺。本轮新增实现未提交推送，上一轮 `cc1e200` 的推送已完成。

后续已按用户要求改为[批量制作流程](landmark-pipeline.md)，Void 东京塔完成离线样例并保持真实画面待验；集中下载见[18 份清单](landmark-downloads.md)。本文上海中心的 CPU/GPU 记录继续保留。原单体构建命令现在是统一工具的兼容入口，只写暂存结果；公开资源须通过 `integrate` 与 `verify` 更新。
