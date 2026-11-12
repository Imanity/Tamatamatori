# Tamatamatori 推算请求格式 v1

推算请求（`tamatamatori.solve`）描述“想让太阳或月亮落在哪里”。应用在用户的浏览器中按星历、DEM 与海平面地平计算，结果由用户试看、挑选后成为普通机位。请求只是意图，链接里的数值不会被当作结果。

- JSON Schema：https://imanity.github.io/Tamatamatori/solve.schema.json
- 机位格式另见：https://imanity.github.io/Tamatamatori/shot-format.md

## 交给用户的方式

链接：`https://imanity.github.io/Tamatamatori/#solve=json:` 后接 URL 编码的 JSON（`encodeURIComponent`）。用户打开后先看到预览：求法、天体、目标（注明来自地标目录，或“来自请求中的坐标，未核实”）、日期、条件以及会改动的拍摄计划字段；确认后才进入推算模式，可撤销。整段不超过 16 KB。

## 三种求法

| `kind` | 已知 | 求 | 必填 |
| --- | --- | --- | --- |
| `"time"` 找时间 | 机位与天体在天空中的期望位置 | 日期跨度内对齐的时刻 | `mark` |
| `"position"` 找机位 | 地面目标与某一天 | 当天能让天体落在目标顶部的机位（对齐线） | `target` |
| `"range"` 两者都找 | 地面目标、主体大小与一段日期 | 哪天、在哪里拍（候选） | `target` |

## 字段

| 字段 | 求法 | 取值 | 缺省 |
| --- | --- | --- | --- |
| `format` / `version` | 全部 | `"tamatamatori.solve"` / `1` | 必填；更高版本拒绝读取 |
| `name` | 全部 | 文本，最多 40 字 | 空 |
| `body` | 全部 | `"sun"` / `"moon"` | 必填 |
| `mark` | time | `{ "azimuth", "elevation" }`：天体中心的视方位（度，正北 0、顺时针）与视高度（-0.25—89°，含所选折射） | 必填 |
| `camera` | time | `{ "latitude", "longitude", "heightAboveGround" }`，离地 0.1—100 m | 沿用打开者当前机位 |
| `target` | position、range | `{ "landmark": id }`，或 `{ "latitude", "longitude", "height", "name" }`；`height` 为目标顶部高出 DEM 地面的米数（0—1000） | 必填；地标高度缺省为其高度，坐标为 0 |
| `date` | 全部 | 当地日期 `"YYYY-MM-DD"`：time、range 为起始日；position 为时间轴范围的起始日（开启夜空类图层时为当天中午起 24 小时） | 打开者当前拍摄日期 |
| `days` | time | `30` / `90` / `365` / `1096` | 365 |
| `days` | range | `7` / `30` / `90` / `365` | 30 |
| `timeZone` | 全部 | IANA 时区；给出时按它解释日期，并改为该固定时区 | 沿用打开者当前时区 |
| `tolerance` | time | `0.1` / `0.25` / `0.5` / `1`（中心偏离期望位置的视直径） | 0.25 |
| `share` | range | 0.05—0.5，主体占画面高度（目标不足 10 m 时改用 `maxDistance`） | 0.3 |
| `maxDistance` | position、range | `10000` / `20000` / `30000`，米 | 30000 |
| `phase` | time、range，月亮 | `[下限, 上限]`，取 `0` / `0.1` / `0.25` / `0.5` / `0.75` / `0.9` / `1` | 不限 |
| `sky` | time、range，月亮 | 非空数组：`"day"` 白天、`"golden"` 黄金、`"blue"` 蓝调、`"twilight"` 暮光、`"night"` 暗夜 | 不限 |

## 已接入地标

