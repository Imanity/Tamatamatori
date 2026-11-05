# 亮星目录子集

`deep-sky.json` 与 `deep-sky-atlas.png` 是 [OpenNGC 固定提交](https://github.com/mattiaverga/OpenNGC/tree/be3cd6c5498806a2fbb2f7e0452ef802dbb02be0)的衍生数据，作者 Mattia Verga，采用 **CC BY-SA 4.0**。8 个目标保留 J2000 RA/Dec、目录全角径、可用位置角（北向东）和原 Aladin/DSS2 多级轮廓；缺失位置角保持 `null`。目录尺寸与描绘的外轮廓不一定相同，后者可能包含附近未分离的云气。应用使用逐点天球投影，不把图谱的固定角度当作摄影画面的朝向。

图集为 4096×4096；对象的 atlasRect 保存像素矩形，不再按统一方格计算 UV。M45/M8 为 2048×1024，北美/加州为 2048×2048；M31/M42/心脏/灵魂为 1024×1024。补齐三目标时，既有五份影像的像素与角范围不变。无损 PNG 约 8.31 MiB，预算上限 14 MiB；完整 RGBA/mip 纹理约 85 MiB，设备上限较小时等比缩小。

采用 RGBA：RGB 是基础色彩，A 为 1−改机额外红色增量；A 不是最终透明度。普通模式保留基础 RGB，改机额外加入定性红色结构，不能视为窄带通量或具体机型响应。

M31 使用 ESA/Hubble 发布、AstroPix 存档的 heic1112f，署名 **ESA/Hubble & Digitized Sky Survey 2. Acknowledgment: Davide De Martin (ESA/Hubble)**。M42 使用 NOIRLab/AstroPix 的 noao-m42steinberg，署名 **KPNO/NOIRLab/NSF/AURA/Ryan Steinberg and Family/Adam Block**。M45 使用 noao-m45denton，署名 **KPNO/NOIRLab/NSF/AURA/Tad Denton/Adam Block**；M8 使用 noao-m8wideblock，NGC7000 使用 noao-n7000mosblock，两图署名 **KPNO/NOIRLab/NSF/AURA/Adam Block**。加州使用 noao-n1499block，署名 **KPNO/NOIRLab/NSF/AURA/Adam Block**，可见光 LRGB、CC BY 4.0。心脏/灵魂采用固定 Stellarium 提交的 ic1805.png/ic1848.png，署名 **Giuseppe Donatiello, post-processing: Sun Shuwei**，依上游 CREDITS 与作者原页按 CC0 1.0 使用。六份资料保留 AVM；两份去星资料没有原始 AVM，保留上游四角数值、来源哈希与派生 TAN/CD 注册，不能称原始测量解。

处理：完整 TAN 覆盖重投影（含不等 X/Y 尺度的 CROTA2 矩阵），保留 RGB 色彩比例及独立线性强度。M31/M42 沿用既有过滤和背景扣除。M45/M8/北美改用同一发布资料的原尺寸 TIFF；最终影像保留原始高频信息，背景和透明度支持独立滤波，最终 RGB 不作整体去星、模糊、锐化或生成细节。M45/M8/北美/加州/心脏/灵魂的来源边缘过渡为 40 工作像素，M31/M42 为 3 像素；不叠加椭圆遮罩或目录外壳。背景补偿可能去掉部分大尺度分量，来源以外不生成云气。

M31/M45 的额外红色增量为零。加州沿用扩散光支持，心脏/灵魂保留上游去星外观，不重复背景扣除或整体模糊；三个目标均有基础 RGB 和独立红色增量。照片中的星点、光刺与原始色彩处理均是参考资料的一部分，不作为额外星历、精确去星结果或机型/曝光定标。三图另以颜色优势信号的形态重建控制连续支持，抑制照片外围星场，支持小孔处理避免白色星核空洞；基础 RGB 与红色增量同时衰减，星云内部可保留照片星点。此分离不是实测去星或谱线资料。当前验收见 [deep-sky-remaining.md](../../docs/plan/deep-sky-remaining.md)。

手动导出：`node scripts/build-deep-sky.mjs` 核对固定上游内容并保存输入哈希；隔离 Python 环境安装 `Pillow==12.0.0 numpy==2.3.5` 后下载 `scripts/deep-sky-image-sources.json` 各条 url 并按 file 命名存入源图目录，再运行 `python scripts/build-deep-sky-atlas.py 源图目录`。资产输出哈希与各分量最大值写回 JSON；运行/构建/CI 不需要 Python。独立坐标参考由 `scripts/build-deep-sky-reference.py` 使用 `pyerfa==2.0.1.5` 生成，固定 DUT1/极移为零及无折射，未来日期仅作为固定闰秒假设下的矩阵回归。

`milky-way.webp` 为 **ESO/S. Brunier** 的 [ESO0932a 全景](https://www.eso.org/public/images/eso0932a/)衍生图，采用 [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)，不改变 HYG 数据的许可。`milky-way.json` 保存原图与输出 SHA-256、银河坐标映射及改动说明；图像 4096 × 512、约 116 KiB，只表示银纬 ±22.5° 的摄影外观。不是精密天图或曝光模型，可能残留照片中的未解析星点/星云，不据此显示新的可点击天体或推断星历精度。

手动再生成：在隔离 Python 环境安装 `Pillow==12.0.0`，从元数据中给定地址下载原图后执行 `python scripts/build-milky-way.py 原图.jpg`。脚本先核对源 SHA-256，再裁切、重采样、中值抑制星点、局部限幅抑制光晕、降噪、调整黑位与经度接缝、编码 WebP。运行/构建/CI 直接使用已提交资产，不需要 Python 或再次访问 ESO。

`bright-stars.json` 是 David Nash / Astronexus 的 HYG Database v4.1 衍生子集，按 [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/) 分发。原始数据、作者、固定版本链接、SHA-256、字段和修改声明保留在 JSON 元数据中。

修改：排除太阳；保留 V 星等 ≤4.5 的 925 颗恒星及必要数值字段；为主要亮星保留 90 个名称，89 个为中文，缺失中文时使用目录固有名。原有常用中文名优先，其余中文星名由 d3-celestial 按 Hipparcos ID 匹配，保留其 BSD-3-Clause 来源、哈希及原始许可。赤经单位小时、赤纬单位度、距离单位 pc、笛卡尔空间速度单位 pc/年，位置历元 J2000.0；颜色索引允许为空。HYG 衍生数据继续按 CC BY-SA 4.0 分发，不改变其余项目代码的许可。

`constellations.json` 提取 [Olaf Frohn / d3-celestial 固定版本](https://github.com/ofrohn/d3-celestial/tree/7e720a3de062059d4c5400a379146a601d9010e0/data)的 88 星座名称与参考连线（89 分区），按 BSD-3-Clause 保留署名和许可；名称转简体，巨蛇座区分蛇头/蛇尾。连线端点匹配 HYG ID，不使用星座插画或边界。

`constellation-stars.json` 是所需的额外 121 个 HYG 端点数据，按 CC BY-SA 4.0 分发；不增加默认亮星目录的显示数量。端点匹配的最大原始方向差为约 0.004517°，这是两个目录的匹配差，不是实景精度承诺。三份 JSON 随应用提供下载，全部运行时计算均为本地。

重建：`node scripts/build-star-catalog.mjs`。仅重建时下载固定来源；应用运行时使用本地文件。预览署名提供完整子集下载，第三方许可页保留作者和许可证链接。

搜索别名保留原始 HYG 固有名、HIP 编号及 d3-celestial 星座英文名/缩写，作为本地搜索索引使用；不新增在线搜索或外部运行时请求。

影像配准独立检查：在同一隔离环境额外安装 `astropy==7.1.1 pyavm==0.9.9`，执行 `python scripts/check-deep-sky-images.py 源图目录`，保存 125 个 WCSLIB 参考点及当前 atlas 哈希到测试 fixture。只验证转换实现与图格边框，未重新测定影像的原始天球解，也不做光度/相机标定；构建和 CI 无需这些 Python 依赖。

色彩核查：M31 是 DSS2 B/R 成品合成，M42 为 LRGB，其余资料的发布波段和未知项见来源清单。底图未按指定未改机相机标定；额外 RGB 红色优势也不是实测 Hα。运行时增量色为红通道 `[1,0,0]`，避免旧增量加入绿蓝而让本已红的云气偏粉；图集像素不变。可在既有 NumPy/Pillow 环境运行 `python scripts/check-deep-sky-colours.py` 复现固定图集的前后信号审计；Node 回归另核对 GLSL 共用常量。结果见[色彩核查](../../docs/plan/deep-sky-colour-audit.md)。
