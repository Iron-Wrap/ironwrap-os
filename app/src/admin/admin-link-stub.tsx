import type { ReactNode } from "react";

/** The router is not mounted in a component test; a link only has to be a link. */
export function LinkStub({ children, to, ...props }: { children: ReactNode; to: string }) {
  return (
    <a href={to} {...props}>
      {children}
    </a>
  );
}
