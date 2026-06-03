/**
 * targets.ts — loader + validator for test-targets.json.
 *
 * test-targets.json lives at the PROJECT ROOT (gitignored) and is the single
 * source of every account/URL/query the harness is allowed to touch. Mutating
 * actions may ONLY use the dedicated mutation keys here, never synthesized or
 * search-derived targets, so a human pre-approves every account a mutation
 * could affect.
 *
 * loadTargets() reads + parses the file. If it is missing it prints a clear
 * pointer to test-targets.example.json and exit(1)s — it does not throw, so the
 * harness fails fast with a friendly message instead of a stack trace.
 *
 * Validation is intentionally LENIENT: loadTargets does not reject a file just
 * because some optional/unused suite has empty targets. Per-suite requirements
 * are enforced lazily by requireTarget(), so e.g. running --only profile never
 * complains about a missing messageTarget.
 */

import * as fs from 'fs';
import * as path from 'path';

import type { ReactionType } from '../../src/driver/actions/feed';

/** The reaction verbs feed.reactToPost accepts, used to validate reactTarget. */
const REACTION_TYPES: readonly ReactionType[] = [
  'like',
  'celebrate',
  'support',
  'love',
  'insightful',
  'funny',
];

export interface MessageTarget {
  /** Profile URL of a safe 1st-degree / open-profile test account you control. */
  profileUrl: string;
  /** Exact message text to send. */
  body: string;
}

export interface ConnectionTarget {
  /** Profile URL to send a connection request to. */
  profileUrl: string;
  /** Optional invite note (<= 300 chars). */
  note?: string;
}

export interface WithdrawTarget {
  /** Pending-outbound invite target, by profileId... */
  profileId?: string;
  /** ...or by profileUrl. */
  profileUrl?: string;
}

export interface ReactTarget {
  /** Post permalink to react to. */
  postUrl: string;
  /** Which reaction to apply; defaults to 'like' when omitted. */
  reaction?: ReactionType;
}

export interface CommentTarget {
  /** Post permalink to comment on. */
  postUrl: string;
  /** Exact comment body to post. */
  text: string;
}

export interface Targets {
  /** Full https://www.linkedin.com/in/<slug>/ URLs for profile.getProfile (read-only). */
  profileUrls: string[];
  /** Bare vanity slugs (e.g. 'satyanadella') for profile.getProfileByUsername (read-only). */
  profileUsernames: string[];
  /** Query for search.searchPeople (read-only). */
  peopleQuery: string;
  /** Query for search.searchJobs (read-only). */
  jobsQuery: string;
  /** Query for search.searchCompanies (read-only). */
  companiesQuery: string;
  /** Existing conversation id for messages.getMessages (read-only); empty -> step skips. */
  conversationId?: string;
  /** MUTATING sendMessage target + exact body. */
  messageTarget?: MessageTarget;
  /** MUTATING sendConnectionRequest target + optional note. */
  connectionTarget?: ConnectionTarget;
  /** MUTATING acceptConnectionRequest target (a pending inbound invite you arranged). */
  acceptRequestProfileId?: string;
  /** MUTATING withdrawConnectionRequest target. */
  withdrawTarget?: WithdrawTarget;
  /** MUTATING feed.likePost permalink (a safe post, ideally your own). */
  likePostUrl: string;
  /** MUTATING feed.reactToPost target — permalink + optional reaction. */
  reactTarget?: ReactTarget;
  /** MUTATING feed.commentOnPost target — permalink + comment body. */
  commentTarget?: CommentTarget;
  /** Extra guard: auth.logout only runs when this AND --include-mutating are set. */
  allowLogout?: boolean;
}

const TARGETS_FILENAME = 'test-targets.json';
const EXAMPLE_FILENAME = 'test/hitl/test-targets.example.json';

/** Resolve the project root from this file's location (test/hitl -> ../../). */
function projectRoot(): string {
  return path.resolve(__dirname, '..', '..');
}

/**
 * Read + parse test-targets.json from the project root. On any failure
 * (missing file, bad JSON) print a friendly message and exit(1).
 */
export function loadTargets(): Targets {
  const root = projectRoot();
  const targetsPath = path.join(root, TARGETS_FILENAME);

  if (!fs.existsSync(targetsPath)) {
    process.stderr.write(
      `\n[hitl] Missing ${TARGETS_FILENAME} at the project root:\n` +
        `       ${targetsPath}\n\n` +
        `       Copy the template and fill in your targets:\n` +
        `         cp ${EXAMPLE_FILENAME} ${TARGETS_FILENAME}\n\n` +
        `       Then edit ${TARGETS_FILENAME} (it is gitignored — never commit real targets).\n`,
    );
    process.exit(1);
  }

  let raw: string;
  try {
    raw = fs.readFileSync(targetsPath, 'utf8');
  } catch (err) {
    process.stderr.write(
      `\n[hitl] Could not read ${targetsPath}: ${(err as Error).message}\n`,
    );
    process.exit(1);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    process.stderr.write(
      `\n[hitl] ${TARGETS_FILENAME} is not valid JSON: ${(err as Error).message}\n` +
        `       Compare against ${EXAMPLE_FILENAME}.\n`,
    );
    process.exit(1);
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    process.stderr.write(
      `\n[hitl] ${TARGETS_FILENAME} must be a JSON object. See ${EXAMPLE_FILENAME}.\n`,
    );
    process.exit(1);
  }

  return normalize(parsed as Record<string, unknown>);
}

