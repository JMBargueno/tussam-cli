import pc from 'picocolors';
import type { LineRoute } from '../tussam.js';
import type {
  CacheStatus,
  Journey,
  Line,
  NearbyStop,
  ServiceAlert,
  StopArrivalsResult,
} from '../types.js';
import { formatDurationHHMM, formatSecondsToHHMM } from '../utils/time.js';

function padRight(value: string, width: number): string {
  return value.length >= width ? value : value + ' '.repeat(width - value.length);
}

function padLeft(value: string, width: number): string {
  return value.length >= width ? value : ' '.repeat(width - value.length) + value;
}

function centerText(value: string, width: number): string {
  if (value.length >= width) {
    return value;
  }
  const totalPad = width - value.length;
  const left = Math.floor(totalPad / 2);
  const right = totalPad - left;
  return ' '.repeat(left) + value + ' '.repeat(right);
}

export interface TimetableFormatOptions {
  totalCount?: number;
  limited?: boolean;
}

export function formatTimetable(
  journeys: readonly Journey[],
  options: TimetableFormatOptions = {},
): string {
  if (journeys.length === 0) {
    return '\nNo schedules available for this route.';
  }

  const linesLabels = journeys.map((j) => j.legs.map((l) => l.lineLabel).join(' → '));
  const linesWidth = Math.max(22, ...linesLabels.map((s) => s.length));
  const totalWidth = 2 + linesWidth + 3 + 9 + 3 + 7 + 3 + 8 + 3 + 9;
  const eqBar = '='.repeat(Math.max(73, totalWidth));
  const dashBar = '-'.repeat(Math.max(73, totalWidth));
  const titleBar = (() => {
    const title = 'TIMETABLE';
    const side = Math.max(10, Math.floor((eqBar.length - title.length) / 2));
    const rem = Math.max(10, eqBar.length - title.length - side);
    return `${'='.repeat(side)}${title}${'='.repeat(rem)}`;
  })();

  const out: string[] = [
    '',
    pc.bold(titleBar),
    `  ${padRight('Lines', linesWidth)} | Departure | Arrival | Duration | Transfers`,
  ];

  journeys.forEach((journey, index) => {
    out.push(dashBar);
    const linesText = linesLabels[index]!;
    const depText = formatSecondsToHHMM(journey.departureSeconds);
    const arrText = `${journey.estimated ? '~' : ''}${formatSecondsToHHMM(journey.arrivalSeconds)}`;
    const durText = `${journey.estimated ? '~' : ''}${formatDurationHHMM(journey.durationSeconds)}`;
    const trText = String(journey.transferCount);

    out.push(
      `  ${pc.cyan(padRight(linesText, linesWidth))} | ${centerText(depText, 9)} | ${centerText(arrText, 7)} | ${centerText(durText, 8)} | ${centerText(trText, 9)}`,
    );

    journey.transfers.forEach((transfer, trIdx) => {
      const arr = formatSecondsToHHMM(transfer.arrivalSeconds);
      const dep = formatSecondsToHHMM(transfer.departureSeconds);
      const wait = formatDurationHHMM(transfer.waitSeconds);
      if (transfer.walkMeters > 0) {
        const walkMin = Math.max(1, Math.ceil(transfer.walkSeconds / 60));
        out.push(
          pc.dim(
            `      Transfer ${trIdx + 1} at ${transfer.fromStopName} (#${transfer.fromStopCode}) → ${transfer.toStopName} (#${transfer.toStopCode}): walk ${transfer.walkMeters}m (${walkMin} min), arrive ${arr}, depart ${dep} (${wait})`,
          ),
        );
      } else {
        out.push(
          pc.dim(
            `      Transfer ${trIdx + 1} at ${transfer.fromStopName} (#${transfer.fromStopCode}): arrive ${arr}, depart ${dep} (${wait})`,
          ),
        );
      }
    });
  });

  out.push(pc.bold(eqBar));

  if (journeys.some((j) => j.estimated)) {
    out.push(pc.dim('~ Estimated arrival time interpolated from route distance.'));
  }

  if (options.limited && options.totalCount !== undefined && options.totalCount > journeys.length) {
    out.push(
      pc.dim(
        `Showing ${journeys.length} of ${options.totalCount} journeys. Pass --all to view the full day timetable.`,
      ),
    );
  }

  return out.join('\n');
}

