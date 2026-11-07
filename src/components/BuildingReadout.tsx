import type { BuildingStatus } from "../domain/buildings";
import { BUILDING_MAX_TRIANGLES } from "../domain/buildings";
import { LANDMARK_RADIUS } from "../domain/landmarks";

export function BuildingReadout({status,retry}:{status:BuildingStatus;retry:()=>void}) {
  const phase=status.phase;
  return <div className="building-readout" aria-label="建筑数据状态" data-building-phase={phase}>
    <p role="status">{phase==="off"?"建筑已关闭":phase==="loading"?"正在读取周边建筑…":phase==="error"?`建筑未应用 · ${status.message}`:
      phase==="empty"?"所取区域未返回可用建筑体块":"建筑体块已应用"}</p>
    {phase!=="off"&&<>
      <p>普通建筑：近景约 2 km，远景至约 5 km、高度 ≥20 m · 已接入地标至约 {LANDMARK_RADIUS/1000} km</p>
      {status.limited&&<p role="status">已达范围或网格预算，建筑覆盖不完整。</p>}
      {(phase==="ready"||phase==="empty")&&<>
        {status.landmarks?.map(item=><p key={item.id} role="status" data-landmark-id={item.id} data-landmark-phase={item.phase}>{item.message}{` · 约 ${(item.distance/1000).toFixed(1)} km`}{item.triangles!==undefined&&` · ${item.triangles.toLocaleString()} 面`}</p>)}
        <div className="preview-readout">
          <span>已读取瓦片 <strong>{status.tiles}</strong></span><span>分块体块 <strong>{status.polygons}{status.candidates!==undefined&&` / ${status.candidates}`}</strong></span>
          <span>三角面（含地标） <strong>{status.triangles.toLocaleString()} / {BUILDING_MAX_TRIANGLES.toLocaleString()}</strong></span><span>网格 <strong>{(status.bytes/1048576).toFixed(2)} MiB</strong></span>
        </div>
        {status.distant!==undefined&&<p>2–5 km 普通远景分部 {status.distant} / {status.distantCandidates} · 普通建筑在 5 km 外未加载。</p>}
        {status.landmarks?.some(item=>item.phase==="applied")&&<p>地标仍受地形、已载建筑及雾影响，距离范围不代表一定可见。</p>}
        {!!status.removedPoints&&<p>已清理 {status.removedPoints.toLocaleString()} 个重复或共线点，保留源轮廓。</p>}
        {status.candidates!==undefined&&status.candidates>status.polygons&&<p>预算内优先保留高层并分配周边覆盖，省略 {status.candidates-status.polygons} 个分部。</p>}
        <p>来源版本 {status.version} · 高度可能由楼层推算或缺省生成，屋顶为简化平面。</p>
        {status.fetchedAt&&<p>本次载入 {new Date(status.fetchedAt).toISOString().replace("T"," ").replace(/\.\d+Z$/," UTC")}</p>}
        {status.skipped>0&&<p>已略过 {status.skipped} 个隐藏轮廓、非面或高度无效要素。</p>}
      </>}
      <p><a href="https://openfreemap.org/" target="_blank" rel="noreferrer">OpenFreeMap</a> · <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">© OpenStreetMap contributors</a></p>
      {phase==="error"&&<p>建筑遮挡未知；地形预览继续显示。</p>}
      {phase!=="loading"&&<button type="button" onClick={retry}>重新读取建筑</button>}
    </>}
  </div>;
}
