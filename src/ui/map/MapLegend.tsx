// The legend under the map: which lines and areas are drawn, with the details in tooltips.
import type { BodyLine } from "../../domain/sun-moon/body-lines";
import { bodyColors, bodyNames } from "./map-overlays";
import type { EclipseMap } from "./map-overlays";

export function MapLegend({ lines, eclipse, auroraKp, tideCell, alignmentFeatures }: {
  lines: BodyLine[];
  eclipse: EclipseMap;
  auroraKp: number | null;
  tideCell: object | null;
  alignmentFeatures: GeoJSON.FeatureCollection;
}) {
  if (!(lines.length > 0 || eclipse || auroraKp !== null || tideCell || alignmentFeatures.features.length > 0)) return null;
  return (
    <div className="map-legend" aria-label="方位线图例">
      {(["sun", "moon", "core"] as const).filter((body) => lines.some((line) => line.body === body)).map((body) => (
        <span key={body}><i style={{ background: bodyColors[body] }} />{bodyNames[body]}</span>
      ))}
      {lines.length > 0 && <span className="map-legend-note" title="粗实线：拍摄时刻方位；点线：拍摄时刻在地平线下；细虚线：时间轴时段内的出没方位。只表示方向，不表示距离与遮挡。">粗线此刻 · 细线出没</span>}
      {eclipse && <span data-eclipse-legend title="中心食带：两侧界线之间可见全食或环食，虚线为中心线，深色为拍摄时刻的本影位置。不含月面边缘地形（界线约有 1—3 km 出入）。">
        <i className="map-legend-band" />{eclipse.kind === "total" ? "全食带" : eclipse.kind === "annular" ? "环食带" : "全环食带"}
      </span>}
      {auroraKp !== null && <span data-aurora-legend title="实线：拍摄时刻 Kp 下极光带的赤道侧边界（Carbary 2005，偏心偶极地磁坐标）；虚线：200 km 高的极光顶部高出地平线 5° 的可见线。绿色块为 OVATION 临近预报的极光概率。均为近似。">
        <i className="map-legend-aurora" />极光带 · 虚线可见
      </span>}
      {tideCell && <span data-tide-legend title="潮位所用的海洋格点（约 8 km）"><i className="map-legend-tide" />潮位格点</span>}
      {alignmentFeatures.features.length > 0 && (alignmentFeatures.features.some((feature) => feature.properties?.kind === "area")
        ? <span data-alignment-legend title="红点为地面目标，虚线圈为机位范围。“机位 N”处两个地面点各在设定的画面位置（与时间无关），淡红色范围内第二个点不超出容差；遮挡只看地形，不含建筑、树木与天气。">
          <i className="map-legend-target" />目标 · 机位与容差内范围
        </span>
        : <span data-alignment-legend title="红点为地面目标，虚线圈为机位范围，淡色扇形为所选日期内机位可能所在的方位。线上每个机位，在标注的时刻看到各目标落在设定的画面位置；颜色由浅到深按日期先后，加粗的是正在试看的一段，另标每 10 分钟。视线被地形挡住的分钟不画；遮挡只看地形，不含建筑、树木与天气。">
          <i className="map-legend-target" />目标 · 线上各点在标注时刻对齐
        </span>
      )}
    </div>
  );
}
