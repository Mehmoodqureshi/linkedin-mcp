/**
 * MCP tool definitions and handlers for the LinkedIn driver.
 *
 * This module is the single place where the Model Context Protocol surface is
 * declared. It owns two responsibilities:
 *
 *   1. The *catalog*: a JSON-Schema description of every tool (name, human
 *      description, and `inputSchema`) advertised to the MCP client. This is
 *      what Claude Desktop reads to know what it may call and with what shape.
 *
 *   2. The *dispatch*: a `name -> handler` map. Each handler validates its
 *      arguments against the declared schema, fetches the process-wide
 *      `LinkedInDriver` singleton, makes sure the browser is launched and the
 *      driver is `ready`, invokes the relevant action module, and serializes
 *      the result back into the MCP `content` envelope.
 *
 * `registerTools(server)` wires the catalog + dispatch onto a `Server` by
 * installing the `ListTools` and `CallTool` request handlers.
 *
 * Design notes:
 *   - We deliberately keep validation lightweight and dependency-free (plain
 *     runtime guards expressed against the JSON Schema) rather than pulling a
 *     parser into the hot path. The schema *is* the contract; the guards only
 *     defend the handler from malformed input.
 *   - Every handler routes through `withReadyDriver`, which lazily launches the
 *     browser. The first tool call therefore pays the Chromium start-up cost;
 *     subsequent calls reuse the live context.
 *   - Handlers never throw raw — `server.ts` wraps them — but they DO throw
 *     `McpToolError` with a clear message when input is invalid or the driver
 *     cannot reach `ready`, so the client gets an actionable `isError` result.
 */

import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from '@modelcontextprotocol/sdk/types.js';

import { getInstance, type LinkedInDriver } from '../driver/linkedin';
import type { ReactionType } from '../driver/actions';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Thrown by a tool handler when the request cannot be fulfilled for a reason
 * the caller can act on (bad arguments, driver not ready, etc.). `server.ts`
 * catches it and renders a structured MCP error result.
 */
export class McpToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'McpToolError';
  }
}

// ---------------------------------------------------------------------------
// Tool catalog (JSON-Schema input descriptions)
// ---------------------------------------------------------------------------

/** A single advertised MCP tool. */
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/**
 * The full set of tools this server exposes. Mirrors the dispatch table below;
 * keep the two in sync (a name present here MUST have a handler, and vice
 * versa — `registerTools` asserts this at startup).
 */
