# 其他深空目标细化

> 用户随后指出长焦过糊，本页保留 cbf2351 图集的历史接入与验收。后续细节、边界和剩余目标分别见[清晰度修正](deep-sky-sharpness.md)、[边界融合](deep-sky-boundary.md)与[剩余目标](deep-sky-remaining.md)，不能将下列广角结构记录当作长焦清晰度通过依据。

2026-11-05。延续 M31/M42 的完整覆盖与色彩修正，本轮细化已有 M45 昴星团、M8 礁湖星云、NGC7000 北美星云，不新增目录条目、曝光模型或服务。

## 范围

为三目标选择有许可、可见光且具备完整 AVM 的宽幅影像。按来源完整足迹重投影，保留基础 RGB 与独立额外红色增量，不恢复椭圆遮罩或目录外壳。M45 为反射云，额外红色增量必须为零；星团点源继续使用 HYG，影像只能提供结构参考，不能伪造新的星历。

若候选影像没有足够的目标覆盖、来源或配准，就更换候选，不以红外假色或未经许可的业余照片补足。未细化的加州、心脏、灵魂星云继续显示目录轮廓并明确说明。单张 atlas 继续按需加载，不引入运行时依赖；预算随实际资产评估，不能无说明降低既有 M31/M42 质量。

## 验收

- 核实来源、许可、署名、输入哈希与 AVM；用 PyAVM/Astropy/WCSLIB 独立核对各来源的方向、旋转、缩放与完整足迹。
- 实际像素检查 M45 的反射云和零红色增量、M8/北美的基础红色及独立增量、图格边框与既有 M31/M42 保持不变。
- Chrome 检查三个目标的宽幅/长焦、同构图两种响应、部分入画、日间隐藏与 DEM 深度；保留真实画面与状态。执行匹配的自动检查和子路径构建。

不把出版图色彩称为未改机实拍或实测 Hα；数值配准检查不代表原始图像测量精度。

## 来源与处理结果

三份资料均由 NOIRLab 提供，AstroPix 明示 CC BY 4.0；完整输入哈希、AVM、原作者署名和处理选项保留在 `scripts/deep-sky-image-sources.json` 与衍生数据中。

