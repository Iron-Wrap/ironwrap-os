import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Building2, ImageUp, Trash2 } from "lucide-react";
import { useId, useMemo, useRef, useState } from "react";

import { isOfflineSession } from "../auth/session";
import { useSession } from "../auth/session-context";
import { RoleGuard } from "../components/role-guard";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { Notice } from "../components/ui/notice";
import { ErrorState, LoadingState } from "../components/ui/state-panel";
import {
  adminErrorMessage,
  loadCompanyProfile,
  readFileAsBase64,
  removeCompanyLogo,
  saveCompanyProfile,
  uploadCompanyLogo,
} from "./admin-api";
import {
  companyProfileInput,
  companyProfileQueryKey,
  type CompanyProfileInput,
  type CompanyProfileResponse,
} from "./admin-contracts";
import { AdminPageHeader } from "./admin-shell";

interface FieldSpec {
  name: keyof Omit<CompanyProfileInput, "brand_labels">;
  label: string;
  hint?: string;
  type?: string;
  autoComplete?: string;
  required?: boolean;
}

const IDENTITY_FIELDS: readonly FieldSpec[] = [
  {
    name: "company_name",
    label: "Company name",
    hint: "The full name on your contracts and invoices.",
    required: true,
    autoComplete: "organization",
  },
  {
    name: "brand_name",
    label: "Short name",
    hint: "What customers see on the request form and in the app header.",
    required: true,
  },
  {
    name: "service_area",
    label: "What you do and where",
    hint: "Shown under your name on the customer request form.",
  },
];

const CONTACT_FIELDS: readonly FieldSpec[] = [
  { name: "phone", label: "Phone", type: "tel", autoComplete: "tel" },
  { name: "email", label: "Email", type: "email", autoComplete: "email" },
  { name: "website", label: "Website", type: "url", hint: "Start with https://" },
];

const ADDRESS_FIELDS: readonly FieldSpec[] = [
  { name: "address_line1", label: "Street address", autoComplete: "address-line1" },
  { name: "address_line2", label: "Unit or suite", autoComplete: "address-line2" },
  { name: "city", label: "City", autoComplete: "address-level2" },
  { name: "region", label: "Province or state", autoComplete: "address-level1" },
  { name: "postal_code", label: "Postal code", autoComplete: "postal-code" },
  { name: "country", label: "Country", autoComplete: "country-name" },
];

export function CompanyProfilePage() {
  return (
    <RoleGuard surface="owner">
      <CompanyProfileContent />
    </RoleGuard>
  );
}

function CompanyProfileContent() {
  const session = useSession();
  const queryClient = useQueryClient();
  const canEdit = !isOfflineSession(session);
  const profile = useQuery({
    queryKey: companyProfileQueryKey(session.tenant.id),
    queryFn: () => loadCompanyProfile(),
    enabled: canEdit,
  });

  if (!canEdit) {
    return (
      <AdminSection>
        <ErrorState
          title="Reconnect before changing company details"
          message="Company details are saved for everyone at once, so this screen needs a live connection."
        />
      </AdminSection>
    );
  }
  if (profile.isPending) return <LoadingState label="Loading your company details…" />;
  if (profile.isError) {
    return (
      <AdminSection>
        <ErrorState
          title="Company details could not load"
          message={adminErrorMessage(profile.error)}
          onRetry={() => void profile.refetch()}
        />
      </AdminSection>
    );
  }

  return (
    <CompanyProfileForm
      data={profile.data}
      onSaved={(next) => queryClient.setQueryData(companyProfileQueryKey(session.tenant.id), next)}
    />
  );
}

