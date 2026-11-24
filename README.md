# TUSSAM Bus Timetables & Live CLI

Get fast **TUSSAM (Transportes Urbanos de Sevilla)** bus and Metrocentro tram timetables, smart multi-modal route transfers, and live arrival times directly in your terminal — built in TypeScript and inspired by [`gerardcl/renfe-cli`](https://github.com/gerardcl/renfe-cli).

No longer need to open the browser! Just keep using your terminal.

## Features

- **Point-to-Point Route & Timetable Search** (`-f`, `-t`, `-d`, `-m`, `-y`, `-s`) supporting direct rides, circular loops (`C1`–`C6B`), same-stop transfers, nearby walking transfers (up to 3 transfers), and **origin/destination access walks** (`--origin-walk`, `--dest-walk`, default `200 m`) so nearby opposite-sidewalk stops are considered automatically.
- **Rate-Limit Resilience & Offline Estimates (`--estimate`)**: Progressive batch schedule hydration with an invocation circuit breaker on HTTP `429`, bounded retry waits (`maxRetryWaitMs`), partial-result warnings on `stderr`, and instant offline topology-based route estimates via `--estimate`.
- **Date-Aware Schedules**: Automatically retrieves weekday, Saturday, or Sunday/holiday timetables.
- **Interactive Mode & Stop Disambiguation**: Step-by-step guided search (`-i` / `--interactive` or `tussam-cli interactive`) plus accent- and case-insensitive stop disambiguation.
- **Saved Stop Favorites (`fav`)**: Save personal stop aliases (`tussam-cli fav add casa 43`) in your OS config directory (`TUSSAM_CLI_CONFIG_DIR`) and use them directly in `stop casa` or `-f casa -t trabajo`.
- **True-Color Line Badges & Smooth `--watch`**: Renders real TUSSAM hex line colors on compatible terminals (respecting `NO_COLOR` and pipes), and updates `stop --watch` cleanly with last-updated timestamps and a 1-second countdown.
- **Shell Completions**: Built-in completion script generator (`tussam-cli completion <bash|zsh|fish|powershell>`).
- **Real-Time Subcommands**:
  - `stop <query>` — Live bus countdown board (`--watch` auto-refresh, `--schedule` for full day timetable).
  - `lines` & `line <label>` — Active line catalog and ordered stop lists with intermodal badges.
  - `nearby <lat> <lon>` — Closest stops with exact Haversine distance (`--arrivals` for live ETAs).
  - `alerts` — Active service notifications and detours.
  - `fav <add|rm|list>` — Manage favorite stop aliases.
  - `interactive` — Guided interactive route search.
  - `completion <shell>` — Generate shell completions.
  - `cache <status|sync|clear>` — Manage local disk cache (`TUSSAM_CLI_CACHE_DIR`).
- **Importable TypeScript / Node.js ESM Library**: Full type definitions included (`dist/index.d.ts`).

---

## Installation

Requires **Node.js 22+**.

```bash
pnpm install -g tussam-cli
# or using npm:
npm install -g tussam-cli
```

Or run directly from source during development:

```bash
pnpm install
pnpm build
node dist/cli.js --help
```

---

## Usage (CLI)

```text
$ tussam-cli --help
Usage: tussam-cli [options] [command]

Fast CLI and TypeScript library for TUSSAM Seville bus timetables and real-time
arrivals

Options:
  -V, --version                             Print version information
  -f, --from <origin>                       Set origin stop (code, name, or favorite)
  -t, --to <destination>                    Set destination stop (code, name, or favorite)
  -d, --day <day>                           Set the day (default: today)
  -m, --month <month>                       Set the month (default: today)
  -y, --year <year>                         Set the year (default: today)
  -s, --sort                                Sort timetable by duration
  --after <HH:MM>                           Show departures at or after HH:MM
  --limit <n>                               Maximum journeys to display (default: "15")
  --all                                     Show all journeys for the full day
  --max-transfers <n>                       Maximum number of transfers (0-3) (default: "2")
  --walk <meters>                           Maximum walking distance for transfers in meters (default: "300")
  --origin-walk <meters>                    Maximum initial walking distance to a nearby stop in meters (default: "200")
  --dest-walk <meters>                      Maximum final walking distance from a nearby stop in meters (default: "200")
  --night                                   Include night lines (A1-A8)
  --live                                    Also display live arrival estimates at the origin stop
  --refresh                                 Force refresh of cached network topology and schedules
  --estimate                                Use offline topology-based route estimates without querying TUSSAM schedule APIs
  -i, --interactive                         Launch interactive step-by-step route search
  --json                                    Output machine-readable JSON
  -h, --help                                display help for command

Commands:
  interactive [options]                     Launch interactive step-by-step route search
  stop [options] <query>                    Show live bus arrivals (or scheduled passing times with --schedule) for a stop
  lines [options]                           List active TUSSAM bus and tram lines
  line [options] <label>                    Show ordered stops and schedule bounds for a TUSSAM line
  nearby [options] <lat> <lon>              Find TUSSAM stops near GPS coordinates
  alerts [options]                          Show active TUSSAM service notifications and detours
  fav [options] <action> [alias] [stop...]  Manage saved favorite stop aliases (add | rm | list)
  completion|completions [shell]            Generate shell completion script (bash | zsh | fish | powershell)
  cache [options] <action>                  Inspect, sync, or clear the local cache (status | sync | clear)
```

### Point-to-Point Timetable & Opposite-Sidewalk Routing

```bash
$ tussam-cli -f "puerta osario" -t "hospital v.rocio" -d 29 -m 11 -y 2026 -s
Multiple stops match 'puerta osario':
  1. José Laguillo (Puerta Osario) [#784] (Lines: 32, C1)
  2. María Auxiliadora (Puerta Osario) [#22] (Lines: 01, C4)
  3. María Auxiliadora (Puerta Osario) [#785] (Lines: 01, C3)
Select a stop [1-3]: 3

================================TIMETABLE================================
  Lines                  | Departure | Arrival | Duration | Transfers
-------------------------------------------------------------------------
  01                     |   07:38   |  07:57  |  00:19   |     0
-------------------------------------------------------------------------
  01                     |   08:02   |  08:21  |  00:19   |     0
=========================================================================
```

By default, up to **15 upcoming journeys** are shown; pass `--all` for the full day timetable, or `--estimate` to compute instant offline topology-based estimates without hitting `reddelineas.tussam.es`.

When a nearby stop within `--origin-walk` / `--dest-walk` (default `200 m`) offers a direct or faster connection (e.g., crossing to the opposite sidewalk from `#43` Recaredo to `#2` Menéndez Pelayo for direct Line `01` to `#58`), `TIMETABLE` displays `Start walk:` / `End walk:` guidance automatically. Pass `--origin-walk 0 --dest-walk 0` to restrict strictly to the exact stop (while still printing an optional walk tip if a better nearby option exists).

### Real-Time Stop Arrivals & Watch Mode

```bash
$ tussam-cli stop 43

Stop #43 — Recaredo (Puerta Carmona)
-------------------------------------------------------------------
  Line   | Destination        |     ETA |  Distance |  Vehicle
-------------------------------------------------------------------
  C4     | PLAZA DE ARMAS     |     Now |      39 m |     #243
  01     | POLIGONO NORTE     |   8 min |   1,205 m |    #1062
  C4     | PLAZA DE ARMAS     |  21 min |   3,416 m |     #244
-------------------------------------------------------------------
```

Use `-w` (`--watch [seconds]`) to auto-refresh live arrivals with a clean timestamp and countdown (`Ctrl+C` exits immediately), or `--schedule` for scheduled passing times.

### Favorites, Interactive Mode & Shell Completions

```bash
# Save and use favorite stop aliases (persisted under TUSSAM_CLI_CONFIG_DIR)
tussam-cli fav add casa 43
tussam-cli fav add trabajo "hospital v.rocio"
tussam-cli fav list
tussam-cli stop casa
tussam-cli -f casa -t trabajo --estimate

# Step-by-step interactive search
tussam-cli -i

# Generate shell completions (bash | zsh | fish | powershell)
tussam-cli completion bash > ~/.local/share/bash-completion/completions/tussam-cli
tussam-cli completion zsh > ~/.zsh/completions/_tussam-cli
tussam-cli completion fish > ~/.config/fish/completions/tussam-cli.fish
tussam-cli completion powershell | Out-String | Invoke-Expression
```

### Caching & Configuration

Network topology (synced rapidly in 3 requests from Seville's public ArcGIS TUSSAM layers and cached 7 days), stop index (7 days), date-specific schedules from `reddelineas.tussam.es` (24 h), and live arrivals (15 s fresh, 5 min stale fallback) are stored in your OS user cache directory. Favorite stop aliases are stored in your OS user config directory.

- Override cache directory with `TUSSAM_CLI_CACHE_DIR`.
- Override config directory with `TUSSAM_CLI_CONFIG_DIR`.
- Set `NO_COLOR=1` to disable ANSI colors in terminal output.

```bash
tussam-cli cache status
tussam-cli cache sync
tussam-cli cache clear
```

---

## Usage (Library)

```ts
import { FavoritesStore, Tussam } from 'tussam-cli';

const tussam = new Tussam({
  clientOptions: { maxRetryWaitMs: 8_000 },
});

const matches = await tussam.matchStops('puerta carmona');
console.log(matches.map((s) => `${s.code}: ${s.name}`));

const arrivals = await tussam.getStopArrivals('43');
console.log(arrivals.arrivals);

const { journeys, rateLimited, warnings, walkSuggestion } = await tussam.findSchedules({
  fromStopCode: '43',
  toStopCode: '58',
  date: new Date(),
  sortByDuration: true,
  estimate: false,
});
console.log({ count: journeys.length, rateLimited, warnings, walkSuggestion });

const favorites = new FavoritesStore();
console.log(await favorites.list());
```

---

## Development

```bash
pnpm install
pnpm lint
pnpm format
pnpm typecheck
pnpm test
pnpm build
pnpm pack --dry-run
```
