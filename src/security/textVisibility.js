const MIN_CONTRAST_RATIO = 1.15;
const MAX_INVISIBLE_FONT_SIZE_PX = 2;
const MAX_INVISIBLE_OPACITY = 0.05;
const OFFSCREEN_MARGIN_PX = 500;

function clamp01(n) {
  return Math.min(1, Math.max(0, n));
}

export function parseColor(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().toLowerCase();
  if (trimmed === "transparent") return { r: 0, g: 0, b: 0, a: 0 };
  const match = trimmed.match(/^rgba?\(([^)]+)\)$/);
  if (!match) return null;
  const parts = match[1].split(",").map((p) => parseFloat(p.trim()));
  if (parts.length < 3 || parts.slice(0, 3).some((n) => Number.isNaN(n))) return null;
  const [r, g, b] = parts;
  const a = parts.length > 3 && !Number.isNaN(parts[3]) ? clamp01(parts[3]) : 1;
  return { r, g, b, a };
}

function srgbChannel(c) {
  const n = clamp01(c / 255);
  return n <= 0.03928 ? n / 12.92 : Math.pow((n + 0.055) / 1.055, 2.4);
}

export function relativeLuminance({ r, g, b }) {
  return 0.2126 * srgbChannel(r) + 0.7152 * srgbChannel(g) + 0.0722 * srgbChannel(b);
}

export function contrastRatio(colorA, colorB) {
  const lA = relativeLuminance(colorA) + 0.05;
  const lB = relativeLuminance(colorB) + 0.05;
  return lA > lB ? lA / lB : lB / lA;
}

export function classifyVisibility(style) {
  const reasons = [];
  if (!style || typeof style !== "object") return reasons;

  if (style.display === "none") reasons.push("display_none");
  if (style.visibility === "hidden" || style.visibility === "collapse") {
    reasons.push("visibility_hidden");
  }

  if (typeof style.opacity === "number" && style.opacity <= MAX_INVISIBLE_OPACITY) {
    reasons.push("near_zero_opacity");
  }

  if (typeof style.fontSize === "number" && style.fontSize <= MAX_INVISIBLE_FONT_SIZE_PX) {
    reasons.push("near_zero_font_size");
  }

  const rect = style.rect || {};
  const collapsedBox =
    typeof rect.width === "number" &&
    typeof rect.height === "number" &&
    rect.width <= 1 &&
    rect.height <= 1 &&
    style.overflow === "hidden";
  if (collapsedBox) reasons.push("collapsed_dimensions");

  const farOffscreen =
    typeof rect.left === "number" &&
    typeof rect.top === "number" &&
    (rect.left <= -OFFSCREEN_MARGIN_PX ||
      rect.top <= -OFFSCREEN_MARGIN_PX ||
      (typeof style.viewportWidth === "number" &&
        rect.left - style.viewportWidth >= OFFSCREEN_MARGIN_PX) ||
      (typeof style.viewportHeight === "number" &&
        rect.top - style.viewportHeight >= OFFSCREEN_MARGIN_PX));
  if (farOffscreen) reasons.push("offscreen_position");

  if (typeof style.clipPath === "string" && /inset\(\s*100%|circle\(\s*0/.test(style.clipPath)) {
    reasons.push("clip_path_hidden");
  }
  if (typeof style.clip === "string" && /rect\(\s*0(px)?[,\s]+0(px)?[,\s]+0(px)?[,\s]+0(px)?\s*\)/.test(style.clip)) {
    reasons.push("legacy_clip_hidden");
  }

  const color = parseColor(style.color);
  const background = parseColor(style.effectiveBackgroundColor);
  if (color && background && color.a > MAX_INVISIBLE_OPACITY) {
    const ratio = contrastRatio(color, background);
    if (ratio < MIN_CONTRAST_RATIO) reasons.push("color_matches_background");
  }

  return reasons;
}

export function summarizeHiddenText(entries, { maxEntries = 20, maxTextLength = 200 } = {}) {
  const flagged = (entries || []).filter((e) => Array.isArray(e.reasons) && e.reasons.length > 0);
  const hiddenTextDetected = flagged.length > 0;
  const hiddenText = flagged.slice(0, maxEntries).map((e) => ({
    text: String(e.text || "").slice(0, maxTextLength),
    reasons: e.reasons,
  }));
  return { hiddenTextDetected, hiddenText, totalHiddenSegments: flagged.length };
}
