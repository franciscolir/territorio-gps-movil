// ============================================================
// APP DE TERRENO — colaboradores (repo móvil autónomo).
// · ve SOLO su sector asignado y sus puntos (RLS de la migración 003)
// · crea/edita puntos del sector, cambia estados, borra solo los suyos
// · devuelve el sector aunque no cubra el 100%
// · cola offline en localStorage con sincronización manual/automática
// ============================================================

// ============================================================
// CONFIG — EDITA AQUÍ
// ============================================================
const SUPABASE_URL = 'https://yfdkyccmaseztypccoww.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_jmltUeff0VTuLXf2KrujcA_zktLmoSS';
const MAP_STYLE = 'https://tiles.openfreemap.org/styles/positron';
const COLA_KEY = 'gps_movil_cola';

// ============================================================
// CLIENTE + ESTADO
// ============================================================
const { createClient } = supabase;
// storageKey propio: la sesión del móvil no compite con la del escritorio
// (misma URL, dos pestañas). El lock serializa refreshes entre pestañas.
const db = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    storageKey: 'gps-movil-session',
    lock: (name, acquireTimeout, fn) =>
      (typeof navigator !== 'undefined' && navigator.locks)
        ? navigator.locks.request(name, () => fn())
        : fn(),
  },
});

let user = null;
let sector = null;      // asignación activa con el sector anidado
let puntos = [];        // puntos del servidor (RLS ya limita al sector)
let cola = [];          // operaciones offline pendientes
let tabActual = 'ruta';
let filtroActual = 'todos';
let map = null;
let mapListo = false;
let markers = {};       // id -> Marker
let sheetPunto = null;  // { id, lat, lng, esNuevo }
let statusTarget = null;
let undoInfo = null;    // { id, prev, timer }
let confirmAction = null;
let syncRunning = false;
let opSeq = 0;

// Configuración local (persistida en localStorage)
let appMapa = 'google';   // 'google' | 'waze' | 'apple'
let tema = 'claro';       // 'claro' | 'oscuro'
try { const g = localStorage.getItem('gps_app_mapa'); if (g) appMapa = g; } catch (_) {}
try { if (localStorage.getItem('gps_tema') === 'oscuro') tema = 'oscuro'; } catch (_) {}
document.documentElement.classList.toggle('dark', tema === 'oscuro');

// GPS del dispositivo
let gpsEstado = 'pendiente'; // 'activo' | 'pendiente' | 'nodisponible'
let gpsWatchId = null;
let gpsUltima = null;        // { lat, lng }
let gpsIntentado = false;
let markerUsuario = null;

const $ = (id) => document.getElementById(id);

// ============================================================
// UI: toasts, sheets, confirmaciones
// ============================================================
function toast(msg, { error = false, undo = null } = {}) {
  const t = $('toastMovil');
  $('toastMsg').textContent = msg;
  $('toastIcon').textContent = error ? 'error' : 'task_alt';
  const btn = $('toastUndo');
  clearTimeout(undoInfo?.timer);
  undoInfo = undo ? { ...undo, timer: setTimeout(() => t.classList.add('hidden'), 4500) }
                  : null;
  btn.classList.toggle('hidden', !undo);
  t.classList.remove('hidden');
  if (!undo) setTimeout(() => t.classList.add('hidden'), 2600);
}

// Errores sin catch visibles en pantalla (diagnóstico sin consola)
window.addEventListener('error', (e) => {
  if (e?.message) toast('Error: ' + e.message, { error: true });
});
window.addEventListener('unhandledrejection', (e) => {
  const m = e?.reason?.message || (typeof e?.reason === 'string' ? e.reason : '');
  if (m) toast('Error: ' + m, { error: true });
});

$('toastUndo').addEventListener('click', () => {
  if (!undoInfo) return;
  const { id, prev } = undoInfo;
  $('toastMovil').classList.add('hidden');
  clearTimeout(undoInfo.timer);
  undoInfo = null;
  aplicarEstado(id, prev, { silent: true });
});

function sheetOpen(id) { $(id).classList.remove('hidden'); $(id).classList.add('flex'); }
function sheetClose(id) { $(id).classList.add('hidden'); $(id).classList.remove('flex'); }

document.querySelectorAll('[data-close]').forEach((b) => {
  b.addEventListener('click', () => sheetClose(b.dataset.close));
});
// Clic fuera de la hoja = cerrar
for (const id of ['statusSheet', 'pointSheet', 'confirmSheet', 'configSheet']) {
  $(id).addEventListener('click', (e) => { if (e.target === $(id)) sheetClose(id); });
}

function preguntar(titulo, mensaje, accion) {
  $('confirmTitulo').textContent = titulo;
  $('confirmMsg').textContent = mensaje;
  confirmAction = accion;
  sheetOpen('confirmSheet');
}
$('btnConfirmNo').addEventListener('click', () => { confirmAction = null; sheetClose('confirmSheet'); });
$('btnConfirmYes').addEventListener('click', () => {
  sheetClose('confirmSheet');
  const a = confirmAction;
  confirmAction = null;
  if (a) a();
});

// ============================================================
// GPS DEL DISPOSITIVO
// Pide permiso al entrar: activo → punto azul en el mapa y "GPS ACTIVO"
// en el header; denegado/sin señal → "UBICACIÓN NO DISPONIBLE".
// ============================================================
function setGpsEstado(estado) {
  gpsEstado = estado;
  const dot = $('gpsDot');
  const txt = $('headerEstado');
  dot.classList.remove('bg-on-tertiary-container', 'bg-error', 'bg-surface-variant', 'animate-pulse');
  if (estado === 'activo') {
    dot.classList.add('bg-on-tertiary-container', 'animate-pulse');
    txt.textContent = 'GPS ACTIVO';
  } else if (estado === 'pendiente') {
    dot.classList.add('bg-surface-variant');
    txt.textContent = 'ACTIVAR UBICACIÓN';
  } else {
    dot.classList.add('bg-error');
    txt.textContent = 'UBICACIÓN NO DISPONIBLE';
  }
  pintarGpsConfig();
}

