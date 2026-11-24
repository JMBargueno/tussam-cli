import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { watchStopArrivals } from '../../src/cli/watch.js';
import type { StopArrivalsResult } from '../../src/types.js';

function captureStream(): { stream: PassThrough; read: () => string } {
  const stream = new PassThrough();
  const chunks: Buffer[] = [];
  stream.on('data', (chunk: Buffer) => chunks.push(chunk));
  return {
    stream,
    read: () => Buffer.concat(chunks).toString('utf8'),
  };
}

function sampleArrivals(seconds = 120): StopArrivalsResult {
  return {
    stopCode: '43',
    stopName: 'Recaredo',
    lat: 37.3896,
    lon: -5.9842,
    fetchedAt: '2026-11-24T12:00:00.000Z',
    stale: false,
    arrivals: [
      {
        lineId: 1,
        lineLabel: '01',
        color: '#f54129',
        destination: 'HOSPITAL V.ROCIO',
        seconds,
        minutes: Math.floor(seconds / 60),
        distanceMeters: 400,
        vehicle: 101,
        attributes: [],
      },
    ],
  };
}

describe('watchStopArrivals', () => {
  it('renders TTY frames with Last updated timestamp, countdown ticks, and restores cursor on abort', async () => {
    const out = captureStream();
    const err = captureStream();
    const controller = new AbortController();
    let calls = 0;

    await watchStopArrivals({
      stopCode: '43',
      intervalSec: 2,
      isTTY: true,
      stdout: out.stream,
      stderr: err.stream,
      signal: controller.signal,
      nowFn: () => new Date(2026, 10, 24, 14, 5, 9),
      sleepFn: async () => undefined,
      fetchArrivals: async () => {
        calls += 1;
        if (calls >= 2) {
          controller.abort();
        }
        return sampleArrivals(120);
      },
    });

    const text = out.read();
    expect(text).toContain('\x1b[?25l'); // hidden cursor
    expect(text).toContain('Last updated: 14:05:09');
    expect(text).toContain('Next refresh in 2s (Ctrl+C to stop)...');
    expect(text).toContain('Next refresh in 1s (Ctrl+C to stop)...');
    expect(text).toContain('\x1b[?25h'); // cursor restored
    expect(err.read()).toBe('');
  });

  it('recovers from transient errors and streams clean NDJSON in --json mode', async () => {
    const out = captureStream();
    const err = captureStream();
    let calls = 0;

    await watchStopArrivals({
      stopCode: '43',
      intervalSec: 10,
      useJson: true,
      isTTY: false,
      stdout: out.stream,
      stderr: err.stream,
      maxIterations: 2,
      sleepFn: async () => undefined,
      fetchArrivals: async () => {
        calls += 1;
        if (calls === 1) {
          throw new Error('Upstream hiccup');
        }
        return sampleArrivals(45);
      },
    });

    expect(err.read()).toContain('[WARN] Refresh failed for stop #43: Upstream hiccup');
    const lines = out.read().trim().split('\n');
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]!) as StopArrivalsResult;
    expect(parsed.stopCode).toBe('43');
    expect(parsed.arrivals[0]?.seconds).toBe(45);
  });
});
