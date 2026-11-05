# 补齐现有深空目标的影像结构

2026-11-06。本轮将仍使用目录轮廓的 NGC1499 加州、IC1805 心脏、IC1848 灵魂星云补为影像结构参考，完成现有八个目标的接入。不增加目录条目、曝光或器材定标，不默认提交发布。

## 来源与范围

- 加州：[NOIRLab/AstroPix `noao-n1499block`](https://www.astropix.org/image/noirlab/noao-n1499block) 原尺寸 1172×1743 TIFF，光学 LRGB，CC BY 4.0，保留内嵌 AVM。
- 心脏、灵魂：Giuseppe Donatiello 的 Canon EOS 4000D / Tair 300 mm 拼接，经 Sun Shuwei 处理的 Stellarium 1024×1024 纹理。[作者原页](https://www.flickr.com/photos/133259498@N05/54332176110/)和[固定上游 CREDITS](https://github.com/Stellarium/stellarium/blob/230f2bd84b7827fb16be2a54c2ebdae07edf17a6/CREDITS.md)明示 CC0；固定上游提交、图像哈希与 `textures.json` 四角数值。它们没有原始 AVM，必须明确记录四角拟合的来源和残差，不伪造为原图测量解。
- 仅采纳两份影像和四角坐标事实，不引入 Stellarium 代码、引擎或依赖。普通/改机仍是基础色彩与额外红色的定性显示，不从出版图推断相机响应。

加州接续扩散光支持抑制照片外围星场，保留原 RGB 细节；心脏、灵魂已由上游去星，不重复整体滤波。五个已细化目标保持像素、分辨率与角范围不变。4096 方图内调整三个旧目录图格的空间：加州 2048 方格，心脏/灵魂各 1024 方格；预算上限仍 14 MiB，不增加纹理数量。

## 验收

1. 核实三图许可、署名、波段/器材说明、完整覆盖和输入哈希。使用 WCSLIB 独立验证 AVM；两份四角注册另验上下/左右方向、尺度与四角残差（小于半个源像素），不得把实现数值差当作实景精度。
2. 实际 PNG 检查三个目标基础红色、改机增量、非空精细结构、中性边框；与当前 0886bc8 图集比较，其他五图 RGBA 保持不变。沿用 M45/M8/北美的边界与长焦回归。
3. Chrome 检查三图宽幅、1000 mm、相同构图两种模式、图层开关、部分入画、白昼与 DEM 遮挡。来源署名必须可见；记录资源/控制台失败，不把待测状态写作通过。
4. 更新搜索、右栏与文档中“目录轮廓”的当前说明，执行匹配测试和子路径构建。留下实际截图、哈希和已知限制。

## 本地执行结果

2026-11-06 完成。现有八目标均有影像结构；没有新增目标或服务，也未提交发布。

- 来源、许可、原尺寸、输入哈希与处理方式已核对，见[来源核查](deep-sky-remaining-evidence/source-audit.json)。加州保留原始 RGB，并按扩散光支持压低外围星场；心脏/灵魂保留原始去星纹理，不重复整体模糊或补造云气。普通模式保留基础红色，改机使用独立额外红色。
- `npm test`：157/157 通过。新增三目标结构与来源检查、其他五幅影像的角范围/图格/RGBA 哈希回归；原有三图的清晰度与矩形边界回归继续通过。实际 PNG 的基础红色、红色增量与中性图格边框通过。
- PyAVM/Astropy/WCSLIB 核对八份来源共 200 点和完整来源足迹，最大坐标转换差约 5.30e−11 个参考像素。心脏/灵魂对原四角的最大残差分别为 0.035896、0.288321 个源像素；两类指标分别记录，均不代表原图实景精度。见[注册记录](deep-sky-remaining-evidence/image-registration.json)。
- `npm run build -- --base /Tamatamatori/` 通过，含 TypeScript；保留既有大分块提示，没有新增 npm 或运行时依赖。
- atlas 4096×4096、8708911 bytes（约 8.31 MiB），SHA256 `2e93d7c91147be4010f7172605e7579c5e37aa16368266d0ba581f2beb4ed870`。仍小于 14 MiB 预算，GPU RGBA/mip 约 85 MiB；既有五幅影像逐像素不变。按需加载、设备纹理回退与资源释放继续沿用现有逻辑。

## Chrome 实际画面

共保留 15 张真实截图，机位为 35.4172°N、138.8729°E、离地 1.6 m、全画幅横幅 3:2、Asia/Tokyo、标准参考折射。截图记录包含参数、取景框、图层状态、名称、控制台错误和文件 SHA256，见[浏览器记录](deep-sky-remaining-evidence/browser-results.json)。未记录到控制台 error。

| 场景 | 结果与证据 |
| --- | --- |
| 2026-11-09 01:00，加州 200/400 mm | [200 mm](deep-sky-remaining-evidence/california-200-stock.png)检查有限资料外沿；[400 mm 构图](deep-sky-remaining-evidence/california-400-framing.png)将俯仰调到 84.7°，保留可用云体、暗斑与细丝，外围星场未形成整块矩形。目录中心的[初始 400 mm](deep-sky-remaining-evidence/california-400-stock.png)构图会将云气末端移出取景框。 |
| 同时刻，加州 1000 mm | [未改机](deep-sky-remaining-evidence/california-1000-stock.png)保留细丝、暗斑和基础红色；[改机](deep-sky-remaining-evidence/california-1000-ha.png)增强红光，实际取景框与相机参数完全一致。 |
| 同时刻，心脏 400/1000 mm | [400 mm](deep-sky-remaining-evidence/heart-400-stock.png)显示环状主体、内部暗带与邻近云气；[1000 mm 普通](deep-sky-remaining-evidence/heart-1000-stock.png)和[改机](deep-sky-remaining-evidence/heart-1000-ha.png)保持细丝和构图，资料中没有密集背景星场矩形。 |
| 心脏 1000 mm，方位改至 337.7° | [中心在框外](deep-sky-remaining-evidence/heart-partial-frame.png)时名称隐藏，左侧仍有部分云气入画，没有按中心点剔除整片结构。 |
| 同时刻，灵魂 400/1000 mm | [400 mm](deep-sky-remaining-evidence/soul-400-stock.png)保留主体与周边云气；[1000 mm 普通](deep-sky-remaining-evidence/soul-1000-stock.png)和[改机](deep-sky-remaining-evidence/soul-1000-ha.png)保留暗带与层次，改机仅增强红光。 |
| 灵魂 400 mm，关闭深空 | [图层关闭](deep-sky-remaining-evidence/deep-sky-off.png)后结构与名称消失，搜索仍保留方向并明确显示“图层已关闭 · 画面内”；重新开启恢复。 |
| 2026-11-09 09:00，灵魂 400 mm | 几何高度约 10.4°时，[白昼](deep-sky-remaining-evidence/soul-daylight.png)隐藏结构与名称，状态为“天空较亮 · 轮廓隐藏”。 |
| 2026-07-16 00:20，加州 200 mm | 几何高度约 1.6°，[真实 DEM](deep-sky-remaining-evidence/california-terrain.png)遮住结构和名称，显示“山体遮挡”；没有将影像覆盖到地形上。 |

三组 1000 mm 取景框的普通/改机比较分别有 464626、662909、457731 个像素变化，最大通道差分别为 55、56、55；这些是显示响应回归，不是光度变化。参数与取景框一致，数据见浏览器记录。

[三目标宽幅展示](deep-sky-remaining-evidence/targets.jpg)只裁出实际预览并缩小并排，没有调色或增加细节；完整署名见各原始截图。

保留限制：加州末端仍受原图有限覆盖影响；心脏/灵魂是 1024 方图和上游去星外观，长焦受源分辨率及处理限制。摄影色彩、强度和红色增量都未经器材/曝光定标，不能从画面推断肉眼可见性或实拍曝光。若继续细化，下一步优先核实更宽、更高分辨率且有可靠注册的来源，或另开小目标扩展新目录。
