import { CheckCircle2, Mail } from "lucide-react";
import { useId, useState, type FormEvent } from "react";

import { apiCommand, ApiError } from "../lib/api";
import { API_PATHS } from "../lib/api-paths";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Input } from "../components/ui/input";

export function MagicLinkForm() {
  const emailId = useId();
  const errorId = useId();
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string>();

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const email = String(data.get("email") ?? "")
      .trim()
      .toLowerCase();
    if (!email) return;
    setBusy(true);
    setError(undefined);
    try {
      await apiCommand({ path: API_PATHS.magicLinkRequest, body: { email } });
      setSent(true);
    } catch (caught) {
      setError(
        caught instanceof ApiError
          ? caught.message
          : "The sign-in email could not be requested. Check your connection and try again.",
      );
    } finally {
      setBusy(false);
    }
  }

  if (sent) {
    return (
      <Card className="w-full max-w-md" aria-live="polite">
        <CardHeader>
          <div className="mb-3 flex size-12 items-center justify-center rounded-full bg-ok-soft text-ok">
            <CheckCircle2 className="size-6" aria-hidden="true" />
          </div>
          <CardTitle>Check your email</CardTitle>
          <CardDescription>
            If that address is active for IronWrap OS, a one-time sign-in link is on its way. The
            link expires and can be used once.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button variant="outline" fullWidth onClick={() => setSent(false)}>
            Use another email
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="w-full max-w-md">
      <CardHeader>
        <div className="mb-3 flex size-12 items-center justify-center rounded-full bg-accent text-accent-foreground">
          <Mail className="size-6" aria-hidden="true" />
        </div>
        <CardTitle>Sign in to IronWrap OS</CardTitle>
        <CardDescription>
          Use your approved work email. There is no password to remember or enter on site.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form className="space-y-4" onSubmit={submit}>
          <div className="space-y-2">
            <label htmlFor={emailId} className="text-sm font-bold">
              Work email
            </label>
            <Input
              id={emailId}
              name="email"
              type="email"
              inputMode="email"
              autoComplete="email"
              enterKeyHint="send"
              required
              placeholder="name@company.ca"
              aria-describedby={error ? errorId : undefined}
              invalid={Boolean(error)}
            />
            {error ? (
              <p id={errorId} className="text-sm font-medium text-danger" role="alert">
                {error}
              </p>
            ) : null}
          </div>
          <Button type="submit" variant="accent" size="field" fullWidth busy={busy}>
            Email me a sign-in link
          </Button>
          <p className="text-xs leading-5 text-muted">
            For privacy, this screen never confirms whether an email is registered.
          </p>
        </form>
      </CardContent>
    </Card>
  );
}
