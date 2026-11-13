# Tamatamatori 推算请求格式 v2

推算请求（`tamatamatori.solve`）描述“画面里要有什么、各在画面哪里”，再给出机位与时间的搜索范围和筛选条件。应用在用户的浏览器中按星历、地形高程与海平面地平搜索拍摄时间或机位，结果由用户试看、挑选后成为普通机位。请求只是意图，链接里的数值不会被当作结果。

- JSON Schema：https://imanity.github.io/Tamatamatori/solve.schema.json
- 机位格式另见：https://imanity.github.io/Tamatamatori/shot-format.md

## 交给用户的方式

链接：`https://imanity.github.io/Tamatamatori/#solve=json:` 后接 URL 编码的 JSON（`encodeURIComponent`）。用户打开后先看到预览：镜头、各目标（注明来自地标目录，或“来自请求中的坐标，未核实”）、搜索范围、筛选以及会改动的拍摄计划字段；确认后进入推算模式并开始搜索，可撤销。整段不超过 16 KB。

## 能求出什么

相机保持水平，焦距与画幅由 `lens` 给定。剩下机位经纬度、时刻、相机方位与俯仰五个量，每个“目标在画面某处”用掉两个。

| 目标与范围 | 结果 |
| --- | --- |
| 一个地面点 + 一个天体，机位不限或在某点周围 | 机位线：每个时刻一处机位 |
| 同上，时刻固定 | 机位点 |
| 一个地面点 + 一个天体，机位固定 | 天体经过画面位置的时刻（按容差） |
| 一个天体，机位与朝向都固定 | 天体落到画面位置的时刻 |
| 两个天体 | 两者到达设定相对位置的时刻；与机位基本无关 |
| 以上任一种再加第三、四个目标 | 第一个地面点与第一个天体（没有地面点时为前两个天体）定机位与时刻，其余目标在每个候选分钟按容差检查：天体须在地平线上，地面点的视线不被地形挡住 |
| 只有一个目标（朝向不固定）、只有地面点、固定朝向时有地面点、机位与时刻都固定 | 不搜索，报出原因 |

## 顶层字段

| 字段 | 取值 | 缺省 |
| --- | --- | --- |
| `format` / `version` | `"tamatamatori.solve"` / `2` | 必填；更高版本拒绝读取；`1` 按下文转换 |
| `name` | 文本，最多 40 字 | 空 |
| `lens` | `{ "focalLength", "sensor", "sensorSize", "aspectRatio", "orientation" }`：焦距 8—1000 mm；传感器 `"full-frame"` / `"aps-c"` / `"micro-four-thirds"` / `"custom"`；画幅 `"3:2"` / `"16:9"` / `"1:1"`；`"landscape"` 横幅 / `"portrait"` 竖幅 | 沿用打开者当前镜头 |
| `targets` | 1—4 个目标，见下 | 必填 |
| `camera` | 机位的搜索范围，见下 | 不限，最远 30 km |
| `time` | 时间的搜索范围，见下 | 打开者当前日期起 30 天 |
| `timeZone` | IANA 时区；给出时按它解释日期，并改为该固定时区 | 沿用打开者当前时区 |
| `filters` | 筛选条件数组，见下 | 无 |

## 目标

所有目标都有 `frame`（`{ "x", "y" }`，自画面左上角起算的比例，缺省为中心）与 `tolerance`（画面高度的比例，0.005—0.2，缺省 0.03）。

| `type` | 字段 | 说明 |
| --- | --- | --- |
| `"ground"` 地面点 | `landmark`（已接入地标 id），或 `latitude` 与 `longitude`；`name` | 坐标目标标为“未核实”，须在地图上确认 |
| | `height` 与 `reference` | `"ground"`（缺省）：高出地面的米数（0—1000），山顶为 0，塔顶为塔高；地标缺省为其高度。`"sea"`：海拔（-500—9000），与应用的地形高程同一套数值，基准未核定 |
| | `base` | 可选：点下方地面在画面中的纵坐标（大于 `frame.y`），用来定主体大小；只用于 `"ground"` 且高度不低于 10 m |
| | `skyline` | 可选，`true` 时对准看得见的山顶：从每个机位看点周围 800 m 的地形轮廓，取比最高处低不到 100 m 的平台的中点（照片里的山顶随方向而变，例如从东北看富士山，剑峰被更高的火口缘挡住，钻石富士时太阳落在平台中间）。只用于 `"ground"` 且高度低于 10 m 的点 |
| `"body"` 天体 | `body` | `"sun"` / `"moon"`，或下面“固定方向天体”中的 id |

