import {
  createContext,
  useContext,
  useEffect,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";

/** The shell listens here, so the chrome around a page in Shop reading follows the page. */
export const ShopReadingContext = createContext<((reading: boolean) => void) | null>(null);

/**
 * Shop reading state for a page. The page puts `scopes.shopReading` on its own root; the shell
 * puts it on itself too, so the rail, top bar and tab bar go dark and glove-sized with the page
 * instead of sitting above it in the office palette.
 */
export function useShopReading(
  initial: () => boolean,
): [boolean, Dispatch<SetStateAction<boolean>>] {
  const [reading, setReading] = useState(initial);
  const publish = useContext(ShopReadingContext);
  useEffect(() => {
    publish?.(reading);
    return () => publish?.(false);
  }, [publish, reading]);
  return [reading, setReading];
}
