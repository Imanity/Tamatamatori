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
  SOLVE_FORMAT, SOLVE_VERSION, SOLVE_VERSION_2, SOLVE_TEXT_LIMIT, SOLVE_NAME_LIMIT, solveBodies,
  targetHeightLimits, seaHeightLimits, phaseChoices, toleranceLimits, nearLimits, parseAnySolve, solveJson2, solveLink2,
} from '../src/domain/solve.ts';
import { dayChoices, dayLabel, DEFAULT_TOLERANCE, distanceChoices as cameraDistances, MAX_LINE_DAYS, TARGET_LIMIT } from '../src/domain/composition.ts';
import { PUBLIC_SITE, SHOT_SCHEMA_FILE, SOLVE_SCHEMA_FILE } from '../src/domain/site.ts';
import { aspectRatios, customSensorLimits, initialPlan, sensors } from '../src/domain/plan.ts';
import { lensOf } from '../src/domain/composition.ts';
import { weatherModels } from '../src/domain/weather.ts';
import { skyConditions, skyConditionNames } from '../src/domain/alignment.ts';
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
const lens105 = { focalLength: 105, sensor: 'full-frame', aspectRatio: '3:2', orientation: 'portrait' };
const fujiSummit = { type: 'ground', latitude: 35.3606, longitude: 138.7274, height: 0, reference: 'ground', name: '富士山顶' };
const solveExamples = [
  {
    title: '深空天体在山顶上方：仙女座星系在富士山顶正上方，105 mm 竖幅，90 天内暗夜、月亮在地平线下',
    value: { format: SOLVE_FORMAT, version: SOLVE_VERSION_2, name: 'M31 与富士山', lens: lens105,
      targets: [{ ...fujiSummit, frame: { x: 0.5, y: 0.67 } }, { type: 'body', body: 'dso-ngc0224', frame: { x: 0.5, y: 0.52 } }],
      camera: { mode: 'free', maxDistance: 30000 }, time: { mode: 'range', date: '2026-11-13', days: 90 }, timeZone: 'Asia/Tokyo',
      filters: [{ type: 'sky', sky: ['night'] }, { type: 'moonDown' }] },
  },
  {
    title: '钻石富士：太阳落在富士山顶正中，机位不限',
    value: { format: SOLVE_FORMAT, version: SOLVE_VERSION_2, lens: { focalLength: 400, sensor: 'full-frame', aspectRatio: '3:2', orientation: 'landscape' },
      targets: [{ ...fujiSummit, frame: { x: 0.5, y: 0.6 } }, { type: 'body', body: 'sun', frame: { x: 0.5, y: 0.6 } }],
      camera: { mode: 'free', maxDistance: 30000 }, time: { mode: 'range', date: '2027-01-01', days: 90 }, timeZone: 'Asia/Tokyo' },
  },
  {
    title: '月亮落在晴空塔塔尖，塔身占画面约 35%（塔顶加底部）',
    value: { format: SOLVE_FORMAT, version: SOLVE_VERSION_2, lens: { focalLength: 200, sensor: 'full-frame', aspectRatio: '3:2', orientation: 'portrait' },
      targets: [{ type: 'ground', landmark: 'tokyo-skytree', frame: { x: 0.5, y: 0.35 }, base: 0.7 }, { type: 'body', body: 'moon', frame: { x: 0.5, y: 0.35 } }],
      camera: { mode: 'free', maxDistance: 30000 }, time: { mode: 'range', date: '2026-11-13', days: 30 }, timeZone: 'Asia/Tokyo',
      filters: [{ type: 'moonLit', range: [0.9, 1] }] },
  },
  {
    title: '固定机位：月亮从富士山顶右上方经过的时刻（3 年内）',
    value: { format: SOLVE_FORMAT, version: SOLVE_VERSION_2, lens: { focalLength: 200, sensor: 'full-frame', aspectRatio: '3:2', orientation: 'landscape' },
      targets: [{ ...fujiSummit, frame: { x: 0.45, y: 0.6 } }, { type: 'body', body: 'moon', frame: { x: 0.58, y: 0.42 } }],
      camera: { mode: 'fixed', latitude: 35.4172, longitude: 138.8729, heightAboveGround: 1.6 }, time: { mode: 'range', date: '2026-11-13', days: 1096 }, timeZone: 'Asia/Tokyo' },
  },
  {
    title: '两个天体：月亮在昴星团左下方（与机位基本无关）',
    value: { format: SOLVE_FORMAT, version: SOLVE_VERSION_2, lens: { focalLength: 135, sensor: 'full-frame', aspectRatio: '3:2', orientation: 'landscape' },
      targets: [{ type: 'body', body: 'dso-mel022', frame: { x: 0.6, y: 0.4 } }, { type: 'body', body: 'moon', frame: { x: 0.4, y: 0.6 }, tolerance: 0.05 }],
      time: { mode: 'range', date: '2026-11-13', days: 365 }, timeZone: 'Asia/Tokyo' },
  },
].map((example) => {
  const parsed = parseAnySolve(example.value, lensOf(initialPlan));
  if (!parsed.ok) throw new Error(`推算请求示例「${example.title}」无效：${parsed.errors.join('；')}`);
  return { ...example, request: parsed.request };
});
// A version 1 request, to show the conversion.
const v1Example = { format: SOLVE_FORMAT, version: SOLVE_VERSION, kind: 'range', body: 'moon', target: { landmark: 'tokyo-skytree' }, date: '2026-11-12', days: 90, share: 0.3, phase: [0.9, 1] };
const v1Converted = parseAnySolve(v1Example, lensOf(initialPlan));
if (!v1Converted.ok) throw new Error('v1 示例无效');

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
const frameSpot = {
  type: 'object', additionalProperties: false, required: ['x', 'y'], description: '在画面中的位置，自左上角起算的比例；缺省为画面中心',
  properties: { x: { type: 'number', minimum: 0, maximum: 1 }, y: { type: 'number', minimum: 0, maximum: 1 } },
};
const tolerance = { type: 'number', minimum: toleranceLimits[0], maximum: toleranceLimits[1], default: DEFAULT_TOLERANCE, description: '容差：与画面位置相差多少仍算对齐，画面高度的比例' };
const eyeHeight = { ...height, description: '相机离地高度，米；缺省沿用打开者当前值' };
const solveSchema = {
  $schema: DRAFT,
  $id: solveSchemaUrl,
  title: `Tamatamatori 推算请求 v${SOLVE_VERSION_2}`,
  description: `构图约束搜索：画面里的目标与它们的位置、镜头、搜索范围与筛选，由应用在本机搜索拍摄时间或机位。未知字段报错。版本 1 的请求仍可打开（按规则转换）。说明见 ${PUBLIC_SITE}solve-format.md`,
  type: 'object',
  additionalProperties: false,
  required: ['format', 'version', 'targets'],
  properties: {
    $schema: { type: 'string', description: '可写本 schema 的地址，读取时忽略' },
    format: { const: SOLVE_FORMAT },
    version: { const: SOLVE_VERSION_2 },
    name: { type: 'string', maxLength: SOLVE_NAME_LIMIT },
    lens: {
      type: 'object', additionalProperties: false, required: ['focalLength'], description: '画面位置所依据的镜头；缺省沿用打开者当前镜头。给出时打开后改为此镜头',
      properties: {
        focalLength: { type: 'number', minimum: shotLimits.focalLength[0], maximum: shotLimits.focalLength[1], description: '焦距，毫米' },
        sensor: { enum: [...Object.keys(sensors), 'custom'], default: initialPlan.sensor },
        sensorSize: { type: 'object', additionalProperties: false, required: ['width', 'height'], description: '只在 sensor 为 "custom" 时，毫米',
          properties: { width: { type: 'number', minimum: customSensorLimits[0], maximum: customSensorLimits[1] }, height: { type: 'number', minimum: customSensorLimits[0], maximum: customSensorLimits[1] } } },
        aspectRatio: { enum: Object.keys(aspectRatios), default: initialPlan.aspectRatio },
        orientation: { enum: ['landscape', 'portrait'], default: initialPlan.orientation },
      },
    },
    targets: {
      type: 'array', minItems: 1, maxItems: TARGET_LIMIT, description: `画面里的目标，目前最多 ${TARGET_LIMIT} 个：一个地面点加一个天体，或两个天体`,
      items: {
        oneOf: [
          {
            type: 'object', additionalProperties: false, required: ['type'], description: '地面点：已接入地标，或坐标',
            properties: {
              type: { const: 'ground' },
              landmark: { enum: landmarks.map((landmark) => landmark.id) },
              latitude, longitude,
              height: { type: 'number', minimum: seaHeightLimits[0], maximum: Math.max(targetHeightLimits[1], seaHeightLimits[1]), description: `米：reference 为 "ground" 时为高出地面（${range(targetHeightLimits)}，山顶 0，塔顶为塔高；地标缺省为其高度），为 "sea" 时为海拔（${range(seaHeightLimits)}）` },
              reference: { enum: ['ground', 'sea'], default: 'ground', description: 'ground 距地表；sea 海拔（与应用的地形高程同一套数值，基准未核定）' },
              name: targetName,
              frame: frameSpot,
              base: { type: 'number', minimum: 0, maximum: 1, description: '底部（点下方的地面）在画面中的纵坐标，用来定主体大小；只用于 reference 为 "ground" 且高度不低于 10 m，须大于 frame.y' },
              tolerance,
            },
            oneOf: [
              { required: ['landmark'], not: { anyOf: [{ required: ['latitude'] }, { required: ['longitude'] }] } },
              { required: ['latitude', 'longitude'], not: { required: ['landmark'] } },
            ],
          },
          {
            type: 'object', additionalProperties: false, required: ['type', 'body'], description: '天体',
            properties: {
              type: { const: 'body' },
              body: { enum: [...solveBodies], description: '"sun"、"moon"，或固定方向天体："galactic-center"（银心）、亮星 hyg-…、深空目标 dso-…（见格式说明的列表）' },
              frame: frameSpot,
              tolerance,
            },
          },
        ],
      },
    },
    camera: {
      description: '机位的搜索范围；缺省为不限（以地面点为中心，最远 30 km）',
      oneOf: [
        { type: 'object', additionalProperties: false, required: ['mode'], properties: { mode: { const: 'free' }, maxDistance: { enum: [...cameraDistances], default: 30000, description: '离地面点最远，米' }, heightAboveGround: eyeHeight } },
        { type: 'object', additionalProperties: false, required: ['mode', 'latitude', 'longitude', 'radius'], properties: { mode: { const: 'near' }, latitude, longitude, radius: { type: 'number', minimum: nearLimits[0], maximum: nearLimits[1], description: '以该点为中心的半径，米' }, heightAboveGround: eyeHeight } },
        { type: 'object', additionalProperties: false, required: ['mode'], properties: {
          mode: { const: 'fixed' }, latitude, longitude,
          aim: { type: 'object', additionalProperties: false, required: ['azimuth', 'pitch'], description: '同时固定朝向：此时只能有一个天体目标，不能有地面点', properties: { azimuth: { type: 'number' }, pitch: { type: 'number', minimum: shotLimits.pitch[0], maximum: shotLimits.pitch[1] } } },
          heightAboveGround: eyeHeight,
        } },
      ],
    },
    time: {
      description: '时间的搜索范围；缺省为打开者当前日期起 30 天',
      oneOf: [
        { type: 'object', additionalProperties: false, properties: { mode: { const: 'range' }, date: { type: 'string', format: 'date', pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: `当地起始日期（${range(shotLimits.year)} 年）` }, days: { enum: [...dayChoices], default: 30, description: `跨度，天；${dayLabel(1096)}只用于固定机位` } } },
        { type: 'object', additionalProperties: false, required: ['mode', 'instant'], properties: { mode: { const: 'instant' }, instant: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}(:\\d{2})?Z$', description: 'UTC 时刻' } } },
      ],
    },
    timeZone: { type: 'string', description: 'IANA 时区；给出时日期按它解释，拍摄计划改为该固定时区' },
    filters: {
      type: 'array', description: '筛选条件，可为空',
      items: {
        oneOf: [
          { type: 'object', additionalProperties: false, required: ['type', 'sky'], properties: { type: { const: 'sky' }, sky: { type: 'array', minItems: 1, uniqueItems: true, items: { enum: [...skyConditions] }, description: '天空条件（按太阳高度）' } } },
          { type: 'object', additionalProperties: false, required: ['type'], properties: { type: { const: 'moonDown' } }, description: '月亮在地平线下' },
          { type: 'object', additionalProperties: false, required: ['type', 'range'], properties: { type: { const: 'moonLit' }, range: { type: 'array', minItems: 2, maxItems: 2, items: { enum: [...phaseChoices] }, description: '月亮亮面比例 [下限, 上限]' } } },
        ],
      },
    },
  },
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
| \`position.heightAboveGround\` | ${range(shotLimits.heightAboveGround, ' m')}（相机离地面） | ${initialPlan.cameraHeight} |
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

const solveMarkdown = `# Tamatamatori 推算请求格式 v${SOLVE_VERSION_2}

推算请求（\`${SOLVE_FORMAT}\`）描述“画面里要有什么、各在画面哪里”，再给出机位与时间的搜索范围和筛选条件。应用在用户的浏览器中按星历、地形高程与海平面地平搜索拍摄时间或机位，结果由用户试看、挑选后成为普通机位。请求只是意图，链接里的数值不会被当作结果。

- JSON Schema：${solveSchemaUrl}
- 机位格式另见：${PUBLIC_SITE}shot-format.md

## 交给用户的方式

链接：\`${PUBLIC_SITE}#solve=json:\` 后接 URL 编码的 JSON（\`encodeURIComponent\`）。用户打开后先看到预览：镜头、各目标（注明来自地标目录，或“来自请求中的坐标，未核实”）、搜索范围、筛选以及会改动的拍摄计划字段；确认后进入推算模式并开始搜索，可撤销。整段不超过 ${SOLVE_TEXT_LIMIT / 1024} KB。

## 能求出什么

相机保持水平，焦距与画幅由 \`lens\` 给定。剩下机位经纬度、时刻、相机方位与俯仰五个量，每个“目标在画面某处”用掉两个。

| 目标与范围 | 结果 |
| --- | --- |
| 一个地面点 + 一个天体，机位不限或在某点周围 | 机位线：每个时刻一处机位 |
| 同上，时刻固定 | 机位点 |
| 一个地面点 + 一个天体，机位固定 | 天体经过画面位置的时刻（按容差） |
| 一个天体，机位与朝向都固定 | 天体落到画面位置的时刻 |
| 两个天体 | 两者到达设定相对位置的时刻；与机位基本无关 |
| 只有一个目标（朝向不固定）、两个地面点、三个以上目标、机位与时刻都固定 | 不搜索，报出原因 |

## 顶层字段

| 字段 | 取值 | 缺省 |
| --- | --- | --- |
| \`format\` / \`version\` | \`"${SOLVE_FORMAT}"\` / \`${SOLVE_VERSION_2}\` | 必填；更高版本拒绝读取；\`1\` 按下文转换 |
| \`name\` | 文本，最多 ${SOLVE_NAME_LIMIT} 字 | 空 |
| \`lens\` | \`{ "focalLength", "sensor", "sensorSize", "aspectRatio", "orientation" }\`：焦距 ${range(shotLimits.focalLength, ' mm')}；传感器 ${[...Object.keys(sensors), 'custom'].map((id) => `\`"${id}"\``).join(' / ')}；画幅 ${Object.keys(aspectRatios).map((id) => `\`"${id}"\``).join(' / ')}；\`"landscape"\` 横幅 / \`"portrait"\` 竖幅 | 沿用打开者当前镜头 |
| \`targets\` | 1—${TARGET_LIMIT} 个目标，见下 | 必填 |
| \`camera\` | 机位的搜索范围，见下 | 不限，最远 30 km |
| \`time\` | 时间的搜索范围，见下 | 打开者当前日期起 30 天 |
| \`timeZone\` | IANA 时区；给出时按它解释日期，并改为该固定时区 | 沿用打开者当前时区 |
| \`filters\` | 筛选条件数组，见下 | 无 |

## 目标

所有目标都有 \`frame\`（\`{ "x", "y" }\`，自画面左上角起算的比例，缺省为中心）与 \`tolerance\`（画面高度的比例，${range(toleranceLimits)}，缺省 ${DEFAULT_TOLERANCE}）。

| \`type\` | 字段 | 说明 |
| --- | --- | --- |
| \`"ground"\` 地面点 | \`landmark\`（已接入地标 id），或 \`latitude\` 与 \`longitude\`；\`name\` | 坐标目标标为“未核实”，须在地图上确认 |
| | \`height\` 与 \`reference\` | \`"ground"\`（缺省）：高出地面的米数（${range(targetHeightLimits)}），山顶为 0，塔顶为塔高；地标缺省为其高度。\`"sea"\`：海拔（${range(seaHeightLimits)}），与应用的地形高程同一套数值，基准未核定 |
| | \`base\` | 可选：点下方地面在画面中的纵坐标（大于 \`frame.y\`），用来定主体大小；只用于 \`"ground"\` 且高度不低于 10 m |
| \`"body"\` 天体 | \`body\` | \`"sun"\` / \`"moon"\`，或下面“固定方向天体”中的 id |

## 搜索范围

| \`camera.mode\` | 字段 | 说明 |
| --- | --- | --- |
| \`"free"\` | \`maxDistance\`：${list([...cameraDistances])} 米 | 以地面点为中心 |
| \`"near"\` | \`latitude\`、\`longitude\`、\`radius\`（${range(nearLimits)} 米） | 只列这个范围内的机位 |
| \`"fixed"\` | \`latitude\`、\`longitude\`（缺省为打开者当前机位）、\`aim\`（\`{ "azimuth", "pitch" }\`，可选） | 给出 \`aim\` 时同时固定朝向，只能有一个天体目标 |

三种机位都可带 \`heightAboveGround\`（${range(shotLimits.heightAboveGround, ' m')}），打开后改为该离地高度。

| \`time.mode\` | 字段 |
| --- | --- |
| \`"range"\` | \`date\`（当地起始日期，缺省为打开者当前拍摄日期）、\`days\`：${list([...dayChoices])}；机位不固定时最多 ${MAX_LINE_DAYS} 天 |
| \`"instant"\` | \`instant\`：UTC 时刻，例如 \`"2026-11-25T08:10:00Z"\` |

## 筛选

| \`type\` | 字段 | 说明 |
| --- | --- | --- |
| \`"sky"\` | \`sky\`：非空数组，${skyConditions.map((sky) => `\`"${sky}"\` ${skyConditionNames[sky]}`).join('、')} | 按太阳高度 |
| \`"moonDown"\` | — | 月亮在地平线下；目标里有月亮时报错 |
| \`"moonLit"\` | \`range\`：\`[下限, 上限]\`，取 ${list([...phaseChoices])} | 月亮亮面比例 |

## 固定方向天体

银心、有中文名的亮星与已收录的深空目标，方向相对恒星固定（J2000 坐标经岁差与章动换算）。它们没有日月那样的视直径，画面中按“标记直径”画出；只在太阳中心低于地平线 ${-DARK_SUN_ELEVATION}° 时搜索。

| id | 名称 | 类型 | 标记直径 |
| --- | --- | --- | --- |
${fixedBodies.map((body) => `| \`${body.id}\` | ${body.name} | ${{ core: '银心', star: '亮星', deepSky: '深空目标' }[body.kind]} | ${(2 * body.radius).toFixed(1)}° |`).join('\n')}

