import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// lib.js es un script clásico (se carga con <script src="lib.js"> en el
// navegador, sin export). Para testearlo se evalúa su fuente y se capturan
// las funciones declaradas en el ámbito del wrapper.
const src = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'lib.js'),
  'utf8'
);
const lib = new Function(
  `${src}
   return {
     ESTADOS, PIN_ICONS, estadoLabel,
     escapeHtml, pointFromGeom, pointInGeometry, inRing,
     nuevaOpCola, colaAgregar, colaQuitar, colaResumen, sectorAvance,
   };`
)();

// EWKB (hex) de un Point con SRID 4326 little-endian, como lo escribe PostGIS
function ewkbPoint(lng, lat) {
  const b = Buffer.alloc(1 + 4 + 4 + 16);
  b.writeUInt8(1, 0);
  b.writeUInt32LE(0x20000001, 1); // tipo Point + flag SRID
  b.writeUInt32LE(4326, 5);
  b.writeDoubleLE(lng, 9);
  b.writeDoubleLE(lat, 17);
  return b.toString('hex');
}

const cuadrado = (x0, y0, x1, y1) => ({
  type: 'Polygon',
  coordinates: [[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]],
});

describe('escapeHtml', () => {
  // '<b>&"&#39;</b>' armado por partes para no depender
  // de entidades literales en el fuente.
  const ent = (n) => '&' + n + ';';
  const escapado =
    ent('lt') + 'b' + ent('gt') + ent('amp') + ent('quot') + ent('#39') +
    ent('lt') + '/b' + ent('gt');

  it('escapa los caracteres peligrosos', () => {
    expect(lib.escapeHtml('<b>&"\'</b>')).toBe(escapado);
  });
  it(' tolera null/undefined', () => {
    expect(lib.escapeHtml(null)).toBe('');
    expect(lib.escapeHtml(undefined)).toBe('');
  });
  it('no rompe texto normal con acentos', () => {
    expect(lib.escapeHtml('Sector Ñuñoa · visitado')).toBe('Sector Ñuñoa · visitado');
  });
});

describe('pointFromGeom', () => {
  it('lee EWKB hex de PostGIS', () => {
    const c = lib.pointFromGeom(ewkbPoint(-70.66, -33.45));
    expect(c).not.toBeNull();
    expect(c.lng).toBeCloseTo(-70.66, 9);
    expect(c.lat).toBeCloseTo(-33.45, 9);
  });
  it('acepta GeoJSON', () => {
    expect(lib.pointFromGeom({ type: 'Point', coordinates: [-70.6, -33.4] }))
      .toEqual({ lat: -33.4, lng: -70.6 });
  });
  it('rechaza basura', () => {
    expect(lib.pointFromGeom(null)).toBeNull();
    expect(lib.pointFromGeom('')).toBeNull();
    expect(lib.pointFromGeom('zzzz')).toBeNull();
    expect(lib.pointFromGeom({ type: 'Point' })).toBeNull();
    expect(lib.pointFromGeom(12345)).toBeNull();
  });
  it('rechaza EWKB que no es Point', () => {
    const b = Buffer.alloc(9);
    b.writeUInt8(1, 0);
    b.writeUInt32LE(2, 1); // LineString
    b.writeUInt32LE(0, 5);
    expect(lib.pointFromGeom(b.toString('hex'))).toBeNull();
  });
});

describe('pointInGeometry / inRing', () => {
  const g = cuadrado(0, 0, 10, 10);

  it('detecta el interior y el exterior', () => {
    expect(lib.pointInGeometry(5, 5, g)).toBe(true);
    expect(lib.pointInGeometry(15, 5, g)).toBe(false);
    expect(lib.pointInGeometry(-1, -1, g)).toBe(false);
  });

  it('respeta los agujeros (holes)', () => {
    const conAgujero = {
      type: 'Polygon',
      coordinates: [
        [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]],
        [[3, 3], [7, 3], [7, 7], [3, 7], [3, 3]],
      ],
    };
    expect(lib.pointInGeometry(5, 5, conAgujero)).toBe(false); // dentro del agujero
    expect(lib.pointInGeometry(1, 1, conAgujero)).toBe(true);  // anillo principal
  });

  it('soporta MultiPolygon', () => {
    const multi = {
      type: 'MultiPolygon',
      coordinates: [[cuadrado(0, 0, 10, 10).coordinates[0]], [cuadrado(20, 20, 30, 30).coordinates[0]]],
    };
    expect(lib.pointInGeometry(25, 25, multi)).toBe(true);
    expect(lib.pointInGeometry(15, 15, multi)).toBe(false);
  });

  it('con geometría rota devuelve false (no truena)', () => {
    expect(lib.pointInGeometry(1, 1, null)).toBe(false);
    expect(lib.pointInGeometry(1, 1, {})).toBe(false);
  });
});

