# 空间站构图首步

## 范围

接入 ISS（NORAD 25544）与天宫天和核心舱（48274），提供独立图层、按拍摄 UTC 时刻推算的位置标记、前后各三分钟的轨迹点、目标朝向、地形遮挡与轨道数据状态。空间站按目录身份选取，避免将停靠飞船、实验载荷或同一组合体的模块重复展示。

轨道来自 CelesTrak stations 分组的 GP JSON，使用固定 satellite.js 7.1.0 的 SGP4。实测接口 HTTP 200，但缺少浏览器跨域许可，因此由 GitHub Actions 获取并发布同源 JSON。保持静态站点架构。完整署名加入 About。

## 数据更新

- Actions 计划每三小时检查一次，UTC 第 23 分触发，推送及手动工作流也检查。两次上游请求至少相隔两小时，使用持久缓存保存尝试时间和最近有效数据。
- 只由发布构建任务请求上游，PR 和其他 Node.js 验证任务不请求。请求失败停止自动重试，保留旧数据并发布明确的失败状态，维护者处理后手动恢复。
- 网页开启图层后每五分钟检查同源快照，后台暂停，回到前台检查到期数据。手动按钮刷新已发布快照，不能强制上游突破更新间隔。
- 分别展示轨道历元、上游成功检查、上游尝试及网页检查时间。刚下载并不意味着轨道历元变新。
- 距轨道历元超过 24 小时提示低可信，超过 72 小时停止位置与轨迹绘制。该范围是本应用的显示策略，不能解释为 SGP4 精度保证。未来和历史时刻采用相同边界。
- 变轨时间和新解发布存在延迟。不能通过旧轨道提前识别所有变轨，也不能将下载成功表述为已校正变轨。拍摄前重新检查数据，变轨后等待新历元。

GitHub 定时任务可能延迟，公开仓库长期无活动也可能停用计划任务。因此界面以实际检查时间与轨道历元判断新鲜度，超过六小时未成功检查时显示提示。定时流程在本轮工作流部署后启用，首次远端执行需单独核对。[GitHub 定时任务说明](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule)

## 验收

固定 GP 输入对照独立 SGP4 与地平坐标，检查经纬度、极区、跨日、传感器视场、实际相机高度和折射。检查缺失、非数、过期、更新回退、取消、后台恢复及冷却。用替身检查异步遮挡与资源生命周期，刷新 Chrome 核对标记、轨迹、视场外/地平线下、遮挡和错误状态。

## 来源

资料查阅于 2026-11-06。[CelesTrak GP 格式与更新说明](https://celestrak.org/NORAD/documentation/gp-data-formats.php)，[使用政策](https://celestrak.org/usage-policy.php)，[satellite.js](https://github.com/shashwatak/satellite-js)

## 执行结果

2026-11-06 已完成本地实现和验证。

- 182 项自动检查通过，包括 32 组独立 C++ SGP4／ERFA 坐标、UTC 历元、跨日/日期变更线/近极区/负高程、24/72 小时边界、两小时请求冷却、先持久化再下载、错误暂停及手动恢复。固定输入取自[种子快照](stations-evidence/seed-snapshot.json)，Python 生成入口为 `scripts/check-stations.py`。
- 独立实现的最大方向差约 0.0000183°，最大距离差约 0.00112 km。数值来自[对照汇总](stations-evidence/numerical.json)，其含义限定为相同输入下的实现一致性，实际轨道解和观测误差另行判断。
- TypeScript 与 `/Tamatamatori/` 子路径构建通过。生产构建启用 ESM Worker 格式后，地图和独立地形均正常启动，最终产物未包含 WASM。构建保留依赖的浏览器外置分析提示和既有大 chunk 提示。
- 使用真实上游接口在 2026-11-06 12:18:31 UTC 成功获取两个目标。新取得的 GP 元素与种子一致，网页成功检查时间更新而历元保留，已验证两者分开显示。[实际快照](stations-evidence/live-snapshot.json)
- 随后通过正常 CLI 再次检查，两小时冷却命中，源快照字节及成功检查时间保持一致。上游拒绝、无效元素、历元回退与取消使用替身验证。
- Chrome 使用带子路径的生产构建验收，覆盖 ISS、天宫、白昼/地影参考、35/1000mm、±1/±10 秒、地形遮挡、地平线下、过期停绘、开关、手机及已发布快照失败/恢复。固定参考中，ISS 在 10:31 UTC 的 1.8° 高度被山体遮挡，10:35 UTC 的 34.5° 高度标记清晰。
- 浏览器故障注入只修改临时 `dist/orbits/stations.json`。暂停状态、损坏 JSON 和恢复均保留真实 GP 元素，恢复案例只验证已发布快照的状态转换。真实上游检查记录与故障注入分别保存，正式源文件保持真实检查结果。
- 初次 ISS 宽幅与天宫白昼截图取到了名称绘制前的一帧，已使用独立生产预览重新取得稳定画面并替换验收截图；两轮使用的 GP 元素相同，检查元数据与资源哈希分别记录。

| 场景 | 画面 |
| --- | --- |
| ISS 宽幅与秒级变化 | [35mm](stations-evidence/iss-35mm.png)、[+1秒](stations-evidence/iss-plus-1s.png)、[+10秒](stations-evidence/iss-plus-10s.png) |
| ISS 长焦与山体遮挡 | [1000mm](stations-evidence/iss-1000mm.png)、[遮挡](stations-evidence/iss-terrain.png) |
| 天宫、开关及边界 | [白昼天宫](stations-evidence/tiangong-daylight.png)、[图层关闭](stations-evidence/station-layer-off.png)、[地平线下](stations-evidence/station-below-horizon.png)、[过期](stations-evidence/station-expired.png) |
| 真实更新及手机 | [真实更新](stations-evidence/station-live-update.png)、[手机预览](stations-evidence/tiangong-mobile.png)、[手机读数](stations-evidence/station-mobile-info.png) |
| 故障与恢复注入 | [上游暂停](stations-evidence/station-source-paused.png)、[无效快照](stations-evidence/station-feed-invalid.png)、[恢复](stations-evidence/station-feed-recovered.png) |

完整状态见[浏览器记录](stations-evidence/browser-records.json)，资源版本与截图哈希见[验证汇总](stations-evidence/verification.json)。

## 使用与边界

位置环及轨迹点属于构图标记，轨迹点间隔十秒，秒级拍摄位置可用右侧按钮调整。地影参考使用几何阴影估计，可拍摄性还取决于天空亮度、光学条件及实际轨道误差。当前开放 ISS 与天宫核心舱两个目录身份。

上游暂停后，维护者先核对具体错误，再在手动 CI 中勾选 `resume_orbits`。本地可以运行 `npm run update:orbits -- --resume`，仍须等待两小时冷却。下一小步适合补充未来短时过境的时段列表，沿用本轮历元与更新状态约束。
