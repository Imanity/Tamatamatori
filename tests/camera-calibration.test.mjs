import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "vite";
import { MercatorCoordinate } from "maplibre-gl";
import { terrainCamera } from "../src/preview/camera.ts";
import { signedAngle } from "../src/domain/plan.ts";
import { terrainScenes } from "./fixtures/terrain-scenes.mjs";

// Exercise the installed SDK's real CPU camera/transform, not the interaction
// test double. No browser, GL context, image decoder or real DEM is simulated.
let server, Camera;
before(async () => {
  server = await createServer({
    configFile: false,
    cacheDir: "node_modules/.vite-camera-validation",
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { middlewareMode: true },
    appType: "custom",
    ssr: { noExternal: ["maplibre-gl"] },
    // Match the SDK build's assignment semantics: its derived event classes
    // narrow `type` without initializing it. Emitting an undefined field would
    // erase the parent constructor's event type and break moveend cleanup.
    oxc: {
      assumptions: { setPublicClassFields: true },
      typescript: { removeClassFieldsWithoutInitializer: true },
    },
  });
  ({ Camera } = await server.ssrLoadModule("/node_modules/maplibre-gl/src/ui/camera.ts"));
});
after(async () => { await server?.close(); });

function close(actual, expected, tolerance, message) {
  assert.ok(Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance,
    `${message}: ${actual} vs ${expected} (tolerance ${tolerance})`);
}

function flatTerrain(height) {
  return {
    exaggeration: 1,
    getCoverageIndex: () => null,
    getMinTileElevationForLngLatZoom: () => height,
    getElevationForLngLat: () => height,
    getElevationAndDEMStateForLngLat: () => ({ elevation: height, demState: "loaded" }),
  };
}

function createCamera(width, height, ground) {
  const camera = new Camera({
    minZoom: 0, maxZoom: 32, minPitch: 0, maxPitch: 180,
    bearingSnap: 0, zoomSnap: 0, terrain: null,
    centerClampedToGround: false, transformConstrain: null,
    requestRenderFrame: () => 0, cancelRenderFrame: () => {},
    transformCameraUpdate: null,
  });
  camera.transform.resize(width, height, true);
  camera.setTerrain(flatTerrain(ground));
  return camera;
}

function apply(camera, plan, ground) {
  const pose = terrainCamera(plan, ground);
  camera.setVerticalFieldOfView(pose.verticalFov);
  const options = camera.transform.calculateCameraOptionsFromTo(
    pose.eye, pose.altitude, pose.target, pose.targetAltitude,
  );
  camera.jumpTo({ ...options, bearing: pose.bearing, pitch: pose.pitch, roll: 0 });
  assert.equal(camera._requestedCameraState, undefined, "SDK moveend must release the proposed transform");
  return pose;
}

function assertEye(camera, plan, ground) {
  const requested = MercatorCoordinate.fromLngLat([plan.longitude, plan.latitude], ground + plan.cameraHeight);
  const actual = MercatorCoordinate.fromLngLat(camera.transform.getCameraLngLat(), camera.transform.getCameraAltitude());
  const meters = requested.meterInMercatorCoordinateUnits();
  close(Math.hypot(actual.x - requested.x, actual.y - requested.y) / meters, 0, 0.02, "final eye ground position / m");
  close(camera.transform.getCameraAltitude(), ground + plan.cameraHeight, 0.02, `final eye altitude / m (${plan.azimuth}/${plan.pitch}/${plan.focalLength}/${plan.orientation})`);
  close(signedAngle(camera.getBearing() - plan.azimuth), 0, 1e-6, "final bearing / degree");
  close(camera.getPitch(), 90 + plan.pitch, 1e-6, "final pitch / degree");
}

// Independent pinhole baseline: build a ray from full-frame sensor dimensions,
// focal length and ENU basis. The point must project to the requested pixel.
function rayPoint(plan, ground, nx, ny, distance = 1000) {
  const heading = plan.azimuth * Math.PI / 180, pitch = plan.pitch * Math.PI / 180;
  const sensorWidth = plan.orientation === "portrait" ? 24 : 36;
  const sensorHeight = plan.orientation === "portrait" ? 36 : 24;
  const right = nx * sensorWidth / (2 * plan.focalLength);
  const up = -ny * sensorHeight / (2 * plan.focalLength);
  const east = Math.sin(heading) * Math.cos(pitch) + right * Math.cos(heading) - up * Math.sin(heading) * Math.sin(pitch);
  const north = Math.cos(heading) * Math.cos(pitch) - right * Math.sin(heading) - up * Math.cos(heading) * Math.sin(pitch);
  const vertical = Math.sin(pitch) + up * Math.cos(pitch);
  const eye = MercatorCoordinate.fromLngLat([plan.longitude, plan.latitude], ground + plan.cameraHeight);
  const scale = distance * eye.meterInMercatorCoordinateUnits();
  const point = new MercatorCoordinate(eye.x + east * scale, eye.y - north * scale);
  // MapLibre's planar terrain matrix scales elevations in meters at the
  // center latitude; keep the independent ray in that local vertical system.
  return { point: point.toLngLat(), altitude: ground + plan.cameraHeight + distance * vertical };
}

for (const scene of terrainScenes) {
  test(`真实 SDK 相机校准：${scene.name}，广角至长焦与横竖幅`, () => {
    for (const focalLength of [8, 35, 200, 1000])
      for (const orientation of ["landscape", "portrait"])
        for (const cameraHeight of [0.1, 1.6, 10]) {
          const plan = { ...scene.plan, focalLength, orientation, cameraHeight };
          const [width, height] = orientation === "portrait" ? [400, 600] : [600, 400];
          const camera = createCamera(width, height, scene.syntheticGround);
          apply(camera, plan, scene.syntheticGround);
          assertEye(camera, plan, scene.syntheticGround);
          for (const [nx, ny] of [[0, 0], [-0.6, -0.5], [0.6, 0.5]]) {
            const reference = rayPoint(plan, scene.syntheticGround, nx, ny);
            const pixel = camera.transform.locationToScreenPoint(reference.point, flatTerrain(reference.altitude));
            close(pixel.x, width * (1 + nx) / 2, 0.1, "pinhole projection x / CSS px");
            close(pixel.y, height * (1 + ny) / 2, 0.1, "pinhole projection y / CSS px");
          }
        }
  });
}

test("真实 SDK 在尺寸调整、旋转和向上/下观察后仍保持机位", () => {
  const { plan, syntheticGround } = terrainScenes[0];
  const camera = createCamera(600, 400, syntheticGround);
  for (const [width, height] of [[600, 400], [960, 640], [300, 450]])
    for (const pitch of [-90, -45, 0, 35, 90])
      for (const azimuth of [0, 90, 247, 359.9]) {
        const next = { ...plan, pitch, azimuth, orientation: width < height ? "portrait" : "landscape" };
        camera.transform.resize(width, height, true);
        apply(camera, next, syntheticGround);
        assertEye(camera, next, syntheticGround);
        const reference = rayPoint(next, syntheticGround, 0.6, -0.5);
        const pixel = camera.transform.locationToScreenPoint(reference.point, flatTerrain(reference.altitude));
        close(pixel.x, width * 0.8, 0.1, "resized projection x / CSS px");
        close(pixel.y, height * 0.25, 0.1, "resized projection y / CSS px");
      }
});
