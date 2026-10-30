import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { readNight } from '../src/digest/read-night.js';

const night = '2026-10-28';
const fixturesDir = fileURLToPath(new URL('../runs/', import.meta.url));
const tempDirs: string[] = [];

function tempRuns(): string {
  const dir = mkdtempSync(join(tmpdir(), 'rig-digest-'));
  tempDirs.push(dir);
  return dir;
}

function logWith(records: unknown[]): string {
  const dir = tempRuns();
  writeFileSync(join(dir, `${night}.jsonl`), records.map(record => JSON.stringify(record)).join('\n'));
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('readNight', () => {
  it('reads the real night: five sorted jobs, all event counts, and one bad line', () => {
    expect(readNight(fixturesDir, night)).toEqual({
      badLines: 1,
      counts: { ok: 10, retry: 4, fail: 1 },
      rows: [
        {
          job: 'digest/render', owner: null, runs: 1, retries: 0,
          lastStatus: 'ok', lastError: null,
          firstAt: '2026-10-29T05:41:09+01:00', lastAt: '2026-10-29T05:41:09+01:00',
        },
        {
          job: 'fixtures/refresh', owner: 'rook', runs: 4, retries: 3,
          lastStatus: 'ok', lastError: 'upstream 503',
          firstAt: '2026-10-29T01:30:00+01:00', lastAt: '2026-10-29T01:37:00+01:00',
        },
        {
          job: 'lane/sync', owner: 'rook', runs: 8, retries: 1,
          lastStatus: 'ok', lastError: 'lock held',
          firstAt: '2026-10-28T23:00:06+01:00', lastAt: '2026-10-29T05:00:04+01:00',
        },
        {
          job: 'notes/backup', owner: 'lane-07', runs: 1, retries: 0,
          lastStatus: 'fail', lastError: 'quota exceeded',
          firstAt: '2026-10-29T04:00:01+01:00', lastAt: '2026-10-29T04:00:01+01:00',
        },
        {
          job: 'rig/rotate-logs', owner: 'lane-07', runs: 1, retries: 0,
          lastStatus: 'ok', lastError: null,
          firstAt: '2026-10-28T23:00:02+01:00', lastAt: '2026-10-28T23:00:02+01:00',
        },
      ],
    });
  });

  it('returns null for a missing log, including a missing runs directory', () => {
    const dir = tempRuns();
    expect(readNight(dir, night)).toBeNull();
    expect(readNight(join(dir, 'absent'), night)).toBeNull();
  });

  it.each(['', '\r\n  \r\n\t\n'])('returns an empty digest for empty or blank logs (%j)', log => {
    const dir = tempRuns();
    writeFileSync(join(dir, `${night}.jsonl`), log);
    expect(readNight(dir, night)).toEqual({ rows: [], badLines: 0, counts: { ok: 0, retry: 0, fail: 0 } });
  });

  it.each(['../2026-10-28', '../../outside', '/2026-10-28', '2026-10-28/extra', '2026-1-2', '2026-10-28.jsonl', '2026-10-28\n', ''])('rejects unsafe or malformed night names (%j)', value => {
    expect(readNight(fixturesDir, value)).toBeNull();
  });

  it('propagates non-ENOENT file errors', () => {
    const dir = tempRuns();
    const file = join(dir, `${night}.jsonl`);
    writeFileSync(file, 'not a directory');
    expect(() => readNight(file, night)).toThrow(expect.objectContaining({ code: 'ENOTDIR' }));
    rmSync(file);
    mkdirSync(file);
    expect(() => readNight(dir, night)).toThrow(expect.objectContaining({ code: 'EISDIR' }));
  });

  it('counts bad JSON and invalid schemas without losing valid events around them', () => {
    const event = { at: '2026-10-28T23:00:00+01:00', job: 'job', status: 'ok', owner: null };
    const { owner: _owner, ...missingOwner } = event;
    const invalid: unknown[] = [
      null, [], 42, 'text', {}, missingOwner,
      { ...event, job: '' }, { ...event, job: ' ' }, { ...event, job: 1 },
      { ...event, at: 'not a date' }, { ...event, at: '2026-10-28' },
      { ...event, at: '2026-10-28T23:00:00' },
      { ...event, at: '2026-99-99T23:00:00Z' }, { ...event, at: null },
      { ...event, status: 'pending' }, { ...event, status: ['ok'] },
      { ...event, owner: 42 }, { ...event, error: null }, { ...event, error: 42 },
    ];
    const dir = tempRuns();
    const lines = [JSON.stringify(event), '{bad JSON', ...invalid.map(value => JSON.stringify(value)), JSON.stringify({ ...event, status: 'retry', error: 'again' })];
    writeFileSync(join(dir, `${night}.jsonl`), `${lines.join('\r\n')}\r\n`);

    const digest = readNight(dir, night);
    expect(digest).toMatchObject({
      badLines: invalid.length + 1,
      counts: { ok: 1, retry: 1, fail: 0 },
      rows: [{ job: 'job', owner: null, runs: 2, retries: 1, lastStatus: 'retry', lastError: 'again' }],
    });
  });

  it('uses timestamp instants for unordered events, preserving offsets and the latest error after recovery', () => {
    const dir = logWith([
      { at: '2026-10-29T01:30:00+02:00', job: 'z/job', status: 'retry', owner: 'new', error: 'new error' },
      { at: '2026-10-29T00:00:00Z', job: 'z/job', status: 'ok', owner: null },
      { at: '2026-10-29T01:00:00+02:00', job: 'z/job', status: 'fail', owner: 'old', error: 'old error' },
      { at: '2026-10-28T23:00:00.123-04:00', job: 'a/job', status: 'ok', owner: 'a' },
    ]);
    expect(readNight(dir, night)).toEqual({
      badLines: 0,
      counts: { ok: 2, retry: 1, fail: 1 },
      rows: [
        {
          job: 'a/job', owner: 'a', runs: 1, retries: 0, lastStatus: 'ok', lastError: null,
          firstAt: '2026-10-28T23:00:00.123-04:00', lastAt: '2026-10-28T23:00:00.123-04:00',
        },
        {
          job: 'z/job', owner: null, runs: 3, retries: 1, lastStatus: 'ok', lastError: 'new error',
          firstAt: '2026-10-29T01:00:00+02:00', lastAt: '2026-10-29T00:00:00Z',
        },
      ],
    });
  });

  it('breaks equal timestamp ties by line order, including empty error strings', () => {
    const dir = logWith([
      { at: '2026-10-28T23:00:00Z', job: '__proto__', status: 'fail', owner: 'first', error: 'first' },
      { at: '2026-10-29T00:00:00+01:00', job: '__proto__', status: 'retry', owner: null, error: '' },
    ]);
    expect(readNight(dir, night)?.rows).toEqual([{
      job: '__proto__', owner: null, runs: 2, retries: 1, lastStatus: 'retry', lastError: '',
      firstAt: '2026-10-28T23:00:00Z', lastAt: '2026-10-29T00:00:00+01:00',
    }]);
  });
});