## 已接入地标

| id | 名称 | 纬度 | 经度 | 高度 m |
| --- | --- | --- | --- | --- |
${landmarks.map((landmark) => `| \`${landmark.id}\` | ${landmark.name} | ${landmark.latitude.toFixed(5)} | ${landmark.longitude.toFixed(5)} | ${landmark.bounds.height} |`).join('\n')}

其他目标请给坐标。应用不解析地名；不确定坐标时请让用户在应用中放置目标，不要猜测。

## 版本 1

\`"version": 1\` 的请求（\`kind\` 为 \`"time"\` / \`"position"\` / \`"range"\`）仍可打开，读入时转换：

- \`"time"\`：机位固定（\`camera\` 或打开者当前机位），朝向固定为 \`mark\`，天体在画面中心；\`tolerance\`（视直径）按打开者镜头换成画面高度的比例。
- \`"position"\`：地面点与天体在同一画面位置（\`frame\`，缺省中心），机位不限，时间为 \`date\` 当天。
- \`"range"\`：同上，跨度为 \`days\`；\`share\` 换成底部位置 \`base = frame.y + share\`（目标不足 10 m 时不设）。原来“±20%”的主体占比改为底部位置的容差。
- \`phase\` 换成 \`moonLit\`，\`sky\` 换成 \`sky\` 筛选。

例：

\`\`\`json
${JSON.stringify(v1Example, null, 2)}
\`\`\`

读入后等同于：

\`\`\`json
${solveJson2(v1Converted.request)}
\`\`\`

## 规则与限制

- 未知字段、组合不支持与越界取值报错并带字段路径（如 \`targets[1].frame.x\`）；缺省项在预览中列出。
- 打开时：给出 \`lens\` 则改为该镜头；固定机位移到该机位（给出 \`aim\` 时转向）；\`"instant"\` 移到该时刻；只搜一天时把拍摄日期移到 \`date\`；其他字段不改。
- 天体位置按海平面地平与所选折射；遮挡只看地形起伏，视线被地形挡住的机位不列出；不含建筑与树木；不含天气。结果是构图模拟，不保证实景可见。
- 推算面板的“复制推算请求”给出同样的链接，“复制结果”给出 Markdown 表格，可交回 AI 挑选。

## 示例

${solveExamples.map((example) => `### ${example.title}

