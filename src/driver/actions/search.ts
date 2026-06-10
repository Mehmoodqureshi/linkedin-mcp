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
  /**
   * Locations. LinkedIn's company-search route ignores geo URL facets, so this is
   * enforced by POST-FILTERING each result card's `location` line (not folded into
   * the keyword query, which polluted the search and often zeroed it out).
   * `location` is a legacy single-value alias.
   */
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
 * Stable LinkedIn geoUrn ids for the locations we filter by most. LinkedIn's
 * runtime typeahead endpoint (which would resolve arbitrary place names) moved
 * to a deploy-versioned GraphQL route that 404s the old REST path, so for the
 * common case we map names → ids directly. These country/region ids are stable.
 * Anything not listed falls back to the keyword query (still biased, just not a
 * hard geo facet). Keys are lowercased; common aliases included.
 */
const KNOWN_GEO: Record<string, string> = {
  'united states': '103644278',
  usa: '103644278',
  us: '103644278',
  'united states of america': '103644278',
  'united kingdom': '101165590',
  uk: '101165590',
  'great britain': '101165590',
  england: '102299470',
  london: '102257491',
  'greater london': '102257491',
  canada: '101174742',
  australia: '101452733',
  ireland: '104738515',
  'new zealand': '105490917',
  india: '102713980',
  'european union': '91000000',
  europe: '91000000',
};

/**
 * Region/abbreviation tokens that let us post-filter company cards by COUNTRY.
 * Company-search cards print a "City, Region" (sometimes "City, Region, Country")
 * line, and the country name often does NOT appear — a US company shows
 * "San Francisco, California", not "…United States". So for the countries we
 * support, a requested country name is expanded to the region/state tokens that
 * DO appear on cards: `substrings` are matched anywhere in the lowercased line;
 * `abbr` (2-letter codes) are matched only as whole words to avoid false hits
 * (e.g. "in" inside "Indianapolis"). Cards that already carry the country name
 * match directly via the requested name itself (added in `expandLocation`).
 */
const US_STATE_NAMES = [
  'alabama', 'alaska', 'arizona', 'arkansas', 'california', 'colorado',
  'connecticut', 'delaware', 'florida', 'georgia', 'hawaii', 'idaho', 'illinois',
  'indiana', 'iowa', 'kansas', 'kentucky', 'louisiana', 'maine', 'maryland',
  'massachusetts', 'michigan', 'minnesota', 'mississippi', 'missouri', 'montana',
  'nebraska', 'nevada', 'new hampshire', 'new jersey', 'new mexico', 'new york',
  'north carolina', 'north dakota', 'ohio', 'oklahoma', 'oregon', 'pennsylvania',
  'rhode island', 'south carolina', 'south dakota', 'tennessee', 'texas', 'utah',
  'vermont', 'virginia', 'washington', 'west virginia', 'wisconsin', 'wyoming',
  'district of columbia',
];
const US_STATE_ABBR = [
  'al', 'ak', 'az', 'ar', 'ca', 'co', 'ct', 'de', 'fl', 'ga', 'hi', 'id', 'il',
  'in', 'ia', 'ks', 'ky', 'la', 'me', 'md', 'ma', 'mi', 'mn', 'ms', 'mo', 'mt',
  'ne', 'nv', 'nh', 'nj', 'nm', 'ny', 'nc', 'nd', 'oh', 'ok', 'or', 'pa', 'ri',
  'sc', 'sd', 'tn', 'tx', 'ut', 'vt', 'va', 'wa', 'wv', 'wi', 'wy', 'dc',
];
const US_ALIAS = {
  substrings: ['united states', 'usa', 'u.s.a', 'u.s.', ...US_STATE_NAMES],
  abbr: US_STATE_ABBR,
};
const UK_ALIAS = {
  substrings: [
    'united kingdom', 'great britain', 'britain', 'england', 'scotland', 'wales',
    'northern ireland',
  ],
  abbr: ['uk'],
};
// Canada/Australia/India cards print the PROVINCE/STATE (e.g. "Sydney, NSW",
// "Bangalore, Karnataka"), not the country; Ireland/NZ print a city/county. We
// list the distinctive region + major-city names so a country filter matches.
// Ambiguous tokens that collide across countries are intentionally omitted
// (e.g. "punjab" → also Pakistan; "hamilton"/"canterbury" → also CA/UK; the AU
// abbreviations "wa"/"sa"/"nt" → also US/CA), and most are full-word region names
// rather than 2-letter codes to keep false matches rare.
const CANADA_ALIAS = {
  substrings: [
    'canada', 'ontario', 'quebec', 'québec', 'british columbia', 'alberta',
    'manitoba', 'saskatchewan', 'nova scotia', 'new brunswick', 'newfoundland',
    'labrador', 'prince edward island', 'yukon', 'nunavut', 'toronto', 'vancouver',
    'montreal', 'montréal', 'calgary', 'ottawa', 'edmonton', 'winnipeg',
  ],
  abbr: ['on', 'qc', 'bc', 'ab', 'mb', 'sk', 'ns', 'nb', 'nl', 'pe'],
};
const AUSTRALIA_ALIAS = {
  substrings: [
    'australia', 'new south wales', 'victoria', 'queensland', 'western australia',
    'south australia', 'tasmania', 'australian capital territory',
    'northern territory', 'sydney', 'melbourne', 'brisbane', 'perth', 'adelaide',
    'canberra', 'gold coast',
  ],
  abbr: ['nsw', 'qld', 'vic', 'tas', 'act'],
};
const INDIA_ALIAS = {
  substrings: [
    'india', 'karnataka', 'maharashtra', 'kerala', 'tamil nadu', 'uttar pradesh',
    'gujarat', 'delhi', 'new delhi', 'telangana', 'west bengal', 'rajasthan',
    'haryana', 'andhra pradesh', 'madhya pradesh', 'bihar', 'odisha', 'assam',
    'jharkhand', 'chandigarh', 'bangalore', 'bengaluru', 'mumbai', 'hyderabad',
    'chennai', 'pune', 'kolkata', 'noida', 'gurgaon', 'gurugram', 'ahmedabad',
  ],
  abbr: [],
};
const IRELAND_ALIAS = {
  substrings: [
    'ireland', 'republic of ireland', 'dublin', 'cork', 'galway', 'limerick',
    'waterford', 'kilkenny', 'kerry', 'mayo', 'donegal', 'wexford', 'sligo',
    'drogheda',
  ],
  abbr: [],
};
const NEW_ZEALAND_ALIAS = {
  substrings: [
    'new zealand', 'auckland', 'wellington', 'christchurch', 'otago', 'waikato',
    'dunedin', 'tauranga',
  ],
  abbr: [],
};
const LOCATION_ALIASES: Record<string, { substrings: string[]; abbr: string[] }> = {
  'united states': US_ALIAS,
  usa: US_ALIAS,
  us: US_ALIAS,
  'united states of america': US_ALIAS,
  'united kingdom': UK_ALIAS,
  uk: UK_ALIAS,
  'great britain': UK_ALIAS,
  canada: CANADA_ALIAS,
  australia: AUSTRALIA_ALIAS,
  india: INDIA_ALIAS,
  ireland: IRELAND_ALIAS,
  'new zealand': NEW_ZEALAND_ALIAS,
};

