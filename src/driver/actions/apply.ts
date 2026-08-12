/**
 * Job application actions: complete a LinkedIn "Easy Apply" flow.
 *
 * Easy Apply is a multi-step modal. LinkedIn pre-fills what it knows from the
 * profile (name, email, phone, résumé) and then asks employer-specific screening
 * questions — work authorization, salary expectation, years with a technology,
 * notice period. Those answers are the applicant's to give, and getting one
 * wrong is a misrepresentation attached to a real application, so this module
 * NEVER invents one. An unanswered required question aborts the run and reports
 * exactly what is missing.
 *
 * The intended workflow is therefore two-pass:
 *   1. `dryRun` — walk the modal, report every question it asks, submit nothing.
 *   2. Re-run with `answers` supplied, which fills and submits.
 *
 * Only Easy Apply is supported. A posting that hands off to an external ATS
 * (Workday, Greenhouse, Lever) is reported as such with its outward link, rather
 * than half-driven through a form this module cannot reason about.
 */

import type { Locator, Page } from 'playwright-core';

import {
  LINKEDIN_BASE,
  ActionError,
  assertAuthenticated,
  clean,
  navigate,
  rateLimitDelay,
  sleep,
} from './common';
import { getQuotaManager } from '../quota';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** How a screening question expects to be answered. */
export type QuestionKind = 'text' | 'textarea' | 'select' | 'radio' | 'checkbox' | 'unknown';

/** One screening question found in the Easy Apply modal. */
export interface ApplicationQuestion {
  /** The visible label, normalized. Also the key used to supply an answer. */
  label: string;
  kind: QuestionKind;
  /** Whether LinkedIn marks the field required. */
  required: boolean;
  /** Currently filled/selected value, if LinkedIn pre-filled one. */
  currentValue?: string;
  /** For select/radio: the accepted values. */
  options?: string[];
  /** Which step of the modal it appeared on (1-based). */
  step: number;
}

export interface ApplyResult {
  jobUrl: string;
  jobTitle?: string;
  company?: string;
  /**
   *  - 'submitted'        the application was sent
   *  - 'previewed'        dryRun: nothing was sent
   *  - 'needs_answers'    required questions were unanswered; nothing was sent
   *  - 'already_applied'  LinkedIn reports a prior application
   *  - 'external'         not Easy Apply; apply on the employer's own site
   */
  outcome: 'submitted' | 'previewed' | 'needs_answers' | 'already_applied' | 'external';
  /** Every question the modal asked, across all steps. */
  questions: ApplicationQuestion[];
  /** Labels of required questions with no answer available. */
  missingAnswers: string[];
  /** Answers that were applied to the form (echoed back for the record). */
  applied: Record<string, string>;
  /** Where to apply when `outcome` is 'external'. */
  externalUrl?: string;
  message: string;
}

export interface ApplyOptions {
  /** Walk the modal and report questions without submitting. */
  dryRun?: boolean;
  /** Answers keyed by question label (case- and whitespace-insensitive match). */
  answers?: Record<string, string>;
}

/** Guard against a malformed modal looping forever. Easy Apply is rarely >6 steps. */
const MAX_STEPS = 12;

/**
 * The Easy Apply dialog. LinkedIn has shipped several containers for it, so
 * match any of them rather than pinning one class that will rot.
 */
const MODAL_SELECTOR =
  'div.jobs-easy-apply-modal, div[data-test-modal][role="dialog"], div.artdeco-modal[role="dialog"], div[role="dialog"]';

/** The dialog fetches saved application state before painting; give it room. */
const MODAL_TIMEOUT_MS = 20000;

// ---------------------------------------------------------------------------
// ApplyActions
// ---------------------------------------------------------------------------

export class ApplyActions {
  private readonly page: Page;

  constructor(page: Page) {
    this.page = page;
  }

