# 亮星目录子集

`milky-way.webp` 为 **ESO/S. Brunier** 的 [ESO0932a 全景](https://www.eso.org/public/images/eso0932a/)衍生图，采用 [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)，不改变 HYG 数据的许可。`milky-way.json` 保存原图与输出 SHA-256、银河坐标映射及改动说明；图像 4096 × 512、约 116 KiB，只表示银纬 ±22.5° 的摄影外观。不是精密天图或曝光模型，可能残留照片中的未解析星点/星云，不据此显示新的可点击天体或推断星历精度。

手动再生成：在隔离 Python 环境安装 `Pillow==12.0.0`，从元数据中给定地址下载原图后执行 `python scripts/build-milky-way.py 原图.jpg`。脚本先核对源 SHA-256，再裁切、重采样、中值抑制星点、局部限幅抑制光晕、降噪、调整黑位与经度接缝、编码 WebP。运行/构建/CI 直接使用已提交资产，不需要 Python 或再次访问 ESO。

`bright-stars.json` 是 David Nash / Astronexus 的 HYG Database v4.1 衍生子集，按 [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/) 分发。原始数据、作者、固定版本链接、SHA-256、字段和修改声明保留在 JSON 元数据中。

修改：排除太阳；保留 V 星等 ≤4.5 的 925 颗恒星及必要数值字段；为主要亮星保留 90 个名称，89 个为中文，缺失中文时使用目录固有名。原有常用中文名优先，其余中文星名由 d3-celestial 按 Hipparcos ID 匹配，保留其 BSD-3-Clause 来源、哈希及原始许可。赤经单位小时、赤纬单位度、距离单位 pc、笛卡尔空间速度单位 pc/年，位置历元 J2000.0；颜色索引允许为空。HYG 衍生数据继续按 CC BY-SA 4.0 分发，不改变其余项目代码的许可。

`constellations.json` 提取 [Olaf Frohn / d3-celestial 固定版本](https://github.com/ofrohn/d3-celestial/tree/7e720a3de062059d4c5400a379146a601d9010e0/data)的 88 星座名称与参考连线（89 分区），按 BSD-3-Clause 保留署名和许可；名称转简体，巨蛇座区分蛇头/蛇尾。连线端点匹配 HYG ID，不使用星座插画或边界。

`constellation-stars.json` 是所需的额外 121 个 HYG 端点数据，按 CC BY-SA 4.0 分发；不增加默认亮星目录的显示数量。端点匹配的最大原始方向差为约 0.004517°，这是两个目录的匹配差，不是实景精度承诺。三份 JSON 随应用提供下载，全部运行时计算均为本地。

重建：`node scripts/build-star-catalog.mjs`。仅重建时下载固定来源；应用运行时使用本地文件。预览署名提供完整子集下载，第三方许可页保留作者和许可证链接。

搜索别名保留原始 HYG 固有名、HIP 编号及 d3-celestial 星座英文名/缩写，作为本地搜索索引使用；不新增在线搜索或外部运行时请求。
