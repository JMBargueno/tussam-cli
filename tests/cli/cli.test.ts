import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import pkg from '../../package.json' with { type: 'json' };
import { TussamClient } from '../../src/api/client.js';
import { CacheStore } from '../../src/cache/store.js';
import { runCli } from '../../src/cli/program.js';
import { FavoritesStore } from '../../src/config/favorites.js';
import { Tussam } from '../../src/tussam.js';
import type { NetworkTopology } from '../../src/types.js';

const execFileAsync = promisify(execFile);
const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

function captureStream(): { stream: PassThrough; read: () => string } {
  const stream = new PassThrough();
  const chunks: Buffer[] = [];
  stream.on('data', (chunk: Buffer) => chunks.push(chunk));
  return {
    stream,
    read: () => Buffer.concat(chunks).toString('utf8'),
  };
}

function makeSeedTopology(): NetworkTopology {
  const line01 = {
    id: 1,
    label: '01',
    subline: 110,
    description: 'Plg. Norte - H. Virgen del Rocio',
    color: '#f54129',
    isCircular: false,
    directions: [
      {
        direction: 1,
        destination: 'HOSPITAL V.ROCIO',
        startTime: '06:00',
        endTime: '23:30',
      },
    ],
  };
  const lineC4 = {
    id: 84,
    label: 'C4',
    subline: 8410,
    description: 'Circular Interior',
    color: '#008431',
    isCircular: true,
    directions: [
      {
        direction: 99,
        destination: 'CIRCULAR',
        startTime: '06:00',
        endTime: '23:30',
      },
    ],
  };
  const line32 = {
    id: 32,
    label: '32',
    subline: 3210,
    description: 'Poligono Sur - Ponce de Leon',
    color: '#000d6f',
    isCircular: false,
    directions: [
      {
        direction: 1,
        destination: 'HOSPITAL V.ROCIO',
        startTime: '06:00',
        endTime: '23:30',
      },
    ],
  };

  return {
    schemaVersion: 1,
    syncedAt: new Date().toISOString(),
    includesNight: true,
    lines: {
      '1': line01,
      '84': lineC4,
      '32': line32,
    },
    stops: {
      '43': {
        code: '43',
        name: 'Recaredo (Puerta Carmona)',
        lat: 37.3896,
        lon: -5.9842,
        lines: [{ lineId: 84, label: 'C4', color: '#008431' }],
      },
      '2': {
        code: '2',
        name: 'Menéndez Pelayo (Puerta Carmona)',
        lat: 37.3883,
        lon: -5.9842,
        lines: [{ lineId: 1, label: '01', color: '#f54129' }],
      },
      MID: {
        code: 'MID',
        name: 'Ronda Histórica',
        lat: 37.405,
        lon: -5.9842,
        lines: [
          { lineId: 84, label: 'C4', color: '#008431' },
          { lineId: 32, label: '32', color: '#000d6f' },
        ],
      },
      '58': {
        code: '58',
        name: 'Manuel Siurot (Hospital V.Rocio)',
        lat: 37.3611,
        lon: -5.9815,
        lines: [
          { lineId: 1, label: '01', color: '#f54129' },
          { lineId: 32, label: '32', color: '#000d6f' },
        ],
      },
    },
    lineStops: {
      '1:1': [
        {
          code: '2',
          name: 'Menéndez Pelayo (Puerta Carmona)',
          lat: 37.3883,
          lon: -5.9842,
          distanceMeters: 0,
          startTime: '06:00',
          endTime: '23:30',
          icons: [],
        },
        {
          code: '58',
          name: 'Manuel Siurot (Hospital V.Rocio)',
          lat: 37.3611,
          lon: -5.9815,
          distanceMeters: 3500,
          startTime: '06:12',
          endTime: '23:42',
          icons: [],
        },
      ],
      '84:99': [
        {
          code: '43',
          name: 'Recaredo (Puerta Carmona)',
          lat: 37.3896,
          lon: -5.9842,
          distanceMeters: 0,
          startTime: '06:00',
          endTime: '23:30',
          icons: [],
        },
        {
          code: 'MID',
          name: 'Ronda Histórica',
          lat: 37.405,
          lon: -5.9842,
          distanceMeters: 3800,
          startTime: '06:16',
          endTime: '23:46',
          icons: [],
        },
      ],
      '32:1': [
        {
          code: 'MID',
          name: 'Ronda Histórica',
          lat: 37.405,
          lon: -5.9842,
          distanceMeters: 0,
          startTime: '06:00',
          endTime: '23:30',
          icons: [],
        },
        {
          code: '58',
          name: 'Manuel Siurot (Hospital V.Rocio)',
          lat: 37.3611,
          lon: -5.9815,
          distanceMeters: 6200,
          startTime: '06:22',
          endTime: '23:52',
          icons: [],
        },
      ],
    },
  };
}

