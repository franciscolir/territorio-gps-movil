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
let tabActual = 'ruta';
let filtroActual = 'todos';
let map = null;
let mapListo = false;
let markers = {};       // id -> Marker
let sateliteActiva = false; // vista satélite del mapa (por instancia de mapa)
let sheetPunto = null;  // { id, lat, lng, esNuevo }
let statusTarget = null;
let undoInfo = null;    // { id, prev, timer }
let confirmAction = null;
let syncRunning = false;
let opSeq = 0;

// Modo abierto por card en la lista: id -> 'nota' | 'estados' (y borrador de nota)
const modoCard = {};
const borradorNota = {};

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
for (const id of ['statusSheet', 'pointSheet', 'confirmSheet', 'configSheet', 'completadoSheet', 'revisionSheet']) {
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
$('btnSatelite').addEventListener('click', alternarSatelite);
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
  user = null; territorio = null; puntos = [];
  detenerGps();
  $('appView').classList.add('hidden');
  $('emptyView').classList.add('hidden');
  $('emptyView').classList.remove('flex');
  $('loginView').classList.remove('hidden');
});

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
  $('userEmail').textContent = u.email || '';
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
  if (territorio) await cargarPuntos();
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
    .select('territorio_id, estado, assigned_at, territorios ( id, nombre, comuna, color, geom )')
    .eq('user_id', user.id)
    // 'completado' (auto al 100 %, migración 008) sigue visible para revisar/enviar;
    // la más reciente gana si coexisten con una nueva asignación
    .in('estado', ['activa', 'completado'])
    .order('assigned_at', { ascending: false })
    .limit(1)
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
  const { data, error } = await db
    .from('puntos')
    .select('*')
    .eq('territorio_id', territorio.territorio_id)
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
  pintarVistaTerritorio();
  pintarCola();
  pintarLista();
  pintarTarjetaTerritorio();
  pintarFiltros();
  if (mapListo) actualizarCapaPuntos();
}

// ============================================================
// ZONA DE BOTONES DE LA CARD: modos nota / estados con transición
// Los elementos colapsan (flex-basis → 0) y se expanden: se ven
// deslizarse y volver, nunca aparecer de golpe.
// ============================================================
function abrirModoNota(zona, id) {
  modoCard[id] = 'nota';
  if (!(id in borradorNota)) borradorNota[id] = puntoPorId(id)?.notas || '';
  zona.querySelector('.acc-nav')?.classList.add('oculto');
  zona.querySelector('.acc-estado')?.classList.add('oculto');
  zona.querySelector('.acc-input')?.classList.add('abierta');
  zona.querySelector('.acc-nota')?.classList.add('modo-guardar');
  const inp = zona.querySelector('[data-nota-input]');
  inp.value = borradorNota[id] ?? '';
  setTimeout(() => inp.focus(), 340);
}

function abrirModoEstados(zona, id) {
  modoCard[id] = 'estados';
  zona.querySelector('.acc-nav')?.classList.add('oculto');
  zona.querySelector('.acc-input')?.classList.remove('abierta');
  zona.querySelector('.acc-nota')?.classList.remove('modo-guardar');
  zona.querySelector('.acc-nota')?.classList.add('oculto');
  zona.querySelector('.acc-estado')?.classList.add('oculto');
  zona.querySelector('.estados-wrap')?.classList.add('abierta');
}

// Todo vuelve a su sitio deslizándose
function cerrarZona(zona, id) {
  delete modoCard[id];
  zona.querySelector('.acc-nav')?.classList.remove('oculto');
  zona.querySelector('.acc-input')?.classList.remove('abierta');
  zona.querySelector('.acc-nota')?.classList.remove('modo-guardar', 'oculto');
  zona.querySelector('.acc-estado')?.classList.remove('oculto');
  zona.querySelector('.estados-wrap')?.classList.remove('abierta');
}

// Guarda la nota de un punto (RPC; sin señal → cola). true = quedó guardada o en cola
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

async function guardarNotaRapida(zona, id) {
  const ok = await guardarNotaPunto(id, borradorNota[id]);
  if (!ok) return;
  actualizarNotasEnCard(zona, puntoPorId(id)?.notas || '');
  delete borradorNota[id];
  cerrarZona(zona, id);
}

