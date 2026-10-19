import { useEffect, useState, type ComponentType } from "react";

import { Segmented } from "../components/ui/segmented";
import { Select } from "../components/ui/select";
import {
  AlertSection,
  AskSection,
  BriefSectionGallery,
  ConversationSection,
  DelegationSection,
  IdentitySection,
  MacroSection,
  ProposedSection,
  SourcesSection,
  TimelineSection,
} from "./ai-sections";
import { ButtonsSection, FieldsSection, StatusSection, StructureSection } from "./base-sections";
import { forceStates } from "./force-states";
import { ReceiptRowSection, ReceiptSection } from "./receipt-sections";

const MODES = [
  "office-light",
  "office-dark",
  "field-sun",
  "field-night",
  "shop-dark",
  "shop-light",
  "customer-light",
  "customer-dark",
  "customer-sun",
] as const;
const DENSITIES = ["office", "touch", "glove"] as const;
const WIDTHS = ["desktop", "phone"] as const;

const SECTIONS: { id: string; title: string; Section: ComponentType }[] = [
  { id: "buttons", title: "Buttons", Section: ButtonsSection },
  { id: "fields", title: "Fields", Section: FieldsSection },
  { id: "status", title: "Signal chips", Section: StatusSection },
  { id: "structure", title: "Tabs, chips, cards and details", Section: StructureSection },
  { id: "identity", title: "Who acted", Section: IdentitySection },
  { id: "delegation", title: "Delegation words", Section: DelegationSection },
  { id: "proposed", title: "Proposed, not accepted yet", Section: ProposedSection },
  { id: "sources", title: "Where a fact came from", Section: SourcesSection },
  { id: "receipt", title: "Receipts", Section: ReceiptSection },
  { id: "receipt-row", title: "Receipt rows", Section: ReceiptRowSection },
  { id: "ask", title: "Ask IronWrap", Section: AskSection },
  { id: "conversation", title: "Conversation", Section: ConversationSection },
  { id: "brief", title: "Brief", Section: BriefSectionGallery },
  { id: "macro", title: "Numbers the owner steers by", Section: MacroSection },
  { id: "timeline", title: "History", Section: TimelineSection },
  { id: "alert", title: "Found: risks and opportunities", Section: AlertSection },
];

interface View {
  mode: (typeof MODES)[number];
  density: (typeof DENSITIES)[number];
  width: (typeof WIDTHS)[number];
  section: string;
}

const pick = <T extends string>(options: readonly T[], value: string | null, fallback: T): T =>
  options.includes(value as T) ? (value as T) : fallback;

/** `?mode=field-sun&density=glove&width=phone&section=receipt`, so a screenshot can link here. */
function readView(): View {
  const params = new URLSearchParams(window.location.search);
  return {
    mode: pick(MODES, params.get("mode"), "office-light"),
    density: pick(DENSITIES, params.get("density"), "office"),
    width: pick(WIDTHS, params.get("width"), "desktop"),
    section: pick(
      SECTIONS.map((section) => section.id),
      params.get("section"),
      "all",
    ),
  };
}

/**
 * The System v2 component gallery: every base control and every AI primitive in every state, in
 * any of the nine colour modes and three densities, at desktop or phone width. Hover, pressed
 * and focus are forced per cell (force-states.ts). Dev server only: gallery.html is not an input
 * of the production build.
 */
export function Gallery() {
  const [view, setView] = useState<View>(readView);
  useEffect(() => forceStates(), []);
  useEffect(() => {
    const params = new URLSearchParams({
      mode: view.mode,
      density: view.density,
      width: view.width,
      section: view.section,
    });
    window.history.replaceState(null, "", `?${params.toString()}`);
  }, [view]);
  const update = (change: Partial<View>) => setView((current) => ({ ...current, ...change }));
  const shown = SECTIONS.filter(({ id }) => view.section === "all" || view.section === id);

  return (
    <div className="g-page">
      <header className="g-toolbar">
        <h1>Component gallery</h1>
        <label className="g-control">
          Colour mode
          <Select
            value={view.mode}
            onChange={(event) => update({ mode: pick(MODES, event.target.value, view.mode) })}
          >
            {MODES.map((mode) => (
              <option key={mode} value={mode}>
                {mode}
              </option>
            ))}
          </Select>
        </label>
        <div className="g-control">
          Density
          <Segmented variant="control" label="Density">
            {DENSITIES.map((density) => (
              <button
                key={density}
                type="button"
                aria-pressed={view.density === density}
                onClick={() => update({ density })}
              >
                {density}
              </button>
            ))}
          </Segmented>
        </div>
        <div className="g-control">
          Width
          <Segmented variant="control" label="Width">
            {WIDTHS.map((width) => (
              <button
                key={width}
                type="button"
                aria-pressed={view.width === width}
                onClick={() => update({ width })}
              >
                {width === "phone" ? "Phone, 390" : "Desktop"}
              </button>
            ))}
          </Segmented>
        </div>
        <label className="g-control">
          Section
          <Select
            value={view.section}
            onChange={(event) => update({ section: event.target.value })}
          >
            <option value="all">Every section</option>
            {SECTIONS.map(({ id, title }) => (
              <option key={id} value={id}>
                {title}
              </option>
            ))}
          </Select>
        </label>
      </header>
      <main
        className="g-canvas"
        data-mode={view.mode}
        data-density={view.density}
        data-width={view.width}
      >
        {shown.map(({ id, title, Section }) => (
          <section key={id} id={id} aria-labelledby={`${id}-title`} className="g-section">
            <h2 id={`${id}-title`}>{title}</h2>
            <Section />
          </section>
        ))}
      </main>
    </div>
  );
}