\`\`\`json
${solveJson2(example.request, solveSchemaUrl)}
\`\`\`

\`\`\`text
${solveLink2(example.request, PUBLIC_SITE)}
\`\`\`
`).join('\n')}`;

const llms = `# Tamatamatori

> 摄影规划 Web App：在地图上确定机位与拍摄方向，调整时间和镜头参数，在预览中评估地面、天空与日月星辰的构图。计算全部在用户的浏览器中完成，没有后端或 API。

AI 可以用两种链接把结果交给用户，用户打开后先看到预览，确认才应用：

- 机位链接 \`${PUBLIC_SITE}#shot=json:<URL 编码的机位 JSON>\`：一个完整的拍摄计划。
- 推算请求链接 \`${PUBLIC_SITE}#solve=json:<URL 编码的推算请求 JSON>\`：说明画面里要有什么、各在画面哪里（例如仙女座星系在富士山顶正上方、月亮落在塔尖），让应用搜索拍摄时间或机位。

写之前请读对应格式说明；字段错误会被逐条指出，可据此修正。地点请给坐标或已接入地标的 id，不要猜测坐标。预览与推算都是基于地理和天文数据的构图模拟，不代表实景一定可见。

## 格式

- [机位格式 v${SHOT_VERSION}](${PUBLIC_SITE}shot-format.md)：字段、取值范围、默认值与示例
- [推算请求格式 v${SOLVE_VERSION_2}](${PUBLIC_SITE}solve-format.md)：目标与画面位置、镜头、搜索范围与筛选，已接入地标列表，版本 1 的转换
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
