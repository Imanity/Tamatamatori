# M31/M42 遮罩与颜色修正

更新：2026-11-05。用户指出已发布版本存在明显蒙版、目标不完整，M42 未改机过蓝。本轮只修复这两个问题，先完成本地验收，再按本轮用户的提交推送要求更新发布。

## 原因与范围

此前将范围偏小的出版图套入 18% 边缘羽化和椭圆遮罩，再叠加 16% 目录轮廓，导致星云被裁掉、外层有假轮廓。RGB 被压缩为连续谱/红光/青蓝分量，未改机又将红光乘 0.25，不能保留原来的色彩关系。相机的 Hα 通光差异不能直接套到整张 RGB 合成图的红色通道。

M31 换用 ESA/Hubble 发布的 [heic1112f 广域图](https://www.astropix.org/image/esahubble/heic1112f)，M42 换用 [NOIRLab 的宽幅 LRGB 资料](https://www.astropix.org/image/noirlab/noao-m42steinberg)，核实 CC BY 4.0、AVM 与输入哈希，保留完整署名。展示来源覆盖中的完整结构，不编造覆盖外的云气。

取消两目标的椭圆裁切及目录轮廓叠加，重投影覆盖原图完整范围，边缘仅做很窄的采样过渡，透明度依据实际亮度连续变化。保留基础 RGB，以独立分量表示改机模式额外的红色增强；普通模式仍保留红、粉和青蓝结构。额外分量由色彩资料近似，不能称为实测 Hα 或普通相机实拍。

其余 6 个目标保持已有显示模型；星历、相机、地形和银河不扩展。图集仍单张、按需加载、共享地形深度，不新增服务和运行时依赖。

## 验收

- WCS 独立对照、源文件与图集哈希、资料覆盖/无椭圆裁切、RGBA 解码及响应 uniform 回归。
- 同构图普通/改机对照：M42 普通模式保留红色和青蓝核心，改机不移动或裁切结构；M31 不因响应切换染红。
- Chrome 广角/长焦和部分入画检查完整结构、无明显蒙版轮廓，日间淡出与 DEM 裁切继续有效。保存实际画面，不能仅凭数值检查宣告视觉通过。

## 执行结果

- `npm test`：154/154 通过；最终 fixture 补充完整来源四角覆盖断言后，深空 8 项再验通过。新增实际 PNG 解码回归，核对 M42 基础 RGB 保留显著红色、M31/M45 无额外红色增量和 8 个图格中性边框。`npm run build -- --base /Tamatamatori/` 通过，含 TypeScript；既有大分块提示不影响构建。
- PyAVM 0.9.9 + Astropy 7.1.1/WCSLIB 独立核对两图各 25 点，最大差分别约 4.37e−11 / 9.78e−12 个参考像素。M42 的 X/Y 尺度不等，按完整 CROTA2/CD 矩阵处理；原图四角均落入重投影网格。该检查验证转换实现，不是原图测量精度。见[独立记录](../../tests/fixtures/deep-sky-image-registration.json)。
- 最终 atlas 为 RGBA 4096×2048、820044 bytes，SHA256 `8a6907b0af4663ca704cac3a3c787953e8ccfd56d31994a6b08b06272b76c912`。RGB 为基础色彩，A 为反向打包的额外红色增量；A 不是可见透明度。M31/M42 无椭圆遮罩和目录外壳，采样边缘仅过渡 3 个工作像素。

Chrome 实际 WebGL 使用山中湖 35.4172°N、138.8729°E、离地 1.6 m、全画幅横幅 3:2、标准参考折射、Asia/Tokyo。最终图集对应的十张截图、场景和文件哈希见[浏览器记录](deep-sky-render-fix-evidence/browser-results.json)；本次控制台未发现 error。

| 场景 | 实际结果与证据 |
| --- | --- |
| 2026-11-09 01:00，M42，600 mm | [未改机](deep-sky-render-fix-evidence/m42-stock.jpg)保留粉红云气与青蓝核心；[改机](deep-sky-render-fix-evidence/m42-ha.jpg)增加红色而不移动或截断结构。南侧、M43 及北侧资料均保留，无旧椭圆外壳。 |
| 同时刻，M42，1000 mm | [长焦边缘](deep-sky-render-fix-evidence/m42-1000mm.jpg)随亮度连续过渡，无旧蒙版截断；这不是分辨率或光度定标。 |
| 同时刻，M31，400 / 600 mm | [较宽构图](deep-sky-render-fix-evidence/m31-400mm.jpg)显示完整主盘与外缘；[未改机](deep-sky-render-fix-evidence/m31-stock.jpg)和[改机](deep-sky-render-fix-evidence/m31-ha.jpg)的相同预览裁区像素完全一致。 |
| 同时刻，M31，1000 mm，方位 297.4° | [中心在框外](deep-sky-render-fix-evidence/m31-partial-frame.jpg)仍显示入画结构，中心名称隐藏。 |
| 2026-11-09 07:00，M42，1000 mm | 几何高度 10.7°，[白昼](deep-sky-render-fix-evidence/m42-daylight.jpg)状态为“天空较亮 · 轮廓隐藏”，无名称。 |
| 2026-01-19 02:50 / 03:05，M42，200 mm | 几何高度 4.7°时[部分山体遮挡](deep-sky-render-fix-evidence/m42-terrain-partial.jpg)，中心与名称被挡；1.6°时[完整山体遮挡](deep-sky-render-fix-evidence/m42-terrain-blocked.jpg)。 |

剩余限制：参考图分辨率、残余恒星、原始色彩处理和资料范围仍限制外观；“未改机”是保留基础色彩的参考，改机红色增量也来自 RGB 近似，两者都不是某台相机或曝光参数的预测。后续若做器材响应定标，需要独立的谱线/通带与实测资料，不能继续直接缩放整图红色。
