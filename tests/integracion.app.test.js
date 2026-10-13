// ============================================================
// PRUEBAS DE INTEGRACIÓN — lógica de app.js contra la DB MOCK,
// con el DOM real de index.html (jsdom).
// ============================================================
import { describe, expect, it, beforeEach } from 'vitest';
import { crearMockDb, sesionPrueba } from './helpers/mockSupabase.js';
import { prepararDOM, instalarGlobales, cargarApp } from './helpers/entornoApp.js';
import { fromBase } from './helpers/datos.js';

const USER = { id: 'u-test', email: 'test@correo.cl' };

beforeEach(() => {
  prepararDOM();
});

describe('cargarAsignacion', () => {
  it('carga la asignación activa con el territorio anidado y sus puntos', async () => {
    const { db } = crearMockDb({ fromHandlers: fromBase() });
    instalarGlobales({ db });
    const app = await cargarApp();

    await app.entrar(USER);

    const e = app.__estado();
    expect(e.territorio.territorio_id).toBe('t1');
    expect(e.territorio.territorios.nombre).toBe('Territorio Ñuñoa');
    expect(e.puntos).toHaveLength(3);
    expect(e.user.email).toBe(USER.email);
  });

  it('acepta también la asignación en estado completado (migración 008)', async () => {
    const handlers = fromBase();
    handlers.territorios_asignaciones = {
      data: { ...handlers.territorios_asignaciones.data, estado: 'completado' },
      error: null,
    };
    const { db } = crearMockDb({ fromHandlers: handlers });
    instalarGlobales({ db });
    const app = await cargarApp();

    await app.entrar(USER);

    expect(app.__estado().territorio.estado).toBe('completado');
  });

  it('sin asignación → territorio null y modo libre (mapa general), sin error', async () => {
    const { db } = crearMockDb({});
    instalarGlobales({ db });
    const app = await cargarApp();

    await app.entrar(USER);

    expect(app.__estado().territorio).toBeNull();
    // modo libre: la app sigue visible con el mapa general, sin tarjeta de territorio
    expect(document.getElementById('emptyView').classList.contains('hidden')).toBe(true);
    expect(document.getElementById('appView').classList.contains('hidden')).toBe(false);
    expect(document.getElementById('secTerritorio').classList.contains('hidden')).toBe(true);
    expect(document.getElementById('emptyError').classList.contains('hidden')).toBe(true);
  });

  it('error de sesión (401) → refresca la sesión y reintenta una vez', async () => {
    let intentos = 0;
    let refrescos = 0;
    const { db } = crearMockDb({
      fromHandlers: {
        territorios_asignaciones: () => {
          intentos += 1;
          return intentos === 1
            ? { data: null, error: { message: 'JWT expired', status: 401 } }
            : { data: null, error: null };
        },
      },
      authHandlers: {
        refreshSession: async () => {
          refrescos += 1;
          return { data: { session: sesionPrueba() }, error: null };
        },
      },
    });
    instalarGlobales({ db });
    const app = await cargarApp();

    await app.entrar(USER);

    expect(refrescos).toBe(1);
    expect(intentos).toBe(2);
  });

  it('error de red → conserva el territorio en memoria y no muestra aviso', async () => {
    let llamadasAlHandler = 0;
    const { db } = crearMockDb({
      fromHandlers: {
        territorios_asignaciones: () => {
          llamadasAlHandler += 1;
          return llamadasAlHandler === 1
            ? { data: null, error: null }
            : { data: null, error: { message: 'Failed to fetch' } };
        },
      },
    });
    instalarGlobales({ db });
    const app = await cargarApp();
    await app.entrar(USER);

    await app.refrescar();

    expect(app.__estado().territorio).toBeNull();
    expect(document.getElementById('toastMovil').textContent).not.toContain('No se pudo cargar');
  });
});

