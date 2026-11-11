import { useRef } from "react";
import { landmarks } from "../domain/landmarks";
import { Icon } from "./Icon";
import starCatalogUrl from "../data/bright-stars.json?url";
import constellationCatalogUrl from "../data/constellations.json?url";
import constellationStarsUrl from "../data/constellation-stars.json?url";
import deepSkyCatalogUrl from "../data/deep-sky.json?url";
import { deepSkyCatalog, deepSkyImageCredits } from "../domain/deep-sky";
import { deepSkyImageUrl } from "../preview/deep-sky-texture";
import lightPollutionUrl from "../data/light-pollution.json?url";
import { lightPollutionAtlas } from "../domain/light-pollution";

const sourceLicenseLabels: Record<string, string> = {
  "Public-Domain": "公有领域",
  "CC0-1.0": "CC0 1.0",
  "CC-BY-SA-4.0": "CC BY-SA 4.0",
  "CC-BY-4.0": "CC BY 4.0",
};

const libraries = [
  { name: "React / React DOM", license: "MIT", url: "https://github.com/facebook/react" },
  { name: "MapLibre GL JS", license: "BSD-3-Clause", url: "https://github.com/maplibre/maplibre-gl-js" },
  { name: "Astronomy Engine", license: "MIT", url: "https://github.com/cosinekitty/astronomy" },
  { name: "Earcut", license: "ISC", url: "https://github.com/mapbox/earcut" },
  { name: "Temporal polyfill", license: "ISC", url: "https://github.com/js-temporal/temporal-polyfill" },
  { name: "satellite.js 7.1.0", license: "MIT", url: "https://github.com/shashwatak/satellite-js" },
  { name: "@photostructure/tz-lookup 11.7.0", license: "CC0-1.0", url: "https://github.com/photostructure/tz-lookup" },
];

