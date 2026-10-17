import { AlertTriangle, Download, PackageCheck } from "lucide-react";

import { Button } from "../components/ui/button";
import { useOnlineStatus } from "../hooks/use-online-status";

export function OfflineReadiness({
  ready,
  saving,
  savedDetail,
  missingDetail,
  onRetry,
}: {
  ready: boolean;
  saving: boolean;
  savedDetail: string;
  missingDetail: string;
  onRetry: () => void;
}) {
  const saved = ready && !saving;
  const online = useOnlineStatus();
  const Icon = saved ? PackageCheck : saving ? Download : AlertTriangle;
  return (
    <section
      aria-label="Offline readiness"
      role="status"
      className={`border p-4 ${saved ? "border-ok/30 bg-ok-soft" : "border-warning/35 bg-warning-soft"}`}
    >
      <div className="flex items-start gap-3">
        <Icon
          className={`mt-0.5 size-5 shrink-0 ${saved ? "text-ok" : "text-warning"}`}
          aria-hidden="true"
        />
        <div className="min-w-0 flex-1 space-y-2">
          <h2 className="text-lg font-bold">
            {saved ? "Ready offline" : saving ? "Saving for offline use" : "Not ready offline"}
          </h2>
          <p className="leading-6">
            {saved
              ? savedDetail
              : saving
                ? "Keep this screen open. Wait for Ready offline before you leave signal."
                : `${missingDetail} ${online ? "Keep signal. Try saving again" : "Go online to save"} and wait for Ready offline before you leave.`}
          </p>
          {!saved ? (
            <Button size="field" fullWidth disabled={saving || !online} onClick={onRetry}>
              {saving ? "Saving…" : online ? "Try saving again" : "Go online to save"}
            </Button>
          ) : null}
        </div>
      </div>
    </section>
  );
}
