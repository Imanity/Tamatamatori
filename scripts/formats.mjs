// Generates the public format files under public/ from the constants in code,
// so the published description cannot drift from what the app accepts:
//   llms.txt, shot-format.md, solve-format.md, shot.schema.json, solve.schema.json
// `node --experimental-strip-types scripts/formats.mjs` writes them;
// `--check` fails when a file differs (run by `npm run build`).
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SHOT_FORMAT, SHOT_VERSION, SHOT_TEXT_LIMIT, SHOT_NAME_LIMIT, SHOT_NOTE_LIMIT, SHARE_PREFIX,
  shotLimits, shotLayerKeys, shotLayerNames, shotLayerRequires, parseShot, shotJson, shotLink,
} from '../src/domain/shot.ts';
import {
  SOLVE_FORMAT, SOLVE_VERSION, SOLVE_TEXT_LIMIT, SOLVE_NAME_LIMIT, solveKinds, solveBodies, timeDays, rangeDays,
  shareLimits, targetHeightLimits, phaseChoices, parseSolve, solveJson, solveLink,
} from '../src/domain/solve.ts';
import { PUBLIC_SITE, SHOT_SCHEMA_FILE, SOLVE_SCHEMA_FILE } from '../src/domain/site.ts';
import { aspectRatios, customSensorLimits, initialPlan, sensors } from '../src/domain/plan.ts';
import { weatherModels } from '../src/domain/weather.ts';
import { skyConditions, skyConditionNames, targetElevationRange, toleranceChoices } from '../src/domain/alignment.ts';
import { distanceChoices } from '../src/domain/position-alignment.ts';
import { landmarks } from '../src/domain/landmarks.ts';
import { DARK_SUN_ELEVATION, fixedBodies } from '../src/domain/sky-targets.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPOSITORY = 'https://github.com/Imanity/Tamatamatori';
const DRAFT = 'https://json-schema.org/draft/2020-12/schema';
const shotSchemaUrl = PUBLIC_SITE + SHOT_SCHEMA_FILE;
const solveSchemaUrl = PUBLIC_SITE + SOLVE_SCHEMA_FILE;
const list = (values) => values.map((value) => `\`${JSON.stringify(value)}\``).join(' / ');
const range = ([low, high], unit = '') => `${low}—${high}${unit}`;
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;

// ---- Examples: written as a person or an AI would, then read back by the app's own parser.
function shotExample() {
  const parsed = parseShot({
    format: SHOT_FORMAT, version: SHOT_VERSION, name: '富士 · 冬夜银河',
    position: { latitude: 35.4172, longitude: 138.8729, heightAboveGround: 1.6 },
    view: { azimuth: 200, pitch: 18 },
    camera: { focalLength: 24, sensor: 'full-frame', aspectRatio: '3:2', orientation: 'landscape' },
    time: { local: '2026-12-14T23:40', timeZone: 'Asia/Tokyo' },
    layers: { sun: true, moon: true, stars: true, milkyWay: true },
  });
  if (!parsed.ok) throw new Error(`机位示例无效：${parsed.errors.join('；')}`);
  return parsed.shot;
}
const solveExamples = [
  {
    title: '找时间：月亮从期望位置经过',
    value: { format: SOLVE_FORMAT, version: SOLVE_VERSION, kind: 'time', body: 'moon', mark: { azimuth: 244.6, elevation: 10.7 },
      camera: { latitude: 35.4172, longitude: 138.8729, heightAboveGround: 1.6 }, date: '2026-11-12', days: 365, timeZone: 'Asia/Tokyo', tolerance: 0.25, phase: [0.9, 1] },
  },
  {
    title: '找机位：某天让太阳落在晴空塔塔尖',
    value: { format: SOLVE_FORMAT, version: SOLVE_VERSION, kind: 'position', body: 'sun', target: { landmark: 'tokyo-skytree' }, date: '2026-12-21', timeZone: 'Asia/Tokyo', maxDistance: 30000 },
  },
  {
    title: '两者都找：90 天内晴空塔与接近满月的月亮，主体占画面 30%',
    value: { format: SOLVE_FORMAT, version: SOLVE_VERSION, name: '晴空塔满月', kind: 'range', body: 'moon', target: { landmark: 'tokyo-skytree' },
      date: '2026-11-12', days: 90, timeZone: 'Asia/Tokyo', share: 0.3, phase: [0.9, 1], sky: ['blue', 'twilight', 'night'] },
  },
  {
    title: '两者都找：12 个月内银心落在晴空塔塔尖（暗夜）',
    value: { format: SOLVE_FORMAT, version: SOLVE_VERSION, kind: 'range', body: 'galactic-center', target: { landmark: 'tokyo-skytree' },
      date: '2027-03-01', days: 365, timeZone: 'Asia/Tokyo', share: 0.25, sky: ['night'] },
  },
  {
    title: '两者都找：坐标目标（山顶，高度 0 表示 DEM 地面）',
    value: { format: SOLVE_FORMAT, version: SOLVE_VERSION, kind: 'range', body: 'sun', target: { latitude: 35.3606, longitude: 138.7274, height: 0, name: '富士山顶' },
      date: '2027-01-01', days: 90, timeZone: 'Asia/Tokyo', maxDistance: 30000 },
  },
].map((example) => {
  const parsed = parseSolve(example.value);
  if (!parsed.ok) throw new Error(`推算请求示例「${example.title}」无效：${parsed.errors.join('；')}`);
  return { ...example, request: parsed.request };
});

