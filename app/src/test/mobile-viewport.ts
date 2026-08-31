/**
 * A phone-sized window for component tests.
 *
 * 390 x 844 is the iPhone 12/13/14-class viewport this product treats as its mobile profile, and
 * mobile-first is an acceptance criterion here rather than a preference: contractors and office
 * staff both work these screens from a phone. happy-dom does no layout, so this proves the honest
 * state RENDERS on a phone-sized viewport and that nothing is gated behind a desktop media query;
 * whether it fits and stays thumb-reachable is what the Playwright mobile projects measure.
 */
export const MOBILE_VIEWPORT = { width: 390, height: 844 } as const;

export function setMobileViewport(): void {
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    writable: true,
    value: MOBILE_VIEWPORT.width,
  });
  Object.defineProperty(window, "innerHeight", {
    configurable: true,
    writable: true,
    value: MOBILE_VIEWPORT.height,
  });
  // A media query a component asks about answers as a phone would: every `min-width` breakpoint
  // above the viewport is false, so a desktop-only branch cannot render and pass unnoticed.
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (query: string) => {
      const minWidth = /\(min-width:\s*(\d+)px\)/.exec(query);
      const matches = minWidth ? MOBILE_VIEWPORT.width >= Number(minWidth[1]) : false;
      return {
        matches,
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      };
    },
  });
  window.dispatchEvent(new Event("resize"));
}