function CompanyProfileForm({
  data,
  onSaved,
}: {
  data: CompanyProfileResponse;
  onSaved: (next: CompanyProfileResponse) => void;
}) {
  const session = useSession();
  const [values, setValues] = useState<CompanyProfileInput>(() =>
    companyProfileInput(data.profile),
  );
  const [saved, setSaved] = useState(false);
  const logoInput = useRef<HTMLInputElement>(null);
  const [logoError, setLogoError] = useState<string>();
  const [logoBusy, setLogoBusy] = useState(false);

  const save = useMutation({
    mutationFn: () => saveCompanyProfile(session, values),
    onSuccess: (next) => {
      setSaved(true);
      onSaved(next);
    },
  });

  const dirty = useMemo(
    () => JSON.stringify(values) !== JSON.stringify(companyProfileInput(data.profile)),
    [data.profile, values],
  );

  function set(name: keyof Omit<CompanyProfileInput, "brand_labels">, value: string) {
    setSaved(false);
    save.reset();
    setValues((current) => ({ ...current, [name]: value }));
  }

  async function pickLogo(file: File | undefined) {
    if (!file || logoBusy) return;
    setLogoBusy(true);
    setLogoError(undefined);
    try {
      const dataBase64 = await readFileAsBase64(file);
      onSaved(await uploadCompanyLogo(session, { contentType: file.type, dataBase64 }));
    } catch (error) {
      setLogoError(adminErrorMessage(error));
    } finally {
      setLogoBusy(false);
      if (logoInput.current) logoInput.current.value = "";
    }
  }

  async function dropLogo() {
    if (logoBusy) return;
    setLogoBusy(true);
    setLogoError(undefined);
    try {
      onSaved(await removeCompanyLogo(session));
    } catch (error) {
      setLogoError(adminErrorMessage(error));
    } finally {
      setLogoBusy(false);
    }
  }

  return (
    <AdminSection>
      <AdminPageHeader
        icon={<Building2 className="size-6 text-accent" aria-hidden="true" />}
        title="Company details"
        description="Your name, logo and address. Everyone in the company sees this, and so do your customers on the request form."
      />

      <Card>
        <CardHeader>
          <CardTitle>Logo</CardTitle>
          <CardDescription>
            PNG, JPG, WEBP or SVG, up to {Math.round(data.logo_limits.max_bytes / 1024)} KB.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-center gap-4">
            <span className="grid size-20 shrink-0 place-items-center overflow-hidden rounded-lg border border-border bg-surface-muted">
              {data.logo_url ? (
                <img
                  src={data.logo_url}
                  alt={`${data.profile.company_name} logo`}
                  className="size-full object-contain p-1.5"
                />
              ) : (
                <Building2 className="size-7 text-muted" aria-hidden="true" />
              )}
            </span>
            <div className="flex min-w-0 flex-wrap gap-2">
              <Button
                type="button"
                variant="outline"
                busy={logoBusy}
                onClick={() => logoInput.current?.click()}
              >
                <ImageUp aria-hidden="true" />
                {data.logo_url ? "Replace logo" : "Upload logo"}
              </Button>
              {data.logo_url ? (
                <Button
                  type="button"
                  variant="ghost"
                  busy={logoBusy}
                  onClick={() => void dropLogo()}
                >
                  <Trash2 aria-hidden="true" />
                  Remove
                </Button>
              ) : null}
            </div>
          </div>
          <input
            ref={logoInput}
            type="file"
            className="sr-only"
            accept={data.logo_limits.content_types.join(",")}
            aria-label="Choose a logo file"
            onChange={(event) => void pickLogo(event.target.files?.[0])}
          />
          {logoError ? (
            <Notice tone="danger" title="That logo was not saved">
              {logoError}
            </Notice>
          ) : null}
        </CardContent>
      </Card>

      <form
        className="space-y-6"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          save.mutate();
        }}
      >
        <FieldGroup
          title="Name"
          description="What this company is called."
          fields={IDENTITY_FIELDS}
          values={values}
          onChange={set}
        />
        <FieldGroup
          title="How customers reach you"
          description="Used on customer-facing documents."
          fields={CONTACT_FIELDS}
          values={values}
          onChange={set}
        />
        <FieldGroup
          title="Address"
          description="Your main office or shop."
          fields={ADDRESS_FIELDS}
          values={values}
          onChange={set}
        />

        {save.isError ? (
          <Notice tone="danger" title="Company details were not saved">
            {adminErrorMessage(save.error)}
          </Notice>
        ) : null}
        {saved && !dirty ? (
          <Notice tone="success" title="Company details saved">
            Everyone in the company sees this now.
          </Notice>
        ) : null}

        <div className="sticky bottom-0 -mx-4 border-t border-border bg-surface/95 px-4 py-3 backdrop-blur-lg sm:mx-0 sm:rounded-lg sm:border sm:px-4">
          <Button type="submit" variant="accent" fullWidth busy={save.isPending} disabled={!dirty}>
            Save company details
          </Button>
        </div>
      </form>
    </AdminSection>
  );
}

function FieldGroup({
  title,
  description,
  fields,
  values,
  onChange,
}: {
  title: string;
  description: string;
  fields: readonly FieldSpec[];
  values: CompanyProfileInput;
  onChange: (name: FieldSpec["name"], value: string) => void;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-5 sm:grid-cols-2">
        {fields.map((field) => (
          <ProfileField
            key={field.name}
            field={field}
            value={values[field.name]}
            onChange={onChange}
          />
        ))}
      </CardContent>
    </Card>
  );
}

function ProfileField({
  field,
  value,
  onChange,
}: {
  field: FieldSpec;
  value: string;
  onChange: (name: FieldSpec["name"], value: string) => void;
}) {
  const id = useId();
  const hintId = `${id}-hint`;
  return (
    <div className="min-w-0 space-y-2">
      <label htmlFor={id} className="block text-sm font-bold">
        {field.label}
        {field.required ? <span className="text-danger"> *</span> : null}
      </label>
      <Input
        id={id}
        name={field.name}
        type={field.type ?? "text"}
        value={value}
        autoComplete={field.autoComplete}
        aria-describedby={field.hint ? hintId : undefined}
        onChange={(event) => onChange(field.name, event.target.value)}
      />
      {field.hint ? (
        <p id={hintId} className="text-xs leading-5 text-muted">
          {field.hint}
        </p>
      ) : null}
    </div>
  );
}

function AdminSection({ children }: { children: React.ReactNode }) {
  return <section className="mx-auto max-w-4xl space-y-6 pb-6">{children}</section>;
}
