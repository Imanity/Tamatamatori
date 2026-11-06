# 当地光污染首步

更新于 2026-11-07，本轮接入预览开关与当地天顶增亮对星空的显示影响。

## 范围与交互

- 构图线按钮右侧增加“当地光污染”开关，默认关闭，与统一拍摄计划一起驱动预览。
- 开启后按机位经纬度读取固定图集，人工增亮量参与夜空背景、暗星、银河与深空云气的显示对比度。构图标记、天体方向和地形遮挡分别计算。
- 右侧全局信息提供来源年份、人工增亮参考值、加载、缺失与失败状态。关闭时恢复原有日月光照模型，加载失败不能显示为零光污染。
- 预览的常驻图集文字与加载提示已移除，正常应用时只通过开关状态表达。加载状态与来源年份集中于全局信息，无覆盖与失败在预览反馈。
- 机位变化取消过期请求，方向、时间、焦距变化复用当地数据，关闭开关或卸载预览组件时释放未完成请求。真实数据与演示模型分别表达。

## 数据选择

采用 Falchi、Cinzano、Duriscoe、Kyba、Elvidge、Baugh、Portnov、Rybnikova、Furgoni 的 World Atlas 2015，GFZ 发布版本 1.1，DOI 为 `10.5880/GFZ.1.4.2016.001`。原始栅格的单位为 mcd/m²，表示模拟的天顶人工亮度，不包含自然夜空。原数据按 30 角秒格网发布，衍生资源的采样与压缩将在生成时记录。[GFZ](https://dataservices.gfz.de/10.5880/gfz.1.4.2016.001/supplement-to-the-new-world-atlas-of-artificial)、[DataCite 元数据](https://api.datacite.org/dois/10.5880/GFZ.1.4.2016.001)

数据采用 CC BY-NC 4.0，仅限非商业使用。来源、完整作者、许可、修改与衍生资源下载纳入 About 和第三方说明。运行时通过同源静态文件读取，用户操作不会请求上游图集。更近年份的 Lorenz 图集缺少可核验的再分发许可，本轮不采用。

2015 为固定历史图集，不能当作所选拍摄年份的实时光污染。当地天顶量与面向某个城市的光穹方向有区别，本轮采用一致的天空显示近似，保留覆盖边界与缺测，不将图集数值标成波特尔等级，不模拟天气、曝光或现场实测亮度。

## 验收

数值检查覆盖经纬度到像元、覆盖边界、缺测、自然与人工亮度叠加、暮光和月光、暗星与银河对比度。组件检查覆盖开关、位置更新、取消、失败及与既有图层的独立性。执行全量测试和 Pages 子路径构建，Chrome 对比城市、暗区、白昼、移动端和开关恢复，单独记录真实 GPU 结果。

## 执行记录

2026-11-07 完成本地验收。

### 数据与模型

- 原始 ZIP SHA256 为 `9c6a624427463c40717efbca7696e3c6bb0f332c26d1b039e7a91e0dbc831fbf`，TIFF 为 `9725566ed4fcf1a8fa311654143bb024c4fe2a792b85356be99adce07e1e83c1`。固定输入从 GFZ 通过正常 TLS 下载，当前许可见[官方元数据记录](light-pollution-evidence/source-metadata.json)。压缩包内的 2016 禁再分发说明已由官方 2019 年 CC BY-NC 4.0 更新替代。
- 原 TIFF 为 WGS84、43200×17406、128×128 无压缩分块。去掉已发布北界 75° 以外的零填充，从原生第 1206 行开始，将有效 3×3 像元在线性亮度空间平均，得到 14400×5400 格网。保留原始格网注册与约 16 m 的经度舍入边界，南界约为 −59.9958°。
- 126 份静态分块共 7,830,068 字节，约 7.47 MiB。编码为 `1 + round(16 × ln(1 + L / 0.001))`，0 留作缺测，1 为真实零值。`L + 0.001` 的相对量化误差上界约为 3.18%。最多缓存四份解码分块，最大驻留缓存为 2,560,000 字节。HTTP 访问只读取同源分块，携带资源校验版本。
- 原始、分块与输出校验值、地理参数和处理声明保存在[数据索引](../../src/data/light-pollution.json)。手动生成入口为[生成脚本](../../scripts/build-light-pollution.py)，重复生成保持索引、参考 fixture 和分块校验一致，构建与 CI 直接使用已生成资源。
- 原模型的典型自然天顶背景为 0.174 mcd/m²。显示极限星等使用线性背景相加，再转回显示阈值。星点与扩展云气采用单调增益，避免在强光污染下月光或暮光增强时反向变亮。天空颜色采用艺术性抬亮，地表材质及阴影参数沿用原时间模型。该显示过程没有器材或曝光定标。

### 自动检查

`npm test` 共 199 项通过，`npm run build -- --base /Tamatamatori/` 通过，保留已有 MapLibre 大包体积提示。

- 九处地点的 34 个参考像元从原 TIFF 独立读取 3×3 平均值，与 JS 格网定位、量化解码和插值核对。东京约为 6.491、山中湖约为 0.202、巴黎约为 9.326 mcd/m²，所选暗区为 0。[源参考](../../tests/fixtures/light-pollution-reference.json)
- 逐块检查 SHA256、压缩字节、解码尺寸与总大小。覆盖经度换日线、北南边界、缺测与零值、缓存、取消、HTTP 失败、不完整下载和版本损坏。
- 数值检查包含光污染单调性，四档污染下的月相、月亮高度与暮光增强不能反向提高星空对比度。白昼保持原模型，地表配色与几何分别核对。
- React 检查开关位置、数据状态、机位变化取消、关闭后的迟到响应、重试与已有镜头交互。GL 替身检查显示强度变化时的几何一致性。另修正已加载预览隐藏后恢复同一尺寸时没有重新提交星空帧的问题，ResizeObserver 事件更新场景版本。

### Chrome 画面

保存 [18 组截图、取景裁片与 DOM 记录](light-pollution-evidence/browser-results.json)，另保留一次初次失败记录。桌面为 1440×900，手机为 390×844 和 360×640，使用真实 Chrome/WebGL、地形和已发布天体纹理。

- [东京关闭](light-pollution-evidence/01-tokyo-off.png)与[东京开启](light-pollution-evidence/02-tokyo-on.png)保持机位、时刻和镜头一致，显示星名从 10 个减至 5 个，夜空背景中位 RGB 从 `(28,44,70)` 升至 `(65,78,95)`。这些是显示像素统计。[关闭恢复](light-pollution-evidence/03-tokyo-restored.png)的取景裁片与关闭基线逐像素一致。
- [山中湖](light-pollution-evidence/04-fuji-on.png)按当地较弱的污染更新。[暗区开启](light-pollution-evidence/05-dark-on.png)与[关闭](light-pollution-evidence/06-dark-off.png)背景中位数一致，真实零值作为有效数据处理。两组取景裁片的平均绝对差约为 0.33/通道。
- [巴黎失败](light-pollution-evidence/07-paris-failed.png)临时隔离本轮 dist 的分块，显示未应用并提供重试，恢复文件后[重试成功](light-pollution-evidence/08-paris-recovered.png)。原始文件未更改，故障注入文件已恢复。
- [高纬度](light-pollution-evidence/09-outside-coverage.png)明确显示图集无覆盖。同次地形源加载失败独立反馈，这个场景用于验证状态区分，未计作有效地形渲染通过。
- [白昼开启](light-pollution-evidence/10-day-on.png)与[关闭](light-pollution-evidence/11-day-off.png)均隐藏星点与银河，背景中位数一致。手机核对[预览](light-pollution-evidence/12-mobile-on.png)、[读数](light-pollution-evidence/13-mobile-readout.png)、[来源与许可](light-pollution-evidence/14-mobile-about.png)及[小屏](light-pollution-evidence/15-small-mobile.png)。About 覆盖画面的裁片不作为天空对照。
- 最终文案修正后刷新核对[城市](light-pollution-evidence/16-final-city.png)、[手机](light-pollution-evidence/17-final-mobile.png)及[默认布局](light-pollution-evidence/18-final-default.png)，控制台无错误。最终资源为 `index-CcC4cSjj.js` 与 `index-CdEQMclY.css`，与子路径构建一致。01—15 为功能验收构建 `index-BDWWyzeA.js`，每个场景分别保存版本。

首次 `.bin.gz` 资源被静态服务标为 HTTP gzip，浏览器提前解压，触发长度检查。[失败画面](light-pollution-evidence/00-initial-content-encoding-error.png)仅作问题记录，初次模块版本未保留，未作为通过依据。最终改用不触发自动解压的 `.bin`，索引显式声明 gzip，运行时校验后解码，并加入文件格式回归检查。[数值、重建及像素统计](light-pollution-evidence/data-verification.json)

### 验证边界

2015 历史图集、约 2.8 km 采样和显示映射均有近似，南北极及覆盖外不会生成污染值。未接入城市方向光穹、实时灯光、气象、镜头眩光或实际曝光。色彩抬亮与星等阈值用于构图参考，来源年份在全局信息展示，非商业许可在 About 中明确标注。

## 界面收敛复验

2026-11-07 按用户要求移除预览常驻的“光污染 · 2015 图集”文字，开关提示简化为“当地光污染”。来源年份集中于全局信息与 About。预览与下方参数面板默认高度比改为 1:1，支持继续拖动分隔条调整。

199 项测试和子路径构建通过，组件检查新增等高初始值和光污染就绪后无常驻状态行的断言。Chrome 在 2560×1271 下实测两个面板均为 576.5 px，开关开启、当地数值就绪后预览无图集文字。资源为 `index-C0ryoHwL.js`，本次仅复验这两项界面调整。[画面](light-pollution-evidence/19-layout-1to1.png)、[布局与状态记录](light-pollution-evidence/layout-refinement.json)

随后按用户要求移除预览的“光污染待应用”加载提示，加载状态集中于全局信息。199 项测试和子路径构建再次通过，组件检查包含首次加载、切换机位与过期请求返回时无预览加载文字。本次文案收敛以组件检查验证。
