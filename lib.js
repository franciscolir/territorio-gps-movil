// ============================================================
// LIB — funciones puras (sin DOM ni estado global).           =
// Se cargan antes de app.js y se prueban con Vitest (tests/). =
// Solo lo que usa la app de terreno; el repo de escritorio    =
// tiene su propia copia con más funciones.                    =
// ============================================================

const ESTADOS = [
  ['pendiente', 'Pendiente'],
  ['visitado', 'Visitado'],
  ['erroneo', 'Erróneo'],
  ['no_pasar', 'No pasar'],
];
// Icono Material del pin de mapa por estado (diseño front)
const PIN_ICONS = { pendiente: 'schedule', visitado: 'check', erroneo: 'priority_high', no_pasar: 'block' };
function estadoLabel(e) {
  const x = ESTADOS.find((k) => k[0] === e);
  return x ? x[1] : 'Pendiente';
}
// ¿El punto (lng, lat) cae dentro del polígono/multipolígono del territorio?
function pointInGeometry(lng, lat, geom) {
  if (!geom || !geom.coordinates) return false;
  const polygons = geom.type === 'MultiPolygon' ? geom.coordinates : [geom.coordinates];
  return polygons.some(
    (poly) => inRing(lng, lat, poly[0]) && !poly.slice(1).some((hole) => inRing(lng, lat, hole))
  );
}

function inRing(lng, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if ((yi > lat) !== (yj > lat) && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}
// Mapa carácter -> entidad (se concatena para evitar entidades literales
// en el fuente, que algunos pipelines de texto pueden decodificar).
const HTML_ENTITIES = { '&': 'amp', '<': 'lt', '>': 'gt', '"': 'quot', "'": '#39' };
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => '&' + HTML_ENTITIES[c] + ';');
}
// PostGIS devuelve la columna `geography` como EWKB hexadecimal
// (ej: "0101000020E6100000..." = byte order + type con flag SRID + 4326 + X + Y).
// También acepta GeoJSON por si el backend cambia el formato.
function pointFromGeom(geom) {
  if (!geom) return null;

  if (typeof geom === 'object' && Array.isArray(geom.coordinates)) {
    const [lng, lat] = geom.coordinates;
    return isFinite(lat) && isFinite(lng) ? { lat, lng } : null;
  }

  if (typeof geom !== 'string') return null;
  const hex = geom.trim();
  if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length < 18 || hex.length % 2 !== 0) return null;

  try {
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);

    const view = new DataView(bytes.buffer);
    const little = bytes[0] === 1;
    const type = view.getUint32(1, little);
    const baseType = type & 0x1fffffff;          // quita flags EWKB (SRID/Z/M)
    if (baseType !== 1) return null;             // solo Point

    const offset = 5 + ((type & 0x20000000) ? 4 : 0);  // 4 bytes extra si hay SRID
    if (bytes.length < offset + 16) return null;

    const lng = view.getFloat64(offset, little);
    const lat = view.getFloat64(offset + 8, little);
    return isFinite(lat) && isFinite(lng) ? { lat, lng } : null;
  } catch {
    return null;
  }
}

// ============================================================
// COLA OFFLINE — funciones puras e inmutables.
// La cola vive en localStorage; el id y el timestamp los aporta el
// caller para que estas funciones sean deterministas en los tests.
// ============================================================

// Operación pendiente: tipo ('estado' | 'crear' | 'editar' | 'borrar'),
// clave (id del punto, o id local en 'crear') y datos de la operación.
function nuevaOpCola(tipo, clave, datos, id, creadoEn) {
  return { id, tipo, clave, datos: { ...datos }, creadoEn };
}

// Agrega reemplazando operaciones previas del mismo tipo sobre la misma
// clave (p. ej. dos cambios de estado del mismo punto = solo el último).
function colaAgregar(ops, op) {
  const resto = ops.filter((o) => !(o.tipo === op.tipo && o.clave === op.clave));
  return [...resto, op];
}

function colaQuitar(ops, opId) {
  return ops.filter((o) => o.id !== opId);
}

// Conteo por tipo para el botón "Sincronizar ahora (N pendientes)".
function colaResumen(ops) {
  const r = { total: ops.length, estado: 0, crear: 0, editar: 0, borrar: 0 };
  for (const o of ops) {
    if (Object.prototype.hasOwnProperty.call(r, o.tipo)) r[o.tipo]++;
  }
  return r;
}

// Avance del territorio a partir de sus puntos (pct = visitados sobre el total).
function territorioAvance(puntos) {
  const r = { total: puntos.length, pendiente: 0, visitado: 0, erroneo: 0, no_pasar: 0, pct: 0 };
  for (const p of puntos) {
    const e = p && p.estado && Object.prototype.hasOwnProperty.call(r, p.estado)
      ? p.estado
      : 'pendiente';
    r[e]++;
  }
  r.pct = r.total ? Math.round((r.visitado / r.total) * 100) : 0;
  return r;
}