// ---- JSON Schemas (draft 2020-12). The app's parser stays the authority; the schema mirrors its rules.
const latitude = { type: 'number', minimum: shotLimits.latitude[0], maximum: shotLimits.latitude[1], description: '纬度，北正南负' };
const longitude = { type: 'number', description: '经度，东正西负；超出 ±180 时取模归一' };
const height = { type: 'number', minimum: shotLimits.heightAboveGround[0], maximum: shotLimits.heightAboveGround[1], description: '相机离地高度，米' };
const shotSchema = {
  $schema: DRAFT,
  $id: shotSchemaUrl,
  title: `Tamatamatori 机位 v${SHOT_VERSION}`,
  description: `拍摄计划的全部字段。未知字段报错；缺省项取应用默认值。说明见 ${PUBLIC_SITE}shot-format.md`,
  type: 'object',
  additionalProperties: false,
  required: ['format', 'version', 'position', 'view', 'time'],
  properties: {
    $schema: { type: 'string', description: '可写本 schema 的地址，读取时忽略' },
    format: { const: SHOT_FORMAT },
    version: { const: SHOT_VERSION },
    name: { type: 'string', maxLength: SHOT_NAME_LIMIT, description: '名称，纯文本' },
    note: { type: 'string', maxLength: SHOT_NOTE_LIMIT, description: '备注，纯文本' },
    position: {
      type: 'object', additionalProperties: false, required: ['latitude', 'longitude'],
      properties: { latitude, longitude, heightAboveGround: { ...height, default: initialPlan.cameraHeight } },
    },
    view: {
      type: 'object', additionalProperties: false, required: ['azimuth'],
      properties: {
        azimuth: { type: 'number', description: '镜头方位角，度，正北为 0、顺时针；超出 0—360 时取模归一' },
        pitch: { type: 'number', minimum: shotLimits.pitch[0], maximum: shotLimits.pitch[1], default: initialPlan.pitch, description: '俯仰角，度，上正下负' },
      },
    },
    camera: {
      type: 'object', additionalProperties: false,
      properties: {
        focalLength: { type: 'number', minimum: shotLimits.focalLength[0], maximum: shotLimits.focalLength[1], default: initialPlan.focalLength, description: '焦距，毫米；视场由传感器与画幅共同决定' },
        sensor: { enum: [...Object.keys(sensors), 'custom'], default: initialPlan.sensor },
        sensorSize: {
          type: 'object', additionalProperties: false, required: ['width', 'height'], description: '只在 sensor 为 "custom" 时使用，毫米',
          properties: Object.fromEntries(['width', 'height'].map((key) => [key, { type: 'number', minimum: customSensorLimits[0], maximum: customSensorLimits[1] }])),
        },
        aspectRatio: { enum: Object.keys(aspectRatios), default: initialPlan.aspectRatio },
        orientation: { enum: ['landscape', 'portrait'], default: initialPlan.orientation },
        response: { enum: ['stock', 'ha-modified'], default: initialPlan.cameraResponse, description: '深空显示：未改机或 Hα 天文改机（示意）' },
      },
      allOf: [{ if: { required: ['sensor'], properties: { sensor: { const: 'custom' } } }, then: { required: ['sensorSize'] }, else: { not: { required: ['sensorSize'] } } }],
    },
    time: {
      type: 'object', additionalProperties: false,
      properties: {
        instant: { type: 'string', format: 'date-time', description: '带 Z 或时差的 ISO 时刻；与 local 同时给出时以它为准' },
        local: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}(:\\d{2})?$', description: '当地日期时间，需配合 timeZone 或 followLocalZone' },
        timeZone: { type: 'string', description: 'IANA 时区，例如 "Asia/Tokyo"' },
        followLocalZone: { type: 'boolean', default: false, description: '显示时区跟随机位' },
        refraction: { enum: ['standard', 'none'], default: initialPlan.refraction, description: '大气折射' },
      },
      anyOf: [{ required: ['instant'] }, { required: ['local'] }],
    },
    layers: {
      type: 'object', additionalProperties: false,
      properties: Object.fromEntries(shotLayerKeys.map((key) => [key, { type: 'boolean', default: !!initialPlan.layers[key], description: shotLayerNames[key] }])),
      allOf: Object.entries(shotLayerRequires).map(([key, base]) => ({
        if: { required: [key], properties: { [key]: { const: true } } }, then: { required: [base], properties: { [base]: { const: true } } },
      })),
    },
    sky: {
      type: 'object', additionalProperties: false,
      properties: { milkyWayContrast: { type: 'number', minimum: shotLimits.milkyWayContrast[0], maximum: shotLimits.milkyWayContrast[1], default: initialPlan.milkyWayContrast } },
    },
    environment: {
      type: 'object', additionalProperties: false,
      properties: {
        lightPollution: { type: 'boolean', default: !!initialPlan.lightPollution },
        weather: { type: 'boolean', default: !!initialPlan.weather },
        weatherModel: { enum: Object.keys(weatherModels), default: 'best_match' },
      },
    },
  },
};

