import { CircleStop, Undo2 } from "lucide-react";
import { useId, type ReactNode } from "react";

import { cn } from "../../lib/cn";
import { Button } from "../ui/button";
import { Status } from "../ui/status";
import { SystemDetails } from "../ui/system-details";
import { PersonAvatar } from "./badge";
import { DelegationPill } from "./delegation";
import { AiName } from "./name";
import { SourceList, type SourceProps } from "./source";
import { type } from "./type";
import {
  appliedOf,
  deciderWords,
  initialsOf,
  receiptActions,
  receiptWords,
  type ActionClass,
  type ContractReceipt,
  type DelegationSetting,
  type ReceiptAction,
  type When,
} from "./words";

/** What a screen resolves around the contract receipt: names, plain labels and its own copy. */
export interface ReceiptDisplay {
  /** One line with the exact facts: "Final invoice for Ruth Okafor, CAD 9,860.00". */
  title: ReactNode;
  /**
   * When the step happened: a day word, the time and the zone. For a draft a person closed by
   * changing its record by hand, when they changed it; the card reads "Changed by hand · {when}".
   */
  when: When;
  /** One plain label per contract source, in the same order. */
  sources: SourceProps[];
  /** Names for the person ids on the receipt: the approver, the reviewer, who undid it. */
  people?: Record<string, string>;
  /** The outside system in plain words: "QuickBooks". */
  where?: string;
  /** When the approver approved and when the outside system confirmed: "today 10:31". */
  approvedWhen?: string;
  checkedWhen?: string;
  /** "Checked" in the screen's own words; by default it is built from the permit and read-back. */
  checked?: string;
  /** Why a person decides, in the screen's words; by default from the policy and reason code. */
  why?: string;
  delegation?: DelegationSetting;
  /** The action's class, for System details only. */
  actionClass?: ActionClass;
  /** Needs you: the one primary action, verb and object ("Approve final invoice"). */
  primary?: string;
  /** Needs you: what the primary does that cannot be taken back. */
  consequence?: string;
  /**
   * The way to change the agent's work (IRW-R8d R8d-2, in place of "Do it myself"): the button reads
   * "Edit {object}" ("Edit the invoice"); its line says what it opens ("Opens the invoice with this
   * draft filled in"), that it does not undo anything, and `after`, what happens to the edit in the
   * screen's words ("The hold stays until Grace Obi decides."). For a viewer who does not decide,
   * `after` says they may edit and where the edit goes; the line ends "{decider} still decides."
   * unless `after` already names the decider.
   */
  edit?: { object: string; opens: string; after?: string };
  /** Done for you: until when Undo works ("today 18:00"), and what it puts back. */
  undoUntil?: string;
  undoDoes?: string;
  /** Done for you, when a person undoes it by hand: "You can still cancel it in QuickBooks until it is paid." */
  undoManual?: string;
  /** Done for you: why it cannot be undone ("the email was delivered"). */
  cannotUndo?: string;
  /** Held: the one next step in the screen's words, and its button. */
  nextStep?: string;
  nextAction?: string;
  /** Done for you, for a standing watch: "Stop the storm watch". */
  stop?: string;
  /** What stopping does, said before the press: "Ends the hail alerts. You can ask IronWrap to start it again." */
  stopNote?: string;
  /**
   * Who declined, undid or did the step instead (a person id in `people`, or a name). A step a
   * person did shows that person's initials circle in the header, never the AI badge.
   */
  by?: string;
  /** A person's answer still on its way: "the phone". */
  waitingFor?: string;
  /**
   * Needs you, for a viewer who does not decide: what this viewer may and may not do, addressed
   * to them ("You may change this invoice. You cannot approve it; Dana Whitford approves it.").
   */
  viewerPart?: string;
  /**
   * Undone, replaced or done by a person: what happened since, in one sentence. By default a
   * closed people-only draft says it in its own words (`supersededNote`, `appliedByPersonNote`).
   */
  since?: string;
  /** What a people-only draft changes, for that closing line: "Grace Obi's role". */
  record?: string;
  /** The signed-in person's id: a step they did reads "You", never their own name. */
  viewer?: string;
}

