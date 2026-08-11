import { classifyVisibility } from "../security/textVisibility.js";
import { config } from "../config.js";
import { logEvent } from "../security/auditLog.js";

function collectElementStyleFacts(el) {
  function effectiveBackgroundColor(node) {
    let cur = node;
    let depth = 0;
    while (cur && depth < 25) {
      const s = window.getComputedStyle(cur);
      const bg = s.backgroundColor;
      if (bg && bg !== "transparent" && !/rgba\([^)]*,\s*0\s*\)/.test(bg)) return bg;
      cur = cur.parentElement;
      depth += 1;
    }
    return "rgb(255, 255, 255)";
  }

  const cs = window.getComputedStyle(el);
  const rect = el.getBoundingClientRect();
  return {
    display: cs.display,
    visibility: cs.visibility,
    opacity: parseFloat(cs.opacity),
    fontSize: parseFloat(cs.fontSize),
    color: cs.color,
    effectiveBackgroundColor: effectiveBackgroundColor(el),
    clipPath: cs.clipPath,
    clip: cs.clip,
    overflow: cs.overflow,
    rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
  };
}

export async function assertElementIsHumanVisible(locator, { url, action }) {
  if (config.ALLOW_CLICK_ON_VISUALLY_HIDDEN_ELEMENTS) return;

  let facts;
  try {
    facts = await locator.evaluate(collectElementStyleFacts);
  } catch {
    return;
  }

  const reasons = classifyVisibility(facts);
  if (reasons.length === 0) return;

  await logEvent({
    action: "click_blocked_visually_hidden_element",
    url,
    triggeredBy: action,
    reasons,
  }).catch(() => {});

  throw new Error(
    `Refused to ${action}: the matched element is not actually visible to a human ` +
      `(${reasons.join(", ")}), even though it passed basic DOM visibility checks. This is a ` +
      "common technique for tricking an automated agent into interacting with a decoy or " +
      "hidden element. Set SYNCRALIS_WEB_AGENT_ALLOW_CLICK_ON_VISUALLY_HIDDEN_ELEMENTS=true to " +
      "override at your own risk."
  );
}
