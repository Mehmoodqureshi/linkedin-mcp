/**
 * One-off MCP tool smoke test: drives the real MCP dispatch surface
 * (`dispatchToolCall`) against the configured test profile, exactly as Claude
 * Desktop would. Read tools run freely; the single authorized mutation is the
 * DM to the 1st-degree connection. linkedin_login/linkedin_logout are skipped
 * on purpose (already authed; logout is destructive and not authorized).
 */
import { dispatchToolCall } from '../src/mcp/tools';
import { getInstance } from '../src/driver/linkedin';

// Replace with a profile / account YOU control before running. Mutating calls
// below (connection request, DM) will perform REAL actions against this target.
const PROFILE = process.env.SMOKE_PROFILE ?? 'https://www.linkedin.com/in/your-test-account/';
const DM_BODY = process.env.SMOKE_DM ?? 'Hi — automated MCP tool test, please ignore.';

interface Call {
  tool: string;
  args: Record<string, unknown>;
  note?: string;
}

const CALLS: Call[] = [
  { tool: 'linkedin_status', args: {} },
  { tool: 'linkedin_get_profile', args: { profileUrl: PROFILE } },
  { tool: 'linkedin_search_people', args: { query: 'software engineer san francisco' } },
  { tool: 'linkedin_search_jobs', args: { query: 'typescript backend remote' } },
  { tool: 'linkedin_search_companies', args: { query: 'anthropic' } },
  { tool: 'linkedin_get_feed', args: { limit: 5 } },
  { tool: 'linkedin_get_notifications', args: { limit: 8 } },
  { tool: 'linkedin_get_conversations', args: {} },
  { tool: 'linkedin_send_connection', args: { profileUrl: PROFILE }, note: 'REAL invite if not connected — authorized' },
  { tool: 'linkedin_send_message', args: { profileUrl: PROFILE, message: DM_BODY }, note: 'sends only if composer opens (1st-degree/open profile)' },
];

function summarize(text: string): string {
  try {
    const v = JSON.parse(text);
    if (Array.isArray(v)) return `array(${v.length})`;
    if (v && typeof v === 'object') {
      const keys = Object.keys(v);
      // Surface a few salient fields per tool.
      const pick = (k: string): string =>
        v[k] !== undefined ? `${k}=${JSON.stringify(v[k])}` : '';
      const hints = ['status', 'isLoggedIn', 'sessionValid', 'name', 'outcome',
        'delivered', 'success', 'error']
        .map(pick).filter(Boolean).join(' ');
      return hints || `object{${keys.slice(0, 6).join(',')}}`;
    }
    return String(v);
  } catch {
    return text.slice(0, 120);
  }
}

async function main(): Promise<void> {
  for (const c of CALLS) {
    const t0 = process.hrtime.bigint();
    const res = await dispatchToolCall(c.tool, c.args);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    const text = res.content?.[0]?.text ?? '';
    const flag = res.isError ? 'ERROR' : 'ok';
    process.stdout.write(
      `\n[${flag}] ${c.tool} (${ms.toFixed(0)}ms)${c.note ? '  // ' + c.note : ''}\n` +
        `  -> ${summarize(text)}\n`,
    );
    if (res.isError) process.stdout.write(`  raw: ${text}\n`);
  }
  await getInstance().close();
}

main().catch(async (err) => {
  process.stderr.write(`smoke crashed: ${err?.stack ?? err}\n`);
  try { await getInstance().close(); } catch { /* ignore */ }
  process.exit(1);
});
