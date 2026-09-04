import { Link, useNavigate } from "@tanstack/react-router";
import { useMutation } from "@tanstack/react-query";
import { ChevronLeft, UserPlus } from "lucide-react";
import { useId, useState } from "react";

import { adminErrorMessage } from "../admin/admin-api";
import { isOfflineSession } from "../auth/session";
import { useSession } from "../auth/session-context";
import { RoleGuard } from "../components/role-guard";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { Notice } from "../components/ui/notice";
import { ErrorState } from "../components/ui/state-panel";
import { Textarea } from "../components/ui/textarea";
import { createLead } from "./sales-api";
import type { NewLeadInput } from "./sales-contracts";

const EMPTY: NewLeadInput = {
  name: "",
  email: "",
  phone: "",
  address: "",
  city: "",
  province: "",
  postal_code: "",
  service: "",
  message: "",
};

export function NewLeadPage() {
  return (
    <RoleGuard surface="sales">
      <NewLeadContent />
    </RoleGuard>
  );
}

function NewLeadContent() {
  const session = useSession();
  const navigate = useNavigate();
  const [values, setValues] = useState<NewLeadInput>(EMPTY);
  const [duplicate, setDuplicate] = useState(false);

  const create = useMutation({
    mutationFn: () => createLead(session, values),
    onSuccess: (result) => {
      if (result.lead.duplicate) {
        setDuplicate(true);
        return;
      }
      void navigate({ to: "/sales" });
    },
  });

  if (isOfflineSession(session)) {
    return (
      <section className="mx-auto max-w-3xl pb-6">
        <ErrorState
          title="Reconnect before adding a lead"
          message="A new lead has to reach the office straight away, so this screen needs a live connection."
        />
      </section>
    );
  }

  const reachable = values.email.trim().length > 0 || values.phone.trim().length > 0;
  const ready = values.name.trim().length >= 2 && reachable;

  function set(name: keyof NewLeadInput, value: string) {
    setDuplicate(false);
    create.reset();
    setValues((current) => ({ ...current, [name]: value }));
  }

  return (
    <section className="mx-auto max-w-3xl space-y-6 pb-6">
      <Card className="overflow-hidden">
        <header className="min-w-0 p-5 sm:p-7">
          <Link
            to="/sales"
            className="-ml-1 inline-flex min-h-11 items-center gap-1 rounded-md pr-2 text-sm font-bold text-muted hover:text-foreground"
          >
            <ChevronLeft className="size-4" aria-hidden="true" />
            Sales desk
          </Link>
          <div className="mt-2 flex min-w-0 items-start gap-4">
            <span className="grid size-12 shrink-0 place-items-center rounded-lg bg-foreground text-background shadow-sm">
              <UserPlus className="size-6 text-accent" aria-hidden="true" />
            </span>
            <div className="min-w-0">
              <h1 className="text-2xl font-bold tracking-[-0.035em] text-balance sm:text-3xl">
                Add a lead
              </h1>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-muted">
                For someone who called, walked in, or was passed on to you. It lands on the sales
                desk the same way a website request does.
              </p>
            </div>
          </div>
        </header>
      </Card>

      <form
        className="space-y-6"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          create.mutate();
        }}
      >
        <Card>
          <CardHeader>
            <CardTitle>Who they are</CardTitle>
            <CardDescription>
              An email address or a phone number is enough to start.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-5 sm:grid-cols-2">
            <LeadField
              label="Full name"
              name="name"
              value={values.name}
              onChange={set}
              required
              autoComplete="name"
            />
            <LeadField
              label="Phone"
              name="phone"
              type="tel"
              inputMode="tel"
              value={values.phone}
              onChange={set}
              autoComplete="tel"
            />
            <LeadField
              label="Email"
              name="email"
              type="email"
              inputMode="email"
              value={values.email}
              onChange={set}
              autoComplete="email"
            />
            <LeadField
              label="What they need"
              name="service"
              value={values.service}
              onChange={set}
              hint="Type it the way they said it. Anything is allowed."
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Where the work is</CardTitle>
            <CardDescription>Leave blank if they have not said yet.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-5 sm:grid-cols-2">
            <LeadField
              label="Street address"
              name="address"
              value={values.address}
              onChange={set}
              autoComplete="address-line1"
            />
            <LeadField
              label="City"
              name="city"
              value={values.city}
              onChange={set}
              autoComplete="address-level2"
            />
            <LeadField
              label="Province or state"
              name="province"
              value={values.province}
              onChange={set}
              autoComplete="address-level1"
            />
            <LeadField
              label="Postal code"
              name="postal_code"
              value={values.postal_code}
              onChange={set}
              autoComplete="postal-code"
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Anything else</CardTitle>
            <CardDescription>What they told you, in their words.</CardDescription>
          </CardHeader>
          <CardContent>
            <NoteField value={values.message} onChange={set} />
          </CardContent>
        </Card>

        {!reachable && values.name.trim().length >= 2 ? (
          <Notice tone="info" title="Add a way to reach them">
            Enter an email address or a phone number so someone can follow this up.
          </Notice>
        ) : null}
        {duplicate ? (
          <Notice tone="warning" title="This person is already on the sales desk">
            Nothing was added twice. Open the sales desk to find the lead that is already there.
          </Notice>
        ) : null}
        {create.isError ? (
          <Notice tone="danger" title="That lead was not added">
            {adminErrorMessage(create.error)}
          </Notice>
        ) : null}

        <div className="sticky bottom-0 -mx-4 border-t border-border bg-surface px-4 py-3 sm:mx-0 sm:rounded-lg sm:border sm:px-4">
          <Button
            type="submit"
            variant="accent"
            fullWidth
            busy={create.isPending}
            disabled={!ready}
          >
            Add the lead
          </Button>
        </div>
      </form>
    </section>
  );
}

function LeadField({
  label,
  name,
  value,
  onChange,
  hint,
  type,
  inputMode,
  autoComplete,
  required,
}: {
  label: string;
  name: keyof NewLeadInput;
  value: string;
  onChange: (name: keyof NewLeadInput, value: string) => void;
  hint?: string;
  type?: string;
  inputMode?: "tel" | "email";
  autoComplete?: string;
  required?: boolean;
}) {
  const id = useId();
  const hintId = `${id}-hint`;
  return (
    <div className="min-w-0 space-y-2">
      <label htmlFor={id} className="block text-sm font-bold">
        {label}
        {required ? <span className="text-danger"> *</span> : null}
      </label>
      <Input
        id={id}
        name={name}
        type={type ?? "text"}
        inputMode={inputMode}
        value={value}
        autoComplete={autoComplete}
        aria-describedby={hint ? hintId : undefined}
        onChange={(event) => onChange(name, event.target.value)}
      />
      {hint ? (
        <p id={hintId} className="text-xs leading-5 text-muted">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

function NoteField({
  value,
  onChange,
}: {
  value: string;
  onChange: (name: keyof NewLeadInput, value: string) => void;
}) {
  const id = useId();
  return (
    <div className="space-y-2">
      <label htmlFor={id} className="block text-sm font-bold">
        Notes
      </label>
      <Textarea
        id={id}
        rows={4}
        value={value}
        onChange={(event) => onChange("message", event.target.value)}
      />
    </div>
  );
}
