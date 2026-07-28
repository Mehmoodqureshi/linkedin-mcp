/**
 * Profile-edit actions: write to the CURRENT USER's own profile.
 *
 * Unlike ProfileActions (read-only scraping of any member), this module drives
 * LinkedIn's own-profile edit modals to mutate the signed-in user's profile. v1
 * covers the flat text fields reachable from the two top-of-profile modals:
 *
 *   - "Edit intro"  → first name, last name, headline, location
 *   - "Edit about"  → the About / summary paragraph
 *
 * Structured sections (experience, education, skills) are intentionally out of
 * scope here — they involve typeaheads, employment-type dropdowns and date
 * pickers and belong in a dedicated follow-up module.
 *
 * Selector strategy mirrors the rest of the driver: we NEVER match obfuscated
 * `.css-xxxx` classes. Fields are located by their accessible label
 * (`getByLabel`) or ARIA role scoped to the open dialog, both of which LinkedIn
 * keeps stable across deploys. Every save is a mutation, so it is paced via
 * `rateLimitDelay`, and edits are idempotent: a field already holding the target
 * value is reported `unchanged` and never re-saved.
 */

import type { Locator, Page } from 'playwright-core';

import {
  LINKEDIN_BASE,
  ActionError,
  assertAuthenticated,
  clean,
  firstVisible,
  navigate,
  rateLimitDelay,
  sleep,
} from './common';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** LinkedIn's hard cap on the headline field. */
export const MAX_HEADLINE_LENGTH = 220;
/** LinkedIn's hard cap on the About / summary field. */
export const MAX_ABOUT_LENGTH = 2600;

/** The editable fields this module supports (all optional in a request). */
export type ProfileEditField = 'firstName' | 'lastName' | 'headline' | 'location' | 'about';

/** Requested edits. Only the provided fields are touched. */
export interface ProfileUpdateInput {
  firstName?: string;
  lastName?: string;
  headline?: string;
  location?: string;
  about?: string;
}

/** Per-field outcome. */
export interface ProfileFieldUpdate {
  field: ProfileEditField;
  /**
   *  - 'updated'    the field was changed and saved
   *  - 'unchanged'  the field already held the requested value (no save)
   *  - 'failed'     the field/control could not be located or set
   */
  outcome: 'updated' | 'unchanged' | 'failed';
  message: string;
}

export interface ProfileUpdateResult {
  /** True when NO requested field failed (every field updated or unchanged). */
  success: boolean;
  /** The fields that were actually changed. */
  updated: ProfileEditField[];
  results: ProfileFieldUpdate[];
}

// ---------------------------------------------------------------------------
// Selectors
// ---------------------------------------------------------------------------

/** "Edit intro" pencil on the top card. */
const EDIT_INTRO_BUTTON = [
  'button[aria-label="Edit intro"]',
  'button[aria-label*="Edit intro" i]',
];

/** "Edit about" pencil on the About section. */
const EDIT_ABOUT_BUTTON = [
  'button[aria-label="Edit about"]',
  'button[aria-label*="Edit about" i]',
  'button[aria-label*="Edit summary" i]',
];

/** Accessible-label matchers for the intro-modal text fields. */
const FIELD_LABELS: Record<'firstName' | 'lastName' | 'headline' | 'location', RegExp> = {
  firstName: /^first name/i,
  lastName: /^last name/i,
  headline: /^headline/i,
  location: /^location|^city|country\/region/i,
};

// ---------------------------------------------------------------------------
// ProfileEditActions
// ---------------------------------------------------------------------------

export class ProfileEditActions {
  private readonly page: Page;

  constructor(page: Page) {
    this.page = page;
  }

  // -------------------------------------------------------------------------
  // updateProfile
  // -------------------------------------------------------------------------

  /**
   * Apply the requested edits to the signed-in user's own profile. Opens the
   * "Edit intro" modal once for any of {firstName, lastName, headline, location}
   * and the "Edit about" modal for {about}; only the modals needed are opened.
   *
   * Returns a per-field breakdown. `success` is false if ANY requested field
   * could not be applied, but the other fields are still saved — partial success
   * is reported, never silently swallowed.
   */
  async updateProfile(input: ProfileUpdateInput): Promise<ProfileUpdateResult> {
    const wantsIntro =
      input.firstName !== undefined ||
      input.lastName !== undefined ||
      input.headline !== undefined ||
      input.location !== undefined;
    const wantsAbout = input.about !== undefined;

    if (!wantsIntro && !wantsAbout) {
      throw new ActionError(
        'No profile fields provided. Supply at least one of: firstName, lastName, ' +
          'headline, location, about.',
        'no_fields',
      );
    }

    if (input.headline !== undefined && input.headline.length > MAX_HEADLINE_LENGTH) {
      throw new ActionError(
        `headline exceeds LinkedIn's ${MAX_HEADLINE_LENGTH}-character limit.`,
        'headline_too_long',
      );
    }
    if (input.about !== undefined && input.about.length > MAX_ABOUT_LENGTH) {
      throw new ActionError(
        `about exceeds LinkedIn's ${MAX_ABOUT_LENGTH}-character limit.`,
        'about_too_long',
      );
    }

    // Land on our own profile. `/in/me/` redirects to the signed-in member.
    await navigate(this.page, `${LINKEDIN_BASE}/in/me/`);
    assertAuthenticated(this.page);
    await rateLimitDelay();

    const results: ProfileFieldUpdate[] = [];

    if (wantsIntro) {
      results.push(...(await this.editIntro(input)));
    }
    if (wantsAbout) {
      results.push(await this.editAbout(input.about as string));
    }

    const updated = results.filter((r) => r.outcome === 'updated').map((r) => r.field);
    const success = results.every((r) => r.outcome !== 'failed');
    return { success, updated, results };
  }