  /**
   * Apply to a job posting via Easy Apply.
   *
   * Quota is enforced up front (so a capped run costs no navigation) but only
   * RECORDED once an application is actually submitted — a dry run or an aborted
   * run must not consume the day's budget.
   */
  async applyToJob(jobUrl: string, opts: ApplyOptions = {}): Promise<ApplyResult> {
    const dryRun = opts.dryRun === true;
    if (!dryRun) await getQuotaManager().enforce('application');

    const url = normalizeJobUrl(jobUrl);
    await navigate(this.page, url);
    assertAuthenticated(this.page);
    await rateLimitDelay();

    const jobTitle = clean(await this.textOf('.job-details-jobs-unified-top-card__job-title, h1'));
    const company = clean(
      await this.textOf('.job-details-jobs-unified-top-card__company-name a, .job-details-jobs-unified-top-card__company-name'),
    );
    const base: Pick<ApplyResult, 'jobUrl' | 'jobTitle' | 'company' | 'questions' | 'missingAnswers' | 'applied'> = {
      jobUrl: url,
      ...(jobTitle ? { jobTitle } : {}),
      ...(company ? { company } : {}),
      questions: [],
      missingAnswers: [],
      applied: {},
    };

    // Already applied? LinkedIn replaces the button with an "Applied" state.
    if ((await this.page.locator('.jobs-s-apply__application-submitted, span:has-text("Application submitted")').count()) > 0) {
      return { ...base, outcome: 'already_applied', message: 'LinkedIn reports you have already applied to this job.' };
    }

    const easyApplyBtn = this.page
      .locator('button.jobs-apply-button, button[aria-label*="Easy Apply"], button:has-text("Easy Apply")')
      .first();

    if ((await easyApplyBtn.count()) === 0) {
      // Not Easy Apply — surface the outward link rather than guessing at a
      // third-party form whose fields and semantics we cannot know.
      const external = this.page.locator('a[href]:has-text("Apply"), button:has-text("Apply")').first();
      const href = (await external.count()) > 0 ? await external.getAttribute('href') : null;
      return {
        ...base,
        outcome: 'external',
        ...(href ? { externalUrl: href } : {}),
        message:
          'This posting is not Easy Apply — it hands off to the employer\'s own application system. ' +
          'Open the job and apply there.',
      };
    }

    // An "Easy Apply" button does not guarantee an on-site application: LinkedIn
    // uses the same label for postings that hand straight off to the employer's
    // ATS, which opens in a NEW TAB instead of a dialog. So watch for both and
    // take whichever happens — treating the hand-off as an error would report a
    // perfectly working posting as broken.
    const context = this.page.context();
    const never = new Promise<never>(() => {});
    const popupWait = context
      .waitForEvent('page', { timeout: MODAL_TIMEOUT_MS })
      .then((p) => ({ kind: 'popup' as const, page: p }))
      .catch(() => never);

    const modal = this.page.locator(MODAL_SELECTOR).first();
    const modalWait = modal
      .waitFor({ state: 'visible', timeout: MODAL_TIMEOUT_MS })
      .then(() => ({ kind: 'modal' as const }))
      .catch(() => never);

    await easyApplyBtn.click();
    const race = await Promise.race([
      popupWait,
      modalWait,
      this.waitForOffsiteMarker().then((ats) => ({ kind: 'offsite' as const, ats })),
      sleep(MODAL_TIMEOUT_MS).then(() => ({ kind: 'none' as const })),
    ]);

    if (race.kind === 'offsite') {
      // LinkedIn stamps the ATS onto the job URL when it routes an application
      // off-site, then tries to window.open the employer's form — which Chrome
      // blocks under automation, so no popup ever arrives. The URL marker is the
      // dependable signal that this posting is not an on-site application.
      return {
        ...base,
        outcome: 'external',
        externalUrl: this.page.url(),
        message:
          `This posting is labelled "Easy Apply" but routes to the employer's own application system` +
          `${race.ats ? ` (${race.ats})` : ''}. Nothing was submitted — open the job and apply there.`,
      };
    }

    if (race.kind === 'popup') {
      // Let the ATS page settle enough to report a real URL, then close it —
      // we are not going to drive a third-party form we cannot reason about.
      await sleep(2500);
      const externalUrl = race.page.url();
      const ats = /[?&]applicantTrackingSystemName=([^&]+)/.exec(this.page.url())?.[1];
      await race.page.close().catch(() => undefined);
      return {
        ...base,
        outcome: 'external',
        externalUrl,
        message:
          `This posting is labelled "Easy Apply" but hands off to the employer's own application system` +
          `${ats ? ` (${decodeURIComponent(ats)})` : ''}. Nothing was submitted — open the link and apply there.`,
      };
    }

    if (race.kind === 'none') {
      // Report what the page actually offered. LinkedIn A/B-tests this surface
      // and relabels the control, so a bare "did not open" leaves no way to tell
      // a changed selector from a posting that simply isn't Easy Apply.
      const controls = await this.page.evaluate(() =>
        Array.from(document.querySelectorAll('main button, main a[href*="apply" i]'))
          .map((el) => {
            const t = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
            const a = el.getAttribute('aria-label') ?? '';
            return (t || a).slice(0, 60);
          })
          .filter(Boolean)
          .slice(0, 25),
      );
      throw new ActionError(
        'The Easy Apply dialog did not open. Controls found on the page: ' +
          (controls.length ? controls.map((c) => `"${c}"`).join(', ') : '(none)'),
        'modal_missing',
      );
    }

    return this.walkModal(modal, base, { dryRun, answers: opts.answers ?? {} });
  }

