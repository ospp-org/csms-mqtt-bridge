/**
 * Every job of every workflow declares its own timeout-minutes, below GitHub's default. A
 * job that declares none runs for up to 360 minutes, so a hang fails only then: the v0.2.0
 * release job's first attempt ran 59 minutes before it was cancelled.
 *
 * Read by indentation, not by a YAML parser (the repo depends on none): a job is a key one
 * level under the top-level `jobs:`, and its settings are the keys one level under the job.
 * A step's own timeout-minutes sits deeper and is not the job's.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const GITHUB_DEFAULT_TIMEOUT_MINUTES = 360;

const workflowsDir = join(import.meta.dirname, '..', '..', '.github', 'workflows');

interface Job {
  name: string;
  /** The job-level value as written, or undefined when the job declares none. */
  timeoutMinutes: string | undefined;
}

const KEY = /^ *([A-Za-z0-9_-]+):(?: +(.*))?$/;

const jobsOf = (yaml: string): Job[] => {
  // Blank and comment lines carry no structure.
  const lines = yaml
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '' && !line.trimStart().startsWith('#'));
  const start = lines.findIndex((line) => /^jobs: *$/.test(line));
  if (start === -1) return [];

  const jobs: Job[] = [];
  let jobIndent: number | undefined;
  let settingIndent: number | undefined;
  for (const line of lines.slice(start + 1)) {
    const indent = line.length - line.trimStart().length;
    // The next top-level key ends `jobs:`.
    if (indent === 0) break;
    jobIndent ??= indent;
    const key = KEY.exec(line);
    if (indent === jobIndent) {
      jobs.push({ name: key?.[1] ?? line.trim(), timeoutMinutes: undefined });
      settingIndent = undefined;
      continue;
    }
    settingIndent ??= indent;
    const job = jobs.at(-1);
    if (job && indent === settingIndent && key?.[1] === 'timeout-minutes') {
      job.timeoutMinutes = (key[2] ?? '').replace(/ +#.*$/, '');
    }
  }
  return jobs;
};

/** Whole minutes above zero and below GitHub's default; anything else bounds nothing. */
const bounds = (timeoutMinutes: string | undefined): boolean =>
  timeoutMinutes !== undefined &&
  /^\d+$/.test(timeoutMinutes) &&
  Number(timeoutMinutes) > 0 &&
  Number(timeoutMinutes) < GITHUB_DEFAULT_TIMEOUT_MINUTES;

describe('GitHub workflows', () => {
  const workflows = readdirSync(workflowsDir)
    .filter((file) => /\.ya?ml$/.test(file))
    .sort()
    .map((file) => ({ file, jobs: jobsOf(readFileSync(join(workflowsDir, file), 'utf-8')) }));

  it('declares timeout-minutes on every job of every workflow, below the 360 GitHub gives a job without one', () => {
    // The denominator first: a workflow whose jobs were not found would pass the check below.
    expect(workflows.length).toBeGreaterThan(0);
    for (const { file, jobs } of workflows) {
      expect(jobs.length, `${file}: no job found`).toBeGreaterThan(0);
    }

    const unbounded = workflows.flatMap(({ file, jobs }) =>
      jobs
        .filter((job) => !bounds(job.timeoutMinutes))
        .map(
          (job) =>
            `${file} job ${job.name}: timeout-minutes ${job.timeoutMinutes ?? 'not declared'}`,
        ),
    );
    expect(unbounded).toEqual([]);
  });
});