function activarGps() {
  if (!navigator.geolocation) { setGpsEstado('nodisponible'); return; }
  if (gpsWatchId != null) {
    navigator.geolocation.clearWatch(gpsWatchId);
    gpsWatchId = null;
  }
  setGpsEstado('pendiente');
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      gpsUltima = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      setGpsEstado('activo');
      ponerMarcadorUsuario();
      gpsWatchId = navigator.geolocation.watchPosition((p) => {
        gpsUltima = { lat: p.coords.latitude, lng: p.coords.longitude };
        ponerMarcadorUsuario();
      }, () => {}, { enableHighAccuracy: true, maximumAge: 15000 });
    },
    () => setGpsEstado('nodisponible'),
    { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 }
  );
}

function detenerGps() {
  if (gpsWatchId != null) {
    navigator.geolocation?.clearWatch(gpsWatchId);
    gpsWatchId = null;
  }
  if (markerUsuario) { markerUsuario.remove(); markerUsuario = null; }
  gpsUltima = null;
  gpsIntentado = false;
  setGpsEstado('pendiente');
}

function ponerMarcadorUsuario() {
  if (!mapListo || !map || !gpsUltima) return;
  if (!markerUsuario) {
    const el = document.createElement('div');
    el.className = 'user-dot';
    markerUsuario = new maplibregl.Marker({ element: el })
      .setLngLat([gpsUltima.lng, gpsUltima.lat])
      .addTo(map);
  } else {
    markerUsuario.setLngLat([gpsUltima.lng, gpsUltima.lat]);
  }
}

// ============================================================
// CONFIGURACIÓN (tema · app de mapas · GPS)
// ============================================================
function aplicarTema(t) {
  tema = t;
  try { localStorage.setItem('gps_tema', t); } catch (_) {}
  document.documentElement.classList.toggle('dark', t === 'oscuro');
  pintarConfig();
}

function pintarConfig() {
  const oscuro = tema === 'oscuro';
  for (const par of [[$('temaClaroBtn'), !oscuro], [$('temaOscuroBtn'), oscuro]]) {
    par[0].classList.toggle('bg-surface-container-lowest', par[1]);
    par[0].classList.toggle('text-primary', par[1]);
    par[0].classList.toggle('shadow-sm', par[1]);
    par[0].classList.toggle('text-on-surface-variant', !par[1]);
  }
  document.querySelectorAll('[data-app]').forEach((b) => {
    const activo = b.dataset.app === appMapa;
    b.classList.toggle('bg-primary', activo);
    b.classList.toggle('text-on-primary', activo);
    b.classList.toggle('bg-surface-container-lowest', !activo);
    b.classList.toggle('text-on-surface-variant', !activo);
  });
  pintarGpsConfig();
}

function pintarGpsConfig() {
  const textos = {
    activo: 'GPS activo: tu ubicación se muestra en el mapa.',
    pendiente: 'Toca para activar la ubicación del dispositivo.',
    nodisponible: 'Ubicación no disponible: permiso denegado o GPS apagado.',
  };
  $('gpsConfigEstado').textContent = textos[gpsEstado] || textos.pendiente;
  $('btnGpsConfigLabel').textContent = gpsEstado === 'nodisponible' ? 'Reintentar' : 'Activar ubicación';
  $('btnGpsConfig').classList.toggle('hidden', gpsEstado === 'activo');
}

// Links de navegación según la app elegida en Configuración
function linkComoLlegar(lat, lng) {
  if (appMapa === 'waze') return `https://waze.com/ul?ll=${lat}%2C${lng}&navigate=yes`;
  if (appMapa === 'apple') {
    const esApple = /iPad|iPhone|iPod|Macintosh/.test(navigator.userAgent);
    return esApple
      ? `maps://?daddr=${lat},${lng}&dirflg=d`
      : `https://maps.apple.com/?daddr=${lat},${lng}&dirflg=d`;
  }
  return `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`;
}

function homeAppMapa() {
  return { google: 'https://www.google.com/maps', waze: 'https://waze.com', apple: 'https://maps.apple.com' }[appMapa]
    || 'https://www.google.com/maps';
}

function abrirRuta(lat, lng) {
  const url = linkComoLlegar(lat, lng);
  // El esquema maps:// no abre en pestaña nueva: navega directo
  if (/^maps:/i.test(url)) { window.location.href = url; return; }
  window.open(url, '_blank', 'noopener');
}

$('btnConfig').addEventListener('click', () => { pintarConfig(); sheetOpen('configSheet'); });
$('temaClaroBtn').addEventListener('click', () => aplicarTema('claro'));
$('temaOscuroBtn').addEventListener('click', () => aplicarTema('oscuro'));
document.querySelectorAll('[data-app]').forEach((b) => {
  b.addEventListener('click', () => {
    appMapa = b.dataset.app;
    try { localStorage.setItem('gps_app_mapa', appMapa); } catch (_) {}
    pintarConfig();
  });
});
$('btnGpsConfig').addEventListener('click', activarGps);
$('btnGpsEstado').addEventListener('click', () => { if (gpsEstado !== 'activo') activarGps(); });
$('btnCentrar').addEventListener('click', () => {
  if (!map) return;
  if (!gpsUltima) { activarGps(); toast('Activando ubicación…'); return; }
  map.flyTo({ center: [gpsUltima.lng, gpsUltima.lat], zoom: Math.max(map.getZoom(), 16), duration: 400 });
});
setGpsEstado('pendiente');

