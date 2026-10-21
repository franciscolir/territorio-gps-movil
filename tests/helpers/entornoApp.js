// ============================================================
// Entorno de prueba para app.js:
//   · prepararDOM(): carga el body real de index.html en jsdom
//   · instalarGlobales(): supabase (con el mock db) y maplibregl stub
//   · cargarApp(): evalúa el fuente de app.js como script clásico
//     (igual que el navegador) y devuelve sus funciones + estado interno
// ============================================================
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { vi } from 'vitest';

const raiz = (...p) => join(dirname(fileURLToPath(import.meta.url)), '..', '..', ...p);

export function prepararDOM() {
  const html = readFileSync(raiz('index.html'), 'utf8');
  const cuerpo = html.match(/<body[^>]*>([\s\S]*)<\/body>/i)?.[1] ?? '';
  document.body.innerHTML = cuerpo;
  document.documentElement.classList.remove('dark');
  localStorage.clear();
}

function stubMapLibre() {
  class MapStub {
    on() {}
    addSource() {}
    addLayer() {}
    removeSource() {}
    getLayer() { return false; }
    getSource() { return false; }
    remove() {}
    flyTo() {}
    easeTo() {}
    fitBounds() {}
    resize() {}
    getStyle() { return { layers: [] }; }
    getZoom() { return 14; }
  }
  class MarkerStub {
    setLngLat() { return this; }
    addTo() { return this; }
    remove() {}
  }
  return { Map: MapStub, Marker: MarkerStub };
}

export function instalarGlobales({ db }) {
  globalThis.supabase = { createClient: () => db };
  globalThis.maplibregl = stubMapLibre();
  if (!window.open?.__esMock) {
    window.open = Object.assign(vi.fn(() => null), { __esMock: true });
  }
}

export async function cargarApp() {
  // Como en el navegador: lib.js se carga ANTES que app.js y expone globales
  const libSrc = readFileSync(raiz('lib.js'), 'utf8');
  const src = readFileSync(raiz('app.js'), 'utf8');
  const api = new Function(
    'supabase',
    'maplibregl',
    `${libSrc}\n${src}
    return {
      cargarAsignacion, cargarPuntos, refrescar, entrar, doLogin,
      aplicarEstado, sincronizar, ejecutarOp, encolar,
      guardarNotaPunto, guardarFicha,
      territorioCompleto, avisarSiCompleto, abrirRevision, pintarRevision,
      enviarTerritorio, pintarTodo, pintarLista, pintarTarjetaTerritorio,
      pintarFiltros, pintarVistaTerritorio, pintarTabs,
      setGpsEstado, activarGps, detenerGps,
      linkComoLlegar, abrirRuta, abrirFicha, abrirFichaNueva,
      toggleEstadoCard, elegirEstadoRapido, elegirEstadoDetalle,
      actualizarEstadoEnCard, pintarEstadosDetalle,
      agregarMensaje, cargarHistorial, pintarHistorial, verPuntoEnMapa,
      pintarConfig, aplicarTema, alternarSatelite, irA, initMap,
      leerCola, dentroDelTerritorio, puntoPorId,
      pasarFiltro, coordsDe, bboxDeGeometria,
      asegurarSesionVigente, esErrorDeRed, esErrorDeSesion,
      __estado: () => ({
        territorio, errorTerritorio, user,
        puntos: [...puntos], cola: [...cola],
        tabActual, filtroActual, gpsEstado, sateliteActiva,
      }),
    };`
  )(globalThis.supabase, globalThis.maplibregl);
  await new Promise((r) => setTimeout(r, 0)); // deja resolver el boot async
  return api;
}

// Espera a que terminen las microtareas/async de un click
export const flush = () => new Promise((r) => setTimeout(r, 0));
