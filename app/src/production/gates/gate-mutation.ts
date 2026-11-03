import { onlineManager, useMutation, type UseMutationOptions } from "@tanstack/react-query";

import { isOfflineSession } from "../../auth/session";
import { PlainError } from "../../lib/plain-error";
import { gateCopy } from "./gate-copy";
import type { GateScreen } from "./gate-screen";

/** Office decisions require a new deliberate action online; they never join a reconnect queue. */
export function useGateMutation<TData, TVariables = void>(
  screen: GateScreen,
  options: Omit<
    UseMutationOptions<TData, Error, TVariables>,
    "mutationFn" | "networkMode" | "retry"
  > & {
    mutationFn: (variables: TVariables) => Promise<TData>;
  },
) {
  return useMutation({
    ...options,
    networkMode: "always",
    retry: false,
    mutationFn: async (variables: TVariables) => {
      // Recheck at submission, including the interval before the live UI has rerendered.
      if (
        screen.offline ||
        isOfflineSession(screen.session) ||
        !navigator.onLine ||
        !onlineManager.isOnline()
      ) {
        throw new PlainError(gateCopy.page.offlineWrite);
      }
      return await options.mutationFn(variables);
    },
  });
}
