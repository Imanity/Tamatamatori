# 天文目录与影像数据

巴纳德环与蛇夫座复合体使用固定 Stellarium 的八份分片和公开四角。新增目标的 `positionSource` 与 `sizeSource` 区分目录事实和区域构图锚点。源清单保留每片的原生尺寸、SHA256、四角及许可，`published-quad-mosaic` 表示派生 TAN 拼接参考。下载各 `panels[].url` 到源图目录后，执行 `python scripts/deep_sky_panels.py 源图目录`，再按既有目录、旧图集、独立纹理步骤生成。分片以四角单应插值投影，重叠权重归一化，外沿由合并覆盖过渡。`python scripts/check-wide-clouds.py 源图目录` 使用独立 WCSLIB/SVD 核查 200 个内部采样点和源 RGB。[范围与验收](../../docs/plan/wide-clouds.md)

巴纳德环的已处理显示分片以 `signalModel=display-rgb` 保存 RGB 显示信号，减少再次按照片线性强度压低和量化造成的暗部丢失。该亮度用于构图参考。蛇夫座沿用照片强度近似，并以 `redEnhancementModel=reflection-safe` 排除黄色、蓝色反射结构的额外红光。派生 2048 纹理为原生 256–512 px 分片提供连续采样。

NGC2024 火树星云通过 `imageReference` 共享 IC0434 光学参考，共 15 个目录目标、14 幅独立影像。火树的目录位置和查询范围独立，其网格 UV 投影回 IC0434 注册后的纹理，只绘制一次共享影像。新增 25 个 WCSLIB 共享 UV 检查点，马头 RGB 与其他十一份 PNG 保持。马头背景压暗权重上限为 0.18，源图暗轮廓及 RGB 细节保留。[融合与共享影像验收](../../docs/plan/horsehead-flame.md)

当前深空目录含 15 个目标。运行时从 `deep-sky/` 逐目标加载 PNG，按当前视场和屏幕尺寸解码，并采用 64 MiB 的深空 RGBA/mip 驻留预算。PNG 的许可、尺寸、SHA256 和 alpha 数据含义保存在每个对象的 `texture` 字段。所有生成的独立 PNG 按 CC BY-SA 4.0 提供。下面的旧八目标图集保留为离线回归输入。

新增 M20/M33 使用 NOIRLab 原尺寸 LRGB 与 AVM。玫瑰采用 Kees Scherer 的 Hα+RGB 参考，马头区域采用 Manuel Peitsch / Sun Shuwei 的可见光拼接参考。两幅宽幅纹理为固定 Stellarium 版本的 1024 方图，使用公开四角拟合 TAN/CD。最大四角残差分别为 0.643094 和 0.546195 源像素，本轮的两份资料采用 1 源像素界限。心脏/灵魂沿用 0.5 源像素界限。M20/M33 输出为 2048 方图。马头的 alpha 数据保存背景暗区对比，额外红光由基础 RGB 估计。来源、覆盖及验收见[四目标计划](../../docs/plan/deep-sky-next-four.md)。

生成独立纹理时，在既有目录与旧图集生成步骤之后执行 `python scripts/build-deep-sky-targets.py 源图目录`。旧八目标图格逐像素拆分，四个新目标重投影到各自纹理。`scripts/check-deep-sky-images.py` 现对 14 幅参考保存 350 个独立 WCS 采样点，并记录逐目标 PNG 哈希和四角拟合残差。运行和 CI 直接使用仓库资产。

