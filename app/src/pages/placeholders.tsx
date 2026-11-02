import { ErrorState } from "../components/ui/state-panel";

export function NotFoundPage() {
  return (
    <main className="grid min-h-dvh place-items-center bg-chrome p-4">
      <div className="w-full max-w-lg border border-chrome-border bg-surface p-6 text-foreground">
        <ErrorState
          title="That screen was not found"
          message="The link may be old or incomplete. Go back to your work list."
          onRetry={() => window.location.assign("/now")}
        />
      </div>
    </main>
  );
}