  // -------------------------------------------------------------------------
  // Modal walking
  // -------------------------------------------------------------------------

  /**
   * Step through the modal, collecting questions and (when not a dry run)
   * filling them from `answers`.
   *
   * Advancing is only ever attempted once the current step's required questions
   * are satisfied. If any are not, the walk stops and reports them — which is
   * why a dry run has to fill nothing yet still reach the later steps: it can't,
   * so it reports what it saw up to the point LinkedIn refuses to advance, and
   * says so.
   */
  private async walkModal(
    modal: Locator,
    base: Pick<ApplyResult, 'jobUrl' | 'jobTitle' | 'company' | 'questions' | 'missingAnswers' | 'applied'>,
    opts: { dryRun: boolean; answers: Record<string, string> },
  ): Promise<ApplyResult> {
    const questions: ApplicationQuestion[] = [];
    const applied: Record<string, string> = {};
    const missing: string[] = [];
    const lookup = normalizeAnswerKeys(opts.answers);

    for (let step = 1; step <= MAX_STEPS; step++) {
      const found = await this.collectQuestions(modal, step);
      questions.push(...found);

      for (const q of found) {
        const answer = lookup.get(answerKey(q.label));
        if (answer === undefined) {
          // Only a REQUIRED question with no pre-filled value blocks us. An
          // optional blank is fine, and a pre-filled required field is already
          // satisfied by whatever LinkedIn carried over from the profile.
          if (q.required && !q.currentValue) missing.push(q.label);
          continue;
        }
        if (!opts.dryRun) {
          const ok = await this.fillQuestion(modal, q, answer);
          if (ok) applied[q.label] = answer;
          else missing.push(q.label);
        }
      }

      if (opts.dryRun || missing.length > 0) {
        // Nothing is submitted and nothing more can be reached: LinkedIn will
        // not advance past an unsatisfied required field.
        await this.dismissModal();
        const outcome = opts.dryRun ? 'previewed' : 'needs_answers';
        return {
          ...base,
          questions,
          applied,
          missingAnswers: unique(missing),
          outcome,
          message: opts.dryRun
            ? `Preview only — nothing was submitted. Found ${questions.length} question(s) across ${step} step(s). ` +
              'Supply answers keyed by the labels below and re-run without dryRun.'
            : `Not submitted: ${unique(missing).length} required question(s) have no answer. ` +
              'Supply them in `answers` and re-run.',
        };
      }

      const submit = modal.locator('button[aria-label*="Submit application"], button:has-text("Submit application")').first();
      if ((await submit.count()) > 0) {
        await rateLimitDelay();
        await submit.click();
        await sleep(2500);
        // Count it only once it actually went out.
        await getQuotaManager().record('application');
        await this.dismissModal();
        return {
          ...base,
          questions,
          applied,
          missingAnswers: [],
          outcome: 'submitted',
          message: `Application submitted after ${step} step(s).`,
        };
      }

      const next = modal
        .locator('button[aria-label*="Continue to next step"], button[aria-label*="Review"], button:has-text("Next"), button:has-text("Review")')
        .first();
      if ((await next.count()) === 0) {
        await this.dismissModal();
        throw new ActionError(
          `Easy Apply stalled at step ${step}: no Next, Review or Submit control was found.`,
          'apply_stalled',
        );
      }
      await next.click();
      await sleep(1500);
    }

    await this.dismissModal();
    throw new ActionError(`Easy Apply exceeded ${MAX_STEPS} steps; aborting without submitting.`, 'apply_too_many_steps');
  }

