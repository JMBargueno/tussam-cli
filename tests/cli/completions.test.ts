import { describe, expect, it } from 'vitest';
import { TussamValidationError } from '../../src/api/errors.js';
import { SUPPORTED_SHELLS, generateCompletionScript } from '../../src/cli/completions.js';

describe('Shell completions generator', () => {
  it('generates valid completion scripts for bash, zsh, fish, and powershell', () => {
    for (const shell of SUPPORTED_SHELLS) {
      const script = generateCompletionScript(shell);
      expect(script.length).toBeGreaterThan(100);
      expect(script).toContain('tussam-cli');
      expect(script).toContain('fav');
      expect(script).toContain('interactive');
      expect(script).toContain('completion');
      expect(script).toContain('estimate');
      expect(script).toContain('origin-walk');
      expect(script).toContain('dest-walk');
    }

    expect(generateCompletionScript('BASH')).toContain('_tussam_cli_completions');
    expect(generateCompletionScript('zsh')).toContain('#compdef tussam-cli');
    expect(generateCompletionScript('fish')).toContain('__fish_use_subcommand');
    expect(generateCompletionScript('powershell')).toContain('Register-ArgumentCompleter');
  });

  it('throws TussamValidationError for unsupported shells', () => {
    expect(() => generateCompletionScript('tcsh')).toThrow(TussamValidationError);
  });
});
