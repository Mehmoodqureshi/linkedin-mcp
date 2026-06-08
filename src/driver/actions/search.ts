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

/** A filter value that may arrive as a single string or an array of strings. */
type OneOrMany<T extends string = string> = T | T[];

export interface PeopleFilters {
  /** Locations. Folded into the keyword query. `location` is a legacy alias. */
  locations?: string[];
  location?: string;
  /** Current employers. `company` is a legacy single-value alias. */
  currentCompanies?: string[];
  company?: string;
  /** Past employers (no native free-text facet — folded into the query). */
  pastCompanies?: string[];
  /** Industries. `industry` is a legacy single-value alias. */
  industries?: string[];
  industry?: string;
  title?: string;
  school?: string;
  /** One or more connection degrees. `connectionDegree` is a legacy alias. */
  connectionDegrees?: ConnectionDegree[];
  connectionDegree?: ConnectionDegree;
}

export interface JobFilters {
  location?: string;
  /** Workplace types: 'on-site' | 'remote' | 'hybrid'. `remote: true` is a legacy alias for ['remote']. */
  workplaceType?: OneOrMany<'on-site' | 'remote' | 'hybrid'>;
  remote?: boolean;
  /** 'internship' | 'entry' | 'associate' | 'mid-senior' | 'director' | 'executive' */
  experienceLevel?: OneOrMany;
  /** Job types: 'full-time' | 'part-time' | 'contract' | 'temporary' | 'internship' | 'volunteer' | 'other'. */
  jobType?: OneOrMany;
  /** Minimum salary bucket, e.g. '40k' | '60k' | '80k' | '100k' | '120k' | '140k' | '160k' | '180k' | '200k'. */
  salary?: string;
  /** 'any' | 'past-24h' | 'past-week' | 'past-month' */
  datePosted?: string;
  easyApply?: boolean;
  /** MCP-schema alias for `easyApply`. */
  easyApplyOnly?: boolean;
}

export interface CompanyFilters {
  /** Locations. Folded into the keyword query. `location` is a legacy alias. */
  locations?: string[];
  location?: string;
  /** Industries. `industry` is a legacy single-value alias. */
  industries?: string[];
  industry?: string;
  /** e.g. '1-10', '11-50', '51-200', '201-500', '501-1000', '1001-5000', '5001-10000', '10001+' */
  companySize?: OneOrMany;
}

// ---------------------------------------------------------------------------
// Filter helpers
// ---------------------------------------------------------------------------

/**
 * Normalize a `string | string[] | undefined` filter into a clean string array:
 * coerces a single value to a one-element array, trims, and drops blanks. This
 * is what lets every filter accept both the MCP array shape and the legacy
 * single-value shape the UI/IPC layer sends.
 */
function toList(...values: Array<OneOrMany | undefined>): string[] {
  const out: string[] = [];
  for (const v of values) {
    if (v == null) continue;
    for (const s of Array.isArray(v) ? v : [v]) {
      const t = String(s).trim();
      if (t) out.push(t);
    }
  }
  return out;
}

/** De-dupe while preserving first-seen order. */
function unique(items: string[]): string[] {
  return [...new Set(items)];
}

/**
 * Map a minimum-salary input to LinkedIn's `f_SB2` bucket code (1–9). Accepts a
 * raw code ('1'..'9'), a 'NNk' label ('40k', '100k'), or a plain number/string
 * of dollars ('60000', '$120,000'). Returns the code for the highest bucket the
 * value meets, or undefined when it can't be parsed.
 */
