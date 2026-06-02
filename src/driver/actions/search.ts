/**
 * Search actions: people, jobs, and companies.
 *
 * LinkedIn search is URL-driven: filters are encoded as querystring params on
 * the `/search/results/<vertical>/` routes, which is far more robust than
 * clicking the filter UI. We build those URLs deterministically and then scrape
 * the result cards, which are exposed as a semantic list with stable
 * `data-*` hooks on the search container.
 */

import type { Page } from 'playwright';

import {
  LINKEDIN_BASE,
  assertAuthenticated,
  autoScroll,
  clean,
  enc,
  navigate,
  rateLimitDelay,
} from './common';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ConnectionDegree = '1st' | '2nd' | '3rd';

export interface PeopleFilters {
  location?: string;
  company?: string;
  industry?: string;
  title?: string;
  school?: string;
  connectionDegree?: ConnectionDegree;
}

export interface JobFilters {
  location?: string;
  remote?: boolean;
  /** 'internship' | 'entry' | 'associate' | 'mid-senior' | 'director' | 'executive' */
  experienceLevel?: string;
  /** 'past-24h' | 'past-week' | 'past-month' */
  datePosted?: string;
  easyApply?: boolean;
}

export interface CompanyFilters {
  location?: string;
  industry?: string;
  /** e.g. '1-10', '11-50', '51-200', '201-500', '501-1000', '1001-5000' */
  companySize?: string;
}

export interface SearchResult {
  name?: string;
  headline?: string;
  location?: string;
  profileUrl?: string;
  connectionDegree?: string;
}

export interface JobResult {
  title?: string;
  company?: string;
  location?: string;
  jobUrl?: string;
  postedDate?: string;
  easyApply?: boolean;
}

export interface CompanyResult {
  name?: string;
  industry?: string;
  location?: string;
  followers?: string;
  companyUrl?: string;
}

// ---------------------------------------------------------------------------
// SearchActions
// ---------------------------------------------------------------------------

export class SearchActions {
  private readonly page: Page;

  constructor(page: Page) {
    this.page = page;
  }

  // -------------------------------------------------------------------------
  // People
  // -------------------------------------------------------------------------

