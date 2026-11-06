# 天气首步

更新于 2026-11-07。用户已授权按[天气评估](weather-feasibility.md)接入 Open-Meteo。实施范围为七天逐小时天气、分层云示意、降水示意与日月星空遮蔽，重点验收未来 48 小时。

## 范围与反馈

- 在预览显示设置增加默认关闭的天气开关。全局信息显示总云量、低中高云量、每小时降水与概率、能见度、有效时刻和抓取时间。
- 点位云量约束程序云层的覆盖，连续图案固定于拍摄方向，随拍摄时刻连续变化。云块位置、透光程度、颜色与降水粒子属于显示近似。
- 所有天空图层经过同一云层合成，地形深度保护山体与水岸。来源数据读取失败单独反馈，关闭后恢复现有天空效果。
- 数据请求使用 UTC，保存返回格点和有效范围。计划超出范围时提示可用时段，由用户主动切换到当前时间。
- 卫星/雷达地图和周边空间云场留待后续独立推进。首步沿用 GitHub Pages 直连，无密钥免费接口仅限非商业用途，CC BY 4.0 署名集中于 About。
- 按供应商许可要求，在全局天气读数旁保留 Open-Meteo 来源链接，完整作者与许可说明集中于 About。

## 数据生命周期

按机位获取七天序列，缓存 30 分钟，最多保留四处机位。时间、焦距、方向和时区变化复用有效缓存。机位变化去抖，取消旧请求，迟到响应不覆盖新机位。开启、回到页面和一分钟检查点核对缓存年龄，过期数据暂停应用并尝试刷新。

云量和能见度在相邻整点插值，降水量/概率按前一小时累计区间取值。缺值、超范围、过期和请求失败分别反馈。上游起报轮次在普通混合接口中未知，抓取时间与上游发布时间分别表达。

## 验收

检查解析、UTC 边界、连续量插值与降水区间、缺值和缓存更新。组件检查开关、位置取消、失效/重试、时间复用和超范围。云层方向、透明度、DEM 遮挡、开关恢复、昼夜/月光/光污染、降水和手机画面通过 Chrome 实际 GPU 验证。程序云与气象实景预测精度分别记录。