// ============================================================
// AUTH
// ============================================================
$('loginBtn').addEventListener('click', doLogin);
$('loginPass').addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });

async function doLogin() {
  const email = $('loginEmail').value.trim();
  const pass = $('loginPass').value;
  $('loginError').textContent = '';
  const { data, error } = await db.auth.signInWithPassword({ email, password: pass });
  if (error) { $('loginError').textContent = error.message; return; }
  await entrar(data.user);
}

$('btnLogout').addEventListener('click', async () => {
  await db.auth.signOut();
  user = null; sector = null; puntos = [];
  detenerGps();
  $('appView').classList.add('hidden');
  $('emptyView').classList.add('hidden');
  $('emptyView').classList.remove('flex');
  $('loginView').classList.remove('hidden');
});

db.auth.onAuthStateChange(async (_evento, sesion) => {
  if (sesion?.user && !user) await entrar(sesion.user);
});

async function entrar(u) {
  user = u;
  $('loginView').classList.add('hidden');
  $('appView').classList.remove('hidden');
  $('userEmail').textContent = u.email || '';
  cola = leerCola();
  await refrescar({ ajustarMapa: true });
  pintarTodo();
  if (!gpsIntentado) {
    gpsIntentado = true;
    activarGps();
  }
}

$('btnReloadSector').addEventListener('click', async () => {
  await refrescar({ ajustarMapa: true });
  pintarTodo();
});

// ============================================================
// DATOS (RLS: el servidor ya limita a sector activo / puntos propios)
// ============================================================
async function refrescar({ ajustarMapa = false } = {}) {
  // Sin señal se conserva lo que hay en memoria (no se "borra" el sector)
  if (!navigator.onLine) {
    if (mapListo && ajustarMapa) ajustarVistaMapa();
    return;
  }
  await cargarAsignacion();
  if (sector) await cargarPuntos();
  if (mapListo && ajustarMapa) ajustarVistaMapa();
}

async function cargarAsignacion() {
  const { data, error } = await db
    .from('sectores_asignaciones')
    .select('sector_id, estado, assigned_at, sectores ( id, nombre, comuna, color, geom )')
    .eq('user_id', user.id)
    .eq('estado', 'activa')
    .maybeSingle();
  if (error) {
    // red caída: conserva el sector en memoria; otro error (columna faltante,
    // RLS) se avisa para no confundirlo con "sin sector asignado"
    if (!esErrorDeRed(error)) toast('No se pudo cargar tu sector: ' + error.message, { error: true });
    return;
  }
  sector = data && data.sectores ? data : null;
}

async function cargarPuntos() {
  const { data, error } = await db
    .from('puntos')
    .select('*')
    .eq('sector_id', sector.sector_id)
    .is('deleted_at', null)
    .order('nombre');
  if (error) {
    if (!esErrorDeRed(error)) toast('No se pudieron cargar los puntos: ' + error.message, { error: true });
    return;
  }
  puntos = data || [];
}

// ============================================================
// COLA OFFLINE (localStorage; helpers puros en lib.js)
// ============================================================
function leerCola() {
  try { return JSON.parse(localStorage.getItem(COLA_KEY)) || []; }
  catch (_) { return []; }
}
function guardarCola() {
  try { localStorage.setItem(COLA_KEY, JSON.stringify(cola)); } catch (_) {}
}
function encolar(tipo, clave, datos) {
  opSeq += 1;
  const op = nuevaOpCola(tipo, clave, datos, `op-${Date.now()}-${opSeq}`, Date.now());
  cola = colaAgregar(cola, op);
  guardarCola();
  pintarCola();
}

// ============================================================
// RENDER
// ============================================================
function pintarTodo() {
  pintarVistaSector();
  pintarCola();
  pintarLista();
  pintarTarjetaSector();
  pintarFiltros();
  if (mapListo) actualizarCapaPuntos();
}

function pintarVistaSector() {
  const vacio = !sector;
  $('emptyView').classList.toggle('hidden', !vacio);
  $('emptyView').classList.toggle('flex', vacio);
  $('appView').classList.toggle('hidden', vacio);
}

function pintarCola() {
  const r = colaResumen(cola);
  const off = !navigator.onLine;

  $('headerSyncIcon').textContent = r.total ? 'cloud_off' : (off ? 'cloud_off' : 'cloud_done');
  $('headerSyncCount').textContent = r.total ? String(r.total) : '';

  $('stripIcon').textContent = off ? 'cloud_off' : 'cloud_sync';
  $('stripTitulo').textContent = off ? 'Modo offline activo' : 'Conectado';
  $('stripTexto').textContent = r.total
    ? `${r.total} gestión${r.total === 1 ? '' : 'es'} en cola local`
    : (off ? 'Sin señal: los cambios se guardan en el teléfono' : 'Sincronizado con central');
  $('stripComuna').textContent = sector?.sectores?.comuna || '—';

  $('fabSync').classList.toggle('hidden', !r.total);
  $('fabCount').textContent = String(r.total);

  $('syncResumen').textContent = r.total
    ? `${r.total} pendiente${r.total === 1 ? '' : 's'} · ${r.estado} estado, ${r.crear} nuevos, ${r.editar} edits, ${r.borrar} bajas`
    : 'Sin cambios pendientes';
  $('syncIcon').textContent = r.total ? 'pending_actions' : 'cloud_done';

  const lista = $('syncLista');
  lista.innerHTML = cola.map((o) => `
    <div class="bg-surface-container-lowest rounded-xl p-3 flex items-center gap-3 shadow-sm">
      <span class="material-symbols-outlined text-secondary">${iconoOp(o.tipo)}</span>
      <div class="flex flex-col min-w-0">
        <span class="text-sm font-semibold text-on-surface">${textoOp(o.tipo)}</span>
        <span class="text-xs text-on-surface-variant truncate">${escapeHtml(o.clave)}</span>
      </div>
    </div>`).join('');
}