function actualizarNotasEnCard(zona, nota) {
  const art = zona.closest('article');
  if (!art) return;
  const bloque = art.querySelector('[data-notas]');
  if (nota) {
    const html = `<div data-notas class="bg-surface-container-low p-2 rounded-lg flex items-center gap-2">
      <span class="material-symbols-outlined text-secondary text-[18px] shrink-0">info</span>
      <p class="text-xs text-on-surface-variant italic truncate">"${escapeHtml(nota)}"</p>
    </div>`;
    if (bloque) bloque.outerHTML = html;
    else art.querySelector('[data-coords]')?.insertAdjacentHTML('afterend', html);
  } else {
    bloque?.remove();
  }
}

function elegirEstadoRapido(zona, id, valor) {
  if (!puntoPorId(id)) return;
  // mantenerLista: evita el re-render que cortaría la animación de cierre
  aplicarEstado(id, valor, { mantenerLista: true });
  actualizarEstadoEnCard(zona, valor);
  cerrarZona(zona, id);
}

function actualizarEstadoEnCard(zona, est) {
  const art = zona.closest('article');
  const chip = art?.querySelector('[data-chip]');
  if (chip) chip.innerHTML = chipEstado(est);
  zona.querySelectorAll('.est-op').forEach((b) => {
    const activo = b.dataset.valor === est;
    b.className = `est-op min-w-0 flex-1 rounded-lg text-[10px] font-semibold flex flex-col items-center justify-center gap-0.5 active:opacity-80 ${
      activo ? CLASES_ESTADO_ACTIVO[b.dataset.valor] : 'bg-surface-container text-on-surface-variant'
    }`;
  });
}

