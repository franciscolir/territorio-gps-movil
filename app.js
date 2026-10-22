// ============================================================
// APP DE TERRENO — colaboradores (repo móvil autónomo).
// · ve SOLO su territorio asignado y sus puntos (RLS de la migración 003)
// · crea/edita puntos del territorio, cambia estados, borra solo los suyos
// · devuelve el territorio aunque no cubra el 100%
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
// (misma URL, dos pestañas). SIN lock custom: el lock sobre navigator.locks
// no soporta re-entrada y podía auto-bloquearse cuando un flujo de auth
// (onAuthStateChange → refrescar → refreshSession) corría dentro de otro
// lock, dejando la app colgada tras recargar (sin sesión, sin mapa, sin
// poder cerrar sesión). Sin lock, un refresh concurrente entre pestañas
// es inofensivo (gana el último token escrito).
const db = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    storageKey: 'gps-movil-session',
  },
  // OJO: no pasar la opción `accessToken` a createClient. Deja el cliente en
  // modo "auth externa" y entonces `db.auth.signInWithPassword` y
  // `db.auth.getSession` (y el resto de los métodos de auth) lanzan en
  // supabase-js ≥ 2.83. La recarga con token viejo ya está cubierta:
  // refrescar() espera asegurarSesionVigente() antes de consultar, así que
  // las peticiones salen con el token vigente sin inyectarlo por petición.
});

let user = null;
let territorio = null;      // asignación activa con el territorio anidado
let errorTerritorio = null; // último error al cargar la asignación (diagnóstico)
let puntos = [];        // puntos del servidor (RLS ya limita al territorio)
let cola = [];          // operaciones offline pendientes
let tabActual = 'inicio';
let filtroActual = 'todos';
let map = null;
let mapListo = false;
let markers = {};       // id -> Marker
let sateliteActiva = false; // vista satélite del mapa (por instancia de mapa)
let sheetPunto = null;  // { id, lat, lng, esNuevo }
let undoInfo = null;    // { id, prev, timer }
let confirmAction = null;
let syncRunning = false;
let opSeq = 0;

// Aviso de territorio completado (modal revisar/enviar)
let avisoTerritorioId = null; // sector_id que ya mostró el modal (no repetir)

// Configuración local (persistida en localStorage)
let appMapa = 'google';   // 'google' | 'waze' | 'apple'
let tema = 'claro';       // 'claro' | 'oscuro'
try { const g = localStorage.getItem('gps_app_mapa'); if (g) appMapa = g; } catch (_) {}
try { if (localStorage.getItem('gps_tema') === 'oscuro') tema = 'oscuro'; } catch (_) {}
document.documentElement.classList.toggle('dark', tema === 'oscuro');

// GPS del dispositivo
let gpsEstado = 'pendiente'; // 'activo' | 'pendiente' | 'nodisponible'
let gpsPrecisionM = null; // precisión del último fix (metros)
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
function sheetClose(id) {
  $(id).classList.add('hidden');
  $(id).classList.remove('flex');
  // La tabla de revisión cerrada sin enviar habilita el FAB «Enviar informe»
  if (id === 'revisionSheet' && !enviandoInforme) { revisionPendiente = true; actualizarFabInforme(); }
}

// FAB "Enviar informe": disponible en todas las vistas mientras quede
// pendiente por revisar/enviar (se limpia al enviar o al devolver territorio)
let revisionPendiente = false;
let enviandoInforme = false;

function actualizarFabInforme() {
  if (!territorio) revisionPendiente = false;
  $('fabInforme').classList.toggle('hidden', !revisionPendiente);
  $('fabInforme').classList.toggle('flex', revisionPendiente);
}

$('btnFabInforme').addEventListener('click', () => abrirRevision());

document.querySelectorAll('[data-close]').forEach((b) => {
  b.addEventListener('click', () => sheetClose(b.dataset.close));
});
// Clic fuera de la hoja = cerrar
for (const id of ['pointSheet', 'confirmSheet', 'configSheet', 'completadoSheet', 'revisionSheet']) {
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
// en el header y el menú del mapa; denegado/sin señal → "UBICACIÓN NO DISPONIBLE".
// ============================================================
function setGpsEstado(estado) {
  gpsEstado = estado;
  const info = estado === 'activo'
    ? { dot: 'bg-on-tertiary-container', txt: 'GPS ACTIVO', pulse: true }
    : estado === 'pendiente'
      ? { dot: 'bg-surface-variant', txt: 'ACTIVAR UBICACIÓN' }
      : { dot: 'bg-error', txt: 'UBICACIÓN NO DISPONIBLE' };
  [$('gpsDot'), $('mapGpsDot')].filter(Boolean).forEach((dot) => {
    dot.classList.remove('bg-on-tertiary-container', 'bg-error', 'bg-surface-variant', 'animate-pulse');
    dot.classList.add(info.dot);
    if (info.pulse) dot.classList.add('animate-pulse');
  });
  [$('headerEstado'), $('mapGpsLabel')].filter(Boolean).forEach((txt) => {
    txt.textContent = info.txt;
  });
  pintarGpsConfig();
  pintarInicioGps();
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
      gpsPrecisionM = pos.coords.accuracy ?? null;
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

function abrirConfig() { pintarConfig(); sheetOpen('configSheet'); }
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
$('btnSatelite').addEventListener('click', alternarSatelite);
$('btnVolverTerritorio').addEventListener('click', () => {
  if (!territorio) { toast('No hay territorio asignado', { error: true }); return; }
  if (!map || !mapListo) return;
  ajustarVistaMapa();
});
setGpsEstado('pendiente');

let controlesMapaAbiertos = true;

function setControlesMapa(abiertos) {
  controlesMapaAbiertos = abiertos;
  const controles = $('mapControles');
  if (controles) controles.style.display = abiertos ? 'flex' : 'none';
  const btn = $('btnColapsarControles');
  if (!btn) return;
  btn.setAttribute('aria-expanded', String(abiertos));
  btn.setAttribute('aria-label', abiertos ? 'Ocultar controles del mapa' : 'Mostrar controles del mapa');
  btn.setAttribute('title', abiertos ? 'Ocultar controles del mapa' : 'Mostrar controles del mapa');
  const icon = btn.querySelector('.material-symbols-outlined');
  if (icon) icon.textContent = abiertos ? 'unfold_less' : 'unfold_more';
}

$('btnColapsarControles').addEventListener('click', () => setControlesMapa(!controlesMapaAbiertos));
$('mapStatsToggle').addEventListener('click', () => {
  const detalle = $('mapStatsDetalle');
  if (!detalle) return;
  const abierto = detalle.style.display !== 'none';
  detalle.style.display = abierto ? 'none' : 'flex';
  $('mapStatsToggle').setAttribute('aria-expanded', String(!abierto));
});

function abrirMenuMapa() {
  const menu = $('mapMenu');
  if (!menu) return;
  menu.classList.add('abierto');
  menu.setAttribute('aria-hidden', 'false');
  $('mapMenuBtn')?.setAttribute('aria-expanded', 'true');
}

function cerrarMenuMapa() {
  const menu = $('mapMenu');
  if (!menu) return;
  menu.classList.remove('abierto');
  menu.setAttribute('aria-hidden', 'true');
  $('mapMenuBtn')?.setAttribute('aria-expanded', 'false');
}

function abrirMenuApp() {
  const menu = $('appMenu');
  if (!menu) return;
  menu.classList.add('abierto');
  menu.setAttribute('aria-hidden', 'false');
  $('appMenuBtn')?.setAttribute('aria-expanded', 'true');
}

function cerrarMenuApp() {
  const menu = $('appMenu');
  if (!menu) return;
  menu.classList.remove('abierto');
  menu.setAttribute('aria-hidden', 'true');
  $('appMenuBtn')?.setAttribute('aria-expanded', 'false');
}

$('mapMenuBtn').addEventListener('click', abrirMenuMapa);
$('mapMenuClose').addEventListener('click', cerrarMenuMapa);
$('mapMenuBackdrop').addEventListener('click', cerrarMenuMapa);
$('mapGpsEstado').addEventListener('click', () => { cerrarMenuMapa(); if (gpsEstado !== 'activo') activarGps(); });
$('mapDevolver').addEventListener('click', () => { cerrarMenuMapa(); devolverTerritorio(); });
$('mapConfig').addEventListener('click', () => { cerrarMenuMapa(); abrirConfig(); });
$('mapLogout').addEventListener('click', () => { cerrarMenuMapa(); cerrarSesion(); });

$('appMenuBtn').addEventListener('click', abrirMenuApp);
$('appMenuClose').addEventListener('click', cerrarMenuApp);
$('appMenuBackdrop').addEventListener('click', cerrarMenuApp);
$('appMenuDevolver').addEventListener('click', () => { cerrarMenuApp(); devolverTerritorio(); });
$('appMenuConfig').addEventListener('click', () => { cerrarMenuApp(); abrirConfig(); });
$('appMenuLogout').addEventListener('click', () => { cerrarMenuApp(); cerrarSesion(); });

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  cerrarMenuMapa();
  cerrarMenuApp();
});

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

async function cerrarSesion() {
  await db.auth.signOut();
  user = null; territorio = null; puntos = [];
  detenerGps();
  cerrarMenuApp();
  cerrarMenuMapa();
  $('appView').classList.add('hidden');
  $('emptyView').classList.add('hidden');
  $('emptyView').classList.remove('flex');
  $('loginView').classList.remove('hidden');
}

// Eventos de auth: con la opción accessToken el cliente principal NO permite
// onAuthStateChange (lanza en supabase-js ≥ 2.83). Se usa un cliente de
// eventos ligero con el MISMO storageKey, que ve la misma sesión y avisa de
// cambios (p. ej. sesión creada en otra pestaña o revocada).
const authEventos = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: false, // quien refresca es el cliente principal
    storageKey: 'gps-movil-session',
  },
});
authEventos.auth.onAuthStateChange(async (_evento, sesion) => {
  if (sesion?.user && !user) await entrar(sesion.user);
});