## 搜索范围

| `camera.mode` | 字段 | 说明 |
| --- | --- | --- |
| `"free"` | `maxDistance`：`10000` / `20000` / `30000` 米；`minDistance`（可选）：`200` / `1000` / `2000` / `5000` / `10000` 米，缺省 200（不限），须小于 `maxDistance` | 以地面点为中心；`minDistance` 排除贴近地面点的机位（如站在山顶上） |
| `"near"` | `latitude`、`longitude`、`radius`（500—30000 米） | 只列这个范围内的机位 |
| `"fixed"` | `latitude`、`longitude`（缺省为打开者当前机位）、`aim`（`{ "azimuth", "pitch" }`，可选） | 给出 `aim` 时同时固定朝向，只能有一个天体目标 |

三种机位都可带 `heightAboveGround`（0.1—100 m），打开后改为该离地高度。

| `time.mode` | 字段 |
| --- | --- |
| `"range"` | `date`（当地起始日期，缺省为打开者当前拍摄日期）、`days`：`1` / `7` / `30` / `90` / `365` / `1096`；机位不固定时最多 365 天 |
| `"instant"` | `instant`：UTC 时刻，例如 `"2026-11-25T08:10:00Z"` |

## 筛选

| `type` | 字段 | 说明 |
| --- | --- | --- |
| `"sky"` | `sky`：非空数组，`"day"` 白天、`"golden"` 黄金、`"blue"` 蓝调、`"twilight"` 暮光、`"night"` 暗夜 | 按太阳高度 |
| `"moonDown"` | — | 月亮在地平线下；目标里有月亮时报错 |
| `"moonLit"` | `range`：`[下限, 上限]`，取 `0` / `0.1` / `0.25` / `0.5` / `0.75` / `0.9` / `1` | 月亮亮面比例 |
| `"darkSky"` | `limit`：`21.7` 很暗（银河结构清楚）、`21.3` 暗（银河明显）、`20.5` 郊外（银河可见）、`19.5` 郊区（以亮星为主） | 星空可见性：天顶天空亮度（mag/arcsec²，数值越大越暗）不亮于所选值。由自然天光、机位的光污染（World Atlas 2015，约 60°S—75°N）与月光合成，只在天文夜（太阳低于 −18°）成立；没有光污染数据的机位不算通过 |

## 固定方向天体

银心、有中文名的亮星与已收录的深空目标，方向相对恒星固定（J2000 坐标经岁差与章动换算）。它们没有日月那样的视直径，画面中按“标记直径”画出；只在太阳中心低于地平线 6° 时搜索。

