# 地标精细模型的数据源与体积评估

2026-11-07。按用户要求只评估数据源、可覆盖数量及体积，尚未接入精模。当前普通建筑仍以[五公里远景](building-distance.md)为准。本轮读取公开目录、模型元数据和两个有界 B3DM 样本，原始二进制仅放在忽略的 `.cache/landmark-assessment/`，没有加入应用资源、增加依赖、提交或推送。

## 结论与建议

可以支持，适合按地标精选单体、离线转换并按需加载。摄影规划优先保证外轮廓、塔架透空、尺度和地理锚点；照片纹理可后置。建议先验收 **1 个地标**，再扩为 **10–30 个精选地标**。这两个数量是实施建议，不是现成合格资源的统计。

来源优先级：日本目标先核查 PLATEAU 的具体单体；不足以表现塔架时，再选作者来源明确的 CC0 / CC BY 社区模型。整城模型与商业照片瓦片不直接作为仓库中的地标精模库。

本轮实际核查 **4 处地标、8 份社区模型**，其中 **1 份因作者注明基于 Google Maps 数据而排除，7 份仍待准入，0 份完成几何、来源、定位和画面的全套验收**。不能把页面可下载、标签 CC BY 或模型面数多解释为已具备实景精度。

## 数据源比较

| 来源 | 数量的正确口径 | 数据形态与体积 | 本项目判断 |
| --- | --- | --- | --- |
| 日本 PLATEAU | 本轮目录统计建筑 LOD3 共 45 条、24 个地区代码；含有/无纹理版本，也含不同 LOD 的回退几何，不是 45 座精细地标 | CityGML、3D Tiles；本文东京两区的 LOD3 源包标称约 61–352 MiB，单体需定位/提取。坐标和属性较完整 | 日本目标的优先核查源，必须验证目标实际 LOD；目录和配信服务是试验性服务。[目录说明](https://docs.plateauview.mlit.go.jp/datasets/3d-tiles/)、[实时目录 API](https://api.plateauview.mlit.go.jp/datacatalog/plateau-datasets) |
| Sketchfab 上明确 CC0 / CC BY 的作者模型 | 全球、逐份发布，没有可直接采用的权威“精细地标总数”。本轮定点核查见下表，不用全站模型数量充当地标数量 | 可下载 glTF/GLB 等；元数据可公开读取，下载 API 要求用户认证，下载档案的实际字节数在授权下载响应中提供 | 适合精选单体后同源静态分发。逐份核查制作来源、许可、单位和结构；不用预览资源绕过下载流程。[下载 API](https://sketchfab.com/developers/download-api)、[下载流程](https://sketchfab.com/developers/download-api/downloading-models) |
| Open Heritage 3D / CyArk | 官方称数百个遗产数据集；一个遗址可有多份扫描，不能当作同等数量的可用单体 GLB | 以点云、摄影测量等原始资料为主，FAQ 给出的平均每遗址下载约 25 GB，需转换、去场景与减面 | 适合之后选个别历史建筑做专项，不适合整批进入当前静态仓库。许可逐项不同，部分限制商业用途。[官方介绍](https://www.cyark.org/whatwedo/openaccess/)、[FAQ](https://www.openheritage3d.org/faq) |
| Fab Standard 等商业模型 | 依具体商品，无统一合格地标数量；本轮未采购 | 单独购买、格式和大小依商品 | Fab Standard 允许项目使用，但限制独立再分发；不能把购买许可自动解释成允许公开仓库发布可直接下载的原始模型。Fab 中明确 CC BY 的项目另按 CC 许可核查。[官方许可](https://www.fab.com/eula) |
| Google Photorealistic 3D Tiles | 按覆盖地区配信，不提供可自由再分发的单地标库存统计 | 需要启用账单与凭据，按服务加载三维瓦片 | 不作为本轮可落仓库的精模来源。官方限制服务外提取、存储和再分发；也不从其瓦片中拆塔另存 GLB。[使用政策](https://developers.google.com/maps/documentation/tile/policies)、[接入与计费](https://developers.google.com/maps/documentation/tile/usage-and-billing) |

PLATEAU 当前政策默认采用 PDL1.0 并允许按兼容的 CC BY 条件使用，要求来源和加工说明。本次港区、墨田区的 G 空间目录 API 均将许可指向该政策；个别资源附注和第三方权利仍需随选中的模型保留。社区 CC BY 4.0 要求署名、许可链接和修改说明；作者的标签不替代对上游资料的核查。[PLATEAU 政策](https://www.mlit.go.jp/plateau/site-policy/)、[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)

## PLATEAU 的数量、体积与塔址抽样

读取 9,746,073 字节的目录响应（共 7,776 个各类条目），按 `type_en=bldg`、`format=3D Tiles`、`lod=3` 筛选：

- 24 个带纹理条目，目录体积合计约 3.47 GiB；21 个无纹理条目，合计约 1.20 GiB。
- 两组覆盖合计 24 个不同地区代码；纹理版本和层级存在几何重复，不能相加作为地标数或独立建筑数。
- 没有逐栋遍历全国文件，因此**目前不能给出可用精细地标的全国栋数**。目录中的 LOD3 标记也不保证整个地区的所有单体都是 LOD3。

以下 `file_size` 是 API 提供的源包/CMS 资产大小，**未下载整个地区包**，不是 `tileset.json` 响应大小或塔本身大小：

| 2025 年度目录 | 无纹理标称体积 | 带纹理标称体积 |
| --- | ---: | ---: |
| 东京港区 LOD3 | 60.96 MiB | 352.13 MiB |
| 东京墨田区 LOD3 | 68.40 MiB | 104.18 MiB |

从两份无纹理 tileset 定位塔址，下载各一个最多 8 MiB 的叶片样本，解析 B3DM、Batch Table 与内嵌 GLB JSON：

| 塔址样本 | 实际下载 | 含建筑记录 | 目标自身记录 | 声明三角面 |
| --- | ---: | ---: | --- | ---: |
| 晴空塔 | 166,840 B（约 163 KiB） | 1 | 名称为東京スカイツリー，`_lod=2`、LOD2.1 | 2,166 |
| 东京塔附近叶片 | 1,201,956 B（约 1.15 MiB） | 101 | 由塔址和约 332.1 m 属性定位，`_lod=2`、LOD2.2 | 9,574，属于整片，不是东京塔单体 |

这是本轮最重要的限制：**LOD3 容器中的塔址抽样仍是 LOD2，尚不能作为有完整钢构和透空的塔架精模通过。** 两样本使用 Draco 压缩；上述面数来自 glTF 索引声明，本轮未解码 Draco、渲染画面或检查所有相邻内容，不能宣称已证明该地区没有其他更高细节资料。

晴空塔的 `bldg:measuredHeight` 为 355.5 m，几何属性 `_zmax-_zmin` 约 634.88 m。两者口径待核对，不能直接用测高字段缩放模型。源包标为 2025 年不代表几何都于 2025 年实测；采集年份、分部含义、JGD2011 与垂直基准需分别核查，不能对当前 DEM 套一个固定高程偏移。

目录、地区代码、许可响应、样本 URL/哈希及目标记录见[目录证据](landmark-assessment-evidence/plateau-catalog.json)和[塔址样本](landmark-assessment-evidence/plateau-targets.json)。没有把 693 / 6,949 个层级瓦片内容项解释成建筑栋数。

## 社区单体候选与已排除项

公开元数据逐份返回 `isDownloadable=true`，下列页面许可均为 CC BY 4.0。候选还需合法下载后的来源、网格与定位验证。本轮未登录 Sketchfab；下载端点实际返回 HTTP 401，因而**未取得 ZIP/GLB 下载体积，也未下载任何社区模型**。

| 地标 / 发布者 | 三角面 | 纹理数 | 理想化未压缩几何估算 | 状态与模型链接 |
| --- | ---: | ---: | ---: | --- |
| 晴空塔 / Noah | 676,132 | 4 | 11.58 MiB | [候选](https://sketchfab.com/3d-models/tokyo-skytree-japan-b4d347b8703f45f48ea8d5fe45d454b9)，制作来源与尺度待验 |
| 东京塔 / zebadiahsantos | 43,608 | 0 | 1.46 MiB | [候选](https://sketchfab.com/3d-models/tokyo-towerjapanese-radio-tower-5eb3686fb3364ffa8f956eabfa388da6)，先核查钢构和透空 |
| 东京塔 / Void | 205,739 | 4 | 3.96 MiB | [候选](https://sketchfab.com/3d-models/tokyo-tower-4f667743965e4260b451ad38efcc3712)，需检查材质和减面 |
| 上海中心 / NanoRay | 121,270 | 0 | 4.02 MiB | [候选](https://sketchfab.com/3d-models/shanghai-tower-e24fd5a66bbb4faaa7a8e26d3e7478fa)，核查扭转外形与冠顶 |
| 上海中心 / 发布者名 Microsoft | 26,896 | 0 | 0.72 MiB | [候选](https://sketchfab.com/3d-models/shanghai-tower-3f1cb06e3305425fb94259fedca86456)，尚未核实账号身份和制作来源 |
| 埃菲尔铁塔 / Brian Trepanier | 1,419,054 | 1 | 42.93 MiB | [候选](https://sketchfab.com/3d-models/eiffel-tower-paris-france-a68b9ffb898d4aa7a44505926a536ce3)，原面数远超现有预算 |
| 埃菲尔铁塔打印版 / corentin | 139,989 | 0 | 3.32 MiB | [候选](https://sketchfab.com/3d-models/eiffel-tower-paris-printable-monument-71eea104dd2947c3a83dc7d4028af112)，需检查打印加粗或封孔是否影响遮挡 |
| 东京塔 / SomeAB | 5,552 | 1 | 0.15 MiB | [排除](https://sketchfab.com/3d-models/tokyo-tower-dc2714f018934e7595381cab83626594)：作者说明基于 Google Maps 数据，CC 标签不足以确认上游提取和再分发授权 |

估算采用 `顶点数 × 32 B + 三角面数 × 12 B`，假定 position/normal/UV 为 float32、索引为 uint32；不含纹理、JSON、额外属性或顶点拆分，也没有计入实际压缩，**不是文件大小或显存上界**。具体顶点数、作者、许可 URL 与排除原因见[候选证据](landmark-assessment-evidence/community-shortlist.json)。

因此当前能确认的是“存在待验单体”，不是已有 7 份完成实景精度校准的精模。晴空塔原候选面数约为当前普通建筑整场 12 万面预算的 5.6 倍，不能直接原样常驻后宣称性能已满足。

## 应用资源包的容量预算

以下是**未来制作后的规划目标**，不是上述源文件已测得的下载大小。只有下载、转换和固定长焦场景检查后才能决定实际大小；不能为满足体积牺牲塔架透空或地标轮廓。

先以一个地标包含远/中/近几个 LOD、合计约 0.3–2 MiB 的无纹理压缩几何作为试制目标；如需要纹理，先以单体资源合计 2–10 MiB 估算。极复杂地标可能超出，需单独调整。多个模型按机位和视场按需加载，资源库大小不等于一次加载量。运行时宜使用精选地标清单，避免让预览每次下载约 9.7 MB 全国目录和约 4.5 MB 墨田区 tileset；这两项大小是本轮目录响应测量。单体的可见距离还需独立验收，不因模型已入库就承诺任意远机位可见。

| 精选库规模 | 无纹理几何预算 | 带纹理资源预算 |
| --- | ---: | ---: |
| 10 个地标 | 3–20 MiB | 20–100 MiB |
| 30 个地标 | 9–60 MiB | 60–300 MiB |
| 100 个地标 | 30–200 MiB | 200–1,000 MiB |

首批 10–30 个无纹理/轻材质地标在容量上有静态部署空间；100 个高纹理模型的上界已接近或超过当前站点可用空间，且 Git 历史、已有资源、请求流量另计。GitHub Pages 发布站点上限 1 GB，普通 Git 单文件超过 100 MiB 被阻止；不把整城 ZIP、扫描原始包或历史版本都塞入应用仓库。[Pages 限制](https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits)、[Git 文件限制](https://docs.github.com/en/repositories/working-with-files/managing-large-files/about-large-files-on-github)

下载大小与显存必须分开：一张 2048² RGBA8 纹理含 mip 约 21.3 MiB，一张 4096² 约 85.3 MiB；这些是格式容量计算，不是某份纹理的实际驻留测量。多个材质贴图可能比几何更占显存，所以第一步推荐几何和轻材质优先。

## 建议的下一小步与准入条件

下一轮先做**晴空塔单目标的源模型下载、轮廓核对和小规模试制**，不同时承诺整库。优先比较可合法取得的作者模型与已定位的 PLATEAU 单体；模型未达要求时保留现有粗体块，不用目录 LOD 标签替代画面结论。

进入实现前固定作者/权利人、源 URL、许可、下载时间、哈希、制作/采集年份、单位、朝向、锚点与高程含义。社区下载经正式下载入口或作者授权资料完成，不将短效下载 URL 作为生产源。可再分发的转换产物同源静态分发，来源和加工说明继续集中于 About。

准入验证重点：塔尖/观景台/基座比例、钢构透空、8–1000 mm 的轮廓误差、统一 ENU/对数深度、粗体块替换、山体/天体遮挡及加载失败回退。打印模型与贴图假透空尤其需核查，透明外观和遮挡深度要一致。三角面与解码/显存预算应与普通建筑共同分配，先测实际 GPU 和手机，再定细节级别；本次不预选新渲染引擎、模型加载库或新增后端。

本轮仅文档与数据样本核查，没有运行模型视觉/精度验收，没有改变应用代码；现有 234 项应用检查是上一轮结果，本轮未重复运行。证据范围、源码未变核对与哈希见[核查记录](landmark-assessment-evidence/verification.json)。