export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: 'linkedin_login',
    description:
      'Start the manual login flow. Opens the Playwright-controlled Chromium ' +
      'window (headed) on the LinkedIn login page, optionally pre-filling the ' +
      'given email/password, so the user can authenticate manually including ' +
      '2FA/captcha. Waits until the session is established or times out, then ' +
      'persists the session.',
    inputSchema: {
      type: 'object',
      properties: {
        email: {
          type: 'string',
          description:
            'LinkedIn account email to pre-fill on the login form. Optional; ' +
            'if omitted the user types it manually in the opened window.',
        },
        password: {
          type: 'string',
          description:
            'LinkedIn account password to pre-fill. Optional and never stored; ' +
            'if omitted the user types it manually in the opened window.',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'linkedin_logout',
    description:
      'Clear the stored LinkedIn session: deletes the saved storageState and ' +
      'clears the persistent browser profile cookies so the next action ' +
      'requires a fresh manual login.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'linkedin_status',
    description:
      'Return the current driver/session status: lifecycle state, whether a ' +
      'LinkedIn session is authenticated, and whether the persisted session ' +
      'cookies are still valid. Useful for deciding whether a login is needed.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'linkedin_get_profile',
    description:
      'Open and scrape a LinkedIn member profile. Returns normalized profile ' +
      'data: name, headline, location, about, experience, education, skills, ' +
      'and connection count.',
    inputSchema: {
      type: 'object',
      properties: {
        profileUrl: {
          type: 'string',
          description:
            'Full profile URL (e.g. https://www.linkedin.com/in/john-doe/) ' +
            'or an /in/ slug (e.g. john-doe).',
        },
      },
      required: ['profileUrl'],
      additionalProperties: false,
    },
  },
  {
    name: 'linkedin_search_people',
    description:
      'Run a People search and return normalized result cards (name, ' +
      'headline, location, profile URL, connection degree). Supports a free- ' +
      'text query plus common filters.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: "Free-text keywords, e.g. 'head of engineering fintech'.",
        },
        filters: {
          type: 'object',
          description: 'Optional People-search filters.',
          properties: {
            locations: { type: 'array', items: { type: 'string' } },
            currentCompanies: { type: 'array', items: { type: 'string' } },
            pastCompanies: { type: 'array', items: { type: 'string' } },
            industries: { type: 'array', items: { type: 'string' } },
            connectionDegree: {
              type: 'array',
              items: { type: 'string', enum: ['1st', '2nd', '3rd'] },
            },
            title: { type: 'string' },
            school: { type: 'string' },
          },
          additionalProperties: false,
        },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'linkedin_search_jobs',
    description:
      'Run a Jobs search and return normalized job postings (title, company, ' +
      'location, posted date, workplace type, salary if shown, job URL).',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: "Job title or keywords, e.g. 'senior typescript engineer'.",
        },
        filters: {
          type: 'object',
          description: 'Optional Jobs-search filters.',
          properties: {
            location: { type: 'string' },
            workplaceType: {
              type: 'array',
              items: { type: 'string', enum: ['on-site', 'remote', 'hybrid'] },
            },
            experienceLevel: {
              type: 'array',
              items: {
                type: 'string',
                enum: [
                  'internship',
                  'entry',
                  'associate',
                  'mid-senior',
                  'director',
                  'executive',
                ],
              },
            },
            jobType: {
              type: 'array',
              items: {
                type: 'string',
                enum: [
                  'full-time',
                  'part-time',
                  'contract',
                  'temporary',
                  'internship',
                  'volunteer',
                  'other',
                ],
              },
            },
            salary: {
              type: 'string',
              description:
                "Minimum salary, e.g. '40k', '100k', or '120000'. Maps to the " +
                'closest LinkedIn salary band.',
            },
            datePosted: {
              type: 'string',
              enum: ['any', 'past-month', 'past-week', 'past-24h'],
            },
            easyApplyOnly: { type: 'boolean' },
          },
          additionalProperties: false,
        },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'linkedin_search_companies',
    description:
      'Run a Company search and return normalized company cards (name, ' +
      'industry, size, company URL).',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Company name or keywords.' },
        filters: {
          type: 'object',
          description: 'Optional Company-search filters.',
          properties: {
            locations: { type: 'array', items: { type: 'string' } },
            industries: { type: 'array', items: { type: 'string' } },
            companySize: {
              type: 'array',
              items: {
                type: 'string',
                enum: [
                  '1-10',
                  '11-50',
                  '51-200',
                  '201-500',
                  '501-1000',
                  '1001-5000',
                  '5001-10000',
                  '10001+',
                ],
              },
            },
          },
          additionalProperties: false,
        },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'linkedin_send_message',
    description:
      'Send a direct message to an existing 1st-degree connection (or an ' +
      'open-profile / InMail-eligible member). Returns delivery status; fails ' +
      'with a clear error if messaging is not permitted for that member.',
    inputSchema: {
      type: 'object',
      properties: {
        profileUrl: {
          type: 'string',
          description: 'Recipient profile URL or /in/ slug.',
        },
        message: {
          type: 'string',
          description: 'Message body text.',
          minLength: 1,
          maxLength: 8000,
        },
      },
      required: ['profileUrl', 'message'],
      additionalProperties: false,
    },
  },
  {
    name: 'linkedin_send_connection',
    description:
      'Send a connection request to a member, optionally with a personalized ' +
      'note. Subject to rate limits; returns the outcome (sent, ' +
      'already-connected, pending, or unavailable).',
    inputSchema: {
      type: 'object',
      properties: {
        profileUrl: {
          type: 'string',
          description: 'Target profile URL or /in/ slug.',
        },
        note: {
          type: 'string',
          description:
            'Optional personalized note (LinkedIn caps this around 300 ' +
            'characters).',
          maxLength: 300,
        },
      },
      required: ['profileUrl'],
      additionalProperties: false,
    },
  },
  {
    name: 'linkedin_get_invitations',
    description:
      'List pending RECEIVED connection invitations from the invitation ' +
      'manager. Returns each inviter’s name, headline, profile URL, and ' +
      'profileId (vanity slug). The slug feeds linkedin_accept_invitation.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'linkedin_accept_invitation',
    description:
      'Accept a pending RECEIVED connection invitation, identified by the ' +
      'inviter’s profileId (vanity slug, as returned by ' +
      'linkedin_get_invitations) or their full profile URL. Fails with a clear ' +
      'error if no matching pending invitation is found.',
    inputSchema: {
      type: 'object',
      properties: {
        profileId: {
          type: 'string',
          description:
            'Inviter vanity slug (e.g. "john-doe") or full /in/ profile URL.',
        },
      },
      required: ['profileId'],
      additionalProperties: false,
    },
  },
  {
    name: 'linkedin_withdraw_invitation',
    description:
      'Withdraw a pending SENT connection invitation, identified by the ' +
      'recipient’s profileId (vanity slug) or their full profile URL. Fails ' +
      'with a clear error if no matching sent invitation is found.',
    inputSchema: {
      type: 'object',
      properties: {
        profileId: {
          type: 'string',
          description:
            'Recipient vanity slug (e.g. "john-doe") or full /in/ profile URL.',
        },
      },
      required: ['profileId'],
      additionalProperties: false,
    },
  },
  {
    name: 'linkedin_react',
    description:
      'React to a post by its permalink URL with one of LinkedIn’s six ' +
      'reactions (like, celebrate, support, love, insightful, funny). Defaults ' +
      'to "like". Subject to rate limits; no-ops cleanly if the post already ' +
      'carries your reaction, and reports "unavailable" if no reaction control ' +
      'is present.',
    inputSchema: {
      type: 'object',
      properties: {
        postUrl: {
          type: 'string',
          description:
            'Post permalink, e.g. ' +
            'https://www.linkedin.com/feed/update/urn:li:activity:1234567890/ ' +
            '(as returned in a feed post’s postUrl).',
        },
        reaction: {
          type: 'string',
          description: 'Which reaction to apply. Defaults to "like".',
          enum: ['like', 'celebrate', 'support', 'love', 'insightful', 'funny'],
          default: 'like',
        },
      },
      required: ['postUrl'],
      additionalProperties: false,
    },
  },
  {
    name: 'linkedin_comment',
    description:
      'Post a comment on a post by its permalink URL. Returns delivery status; ' +
      'fails with a clear error if the post is not commentable or the comment ' +
      'composer cannot be opened.',
    inputSchema: {
      type: 'object',
      properties: {
        postUrl: {
          type: 'string',
          description:
            'Post permalink, e.g. ' +
            'https://www.linkedin.com/feed/update/urn:li:activity:1234567890/ ' +
            '(as returned in a feed post’s postUrl).',
        },
        text: {
          type: 'string',
          description: 'Comment body text.',
          minLength: 1,
          maxLength: 1250,
        },
      },
      required: ['postUrl', 'text'],
      additionalProperties: false,
    },
  },
  {
    name: 'linkedin_get_member_posts',
    description:
      'List a member’s recent posts (newest first) with their canonical ' +
      'permalink URLs and a short text preview, by reading their recent-activity ' +
      'page. Use this to locate a specific person’s post (e.g. to react or ' +
      'comment) without waiting for it to appear in the volatile home feed.',
    inputSchema: {
      type: 'object',
      properties: {
        profileUrl: {
          type: 'string',
          description: 'Target member profile URL or /in/ slug.',
        },
        limit: {
          type: 'integer',
          description: 'Number of recent posts to collect.',
          minimum: 1,
          maximum: 20,
          default: 5,
        },
      },
      required: ['profileUrl'],
      additionalProperties: false,
    },
  },
  {
    name: 'linkedin_get_feed',
    description:
      'Read the home feed and return normalized posts (author, author URL, ' +
      'text, posted time, like/comment counts, post URL). Scrolls to gather ' +
      'the requested count.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: {
          type: 'integer',
          description: 'Number of posts to collect.',
          minimum: 1,
          maximum: 50,
          default: 10,
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'linkedin_get_notifications',
    description:
      'Read the notifications panel and return normalized notification items ' +
      '(type, actor, text, timestamp, target URL, read/unread state).',
    inputSchema: {
      type: 'object',
      properties: {
        limit: {
          type: 'integer',
          description: 'Number of notifications to collect.',
          minimum: 1,
          maximum: 50,
          default: 20,
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'linkedin_get_conversations',
    description:
      'List the message threads in the LinkedIn inbox as normalized ' +
      'conversation summaries (participant, snippet, conversation id, ' +
      'timestamp, unread state).',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
];

// ---------------------------------------------------------------------------
// Argument validation helpers
// ---------------------------------------------------------------------------

type Args = Record<string, unknown>;

/** Coerce the SDK-provided arguments bag into a plain object. */
function asArgs(raw: unknown): Args {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new McpToolError('Tool arguments must be a JSON object.');
  }
  return raw as Args;
}

/** Require a non-empty string argument. */
function requireString(args: Args, key: string): string {
  const v = args[key];
  if (typeof v !== 'string' || v.trim() === '') {
    throw new McpToolError(`Missing or invalid required string argument: "${key}".`);
  }
  return v;
}

/** Read an optional string argument (undefined if absent). */
function optionalString(args: Args, key: string): string | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') {
    throw new McpToolError(`Argument "${key}" must be a string when provided.`);
  }
  return v;
}

