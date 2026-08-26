/**
 * Returns a hex color string for a congestion score in [0, 1] using
 * continuous piecewise-linear RGB interpolation across five control points.
 *
 * 0.0  → #22c55e (green)       — free-flowing
 * 0.15 → #eab308 (yellow)      — light congestion
 * 0.35 → #f97316 (orange)      — moderate
 * 0.6  → #dc2626 (red)         — heavy
 * 1.0  → #7f1d1d (dark red)    — extreme
 */

interface ColorStop {
  t: number;
  r: number;
  g: number;
  b: number;
}

const CONTROL_POINTS: ColorStop[] = [
  { t: 0.0,  r: 0x22, g: 0xc5, b: 0x5e },
  { t: 0.15, r: 0xea, g: 0xb3, b: 0x08 },
  { t: 0.35, r: 0xf9, g: 0x73, b: 0x16 },
  { t: 0.6,  r: 0xdc, g: 0x26, b: 0x26 },
  { t: 1.0,  r: 0x7f, g: 0x1d, b: 0x1d },
];

export function getCongestionColor(score: number): string {
  const s = Math.max(0, Math.min(1, score));

  // Find bounding control points
  let lo = CONTROL_POINTS[0];
  let hi = CONTROL_POINTS[CONTROL_POINTS.length - 1];
  for (let i = 0; i < CONTROL_POINTS.length - 1; i++) {
    if (s >= CONTROL_POINTS[i].t && s <= CONTROL_POINTS[i + 1].t) {
      lo = CONTROL_POINTS[i];
      hi = CONTROL_POINTS[i + 1];
      break;
    }
  }

  const range = hi.t - lo.t;
  const f = range === 0 ? 0 : (s - lo.t) / range;

  const r = Math.round(lo.r + (hi.r - lo.r) * f);
  const g = Math.round(lo.g + (hi.g - lo.g) * f);
  const b = Math.round(lo.b + (hi.b - lo.b) * f);

  return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
}

/** The same five control-point hex colors, exported for the legend gradient. */
export const CONGESTION_COLORS = ["#22c55e", "#eab308", "#f97316", "#dc2626", "#7f1d1d"];