function Row({
  label,
  children,
  strong,
}: {
  label: string;
  children: ReactNode;
  strong?: boolean;
}) {
  return (
    <div className="grid grid-cols-[8rem_minmax(0,1fr)] items-start gap-x-3 phone:grid-cols-1 phone:gap-y-0.5">
      <dt className={cn(type.caption, "pt-0.5 font-semibold text-text-secondary phone:pt-0")}>
        {label}
      </dt>
      <dd className={cn(type.body, "min-w-0 text-text-primary", strong && "font-semibold")}>
        {children}
      </dd>
    </div>
  );
}

/**
 * One agent step (Board 6, AI/Receipt): who did it, what it did, what it is doing, what it needs
 * from you, where each fact came from, why it waits for a person, what the outside system read
 * back, and what you can do with it (Edit, Undo). Permit, tool, class and run stay behind System
 * details. It takes the contract receipt as the Worker emits it and the names the screen resolves.
 *
 * A button shows only with its handler, and Edit only with its screen and its words.
 * Needs you is the viewer's: only `viewerMayDecide` makes it blue with the primary; anyone else
 * reads "Waiting on {who decides}" in ink.
 *
 * In touch and glove density, on a coarse pointer, in a window 720px wide or narrower, or in a
 * container narrower than 30rem it takes the phone layout: labels above values, state under the
 * name, full-width actions 48px or taller.
 */