/** Read an optional, bounded integer argument (undefined if absent). */
function optionalInt(
  args: Args,
  key: string,
  min: number,
  max: number,
): number | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'number' || !Number.isFinite(v) || !Number.isInteger(v)) {
    throw new McpToolError(`Argument "${key}" must be an integer when provided.`);
  }
  if (v < min || v > max) {
    throw new McpToolError(`Argument "${key}" must be between ${min} and ${max}.`);
  }
  return v;
}

/** The accepted reaction verbs for `linkedin_react`, in catalog order. */
const REACTION_TYPES = [
  'like',
  'celebrate',
  'support',
  'love',
  'insightful',
  'funny',
] as const satisfies readonly ReactionType[];

/**
 * Read an optional string argument constrained to a fixed set (undefined if
 * absent). Throws when present but not one of the allowed values.
 */
function optionalEnum<T extends string>(
  args: Args,
  key: string,
  allowed: readonly T[],
): T | undefined {
  const v = optionalString(args, key);
  if (v === undefined) return undefined;
  if (!allowed.includes(v as T)) {
    throw new McpToolError(
      `Argument "${key}" must be one of: ${allowed.join(', ')}.`,
    );
  }
  return v as T;
}

/**
 * Normalize a profile reference to its vanity slug. Accepts either a bare slug
 * ("john-doe") or a full /in/ profile URL and returns the slug the connection
 * actions match on, so callers can pass whichever they have to hand. Falls back
 * to the trimmed input when no /in/ segment is present.
 */
