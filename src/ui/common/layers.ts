import type { IconName } from "./Icon";
import type { ShootingPlan } from "../../domain/core/plan";

type LayerKey = "buildings" | "sun" | "moon" | "stars" | "milkyWay" | "deepSky" | "stations" | "meteors" | "comets" | "aurora" | "tides";

/** Layers switched from the heading of their information group, in panel order. */
export const layerGroups: readonly { id: LayerKey & keyof ShootingPlan["layers"]; name: string; icon: IconName }[] = [
  { id: "buildings", name: "建筑", icon: "building" },
  { id: "sun", name: "太阳", icon: "sun" },
  { id: "moon", name: "月亮", icon: "moon" },
  { id: "stars", name: "星空", icon: "stars" },
  { id: "milkyWay", name: "银河", icon: "orbit" },
  { id: "deepSky", name: "深空天体", icon: "orbit" },
  { id: "stations", name: "空间站", icon: "satellite" },
  { id: "meteors", name: "流星雨", icon: "meteor" },
  { id: "comets", name: "彗星", icon: "comet" },
  { id: "aurora", name: "极光", icon: "aurora" },
  { id: "tides", name: "潮汐", icon: "tide" },
];
export type LayerGroupId = LayerKey;
