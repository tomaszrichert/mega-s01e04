export type RunStatus = 'ok' | 'retry' | 'fail';

export type DigestRow = {
  job: string;
  owner: string | null;
  runs: number;
  retries: number;
  lastStatus: RunStatus;
  lastError: string | null;
  firstAt: string;
  lastAt: string;
};

export type NightDigest = {
  rows: DigestRow[];
  badLines: number;
  counts: Record<RunStatus, number>;
};

/**
 * Read one night's log synchronously.
 *
 * Return null when the log does not exist. An empty log returns an empty digest.
 * Rows are sorted by job; counts include every valid event, not just final states.
 * Preserve original timestamp strings, including their offsets.
 */
export type ReadNight = (runsDir: string, night: string) => NightDigest | null;