describe('cargarPuntos', () => {
  it('un error de red conserva los puntos previos', async () => {
    let primera = true;
    const handlers = fromBase();
    const puntosBuenos = handlers.puntos.data;
    handlers.puntos = () => {
      if (primera) {
        primera = false;
        return { data: puntosBuenos, error: null };
      }
      return { data: null, error: { message: 'Failed to fetch' } };
    };
    const { db } = crearMockDb({ fromHandlers: handlers });
    instalarGlobales({ db });
    const app = await cargarApp();
    await app.entrar(USER);
    expect(app.__estado().puntos).toHaveLength(3);

    await app.refrescar();

    expect(app.__estado().puntos).toHaveLength(3);
  });
});

describe('cola offline', () => {
  it('encolar deduplica por tipo+clave y persiste en localStorage', async () => {
    const { db } = crearMockDb({});
    instalarGlobales({ db });
    const app = await cargarApp();

    app.encolar('estado', 'p1', { estado: 'visitado' });
    app.encolar('estado', 'p1', { estado: 'erroneo' });
    app.encolar('crear', 'local-1', { nombre: 'X' });

    const cola = app.__estado().cola;
    expect(cola).toHaveLength(2);
    expect(cola.find((o) => o.tipo === 'estado').datos.estado).toBe('erroneo');
    expect(JSON.parse(localStorage.getItem('gps_movil_cola'))).toHaveLength(2);
  });

  it('ejecutarOp clasifica: ok / offline / descartado', async () => {
    const { db } = crearMockDb({
      rpcHandlers: {
        marcar_estado: (p) => (p.p_id === 'p-red'
          ? { data: null, error: { message: 'Failed to fetch' } }
          : { data: 'pendiente', error: null }),
        guardar_punto: (p) => (p.p_nombre === 'Sin señal'
          ? { data: null, error: { message: 'NetworkError' } }
          : { data: 'id-nuevo', error: null }),
        actualizar_punto_terreno: () => ({ data: null, error: { message: 'Punto fuera de tu territorio' } }),
        eliminar_punto_propio: () => ({ data: null, error: null }),
      },
    });
    instalarGlobales({ db });
    const app = await cargarApp();

    await expect(app.ejecutarOp({ id: '1', tipo: 'estado', clave: 'p1', datos: { estado: 'visitado' } })).resolves.toBe('ok');
    await expect(app.ejecutarOp({ id: '2', tipo: 'estado', clave: 'p-red', datos: { estado: 'visitado' } })).resolves.toBe('offline');
    await expect(app.ejecutarOp({ id: '3', tipo: 'crear', clave: 'l1', datos: { nombre: 'X' } })).resolves.toBe('ok');
    await expect(app.ejecutarOp({ id: '4', tipo: 'crear', clave: 'l2', datos: { nombre: 'Sin señal' } })).resolves.toBe('offline');
    await expect(app.ejecutarOp({ id: '5', tipo: 'editar', clave: 'p1', datos: {} })).resolves.toBe('descartado');
    await expect(app.ejecutarOp({ id: '6', tipo: 'borrar', clave: 'p1', datos: {} })).resolves.toBe('ok');
    await expect(app.ejecutarOp({ id: '7', tipo: 'desconocida', clave: 'x', datos: {} })).resolves.toBe('descartado');
  });

  it('sincronizar envía en orden y se detiene al perder señal', async () => {
    const { db, llamadas } = crearMockDb({
      fromHandlers: fromBase(),
      rpcHandlers: {
        marcar_estado: (p) => (p.p_id === 'p2'
          ? { data: null, error: { message: 'Failed to fetch' } }
          : { data: 'x', error: null }),
      },
    });
    instalarGlobales({ db });
    const app = await cargarApp();
    await app.entrar(USER);

    app.encolar('estado', 'p1', { estado: 'erroneo' });
    app.encolar('estado', 'p2', { estado: 'no_pasar' });
    app.encolar('estado', 'p3', { estado: 'visitado' });
    await app.sincronizar();

    const marcas = llamadas.rpc.filter((r) => r.nombre === 'marcar_estado').map((r) => r.params.p_id);
    expect(marcas).toEqual(['p1', 'p2']); // p2 falló por red → no se intenta p3
    expect(app.__estado().cola.map((o) => o.clave)).toEqual(['p2', 'p3']);
  });
});

