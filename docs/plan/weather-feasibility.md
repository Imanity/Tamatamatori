# 天气与云雨渲染可行性评估

核查于 2026-11-07。本轮完成资料评估与公开接口探测，方案处于候选状态。

## 结论

支持按拍摄地点与时间读取天气，并驱动预览中的云层、天体透过率、远景能见度与降水示意，在现有 React、MapLibre 和共享天体渲染结构中可行。首步候选为 Open-Meteo，默认读取未来七天，重点验证未来 48 小时。更远时效可扩展到最多 16 个日历天，界面需要分别表达预报范围与使用时效。

点位云量给出覆盖比例。要进一步判断某个拍摄方向上的云带，需要周边空间云场、高度和透光属性。预览可以先显示受预报约束的云层示意，具体云块位置与形状仍属于显示模型。下文的渲染建议属于工程推演。

## 数据类型与用途

| 数据 | 适合的用途 | 接入预览还需要的信息 |
| --- | --- | --- |
| 点位逐小时预报 | 选择拍摄窗口、驱动总云量和降水效果 | 层级云量、高度、透明度与空间结构的显示假设 |
| 数值模式空间云场 | 地图区云雨覆盖、按方位估计云带 | 网格注册、云底/云顶或垂直廓线、层间重叠与光学映射 |
| 卫星云图 | 核对近期云系位置与变化 | 对应通道、时间、投影、云高，以及从俯视图到地面视角的转换 |
| 雷达降水图 | 查看附近降水范围和移动趋势 | 覆盖范围、观测延迟、降水强度和所选时刻的有效性 |

