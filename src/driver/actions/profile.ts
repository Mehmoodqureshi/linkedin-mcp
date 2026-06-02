/**
 * Profile actions: view + scrape a normalized LinkedIn member profile.
 *
 * Scraping LinkedIn profiles is brittle by nature — the DOM is rendered into
 * deeply nested, RANDOMIZED/obfuscated class names (e.g. `_6bc9d9b3`) that
 * change per deploy, and the 2025+ redesign dropped the old stable `#about` /
 * `#experience` section anchors entirely. So we deliberately DO NOT anchor on
 * class names or section ids. Instead we anchor on text that LinkedIn cannot
 * easily change without breaking the page for humans:
 *   - the member name comes from `document.title` ("<Name> | LinkedIn"),
 *   - profile sections are located by their visible heading TEXT
 *     ("About", "Experience", "Education", "Skills"),
 *   - the top card (headline/location/connections) is parsed from the visible
 *     text lines around the name.
 * All extraction runs in a single in-page `evaluate` so it can reason over the
 * live text/structure rather than fight obfuscated selectors.
 */

import type { Page } from 'playwright';

import {
  LINKEDIN_BASE,
  assertAuthenticated,
  clean,
  isAuthWallUrl,
  navigate,
  rateLimitDelay,
  sleep,
} from './common';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ExperienceEntry {
  title?: string;
  company?: string;
  dateRange?: string;
  location?: string;
  description?: string;
}

export interface EducationEntry {
  school?: string;
  degree?: string;
  dateRange?: string;
}

export interface ContactInfo {
  websites?: string[];
  email?: string;
  phone?: string;
  twitter?: string;
}

export interface RecommendationEntry {
  author?: string;
  relationship?: string;
  text?: string;
}

/** Fully normalized profile payload. */
export interface ProfileData {
  url: string;
  name?: string;
  headline?: string;
  location?: string;
  about?: string;
  connectionsCount?: string;
  experience: ExperienceEntry[];
  education: EducationEntry[];
  skills: string[];
  contact?: ContactInfo;
  recommendations: RecommendationEntry[];
}

/** Top-card fields, extracted while scrolled to the top of the page. */
interface RawTopCard {
  name: string;
  headline: string;
  location: string;
  connections: string;
  about: string;
}

/** Lower-section fields, extracted while scrolled down (they virtualize). */
interface RawSections {
  about: string;
  experience: string[][];
  education: string[][];
  skills: string[];
}

// ---------------------------------------------------------------------------
// ProfileActions
// ---------------------------------------------------------------------------

export class ProfileActions {
  private readonly page: Page;

  constructor(page: Page) {
    this.page = page;
  }

  /**
   * Navigates to a vanity URL or full profile URL, scrapes, and returns a
   * normalized `ProfileData`.
   */
  async getProfile(url: string): Promise<ProfileData> {
    const target = this.normalizeUrl(url);
    await navigate(this.page, target);
    assertAuthenticated(this.page);
    await rateLimitDelay();

    // LinkedIn virtualizes the lower sections and gates the inline
    // Experience/Education/Skills previews behind connection state, so they are
    // unreliable in-page. We grab the top card + About from the main profile,
    // then pull the FULL lists from LinkedIn's dedicated detail sub-pages
    // (/details/experience|education|skills/), which render completely.
    await this.scrollToBottom();
    const sections = await this.extractSections();

    await this.page.evaluate(() => window.scrollTo(0, 0));
    await sleep(700);
    const card = await this.extractTopCard();

    // Detail sub-pages (most reliable source). Fall back to whatever the inline
    // section yielded if a detail page is empty/gated.
    const slug = this.slugFromUrl(target);
    const expDetail = slug ? await this.scrapeExperienceDetail(slug) : [];
    const eduDetail = slug ? await this.scrapeEducationDetail(slug) : [];
    const skills = slug ? await this.scrapeSkillsDetail(slug) : sections.skills;

    // Prefer the complete detail-page entries; fall back to the (often gated)
    // inline section previews mapped through the same shape only if a detail
    // page yielded nothing.
    const experience = expDetail.length
      ? expDetail
      : sections.experience.map((lines) => this.toExperience(lines));
    const education = eduDetail.length
      ? eduDetail
      : sections.education.map((lines) => this.toEducation(lines));

    const data: ProfileData = {
      url: target,
      experience,
      education,
      skills: skills.length ? skills : sections.skills,
      recommendations: [],
    };
    const name = clean(card.name);
    const headline = clean(card.headline);
    const location = clean(card.location);
    const connections = clean(card.connections);
    const about = clean(sections.about) || clean(card.about);
    if (name) data.name = name;
    if (headline) data.headline = headline;
    if (location) data.location = location;
    if (connections) data.connectionsCount = connections;
    if (about) data.about = about;
    return data;
  }

