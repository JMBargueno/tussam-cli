import { describe, expect, it } from 'vitest';
import { TussamClient, extractArrayParadasJson } from '../../src/api/client.js';
import { TussamApiError } from '../../src/api/errors.js';

function makeResponse(
  body: string,
  init: { status?: number; headers?: Record<string, string> } = {},
): Response {
  return new Response(body, {
    status: init.status ?? 200,
    headers: {
      'Content-Type': 'text/html; charset=UTF-8',
      ...(init.headers ?? {}),
    },
  });
}

describe('extractArrayParadasJson', () => {
  it('parses APP.arrayParadas even with nested braces inside string literals', () => {
    const html = `
      <script>
        var other = { a: 1 };
        APP.arrayParadas = {"43":{"nombre":"Recaredo {Puerta Carmona}","datos":[{"color":"#f54129","numero":1,"label":"01"}],"vLat":37389663,"vLon":-5984265}};
        APP.next = true;
      </script>
    `;

    const parsed = extractArrayParadasJson(html);
    expect(parsed['43']?.nombre).toBe('Recaredo {Puerta Carmona}');
    expect(parsed['43']?.vLat).toBe(37389663);
  });

  it('throws TussamApiError when marker is missing', () => {
    expect(() => extractArrayParadasJson('<html><body>No data</body></html>')).toThrow(
      TussamApiError,
    );
  });
});

