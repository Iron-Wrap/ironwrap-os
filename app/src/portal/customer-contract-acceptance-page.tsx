import { useState, type FormEvent } from "react";

import { takeMagicLinkTokenFromWindow } from "../auth/magic-link-fragment";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Input } from "../components/ui/input";
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
          title="This link is no longer ready"
          message="Open your private project page and ask for a new email."
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
          <CardTitle>Accept your contract</CardTitle>
          <CardDescription>
            This one-time link checks the email on file. It does not replace any signature the law
            may need.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {state === "accepted" ? (
            <p className="text-sm font-semibold text-ok" role="status">
              Your acceptance was saved. We will keep the receipt with your project.
            </p>
          ) : state === "uncertain" ? (
            <p className="text-sm font-semibold text-warning" role="status">
              We are checking your acceptance. Do not send it again.
            </p>
          ) : (
            <form className="space-y-5" onSubmit={submit}>
              <div>
                <label className="text-sm font-bold" htmlFor="contract-signer-name">
                  Your full name
                </label>
                <Input
                  id="contract-signer-name"
                  className="mt-2"
                  value={signerName}
                  autoComplete="name"
                  maxLength={140}
                  required
                  onChange={(event) => setSignerName(event.target.value)}
                />
              </div>
              <label className="flex min-h-11 cursor-pointer items-start gap-3 text-sm leading-6">
                <input
                  type="checkbox"
                  className="mt-0.5 size-5 shrink-0 rounded-sm border-border text-accent"
                  checked={attested}
                  required
                  onChange={(event) => setAttested(event.target.checked)}
                />
                <span>
                  I have the right to accept the current proposal shown on my private project page.
                </span>
              </label>
              <Button
                type="submit"
                disabled={!attested || !signerName.trim() || state === "submitting"}
              >
                {state === "submitting" ? "Saving acceptance…" : "Accept contract"}
              </Button>
              {state === "error" ? (
                <p className="text-sm font-semibold text-danger" role="alert">
                  We could not save this. If the proposal changed, ask for a new link. If not, call
                  your project team.
                </p>
              ) : null}
            </form>
          )}
        </CardContent>
      </Card>
    </main>
  );
}
