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
      guardar_punto: () => ({ data: 'id', error: null }),
      eliminar_punto_propio: () => ({ data: null, error: null }),
      devolver_territorio: () => ({ data: null, error: null }),
    },
  });
  instalarGlobales({ db: mock.db });
  llamadas = mock.llamadas;
  app = await cargarApp(); // el boot restaura la sesión y entra solo
});

it('arranque: sesión restaurada, territorio visible y lista renderizada', () => {
  expect(document.getElementById('loginView').classList.contains('hidden')).toBe(true);
  expect(document.getElementById('appView').classList.contains('hidden')).toBe(false);
  expect(document.getElementById('userEmail').textContent).toBe('test@correo.cl');
  expect(document.getElementById('territorioNombre').textContent).toBe('Territorio Ñuñoa');
  expect(document.getElementById('stripComuna').textContent).toBe('Ñuñoa');
  expect(document.querySelectorAll('#pdvList article')).toHaveLength(3);
  expect(document.getElementById('cntPendiente').textContent).toBe('1');
  expect(document.getElementById('headerSyncCount').textContent).toBe('');
});

it('marcar estado rápido desde la card: RPC + UI + barra de avance', async () => {
  const btn = document.querySelector('[data-estado-rapido="p3"][data-valor="visitado"]');
  expect(btn).toBeTruthy();
  btn.click();
  await flush();

  expect(marcarLlamadas.at(-1)).toEqual({ p_id: 'p3', p_estado: 'visitado' });
  expect(app.puntoPorId('p3').estado).toBe('visitado');
  // sin pendientes → sin barra pendiente visible en contadores
  expect(document.getElementById('cntPendiente').textContent).toBe('0');
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
  expect(app.__estado().cola).toHaveLength(1);
  expect(document.getElementById('fabSync').classList.contains('hidden')).toBe(false);
  expect(document.getElementById('fabCount').textContent).toBe('1');
  expect(JSON.parse(localStorage.getItem('gps_movil_cola'))).toHaveLength(1);

  Object.defineProperty(window.navigator, 'onLine', { configurable: true, get: () => true });
  window.dispatchEvent(new Event('online'));
  await flush();
  await flush();

  expect(marcarLlamadas.length).toBe(antes + 1);
  expect(app.__estado().cola).toHaveLength(0);
  expect(document.getElementById('fabSync').classList.contains('hidden')).toBe(true);
});

it('nota rápida desde la card (lápiz → flecha): guarda por RPC', async () => {
  document.querySelector('[data-nota-btn="p3"]').click();
  await flush();
  const zona = document.querySelector('[data-nota-btn="p3"]').closest('.zona-btns');
  expect(zona.querySelector('.acc-input').classList.contains('abierta')).toBe(true);
  expect(zona.querySelector('.acc-nota').classList.contains('modo-guardar')).toBe(true);

  const inp = zona.querySelector('[data-nota-input]');
  inp.value = 'nota rápida';
  inp.dispatchEvent(new Event('input'));
  document.querySelector('[data-nota-btn="p3"]').click(); // ahora es la flecha
  await flush();

  expect(app.puntoPorId('p3').notas).toBe('nota rápida');
  expect(zona.querySelector('.acc-input').classList.contains('abierta')).toBe(false);
});

it('filtro de lista muestra/oculta puntos según estado', () => {
  const btnPendiente = document.querySelector('.filtro[data-filtro="pendiente"]');
  btnPendiente.click();
  expect(app.pasarFiltro({ estado: 'pendiente' })).toBe(true);
  expect(app.pasarFiltro({ estado: 'visitado' })).toBe(false);
  const btnTodos = document.querySelector('.filtro[data-filtro="todos"]');
  btnTodos.click();
  expect(app.pasarFiltro({ estado: 'visitado' })).toBe(true);
});

it('devolver territorio: confirmación → RPC → pantalla sin territorio', async () => {
  document.getElementById('btnDevolver').click();
  await flush();
  expect(document.getElementById('confirmSheet').classList.contains('hidden')).toBe(false);

  document.getElementById('btnConfirmYes').click();
  await flush();

  expect(llamadas.rpc.filter((r) => r.nombre === 'devolver_territorio')).toHaveLength(1);
  expect(app.__estado().territorio).toBeNull();
  expect(document.getElementById('emptyView').classList.contains('hidden')).toBe(false);
  expect(document.getElementById('appView').classList.contains('hidden')).toBe(true);
});
