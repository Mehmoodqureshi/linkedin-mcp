/**
 * profile.scenario.ts — READ-ONLY profile suite for the HITL harness.
 *
 * Covers the two public profile actions:
 *   - profile.getProfile(url)            for every targets.profileUrls[]
 *   - profile.getProfileByUsername(slug) for every targets.profileUsernames[]
 *
 * Both are pure reads (they navigate + scrape, never mutate remote state), so
 * every step goes through `runner.runReadOnly` — there is no mutation gate here
 * and no mutating driver method is imported.
 *
 * The Runner owns timing, screenshots, the truncated JSON preview and the human
 * verdict; this file only describes each step declaratively and returns the raw
 * `ProfileData` from the real action. To help the human compare the scraped data
 * against the visible page, each step also logs a compact name/headline/
 * experience digest to stderr before the verdict prompt.
 *
 * Failures route to `src/driver/actions/profile.ts` via `sourceHint`, since that
 * is the file whose selectors/scrapers would have drifted.
 */

import type { ProfileData } from '../../../src/driver/actions/profile';
import type { RunContext, ScenarioCtx, ScenarioModule } from '../types';

/** Source file whose selectors/actions to tune if any step here fails. */
const SOURCE_HINT = 'src/driver/actions/profile.ts';

/**
 * Build the per-step RunContext the Runner needs (page, resultsDir, artifact
 * sink) from the ScenarioCtx the harness hands us. `resultsDir` is published by
 * index.ts as `HITL_RESULTS_DIR`; if it is absent we fall back to cwd so the
 * suite still runs (screenshots simply land there).
 */
async function makeRunContext(ctx: ScenarioCtx): Promise<RunContext> {
  const page = await ctx.driver.getPage();
  const resultsDir = process.env.HITL_RESULTS_DIR ?? process.cwd();
  return {
    driver: ctx.driver,
    page,
    targets: ctx.targets,
    options: ctx.options,
    resultsDir,
    async recordArtifact(name: string, data: unknown): Promise<string> {
      const fs = await import('fs');
      const path = await import('path');
      const abs = path.join(resultsDir, name);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, JSON.stringify(data, null, 2) + '\n', 'utf8');
      return abs;
    },
  };
}

/**
 * Log a compact, human-comparable digest of the scraped profile to stderr so
 * the operator can eyeball name / headline / first experience entries against
 * the visible LinkedIn page before voting pass/fail.
 */
function logDigest(label: string, data: ProfileData): void {
  const lines: string[] = [];
  lines.push(`  [compare] ${label}`);
  lines.push(`    name      : ${data.name ?? '(none)'}`);
  lines.push(`    headline  : ${data.headline ?? '(none)'}`);
  lines.push(`    location  : ${data.location ?? '(none)'}`);
  lines.push(`    connections: ${data.connectionsCount ?? '(none)'}`);

  if (data.experience.length === 0) {
    lines.push('    experience: (none scraped)');
  } else {
    lines.push(`    experience (${data.experience.length}):`);
    for (const exp of data.experience.slice(0, 3)) {
      const title = exp.title ?? '(no title)';
      const company = exp.company ? ` @ ${exp.company}` : '';
      const dates = exp.dateRange ? ` (${exp.dateRange})` : '';
      lines.push(`      - ${title}${company}${dates}`);
    }
    if (data.experience.length > 3) {
      lines.push(`      … +${data.experience.length - 3} more`);
    }
  }

  process.stderr.write(lines.join('\n') + '\n');
}

const scenario: ScenarioModule = {
  id: 'profile',
  label: 'Profile (read-only): getProfile + getProfileByUsername',
  group: 'profile',

  async run(ctx: ScenarioCtx): Promise<void> {
    const runCtx = await makeRunContext(ctx);
    const { runner, targets } = ctx;

    // --- profile.getProfile(url) for each configured profile URL ---
    if (targets.profileUrls.length === 0) {
      process.stderr.write(
        '  [skip] profile.getProfile — no targets.profileUrls configured.\n',
      );
    } else {
      for (let i = 0; i < targets.profileUrls.length; i++) {
        const url = targets.profileUrls[i];
        if (!url) continue; // guard against sparse/empty entries
        await runner.runReadOnly(
          {
            name: `profile-getProfile-${i + 1}`,
            group: 'profile',
            action: 'profile.getProfile',
            inputs: { url },
            sourceHint: SOURCE_HINT,
          },
          runCtx,
          async () => {
            const data = await ctx.driver.profile.getProfile(url);
            logDigest(`getProfile(${url})`, data);
            return data;
          },
        );
      }
    }

    // --- profile.getProfileByUsername(slug) for each configured slug ---
    if (targets.profileUsernames.length === 0) {
      process.stderr.write(
        '  [skip] profile.getProfileByUsername — no targets.profileUsernames configured.\n',
      );
    } else {
      for (let i = 0; i < targets.profileUsernames.length; i++) {
        const username = targets.profileUsernames[i];
        if (!username) continue; // guard against sparse/empty entries
        await runner.runReadOnly(
          {
            name: `profile-getProfileByUsername-${i + 1}`,
            group: 'profile',
            action: 'profile.getProfileByUsername',
            inputs: { username },
            sourceHint: SOURCE_HINT,
          },
          runCtx,
          async () => {
            const data = await ctx.driver.profile.getProfileByUsername(username);
            logDigest(`getProfileByUsername(${username})`, data);
            return data;
          },
        );
      }
    }
  },
};

export default scenario;