| id | 名称 | 类型 | 标记直径 |
| --- | --- | --- | --- |
| `galactic-center` | 银心 | 银心 | 2.0° |
| `hyg-32263` | 天狼星 | 亮星 | 0.5° |
| `hyg-30365` | 老人星 | 亮星 | 0.5° |
| `hyg-69451` | 大角星 | 亮星 | 0.5° |
| `hyg-71456` | 南门二 | 亮星 | 0.5° |
| `hyg-90979` | 织女星 | 亮星 | 0.5° |
| `hyg-24549` | 五车二 | 亮星 | 0.5° |
| `hyg-24378` | 参宿七 | 亮星 | 0.5° |
| `hyg-37173` | 南河三 | 亮星 | 0.5° |
| `hyg-7574` | 水委一 | 亮星 | 0.5° |
| `hyg-27919` | 参宿四 | 亮星 | 0.5° |
| `hyg-68483` | 马腹一 | 亮星 | 0.5° |
| `hyg-97338` | 牛郎星 | 亮星 | 0.5° |
| `hyg-60530` | 十字架二 | 亮星 | 0.5° |
| `hyg-21368` | 毕宿五 | 亮星 | 0.5° |
| `hyg-65269` | 角宿一 | 亮星 | 0.5° |
| `hyg-80519` | 心宿二 | 亮星 | 0.5° |
| `hyg-37718` | 北河三 | 亮星 | 0.5° |
| `hyg-113008` | 北落师门 | 亮星 | 0.5° |
| `hyg-62239` | 十字架三 | 亮星 | 0.5° |
| `hyg-101767` | 天津四 | 亮星 | 0.5° |
| `hyg-71453` | Toliman | 亮星 | 0.5° |
| `hyg-49528` | 轩辕十四 | 亮星 | 0.5° |
| `hyg-33492` | 弧矢七 | 亮星 | 0.5° |
| `hyg-36744` | 北河二 | 亮星 | 0.5° |
| `hyg-60893` | 十字架一 | 亮星 | 0.5° |
| `hyg-85665` | 尾宿八 | 亮星 | 0.5° |
| `hyg-25273` | 参宿五 | 亮星 | 0.5° |
| `hyg-25364` | 五车五 | 亮星 | 0.5° |
| `hyg-45106` | 南船五 | 亮星 | 0.5° |
| `hyg-26246` | 参宿二 | 亮星 | 0.5° |
| `hyg-108922` | 鹤一 | 亮星 | 0.5° |
| `hyg-26662` | 参宿一 | 亮星 | 0.5° |
| `hyg-39840` | 天社一 | 亮星 | 0.5° |
| `hyg-62757` | 玉衡 | 亮星 | 0.5° |
| `hyg-15824` | 天船三 | 亮星 | 0.5° |
| `hyg-89906` | 萁宿三 | 亮星 | 0.5° |
| `hyg-53905` | 天枢 | 亮星 | 0.5° |
| `hyg-34354` | 弧矢一 | 亮星 | 0.5° |
| `hyg-67088` | 摇光 | 亮星 | 0.5° |
| `hyg-40921` | 海石一 | 亮星 | 0.5° |
| `hyg-85965` | 尾宿五 | 亮星 | 0.5° |
| `hyg-28288` | 五车三 | 亮星 | 0.5° |
| `hyg-82022` | 三角形三 | 亮星 | 0.5° |
| `hyg-31601` | 井宿三 | 亮星 | 0.5° |
| `hyg-42794` | 天社三 | 亮星 | 0.5° |
| `hyg-100425` | 孔雀十一 | 亮星 | 0.5° |
| `hyg-11734` | 北极星 | 亮星 | 0.5° |
| `hyg-30251` | 军市一 | 亮星 | 0.5° |
| `hyg-46259` | 星宿一 | 亮星 | 0.5° |
| `hyg-9861` | 娄宿三 | 亮星 | 0.5° |
| `hyg-50440` | 轩辕十二 | 亮星 | 0.5° |
| `hyg-3413` | 土司空 | 亮星 | 0.5° |
| `hyg-92564` | 斗宿四 | 亮星 | 0.5° |
| `hyg-68714` | 库楼三 | 亮星 | 0.5° |
| `hyg-676` | 壁宿二 | 亮星 | 0.5° |
| `hyg-5436` | 奎宿九 | 亮星 | 0.5° |
| `hyg-27298` | 参宿六 | 亮星 | 0.5° |
| `hyg-72380` | 北极二 帝 | 亮星 | 0.5° |
| `hyg-111768` | 鹤二 | 亮星 | 0.5° |
| `hyg-85769` | 侯 | 亮星 | 0.5° |
| `hyg-14540` | 大陵五 | 亮星 | 0.5° |
| `hyg-9618` | 天大将军一 | 亮星 | 0.5° |
| `hyg-57459` | 五帝座一 | 亮星 | 0.5° |
| `hyg-4417` | 策 | 亮星 | 0.5° |
| `hyg-61739` | 库楼七 | 亮星 | 0.5° |
| `hyg-39318` | 弧矢增廿二 | 亮星 | 0.5° |
| `hyg-45425` | 海石二 | 亮星 | 0.5° |
| `hyg-76035` | 贯索四 | 亮星 | 0.5° |
| `hyg-44689` | 天纪 | 亮星 | 0.5° |
| `hyg-65173` | 开阳 | 亮星 | 0.5° |
| `hyg-100128` | 天津一 | 亮星 | 0.5° |
| `hyg-3172` | 王良四 | 亮星 | 0.5° |
| `hyg-87561` | 天棓四 | 亮星 | 0.5° |
| `hyg-25865` | 参宿三 | 亮星 | 0.5° |
| `hyg-744` | 王良一 | 亮星 | 0.5° |
| `hyg-78165` | 房宿三 | 亮星 | 0.5° |
| `hyg-82144` | 尾宿二 | 亮星 | 0.5° |
| `hyg-53754` | 天璇 | 亮星 | 0.5° |
| `hyg-71879` | 梗河一 | 亮星 | 0.5° |
| `hyg-106972` | 危宿三 | 亮星 | 0.5° |
| `hyg-86403` | 尾宿七 | 亮星 | 0.5° |
| `hyg-2076` | 火鸟六 | 亮星 | 0.5° |
| `hyg-57828` | 天玑 | 亮星 | 0.5° |
| `hyg-83755` | 宋 | 亮星 | 0.5° |
| `hyg-113521` | 室宿二 | 亮星 | 0.5° |
| `hyg-35806` | 弧矢二 | 亮星 | 0.5° |
| `hyg-104861` | 天钩五 | 亮星 | 0.5° |
| `hyg-45809` | 天社五 | 亮星 | 0.5° |
| `hyg-102157` | 天津九 | 亮星 | 0.5° |
| `hyg-113603` | 室宿一 | 亮星 | 0.5° |
| `dso-ngc0224` | 仙女座星系 | 深空目标 | 3.0° |
| `dso-ngc1976` | 猎户座大星云 | 深空目标 | 1.5° |
| `dso-mel022` | 昴星团 | 深空目标 | 2.5° |
| `dso-ngc6523` | 礁湖星云 | 深空目标 | 0.8° |
| `dso-ngc7000` | 北美星云 | 深空目标 | 2.0° |
| `dso-ngc1499` | 加州星云 | 深空目标 | 2.7° |
| `dso-ic1805` | 心脏星云 | 深空目标 | 1.0° |
| `dso-ic1848` | 灵魂星云 | 深空目标 | 0.7° |
| `dso-ngc6514` | 三裂星云 | 深空目标 | 0.5° |
| `dso-ngc0598` | 三角座星系 | 深空目标 | 1.0° |
| `dso-ngc2237` | 玫瑰星云 | 深空目标 | 1.3° |
| `dso-ic0434` | 马头星云区域 | 深空目标 | 1.5° |
| `dso-ngc2024` | 火树星云 | 深空目标 | 0.5° |
| `dso-sh2-276` | 巴纳德环 | 深空目标 | 20.0° |
| `dso-rhooph` | 蛇夫座星云复合体 | 深空目标 | 8.0° |

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

