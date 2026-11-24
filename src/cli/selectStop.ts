import readline from 'node:readline';
import { TussamValidationError } from '../api/errors.js';
import type { Stop } from '../types.js';

/**
 * Resolves a stop from candidate matches, prompting interactively when multiple stops match
 * (mirrors `renfe-cli/src/cli.rs`).
 */
export async function selectStopFrom(
  query: string,
  matches: readonly Stop[],
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stdout,
): Promise<Stop> {
  const sorted = [...matches].sort(
    (a, b) => a.name.localeCompare(b.name) || a.code.localeCompare(b.code),
  );

  if (sorted.length === 0) {
    throw new TussamValidationError(`Provided input '${query}' does not match any stop`);
  }

  if (sorted.length === 1) {
    return sorted[0]!;
  }

  output.write(`Multiple stops match '${query}':\n`);
  sorted.forEach((stop, index) => {
    const lines = stop.lines.map((l) => l.label).join(', ') || 'none';
    output.write(`  ${index + 1}. ${stop.name} [#${stop.code}] (Lines: ${lines})\n`);
  });

  const rl = readline.createInterface({
    input,
    crlfDelay: Infinity,
  });
  const iterator = rl[Symbol.asyncIterator]();

  try {
    while (true) {
      output.write(`Select a stop [1-${sorted.length}]: `);
      const next = await iterator.next();
      if (next.done) {
        throw new TussamValidationError(`No stop was selected for '${query}'`);
      }

      const trimmed = next.value.trim();
      if (/^\d+$/.test(trimmed)) {
        const index = Number.parseInt(trimmed, 10);
        if (index >= 1 && index <= sorted.length) {
          return sorted[index - 1]!;
        }
      }

      output.write(`Please enter a number between 1 and ${sorted.length}.\n`);
    }
  } finally {
    rl.close();
  }
}
