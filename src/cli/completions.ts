import { TussamValidationError } from '../api/errors.js';

export const SUPPORTED_SHELLS = ['bash', 'zsh', 'fish', 'powershell'] as const;
export type CompletionShell = (typeof SUPPORTED_SHELLS)[number];

const SUBCOMMANDS = [
  'stop',
  'lines',
  'line',
  'nearby',
  'alerts',
  'cache',
  'fav',
  'interactive',
  'completion',
];

const ROOT_FLAGS = [
  '-V',
  '--version',
  '-f',
  '--from',
  '-t',
  '--to',
  '-d',
  '--day',
  '-m',
  '--month',
  '-y',
  '--year',
  '-s',
  '--sort',
  '--after',
  '--limit',
  '--all',
  '--max-transfers',
  '--walk',
  '--origin-walk',
  '--dest-walk',
  '--night',
  '--live',
  '--refresh',
  '--estimate',
  '-i',
  '--interactive',
  '--json',
  '-h',
  '--help',
];

function buildBashCompletion(): string {
  return `# bash completion for tussam-cli
_tussam_cli_completions() {
  local cur prev subcmd
  COMPREPLY=()
  cur="\${COMP_WORDS[COMP_CWORD]}"
  prev="\${COMP_WORDS[COMP_CWORD-1]}"
  subcmd=""

  if [[ \${COMP_CWORD} -ge 2 ]]; then
    subcmd="\${COMP_WORDS[1]}"
  fi

  case "\${subcmd}" in
    stop)
      COMPREPLY=( $(compgen -W "-l --line -w --watch --schedule -d --day -m --month -y --year --no-cache --json -h --help" -- "\${cur}") )
      return 0
      ;;
    lines)
      COMPREPLY=( $(compgen -W "-d --day -m --month -y --year --night --all --json -h --help" -- "\${cur}") )
      return 0
      ;;
    line)
      COMPREPLY=( $(compgen -W "--direction -d --day -m --month -y --year --json -h --help" -- "\${cur}") )
      return 0
      ;;
    nearby)
      COMPREPLY=( $(compgen -W "-r --radius -n --limit --arrivals --json -h --help" -- "\${cur}") )
      return 0
      ;;
    alerts)
      COMPREPLY=( $(compgen -W "-l --line --json -h --help" -- "\${cur}") )
      return 0
      ;;
    cache)
      if [[ \${COMP_CWORD} -eq 2 ]]; then
        COMPREPLY=( $(compgen -W "status sync clear" -- "\${cur}") )
      else
        COMPREPLY=( $(compgen -W "--night --json -h --help" -- "\${cur}") )
      fi
      return 0
      ;;
    fav)
      if [[ \${COMP_CWORD} -eq 2 ]]; then
        COMPREPLY=( $(compgen -W "add rm remove list ls" -- "\${cur}") )
      else
        COMPREPLY=( $(compgen -W "--json -h --help" -- "\${cur}") )
      fi
      return 0
      ;;
    interactive)
      COMPREPLY=( $(compgen -W "--max-transfers --walk --origin-walk --dest-walk --night --estimate --live --json -h --help" -- "\${cur}") )
      return 0
      ;;
    completion|completions)
      if [[ \${COMP_CWORD} -eq 2 ]]; then
        COMPREPLY=( $(compgen -W "bash zsh fish powershell" -- "\${cur}") )
      fi
      return 0
      ;;
  esac

  if [[ "\${cur}" == -* ]]; then
    COMPREPLY=( $(compgen -W "${ROOT_FLAGS.join(' ')}" -- "\${cur}") )
    return 0
  fi

  if [[ \${COMP_CWORD} -eq 1 ]]; then
    COMPREPLY=( $(compgen -W "${SUBCOMMANDS.join(' ')} ${ROOT_FLAGS.join(' ')}" -- "\${cur}") )
  fi
}

complete -F _tussam_cli_completions tussam-cli
`;
}