export function About() {
  const dialog = useRef<HTMLDialogElement>(null);

  return (
    <>
      <button
        className="about-button"
        type="button"
        aria-label="关于 Tamatamatori"
        aria-haspopup="dialog"
        aria-controls="about-dialog"
        title="版权、许可与数据来源"
        onClick={() => dialog.current?.showModal()}
      >
        <Icon name="info" size={16} />
        About
      </button>
      <dialog
        id="about-dialog"
        className="about-dialog"
        aria-labelledby="about-title"
        aria-describedby="about-description"
        ref={dialog}
      >
        <header className="about-header">
          <div>
            <span className="eyebrow">ABOUT TAMATAMATORI</span>
            <h2 id="about-title">关于与版权</h2>
          </div>
          <button
            className="reset-button"
            type="button"
            autoFocus
            onClick={() => dialog.current?.close()}
          >
            关闭
          </button>
        </header>
        <div className="about-body">
          <p id="about-description">
            Tamatamatori 是基于地理与天文数据的摄影构图模拟工具。以下汇集应用使用的数据、影像与开源软件来源。
          </p>
          <a
            className="about-notices"
            href={`${import.meta.env.BASE_URL}third-party-notices.txt`}
            target="_blank"
            rel="noreferrer"
          >
            查看第三方完整版权、许可与修改说明
          </a>

          <section aria-labelledby="about-map-title">
            <h3 id="about-map-title">地图与高程</h3>
            <ul>
              <li>
                <a href="https://openfreemap.org/" target="_blank" rel="noreferrer">OpenFreeMap</a>
                <span> · 底图、水体与建筑瓦片服务</span>
              </li>
              <li>
                <a href="https://openmaptiles.org/" target="_blank" rel="noreferrer">© OpenMapTiles</a>
                <span> · 地图数据结构与样式</span>
              </li>
              <li>
                <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">© OpenStreetMap contributors</a>
                <span> · ODbL · 底图、水体与建筑数据</span>
              </li>
              <li>
                <a href="https://mapterhorn.com/attribution/" target="_blank" rel="noreferrer">© Mapterhorn · 高程及上游数据来源</a>
              </li>
              <li>
                <a href="https://nominatim.org/" target="_blank" rel="noreferrer">Nominatim</a>
                <span> · 地点搜索，数据 © OpenStreetMap contributors（ODbL）。只在按回车或“搜索”时查询，遵守 </span>
                <a href="https://operations.osmfoundation.org/policies/nominatim/" target="_blank" rel="noreferrer">使用条款</a>
                <span>；“我的位置”只在本机使用，不发送到任何服务</span>
              </li>
            </ul>
            <p>地形按曲面构图绘制；高程数据的垂直基准尚未核定，水面高程按 DEM 近似，不含倒影、波纹或实际水位。</p>
            <p>建筑以周边有限范围的轮廓和渲染高度生成体块；高度可能来自楼层换算或缺省值，不含完整屋顶、实景材质或灯光。基座采用同源 DEM 近似，不保证建筑完整覆盖或楼顶日月对齐精度。</p>
          </section>

          <section aria-labelledby="about-zone-title">
            <h3 id="about-zone-title">当地时区</h3>
            <p>“当地时区”按机位坐标查询 IANA 时区，使用 @photostructure/tz-lookup 11.7.0（CC0 1.0）。其有损压缩网格源自 Evan Siroky 的 timezone-boundary-builder，后者以 ODbL 发布、基于 © OpenStreetMap contributors。</p>
            <p>边境附近与海上可能返回相邻时区；新疆返回 Asia/Urumqi（UTC+6）而非北京时间。结果以城市和 UTC 偏移显示，可随时改选固定时区，拍摄时刻按 UTC 保存、不受影响。</p>
            <div className="about-downloads">
              <a href="https://github.com/photostructure/tz-lookup" target="_blank" rel="noreferrer">tz-lookup</a>
              <a href="https://github.com/evansiroky/timezone-boundary-builder" target="_blank" rel="noreferrer">timezone-boundary-builder</a>
              <a href="https://opendatacommons.org/licenses/odbl/" target="_blank" rel="noreferrer">ODbL 1.0</a>
            </div>
          </section>

          <section aria-labelledby="about-weather-title">
            <h3 id="about-weather-title">天气预报</h3>
            <p>天气数据由 Open-Meteo 提供，汇集各国气象机构的数值预报，数据采用 CC BY 4.0。当前使用免密钥免费服务，仅限非商业用途。</p>
            <p>按机位读取七天逐小时序列。云层覆盖受点位云量约束，云块位置、透光与降水外观为显示近似，实际预报精度随地区、时效与气象条件变化。</p>
            <div className="about-downloads">
              <a href="https://open-meteo.com/" target="_blank" rel="noreferrer">Open-Meteo</a>
              <a href="https://open-meteo.com/en/docs" target="_blank" rel="noreferrer">变量与来源模式</a>
              <a href="https://open-meteo.com/en/terms" target="_blank" rel="noreferrer">服务条件与数据许可</a>
              <a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noreferrer">CC BY 4.0</a>
            </div>
          </section>

          <section aria-labelledby="about-tides-title">
            <h3 id="about-tides-title">潮汐</h3>
            <p>潮位来自 Open-Meteo Marine API 的海平面高度：MeteoFrance SMOC 模型，generated using E.U. Copernicus Marine Service Information。约 8 km 网格、逐小时、预报约 10 天，相对全球平均海平面，不是海图基准面；含天文潮、逆气压与海面高度变化。免密钥免费服务仅限非商业用途。</p>
            <p>机位常落在陆地格点，因此同时查询周围约 12 km、30 km 两圈，取最近的海洋格点。高低潮由逐小时数值插值；与 NOAA 美国验潮站预报对照，开阔海岸的时刻常早 15—45 分钟，海湾可差 1 小时以上，不可用于航行。预览中的水面不随潮位变化。</p>
            <div className="about-downloads">
              <a href="https://open-meteo.com/en/docs/marine-weather-api" target="_blank" rel="noreferrer">Open-Meteo Marine</a>
              <a href="https://doi.org/10.48670/moi-00016" target="_blank" rel="noreferrer">Copernicus Marine SMOC</a>
              <a href="https://open-meteo.com/en/terms" target="_blank" rel="noreferrer">服务条件与数据许可</a>
            </div>
          </section>

          <section aria-labelledby="about-aurora-title">
            <h3 id="about-aurora-title">极光</h3>
            <p>极光预报来自 NOAA 空间天气预报中心（SWPC）：OVATION Prime 临近预报（拍摄时刻接近现在时）、3 小时 Kp 预报与 27 天展望。NOAA 数据可自由使用，本应用与 NOAA 无关联。</p>
            <p>地磁坐标用 IGRF-14（2025.0）一、二阶系数的偏心偶极近似；极光带赤道侧边界按 Carbary（2005）的 Kp 线性模型，系数取自 MIT 许可的 carbary-auroral-model 转录。能否看到按 200 km 高的极光顶部是否高出地平线 5° 判断，偏向相机长曝光。均为近似，Kp 预报本身超过一天后可靠性较低；不含云量与月光，预览中不画极光。</p>
            <div className="about-downloads">
              <a href="https://www.swpc.noaa.gov/products/aurora-30-minute-forecast" target="_blank" rel="noreferrer">SWPC 极光临近预报</a>
              <a href="https://www.swpc.noaa.gov/products/3-day-forecast" target="_blank" rel="noreferrer">Kp 预报</a>
              <a href="https://www.ncei.noaa.gov/products/international-geomagnetic-reference-field" target="_blank" rel="noreferrer">IGRF-14</a>
              <a href="https://doi.org/10.1029/2005SW000162" target="_blank" rel="noreferrer">Carbary 2005</a>
            </div>
          </section>

          <section aria-labelledby="about-pollution-title">
            <h3 id="about-pollution-title">当地光污染</h3>
            <p>{lightPollutionAtlas.credit}</p>
            <p>World Atlas 2015 · GFZ 版本 1.1 · CC BY-NC 4.0，仅限非商业使用。</p>
            <div className="about-downloads">
              <a href={lightPollutionAtlas.source} target="_blank" rel="noreferrer">数据来源与许可</a>
              <a href={lightPollutionAtlas.paper} target="_blank" rel="noreferrer">Falchi 等，Science Advances 2016</a>
              <a href={lightPollutionAtlas.licenseUrl} target="_blank" rel="noreferrer">CC BY-NC 4.0</a>
              <a href={lightPollutionUrl} download="tamatamatori-light-pollution.json">下载衍生数据索引与校验值</a>
              <a href={lightPollutionAtlas.download} target="_blank" rel="noreferrer">原始全球图集</a>
            </div>
            <p>原始 30 角秒栅格按 3×3 平均为约 2.8 km 格网，保留原格网注册，去掉北部覆盖外填充值，再对数编码并按需加载分块。衍生数据继续采用 CC BY-NC 4.0。</p>
            <p>覆盖约南纬 60° 至北纬 75°。数值为历史模型的天顶人工亮度，天空颜色与对比度为显示近似，不提供实时光污染、城市光穹方向、波特尔等级或曝光预测。</p>
          </section>

          <section aria-labelledby="about-landmarks-title">
            <h3 id="about-landmarks-title">地标模型</h3>
            <p>社区外观模型，定位和朝向近似；无纹理、不透明共享光照，不提供测绘精度、玻璃透光或夜景灯光。</p>
            <ul className="about-image-credits">
              {landmarks.map((model) => (
                <li key={model.id} data-landmark-credit={model.id}>
                  <h4>{model.name}</h4>
                  <p className="about-credit-line">
                    <a href={model.credit.page} target="_blank" rel="noreferrer">{model.credit.title}</a>
                    {" · "}
                    <a href={model.credit.authorPage} target="_blank" rel="noreferrer">{model.credit.author}</a>
                  </p>
                  <p>
                    <a href={model.credit.licenseUrl} target="_blank" rel="noreferrer">{model.credit.license}</a>
                    {model.credit.use && <strong className="about-use">，{model.credit.use}</strong>} · {model.credit.changes}
                  </p>
                  {model.validation.visual === "pending" && <p>已完成 CPU 检查，画面待验证。</p>}
                  <details className="about-more">
                    <summary>定位、朝向与参考资料</summary>
                    <p>{model.credit.registration}</p>
                    <ul className="about-references">
                      {model.credit.references.map((ref) => (
                        <li key={ref.url}>
                          <a href={ref.url} target="_blank" rel="noreferrer">{ref.title}</a>
                        </li>
                      ))}
                    </ul>
                  </details>
                  <div className="about-downloads">
                    <a href={`${import.meta.env.BASE_URL}landmarks/${model.asset.file}`} download>
                      下载无纹理衍生模型 · {model.credit.license}{model.credit.use && `，${model.credit.use}`}
                    </a>
                    <a href={`${import.meta.env.BASE_URL}landmarks/${model.asset.file.replace(".ttlm.gz", ".json")}`} download>
                      下载来源、校验与处理记录
                    </a>
                  </div>
                </li>
              ))}
            </ul>
          </section>

          <section aria-labelledby="about-catalog-title">
            <h3 id="about-catalog-title">天文目录</h3>
            <ul>
              <li>
                <a href="https://github.com/astronexus/HYG-Database" target="_blank" rel="noreferrer">HYG 4.1 · David Nash / Astronexus · CC BY-SA 4.0</a>
                <p>亮星子集、中文名称及星座连线端点。</p>
                <div className="about-downloads">
                  <a href={starCatalogUrl} download="tamatamatori-bright-stars.json">下载亮星目录</a>
                  <a href={constellationStarsUrl} download="tamatamatori-constellation-stars.json">下载星座端点</a>
                </div>
              </li>
              <li>
                <a href="https://github.com/ofrohn/d3-celestial" target="_blank" rel="noreferrer">d3-celestial · Olaf Frohn · BSD-3-Clause</a>
                <p>星名、星座名称与连线数据，已匹配目录并加入简体中文名称。</p>
                <a href={constellationCatalogUrl} download="tamatamatori-constellations.json">下载星座数据</a>
              </li>
              <li>
                <a href="https://github.com/mattiaverga/OpenNGC" target="_blank" rel="noreferrer">OpenNGC · Mattia Verga · CC BY-SA 4.0</a>
                <p>深空目录及轮廓，含新增目标的独立来源、影像注册和处理记录。</p>
                <a href={deepSkyCatalogUrl} download="tamatamatori-deep-sky.json">下载深空数据及来源清单</a>
              </li>
            </ul>
            <p>日月位置、出没时刻与运行轨迹由 Astronomy Engine 在本机计算。轨迹取拍摄时刻所在的一次出没，在地平线下时取前后 36 小时内最近的一次；每 5 分钟取一点连线，中心落到海平面地平以下的部分不绘制。整点标注按所选时区，只标方向、不判断遮挡；山体或建筑后方的轨迹以淡色虚线表示。</p>
            <p>日食与月食的本地食况（初亏至复圆的时刻、食分与遮挡比例）由 Astronomy Engine 计算，可见与否按海平面地平与所选折射判断，不含地形遮挡。全食、环食的中心食带按日、月几何自行计算，与 NASA（Fred Espenak）路径表对照的差距约 1—4 km，不含月面边缘地形。日食时天空按未遮挡的日面比例变暗，全食按太阳在地平线下 6° 的暮光近似；月食的地影红色深浅取决于地球大气、无法预报，画面为示意色。</p>
          </section>

          <section aria-labelledby="about-meteors-title">
            <h3 id="about-meteors-title">流星雨</h3>
            <ul>
              <li>
                <a href="https://www.imo.net/resources/calendar/" target="_blank" rel="noreferrer">IMO Meteor Shower Calendar 2026 · Jürgen Rendtel 编 · © International Meteor Organization</a>
                <p>摘录表 5“目视流星雨工作表”与表 6 辐射点位置的数值：活动期、极大、辐射点、速度、族群指数和 ZHR。中文名称为本应用翻译。IMO 未给出明示许可，本应用署名摘录这些事实数据，权利人要求时撤下。</p>
              </li>
              <li>
                <a href="https://arxiv.org/abs/1904.06370" target="_blank" rel="noreferrer">Moorhead 等（2019）· NASA 流星体环境办公室流星雨参数表</a>
                <p>有该表参数的流星雨按其上升、衰减指数描述极大前后的 ZHR；其余在活动期两端按降为峰值的十分之一估计。</p>
              </li>
            </ul>
            <p>辐射点按太阳黄经插值，极大时与表 5 一致、漂移取自表 6；两表在天鹅座κ、九月天猫座分别相差约 5°、7°。其他年份沿用 2026 年参数，不预测爆发。</p>
            <p>预估密度按 Koschack 与 Rendtel（1990）把 ZHR 换算为流量，月光采用 Krisciunas 与 Schaefer（1991）模型。假定广角大光圈相机在自然暗夜能记录亮于约 +2 等的流星，天空每亮 10 倍阈值减 1.25 等；光污染按机位天顶值均匀计入。数量按拍摄时刻所在的整晚累计：按机位经度的地方平太阳时，从正午到次日正午，其中太阳低于 −18° 的时段都计入，凌晨的拍摄时刻仍属前一晚。未计山体遮挡、云量、流星角速度对灵敏度的影响和散发流星。预览按后期对齐叠加的成片表现：相机整晚固定在当前构图连续拍摄，含流星的帧按星空对齐到拍摄时刻（锚点帧）后贴回。因此一颗流星要在它出现时位于固定画面内，对齐后也仍落在画面内、地平线以上，才计入数量和示意；所有示意流星都从拍摄时刻的辐射点发散，离拍摄时刻越远、焦距越长，对齐后的有效天区越小。示意流星是按同一模型抽取的固定样本，位置、亮度和数量都不代表实际会出现的流星。</p>
          </section>

          <section aria-labelledby="about-comets-title">
            <h3 id="about-comets-title">彗星</h3>
            <ul>
              <li>
                <a href="https://cobs.si" target="_blank" rel="noreferrer">COBS Comet Observation Database · CC BY-NC-SA 4.0</a>
                <p>彗星亮度参数拟合自 COBS 中世界各地观测者提交的目视总星等：每颗彗星按近日点前、后分别拟合 m = H + 5 log Δ + 2.5 n log r，只保存拟合结果，不含观测者与单条观测。该衍生数据按 CC BY-NC-SA 4.0 提供，仅限非商业使用。</p>
                <a href={`${import.meta.env.BASE_URL}comets/catalog.json`} download="tamatamatori-comets.json">下载彗星目录（含更新状态）</a>
              </li>
              <li>
                <a href="https://ssd.jpl.nasa.gov/horizons/" target="_blank" rel="noreferrer">NASA/JPL Solar System Dynamics · Horizons</a>
                <p>引用格式：NASA/JPL Solar System Dynamics. Data retrieved on（目录更新日期，见彗星目录的 sources.orbit.citation）. Horizons System. https://ssd.jpl.nasa.gov。取每次回归近日点时刻的日心密切根数，本机按二体轨道推算，不含行星摄动与非引力效应。</p>
              </li>
              <li>
                <a href="https://www.projectpluto.com/update7b.htm#comet_tail_formula" target="_blank" rel="noreferrer">Andreas Kammerer · 彗尾长度与彗发直径经验公式（Project Pluto Guide 7）</a>
                <p>按日心星等与日距估算彗尾物理长度和目视彗发直径，原作者称多数情况误差约 30%。</p>
              </li>
            </ul>
            <p>收录 1990 年起近日点、COBS 目视星等夜间中位最亮不暗于 10 等的回归。目录随站点每 3 小时自动检查一次：观测期仍未结束的回归重新拟合，新达到条件的彗星加入，已结束的回归保持不变；周期彗星的新回归与旧回归并存。更新失败时沿用上一份目录并暂停自动更新，预览中会提示。观测夜以外的亮度为外推；仍在回归中的彗星按已有观测外推，实际亮度常有 1 等以上出入，爆发、碎裂与前向散射增亮都不预测。</p>
            <p>彗尾按暗夜长曝光口径：离子尾取经验长度，沿太阳风方向（计入彗星运动造成的偏折）伸直；尘埃尾取一半长度（不超过约 4500 万 km），沿辐射压力为引力一半的尘埃粒子轨迹弯曲，形态与长度比离子尾更近似。两条彗尾都按日、彗、地的实际三维位置投影到画面，因此指向或背向观察者时会缩短，并随焦距缩放。暮光、月光与光污染使天空比自然暗夜每亮 1 等，彗尾末端约少显示 30%。彗尾的亮度、宽度与颜色只作示意。</p>
          </section>

          <section aria-labelledby="about-stations-title">
            <h3 id="about-stations-title">空间站轨道</h3>
            <a href="https://celestrak.org/NORAD/documentation/gp-data-formats.php" target="_blank" rel="noreferrer">CelesTrak · GP 轨道数据 · T.S. Kelso</a>
            <p>选取 ISS 与天宫目录条目，使用 SGP4 推算并生成构图轨迹。快照保留上游历元及检查时间。变轨后的新解发布存在延迟。</p>
            <a href={`${import.meta.env.BASE_URL}orbits/stations.json`} download="tamatamatori-space-stations.json">下载已发布轨道快照及状态</a>
          </section>

          <section aria-labelledby="about-milky-way-title">
            <h3 id="about-milky-way-title">银河影像</h3>
            <a href="https://www.eso.org/public/images/eso0932a/" target="_blank" rel="noreferrer">ESO/S. Brunier · CC BY 4.0</a>
            <p>全景经裁切、缩放、星点压低、降噪、黑位和接缝处理，作为银河结构参考。</p>
          </section>

          <section aria-labelledby="about-deep-sky-title">
            <h3 id="about-deep-sky-title">深空影像</h3>
            <p>以下保留原作者署名与原图许可。影像经天球重投影、缩放及背景处理，部分提取扩散结构、红光增量或暗区对比。衍生 PNG 按 CC BY-SA 4.0 提供，亮度和颜色用于构图参考。</p>
            <ul className="about-image-credits">
              {deepSkyImageCredits.map((source) => {
                const targets = deepSkyCatalog.filter(
                  (entry) => (entry.imageReference ?? entry.catalogId) === source.catalogId,
                );
                return (
                  <li key={source.catalogId} data-credit-source={source.catalogId}>
                    <h4>{targets.map((entry) => entry.name).join(" / ")}</h4>
                    <a href={source.page} target="_blank" rel="noreferrer">{source.credit}</a>
                    <p>{sourceLicenseLabels[source.license] ?? source.license} · 结构与色彩衍生</p>
                    <a
                      href={deepSkyImageUrl(source.catalogId).href}
                      download={`tamatamatori-${source.catalogId.toLowerCase()}.png`}
                    >
                      下载衍生 PNG · CC BY-SA 4.0
                    </a>
                  </li>
                );
              })}
            </ul>
          </section>

          <section aria-labelledby="about-storage-title">
            <h3 id="about-storage-title">本地保存</h3>
            <p>保存的机位和上次的工作状态只存放在此浏览器的本地存储中，不上传、不跨设备同步，清除网站数据即删除。GitHub Pages 上同一域名下的其他页面与本应用共用这份本地存储。</p>
          </section>

          <section aria-labelledby="about-software-title">
            <h3 id="about-software-title">开源软件</h3>
            <ul>
              {libraries.map((library) => (
                <li key={library.name}>
                  <a href={library.url} target="_blank" rel="noreferrer">{library.name}</a>
                  <span> · {library.license}</span>
                </li>
              ))}
            </ul>
            <p>MapLibre 的摄影预览投影与地形补丁修改说明随第三方许可文件分发。</p>
          </section>
        </div>
      </dialog>
    </>
  );
}
