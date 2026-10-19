/**
 * Hover, pressed and keyboard focus are states a pointer or a keyboard puts on one element at a
 * time. To show every one of them side by side, the gallery copies each stylesheet rule that names
 * `:hover`, `:active` or `:focus-visible` into a rule for `[data-force-hover]`,
 * `[data-force-active]` or `[data-force-focus]`, in the same layer and media block, so the
 * attribute draws exactly what the state draws. Components need no gallery-only code: their props
 * reach the element, and so does the attribute.
 */
const STATES = [
  ["hover", "[data-force-hover]"],
  ["active", "[data-force-active]"],
  ["focus-visible", "[data-force-focus]"],
] as const;

const forced = new WeakSet<CSSRule>();

function copyRules(parent: CSSStyleSheet | CSSGroupingRule | CSSStyleRule) {
  const rules = Array.from(parent.cssRules);
  // Backwards, so an inserted copy never shifts a rule still to be read.
  for (let index = rules.length - 1; index >= 0; index -= 1) {
    const rule = rules[index];
    if (!rule || forced.has(rule)) continue;
    if (rule instanceof CSSStyleRule) {
      if (rule.cssRules.length) copyRules(rule);
      const selector = rule.selectorText;
      let copy = selector;
      for (const [state, attribute] of STATES)
        copy = copy.replace(new RegExp(`:${state}(?![\\w-])`, "g"), attribute);
      if (copy === selector) continue;
      try {
        parent.insertRule(rule.cssText.replace(selector, copy), index + 1);
        const inserted = parent.cssRules[index + 1];
        if (inserted) forced.add(inserted);
      } catch {
        // A copy the browser refuses (a selector it cannot parse) is skipped, not fatal.
      }
    } else if ("cssRules" in rule) {
      copyRules(rule as CSSGroupingRule);
    }
  }
}

const done = new WeakSet<Document>();

export function forceStates(doc: Document = document) {
  // Once per page: React's development double effect would otherwise copy every rule twice.
  if (done.has(doc)) return;
  done.add(doc);
  for (const sheet of Array.from(doc.styleSheets)) {
    try {
      copyRules(sheet);
    } catch {
      // A sheet from another origin cannot be read; it holds none of the app's own rules.
    }
  }
}
