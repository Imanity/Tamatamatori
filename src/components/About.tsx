import { useRef } from "react";
import { Icon } from "./Icon";
import starCatalogUrl from "../data/bright-stars.json?url";
import constellationCatalogUrl from "../data/constellations.json?url";
import constellationStarsUrl from "../data/constellation-stars.json?url";
import deepSkyCatalogUrl from "../data/deep-sky.json?url";
import { deepSkyCatalog, deepSkyImageCredits } from "../domain/deep-sky";
import { deepSkyImageUrl } from "../preview/deep-sky-texture";

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
                <span> · 底图与水体瓦片服务</span>
              </li>
              <li>
                <a href="https://openmaptiles.org/" target="_blank" rel="noreferrer">© OpenMapTiles</a>
                <span> · 地图数据结构与样式</span>
              </li>
              <li>
                <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">© OpenStreetMap contributors</a>
                <span> · ODbL · 底图与水体数据</span>
              </li>
              <li>
                <a href="https://mapterhorn.com/attribution/" target="_blank" rel="noreferrer">© Mapterhorn · 高程及上游数据来源</a>
              </li>
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
