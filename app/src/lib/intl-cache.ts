/**
 * Constructing an `Intl.DateTimeFormat` resolves locale data and normalises every
 * option, which costs orders of magnitude more than formatting with one. A field run
 * sheet formats a date for every job, gate, schedule and proof it lists, so building a
 * formatter per call dominated the `/today` boot profile — 102 ms of main-thread self
 * time at the paired-device CPU budget, more than React spent rendering the page.
 *
 * Formatters are immutable and cheap to hold, and the call sites use a small fixed set
 * of option literals, so the cache stays bounded by (locale × time zone × format).
 * Construction errors are deliberately left to propagate: callers that fall back to a
 * default locale rely on catching them.
 */
const formatters = new Map<string, Intl.DateTimeFormat>();

export function dateTimeFormatter(
  locale: string | undefined,
  options: Intl.DateTimeFormatOptions,
): Intl.DateTimeFormat {
  const key = JSON.stringify([locale ?? null, options]);
  const cached = formatters.get(key);
  if (cached) return cached;

  const formatter = new Intl.DateTimeFormat(locale, options);
  formatters.set(key, formatter);
  return formatter;
}