| id | 名称 | 纬度 | 经度 | 高度 m |
| --- | --- | --- | --- | --- |
| `big-ben` | 伊丽莎白塔（大本钟） | 51.50070 | -0.12457 | 96 |
| `burj-al-arab` | 帆船酒店 | 25.14128 | 55.18540 | 321 |
| `burj-khalifa` | 哈利法塔 | 25.19708 | 55.27422 | 828 |
| `chrysler-building` | 克莱斯勒大厦 | 40.75160 | -73.97533 | 318.9 |
| `cn-tower` | 加拿大国家电视塔 | 43.64259 | -79.38709 | 553.3 |
| `eiffel-tower` | 埃菲尔铁塔 | 48.85826 | 2.29449 | 330 |
| `empire-state-building` | 帝国大厦 | 40.74848 | -73.98578 | 443.2 |
| `lotte-world-tower` | 乐天世界塔 | 37.51254 | 127.10266 | 555 |
| `metlife-building` | 大都会人寿大厦 | 40.75358 | -73.97661 | 246.3 |
| `one-world-trade-center` | 世贸中心一号楼 | 40.71300 | -74.01319 | 541.3 |
| `oriental-pearl` | 东方明珠 | 31.24189 | 121.49526 | 468 |
| `osaka-castle` | 大阪城天守阁 | 34.68727 | 135.52586 | 54.8 |
| `petronas-towers` | 双子塔 | 3.15797 | 101.71175 | 451.9 |
| `shanghai-tower` | 上海中心 | 31.23551 | 121.50132 | 632 |
| `shanghai-wfc` | 上海环球金融中心 | 31.23657 | 121.50304 | 492 |
| `sydney-opera-house` | 悉尼歌剧院 | -33.85711 | 151.21507 | 65 |
| `taipei-101` | 台北101 | 25.03367 | 121.56480 | 508 |
| `three-world-trade-center` | 世贸中心三号楼 | 40.71103 | -74.01112 | 328.9 |
| `tokyo-skytree` | 晴空塔 | 35.71005 | 139.81072 | 634 |
| `tokyo-tower` | 东京塔 | 35.65859 | 139.74544 | 333 |
| `willis-tower` | 威利斯大厦 | 41.87889 | -87.63587 | 527 |

其他目标请给坐标。应用不解析地名；不确定坐标时请让用户在应用中放置目标，不要猜测。

## 规则与限制

- 未知字段、不属于该求法的字段和越界取值报错并带字段路径；缺省项在预览中列出。
- 找时间打开时转向期望位置（方位与俯仰），给出 `camera` 时移到该机位；找机位把拍摄日期移到 `date`；其他字段不改。
- 天体位置按海平面地平与所选折射；通视只检查 DEM，不含建筑与树木；不含天气。结果是构图模拟，不保证实景可见。
- 推算面板的“复制推算请求”给出同样的链接，“复制结果”给出 Markdown 表格，可交回 AI 挑选。

## 示例

### 找时间：月亮从期望位置经过

```json
{
  "$schema": "https://imanity.github.io/Tamatamatori/solve.schema.json",
  "format": "tamatamatori.solve",
  "version": 1,
  "kind": "time",
  "body": "moon",
  "mark": {
    "azimuth": 244.6,
    "elevation": 10.7
  },
  "camera": {
    "latitude": 35.4172,
    "longitude": 138.8729,
    "heightAboveGround": 1.6
  },
  "date": "2026-11-12",
  "days": 365,
  "timeZone": "Asia/Tokyo",
  "tolerance": 0.25,
  "phase": [
    0.9,
    1
  ]
}
```

```text
https://imanity.github.io/Tamatamatori/#solve=json:%7B%22format%22%3A%22tamatamatori.solve%22%2C%22version%22%3A1%2C%22kind%22%3A%22time%22%2C%22body%22%3A%22moon%22%2C%22mark%22%3A%7B%22azimuth%22%3A244.6%2C%22elevation%22%3A10.7%7D%2C%22camera%22%3A%7B%22latitude%22%3A35.4172%2C%22longitude%22%3A138.8729%2C%22heightAboveGround%22%3A1.6%7D%2C%22date%22%3A%222026-11-12%22%2C%22days%22%3A365%2C%22timeZone%22%3A%22Asia%2FTokyo%22%2C%22tolerance%22%3A0.25%2C%22phase%22%3A%5B0.9%2C1%5D%7D
```

