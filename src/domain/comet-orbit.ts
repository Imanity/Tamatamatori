/**
 * Two-body comet motion, magnitudes and the empirical coma/tail sizes.
 *
 * Elements are JPL heliocentric osculating elements referred to the IAU 1976
 * J2000 ecliptic; positions come out in the J2000 mean equator (Astronomy
 * Engine's EQJ). Time arguments are Julian dates in TT, treated as TDB.
 */
export type Vector3 = readonly [number, number, number];
export interface CometElements {
  /** Perihelion distance, au. */
  q: number;
  e: number;
  /** Time of perihelion, JD (TDB). */
  tp: number;
  /** Longitude of the ascending node, argument of perihelion and inclination, degrees. */
  node: number;
  peri: number;
  incl: number;
}
export interface MagnitudeLaw {
  /** m = H + 5 log Δ + 2.5 n log r */
  H: number;
  n: number;
  /**
   * Distances from the Sun (au) the law was fitted over. Outside them the
   * magnitude keeps its value at the nearer end: an unobserved approach to a
   * sungrazing perihelion must not brighten without limit.
   */
  range?: readonly [number, number];
}
export interface CometPhotometry {
  pre: MagnitudeLaw;
  post: MagnitudeLaw;
}

/** Gaussian gravitational constant squared, au³/day². */
export const GM_SUN = 0.01720209895 ** 2;
export const AU_KM = 149_597_870.7;
export const C_AU_PER_DAY = 173.1446326846693;
/** Days over which the pre- and post-perihelion magnitude laws are blended. */
export const PERIHELION_BLEND_DAYS = 5;
const RAD = Math.PI / 180;
const OBLIQUITY = 23.4392911 * RAD;