function salaryBucket(input: string): string | undefined {
  const raw = input.trim();
  if (/^[1-9]$/.test(raw)) return raw;
  // Thresholds (in dollars) for buckets 1..9.
  const thresholds = [40, 60, 80, 100, 120, 140, 160, 180, 200].map((k) => k * 1000);
  const kMatch = raw.match(/^\$?\s*(\d+(?:\.\d+)?)\s*k$/i);
  const dollars = kMatch
    ? Math.round(parseFloat(kMatch[1] as string) * 1000)
    : Number(raw.replace(/[^0-9.]/g, ''));
  if (!Number.isFinite(dollars) || dollars <= 0) return undefined;
  let code: string | undefined;
  thresholds.forEach((t, i) => {
    if (dollars >= t) code = String(i + 1);
  });
  return code;
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
    params.set('origin', 'GLOBAL_SEARCH_HEADER');

    // Free-text facets (location, company, industry, past company) are not honored
    // as standalone URL params on the people-results route, so we fold every value
    // into the keyword query — the one signal LinkedIn reliably applies. Dedicated
    // params that ARE honored (title, school, network) are set below.
    const locations = toList(filters?.locations, filters?.location);
    const currentCompanies = toList(filters?.currentCompanies, filters?.company);
    const pastCompanies = toList(filters?.pastCompanies);
    const industries = toList(filters?.industries, filters?.industry);
    const keywords = unique([query, ...locations, ...currentCompanies, ...pastCompanies, ...industries]);
    params.set('keywords', keywords.join(' '));

    const degrees = unique(
      toList(filters?.connectionDegrees, filters?.connectionDegree),
    ) as ConnectionDegree[];
    if (degrees.length) {
      // LinkedIn encodes the degree filter as network=["F"|"S"|"O"].
      const map: Record<ConnectionDegree, string> = { '1st': 'F', '2nd': 'S', '3rd': 'O' };
      params.set('network', JSON.stringify(degrees.map((d) => map[d]).filter(Boolean)));
    }
    if (filters?.title) params.set('title', filters.title);
    if (filters?.school) params.set('schoolFreetext', filters.school);

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

    // Workplace type — LinkedIn's f_WT facet: 1=on-site, 2=remote, 3=hybrid. It
    // accepts a comma-joined list. `remote: true` is the legacy single-value form.
    const wtMap: Record<string, string> = { 'on-site': '1', remote: '2', hybrid: '3' };
    const workplace = unique(
      toList(filters?.workplaceType, filters?.remote ? 'remote' : undefined)
        .map((w) => wtMap[w])
        .filter((v): v is string => Boolean(v)),
    );
    if (workplace.length) params.set('f_WT', workplace.join(','));

    if (filters?.easyApply || filters?.easyApplyOnly) params.set('f_AL', 'true');

    if (filters?.datePosted && filters.datePosted !== 'any') {
      const map: Record<string, string> = {
        'past-24h': 'r86400',
        'past-week': 'r604800',
        'past-month': 'r2592000',
      };
      const v = map[filters.datePosted];
      if (v) params.set('f_TPR', v);
    }

    // Experience level — f_E facet (comma-joined): 1=internship … 6=executive.
    const expMap: Record<string, string> = {
      internship: '1',
      entry: '2',
      associate: '3',
      'mid-senior': '4',
      director: '5',
      executive: '6',
    };
    const exp = unique(
      toList(filters?.experienceLevel)
        .map((e) => expMap[e])
        .filter((v): v is string => Boolean(v)),
    );
    if (exp.length) params.set('f_E', exp.join(','));

    // Job type — f_JT facet (comma-joined): F=full-time, P=part-time, C=contract,
    // T=temporary, I=internship, V=volunteer, O=other.
    const jtMap: Record<string, string> = {
      'full-time': 'F',
      'part-time': 'P',
      contract: 'C',
      temporary: 'T',
      internship: 'I',
      volunteer: 'V',
      other: 'O',
    };
    const jobTypes = unique(
      toList(filters?.jobType)
        .map((j) => jtMap[j])
        .filter((v): v is string => Boolean(v)),
    );
    if (jobTypes.length) params.set('f_JT', jobTypes.join(','));

    // Minimum salary — f_SB2 facet: 1=$40k+, 2=$60k+ … 9=$200k+. Accept either a
    // bare bucket label ('40k', '$60,000', '100000') or the raw code.
    if (filters?.salary) {
      const code = salaryBucket(filters.salary);
      if (code) params.set('f_SB2', code);
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
    params.set('origin', 'GLOBAL_SEARCH_HEADER');

    // Locations and industries fold into the keyword query (the reliable signal).
    const locations = toList(filters?.locations, filters?.location);
    const industries = toList(filters?.industries, filters?.industry);
    const keywords = unique([query, ...locations, ...industries]);
    params.set('keywords', keywords.join(' '));

    // Company-size facet still accepts the size-band strings as a comma-joined list.
    const sizes = unique(toList(filters?.companySize));
    if (sizes.length) params.set('companySize', enc(sizes.join(',')));

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
