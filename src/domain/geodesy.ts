/** WGS84 geometric coordinates. Heights MUST be ellipsoidal metres. */
export type EllipsoidalPoint = {
  latitude: number;
  longitude: number;
  ellipsoidalHeight: number;
};

type Vector3 = [number, number, number];
const radians = Math.PI / 180;
// NGA WGS84 defining geometric parameters; not the SDK's mean-radius sphere.
const a = 6378137;
const f = 1 / 298.257223563;
const e2 = f * (2 - f);

export function geodeticEcef(point: EllipsoidalPoint): Vector3 {
  const { latitude, longitude, ellipsoidalHeight: h } = point;
  if (![latitude, longitude, h].every(Number.isFinite) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180)
    throw new RangeError("椭球参考坐标无效");
  const phi = latitude * radians, lambda = longitude * radians;
  const sin = Math.sin(phi), cos = Math.cos(phi);
  const n = a / Math.sqrt(1 - e2 * sin * sin);
  return [(n + h) * cos * Math.cos(lambda), (n + h) * cos * Math.sin(lambda), (n * (1 - e2) + h) * sin];
}

/** Inverse of `geodeticEcef` (iterative; not meant for the poles' immediate neighbourhood). */
export function ecefGeodetic([x, y, z]: readonly [number, number, number]): EllipsoidalPoint {
  const p = Math.hypot(x, y);
  let phi = Math.atan2(z, p * (1 - e2)), h = 0;
  for (let pass = 0; pass < 8; pass++) {
    const sin = Math.sin(phi), n = a / Math.sqrt(1 - e2 * sin * sin);
    h = p / Math.cos(phi) - n;
    phi = Math.atan2(z, p * (1 - (e2 * n) / (n + h)));
  }
  return { latitude: phi / radians, longitude: Math.atan2(y, x) / radians, ellipsoidalHeight: h };
}

/** Straight target ray in the observer's geodetic ENU basis; no air refraction. */
export function ellipsoidalRay(eye: EllipsoidalPoint, target: EllipsoidalPoint): Vector3 {
  const origin = geodeticEcef(eye), destination = geodeticEcef(target);
  const [x, y, z] = destination.map((v, i) => v - origin[i]);
  const phi = eye.latitude * radians, lambda = eye.longitude * radians;
  const sinPhi = Math.sin(phi), cosPhi = Math.cos(phi), sinLambda = Math.sin(lambda), cosLambda = Math.cos(lambda);
  return [-sinLambda * x + cosLambda * y,
    -sinPhi * cosLambda * x - sinPhi * sinLambda * y + cosPhi * z,
    cosPhi * cosLambda * x + cosPhi * sinLambda * y + sinPhi * z];
}