async function entrar(u) {
  user = u;
  $('loginView').classList.add('hidden');
  $('appView').classList.remove('hidden');
  $('appMenuUser').textContent = u.email || '';
  cola = leerCola();
  await refrescar({ ajustarMapa: true });
  pintarTodo();
  if (!gpsIntentado) {
    gpsIntentado = true;
    activarGps();
  }
}

$('btnReloadTerritorio').addEventListener('click', async () => {
  await refrescar({ ajustarMapa: true });
  pintarTodo();
});

// ============================================================
// DATOS (RLS: el servidor ya limita a territorio activo / puntos propios)
// ============================================================
async function refrescar({ ajustarMapa = false } = {}) {
  // Sin señal se conserva lo que hay en memoria (no se "borra" el territorio)
  if (!navigator.onLine) {
    if (mapListo && ajustarMapa) ajustarVistaMapa();
    return;
  }
  // Al recargar el navegador el token guardado puede estar expirado:
  // se asegura vigencia antes de consultar (y reintenta si aun así falla)
  await asegurarSesionVigente();
  await cargarAsignacion();
  await cargarPuntos(); // con territorio: los suyos; en modo libre: mapa general
  await cargarTareas();
  if (mapListo && ajustarMapa) ajustarVistaMapa();
}

// Renueva la sesión si vence en menos de un minuto
async function asegurarSesionVigente() {
  try {
    const { data } = await db.auth.getSession();
    const expira = (data?.session?.expires_at ?? 0) * 1000;
    if (data?.session && expira - Date.now() < 60000) {
      await db.auth.refreshSession();
    }
  } catch (_) { /* sin sesión o sin señal: se sigue igual */ }
}

// ¿El error viene de un token viejo/invalido? (merece refresh + reintento)
function esErrorDeSesion(error) {
  const m = String(error?.message || '') + ' ' + String(error?.code || '') + ' ' + String(error?.status || '');
  return /jwt|token|401|unauthorized|invalid api key/i.test(m);
}

async function cargarAsignacion({ reintentado = false } = {}) {
  const { data, error } = await db
    .from('territorios_asignaciones')
    .select('territorio_id, estado, assigned_at, puntos_base, territorios ( id, nombre, comuna, color, geom )')
    .eq('user_id', user.id)
    // Solo asignaciones activas: al completarse (auto al 100 %, migración 008)
    // el colaborador deja de ver el territorio y sus puntos. La reasignación
    // inserta una fila 'activa' nueva (migración 010 reinicia los visitados).
    .eq('estado', 'activa')
    .maybeSingle();
  if (error) {
    if (!esErrorDeRed(error) && !reintentado && esErrorDeSesion(error)) {
      try { await db.auth.refreshSession(); } catch (_) {}
      return cargarAsignacion({ reintentado: true });
    }
    // red caída: conserva el territorio en memoria; otro error (columna faltante,
    // grants/RLS) se avisa para no confundirlo con "sin territorio asignado"
    errorTerritorio = error.message;
    if (!esErrorDeRed(error)) toast('No se pudo cargar tu territorio: ' + error.message, { error: true });
    return;
  }
  errorTerritorio = null;
  territorio = data && data.territorios ? data : null;
}

async function cargarPuntos() {
  // NORMA DE SEGURIDAD: sin territorio activo NO se consulta nada. El móvil
  // solo lee puntos de su territorio activo (lo garantiza RLS y este guard
  // evita incluso intentarlo). Las tareas del admin vienen por su propia
  // tabla (tareas_verificacion, RLS solo asignado + admin).
  if (!territorio) {
    puntos = [];
    return;
  }
  const { data, error } = await db
    .from('puntos')
    .select('*')
    .is('deleted_at', null)
    .eq('territorio_id', territorio.territorio_id)
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
  pintarVistaTerritorio();
  pintarHeader();
  pintarCola();
  pintarLista();
  pintarTarjetaTerritorio();
  pintarFiltros();
  pintarInicio();
  pintarTabs();
  actualizarFabInforme();
  if (mapListo) actualizarCapaPuntos();
}

function pintarHeader() {
  const t = territorio?.territorios;
  $('headerTitulo').textContent = t
    ? [t.comuna, t.nombre].filter(Boolean).join(' · ')
    : 'Sin territorio';
}

// ============================================================
// VISTA INICIO (saludo, GPS, territorio, métricas y sync)
// ============================================================
function nombreDesdeEmail(email) {
  const base = String(email || '').split('@')[0].split(/[._\-+]+/)[0] || '';
  return base ? base.charAt(0).toUpperCase() + base.slice(1) : '';
}

function fechaHoy() {
  const f = new Date().toLocaleDateString('es-CL', { weekday: 'long', day: 'numeric', month: 'long' });
  return f.charAt(0).toUpperCase() + f.slice(1);
}

// Calidad del fix según los metros de error reportados por el GPS
function calidadPrecision(m) {
  if (m == null) return 'Precisión disponible en el mapa';
  const q = m <= 10 ? 'Excelente' : m <= 30 ? 'Buena' : 'Regular';
  return `Precisión de alta fidelidad: ${Math.round(m)}m (${q})`;
}

function pintarInicio() {
  const nombre = nombreDesdeEmail(user?.email);
  $('inicioSaludo').textContent = nombre ? `¡Hola, ${nombre}!` : '¡Hola!';
  $('inicioFecha').textContent = fechaHoy();
  pintarInicioGps();
  pintarInicioLabores();
  pintarInicioTerritorio();
  pintarInicioTareas();
  pintarInicioMetricas();
  pintarInicioSync();
}

function pintarInicioGps() {
  const box = $('inicioGpsBanner');
  if (!box) return;
  if (gpsEstado === 'activo') {
    box.className = 'gps-on rounded-2xl p-4 flex items-center justify-between shadow-sm';
    box.innerHTML = `
      <div class="flex items-center gap-3 min-w-0">
        <div class="w-10 h-10 rounded-xl gps-on-ic flex items-center justify-center shrink-0">
          <span class="material-symbols-outlined text-[22px]">my_location</span>
        </div>
        <div class="min-w-0">
          <div class="flex items-center gap-1.5">
            <span class="text-[15px] font-bold gps-on-title">GPS Activo y Calibrado</span>
            <span class="w-2 h-2 rounded-full gps-on-dot animate-pulse"></span>
          </div>
          <p class="text-[12px] text-on-surface-variant mt-0.5">${escapeHtml(calidadPrecision(gpsPrecisionM))}</p>
        </div>
      </div>
      <span class="material-symbols-outlined gps-on-check text-[26px] shrink-0">check_circle</span>`;
    return;
  }
  const noDisponible = gpsEstado === 'nodisponible';
  box.className = 'gps-off rounded-2xl p-4 flex flex-col gap-3';
  box.innerHTML = `
    <div class="flex items-start gap-3">
      <div class="w-11 h-11 rounded-xl gps-off-ic flex items-center justify-center shrink-0 mt-0.5">
        <span class="material-symbols-outlined text-[24px]">location_searching</span>
      </div>
      <div class="flex-1 min-w-0">
        <div class="flex items-center justify-between gap-1 flex-wrap">
          <span class="text-[16px] font-bold gps-off-title">${noDisponible ? 'Ubicación no disponible' : 'Ubicación GPS inactiva'}</span>
          <span class="text-[10px] gps-off-chip font-bold px-2 py-0.5 rounded-full uppercase tracking-wider">Requerido para operar</span>
        </div>
        <p class="text-[13px] gps-off-txt mt-1 leading-snug">${noDisponible
          ? 'Permiso denegado o GPS apagado. Actívalo en tu teléfono para registrar visitas y validar puntos.'
          : 'Para iniciar tu jornada y validar puntos en terreno necesitas activar tu GPS de alta precisión.'}</p>
      </div>
    </div>
    <button id="btnInicioGps" class="w-full h-11 gps-off-btn rounded-xl text-[15px] font-bold flex items-center justify-center gap-2 active:scale-[0.98] transition-transform shadow-sm">
      <span class="material-symbols-outlined text-[20px]">near_me</span>
      <span>${noDisponible ? 'Reintentar' : 'Activar GPS'}</span>
    </button>`;
  $('btnInicioGps')?.addEventListener('click', activarGps);
}

function pintarInicioLabores() {
  const seccion = $('inicioLabores');
  if (!seccion) return;
  seccion.classList.toggle('hidden', !territorio);
  if (!territorio) return;
  const n = 1 + (tareas.length ? 1 : 0);
  $('inicioLaboresChip').textContent = n === 1 ? '1 labor activa' : `${n} labores activas`;
}

function pintarInicioTerritorio() {
  if (!territorio) return;
  const t = territorio.territorios || {};
  $('btnInicioTerritorio').classList.remove('hidden');

  $('inicioTerritorioNombre').textContent = t.nombre || 'Territorio';
  const extra = colaResumen(cola).crear;
  $('inicioTerritorioChip').textContent = `${puntos.length + extra} pts`;
  $('inicioComuna').textContent = t.comuna || 'Comuna sin registrar';
  $('inicioPorVisitar').textContent = `${territorioAvance(puntos).pendiente + extra} por visitar`;
}