## 版本 1

`"version": 1` 的请求（`kind` 为 `"time"` / `"position"` / `"range"`）仍可打开，读入时转换：

- `"time"`：机位固定（`camera` 或打开者当前机位），朝向固定为 `mark`，天体在画面中心；`tolerance`（视直径）按打开者镜头换成画面高度的比例。
- `"position"`：地面点与天体在同一画面位置（`frame`，缺省中心），机位不限，时间为 `date` 当天。
- `"range"`：同上，跨度为 `days`；`share` 换成底部位置 `base = frame.y + share`（目标不足 10 m 时不设）。原来“±20%”的主体占比改为底部位置的容差。
- `phase` 换成 `moonLit`，`sky` 换成 `sky` 筛选。

例：

```json
{
  "format": "tamatamatori.solve",
  "version": 1,
  "kind": "range",
  "body": "moon",
  "target": {
    "landmark": "tokyo-skytree"
  },
  "date": "2026-11-12",
  "days": 90,
  "share": 0.3,
  "phase": [
    0.9,
    1
  ]
}
```

读入后等同于：

```json
{
  "format": "tamatamatori.solve",
  "version": 2,
  "targets": [
    {
      "type": "ground",
      "landmark": "tokyo-skytree",
      "height": 634,
      "reference": "ground",
      "frame": {
        "x": 0.5,
        "y": 0.5
      },
      "base": 0.8,
      "tolerance": 0.03
    },
    {
      "type": "body",
      "body": "moon",
      "frame": {
        "x": 0.5,
        "y": 0.5
      },
      "tolerance": 0.03
    }
  ],
  "camera": {
    "mode": "free",
    "maxDistance": 30000
  },
  "time": {
    "mode": "range",
    "date": "2026-11-12",
    "days": 90
  },
  "filters": [
    {
      "type": "moonLit",
      "range": [
        0.9,
        1
      ]
    }
  ]
}
```

## 规则与限制

- 未知字段、组合不支持与越界取值报错并带字段路径（如 `targets[1].frame.x`）；缺省项在预览中列出。
- 打开时：给出 `lens` 则改为该镜头；固定机位移到该机位（给出 `aim` 时转向）；`"instant"` 移到该时刻；只搜一天时把拍摄日期移到 `date`；其他字段不改。
- 天体位置按海平面地平与所选折射；遮挡只看地形起伏，视线被地形挡住的机位不列出；不含建筑与树木；不含天气。结果是构图模拟，不保证实景可见。
- 推算面板的“复制推算请求”给出同样的链接，“复制结果”给出 Markdown 表格，可交回 AI 挑选。

## 示例