function makeMockFetch(
  options: { rateLimitAll?: boolean; rateLimitTransfer?: boolean } = {},
): typeof fetch {
  const topology = makeSeedTopology();
  return async (input) => {
    const url = String(input);

    if (url.includes('/API/infotus-ui/tiempos/')) {
      return new Response(
        JSON.stringify({
          result: {
            codigo: 43,
            descripcion: { texto: 'Recaredo (Puerta Carmona)' },
            posicion: { latitudE6: 37389600, longitudE6: -5984200 },
            lineasCoincidentes: [
              {
                lineaId: 84,
                labelLinea: 'C4',
                color: '#008431',
                estimaciones: [
                  {
                    vehiculo: 243,
                    destino: { texto: 'PLAZA DE ARMAS' },
                    distancia: 120,
                    segundos: 40,
                  },
                ],
              },
            ],
          },
        }),
        { status: 200 },
      );
    }

    if (url.includes('/API/infotus-ui/lineas/')) {
      const lineasDisponibles = Object.values(topology.lines).map((l) => ({
        linea: l.id,
        labelLinea: l.label,
        sublinea: l.subline,
        descripcion: { texto: l.description },
        color: l.color,
        destinos: l.directions.map((d) => ({
          sentido: d.direction,
          destino: { texto: d.destination },
          horaInicio: d.startTime,
          horaFin: d.endTime,
        })),
      }));
      return new Response(JSON.stringify({ result: { lineasDisponibles } }), { status: 200 });
    }

    if (url.includes('/API/infotus-ui/nodosLinea/1/1/')) {
      const nodes = (topology.lineStops['1:1'] ?? []).map((s) => ({
        codigo: s.code,
        descripcion: { texto: s.name, iconos: s.icons },
        posicion: {
          latitudE6: Math.round((s.lat ?? 0) * 1_000_000),
          longitudE6: Math.round((s.lon ?? 0) * 1_000_000),
        },
        distancia: s.distanceMeters,
        horaInicio: s.startTime,
        horaFin: s.endTime,
      }));
      return new Response(JSON.stringify({ result: nodes }), { status: 200 });
    }

    if (url.includes('/API/infotus-ui/notificaciones/activas')) {
      return new Response(
        JSON.stringify({
          result: [
            {
              id: 101,
              creacion: '24-11-2026T08:00:00',
              caducidad: '24-11-2026T22:00:00',
              lineas: ['01'],
              contenido: 'Planned lane adjustment near Prado',
              tipo: 'Notification',
            },
          ],
        }),
        { status: 200 },
      );
    }

    if (url.includes('/API/infotus-ui/horarios/')) {
      if (options.rateLimitAll) {
        return new Response('Too Many Requests', { status: 429, headers: { 'Retry-After': '60' } });
      }
      if (url.includes('/horarios/2/1/')) {
        return new Response(JSON.stringify({ result: { horarios: ['08:05:00', '08:25:00'] } }), {
          status: 200,
        });
      }
      if (url.includes('/horarios/58/1/')) {
        return new Response(JSON.stringify({ result: { horarios: ['08:17:00', '08:37:00'] } }), {
          status: 200,
        });
      }
      if (options.rateLimitTransfer) {
        return new Response('Too Many Requests', { status: 429, headers: { 'Retry-After': '60' } });
      }
      if (url.includes('/horarios/43/84/')) {
        return new Response(JSON.stringify({ result: { horarios: ['08:00:00'] } }), {
          status: 200,
        });
      }
      if (url.includes('/horarios/MID/84/')) {
        return new Response(JSON.stringify({ result: { horarios: ['08:16:00'] } }), {
          status: 200,
        });
      }
      if (url.includes('/horarios/MID/32/')) {
        return new Response(JSON.stringify({ result: { horarios: ['08:22:00'] } }), {
          status: 200,
        });
      }
      if (url.includes('/horarios/58/32/')) {
        return new Response(JSON.stringify({ result: { horarios: ['08:44:00'] } }), {
          status: 200,
        });
      }
    }

    return new Response('Not Found', { status: 404 });
  };
}