describe('aplicarEstado', () => {
  it('cambio optimista + RPC; en error de negocio revierte; en red encola', async () => {
    let redCaida = false;
    const { db, llamadas } = crearMockDb({
      fromHandlers: fromBase(),
      rpcHandlers: {
        marcar_estado: (p) => {
          if (redCaida) return { data: null, error: { message: 'Failed to fetch' } };
          if (p.p_id === 'p1') return { data: null, error: { message: 'Punto fuera de tu territorio' } };
          return { data: 'x', error: null };
        },
      },
    });
    instalarGlobales({ db });
    const app = await cargarApp();
    await app.entrar(USER);

    await app.aplicarEstado('p3', 'visitado');
    expect(app.puntoPorId('p3').estado).toBe('visitado');
    expect(llamadas.rpc.at(-1)).toMatchObject({ nombre: 'marcar_estado', params: { p_id: 'p3', p_estado: 'visitado' } });

    await app.aplicarEstado('p1', 'erroneo'); // error de negocio
    expect(app.puntoPorId('p1').estado).toBe('visitado'); // revierte
    expect(app.__estado().cola).toHaveLength(0);

    redCaida = true; // sin señal → el fetch real fallaría
    await app.aplicarEstado('p3', 'erroneo');
    expect(app.__estado().cola.at(-1)).toMatchObject({ tipo: 'estado', clave: 'p3' });
  });
});

describe('guardarNotaPunto', () => {
  it('guarda por RPC (con trim) y encola sin señal', async () => {
    const { db, llamadas } = crearMockDb({ fromHandlers: fromBase() });
    instalarGlobales({ db });
    const app = await cargarApp();
    await app.entrar(USER);

    const ok = await app.guardarNotaPunto('p3', '  portón rojo  ');
    expect(ok).toBe(true);
    const edicion = llamadas.rpc.find((r) => r.nombre === 'actualizar_punto_terreno');
    expect(edicion.params).toMatchObject({ p_id: 'p3', p_notas: 'portón rojo' });
    expect(app.puntoPorId('p3').notas).toBe('portón rojo');

    Object.defineProperty(window.navigator, 'onLine', { configurable: true, get: () => false });
    const ok2 = await app.guardarNotaPunto('p3', 'sin señal');
    expect(ok2).toBe(true);
    expect(app.__estado().cola.at(-1)).toMatchObject({ tipo: 'editar', clave: 'p3', datos: { notas: 'sin señal' } });
    Object.defineProperty(window.navigator, 'onLine', { configurable: true, get: () => true });
  });

  it('error de negocio → devuelve false sin encolar', async () => {
    const { db } = crearMockDb({
      fromHandlers: fromBase(),
      rpcHandlers: { actualizar_punto_terreno: () => ({ data: null, error: { message: 'Punto fuera de tu territorio' } }) },
    });
    instalarGlobales({ db });
    const app = await cargarApp();
    await app.entrar(USER);

    const ok = await app.guardarNotaPunto('p1', 'nueva nota');
    expect(ok).toBe(false);
    expect(app.__estado().cola).toHaveLength(0);
  });
});

describe('territorioCompleto', () => {
  it('true solo sin pendientes y sin creaciones locales en cola', async () => {
    const { db } = crearMockDb({ fromHandlers: fromBase() });
    instalarGlobales({ db });
    const app = await cargarApp();
    await app.entrar(USER);

    expect(app.territorioCompleto()).toBe(false); // p3 pendiente
    app.puntoPorId('p3').estado = 'visitado';
    expect(app.territorioCompleto()).toBe(true);
    app.encolar('crear', 'local-1', { nombre: 'Nuevo' });
    expect(app.territorioCompleto()).toBe(false);
  });
});