### 深空天体在山顶上方：仙女座星系在富士山顶正上方，105 mm 竖幅，90 天内暗夜、月亮在地平线下

```json
{
  "$schema": "https://imanity.github.io/Tamatamatori/solve.schema.json",
  "format": "tamatamatori.solve",
  "version": 2,
  "name": "M31 与富士山",
  "lens": {
    "focalLength": 105,
    "sensor": "full-frame",
    "aspectRatio": "3:2",
    "orientation": "portrait"
  },
  "targets": [
    {
      "type": "ground",
      "latitude": 35.3606,
      "longitude": 138.7274,
      "name": "富士山顶",
      "height": 0,
      "reference": "ground",
      "frame": {
        "x": 0.5,
        "y": 0.67
      },
      "tolerance": 0.03,
      "skyline": true
    },
    {
      "type": "body",
      "body": "dso-ngc0224",
      "frame": {
        "x": 0.5,
        "y": 0.52
      },
      "tolerance": 0.03
    }
  ],
  "camera": {
    "mode": "free",
    "maxDistance": 30000
  },
  "time": {
    "mode": "range",
    "date": "2026-11-13",
    "days": 90
  },
  "timeZone": "Asia/Tokyo",
  "filters": [
    {
      "type": "sky",
      "sky": [
        "night"
      ]
    },
    {
      "type": "moonDown"
    },
    {
      "type": "darkSky",
      "limit": 21.3
    }
  ]
}
```

```text
https://imanity.github.io/Tamatamatori/#solve=json:%7B%22format%22%3A%22tamatamatori.solve%22%2C%22version%22%3A2%2C%22name%22%3A%22M31%20%E4%B8%8E%E5%AF%8C%E5%A3%AB%E5%B1%B1%22%2C%22lens%22%3A%7B%22focalLength%22%3A105%2C%22sensor%22%3A%22full-frame%22%2C%22aspectRatio%22%3A%223%3A2%22%2C%22orientation%22%3A%22portrait%22%7D%2C%22targets%22%3A%5B%7B%22type%22%3A%22ground%22%2C%22latitude%22%3A35.3606%2C%22longitude%22%3A138.7274%2C%22name%22%3A%22%E5%AF%8C%E5%A3%AB%E5%B1%B1%E9%A1%B6%22%2C%22height%22%3A0%2C%22reference%22%3A%22ground%22%2C%22frame%22%3A%7B%22x%22%3A0.5%2C%22y%22%3A0.67%7D%2C%22tolerance%22%3A0.03%2C%22skyline%22%3Atrue%7D%2C%7B%22type%22%3A%22body%22%2C%22body%22%3A%22dso-ngc0224%22%2C%22frame%22%3A%7B%22x%22%3A0.5%2C%22y%22%3A0.52%7D%2C%22tolerance%22%3A0.03%7D%5D%2C%22camera%22%3A%7B%22mode%22%3A%22free%22%2C%22maxDistance%22%3A30000%7D%2C%22time%22%3A%7B%22mode%22%3A%22range%22%2C%22date%22%3A%222026-11-13%22%2C%22days%22%3A90%7D%2C%22timeZone%22%3A%22Asia%2FTokyo%22%2C%22filters%22%3A%5B%7B%22type%22%3A%22sky%22%2C%22sky%22%3A%5B%22night%22%5D%7D%2C%7B%22type%22%3A%22moonDown%22%7D%2C%7B%22type%22%3A%22darkSky%22%2C%22limit%22%3A21.3%7D%5D%7D
```

### 三个目标：月亮在富士山顶右上方，昴星团在月亮左上方，135 mm 横幅，12 个月

```json
{
  "$schema": "https://imanity.github.io/Tamatamatori/solve.schema.json",
  "format": "tamatamatori.solve",
  "version": 2,
  "name": "月亮、昴星团与富士山",
  "lens": {
    "focalLength": 135,
    "sensor": "full-frame",
    "aspectRatio": "3:2",
    "orientation": "landscape"
  },
  "targets": [
    {
      "type": "ground",
      "latitude": 35.3606,
      "longitude": 138.7274,
      "name": "富士山顶",
      "height": 0,
      "reference": "ground",
      "frame": {
        "x": 0.5,
        "y": 0.8
      },
      "tolerance": 0.03,
      "skyline": true
    },
    {
      "type": "body",
      "body": "moon",
      "frame": {
        "x": 0.55,
        "y": 0.55
      },
      "tolerance": 0.03
    },
    {
      "type": "body",
      "body": "dso-mel022",
      "frame": {
        "x": 0.46,
        "y": 0.42
      },
      "tolerance": 0.05
    }
  ],
  "camera": {
    "mode": "free",
    "maxDistance": 30000
  },
  "time": {
    "mode": "range",
    "date": "2026-11-13",
    "days": 365
  },
  "timeZone": "Asia/Tokyo",
  "filters": []
}
```

