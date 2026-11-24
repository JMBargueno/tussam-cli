import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { TussamValidationError } from '../../src/api/errors.js';
import { runInteractivePrompt } from '../../src/cli/interactive.js';
import type { FavoriteStop, Stop } from '../../src/types.js';

function captureOutput(): { stream: PassThrough; read: () => string } {
  const stream = new PassThrough();
  const chunks: Buffer[] = [];
  stream.on('data', (chunk: Buffer) => chunks.push(chunk));
  return {
    stream,
    read: () => Buffer.concat(chunks).toString('utf8'),
  };
}

const STOPS: Stop[] = [
  {
    code: '43',
    name: 'Recaredo (Puerta Carmona)',
    lat: 37.3896,
    lon: -5.9842,
    lines: [{ lineId: 1, label: '01', color: '#f54129' }],
  },
  {
    code: '785',
    name: 'María Auxiliadora (Puerta Osario)',
    lat: 37.3941,
    lon: -5.9838,
    lines: [{ lineId: 1, label: '01', color: '#f54129' }],
  },
  {
    code: '58',
    name: 'Manuel Siurot (Hospital V.Rocio)',
    lat: 37.3611,
    lon: -5.9815,
    lines: [{ lineId: 1, label: '01', color: '#f54129' }],
  },
  {
    code: '59',
    name: 'Manuel Siurot (Bami)',
    lat: 37.359,
    lon: -5.981,
    lines: [{ lineId: 1, label: '01', color: '#f54129' }],
  },
];

describe('runInteractivePrompt', () => {
  it('walks user through origin favorite, destination disambiguation, date retry, time, and sort', async () => {
    const input = new PassThrough();
    const out = captureOutput();

    input.end(
      `${[
        'unknown-stop', // re-prompts on 0 matches
        'casa', // resolves via favorite
        'manuel siurot', // matches 2 stops -> disambiguation prompt
        '2', // picks Hospital V.Rocio (#58)
        'invalid-date', // re-prompts on invalid date
        '2026-11-29',
        '08:30',
        'y',
      ].join('\n')}\n`,
    );

    const favs: FavoriteStop[] = [
      {
        alias: 'casa',
        stopCode: '43',
        stopName: 'Recaredo (Puerta Carmona)',
        addedAt: '2026-11-24T12:00:00.000Z',
      },
    ];

    const result = await runInteractivePrompt({
      input,
      output: out.stream,
      now: new Date(2026, 10, 24, 10, 0, 0),
      listFavorites: async () => favs,
      resolveFavorite: async (q) => favs.find((f) => f.alias === q.toLowerCase()) ?? null,
      matchStops: async (q) =>
        STOPS.filter((s) => s.code === q || s.name.toLowerCase().includes(q.toLowerCase())),
    });

    expect(result.origin.code).toBe('43');
    expect(result.destination.code).toBe('58');
    expect(result.date.getFullYear()).toBe(2026);
    expect(result.date.getMonth()).toBe(10);
    expect(result.date.getDate()).toBe(29);
    expect(result.afterSeconds).toBe(8 * 3600 + 30 * 60);
    expect(result.sortByDuration).toBe(true);

    const text = out.read();
    expect(text).toContain('Saved favorites: casa (#43)');
    expect(text).toContain("No stops matched 'unknown-stop'");
    expect(text).toContain("Multiple stops match 'manuel siurot'");
    expect(text).toContain("Invalid date 'invalid-date'");
  });

  it('throws TussamValidationError cleanly on EOF', async () => {
    const input = new PassThrough();
    input.end();
    const out = captureOutput();

    await expect(
      runInteractivePrompt({
        input,
        output: out.stream,
        matchStops: async () => [],
      }),
    ).rejects.toThrow(TussamValidationError);
  });
});
