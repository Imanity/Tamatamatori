import { sensors } from "../../domain/core/plan";
import type { Shot } from "../../domain/shots/shot";

// Short descriptions of a shot, shared by the shot menu and the map card.
/** Local date and time with the zone, e.g. "2026-11-25 16:13 · Asia/Tokyo（当地）". */
export const shotTimeText = (shot: Shot) =>
  `${shot.time.local.slice(0, 16).replace("T", " ")} · ${shot.time.timeZone}${shot.time.followLocalZone ? "（当地）" : ""}`;
/** Focal length, sensor, orientation and ratio. */
export const shotLensText = (shot: Shot) =>
  `${shot.camera.focalLength} mm · ${shot.camera.sensor === "custom" ? `自定义 ${shot.camera.sensorSize?.width}×${shot.camera.sensorSize?.height} mm` : sensors[shot.camera.sensor].label.split(" · ")[0]} · ${shot.camera.orientation === "portrait" ? "竖幅" : "横幅"} ${shot.camera.aspectRatio}`;