export function formatArrivalsTable(result: StopArrivalsResult, filterLine?: string): string {
  const normalizedFilter = filterLine?.trim().toUpperCase();
  const filtered = normalizedFilter
    ? result.arrivals.filter((a) => {
        const lbl = a.lineLabel.toUpperCase();
        return (
          lbl === normalizedFilter ||
          (/^\d$/.test(normalizedFilter) && lbl === `0${normalizedFilter}`) ||
          (/^0\d$/.test(normalizedFilter) && lbl === normalizedFilter.slice(1))
        );
      })
    : result.arrivals;

  const title = result.stopName
    ? `Stop #${result.stopCode} — ${result.stopName}`
    : `Stop #${result.stopCode}`;

  const out: string[] = ['', pc.bold(title)];
  if (result.stale) {
    out.push(pc.yellow('[WARN] Showing cached arrival times (TUSSAM upstream unavailable).'));
  }

  if (filtered.length === 0) {
    out.push('No upcoming bus arrivals reported at this time.');
    return out.join('\n');
  }

  const destWidth = Math.max(18, ...filtered.map((a) => a.destination.length));
  const bar = '-'.repeat(6 + 3 + destWidth + 3 + 7 + 3 + 9 + 3 + 8);

  out.push(bar);
  out.push(
    `  ${padRight('Line', 6)} | ${padRight('Destination', destWidth)} | ${padLeft('ETA', 7)} | ${padLeft('Distance', 9)} | ${padLeft('Vehicle', 8)}`,
  );
  out.push(bar);

  for (const arrival of filtered) {
    const eta = arrival.seconds < 60 ? pc.green('Now') : `${arrival.minutes} min`;
    const etaPlainLen = arrival.seconds < 60 ? 3 : `${arrival.minutes} min`.length;
    const etaPadded = ' '.repeat(Math.max(0, 7 - etaPlainLen)) + eta;
    const dist =
      arrival.distanceMeters !== null ? `${arrival.distanceMeters.toLocaleString('en-US')} m` : '-';
    const veh = arrival.vehicle !== null ? `#${arrival.vehicle}` : '-';

    out.push(
      `  ${pc.cyan(padRight(arrival.lineLabel, 6))} | ${padRight(arrival.destination, destWidth)} | ${etaPadded} | ${padLeft(dist, 9)} | ${padLeft(veh, 8)}`,
    );
  }
  out.push(bar);

  return out.join('\n');
}

export function formatStopScheduleTable(
  stopCode: string,
  stopName: string,
  entries: Array<{ lineLabel: string; times: string[] }>,
  dateLabel: string,
): string {
  const title = stopName ? `Stop #${stopCode} — ${stopName}` : `Stop #${stopCode}`;
  const out: string[] = ['', pc.bold(`${title} (Scheduled passing times for ${dateLabel})`)];

  for (const entry of entries) {
    out.push('');
    out.push(pc.cyan(pc.bold(`Line ${entry.lineLabel} (${entry.times.length} departures)`)));
    if (entry.times.length === 0) {
      out.push('  No scheduled passing times.');
      continue;
    }

    const formatted = entry.times.map((t) => t.slice(0, 5));
    const perRow = 8;
    for (let i = 0; i < formatted.length; i += perRow) {
      out.push(`  ${formatted.slice(i, i + perRow).join('  ')}`);
    }
  }

  return out.join('\n');
}

export function formatLinesTable(lines: readonly Line[]): string {
  if (lines.length === 0) {
    return '\nNo lines available for the selected time/date.';
  }

  const descWidth = Math.max(24, ...lines.map((l) => l.description.length));
  const bar = '-'.repeat(6 + 3 + 13 + 3 + 13 + 3 + descWidth + 4);
  const out: string[] = [
    '',
    bar,
    `  ${padRight('Line', 6)} | ${padRight('Type', 13)} | ${padRight('Hours', 13)} | ${padRight('Description', descWidth)}`,
    bar,
  ];

  for (const line of lines) {
    const type = line.isCircular ? 'Circular' : 'Bidirectional';
    const firstDir = line.directions[0];
    const hours =
      firstDir && firstDir.startTime && firstDir.endTime
        ? `${firstDir.startTime}-${firstDir.endTime}`
        : '-';
    out.push(
      `  ${pc.cyan(padRight(line.label, 6))} | ${padRight(type, 13)} | ${padRight(hours, 13)} | ${line.description}`,
    );
  }
  out.push(bar);
  out.push(pc.dim(`Total: ${lines.length} lines`));

  return out.join('\n');
}

