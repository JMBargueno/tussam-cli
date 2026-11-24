import { describe, expect, it } from 'vitest';
import {
  cleanArcGisDestination,
  cleanArcGisLineDescription,
  cleanArcGisStopName,
  fetchArcGisTopology,
} from '../../src/api/arcgis.js';

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('ArcGIS topology helpers', () => {
  it('extracts intermodal icons and cleans stop, line, and destination labels', () => {
    expect(cleanArcGisStopName('Enramadilla (Apeadero San Bernardo) [R][C][M]')).toEqual({
      name: 'Enramadilla (Apeadero San Bernardo)',
      icons: ['renfe', 'consorcio', 'metro'],
    });
    expect(cleanArcGisLineDescription('P.S.Sebastian - Alcosa [V]')).toBe(
      'P.S.Sebastian - Alcosa',
    );
    expect(cleanArcGisDestination('PRADO                     .')).toBe('PRADO');
  });

  it('paginates stops, filters max Package, picks primary Sublinea, and stitches circular C1', async () => {
    const requestedOffsets: string[] = [];

    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes('TUSSAM_Lineas')) {
        return jsonResponse({
          features: [
            // Stale Package 670 should be ignored in favor of 678
            {
              attributes: {
                Linea: 1,
                LabelLinea: '01',
                Sublinea: 110,
                Ruta: 111,
                NombreLinea: 'Old Line 01',
                DestinoRuta: 'OLD DEST',
                Color: '#000000',
                Package: 670,
              },
            },
            {
              attributes: {
                Linea: 1,
                LabelLinea: '01',
                Sublinea: 110,
                Ruta: 111,
                NombreLinea: 'Plg. Norte H. Virgen del Rocio',
                DestinoRuta: 'HOSPITAL V.ROCIO .',
                Color: '#f54129',
                Package: 678,
              },
            },
            {
              attributes: {
                Linea: 81,
                LabelLinea: 'C1',
                Sublinea: 8110,
                Ruta: 8111,
                NombreLinea: 'Circular Exterior 1',
                DestinoRuta: 'PRADO .',
                Color: '#008431',
                Package: 678,
              },
            },
            {
              attributes: {
                Linea: 81,
                LabelLinea: 'C1',
                Sublinea: 8110,
                Ruta: 8112,
                NombreLinea: 'Circular Exterior 1',
                DestinoRuta: 'CARTUJA .',
                Color: '#008431',
                Package: 678,
              },
            },
          ],
        });
      }

      const parsedUrl = new URL(url);
      const offset = parsedUrl.searchParams.get('resultOffset') ?? '0';
      requestedOffsets.push(offset);

      if (offset === '0') {
        return jsonResponse({
          exceededTransferLimit: true,
          features: [
            // Secondary Sublinea 112 should not override primary 110
            {
              attributes: {
                Linea: 1,
                LabelLinea: '01',
                Sublinea: 112,
                Ruta: 113,
                Nodo: 999,
                Nombre: 'Secondary Variant',
                Distancia: 0,
                Package: 678,
              },
              geometry: { x: -5.98, y: 37.38 },
            },
            {
              attributes: {
                Linea: 1,
                LabelLinea: '01',
                Sublinea: 110,
                Ruta: 111,
                Nodo: 785,
                Nombre: 'María Auxiliadora (Puerta Osario)',
                Distancia: 2973,
                Package: 678,
              },
              geometry: { x: -5.98386, y: 37.39415 },
            },
            {
              attributes: {
                Linea: 1,
                LabelLinea: '01',
                Sublinea: 110,
                Ruta: 111,
                Nodo: 58,
                Nombre: 'Manuel Siurot (Hospital V.Rocio)',
                Distancia: 7191,
                Package: 678,
              },
              geometry: { x: -5.98156, y: 37.36108 },
            },
          ],
        });
      }

      return jsonResponse({
        exceededTransferLimit: false,
        features: [
          {
            attributes: {
              Linea: 81,
              LabelLinea: 'C1',
              Sublinea: 8110,
              Ruta: 8111,
              Nodo: 737,
              Nombre: 'Américo Vespucio (F. de Comunicación)',
              Distancia: 0,
              Package: 678,
            },
            geometry: { x: -6.0066, y: 37.4105 },
          },
          {
            attributes: {
              Linea: 81,
              LabelLinea: 'C1',
              Sublinea: 8110,
              Ruta: 8111,
              Nodo: 185,
              Nombre: 'Av. Carlos V (Juzgados) [C][M]',
              Distancia: 7715,
              Package: 678,
            },
            geometry: { x: -5.9869, y: 37.3807 },
          },
          {
            attributes: {
              Linea: 81,
              LabelLinea: 'C1',
              Sublinea: 8110,
              Ruta: 8112,
              Nodo: 185,
              Nombre: 'Av. Carlos V (Juzgados) [C][M]',
              Distancia: 0,
              Package: 678,
            },
            geometry: { x: -5.9869, y: 37.3807 },
          },
          {
            attributes: {
              Linea: 81,
              LabelLinea: 'C1',
              Sublinea: 8110,
              Ruta: 8112,
              Nodo: 730,
              Nombre: 'Américo Vespucio (Jacques Cousteau)',
              Distancia: 6309,
              Package: 678,
            },
            geometry: { x: -6.0074, y: 37.4076 },
          },
          {
            attributes: {
              Linea: 81,
              LabelLinea: 'C1',
              Sublinea: 8110,
              Ruta: 8112,
              Nodo: 737,
              Nombre: 'Américo Vespucio (F. de Comunicación)',
              Distancia: 6643,
              Package: 678,
            },
            geometry: { x: -6.0066, y: 37.4105 },
          },
        ],
      });
    };

    const topology = await fetchArcGisTopology({ fetchImpl });

    expect(requestedOffsets).toEqual(['0', '3']);
    expect(topology.lines['1']?.directions[0]?.destination).toBe('HOSPITAL V.ROCIO');
    expect(topology.lineStops['1:1']?.map((s) => s.code)).toEqual(['785', '58']);

    // Circular C1 stitched into 81:99 with cumulative distances (7715 + 6309 = 14024)
    expect(topology.lines['81']?.isCircular).toBe(true);
    expect(topology.lines['81']?.directions[0]?.direction).toBe(99);
    const c1Stops = topology.lineStops['81:99'];
    expect(c1Stops?.map((s) => s.code)).toEqual(['737', '185', '730']);
    expect(c1Stops?.[2]?.distanceMeters).toBe(14_024);
    expect(topology.stops['185']?.icons).toEqual(['consorcio', 'metro']);
    // Stop from secondary sublinea is still indexed for search
    expect(topology.stops['999']?.name).toBe('Secondary Variant');
  });
});