function iconoOp(tipo) {
  return { estado: 'flag', crear: 'add_circle', editar: 'edit', borrar: 'delete' }[tipo] || 'sync';
}
function textoOp(tipo) {
  return { estado: 'Cambio de estado', crear: 'Punto nuevo', editar: 'Edición de punto', borrar: 'Borrado de punto' }[tipo] || tipo;
}

function pintarTarjetaSector() {
  const av = sectorAvance(puntos);
  const extra = colaResumen(cola).crear;
  $('sectorNombre').textContent = sector ? sector.sectores.nombre : '—';
  $('sectorProgreso').textContent = `${av.visitado} de ${av.total} visitados (${av.pct}%)`;
  const pct = (n) => (av.total ? (n / av.total) * 100 : 0) + '%';
  $('barVisitado').style.width = pct(av.visitado);
  $('barErroneo').style.width = pct(av.erroneo);
  $('barNoPasar').style.width = pct(av.no_pasar);
  $('cntVisitado').textContent = av.visitado;
  $('cntErroneo').textContent = av.erroneo;
  $('cntNoPasar').textContent = av.no_pasar;
  $('cntPendiente').textContent = av.pendiente + extra;
  $('tabListCount').textContent = av.total + extra;
}

function pintarFiltros() {
  const av = sectorAvance(puntos);
  const extra = colaResumen(cola).crear;
  const val = { todos: av.total + extra, visitado: av.visitado, incidencia: av.erroneo + av.no_pasar, pendiente: av.pendiente + extra };
  document.querySelectorAll('[data-badge]').forEach((b) => {
    b.textContent = String(val[b.dataset.badge] ?? 0);
  });
  document.querySelectorAll('.filtro').forEach((b) => {
    const activo = b.dataset.filtro === filtroActual;
    b.classList.toggle('bg-primary', activo);
    b.classList.toggle('text-on-primary', activo);
    b.classList.toggle('bg-surface-container-lowest', !activo);
    b.classList.toggle('text-on-surface-variant', !activo);
  });
}

document.querySelectorAll('.filtro').forEach((b) => {
  b.addEventListener('click', () => { filtroActual = b.dataset.filtro; pintarFiltros(); pintarLista(); });
});

function pasarFiltro(p) {
  if (filtroActual === 'todos') return true;
  if (filtroActual === 'incidencia') return p.estado === 'erroneo' || p.estado === 'no_pasar';
  return p.estado === filtroActual;
}

function pintarLista() {
  const box = $('pdvList');
  const locales = cola.filter((o) => o.tipo === 'crear').map((o) => ({
    id: o.clave, nombre: o.datos.nombre, direccion: o.datos.direccion,
    estado: 'pendiente', notas: o.datos.notas, local: true,
    lat: o.datos.lat, lng: o.datos.lng,
  }));
  const todo = [...puntos, ...locales].filter(pasarFiltro);

  if (!todo.length) {
    box.innerHTML = '<div class="text-sm text-on-surface-variant text-center py-8">No hay puntos con este filtro.</div>';
    return;
  }

  box.innerHTML = todo.map((p) => {
    const est = p.estado || 'pendiente';
    const coords = coordsDe(p);
    const nav = coords ? linkComoLlegar(coords.lat, coords.lng) : homeAppMapa();
    return `
    <article class="bg-surface-container-lowest rounded-xl p-4 shadow-sm flex flex-col gap-3" data-id="${escapeHtml(p.id)}">
      <div class="flex items-start justify-between gap-3">
        <div class="flex flex-col min-w-0 cursor-pointer" data-abrir="${escapeHtml(p.id)}">
          <span class="text-[11px] font-bold text-on-surface-variant">${p.local ? 'NUEVO · PENDIENTE SYNC' : 'PDV'}</span>
          <h3 class="text-base font-bold text-on-surface truncate">${escapeHtml(p.nombre || 'Sin nombre')}</h3>
          <p class="text-sm text-on-surface-variant">${escapeHtml(p.direccion || (coords ? `${coords.lat.toFixed(5)}, ${coords.lng.toFixed(5)}` : 'Sin dirección'))}</p>
        </div>
        ${chipEstado(est)}
      </div>
      ${p.notas ? `
      <div class="bg-surface-container-low p-2 rounded-lg flex items-center gap-2">
        <span class="material-symbols-outlined text-secondary text-[18px] shrink-0">info</span>
        <p class="text-xs text-on-surface-variant italic truncate">"${escapeHtml(p.notas)}"</p>
      </div>` : ''}
      <div class="grid grid-cols-2 gap-2">
        <a class="min-h-[48px] rounded-xl bg-surface-container text-primary text-sm font-semibold flex items-center justify-center gap-2 active:bg-surface-container-high"
           href="${nav}" target="_blank" rel="noopener">
          <span class="material-symbols-outlined text-[20px]">near_me</span><span>Cómo llegar</span>
        </a>
        <button class="min-h-[48px] rounded-xl bg-primary text-on-primary text-sm font-semibold flex items-center justify-center gap-2 active:bg-secondary"
                data-estado="${escapeHtml(p.id)}" data-nombre="${escapeHtml(p.nombre || '')}" ${p.local ? 'disabled' : ''}>
          <span class="material-symbols-outlined text-[20px]">edit</span><span>Cambiar estado</span>
        </button>
      </div>
    </article>`;
  }).join('');

  box.querySelectorAll('[data-abrir]').forEach((el) => {
    el.addEventListener('click', () => abrirFicha(el.dataset.abrir));
  });
  box.querySelectorAll('[data-estado]').forEach((b) => {
    b.addEventListener('click', () => abrirStatusSheet(b.dataset.estado, b.dataset.nombre));
  });
}