function pintarInicioTareas() {
  const box = $('inicioCardTareas');
  if (!box) return;
  if (!tareas.length) { box.classList.add('hidden'); box.innerHTML = ''; return; }
  box.classList.remove('hidden');

  const dotPorEstado = { pendiente: 'bg-outline', visitado: 'bg-tertiary-fixed', erroneo: 'bg-error', no_pasar: 'bg-secondary' };
  const recuento = {};
  tareas.forEach((t) => {
    const e = t.puntos?.estado ?? 'pendiente';
    recuento[e] = (recuento[e] || 0) + 1;
  });
  const chips = Object.entries(recuento).map(([e, n]) => `
    <span class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-surface-container-lowest border border-surface-container text-on-surface text-[11px] font-medium shadow-sm">
      <span class="w-1.5 h-1.5 rounded-full ${dotPorEstado[e] || 'bg-outline'}"></span>
      <span>${estadoLabel(e)} (${n})</span>
    </span>`).join('');
  const visitados = (recuento.visitado || 0) + (recuento.erroneo || 0);

  box.innerHTML = `
    <button id="btnInicioTareas" class="bg-surface-container-lowest rounded-2xl p-4 shadow-sm border border-surface-container hover:border-primary/30 transition-all flex flex-col gap-3 w-full text-left active:scale-[0.99]">
      <div class="flex items-start justify-between gap-3">
        <div class="flex items-start gap-3 flex-1 min-w-0">
          <div class="w-10 h-10 rounded-xl bg-tertiary-fixed text-on-tertiary-fixed flex items-center justify-center shrink-0 mt-0.5">
            <span class="material-symbols-outlined text-[22px]">assignment</span>
          </div>
          <div class="flex-1 min-w-0">
            <span class="text-[11px] font-bold tracking-wider uppercase text-on-tertiary-fixed">Tareas individuales</span>
            <h4 class="text-base font-bold text-on-surface leading-snug">Confirmar estado de Puntos</h4>
          </div>
        </div>
        <div class="flex items-center gap-1.5 shrink-0">
          <span class="text-xs px-2.5 py-1 rounded-full bg-tertiary-fixed text-on-tertiary-fixed font-bold">${tareas.length} tareas</span>
          <span class="material-symbols-outlined text-outline text-[20px]">chevron_right</span>
        </div>
      </div>
      <div class="bg-surface-container-low/70 rounded-xl p-3 flex flex-col gap-2.5 border border-surface-container-high/40">
        <div class="flex items-center justify-between text-xs">
          <div class="flex items-center gap-1.5 font-semibold text-on-tertiary-fixed">
            <span class="material-symbols-outlined text-[17px]">storefront</span><span>${tareas.length} puntos asignados</span>
          </div>
          ${visitados ? `
            <div class="flex items-center gap-1 text-on-surface-variant font-medium">
              <span class="material-symbols-outlined text-[15px] text-primary">travel_explore</span><span>${visitados} visitado${visitados === 1 ? '' : 's'}</span>
            </div>` : ''}
        </div>
        <div class="flex flex-wrap gap-1.5 pt-1">${chips}</div>
      </div>
    </button>`;
  $('btnInicioTareas')?.addEventListener('click', () => irA('tareas'));
}

function pintarInicioMetricas() {
  const box = $('inicioMetricas');
  if (!box) return;
  if (!territorio) { box.classList.add('hidden'); return; }
  box.classList.remove('hidden');

  const av = territorioAvance(puntos);
  const total = av.total + colaResumen(cola).crear;
  const pct = total ? Math.round((av.visitado / total) * 100) : 0;
  $('inicioProgressLabel').textContent = `${pct}%`;
  $('inicioProgressBar').style.width = `${pct}%`;
}

function pintarInicioSync() {
  const dot = $('inicioSyncDot');
  const txt = $('inicioSyncTxt');
  if (!dot || !txt) return;
  const r = colaResumen(cola);
  const off = !navigator.onLine;
  if (r.total) {
    dot.className = 'w-2 h-2 rounded-full bg-error shrink-0';
    txt.textContent = `${r.total} cambio${r.total === 1 ? '' : 's'} pendiente${r.total === 1 ? '' : 's'} de sincronizar`;
  } else if (off) {
    dot.className = 'w-2 h-2 rounded-full bg-outline shrink-0';
    txt.textContent = 'Modo offline activo · los cambios se guardan en el teléfono';
  } else {
    dot.className = 'w-2 h-2 rounded-full bg-tertiary-fixed shrink-0';
    txt.textContent = 'Todo sincronizado con central';
  }
}

// ============================================================
// CARD DE PUNTO: estados, mensajes e historial
// ============================================================
// Abre/cierra la fila de estados de una card (solo una desplegada a la vez)
function toggleEstadoCard(art, id) {
  const abierto = art.dataset.estadoAbierto === '1';
  document.querySelectorAll('#pdvList article[data-estado-abierto="1"]').forEach((a) => {
    a.dataset.estadoAbierto = '0';
    a.querySelector('[data-estados-row]')?.classList.add('hidden');
  });
  if (abierto) return;
  art.dataset.estadoAbierto = '1';
  art.querySelector('[data-estados-row]')?.classList.remove('hidden');
}

// Guarda la nota espejo (último mensaje) de un punto. true = ok o en cola
async function guardarNotaPunto(id, texto) {
  const p = puntoPorId(id);
  if (!p) return false;
  const t = (texto || '').trim();
  const c = coordsDe(p) || {};
  const { error } = await db.rpc('actualizar_punto_terreno', {
    p_id: id, p_nombre: p.nombre, p_direccion: p.direccion || '',
    p_notas: t, p_lat: c.lat ?? p.lat, p_lng: c.lng ?? p.lng,
  });
  if (error) {
    if (esErrorDeRed(error)) {
      encolar('editar', id, { nombre: p.nombre, direccion: p.direccion || '', notas: t, lat: c.lat, lng: c.lng });
      toast('Sin señal: la nota quedó en cola local');
    } else {
      toast(error.message, { error: true });
      return false;
    }
  } else {
    toast('Nota guardada');
  }
  p.notas = t;
  return true;
}

// Agrega un mensaje al historial (RPC; sin señal → cola con append local)
async function agregarMensaje(id) {
  const inp = $('pointMensajeInput');
  const texto = (inp.value || '').trim();
  const p = puntoPorId(id);
  if (!p || !texto) return;
  const btn = $('btnPointMensaje');
  btn.disabled = true;
  const { error } = await db.rpc('agregar_nota_punto', { p_id: id, p_texto: texto });
  btn.disabled = false;
  if (error && !esErrorDeRed(error)) { toast(error.message, { error: true }); return; }
  if (error) {
    encolar('nota', id, { texto });
    p.notas = texto;
    anexarMensajeLocal(texto, true);
    inp.value = '';
    pintarLista();
    return;
  }
  p.notas = texto;
  inp.value = '';
  pintarLista();
  await cargarHistorial(id);
}

function anexarMensajeLocal(texto, pendiente) {
  const box = $('pointSheetHistorial');
  box.querySelector('[data-hist-vacio]')?.remove();
  const div = document.createElement('div');
  div.className = 'relative pl-4';
  div.innerHTML = `
    <span class="absolute -left-[7px] top-2 w-3 h-3 rounded-full bg-secondary ring-4 ring-surface-container-lowest"></span>
    <div class="bg-surface-container rounded-xl p-2.5">
      <div class="flex items-center justify-between gap-2 mb-0.5">
        <span class="text-[11px] font-bold text-on-surface truncate">${pendiente ? 'Tú · sin sincronizar' : 'Tú'}</span>
        <span class="text-[10px] text-on-surface-variant shrink-0">${escapeHtml(fechaCorta(new Date().toISOString()))}</span>
      </div>
      <p class="text-xs text-on-surface-variant whitespace-pre-wrap break-words">${escapeHtml(texto)}</p>
    </div>`;
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
}

function fechaCorta(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleDateString('es-CL', { day: '2-digit', month: 'short' }) + ' ' +
         d.toLocaleTimeString('es-CL', { hour: '2-digit', minute: '2-digit' });
}

async function cargarHistorial(id) {
  const box = $('pointSheetHistorial');
  box.innerHTML = '<p class="text-xs text-on-surface-variant">Cargando historial…</p>';
  const { data, error } = await db.rpc('notas_punto', { p_punto: id });
  if (error) {
    box.innerHTML = `<p class="text-xs text-error">${escapeHtml(error.message)}</p>`;
    return;
  }
  pintarHistorial(data || []);
}

function pintarHistorial(items) {
  const box = $('pointSheetHistorial');
  const count = $('pointSheetHistorialCount');
  if (count) count.textContent = items.length ? `${items.length} registro${items.length === 1 ? '' : 's'}` : '';
  if (!items.length) {
    box.innerHTML = '<p data-hist-vacio class="text-xs text-on-surface-variant">Sin mensajes todavía.</p>';
    return;
  }
  box.innerHTML = `<div class="border-l-2 border-outline-variant ml-1.5 flex flex-col gap-2">${items.map((n) => `
    <div class="relative pl-4">
      <span class="absolute -left-[7px] top-2 w-3 h-3 rounded-full bg-secondary ring-4 ring-surface-container-lowest"></span>
      <div class="bg-surface-container rounded-xl p-2.5">
        <div class="flex items-center justify-between gap-2 mb-0.5">
          <span class="text-[11px] font-bold text-on-surface truncate">${escapeHtml(n.autor || '—')}</span>
          <span class="text-[10px] text-on-surface-variant shrink-0">${escapeHtml(fechaCorta(n.at))}</span>
        </div>
        <p class="text-xs text-on-surface-variant whitespace-pre-wrap break-words">${escapeHtml(n.texto)}</p>
      </div>
    </div>`).join('')}</div>`;
  box.scrollTop = box.scrollHeight;
}

// Tarjetas grandes del selector de estado (detalle del punto)
const CLASES_ESTADO_IC = {
  pendiente: 'bg-secondary-container text-on-secondary-container',
  visitado: 'bg-tertiary-fixed text-on-tertiary-fixed',
  erroneo: 'bg-outline text-white',
  no_pasar: 'bg-error text-on-error',
};
const BORDES_ESTADO_DETALLE = {
  pendiente: 'border-secondary',
  visitado: 'border-tertiary-fixed-dim',
  erroneo: 'border-outline',
  no_pasar: 'border-error',
};
const CHECK_ESTADO_DETALLE = {
  pendiente: 'text-secondary',
  visitado: 'text-on-tertiary-fixed',
  erroneo: 'text-on-surface-variant',
  no_pasar: 'text-error',
};

