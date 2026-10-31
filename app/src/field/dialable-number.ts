/**
 * The number a tel: link may dial, or null when the text is not one plain phone number. A label
 * before it ("Cell:") and anything after an extension mark ("ext", "x", "#", ",") are left out;
 * only digits, spaces, dots, dashes and brackets may stand around the digits, a "+" only first.
 * A local number has 7 or 10 digits, or 11 starting with 1; an international one ("+") 8 to 15
 * digits with no "(0)" trunk group. A shown number that is not dialable gets no Call button,
 * never a wrong one.
 */
export function dialableNumber(text: string | null | undefined): string | null {
  const number = (text ?? "")
    .replace(/[\u2010-\u2015]/g, "-")
    .replace(/^[^\d+(]*:\s*/, "")
    .split(/\s*(?:ext\.?|x|#|,)/i)[0]!
    .trim();
  if (!/^\+?[\d\s().-]+$/.test(number)) return null;
  const digits = number.replace(/\D/g, "");
  if (number.startsWith("+")) {
    if (/\(\s*0\s*\)/.test(number) || digits.length < 8 || digits.length > 15) return null;
    return `+${digits}`;
  }
  const local =
    digits.length === 7 || digits.length === 10 || (digits.length === 11 && digits.startsWith("1"));
  return local ? digits : null;
}
