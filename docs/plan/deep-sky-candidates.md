# 下一批深空目标候选

核查日期：2026-11-06。仅为来源与技术预审，没有加入目录或运行时图集。三份可见光候选的原尺寸 TIFF 已临时下载并核对嵌入 AVM、尺寸与 SHA256，见[预审数据](deep-sky-colour-evidence/candidate-preflight.json)；不将预审等同于显示、边界融合或器材响应验收。

## 优先候选

| 目标 | 已核实资料 | 接入判断 |
| --- | --- | --- |
| M20 三裂星云 | [NOIRLab/AstroPix noao-m20johnson](https://www.astropix.org/image/noirlab/noao-m20johnson)，1773×1388，约 1.8°×1.4°，光学 LRGB、CC BY 4.0、完整 ICRS/J2000 TAN AVM。署名 KPNO/NOIRLab/NSF/AURA/ Lawrence Johnson and Kathy Ortega/Adam Block。 | 建议下一目标。原图包含主要红色云气、蓝色反射区、暗带和足够背景；可以检验混合星云显示。不能直接用仅红色的扩散支持，否则蓝色反射区会被抹去；需联合红/蓝结构支持、保持细节并检查密集星场边界。 |
| M33 三角座星系 | [NOIRLab/AstroPix noao-m33hotelling](https://www.astropix.org/image/noirlab/noao-m33hotelling)，1700×1199，约 1.4°×1.0°，光学 LRGB、CC BY 4.0、完整 ICRS/J2000 TAN AVM。署名 KPNO/NOIRLab/NSF/AURA/Ken Hotelling/Flynn Haase。 | 适合随后接入，原图可见完整主要旋臂与周边背景。主体连续谱不能整体染红；局部 H II 区是否加入增强需要单独数据，不能据此宣称真实星系对改机完全没有反应。星系主体也不能套只保留红色的星云支持。 |

上述资料的许可、波段与坐标已核对，但背景分离、资料外沿及 1000 mm 实际质量仍须进入该目标后验收。只接入图像不会自动具备真实相机色彩。

## 有条件候选

| 目标 | 已核实资料与限制 | 后续条件 |
| --- | --- | --- |
| 玫瑰星云 NGC2237–2239 / NGC2244 | [noao-rosette_mulligan](https://www.astropix.org/image/noirlab/noao-rosette_mulligan)，1800×1299、约 1.5°×1.1°、LRGB、CC BY 4.0、完整 TAN AVM。署名 KPNO/NOIRLab/NSF/AURA/Walter Mulligan/Flynn Haase。实际原图的部分外围云气触到上沿，不能作为完整外轮廓已经解决的资料。 | 优先找更宽且注册可靠的光学资料，再决定是否接入。不能拿 [DECam noirlab2424a](https://www.astropix.org/image/noirlab/noirlab2424a) 直接代替普通相机图：它把 S II 映成蓝色、Hα 映成红色、O III 映成绿色，是代表色组合。 |
| 马头 Barnard33 / IC434，火焰 NGC2024 区域 | [noao-02188](https://www.astropix.org/image/noirlab/noao-02188)，B/V/R、CC BY 4.0、完整 TAN AVM，但只约 15.5′×16.8′，不足以覆盖整片马头—火焰区域；[noao0126a](https://www.astropix.org/image/noirlab/noao0126a) 较宽但为 Hα/O III/S II 代表色。 | 单独解决暗云消光和背景合成。当前深空层为加亮叠加，黑色照片像素等于透明，不能遮暗银河背景；不能将其当作发光星云直接上图，更不能无条件删除可能位于云前的星表恒星。 |

红外、紫外或射电合成图可以用来展示结构，但不能在当前普通相机参考模式中不加区分地套用。资料不足的目标保持候选状态。

## 资源边界与建议顺序

现有 4096×4096 图集的八个 `atlasRect` 已占满全部区域，GPU RGBA/mip 约 85 MiB。8.31 MiB 是压缩下载大小，不能据此认为还有显存或图格空间。新增目标不能直接扩大为 8192 方图（相同格式/mip 约 341 MiB），也不能缩小现有目标的分辨率挤出空间。

建议先以一份小的新增资料组验证按需纹理与驻留预算，评估只下载/驻留当前需要的资料；此处仅提方案，不预建通用插件、分页框架或空模块。随后只接入 M20，验收其红/蓝混合结构、边界、长焦和模式独立性，再接 M33。玫瑰、马头分别等待更宽资料和暗云合成能力，不作为本轮承诺。

如果下一步优先追求真实未改机/改机色彩，应改为选择一种明确器材和一个具有标定波段数据的目标，建立滤镜/传感器响应、白平衡与曝光基准；不能靠继续增加出版图达到这一目标。当前定性边界见[色彩核查](deep-sky-colour-audit.md)。