function chipEstado(est) {
  const mapa = {
    visitado: ['bg-tertiary-fixed text-on-tertiary-fixed', 'check_circle', 'Visitado'],
    erroneo: ['bg-error-container text-on-error-container', 'cancel', 'Erróneo'],
    no_pasar: ['bg-surface-container-high text-secondary', 'block', 'No pasar'],
    pendiente: ['bg-surface-container text-on-surface-variant', 'schedule', 'Pendiente'],
  };
  const [cls, ic, txt] = mapa[est] || mapa.pendiente;
  return `<span class="inline-flex items-center gap-1 px-3 py-1 rounded ${cls} text-xs font-semibold shrink-0">
    <span class="material-symbols-outlined text-[16px]">${ic}</span><span>${txt}</span></span>`;
}

// ============================================================
// MAPA
// ============================================================
function coordsDe(p) {
  if (p.lat != null && p.lng != null) return { lat: p.lat, lng: p.lng };
  const c = pointFromGeom(p.geom);
  return c;
}

function bboxDeGeometria(geom) {
  const pts = [];
  (function walk(c) {
    if (typeof c?.[0] === 'number') pts.push(c);
    else if (Array.isArray(c)) c.forEach(walk);
  })(geom?.coordinates);
  if (!pts.length) return null;
  const lngs = pts.map((c) => c[0]);
  const lats = pts.map((c) => c[1]);
  return [[Math.min(...lngs), Math.min(...lats)], [Math.max(...lngs), Math.max(...lats)]];
}

function initMap() {
  if (map || !sector) return;
  const gl = document.createElement('canvas').getContext('webgl2')
    || document.createElement('canvas').getContext('webgl');
  if (!gl) {
    toast('WebGL no está disponible en este navegador', { error: true });
    return;
  }
  const geom = sector.sectores.geom;
  const bb = bboxDeGeometria(geom);
  const centro = bb ? [(bb[0][0] + bb[1][0]) / 2, (bb[0][1] + bb[1][1]) / 2] : [-70.6483, -33.457];

  map = new maplibregl.Map({
    container: 'mapMovil',
    style: MAP_STYLE,
    center: centro,
    zoom: 14,
    attributionControl: { compact: true },
  });

  map.on('load', () => {
    if (geom) {
      map.addSource('sector-movil', { type: 'geojson', data: { type: 'Feature', geometry: geom, properties: {} } });
      map.addLayer({
        id: 'sector-movil-fill', type: 'fill', source: 'sector-movil',
        paint: { 'fill-color': sector.sectores.color || '#3b82f6', 'fill-opacity': 0.08 },
      });
      map.addLayer({
        id: 'sector-movil-line', type: 'line', source: 'sector-movil',
        paint: { 'line-color': sector.sectores.color || '#3b82f6', 'line-width': 2 },
      });
    }
    mapListo = true;
    ajustarVistaMapa();
    actualizarCapaPuntos();
    ponerMarcadorUsuario();

    // Tocar el mapa en el modo lista no crea puntos: solo en la vista mapa
    map.on('click', (e) => {
      if (tabActual !== 'mapa') return;
      abrirFichaNueva(e.lngLat.lng, e.lngLat.lat);
    });
  });
}

function ajustarVistaMapa() {
  if (!map || !sector) return;
  const bb = bboxDeGeometria(sector.sectores.geom);
  if (bb) {
    map.fitBounds(bb, { padding: 40, duration: 0 });
  } else if (puntos.length) {
    const coords = puntos.map(coordsDe).filter(Boolean).map((c) => [c.lng, c.lat]);
    if (coords.length) {
      map.fitBounds(coords, { padding: 40, duration: 0 });
    }
  }
}

function actualizarCapaPuntos() {
  if (!mapListo || !map) return;
  Object.values(markers).forEach((m) => m.remove());
  markers = {};

  const pintar = (p, { local = false } = {}) => {
    const c = coordsDe(p);
    if (!c) return;
    const est = p.estado || 'pendiente';
    const el = document.createElement('div');
    el.className = 'pin-wrap';
    el.innerHTML = `<div class="pin${local ? ' is-nuevo' : ''}" data-est="${est}"><span class="ms pin-ic material-symbols-outlined text-[15px]">${PIN_ICONS[est] || 'schedule'}</span></div>`;
    el.addEventListener('click', (ev) => {
      ev.stopPropagation();
      if (local) return;
      abrirFicha(p.id);
    });
    markers[p.id] = new maplibregl.Marker({ element: el }).setLngLat([c.lng, c.lat]).addTo(map);
  };

  puntos.forEach((p) => pintar(p));
  cola.filter((o) => o.tipo === 'crear').forEach((o) => {
    pintar({ id: o.clave, estado: 'pendiente', lat: o.datos.lat, lng: o.datos.lng }, { local: true });
  });

  const av = sectorAvance(puntos);
  $('mapLegend').innerHTML = `
    <span class="text-on-tertiary">${av.visitado} visitados</span>
    <span class="text-error">${av.erroneo} erróneos</span>
    <span class="text-secondary">${av.no_pasar} no pasar</span>
    <span class="text-on-surface-variant">${av.pendiente} pendientes</span>`;
}

