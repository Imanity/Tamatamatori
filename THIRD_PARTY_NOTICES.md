# 第三方许可

## Astronomy Engine 2.1.19

用于本地日月、金木星星历及恒星/银河坐标旋转，使用 MIT 许可。[项目主页](https://github.com/cosinekitty/astronomy)

完整版权与许可随应用发布，见 [third-party-notices.txt](public/third-party-notices.txt)。

## HYG Database v4.1

David Nash / Astronexus 的亮星目录，使用 [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/)。本项目提取 V 星等 ≤4.5 的 925 颗恒星，排除太阳、精简字段并加入中文名称。该衍生数据保留相同许可；[子集说明与来源](src/data/README.md)，应用内署名提供完整 JSON 下载。

## OpenNGC 深空数据与轮廓

使用 [Mattia Verga / OpenNGC 固定提交](https://github.com/mattiaverga/OpenNGC/tree/be3cd6c5498806a2fbb2f7e0452ef802dbb02be0)，按 [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/) 分发 8 个目标的衍生子集及组合分量图。轮廓由原项目使用 CDS 的 Aladin Sky Atlas 从 DSS2 Color 描绘；此项不分发原始 DSS 摄影像素。已增加中文名、搜索别名、切平面边界与定性显示分量；组合图中另有下述两幅 CC BY 4.0 影像的衍生结构。来源哈希、字段/历元、修改声明见 [deep-sky.json](src/data/deep-sky.json)。数据与分量图在预览署名区可下载；此许可不改变无关应用代码的许可。

## 深空宽幅影像与色彩参考

- M31：[heic1112f](https://www.astropix.org/image/esahubble/heic1112f)，完整署名 **ESA/Hubble & Digitized Sky Survey 2. Acknowledgment: Davide De Martin (ESA/Hubble)**。这是 ESA/Hubble 已发布并按 CC BY 4.0 提供的成品合成图，不是原始 DSS 数据服务；[ESA/Hubble 使用政策](https://esahubble.org/copyright/)。
- M42：[noao-m42steinberg](https://www.astropix.org/image/noirlab/noao-m42steinberg)，完整署名 **KPNO/NOIRLab/NSF/AURA/Ryan Steinberg and Family/Adam Block**，发布方 NOIRLab 的 AstroPix 存档明确标为 CC BY 4.0，使用可见光 LRGB。

修改：完整 AVM/TAN 覆盖重投影、缩放、部分星点抑制、线性化及背景扣除；保留基础 RGB，并将定性的额外红色结构单独打包。不用椭圆截断或目录外壳，不使用 AI 生成/扩展。原图保留 CC BY 4.0，组合 atlas 继续按 CC BY-SA 4.0 提供。不是实测谱线、相机曝光或原始天球精度承诺。完整来源和输入/输出哈希见 [deep-sky.json](src/data/deep-sky.json)。

历史验收截图仍包含上一版 eso1103a（ESO/Igor Chekalin）与 heic0512d（÷ 2002 R. Gendler, Photo by R. Gendler）的结构衍生外观，按当时发布方 CC BY 4.0 保留署名；它们不再用于当前运行时图集。

## ESO 银河全景

银河外观衍生自 [ESO eso0932a](https://www.eso.org/public/images/eso0932a/)，署名 **ESO/S. Brunier**，按 [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) 使用。已裁切银河平面、缩放、压低星点/光晕、降噪、调整黑位及接缝，转换为 WebP；未使用 AI 修改。原始与输出 SHA-256、坐标约定和改动详见 [milky-way.json](src/data/milky-way.json)，生成入口为 `scripts/build-milky-way.py`。全景不作为星历或光度标定，署名在启用银河时显示于预览底部。

## Earcut 3.2.4

用于日月凹多边形三角化，使用 ISC 许可。版权与许可同样包含在 [third-party-notices.txt](public/third-party-notices.txt)。

## d3-celestial 星座及星名数据

使用 Olaf Frohn 项目的固定版本数据（BSD-3-Clause），不引入其渲染库。中文星名按 Hipparcos ID 匹配；星座名称转简体，巨蛇座分为两片，连线端点匹配 HYG v4.1。原始 BSD 许可和修改说明见 [third-party-notices.txt](public/third-party-notices.txt)，[数据说明](src/data/README.md)保留固定来源与导出方式。

## MapLibre GL JS 6.16.0

地形与地图渲染，使用 BSD-3-Clause 许可。本项目为地形绘制补充公开 LOD 函数的传递，并增加按 WebGL 上下文启用的摄影地形 ENU 顶点投影及对数主深度；修改由 `scripts/patch-maplibre.mjs`、`scripts/patch-terrain-perspective.mjs` 和 `scripts/patch-terrain-depth.mjs` 在安装后校验并应用。以上是本项目修改，不代表上游接口。完整版权与许可见 [third-party-notices.txt](public/third-party-notices.txt)。
