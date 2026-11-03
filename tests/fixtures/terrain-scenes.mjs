// Public-area candidate viewpoints for repeatable validation. Ground heights
// below are synthetic CPU-test inputs, not sampled or surveyed elevations.
const common = {
  cameraHeight: 1.6,
  focalLength: 35,
  sensor: "full-frame",
  aspectRatio: "3:2",
  orientation: "landscape",
  instant: "2026-11-04T03:00:00Z",
  timeZone: "Asia/Tokyo",
};

export const terrainScenes = [
  {
    id: "fuji",
    name: "山中湖附近朝富士山",
    plan: { ...common, latitude: 35.4172, longitude: 138.8729, azimuth: 247, pitch: 4 },
    syntheticGround: 980,
    target: {
      name: "富士山剣ヶ峰公开参考点",
      latitude: 35.36083333333333,
      longitude: 138.7275,
      altitude: 3776,
      source: "https://www.data.jma.go.jp/vois/data/tokyo/314_Fujisan/314_index.html",
    },
  },
  {
    id: "lake",
    name: "河口湖北岸附近向南",
    plan: { ...common, latitude: 35.5222, longitude: 138.764, azimuth: 180, pitch: 0 },
    syntheticGround: 840,
  },
  {
    id: "plain",
    name: "霞浦西岸附近向东",
    plan: { ...common, latitude: 36.0248, longitude: 140.1854, azimuth: 90, pitch: 0 },
    syntheticGround: 4,
  },
];