// ============================================================
// FICHA DE PUNTO (ver/editar/nuevo)
// ============================================================
function puntoPorId(id) {
  return puntos.find((p) => p.id === id) || null;
}

function abrirFicha(id) {
  const p = puntoPorId(id);
  if (!p) {
    toast('Este punto está en cola local; sincroniza para editarlo', { error: false });
    return;
  }
  const c = coordsDe(p) || {};
  sheetPunto = { id: p.id, lat: c.lat ?? '', lng: c.lng ?? '', esNuevo: false };

  $('pointSheetKicker').textContent = 'Detalle del punto';
  $('pointSheetTitle').textContent = p.nombre || 'Punto';
  $('pointSheetError').textContent = '';
  $('fPDVNombre').value = p.nombre || '';
  $('fPDVDireccion').value = p.direccion || '';
  $('fPDVNotas').value = p.notas || '';
  $('fPDVLat').value = c.lat != null ? Number(c.lat).toFixed(6) : '';
  $('fPDVLng').value = c.lng != null ? Number(c.lng).toFixed(6) : '';
  $('pointSheetBadges').innerHTML = chipEstado(p.estado || 'pendiente')
    + (p.user_id === user.id ? '<span class="text-[11px] font-bold text-secondary bg-surface-container px-2 py-1 rounded">CREADO POR TI</span>' : '');

  const coords = coordsDe(p);
  $('btnPointNav').href = coords ? linkComoLlegar(coords.lat, coords.lng) : homeAppMapa();
  $('btnPointNav').classList.toggle('hidden', !coords);
  $('btnPointStatus').classList.remove('hidden');
  $('btnPointDelete').classList.toggle('hidden', p.user_id !== user.id);
  $('btnPointSaveLabel').textContent = 'Guardar cambios';
  sheetOpen('pointSheet');
}

function abrirFichaNueva(lng, lat) {
  sheetPunto = { id: null, lat, lng, esNuevo: true };
  $('pointSheetKicker').textContent = 'Punto nuevo';
  $('pointSheetTitle').textContent = 'Agregar punto';
  $('pointSheetError').textContent = '';
  $('fPDVNombre').value = '';
  $('fPDVDireccion').value = '';
  $('fPDVNotas').value = '';
  $('fPDVLat').value = Number(lat).toFixed(6);
  $('fPDVLng').value = Number(lng).toFixed(6);
  $('pointSheetBadges').innerHTML = '';
  $('btnPointNav').classList.add('hidden');
  $('btnPointStatus').classList.add('hidden');
  $('btnPointDelete').classList.add('hidden');
  $('btnPointSaveLabel').textContent = 'Guardar punto';
  sheetOpen('pointSheet');
}

$('btnPointLocate').addEventListener('click', () => {
  if (!navigator.geolocation) { toast('Este teléfono no tiene GPS', { error: true }); return; }
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      $('fPDVLat').value = pos.coords.latitude.toFixed(6);
      $('fPDVLng').value = pos.coords.longitude.toFixed(6);
      toast('Ubicación capturada');
    },
    () => toast('No se pudo obtener tu ubicación', { error: true }),
    { enableHighAccuracy: true, timeout: 10000 }
  );
});

$('btnPointStatus').addEventListener('click', () => {
  const p = puntoPorId(sheetPunto?.id);
  if (!p) return;
  sheetClose('pointSheet');
  abrirStatusSheet(p.id, p.nombre);
});

$('btnPointSave').addEventListener('click', guardarFicha);

async function guardarFicha() {
  const nombre = $('fPDVNombre').value.trim();
  const direccion = $('fPDVDireccion').value.trim();
  const notas = $('fPDVNotas').value.trim();
  const lat = parseFloat($('fPDVLat').value);
  const lng = parseFloat($('fPDVLng').value);
  const err = $('pointSheetError');
  err.textContent = '';

  if (!nombre) { err.textContent = 'El nombre es obligatorio'; return; }
  if (isNaN(lat) || isNaN(lng)) { err.textContent = 'Latitud/longitud inválidas'; return; }
  if (!dentroDelSector(lat, lng)) { err.textContent = 'Las coordenadas quedan fuera de tu sector'; return; }

  if (sheetPunto.esNuevo) {
    // Intenta contra el servidor; sin señal, encola la creación
    const { error } = await db.rpc('guardar_punto', {
      p_id: null, p_nombre: nombre, p_direccion: direccion,
      p_estado: 'pendiente', p_notas: notas, p_lat: lat, p_lng: lng,
    });
    if (error) {
      if (esErrorDeRed(error)) {
        encolar('crear', `local-${Date.now()}`, { nombre, direccion, notas, lat, lng });
        toast('Sin señal: el punto quedó en cola local');
      } else {
        err.textContent = error.message;
        return;
      }
    } else {
      toast('Punto creado');
    }
    sheetClose('pointSheet');
    await refrescar({ ajustarMapa: false });
    pintarTodo();
    return;
  }

  const { error } = await db.rpc('actualizar_punto_terreno', {
    p_id: sheetPunto.id, p_nombre: nombre, p_direccion: direccion,
    p_notas: notas, p_lat: lat, p_lng: lng,
  });
  if (error) {
    if (esErrorDeRed(error)) {
      encolar('editar', sheetPunto.id, { nombre, direccion, notas, lat, lng });
      toast('Sin señal: la edición quedó en cola local');
      sheetClose('pointSheet');
      return;
    }
    err.textContent = error.message;
    return;
  }
  toast('Punto actualizado');
  sheetClose('pointSheet');
  await refrescar();
  pintarTodo();
}

