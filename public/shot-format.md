# Tamatamatori 机位格式 v1

机位（`tamatamatori.shot`）描述决定预览画面的全部拍摄计划：机位与离地高度、方向、镜头、时刻与时区、图层和环境。应用的本地保存、分享码、分享链接与手写或 AI 生成的 JSON 共用同一套读取规则。

- JSON Schema：https://imanity.github.io/Tamatamatori/shot.schema.json
- 推算请求（求时间或机位）另见：https://imanity.github.io/Tamatamatori/solve-format.md

## 交给用户的方式

- **链接**：`https://imanity.github.io/Tamatamatori/#shot=` 后接分享码，或 `json:` 加 URL 编码的 JSON。用户打开后先看到预览，确认才应用。
- **分享码**：`tmt1:` 加 base64url 编码的 UTF-8 JSON。
- **JSON**：用户在“机位 → 导入机位”中粘贴；也接受 Markdown 代码块包着的 JSON。整段不超过 16 KB。

## 字段

| 字段 | 取值 | 缺省 |
| --- | --- | --- |
| `format` | `"tamatamatori.shot"` | 必填 |
| `version` | `1` | 必填；更高版本拒绝读取 |
| `name` / `note` | 文本，最多 40 / 500 字 | 空 |
| `position.latitude` | -90—90° | 必填 |
| `position.longitude` | 度，超出 ±180 取模 | 必填 |
| `position.heightAboveGround` | 0.1—100 m（相机离 DEM 地面） | 1.6 |
| `view.azimuth` | 度，正北 0、顺时针，取模 | 必填 |
| `view.pitch` | -90—90° | 4 |
| `camera.focalLength` | 8—1000 mm | 35 |
| `camera.sensor` | `"full-frame"` / `"aps-c"` / `"micro-four-thirds"` / `"custom"` | `"full-frame"` |
| `camera.sensorSize` | `{ "width", "height" }`，1—100 mm；只在 `custom` 时使用且必填 | — |
| `camera.aspectRatio` | `"3:2"` / `"16:9"` / `"1:1"` | `"3:2"` |
| `camera.orientation` | `"landscape"` / `"portrait"` | `"landscape"` |
| `camera.response` | `"stock"` / `"ha-modified"`（深空显示示意） | `"stock"` |
| `time.instant` | 带 Z 或时差的 ISO 时刻 | 与 `local` 二选一 |
| `time.local` | 当地日期时间，如 `"2026-12-14T23:40"` | 需配合 `timeZone` 或 `followLocalZone` |
| `time.timeZone` | IANA 时区 | 只给 `instant` 时为 `"UTC"` |
| `time.followLocalZone` | 布尔，显示时区跟随机位 | `false` |
| `time.refraction` | `"standard"` / `"none"` | `"standard"` |
| `layers.*` | 布尔：`buildings` 建筑、`sun` 太阳、`sunPath` 太阳轨迹、`moon` 月亮、`moonPath` 月亮轨迹、`stars` 星空、`constellations` 星座、`milkyWay` 银河、`deepSky` 深空天体、`stations` 空间站、`meteors` 流星雨、`meteorDensity` 流星密度、`comets` 彗星、`tides` 潮汐、`aurora` 极光 | `sun`、`moon` 开启，其余关闭 |
| `sky.milkyWayContrast` | 25—200 | 100 |
| `environment.lightPollution` / `weather` | 布尔 | `false` |
| `environment.weatherModel` | `"best_match"` / `"gfs_seamless"` / `"icon_seamless"` / `"ecmwf_ifs"` | `"best_match"` |

## 规则

- 未知字段与越界取值报错，不截断、不猜测；错误一次列全并带字段路径（如 `view.azimuth：应为数字`）。
- `constellations` 需要 `stars`，`sunPath` 需要 `sun`，`moonPath` 需要 `moon`，`meteorDensity` 需要 `meteors`。
- `instant` 与 `local` 都给出时，`local` 须按其精度与 `instant` 一致；夏令时跳过或重复的当地时间报错。
- 范围内的数值原样保留；方位与经度只在越界时取模。
- 预览是基于地理与天文数据的构图模拟，不是实景照片，不保证实景可见。