describe('estados', () => {
  it('mapea estado → etiqueta', () => {
    expect(lib.estadoLabel('visitado')).toBe('Visitado');
    expect(lib.estadoLabel('no_pasar')).toBe('No pasar');
    expect(lib.estadoLabel('desconocido')).toBe('Pendiente');
  });
  it('los 4 estados del terreno', () => {
    expect(lib.ESTADOS.map(([v]) => v)).toEqual(['pendiente', 'visitado', 'erroneo', 'no_pasar']);
  });
  it('cada estado tiene ícono Material', () => {
    for (const [v] of lib.ESTADOS) expect(lib.PIN_ICONS[v]).toBeTruthy();
  });
});

describe('cola offline (nuevaOpCola / colaAgregar / colaQuitar / colaResumen)', () => {
  it('nuevaOpCola construye la operación con id y datos copiados', () => {
    const datos = { estado: 'visitado' };
    const op = lib.nuevaOpCola('estado', 'p1', datos, 'op-1', 1000);
    expect(op).toEqual({
      id: 'op-1', tipo: 'estado', clave: 'p1',
      datos: { estado: 'visitado' }, creadoEn: 1000,
    });
    datos.estado = 'erroneo'; // no debe afectar a la copia
    expect(op.datos.estado).toBe('visitado');
  });

  it('colaAgregar no muta la lista original', () => {
    const ops = [];
    const out = lib.colaAgregar(ops, lib.nuevaOpCola('estado', 'p1', { estado: 'visitado' }, 'a', 1));
    expect(ops).toHaveLength(0);
    expect(out).toHaveLength(1);
  });

  it('colaAgregar reemplaza la operación previa del mismo tipo y clave', () => {
    let ops = [];
    ops = lib.colaAgregar(ops, lib.nuevaOpCola('estado', 'p1', { estado: 'visitado' }, 'a', 1));
    ops = lib.colaAgregar(ops, lib.nuevaOpCola('estado', 'p1', { estado: 'erroneo' }, 'b', 2));
    ops = lib.colaAgregar(ops, lib.nuevaOpCola('editar', 'p1', { nombre: 'X' }, 'c', 3));
    expect(ops).toHaveLength(2);
    expect(ops.find((o) => o.tipo === 'estado').datos.estado).toBe('erroneo');
  });

  it('colaQuitar elimina por id', () => {
    const ops = [
      lib.nuevaOpCola('estado', 'p1', {}, 'a', 1),
      lib.nuevaOpCola('estado', 'p2', {}, 'b', 2),
    ];
    expect(lib.colaQuitar(ops, 'a').map((o) => o.id)).toEqual(['b']);
    expect(lib.colaQuitar(ops, 'no-existe')).toHaveLength(2);
  });

  it('colaResumen cuenta por tipo', () => {
    const ops = [
      lib.nuevaOpCola('estado', 'p1', {}, 'a', 1),
      lib.nuevaOpCola('estado', 'p2', {}, 'b', 2),
      lib.nuevaOpCola('crear', 'local-1', {}, 'c', 3),
      lib.nuevaOpCola('borrar', 'p3', {}, 'd', 4),
    ];
    expect(lib.colaResumen(ops)).toEqual({
      total: 4, estado: 2, crear: 1, editar: 0, borrar: 1,
    });
    expect(lib.colaResumen([])).toEqual({
      total: 0, estado: 0, crear: 0, editar: 0, borrar: 0,
    });
  });
});

describe('sectorAvance', () => {
  it('cuenta estados y calcula el porcentaje de visitados', () => {
    const puntos = [
      { estado: 'visitado' }, { estado: 'visitado' }, { estado: 'visitado' },
      { estado: 'erroneo' }, { estado: 'no_pasar' }, { estado: 'pendiente' },
    ];
    expect(lib.sectorAvance(puntos)).toEqual({
      total: 6, pendiente: 1, visitado: 3, erroneo: 1, no_pasar: 1, pct: 50,
    });
  });
  it('trata lo vacío o desconocido como pendiente', () => {
    expect(lib.sectorAvance([])).toEqual({
      total: 0, pendiente: 0, visitado: 0, erroneo: 0, no_pasar: 0, pct: 0,
    });
    const r = lib.sectorAvance([{}, { estado: 'raro' }]);
    expect(r.pendiente).toBe(2);
    expect(r.pct).toBe(0);
  });
});