| 目标 | 来源与覆盖 | 色彩模式 |
| --- | --- | --- |
| M45 昴星团 | [noao-m45denton](https://www.astropix.org/image/noirlab/noao-m45denton)，约 2.2°×1.5° | 可见光 RGB，蓝色反射云；额外红色增量为零 |
| M8 礁湖星云 | [noao-m8wideblock](https://www.astropix.org/image/noirlab/noao-m8wideblock)，约 1.6°×1.1° | 可见光 LRGB，普通模式保留红色，改机额外增强 |
| NGC7000 北美星云 | [noao-n7000mosblock](https://www.astropix.org/image/noirlab/noao-n7000mosblock)，约 4.2°×2.9° | 可见光 LRGB；资料含鹈鹕星云及星场，未将它们新增为可搜索星历 |

首轮实际画面发现照片背景矩形边缘、星核重复；局部补洞又产生圆环，均未作为最终验收。当前使用平滑边界背景补偿，M45 与北美另做较大尺度统一星点滤波及平滑；不使用局部圆洞、椭圆裁切或合成外壳。北美的来源边缘用 12 个工作像素过渡（宽度的 0.75%），其他来源为 3 像素。代价是部分细丝与大尺度弥漫分量变弱，不能将处理后影像描述为无恒星实测图。

## 自动与数值验证

- `npm test`：154/154 通过。实际 PNG 解码覆盖反射云零额外红色增量、三幅发射云的基础红色及独立增量、五份来源注册记录和中性图格边框；既有几何、交互、资源及 GL 遮挡检查通过。
- `npm run build -- --base /Tamatamatori/` 通过，含 TypeScript。没有新增 npm 或运行时依赖；保留既有分块体积提示。
- PyAVM 0.9.9 + Astropy 7.1.1/WCSLIB 独立验证 125 个点及完整来源四角，最大转换差约 5.30e−11 个参考像素；这仅验证坐标转换实现。见[独立记录](deep-sky-expansion-evidence/image-registration.json)。
- 合成常量背景误差为零，平滑线性梯度最大差约 0.000674（线性 RGB），未发生取值过冲；这是显示背景算法检查，不是光度精度。
- 与 5a0fc34 逐像素比较，M31、M42、加州、心脏、灵魂图格均未改变。最终 RGBA atlas 为 4096×2048、1745629 bytes（约 1.67 MiB），SHA256 `cbf2351afb552dc0b4d3c626948fc3f9c1335a4349a61614feb81ad4a1e2ad69`；预算上限为 3 MiB，未降低已有 M31/M42 分辨率。

## Chrome 实际画面

最终图集在山中湖 35.4172°N、138.8729°E、离地 1.6 m、全画幅横幅 3:2、标准参考折射、Asia/Tokyo 下保存 14 张截图。具体镜头、响应、状态、裁区与截图 SHA256 见[完整记录](deep-sky-expansion-evidence/browser-results.json)。最终记录无控制台 error。

| 场景 | 实际结果与证据 |
| --- | --- |
| 2026-11-09 01:00，M45，600 mm | [未改机](deep-sky-expansion-evidence/m45-stock.jpg)与[改机](deep-sky-expansion-evidence/m45-ha.jpg)的相同预览裁区像素完全一致，不泛红；显示较柔和的蓝色反射云，无局部补洞圆环。 |
| 同时刻，M45，400 mm / 图层关闭 | [较宽构图](deep-sky-expansion-evidence/m45-400mm.jpg)保留来源内的反射云范围；[关闭深空](deep-sky-expansion-evidence/m45-layer-off.jpg)后消失，状态明确为图层已关闭。 |
| 2026-07-15 22:00，M8，600 mm | [未改机](deep-sky-expansion-evidence/m8-stock.jpg)保留红粉云气与暗带；[改机](deep-sky-expansion-evidence/m8-ha.jpg)额外增强红色，相同预览裁区有 196100 个变化像素、最大通道差 49。 |
| 同时刻，M8，1000 mm | [长焦](deep-sky-expansion-evidence/m8-1000mm.jpg)可辨核心和暗带；[方位改为 177.7°](deep-sky-expansion-evidence/m8-partial-frame.jpg)后中心在框外，左侧仍有部分资料入画，中心名称隐藏。 |
| 同时刻，北美星云，200 / 400 mm | [200 mm](deep-sky-expansion-evidence/ngc7000-200mm.jpg)显示资料内主云、暗区和邻近鹈鹕结构；400 mm 的[普通模式](deep-sky-expansion-evidence/ngc7000-stock.jpg)与[改机](deep-sky-expansion-evidence/ngc7000-ha.jpg)保持构图，改机增强红色。 |
| 2026-07-16 06:00，北美星云，400 mm | 几何高度仍为 35.5°，[白昼](deep-sky-expansion-evidence/ngc7000-daylight.jpg)隐藏轮廓和名称，状态为“天空较亮 · 轮廓隐藏”。 |
| 2026-07-16 02:15 / 02:45，M8，200 mm | 几何高度 7.7°时[未被 DEM 遮挡](deep-sky-expansion-evidence/m8-terrain.jpg)；2.7°时[山体遮挡](deep-sky-expansion-evidence/m8-terrain-blocked.jpg)，结构与中心名称隐藏。 |

本轮完成的是结构参考接入。M45 的星点抑制会使细丝较模糊；北美资料仍含密集星场与残余光晕，极高对比或长焦下仍受来源边界、分辨率和原始色彩处理限制。没有精确去星、无穷范围云气、相机光谱定标或曝光预测。加州、心脏、灵魂继续使用目录轮廓，已在搜索和目标列表标明。当前结果保留在本地，未提交或发布；下一小步可继续为这三个未细化目标核实合适资料。