describe('links de navegación', () => {
  it('google por defecto', async () => {
    const { db } = crearMockDb({});
    instalarGlobales({ db });
    const app = await cargarApp();
    expect(app.linkComoLlegar(-33.45, -70.66))
      .toBe('https://www.google.com/maps/dir/?api=1&destination=-33.45,-70.66');
    app.abrirRuta(-33.45, -70.66);
    expect(window.open).toHaveBeenCalledWith(
      'https://www.google.com/maps/dir/?api=1&destination=-33.45,-70.66', '_blank', 'noopener'
    );
  });

  it('waze y mapas iOS según configuración', async () => {
    prepararDOM();
    localStorage.setItem('gps_app_mapa', 'waze');
    const { db } = crearMockDb({});
    instalarGlobales({ db });
    const app = await cargarApp();
    expect(app.linkComoLlegar(-33.45, -70.66)).toBe('https://waze.com/ul?ll=-33.45%2C-70.66&navigate=yes');

    prepararDOM();
    localStorage.setItem('gps_app_mapa', 'apple');
    const { db: db2 } = crearMockDb({});
    instalarGlobales({ db: db2 });
    const app2 = await cargarApp();
    expect(app2.linkComoLlegar(-33.45, -70.66)).toBe('https://maps.apple.com/?daddr=-33.45,-70.66&dirflg=d');

    Object.defineProperty(window.navigator, 'userAgent', { configurable: true, get: () => 'iPhone' });
    expect(app2.linkComoLlegar(-33.45, -70.66)).toBe('maps://?daddr=-33.45,-70.66&dirflg=d');
  });
});

describe('GPS', () => {
  it('concedido → activo; denegado → no disponible', async () => {
    const { db } = crearMockDb({});
    instalarGlobales({ db });
    const app = await cargarApp();

    Object.defineProperty(window.navigator, 'geolocation', {
      configurable: true,
      get: () => ({
        getCurrentPosition: (ok) => ok({ coords: { latitude: -33.45, longitude: -70.66 } }),
        watchPosition: () => 7,
        clearWatch: () => {},
      }),
    });
    app.activarGps();
    expect(app.__estado().gpsEstado).toBe('activo');

    Object.defineProperty(window.navigator, 'geolocation', {
      configurable: true,
      get: () => ({
        getCurrentPosition: (ok, fail) => fail(new Error('denegado')),
        watchPosition: () => 1,
        clearWatch: () => {},
      }),
    });
    app.activarGps();
    expect(app.__estado().gpsEstado).toBe('nodisponible');
  });
});

describe('sesión', () => {
  it('renueva la sesión por vencer', async () => {
    const sesion = { ...sesionPrueba(), expires_at: Math.floor(Date.now() / 1000) + 10 };
    let refrescos = 0;
    const { db } = crearMockDb({
      session: sesion,
      authHandlers: {
        refreshSession: async () => {
          refrescos += 1;
          return { data: { session: sesionPrueba() }, error: null };
        },
      },
    });
    instalarGlobales({ db });
    const app = await cargarApp(); // el boot ya dispara entrar → refrescar → refresh

    await app.asegurarSesionVigente();
    expect(refrescos).toBeGreaterThanOrEqual(1);
  });

  it('doLogin muestra el error de credenciales', async () => {
    const { db } = crearMockDb({
      authHandlers: {
        signInWithPassword: async () => ({ data: { user: null }, error: { message: 'Invalid login credentials' } }),
      },
    });
    instalarGlobales({ db });
    const app = await cargarApp();

    document.getElementById('loginEmail').value = 'mal@correo.cl';
    document.getElementById('loginPass').value = 'mala';
    await app.doLogin();

    expect(document.getElementById('loginError').textContent).toBe('Invalid login credentials');
    expect(document.getElementById('loginView').classList.contains('hidden')).toBe(false);
  });
});
