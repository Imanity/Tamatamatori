# 第三方许可

## 空间站轨道与 satellite.js

ISS（25544）与天宫天和核心舱（48274）的 GP JSON 由 CelesTrak 提供。保留原始轨道字段、UTC 历元及独立的检查状态，空间站白名单筛选和静态镜像均在本项目完成。遵守两小时最短请求间隔和错误暂停要求，署名与快照下载入口在 About。[数据说明](https://celestrak.org/NORAD/documentation/gp-data-formats.php)，[使用政策](https://celestrak.org/usage-policy.php)

传播使用 satellite.js 7.1.0，MIT 许可，Copyright (C) 2013 Shashwat Kandadai, UCSC Jack Baskin School of Engineering。完整许可随应用分发。空间站标记和短轨迹由轨道计算生成，日照参考不构成观测可见性保证。[上游项目](https://github.com/shashwatak/satellite-js)

## 巴纳德环与蛇夫座区域

巴纳德环采用 Sun Shuwei 的 `barnard_loop-1..4.png`。固定上游 CREDITS 4.29 声明这些影像为公有领域，保留原作者署名及声明。Sh2-276 的中心和角径事实引用同版本合并目录的 Sharpless 条目，源文件哈希与记录标识存于目标数据。[固定影像与声明](https://github.com/Stellarium/stellarium/blob/230f2bd84b7827fb16be2a54c2ebdae07edf17a6/CREDITS.md)

蛇夫座复合体采用 `rho-a00/a10/a11/a01.png`，署名 **ESO/S. Guisard (www.eso.org/~sguisard)**。参考来自 ESO0934a 的 B/V/R 光学拼接，上游 CREDITS 4.94 及 ESO 按 CC BY 4.0 使用。两目标依公开四角拼接为派生 TAN 影像，保留原生分辨率说明、源 RGB 及作者处理的有限覆盖。巴纳德环采用显示信号亮度，蛇夫座红光增量排除黄色和蓝色反射结构。生成 PNG 按 CC BY-SA 4.0 提供，制作与输入哈希保存在来源清单。[ESO 资料](https://www.eso.org/public/images/eso0934a/)，[使用条款](https://www.eso.org/public/outreach/copyright/)

## Astronomy Engine 2.1.19

用于本地日月、金木星星历及恒星/银河坐标旋转，使用 MIT 许可。[项目主页](https://github.com/cosinekitty/astronomy)

完整版权与许可随应用发布，见 [third-party-notices.txt](public/third-party-notices.txt)。

## HYG Database v4.1

David Nash / Astronexus 的亮星目录，使用 [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/)。本项目提取 V 星等 ≤4.5 的 925 颗恒星，排除太阳、精简字段并加入中文名称。该衍生数据保留相同许可；[子集说明与来源](src/data/README.md)，应用内署名提供完整 JSON 下载。

## OpenNGC 深空数据与轮廓

使用 Mattia Verga / OpenNGC 固定提交，按 CC BY-SA 4.0 分发 12 个目标的衍生目录与独立分量图。轮廓由原项目使用 CDS Aladin 从 DSS2 Color 描绘。已增加中文名称、搜索别名、切平面边界和定性显示分量。摄影参考资料包含九份 CC BY 4.0、两份 CC0 1.0 与一份 CC BY-SA 4.0 来源。来源哈希、历元和修改记录随数据分发。独立 PNG 衍生数据按 CC BY-SA 4.0 提供下载。[OpenNGC 固定版本](https://github.com/mattiaverga/OpenNGC/tree/be3cd6c5498806a2fbb2f7e0452ef802dbb02be0)，[衍生数据](src/data/deep-sky.json)，[CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/)

## 深空宽幅影像与色彩参考

- M31：[heic1112f](https://www.astropix.org/image/esahubble/heic1112f)，完整署名 **ESA/Hubble & Digitized Sky Survey 2. Acknowledgment: Davide De Martin (ESA/Hubble)**。这是 ESA/Hubble 已发布并按 CC BY 4.0 提供的成品合成图，不是原始 DSS 数据服务；[ESA/Hubble 使用政策](https://esahubble.org/copyright/)。
- M42：[noao-m42steinberg](https://www.astropix.org/image/noirlab/noao-m42steinberg)，完整署名 **KPNO/NOIRLab/NSF/AURA/Ryan Steinberg and Family/Adam Block**，发布方 NOIRLab 的 AstroPix 存档明确标为 CC BY 4.0，使用可见光 LRGB。
- M45：[noao-m45denton](https://www.astropix.org/image/noirlab/noao-m45denton)，完整署名 **KPNO/NOIRLab/NSF/AURA/Tad Denton/Adam Block**，可见光 RGB。
- M8：[noao-m8wideblock](https://www.astropix.org/image/noirlab/noao-m8wideblock)；NGC7000：[noao-n7000mosblock](https://www.astropix.org/image/noirlab/noao-n7000mosblock)。两幅完整署名均为 **KPNO/NOIRLab/NSF/AURA/Adam Block**，可见光 LRGB。三份新增资料均按 NOIRLab/AstroPix 明示的 CC BY 4.0 使用。
- NGC1499：[noao-n1499block](https://www.astropix.org/image/noirlab/noao-n1499block)，**KPNO/NOIRLab/NSF/AURA/Adam Block**，光学 LRGB、CC BY 4.0；完整 TIFF/AVM 重投影，保留 RGB 细节并加入扩散光支持和独立红色增量。
- IC1805/IC1848：**Giuseppe Donatiello, post-processing: Sun Shuwei**；使用 [Stellarium 固定提交的纹理](https://github.com/Stellarium/stellarium/tree/230f2bd84b7827fb16be2a54c2ebdae07edf17a6/nebulae/default)。[固定 CREDITS 的 4.63 项](https://github.com/Stellarium/stellarium/blob/230f2bd84b7827fb16be2a54c2ebdae07edf17a6/CREDITS.md)及[作者原页](https://www.flickr.com/photos/133259498@N05/54332176110/)明确按 [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) 提供。保留上游去星外观、四角数值注册、重投影、线性化与独立红色增强；不把原图或处理宣称为实测去星/相机定标。未引入 Stellarium 程序代码。

修改：完整可用覆盖的 AVM/TAN 或四角数值注册重投影、缩放、部分星点抑制、线性化及背景扣除；保留基础 RGB，并将定性的额外红色结构单独打包。不用椭圆截断或目录外壳，本项目不生成或扩展资料外的影像；上游去星外观按发布资料保留。原图保留各自 CC BY 4.0 / CC0 1.0，组合 atlas 继续按 CC BY-SA 4.0 提供。不是实测谱线、相机曝光或原始天球精度承诺。完整来源和输入/输出哈希见 [deep-sky.json](src/data/deep-sky.json)。

M45/M8/北美使用同一发布资料的原尺寸 TIFF，最终 RGB 保留高频结构；背景与扩散光支持分别滤波，不对最终 RGB 整体去星或模糊；颜色支持的形态重建抑制外围照片星场并填补白色星核支持孔洞。三图采样边缘为 40 工作像素，M31/M42 为 3 像素。照片星点与光刺保留为参考，不是新增星历或光度定标。

历史验收截图仍包含上一版 eso1103a（ESO/Igor Chekalin）与 heic0512d（÷ 2002 R. Gendler, Photo by R. Gendler）的结构衍生外观，按当时发布方 CC BY 4.0 保留署名；它们不再用于当前运行时图集。

## 四个新增深空参考

- M20 署名 KPNO/NOIRLab/NSF/AURA/Lawrence Johnson and Kathy Ortega/Adam Block，光学 LRGB、CC BY 4.0。使用原尺寸 TIFF、AVM 重投影和联合红蓝扩散结构支持。[发布资料](https://www.astropix.org/image/noirlab/noao-m20johnson)
- M33 署名 KPNO/NOIRLab/NSF/AURA/Ken Hotelling/Flynn Haase，光学 LRGB、CC BY 4.0。使用原尺寸 TIFF、AVM 重投影和连续谱结构支持。[发布资料](https://www.astropix.org/image/noirlab/noao-m33hotelling)
- 玫瑰署名 Kees Scherer，采用 Stellarium 固定版本的 `n2244.png` 与四角坐标。原资料为 Hα+RGB，按 CC BY-SA 4.0 使用。已重投影、缩放并提取定性红光增量。许可依据为上游 CREDITS 第 4.58 项。[来源页](https://commons.wikimedia.org/wiki/File:2244_and_the_Rosette_Nebula.jpg)，[固定许可记录](https://github.com/Stellarium/stellarium/blob/230f2bd84b7827fb16be2a54c2ebdae07edf17a6/CREDITS.md)
- 马头区域署名 Manuel Peitsch, post-processing: Sun Shuwei，采用同一固定版本的 `ic434.png` 与四角坐标。作者资料采用 ASI2600MC-Pro、Optolong L-Pro 和可见光拼接，按 CC BY 4.0 使用。已重投影、提取扩散结构并估计暗区背景对比。许可依据为上游 CREDITS 第 4.132 项。[作者资料](https://manuel-astro.ch/project/south-of-orions-belt/)，[固定纹理与坐标](https://github.com/Stellarium/stellarium/tree/230f2bd84b7827fb16be2a54c2ebdae07edf17a6/nebulae/default)

四份参考的输入/输出 SHA256、原许可、派生处理及注册字段均保存在 `deep-sky.json`。四角资料的 TAN 拟合误差单独记录，既有心脏/灵魂继续使用原来的半像素验收界限。应用采用 12 份独立纹理，并按 CC BY-SA 4.0 提供生成后的 PNG。NGC2024 火树星云共享上述 IC434 参考的注册与像素，新增目录位置、别名和局部查询范围；马头暗区显示权重已减弱。两目标共享一次可见绘制，原作者及许可沿用。[完整数据](src/data/deep-sky.json)

## ESO 银河全景

银河外观衍生自 [ESO eso0932a](https://www.eso.org/public/images/eso0932a/)，署名 **ESO/S. Brunier**，按 [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) 使用。已裁切银河平面、缩放、压低星点/光晕、降噪、调整黑位及接缝，转换为 WebP；未使用 AI 修改。原始与输出 SHA-256、坐标约定和改动详见 [milky-way.json](src/data/milky-way.json)，生成入口为 `scripts/build-milky-way.py`。全景不作为星历或光度标定，完整署名在 header 的 About 中按银河影像列出，不依赖图层开关。

## Earcut 3.2.4

用于日月凹多边形三角化，使用 ISC 许可。版权与许可同样包含在 [third-party-notices.txt](public/third-party-notices.txt)。

## d3-celestial 星座及星名数据

使用 Olaf Frohn 项目的固定版本数据（BSD-3-Clause），不引入其渲染库。中文星名按 Hipparcos ID 匹配；星座名称转简体，巨蛇座分为两片，连线端点匹配 HYG v4.1。原始 BSD 许可和修改说明见 [third-party-notices.txt](public/third-party-notices.txt)，[数据说明](src/data/README.md)保留固定来源与导出方式。

## MapLibre GL JS 6.16.0

地形与地图渲染，使用 BSD-3-Clause 许可。本项目为地形绘制补充公开 LOD 函数的传递，并增加按 WebGL 上下文启用的摄影地形 ENU 顶点投影及对数主深度；修改由 `scripts/patch-maplibre.mjs`、`scripts/patch-terrain-perspective.mjs` 和 `scripts/patch-terrain-depth.mjs` 在安装后校验并应用。以上是本项目修改，不代表上游接口。完整版权与许可见 [third-party-notices.txt](public/third-party-notices.txt)。
