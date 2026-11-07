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
            </ul>
            <p>建筑以周边有限范围的轮廓和渲染高度生成体块；高度可能来自楼层换算或缺省值，不含完整屋顶、实景材质或灯光。基座采用同源 DEM 近似，不保证建筑完整覆盖或楼顶日月对齐精度。</p>
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
            {landmarks.map(model=><div key={model.id} data-landmark-credit={model.id}>
              <a href={model.credit.page} target="_blank" rel="noreferrer">{model.name} · {model.credit.title} · {model.credit.author}</a>
              <p><a href={model.credit.authorPage} target="_blank" rel="noreferrer">{model.credit.author}</a> · <a href={model.credit.licenseUrl} target="_blank" rel="noreferrer">{model.credit.license}</a> · {model.credit.changes}</p>
              <p>{model.credit.registration}</p>
              <p>{model.credit.references.map(ref=><a key={ref.url} href={ref.url} target="_blank" rel="noreferrer">{ref.title} </a>)}</p>
              {model.validation.visual==="pending"&&<p>已完成 CPU 检查，画面待验证。</p>}
              <div className="about-downloads">
                <a href={`${import.meta.env.BASE_URL}landmarks/${model.asset.file}`} download>下载{model.name}无纹理衍生模型 · {model.credit.license}</a>
                <a href={`${import.meta.env.BASE_URL}landmarks/${model.asset.file.replace('.ttlm.gz','.json')}`} download>下载{model.name}来源、校验与处理记录</a>
              </div>
            </div>)}

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
