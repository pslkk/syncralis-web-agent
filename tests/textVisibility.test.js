import test from "node:test";
import assert from "node:assert/strict";
import {
  parseColor,
  contrastRatio,
  classifyVisibility,
  summarizeHiddenText,
} from "../src/security/textVisibility.js";

test("parseColor parses rgb() and rgba() forms", () => {
  assert.deepEqual(parseColor("rgb(255, 255, 255)"), { r: 255, g: 255, b: 255, a: 1 });
  assert.deepEqual(parseColor("rgba(0, 0, 0, 0.5)"), { r: 0, g: 0, b: 0, a: 0.5 });
});

test("parseColor returns null for unparseable input", () => {
  assert.equal(parseColor("currentcolor"), null);
  assert.equal(parseColor(undefined), null);
});

test("contrastRatio is 1 for identical colors and >1 for black/white", () => {
  const white = { r: 255, g: 255, b: 255 };
  const black = { r: 0, g: 0, b: 0 };
  assert.ok(Math.abs(contrastRatio(white, white) - 1) < 0.001);
  assert.ok(contrastRatio(white, black) > 20);
});

test("classifyVisibility flags display:none", () => {
  const reasons = classifyVisibility({ display: "none" });
  assert.ok(reasons.includes("display_none"));
});

test("classifyVisibility flags visibility:hidden", () => {
  const reasons = classifyVisibility({ visibility: "hidden" });
  assert.ok(reasons.includes("visibility_hidden"));
});

test("classifyVisibility flags near-zero opacity", () => {
  const reasons = classifyVisibility({ opacity: 0.01 });
  assert.ok(reasons.includes("near_zero_opacity"));
});

test("classifyVisibility does not flag normal opacity", () => {
  const reasons = classifyVisibility({ opacity: 1 });
  assert.ok(!reasons.includes("near_zero_opacity"));
});

test("classifyVisibility flags near-zero font size", () => {
  const reasons = classifyVisibility({ fontSize: 1 });
  assert.ok(reasons.includes("near_zero_font_size"));
});

test("classifyVisibility flags white-text-on-white-background (the classic hidden-injection trick)", () => {
  const reasons = classifyVisibility({
    color: "rgb(255, 255, 255)",
    effectiveBackgroundColor: "rgb(255, 255, 255)",
  });
  assert.ok(reasons.includes("color_matches_background"));
});

test("classifyVisibility does NOT flag normal readable contrast", () => {
  const reasons = classifyVisibility({
    color: "rgb(20, 20, 20)",
    effectiveBackgroundColor: "rgb(255, 255, 255)",
  });
  assert.equal(reasons.length, 0);
});

test("classifyVisibility flags far off-screen positioning", () => {
  const reasons = classifyVisibility({
    rect: { left: -9999, top: 0, width: 100, height: 20 },
    viewportWidth: 1280,
    viewportHeight: 800,
  });
  assert.ok(reasons.includes("offscreen_position"));
});

test("classifyVisibility does not flag ordinary in-viewport content", () => {
  const reasons = classifyVisibility({
    rect: { left: 10, top: 10, width: 100, height: 20 },
    viewportWidth: 1280,
    viewportHeight: 800,
    color: "rgb(20,20,20)",
    effectiveBackgroundColor: "rgb(255,255,255)",
  });
  assert.equal(reasons.length, 0);
});

test("classifyVisibility flags positioning far past the right edge of the viewport", () => {
  const reasons = classifyVisibility({
    rect: { left: 999999, top: 0, width: 100, height: 20 },
    viewportWidth: 1280,
    viewportHeight: 800,
  });
  assert.ok(reasons.includes("offscreen_position"));
});

test("classifyVisibility flags positioning far past the bottom edge of the viewport", () => {
  const reasons = classifyVisibility({
    rect: { left: 10, top: 999999, width: 100, height: 20 },
    viewportWidth: 1280,
    viewportHeight: 800,
  });
  assert.ok(reasons.includes("offscreen_position"));
});

test("classifyVisibility flags clip-path fully-hidden technique", () => {
  const reasons = classifyVisibility({ clipPath: "inset(100%)" });
  assert.ok(reasons.includes("clip_path_hidden"));
});

test("classifyVisibility flags legacy clip:rect(0,0,0,0)", () => {
  const reasons = classifyVisibility({ clip: "rect(0px, 0px, 0px, 0px)" });
  assert.ok(reasons.includes("legacy_clip_hidden"));
});

test("classifyVisibility flags collapsed zero-size + overflow:hidden box", () => {
  const reasons = classifyVisibility({
    rect: { width: 0, height: 0 },
    overflow: "hidden",
  });
  assert.ok(reasons.includes("collapsed_dimensions"));
});

test("classifyVisibility handles missing/malformed input safely", () => {
  assert.deepEqual(classifyVisibility(null), []);
  assert.deepEqual(classifyVisibility(undefined), []);
  assert.deepEqual(classifyVisibility({}), []);
});

test("summarizeHiddenText filters to only flagged entries and caps length", () => {
  const entries = [
    { text: "visible paragraph", reasons: [] },
    { text: "a".repeat(500), reasons: ["display_none"] },
  ];
  const summary = summarizeHiddenText(entries, { maxTextLength: 50 });
  assert.equal(summary.hiddenTextDetected, true);
  assert.equal(summary.hiddenText.length, 1);
  assert.equal(summary.hiddenText[0].text.length, 50);
  assert.equal(summary.totalHiddenSegments, 1);
});

test("summarizeHiddenText reports false when nothing is flagged", () => {
  const summary = summarizeHiddenText([{ text: "hi", reasons: [] }]);
  assert.equal(summary.hiddenTextDetected, false);
  assert.deepEqual(summary.hiddenText, []);
});

test("summarizeHiddenText caps number of entries returned", () => {
  const entries = Array.from({ length: 50 }, (_, i) => ({
    text: `hidden ${i}`,
    reasons: ["display_none"],
  }));
  const summary = summarizeHiddenText(entries, { maxEntries: 5 });
  assert.equal(summary.hiddenText.length, 5);
  assert.equal(summary.totalHiddenSegments, 50);
});