export function Receipt({
  receipt,
  display,
  headingLevel = 3,
  viewerMayDecide = false,
  onPrimary,
  onEdit,
  onUndo,
  onNext,
  onStop,
  className,
}: {
  receipt: ContractReceipt;
  display: ReceiptDisplay;
  headingLevel?: 2 | 3 | 4;
  /** The viewer may decide this step: Needs you turns blue and offers the primary action. */
  viewerMayDecide?: boolean;
  onPrimary?: () => void;
  onEdit?: () => void;
  onUndo?: () => void;
  onNext?: () => void;
  onStop?: () => void;
  className?: string;
}) {
  const id = useId();
  const people = display.people ?? {};
  // People ids resolve through `people`; an id the screen cannot name reads "a person", never the
  // id. Only `display.by` may already be a name.
  const name = (person: string | null | undefined) =>
    person ? (people[person] ?? undefined) : undefined;
  const where = display.where ?? "the other system";
  // A closed draft says what a person set by hand and who: their id resolves like any other.
  const applied = appliedOf(receipt.do_it_myself.context);
  const by = display.by ? (people[display.by] ?? display.by) : name(applied?.by);
  // The person who acted is the one reading: the card says "You" (ruling: actor is viewer).
  const byViewer = Boolean(display.viewer) && (display.by ?? applied?.by) === display.viewer;
  const words = receiptWords(receipt, {
    by,
    where,
    waitingFor: display.waitingFor,
    record: display.record,
    applied,
    byViewer,
    when: display.when.text,
  });
  const { state } = words;
  // A closed draft's note is what happened since. A done answer's note (VIEW_REFUSED) points at the
  // answer text above it, so it stands under the answer in the conversation, never on this card.
  const since =
    display.since ?? (state === "replaced" || state === "done_by_person" ? words.note : undefined);
  const Heading = `h${headingLevel}` as const;
  const when = display.when.at ? (
    <time dateTime={display.when.at}>{display.when.text}</time>
  ) : (
    display.when.text
  );

  const approver = receipt.permit.approved_by
    ? (name(receipt.permit.approved_by) ?? "a person")
    : undefined;
  // A closed people-only draft's read-back names the record a person changed or the newer draft,
  // not a check in an outside system; its note says what happened, so it has no Checked line.
  const closedDraft =
    receipt.outcome === "succeeded" && (state === "done_by_person" || state === "replaced");
  const checked =
    display.checked ??
    ([
      approver
        ? `Approved by ${approver}${display.approvedWhen ? ` ${display.approvedWhen}` : ""}.`
        : null,
      receipt.readback && !closedDraft
        ? `Checked in ${where}${display.checkedWhen ? ` ${display.checkedWhen}` : ""}: ${
            receipt.readback.matched ? "matches" : "does not match"
          }.`
        : receipt.tool && state !== "needs_you" && !closedDraft
          ? "Not checked yet."
          : null,
    ]
      .filter(Boolean)
      .join(" ") ||
      undefined);

  // Needs you waits on one person or role; a viewer who may not decide reads who, in ink.
  const ask = receipt.needs_from_you;
  const waitingOn =
    state === "needs_you" && !viewerMayDecide
      ? ask
        ? deciderWords(ask.reviewer_role, name(ask.person_id))
        : { waiting: "Waiting on a person", decides: undefined }
      : undefined;
  // Editing does not go around the decision (gate r3, R3-1): say so beside the Edit button, by
  // name, by role ("The owner"), or "A person".
  const deciderName = ask ? name(ask.person_id) : undefined;
  const decider = waitingOn?.waiting.replace(/^Waiting on /, "");
  const stillDecides = decider
    ? `${decider.charAt(0).toUpperCase()}${decider.slice(1)} still decides.`
    : undefined;
  const why =
    state === "needs_you"
      ? (display.why ?? "A person approves this kind of step before it runs.")
      : state === "held"
        ? (display.why ?? words.why)
        : undefined;
  const doing = receipt.doing ?? words.waiting;
  // A standing watch is stopped, not undone: Stop and its note stand in place of Undo.
  const watch = Boolean(display.stop);
  const actions = receiptActions(state, {
    primary: Boolean(onPrimary) && !waitingOn,
    next: Boolean(display.nextAction && onNext),
    stop: Boolean(display.stop && onStop),
    undo: receipt.undo.available && receipt.undo.mode === "automatic" && Boolean(onUndo) && !watch,
    edit: Boolean(onEdit && receipt.do_it_myself.surface && display.edit),
  });
  const offers = (action: ReceiptAction["id"]) => actions.some(({ id }) => id === action);
  const until = display.undoUntil ? ` until ${display.undoUntil}` : "";
  // Undo has its own line, only in Done for you: the window and what it puts back next to the
  // button, the way to undo it by hand, or why it cannot be undone. A watch says it in its stop note.
  const undoLine =
    state !== "done" || watch
      ? undefined
      : offers("undo")
        ? `You can undo this${until}.${display.undoDoes ? ` ${display.undoDoes}` : ""}`
        : receipt.undo.available && receipt.undo.mode === "manual"
          ? (display.undoManual ?? `You can undo this yourself${until}.`)
          : receipt.undo.available && receipt.undo.mode === "automatic"
            ? undefined
            : `Can't be undone${display.cannotUndo ? `: ${display.cannotUndo.replace(/[.!?]?$/, ".")}` : "."}`;
  const consequenceId = `${id}-consequence`;
  const editId = `${id}-edit`;
  const stopNoteId = `${id}-stop-note`;
  const undoLineId = `${id}-undo`;
  const fullWidth = "phone:w-full phone:min-h-[max(3rem,var(--control-height))]";

  const button = ({ id: action, rank }: ReceiptAction) => {
    switch (action) {
      case "primary":
        return (
          <Button
            key={action}
            variant={rank}
            className={fullWidth}
            aria-describedby={display.consequence ? consequenceId : undefined}
            onClick={onPrimary}
          >
            {display.primary ?? "Review"}
          </Button>
        );
      case "next":
        return (
          <Button key={action} variant={rank} className={fullWidth} onClick={onNext}>
            {display.nextAction}
          </Button>
        );
      case "stop":
        return (
          <Button
            key={action}
            variant={rank}
            className={fullWidth}
            aria-describedby={display.stopNote ? stopNoteId : undefined}
            onClick={onStop}
          >
            <CircleStop aria-hidden="true" />
            {display.stop}
          </Button>
        );
      case "undo":
        return (
          <Button
            key={action}
            variant={rank}
            className={fullWidth}
            aria-describedby={undoLineId}
            onClick={onUndo}
          >
            <Undo2 aria-hidden="true" />
            Undo
          </Button>
        );
      case "edit":
        return (
          <Button
            key={action}
            variant={rank}
            className={fullWidth}
            aria-describedby={editId}
            onClick={onEdit}
          >
            Edit {display.edit?.object}
          </Button>
        );
    }
  };

  return (
    <article
      aria-labelledby={`${id}-title`}
      data-state={state}
      className={cn(
        "@container grid gap-3 rounded-[var(--radius-card)] border px-5 py-4 text-text-primary",
        state === "needs_you" && !waitingOn
          ? "border-signal-you-tint-edge bg-signal-you-tint"
          : state === "held"
            ? "border-signal-held-line bg-signal-held-tint"
            : "border-line-hairline bg-surface-paper",
        className,
      )}
    >
      <header className="flex flex-wrap items-center gap-2">
        {state === "done_by_person" ? (
          // A person did it: their circle, or a neutral one when nobody named them; never the badge.
          <span className="inline-flex min-w-0 items-center gap-2.5">
            <PersonAvatar initials={by ? initialsOf({ name: by }) : undefined} decorative />
            <span className="grid min-w-0">
              <span className={cn(type.body, "font-semibold")}>
                {byViewer ? "You" : (by ?? "A person")}
              </span>
              {/* A closed draft has two moments; its time is the hand change that closed it (gate c2).
                  Only applied_by_person reaches this branch closed: a replaced draft has the AI header. */}
              <span className={cn(type.caption, "text-text-secondary")}>
                {closedDraft ? <>Changed by hand · {when}</> : when}
              </span>
            </span>
          </span>
        ) : (
          <AiName who={receipt.specialist_id} size="header" line={when} />
        )}
        <span className="ml-auto flex flex-wrap items-center gap-2 phone:ml-0 phone:basis-full">
          {display.delegation ? <DelegationPill setting={display.delegation} /> : null}
          {waitingOn ? (
            <Status kind="pending">{waitingOn.waiting}</Status>
          ) : (
            <Status kind={words.kind}>{words.words}</Status>
          )}
        </span>
      </header>
      <Heading id={`${id}-title`} className={cn(type.leadHeading, "font-semibold")}>
        {display.title}
      </Heading>
      <dl className="grid gap-2">
        {receipt.did ? <Row label="Did">{receipt.did}</Row> : null}
        {doing && state === "working" ? <Row label="Doing">{doing}</Row> : null}
        {/* A viewer who does not decide reads whom it asks, not an order to approve (gate R3b-3). */}
        {ask && state === "needs_you" ? (
          <Row label={decider ? `What ${decider} is asked` : "Needs you"} strong={!waitingOn}>
            {ask.ask}
          </Row>
        ) : null}
        {waitingOn?.decides ? <Row label="Who decides">{waitingOn.decides}</Row> : null}
        {/* Gate r8d8: the card says who the viewer is in it, not only who decides. */}
        {waitingOn && display.viewerPart ? <Row label="Your part">{display.viewerPart}</Row> : null}
        {display.sources.length ? (
          <Row label="Where this came from">
            <SourceList sources={display.sources} />
          </Row>
        ) : null}
        {why ? (
          <Row
            label={
              state === "held"
                ? "Why it waits"
                : waitingOn
                  ? "Why a person decides"
                  : "Why it asks you"
            }
          >
            {why}
          </Row>
        ) : null}
        {state === "held" ? <Row label="Next step">{display.nextStep ?? words.next}</Row> : null}
        {since ? <Row label="Since then">{since}</Row> : null}
        {checked ? <Row label="Checked">{checked}</Row> : null}
      </dl>
      {actions.length ? (
        <div className="flex flex-wrap items-center gap-2 phone:flex-col phone:items-stretch">
          {actions.map(button)}
        </div>
      ) : null}
      {display.consequence && offers("primary") ? (
        <p id={consequenceId} className={cn(type.caption, "font-semibold text-text-primary")}>
          {display.consequence}
        </p>
      ) : null}
      {undoLine ? (
        <p id={undoLineId} className={cn(type.caption, "text-text-secondary")}>
          {undoLine}
        </p>
      ) : null}
      {display.stopNote && offers("stop") ? (
        <p id={stopNoteId} className={cn(type.caption, "font-semibold text-text-primary")}>
          {display.stopNote}
        </p>
      ) : null}
      {offers("edit") && display.edit ? (
        // IRW-R8d R8d-2: what Edit opens, that it undoes nothing (gate r8d: plainer than "reverts
        // nothing"), and what happens to the edit. Named, so the line reads as that button's.
        <p id={editId} className={cn(type.caption, "text-text-secondary")}>
          <span className="font-semibold" aria-hidden="true">
            Edit {display.edit.object}:
          </span>{" "}
          {display.edit.opens.replace(
            /(?:[;,.]?\s*(?:and\s+)?(?:reverts nothing|it does not undo anything))?[.;!?…\s]*$/i,
            "",
          )}
          . It does not undo anything.
          {display.edit.after ? ` ${display.edit.after}` : null}
          {
            // The screen's after-clause may already name who decides; otherwise say it here, so a
            // line written for the decider never leaves a viewer who does not without a name.
            stillDecides && !(deciderName && display.edit.after?.includes(deciderName))
              ? ` ${stillDecides}`
              : null
          }
        </p>
      ) : null}
      <SystemDetails className={type.caption}>
        <dl className="grid gap-1 pb-2 text-text-secondary [&_code]:font-mono [&_code]:text-text-primary">
          <div>
            <dt className="inline font-semibold">Run </dt>
            <dd className="inline">
              <code>{receipt.run_id}</code>
            </dd>
          </div>
          <div>
            <dt className="inline font-semibold">Action </dt>
            <dd className="inline">
              <code>{receipt.action_id}</code>
              {display.actionClass ? (
                <>
                  {" "}
                  class <code>{display.actionClass}</code>
                </>
              ) : null}
            </dd>
          </div>
          <div>
            <dt className="inline font-semibold">Policy </dt>
            <dd className="inline">
              <code>{receipt.policy.policy_id}</code> version <code>{receipt.policy.version}</code>{" "}
              result <code>{receipt.policy.result}</code>
              {receipt.policy.reason_codes.map((code) => (
                <span key={code}>
                  {" "}
                  reason <code>{code}</code>
                </span>
              ))}
              {receipt.policy.checks.map((check) => (
                <span key={check.check}>
                  {" "}
                  check <code>{check.check}</code> {check.passed ? "passed" : "failed"}
                </span>
              ))}
            </dd>
          </div>
          <div>
            <dt className="inline font-semibold">Permit </dt>
            <dd className="inline">
              <code>{receipt.permit.kind}</code>
              {receipt.permit.permit_id ? (
                <>
                  {" "}
                  permit <code>{receipt.permit.permit_id}</code>
                </>
              ) : null}
              {receipt.permit.approval_id ? (
                <>
                  {" "}
                  approval <code>{receipt.permit.approval_id}</code>
                </>
              ) : null}
              {receipt.permit.delegation_id ? (
                <>
                  {" "}
                  delegation <code>{receipt.permit.delegation_id}</code>
                </>
              ) : null}
            </dd>
          </div>
          {receipt.tool ? (
            <div>
              <dt className="inline font-semibold">Tool </dt>
              <dd className="inline">
                <code>{receipt.tool.name}</code> binding <code>{receipt.tool.binding}</code> key{" "}
                <code>{receipt.tool.idempotency_key}</code> request hash{" "}
                <code>{receipt.tool.request_hash}</code>
              </dd>
            </div>
          ) : null}
          {receipt.readback ? (
            <div>
              <dt className="inline font-semibold">Read back </dt>
              <dd className="inline">
                <code>{receipt.readback.source}</code> reference{" "}
                <code>{receipt.readback.reference}</code> response hash{" "}
                <code>{receipt.readback.response_hash}</code>{" "}
                {receipt.readback.matched ? "matched" : "did not match"}
              </dd>
            </div>
          ) : null}
          {receipt.sources.map((source) => (
            <div key={`${source.fact_id}@${source.version}`}>
              <dt className="inline font-semibold">Fact </dt>
              <dd className="inline">
                <code>{source.fact_id}</code> version <code>{source.version}</code>
                {source.hash ? (
                  <>
                    {" "}
                    hash <code>{source.hash}</code>
                  </>
                ) : null}
              </dd>
            </div>
          ))}
          <div>
            <dt className="inline font-semibold">Undo </dt>
            <dd className="inline">
              <code>{receipt.undo.mode}</code>
              {receipt.undo.action_id ? (
                <>
                  {" "}
                  by <code>{receipt.undo.action_id}</code>
                </>
              ) : null}{" "}
              {receipt.undo.available ? "available" : "not available"}
            </dd>
          </div>
          {receipt.do_it_myself.surface ? (
            <div>
              <dt className="inline font-semibold">Edit opens </dt>
              <dd className="inline">
                <code>{receipt.do_it_myself.surface}</code>
              </dd>
            </div>
          ) : null}
        </dl>
      </SystemDetails>
    </article>
  );
}
