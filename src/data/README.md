# 亮星目录子集

`deep-sky.json` 与 `deep-sky-atlas.png` 是 [OpenNGC 固定提交](https://github.com/mattiaverga/OpenNGC/tree/be3cd6c5498806a2fbb2f7e0452ef802dbb02be0)的衍生数据，作者 Mattia Verga，采用 **CC BY-SA 4.0**。8 个目标保留 J2000 RA/Dec、目录全角径、可用位置角（北向东）和原 Aladin/DSS2 多级轮廓；缺失位置角保持 `null`。目录尺寸与描绘的外轮廓不一定相同，后者可能包含附近未分离的云气。应用使用逐点天球投影，不把图谱的固定角度当作摄影画面的朝向。

分量图 4096 × 2048，8 个 1024 像素方格，R/G/B 分别存储连续谱/Hα/其他发射的**定性显示权重**，不是 RGB 照片或窄带实测通量。M31/M42 的局部结构现加入 imageSources 中固定的两幅 CC BY 4.0 影像：M31 为 ESA/Hubble 发布、AstroPix 存档的 heic0512d（÷ 2002 R. Gendler, Photo by R. Gendler），M42 为 eso1103a（ESO/Igor Chekalin）。输入按嵌入的 AVM/TAN 坐标重投影，抑制部分前景星点、调整黑位与显示层次，在椭圆羽化覆盖中叠加到 16% 的原轮廓；覆盖之外保留较淡的目录近似，不生成或补造照片细节。星系外层使用目录椭圆/核心、昴星团使用现有 HYG 恒星位置附近的反射光晕，发射星云使用目录轮廓及平滑径向衰减；不生成随机云团或未知天体。M31/M45 的 Hα 分量为零，仅表示本轮不单独绘制它们的发射区，不代表这些目标没有任何 Hα 光。未改机与改机采用 0.25/1 的 Hα 显示权重，参考一般增透原理作对比，不能当成任意机型的实测灵敏度。

手动导出：`node scripts/build-deep-sky.mjs` 核对固定上游内容并保存输入哈希；隔离 Python 环境安装 `Pillow==12.0.0 numpy==2.3.5` 后下载 `scripts/deep-sky-image-sources.json` 两条 url 并按 file 命名存入源图目录，再运行 `python scripts/build-deep-sky-atlas.py 源图目录`。资产输出哈希与各分量最大值写回 JSON；运行/构建/CI 不需要 Python。独立坐标参考由 `scripts/build-deep-sky-reference.py` 使用 `pyerfa==2.0.1.5` 生成，固定 DUT1/极移为零及无折射，未来日期仅作为固定闰秒假设下的矩阵回归。

`milky-way.webp` 为 **ESO/S. Brunier** 的 [ESO0932a 全景](https://www.eso.org/public/images/eso0932a/)衍生图，采用 [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)，不改变 HYG 数据的许可。`milky-way.json` 保存原图与输出 SHA-256、银河坐标映射及改动说明；图像 4096 × 512、约 116 KiB，只表示银纬 ±22.5° 的摄影外观。不是精密天图或曝光模型，可能残留照片中的未解析星点/星云，不据此显示新的可点击天体或推断星历精度。

手动再生成：在隔离 Python 环境安装 `Pillow==12.0.0`，从元数据中给定地址下载原图后执行 `python scripts/build-milky-way.py 原图.jpg`。脚本先核对源 SHA-256，再裁切、重采样、中值抑制星点、局部限幅抑制光晕、降噪、调整黑位与经度接缝、编码 WebP。运行/构建/CI 直接使用已提交资产，不需要 Python 或再次访问 ESO。

`bright-stars.json` 是 David Nash / Astronexus 的 HYG Database v4.1 衍生子集，按 [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/) 分发。原始数据、作者、固定版本链接、SHA-256、字段和修改声明保留在 JSON 元数据中。

修改：排除太阳；保留 V 星等 ≤4.5 的 925 颗恒星及必要数值字段；为主要亮星保留 90 个名称，89 个为中文，缺失中文时使用目录固有名。原有常用中文名优先，其余中文星名由 d3-celestial 按 Hipparcos ID 匹配，保留其 BSD-3-Clause 来源、哈希及原始许可。赤经单位小时、赤纬单位度、距离单位 pc、笛卡尔空间速度单位 pc/年，位置历元 J2000.0；颜色索引允许为空。HYG 衍生数据继续按 CC BY-SA 4.0 分发，不改变其余项目代码的许可。

`constellations.json` 提取 [Olaf Frohn / d3-celestial 固定版本](https://github.com/ofrohn/d3-celestial/tree/7e720a3de062059d4c5400a379146a601d9010e0/data)的 88 星座名称与参考连线（89 分区），按 BSD-3-Clause 保留署名和许可；名称转简体，巨蛇座区分蛇头/蛇尾。连线端点匹配 HYG ID，不使用星座插画或边界。

`constellation-stars.json` 是所需的额外 121 个 HYG 端点数据，按 CC BY-SA 4.0 分发；不增加默认亮星目录的显示数量。端点匹配的最大原始方向差为约 0.004517°，这是两个目录的匹配差，不是实景精度承诺。三份 JSON 随应用提供下载，全部运行时计算均为本地。

重建：`node scripts/build-star-catalog.mjs`。仅重建时下载固定来源；应用运行时使用本地文件。预览署名提供完整子集下载，第三方许可页保留作者和许可证链接。

搜索别名保留原始 HYG 固有名、HIP 编号及 d3-celestial 星座英文名/缩写，作为本地搜索索引使用；不新增在线搜索或外部运行时请求。

影像配准独立检查：在同一隔离环境额外安装 `astropy==7.1.1 pyavm==0.9.9`，执行 `python scripts/check-deep-sky-images.py 源图目录`，保存 50 个 WCSLIB 参考点及当前 atlas 哈希到测试 fixture。只验证转换实现与零边框，未重新测定影像的原始天球解，也不做光度/相机标定；构建和 CI 无需这些 Python 依赖。