const targetName = { type: 'string', minLength: 1, maxLength: SOLVE_NAME_LIMIT, description: '目标名称' };
const targetHeight = { type: 'number', minimum: targetHeightLimits[0], maximum: targetHeightLimits[1], description: '目标顶部高出 DEM 地面的米数；地标缺省为其高度，坐标缺省为 0' };
const forbid = (...keys) => Object.fromEntries(keys.map((key) => [key, false]));
const solveSchema = {
  $schema: DRAFT,
  $id: solveSchemaUrl,
  title: `Tamatamatori 推算请求 v${SOLVE_VERSION}`,
  description: `求拍摄时间或机位的条件，由应用在本机推算。未知字段与不属于该求法的字段报错。说明见 ${PUBLIC_SITE}solve-format.md`,
  type: 'object',
  additionalProperties: false,
  required: ['format', 'version', 'kind', 'body'],
  properties: {
    $schema: { type: 'string', description: '可写本 schema 的地址，读取时忽略' },
    format: { const: SOLVE_FORMAT },
    version: { const: SOLVE_VERSION },
    name: { type: 'string', maxLength: SOLVE_NAME_LIMIT },
    kind: { enum: [...solveKinds], description: 'time 找时间（机位已定）；position 找机位（某一天）；range 两者都找（一段日期）' },
    body: { enum: [...solveBodies], description: '"sun"、"moon"，或固定方向天体："galactic-center"（银心）、亮星 hyg-…、深空目标 dso-…（见格式说明的列表）' },
    mark: {
      type: 'object', additionalProperties: false, required: ['azimuth', 'elevation'], description: '天体中心的视方位与视高度（含所选折射），度',
      properties: {
        azimuth: { type: 'number', description: '正北为 0、顺时针；取模归一' },
        elevation: { type: 'number', minimum: targetElevationRange[0], maximum: targetElevationRange[1] },
      },
    },
    camera: {
      type: 'object', additionalProperties: false, required: ['latitude', 'longitude'], description: '找时间的机位；缺省沿用打开者当前机位',
      properties: { latitude, longitude, heightAboveGround: height },
    },
    target: {
      description: '地面目标：已接入地标的 id，或坐标',
      oneOf: [
        { type: 'object', additionalProperties: false, required: ['landmark'], properties: { landmark: { enum: landmarks.map((landmark) => landmark.id) }, height: targetHeight, name: targetName } },
        { type: 'object', additionalProperties: false, required: ['latitude', 'longitude'], properties: { latitude, longitude, height: targetHeight, name: targetName } },
      ],
    },
    date: { type: 'string', format: 'date', pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: `当地日期（${range(shotLimits.year)} 年）；缺省为打开者当前拍摄日期` },
    days: { type: 'integer', description: '跨度，天' },
    timeZone: { type: 'string', description: 'IANA 时区；给出时日期按它解释，拍摄计划改为该固定时区' },
    tolerance: { enum: [...toleranceChoices], default: 0.25, description: '中心偏离期望位置的上限，视直径' },
    share: { type: 'number', minimum: shareLimits[0], maximum: shareLimits[1], default: 0.3, description: '主体占画面高度的比例（目标不足 10 m 时改用 maxDistance）' },
    maxDistance: { enum: [...distanceChoices], default: 30000, description: '机位离目标的最远距离，米' },
    phase: { type: 'array', minItems: 2, maxItems: 2, items: { enum: [...phaseChoices] }, description: '月亮亮面比例 [下限, 上限]，下限不大于上限' },
    sky: { type: 'array', minItems: 1, uniqueItems: true, items: { enum: [...skyConditions] }, description: '天空条件（按太阳高度）' },
  },
  allOf: [
    { if: { properties: { kind: { const: 'time' } } }, then: { required: ['mark'], properties: { days: { enum: [...timeDays], default: 365 }, ...forbid('target', 'share', 'maxDistance') } } },
    { if: { properties: { kind: { const: 'position' } } }, then: { required: ['target'], properties: forbid('mark', 'camera', 'days', 'tolerance', 'share', 'phase', 'sky') } },
    { if: { properties: { kind: { const: 'range' } } }, then: { required: ['target'], properties: { days: { enum: [...rangeDays], default: 30 }, ...forbid('mark', 'camera', 'tolerance') } } },
    { if: { properties: { body: { const: 'sun' } } }, then: { properties: forbid('phase', 'sky') } },
    { if: { required: ['body'], properties: { body: { not: { const: 'moon' } } } }, then: { properties: forbid('phase') } },
  ],
};

