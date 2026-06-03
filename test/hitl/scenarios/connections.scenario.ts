/**
 * HITL scenario: connections
 *
 * Exercises the ConnectionActions surface (src/driver/actions/connections.ts):
 *   - getConnectionRequests()            READ-only  — lists pending received invites
 *   - sendConnectionRequest(url, note)   MUTATING   — gated; prints target + note
 *
 * Each step's run() calls the real driver action and RETURNS the raw result;
 * the Runner owns timing, screenshots, the mutation confirm-gate, and the human
 * verdict. Steps never touch readline, fs, or the Page directly.
 *
 * The mutating step draws its target ONLY from the dedicated config key
 * `connectionTarget` (never a synthesized or search-derived value), per the
 * harness safety model. If that key is absent the step's `plan.target` is empty,
 * so the Runner's Layer-3 gate records a graceful 'skip' ("no safe target
 * configured") instead of firing.
 */

import type { RunContext, Step } from '../types';

/**
 * A scenario module: a stable name plus an ordered list of declarative steps.
 * Read steps run with no confirmation; mutating steps carry a `plan` the
 * Runner shows in its confirm-gate before anything fires.
 */
export interface ScenarioModule {
  name: string;
  steps: Step[];
}

const SOURCE_HINT = 'src/driver/actions/connections.ts';

const connectionsScenario: ScenarioModule = {
  name: 'connections',
  steps: [
    // ---------------------------------------------------------------------
    // READ — list pending received connection requests.
    // ---------------------------------------------------------------------
    {
      name: 'connections-getConnectionRequests',
      kind: 'read',
      group: 'connections',
      action: 'connections.getConnectionRequests',
      sourceHint: SOURCE_HINT,
      run: (ctx: RunContext) => ctx.driver.connections.getConnectionRequests(),
    },

    // ---------------------------------------------------------------------
    // MUTATING — send a connection request to the pre-approved target.
    // The target + note come ONLY from targets.connectionTarget; if it is
    // missing, `plan.target` is empty and the Runner records a graceful skip.
    // ---------------------------------------------------------------------
    {
      name: 'connections-sendConnectionRequest',
      kind: 'mutating',
      group: 'connections',
      action: 'connections.sendConnectionRequest',
      sourceHint: SOURCE_HINT,
      // `inputs` and `plan.target` are bound to the human-supplied
      // `targets.connectionTarget` at run time by buildConnectionsScenario().
      plan: {
        effect: 'Sends a LinkedIn connection request to the target profile.',
        target: '',
        payload: {},
      },
      run: (ctx: RunContext) => {
        const target = ctx.targets.connectionTarget;
        const profileUrl = target?.profileUrl ?? '';
        const note = target?.note;
        // exactOptionalPropertyTypes: branch rather than pass an explicit
        // `undefined` to the optional `note` param.
        return note !== undefined
          ? ctx.driver.connections.sendConnectionRequest(profileUrl, note)
          : ctx.driver.connections.sendConnectionRequest(profileUrl);
      },
    },

    // ---------------------------------------------------------------------
    // MUTATING — accept a pending RECEIVED invitation.
    // Target is the inviter's vanity slug, drawn ONLY from
    // targets.acceptRequestProfileId; absent -> empty plan.target -> graceful
    // skip. (You must have arranged a real inbound invite for this to pass.)
    // ---------------------------------------------------------------------
    {
      name: 'connections-acceptConnectionRequest',
      kind: 'mutating',
      group: 'connections',
      action: 'connections.acceptConnectionRequest',
      sourceHint: SOURCE_HINT,
      // `inputs` and `plan.target` are bound to targets.acceptRequestProfileId
      // at run time by buildConnectionsScenario().
      plan: {
        effect: 'Accepts a pending RECEIVED invitation from the target member.',
        target: '',
        payload: {},
      },
      run: (ctx: RunContext) =>
        ctx.driver.connections.acceptConnectionRequest(
          (ctx.targets.acceptRequestProfileId ?? '').trim(),
        ),
    },

    // ---------------------------------------------------------------------
    // MUTATING — withdraw a pending SENT invitation.
    // Target is the recipient's vanity slug, resolved from
    // targets.withdrawTarget (profileId, else the /in/<slug> of profileUrl);
    // unresolvable -> empty plan.target -> graceful skip.
    // ---------------------------------------------------------------------
    {
      name: 'connections-withdrawConnectionRequest',
      kind: 'mutating',
      group: 'connections',
      action: 'connections.withdrawConnectionRequest',
      sourceHint: SOURCE_HINT,
      // `inputs` and `plan.target` are bound to targets.withdrawTarget at run
      // time by buildConnectionsScenario().
      plan: {
        effect: 'Withdraws a pending SENT invitation to the target member.',
        target: '',
        payload: {},
      },
      run: (ctx: RunContext) =>
        ctx.driver.connections.withdrawConnectionRequest(
          withdrawSlug(ctx.targets.withdrawTarget),
        ),
    },
  ],
};