  // -------------------------------------------------------------------------
  // Intro modal
  // -------------------------------------------------------------------------

  private async editIntro(input: ProfileUpdateInput): Promise<ProfileFieldUpdate[]> {
    const dialog = await this.openModal(EDIT_INTRO_BUTTON, 'Edit intro');
    const results: ProfileFieldUpdate[] = [];
    let anyChanged = false;

    // Simple text fields first.
    for (const field of ['firstName', 'lastName', 'headline'] as const) {
      const value = input[field];
      if (value === undefined) continue;
      const r = await this.setTextField(dialog, field, value);
      results.push(r);
      if (r.outcome === 'updated') anyChanged = true;
    }

    // Location is a typeahead: type then pick a suggestion.
    if (input.location !== undefined) {
      const r = await this.setLocation(dialog, input.location);
      results.push(r);
      if (r.outcome === 'updated') anyChanged = true;
    }

    if (anyChanged) {
      await this.saveModal(dialog);
    } else {
      await this.dismissModal(dialog);
    }
    return results;
  }

  // -------------------------------------------------------------------------
  // About modal
  // -------------------------------------------------------------------------

  private async editAbout(about: string): Promise<ProfileFieldUpdate> {
    // Ensure the About section is in view (it lazy-mounts on scroll).
    try {
      await this.page.evaluate(() => window.scrollBy(0, 600));
      await sleep(600);
    } catch {
      /* non-fatal */
    }

    let dialog: Locator;
    try {
      dialog = await this.openModal(EDIT_ABOUT_BUTTON, 'Edit about');
    } catch (err) {
      return {
        field: 'about',
        outcome: 'failed',
        message: `Could not open the About editor: ${(err as Error).message}`,
      };
    }

    // The About editor is a single large textbox (textarea / role=textbox).
    const box = await this.firstInDialog(dialog, [
      'textarea',
      '[role="textbox"]',
      'div[contenteditable="true"]',
    ]);
    if (!box) {
      await this.dismissModal(dialog);
      return { field: 'about', outcome: 'failed', message: 'About text box not found.' };
    }

    const current = clean(await this.readValue(box)) ?? '';
    if (current === clean(about)) {
      await this.dismissModal(dialog);
      return { field: 'about', outcome: 'unchanged', message: 'About already matches.' };
    }

    await this.replaceValue(box, about);
    await this.saveModal(dialog);
    return { field: 'about', outcome: 'updated', message: 'About updated.' };
  }

  // -------------------------------------------------------------------------
  // Field helpers
  // -------------------------------------------------------------------------

  private async setTextField(
    dialog: Locator,
    field: 'firstName' | 'lastName' | 'headline',
    value: string,
  ): Promise<ProfileFieldUpdate> {
    const input = dialog.getByLabel(FIELD_LABELS[field]).first();
    try {
      if ((await input.count()) === 0 || !(await input.isVisible())) {
        return { field, outcome: 'failed', message: `${field} field not found in the intro modal.` };
      }
    } catch {
      return { field, outcome: 'failed', message: `${field} field not reachable.` };
    }

    const current = clean(await this.readValue(input)) ?? '';
    if (current === clean(value)) {
      return { field, outcome: 'unchanged', message: `${field} already matches.` };
    }
    await this.replaceValue(input, value);
    return { field, outcome: 'updated', message: `${field} updated.` };
  }