function profileSlug(ref: string): string {
  const m = ref.match(/\/in\/([^/?#]+)/);
  return (m?.[1] ?? ref).trim();
}

/** Read an optional object argument (undefined if absent). */
function optionalObject(args: Args, key: string): Args | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'object' || Array.isArray(v)) {
    throw new McpToolError(`Argument "${key}" must be an object when provided.`);
  }
  return v as Args;
}

// ---------------------------------------------------------------------------
// Driver readiness
// ---------------------------------------------------------------------------

/**
 * Fetch the singleton driver, lazily launch the browser if needed, and ensure
 * it reaches the `ready` state before handing it to a tool handler.
 *
 * The login/logout/status tools must run even when not yet authenticated, so
 * readiness here means "browser is up", not "user is logged in".
 */
async function withReadyDriver(): Promise<LinkedInDriver> {
  const driver = getInstance();

  // Lazily bring up Chromium AND self-heal a mid-session disconnect: if the
  // browser died (crash / closed window) or the primary tab was lost, this
  // relaunches and re-wires the action modules to a live page. Idempotent and a
  // no-op once ready with a live page.
  try {
    await driver.ensureOperational();
  } catch (err) {
    throw new McpToolError(
      `Failed to launch the LinkedIn driver: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  if (driver.status !== 'ready') {
    throw new McpToolError(
      `LinkedIn driver is not ready (status: ${driver.status}). ` +
        'Try again, or call linkedin_status to inspect the session.',
    );
  }

  return driver;
}

/**
 * Like `withReadyDriver`, but additionally asserts an authenticated session.
 * Used by every data/action tool that needs a logged-in member. Surfaces a
 * clear "log in first" error rather than letting the scraper fail deep in the
 * DOM.
 */
async function withAuthedDriver(): Promise<LinkedInDriver> {
  const driver = await withReadyDriver();
  await driver.refreshSession();
  const { isLoggedIn } = driver.getStatus();
  if (!isLoggedIn) {
    throw new McpToolError(
      'Not logged in to LinkedIn. Run linkedin_login to start the manual ' +
        'login flow, then retry.',
    );
  }
  return driver;
}

// ---------------------------------------------------------------------------
// Result envelope
// ---------------------------------------------------------------------------

/** The MCP tool result shape (text content carrying serialized JSON). */
export interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
}

/** Wrap an arbitrary serializable value in the standard text-content envelope. */
function jsonResult(value: unknown): ToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
  };
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

type ToolHandler = (args: Args) => Promise<ToolResult>;

/**
 * The dispatch table: tool name -> handler. Each handler validates its inputs,
 * obtains an appropriately-gated driver, calls the action module, and
 * serializes the result.
 */
export const TOOL_HANDLERS: Record<string, ToolHandler> = {
  // --- Auth ---------------------------------------------------------------
  linkedin_login: async (args) => {
    const driver = await withReadyDriver();
    const email = optionalString(args, 'email') ?? '';
    const password = optionalString(args, 'password') ?? '';
    const result = await driver.auth.login(email, password);
    await driver.refreshSession();
    return jsonResult(result);
  },

  linkedin_logout: async () => {
    const driver = await withReadyDriver();
    const result = await driver.auth.logout();
    await driver.refreshSession();
    return jsonResult(result);
  },

  linkedin_status: async () => {
    // Report the AUTHORITATIVE live state, not a stale pre-launch snapshot:
    // lazily launch the browser and re-check the session so a freshly-started
    // server doesn't misreport an authenticated profile as logged-out. If the
    // launch fails (e.g. no display), fall back to the cached snapshot so the
    // tool still answers instead of erroring.
    try {
      const driver = await withReadyDriver();
      await driver.refreshSession();
      return jsonResult(driver.getStatus());
    } catch {
      return jsonResult(getInstance().getStatus());
    }
  },

  // --- Profile ------------------------------------------------------------
  linkedin_get_profile: async (args) => {
    const driver = await withAuthedDriver();
    const profileUrl = requireString(args, 'profileUrl');
    const result = await driver.profile.getProfile(profileUrl);
    return jsonResult(result);
  },

  // --- Search -------------------------------------------------------------
  linkedin_search_people: async (args) => {
    const driver = await withAuthedDriver();
    const query = requireString(args, 'query');
    const filters = optionalObject(args, 'filters');
    const result = await driver.search.searchPeople(query, filters as never);
    return jsonResult(result);
  },

  linkedin_search_jobs: async (args) => {
    const driver = await withAuthedDriver();
    const query = requireString(args, 'query');
    const filters = optionalObject(args, 'filters');
    const result = await driver.search.searchJobs(query, filters as never);
    return jsonResult(result);
  },

  linkedin_search_companies: async (args) => {
    const driver = await withAuthedDriver();
    const query = requireString(args, 'query');
    const filters = optionalObject(args, 'filters');
    const result = await driver.search.searchCompanies(query, filters as never);
    return jsonResult(result);
  },

  // --- Messaging ----------------------------------------------------------
  linkedin_send_message: async (args) => {
    const driver = await withAuthedDriver();
    const profileUrl = requireString(args, 'profileUrl');
    const message = requireString(args, 'message');
    const result = await driver.messages.sendMessage(profileUrl, message);
    return jsonResult(result);
  },

  linkedin_get_conversations: async () => {
    const driver = await withAuthedDriver();
    const result = await driver.messages.getConversations();
    return jsonResult(result);
  },

  // --- Connections --------------------------------------------------------
  linkedin_send_connection: async (args) => {
    const driver = await withAuthedDriver();
    const profileUrl = requireString(args, 'profileUrl');
    const note = optionalString(args, 'note');
    const result = await driver.connections.sendConnectionRequest(profileUrl, note);
    return jsonResult(result);
  },

  linkedin_get_invitations: async () => {
    const driver = await withAuthedDriver();
    const result = await driver.connections.getConnectionRequests();
    return jsonResult(result);
  },

  linkedin_accept_invitation: async (args) => {
    const driver = await withAuthedDriver();
    const profileId = profileSlug(requireString(args, 'profileId'));
    const result = await driver.connections.acceptConnectionRequest(profileId);
    return jsonResult(result);
  },

  linkedin_withdraw_invitation: async (args) => {
    const driver = await withAuthedDriver();
    const profileId = profileSlug(requireString(args, 'profileId'));
    const result = await driver.connections.withdrawConnectionRequest(profileId);
    return jsonResult(result);
  },

  // --- Feed engagement ----------------------------------------------------
  linkedin_react: async (args) => {
    const driver = await withAuthedDriver();
    const postUrl = requireString(args, 'postUrl');
    const reaction = optionalEnum(args, 'reaction', REACTION_TYPES) ?? 'like';
    const result = await driver.feed.reactToPost(postUrl, reaction);
    return jsonResult(result);
  },

  linkedin_comment: async (args) => {
    const driver = await withAuthedDriver();
    const postUrl = requireString(args, 'postUrl');
    const text = requireString(args, 'text');
    const result = await driver.feed.commentOnPost(postUrl, text);
    return jsonResult(result);
  },

  // --- Feed / notifications ----------------------------------------------
  linkedin_get_member_posts: async (args) => {
    const driver = await withAuthedDriver();
    const profileUrl = requireString(args, 'profileUrl');
    const limit = optionalInt(args, 'limit', 1, 20);
    const result = await driver.feed.getMemberPosts(profileUrl, limit);
    return jsonResult(result);
  },

  linkedin_get_feed: async (args) => {
    const driver = await withAuthedDriver();
    const limit = optionalInt(args, 'limit', 1, 50);
    const result = await driver.feed.getFeed(limit);
    return jsonResult(result);
  },

  linkedin_get_notifications: async (args) => {
    const driver = await withAuthedDriver();
    const limit = optionalInt(args, 'limit', 1, 50);
    const result = await driver.feed.getNotifications(limit);
    return jsonResult(result);
  },
};

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/**
 * Wire the tool catalog and dispatch onto an MCP `Server`.
 *
 * Installs:
 *   - a `ListTools` handler returning `TOOL_DEFINITIONS`, and
 *   - a `CallTool` handler that looks up `TOOL_HANDLERS[name]`, validates the
 *     arguments inside the handler, runs it, and returns the result.
 *
 * Errors thrown by a handler propagate to `server.ts`, which converts them into
 * an MCP error result (`isError: true`) so the client sees a clean failure
 * rather than a transport-level crash.
 */
export function registerTools(server: Server): void {
  // Invariant: every advertised tool has a handler and vice versa. Catch
  // drift at startup instead of at call time.
  for (const def of TOOL_DEFINITIONS) {
    if (!TOOL_HANDLERS[def.name]) {
      throw new Error(`Tool "${def.name}" is advertised but has no handler.`);
    }
  }
  for (const name of Object.keys(TOOL_HANDLERS)) {
    if (!TOOL_DEFINITIONS.some((d) => d.name === name)) {
      throw new Error(`Handler "${name}" has no advertised tool definition.`);
    }
  }

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOL_DEFINITIONS,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: rawArgs } = request.params;
    // Our envelope is a structurally valid CallToolResult (text content +
    // optional isError). Cast past the SDK's task-augmented union variant.
    return dispatchToolCall(name, rawArgs) as Promise<CallToolResult>;
  });
}

/**
 * Resolve and run a tool by name. Every error — bad tool name, invalid
 * arguments, driver-not-ready, or a failure deep inside an action module — is
 * caught and converted into a structured MCP error result (`isError: true`)
 * rather than propagating as a thrown exception. This keeps the JSON-RPC
 * transport healthy and gives the client an actionable message.
 *
 * Exported so `server.ts` (and tests) can drive a tool call directly with the
 * same error semantics the registered handler uses.
 */
export async function dispatchToolCall(
  name: string,
  rawArgs: unknown,
): Promise<ToolResult & { isError?: boolean }> {
  try {
    const handler = TOOL_HANDLERS[name];
    if (!handler) {
      throw new McpToolError(`Unknown tool: "${name}".`);
    }
    const args = asArgs(rawArgs);
    return await handler(args);
  } catch (err) {
    const message =
      err instanceof Error ? err.message : `Unexpected error: ${String(err)}`;
    return {
      isError: true,
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            { error: message, tool: name },
            null,
            2,
          ),
        },
      ],
    };
  }
}