async function setupCliHarness(
  fetchOptions: { rateLimitAll?: boolean; rateLimitTransfer?: boolean } = {},
) {
  const cacheDir = await makeTempDir('tussam-cli-cache-');
  const configDir = await makeTempDir('tussam-cli-cfg-');
  const cache = new CacheStore(cacheDir);
  const topology = makeSeedTopology();
  await cache.saveNetworkTopology(topology, { force: true });
  await cache.saveStopIndex(Object.values(topology.stops));

  const client = new TussamClient({
    fetchImpl: makeMockFetch(fetchOptions),
    maxRetries: 0,
    maxConcurrency: 1,
  });

  const favoritesStore = new FavoritesStore({
    configDir,
    nowFn: () => Date.parse('2026-11-24T12:00:00.000Z'),
  });

  const run = async (args: string[], stdinText = '') => {
    const stdout = captureStream();
    const stderr = captureStream();
    const stdin = new PassThrough();
    if (stdinText) {
      stdin.end(stdinText);
    } else {
      stdin.end();
    }
    const exitCode = await runCli(['node', 'tussam-cli', ...args], {
      createTussam: () => new Tussam({ client, cache }),
      favoritesStore,
      stdin,
      stdout: stdout.stream,
      stderr: stderr.stream,
      nowFn: () => new Date(2026, 10, 24, 7, 0, 0),
      configureExitOverride: true,
      manageProcessExitCode: false,
    });
    return {
      exitCode,
      stdout: stdout.read(),
      stderr: stderr.read(),
    };
  };

  return { run, cacheDir, configDir, cache, favoritesStore };
}