  async searchPeople(query: string, filters?: PeopleFilters): Promise<SearchResult[]> {
    const params = new URLSearchParams();
    params.set('keywords', query);
    params.set('origin', 'GLOBAL_SEARCH_HEADER');

    if (filters?.location) params.set('keywords', `${query} ${filters.location}`);
    if (filters?.connectionDegree) {
      // LinkedIn encodes degree filter as network=["F"|"S"|"O"].
      const map: Record<ConnectionDegree, string> = { '1st': 'F', '2nd': 'S', '3rd': 'O' };
      params.set('network', JSON.stringify([map[filters.connectionDegree]]));
    }
    if (filters?.title) params.set('title', filters.title);
    if (filters?.company) params.set('company', filters.company);
    if (filters?.school) params.set('schoolFreetext', filters.school);
    if (filters?.industry) params.set('industry', filters.industry);

    await navigate(this.page, `${LINKEDIN_BASE}/search/results/people/?${params.toString()}`);
    assertAuthenticated(this.page);
    await rateLimitDelay();

    const cards = await this.collectByHref('/in/', 25);
    const out: SearchResult[] = [];
    for (const { href, lines } of cards) {
      const r = this.parsePerson(href, lines);
      if (r) out.push(r);
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // Jobs
  // -------------------------------------------------------------------------

  async searchJobs(query: string, filters?: JobFilters): Promise<JobResult[]> {
    const params = new URLSearchParams();
    params.set('keywords', query);
    if (filters?.location) params.set('location', filters.location);

    // f_WT=2 => remote workplace type.
    if (filters?.remote) params.set('f_WT', '2');
    if (filters?.easyApply) params.set('f_AL', 'true');

    if (filters?.datePosted) {
      const map: Record<string, string> = {
        'past-24h': 'r86400',
        'past-week': 'r604800',
        'past-month': 'r2592000',
      };
      const v = map[filters.datePosted];
      if (v) params.set('f_TPR', v);
    }
    if (filters?.experienceLevel) {
      const map: Record<string, string> = {
        internship: '1',
        entry: '2',
        associate: '3',
        'mid-senior': '4',
        director: '5',
        executive: '6',
      };
      const v = map[filters.experienceLevel];
      if (v) params.set('f_E', v);
    }

    await navigate(this.page, `${LINKEDIN_BASE}/jobs/search/?${params.toString()}`);
    assertAuthenticated(this.page);
    await rateLimitDelay();

    const cards = await this.collectByHref('/jobs/view/', 25);
    const out: JobResult[] = [];
    for (const { href, lines } of cards) {
      const r = this.parseJob(href, lines);
      if (r) out.push(r);
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // Companies
  // -------------------------------------------------------------------------

  async searchCompanies(query: string, filters?: CompanyFilters): Promise<CompanyResult[]> {
    const params = new URLSearchParams();
    params.set('keywords', query);
    params.set('origin', 'GLOBAL_SEARCH_HEADER');
    if (filters?.location) params.set('keywords', `${query} ${filters.location}`);
    if (filters?.industry) params.set('industryCompanyVertical', filters.industry);
    if (filters?.companySize) params.set('companySize', enc(filters.companySize));

    await navigate(
      this.page,
      `${LINKEDIN_BASE}/search/results/companies/?${params.toString()}`,
    );
    assertAuthenticated(this.page);
    await rateLimitDelay();

    const cards = await this.collectByHref('/company/', 25);
    const out: CompanyResult[] = [];
    for (const { href, lines } of cards) {
      const r = this.parseCompany(href, lines);
      if (r) out.push(r);
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  /**
   * Collect result cards by anchor href. LinkedIn search results use obfuscated
   * class names, so we anchor on the result links (e.g. `/in/`, `/jobs/view/`,
   * `/company/`), take each link's enclosing `<li>`, and return its visible text
   * lines. Deduped by canonical href, keeping the richest (most-lines) card.
   */
  private async collectByHref(
    hrefSubstr: string,
    max = 25,
  ): Promise<Array<{ href: string; lines: string[] }>> {
    await autoScroll(this.page, `a[href*="${hrefSubstr}"]`, max).catch(
      () => undefined,
    );
    return this.page.evaluate(
      ({ sub, limit }) => {
        const norm = (s: string | null | undefined): string =>
          (s ?? '').replace(/\s+/g, ' ').trim();
        const root: HTMLElement =
          document.querySelector('main') ?? document.body;
        const links = Array.from(
          root.querySelectorAll(`a[href*="${sub}"]`),
        );
        const byHref = new Map<string, string[]>();
        const order: string[] = [];
        for (const a of links) {
          const raw = a.getAttribute('href') ?? '';
          if (!raw) continue;
          const key = (raw.split('?')[0] ?? raw).replace(/\/$/, '');
          const li = a.closest('li') ?? a.parentElement;
          if (!li) continue;
          const seen = new Set<string>();
          const lines = (li.innerText ?? '')
            .split('\n')
            .map(norm)
            .filter((t) => {
              if (!t || seen.has(t)) return false;
              seen.add(t);
              return true;
            });
          const prev = byHref.get(key);
          if (!prev) order.push(key);
          if (!prev || lines.length > prev.length) byHref.set(key, lines);
        }
        return order
          .slice(0, limit)
          .map((href) => ({ href, lines: byHref.get(href) ?? [] }))
          .filter((c) => c.lines.length > 0);
      },
      { sub: hrefSubstr, limit: max },
    );
  }

  private static readonly DEGREE_RE = /•\s*(1st|2nd|3rd)\b/i;
  private static readonly ACTION_RE =
    /^(connect|message|follow|following|pending|view profile|view full profile|invite .* to connect)$/i;

  /** Parse a people-search card's text lines into a SearchResult. */
  private parsePerson(href: string, lines: string[]): SearchResult | null {
    const first = lines[0] ?? '';
    // Skip non-result cards (mutual-connection blurbs, bare name fragments).
    if (/mutual connection/i.test(first)) return null;

    const degMatch = lines.join(' ').match(SearchActions.DEGREE_RE);
    const name = clean(first.replace(SearchActions.DEGREE_RE, '').replace(/•.*$/, ''));
    if (!name) return null;

    const isLocation = (l: string): boolean =>
      /,/.test(l) && !l.includes('|') && !l.includes(':') && l.length < 60;
    const mid = lines
      .slice(1)
      .filter(
        (l) =>
          !SearchActions.ACTION_RE.test(l) &&
          !/^•/.test(l) &&
          !/^current:/i.test(l) &&
          !SearchActions.DEGREE_RE.test(l) &&
          !/mutual connection|is a shared connection|are mutual/i.test(l),
      );
    const locIdx = mid.findIndex(isLocation);
    const headline =
      locIdx >= 0 ? clean(mid.slice(0, locIdx).join(' ')) : clean(mid.join(' '));
    const location = locIdx >= 0 ? clean(mid[locIdx]) : undefined;

    const result: SearchResult = { profileUrl: this.cleanProfileUrl(href) };
    result.name = name;
    if (headline) result.headline = headline;
    if (location) result.location = location;
    if (degMatch && degMatch[1]) result.connectionDegree = degMatch[1].toLowerCase();
    return result;
  }

  /** Parse a jobs-search card's text lines into a JobResult. */
  private parseJob(href: string, lines: string[]): JobResult | null {
    const title = clean(lines[0]);
    if (!title) return null;
    const easyApply = lines.some((l) => /easy apply/i.test(l));
    const TIME_RE = /\b(ago|hour|day|week|month|minute)s?\b|just now/i;
    const company = clean(lines[1]);
    // Location is never the title (line 0) or company (line 1). Prefer a line
    // with an explicit workplace type, else a comma-bearing line from line 2 on.
    const location = clean(
      lines
        .slice(1)
        .find((l) => /\((remote|on-?site|hybrid)\)/i.test(l)) ??
        lines.slice(2).find((l) => /,/.test(l) && !TIME_RE.test(l)),
    );
    const postedDate = clean(lines.find((l) => TIME_RE.test(l)));

    const result: JobResult = { easyApply };
    result.jobUrl = this.cleanJobUrl(href);
    result.title = title;
    if (company && company !== location) result.company = company;
    if (location) result.location = location;
    if (postedDate) result.postedDate = postedDate;
    return result;
  }

  /** Parse a companies-search card's text lines into a CompanyResult. */
  private parseCompany(href: string, lines: string[]): CompanyResult | null {
    const name = clean(lines[0]);
    if (!name) return null;
    const FOLLOWERS_RE = /[\d,.]+\+?\s*(followers?|members?)/i;
    const followers = clean(lines.find((l) => FOLLOWERS_RE.test(l)));
    const location = clean(
      lines
        .slice(1)
        .find((l) => /,/.test(l) && l.length < 50 && !FOLLOWERS_RE.test(l)),
    );
    // Industry: the first short line after the name that isn't followers/location.
    const industry = clean(
      lines
        .slice(1)
        .find(
          (l) =>
            l !== location &&
            !FOLLOWERS_RE.test(l) &&
            !/^(follow|following|visit website)$/i.test(l) &&
            l.length < 50 &&
            !/,/.test(l),
        ),
    );

    const result: CompanyResult = { companyUrl: this.cleanCompanyUrl(href) };
    result.name = name;
    if (industry) result.industry = industry;
    if (location) result.location = location;
    if (followers) result.followers = followers;
    return result;
  }

  private cleanProfileUrl(href: string): string {
    const abs = href.startsWith('http') ? href : `${LINKEDIN_BASE}${href}`;
    return abs.split('?')[0] ?? abs;
  }

  private cleanJobUrl(href: string): string {
    const abs = href.startsWith('http') ? href : `${LINKEDIN_BASE}${href}`;
    return abs.split('?')[0] ?? abs;
  }

  private cleanCompanyUrl(href: string): string {
    const abs = href.startsWith('http') ? href : `${LINKEDIN_BASE}${href}`;
    return abs.split('?')[0] ?? abs;
  }
}
