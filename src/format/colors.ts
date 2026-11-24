import pc from 'picocolors';

export type ColorLevel = 0 | 1 | 2 | 3;

const TRUECOLOR_PROGRAMS = new Set([
  'iTerm.app',
  'vscode',
  'WezTerm',
  'Hyper',
  'Alacritty',
  'kitty',
  'Ghostty',
]);

/**
 * Detects supported terminal color depth while honoring `NO_COLOR`, `FORCE_COLOR`, and TTY status.
 */
export function detectColorLevel(
  env: NodeJS.ProcessEnv = process.env,
  isTTY: boolean = Boolean(process.stdout.isTTY),
): ColorLevel {
  if (
    (env.NO_COLOR !== undefined && env.NO_COLOR !== '') ||
    env.FORCE_COLOR === '0' ||
    env.TERM === 'dumb'
  ) {
    return 0;
  }

  if (!isTTY && !env.FORCE_COLOR) {
    return 0;
  }

  if (
    env.FORCE_COLOR === '3' ||
    /truecolor|24bit/i.test(env.COLORTERM ?? '') ||
    env.WT_SESSION ||
    TRUECOLOR_PROGRAMS.has(env.TERM_PROGRAM ?? '')
  ) {
    return 3;
  }

  if (env.FORCE_COLOR === '2' || /256color/i.test(env.TERM ?? '')) {
    return 2;
  }

  return 1;
}

export function parseHexColor(hex?: string | null): { r: number; g: number; b: number } | null {
  if (!hex) {
    return null;
  }
  const cleaned = hex.trim().replace(/^#/, '');
  if (/^[0-9a-fA-F]{6}$/.test(cleaned)) {
    return {
      r: Number.parseInt(cleaned.slice(0, 2), 16),
      g: Number.parseInt(cleaned.slice(2, 4), 16),
      b: Number.parseInt(cleaned.slice(4, 6), 16),
    };
  }
  if (/^[0-9a-fA-F]{3}$/.test(cleaned)) {
    return {
      r: Number.parseInt(cleaned[0]! + cleaned[0]!, 16),
      g: Number.parseInt(cleaned[1]! + cleaned[1]!, 16),
      b: Number.parseInt(cleaned[2]! + cleaned[2]!, 16),
    };
  }
  return null;
}

/**
 * Gently lifts very dark brand colors (e.g. `#000d6f` or `#000000`) so they stay legible on dark terminals.
 */
export function liftDarkRgb(r: number, g: number, b: number): { r: number; g: number; b: number } {
  if (r === 0 && g === 0 && b === 0) {
    return { r: 0, g: 200, b: 220 };
  }
  const luminance = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  if (luminance >= 0.25) {
    return { r, g, b };
  }
  const blend = Math.min(0.65, (0.35 - luminance) / Math.max(0.01, 1 - luminance));
  return {
    r: Math.round(r + (255 - r) * blend),
    g: Math.round(g + (255 - g) * blend),
    b: Math.round(b + (255 - b) * blend),
  };
}

export function rgbToAnsi256(r: number, g: number, b: number): number {
  const toCube = (value: number): number => {
    if (value < 48) {
      return 0;
    }
    if (value < 115) {
      return 1;
    }
    return Math.min(5, Math.floor((value - 35) / 40));
  };
  return 16 + 36 * toCube(r) + 6 * toCube(g) + toCube(b);
}

/**
 * Strips ANSI SGR escape sequences for accurate width calculation and test assertions.
 */
export function stripAnsi(text: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional ANSI CSI escape stripping
  return text.replace(/\u001b\[[0-9;]*m/g, '');
}

export function visibleLength(text: string): number {
  return stripAnsi(text).length;
}

export function padRightVisible(text: string, width: number): string {
  const len = visibleLength(text);
  return len >= width ? text : text + ' '.repeat(width - len);
}

/**
 * Formats a TUSSAM line label using its brand hex color when the terminal supports color.
 */
export function colorizeLineLabel(
  label: string,
  hexColor?: string | null,
  level: ColorLevel = detectColorLevel(),
): string {
  if (level === 0) {
    return label;
  }

  const parsed = parseHexColor(hexColor);
  if (!parsed || level === 1) {
    return pc.cyan(label);
  }

  const { r, g, b } = liftDarkRgb(parsed.r, parsed.g, parsed.b);
  if (level === 3) {
    return `\u001b[1;38;2;${r};${g};${b}m${label}\u001b[0m`;
  }

  const ansi256 = rgbToAnsi256(r, g, b);
  return `\u001b[1;38;5;${ansi256}m${label}\u001b[0m`;
}
