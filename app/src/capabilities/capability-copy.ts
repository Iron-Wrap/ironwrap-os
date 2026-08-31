import { officeDetail, type Capability, type CapabilityState } from "./capability-contracts";

/**
 * Plain-language copy for a capability a screen cannot use.
 *
 * Four things every unavailable state has to say (annex §6.1, §6 item 4): what the state is, why,
 * the next valid action with its actor and prerequisite, and a path to a person. Nothing here
 * offers a retry: neither a switched-off flag nor a missing setting is fixed by pressing a button
 * again, and a control that cannot succeed must not offer to try.
 *
 * ## Why no "turn it on in Settings" link
 *
 * The G1.5 spec proposed "An owner turns this on in Settings → Integrations". That screen cannot
 * do it. `/settings/integrations` is a read-only readiness view — it says so itself ("There is no
 * generic hook or integration CRUD endpoint behind this screen") — and every flag behind these
 * capabilities is a Worker binding in `workers-bus/wrangler.jsonc`, changed by a redeploy. Naming
 * a screen that cannot make the change would be the same defect one level down: an honest-looking
 * sentence pointing at nothing. So the copy says where the change really happens and who to ask,
 * and the gap between "the administrator should be able to" and "an engineer has to" is reported
 * to the product owner rather than papered over here (ELEC-236 finding).
 */
export interface CapabilityCopy {
  /** Short visible state name. Never icon-only: colour and icon must not carry meaning alone. */
  stateLabel: string;
  title: string;
  message: string;
  /** The next valid action, naming the actor and the prerequisite. */
  nextAction: string;
  /** A person a reader can actually reach. Never a dead link — none of these has a request flow. */
  personPath: string;
}

export type CapabilityViewerRole = string;

function administersDeployment(role: CapabilityViewerRole): boolean {
  return role === "owner" || role === "ops";
}

/** Where the change really happens, said the same way everywhere. */
function enablementAction(role: CapabilityViewerRole): string {
  return administersDeployment(role)
    ? "Switching it on is a change to this deployment's configuration, not a setting on any screen in IronWrap yet. Whoever deploys IronWrap for your company has to make it."
    : "An administrator has to switch it on. It is a deployment setting, so it is not something any screen in IronWrap can change yet.";
}

function configurationAction(role: CapabilityViewerRole, missing: readonly string[]): string {
  if (administersDeployment(role) && missing.length > 0) {
    return `An administrator has to finish the setup this needs: ${missing.join(", ")}. Until then the first use fails.`;
  }
  return "An administrator has to finish the setup this needs before anyone uses it. Until then the first use fails.";
}

function personPathFor(role: CapabilityViewerRole): string {
  return administersDeployment(role)
    ? "Ask whoever administers this IronWrap deployment. No one can make this change from inside the app."
    : "Ask your owner or operations lead — they can reach whoever administers this IronWrap deployment.";
}

const stateLabels: Record<CapabilityState, string> = {
  absent: "Not in this build",
  off: "Turned off",
  unconfigured: "Setup not finished",
  dependency_blocked: "Waiting on something else",
  unknown: "State not confirmed",
  available: "Reachable",
};

/**
 * Copy for one capability, from its own state and reason.
 *
 * Returns `undefined` for the two states that are not an unavailability to explain: `available`
 * (the screen renders normally — and must never call it proven) and `absent` (rendered nowhere at
 * all, in any styling).
 */
export function capabilityCopy(
  capability: Capability,
  role: CapabilityViewerRole,
): CapabilityCopy | undefined {
  const office = officeDetail(capability);
  const name = capability.title;
  switch (capability.state) {
    case "off":
      return {
        stateLabel: stateLabels.off,
        title: `${name} is turned off`,
        message: `${name} is part of IronWrap, but nobody has switched it on for this company. Nothing here has failed and nothing is waiting to be retried.`,
        nextAction: enablementAction(role),
        personPath: personPathFor(role),
      };
    case "unconfigured":
      // Two different jobs for whoever fixes it, so two different sentences. `rejected` means
      // every setting has a value and the capability refused them anyway: pointing that reader at
      // a missing setting sends them hunting for a blank that does not exist.
      return capability.reason === "configuration_rejected"
        ? {
            stateLabel: stateLabels.unconfigured,
            title: `${name} will not accept its current setup`,
            message: `${name} is switched on and every setting it needs has a value, but ${name} refused those values. Nothing is blank; the values themselves are wrong for this company.`,
            nextAction:
              "An administrator has to correct the values this was given. There is no empty setting to fill in, so looking for one will not find anything.",
            personPath: personPathFor(role),
          }
        : {
            stateLabel: stateLabels.unconfigured,
            title: `${name} is not set up yet`,
            message: `${name} is switched on, but the setup it needs is not finished. It is not off, and it is not broken — it will fail the first time anyone uses it.`,
            nextAction: configurationAction(role, office?.missing_configuration ?? []),
            personPath: personPathFor(role),
          };
    case "dependency_blocked": {
      const blocked = (office?.dependencies ?? [])
        .filter((dependency) => dependency.state !== "available")
        .map((dependency) => dependency.id);
      return {
        stateLabel: stateLabels.dependency_blocked,
        title: `${name} is waiting on something it depends on`,
        message: `${name} is switched on and set up, but something it needs is not available yet, so it cannot run. This is not a fault in ${name} and retrying will not change it.`,
        nextAction:
          blocked.length > 0
            ? `An administrator has to make ${blocked.join(", ")} available first.`
            : "An administrator has to make the capability this depends on available first.",
        personPath: personPathFor(role),
      };
    }
    case "unknown":
      return {
        stateLabel: stateLabels.unknown,
        title: `Whether ${name} works could not be confirmed`,
        message: `IronWrap could not read one of the settings ${name} depends on, so it is neither working nor broken. Nothing on this screen claims it will work.`,
        nextAction:
          "An administrator has to read the deployment configuration back and record what it actually says. IronWrap will not guess in either direction.",
        personPath: personPathFor(role),
      };
    case "absent":
    case "available":
      return undefined;
  }
}

/** The one sentence `available` is allowed to say. Reachable is not proven, ever. */
export const CAPABILITY_AVAILABLE_CAVEAT =
  "Reachable — not proven. IronWrap has checked that this is switched on and set up; it has not checked that the provider accepts it.";

export { stateLabels as capabilityStateLabels };