### 找机位：某天让太阳落在晴空塔塔尖

```json
{
  "$schema": "https://imanity.github.io/Tamatamatori/solve.schema.json",
  "format": "tamatamatori.solve",
  "version": 1,
  "kind": "position",
  "body": "sun",
  "target": {
    "landmark": "tokyo-skytree",
    "height": 634
  },
  "date": "2026-12-21",
  "timeZone": "Asia/Tokyo",
  "maxDistance": 30000
}
```

```text
https://imanity.github.io/Tamatamatori/#solve=json:%7B%22format%22%3A%22tamatamatori.solve%22%2C%22version%22%3A1%2C%22kind%22%3A%22position%22%2C%22body%22%3A%22sun%22%2C%22target%22%3A%7B%22landmark%22%3A%22tokyo-skytree%22%2C%22height%22%3A634%7D%2C%22date%22%3A%222026-12-21%22%2C%22timeZone%22%3A%22Asia%2FTokyo%22%2C%22maxDistance%22%3A30000%7D
```

### 两者都找：90 天内晴空塔与接近满月的月亮，主体占画面 30%

```json
{
  "$schema": "https://imanity.github.io/Tamatamatori/solve.schema.json",
  "format": "tamatamatori.solve",
  "version": 1,
  "name": "晴空塔满月",
  "kind": "range",
  "body": "moon",
  "target": {
    "landmark": "tokyo-skytree",
    "height": 634
  },
  "date": "2026-11-12",
  "days": 90,
  "timeZone": "Asia/Tokyo",
  "share": 0.3,
  "maxDistance": 30000,
  "phase": [
    0.9,
    1
  ],
  "sky": [
    "blue",
    "twilight",
    "night"
  ]
}
```

```text
https://imanity.github.io/Tamatamatori/#solve=json:%7B%22format%22%3A%22tamatamatori.solve%22%2C%22version%22%3A1%2C%22name%22%3A%22%E6%99%B4%E7%A9%BA%E5%A1%94%E6%BB%A1%E6%9C%88%22%2C%22kind%22%3A%22range%22%2C%22body%22%3A%22moon%22%2C%22target%22%3A%7B%22landmark%22%3A%22tokyo-skytree%22%2C%22height%22%3A634%7D%2C%22date%22%3A%222026-11-12%22%2C%22days%22%3A90%2C%22timeZone%22%3A%22Asia%2FTokyo%22%2C%22share%22%3A0.3%2C%22maxDistance%22%3A30000%2C%22phase%22%3A%5B0.9%2C1%5D%2C%22sky%22%3A%5B%22blue%22%2C%22twilight%22%2C%22night%22%5D%7D
```

### 两者都找：坐标目标（山顶，高度 0 表示 DEM 地面）

```json
{
  "$schema": "https://imanity.github.io/Tamatamatori/solve.schema.json",
  "format": "tamatamatori.solve",
  "version": 1,
  "kind": "range",
  "body": "sun",
  "target": {
    "latitude": 35.3606,
    "longitude": 138.7274,
    "height": 0,
    "name": "富士山顶"
  },
  "date": "2027-01-01",
  "days": 90,
  "timeZone": "Asia/Tokyo",
  "share": 0.3,
  "maxDistance": 30000
}
```

```text
https://imanity.github.io/Tamatamatori/#solve=json:%7B%22format%22%3A%22tamatamatori.solve%22%2C%22version%22%3A1%2C%22kind%22%3A%22range%22%2C%22body%22%3A%22sun%22%2C%22target%22%3A%7B%22latitude%22%3A35.3606%2C%22longitude%22%3A138.7274%2C%22height%22%3A0%2C%22name%22%3A%22%E5%AF%8C%E5%A3%AB%E5%B1%B1%E9%A1%B6%22%7D%2C%22date%22%3A%222027-01-01%22%2C%22days%22%3A90%2C%22timeZone%22%3A%22Asia%2FTokyo%22%2C%22share%22%3A0.3%2C%22maxDistance%22%3A30000%7D
```