function pintarEstadosDetalle(id, est) {
  const box = $('pointSheetEstados');
  box.innerHTML = ESTADOS.map(([valor, etiqueta]) => {
    const activo = valor === est;
    const borde = activo
      ? `border-2 ${BORDES_ESTADO_DETALLE[valor]} bg-surface-container-high`
      : 'border border-outline-variant/50 bg-surface-container';
    return `
      <button class="est-det flex items-center gap-2.5 p-3 rounded-xl ${borde} text-on-surface text-left active:scale-[0.98] transition"
              data-estado-detalle="${escapeHtml(id)}" data-valor="${valor}">
        <span class="w-7 h-7 rounded-lg ${CLASES_ESTADO_IC[valor]} flex items-center justify-center shrink-0">
          <span class="material-symbols-outlined text-[15px]">${ICONOS_ESTADO[valor]}</span>
        </span>
        <span class="flex-1 min-w-0">
          <span class="block font-bold text-xs truncate leading-tight">${etiqueta}</span>
        </span>
        ${activo ? `<span class="material-symbols-outlined text-[16px] shrink-0 ${CHECK_ESTADO_DETALLE[valor]}">check_circle</span>` : ''}
      </button>`;
  }).join('');
  box.querySelectorAll('[data-estado-detalle]').forEach((b) => {
    b.addEventListener('click', () => elegirEstadoDetalle(id, b.dataset.valor));
  });
}

function pintarBadgesFicha(p, libre) {
  $('pointSheetBadges').innerHTML = chipEstado(p.estado || 'pendiente')
    + (p.user_id === user.id ? '<span class="text-[11px] font-bold text-secondary bg-surface-container px-2 py-1 rounded">CREADO POR TI</span>' : '')
    + (libre ? '<span class="text-[11px] font-bold text-on-surface-variant bg-surface-container px-2 py-1 rounded">SOLO LECTURA</span>' : '');
}

function elegirEstadoRapido(art, id, valor) {
  if (!puntoPorId(id)) return;
  // mantenerLista: evita el re-render que cortaría la transición del chip
  aplicarEstado(id, valor, { mantenerLista: true });
  // No pasar pasa a card/simple detalle: re-render de la lista
  if (valor === 'no_pasar') { pintarLista(); return; }
  actualizarEstadoEnCard(art, valor);
}

async function elegirEstadoDetalle(id, valor) {
  const p = puntoPorId(id);
  if (!p) return;
  await aplicarEstado(id, valor, { mantenerLista: true });
  // No pasar: la ficha pasa al detalle simple de solo lectura
  if (valor === 'no_pasar') { abrirFicha(id); return; }
  pintarEstadosDetalle(id, valor);
  pintarBadgesFicha(p, !territorio);
  if (navigator.onLine) await cargarHistorial(id); // muestra la nueva entrada del log
}

function actualizarEstadoEnCard(art, est) {
  const chip = art?.querySelector('[data-estado-chip]');
  if (chip) {
    chip.className = `shrink-0 inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold active:opacity-80 ${CLASES_ESTADO_ACTIVO[est] || ''}`;
    const ic = chip.querySelector('.material-symbols-outlined');
    if (ic) ic.textContent = ICONOS_ESTADO[est] || 'schedule';
    const tx = chip.querySelector('[data-estado-label]');
    if (tx) tx.textContent = estadoLabel(est);
  }
  art?.querySelectorAll('.est-op').forEach((b) => {
    const activo = b.dataset.valor === est;
    b.className = `est-op h-9 rounded-lg text-[10px] font-semibold flex items-center justify-center gap-1 active:opacity-80 ${
      activo ? CLASES_ESTADO_ACTIVO[b.dataset.valor] : 'bg-surface-container text-on-surface-variant'
    }`;
  });
}

function actualizarChromeTerritorio() {
  if (!territorio) { $('secTerritorio').classList.add('hidden'); return; }
  const total = territorioAvance(puntos).total + colaResumen(cola).crear;
  const sinTareas = tabActual === 'tareas' && !tareas.length;
  // En Inicio el avance vive en su propia tarjeta: sin cabecera duplicada
  const enInicio = tabActual === 'inicio';
  $('secTerritorio').classList.toggle('hidden', !total || sinTareas || enInicio);
}

// La métrica de Inicio vive fuera del re-render de cards/lista: se refresca
// aparte en cada cambio que afecta el avance (estados, cola, filtros).
function actualizarProgresoInicio() {
  actualizarChromeTerritorio();
  if (tabActual !== 'inicio') return;
  pintarInicioMetricas();
  pintarInicioTerritorio();
  pintarInicioSync();
}

function pintarVistaTerritorio() {
  // Sin territorio asignado (y sin error de carga) la app entra en MODO LIBRE:
  // mapa general + crear puntos, sin gestión ni datos exclusivos de territorio.
  const vacio = !territorio && !!errorTerritorio;
  const libre = !territorio && !errorTerritorio;
  $('emptyView').classList.toggle('hidden', !vacio);
  $('emptyView').classList.toggle('flex', vacio);
  $('appView').classList.toggle('hidden', vacio);
  const err = $('emptyError');
  err.textContent = errorTerritorio ? 'Detalle: ' + errorTerritorio : '';
  err.classList.toggle('hidden', !errorTerritorio);
  // Elementos exclusivos de un territorio asignado
  actualizarChromeTerritorio();
  $('mapDevolver')?.classList.toggle('hidden', libre);
  $('mapStats')?.classList.toggle('hidden', libre);
  $('btnVolverTerritorio')?.classList.toggle('hidden', libre);
}

function pintarCola() {
  const r = colaResumen(cola);
  const off = !navigator.onLine;

  $('headerSyncIcon').textContent = r.total ? 'cloud_off' : (off ? 'cloud_off' : 'cloud_done');
  $('headerSyncCount').textContent = r.total ? String(r.total) : '';

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
  pintarInicioSync();
}

function iconoOp(tipo) {
  return { estado: 'flag', crear: 'add_circle', editar: 'edit', borrar: 'delete' }[tipo] || 'sync';
}
function textoOp(tipo) {
  return { estado: 'Cambio de estado', crear: 'Punto nuevo', editar: 'Edición de punto', borrar: 'Borrado de punto' }[tipo] || tipo;
}

function pintarTarjetaTerritorio() {
  if (!territorio) return; // modo libre: la tarjeta está oculta
  const av = territorioAvance(puntos);
  const extra = colaResumen(cola).crear;
  const total = av.total + extra;
  const pct = total ? Math.round((av.visitado / total) * 100) : 0;
  // Progreso de la ruta: barra lineal simple sobre las paradas visitadas.
  const boxAv = $('avanceProcesoBox');
  if (boxAv) {
    boxAv.classList.toggle('hidden', !total);
    $('avanceProcesoPct').textContent = pct + ' %';
    const det = $('avanceProcesoDetalle');
    if (det) det.textContent = `${av.visitado} de ${total} paradas visitadas`;
    const bar = $('barProgreso');
    if (bar) bar.style.width = pct + '%';
  }
  const pa = procesoAvance(puntos, territorio.puntos_base);
  const stats = $('mapStats');
  if (stats) {
    stats.classList.toggle('hidden', !pa.base);
    $('mapStatsToggle').textContent = pa.pct + '%';
    $('mapStatsErroneo').textContent = av.erroneo;
    $('mapStatsNoPasar').textContent = av.no_pasar;
    $('mapStatsPendiente').textContent = av.pendiente + extra;
  }
}

const CLASES_FILTRO_ACTIVO = {
  todos: 'bg-primary text-on-primary border-transparent',
  pendiente: 'bg-secondary-container text-on-secondary-container border-transparent',
  no_pasar: 'bg-error-container text-on-error-container border-transparent',
  completado: 'bg-tertiary-fixed text-on-tertiary-fixed border-transparent',
};

function pintarFiltros() {
  const av = territorioAvance(puntos);
  const extra = colaResumen(cola).crear;
  const val = {
    todos: av.total + extra,
    pendiente: av.pendiente + extra,
    no_pasar: av.no_pasar,
    completado: av.visitado + av.erroneo,
  };
  document.querySelectorAll('[data-badge]').forEach((b) => {
    b.textContent = String(val[b.dataset.badge] ?? 0);
  });
  document.querySelectorAll('.filtro').forEach((b) => {
    const activo = b.dataset.filtro === filtroActual;
    const estado = activo
      ? CLASES_FILTRO_ACTIVO[b.dataset.filtro]
      : 'bg-surface-container-lowest text-on-surface-variant border-outline-variant';
    b.className = `filtro shrink-0 inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-full text-xs font-semibold border active:scale-95 transition-all ${estado}`;
  });
}

document.querySelectorAll('.filtro').forEach((b) => {
  b.addEventListener('click', () => { filtroActual = b.dataset.filtro; pintarFiltros(); pintarLista(); });
});

function pasarFiltro(p) {
  if (filtroActual === 'todos') return true;
  if (filtroActual === 'completado') return p.estado === 'visitado' || p.estado === 'erroneo';
  if (filtroActual === 'no_pasar') return p.estado === 'no_pasar';
  return p.estado === filtroActual; // pendiente
}

// Píldora de la nota más reciente (último mensaje del historial)
function notaPill(texto) {
  return `<div class="bg-surface-container rounded-xl p-2 border border-outline-variant/40 flex items-start gap-2">
    <span class="material-symbols-outlined text-on-surface-variant text-[15px]">comment</span>
    <p class="text-xs text-on-surface-variant italic break-words">“${escapeHtml(texto)}”</p>
  </div>`;
}

