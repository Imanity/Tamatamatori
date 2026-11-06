/** Display contrast only: coefficients are artistic, not calibrated photometry. */
const clamp = (value: number) => Math.max(0, Math.min(1, value));
const smoothstep = (low: number, high: number, value: number) => {
  const t = clamp((value - low) / (high - low));
  return t * t * (3 - 2 * t);
};
const solarStops = [
  [-18, 5.5],
  [-12, 4],
  [-6, 1.5],
  [0, -4.5],
] as const;
type Moon = { elevation: number; illuminatedFraction: number };

export function skyAppearance(
  sunElevation: number,
  moon: Moon,
  artificialMcd = 0,
) {
  if (
    !Number.isFinite(sunElevation) ||
    Math.abs(sunElevation) > 90 ||
    !Number.isFinite(moon.elevation) ||
    Math.abs(moon.elevation) > 90 ||
    !Number.isFinite(moon.illuminatedFraction) ||
    moon.illuminatedFraction < 0 ||
    moon.illuminatedFraction > 1 ||
    !Number.isFinite(artificialMcd) ||
    artificialMcd < 0
  )
    throw new RangeError("星空明暗需要有效的日月高度与月亮亮面比例");
  const elevation = Math.max(-18, Math.min(0, sunElevation));
  const index = solarStops.findIndex(([height]) => height >= elevation);
  const a = solarStops[Math.max(0, index - 1)],
    b = solarStops[index];
  const blend = a === b ? 0 : smoothstep(a[0], b[0], elevation);
  const night = 1 - smoothstep(-18, -6, sunElevation);
  const moonlight =
    moon.illuminatedFraction ** 2 *
    Math.sqrt(Math.sin((Math.max(0, moon.elevation) * Math.PI) / 180));
  // Solar and lunar contrast multiply; fading the lunar penalty independently
  // at dawn would incorrectly make bright stars brighten while the Sun rises.
  const solarScale =
    (1 - 0.65 * smoothstep(-18, 0, sunElevation)) *
    (1 - smoothstep(-2, 0, sunElevation));
  const baseMagnitude = a[1] + (b[1] - a[1]) * blend - 2.5 * moonlight;
  // The atlas supplies artificial zenith luminance in mcd/m². Its natural
  // reference is 0.174 mcd/m². Preserve the existing twilight/Moon display
  // response, then add the artificial component in linear brightness space.
  const background = 0.174 * 10 ** (0.4 * (5.5 - baseMagnitude));
  const contrast = background / (background + artificialMcd);
  // Opacity gains remain independent and monotone. A growing Moon or twilight
  // must not make a target brighten as its share of the total skyglow shrinks.
  const artificialContrast = 0.174 / (0.174 + artificialMcd);
  return {
    sunElevation,
    moonlight,
    artificialMcd,
    pollutionGlow: night * (1 - Math.sqrt(artificialContrast)),
    displayMagnitude: baseMagnitude + 2.5 * Math.log10(contrast),
    starScale: solarScale * (1 - 0.45 * moonlight) * artificialContrast ** 0.25,
    galaxyStrength: night * (1 - 0.92 * moonlight) * artificialContrast,
  };
}
export type SkyAppearance = ReturnType<typeof skyAppearance>;
export const STAR_LABEL_ALPHA = 0.06;
export function starOpacity(
  point: { id: string; magnitude: number },
  appearance: SkyAppearance,
) {
  // An empty ring marks a direction, not the brightness of an optical source.
  if (point.id === "galactic-center") return 1;
  if (!Number.isFinite(point.magnitude))
    throw new RangeError("星点需要有效星等");
  const base = Math.max(
    0.45,
    Math.min(1, 0.45 + (4.5 - point.magnitude) * 0.08),
  );
  return (
    base *
    appearance.starScale *
    (1 -
      smoothstep(
        appearance.displayMagnitude - 0.6,
        appearance.displayMagnitude + 0.6,
        point.magnitude,
      ))
  );
}
export function skyAppearanceLabel(appearance: SkyAppearance) {
  if (appearance.sunElevation >= 0) return "白昼 · 星点与银河淡出";
  if (appearance.sunElevation >= -6) return "暮光较亮 · 星点减少";
  if (appearance.sunElevation > -18) return "暮光减弱";
  if (appearance.pollutionGlow > 0.04)
    return appearance.moonlight > 0.02 ? "月光与光污染影响" : "光污染影响";
  return appearance.moonlight > 0.02 ? "月光减弱" : "暗夜参考";
}
