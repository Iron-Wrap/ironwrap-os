import { useState, type FormEvent } from "react";

import { takeMagicLinkTokenFromWindow } from "../auth/magic-link-fragment";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { ErrorState } from "../components/ui/state-panel";
import { confirmCustomerContractAcceptance } from "./portal-api";

type ConfirmationState = "ready" | "submitting" | "accepted" | "uncertain" | "error";
const tokenPattern = /^[A-Za-z0-9_-]{43}$/;

/** An email-bound confirmation page; the one-time token is scrubbed before any network request. */
export function CustomerContractAcceptancePage() {
  const [token] = useState(() => takeMagicLinkTokenFromWindow());
  const [signerName, setSignerName] = useState("");
  const [attested, setAttested] = useState(false);
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const [state, setState] = useState<ConfirmationState>("ready");

  if (!token || !tokenPattern.test(token)) {
    return (
      <main className="grid min-h-dvh place-items-center p-4">
        <ErrorState
          title="This confirmation link is no longer available"
          message="Return to your private project portal to request a new confirmation email."
        />
      </main>
    );
  }
  const confirmationToken = token;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = signerName.trim();
    if (!name || !attested || state === "submitting") return;
    setState("submitting");
    try {
      const result = await confirmCustomerContractAcceptance({
        token: confirmationToken,
        signerName: name,
        idempotencyKey,
      });
      setState(result.status);
    } catch {
      setState("error");
    }
  }

  return (
    <main className="grid min-h-dvh place-items-center bg-background p-4">
      <Card className="w-full max-w-xl">
        <CardHeader>
          <CardTitle>Confirm your contract acceptance</CardTitle>
          <CardDescription>
            This one-time email link verifies access to the customer email address on file. It does
            not replace any legally required signature process.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {state === "accepted" ? (
            <p className="text-sm font-semibold text-success" role="status">
              Your acceptance was recorded. We will retain the verified receipt with your project
              record.
            </p>
          ) : state === "uncertain" ? (
            <p className="text-sm font-semibold text-warning" role="status">
              Your confirmation needs reconciliation. Please do not submit it again; we will verify
              the recorded result.
            </p>
          ) : (
            <form className="space-y-5" onSubmit={submit}>
              <div>
                <label className="text-sm font-bold" htmlFor="contract-signer-name">
                  Your full name
                </label>
                <input
                  id="contract-signer-name"
                  className="mt-2 flex h-11 w-full rounded-md border border-input bg-background px-3 text-sm"
                  value={signerName}
                  autoComplete="name"
                  maxLength={140}
                  required
                  onChange={(event) => setSignerName(event.target.value)}
                />
              </div>
              <label className="flex gap-3 text-sm leading-6">
                <input
                  type="checkbox"
                  checked={attested}
                  required
                  onChange={(event) => setAttested(event.target.checked)}
                />
                <span>
                  I confirm that I am authorized to accept the current proposal shown in my private
                  project portal.
                </span>
              </label>
              <Button
                type="submit"
                disabled={!attested || !signerName.trim() || state === "submitting"}
              >
                {state === "submitting" ? "Recording acceptance…" : "Confirm acceptance"}
              </Button>
              {state === "error" ? (
                <p className="text-sm font-semibold text-danger" role="alert">
                  We could not record this confirmation. If the proposal changed, request a new link
                  from your project portal; otherwise contact your project team.
                </p>
              ) : null}
            </form>
          )}
        </CardContent>
      </Card>
    </main>
  );
}