## 示例

```json
{
  "$schema": "https://imanity.github.io/Tamatamatori/shot.schema.json",
  "format": "tamatamatori.shot",
  "version": 1,
  "name": "富士 · 冬夜银河",
  "note": "",
  "position": {
    "latitude": 35.4172,
    "longitude": 138.8729,
    "heightAboveGround": 1.6
  },
  "view": {
    "azimuth": 200,
    "pitch": 18
  },
  "camera": {
    "focalLength": 24,
    "sensor": "full-frame",
    "aspectRatio": "3:2",
    "orientation": "landscape",
    "response": "stock"
  },
  "time": {
    "instant": "2026-12-14T14:40:00Z",
    "local": "2026-12-14T23:40:00",
    "timeZone": "Asia/Tokyo",
    "followLocalZone": false,
    "refraction": "standard"
  },
  "layers": {
    "buildings": false,
    "sun": true,
    "sunPath": false,
    "moon": true,
    "moonPath": false,
    "stars": true,
    "constellations": false,
    "milkyWay": true,
    "deepSky": false,
    "stations": false,
    "meteors": false,
    "meteorDensity": false,
    "comets": false,
    "tides": false,
    "aurora": false
  },
  "sky": {
    "milkyWayContrast": 100
  },
  "environment": {
    "lightPollution": false,
    "weather": false,
    "weatherModel": "best_match"
  }
}
```

链接：

```text
https://imanity.github.io/Tamatamatori/#shot=tmt1:eyJmb3JtYXQiOiJ0YW1hdGFtYXRvcmkuc2hvdCIsInZlcnNpb24iOjEsIm5hbWUiOiLlr4zlo6sgwrcg5Yas5aSc6ZO25rKzIiwibm90ZSI6IiIsInBvc2l0aW9uIjp7ImxhdGl0dWRlIjozNS40MTcyLCJsb25naXR1ZGUiOjEzOC44NzI5LCJoZWlnaHRBYm92ZUdyb3VuZCI6MS42fSwidmlldyI6eyJhemltdXRoIjoyMDAsInBpdGNoIjoxOH0sImNhbWVyYSI6eyJmb2NhbExlbmd0aCI6MjQsInNlbnNvciI6ImZ1bGwtZnJhbWUiLCJhc3BlY3RSYXRpbyI6IjM6MiIsIm9yaWVudGF0aW9uIjoibGFuZHNjYXBlIiwicmVzcG9uc2UiOiJzdG9jayJ9LCJ0aW1lIjp7Imluc3RhbnQiOiIyMDI2LTEyLTE0VDE0OjQwOjAwWiIsImxvY2FsIjoiMjAyNi0xMi0xNFQyMzo0MDowMCIsInRpbWVab25lIjoiQXNpYS9Ub2t5byIsImZvbGxvd0xvY2FsWm9uZSI6ZmFsc2UsInJlZnJhY3Rpb24iOiJzdGFuZGFyZCJ9LCJsYXllcnMiOnsiYnVpbGRpbmdzIjpmYWxzZSwic3VuIjp0cnVlLCJzdW5QYXRoIjpmYWxzZSwibW9vbiI6dHJ1ZSwibW9vblBhdGgiOmZhbHNlLCJzdGFycyI6dHJ1ZSwiY29uc3RlbGxhdGlvbnMiOmZhbHNlLCJtaWxreVdheSI6dHJ1ZSwiZGVlcFNreSI6ZmFsc2UsInN0YXRpb25zIjpmYWxzZSwibWV0ZW9ycyI6ZmFsc2UsIm1ldGVvckRlbnNpdHkiOmZhbHNlLCJjb21ldHMiOmZhbHNlLCJ0aWRlcyI6ZmFsc2UsImF1cm9yYSI6ZmFsc2V9LCJza3kiOnsibWlsa3lXYXlDb250cmFzdCI6MTAwfSwiZW52aXJvbm1lbnQiOnsibGlnaHRQb2xsdXRpb24iOmZhbHNlLCJ3ZWF0aGVyIjpmYWxzZSwid2VhdGhlck1vZGVsIjoiYmVzdF9tYXRjaCJ9fQ
```
