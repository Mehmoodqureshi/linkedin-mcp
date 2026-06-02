/**
 * auth.scenario.ts — HITL coverage for the authentication surface.
 *
 * Exercises the read-only diagnostics (`auth.status`, `auth.isLoggedIn`) and,
 * behind the three-layer safety gate, the two MUTATING flows (`auth.login`,
 * `auth.logout`). The whole point of these mutating steps is to verify that
 * *session restore* works end-to-end: log in once, persist the snapshot, and
 * confirm a subsequent `isLoggedIn()` still reports an authenticated session.
 *
 * Contract (see ../types.ts):
 *   - A scenario file exports a `ScenarioModule` ({ id, label, group, run }).
 *   - `run()` simply sequences `runner.runReadOnly` / `runner.runMutating`
 *     calls; the Runner owns timing, screenshots, the safety gate and the
 *     verdict prompt. Read-only steps must never reach a mutating driver method.
 *   - Every step carries a `sourceHint` so a FAIL routes to the source file
 *     whose selectors/actions most likely broke.
 *
 * Safety:
 *   - `auth.login` / `auth.logout` are ONLY invoked through `runner.runMutating`
 *     (Layer 1). Layer 2 (--include-mutating) and Layer 3 (target presence +
 *     literal 'yes') are enforced inside the Runner.
 *   - `login` only has a usable target when LINKEDIN_EMAIL is present in the env
 *     (we never read or store the password here — the headed flow lets the human
 *     finish 2FA). With no email configured the step records 'skip'
 *     ('no safe target configured') because the MutationPlan target is empty.
 *   - `logout` is double-guarded by `targets.allowLogout`: if it is not set we
 *     leave the plan target empty so the Runner records a skip, ensuring a run
 *     can never silently destroy the persisted session it just validated.
 */

import type { RunContext, ScenarioCtx, ScenarioModule } from '../types';

const SOURCE_HINT = 'src/driver/actions/auth.ts';

/**
 * The Runner's `runReadOnly` / `runMutating` take a `RunContext` (page +
 * resultsDir + recordArtifact). The orchestrator (index.ts) hands each scenario
 * a `ScenarioCtx` that also carries those fields, so we surface them through a
 * single narrowing helper rather than sprinkling casts across every step.
 */
function runCtx(ctx: ScenarioCtx): RunContext {
  return ctx as unknown as RunContext;
}

/** Read the login email from the env; '' when unset (drives the login skip). */
function loginEmail(): string {
  return process.env.LINKEDIN_EMAIL?.trim() ?? '';
}

export const scenario: ScenarioModule = {
  id: 'auth',
  label: 'Authentication — status, session restore, login/logout',
  group: 'auth',

  async run(ctx: ScenarioCtx): Promise<void> {
    const { runner, driver, targets } = ctx;
    const rctx = runCtx(ctx);

    // -----------------------------------------------------------------------
    // 1. auth.status() — normalized cookie/snapshot diagnostics (read-only).
    // -----------------------------------------------------------------------
    await runner.runReadOnly(
      {
        name: 'auth-status',
        group: 'auth',
        action: 'auth.status',
        inputs: {},
        sourceHint: SOURCE_HINT,
      },
      rctx,
      () => driver.auth.status(),
    );

    // -----------------------------------------------------------------------
    // 2. auth.isLoggedIn() — confirms the restored session is authenticated.
    //    This is the read-side proof that session restore worked.
    // -----------------------------------------------------------------------
    await runner.runReadOnly(
      {
        name: 'auth-isLoggedIn',
        group: 'auth',
        action: 'auth.isLoggedIn',
        inputs: {},
        sourceHint: SOURCE_HINT,
      },
      rctx,
      () => driver.auth.isLoggedIn(),
    );

    // -----------------------------------------------------------------------
    // 3. auth.login() — MUTATING. Only meaningful when an email is configured;
    //    otherwise the empty plan target makes the Runner record a 'skip'
    //    ('no safe target configured'). The password is intentionally NOT read
    //    here — the headed flow lets the human finish 2FA — so we pass ''.
    //    Logging in (re)persists the storageState snapshot, which is what makes
    //    subsequent restores work.
    // -----------------------------------------------------------------------
    const email = loginEmail();
    await runner.runMutating(
      {
        name: 'auth-login',
        group: 'auth',
        action: 'auth.login',
        inputs: { email: email || '(unset)', password: '(handled in headed browser)' },
        sourceHint: SOURCE_HINT,
      },
      {
        effect:
          'Drives the headed login flow and persists the session snapshot ' +
          '(no password is stored; 2FA/captcha is solved by the human).',
        target: email,
        payload: { email: email || '(unset)' },
      },
      rctx,
      () => driver.auth.login(email, ''),
    );

    // -----------------------------------------------------------------------
    // 4. auth.logout() — MUTATING and double-guarded. We only supply a real
    //    plan target when `targets.allowLogout` is true; otherwise the empty
    //    target makes the Runner skip, so a default run never tears down the
    //    session it just validated. (Layer 2 still requires --include-mutating.)
    // -----------------------------------------------------------------------
    const logoutTarget = targets.allowLogout === true ? 'current-session' : '';
    await runner.runMutating(
      {
        name: 'auth-logout',
        group: 'auth',
        action: 'auth.logout',
        inputs: { allowLogout: targets.allowLogout === true },
        sourceHint: SOURCE_HINT,
      },
      {
        effect:
          'Clears the active session cookies and deletes the persisted ' +
          'storageState snapshot (logs the test account OUT).',
        target: logoutTarget,
      },
      rctx,
      () => driver.auth.logout(),
    );
  },
};

export default scenario;
