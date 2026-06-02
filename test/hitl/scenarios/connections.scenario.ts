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
  ],
};

/**
 * The mutating step's `plan` must reflect the human-supplied target so the
 * confirm-gate shows exactly what will change. Targets aren't known until a run
 * has its config loaded, so a thin factory binds them in. Callers that prefer
 * the static module can also resolve the plan themselves from
 * `ctx.targets.connectionTarget`.
 */
export function buildConnectionsScenario(targets: {
  connectionTarget?: { profileUrl: string; note?: string };
}): ScenarioModule {
  const ct = targets.connectionTarget;
  const profileUrl = ct?.profileUrl ?? '';
  const note = ct?.note;

  const steps = connectionsScenario.steps.map((step) => {
    if (step.kind !== 'mutating') return step;
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
  });

  return { name: connectionsScenario.name, steps };
}

export default connectionsScenario;