// ---- Markdown descriptions.
const shot = shotExample();
const shotMarkdown = `# Tamatamatori 机位格式 v${SHOT_VERSION}

机位（\`${SHOT_FORMAT}\`）描述决定预览画面的全部拍摄计划：机位与离地高度、方向、镜头、时刻与时区、图层和环境。应用的本地保存、分享码、分享链接与手写或 AI 生成的 JSON 共用同一套读取规则。

- JSON Schema：${shotSchemaUrl}
- 推算请求（求时间或机位）另见：${PUBLIC_SITE}solve-format.md

## 交给用户的方式

- **链接**：\`${PUBLIC_SITE}#shot=\` 后接分享码，或 \`json:\` 加 URL 编码的 JSON。用户打开后先看到预览，确认才应用。
- **分享码**：\`${SHARE_PREFIX}\` 加 base64url 编码的 UTF-8 JSON。
- **JSON**：用户在“机位 → 导入机位”中粘贴；也接受 Markdown 代码块包着的 JSON。整段不超过 ${SHOT_TEXT_LIMIT / 1024} KB。

## 字段

| 字段 | 取值 | 缺省 |
| --- | --- | --- |
| \`format\` | \`"${SHOT_FORMAT}"\` | 必填 |
| \`version\` | \`${SHOT_VERSION}\` | 必填；更高版本拒绝读取 |
| \`name\` / \`note\` | 文本，最多 ${SHOT_NAME_LIMIT} / ${SHOT_NOTE_LIMIT} 字 | 空 |
| \`position.latitude\` | ${range(shotLimits.latitude, '°')} | 必填 |
| \`position.longitude\` | 度，超出 ±180 取模 | 必填 |
| \`position.heightAboveGround\` | ${range(shotLimits.heightAboveGround, ' m')}（相机离 DEM 地面） | ${initialPlan.cameraHeight} |
| \`view.azimuth\` | 度，正北 0、顺时针，取模 | 必填 |
| \`view.pitch\` | ${range(shotLimits.pitch, '°')} | ${initialPlan.pitch} |
| \`camera.focalLength\` | ${range(shotLimits.focalLength, ' mm')} | ${initialPlan.focalLength} |
| \`camera.sensor\` | ${list([...Object.keys(sensors), 'custom'])} | \`"${initialPlan.sensor}"\` |
| \`camera.sensorSize\` | \`{ "width", "height" }\`，${range(customSensorLimits, ' mm')}；只在 \`custom\` 时使用且必填 | — |
| \`camera.aspectRatio\` | ${list(Object.keys(aspectRatios))} | \`"${initialPlan.aspectRatio}"\` |
| \`camera.orientation\` | ${list(['landscape', 'portrait'])} | \`"${initialPlan.orientation}"\` |
| \`camera.response\` | ${list(['stock', 'ha-modified'])}（深空显示示意） | \`"${initialPlan.cameraResponse}"\` |
| \`time.instant\` | 带 Z 或时差的 ISO 时刻 | 与 \`local\` 二选一 |
| \`time.local\` | 当地日期时间，如 \`"2026-12-14T23:40"\` | 需配合 \`timeZone\` 或 \`followLocalZone\` |
| \`time.timeZone\` | IANA 时区 | 只给 \`instant\` 时为 \`"UTC"\` |
| \`time.followLocalZone\` | 布尔，显示时区跟随机位 | \`false\` |
| \`time.refraction\` | ${list(['standard', 'none'])} | \`"${initialPlan.refraction}"\` |
| \`layers.*\` | 布尔：${shotLayerKeys.map((key) => `\`${key}\` ${shotLayerNames[key]}`).join('、')} | ${shotLayerKeys.filter((key) => initialPlan.layers[key]).map((key) => `\`${key}\``).join('、')} 开启，其余关闭 |
| \`sky.milkyWayContrast\` | ${range(shotLimits.milkyWayContrast)} | ${initialPlan.milkyWayContrast} |
| \`environment.lightPollution\` / \`weather\` | 布尔 | \`false\` |
| \`environment.weatherModel\` | ${list(Object.keys(weatherModels))} | \`"best_match"\` |

## 规则

- 未知字段与越界取值报错，不截断、不猜测；错误一次列全并带字段路径（如 \`view.azimuth：应为数字\`）。
- ${Object.entries(shotLayerRequires).map(([key, base]) => `\`${key}\` 需要 \`${base}\``).join('，')}。
- \`instant\` 与 \`local\` 都给出时，\`local\` 须按其精度与 \`instant\` 一致；夏令时跳过或重复的当地时间报错。
- 范围内的数值原样保留；方位与经度只在越界时取模。
- 预览是基于地理与天文数据的构图模拟，不是实景照片，不保证实景可见。

## 示例

\`\`\`json
${shotJson(shot, shotSchemaUrl)}
\`\`\`

链接：

\`\`\`text
${shotLink(shot, PUBLIC_SITE)}
\`\`\`
`;