function acentoEstado(est) {
  return (est === 'no_pasar' || est === 'erroneo') ? 'border-error/40' : 'border-outline-variant/40';
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
    // Sin territorio asignado (modo libre): estado vacío explícito en Puntos
    box.innerHTML = !territorio
      ? `<div class="bg-surface-container-lowest rounded-2xl p-6 shadow-sm border border-outline-variant/40 flex flex-col items-center gap-2 text-center">
          <div class="w-11 h-11 rounded-full bg-primary/10 text-primary flex items-center justify-center shrink-0">
            <span class="material-symbols-outlined text-[24px]">map</span>
          </div>
          <h3 class="text-base font-bold text-on-surface">Sin territorio asignado</h3>
          <p class="text-xs text-on-surface-variant">Pide una asignación a central para ver los puntos de cuidado.</p>
          ${errorTerritorio ? `<p class="text-[11px] text-on-surface-variant break-words">No se pudo cargar: ${escapeHtml(errorTerritorio)}</p>` : ''}
        </div>`
      : '<div class="text-sm text-on-surface-variant text-center py-8">No hay puntos con este filtro.</div>';
    return;
  }

  // Modo libre (sin territorio asignado): tarjetas de solo lectura. Los
  // cambios de estado los valida la DB contra el territorio activo, así que
  // aquí no se ofrecen acciones de trabajo.
  if (!territorio) {
    box.innerHTML = todo.map((p) => {
      const est = p.estado || 'pendiente';
      const coords = coordsDe(p);
      const nav = coords ? linkComoLlegar(coords.lat, coords.lng) : null;
      if (est === 'no_pasar') {
        return `
        <article class="bg-surface-container-lowest rounded-2xl p-3 shadow-sm border border-error/40 flex flex-col gap-1.5 cursor-pointer active:scale-[0.99] transition-transform" data-id="${escapeHtml(p.id)}" data-abrir="${escapeHtml(p.id)}">
          <div class="flex items-start justify-between gap-2">
            <h3 class="text-sm font-bold text-on-surface truncate leading-snug flex-1 min-w-0">${escapeHtml(p.nombre || 'Sin nombre')}</h3>
            ${chipEstado('no_pasar')}
          </div>
          <div class="flex items-center gap-1.5 text-xs text-on-surface-variant min-w-0">
            <span class="material-symbols-outlined text-[14px] shrink-0">location_on</span>
            <span class="font-medium truncate">${escapeHtml(p.direccion || 'Sin dirección')}</span>
          </div>
        </article>`;
      }
      return `
      <article class="bg-surface-container-lowest rounded-2xl p-3 shadow-sm border ${acentoEstado(est)} flex flex-col gap-2" data-id="${escapeHtml(p.id)}">
        <div class="flex items-start justify-between gap-2">
          <div class="min-w-0 flex-1 cursor-pointer" data-abrir="${escapeHtml(p.id)}">
            <h3 class="text-base font-bold text-on-surface truncate leading-snug">${escapeHtml(p.nombre || 'Sin nombre')}</h3>
            <div class="flex items-center gap-1.5 mt-1 text-xs text-on-surface-variant min-w-0">
              <span class="material-symbols-outlined text-[14px] shrink-0">location_on</span>
              <span class="font-medium truncate">${escapeHtml(p.direccion || 'Sin dirección')}</span>
            </div>
          </div>
          ${chipEstado(est)}
        </div>
        ${p.notas ? notaPill(p.notas) : ''}
        <div class="grid grid-cols-3 gap-2 pt-2 border-t border-outline-variant/40">
          <button data-abrir="${escapeHtml(p.id)}" class="min-h-[40px] rounded-xl bg-surface-container text-primary text-xs font-semibold flex items-center justify-center active:bg-surface-container-high">
            Detalles
          </button>
          <a ${nav ? `href="${nav}" target="_blank" rel="noopener"` : ''} class="min-h-[40px] rounded-xl bg-secondary text-on-secondary text-xs font-semibold flex items-center justify-center active:opacity-90 ${nav ? '' : 'opacity-40 pointer-events-none'}">
            Cómo llegar
          </a>
          <button data-ver-mapa="${escapeHtml(p.id)}" class="min-h-[40px] rounded-xl bg-surface-container text-secondary text-xs font-semibold flex items-center justify-center active:bg-surface-container-high">
            En mapa
          </button>
        </div>
      </article>`;
    }).join('');
    box.querySelectorAll('[data-abrir]').forEach((el) => {
      el.addEventListener('click', () => abrirFicha(el.dataset.abrir));
    });
    box.querySelectorAll('[data-ver-mapa]').forEach((b) => {
      b.addEventListener('click', () => verPuntoEnMapa(b.dataset.verMapa));
    });
    return;
  }

  box.innerHTML = todo.map((p) => {
    const est = p.estado || 'pendiente';
    const coords = coordsDe(p);
    const nav = coords ? linkComoLlegar(coords.lat, coords.lng) : homeAppMapa();
    const local = !!p.local;
    // No pasar: card mínima. Solo nombre, dirección y estado; el toque abre el
    // detalle simple (sin acciones ni cambio de estado, solo permitir mensaje).
    if (est === 'no_pasar') {
      return `
      <article class="bg-surface-container-lowest rounded-2xl p-3 shadow-sm border border-error/40 flex flex-col gap-1.5 cursor-pointer active:scale-[0.99] transition-transform" data-id="${escapeHtml(p.id)}" data-abrir="${escapeHtml(p.id)}">
        <div class="flex items-start justify-between gap-2">
          <h3 class="text-sm font-bold text-on-surface truncate leading-snug flex-1 min-w-0">${escapeHtml(p.nombre || 'Sin nombre')}</h3>
          ${chipEstado('no_pasar')}
        </div>
        <div class="flex items-center gap-1.5 text-xs text-on-surface-variant min-w-0">
          <span class="material-symbols-outlined text-[14px] shrink-0">location_on</span>
          <span class="font-medium truncate">${escapeHtml(p.direccion || 'Sin dirección')}</span>
        </div>
      </article>`;
    }
    const opcionesEstado = ESTADOS.map(([valor, etiqueta]) => {
      const activo = valor === est;
      const cls = activo ? CLASES_ESTADO_ACTIVO[valor] : 'bg-surface-container text-on-surface-variant';
      return `
        <button class="est-op h-9 rounded-lg ${cls} text-[10px] font-semibold flex items-center justify-center gap-1 active:opacity-80"
                data-estado-rapido="${escapeHtml(p.id)}" data-valor="${valor}" ${local ? 'disabled' : ''}>
          <span class="material-symbols-outlined text-[16px]">${ICONOS_ESTADO[valor]}</span>
          <span class="truncate">${etiqueta}</span>
        </button>`;
    }).join('');
    return `
    <article class="bg-surface-container-lowest rounded-2xl p-3 shadow-sm border ${acentoEstado(est)} flex flex-col gap-2" data-id="${escapeHtml(p.id)}" data-estado-abierto="0">
      <div class="flex items-start justify-between gap-2">
        <div class="min-w-0 flex-1 cursor-pointer" data-abrir="${escapeHtml(p.id)}">
          <div class="flex items-center gap-1.5 min-w-0">
            <h3 class="text-base font-bold text-on-surface truncate leading-snug">${escapeHtml(p.nombre || 'Sin nombre')}</h3>
            ${local ? '<span class="material-symbols-outlined text-secondary text-[16px] shrink-0" title="Pendiente de sincronizar">cloud_upload</span>' : ''}
          </div>
          <div class="flex items-center gap-1.5 mt-1 text-xs text-on-surface-variant min-w-0">
            <span class="material-symbols-outlined text-[14px] shrink-0">location_on</span>
            <span class="font-medium truncate">${escapeHtml(p.direccion || 'Sin dirección')}</span>
          </div>
        </div>
        <button data-estado-chip="${escapeHtml(p.id)}" ${local ? 'disabled' : ''}
                class="shrink-0 inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold active:opacity-80 ${CLASES_ESTADO_ACTIVO[est] || ''}">
          <span class="material-symbols-outlined text-[14px]">${ICONOS_ESTADO[est] || 'schedule'}</span>
          <span data-estado-label>${estadoLabel(est)}</span>
        </button>
      </div>
      <div class="hidden grid grid-cols-4 gap-1" data-estados-row>${opcionesEstado}</div>
      ${p.notas ? notaPill(p.notas) : ''}
      <div class="grid grid-cols-3 gap-2 pt-2 border-t border-outline-variant/40">
        <button data-abrir="${escapeHtml(p.id)}" class="min-h-[40px] rounded-xl bg-surface-container text-primary text-xs font-semibold flex items-center justify-center active:bg-surface-container-high">
          Detalles
        </button>
        <a href="${nav}" target="_blank" rel="noopener" aria-label="Cómo llegar" class="min-h-[40px] rounded-xl bg-secondary text-on-secondary text-xs font-semibold flex items-center justify-center active:opacity-90">
          Cómo llegar
        </a>
        <button data-ver-mapa="${escapeHtml(p.id)}" class="min-h-[40px] rounded-xl bg-surface-container text-secondary text-xs font-semibold flex items-center justify-center active:bg-surface-container-high">
          En mapa
        </button>
      </div>
    </article>`;
  }).join('');

  box.querySelectorAll('[data-abrir]').forEach((el) => {
    el.addEventListener('click', () => abrirFicha(el.dataset.abrir));
  });
  box.querySelectorAll('[data-estado-chip]').forEach((b) => {
    b.addEventListener('click', () => {
      if (b.disabled) return;
      toggleEstadoCard(b.closest('article'), b.dataset.estadoChip);
    });
  });
  box.querySelectorAll('[data-estado-rapido]').forEach((b) => {
    b.addEventListener('click', () => {
      const art = b.closest('article');
      elegirEstadoRapido(art, b.dataset.estadoRapido, b.dataset.valor);
      toggleEstadoCard(art, b.dataset.estadoRapido);
    });
  });
  box.querySelectorAll('[data-ver-mapa]').forEach((b) => {
    b.addEventListener('click', () => verPuntoEnMapa(b.dataset.verMapa));
  });
}

// Lleva al mapa y encuadra el punto indicado
function verPuntoEnMapa(id) {
  const p = puntoPorId(id);
  const c = p && coordsDe(p);
  irA('mapa');
  if (c) setTimeout(() => encuadrarCoords([[c.lng, c.lat]]), 60);
}

// Iconos y clases de los botones de estado rápido de la card
const ICONOS_ESTADO = { pendiente: 'schedule', visitado: 'check_circle', erroneo: 'report', no_pasar: 'block' };
const CLASES_ESTADO_ACTIVO = {
  pendiente: 'bg-surface-container-high text-secondary',
  visitado: 'bg-tertiary-fixed text-on-tertiary-fixed',
  erroneo: 'bg-surface-container-highest text-on-surface-variant',
  no_pasar: 'bg-error-container text-on-error-container',
};