  /**
   * Location is a typeahead combobox: fill the query, wait for the suggestion
   * listbox, and click the first option. Best-effort — if no suggestion resolves
   * we report `failed` (rather than saving a free-text value LinkedIn may reject)
   * so the caller knows to set it manually.
   */
  private async setLocation(dialog: Locator, value: string): Promise<ProfileFieldUpdate> {
    const input = dialog.getByLabel(FIELD_LABELS.location).first();
    try {
      if ((await input.count()) === 0 || !(await input.isVisible())) {
        return { field: 'location', outcome: 'failed', message: 'Location field not found.' };
      }
    } catch {
      return { field: 'location', outcome: 'failed', message: 'Location field not reachable.' };
    }

    const current = clean(await this.readValue(input)) ?? '';
    if (current.toLowerCase() === clean(value)?.toLowerCase()) {
      return { field: 'location', outcome: 'unchanged', message: 'Location already matches.' };
    }

    await this.replaceValue(input, value);
    // Let the typeahead populate, then choose the first suggestion.
    await sleep(1200);
    const option = this.page.getByRole('option').first();
    try {
      if (await option.isVisible()) {
        await option.click();
        return { field: 'location', outcome: 'updated', message: 'Location updated.' };
      }
    } catch {
      /* fall through to failure */
    }
    return {
      field: 'location',
      outcome: 'failed',
      message: 'No location suggestion matched; set it manually in the pane.',
    };
  }

  // -------------------------------------------------------------------------
  // Modal helpers
  // -------------------------------------------------------------------------

  /** Click an edit pencil and return the resulting dialog, or throw. */
  private async openModal(buttonSelectors: readonly string[], label: string): Promise<Locator> {
    const button = await firstVisible(this.page, buttonSelectors, 8000);
    if (!button) {
      throw new ActionError(`"${label}" control not found on the profile.`, 'edit_button_missing');
    }
    await button.click();
    const dialog = this.page.getByRole('dialog').first();
    try {
      await dialog.waitFor({ state: 'visible', timeout: 8000 });
    } catch {
      throw new ActionError(`"${label}" dialog did not open.`, 'dialog_missing');
    }
    // Give the form a beat to hydrate its inputs.
    await sleep(600);
    return dialog;
  }

  /** Click the modal's Save button and wait for the dialog to close. */
  private async saveModal(dialog: Locator): Promise<void> {
    await rateLimitDelay();
    const save = dialog.getByRole('button', { name: /^\s*save\s*$/i }).first();
    if ((await save.count()) === 0 || !(await save.isVisible())) {
      throw new ActionError('Save button not found in the edit dialog.', 'save_missing');
    }
    await save.click();
    try {
      await dialog.waitFor({ state: 'hidden', timeout: 10_000 });
    } catch {
      // Some saves surface an inline validation error and keep the dialog open.
      throw new ActionError(
        'Saved but the dialog stayed open — LinkedIn may have rejected a value.',
        'save_not_confirmed',
      );
    }
  }

  /**
   * Close a modal without saving (used when nothing changed). Clicks the dialog's
   * dismiss control and, if LinkedIn shows a "discard changes" confirm, confirms
   * it. Best-effort: a leftover dialog is harmless since the next call navigates.
   */
  private async dismissModal(dialog: Locator): Promise<void> {
    try {
      const dismiss = dialog
        .getByRole('button', { name: /dismiss|close|cancel/i })
        .first();
      if (await dismiss.isVisible()) {
        await dismiss.click();
        // Possible "Discard changes?" confirmation.
        const discard = this.page.getByRole('button', { name: /discard/i }).first();
        if (await discard.isVisible().catch(() => false)) {
          await discard.click();
        }
      }
    } catch {
      /* best effort */
    }
  }

  // -------------------------------------------------------------------------
  // Value get/set (handles both <input>/<textarea> and contenteditable)
  // -------------------------------------------------------------------------

  private async firstInDialog(
    dialog: Locator,
    selectors: readonly string[],
  ): Promise<Locator | null> {
    for (const sel of selectors) {
      const loc = dialog.locator(sel).first();
      try {
        if ((await loc.count()) > 0 && (await loc.isVisible())) return loc;
      } catch {
        /* try next */
      }
    }
    return null;
  }

  /** Read the current value of an input/textarea, or the text of a contenteditable. */
  private async readValue(loc: Locator): Promise<string> {
    try {
      const tag = await loc.evaluate((el) => el.tagName.toLowerCase());
      if (tag === 'input' || tag === 'textarea') {
        return await loc.inputValue();
      }
    } catch {
      /* fall through to textContent */
    }
    return (await loc.textContent()) ?? '';
  }

  /** Clear an input/textarea/contenteditable and type the new value. */
  private async replaceValue(loc: Locator, value: string): Promise<void> {
    await loc.click();
    // Select-all + delete works for inputs, textareas and contenteditables.
    const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
    await this.page.keyboard.press(`${mod}+A`);
    await this.page.keyboard.press('Backspace');
    // `fill` is fastest for form controls; fall back to typing for contenteditable.
    try {
      await loc.fill(value);
    } catch {
      await loc.type(value, { delay: 15 });
    }
  }
}
