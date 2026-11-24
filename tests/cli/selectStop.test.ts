import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { TussamValidationError } from '../../src/api/errors.js';
import { selectStopFrom } from '../../src/cli/selectStop.js';
import type { Stop } from '../../src/types.js';

function stop(name: string, code: string, lineLabels: string[] = ['01']): Stop {
  return {
    code,
    name,
    lat: 37.38,
    lon: -5.98,
    lines: lineLabels.map((label, idx) => ({ lineId: idx + 1, label, color: '#000000' })),
  };
}

function captureOutput(): { stream: PassThrough; read: () => string } {
  const stream = new PassThrough();
  const chunks: Buffer[] = [];
  stream.on('data', (chunk: Buffer) => chunks.push(chunk));
  return {
    stream,
    read: () => Buffer.concat(chunks).toString('utf8'),
  };
}

describe('selectStopFrom (mirrors renfe-cli cli.rs)', () => {
  it('selects a single matching stop without prompting', async () => {
    const input = new PassThrough();
    const out = captureOutput();

    const selected = await selectStopFrom(
      '43',
      [stop('Recaredo (Puerta Carmona)', '43', ['01', 'C4'])],
      input,
      out.stream,
    );

    expect(selected.code).toBe('43');
    expect(out.read()).toBe('');
  });

  it('throws descriptive error when no stops match', async () => {
    const input = new PassThrough();
    const out = captureOutput();

    await expect(selectStopFrom('unknown', [], input, out.stream)).rejects.toThrow(
      new TussamValidationError("Provided input 'unknown' does not match any stop"),
    );
    expect(out.read()).toBe('');
  });

  it('lists sorted matches with stop codes/lines and selects by 1-based ordinal', async () => {
    const input = new PassThrough();
    input.end('2\n');
    const out = captureOutput();

    const selected = await selectStopFrom(
      'puerta carmona',
      [
        stop('Recaredo (Puerta Carmona)', '43', ['01', 'C4']),
        stop('Menéndez Pelayo (Puerta Carmona)', '2', ['01', '21']),
      ],
      input,
      out.stream,
    );

    expect(selected.code).toBe('43');
    expect(out.read()).toBe(
      [
        "Multiple stops match 'puerta carmona':",
        '  1. Menéndez Pelayo (Puerta Carmona) [#2] (Lines: 01, 21)',
        '  2. Recaredo (Puerta Carmona) [#43] (Lines: 01, C4)',
        'Select a stop [1-2]: ',
      ].join('\n'),
    );
  });

  it('asks again after invalid selections and recovers on valid ordinal', async () => {
    const input = new PassThrough();
    input.end('none\n0\n9\n1\n');
    const out = captureOutput();

    const selected = await selectStopFrom(
      'carmona',
      [
        stop('Amador de Los Ríos (Puerta Carmona)', '887', ['24']),
        stop('Recaredo (Puerta Carmona)', '43', ['01', 'C4']),
      ],
      input,
      out.stream,
    );

    expect(selected.code).toBe('887');
    const text = out.read();
    expect(text.match(/Please enter a number between 1 and 2\./g)?.length).toBe(3);
  });

  it('throws cleanly on EOF without selection', async () => {
    const input = new PassThrough();
    input.end();
    const out = captureOutput();

    await expect(
      selectStopFrom('carmona', [stop('Stop A', '1'), stop('Stop B', '2')], input, out.stream),
    ).rejects.toThrow("No stop was selected for 'carmona'");
  });
});