/** Expand a requested location into the substring + whole-word tokens to match. */
function expandLocation(name: string): { substrings: string[]; abbr: string[] } {
  const key = name.trim().toLowerCase();
  const ext = LOCATION_ALIASES[key];
  // Always include the requested name itself (covers cities/regions and cards
  // that DO print the country, e.g. "London, England, United Kingdom").
  return {
    substrings: unique([key, ...(ext?.substrings ?? [])]),
    abbr: unique(ext?.abbr ?? []),
  };
}

/**
 * Does a company card's location line satisfy ANY of the requested locations?
 * Returns true when no locations are requested (no filter), false when a filter
 * is requested but the card has no location to test.
 */
function locationMatches(cardLocation: string | undefined, wanted: string[]): boolean {
  if (!wanted.length) return true;
  if (!cardLocation) return false;
  const hay = cardLocation.toLowerCase();
  const words = new Set(hay.split(/[^a-z0-9]+/).filter(Boolean));
  return wanted.some((w) => {
    const { substrings, abbr } = expandLocation(w);
    return (
      substrings.some((s) => hay.includes(s)) || abbr.some((a) => words.has(a))
    );
  });
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

  /**
   * Resolve free-text location values to the numeric LinkedIn geoUrn ids that the
   * people-search route accepts as a real geo facet, using the static KNOWN_GEO
   * table. (LinkedIn's runtime typeahead endpoint that resolved arbitrary names
   * moved to a deploy-versioned GraphQL route and 404s the old REST path, so we
   * resolve the common cases directly and keyword-fold the rest.) Returns the ids
   * that resolved plus the inputs that didn't, so the caller folds the remainder
   * into the keyword query. `type` is currently GEO-only; COMPANY has no stable
   * resolver, so company names always fall through to keyword-fold.
   */
  private resolveUrns(
    type: 'GEO' | 'COMPANY',
    names: string[],
  ): { resolved: string[]; unresolved: string[] } {
    const resolved: string[] = [];
    const unresolved: string[] = [];
    for (const name of names) {
      const known = type === 'GEO' ? KNOWN_GEO[name.trim().toLowerCase()] : undefined;
      if (known) {
        resolved.push(known);
        if (process.env.URN_DEBUG) console.error(`[urn] GEO "${name}" -> ${known} (static)`);
      } else {
        unresolved.push(name);
        if (process.env.URN_DEBUG) console.error(`[urn] ${type} "${name}" -> unresolved (keyword-fold)`);
      }
    }
    return { resolved: unique(resolved), unresolved };
  }

  // -------------------------------------------------------------------------
  // People
  // -------------------------------------------------------------------------

  async searchPeople(query: string, filters?: PeopleFilters): Promise<SearchResult[]> {
    const params = new URLSearchParams();
    params.set('origin', 'GLOBAL_SEARCH_HEADER');

    const locations = toList(filters?.locations, filters?.location);
    const currentCompanies = toList(filters?.currentCompanies, filters?.company);
    const pastCompanies = toList(filters?.pastCompanies);
    const industries = toList(filters?.industries, filters?.industry);

    // Resolve free-text location/company values to LinkedIn URNs via the
    // authenticated typeahead API so they apply as REAL facets (geoUrn,
    // currentCompany, pastCompany) — not a leaky keyword match on the headline.
    // Anything that fails to resolve falls back to the keyword query below, so
    // this can only improve precision, never regress to an empty result set.
    const geo = this.resolveUrns('GEO', locations);
    const cur = this.resolveUrns('COMPANY', currentCompanies);
    const past = this.resolveUrns('COMPANY', pastCompanies);
    if (geo.resolved.length) params.set('geoUrn', JSON.stringify(geo.resolved));
    if (cur.resolved.length) params.set('currentCompany', JSON.stringify(cur.resolved));
    if (past.resolved.length) params.set('pastCompany', JSON.stringify(past.resolved));

    // Fold the query plus any UNRESOLVED facet values (and industries, which has
    // no reliable people-search facet) into keywords.
    const keywords = unique([
      query,
      ...geo.unresolved,
      ...cur.unresolved,
      ...past.unresolved,
      ...industries,
    ]);
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
    // NOTE: LinkedIn's company-search route ignores URL geo facets (both geoUrn
    // and companyHqGeo were verified no-ops), so locations are enforced by
    // post-filtering each result card's `location` line (see locationMatches) —
    // never as a hard URL param. Industries DO fold into the keyword query
    // (company descriptions carry industry words). Company size IS a real facet.
    const locations = toList(filters?.locations, filters?.location);
    const industries = toList(filters?.industries, filters?.industry);

    // Company-size facet: LinkedIn keys the `companySize` facet by coded letters,
    // not the human-readable band strings, so map them. Unknown bands are dropped.
    const SIZE_CODES: Record<string, string> = {
      '1-10': 'B',
      '11-50': 'C',
      '51-200': 'D',
      '201-500': 'E',
      '501-1000': 'F',
      '1001-5000': 'G',
      '5001-10000': 'H',
      '10001+': 'I',
    };
    const sizes = unique(toList(filters?.companySize))
      .map((s) => SIZE_CODES[s])
      .filter(Boolean);

    // Build a companies-results URL for a given keyword set (query + industries +
    // any extra terms). Multi-value companySize MUST be a JSON-array list (e.g.
    // ["D","E"]) — a comma-joined string returns zero results for >1 size.
    const buildUrl = (extraKeywords: string[]): string => {
      const params = new URLSearchParams();
      params.set('origin', 'GLOBAL_SEARCH_HEADER');
      params.set('keywords', unique([query, ...industries, ...extraKeywords]).join(' '));
      if (sizes.length) params.set('companySize', JSON.stringify(sizes));
      return `${LINKEDIN_BASE}/search/results/companies/?${params.toString()}`;
    };

    const runSearch = async (url: string): Promise<CompanyResult[]> => {
      await navigate(this.page, url);
      assertAuthenticated(this.page);
      await rateLimitDelay();
      // Pull a larger pool when a location filter is active, since post-filtering
      // discards non-matching cards; otherwise the usual page of 25.
      const cards = await this.collectByHref('/company/', locations.length ? 50 : 25);
      const out: CompanyResult[] = [];
      for (const { href, lines } of cards) {
        const r = this.parseCompany(href, lines);
        if (r) out.push(r);
      }
      return out;
    };

    // Pass A: query-only (+industries). The unfiltered page lets a COUNTRY filter
    // work via region/abbr expansion against the card location, without the
    // country name polluting the keyword query (folding "United States" matched
    // almost no company names and zeroed the page).
    const results = await runSearch(buildUrl([]));

    // Pass B: when a location filter is active, also fold the location names into
    // the keyword query and merge. A CITY/region name often appears in a company's
    // name/tagline, so this surfaces local matches the (frequently single-country)
    // unfiltered page omits. Both passes are post-filtered below, so Pass B can
    // only add matches, never loosen the filter.
    if (locations.length) {
      const more = await runSearch(buildUrl(locations));
      const seen = new Set(results.map((c) => c.companyUrl));
      for (const c of more) {
        if (c.companyUrl && !seen.has(c.companyUrl)) {
          seen.add(c.companyUrl);
          results.push(c);
        }
      }
    }

    const matched = results.filter((c) => locationMatches(c.location, locations));
    return matched.slice(0, 25);
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
