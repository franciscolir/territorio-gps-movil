// ============================================================
// Datos de prueba compartidos (fixtures) para integración y E2E.
// ============================================================

export const TERRITORIO = {
  territorio_id: 't1',
  estado: 'activa',
  assigned_at: '2026-01-01T10:00:00Z',
  user_id: 'u-test',
  territorios: {
    id: 't1',
    nombre: 'Territorio Ñuñoa',
    comuna: 'Ñuñoa',
    color: '#3b82f6',
    geom: {
      type: 'Polygon',
      coordinates: [[
        [-70.61, -33.47], [-70.59, -33.47], [-70.59, -33.45], [-70.61, -33.45], [-70.61, -33.47],
      ]],
    },
  },
};

export const PUNTOS = [
  { id: 'p1', nombre: 'Almacén A', direccion: 'Calle 1', notas: '', estado: 'visitado', lat: -33.46, lng: -70.6, territorio_id: 't1', user_id: 'otro', deleted_at: null },
  { id: 'p2', nombre: 'Bodega B', direccion: 'Calle 2', notas: 'portón azul', estado: 'erroneo', lat: -33.461, lng: -70.601, territorio_id: 't1', user_id: 'u-test', deleted_at: null },
  { id: 'p3', nombre: 'Tienda C', direccion: '', notas: '', estado: 'pendiente', lat: -33.459, lng: -70.599, territorio_id: 't1', user_id: 'u-test', deleted_at: null },
];

// Copia fresca por test (la app muta los objetos de puntos)
export const fromBase = () => ({
  territorios_asignaciones: { data: { ...TERRITORIO }, error: null },
  puntos: { data: PUNTOS.map((p) => ({ ...p })), error: null },
});