const solveMarkdown = `# Tamatamatori 推算请求格式 v${SOLVE_VERSION}

推算请求（\`${SOLVE_FORMAT}\`）描述“想让太阳、月亮或银心、亮星、深空目标落在哪里”。应用在用户的浏览器中按星历、DEM 与海平面地平计算，结果由用户试看、挑选后成为普通机位。请求只是意图，链接里的数值不会被当作结果。

- JSON Schema：${solveSchemaUrl}
- 机位格式另见：${PUBLIC_SITE}shot-format.md

## 交给用户的方式

链接：\`${PUBLIC_SITE}#solve=json:\` 后接 URL 编码的 JSON（\`encodeURIComponent\`）。用户打开后先看到预览：求法、天体、目标（注明来自地标目录，或“来自请求中的坐标，未核实”）、日期、条件以及会改动的拍摄计划字段；确认后才进入推算模式，可撤销。整段不超过 ${SOLVE_TEXT_LIMIT / 1024} KB。

## 三种求法

| \`kind\` | 已知 | 求 | 必填 |
| --- | --- | --- | --- |
| \`"time"\` 找时间 | 机位与天体在天空中的期望位置 | 日期跨度内对齐的时刻 | \`mark\` |
| \`"position"\` 找机位 | 地面目标与某一天 | 当天能让天体落在目标顶部的机位（对齐线） | \`target\` |
| \`"range"\` 两者都找 | 地面目标、主体大小与一段日期 | 哪天、在哪里拍（候选） | \`target\` |

## 字段

| 字段 | 求法 | 取值 | 缺省 |
| --- | --- | --- | --- |
| \`format\` / \`version\` | 全部 | \`"${SOLVE_FORMAT}"\` / \`${SOLVE_VERSION}\` | 必填；更高版本拒绝读取 |
| \`name\` | 全部 | 文本，最多 ${SOLVE_NAME_LIMIT} 字 | 空 |
| \`body\` | 全部 | \`"sun"\` / \`"moon"\`，或下面“固定方向天体”中的 id | 必填 |
| \`mark\` | time | \`{ "azimuth", "elevation" }\`：天体中心的视方位（度，正北 0、顺时针）与视高度（${range(targetElevationRange, '°')}，含所选折射） | 必填 |
| \`camera\` | time | \`{ "latitude", "longitude", "heightAboveGround" }\`，离地 ${range(shotLimits.heightAboveGround, ' m')} | 沿用打开者当前机位 |
| \`target\` | position、range | \`{ "landmark": id }\`，或 \`{ "latitude", "longitude", "height", "name" }\`；\`height\` 为目标顶部高出 DEM 地面的米数（${range(targetHeightLimits)}） | 必填；地标高度缺省为其高度，坐标为 0 |
| \`date\` | 全部 | 当地日期 \`"YYYY-MM-DD"\`：time、range 为起始日；position 为时间轴范围的起始日（开启夜空类图层时为当天中午起 24 小时） | 打开者当前拍摄日期 |
| \`days\` | time | ${list(timeDays)} | 365 |
| \`days\` | range | ${list(rangeDays)} | 30 |
| \`timeZone\` | 全部 | IANA 时区；给出时按它解释日期，并改为该固定时区 | 沿用打开者当前时区 |
| \`tolerance\` | time | ${list([...toleranceChoices])}（中心偏离期望位置的视直径；固定方向天体按标记直径） | 0.25 |
| \`share\` | range | ${range(shareLimits)}，主体占画面高度（目标不足 10 m 时改用 \`maxDistance\`） | 0.3 |
| \`maxDistance\` | position、range | ${list([...distanceChoices])}，米 | 30000 |
| \`phase\` | time、range，月亮 | \`[下限, 上限]\`，取 ${list([...phaseChoices])} | 不限 |
| \`sky\` | time、range，月亮与固定方向天体 | 非空数组：${skyConditions.map((sky) => `\`"${sky}"\` ${skyConditionNames[sky]}`).join('、')} | 不限 |