function pintarVistaTerritorio() {
  const vacio = !territorio;
  $('emptyView').classList.toggle('hidden', !vacio);
  $('emptyView').classList.toggle('flex', vacio);
  $('appView').classList.toggle('hidden', vacio);
  const err = $('emptyError');
  err.textContent = errorTerritorio ? 'Detalle: ' + errorTerritorio : '';
  err.classList.toggle('hidden', !errorTerritorio);
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
  $('stripComuna').textContent = territorio?.territorios?.comuna || '—';

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

function pintarTarjetaTerritorio() {
  const av = territorioAvance(puntos);
  const extra = colaResumen(cola).crear;
  $('territorioNombre').textContent = territorio ? territorio.territorios.nombre : '—';
  $('territorioProgreso').textContent = `${av.visitado} de ${av.total} visitados (${av.pct}%)`;
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
  const av = territorioAvance(puntos);
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
    const local = !!p.local;
    const enNota = modoCard[p.id] === 'nota';
    const enEstados = modoCard[p.id] === 'estados';
    const clsNav = enNota || enEstados ? 'oculto' : '';
    const clsInput = enNota ? 'abierta' : '';
    const clsNota = enNota ? 'modo-guardar' : (enEstados ? 'oculto' : '');
    const clsEstado = enNota || enEstados ? 'oculto' : '';
    const clsEstados = enEstados ? 'abierta' : '';
    const borrador = enNota ? (borradorNota[p.id] ?? p.notas ?? '') : (p.notas ?? '');
    const opcionesEstado = ESTADOS.map(([valor, etiqueta]) => {
      const activo = valor === est;
      const cls = activo ? CLASES_ESTADO_ACTIVO[valor] : 'bg-surface-container text-on-surface-variant';
      return `
        <button class="est-op min-w-0 flex-1 rounded-lg ${cls} text-[10px] font-semibold flex flex-col items-center justify-center gap-0.5 active:opacity-80"
                data-estado-rapido="${escapeHtml(p.id)}" data-valor="${valor}"
                ${local ? 'disabled' : ''}>
          <span class="material-symbols-outlined text-[18px]">${ICONOS_ESTADO[valor]}</span>
          <span>${etiqueta}</span>
        </button>`;
    }).join('');
    return `
    <article class="bg-surface-container-lowest rounded-xl p-4 shadow-sm flex flex-col gap-3" data-id="${escapeHtml(p.id)}">
      <div class="flex items-start justify-between gap-3">
        <div class="flex flex-col min-w-0 cursor-pointer" data-abrir="${escapeHtml(p.id)}">
          <span class="text-[11px] font-bold text-on-surface-variant">${local ? 'NUEVO · PENDIENTE SYNC' : 'PDV'}</span>
          <h3 class="text-base font-bold text-on-surface truncate leading-tight">${escapeHtml(p.nombre || 'Sin nombre')}</h3>
          <p class="text-sm text-on-surface-variant truncate">${escapeHtml(p.direccion || 'Sin dirección')}</p>
        </div>
        <span data-chip>${chipEstado(est)}</span>
      </div>
      ${coords ? `
      <div data-coords class="flex items-center gap-1 text-xs text-on-surface-variant">
        <span class="material-symbols-outlined text-[14px]">location_on</span>
        <span>${coords.lat.toFixed(5)}, ${coords.lng.toFixed(5)}</span>
      </div>` : ''}
      ${p.notas ? `
      <div data-notas class="bg-surface-container-low p-2 rounded-lg flex items-center gap-2">
        <span class="material-symbols-outlined text-secondary text-[18px] shrink-0">info</span>
        <p class="text-xs text-on-surface-variant italic truncate">"${escapeHtml(p.notas)}"</p>
      </div>` : ''}
      <div class="zona-btns">
        <a class="acc acc-nav ${clsNav} bg-surface-container active:bg-surface-container-high"
           href="${nav}" target="_blank" rel="noopener" title="Cómo llegar" aria-label="Cómo llegar">
          <span class="material-symbols-outlined text-primary text-[20px]">near_me</span>
        </a>
        <div class="acc-zona acc-input ${clsInput}">
          <input data-nota-input="${escapeHtml(p.id)}"
                 class="w-full h-full min-w-0 px-3 rounded-lg bg-surface-container text-on-surface text-sm outline-none border border-outline-variant focus:border-secondary"
                 placeholder="Agregar nota…" value="${escapeHtml(borrador)}" />
        </div>
        <button class="acc acc-nota ${clsNota} bg-surface-container active:bg-surface-container-high"
                data-nota-btn="${escapeHtml(p.id)}" title="Nota" aria-label="Nota"
                ${local ? 'disabled' : ''}>
          <span class="ic ic-pencil material-symbols-outlined text-primary text-[20px]">edit</span>
          <span class="ic ic-flecha material-symbols-outlined text-primary text-[20px]">arrow_forward</span>
        </button>
        <button class="acc acc-estado ${clsEstado} bg-surface-container active:bg-surface-container-high"
                data-estado-btn="${escapeHtml(p.id)}" title="Estado" aria-label="Cambiar estado"
                ${local ? 'disabled' : ''}>
          <span class="material-symbols-outlined text-primary text-[20px]">flag</span>
        </button>
        <div class="acc-zona estados-wrap ${clsEstados}">${opcionesEstado}</div>
      </div>
    </article>`;
  }).join('');

  box.querySelectorAll('[data-abrir]').forEach((el) => {
    el.addEventListener('click', () => abrirFicha(el.dataset.abrir));
  });
  box.querySelectorAll('[data-nota-btn]').forEach((b) => {
    b.addEventListener('click', () => {
      const zona = b.closest('.zona-btns');
      const id = b.dataset.notaBtn;
      if (modoCard[id] === 'nota') guardarNotaRapida(zona, id);
      else abrirModoNota(zona, id);
    });
  });
  box.querySelectorAll('[data-nota-input]').forEach((inp) => {
    inp.addEventListener('input', () => { borradorNota[inp.dataset.notaInput] = inp.value; });
    inp.addEventListener('keydown', (e) => {
      const zona = inp.closest('.zona-btns');
      if (e.key === 'Enter') { e.preventDefault(); guardarNotaRapida(zona, inp.dataset.notaInput); }
      if (e.key === 'Escape') { delete borradorNota[inp.dataset.notaInput]; cerrarZona(zona, inp.dataset.notaInput); }
    });
  });
  box.querySelectorAll('[data-estado-btn]').forEach((b) => {
    b.addEventListener('click', () => abrirModoEstados(b.closest('.zona-btns'), b.dataset.estadoBtn));
  });
  box.querySelectorAll('[data-estado-rapido]').forEach((b) => {
    b.addEventListener('click', () => elegirEstadoRapido(b.closest('.zona-btns'), b.dataset.estadoRapido, b.dataset.valor));
  });
}

