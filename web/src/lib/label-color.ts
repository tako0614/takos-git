import type { ResolvedTheme } from "./theme.ts";

export interface RgbColor {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

export type LabelChipStyle = {
  readonly color: string;
  readonly background: string;
  readonly "border-color": string;
};

const FALLBACK_HEX = "8b949e";
const LIGHT_CANVAS: RgbColor = { r: 255, g: 255, b: 255 };
const LIGHT_SUBTLE: RgbColor = { r: 246, g: 248, b: 250 };
const DARK_CANVAS: RgbColor = { r: 13, g: 17, b: 23 };
const DARK_SUBTLE: RgbColor = { r: 21, g: 27, b: 35 };
const LIGHT_ANCHOR: RgbColor = { r: 13, g: 17, b: 23 };
const DARK_ANCHOR: RgbColor = { r: 240, g: 246, b: 252 };
const TARGET_CONTRAST = 4.6;

/** Parse a 3- or 6-digit hex color (with optional leading `#`), falling back to neutral gray. */
export function parseHexColor(raw: string | null | undefined): RgbColor {
  const cleaned = (raw ?? "").trim().replace(/^#/u, "");
  let hex = FALLBACK_HEX;
  if (/^[0-9a-fA-F]{6}$/u.test(cleaned)) {
    hex = cleaned;
  } else if (/^[0-9a-fA-F]{3}$/u.test(cleaned)) {
    hex = cleaned
      .split("")
      .map((c) => c + c)
      .join("");
  }
  return {
    r: Number.parseInt(hex.slice(0, 2), 16),
    g: Number.parseInt(hex.slice(2, 4), 16),
    b: Number.parseInt(hex.slice(4, 6), 16),
  };
}

function srgbChannel(v: number): number {
  const s = v / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

/** WCAG 2.x relative luminance (0..1). */
export function relativeLuminance(c: RgbColor): number {
  return 0.2126 * srgbChannel(c.r) + 0.7152 * srgbChannel(c.g) + 0.0722 * srgbChannel(c.b);
}

/** WCAG 2.x contrast ratio (1..21). */
export function contrastRatio(a: RgbColor, b: RgbColor): number {
  const l1 = relativeLuminance(a);
  const l2 = relativeLuminance(b);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

function mixRgb(from: RgbColor, to: RgbColor, t: number): RgbColor {
  return {
    r: Math.round(from.r + (to.r - from.r) * t),
    g: Math.round(from.g + (to.g - from.g) * t),
    b: Math.round(from.b + (to.b - from.b) * t),
  };
}

function toRgbCss(c: RgbColor): string {
  return `rgb(${c.r}, ${c.g}, ${c.b})`;
}

function toRgbaCss(c: RgbColor, alpha: number): string {
  return `rgba(${c.r}, ${c.g}, ${c.b}, ${alpha})`;
}

/**
 * Compute WCAG AA (>= 4.5:1) label pill styles for any hex color on the active
 * light or dark theme. Preserves the label's hue while minimally shifting text
 * lightness toward the theme anchor when raw contrast against the tinted pill
 * background would fall below AA.
 */
export function computeLabelChipStyle(
  rawColor: string | null | undefined,
  theme: ResolvedTheme,
): LabelChipStyle {
  const base = parseHexColor(rawColor);
  const canvas = theme === "dark" ? DARK_CANVAS : LIGHT_CANVAS;
  const subtle = theme === "dark" ? DARK_SUBTLE : LIGHT_SUBTLE;
  const anchor = theme === "dark" ? DARK_ANCHOR : LIGHT_ANCHOR;
  const bgAlpha = theme === "dark" ? 0.2 : 0.16;
  const pillBgCanvas = mixRgb(canvas, base, bgAlpha);
  const pillBgSubtle = mixRgb(subtle, base, bgAlpha);
  const minContrast = (fg: RgbColor): number =>
    Math.min(contrastRatio(fg, pillBgCanvas), contrastRatio(fg, pillBgSubtle));

  let textColor = base;
  if (minContrast(base) < TARGET_CONTRAST) {
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < 12; i += 1) {
      const mid = (lo + hi) / 2;
      if (minContrast(mixRgb(base, anchor, mid)) >= TARGET_CONTRAST) {
        hi = mid;
      } else {
        lo = mid;
      }
    }
    textColor = mixRgb(base, anchor, hi);
  }

  const borderBase = theme === "dark" ? mixRgb(base, anchor, 0.2) : mixRgb(base, anchor, 0.25);

  return {
    color: toRgbCss(textColor),
    background: toRgbaCss(base, bgAlpha),
    "border-color": toRgbaCss(borderBase, theme === "dark" ? 0.55 : 0.5),
  };
}