## 固定方向天体

银心、有中文名的亮星与已收录的深空目标，方向相对恒星固定（J2000 坐标经岁差与章动换算）。它们没有日月那样的视直径，期望位置按“标记直径”画出，容差也按它计；只在太阳中心低于地平线 ${-DARK_SUN_ELEVATION}° 时推算，\`sky\` 只有 \`"twilight"\` 与 \`"night"\` 起作用。

| id | 名称 | 类型 | 标记直径 |
| --- | --- | --- | --- |
${fixedBodies.map((body) => `| \`${body.id}\` | ${body.name} | ${{ core: '银心', star: '亮星', deepSky: '深空目标' }[body.kind]} | ${(2 * body.radius).toFixed(1)}° |`).join('\n')}

## 已接入地标

| id | 名称 | 纬度 | 经度 | 高度 m |
| --- | --- | --- | --- | --- |
${landmarks.map((landmark) => `| \`${landmark.id}\` | ${landmark.name} | ${landmark.latitude.toFixed(5)} | ${landmark.longitude.toFixed(5)} | ${landmark.bounds.height} |`).join('\n')}

其他目标请给坐标。应用不解析地名；不确定坐标时请让用户在应用中放置目标，不要猜测。

## 规则与限制

- 未知字段、不属于该求法的字段和越界取值报错并带字段路径；缺省项在预览中列出。
- 找时间打开时转向期望位置（方位与俯仰），给出 \`camera\` 时移到该机位；找机位把拍摄日期移到 \`date\`；其他字段不改。
- 天体位置按海平面地平与所选折射；通视只检查 DEM，不含建筑与树木；不含天气。结果是构图模拟，不保证实景可见。
- 推算面板的“复制推算请求”给出同样的链接，“复制结果”给出 Markdown 表格，可交回 AI 挑选。

## 示例

${solveExamples.map((example) => `### ${example.title}