```text
https://imanity.github.io/Tamatamatori/#solve=json:%7B%22format%22%3A%22tamatamatori.solve%22%2C%22version%22%3A2%2C%22name%22%3A%22%E6%9C%88%E4%BA%AE%E3%80%81%E6%98%B4%E6%98%9F%E5%9B%A2%E4%B8%8E%E5%AF%8C%E5%A3%AB%E5%B1%B1%22%2C%22lens%22%3A%7B%22focalLength%22%3A135%2C%22sensor%22%3A%22full-frame%22%2C%22aspectRatio%22%3A%223%3A2%22%2C%22orientation%22%3A%22landscape%22%7D%2C%22targets%22%3A%5B%7B%22type%22%3A%22ground%22%2C%22latitude%22%3A35.3606%2C%22longitude%22%3A138.7274%2C%22name%22%3A%22%E5%AF%8C%E5%A3%AB%E5%B1%B1%E9%A1%B6%22%2C%22height%22%3A0%2C%22reference%22%3A%22ground%22%2C%22frame%22%3A%7B%22x%22%3A0.5%2C%22y%22%3A0.8%7D%2C%22tolerance%22%3A0.03%2C%22skyline%22%3Atrue%7D%2C%7B%22type%22%3A%22body%22%2C%22body%22%3A%22moon%22%2C%22frame%22%3A%7B%22x%22%3A0.55%2C%22y%22%3A0.55%7D%2C%22tolerance%22%3A0.03%7D%2C%7B%22type%22%3A%22body%22%2C%22body%22%3A%22dso-mel022%22%2C%22frame%22%3A%7B%22x%22%3A0.46%2C%22y%22%3A0.42%7D%2C%22tolerance%22%3A0.05%7D%5D%2C%22camera%22%3A%7B%22mode%22%3A%22free%22%2C%22maxDistance%22%3A30000%7D%2C%22time%22%3A%7B%22mode%22%3A%22range%22%2C%22date%22%3A%222026-11-13%22%2C%22days%22%3A365%7D%2C%22timeZone%22%3A%22Asia%2FTokyo%22%2C%22filters%22%3A%5B%5D%7D
```

### 钻石富士：太阳落在富士山顶正中，机位离山顶 10—30 km

```json
{
  "$schema": "https://imanity.github.io/Tamatamatori/solve.schema.json",
  "format": "tamatamatori.solve",
  "version": 2,
  "lens": {
    "focalLength": 400,
    "sensor": "full-frame",
    "aspectRatio": "3:2",
    "orientation": "landscape"
  },
  "targets": [
    {
      "type": "ground",
      "latitude": 35.3606,
      "longitude": 138.7274,
      "name": "富士山顶",
      "height": 0,
      "reference": "ground",
      "frame": {
        "x": 0.5,
        "y": 0.6
      },
      "tolerance": 0.03,
      "skyline": true
    },
    {
      "type": "body",
      "body": "sun",
      "frame": {
        "x": 0.5,
        "y": 0.6
      },
      "tolerance": 0.03
    }
  ],
  "camera": {
    "mode": "free",
    "maxDistance": 30000,
    "minDistance": 10000
  },
  "time": {
    "mode": "range",
    "date": "2027-01-01",
    "days": 90
  },
  "timeZone": "Asia/Tokyo",
  "filters": []
}
```

