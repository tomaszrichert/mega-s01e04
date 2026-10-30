import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import type { NightDigest } from '../src/digest/types.js';

const night = '2026-10-28';
const at = '2026-10-28T23:00:00+01:00';
const event = { at, job: 'daily/report', status: 'ok', owner: null };
let runsDir: string;

beforeEach(() => {
  runsDir = mkdtempSync(join(tmpdir(), 'rig-digest-routes-'));
});

afterEach(() => {
  rmSync(runsDir, { recursive: true, force: true });
});

function app() {
  return createApp({ adapter: 'shim', installed: at, beatEverySeconds: 60, runsDir });
}

function writeLog(log: string, name = night) {
  writeFileSync(join(runsDir, `${name}.jsonl`), log);
}

function writeEvents(events: unknown[], name = night) {
  writeLog(events.map(value => JSON.stringify(value)).join('\n'), name);
}

// Only inspect the fixed, text-only digest table, not layout styles or other markup.
function tableRows(html: string) {
  const bodies = [...html.matchAll(/<tbody>([\s\S]*?)<\/tbody>/g)];
  expect(bodies).toHaveLength(1);
  return [...bodies[0]![1]!.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map(row => {
    const cells = [...row[1]!.matchAll(/<td([^>]*)>([\s\S]*?)<\/td>/g)].map(cell => ({
      attributes: cell[1]!,
      text: cell[2]!,
    }));
    expect(cells).toHaveLength(8);
    return cells;
  });
}

describe('digest routes', () => {
  it('serves the same sorted jobs and complete row values in HTML and JSON', async () => {
    writeEvents([
      { at: '2026-10-29T01:30:00+02:00', job: 'z/sync', status: 'retry', owner: 'new owner', error: 'upstream 503' },
      { at: '2026-10-29T00:00:00Z', job: 'z/sync', status: 'ok', owner: null },
      { at: '2026-10-29T01:00:00+02:00', job: 'z/sync', status: 'fail', owner: 'old owner', error: 'old error' },
      { at: '2026-10-28T23:00:00.123-04:00', job: 'a/report', status: 'ok', owner: 'rook' },
    ]);
    const expected: NightDigest = {
      rows: [
        {
          job: 'a/report', owner: 'rook', runs: 1, retries: 0, lastStatus: 'ok', lastError: null,
          firstAt: '2026-10-28T23:00:00.123-04:00', lastAt: '2026-10-28T23:00:00.123-04:00',
        },
        {
          job: 'z/sync', owner: null, runs: 3, retries: 1, lastStatus: 'ok', lastError: 'upstream 503',
          firstAt: '2026-10-29T01:00:00+02:00', lastAt: '2026-10-29T00:00:00Z',
        },
      ],
      badLines: 0,
      counts: { ok: 2, retry: 1, fail: 1 },
    };
    const server = app();
    const page = await server.request(`/digest/${night}`);
    const api = await server.request(`/api/digest/${night}`);
    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toContain('text/html');
    expect(api.status).toBe(200);
    expect(api.headers.get('content-type')).toContain('application/json');
    const digest: NightDigest = await api.json();
    expect(digest).toEqual(expected);
    const html = await page.text();
    expect(html).toContain(`<h1>digest · ${night}</h1>`);
    expect(html).toContain('malformed lines: 0');
    const rows = tableRows(html);
    expect(rows.map(row => row.map(cell => cell.text))).toEqual([
      ['a/report', 'rook', '1', '0', 'ok', '—', '2026-10-28T23:00:00.123-04:00', '2026-10-28T23:00:00.123-04:00'],
      ['z/sync', '—', '3', '1', 'ok', 'upstream 503', '2026-10-29T01:00:00+02:00', '2026-10-29T00:00:00Z'],
    ]);
    expect(rows.map(row => row[0]!.text)).toEqual(digest.rows.map(row => row.job));
  });

  it.each(['/digest', '/api/digest'])('returns 404 for a missing night on %s', async route => {
    const response = await app().request(`${route}/${night}`);
    expect(response.status).toBe(404);
    if (route === '/api/digest') expect(await response.json()).toEqual({ error: 'Not Found' });
    else expect(await response.text()).toContain('Not Found');
  });

  it.each(['not-a-night', '2026-1-2', '2026-10-28.jsonl', '..%2F2026-10-28', '2026-10-28%0A'])(
    'returns 404 in both representations for invalid night %s', async invalidNight => {
      // Even an existing file must not make a malformed night name routable.
      writeEvents([event], 'not-a-night');
      const server = app();
      expect((await server.request(`/digest/${invalidNight}`)).status).toBe(404);
      const api = await server.request(`/api/digest/${invalidNight}`);
      expect(api.status).toBe(404);
      expect(await api.json()).toEqual({ error: 'Not Found' });
    },
  );

  it.each(['', '\r\n  \r\n\t\n'])('renders an empty or whitespace-only night (%j)', async log => {
    writeLog(log);
    const server = app();
    const page = await server.request(`/digest/${night}`);
    const api = await server.request(`/api/digest/${night}`);
    expect(page.status).toBe(200);
    expect(api.status).toBe(200);
    expect(await api.json()).toEqual({ rows: [], badLines: 0, counts: { ok: 0, retry: 0, fail: 0 } });
    const html = await page.text();
    expect(html).toContain('nothing ran');
    expect(html).toContain('malformed lines: 0');
    expect(html).not.toContain('no valid runs found');
    expect(html).not.toContain('<table');
  });

  it('counts malformed JSON and schema lines without losing valid runs on either side', async () => {
    writeLog([
      JSON.stringify(event),
      '{broken JSON',
      'null',
      JSON.stringify({ ...event, status: 'pending' }),
      JSON.stringify({ ...event, owner: 42 }),
      JSON.stringify({ ...event, at: 'not a timestamp' }),
      '  ',
      JSON.stringify({ ...event, at: '2026-10-29T00:00:00+01:00', status: 'retry', error: 'try again' }),
      '',
    ].join('\r\n'));
    const server = app();
    const page = await server.request(`/digest/${night}`);
    const api = await server.request(`/api/digest/${night}`);
    expect(page.status).toBe(200);
    expect(api.status).toBe(200);
    expect(await api.json()).toEqual({
      rows: [{
        job: 'daily/report', owner: null, runs: 2, retries: 1, lastStatus: 'retry', lastError: 'try again',
        firstAt: at, lastAt: '2026-10-29T00:00:00+01:00',
      }],
      badLines: 5,
      counts: { ok: 1, retry: 1, fail: 0 },
    });
    const html = await page.text();
    expect(html).toContain('<p class="warn">malformed lines: 5 · skipped; this digest may be incomplete</p>');
    expect(tableRows(html).map(row => row.map(cell => cell.text))).toEqual([
      ['daily/report', '—', '2', '1', 'retry', 'try again', at, '2026-10-29T00:00:00+01:00'],
    ]);
    expect(html).not.toContain('nothing ran');
  });

  it('distinguishes a malformed-only log from a night where nothing ran', async () => {
    writeLog('{broken JSON\n{"job":"missing fields"}\n\n');
    const server = app();
    const page = await server.request(`/digest/${night}`);
    const api = await server.request(`/api/digest/${night}`);
    expect(page.status).toBe(200);
    expect(api.status).toBe(200);
    expect(await api.json()).toEqual({ rows: [], badLines: 2, counts: { ok: 0, retry: 0, fail: 0 } });
    const html = await page.text();
    expect(html).toContain('malformed lines: 2 · skipped; this digest may be incomplete');
    expect(html).toContain('no valid runs found');
    expect(html).not.toContain('nothing ran');
    expect(html).not.toContain('<table');
  });

  it.each([0, 2, 3, 4])('marks retries at the threshold, including recovery (%i retries)', async retries => {
    writeEvents([
      ...Array.from({ length: retries }, () => ({ ...event, status: 'retry', error: 'busy' })),
      { ...event, at: '2026-10-29T00:00:00+01:00' },
    ]);
    const response = await app().request(`/digest/${night}`);
    expect(response.status).toBe(200);
    const [row] = tableRows(await response.text());
    expect(row![2]!.text).toBe(String(retries + 1));
    expect(row![3]!.text).toBe(String(retries));
    expect(row![3]!.attributes.includes('class="warn"')).toBe(retries >= 3);
    expect(row![4]!.text).toBe('ok');
    expect(row![4]!.attributes).not.toContain('warn');
  });

  it('marks a failed status even with no retries', async () => {
    writeEvents([{ ...event, status: 'fail', error: 'quota exceeded' }]);
    const response = await app().request(`/digest/${night}`);
    expect(response.status).toBe(200);
    const [row] = tableRows(await response.text());
    expect(row![3]).toEqual({ attributes: '', text: '0' });
    expect(row![4]).toEqual({ attributes: ' class="warn"', text: 'fail' });
    expect(row![5]!.text).toBe('quota exceeded');
  });

  it('escapes injection-like job, owner, and error text in HTML while preserving JSON strings', async () => {
    const job = '<script>alert("job")</script>&';
    const owner = '<img src=x onerror="alert(1)">&';
    const error = '</td><script>alert("error")</script>&';
    writeEvents([{ ...event, job, owner, status: 'fail', error }]);
    const server = app();
    const page = await server.request(`/digest/${night}`);
    const api = await server.request(`/api/digest/${night}`);
    expect(page.status).toBe(200);
    expect(api.status).toBe(200);
    expect(await api.json()).toEqual({
      rows: [{ job, owner, runs: 1, retries: 0, lastStatus: 'fail', lastError: error, firstAt: at, lastAt: at }],
      badLines: 0,
      counts: { ok: 0, retry: 0, fail: 1 },
    });
    const html = await page.text();
    const [row] = tableRows(html);
    expect(row![0]!.text).toBe('&lt;script&gt;alert(&quot;job&quot;)&lt;/script&gt;&amp;');
    expect(row![1]!.text).toBe('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;&amp;');
    expect(row![5]!.text).toBe('&lt;/td&gt;&lt;script&gt;alert(&quot;error&quot;)&lt;/script&gt;&amp;');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('<img');
  });

  it('links temporary nights from the board with all-event counts and working digests', async () => {
    writeEvents([
      { ...event, status: 'retry' },
      { ...event, status: 'retry' },
      { ...event, status: 'fail' },
      event,
    ]);
    writeLog('', '2026-10-27');
    const server = app();
    const response = await server.request('/');
    expect(response.status).toBe(200);
    const html = await response.text();
    const nights = [...html.matchAll(/<li>([\s\S]*?)<\/li>/g)].map(match => match[1]);
    expect(nights).toEqual([
      '<a href="/digest/2026-10-28">2026-10-28</a> · ok 1 / retry 2 / fail 1',
      '<a href="/digest/2026-10-27">2026-10-27</a> · ok 0 / retry 0 / fail 0',
    ]);
    const links = [...html.matchAll(/<a href="(\/digest\/[^"]+)">/g)].map(match => match[1]!);
    expect(links).toHaveLength(2);
    for (const link of links) expect((await server.request(link)).status).toBe(200);
    const api = await server.request(`/api/digest/${night}`);
    expect(api.status).toBe(200);
    expect(await api.json()).toMatchObject({ counts: { ok: 1, retry: 2, fail: 1 } });
  });
});
