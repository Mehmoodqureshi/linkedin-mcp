/**
 * src/mcp/mutation-gate.ts — deny-by-default gate for account-modifying tools.
 *
 * LinkedIn write actions (message, connect, comment, react, accept/withdraw
 * invitation, update own profile) can act on the user's real account, so a
 * malicious or hijacked MCP prompt must NOT be able to trigger them freely.
 * These actions are disabled unless the operator opts in via the
 * `LINKEDIN_ALLOW_MUTATIONS` allowlist.
 *
 * Kept dependency-free (no driver/Electron imports) so it is trivially unit-testable.
 */

/** Tools that take an ACTION on the user's LinkedIn account (not just reads). */
export const MUTATING_TOOLS: ReadonlySet<string> = new Set<string>([
  'linkedin_send_message',
  'linkedin_send_connection',
  'linkedin_accept_invitation',
  'linkedin_withdraw_invitation',
  'linkedin_react',
  'linkedin_comment',
  'linkedin_update_profile',
]);

export function isMutatingTool(name: string): boolean {
  return MUTATING_TOOLS.has(name);
}

/**
 * Whether a mutating tool is permitted by the `LINKEDIN_ALLOW_MUTATIONS`
 * allowlist. DENY-BY-DEFAULT: with the env unset/empty, no write action runs.
 * Accepts a comma-separated list of tool names (with or without the `linkedin_`
 * prefix); `all` or `*` enables every write action.
 */
export function mutationAllowed(name: string, allowEnv: string | undefined): boolean {
  const raw = (allowEnv ?? '').trim();
  if (!raw) return false;
  const entries = raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (entries.includes('all') || entries.includes('*')) return true;
  const short = name.replace(/^linkedin_/, '').toLowerCase();
  return entries.some((e) => e.replace(/^linkedin_/, '') === short);
}