export function formatLineRoute(
  route: LineRoute,
  directionFilter: '1' | '2' | 'both' = 'both',
): string {
  const out: string[] = ['', pc.bold(`Line ${route.line.label} — ${route.line.description}`)];

  const selectedDirections = route.directions.filter((d) => {
    if (directionFilter === 'both') {
      return true;
    }
    if (route.line.isCircular) {
      return true;
    }
    return String(d.info.direction) === directionFilter;
  });

  if (selectedDirections.length === 0) {
    out.push('No route directions matched the requested filter.');
    return out.join('\n');
  }

  for (const dir of selectedDirections) {
    const hours =
      dir.info.startTime && dir.info.endTime ? ` (${dir.info.startTime}–${dir.info.endTime})` : '';
    out.push('');
    out.push(pc.cyan(pc.bold(`Direction ${dir.info.direction}: ${dir.info.destination}${hours}`)));

    const nameWidth = Math.max(24, ...dir.stops.map((s) => s.name.length));
    const bar = '-'.repeat(6 + 3 + nameWidth + 3 + 8 + 3 + 11 + 3 + 15);
    out.push(bar);
    out.push(
      `  ${padRight('Code', 6)} | ${padRight('Stop Name', nameWidth)} | ${padLeft('Dist', 8)} | ${padRight('Hours', 11)} | Connections`,
    );
    out.push(bar);

    for (const stop of dir.stops) {
      const dist = `${stop.distanceMeters} m`;
      const hrs = stop.startTime && stop.endTime ? `${stop.startTime}-${stop.endTime}` : '-';
      const conns = stop.icons.map((i) => `[${i}]`).join(' ');
      out.push(
        `  ${padRight(stop.code, 6)} | ${padRight(stop.name, nameWidth)} | ${padLeft(dist, 8)} | ${padRight(hrs, 11)} | ${conns}`,
      );
    }
    out.push(bar);
  }

  return out.join('\n');
}

export function formatNearbyTable(stops: readonly NearbyStop[]): string {
  if (stops.length === 0) {
    return '\nNo TUSSAM stops found within the requested radius.';
  }

  const nameWidth = Math.max(20, ...stops.map((s) => s.name.length));
  const bar = '-'.repeat(6 + 3 + 8 + 3 + nameWidth + 3 + 22);
  const out: string[] = [
    '',
    bar,
    `  ${padRight('Code', 6)} | ${padLeft('Distance', 8)} | ${padRight('Stop Name', nameWidth)} | Lines`,
    bar,
  ];

  for (const stop of stops) {
    const dist = `${stop.distanceMeters} m`;
    const lines = stop.lines.map((l) => l.label).join(', ');
    out.push(
      `  ${pc.cyan(padRight(stop.code, 6))} | ${padLeft(dist, 8)} | ${padRight(stop.name, nameWidth)} | ${lines}`,
    );

    if (stop.arrivals && stop.arrivals.arrivals.length > 0) {
      const top = stop.arrivals.arrivals
        .slice(0, 3)
        .map((a) => `${a.lineLabel}: ${a.seconds < 60 ? 'Now' : `${a.minutes}m`}`)
        .join(' · ');
      out.push(pc.dim(`      Next: ${top}`));
    }
  }
  out.push(bar);

  return out.join('\n');
}

export function formatAlerts(alerts: readonly ServiceAlert[]): string {
  if (alerts.length === 0) {
    return '\nNo active TUSSAM service alerts.';
  }

  const out: string[] = ['', pc.bold(`Active TUSSAM Service Alerts (${alerts.length}):`)];
  for (const alert of alerts) {
    const lines = alert.lines.length > 0 ? alert.lines.join(', ') : 'General';
    out.push('');
    out.push(`  ${pc.yellow(`[Lines: ${lines}]`)} ${alert.content}`);
    if (alert.createdAt || alert.expiresAt) {
      out.push(pc.dim(`  Window: ${alert.createdAt || '?'} → ${alert.expiresAt || '?'}`));
    }
  }
  return out.join('\n');
}

export function formatCacheStatus(status: CacheStatus): string {
  const sizeKb = (status.totalBytes / 1024).toFixed(1);
  return [
    '',
    pc.bold('TUSSAM CLI Cache Status'),
    `  Directory:   ${status.cacheDir}`,
    `  Stop index:  ${status.stopIndex.present ? `${status.stopIndex.count} stops (${status.stopIndex.fresh ? 'fresh' : 'expired'})` : 'not cached'}`,
    `  Topology:    ${status.topology.present ? `${status.topology.linesCount} lines, ${status.topology.stopsCount} stops (${status.topology.fresh ? 'fresh' : 'expired'}${status.topology.includesNight ? ', incl. night' : ''})` : 'not cached'}`,
    `  Schedules:   ${status.schedulesCount} cached files`,
    `  Arrivals:    ${status.arrivalsCount} cached files`,
    `  Total size:  ${sizeKb} KB`,
  ].join('\n');
}
