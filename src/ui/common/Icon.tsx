import type { CSSProperties } from "react";

const paths = {
  building: "M4 21V7h7v14M11 21V3h9v18M2 21h20M7 10h1m-1 4h1m-1 4h1m6-12h3m-3 4h3m-3 4h3m-3 4h3",
  camera:
    "M14 4h-4L8 7H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-4l-2-3ZM16 13a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z",
  map: "m9 18-6 3V6l6-3 6 3 6-3v15l-6 3-6-3Zm0 0V3m6 3v15",
  layers: "m12 3 10 5-10 5L2 8l10-5ZM2 12l10 5 10-5M2 16l10 5 10-5",
  sun: "M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z",
  moon: "M20.9 13A9 9 0 0 1 11 3.1 9 9 0 1 0 20.9 13Z",
  stars:
    "m12 3 2.2 6.8L21 12l-6.8 2.2L12 21l-2.2-6.8L3 12l6.8-2.2L12 3ZM20 2v4m-2-2h4",
  orbit:
    "M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0ZM3 19C0 15 14 1 19 3s-6 20-13 18m12-2 3 3m-1-4 2 3",
  satellite:
    "m8 8 8 8m-9-4 5-5 5 5-5 5-5-5ZM2 5l3-3 4 4-3 3-4-4Zm13 13 3-3 4 4-3 3-4-4ZM15 2a7 7 0 0 1 7 7m-7-3a3 3 0 0 1 3 3",
  compass:
    "M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0ZM16 8l-2.5 5.5L8 16l2.5-5.5L16 8Z",
  settings: "M4 7h16M4 17h16M8 4v6m8 4v6",
  grip: "M9 5h.01M15 5h.01M9 12h.01M15 12h.01M9 19h.01M15 19h.01",
  swap: "M4 8h15m-4-4 4 4-4 4M20 16H5m4-4-4 4 4 4",
  search: "M11 18a7 7 0 1 1 0-14 7 7 0 0 1 0 14Zm5-2 5 5",
  locate: "M12 2v3m0 14v3M2 12h3m14 0h3M18 12a6 6 0 1 1-12 0 6 6 0 0 1 12 0Zm-4 0a2 2 0 1 1-4 0 2 2 0 0 1 4 0Z",
  reset: "M3 10a9 9 0 1 1 2 8M3 4v6h6",
  pin: "M19 10c0 5-7 11-7 11S5 15 5 10a7 7 0 1 1 14 0ZM14 10a2 2 0 1 1-4 0 2 2 0 0 1 4 0Z",
  arrow: "M5 12h14m-5-5 5 5-5 5",
  grid: "M3 8h18M3 16h18M8 3v18m8-18v18",
  light: "M9 18h6m-5 3h4M8 14a6 6 0 1 1 8 0c-1 1-1 2-1 2H9s0-1-1-2ZM12 1v2M2 9h2m16 0h2M4 3l2 2m12 0 2-2",
  cloud: "M6 17a4 4 0 1 1 1-7.9 6 6 0 0 1 11.8 1A3.5 3.5 0 1 1 19 17H6Zm2 3-1 2m6-2-1 2m6-2-1 2",
  info: "M12 11v6m0-10h.01M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z",
  bookmark: "M6 3.5h12v17l-6-4.2-6 4.2v-17Z",
  chevron: "m6 9 6 6 6-6",
  meteor: "M20 5a2 2 0 1 1-4 0 2 2 0 0 1 4 0ZM16.5 6.5 4 19M12.5 6 7 11.5M18 11.5 12.5 17",
  tide: "M2 9c2.5 0 2.5-2 5-2s2.5 2 5 2 2.5-2 5-2 2.5 2 5 2M2 14c2.5 0 2.5-2 5-2s2.5 2 5 2 2.5-2 5-2 2.5 2 5 2M2 19c2.5 0 2.5-2 5-2s2.5 2 5 2 2.5-2 5-2 2.5 2 5 2",
  aurora: "M3 20c2-6 3-12 6-15m-2 15c1-5 3-10 6-13m-1 13c1-4 3-8 7-11M17 20c.5-2 2-4 4-5",
  comet: "M19 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0ZM13.5 15.5C10 12 6 8 3 3m11.5 11C12 10 9 6 7 3m9.5 12.5C16 12 15 8 14 4",
} as const;

export type IconName = keyof typeof paths;

export function Icon({
  name,
  size = 18,
  style,
}: {
  name: IconName;
  size?: number;
  style?: CSSProperties;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={style}
    >
      <path d={paths[name]} />
    </svg>
  );
}