function chipEstado(est) {
  const mapa = {
    visitado: ['bg-tertiary-fixed text-on-tertiary-fixed', 'check_circle', 'Visitado'],
    erroneo: ['bg-surface-container-highest text-on-surface-variant', 'report', 'Erróneo'],
    no_pasar: ['bg-error-container text-on-error-container', 'block', 'No pasar'],
    pendiente: ['bg-surface-container-high text-secondary', 'schedule', 'Pendiente'],
  };
  const [cls, ic, txt] = mapa[est] || mapa.pendiente;
  return `<span class="inline-flex items-center gap-1 px-2.5 py-1 rounded-full ${cls} text-xs font-semibold shrink-0">
    <span class="material-symbols-outlined text-[15px]">${ic}</span><span>${txt}</span></span>`;
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
  if (map) return;   // también se crea en modo libre (sin territorio asignado)
  const gl = document.createElement('canvas').getContext('webgl2')
    || document.createElement('canvas').getContext('webgl');
  if (!gl) {
    toast('WebGL no está disponible en este navegador', { error: true });
    return;
  }
  // Sin territorio/comuna: arranca en Plaza de Armas (Santiago centro) para no
  // cargar tiles innecesarios y abrir más rápido.
  let centro = [-70.6506, -33.4410];
  if (territorio) {
    const bb = bboxDeGeometria(territorio.territorios.geom);
    if (bb) centro = [(bb[0][0] + bb[1][0]) / 2, (bb[0][1] + bb[1][1]) / 2];
  }

  map = new maplibregl.Map({
    container: 'mapMovil',
    style: MAP_STYLE,
    center: centro,
    zoom: 14,
    attributionControl: { compact: true },
  });

  map.on('load', () => {
    // El polígono del territorio solo se muestra con el proceso «en proceso»:
    // al completarlo (revisión/envío) el mapa pasa a plano de puntos.
    if (territorio?.estado === 'activa' && territorio.territorios?.geom) {
      map.addSource('territorio-movil', { type: 'geojson', data: { type: 'Feature', geometry: territorio.territorios.geom, properties: {} } });
      map.addLayer({
        id: 'territorio-movil-fill', type: 'fill', source: 'territorio-movil',
        paint: { 'fill-color': territorio.territorios.color || '#3b82f6', 'fill-opacity': 0.08 },
      });
      map.addLayer({
        id: 'territorio-movil-line', type: 'line', source: 'territorio-movil',
        paint: { 'line-color': territorio.territorios.color || '#3b82f6', 'line-width': 2 },
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

// ============================================================
// VISTA SATÉLITE (Esri World Imagery) — reemplaza el fondo del mapa.
// Se inserta bajo la primera capa de símbolos: los rótulos de calles
// quedan legibles y el polígono/pines/ubicación se dibujan encima.
// ============================================================
function alternarSatelite() {
  if (!map || !mapListo) return;
  const btn = $('btnSatelite');
  if (sateliteActiva) {
    if (map.getLayer('satelite-layer')) map.removeLayer('satelite-layer');
    if (map.getSource('satelite')) map.removeSource('satelite');
    sateliteActiva = false;
    btn.classList.remove('bg-primary', 'text-on-primary');
    btn.classList.add('bg-surface-container-lowest/95', 'text-secondary');
    return;
  }
  const capas = map.getStyle().layers || [];
  const simbolo = capas.find((c) => c.type === 'symbol');
  map.addSource('satelite', {
    type: 'raster',
    tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
    tileSize: 256,
    maxzoom: 19,
    attribution: 'Esri, Maxar, Earthstar Geographics',
  });
  map.addLayer(
    { id: 'satelite-layer', type: 'raster', source: 'satelite', paint: {} },
    simbolo ? simbolo.id : undefined
  );
  sateliteActiva = true;
  btn.classList.add('bg-primary', 'text-on-primary');
  btn.classList.remove('bg-surface-container-lowest/95', 'text-secondary');
}

// Encuadra un conjunto de coordenadas [[lng,lat],…] calculando la caja con
// los extremos: fitBounds exige exactamente dos esquinas, no N puntos.
function encuadrarCoords(coords, opts = {}) {
  if (!map || !coords.length) return;
  if (coords.length === 1) {
    map.easeTo({ center: coords[0], zoom: Math.max(map.getZoom(), 15), duration: 300 });
    return;
  }
  const lngs = coords.map((c) => c[0]);
  const lats = coords.map((c) => c[1]);
  map.fitBounds(
    [
      [Math.min(...lngs), Math.min(...lats)],
      [Math.max(...lngs), Math.max(...lats)],
    ],
    { padding: 40, duration: 0, ...opts }
  );
}

function ajustarVistaMapa() {
  if (!map || !mapListo) return;
  if (territorio) {
    const bb = bboxDeGeometria(territorio.territorios.geom);
    if (bb) {
      map.fitBounds(bb, { padding: 40, duration: 0 });
      return;
    }
  }
  // Modo libre (o territorio sin geometría): encuadrar los puntos visibles
  if (puntos.length) {
    const coords = puntos.map(coordsDe).filter(Boolean).map((c) => [c.lng, c.lat]);
    encuadrarCoords(coords);
  }
}

function actualizarCapaPuntos() {
  if (!mapListo || !map) return;
  Object.values(markers).forEach((m) => m.remove());
  markers = {};

  const pintar = (p, { local = false, tarea = false } = {}) => {
    const c = coordsDe(p);
    if (!c) return;
    const est = p.estado || 'pendiente';
    const el = document.createElement('div');
    el.className = 'pin-wrap';
    el.innerHTML = `<div class="pin${local ? ' is-nuevo' : ''}${tarea ? ' is-tarea' : ''}" data-est="${est}"><span class="ms pin-ic material-symbols-outlined text-[15px]">${PIN_ICONS[est] || 'schedule'}</span></div>`;
    el.addEventListener('click', (ev) => {
      ev.stopPropagation();
      if (local) return;
      abrirFicha(p.id);
    });
    markers[p.id] = new maplibregl.Marker({ element: el }).setLngLat([c.lng, c.lat]).addTo(map);
  };

  // Los puntos con tarea especial se distinguen con aureola púrpura, aunque
  // ya estén entre los puntos cargados (en modo libre se ven todos).
  const idsTarea = new Set(tareas.map((t) => t.punto_id));
  puntos.forEach((p) => pintar(p, { tarea: idsTarea.has(p.id) }));
  cola.filter((o) => o.tipo === 'crear').forEach((o) => {
    pintar({ id: o.clave, estado: 'pendiente', lat: o.datos.lat, lng: o.datos.lng }, { local: true });
  });

  // Tareas de puntos fuera de la lista actual (otro territorio)
  tareas.forEach((t) => {
    const p = t.puntos;
    if (!p || idsTarea.has(t.punto_id) && puntos.some((x) => x.id === t.punto_id)) return;
    pintar(p, { tarea: true });
  });
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
    toast('Este punto está en cola local; sincroniza para verlo', { error: false });
    return;
  }
  const c = coordsDe(p) || {};
  const coords = coordsDe(p);
  const libre = !territorio;
  sheetPunto = { id: p.id, lat: c.lat ?? '', lng: c.lng ?? '', esNuevo: false };

  $('pointSheetKicker').textContent = 'Detalle del punto';
  $('pointSheetTitle').textContent = p.nombre || 'Punto';
  $('pointSheetError').textContent = '';
  $('pointSheetDireccion').textContent = p.direccion || 'Sin dirección';
  $('pointSheetCoords').textContent = coords
    ? `${Number(coords.lat).toFixed(5)}, ${Number(coords.lng).toFixed(5)}`
    : 'Sin coordenadas';
  $('fPDVNombre').value = p.nombre || '';
  $('fPDVDireccion').value = p.direccion || '';
  $('fPDVLat').value = c.lat != null ? Number(c.lat).toFixed(6) : '';
  $('fPDVLng').value = c.lng != null ? Number(c.lng).toFixed(6) : '';
  pintarBadgesFicha(p, libre);

  // Punto descartado (no_pasar): detalle de solo lectura con mensajes. Sin
  // cambios de estado, edición, borrado ni navegación.
  const detalleSimple = p.estado === 'no_pasar';
  $('pointSheetCoordsRow').classList.toggle('hidden', detalleSimple);
  $('pointSheetAcciones').classList.toggle('hidden', detalleSimple);
  $('btnPointNav').classList.toggle('hidden', !coords || detalleSimple);
  $('btnPointMap').classList.toggle('col-span-2', !coords);
  $('btnPointEdit').classList.toggle('hidden', libre || detalleSimple);
  $('btnPointDelete').classList.toggle('hidden', libre || detalleSimple || p.user_id !== user.id);
  $('pointSheetEstadoBox').classList.toggle('hidden', libre || detalleSimple);
  $('pointSheetMensajeWrap').classList.toggle('hidden', libre);
  $('pointSheetHistorialBox').classList.toggle('hidden', detalleSimple);
  $('pointSheetEdit').classList.add('hidden');
  $('btnPointSaveLabel').textContent = 'Guardar cambios';
  $('pointMensajeInput').value = '';

  if (!detalleSimple) {
    pintarEstadosDetalle(p.id, p.estado || 'pendiente');
    cargarHistorial(p.id);
  }
  sheetOpen('pointSheet');
}

function abrirFichaNueva(lng, lat) {
  // Desde el móvil un punto nuevo es una SOLICITUD para el admin (no escribe
  // en public.puntos): permitido con o sin territorio asignado. La BD también
  // exige el flujo (guardar_punto solo admin; solicitudes via RPC propia).
  sheetPunto = { id: null, lat, lng, esNuevo: true };
  $('pointSheetKicker').textContent = 'Punto nuevo';
  $('pointSheetTitle').textContent = 'Agregar punto';
  $('pointSheetError').textContent = '';
  $('pointSheetBadges').innerHTML = '';
  $('pointSheetDireccion').textContent = '';
  $('pointSheetCoords').textContent = '';
  $('fPDVNombre').value = '';
  $('fPDVDireccion').value = '';
  $('fPDVLat').value = Number(lat).toFixed(6);
  $('fPDVLng').value = Number(lng).toFixed(6);
  $('btnPointNav').classList.add('hidden');
  $('btnPointMap').classList.add('col-span-2');
  $('btnPointEdit').classList.add('hidden');
  $('btnPointDelete').classList.add('hidden');
  $('pointSheetEstadoBox').classList.add('hidden');
  $('pointSheetMensajeWrap').classList.add('hidden');
  $('pointSheetHistorialBox').classList.add('hidden');
  $('pointSheetEdit').classList.remove('hidden');
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

$('btnPointNav').addEventListener('click', () => {
  if (!sheetPunto || sheetPunto.lat == null || sheetPunto.lng == null || sheetPunto.lat === '' || sheetPunto.lng === '') {
    toast('Sin coordenadas para navegar', { error: true });
    return;
  }
  abrirRuta(Number(sheetPunto.lat), Number(sheetPunto.lng));
});

$('btnPointEdit').addEventListener('click', () => {
  const panel = $('pointSheetEdit');
  panel.classList.toggle('hidden');
  if (!panel.classList.contains('hidden')) {
    // el formulario se abre debajo: desplazamiento suave hasta él
    setTimeout(() => panel.scrollIntoView?.({ behavior: 'smooth', block: 'start' }), 80);
  }
});

$('btnPointCancel').addEventListener('click', () => {
  $('pointSheetEdit').classList.add('hidden');
  setTimeout(() => $('pointSheetScroll')?.scrollTo?.({ top: 0, behavior: 'smooth' }), 80);
});

$('btnPointCopy').addEventListener('click', async () => {
  const t = $('pointSheetCoords').textContent.trim();
  if (!t || t === 'Sin coordenadas') { toast('Sin coordenadas para copiar', { error: true }); return; }
  try {
    await navigator.clipboard.writeText(t);
    toast('Coordenadas copiadas');
  } catch {
    toast('No se pudo copiar', { error: true });
  }
});

$('btnPointMap').addEventListener('click', () => {
  const id = sheetPunto?.id;
  sheetClose('pointSheet');
  if (id) verPuntoEnMapa(id);
});

$('btnPointMensaje').addEventListener('click', () => {
  if (sheetPunto?.id) agregarMensaje(sheetPunto.id);
});

$('pointMensajeInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    if (sheetPunto?.id) agregarMensaje(sheetPunto.id);
  }
});

$('btnPointSave').addEventListener('click', guardarFicha);

async function guardarFicha() {
  const nombre = $('fPDVNombre').value.trim();
  const direccion = $('fPDVDireccion').value.trim();
  const lat = parseFloat($('fPDVLat').value);
  const lng = parseFloat($('fPDVLng').value);
  const err = $('pointSheetError');
  err.textContent = '';

  if (!nombre) { err.textContent = 'El nombre es obligatorio'; return; }
  if (isNaN(lat) || isNaN(lng)) { err.textContent = 'Latitud/longitud inválidas'; return; }
  if (territorio && !dentroDelTerritorio(lat, lng)) { err.textContent = 'Las coordenadas quedan fuera de tu territorio'; return; }


  if (sheetPunto.esNuevo) {
    // NORMA: desde el móvil no se crean puntos, se envía una SOLICITUD que
    // el admin confirma o rechaza en Nueva actividad. Sin señal queda en cola.
    const { error } = await db.rpc('crear_solicitud_punto', {
      p_nombre: nombre, p_direccion: direccion, p_notas: '', p_lat: lat, p_lng: lng,
    });
    if (error) {
      if (esErrorDeRed(error)) {
        encolar('crear', `local-${Date.now()}`, { nombre, direccion, notas: '', lat, lng });
        toast('Sin señal: la solicitud quedó en cola local');
      } else {
        err.textContent = error.message;
        return;
      }
    } else {
      toast('Solicitud enviada a admin');
    }
    sheetClose('pointSheet');
    await refrescar({ ajustarMapa: false });
    pintarTodo();
    return;
  }

  const notas = puntoPorId(sheetPunto.id)?.notas ?? '';
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
  // Refleja la edición en la cabecera de la ficha sin cerrarla
  $('pointSheetTitle').textContent = nombre;
  $('pointSheetDireccion').textContent = direccion || 'Sin dirección';
  $('pointSheetCoords').textContent = `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
  $('pointSheetEdit').classList.add('hidden');
  toast('Punto actualizado');
  await refrescar();
  pintarTodo();
}

function dentroDelTerritorio(lat, lng) {
  const g = territorio?.territorios?.geom;
  if (!g) return true; // sin polígono no se puede validar en cliente
  return pointInGeometry(lng, lat, g);
}

// ============================================================
// ESTADOS (RPC marcar_estado + deshacer + cola offline)
// ============================================================
// Texto con el que queda registrada en el historial la marca de un punto
function textoEstadoLog(estado) {
  return `Marcado como ${estadoLabel(estado).toLowerCase()}`;
}

async function aplicarEstado(id, estado, { silent = false, mantenerLista = false } = {}) {
  const p = puntoPorId(id);
  if (!p) return;
  const prev = p.estado || 'pendiente';
  const cambio = prev !== estado;
  const notasPrev = p.notas;

  // Optimista: la lista refleja el cambio al instante
  p.estado = estado;
  if (cambio) p.notas = textoEstadoLog(estado); // espejo del último movimiento
  if (!mantenerLista) pintarLista();
  pintarTarjetaTerritorio(); pintarFiltros(); actualizarCapaPuntos();
  actualizarProgresoInicio();

  const { error } = await db.rpc('marcar_estado', { p_id: id, p_estado: estado });
  if (error) {
    if (esErrorDeRed(error)) {
      encolar('estado', id, { estado });
      if (cambio) encolar('nota', id, { texto: textoEstadoLog(estado) });
      if (!silent) toast('Sin señal: el cambio quedó en cola local');
      return;
    }
    p.estado = prev; // revierte el optimismo
    if (cambio) p.notas = notasPrev;
    if (!mantenerLista) pintarLista();
    pintarTarjetaTerritorio(); pintarFiltros(); actualizarCapaPuntos();
    actualizarProgresoInicio();
    toast(error.message, { error: true });
    return;
  }
  // Bitácora: el cambio de estado queda como entrada del historial del punto
  if (cambio) {
    const { error: errorLog } = await db.rpc('agregar_nota_punto', {
      p_id: id, p_texto: textoEstadoLog(estado),
    });
    if (errorLog) {
      if (esErrorDeRed(errorLog)) encolar('nota', id, { texto: textoEstadoLog(estado) });
      else toast('El estado se aplicó, pero no se pudo registrar en el historial', { error: true });
    }
  }
  if (!silent && cambio) {
    toast(`Marcado como "${estadoLabel(estado)}"`, {
      undo: { id, prev },
    });
  }
  avisarSiCompleto();
}

// ============================================================
// TERRITORIO COMPLETADO: modal con Revisar / Enviar
// La tabla de revisión SOLO se puede ver desde ese modal.
// ============================================================
function territorioCompleto() {
  if (!territorio || !puntos.length) return false;
  if (cola.some((o) => o.tipo === 'crear')) return false; // puntos locales sin sync
  return territorioAvance(puntos).pendiente === 0;
}

function avisarSiCompleto() {
  if (!territorio || avisoTerritorioId === territorio.territorio_id) return;
  if (!territorioCompleto()) return;
  avisoTerritorioId = territorio.territorio_id;
  $('completadoNombre').textContent = territorio.territorios.nombre || 'el territorio';
  sheetOpen('completadoSheet');
}

function abrirRevision() {
  sheetClose('completadoSheet');
  $('revisionTitulo').textContent = territorio ? territorio.territorios.nombre : '—';
  pintarRevision();
  sheetOpen('revisionSheet');
}

function pintarRevision() {
  const av = territorioAvance(puntos);
  $('revisionResumen').textContent =
    `${av.visitado} visitados · ${av.erroneo} erróneos · ${av.no_pasar} no pasar`;
  const box = $('revisionTabla');
  box.innerHTML = puntos.map((p) => {
    const est = p.estado || 'pendiente';
    const c = coordsDe(p);
    // Punto que ya viene como no pasar: estado fijo (sin select de estado ni
    // edición de notas); solo se muestra su último mensaje si tiene uno.
    if (est === 'no_pasar') {
      return `
      <div class="rounded-xl bg-surface-container-low p-3 flex flex-col gap-2" data-rev="${escapeHtml(p.id)}">
        <div class="flex items-start justify-between gap-2">
          <div class="flex flex-col min-w-0">
            <p class="text-sm font-semibold text-on-surface truncate">${escapeHtml(p.nombre || 'Sin nombre')}</p>
            <p class="text-xs text-on-surface-variant truncate">${escapeHtml(p.direccion || (c ? `${c.lat.toFixed(5)}, ${c.lng.toFixed(5)}` : 'Sin dirección'))}</p>
          </div>
          ${chipEstado(est)}
        </div>
        ${p.notas ? `<p class="text-xs text-on-surface-variant italic break-words">“${escapeHtml(p.notas)}”</p>` : ''}
      </div>`;
    }
    const opciones = ESTADOS.map(([valor, etiqueta]) =>
      `<option value="${valor}" ${valor === est ? 'selected' : ''}>${etiqueta}</option>`).join('');
    return `
    <div class="rounded-xl bg-surface-container-low p-3 flex flex-col gap-2" data-rev="${escapeHtml(p.id)}">
      <div class="flex items-start justify-between gap-2">
        <div class="flex flex-col min-w-0">
          <p class="text-sm font-semibold text-on-surface truncate">${escapeHtml(p.nombre || 'Sin nombre')}</p>
          <p class="text-xs text-on-surface-variant truncate">${escapeHtml(p.direccion || (c ? `${c.lat.toFixed(5)}, ${c.lng.toFixed(5)}` : 'Sin dirección'))}</p>
        </div>
        <span data-chip-rev>${chipEstado(est)}</span>
      </div>
      <div class="grid grid-cols-5 gap-2">
        <input data-rev-notas="${escapeHtml(p.id)}" value="${escapeHtml(p.notas || '')}"
               placeholder="Notas…"
               class="col-span-3 min-h-[44px] px-3 rounded-lg bg-surface-container-lowest text-on-surface text-sm outline-none border border-outline-variant focus:border-secondary min-w-0" />
        <select data-rev-estado="${escapeHtml(p.id)}"
                class="col-span-2 min-h-[44px] px-2 rounded-lg bg-surface-container-lowest text-on-surface text-sm outline-none border border-outline-variant focus:border-secondary min-w-0">
          ${opciones}
        </select>
      </div>
    </div>`;
  }).join('');

  box.querySelectorAll('[data-rev-estado]').forEach((sel) => {
    sel.addEventListener('change', () => {
      const id = sel.dataset.revEstado;
      aplicarEstado(id, sel.value, { mantenerLista: true });
      const chip = sel.closest('[data-rev]')?.querySelector('[data-chip-rev]');
      if (chip) chip.innerHTML = chipEstado(sel.value);
    });
  });
  box.querySelectorAll('[data-rev-notas]').forEach((inp) => {
    inp.addEventListener('change', () => guardarNotaPunto(inp.dataset.revNotas, inp.value));
  });
}

async function enviarTerritorio() {
  enviandoInforme = true;
  revisionPendiente = false;
  sheetClose('completadoSheet');
  sheetClose('revisionSheet');
  enviandoInforme = false;
  actualizarFabInforme();
  await sincronizar(); // vacía la cola si hay pendientes y refresca datos
  toast('Territorio enviado a central');
}

$('btnRevisar').addEventListener('click', abrirRevision);
$('btnEnviarTerritorio').addEventListener('click', enviarTerritorio);
$('btnRevisionEnviar').addEventListener('click', enviarTerritorio);

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
// DEVOLVER TERRITORIO
// ============================================================
function devolverTerritorio() {
  if (!territorio) return;
  preguntar(
    '¿Devolver el territorio?',
    `Vas a devolver "${territorio.territorios.nombre}" a central aunque no esté terminado. Dejarás de verlo al instante.`,
    async () => {
      const { error } = await db.rpc('devolver_territorio');
      if (error) {
        toast(esErrorDeRed(error) ? 'Sin señal: no se pudo devolver' : error.message, { error: true });
        return;
      }
      territorio = null;
      puntos = [];
      if (map) { map.remove(); map = null; mapListo = false; markers = {}; sateliteActiva = false; }
      pintarTodo();
      toast('Territorio devuelto a central');
    }
  );
}

// ============================================================
// TABS (Mapa / Puntos / Tareas / Sync)
// ============================================================
function pintarTabs() {
  const vistas = { inicio: 'inicioView', mapa: 'mapView', ruta: 'listView', sync: 'syncView', tareas: 'tareasView' };
  for (const [tab, id] of Object.entries(vistas)) {
    $(id).classList.toggle('hidden', tab !== tabActual);
    $(id).classList.toggle('flex', tab === tabActual);
  }
  const enMapa = tabActual === 'mapa';
  $('appView').classList.toggle('map-mode', enMapa);
  $('filtrosWrap').classList.toggle('hidden', tabActual !== 'ruta' || !territorio);
  actualizarChromeTerritorio();
  if (!enMapa) cerrarMenuMapa();
  document.querySelectorAll('.navtab').forEach((b) => {
    const activo = b.dataset.tab === tabActual;
    b.classList.toggle('text-secondary', activo);
    b.classList.toggle('bg-surface-container', activo);
    b.classList.toggle('font-semibold', activo);
    b.classList.toggle('text-on-surface-variant', !activo);
  });
  if (enMapa) {
    if (!map) {
      try { initMap(); } catch (e) { console.error(e); toast('No se pudo iniciar el mapa: ' + e.message, { error: true }); }
    } else {
      actualizarCapaPuntos();
      map.resize();
    }
    requestAnimationFrame(() => { if (map) map.resize(); });
  }
  if (tabActual === 'tareas') cargarTareas();
}

function irA(tab) { tabActual = tab; pintarTabs(); }
document.querySelectorAll('.navtab').forEach((b) => b.addEventListener('click', () => irA(b.dataset.tab)));

// Inicio: tocar la tarjeta de territorio abre Puntos (como el diseño); el pie sincroniza
$('btnInicioTerritorio').addEventListener('click', () => irA('ruta'));
$('btnInicioSync').addEventListener('click', () => sincronizar());

// «Ver en mapa» en la vista de tareas: cambia al mapa y encuadra los puntos
// de la tarea para navegar rápido al sector.
$('btnTareasMapa').addEventListener('click', () => {
  irA('mapa');
  const encuadrar = () => {
    const coords = tareas
      .map((t) => coordsDe(t.puntos || {}))
      .filter(Boolean)
      .map((c) => [c.lng, c.lat]);
    encuadrarCoords(coords, { padding: 60, duration: 300 });
  };
  if (!map) return;
  if (mapListo) encuadrar();
  else map.once('load', encuadrar);
});

// ============================================================
// TAREAS ESPECIALES DE VERIFICACIÓN (doble chequeo asignado por central)
// Central asigna puntos cuya señal errónea/no pasar debe confirmarse en
// terreno. El usuario confirma o rechaza; el aviso llega a la vista Nueva
// actividad del admin.
// ============================================================
let tareas = [];

async function cargarTareas() {
  if (!user) return;
  const { data, error } = await db
    .from('tareas_verificacion')
    .select('id, punto_id, estado, created_at, puntos ( nombre, direccion, estado, geom )')
    .eq('user_id', user.id)
    .eq('estado', 'pendiente')
    .order('created_at', { ascending: false });
  if (error) {
    if (!esErrorDeRed(error)) toast('No se pudieron cargar las tareas: ' + error.message, { error: true });
    return;
  }
  tareas = data || [];
  pintarTareas();
  if (tabActual === 'inicio') pintarInicioTareas();
  if (mapListo) actualizarCapaPuntos(); // marcadores de tarea al día
}

function pintarTareas() {
  const box = $('tareasList');
  if (!box) return;
  const hay = tareas.length > 0;
  $('tareasIntro').classList.toggle('hidden', !hay);
  $('btnTareasMapa').classList.toggle('hidden', !hay);
  actualizarChromeTerritorio();
  if (!hay) {
    box.innerHTML = '<div class="text-sm text-on-surface-variant text-center py-8 bg-surface-container-lowest rounded-xl">Sin tareas asignadas.</div>';
    return;
  }
  box.innerHTML = tareas.map((t) => {
    const p = t.puntos || {};
    const c = coordsDe(p);
    const nav = c ? linkComoLlegar(c.lat, c.lng) : null;
    return `
    <article class="bg-surface-container-lowest rounded-xl p-4 shadow-sm flex flex-col gap-3">
      <div class="flex items-start justify-between gap-3">
        <div class="flex flex-col min-w-0">
          <span class="text-[11px] font-bold text-on-surface-variant">VERIFICAR EN TERRENO</span>
          <h3 class="text-base font-bold text-on-surface truncate leading-tight">${escapeHtml(p.nombre || 'Sin nombre')}</h3>
          <p class="text-sm text-on-surface-variant truncate">${escapeHtml(p.direccion || (c ? `${c.lat.toFixed(5)}, ${c.lng.toFixed(5)}` : 'Sin dirección'))}</p>
        </div>
        ${chipEstado(p.estado || 'pendiente')}
      </div>
      <div class="grid grid-cols-2 gap-2">
        <button class="min-h-[48px] rounded-xl bg-primary text-on-primary text-sm font-bold flex items-center justify-center gap-1 active:bg-secondary"
                data-tarea-res="${escapeHtml(t.id)}" data-punto="${escapeHtml(t.punto_id)}" data-res="confirmado">
          <span class="material-symbols-outlined text-[20px]">task_alt</span><span>Confirmar</span>
        </button>
        <button class="min-h-[48px] rounded-xl bg-surface-container text-on-surface text-sm font-bold flex items-center justify-center gap-1 active:opacity-80"
                data-tarea-res="${escapeHtml(t.id)}" data-punto="${escapeHtml(t.punto_id)}" data-res="rechazado">
          <span class="material-symbols-outlined text-[20px]">cancel</span><span>Rechazar</span>
        </button>
      </div>
      ${nav ? `<a class="text-xs text-secondary font-semibold flex items-center gap-1" href="${nav}" target="_blank" rel="noopener"><span class="material-symbols-outlined text-[16px]">near_me</span>Cómo llegar</a>` : ''}
    </article>`;
  }).join('');
  box.querySelectorAll('[data-tarea-res]').forEach((b) => {
    b.addEventListener('click', () => resolverTarea(b.dataset.tareaRes, b.dataset.punto, b.dataset.res));
  });
}

async function resolverTarea(tareaId, puntoId, resultado) {
  const { error } = await db.rpc('resolver_verificacion', {
    p_punto: puntoId,
    p_resultado: resultado,
    p_tarea: tareaId,
  });
  if (error) {
    if (esErrorDeRed(error)) {
      toast('Sin señal: la verificación se enviará al sincronizar', { error: true });
      return;
    }
    toast(error.message, { error: true });
    return;
  }
  toast(resultado === 'confirmado'
    ? 'Verificación enviada: el estado quedó confirmado'
    : 'Verificación enviada: el punto volvió a pendiente');
  await cargarTareas();
}

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
  avisarSiCompleto();

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
      // Solicitud de punto nuevo (el admin la confirma en Nueva actividad)
      const { error } = await db.rpc('crear_solicitud_punto', {
        p_nombre: op.datos.nombre, p_direccion: op.datos.direccion,
        p_notas: op.datos.notas, p_lat: op.datos.lat, p_lng: op.datos.lng,
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
    if (op.tipo === 'nota') {
      const { error } = await db.rpc('agregar_nota_punto', { p_id: op.clave, p_texto: op.datos.texto });
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
// Refresco periódico: si hay cola, sincroniza; si no, refresca datos en
// silencio (recupera la app si una carga inicial falló, p. ej. token vencido)
setInterval(() => {
  if (!user || !navigator.onLine) return;
  if (cola.length) { sincronizar(); return; }
  refrescar({ ajustarMapa: true }).then(() => pintarTodo()).catch(() => {});
}, 45000);

// ============================================================
// ARRANQUE
// ============================================================
(async function boot() {
  pintarTabs();
  try {
    const { data } = await db.auth.getSession();
    if (data?.session?.user && !user) await entrar(data.session.user);
  } catch (e) {
    console.error(e);
    toast('No se pudo recuperar la sesión: ' + e.message, { error: true });
  }
})();