Open-Meteo 将云量定义为区域覆盖比例，低中高层分别提供数值。不同供应商的分层高度定义也有差异，后续适配应保留来源定义。Meteomatics 提供云底高度等更多字段，可作为空间云层阶段的补充候选。[Open-Meteo 字段](https://open-meteo.com/en/docs)、[Meteomatics 云参数](https://www.meteomatics.com/en/api/available-parameters/weather-parameter/clouds/)

## API 候选

| 服务 | 可用数据与预报时效 | 接入条件 | 评估 |
| --- | --- | --- | --- |
| Open-Meteo Forecast | 总云量、低中高云量、降水量/概率、能见度和风，逐小时，最多 16 个日历天 | 非商业免费接口免密钥，支持 CORS。商业使用订阅客户接口 | 首步优先候选，适合现有静态部署。周边云场可用多坐标查询，调用成本随变量、时段与点数增加。来源见下文 |
| meteoblue Forecast / Maps | Clouds 套餐约七天，Trend 约十四天。另有预报瓦片、卫星与雷达产品 | API key，免费方案的时步和用途受限，所需套餐与再渲染权利待确认 | 适合需要更完整云参数、地图图层或多模型信息时进一步试用。预报数据与地图权限分别核实。[套餐](https://content.meteoblue.com/en/content/view/full/4392)、[免费方案](https://content.meteoblue.com/en/access-options/weather-apis/free-weather-api)、[技术概览](https://docs.meteoblue.com/en/weather-apis/forecast-api/overview) |
| 和风天气 QWeather | 新逐小时接口全球最多 240 小时，含总云量、雨雪、概率、能见度。中国分钟降水覆盖未来两小时、五分钟一步 | 认证、计费与套餐权限需要账号核验 | 可作中国用户的对照候选。公开逐小时字段以总云量为主，低中高分层能力需另行确认。官方标注的 1 km 为数据产品分辨率，实际预报表现仍需当地回测。[逐小时 v1](https://dev.qweather.com/en/docs/api/weather/weather-hourly-forecast/)、[分钟降水](https://dev.qweather.com/docs/api/minutely/minutely-precipitation/) |
| Meteomatics | 分层云量、云底、对流云顶等字段，支持区域查询。可用时效取决于所选模式与字段 | 商业授权、账号及具体参数权限待试用 | 空间云场的后续候选，现阶段未核验完整套餐、价格与各字段最长时效。[云参数](https://www.meteomatics.com/en/api/available-parameters/weather-parameter/clouds/) |
| RainViewer 公共 API | 最近两小时雷达历史，十分钟一步 | 个人和教育等用途，署名、限流与覆盖限制 | 可作近期降水地图候选。2026 年 1 月已停供未来雷达帧和卫星红外图。[地图接口](https://www.rainviewer.com/api/weather-maps-api.html)、[迁移公告](https://www.rainviewer.com/api/transition-faq.html) |

Open-Meteo 的免费服务限制为每分钟 600、每小时 5,000、每天 10,000 次，定价页另列每月 300,000 次。服务使用条件与数据 CC BY 4.0 许可分别处理，付费访问需要客户密钥。现阶段的非商业评估与静态直连路径较匹配。[服务条款](https://open-meteo.com/en/terms)、[定价](https://open-meteo.com/en/pricing)、[官方项目与 CORS 说明](https://github.com/open-meteo/open-meteo)

两个容易混淆的版本边界需要保留。

- QWeather 新版 `GET /weather/v1/hourly/{latitude}/{longitude}` 提供最多 240 小时，旧 `/v7/weather/{hours}` 为最多 168 小时且已标记将弃用。旧接口资料中的七天限制不能直接套到新版。[新版](https://dev.qweather.com/en/docs/api/weather/weather-hourly-forecast/)、[旧版](https://dev.qweather.com/en/docs/api/weather/weather-hourly-forecast-webapi-v7/)
- meteoblue 的公开 Radar and Satellite Tile API 将全球卫星和全球降水标为无预报，欧洲雷达提供两小时、美国雷达一小时预报。该接口还说明实际覆盖与其网站/App 有差异，最大 zoom 为 6。产品介绍中的两小时能力应按具体地区和接口确认。[雷达与卫星瓦片](https://docs.meteoblue.com/en/weather-apis/maps-api/radar-and-satellite-tile-api)

## 预报范围与准确度

API 可返回的最大天数、原始模式分辨率、插值后的显示时步与实际预报准确度需要分别展示。预报误差随时效增加，地区、季节、云型和地形也影响结果。供应商公开参数不足以推导本应用的统一准确率百分比。[ECMWF 不确定性](https://www.ecmwf.int/en/research/modelling-and-prediction/quantifying-forecast-uncertainty)、[AMS 可预报性说明](https://www.ametsoc.org/ams/about-ams/ams-statements/statements-of-the-ams-in-force/weather-analysis-and-forecasting2/)

建议采用以下产品分级，阈值在实施后的回测中修订。

| 拍摄时效 | 使用方式 | 需要的反馈 |
| --- | --- | --- |
| 当前至两小时 | 有当地雷达/卫星与短临产品时用于现场判断 | 标明观测时间、延迟、覆盖与预测帧范围 |
| 未来 0—48 小时 | 首步天气预览的重点范围 | 云层与能见度示意，允许与临近资料对照 |
| 第三至七天 | 比较出行日期与拍摄窗口 | 展示变化趋势和模型分歧 |
| 第八至十六天 | 行程趋势参考 | 突出较长时效及实际数据来源变化 |

日本场景值得单独验证。Open-Meteo 文档列出的 JMA MSM 约 5 km、逐小时、四天，气压层约 11 km、三小时一步。JMA GSM 约 55 km、六小时原生数据，接口插值到逐小时，最长十一天。通用 best_match 可以在短时区域模式之后衔接全球模式，因此完整十六天序列中各时段的分辨率可能不同。[JMA 接口](https://open-meteo.com/en/docs/jma-api)、[混合模式选择](https://open-meteo.com/en/docs)

准确度验收建议在山中湖、城市、沿海与内陆等固定机位保存真实起报批次，按 6、24、48、72 小时及七天分组回测。云量检查平均绝对误差、晴空窗口命中和漏报，降水概率检查 Brier 分数与雨段命中。相应时刻的卫星云产品、地面记录和当地照片分别作为参照。模型间一致性可作为分歧提示，经回测定标后再考虑数值置信度。

## 公开接口探测

在现有开发环境以山中湖固定场景 `35.4172, 138.8729` 探测 Open-Meteo，两次 GET 使用相同参数，第二次带 Pages 域名的 Origin。

```text
https://api.open-meteo.com/v1/forecast
?latitude=35.4172&longitude=138.8729
&hourly=cloud_cover,cloud_cover_low,cloud_cover_mid,cloud_cover_high,precipitation,precipitation_probability,rain,snowfall,visibility,wind_speed_10m,wind_direction_10m
&forecast_days=16&timezone=GMT
```

- HTTP 200，响应 Date 为 `2026-11-06 18:57:07 GMT`。首次响应的十一项气象字段均为 384 个小时槽位，所选字段无缺值。
- 有效时间为 UTC `2026-11-06T00:00` 至 `2026-11-21T23:00`，包含当天零时以来的槽位。产品需要从有效时间判断可用范围。
- 返回格点中心为 `35.4, 138.875`，返回高程 982 m。保存原请求机位与来源格点中心，有助于解释山地偏差。
- 带 `Origin: https://imanity.github.io` 的请求返回 `Access-Control-Allow-Origin: *`，当前静态站点可直接读取该接口。
- 一次十一变量、十六天请求的响应计费权重约为 `1.2571429`。预算需要依据供应商计数方式估算。

以上结果验证字段、时段和 CORS 接入。真实云雨精度、浏览器内天气效果和性能仍待对应阶段验证。

## 预览渲染建议

### 首步闭环

1. 增加默认关闭的天气效果开关，在右侧信息分组展示逐小时云量、降水和有效时刻。
2. 按机位读取有限时间段，默认七天。先用低中高云量形成连续云层示意，云图案固定于场景坐标并随时间连续变化，拖视角时保持稳定。
3. 白天按云量调整直射/漫射观感，夜间云层与现有月光、光污染模型共同决定亮度。云量控制覆盖，云的光学厚度单独采用明确的显示近似，避免将覆盖百分比直接等同于透射率。
4. 云层和天体共享方向采样，让日月、恒星、银河、深空经过一致的云透过率。现有 DEM 遮挡独立保留。可见度用于远景衰减，需要与地形深度配合。
5. 降水类型和强度可驱动轻量粒子。每小时累计量和概率保留各自含义，具体时刻的粒子密度属于时间平均场景近似。

现有 `TerrainScene` 的环境同步、`environmentForSky` 的天空配色与 `StarfieldLayer` 的天体显示提供接入点。更精细云层需要 WebGL 自定义绘制并验证深度和混合顺序，地图侧的气象瓦片可单独叠加。两个视图共享天气时间与数据版本。

### 后续空间云场

若首步需要进一步解决“山峰后是否有云带”“太阳所在方向是否有云”，再读取机位周边的多点/网格云场和高度数据，按云层高度与视线交点采样。卫星图辅助约束近期水平结构，风场辅助短时连续动画。远方低仰角涉及更大采样范围，格网、传输、缓存和 GPU 预算需要实测后确定。光学厚度、精细轮廓和云层演变仍保留模式与显示假设。

## 更新与架构边界

- UTC 拍摄时刻作为唯一采样基准，显示时区只作用于界面。按有效时间判断数据是否适用于所选日期。
- 首步建议缓存 30 分钟，返回页面后检查缓存年龄和可用范围。该值为客户端策略，上游模式发布按自身频率执行。读取整段小时序列后，拖动时间轴、焦距和方向可以本地更新。
- 机位变化去抖并取消旧请求。空间云场阶段按真实来源格网复用缓存，保留原机位与返回格点差异。
- 区分数据加载、失败、缺测、过期和超出预报范围。保留上一有效画面时标明旧时刻，未知天气状态单独表达。
- 保存供应商、模型选择、变量、有效时段、抓取时刻和请求版本。普通混合接口对具体起报批次的可追溯性需另行核实，`generationtime_ms` 表示处理耗时。需要批次回测时采用可追溯的预报档案。
- 云量在合适的相邻时间点连续插值，降水按所属累计区间处理。Open-Meteo 将降水量定义为前一小时累计，概率也对应前一小时事件。[时间字段定义](https://open-meteo.com/en/docs)
- Open-Meteo 免费接口支持现有 Pages 直连。付费候选先核实可公开的域名受限访问方式、再渲染与缓存授权。需要保密认证的方案再评估最小代理边界。
- 来源、模型说明和许可集中加入 About。新天气资料与现有 2015 历史光污染图集分别标注来源时间，二者叠加的亮度保持显示近似。

## 建议的下一小步

先验证 Open-Meteo 七天小时序列的时间与更新生命周期，再接入低中高云层示意和共享天体透过率，以未来 48 小时作为主要验收范围。固定晴天、多云、阴天、雨天和缺数据场景，分别完成数值、状态、桌面/手机真实 GPU 画面检查。地图卫星/雷达与空间云场在该闭环后独立推进。