\`\`\`json
${solveJson(example.request, solveSchemaUrl)}
\`\`\`

\`\`\`text
${solveLink(example.request, PUBLIC_SITE)}
\`\`\`
`).join('\n')}`;

const llms = `# Tamatamatori

> 摄影规划 Web App：在地图上确定机位与拍摄方向，调整时间和镜头参数，在预览中评估地面、天空与日月星辰的构图。计算全部在用户的浏览器中完成，没有后端或 API。

AI 可以用两种链接把结果交给用户，用户打开后先看到预览，确认才应用：

- 机位链接 \`${PUBLIC_SITE}#shot=json:<URL 编码的机位 JSON>\`：一个完整的拍摄计划。
- 推算请求链接 \`${PUBLIC_SITE}#solve=json:<URL 编码的推算请求 JSON>\`：让应用求拍摄时间或机位（例如让月亮或银心落在某座塔的塔尖）。

写之前请读对应格式说明；字段错误会被逐条指出，可据此修正。地点请给坐标或已接入地标的 id，不要猜测坐标。预览与推算都是基于地理和天文数据的构图模拟，不代表实景一定可见。

## 格式

- [机位格式 v${SHOT_VERSION}](${PUBLIC_SITE}shot-format.md)：字段、取值范围、默认值与示例
- [推算请求格式 v${SOLVE_VERSION}](${PUBLIC_SITE}solve-format.md)：找时间、找机位、两者都找，已接入地标列表
- [机位 JSON Schema](${shotSchemaUrl})
- [推算请求 JSON Schema](${solveSchemaUrl})

## Optional

- [源代码](${REPOSITORY})
`;

const outputs = {
  'public/llms.txt': llms,
  'public/shot-format.md': shotMarkdown,
  'public/solve-format.md': solveMarkdown,
  [`public/${SHOT_SCHEMA_FILE}`]: json(shotSchema),
  [`public/${SOLVE_SCHEMA_FILE}`]: json(solveSchema),
};

const check = process.argv.includes('--check');
const normalize = (text) => text.replace(/\r\n/g, '\n');
const stale = [];
for (const [path, content] of Object.entries(outputs)) {
  const file = resolve(root, path);
  if (check) {
    const current = await readFile(file, 'utf8').catch(() => null);
    if (current === null || normalize(current) !== content) stale.push(path);
  } else await writeFile(file, content);
}
if (stale.length) {
  console.error(`公开格式文件与代码不一致：${stale.join('、')}。请运行 npm run formats 后提交。`);
  process.exit(1);
}
console.log(check ? `公开格式文件一致（${Object.keys(outputs).length} 份）` : `已生成 ${Object.keys(outputs).join('、')}`);