function buildZshCompletion(): string {
  return `#compdef tussam-cli

_tussam-cli() {
  local -a commands
  commands=(
    'stop:Show live bus arrivals or scheduled passing times for a stop'
    'lines:List active TUSSAM bus and tram lines'
    'line:Show ordered stops and schedule bounds for a TUSSAM line'
    'nearby:Find TUSSAM stops near GPS coordinates'
    'alerts:Show active TUSSAM service notifications and detours'
    'cache:Inspect, sync, or clear the local cache'
    'fav:Manage saved favorite stop aliases'
    'interactive:Launch interactive step-by-step route search'
    'completion:Generate shell completion script'
  )

  _arguments -C \\
    '(-V --version)'{-V,--version}'[Print version information]' \\
    '(-f --from)'{-f,--from}'[Set origin stop (code, name, or favorite)]:origin:' \\
    '(-t --to)'{-t,--to}'[Set destination stop (code, name, or favorite)]:destination:' \\
    '(-d --day)'{-d,--day}'[Set the day]:day:' \\
    '(-m --month)'{-m,--month}'[Set the month]:month:' \\
    '(-y --year)'{-y,--year}'[Set the year]:year:' \\
    '(-s --sort)'{-s,--sort}'[Sort timetable by duration]' \\
    '--after[Show departures at or after HH:MM]:time:' \\
    '--limit[Maximum journeys to display]:limit:' \\
    '--all[Show all journeys for the full day]' \\
    '--max-transfers[Maximum number of transfers (0-3)]:transfers:' \\
    '--walk[Maximum transfer walking distance in meters]:meters:' \\
    '--origin-walk[Maximum origin walking distance in meters]:meters:' \\
    '--dest-walk[Maximum destination walking distance in meters]:meters:' \\
    '--night[Include night lines (A1-A8)]' \\
    '--live[Display live arrivals at the origin stop]' \\
    '--refresh[Force refresh of cached topology and schedules]' \\
    '--estimate[Show offline topology-based estimates without querying schedules]' \\
    '(-i --interactive)'{-i,--interactive}'[Launch interactive step-by-step route search]' \\
    '--json[Output machine-readable JSON]' \\
    '(-h --help)'{-h,--help}'[Display help]' \\
    '1: :->cmds' \\
    '*::arg:->args'

  case "$state" in
    cmds)
      _describe 'command' commands
      ;;
    args)
      case "$line[1]" in
        cache)
          _values 'cache action' status sync clear
          ;;
        fav)
          _values 'fav action' add rm remove list ls
          ;;
        completion|completions)
          _values 'shell' bash zsh fish powershell
          ;;
      esac
      ;;
  esac
}

compdef _tussam-cli tussam-cli
`;
}

function buildFishCompletion(): string {
  return `# fish completion for tussam-cli
complete -c tussam-cli -f

# Subcommands
complete -c tussam-cli -n '__fish_use_subcommand' -a stop -d 'Show live arrivals or schedule for a stop'
complete -c tussam-cli -n '__fish_use_subcommand' -a lines -d 'List active TUSSAM lines'
complete -c tussam-cli -n '__fish_use_subcommand' -a line -d 'Show ordered stops for a line'
complete -c tussam-cli -n '__fish_use_subcommand' -a nearby -d 'Find stops near GPS coordinates'
complete -c tussam-cli -n '__fish_use_subcommand' -a alerts -d 'Show active service alerts'
complete -c tussam-cli -n '__fish_use_subcommand' -a cache -d 'Manage local cache'
complete -c tussam-cli -n '__fish_use_subcommand' -a fav -d 'Manage favorite stop aliases'
complete -c tussam-cli -n '__fish_use_subcommand' -a interactive -d 'Launch interactive route search'
complete -c tussam-cli -n '__fish_use_subcommand' -a completion -d 'Generate shell completions'

# Root options
complete -c tussam-cli -n '__fish_use_subcommand' -s V -l version -d 'Print version information'
complete -c tussam-cli -n '__fish_use_subcommand' -s f -l from -r -d 'Set origin stop'
complete -c tussam-cli -n '__fish_use_subcommand' -s t -l to -r -d 'Set destination stop'
complete -c tussam-cli -n '__fish_use_subcommand' -s d -l day -r -d 'Set the day'
complete -c tussam-cli -n '__fish_use_subcommand' -s m -l month -r -d 'Set the month'
complete -c tussam-cli -n '__fish_use_subcommand' -s y -l year -r -d 'Set the year'
complete -c tussam-cli -n '__fish_use_subcommand' -s s -l sort -d 'Sort timetable by duration'
complete -c tussam-cli -n '__fish_use_subcommand' -l after -r -d 'Filter departures after HH:MM'
complete -c tussam-cli -n '__fish_use_subcommand' -l limit -r -d 'Maximum journeys to display'
complete -c tussam-cli -n '__fish_use_subcommand' -l all -d 'Show all journeys for the day'
complete -c tussam-cli -n '__fish_use_subcommand' -l max-transfers -r -d 'Maximum transfers (0-3)'
complete -c tussam-cli -n '__fish_use_subcommand' -l walk -r -d 'Max transfer walk meters'
complete -c tussam-cli -n '__fish_use_subcommand' -l origin-walk -r -d 'Max origin walk meters'
complete -c tussam-cli -n '__fish_use_subcommand' -l dest-walk -r -d 'Max destination walk meters'
complete -c tussam-cli -n '__fish_use_subcommand' -l night -d 'Include night lines'
complete -c tussam-cli -n '__fish_use_subcommand' -l live -d 'Show live arrivals at origin'
complete -c tussam-cli -n '__fish_use_subcommand' -l refresh -d 'Force refresh cache'
complete -c tussam-cli -n '__fish_use_subcommand' -l estimate -d 'Offline topology estimates'
complete -c tussam-cli -n '__fish_use_subcommand' -s i -l interactive -d 'Interactive route search'
complete -c tussam-cli -n '__fish_use_subcommand' -l json -d 'Output JSON'

# Subcommand arguments
complete -c tussam-cli -n '__fish_seen_subcommand_from cache' -a 'status sync clear'
complete -c tussam-cli -n '__fish_seen_subcommand_from fav' -a 'add rm remove list ls'
complete -c tussam-cli -n '__fish_seen_subcommand_from completion completions' -a 'bash zsh fish powershell'
complete -c tussam-cli -n '__fish_seen_subcommand_from stop' -s l -l line -r -d 'Filter by line'
complete -c tussam-cli -n '__fish_seen_subcommand_from stop' -s w -l watch -d 'Watch live arrivals'
complete -c tussam-cli -n '__fish_seen_subcommand_from stop' -l schedule -d 'Show scheduled times'
complete -c tussam-cli -n '__fish_seen_subcommand_from nearby' -s r -l radius -r -d 'Radius in meters'
complete -c tussam-cli -n '__fish_seen_subcommand_from nearby' -s n -l limit -r -d 'Max stops'
complete -c tussam-cli -n '__fish_seen_subcommand_from nearby' -l arrivals -d 'Include live arrivals'
complete -c tussam-cli -n '__fish_seen_subcommand_from line' -l direction -r -a '1 2 both' -d 'Filter direction'
`;
}