const dot = (a: Vector3, b: Vector3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const length = (a: Vector3) => Math.hypot(a[0], a[1], a[2]);
const combine = (a: Vector3, x: number, b: Vector3, y: number): Vector3 =>
  [a[0] * x + b[0] * y, a[1] * x + b[1] * y, a[2] * x + b[2] * y];

function stumpff(z: number): [number, number] {
  if (z > 1e-4) {
    const s = Math.sqrt(z);
    return [(1 - Math.cos(s)) / z, (s - Math.sin(s)) / (s * z)];
  }
  if (z < -1e-4) {
    const s = Math.sqrt(-z);
    return [(Math.cosh(s) - 1) / -z, (Math.sinh(s) - s) / (s * -z)];
  }
  return [1 / 2 - z / 24 + (z * z) / 720, 1 / 6 - z / 120 + (z * z) / 5040];
}

/**
 * Universal-variable Kepler propagation for any conic. The Kepler function is
 * monotonic in the universal anomaly, so the root is bracketed and refined by
 * Newton steps that fall back to bisection.
 */
export function propagate(r0: Vector3, v0: Vector3, dt: number, mu = GM_SUN): { r: Vector3; v: Vector3 } {
  if (![...r0, ...v0, dt, mu].every(Number.isFinite) || mu <= 0) throw new RangeError("轨道状态无效");
  if (dt === 0) return { r: r0, v: v0 };
  const rn = length(r0), sq = Math.sqrt(mu);
  const sigma = dot(r0, v0) / sq, alpha = 2 / rn - dot(v0, v0) / mu, target = sq * dt;
  const kepler = (x: number) => {
    const z = alpha * x * x, [C, S] = stumpff(z);
    return {
      F: sigma * x * x * C + (1 - alpha * rn) * x * x * x * S + rn * x - target,
      dF: sigma * x * (1 - z * S) + (1 - alpha * rn) * x * x * C + rn,
      C, S,
    };
  };
  // F(0) = -target, so the root has the sign of dt.
  let lo = 0, hi = dt > 0 ? target / rn : target / rn;
  if (dt < 0) [lo, hi] = [hi, 0];
  for (let k = 0; k < 200; k++) {
    const edge = dt > 0 ? hi : lo, F = kepler(edge).F;
    if (dt > 0 ? F > 0 || !Number.isFinite(F) : F < 0 || !Number.isFinite(F)) break;
    if (dt > 0) { lo = hi; hi *= 2; } else { hi = lo; lo *= 2; }
    if (k === 199) throw new RangeError("轨道传播无法收敛");
  }
  let x = (lo + hi) / 2;
  for (let k = 0; k < 200; k++) {
    const { F, dF } = kepler(x);
    if (!Number.isFinite(F)) { (dt > 0 ? (hi = x) : (lo = x)); x = (lo + hi) / 2; continue; }
    if (F > 0) hi = x; else lo = x;
    let next = x - F / dF;
    if (!(next > lo && next < hi)) next = (lo + hi) / 2;
    if (Math.abs(next - x) <= 1e-14 * Math.max(1, Math.abs(x)) || hi - lo <= 1e-15 * Math.max(1, Math.abs(x))) { x = next; break; }
    x = next;
  }
  const { C, S } = kepler(x), z = alpha * x * x;
  const f = 1 - (x * x / rn) * C, g = dt - (x * x * x * S) / sq;
  const r = combine(r0, f, v0, g), rr = length(r);
  const fdot = (sq / (rr * rn)) * (z * S - 1) * x, gdot = 1 - (x * x / rr) * C;
  return { r, v: combine(r0, fdot, v0, gdot) };
}

const toEquator = (v: Vector3): Vector3 => [
  v[0],
  v[1] * Math.cos(OBLIQUITY) - v[2] * Math.sin(OBLIQUITY),
  v[1] * Math.sin(OBLIQUITY) + v[2] * Math.cos(OBLIQUITY),
];

const perihelionCache = new WeakMap<CometElements, { r: Vector3; v: Vector3 }>();
/** Position and velocity at perihelion in the J2000 equator. */
export function perihelionState(el: CometElements) {
  const cached = perihelionCache.get(el);
  if (cached) return cached;
  if (!(el.q > 0) || !(el.e >= 0) || ![el.tp, el.node, el.peri, el.incl].every(Number.isFinite))
    throw new RangeError("彗星轨道根数无效");
  const [cO, sO, cw, sw, ci, si] = [el.node, el.node, el.peri, el.peri, el.incl, el.incl]
    .map((angle, k) => (k % 2 ? Math.sin : Math.cos)(angle * RAD));
  const P: Vector3 = [cO * cw - sO * sw * ci, sO * cw + cO * sw * ci, sw * si];
  const Q: Vector3 = [-cO * sw - sO * cw * ci, -sO * sw + cO * cw * ci, cw * si];
  const speed = Math.sqrt((GM_SUN * (1 + el.e)) / el.q);
  const state = { r: toEquator(combine(P, el.q, P, 0)), v: toEquator(combine(Q, speed, Q, 0)) };
  perihelionCache.set(el, state);
  return state;
}

/** Heliocentric position (au) and velocity (au/day) in the J2000 equator. */
export function cometState(el: CometElements, jd: number) {
  const start = perihelionState(el);
  return propagate(start.r, start.v, jd - el.tp);
}

/** The magnitude law at a date: separate fits before and after perihelion, blended across it. */
export function magnitudeLaw(photometry: CometPhotometry, tp: number, jd: number): MagnitudeLaw {
  const t = Math.max(0, Math.min(1, (jd - tp + PERIHELION_BLEND_DAYS) / (2 * PERIHELION_BLEND_DAYS)));
  const w = t * t * (3 - 2 * t), a = photometry.pre, b = photometry.post;
  const mix = (x: number, y: number) => x * (1 - w) + y * w;
  return {
    H: mix(a.H, b.H),
    n: mix(a.n, b.n),
    ...(a.range && b.range ? { range: [mix(a.range[0], b.range[0]), mix(a.range[1], b.range[1])] as const } : {}),
  };
}
/** Magnitude reduced to 1 au from the observer ("heliocentric magnitude"). */
export const heliocentricMagnitude = (law: MagnitudeLaw, r: number) =>
  law.H + 2.5 * law.n * Math.log10(law.range ? Math.max(law.range[0], Math.min(law.range[1], r)) : r);
export const totalMagnitude = (law: MagnitudeLaw, r: number, delta: number) =>
  heliocentricMagnitude(law, r) + 5 * Math.log10(delta);

/**
 * Kammerer's empirical sizes (Project Pluto, Guide 7 update): tail length in
 * millions of km and visual coma diameter in thousands of km from the
 * heliocentric magnitude and the distance from the Sun. Both are stated to be
 * good to about 30 % in most cases; the tail formula does not distinguish
 * gas from dust tails.
 */
export function tailLengthAu(heliocentric: number, r: number) {
  const L0 = 10 ** (-0.0075 * heliocentric * heliocentric - 0.19 * heliocentric + 2.1);
  return (L0 * (1 - 10 ** (-4 * r)) * (1 - 10 ** (-2 * r)) * 1e6) / AU_KM;
}
export function comaDiameterKm(heliocentric: number, r: number) {
  const D0 = 10 ** (-0.0033 * heliocentric * heliocentric - 0.07 * heliocentric + 3.25);
  return D0 * (1 - 10 ** (-2 * r)) * (1 - 10 ** -r) * 1000;
}