function dentroDelSector(lat, lng) {
  const g = sector?.sectores?.geom;
  if (!g) return true; // sin polígono no se puede validar en cliente
  return pointInGeometry(lng, lat, g);
}

// ============================================================
// ESTADOS (RPC marcar_estado + deshacer + cola offline)
// ============================================================
function abrirStatusSheet(id, nombre) {
  statusTarget = { id, nombre };
  $('statusSheetTitle').textContent = nombre || 'Punto';
  const box = $('statusBtns');
  box.innerHTML = '';
  const iconos = { pendiente: 'schedule', visitado: 'check_circle', erroneo: 'cancel', no_pasar: 'block' };
  const clases = {
    pendiente: 'bg-surface-container text-on-surface',
    visitado: 'bg-tertiary-fixed text-on-tertiary-fixed',
    erroneo: 'bg-error-container text-on-error-container',
    no_pasar: 'bg-surface-container-high text-secondary',
  };
  for (const [valor, etiqueta] of ESTADOS) {
    const b = document.createElement('button');
    b.className = `min-h-[52px] rounded-xl ${clases[valor]} font-semibold flex items-center justify-between px-4 active:opacity-90`;
    b.innerHTML = `<span class="flex items-center gap-3">
        <span class="material-symbols-outlined text-[24px]">${iconos[valor]}</span>
        <span>${etiqueta}</span></span>
      <span class="material-symbols-outlined text-[20px]">chevron_right</span>`;
    b.addEventListener('click', () => {
      sheetClose('statusSheet');
      aplicarEstado(statusTarget.id, valor);
    });
    box.appendChild(b);
  }
  sheetOpen('statusSheet');
}

async function aplicarEstado(id, estado, { silent = false } = {}) {
  const p = puntoPorId(id);
  if (!p) return;
  const prev = p.estado || 'pendiente';

  // Optimista: la lista refleja el cambio al instante
  p.estado = estado;
  pintarLista(); pintarTarjetaSector(); pintarFiltros(); actualizarCapaPuntos();

  const { error } = await db.rpc('marcar_estado', { p_id: id, p_estado: estado });
  if (error) {
    if (esErrorDeRed(error)) {
      encolar('estado', id, { estado });
      if (!silent) toast('Sin señal: el cambio quedó en cola local');
      return;
    }
    p.estado = prev; // revierte el optimismo
    pintarLista(); pintarTarjetaSector(); pintarFiltros(); actualizarCapaPuntos();
    toast(error.message, { error: true });
    return;
  }
  if (!silent && prev !== estado) {
    toast(`Marcado como "${estadoLabel(estado)}"`, {
      undo: prev !== estado ? { id, prev } : null,
    });
  }
}

// ============================================================
// BORRAR (solo puntos creados por el colaborador)
// ============================================================
$('btnPointDelete').addEventListener('click', () => {
  const p = puntoPorId(sheetPunto?.id);
  if (!p || p.user_id !== user.id) return;
  sheetClose('pointSheet');
  preguntar('¿Borrar punto?', `Se ocultará "${p.nombre}" para todos. Solo puedes borrar puntos que tú creaste.`, async () => {
    const { error } = await db.rpc('eliminar_punto_propio', { p_id: p.id });
    if (error) {
      if (esErrorDeRed(error)) {
        encolar('borrar', p.id, {});
        toast('Sin señal: el borrado quedó en cola local');
        return;
      }
      toast(error.message, { error: true });
      return;
    }
    toast('Punto borrado');
    await refrescar();
    pintarTodo();
  });
});

// ============================================================
// DEVOLVER SECTOR
// ============================================================
$('btnDevolver').addEventListener('click', () => {
  if (!sector) return;
  preguntar(
    '¿Devolver el sector?',
    `Vas a devolver "${sector.sectores.nombre}" a central aunque no esté terminado. Dejarás de verlo al instante.`,
    async () => {
      const { error } = await db.rpc('devolver_sector');
      if (error) {
        toast(esErrorDeRed(error) ? 'Sin señal: no se pudo devolver' : error.message, { error: true });
        return;
      }
      sector = null;
      puntos = [];
      if (map) { map.remove(); map = null; mapListo = false; markers = {}; }
      pintarTodo();
      toast('Sector devuelto a central');
    }
  );
});

// ============================================================
// NAVEGACIÓN AL SIGUIENTE PUNTO
// ============================================================
$('btnNavegar').addEventListener('click', () => {
  const siguiente = puntos.find((p) => (p.estado || 'pendiente') === 'pendiente') || puntos[0];
  const c = siguiente ? coordsDe(siguiente) : null;
  if (c) { abrirRuta(c.lat, c.lng); return; }
  const bb = bboxDeGeometria(sector?.sectores?.geom);
  if (bb) { abrirRuta((bb[0][1] + bb[1][1]) / 2, (bb[0][0] + bb[1][0]) / 2); return; }
  toast('Sin coordenadas para navegar', { error: true });
});

