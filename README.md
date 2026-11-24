# TUSSAM Bus Timetables & Live CLI

Get fast **TUSSAM (Transportes Urbanos de Sevilla)** bus and Metrocentro tram timetables, route transfers, and live arrival times directly in your terminal — built in TypeScript and inspired by [`gerardcl/renfe-cli`](https://github.com/gerardcl/renfe-cli).

No longer need to open the browser! Just keep using your terminal.

## Features

- **Point-to-Point Route & Timetable Search** (`-f`, `-t`, `-d`, `-m`, `-y`, `-s`) supporting direct rides, circular loops (`C1`–`C6B`), same-stop transfers, and nearby walking transfers (up to 3 transfers).
- **Date-Aware Schedules**: Automatically retrieves weekday, Saturday, or Sunday/holiday timetables.
- **Interactive Stop Disambiguation**: Match stops by numeric stop code (`43`) or accent- and case-insensitive name (`puerta carmona`).
- **Real-Time Subcommands**:
  - `stop <query>` — Live bus countdown board (`--watch` auto-refresh, `--schedule` for full day timetable).
  - `lines` & `line <label>` — Active line catalog and ordered stop lists with intermodal badges.
  - `nearby <lat> <lon>` — Closest stops with exact Haversine distance (`--arrivals` for live ETAs).
  - `alerts` — Active service notifications and detours.
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

Fast CLI and TypeScript library for TUSSAM Seville bus timetables and real-time arrivals

Options:
  -V, --version          Print version information
  -f, --from <origin>    Set origin stop (code or name)
  -t, --to <destination> Set destination stop (code or name)
  -d, --day <day>        Set the day (default: today)
  -m, --month <month>    Set the month (default: today)
  -y, --year <year>      Set the year (default: today)
  -s, --sort             Sort timetable by duration
  --after <HH:MM>        Show departures at or after HH:MM
  --limit <n>            Maximum journeys to display (default: 15)
  --all                  Show all journeys for the full day
  --max-transfers <n>    Maximum number of transfers (0-3) (default: "2")
  --walk <meters>        Maximum walking distance for transfers in meters (default: "300")
  --night                Include night lines (A1-A8)
  --live                 Also display live arrival estimates at the origin stop
  --refresh              Force refresh of cached network topology and schedules
  --json                 Output machine-readable JSON
  -h, --help             display help for command
```

### Point-to-Point Timetable

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

By default, up to **15 upcoming journeys** are shown; pass `--all` for the full day timetable.

### Real-Time Stop Arrivals

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

Use `-w` (`--watch`) to auto-refresh live arrivals, or `--schedule` for scheduled departure times.

### Caching

Network topology (synced rapidly in 3 requests from Seville's public ArcGIS TUSSAM layers and cached 7 days), stop index (7 days), date-specific schedules from `reddelineas.tussam.es` (24 h), and live arrivals (15 s fresh, 5 min stale fallback) are stored in your OS user cache directory. Set `TUSSAM_CLI_CACHE_DIR` to override the location:

```bash
tussam-cli cache status
tussam-cli cache sync
tussam-cli cache clear
```

---

## Usage (Library)

```ts
import { Tussam } from 'tussam-cli';

const tussam = new Tussam();

const matches = await tussam.matchStops('puerta carmona');
console.log(matches.map((s) => `${s.code}: ${s.name}`));

const arrivals = await tussam.getStopArrivals('43');
console.log(arrivals.arrivals);

const { journeys } = await tussam.findSchedules({
  fromStopCode: '785',
  toStopCode: '58',
  date: new Date(),
  sortByDuration: true,
});
console.log(journeys.slice(0, 5));
```

---

## Development

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
```