describe('TussamClient', () => {
  it('fetches and normalizes stop index from HTML', async () => {
    const html = `
      <script>
        APP.arrayParadas = {
          "43": {
            "nombre": "Recaredo (Puerta Carmona)",
            "datos": [
              {"color": "#f54129", "numero": 1, "label": "01"},
              {"color": "#008431", "numero": 84, "label": "C4"},
              {"color": "#f54129", "numero": 1, "label": "01"}
            ],
            "vLat": 37389663,
            "vLon": -5984265
          },
          "999": {
            "nombre": "Parada Sin Coords",
            "datos": [],
            "vLat": 0,
            "vLon": 0
          }
        };
      </script>
    `;

    const client = new TussamClient({
      fetchImpl: async () => makeResponse(html),
    });

    const stops = await client.fetchStopIndexFromHtml();
    expect(stops).toHaveLength(2);
    const stop43 = stops.find((s) => s.code === '43');
    expect(stop43).toEqual({
      code: '43',
      name: 'Recaredo (Puerta Carmona)',
      lat: 37.389663,
      lon: -5.984265,
      lines: [
        { lineId: 1, label: '01', color: '#f54129' },
        { lineId: 84, label: 'C4', color: '#008431' },
      ],
    });
    const stop999 = stops.find((s) => s.code === '999');
    expect(stop999?.lat).toBeNull();
    expect(stop999?.lon).toBeNull();
  });

  it('encodes timestamp colons as %3A when requesting lines and schedules', async () => {
    const requestedUrls: string[] = [];
    const client = new TussamClient({
      fetchImpl: async (input) => {
        const url = String(input);
        requestedUrls.push(url);
        if (url.includes('/lineas/')) {
          return makeResponse(
            JSON.stringify({
              result: {
                lineasDisponibles: [
                  {
                    linea: 81,
                    labelLinea: 'C1',
                    sublinea: 8110,
                    descripcion: { texto: 'Circular Exterior 1' },
                    color: '#008431',
                    destinos: [
                      {
                        sentido: 99,
                        destino: { texto: 'CIRCULAR' },
                        horaInicio: '06:00',
                        horaFin: '00:20',
                      },
                    ],
                  },
                ],
              },
            }),
          );
        }
        return makeResponse(JSON.stringify({ result: { horarios: ['07:32:29', '07:57:29'] } }));
      },
    });

    const date = new Date(2026, 10, 29, 12, 5, 9);
    const lines = await client.fetchLines(date);
    const times = await client.fetchStopSchedule('58', 1, date);

    expect(requestedUrls[0]).toContain('/API/infotus-ui/lineas/29-11-2026T12%3A05%3A09');
    expect(requestedUrls[1]).toContain('/API/infotus-ui/horarios/58/1/29-11-2026T12%3A05%3A09');
    expect(lines[0]?.isCircular).toBe(true);
    expect(times).toEqual(['07:32:29', '07:57:29']);
  });

  it('normalizes tiempos quirks: list result, missing segundos, and missing coordinates', async () => {
    const client = new TussamClient({
      fetchImpl: async (input) => {
        const url = String(input);
        if (url.endsWith('/empty')) {
          return makeResponse(JSON.stringify({ result: [] }));
        }
        return makeResponse(
          JSON.stringify({
            result: [
              {
                codigo: 43,
                descripcion: { texto: 'Recaredo (Puerta Carmona)' },
                posicion: { latitudE6: 0, longitudE6: 0 },
                lineasCoincidentes: [
                  {
                    lineaId: 1,
                    labelLinea: '01',
                    color: '#f54129',
                    estimaciones: [
                      { vehiculo: 1062, destino: { texto: 'POLIGONO NORTE' }, distancia: 1205, segundos: 487 },
                      { vehiculo: 9999, destino: { texto: 'INVALID' }, distancia: 100 },
                      { vehiculo: 8888, destino: { texto: 'NEGATIVE' }, distancia: 100, segundos: -30 },
                    ],
                  },
                  {
                    lineaId: 84,
                    labelLinea: 'C4',
                    color: '#008431',
                    estimaciones: [
                      { vehiculo: 243, destino: { texto: 'PLAZA DE ARMAS' }, distancia: 39, segundos: 24 },
                    ],
                  },
                ],
              },
            ],
          }),
        );
      },
    });

    const empty = await client.fetchStopArrivals('empty');
    expect(empty.arrivals).toEqual([]);

    const stop43 = await client.fetchStopArrivals('43');
    expect(stop43.lat).toBeNull();
    expect(stop43.lon).toBeNull();
    expect(stop43.arrivals).toHaveLength(2);
    expect(stop43.arrivals[0]?.lineLabel).toBe('C4');
    expect(stop43.arrivals[0]?.minutes).toBe(0);
    expect(stop43.arrivals[1]?.lineLabel).toBe('01');
    expect(stop43.arrivals[1]?.minutes).toBe(8);
  });

  it('handles both empty array and object shape for active alerts', async () => {
    let toggle = false;
    const client = new TussamClient({
      fetchImpl: async () => {
        toggle = !toggle;
        if (toggle) {
          return makeResponse(JSON.stringify({ result: [] }));
        }
        return makeResponse(
          JSON.stringify({
            result: {
              notificacionesActivas: [
                {
                  id: 5065,
                  creacion: '24-11-2026T10:00:00',
                  caducidad: '24-11-2026T18:00:00',
                  lineas: ['06', 'C1'],
                  contenido: 'Detour on Ronda de Triana',
                  tipo: 'Notificacion',
                },
              ],
            },
          }),
        );
      },
    });

    expect(await client.fetchActiveAlerts()).toEqual([]);
    const alerts = await client.fetchActiveAlerts();
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.lines).toEqual(['06', 'C1']);
  });

  it('retries HTTP 429 honoring Retry-After and HTTP 503 with exponential backoff', async () => {
    const sleepCalls: number[] = [];
    let attempt = 0;
    const client = new TussamClient({
      maxRetries: 3,
      retryBaseDelayMs: 50,
      sleepImpl: async (ms) => {
        sleepCalls.push(ms);
      },
      fetchImpl: async () => {
        attempt += 1;
        if (attempt === 1) {
          return makeResponse('Too Many Requests', { status: 429, headers: { 'Retry-After': '3' } });
        }
        if (attempt === 2) {
          return makeResponse('Service Unavailable', { status: 503 });
        }
        return makeResponse(JSON.stringify({ result: [] }));
      },
    });

    const alerts = await client.fetchActiveAlerts();
    expect(alerts).toEqual([]);
    expect(sleepCalls).toEqual([3000, 100]);
  });

  it('rejects Cloudflare HTML challenges and upstream API error payloads', async () => {
    const htmlClient = new TussamClient({
      maxRetries: 0,
      fetchImpl: async () => makeResponse('<!DOCTYPE html><html><body>Just a moment...</body></html>'),
    });
    await expect(htmlClient.fetchActiveAlerts()).rejects.toThrow(/HTML\/challenge/);

    const errClient = new TussamClient({
      maxRetries: 0,
      fetchImpl: async () =>
        makeResponse(
          JSON.stringify({
            result: null,
            error: true,
            status: 'ERROR',
            message: 'Peticion incorrecta',
          }),
        ),
    });
    await expect(errClient.fetchActiveAlerts()).rejects.toThrow(/Peticion incorrecta/);
  });
});
