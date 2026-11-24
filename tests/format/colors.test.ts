import { describe, expect, it } from 'vitest';
import {
  colorizeLineLabel,
  detectColorLevel,
  liftDarkRgb,
  padRightVisible,
  parseHexColor,
  stripAnsi,
} from '../../src/format/colors.js';

describe('Terminal line colors', () => {
  it('respects NO_COLOR, FORCE_COLOR=0, dumb TERM, and non-TTY pipes', () => {
    expect(detectColorLevel({ NO_COLOR: '1', COLORTERM: 'truecolor' }, true)).toBe(0);
    expect(detectColorLevel({ FORCE_COLOR: '0', WT_SESSION: 'abc' }, true)).toBe(0);
    expect(detectColorLevel({ TERM: 'dumb' }, true)).toBe(0);
    expect(detectColorLevel({ COLORTERM: 'truecolor' }, false)).toBe(0);
    expect(detectColorLevel({ WT_SESSION: '1' }, true)).toBe(3);
    expect(detectColorLevel({ COLORTERM: 'truecolor' }, true)).toBe(3);
    expect(detectColorLevel({ TERM: 'xterm-256color' }, true)).toBe(2);
    expect(detectColorLevel({}, true)).toBe(1);
  });

  it('parses 3- and 6-digit hex colors and lifts very dark colors for readability', () => {
    expect(parseHexColor('#f54129')).toEqual({ r: 245, g: 65, b: 41 });
    expect(parseHexColor('#0af')).toEqual({ r: 0, g: 170, b: 255 });
    expect(parseHexColor('invalid')).toBeNull();

    const liftedNavy = liftDarkRgb(0, 13, 111);
    expect(liftedNavy.b).toBeGreaterThan(111);
    expect(liftedNavy.r).toBeGreaterThan(0);

    const liftedBlack = liftDarkRgb(0, 0, 0);
    expect(liftedBlack).toEqual({ r: 0, g: 200, b: 220 });
  });

  it('colorizes according to level and pads cleanly by visible width', () => {
    expect(colorizeLineLabel('01', '#f54129', 0)).toBe('01');

    const truecolor = colorizeLineLabel('01', '#f54129', 3);
    expect(truecolor).toContain('\u001b[1;38;2;245;65;41m01\u001b[0m');
    expect(stripAnsi(truecolor)).toBe('01');
    expect(padRightVisible(truecolor, 6)).toBe(`${truecolor}    `);

    const ansi256 = colorizeLineLabel('C1', '#008431', 2);
    expect(ansi256.startsWith('\u001b[1;38;5;')).toBe(true);
    expect(ansi256.endsWith('mC1\u001b[0m')).toBe(true);
    expect(stripAnsi(ansi256)).toBe('C1');
  });
});