describe('CLI Integration Tests (offline & deterministic)', () => {
  it('executes root route search with opposite-sidewalk origin walk and --origin-walk 0 suggestion', async () => {
    const { run } = await setupCliHarness();

    const directJson = await run([
      '-f',
      '43',
      '-t',
      '58',
      '-d',
      '29',
      '-m',
      '11',
      '-y',
      '2026',
      '-s',
      '--after',
      '07:00',
      '--limit',
      '5',
      '--json',
    ]);
    expect(directJson.exitCode).toBe(0);
    const parsed = JSON.parse(directJson.stdout) as {
      totalJourneys: number;
      journeys: Array<{ originWalk?: { toStopCode: string }; legs: Array<{ lineLabel: string }> }>;
      rateLimited: boolean;
    };
    expect(parsed.rateLimited).toBe(false);
    expect(parsed.totalJourneys).toBeGreaterThanOrEqual(1);
    expect(parsed.journeys[0]?.legs.map((l) => l.lineLabel)).toEqual(['01']);
    expect(parsed.journeys[0]?.originWalk?.toStopCode).toBe('2');

    // With --origin-walk 0 --estimate, returns transfer C4 -> 32 plus an actionable walk tip
    const noWalkText = await run([
      '-f',
      '43',
      '-t',
      '58',
      '-d',
      '29',
      '-m',
      '11',
      '-y',
      '2026',
      '--origin-walk',
      '0',
      '--estimate',
    ]);
    expect(noWalkText.exitCode).toBe(0);
    expect(noWalkText.stdout).toContain('TIMETABLE');
    expect(noWalkText.stdout).toContain('C4 → 32');
    expect(noWalkText.stdout).toContain('Menéndez Pelayo (Puerta Carmona) (#2)');
    expect(noWalkText.stdout).toContain('Offline estimates computed from ArcGIS');
  });

  it('handles HTTP 429 partial results and total 429 failures with clear stderr guidance', async () => {
    const partialHarness = await setupCliHarness({ rateLimitTransfer: true });
    const partialRes = await partialHarness.run([
      '-f',
      '43',
      '-t',
      '58',
      '-d',
      '29',
      '-m',
      '11',
      '-y',
      '2026',
    ]);
    expect(partialRes.exitCode).toBe(0);
    expect(partialRes.stdout).toContain('TIMETABLE');
    expect(partialRes.stdout).toContain('01');
    expect(partialRes.stderr).toContain('[WARN]');
    expect(partialRes.stderr).toContain('429');

    const failHarness = await setupCliHarness({ rateLimitAll: true });
    const failRes = await failHarness.run([
      '-f',
      '43',
      '-t',
      '58',
      '-d',
      '29',
      '-m',
      '11',
      '-y',
      '2026',
    ]);
    expect(failRes.exitCode).toBe(1);
    expect(failRes.stderr).toContain('Error:');
    expect(failRes.stderr).toContain('--estimate');
  });

  it('runs subcommands: stop, lines, line, alerts, nearby (negative coords), and cache', async () => {
    const { run } = await setupCliHarness();

    const stopJson = await run(['stop', '43', '--json']);
    expect(stopJson.exitCode).toBe(0);
    expect(JSON.parse(stopJson.stdout).arrivals[0].lineLabel).toBe('C4');

    const stopSched = await run([
      'stop',
      '43',
      '--schedule',
      '-l',
      'C4',
      '-d',
      '29',
      '-m',
      '11',
      '-y',
      '2026',
    ]);
    expect(stopSched.exitCode).toBe(0);
    expect(stopSched.stdout).toContain('Line C4');
    expect(stopSched.stdout).toContain('08:00');

    const linesRes = await run(['lines', '--json']);
    expect(linesRes.exitCode).toBe(0);
    expect(JSON.parse(linesRes.stdout)).toHaveLength(3);

    const lineRouteRes = await run(['line', '01', '--direction', '1']);
    expect(lineRouteRes.exitCode).toBe(0);
    expect(lineRouteRes.stdout).toContain('Line 01');
    expect(lineRouteRes.stdout).toContain('Menéndez Pelayo');

    const alertsRes = await run(['alerts', '-l', '01', '--json']);
    expect(alertsRes.exitCode).toBe(0);
    expect(JSON.parse(alertsRes.stdout)).toHaveLength(1);

    const nearbyRes = await run(['nearby', '-r', '500', '-n', '2', '37.389', '-5.9845', '--json']);
    expect(nearbyRes.exitCode).toBe(0);
    const nearbyStops = JSON.parse(nearbyRes.stdout) as Array<{ code: string }>;
    expect(nearbyStops).toHaveLength(2);
    expect(nearbyStops.map((s) => s.code).sort()).toEqual(['2', '43']);

    const cacheStatus = await run(['cache', 'status', '--json']);
    expect(cacheStatus.exitCode).toBe(0);
    expect(JSON.parse(cacheStatus.stdout).topology.linesCount).toBe(3);

    const cacheClear = await run(['cache', 'clear', '--json']);
    expect(cacheClear.exitCode).toBe(0);
    expect(JSON.parse(cacheClear.stdout)).toEqual({ cleared: true });
  });

  it('supports fav add/list/rm and resolving favorite aliases in stop and route searches', async () => {
    const { run } = await setupCliHarness();

    const emptyList = await run(['fav', 'list']);
    expect(emptyList.exitCode).toBe(0);
    expect(emptyList.stdout).toContain('No favorite stops saved');

    const addCasa = await run(['fav', 'add', 'casa', '43']);
    expect(addCasa.exitCode).toBe(0);
    expect(addCasa.stdout).toContain("Saved favorite 'casa'");

    const addTrabajo = await run(['fav', 'add', 'trabajo', '58']);
    expect(addTrabajo.exitCode).toBe(0);

    const favJson = await run(['fav', 'list', '--json']);
    expect(favJson.exitCode).toBe(0);
    expect(JSON.parse(favJson.stdout).map((f: { alias: string }) => f.alias)).toEqual([
      'casa',
      'trabajo',
    ]);

    const stopCasa = await run(['stop', 'casa', '--json']);
    expect(stopCasa.exitCode).toBe(0);
    expect(JSON.parse(stopCasa.stdout).stopCode).toBe('43');

    const routeFav = await run(['-f', 'casa', '-t', 'trabajo', '--estimate', '--json']);
    expect(routeFav.exitCode).toBe(0);
    const parsedRoute = JSON.parse(routeFav.stdout) as {
      origin: { code: string };
      destination: { code: string };
      estimatedFallback: boolean;
    };
    expect(parsedRoute.origin.code).toBe('43');
    expect(parsedRoute.destination.code).toBe('58');
    expect(parsedRoute.estimatedFallback).toBe(true);

    const rmCasa = await run(['fav', 'rm', 'casa']);
    expect(rmCasa.exitCode).toBe(0);
    expect(rmCasa.stdout).toContain("Removed favorite 'casa'");
  });

  it('supports interactive -i mode and shell completion generation', async () => {
    const { run } = await setupCliHarness();

    const interactiveRes = await run(
      ['-i', '--estimate', '--json'],
      `${['43', '58', '2026-11-29', '08:00', 'n'].join('\n')}\n`,
    );
    expect(interactiveRes.exitCode).toBe(0);
    const jsonStart = interactiveRes.stdout.indexOf('{');
    const parsed = JSON.parse(interactiveRes.stdout.slice(jsonStart)) as {
      origin: { code: string };
      destination: { code: string };
      estimatedFallback: boolean;
      journeys: unknown[];
    };
    expect(parsed.origin.code).toBe('43');
    expect(parsed.destination.code).toBe('58');
    expect(parsed.estimatedFallback).toBe(true);
    expect(parsed.journeys.length).toBeGreaterThanOrEqual(1);

    for (const shell of ['bash', 'zsh', 'fish', 'powershell']) {
      const compRes = await run(['completion', shell]);
      expect(compRes.exitCode).toBe(0);
      expect(compRes.stdout).toContain('tussam-cli');
    }

    const badShell = await run(['completion', 'tcsh']);
    expect(badShell.exitCode).toBe(1);
    expect(badShell.stderr).toContain('Unsupported shell');
  });

  it('returns exitCode 1 and clear errors on invalid flags or arguments', async () => {
    const { run } = await setupCliHarness();

    const cases: Array<[string[], RegExp]> = [
      [['-f', '43'], /Both -f <origin> and -t <destination> are required/],
      [['-f', '43', '-t', '58', '--max-transfers', '5'], /max-transfers must be between 0 and 3/],
      [
        ['-f', '43', '-t', '58', '--origin-walk', '-10'],
        /origin-walk distance must be non-negative/,
      ],
      [['-f', '43', '-t', '58', '-d', '31', '-m', '2', '-y', '2026'], /does not exist/],
      [['-f', '43', '-t', '58', '--after', '99:00'], /Hours must be 00-23/],
      [['cache', 'bogus'], /Unknown cache action/],
      [['fav', 'add', '43', '58'], /cannot be purely numeric/],
      [['fav', 'rm', 'missing'], /does not exist/],
    ];

    for (const [args, pattern] of cases) {
      const res = await run(args);
      expect(res.exitCode).toBe(1);
      expect(res.stderr).toMatch(pattern);
    }
  });

  it('executes the CLI entrypoint in a real offline subprocess', async () => {
    const { cacheDir, configDir } = await setupCliHarness();
    const repoRoot = path.resolve(import.meta.dirname, '..', '..');
    const sourceEntry = path.join(repoRoot, 'src', 'cli.ts');

    const execCli = (args: string[]) => {
      return execFileAsync(process.execPath, ['--import', 'tsx', sourceEntry, ...args], {
        cwd: repoRoot,
        env: {
          ...process.env,
          NO_COLOR: '1',
          TUSSAM_CLI_CACHE_DIR: cacheDir,
          TUSSAM_CLI_CONFIG_DIR: configDir,
        },
        timeout: 15_000,
      });
    };

    const versionRes = await execCli(['--version']);
    expect(versionRes.stdout.trim()).toBe(pkg.version);

    const helpRes = await execCli(['--help']);
    expect(helpRes.stdout).toContain('--estimate');
    expect(helpRes.stdout).toContain('--origin-walk');
    expect(helpRes.stdout).toContain('fav');
    expect(helpRes.stdout).toContain('completion');

    const compRes = await execCli(['completion', 'powershell']);
    expect(compRes.stdout).toContain('Register-ArgumentCompleter');

    const nearbyRes = await execCli(['nearby', '37.389', '-5.9845', '--json']);
    const stops = JSON.parse(nearbyRes.stdout) as Array<{ code: string }>;
    expect(stops.map((s) => s.code)).toEqual(['43', '2']);
  });
});