  /** Builds a profile URL from a vanity slug and delegates to `getProfile`. */
  async getProfileByUsername(username: string): Promise<ProfileData> {
    const slug = username.replace(/^\/+|\/+$/g, '').replace(/^in\//, '');
    return this.getProfile(`${LINKEDIN_BASE}/in/${slug}/`);
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  /** Accepts a full URL or a bare vanity slug; returns a canonical /in/ URL. */
  private normalizeUrl(input: string): string {
    if (/^https?:\/\//i.test(input)) return input;
    const slug = input.replace(/^\/+|\/+$/g, '').replace(/^in\//, '');
    return `${LINKEDIN_BASE}/in/${slug}/`;
  }

  /** Scroll the page to the bottom in steps so lazy sections render. */
  private async scrollToBottom(): Promise<void> {
    const steps = 8;
    for (let i = 1; i <= steps; i++) {
      await this.page.evaluate(
        (frac) => window.scrollTo(0, document.body.scrollHeight * frac),
        i / steps,
      );
      await sleep(700);
    }
  }

  /** Extract the vanity slug from a canonical /in/<slug>/ URL. */
  private slugFromUrl(url: string): string | null {
    const m = url.match(/\/in\/([^/?#]+)/i);
    return m && m[1] ? m[1] : null;
  }

  /**
   * Navigate to a `/in/<slug>/details/<type>/` sub-page and return its visible
   * text as cleaned lines (real newlines preserved), with the section heading
   * and the global page footer stripped. Returns [] if the page is gated or
   * bounces back to the main profile.
   *
   * The 2025+ redesign dropped the `<ul><li>` wrapping these lists used to have
   * (the pages now render flat, obfuscated divs), so we parse the line stream
   * rather than DOM list items.
   */
  private async loadDetailLines(slug: string, type: string): Promise<string[]> {
    const url = `${LINKEDIN_BASE}/in/${slug}/details/${type}/`;
    try {
      await navigate(this.page, url);
      if (isAuthWallUrl(this.page.url()) || !this.page.url().includes('/details/')) {
        return [];
      }
      await this.scrollToBottom();
      return await this.page.evaluate((heading: string) => {
        const norm = (s: string | null | undefined): string =>
          (s ?? '').replace(/\s+/g, ' ').trim();
        const root: HTMLElement = document.querySelector('main') ?? document.body;
        let lines = (root.innerText ?? '').split('\n').map(norm).filter(Boolean);
        // Drop the leading section heading ("Experience"/"Education"/"Skills").
        if (lines[0] && lines[0].toLowerCase() === heading.toLowerCase()) {
          lines = lines.slice(1);
        }
        // Trim the global footer (begins at "About" → "Accessibility").
        const fi = lines.findIndex(
          (l, i) => l === 'About' && lines[i + 1] === 'Accessibility',
        );
        if (fi >= 0) lines = lines.slice(0, fi);
        return lines;
      }, type);
    } catch {
      return [];
    }
  }

  /**
   * Scrape the experience detail page into structured entries. Each role is a
   * run of lines: `Title` / `Company · EmploymentType` / `DateRange · Duration`
   * / optional location / optional skills summary. We segment on the
   * `Company · <employment-type>` line (its preceding line is the title).
   */
  private async scrapeExperienceDetail(slug: string): Promise<ExperienceEntry[]> {
    const lines = await this.loadDetailLines(slug, 'experience');
    if (!lines.length) return [];

    const EMP = new Set([
      'full-time', 'part-time', 'internship', 'contract', 'freelance',
      'self-employed', 'seasonal', 'apprenticeship',
    ]);
    const DATE = /\b(19|20)\d{2}\b|present/i;
    const SKILLS = /(\band \+\d+ skills?$)|(^skills?:)/i;
    const isCompanyLine = (l: string): boolean =>
      l.includes(' · ') &&
      l.split(' · ').some((p) => EMP.has(p.trim().toLowerCase()));

    const idxs: number[] = [];
    for (let i = 0; i < lines.length; i++) {
      if (isCompanyLine(lines[i] ?? '')) idxs.push(i);
    }

    const out: ExperienceEntry[] = [];
    for (let k = 0; k < idxs.length; k++) {
      const ci = idxs[k] as number;
      // Meta runs to the line before the NEXT entry's title (next company - 1).
      const metaEnd = k + 1 < idxs.length ? (idxs[k + 1] as number) - 1 : lines.length;
      const meta = lines.slice(ci + 1, metaEnd);

      const entry: ExperienceEntry = {};
      const title = clean(lines[ci - 1]);
      if (title) entry.title = title;
      const company = clean((lines[ci] ?? '').split(' · ')[0]);
      if (company) entry.company = company;
      const dateRange = clean(meta.find((l) => DATE.test(l)));
      if (dateRange) entry.dateRange = dateRange;
      const location = clean(
        meta.find(
          (l) => l !== dateRange && !SKILLS.test(l) && /,/.test(l) && !DATE.test(l),
        ),
      );
      if (location) entry.location = location;
      const description = clean(
        meta
          .filter(
            (l) =>
              l !== dateRange && l !== location && !SKILLS.test(l) && l.length > 60,
          )
          .sort((a, b) => b.length - a.length)[0],
      );
      if (description) entry.description = description;
      if (entry.title || entry.company) out.push(entry);
    }
    return out;
  }

  /**
   * Scrape the education detail page into structured entries. Each entry is a
   * run of lines: `School` / optional `Degree` / optional `DateRange` /
   * optional `Skills: …`. We segment on the school anchor texts (`/school/` or
   * `/company/` links), falling back to date-line anchoring when a school has
   * no link.
   */
  private async scrapeEducationDetail(slug: string): Promise<EducationEntry[]> {
    const url = `${LINKEDIN_BASE}/in/${slug}/details/education/`;
    try {
      await navigate(this.page, url);
      if (isAuthWallUrl(this.page.url()) || !this.page.url().includes('/details/')) {
        return [];
      }
      await this.scrollToBottom();
      return await this.page.evaluate(() => {
        const norm = (s: string | null | undefined): string =>
          (s ?? '').replace(/\s+/g, ' ').trim();
        const root: HTMLElement = document.querySelector('main') ?? document.body;
        const DATE = /\b(19|20)\d{2}\b/;
        const SKILLS = /^skills?:/i;

        // Dedupe + line-split a container's visible text.
        const blockLines = (el: HTMLElement): string[] => {
          const seen = new Set<string>();
          return (el.innerText ?? '').split('\n').map(norm).filter((t) => {
            if (!t || seen.has(t)) return false;
            seen.add(t);
            return true;
          });
        };

        type Edu = { school?: string; degree?: string; dateRange?: string };
        const out: Edu[] = [];

        // Primary: each entry is anchored by a /school/ (or /company/) link.
        // Climb from the anchor to the smallest ancestor that holds a date —
        // that's the entry block. The school is the block's first line.
        const seenHref = new Set<string>();
        for (const a of Array.from(
          root.querySelectorAll('a[href*="/school/"], a[href*="/company/"]'),
        )) {
          const href = (a.getAttribute('href') ?? '').split('?')[0] ?? '';
          if (!href || seenHref.has(href)) continue;
          let c: HTMLElement | null = a as HTMLElement;
          for (let n = 0; n < 8 && c; n++) {
            if (DATE.test(c.innerText ?? '')) break;
            c = c.parentElement;
          }
          if (!c) continue;
          const block = blockLines(c);
          if (!block.length) continue;
          seenHref.add(href);
          const entry: Edu = {};
          if (block[0]) entry.school = block[0];
          const degree = block.slice(1).find((l) => !DATE.test(l) && !SKILLS.test(l));
          if (degree) entry.degree = degree;
          const dateRange = block.find((l) => DATE.test(l));
          if (dateRange) entry.dateRange = dateRange;
          if (entry.school) out.push(entry);
        }
        if (out.length) return out;

        // Fallback (no school links — e.g. manually typed schools): segment the
        // flat line stream by date lines; the school is each block's first line.
        let lines = (root.innerText ?? '').split('\n').map(norm).filter(Boolean);
        if (lines[0] && lines[0].toLowerCase() === 'education') lines = lines.slice(1);
        const fi = lines.findIndex(
          (l, i) => l === 'About' && lines[i + 1] === 'Accessibility',
        );
        if (fi >= 0) lines = lines.slice(0, fi);
        let start = 0;
        for (let i = 0; i < lines.length; i++) {
          if (!DATE.test(lines[i] ?? '')) continue;
          const block = lines.slice(start, i + 1);
          const entry: Edu = {};
          if (block[0]) entry.school = block[0];
          const degree = block.slice(1).find((l) => !DATE.test(l) && !SKILLS.test(l));
          if (degree) entry.degree = degree;
          const dateRange = lines[i];
          if (dateRange) entry.dateRange = dateRange;
          if (entry.school) out.push(entry);
          start = i + 1;
          while (start < lines.length && SKILLS.test(lines[start] ?? '')) start++;
        }
        return out;
      });
    } catch {
      return [];
    }
  }

  /**
   * Scrape the skills detail page. Two layouts occur in the wild:
   *
   *   (A) Endorsed profiles render each skill as a block ending in an
   *       `Endorse`/`Endorsed` affordance, with a VARIABLE number of
   *       usage-context lines between (role/company, school, endorsement count,
   *       "Show all N details", assessment badge). Here a skill is the first
   *       line after the tabs and the first line after every terminator.
   *
   *   (B) Sparse profiles render a flat one-skill-per-line list with NO
   *       `Endorse` affordances and the odd context line (e.g. "Passed LinkedIn
   *       Skill Assessment"). Here every non-tab, non-context line is a skill.
   *
   * The leading category tabs (All / Tools & Technologies / Languages / …) vary
   * per profile, so we read them from the page's `<li>` filter elements rather
   * than hardcoding the list.
   */
  private async scrapeSkillsDetail(slug: string): Promise<string[]> {
    const url = `${LINKEDIN_BASE}/in/${slug}/details/skills/`;
    try {
      await navigate(this.page, url);
      if (isAuthWallUrl(this.page.url()) || !this.page.url().includes('/details/')) {
        return [];
      }
      await this.scrollToBottom();
      return await this.page.evaluate(() => {
        const norm = (s: string | null | undefined): string =>
          (s ?? '').replace(/\s+/g, ' ').trim();
        const root: HTMLElement = document.querySelector('main') ?? document.body;

        // Category tabs are the page's <li> filter chips (skills themselves
        // render as role=listitem divs, not <li>). Read them dynamically.
        const tabSet = new Set<string>(['skills', 'all']);
        for (const li of Array.from(root.querySelectorAll('li'))) {
          const t = norm((li as HTMLElement).innerText).toLowerCase();
          if (t && t.length < 40) tabSet.add(t);
        }
        const isTab = (l: string): boolean => tabSet.has(l.toLowerCase());

        let lines = (root.innerText ?? '').split('\n').map(norm).filter(Boolean);
        if (lines[0] && lines[0].toLowerCase() === 'skills') lines = lines.slice(1);
        const fi = lines.findIndex(
          (l, i) => l === 'About' && lines[i + 1] === 'Accessibility',
        );
        if (fi >= 0) lines = lines.slice(0, fi);

        const out: string[] = [];
        const hasEndorse = lines.some((l) => l === 'Endorse' || l === 'Endorsed');
        if (hasEndorse) {
          // Layout A: first non-tab line, then first line after each terminator.
          let expectSkill = true;
          for (const l of lines) {
            if (isTab(l)) continue;
            if (expectSkill) {
              if (l !== 'Endorse' && l !== 'Endorsed') {
                out.push(l);
                expectSkill = false;
              }
              continue;
            }
            if (l === 'Endorse' || l === 'Endorsed') expectSkill = true;
          }
        } else {
          // Layout B: every non-tab, non-context line is a skill.
          const CONTEXT =
            /^(\d+ endorsements?|show all \d+ details?|passed linkedin skill assessment|endorse|endorsed)$/i;
          for (const l of lines) {
            if (isTab(l) || CONTEXT.test(l) || / at /i.test(l)) continue;
            out.push(l);
          }
        }
        return Array.from(new Set(out)).slice(0, 60);
      });
    } catch {
      return [];
    }
  }

  /**
   * Extract the top card (name / headline / location / connections). Run while
   * scrolled to the top. Anchors on document.title and the visible text lines
   * around the name, skipping pronoun and UI-affordance lines.
   */
  private extractTopCard(): Promise<RawTopCard> {
    return this.page.evaluate(() => {
      const norm = (s: string | null | undefined): string =>
        (s ?? '').replace(/\s+/g, ' ').trim();
      const root: HTMLElement = document.querySelector('main') ?? document.body;

      const name = norm(
        document.title.replace(/\(\d+\)\s*/g, '').replace(/\|\s*LinkedIn.*$/i, ''),
      );

      // Smallest ancestor of the name leaf that also mentions connections.
      const nameEl =
        Array.from(root.querySelectorAll('h1,h2,h3,p,span,a,strong')).find(
          (el) => norm(el.textContent) === name && el.children.length <= 1,
        ) ?? null;
      let card: HTMLElement | null = nameEl as HTMLElement | null;
      for (let i = 0; i < 8 && card; i++) {
        const t = (card.textContent ?? '').toLowerCase();
        if (t.includes('connection') || t.includes('follower')) break;
        card = card.parentElement;
      }
      const cardEl: HTMLElement = card ?? root;

      const lines = (cardEl.innerText ?? '').split('\n').map(norm).filter(Boolean);
      const CONN_RE = /([\d,.]+)\s*\+?\s*(connections?|followers?)/i;
      // Lines that are UI affordances / pronouns, never headline or location.
      const NOISE_RE =
        /^(he\/him|she\/her|they\/them|message|connect|more|follow|following|pending|contact info|add verification badge|add (profile )?section|enhance profile|open to|get started|add services|show recruiters|·|save in sales navigator|view .* profile|premium)/i;

      let headline = '';
      let location = '';
      let connections = '';
      const ni = lines.findIndex((l) => l === name);
      const start = ni >= 0 ? ni + 1 : 0;
      for (let j = start; j < lines.length; j++) {
        const l = lines[j] ?? '';
        const connMatch = l.match(CONN_RE);
        if (connMatch) {
          if (!connections) connections = connMatch[0];
          continue;
        }
        if (NOISE_RE.test(l)) continue;
        if (!headline && l.length > 2) {
          headline = l;
          continue;
        }
        // Location: the place-like line right after the headline.
        if (
          headline &&
          !location &&
          /[A-Za-z]/.test(l) &&
          !/\d/.test(l) &&
          l.length < 70 &&
          !/connection|follower/i.test(l) &&
          (l.includes(',') || / area$/i.test(l))
        ) {
          location = l;
          break;
        }
      }
      if (!connections) {
        const m = norm(cardEl.textContent).match(CONN_RE);
        if (m) connections = m[0];
      }

      return { name, headline, location, connections, about: '' };
    });
  }

  /**
   * Extract the lower sections (About / Experience / Education / Skills). Run
   * while scrolled down so the virtualized sections are present in the DOM.
   * Sections are located by their visible heading TEXT, not class/id.
   */
  private extractSections(): Promise<RawSections> {
    return this.page.evaluate(() => {
      const norm = (s: string | null | undefined): string =>
        (s ?? '').replace(/\s+/g, ' ').trim();
      const root: HTMLElement = document.querySelector('main') ?? document.body;

      const headings = Array.from(root.querySelectorAll('h2, h3'));
      const sectionFor = (label: string): HTMLElement | null => {
        const h = headings.find(
          (e) => norm(e.textContent).toLowerCase() === label.toLowerCase(),
        );
        if (!h) return null;
        return (h.closest('section') as HTMLElement | null) ?? h.parentElement;
      };

      const about = (() => {
        const sec = sectionFor('About');
        if (!sec) return '';
        return norm(sec.innerText).replace(/^About\s*/i, '').slice(0, 2000);
      })();

      const topItems = (sec: HTMLElement): HTMLLIElement[] =>
        Array.from(sec.querySelectorAll('li')).filter(
          (li) => !li.parentElement?.closest('li'),
        ) as HTMLLIElement[];

      const entriesFor = (label: string): string[][] => {
        const sec = sectionFor(label);
        if (!sec) return [];
        const out: string[][] = [];
        for (const li of topItems(sec).slice(0, 25)) {
          const seen = new Set<string>();
          const ls = (li.innerText ?? '')
            .split('\n')
            .map(norm)
            .filter((t) => {
              if (!t || seen.has(t)) return false;
              seen.add(t);
              return true;
            });
          if (ls.length) out.push(ls.slice(0, 5));
        }
        return out;
      };

      const skills = (() => {
        const sec = sectionFor('Skills');
        if (!sec) return [] as string[];
        const set = new Set<string>();
        for (const li of topItems(sec)) {
          const first = norm((li.innerText ?? '').split('\n')[0]);
          if (first && first.length < 80) set.add(first);
        }
        return Array.from(set).slice(0, 50);
      })();

      return {
        about,
        experience: entriesFor('Experience'),
        education: entriesFor('Education'),
        skills,
      };
    });
  }

  /** Map a detail-page item's text lines to an experience entry (best-effort). */
  private toExperience(lines: string[]): ExperienceEntry {
    const DATE_RE = /\b(19|20)\d{2}\b|present|·\s*\d+\s*(yr|mo)/i;
    const EMP_RE =
      /^(full-time|part-time|internship|contract|freelance|self-employed|seasonal|apprenticeship)$/i;
    const MODE_RE = /^(remote|hybrid|on-?site)$/i;
    const SKILLS_RE = /^skills?:/i;

    const entry: ExperienceEntry = {};
    const title = clean(lines[0]);
    if (title) entry.title = title;

    const dateRange = clean(lines.find((l) => DATE_RE.test(l)));
    if (dateRange) entry.dateRange = dateRange;

    // Company: a short non-date/employment/mode/skills line that isn't a place
    // (no comma) — present only when the role isn't grouped under a company head.
    const company = clean(
      lines
        .slice(1)
        .find(
          (l) =>
            !DATE_RE.test(l) &&
            !EMP_RE.test(l) &&
            !MODE_RE.test(l) &&
            !SKILLS_RE.test(l) &&
            !l.includes(',') &&
            l.length < 50 &&
            / · |\bat\b/i.test(l),
        ),
    );
    if (company) entry.company = company;

    // Location: a place-like line (comma) or a work-mode word.
    const location = clean(
      lines.find(
        (l) =>
          l !== company &&
          !DATE_RE.test(l) &&
          !SKILLS_RE.test(l) &&
          (/,/.test(l) || MODE_RE.test(l)) &&
          l.length < 60,
      ),
    );
    if (location) entry.location = location;

    // Description: the longest substantive line that isn't the skills summary.
    const description = clean(
      lines
        .filter((l) => !SKILLS_RE.test(l) && l.length > 60)
        .sort((a, b) => b.length - a.length)[0],
    );
    if (description) entry.description = description;

    return entry;
  }

  /** Map a list item's text lines to an education entry (best-effort). */
  private toEducation(lines: string[]): EducationEntry {
    const DATE_RE = /\b(19|20)\d{2}\b|present|·/i;
    const entry: EducationEntry = {};
    const school = clean(lines[0]);
    if (school) entry.school = school;
    const degree = clean(lines[1]);
    if (degree && !DATE_RE.test(degree)) entry.degree = degree;
    const dateLine = lines.find((l) => DATE_RE.test(l));
    const dateRange = clean(dateLine);
    if (dateRange) entry.dateRange = dateRange;
    return entry;
  }
}
