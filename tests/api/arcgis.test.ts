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
    expect(cleanArcGisLineDescription('P.S.Sebastian - Alcosa [V]')).toBe('P.S.Sebastian - Alcosa');
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

  it('keeps bidirectional lines sharing both termini non-circular, prefers full subline, and preserves circular handover stops', async () => {
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes('TUSSAM_Lineas')) {
        return jsonResponse({
          features: [
            {
              attributes: {
                Linea: 5,
                LabelLinea: '05',
                Sublinea: 505,
                Ruta: 5051,
                NombreLinea: 'Puerta Triana - Santa Aurelia',
                DestinoRuta: 'SANTA AURELIA',
                Color: '#e53935',
                Package: 680,
              },
            },
            {
              attributes: {
                Linea: 5,
                LabelLinea: '05',
                Sublinea: 510,
                Ruta: 511,
                NombreLinea: 'Puerta Triana - Santa Aurelia',
                DestinoRuta: 'SANTA AURELIA',
                Color: '#e53935',
                Package: 680,
              },
            },
            {
              attributes: {
                Linea: 5,
                LabelLinea: '05',
                Sublinea: 510,
                Ruta: 512,
                NombreLinea: 'Puerta Triana - Santa Aurelia',
                DestinoRuta: 'PUERTA TRIANA',
                Color: '#e53935',
                Package: 680,
              },
            },
            {
              attributes: {
                Linea: 82,
                LabelLinea: 'C2',
                Sublinea: 8210,
                Ruta: 8211,
                NombreLinea: 'Circular Exterior 2',
                DestinoRuta: 'PRADO',
                Color: '#008431',
                Package: 680,
              },
            },
            {
              attributes: {
                Linea: 82,
                LabelLinea: 'C2',
                Sublinea: 8210,
                Ruta: 8212,
                NombreLinea: 'Circular Exterior 2',
                DestinoRuta: 'CARTUJA',
                Color: '#008431',
                Package: 680,
              },
            },
          ],
        });
      }

      return jsonResponse({
        exceededTransferLimit: false,
        features: [
          // Partial sublinea 505 (only 1 direction) should lose to 2-direction sublinea 510
          {
            attributes: {
              Linea: 5,
              LabelLinea: '05',
              Sublinea: 505,
              Ruta: 5051,
              Nodo: 100,
              Nombre: 'Term A',
              Distancia: 0,
              Package: 680,
            },
            geometry: { x: -5.99, y: 37.39 },
          },
          {
            attributes: {
              Linea: 5,
              LabelLinea: '05',
              Sublinea: 505,
              Ruta: 5051,
              Nodo: 200,
              Nombre: 'Term B',
              Distancia: 1000,
              Package: 680,
            },
            geometry: { x: -5.98, y: 37.38 },
          },
          // Bidirectional line 05 sharing BOTH termini 100 and 200 must stay isCircular: false
          {
            attributes: {
              Linea: 5,
              LabelLinea: '05',
              Sublinea: 510,
              Ruta: 511,
              Nodo: 100,
              Nombre: 'Term A',
              Distancia: 0,
              Package: 680,
            },
            geometry: { x: -5.99, y: 37.39 },
          },
          {
            attributes: {
              Linea: 5,
              LabelLinea: '05',
              Sublinea: 510,
              Ruta: 511,
              Nodo: 150,
              Nombre: 'Mid 1',
              Distancia: 500,
              Package: 680,
            },
            geometry: { x: -5.985, y: 37.385 },
          },
          {
            attributes: {
              Linea: 5,
              LabelLinea: '05',
              Sublinea: 510,
              Ruta: 511,
              Nodo: 200,
              Nombre: 'Term B',
              Distancia: 1000,
              Package: 680,
            },
            geometry: { x: -5.98, y: 37.38 },
          },
          {
            attributes: {
              Linea: 5,
              LabelLinea: '05',
              Sublinea: 510,
              Ruta: 512,
              Nodo: 200,
              Nombre: 'Term B',
              Distancia: 0,
              Package: 680,
            },
            geometry: { x: -5.98, y: 37.38 },
          },
          {
            attributes: {
              Linea: 5,
              LabelLinea: '05',
              Sublinea: 510,
              Ruta: 512,
              Nodo: 160,
              Nombre: 'Mid 2',
              Distancia: 500,
              Package: 680,
            },
            geometry: { x: -5.986, y: 37.384 },
          },
          {
            attributes: {
              Linea: 5,
              LabelLinea: '05',
              Sublinea: 510,
              Ruta: 512,
              Nodo: 100,
              Nombre: 'Term A',
              Distancia: 1000,
              Package: 680,
            },
            geometry: { x: -5.99, y: 37.39 },
          },
          // Circular C2 where odd last stop (B2) != even first stop (C1) must NOT drop C1
          {
            attributes: {
              Linea: 82,
              LabelLinea: 'C2',
              Sublinea: 8210,
              Ruta: 8211,
              Nodo: 301,
              Nombre: 'C2 A',
              Distancia: 0,
              Package: 680,
            },
            geometry: { x: -6.0, y: 37.4 },
          },
          {
            attributes: {
              Linea: 82,
              LabelLinea: 'C2',
              Sublinea: 8210,
              Ruta: 8211,
              Nodo: 302,
              Nombre: 'C2 B',
              Distancia: 600,
              Package: 680,
            },
            geometry: { x: -5.995, y: 37.4 },
          },
          {
            attributes: {
              Linea: 82,
              LabelLinea: 'C2',
              Sublinea: 8210,
              Ruta: 8212,
              Nodo: 303,
              Nombre: 'C2 C',
              Distancia: 0,
              Package: 680,
            },
            geometry: { x: -5.994, y: 37.399 },
          },
          {
            attributes: {
              Linea: 82,
              LabelLinea: 'C2',
              Sublinea: 8210,
              Ruta: 8212,
              Nodo: 304,
              Nombre: 'C2 D',
              Distancia: 450,
              Package: 680,
            },
            geometry: { x: -5.998, y: 37.398 },
          },
          {
            attributes: {
              Linea: 82,
              LabelLinea: 'C2',
              Sublinea: 8210,
              Ruta: 8212,
              Nodo: 301,
              Nombre: 'C2 A',
              Distancia: 800,
              Package: 680,
            },
            geometry: { x: -6.0, y: 37.4 },
          },
        ],
      });
    };

    const topology = await fetchArcGisTopology({ fetchImpl });

    const line05 = topology.lines['5'];
    expect(line05?.subline).toBe(510);
    expect(line05?.isCircular).toBe(false);
    expect(line05?.directions.map((d) => d.direction)).toEqual([1, 2]);
    expect(topology.lineStops['5:1']?.map((s) => s.code)).toEqual(['100', '150', '200']);
    expect(topology.lineStops['5:2']?.map((s) => s.code)).toEqual(['200', '160', '100']);

    const c2Stops = topology.lineStops['82:99'];
    expect(topology.lines['82']?.isCircular).toBe(true);
    expect(c2Stops?.map((s) => s.code)).toEqual(['301', '302', '303', '304']);
    expect(c2Stops![2]!.distanceMeters).toBeGreaterThan(c2Stops![1]!.distanceMeters);
    expect(c2Stops![3]!.distanceMeters).toBeGreaterThan(c2Stops![2]!.distanceMeters);
  });
});
