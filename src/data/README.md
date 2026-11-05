# 亮星目录子集

`bright-stars.json` 是 David Nash / Astronexus 的 HYG Database v4.1 衍生子集，按 [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/) 分发。原始数据、作者、固定版本链接、SHA-256、字段和修改声明保留在 JSON 元数据中。

修改：排除太阳；保留 V 星等 ≤4.5 的 925 颗恒星及必要数值字段；加入 18 个中文名称。赤经单位小时、赤纬单位度、距离单位 pc、笛卡尔空间速度单位 pc/年，位置历元 J2000.0；颜色索引允许为空。数据许可适用于该子集，不改变其余项目代码的许可。

重建：`node scripts/build-star-catalog.mjs`。仅重建时下载固定来源；应用运行时使用本地文件。预览署名提供完整子集下载，第三方许可页保留作者和许可证链接。
