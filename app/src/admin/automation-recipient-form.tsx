import { Save } from "lucide-react";
import { useState } from "react";

import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Notice } from "../components/ui/notice";
import { Select } from "../components/ui/select";
import { automationRecipientErrorMessage } from "./configuration-api";
import type { AutomationRecipient, AutomationRecipientWriteInput } from "./configuration-contracts";

/**
 * The one form that authors a recipient, used by the recipients screen and by the rule builder's
 * inline "add a recipient" panel. Two entry points, one form: a recipient added mid-rule must be
 * the same record, with the same rules, as one added from the list — otherwise the shortcut
 * quietly becomes a weaker way to configure who gets email.
 *
 * What it deliberately does NOT do is show an address it was given. The server publishes only a
 * masked form (`workers-bus/src/automation-recipients.ts`), so a revise that leaves the address
 * field empty omits the key entirely and the stored destination survives. Pre-filling the field
 * with `s***@shop.example` and posting it back would overwrite a real address with a mask.
 */

/** Mirrors `RECIPIENT_REF_PATTERN` in `workers-bus/src/automation-recipients.ts`. */
const RECIPIENT_REF_PATTERN = /^[A-Za-z0-9._:-]{1,120}$/;

/**
 * The reference an administrator gets for free from the name they typed.
 *
 * A reference is permanent and is what every rule stores, so asking an owner to invent one before
 * they have named the thing is asking them to make the irreversible decision first. They can still
 * overwrite it before the first save.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function recipientRefFromLabel(label: string): string {
  const slug = label
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.slice(0, 120);
}

/**
 * The same narrow address parse the server applies, run before the round trip.
 *
 * It is intentionally strict rather than permissive — one plain ASCII address, no display name, no
 * list, no whitespace — because that narrowness is what forecloses header injection into the mail
 * the effect runtime later builds. Keeping the client's rule looser would only mean the server
 * refuses a save the screen said was fine.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function recipientAddressProblem(value: string): string | null {
  const address = value.trim().toLowerCase();
  if (address.length < 3 || address.length > 320) return INVALID_ADDRESS;
  if (!/^[\x21-\x7e]+$/.test(address)) return INVALID_ADDRESS;
  const at = address.indexOf("@");
  if (at < 1 || at !== address.lastIndexOf("@") || at === address.length - 1)
    return INVALID_ADDRESS;
  const local = address.slice(0, at);
  const domain = address.slice(at + 1);
  if (
    local.length > 64 ||
    !/^[a-z0-9._%+-]+$/.test(local) ||
    local.startsWith(".") ||
    local.endsWith(".") ||
    local.includes("..")
  )
    return INVALID_ADDRESS;
  const labels = domain.split(".");
  if (domain.length < 4 || domain.length > 255 || labels.length < 2) return INVALID_ADDRESS;
  for (const label of labels)
    if (
      label.length < 1 ||
      label.length > 63 ||
      !/^[a-z0-9-]+$/.test(label) ||
      label.startsWith("-") ||
      label.endsWith("-")
    )
      return INVALID_ADDRESS;
  if (!/^[a-z]{2,24}$/.test(labels[labels.length - 1] ?? "")) return INVALID_ADDRESS;
  return null;
}

const INVALID_ADDRESS =
  "Enter one plain email address, such as shop@example.com. Do not add a display name, angle brackets, or a list.";

/**
 * What still stops this form saving, in the order an administrator fills it in. `null` means the
 * server is the only thing left that can refuse it.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function automationRecipientProblem(input: {
  label: string;
  recipientRef: string;
  address: string;
  existing: boolean;
}): string | null {
  if (input.label.trim().length === 0) return "Give this recipient a name.";
  if (!input.existing) {
    const ref = input.recipientRef.trim();
    if (ref.length === 0)
      return "Give this recipient a permanent reference. Your rules will store this name.";
    if (!RECIPIENT_REF_PATTERN.test(ref))
      return "A reference can hold letters, numbers, dots, dashes, colons, and underscores only.";
  }
  const address = input.address.trim();
  if (address.length === 0)
    return input.existing ? null : "Enter the email address this recipient delivers to.";
  return recipientAddressProblem(address);
}

export function AutomationRecipientForm({
  idPrefix,
  channels,
  initial,
  live,
  busy,
  error,
  submitLabel,
  nested = false,
  onCancel,
  onSubmit,
}: {
  idPrefix: string;
  channels: string[];
  /** Present when revising: the reference is frozen and the address may be left alone. */
  initial?: AutomationRecipient;
  live: boolean;
  busy: boolean;
  error: unknown;
  submitLabel: string;
  /**
   * Rendered inside the rule builder's own form. HTML has no nested forms - a browser gives the
   * inner submit button to the OUTER form, which submitted the half-composed rule and navigated
   * away from it. Nested, this renders a group instead and keeps Enter-to-save by hand.
   */
  nested?: boolean;
  onCancel: () => void;
  onSubmit: (input: AutomationRecipientWriteInput) => void;
}) {
  const existing = Boolean(initial);
  const [label, setLabel] = useState(initial?.label ?? "");
  const [recipientRef, setRecipientRef] = useState(initial?.recipient_ref ?? "");
  // Once an owner edits the reference by hand, the name stops driving it: re-deriving under them
  // would throw away a deliberate choice on the next keystroke.
  const [refEdited, setRefEdited] = useState(existing);
  const [address, setAddress] = useState("");
  const [channel, setChannel] = useState(initial?.channel ?? channels[0] ?? "email");
  const [submitted, setSubmitted] = useState(false);
  const problem = automationRecipientProblem({ label, recipientRef, address, existing });

  const save = () => {
    setSubmitted(true);
    if (!live || problem) return;
    const trimmedAddress = address.trim();
    onSubmit({
      ...(existing ? {} : { recipient_ref: recipientRef.trim() }),
      label: label.trim(),
      channel,
      // Omitted, never blanked: an absent key is what tells the server to keep the address it
      // already holds, and this client is never told what that address is.
      ...(trimmedAddress ? { destination: trimmedAddress.toLowerCase() } : {}),
    });
  };

  const body = (
    <>
      <div className="grid gap-5 sm:grid-cols-2">
        <RecipientField
          id={`${idPrefix}-label`}
          label="Name"
          hint="What your team calls it, such as The shop."
          value={label}
          onChange={(value) => {
            setLabel(value);
            if (!refEdited) setRecipientRef(recipientRefFromLabel(value));
          }}
        />
        <RecipientField
          id={`${idPrefix}-ref`}
          label="Reference"
          hint={
            existing
              ? "Permanent. Rules are bound to it, so it cannot be renamed."
              : "The permanent name your rules store, such as shop. It cannot change later."
          }
          value={recipientRef}
          disabled={existing}
          onChange={(value) => {
            setRefEdited(true);
            setRecipientRef(value);
          }}
        />
        <RecipientField
          id={`${idPrefix}-address`}
          type="email"
          label={existing ? "New email address" : "Email address"}
          hint={
            existing
              ? `Leave empty to keep the current address (${initial?.destination_masked ?? "hidden"}). Addresses are never shown in full.`
              : "Where this recipient's automation email is delivered. It is stored, never shown back in full."
          }
          value={address}
          onChange={setAddress}
        />
        {channels.length > 1 ? (
          <div className="space-y-2">
            <label className="block text-sm font-bold" htmlFor={`${idPrefix}-channel`}>
              Delivered by
            </label>
            <Select
              id={`${idPrefix}-channel`}
              value={channel}
              onChange={(event) => setChannel(event.target.value)}
            >
              {channels.map((entry) => (
                <option key={entry} value={entry}>
                  {channelLabel(entry)}
                </option>
              ))}
            </Select>
          </div>
        ) : (
          <p className="self-end text-xs leading-5 text-muted">
            Delivered by {channelLabel(channel)}. This deployment sends automation mail only.
          </p>
        )}
      </div>
      {submitted && problem ? (
        <Notice tone="warning" title="Not ready to save">
          {problem}
        </Notice>
      ) : null}
      {error ? (
        <Notice tone="danger" title="This recipient was not saved">
          {automationRecipientErrorMessage(error)}
        </Notice>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button
          type={nested ? "button" : "submit"}
          variant="accent"
          busy={busy}
          disabled={!live}
          onClick={nested ? save : undefined}
        >
          <Save aria-hidden="true" />
          {submitLabel}
        </Button>
        <Button type="button" variant="ghost" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </>
  );

  if (nested)
    return (
      <div
        className="space-y-5 border-t border-border pt-5"
        role="group"
        aria-label="Add a recipient"
        onKeyDown={(event) => {
          // What the missing <form> would have done: Enter in a text field saves it.
          if (event.key !== "Enter" || !(event.target instanceof HTMLInputElement)) return;
          event.preventDefault();
          save();
        }}
      >
        {body}
      </div>
    );
  return (
    <form
      className="space-y-5 border-t border-border pt-5"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        save();
      }}
    >
      {body}
    </form>
  );
}

function RecipientField({
  id,
  label,
  hint,
  value,
  type = "text",
  disabled = false,
  onChange,
}: {
  id: string;
  label: string;
  hint: string;
  value: string;
  type?: "text" | "email";
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <div className="space-y-2">
      <label className="block text-sm font-bold" htmlFor={id}>
        {label}
      </label>
      <Input
        id={id}
        type={type}
        value={value}
        disabled={disabled}
        autoComplete="off"
        aria-describedby={`${id}-hint`}
        onChange={(event) => onChange(event.target.value)}
      />
      <p id={`${id}-hint`} className="text-xs leading-5 text-muted">
        {hint}
      </p>
    </div>
  );
}

/** The server names its own channels; an unregistered one is shown as it was stored. */
function channelLabel(channel: string): string {
  return channel === "email" ? "email" : channel;
}