  /**
   * Resolve once the job URL picks up LinkedIn's off-site-apply marker.
   * Never resolves if the marker doesn't appear, so it can sit in a race.
   */
  private async waitForOffsiteMarker(): Promise<string | undefined> {
    const deadline = Date.now() + MODAL_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const m = /[?&](?:applicantTrackingSystemName|externalApplyUrl)=([^&]*)/.exec(this.page.url());
      if (m) {
        let ats = m[1] ?? '';
        try {
          ats = decodeURIComponent(ats);
        } catch {
          /* keep the raw value */
        }
        // `applicantTrackingSystemName=LinkedIn` means LinkedIn IS the ATS —
        // a genuine on-site Easy Apply. Only a THIRD-PARTY name is a hand-off.
        if (ats && !/^linkedin$/i.test(ats)) return ats;
      }
      await sleep(400);
    }
    return new Promise<never>(() => {});
  }

  /** Read every labelled form control on the current modal step. */
  private async collectQuestions(modal: Locator, step: number): Promise<ApplicationQuestion[]> {
    const raw = await modal.evaluate((root) => {
      const norm = (s: string | null | undefined): string => (s ?? '').replace(/\s+/g, ' ').trim();
      const out: Array<{
        label: string; kind: string; required: boolean; currentValue: string; options: string[];
      }> = [];
      const seen = new Set<string>();

      // Each question sits in a grouping element with a <label> or a fieldset
      // legend. Anchor on the control and walk up for its label, since the
      // wrapper class names are partly obfuscated.
      const controls = Array.from(
        root.querySelectorAll('input:not([type="hidden"]), select, textarea'),
      ) as Array<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>;

      for (const el of controls) {
        if (el instanceof HTMLInputElement && (el.type === 'file' || el.type === 'submit' || el.type === 'button')) continue;

        // Label: explicit for=, else an ancestor fieldset legend, else aria-label.
        let label = '';
        if (el.id) label = norm(root.querySelector(`label[for="${CSS.escape(el.id)}"]`)?.textContent);
        if (!label) {
          const fieldset = el.closest('fieldset');
          if (fieldset) label = norm(fieldset.querySelector('legend')?.textContent);
        }
        if (!label) label = norm(el.getAttribute('aria-label'));
        if (!label) {
          const wrapper = el.closest('div');
          if (wrapper) label = norm(wrapper.querySelector('label')?.textContent);
        }
        if (!label) continue;

        // Radio groups share a label; collapse them into one question.
        const isRadio = el instanceof HTMLInputElement && el.type === 'radio';
        const key = label.toLowerCase();
        if (isRadio && seen.has(key)) continue;
        seen.add(key);

        let kind = 'unknown';
        let options: string[] = [];
        let currentValue = '';
        if (el instanceof HTMLSelectElement) {
          kind = 'select';
          options = Array.from(el.options).map((o) => norm(o.textContent)).filter((t) => t && !/^select an option$/i.test(t));
          currentValue = norm(el.selectedOptions[0]?.textContent);
          if (/^select an option$/i.test(currentValue)) currentValue = '';
        } else if (el instanceof HTMLTextAreaElement) {
          kind = 'textarea';
          currentValue = norm(el.value);
        } else if (isRadio) {
          kind = 'radio';
          const name = el.getAttribute('name');
          const group = name
            ? (Array.from(root.querySelectorAll(`input[type="radio"][name="${CSS.escape(name)}"]`)) as HTMLInputElement[])
            : [el];
          options = group.map((r) => {
            const own = r.id ? norm(root.querySelector(`label[for="${CSS.escape(r.id)}"]`)?.textContent) : '';
            return own || norm(r.value);
          }).filter(Boolean);
          const checked = group.find((r) => r.checked);
          if (checked) {
            currentValue = checked.id
              ? norm(root.querySelector(`label[for="${CSS.escape(checked.id)}"]`)?.textContent) || norm(checked.value)
              : norm(checked.value);
          }
        } else if (el instanceof HTMLInputElement && el.type === 'checkbox') {
          kind = 'checkbox';
          currentValue = el.checked ? 'checked' : '';
        } else {
          kind = 'text';
          currentValue = norm((el as HTMLInputElement).value);
        }

        const required =
          el.hasAttribute('required') ||
          el.getAttribute('aria-required') === 'true' ||
          /\*/.test(label);

        out.push({ label: label.replace(/\s*\*\s*$/, ''), kind, required, currentValue, options });
      }
      return out;
    });

    return raw.map((r) => ({
      label: r.label,
      kind: (['text', 'textarea', 'select', 'radio', 'checkbox'].includes(r.kind) ? r.kind : 'unknown') as QuestionKind,
      required: r.required,
      ...(r.currentValue ? { currentValue: r.currentValue } : {}),
      ...(r.options.length ? { options: r.options } : {}),
      step,
    }));
  }

  /** Put `answer` into the control for `q`. Returns false if it could not be set. */
  private async fillQuestion(modal: Locator, q: ApplicationQuestion, answer: string): Promise<boolean> {
    try {
      if (q.kind === 'select') {
        const target = await this.controlFor(modal, q.label, 'select');
        if (!target) return false;
        await target.selectOption({ label: answer }).catch(async () => target.selectOption(answer));
        return true;
      }
      if (q.kind === 'radio') {
        const option = modal.locator(`label:has-text("${answer}")`).first();
        if ((await option.count()) === 0) return false;
        await option.click();
        return true;
      }
      if (q.kind === 'checkbox') {
        const target = await this.controlFor(modal, q.label, 'input');
        if (!target) return false;
        const wants = /^(yes|true|checked|on)$/i.test(answer);
        if (wants) await target.check().catch(() => undefined);
        else await target.uncheck().catch(() => undefined);
        return true;
      }
      const target = await this.controlFor(modal, q.label, q.kind === 'textarea' ? 'textarea' : 'input');
      if (!target) return false;
      await target.fill(answer);
      return true;
    } catch {
      return false;
    }
  }

  /** Locate the control whose label matches, by walking labels back to their control. */
  private async controlFor(modal: Locator, label: string, tag: string): Promise<Locator | null> {
    const id = await modal.evaluate(
      (root: Element, { wanted, tagName }: { wanted: string; tagName: string }) => {
        const norm = (s: string | null | undefined): string => (s ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
        const target = norm(wanted);
        for (const el of Array.from(root.querySelectorAll(tagName))) {
          const node = el as HTMLElement & { id: string };
          let own = '';
          if (node.id) own = norm(root.querySelector(`label[for="${CSS.escape(node.id)}"]`)?.textContent);
          if (!own) own = norm(node.getAttribute('aria-label'));
          if (!own) {
            const fs = node.closest('fieldset');
            if (fs) own = norm(fs.querySelector('legend')?.textContent);
          }
          if (own.replace(/\s*\*\s*$/, '') === target) return node.id || null;
        }
        return null;
      },
      { wanted: label, tagName: tag },
    );
    if (!id) return null;
    return modal.locator(`#${cssEscape(id)}`).first();
  }

  /** Close the modal without submitting, discarding any draft LinkedIn offers to save. */
  private async dismissModal(): Promise<void> {
    const close = this.page.locator('button[aria-label*="Dismiss"], button[aria-label*="Close"]').first();
    if ((await close.count()) === 0) return;
    await close.click().catch(() => undefined);
    await sleep(800);
    const discard = this.page.locator('button:has-text("Discard"), button[data-control-name="discard_application_confirm_btn"]').first();
    if ((await discard.count()) > 0) await discard.click().catch(() => undefined);
    await sleep(500);
  }

  private async textOf(selector: string): Promise<string> {
    const el = this.page.locator(selector).first();
    if ((await el.count()) === 0) return '';
    return (await el.textContent()) ?? '';
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Accept a numeric job id, a /jobs/view/ URL, or a search-result URL with params. */
export function normalizeJobUrl(input: string): string {
  const raw = input.trim();
  if (/^\d+$/.test(raw)) return `${LINKEDIN_BASE}/jobs/view/${raw}`;
  const m = /\/jobs\/view\/(\d+)/.exec(raw);
  if (m) return `${LINKEDIN_BASE}/jobs/view/${m[1]}`;
  const param = /[?&]currentJobId=(\d+)/.exec(raw);
  if (param) return `${LINKEDIN_BASE}/jobs/view/${param[1]}`;
  throw new ActionError(`"${input}" does not name a LinkedIn job (expected a job id or /jobs/view/ URL).`, 'bad_job_url');
}

/** Normalize a question label into a lookup key: case- and punctuation-insensitive. */
export function answerKey(label: string): string {
  return label.replace(/\s+/g, ' ').replace(/[*?:.]+$/g, '').trim().toLowerCase();
}

function normalizeAnswerKeys(answers: Record<string, string>): Map<string, string> {
  const out = new Map<string, string>();
  for (const [k, v] of Object.entries(answers)) out.set(answerKey(k), v);
  return out;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

/** Minimal CSS.escape for ids used in a Playwright selector. */
function cssEscape(id: string): string {
  return id.replace(/([^\w-])/g, '\\$1');
}