function buildPowerShellCompletion(): string {
  return `# PowerShell completion for tussam-cli
Register-ArgumentCompleter -Native -CommandName 'tussam-cli' -ScriptBlock {
  param($wordToComplete, $commandAst, $cursorPosition)

  $tokens = $commandAst.CommandElements | ForEach-Object { $_.Extent.Text }
  $subcommands = @('stop', 'lines', 'line', 'nearby', 'alerts', 'cache', 'fav', 'interactive', 'completion')
  $rootFlags = @(${ROOT_FLAGS.map((f) => `'${f}'`).join(', ')})

  $subcmd = if ($tokens.Count -ge 2) { $tokens[1] } else { '' }
  $candidates = switch ($subcmd) {
    'cache' { @('status', 'sync', 'clear', '--night', '--json', '-h', '--help') }
    'fav' { @('add', 'rm', 'remove', 'list', 'ls', '--json', '-h', '--help') }
    'completion' { @('bash', 'zsh', 'fish', 'powershell', '-h', '--help') }
    'completions' { @('bash', 'zsh', 'fish', 'powershell', '-h', '--help') }
    'stop' { @('-l', '--line', '-w', '--watch', '--schedule', '-d', '--day', '-m', '--month', '-y', '--year', '--no-cache', '--json', '-h', '--help') }
    'lines' { @('-d', '--day', '-m', '--month', '-y', '--year', '--night', '--all', '--json', '-h', '--help') }
    'line' { @('--direction', '-d', '--day', '-m', '--month', '-y', '--year', '--json', '-h', '--help') }
    'nearby' { @('-r', '--radius', '-n', '--limit', '--arrivals', '--json', '-h', '--help') }
    'alerts' { @('-l', '--line', '--json', '-h', '--help') }
    'interactive' { @('--max-transfers', '--walk', '--origin-walk', '--dest-walk', '--night', '--estimate', '--live', '--json', '-h', '--help') }
    default { $subcommands + $rootFlags }
  }

  $candidates |
    Where-Object { $_ -like "$wordToComplete*" } |
    ForEach-Object { [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', $_) }
}
`;
}

/**
 * Generates a self-contained shell completion script for bash, zsh, fish, or PowerShell.
 */
export function generateCompletionScript(shell: string): string {
  const normalized = shell.trim().toLowerCase();
  switch (normalized) {
    case 'bash':
      return buildBashCompletion();
    case 'zsh':
      return buildZshCompletion();
    case 'fish':
      return buildFishCompletion();
    case 'powershell':
      return buildPowerShellCompletion();
    default:
      throw new TussamValidationError(
        `Unsupported shell '${shell}'. Expected one of: ${SUPPORTED_SHELLS.join(', ')}.`,
      );
  }
}