资料采用[Open-Meteo 文档](https://open-meteo.com/en/docs)、[服务条款](https://open-meteo.com/en/terms)与[数据许可](https://open-meteo.com/en/licence)。

## 执行记录

2026-11-07 完成本地接入验收。天气开关位于构图线与光污染按钮旁，默认关闭。有效天气参与天空合成、地表直射观感与地平线雾混合，日月、恒星、银河、星座、深空和空间站符号经过同一云层。云层以摄影射线绘制到天空深度，降水绘制到前景，两者均不写入主深度。

### 数值与生命周期

`npm test` 共 209 项通过，`npm run build -- --base /Tamatamatori/` 通过，保留既有 MapLibre 大包体积提示。

- 检查 UTC 时区等价、整点与跨日边界、前一小时降水区间、连续云量和能见度插值、跨北风向，以及缺测与真实零值的区别。拒绝单位错误、乱序、越界值和异常结构。
- 请求固定七天、UTC Unix 时刻与 m/s 风速。最多四处机位缓存，半小时到期后更新，取消后的迟到请求不写入缓存。组件检查覆盖关闭、机位切换、失败重试、缺测、超范围和页面返回时的过期刷新。
- 天气变化与镜头、方向和时间调整复用机位序列，组件检查确认未额外获取 DEM 或重建地图。云遮蔽导致星点隐藏时，右栏与搜索使用“云层遮蔽”，天空背景过亮继续按既有模型表达。
- GL 替身检查云层采用天空深度、降水关闭深度检测且不写深度，以及宿主状态和程序资源释放。该层检查与真实 GPU 画面分别执行。

独立公开请求返回 168 个小时槽位，UTC 有效范围为 `2026-11-06T00:00` 至 `2026-11-12T23:00`。原始响应保存在[公开接口快照](weather-evidence/live-forecast.json)，其抓取时间、校验值和请求参数见[验证元数据](weather-evidence/verification.json)。此快照来自独立接口探测，浏览器使用自己的真实请求，普通混合接口未提供起报轮次。

### Chrome 画面

保存[22 组 DOM 与截图记录](weather-evidence/browser-results.json)、27 张 PNG。桌面为 1440×900，手机为 390×844 和 360×640，使用真实 Chrome/WebGL、Mapterhorn DEM 与已接入天体。02 为面板交换后的加载过渡，18 为 About 遮盖画面，二者分别用于状态与来源检查。

- [超范围](weather-evidence/01-live-outside.png)没有改变拍摄时刻，提供“使用当前时间”。主动切换后的[真实天气](weather-evidence/03-live-current-ready.png)读取到低中高云量、降水与能见度，画布就绪。
- 11/09 09:00 东京时区的实际预报为总云量 68%、降水 2.3 mm/小时。[开启](weather-evidence/04-live-rain.png)、[关闭](weather-evidence/05-rain-weather-off.png)与[恢复](weather-evidence/06-rain-restored.png)保留拍摄姿态，山体与水面受到地形深度保护。开启与恢复的取景平均绝对差约为 0.249/通道，未记作逐像素相等。
- 11/10 21:00 低云量 100% 的[阴夜](weather-evidence/08-overcast-night.png)中可见星名为 0，[关闭天气](weather-evidence/09-night-weather-off.png)后为 9，仙女座星系和银河结构恢复。另核对[光污染叠加](weather-evidence/10-clouds-with-light-pollution.png)。这些是预报驱动的显示结果。
- 最终构建复验[夜景](weather-evidence/13-final-overcast-night.png)、[云雨](weather-evidence/14-final-rain.png)与[视角调整](weather-evidence/15-final-view-turn.png)。仙女座星系的右侧读数实际显示“云层遮蔽 · 显示近似”，地形未遮挡与云层显示影响分别表达。
- 手机核对[预览](weather-evidence/16-final-mobile-preview.png)、[天气信息](weather-evidence/17-final-mobile-readout.png)、[About](weather-evidence/18-weather-about.png)及[小屏](weather-evidence/19-small-mobile.png)。360 px 宽时三个预览按钮均处于面板内部。完整许可在 About，天气读数保留供应商要求的来源链接。
- 500 mm 入画核对[太阳有云](weather-evidence/20-sun-clouds.png)与[关闭](weather-evidence/21-sun-weather-off.png)，以及[月亮有云](weather-evidence/22-moon-clouds.png)与[关闭](weather-evidence/23-moon-weather-off.png)。日月圆盘经过同一天空云层，右栏分别显示约 0% 与 1% 的模型透过率。月亮场景亮面为 8%，属于低月相对照。

01—02 的模块为 `index-DAc1zJ7i.js`，03—12 为 `index-B2161DD2.js`。最终复验 13—23 使用 `index-CRu2ydH1.js`、`index-rWz4kx0n.css` 与 `celestial-layer-BZWArtNq.js`，校验值保存在验证元数据。两次 Chrome 会话的[错误日志](weather-evidence/browser-console.json)与[日月错误日志](weather-evidence/body-console.json)均为空。

局部截图接口出现过超时，07 未形成记录。后续采用文档支持的页面截图接口，保存了有效画面。日期与时间的浏览器填值需补原生方向键提交，记录以右栏实际采样时刻核对。

### 显示与精度边界

点位小时预报约束天空背景云层的覆盖，云形、分布、层间重叠、透光和配色属于显示模型。云层位于地形后方，地平线雾混合按能见度作显示映射，实际距离定标待后续验证。雨雪采用小时平均强度与近地风的静态构图示意，随拍摄时刻更新，具体云层平移采用独立的连续显示模型。

现有记录验证数据接入、交互、合成与显示一致性。不同地区和时效的云雨预测准确率仍需按评估文档进行实景回测。卫星/雷达地图与空间云场属于后续独立目标。

## 高处远云条带修正

2026-11-07 根据用户截图复现 `39.8206°N, 141.5275°E`、方位 46.4°、35 mm、东京时区 06:29 的近地平线云层问题。首版用 `max(0.12, ray.z)` 限制投影距离，仰角低于约 6.9° 后纹理竖直变化停住，形成柱状条带。

修正采用有界且连续的远云投影，低仰角的细节平滑收敛至分层云量的平均覆盖。CPU 标记与 GPU 着色器共用地平线过渡参数，图案变化与透过率同步。高处机位数学水平线以下的可见天空延续平均覆盖，地面继续按实际 DEM 深度裁切。

`npm test` 共 210 项通过，子路径构建通过。新增回归覆盖各方位的地平线平均覆盖、水平线及原限幅角度两侧的连续性、远云条带抑制和较高仰角的结构保留。此项为显示模型检查，实际 GPU 另行核对。

- Chrome [修正前](weather-horizon-evidence/01-before-high-view.jpg)与[修正后](weather-horizon-evidence/02-after-high-view.jpg)使用相同机位、4° 俯仰、35 mm 与拍摄时刻。当前 DEM 高程约 941.6 m，离地 1.6 m。两次真实天气请求均显示总云量 55%、低云 55%、中云 18%、高云 0%，降水 0.1 mm/小时。原先贴地的竖状云柱消除，地面遮挡保留。
- 核对[水平视角](weather-horizon-evidence/03-after-level-view.jpg)、[8 mm 广角](weather-horizon-evidence/05-after-ultrawide.jpg)与[低角度太阳](weather-horizon-evidence/06-low-sun.jpg)。太阳视高度约 2.98°，右栏云层透过约 44%，与云层合成同时更新。[1000 mm](weather-horizon-evidence/04-after-telephoto.jpg)中远云连续，截图仍含 DEM 细化提示，仅用作云层投影检查。
- 390×844 的[手机预览](weather-horizon-evidence/07-mobile-after.jpg)与[关闭天气](weather-horizon-evidence/08-mobile-weather-off.jpg)分别核对。首次手机采集时预览面板隐藏，切换到预览后重新采集，有效记录保留非零画布尺寸。

共保存[8 组 DOM 与截图记录](weather-horizon-evidence/browser-results.json)。修正前使用 `index-CRu2ydH1.js`，修正后使用 `index-CTRBXZWS.js`、`index-rWz4kx0n.css` 与 `celestial-layer-DPMn2vmA.js`。[错误日志](weather-horizon-evidence/browser-console.json)为空，资源及证据校验值见[验证元数据](weather-horizon-evidence/verification.json)。远云平均覆盖仍是点位预报驱动的显示近似。
