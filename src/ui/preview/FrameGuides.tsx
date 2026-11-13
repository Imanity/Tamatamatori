// Guides over the frame: rule-of-thirds lines, the centre mark and the compass
// directions inside the horizontal field of view.
import { signedAngle } from "../../domain/core/plan";

const radians = (value: number) => (value * Math.PI) / 180;
const directions = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];

export function FrameGuides({ grid, azimuth, fov }: {
  grid: boolean;
  /** The camera's actual azimuth (after the engine's adjustment). */
  azimuth: number;
  fov: { horizontal: number; vertical: number };
}) {
  return (
    <svg
      viewBox="0 0 600 400"
      preserveAspectRatio="none"
      role="img"
      aria-label={`取景辅助线，水平视场 ${fov.horizontal.toFixed(1)} 度，垂直视场 ${fov.vertical.toFixed(1)} 度。`}
    >
      {grid && (
        <path
          d="M200 0V400M400 0V400M0 133.33H600M0 266.67H600"
          stroke="white"
          opacity="0.4"
          strokeWidth="0.8"
        />
      )}
      <path
        d="M290 200h20m-10-10v20"
        stroke="#fff"
        opacity="0.9"
        strokeWidth="1"
      />
      {directions.map((label, index) => {
        const delta = signedAngle(index * 45 - azimuth);
        if (Math.abs(delta) > fov.horizontal / 2) return null;
        const x =
          300 +
          (300 * Math.tan(radians(delta))) /
            Math.tan(radians(fov.horizontal / 2));
        return (
          <g key={label}>
            <path d={`M${x} 0v13`} stroke="white" opacity="0.8" />
            <text
              x={Math.max(16, Math.min(584, x))}
              y="32"
              textAnchor="middle"
              fill="white"
              stroke="#182535"
              strokeWidth="0.4"
              paintOrder="stroke"
              fontSize="15"
              fontFamily="monospace"
            >
              {label}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