// Iconos y clases de los botones de estado rápido de la card
const ICONOS_ESTADO = { pendiente: 'schedule', visitado: 'check_circle', erroneo: 'cancel', no_pasar: 'block' };
const CLASES_ESTADO_ACTIVO = {
  pendiente: 'bg-surface-container-high text-secondary',
  visitado: 'bg-tertiary-fixed text-on-tertiary-fixed',
  erroneo: 'bg-surface-container-highest text-on-surface-variant',
  no_pasar: 'bg-error-container text-on-error-container',
};

function chipEstado(est) {
  const mapa = {
    visitado: ['bg-tertiary-fixed text-on-tertiary-fixed', 'check_circle', 'Visitado'],
    erroneo: ['bg-surface-container-highest text-on-surface-variant', 'cancel', 'Erróneo'],
    no_pasar: ['bg-error-container text-on-error-container', 'block', 'No pasar'],
    pendiente: ['bg-surface-container-high text-secondary', 'schedule', 'Pendiente'],
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
  if (map || !territorio) return;
  const gl = document.createElement('canvas').getContext('webgl2')
    || document.createElement('canvas').getContext('webgl');
  if (!gl) {
    toast('WebGL no está disponible en este navegador', { error: true });
    return;
  }
  const geom = territorio.territorios.geom;
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
      map.addSource('territorio-movil', { type: 'geojson', data: { type: 'Feature', geometry: geom, properties: {} } });
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

function ajustarVistaMapa() {
  if (!map || !territorio) return;
  const bb = bboxDeGeometria(territorio.territorios.geom);
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

  const av = territorioAvance(puntos);
  $('mapLegend').innerHTML = `
    <span class="text-on-tertiary">${av.visitado} visitados</span>
    <span class="text-on-surface-variant">${av.erroneo} erróneos</span>
    <span class="text-error">${av.no_pasar} no pasar</span>
    <span class="text-secondary">${av.pendiente} pendientes</span>`;
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
  if (!dentroDelTerritorio(lat, lng)) { err.textContent = 'Las coordenadas quedan fuera de tu territorio'; return; }

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

function dentroDelTerritorio(lat, lng) {
  const g = territorio?.territorios?.geom;
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
    pendiente: 'bg-surface-container-high text-secondary',
    visitado: 'bg-tertiary-fixed text-on-tertiary-fixed',
    erroneo: 'bg-surface-container-highest text-on-surface-variant',
    no_pasar: 'bg-error-container text-on-error-container',
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

async function aplicarEstado(id, estado, { silent = false, mantenerLista = false } = {}) {
  const p = puntoPorId(id);
  if (!p) return;
  const prev = p.estado || 'pendiente';

  // Optimista: la lista refleja el cambio al instante
  p.estado = estado;
  if (!mantenerLista) pintarLista();
  pintarTarjetaTerritorio(); pintarFiltros(); actualizarCapaPuntos();

  const { error } = await db.rpc('marcar_estado', { p_id: id, p_estado: estado });
  if (error) {
    if (esErrorDeRed(error)) {
      encolar('estado', id, { estado });
      if (!silent) toast('Sin señal: el cambio quedó en cola local');
      return;
    }
    p.estado = prev; // revierte el optimismo
    if (!mantenerLista) pintarLista();
    pintarTarjetaTerritorio(); pintarFiltros(); actualizarCapaPuntos();
    toast(error.message, { error: true });
    return;
  }
  if (!silent && prev !== estado) {
    toast(`Marcado como "${estadoLabel(estado)}"`, {
      undo: prev !== estado ? { id, prev } : null,
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
  sheetClose('completadoSheet');
  sheetClose('revisionSheet');
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
$('btnDevolver').addEventListener('click', () => {
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
});

// ============================================================
// NAVEGACIÓN AL SIGUIENTE PUNTO
// ============================================================
$('btnNavegar').addEventListener('click', () => {
  const siguiente = puntos.find((p) => (p.estado || 'pendiente') === 'pendiente') || puntos[0];
  const c = siguiente ? coordsDe(siguiente) : null;
  if (c) { abrirRuta(c.lat, c.lng); return; }
  const bb = bboxDeGeometria(territorio?.territorios?.geom);
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
    if (!map && territorio) {
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