`deep-sky.json` 与 `deep-sky-atlas.png` 是 [OpenNGC 固定提交](https://github.com/mattiaverga/OpenNGC/tree/be3cd6c5498806a2fbb2f7e0452ef802dbb02be0)的衍生数据，作者 Mattia Verga，采用 **CC BY-SA 4.0**。8 个目标保留 J2000 RA/Dec、目录全角径、可用位置角（北向东）和原 Aladin/DSS2 多级轮廓；缺失位置角保持 `null`。目录尺寸与描绘的外轮廓不一定相同，后者可能包含附近未分离的云气。应用使用逐点天球投影，不把图谱的固定角度当作摄影画面的朝向。

图集为 4096×4096；对象的 atlasRect 保存像素矩形，不再按统一方格计算 UV。M45/M8 为 2048×1024，北美/加州为 2048×2048；M31/M42/心脏/灵魂为 1024×1024。补齐三目标时，既有五份影像的像素与角范围不变。无损 PNG 约 8.31 MiB，预算上限 14 MiB；完整 RGBA/mip 纹理约 85 MiB，设备上限较小时等比缩小。

采用 RGBA：RGB 是基础色彩，A 为 1−改机额外红色增量；A 不是最终透明度。普通模式保留基础 RGB，改机额外加入定性红色结构，不能视为窄带通量或具体机型响应。

M31 使用 ESA/Hubble 发布、AstroPix 存档的 heic1112f，署名 **ESA/Hubble & Digitized Sky Survey 2. Acknowledgment: Davide De Martin (ESA/Hubble)**。M42 使用 NOIRLab/AstroPix 的 noao-m42steinberg，署名 **KPNO/NOIRLab/NSF/AURA/Ryan Steinberg and Family/Adam Block**。M45 使用 noao-m45denton，署名 **KPNO/NOIRLab/NSF/AURA/Tad Denton/Adam Block**；M8 使用 noao-m8wideblock，NGC7000 使用 noao-n7000mosblock，两图署名 **KPNO/NOIRLab/NSF/AURA/Adam Block**。加州使用 noao-n1499block，署名 **KPNO/NOIRLab/NSF/AURA/Adam Block**，可见光 LRGB、CC BY 4.0。心脏/灵魂采用固定 Stellarium 提交的 ic1805.png/ic1848.png，署名 **Giuseppe Donatiello, post-processing: Sun Shuwei**，依上游 CREDITS 与作者原页按 CC0 1.0 使用。六份资料保留 AVM；两份去星资料没有原始 AVM，保留上游四角数值、来源哈希与派生 TAN/CD 注册，不能称原始测量解。

处理：完整 TAN 覆盖重投影（含不等 X/Y 尺度的 CROTA2 矩阵），保留 RGB 色彩比例及独立线性强度。M31/M42 沿用既有过滤和背景扣除。M45/M8/北美改用同一发布资料的原尺寸 TIFF；最终影像保留原始高频信息，背景和透明度支持独立滤波，最终 RGB 不作整体去星、模糊、锐化或生成细节。M45/M8/北美/加州/心脏/灵魂的来源边缘过渡为 40 工作像素，M31/M42 为 3 像素；不叠加椭圆遮罩或目录外壳。背景补偿可能去掉部分大尺度分量，来源以外不生成云气。

M31/M45 的额外红色增量为零。加州沿用扩散光支持，心脏/灵魂保留上游去星外观，不重复背景扣除或整体模糊；三个目标均有基础 RGB 和独立红色增量。照片中的星点、光刺与原始色彩处理均是参考资料的一部分，不作为额外星历、精确去星结果或机型/曝光定标。三图另以颜色优势信号的形态重建控制连续支持，抑制照片外围星场，支持小孔处理避免白色星核空洞；基础 RGB 与红色增量同时衰减，星云内部可保留照片星点。此分离不是实测去星或谱线资料。当前验收见 [deep-sky-remaining.md](../../docs/plan/deep-sky-remaining.md)。

手动导出：`node scripts/build-deep-sky.mjs` 核对固定上游内容并保存输入哈希；隔离 Python 环境安装 `Pillow==12.0.0 numpy==2.3.5` 后下载 `scripts/deep-sky-image-sources.json` 单图条目的 url 并按 file 命名存入源图目录，分片条目按上文准备，再运行 `python scripts/build-deep-sky-atlas.py 源图目录`。资产输出哈希与各分量最大值写回 JSON；运行/构建/CI 不需要 Python。独立坐标参考由 `scripts/build-deep-sky-reference.py` 使用 `pyerfa==2.0.1.5` 生成，固定 DUT1/极移为零及无折射，未来日期仅作为固定闰秒假设下的矩阵回归。

`milky-way.webp` 为 **ESO/S. Brunier** 的 [ESO0932a 全景](https://www.eso.org/public/images/eso0932a/)衍生图，采用 [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)，不改变 HYG 数据的许可。`milky-way.json` 保存原图与输出 SHA-256、银河坐标映射及改动说明；图像 4096 × 512、约 116 KiB，只表示银纬 ±22.5° 的摄影外观。不是精密天图或曝光模型，可能残留照片中的未解析星点/星云，不据此显示新的可点击天体或推断星历精度。

手动再生成：在隔离 Python 环境安装 `Pillow==12.0.0`，从元数据中给定地址下载原图后执行 `python scripts/build-milky-way.py 原图.jpg`。脚本先核对源 SHA-256，再裁切、重采样、中值抑制星点、局部限幅抑制光晕、降噪、调整黑位与经度接缝、编码 WebP。运行/构建/CI 直接使用已提交资产，不需要 Python 或再次访问 ESO。

`bright-stars.json` 是 David Nash / Astronexus 的 HYG Database v4.1 衍生子集，按 [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/) 分发。原始数据、作者、固定版本链接、SHA-256、字段和修改声明保留在 JSON 元数据中。

修改：排除太阳；保留 V 星等 ≤4.5 的 925 颗恒星及必要数值字段；为主要亮星保留 90 个名称，89 个为中文，缺失中文时使用目录固有名。原有常用中文名优先，其余中文星名由 d3-celestial 按 Hipparcos ID 匹配，保留其 BSD-3-Clause 来源、哈希及原始许可。赤经单位小时、赤纬单位度、距离单位 pc、笛卡尔空间速度单位 pc/年，位置历元 J2000.0；颜色索引允许为空。HYG 衍生数据继续按 CC BY-SA 4.0 分发，不改变其余项目代码的许可。

`constellations.json` 提取 [Olaf Frohn / d3-celestial 固定版本](https://github.com/ofrohn/d3-celestial/tree/7e720a3de062059d4c5400a379146a601d9010e0/data)的 88 星座名称与参考连线（89 分区），按 BSD-3-Clause 保留署名和许可；名称转简体，巨蛇座区分蛇头/蛇尾。连线端点匹配 HYG ID，不使用星座插画或边界。

`constellation-stars.json` 是所需的额外 121 个 HYG 端点数据，按 CC BY-SA 4.0 分发；不增加默认亮星目录的显示数量。端点匹配的最大原始方向差为约 0.004517°，这是两个目录的匹配差，不是实景精度承诺。三份 JSON 随应用提供下载，全部运行时计算均为本地。

重建：`node scripts/build-star-catalog.mjs`。仅重建时下载固定来源；应用运行时使用本地文件。About 提供完整子集下载，第三方许可页保留作者和许可证链接。

搜索别名保留原始 HYG 固有名、HIP 编号及 d3-celestial 星座英文名/缩写，作为本地搜索索引使用；不新增在线搜索或外部运行时请求。

影像配准独立检查：在同一隔离环境额外安装 `astropy==7.1.1 pyavm==0.9.9`，执行 `python scripts/check-deep-sky-images.py 源图目录`，保存 300 个 WCSLIB 参考点、逐目标纹理哈希与旧 atlas 哈希到测试 fixture。只验证转换实现与图格边框，未重新测定影像的原始天球解，也不做光度/相机标定；构建和 CI 无需这些 Python 依赖。

色彩核查：M31 是 DSS2 B/R 成品合成，M42 为 LRGB，其余资料的发布波段和未知项见来源清单。底图未按指定未改机相机标定；额外 RGB 红色优势也不是实测 Hα。运行时增量色为红通道 `[1,0,0]`，避免旧增量加入绿蓝而让本已红的云气偏粉；图集像素不变。可在既有 NumPy/Pillow 环境运行 `python scripts/check-deep-sky-colours.py` 复现固定图集的前后信号审计；Node 回归另核对 GLSL 共用常量。结果见[色彩核查](../../docs/plan/deep-sky-colour-audit.md)。
## World Atlas 2015 光污染

`light-pollution.json` 保存 GFZ 版本 1.1 的来源、许可、原始 SHA256、地理注册、对数编码和分块校验。`public/light-pollution/atlas-2015/*.bin` 是显式 gzip 压缩的 126 份字节分块，文件扩展名避开静态服务的自动 Content-Encoding 解压，运行时先校验压缩字节，再显式解码。有效原生 3×3 像元按线性亮度平均为约 2.8 km 格网，采样时对解码后的值作双线性插值。无效编码 0 与真实零亮度编码 1 分开。

生成入口为 `scripts/build-light-pollution.py`，不参与正常构建或 CI 下载。原始和衍生数据均为 CC BY-NC 4.0，仅限非商业使用，完整作者与两份引用在 About 和第三方说明。版本、边界和验证见[光污染计划](../../docs/plan/light-pollution.md)。

## 流星雨工作表

`meteor-showers.json` 摘录 [IMO Meteor Shower Calendar 2026](https://www.imo.net/files/meteor-shower/cal2026.pdf)（IMO INFO(3-25)，Jürgen Rendtel 编）的表 5“目视流星雨工作表”38 个流星雨，以及表 6 的 234 个辐射点位置。活动曲线的上升/衰减指数取自 [Moorhead 等（2019）](https://arxiv.org/abs/1904.06370)表 5，共 22 个流星雨。两份 PDF 的 SHA-256、权利说明，以及表 6 各列与表 5 辐射点的匹配差值都保存在 JSON 元数据中。

IMO 资料标注 © International Meteor Organization，没有明示许可。经用户确认，本应用署名摘录这些事实数值，不单独提供下载；权利人要求时撤下，商业使用前需另行确认。中文名称为本应用翻译。日期保留 2026 年日历的月-日形式，由应用换算为 J2000 太阳黄经。表 6 的 “Jan 0” 记为 12-31。

重建：在隔离的 Python 环境安装 `pypdf==7.0.0`，下载两份 PDF，然后执行 `python scripts/build-meteor-showers.py cal2026.pdf 1904.06370.pdf`。运行、构建和 CI 直接使用已提交的 JSON。

脚本处理表 6 的方式：表 6 的列在年内依次给不同流星雨使用，因此不按列标签取数；而是按文字坐标取出连续数值段，在辐射点跳变处切开，再用表 5 的极大日期和辐射点以全局最小距离匹配，并把跨年的两段重新接上。

两表不一致之处：波江座η、天鹅座κ、九月天猫座在极大日分别相差 2.2°、4.9°、6.8°，其余不超过 1.04°。运行时以表 5 为准，表 6 只提供漂移。范围与验收见[流星雨计划](../../docs/plan/meteor-showers.md)。
