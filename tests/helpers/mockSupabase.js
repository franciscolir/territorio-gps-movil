// ============================================================
// Mock del cliente supabase-js para pruebas de integración/E2E.
// Soporta el subconjunto que usa app.js:
//   · from(tabla).select().eq().is().in().order().limit() → thenable
//     con terminadores maybeSingle()/single()
//   · rpc(nombre, params) → Promise
//   · auth: getSession, signInWithPassword, signOut, refreshSession,
//     onAuthStateChange
// Todo registra sus llamadas en `llamadas` para asertar.
// ============================================================

export function crearMockDb({ session = null, fromHandlers = {}, rpcHandlers = {}, authHandlers = {} } = {}) {
  const llamadas = { from: [], rpc: [] };

  const auth = {
    _escuchas: [],
    getSession: async () => ({ data: { session }, error: null }),
    signInWithPassword:
      authHandlers.signInWithPassword ?? (async (creds) => ({ data: { user: { id: 'u-test', email: creds?.email ?? '' } }, error: null })),
    signOut: authHandlers.signOut ?? (async () => ({ error: null })),
    refreshSession:
      authHandlers.refreshSession ?? (async () => ({ data: { session }, error: null })),
    onAuthStateChange: (cb) => {
      auth._escuchas.push(cb);
      return { data: { subscription: { unsubscribe() {} } } };
    },
  };

  const db = {
    auth,
    from(tabla) {
      llamadas.from.push(tabla);
      const builder = {};
      for (const m of ['select', 'eq', 'is', 'in', 'order', 'limit', 'range']) {
        builder[m] = () => builder;
      }
      const ejecutar = () => {
        // Simula el mundo real: sin señal, el fetch falla con error de red
        if (typeof navigator !== 'undefined' && !navigator.onLine) {
          return Promise.resolve({ data: null, error: { message: 'Failed to fetch' } });
        }
        return Promise.resolve(
          typeof fromHandlers[tabla] === 'function'
            ? fromHandlers[tabla]()
            : (fromHandlers[tabla] ?? { data: null, error: null })
        );
      };
      builder.maybeSingle = ejecutar;
      builder.single = ejecutar;
      builder.then = (ok, fail) => ejecutar().then(ok, fail);
      builder.catch = (fail) => ejecutar().catch(fail);
      builder.finally = (fn) => ejecutar().finally(fn);
      return builder;
    },
    rpc(nombre, params = {}) {
      llamadas.rpc.push({ nombre, params });
      // Sin señal la RPC no llega (el fetch real falla con error de red)
      if (typeof navigator !== 'undefined' && !navigator.onLine) {
        return Promise.resolve({ data: null, error: { message: 'Failed to fetch' } });
      }
      const handler = rpcHandlers[nombre];
      return Promise.resolve(
        typeof handler === 'function' ? handler(params) : (handler ?? { data: null, error: null })
      );
    },
  };

  return { db, llamadas, auth };
}

// Sesión de prueba con token vigente (1 hora)
export function sesionPrueba() {
  return {
    access_token: 'token-de-prueba',
    refresh_token: 'refresh-de-prueba',
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    user: { id: 'u-test', email: 'test@correo.cl' },
  };
}