/**
 * Resolve a withdraw target to the vanity slug withdrawConnectionRequest needs:
 * prefer an explicit profileId, else extract the /in/<slug> from profileUrl.
 * Returns '' when neither is usable, so the Runner's Layer-3 gate records a
 * graceful skip rather than firing on an empty target.
 */
function withdrawSlug(wt?: { profileId?: string; profileUrl?: string }): string {
  const id = wt?.profileId?.trim();
  if (id) return id;
  const url = wt?.profileUrl?.trim();
  if (url) return url.match(/\/in\/([^/?#]+)/)?.[1] ?? '';
  return '';
}

/**
 * The mutating step's `plan` must reflect the human-supplied target so the
 * confirm-gate shows exactly what will change. Targets aren't known until a run
 * has its config loaded, so a thin factory binds them in. Callers that prefer
 * the static module can also resolve the plan themselves from
 * `ctx.targets.connectionTarget`.
 */
export function buildConnectionsScenario(targets: {
  connectionTarget?: { profileUrl: string; note?: string };
  acceptRequestProfileId?: string;
  withdrawTarget?: { profileId?: string; profileUrl?: string };
}): ScenarioModule {
  const ct = targets.connectionTarget;
  const profileUrl = ct?.profileUrl ?? '';
  const note = ct?.note;
  const acceptId = (targets.acceptRequestProfileId ?? '').trim();
  const withdrawId = withdrawSlug(targets.withdrawTarget);

  // Each mutating step binds its OWN dedicated target — never cross-wire one
  // mutation's target into another step's plan — so switch on the step name.
  const steps = connectionsScenario.steps.map((step) => {
    if (step.kind !== 'mutating') return step;

    if (step.name === 'connections-sendConnectionRequest') {
      return {
        ...step,
        inputs: {
          profileUrl,
          ...(note !== undefined ? { note } : {}),
        },
        plan: {
          effect: 'Sends a LinkedIn connection request to the target profile.',
          target: profileUrl,
          payload: {
            profileUrl,
            ...(note !== undefined ? { note } : { note: '(no note)' }),
          },
        },
      } satisfies Step;
    }

    if (step.name === 'connections-acceptConnectionRequest') {
      return {
        ...step,
        inputs: { profileId: acceptId },
        plan: {
          effect: 'Accepts a pending RECEIVED invitation from the target member.',
          target: acceptId,
          payload: { profileId: acceptId },
        },
      } satisfies Step;
    }

    if (step.name === 'connections-withdrawConnectionRequest') {
      return {
        ...step,
        inputs: { profileId: withdrawId },
        plan: {
          effect: 'Withdraws a pending SENT invitation to the target member.',
          target: withdrawId,
          payload: { profileId: withdrawId },
        },
      } satisfies Step;
    }

    return step;
  });

  return { name: connectionsScenario.name, steps };
}

export default connectionsScenario;
