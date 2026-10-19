import { Camera, ChevronLeft } from "lucide-react";
import { useState } from "react";

import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { Dialog } from "../components/ui/dialog";
import { Field } from "../components/ui/field";
import { Input } from "../components/ui/input";
import { Notice } from "../components/ui/notice";
import { Segmented, SegmentedCount } from "../components/ui/segmented";
import { Select } from "../components/ui/select";
import { Status, type StatusKind } from "../components/ui/status";
import { SystemDetails } from "../components/ui/system-details";
import { Textarea } from "../components/ui/textarea";

/** The interaction states a gallery cell can force: see force-states.ts. */
const FORCED = {
  Default: {},
  Hover: { "data-force-hover": "" },
  Pressed: { "data-force-active": "" },
  Focus: { "data-force-focus": "" },
} as const;

const KINDS = [
  ["Primary", "primary"],
  ["You", "you"],
  ["Secondary", "secondary"],
  ["Ghost", "quiet"],
  ["Held", "danger"],
] as const;
const SIZES = [
  ["Small", "small"],
  ["Default", "default"],
  ["Large", "large"],
] as const;

/** Board 1: every kind and size in every state. */
export function ButtonsSection() {
  return (
    <>
      <p className="g-note">
        Kinds keep one meaning each: You is blue only when it answers something waiting on the
        viewer; Held is red only for a stop. Filled kinds do not change on hover, pressed recolours,
        disabled recolours and never fades, busy keeps the label. Heights follow the density.
      </p>
      <div className="g-matrix">
        <table>
          <thead>
            <tr>
              <th scope="col">Kind and size</th>
              {[...Object.keys(FORCED), "Disabled", "Busy"].map((state) => (
                <th key={state} scope="col">
                  {state}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {KINDS.flatMap(([kindName, variant]) =>
              SIZES.map(([sizeName, size]) => (
                <tr key={`${variant}-${size}`}>
                  <th scope="row">
                    {kindName} · {sizeName}
                  </th>
                  {Object.entries(FORCED).map(([state, force]) => (
                    <td key={state}>
                      <Button variant={variant} size={size} {...force}>
                        Save measurement
                      </Button>
                    </td>
                  ))}
                  <td>
                    <Button variant={variant} size={size} disabled>
                      Save measurement
                    </Button>
                  </td>
                  <td>
                    <Button variant={variant} size={size} busy>
                      Save measurement
                    </Button>
                  </td>
                </tr>
              )),
            )}
          </tbody>
        </table>
      </div>
      <h3>In use</h3>
      <div className="g-row">
        <Button variant="you">Approve change order</Button>
        <Button>
          <Camera aria-hidden="true" />
          Take photo
        </Button>
        <Button variant="secondary">See coil order</Button>
        <Button variant="quiet">
          <ChevronLeft aria-hidden="true" />
          Previous
        </Button>
        <Button variant="danger">Stop work</Button>
        <Button size="icon" variant="secondary" aria-label="Take photo">
          <Camera aria-hidden="true" />
        </Button>
      </div>
    </>
  );
}

function TextStates() {
  const help = "Can't scan? Type the number.";
  return (
    <div className="g-grid">
      <Field label="Coil or part number" help={help}>
        {(control) => <Input {...control} placeholder="Coil PMS-2231" />}
      </Field>
      <Field label="Coil or part number" help={help}>
        {(control) => <Input {...control} defaultValue="PMS-2213" />}
      </Field>
      <Field label="Coil or part number" help={help}>
        {(control) => <Input {...control} defaultValue="PMS-2213" data-force-hover="" />}
      </Field>
      <Field label="Coil or part number" help={help}>
        {(control) => <Input {...control} defaultValue="PMS-2213" data-force-focus="" />}
      </Field>
      <Field
        label="Coil or part number"
        error="Coil PMS-2213 is not on file. Check the number on the label."
      >
        {(control) => <Input {...control} defaultValue="PMS-2213" />}
      </Field>
      <Field label="Coil or part number" help={help}>
        {(control) => <Input {...control} defaultValue="PMS-2213" disabled />}
      </Field>
      <Field label="Coil or part number" help="Set by the shop when the coil arrived.">
        {(control) => <Input {...control} defaultValue="PMS-2213" readOnly />}
      </Field>
      <Field label="Coil or part number" busy>
        {(control) => <Input {...control} defaultValue="PMS-2213" />}
      </Field>
      <Field label="South slope area" unknown="Not measured yet" help="The measurer adds it." />
    </div>
  );
}

function SelectStates() {
  const options = (
    <>
      <option value="">Choose the area</option>
      <option value="south">South eave</option>
      <option value="north">North eave</option>
    </>
  );
  return (
    <div className="g-grid">
      <Field label="What you measured" help="From the area you are in.">
        {(control) => <Select {...control}>{options}</Select>}
      </Field>
      <Field label="What you measured" help="From the area you are in.">
        {(control) => (
          <Select {...control} defaultValue="south">
            {options}
          </Select>
        )}
      </Field>
      <Field label="What you measured" help="From the area you are in.">
        {(control) => (
          <Select {...control} defaultValue="south" data-force-hover="">
            {options}
          </Select>
        )}
      </Field>
      <Field label="What you measured" help="From the area you are in.">
        {(control) => (
          <Select {...control} defaultValue="south" data-force-focus="">
            {options}
          </Select>
        )}
      </Field>
      <Field label="What you measured" error="Choose the area before you save.">
        {(control) => <Select {...control}>{options}</Select>}
      </Field>
      <Field label="What you measured" help="From the area you are in.">
        {(control) => (
          <Select {...control} defaultValue="south" disabled>
            {options}
          </Select>
        )}
      </Field>
      <Field label="What you measured" busy busyText="Loading the areas…">
        {(control) => <Select {...control}>{options}</Select>}
      </Field>
      <Field label="Crew" help="The crew's large select on a phone.">
        {(control) => (
          <Select {...control} field defaultValue="north">
            <option value="north">North crew</option>
            <option value="south">South crew</option>
          </Select>
        )}
      </Field>
    </div>
  );
}

function TextareaStates() {
  const value = "First piece is 1⅜″ short at the eave end.";
  const help = "The office reads this with the photo.";
  return (
    <div className="g-grid">
      <Field label="What happened" help={help}>
        {(control) => <Textarea {...control} placeholder="Say what you saw" />}
      </Field>
      <Field label="What happened" help={help}>
        {(control) => <Textarea {...control} defaultValue={value} />}
      </Field>
      <Field label="What happened" help={help}>
        {(control) => <Textarea {...control} defaultValue={value} data-force-hover="" />}
      </Field>
      <Field label="What happened" help={help}>
        {(control) => <Textarea {...control} defaultValue={value} data-force-focus="" />}
      </Field>
      <Field label="What happened" error="Add a few words so the office knows what to check.">
        {(control) => <Textarea {...control} />}
      </Field>
      <Field label="What happened" help={help}>
        {(control) => <Textarea {...control} defaultValue={value} disabled />}
      </Field>
      <Field label="What happened" help="Sent with the photo; it cannot change now.">
        {(control) => <Textarea {...control} defaultValue={value} readOnly />}
      </Field>
    </div>
  );
}

/** Board 2: text, select and text area in every state, labels above and help under. */
export function FieldsSection() {
  return (
    <>
      <p className="g-note">
        Every resting edge is the control border at the density's edge width. Hover fills on the
        office, focus is the ink ring, an error says the one next step, read-only sits on the rail,
        and a value nobody has measured is words in a dashed edge, never 0.
      </p>
      <h3>Text</h3>
      <TextStates />
      <h3>Select</h3>
      <SelectStates />
      <h3>Text area</h3>
      <TextareaStates />
    </>
  );
}

const CHIPS: [StatusKind, string][] = [
  ["you", "Needs you"],
  ["stopped", "Held"],
  ["done", "Done for you"],
  ["working", "Working on it"],
  ["proposed", "Proposed"],
  ["unknown", "Not measured yet"],
  ["undone", "Undone by Dana Whitford"],
  ["pending", "Waiting on the office"],
  ["local", "On phone, not sent yet"],
  ["confirmed", "Sent to the office"],
  ["attention", "Check before you send"],
  ["neutral", "Offline"],
  ["retired", "Replaced"],
];

/** Board 3: the signal chip, every kind in words with its own glyph. */
export function StatusSection() {
  return (
    <>
      <p className="g-note">
        Two signals, one meaning each: red is held or stopped, blue is the viewer being waited on.
        Every other kind is ink with a glyph and words; proposed has a dotted edge and not known yet
        a dashed one.
      </p>
      <div className="g-grid">
        {CHIPS.map(([kind, words]) => (
          <span key={kind} className="g-cell">
            <Status kind={kind}>{words}</Status>
          </span>
        ))}
      </div>
    </>
  );
}

/** Section tabs, filter chips, the segmented control, cards, notices and System details. */
export function StructureSection() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <h3>Section tabs</h3>
      <Segmented variant="tabs" label="Job sections">
        <a href="#structure" aria-current="page">
          Everything
        </a>
        <a href="#structure">Money</a>
        <a href="#structure" data-force-hover="">
          Photos
        </a>
        <a href="#structure" data-force-focus="">
          Crew
        </a>
      </Segmented>
      <h3>Filter chips</h3>
      <Segmented variant="filters" label="Lead filters">
        <button type="button" aria-pressed="true">
          Open <SegmentedCount>4</SegmentedCount>
        </button>
        <button type="button" aria-pressed="false">
          Waiting
        </button>
        <button type="button" aria-pressed="false" data-force-hover="">
          Hover
        </button>
        <button type="button" aria-pressed="false" data-force-active="">
          Pressed
        </button>
        <button type="button" aria-pressed="false" data-force-focus="">
          Focus
        </button>
        <button type="button" aria-pressed="false" disabled>
          Disabled
        </button>
      </Segmented>
      <h3>Segmented control</h3>
      <Segmented variant="control" label="Appearance">
        <button type="button" aria-pressed="true">
          Light
        </button>
        <button type="button" aria-pressed="false">
          Dark
        </button>
        <button type="button" aria-pressed="false">
          Device
        </button>
      </Segmented>
      <h3>Card and notices</h3>
      <div className="g-grid" data-wide="">
        <Card className="g-card">
          <strong>You owe nothing today.</strong>
          <p className="g-note">Next: CAD 9,210.00 when your roof is installed.</p>
        </Card>
        <Notice tone="danger" title="Coil PMS-2231 is held.">
          Its first piece failed. Next step: add the first-piece measurement.
        </Notice>
        <Notice tone="local" title="Saved on this phone, not sent yet.">
          It sends to the office by itself when you have signal.
        </Notice>
        <Notice tone="neutral" title="Coil PMS-2213 is not on file.">
          Check the number on the label. Next step: call the office.
        </Notice>
      </div>
      <h3>System details and a dialog</h3>
      <div className="g-panel">
        <SystemDetails>
          <p>Request ID approval:42</p>
        </SystemDetails>
      </div>
      <div className="g-row">
        <Button variant="secondary" onClick={() => setOpen(true)}>
          Open the dialog
        </Button>
      </div>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="Approve the change order for the Harlow job?"
        description="Kara Harlow sees the new price before anything is ordered."
        footer={
          <>
            <Button variant="quiet" onClick={() => setOpen(false)}>
              Not now
            </Button>
            <Button variant="you" onClick={() => setOpen(false)}>
              Approve change order
            </Button>
          </>
        }
      >
        <p>Starts the re-cut of two parts from a new coil.</p>
      </Dialog>
    </>
  );
}