```text
https://imanity.github.io/Tamatamatori/#solve=json:%7B%22format%22%3A%22tamatamatori.solve%22%2C%22version%22%3A2%2C%22lens%22%3A%7B%22focalLength%22%3A400%2C%22sensor%22%3A%22full-frame%22%2C%22aspectRatio%22%3A%223%3A2%22%2C%22orientation%22%3A%22landscape%22%7D%2C%22targets%22%3A%5B%7B%22type%22%3A%22ground%22%2C%22latitude%22%3A35.3606%2C%22longitude%22%3A138.7274%2C%22name%22%3A%22%E5%AF%8C%E5%A3%AB%E5%B1%B1%E9%A1%B6%22%2C%22height%22%3A0%2C%22reference%22%3A%22ground%22%2C%22frame%22%3A%7B%22x%22%3A0.5%2C%22y%22%3A0.6%7D%2C%22tolerance%22%3A0.03%2C%22skyline%22%3Atrue%7D%2C%7B%22type%22%3A%22body%22%2C%22body%22%3A%22sun%22%2C%22frame%22%3A%7B%22x%22%3A0.5%2C%22y%22%3A0.6%7D%2C%22tolerance%22%3A0.03%7D%5D%2C%22camera%22%3A%7B%22mode%22%3A%22free%22%2C%22maxDistance%22%3A30000%2C%22minDistance%22%3A10000%7D%2C%22time%22%3A%7B%22mode%22%3A%22range%22%2C%22date%22%3A%222027-01-01%22%2C%22days%22%3A90%7D%2C%22timeZone%22%3A%22Asia%2FTokyo%22%2C%22filters%22%3A%5B%5D%7D
```

### 月亮落在晴空塔塔尖，塔身占画面约 35%（塔顶加底部）

```json
{
  "$schema": "https://imanity.github.io/Tamatamatori/solve.schema.json",
  "format": "tamatamatori.solve",
  "version": 2,
  "lens": {
    "focalLength": 200,
    "sensor": "full-frame",
    "aspectRatio": "3:2",
    "orientation": "portrait"
  },
  "targets": [
    {
      "type": "ground",
      "landmark": "tokyo-skytree",
      "height": 634,
      "reference": "ground",
      "frame": {
        "x": 0.5,
        "y": 0.35
      },
      "base": 0.7,
      "tolerance": 0.03
    },
    {
      "type": "body",
      "body": "moon",
      "frame": {
        "x": 0.5,
        "y": 0.35
      },
      "tolerance": 0.03
    }
  ],
  "camera": {
    "mode": "free",
    "maxDistance": 30000
  },
  "time": {
    "mode": "range",
    "date": "2026-11-13",
    "days": 30
  },
  "timeZone": "Asia/Tokyo",
  "filters": [
    {
      "type": "moonLit",
      "range": [
        0.9,
        1
      ]
    }
  ]
}
```

```text
https://imanity.github.io/Tamatamatori/#solve=json:%7B%22format%22%3A%22tamatamatori.solve%22%2C%22version%22%3A2%2C%22lens%22%3A%7B%22focalLength%22%3A200%2C%22sensor%22%3A%22full-frame%22%2C%22aspectRatio%22%3A%223%3A2%22%2C%22orientation%22%3A%22portrait%22%7D%2C%22targets%22%3A%5B%7B%22type%22%3A%22ground%22%2C%22landmark%22%3A%22tokyo-skytree%22%2C%22height%22%3A634%2C%22reference%22%3A%22ground%22%2C%22frame%22%3A%7B%22x%22%3A0.5%2C%22y%22%3A0.35%7D%2C%22base%22%3A0.7%2C%22tolerance%22%3A0.03%7D%2C%7B%22type%22%3A%22body%22%2C%22body%22%3A%22moon%22%2C%22frame%22%3A%7B%22x%22%3A0.5%2C%22y%22%3A0.35%7D%2C%22tolerance%22%3A0.03%7D%5D%2C%22camera%22%3A%7B%22mode%22%3A%22free%22%2C%22maxDistance%22%3A30000%7D%2C%22time%22%3A%7B%22mode%22%3A%22range%22%2C%22date%22%3A%222026-11-13%22%2C%22days%22%3A30%7D%2C%22timeZone%22%3A%22Asia%2FTokyo%22%2C%22filters%22%3A%5B%7B%22type%22%3A%22moonLit%22%2C%22range%22%3A%5B0.9%2C1%5D%7D%5D%7D
```

### 固定机位：月亮从富士山顶右上方经过的时刻（3 年内）

```json
{
  "$schema": "https://imanity.github.io/Tamatamatori/solve.schema.json",
  "format": "tamatamatori.solve",
  "version": 2,
  "lens": {
    "focalLength": 200,
    "sensor": "full-frame",
    "aspectRatio": "3:2",
    "orientation": "landscape"
  },
  "targets": [
    {
      "type": "ground",
      "latitude": 35.3606,
      "longitude": 138.7274,
      "name": "富士山顶",
      "height": 0,
      "reference": "ground",
      "frame": {
        "x": 0.45,
        "y": 0.6
      },
      "tolerance": 0.03,
      "skyline": true
    },
    {
      "type": "body",
      "body": "moon",
      "frame": {
        "x": 0.58,
        "y": 0.42
      },
      "tolerance": 0.03
    }
  ],
  "camera": {
    "mode": "fixed",
    "latitude": 35.4172,
    "longitude": 138.8729,
    "heightAboveGround": 1.6
  },
  "time": {
    "mode": "range",
    "date": "2026-11-13",
    "days": 1096
  },
  "timeZone": "Asia/Tokyo",
  "filters": []
}
```