// ============================================================
// TABS (Mapa / Ruta / Sync)
// ============================================================
function pintarTabs() {
  const vistas = { mapa: 'mapView', ruta: 'listView', sync: 'syncView' };
  for (const [tab, id] of Object.entries(vistas)) {
    $(id).classList.toggle('hidden', tab !== tabActual);
    $(id).classList.toggle('flex', tab === tabActual);
  }
  $('tabListBtn').classList.toggle('bg-surface-container-lowest', tabActual === 'ruta');
  $('tabListBtn').classList.toggle('text-primary', tabActual === 'ruta');
  $('tabListBtn').classList.toggle('shadow-sm', tabActual === 'ruta');
  $('tabListBtn').classList.toggle('text-on-surface-variant', tabActual !== 'ruta');
  $('tabMapBtn').classList.toggle('bg-surface-container-lowest', tabActual === 'mapa');
  $('tabMapBtn').classList.toggle('text-primary', tabActual === 'mapa');
  $('tabMapBtn').classList.toggle('shadow-sm', tabActual === 'mapa');
  $('tabMapBtn').classList.toggle('text-on-surface-variant', tabActual !== 'mapa');
  document.querySelectorAll('.navtab').forEach((b) => {
    const activo = b.dataset.tab === tabActual;
    b.classList.toggle('text-secondary', activo);
    b.classList.toggle('bg-surface-container', activo);
    b.classList.toggle('font-semibold', activo);
    b.classList.toggle('text-on-surface-variant', !activo);
  });
  if (tabActual === 'mapa') {
    if (!map && sector) {
      try { initMap(); } catch (e) { console.error(e); toast('No se pudo iniciar el mapa: ' + e.message, { error: true }); }
    } else if (map) { map.resize(); actualizarCapaPuntos(); }
  }
}

function irA(tab) { tabActual = tab; pintarTabs(); }
document.querySelectorAll('.navtab').forEach((b) => b.addEventListener('click', () => irA(b.dataset.tab)));
$('tabListBtn').addEventListener('click', () => irA('ruta'));
$('tabMapBtn').addEventListener('click', () => irA('mapa'));

// ============================================================
// SINCRONIZACIÓN
// ============================================================
function esErrorDeRed(error) {
  const m = String(error?.message || '');
  return /Failed to fetch|NetworkError|ERR_NETWORK|fetch failed|Load failed/i.test(m)
    || (!navigator.onLine && /fetch|network/i.test(m));
}

async function sincronizar() {
  if (syncRunning) return;
  if (!cola.length) {
    await refrescar();
    pintarTodo();
    toast('Todo al día');
    return;
  }
  syncRunning = true;
  $('syncBtnIcon').classList.add('spin-slow');

  let listos = 0;
  let descartados = 0;

  for (const op of [...cola]) {
    const r = await ejecutarOp(op);
    if (r === 'offline') break;
    cola = colaQuitar(cola, op.id);
    guardarCola();
    if (r === 'ok') listos += 1;
    if (r === 'descartado') descartados += 1;
  }

  syncRunning = false;
  $('syncBtnIcon').classList.remove('spin-slow');
  await refrescar({ ajustarMapa: true });
  pintarTodo();

  const partes = [];
  if (listos) partes.push(`${listos} sincronizado${listos === 1 ? '' : 's'}`);
  if (descartados) partes.push(`${descartados} descartado${descartados === 1 ? '' : 's'} (ya no aplican)`);
  if (cola.length) partes.push(`${cola.length} en cola (sin señal)`);
  toast(partes.length ? partes.join(' · ') : 'Todo al día');
}

async function ejecutarOp(op) {
  try {
    if (op.tipo === 'estado') {
      const { error } = await db.rpc('marcar_estado', { p_id: op.clave, p_estado: op.datos.estado });
      if (error) return esErrorDeRed(error) ? 'offline' : 'descartado';
      return 'ok';
    }
    if (op.tipo === 'crear') {
      const { error } = await db.rpc('guardar_punto', {
        p_id: null, p_nombre: op.datos.nombre, p_direccion: op.datos.direccion,
        p_estado: 'pendiente', p_notas: op.datos.notas, p_lat: op.datos.lat, p_lng: op.datos.lng,
      });
      if (error) return esErrorDeRed(error) ? 'offline' : 'descartado';
      return 'ok';
    }
    if (op.tipo === 'editar') {
      const { error } = await db.rpc('actualizar_punto_terreno', {
        p_id: op.clave, p_nombre: op.datos.nombre, p_direccion: op.datos.direccion,
        p_notas: op.datos.notas, p_lat: op.datos.lat, p_lng: op.datos.lng,
      });
      if (error) return esErrorDeRed(error) ? 'offline' : 'descartado';
      return 'ok';
    }
    if (op.tipo === 'borrar') {
      const { error } = await db.rpc('eliminar_punto_propio', { p_id: op.clave });
      if (error) return esErrorDeRed(error) ? 'offline' : 'descartado';
      return 'ok';
    }
    return 'descartado';
  } catch (_) {
    return 'offline';
  }
}

$('btnSyncAhora').addEventListener('click', sincronizar);
$('btnFabSync').addEventListener('click', sincronizar);
$('headerSync').addEventListener('click', () => { irA('sync'); sincronizar(); });

window.addEventListener('online', () => { pintarCola(); sincronizar(); });
window.addEventListener('offline', pintarCola);
setInterval(() => { if (cola.length && navigator.onLine) sincronizar(); }, 45000);

// ============================================================
// ARRANQUE
// ============================================================
(async function boot() {
  pintarTabs();
  try {
    const { data } = await db.auth.getSession();
    if (data?.session?.user) await entrar(data.session.user);
  } catch (e) {
    console.error(e);
    toast('No se pudo recuperar la sesión: ' + e.message, { error: true });
  }
})();
