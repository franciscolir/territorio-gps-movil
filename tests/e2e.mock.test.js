// ============================================================
// E2E CON MOCK — flujo completo del usuario sobre el DOM real de
// index.html y la DB simulada: arranque → estados → completado →
// revisión in situ → envío → offline/online → devolución.
// ============================================================
import { expect, it, beforeAll } from 'vitest';
import { crearMockDb, sesionPrueba } from './helpers/mockSupabase.js';
import { prepararDOM, instalarGlobales, cargarApp, flush } from './helpers/entornoApp.js';
import { fromBase } from './helpers/datos.js';

let app;
let llamadas;
const marcarLlamadas = [];

beforeAll(async () => {
  prepararDOM();
  const mock = crearMockDb({
    session: sesionPrueba(),
    fromHandlers: fromBase(),
    rpcHandlers: {
      marcar_estado: (p) => {
        marcarLlamadas.push(p);
        return { data: 'prev', error: null };
      },
      actualizar_punto_terreno: () => ({ data: null, error: null }),
      crear_solicitud_punto: () => ({ data: 'id-solicitud', error: null }),
      eliminar_punto_propio: () => ({ data: null, error: null }),
      devolver_territorio: () => ({ data: null, error: null }),
      agregar_nota_punto: () => ({ data: 'n1', error: null }),
      notas_punto: () => ({ data: [], error: null }),
    },
  });
  instalarGlobales({ db: mock.db });
  llamadas = mock.llamadas;
  app = await cargarApp(); // el boot restaura la sesión y entra solo
});

it('arranque: sesión restaurada, territorio visible y lista renderizada', () => {
  expect(document.getElementById('loginView').classList.contains('hidden')).toBe(true);
  expect(document.getElementById('appView').classList.contains('hidden')).toBe(false);
  expect(document.getElementById('appMenuUser').textContent).toBe('test@correo.cl');
  expect(document.getElementById('headerTitulo').textContent).toBe('Ñuñoa · Territorio Ñuñoa');
  expect(document.querySelectorAll('#pdvList article')).toHaveLength(3);
  expect(document.getElementById('mapStatsPendiente').textContent).toBe('1');
  expect(document.getElementById('headerSyncCount').textContent).toBe('');
});

it('marcar estado rápido desde la card: RPC + UI + barra de avance', async () => {
  document.querySelector('[data-estado-chip="p3"]').click();
  const row = document.querySelector('#pdvList article[data-id="p3"] [data-estados-row]');
  expect(row.classList.contains('hidden')).toBe(false);

  const btn = document.querySelector('[data-estado-rapido="p3"][data-valor="visitado"]');
  expect(btn).toBeTruthy();
  btn.click();
  await flush();

  expect(marcarLlamadas.at(-1)).toEqual({ p_id: 'p3', p_estado: 'visitado' });
  expect(app.puntoPorId('p3').estado).toBe('visitado');
  // sin pendientes → sin barra pendiente visible en contadores
  expect(document.getElementById('mapStatsPendiente').textContent).toBe('0');
});

it('territorio completado → modal → tabla de revisión editable → enviar', async () => {
  const modal = document.getElementById('completadoSheet');
  expect(modal.classList.contains('hidden')).toBe(false);
  expect(document.getElementById('completadoNombre').textContent).toBe('Territorio Ñuñoa');

  document.getElementById('btnRevisar').click();
  await flush();
  expect(document.getElementById('completadoSheet').classList.contains('hidden')).toBe(true);
  expect(document.getElementById('revisionSheet').classList.contains('hidden')).toBe(false);
  expect(document.querySelectorAll('#revisionTabla [data-rev]')).toHaveLength(3);
  expect(document.getElementById('revisionResumen').textContent).toContain('2 visitados');

  // edición in situ: estado
  const sel = document.querySelector('[data-rev-estado="p1"]');
  sel.value = 'erroneo';
  sel.dispatchEvent(new Event('change'));
  await flush();
  expect(marcarLlamadas.at(-1)).toEqual({ p_id: 'p1', p_estado: 'erroneo' });

  // edición in situ: notas
  const inp = document.querySelector('[data-rev-notas="p3"]');
  inp.value = 'entrega confirmada';
  inp.dispatchEvent(new Event('change'));
  await flush();
  const edicion = llamadas.rpc.filter((r) => r.nombre === 'actualizar_punto_terreno').at(-1);
  expect(edicion.params).toMatchObject({ p_id: 'p3', p_notas: 'entrega confirmada' });

  document.getElementById('btnRevisionEnviar').click();
  await flush();
  expect(document.getElementById('revisionSheet').classList.contains('hidden')).toBe(true);
  expect(document.getElementById('completadoSheet').classList.contains('hidden')).toBe(true);
});