```text
https://imanity.github.io/Tamatamatori/#solve=json:%7B%22format%22%3A%22tamatamatori.solve%22%2C%22version%22%3A2%2C%22lens%22%3A%7B%22focalLength%22%3A200%2C%22sensor%22%3A%22full-frame%22%2C%22aspectRatio%22%3A%223%3A2%22%2C%22orientation%22%3A%22landscape%22%7D%2C%22targets%22%3A%5B%7B%22type%22%3A%22ground%22%2C%22latitude%22%3A35.3606%2C%22longitude%22%3A138.7274%2C%22name%22%3A%22%E5%AF%8C%E5%A3%AB%E5%B1%B1%E9%A1%B6%22%2C%22height%22%3A0%2C%22reference%22%3A%22ground%22%2C%22frame%22%3A%7B%22x%22%3A0.45%2C%22y%22%3A0.6%7D%2C%22tolerance%22%3A0.03%2C%22skyline%22%3Atrue%7D%2C%7B%22type%22%3A%22body%22%2C%22body%22%3A%22moon%22%2C%22frame%22%3A%7B%22x%22%3A0.58%2C%22y%22%3A0.42%7D%2C%22tolerance%22%3A0.03%7D%5D%2C%22camera%22%3A%7B%22mode%22%3A%22fixed%22%2C%22latitude%22%3A35.4172%2C%22longitude%22%3A138.8729%2C%22heightAboveGround%22%3A1.6%7D%2C%22time%22%3A%7B%22mode%22%3A%22range%22%2C%22date%22%3A%222026-11-13%22%2C%22days%22%3A1096%7D%2C%22timeZone%22%3A%22Asia%2FTokyo%22%2C%22filters%22%3A%5B%5D%7D
```

### 两个天体：月亮在昴星团左下方（与机位基本无关）

```json
{
  "$schema": "https://imanity.github.io/Tamatamatori/solve.schema.json",
  "format": "tamatamatori.solve",
  "version": 2,
  "lens": {
    "focalLength": 135,
    "sensor": "full-frame",
    "aspectRatio": "3:2",
    "orientation": "landscape"
  },
  "targets": [
    {
      "type": "body",
      "body": "dso-mel022",
      "frame": {
        "x": 0.6,
        "y": 0.4
      },
      "tolerance": 0.03
    },
    {
      "type": "body",
      "body": "moon",
      "frame": {
        "x": 0.4,
        "y": 0.6
      },
      "tolerance": 0.05
    }
  ],
  "camera": {
    "mode": "free",
    "maxDistance": 30000
  },
  "time": {
    "mode": "range",
    "date": "2026-11-13",
    "days": 365
  },
  "timeZone": "Asia/Tokyo",
  "filters": []
}
```

```text
https://imanity.github.io/Tamatamatori/#solve=json:%7B%22format%22%3A%22tamatamatori.solve%22%2C%22version%22%3A2%2C%22lens%22%3A%7B%22focalLength%22%3A135%2C%22sensor%22%3A%22full-frame%22%2C%22aspectRatio%22%3A%223%3A2%22%2C%22orientation%22%3A%22landscape%22%7D%2C%22targets%22%3A%5B%7B%22type%22%3A%22body%22%2C%22body%22%3A%22dso-mel022%22%2C%22frame%22%3A%7B%22x%22%3A0.6%2C%22y%22%3A0.4%7D%2C%22tolerance%22%3A0.03%7D%2C%7B%22type%22%3A%22body%22%2C%22body%22%3A%22moon%22%2C%22frame%22%3A%7B%22x%22%3A0.4%2C%22y%22%3A0.6%7D%2C%22tolerance%22%3A0.05%7D%5D%2C%22camera%22%3A%7B%22mode%22%3A%22free%22%2C%22maxDistance%22%3A30000%7D%2C%22time%22%3A%7B%22mode%22%3A%22range%22%2C%22date%22%3A%222026-11-13%22%2C%22days%22%3A365%7D%2C%22timeZone%22%3A%22Asia%2FTokyo%22%2C%22filters%22%3A%5B%5D%7D
```
