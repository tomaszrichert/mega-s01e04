import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DigestRow, NightDigest, ReadNight, RunStatus } from './types.js';

type RunEvent = {
  at: string;
  job: string;
  status: RunStatus;
  owner: string | null;
  error?: string;
};

function isRunEvent(value: unknown): value is RunEvent {
  if (typeof value !== 'object' || value === null) return false;
  if (!('at' in value) || typeof value.at !== 'string') return false;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value.at)) return false;
  if (!Number.isFinite(Date.parse(value.at))) return false;
  if (!('job' in value) || typeof value.job !== 'string' || !value.job.trim()) return false;
  if (!('status' in value) || (value.status !== 'ok' && value.status !== 'retry' && value.status !== 'fail')) return false;
  if (!('owner' in value) || (value.owner !== null && typeof value.owner !== 'string')) return false;
  return !('error' in value) || typeof value.error === 'string';
}

type Aggregate = {
  row: DigestRow;
  firstTime: number;
  lastTime: number;
  errorTime: number;
};

/**
 * Invalid night names return null without reading a path. Blank lines are ignored.
 * First/latest use timestamp instants; ties use the later line for status and owner.
 * The latest error by timestamp survives later successful events without an error.
 */
export const readNight: ReadNight = (runsDir, night) => {
  if (night.length !== 10 || !/^\d{4}-\d{2}-\d{2}$/.test(night)) return null;

  let log: string;
  try {
    log = readFileSync(join(runsDir, `${night}.jsonl`), 'utf8');
  } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  }

  const digest: NightDigest = { rows: [], badLines: 0, counts: { ok: 0, retry: 0, fail: 0 } };
  const jobs = new Map<string, Aggregate>();

  for (const line of log.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      digest.badLines++;
      continue;
    }
    if (!isRunEvent(event)) {
      digest.badLines++;
      continue;
    }

    digest.counts[event.status]++;
    const time = Date.parse(event.at);
    const current = jobs.get(event.job);
    if (!current) {
      jobs.set(event.job, {
        row: {
          job: event.job,
          owner: event.owner,
          runs: 1,
          retries: event.status === 'retry' ? 1 : 0,
          lastStatus: event.status,
          lastError: event.error ?? null,
          firstAt: event.at,
          lastAt: event.at,
        },
        firstTime: time,
        lastTime: time,
        errorTime: event.error === undefined ? -Infinity : time,
      });
      continue;
    }

    current.row.runs++;
    if (event.status === 'retry') current.row.retries++;
    if (time < current.firstTime) {
      current.firstTime = time;
      current.row.firstAt = event.at;
    }
    if (time >= current.lastTime) {
      current.lastTime = time;
      current.row.lastAt = event.at;
      current.row.lastStatus = event.status;
      current.row.owner = event.owner;
    }
    if (event.error !== undefined && time >= current.errorTime) {
      current.errorTime = time;
      current.row.lastError = event.error;
    }
  }

  digest.rows = [...jobs.values()].map(({ row }) => row)
    .sort((a, b) => a.job < b.job ? -1 : a.job > b.job ? 1 : 0);
  return digest;
};
