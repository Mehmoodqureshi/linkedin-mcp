/**
 * Shared TypeScript interfaces for the LinkedIn driver layer.
 *
 * These types describe the *normalized* shapes returned by the action modules
 * (profile / search / messaging / connection / feed). They are deliberately
 * decoupled from LinkedIn's DOM: scrapers map raw page content into these
 * structures so the rest of the app (IPC, MCP tools, renderer) depends only on
 * stable contracts.
 */

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------

/** A single role within a person's experience history. */
export interface Experience {
  /** Company / organization name. */
  company: string;
  /** Job title held at the company. */
  title: string;
  /** Human-readable tenure, e.g. "Jan 2020 - Present · 4 yrs". */
  duration: string;
  /** Free-text role description / responsibilities (may be empty). */
  description: string;
}

/** A single education entry. */
export interface Education {
  /** Institution name. */
  school: string;
  /** Degree obtained, e.g. "Bachelor of Science". */
  degree: string;
  /** Field of study, e.g. "Computer Science". */
  field: string;
  /** Human-readable attendance range, e.g. "2016 - 2020". */
  years: string;
}

/** A fully scraped LinkedIn profile. */
export interface ProfileData {
  /** Display name. */
  name: string;
  /** Headline / tagline shown under the name. */
  headline: string;
  /** "About" section body text. */
  about: string;
  /** Stated location, e.g. "San Francisco Bay Area". */
  location: string;
  /** Connection count label, e.g. "500+ connections". */
  connections: string;
  /** Experience history, most recent first. */
  experience: Experience[];
  /** Education history. */
  education: Education[];
  /** Listed skills. */
  skills: string[];
}

// ---------------------------------------------------------------------------
// Search results
// ---------------------------------------------------------------------------

/** A people-search result row. */
export interface SearchResult {
  /** Person's display name. */
  name: string;
  /** Headline / current title. */
  headline: string;
  /** Absolute URL to the person's profile. */
  profileUrl: string;
  /** Connection degree label, e.g. "1st", "2nd", "3rd". */
  connectionDegree: string;
  /** Stated location. */
  location: string;
}

/** A job-search result row. */
export interface JobResult {
  /** Job title. */
  title: string;
  /** Hiring company name. */
  company: string;
  /** Job location. */
  location: string;
  /** Absolute URL to the job posting. */
  url: string;
  /** Human-readable posted date, e.g. "2 days ago". */
  postedDate: string;
  /** Salary range, when LinkedIn surfaces one. */
  salary?: string;
}

/** A company-search result row. */
export interface CompanyResult {
  /** Company name. */
  name: string;
  /** Primary industry. */
  industry: string;
  /** Employee-count band, e.g. "1,001-5,000 employees". */
  size: string;
  /** Absolute URL to the company page. */
  url: string;
}

// ---------------------------------------------------------------------------
// Feed
// ---------------------------------------------------------------------------

/** A single post scraped from the home feed. */
export interface FeedPost {
  /** Author display name. */
  author: string;
  /** Absolute URL to the author's profile. */
  authorUrl: string;
  /** Post body text. */
  content: string;
  /** Human-readable relative timestamp, e.g. "3h". */
  timestamp: string;
  /** Reaction / like count. */
  likes: number;
  /** Comment count. */
  comments: number;
  /** Absolute URL to the post (permalink). */
  postUrl: string;
}

// ---------------------------------------------------------------------------
// Driver status
// ---------------------------------------------------------------------------

/** Lifecycle state of the driver/browser. */
export type DriverState = 'idle' | 'launching' | 'ready' | 'error' | 'closed';

/** Snapshot of the driver's current health, returned by `getStatus()`. */
export interface DriverStatus {
  /** Lifecycle state of the driver/browser. */
  status: DriverState;
  /** Whether a LinkedIn session is currently authenticated. */
  isLoggedIn: boolean;
  /** Whether the persisted session cookies are still valid. */
  sessionValid: boolean;
}