/**
 * Coerce a parsed object into a Targets with safe defaults, so downstream
 * code can rely on array/string shapes without re-checking. Lenient: missing
 * keys become empty — requireTarget() handles per-suite enforcement.
 */
function normalize(obj: Record<string, unknown>): Targets {
  const targets: Targets = {
    profileUrls: asStringArray(obj.profileUrls),
    profileUsernames: asStringArray(obj.profileUsernames),
    peopleQuery: asString(obj.peopleQuery),
    jobsQuery: asString(obj.jobsQuery),
    companiesQuery: asString(obj.companiesQuery),
    likePostUrl: asString(obj.likePostUrl),
  };

  const conversationId = asOptionalString(obj.conversationId);
  if (conversationId !== undefined) targets.conversationId = conversationId;

  const messageTarget = asMessageTarget(obj.messageTarget);
  if (messageTarget !== undefined) targets.messageTarget = messageTarget;

  const connectionTarget = asConnectionTarget(obj.connectionTarget);
  if (connectionTarget !== undefined) targets.connectionTarget = connectionTarget;

  const acceptRequestProfileId = asOptionalString(obj.acceptRequestProfileId);
  if (acceptRequestProfileId !== undefined)
    targets.acceptRequestProfileId = acceptRequestProfileId;

  const withdrawTarget = asWithdrawTarget(obj.withdrawTarget);
  if (withdrawTarget !== undefined) targets.withdrawTarget = withdrawTarget;

  const reactTarget = asReactTarget(obj.reactTarget);
  if (reactTarget !== undefined) targets.reactTarget = reactTarget;

  const commentTarget = asCommentTarget(obj.commentTarget);
  if (commentTarget !== undefined) targets.commentTarget = commentTarget;

  if (typeof obj.allowLogout === 'boolean') targets.allowLogout = obj.allowLogout;

  return targets;
}

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0);
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function asOptionalString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function asMessageTarget(v: unknown): MessageTarget | undefined {
  if (typeof v !== 'object' || v === null) return undefined;
  const o = v as Record<string, unknown>;
  const profileUrl = asString(o.profileUrl);
  const body = asString(o.body);
  if (profileUrl.length === 0 && body.length === 0) return undefined;
  return { profileUrl, body };
}

function asConnectionTarget(v: unknown): ConnectionTarget | undefined {
  if (typeof v !== 'object' || v === null) return undefined;
  const o = v as Record<string, unknown>;
  const profileUrl = asString(o.profileUrl);
  if (profileUrl.length === 0 && typeof o.note !== 'string') return undefined;
  const target: ConnectionTarget = { profileUrl };
  const note = asOptionalString(o.note);
  if (note !== undefined) target.note = note;
  return target;
}

function asWithdrawTarget(v: unknown): WithdrawTarget | undefined {
  if (typeof v !== 'object' || v === null) return undefined;
  const o = v as Record<string, unknown>;
  const profileId = asOptionalString(o.profileId);
  const profileUrl = asOptionalString(o.profileUrl);
  if (profileId === undefined && profileUrl === undefined) return undefined;
  const target: WithdrawTarget = {};
  if (profileId !== undefined) target.profileId = profileId;
  if (profileUrl !== undefined) target.profileUrl = profileUrl;
  return target;
}

function asReactTarget(v: unknown): ReactTarget | undefined {
  if (typeof v !== 'object' || v === null) return undefined;
  const o = v as Record<string, unknown>;
  const postUrl = asString(o.postUrl);
  if (postUrl.length === 0) return undefined;
  const target: ReactTarget = { postUrl };
  // Accept a reaction only when it's one of the known verbs; an unknown or
  // absent value leaves it undefined so the scenario defaults to 'like'.
  if (
    typeof o.reaction === 'string' &&
    (REACTION_TYPES as readonly string[]).includes(o.reaction)
  ) {
    target.reaction = o.reaction as ReactionType;
  }
  return target;
}

function asCommentTarget(v: unknown): CommentTarget | undefined {
  if (typeof v !== 'object' || v === null) return undefined;
  const o = v as Record<string, unknown>;
  const postUrl = asString(o.postUrl);
  const text = asString(o.text);
  if (postUrl.length === 0 && text.length === 0) return undefined;
  return { postUrl, text };
}

/**
 * Assert that a given target key is usefully populated for a suite about to
 * run. Throws a clear, actionable error if not. Used by scenarios/index.ts
 * just before a suite executes (lazy, per-suite enforcement).
 *
 * "Populated" means: non-empty string, non-empty array, or an object whose
 * primary field (profileUrl / profileId) is set.
 */
export function requireTarget(
  targets: Targets,
  key: keyof Targets,
  suiteName: string,
): void {
  if (!isPopulated(targets[key])) {
    throw new Error(
      `[hitl] set "${key}" in ${TARGETS_FILENAME} to run the ${suiteName} suite ` +
        `(see ${EXAMPLE_FILENAME} for the expected shape).`,
    );
  }
}

function isPopulated(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'object') {
    const o = value as Record<string, unknown>;
    const primary = o.profileUrl ?? o.profileId ?? o.body;
    return typeof primary === 'string' && primary.trim().length > 0;
  }
  return false;
}