it('sin señal encola; al volver la señal sincroniza solo', async () => {
  const antes = marcarLlamadas.length;
  Object.defineProperty(window.navigator, 'onLine', { configurable: true, get: () => false });

  await app.aplicarEstado('p2', 'no_pasar');
  expect(marcarLlamadas.length).toBe(antes); // no se llamó a la RPC
  expect(app.__estado().cola).toHaveLength(2); // estado + entrada de log
  expect(document.getElementById('fabSync').classList.contains('hidden')).toBe(false);
  expect(document.getElementById('fabCount').textContent).toBe('2');
  expect(JSON.parse(localStorage.getItem('gps_movil_cola'))).toHaveLength(2);

  Object.defineProperty(window.navigator, 'onLine', { configurable: true, get: () => true });
  window.dispatchEvent(new Event('online'));
  await flush();
  await flush();

  expect(marcarLlamadas.length).toBe(antes + 1);
  expect(app.__estado().cola).toHaveLength(0);
  expect(document.getElementById('fabSync').classList.contains('hidden')).toBe(true);
});

it('agregar mensaje al historial desde el detalle del punto', async () => {
  document.querySelector('[data-abrir="p3"]').click();
  await flush();
  expect(document.getElementById('pointSheet').classList.contains('hidden')).toBe(false);

  const inp = document.getElementById('pointMensajeInput');
  inp.value = 'mensaje de prueba';
  document.getElementById('btnPointMensaje').click();
  await flush();

  const rpc = llamadas.rpc.filter((r) => r.nombre === 'agregar_nota_punto').at(-1);
  expect(rpc.params).toEqual({ p_id: 'p3', p_texto: 'mensaje de prueba' });
  expect(app.puntoPorId('p3').notas).toBe('mensaje de prueba');
  expect(inp.value).toBe('');

  // la card refleja el último mensaje tras el re-render (píldora de nota)
  const art = document.querySelector('#pdvList article[data-id="p3"]');
  expect(art.querySelector('.italic').textContent).toContain('mensaje de prueba');

  document.querySelector('#pointSheet [data-close="pointSheet"]').click();
});

it('filtro de lista muestra/oculta puntos según estado', () => {
  document.querySelector('.filtro[data-filtro="pendiente"]').click();
  expect(app.pasarFiltro({ estado: 'pendiente' })).toBe(true);
  expect(app.pasarFiltro({ estado: 'visitado' })).toBe(false);

  document.querySelector('.filtro[data-filtro="no_pasar"]').click();
  expect(app.pasarFiltro({ estado: 'no_pasar' })).toBe(true);
  expect(app.pasarFiltro({ estado: 'pendiente' })).toBe(false);

  document.querySelector('.filtro[data-filtro="completado"]').click();
  expect(app.pasarFiltro({ estado: 'visitado' })).toBe(true);
  expect(app.pasarFiltro({ estado: 'erroneo' })).toBe(true);
  expect(app.pasarFiltro({ estado: 'no_pasar' })).toBe(false);

  document.querySelector('.filtro[data-filtro="todos"]').click();
  expect(app.pasarFiltro({ estado: 'visitado' })).toBe(true);
  expect(app.pasarFiltro({ estado: 'no_pasar' })).toBe(true);
});

it('devolver territorio: confirmación → RPC → modo libre (mapa general, sin tarjeta)', async () => {
  document.getElementById('appMenuDevolver').click();
  await flush();
  expect(document.getElementById('confirmSheet').classList.contains('hidden')).toBe(false);

  document.getElementById('btnConfirmYes').click();
  await flush();

  expect(llamadas.rpc.filter((r) => r.nombre === 'devolver_territorio')).toHaveLength(1);
  expect(app.__estado().territorio).toBeNull();
  // sin asignación la app entra en modo libre: el mapa general sigue visible
  expect(document.getElementById('emptyView').classList.contains('hidden')).toBe(true);
  expect(document.getElementById('appView').classList.contains('hidden')).toBe(false);
  expect(document.getElementById('secTerritorio').classList.contains('hidden')).toBe(true);
});
