import { cn } from "../../lib/cn";

const LOGO_RATIO = 608 / 178;
const SHIELD_RATIO = 109 / 128;

/**
 * The Iron Wrap Exteriors wordmark. `surface="auto"` follows the colour scheme; `"dark"` is for
 * a dark ground in either scheme, such as the charcoal rail. Tenant-configured marks stay with
 * the shell's CompanyMark; this is the Iron Wrap identity itself.
 */
export function Logo({
  height = 32,
  surface = "auto",
  className,
}: {
  height?: number;
  surface?: "auto" | "dark";
  className?: string;
}) {
  const width = Math.round(height * LOGO_RATIO);
  const art = (src: string, on?: "light" | "dark") => (
    <img
      src={src}
      alt="Iron Wrap Exteriors"
      width={width}
      height={height}
      data-on={on}
      className={cn("block h-auto max-w-full", on && "brand-logo", className)}
    />
  );
  if (surface === "dark") return art("/brand/logo-on-dark.png");
  // Both artworks ship and CSS shows one, so a pinned appearance (`data-theme` on <html>) is
  // honoured as well as the device setting; a <picture> source can only follow the device.
  return (
    <>
      {art("/brand/logo.png", "light")}
      {art("/brand/logo-on-dark.png", "dark")}
    </>
  );
}

/** The shield on its own, for tight spaces. Decorative unless given a label. */
export function BrandMark({
  size = 24,
  label,
  className,
}: {
  size?: number;
  label?: string;
  className?: string;
}) {
  return (
    <img
      src="/brand/shield.png"
      alt={label ?? ""}
      width={Math.round(size * SHIELD_RATIO)}
      height={size}
      className={cn("block", className)}
    />
  );
}
