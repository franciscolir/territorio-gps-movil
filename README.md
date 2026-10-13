# Territorio GPS — App de Terreno (Móvil)

Web-app para **colaboradores de terreno** del proyecto Territorio GPS
(Región Metropolitana de Chile). Es la app que usa la cuadrilla en el teléfono:

- Ve **solo su territorio asignado** y sus puntos (lo limita RLS en Supabase, no el front).
- Crea y edita puntos, cambia estados (`pendiente`, `visitado`, `erróneo`, `no_pasar`) y **devuelve el territorio** cuando termina.
- **Cola offline**: sin señal, todo queda guardado en el teléfono (localStorage) y se sincroniza solo al volver la conexión.
- Mapa MapLibre con el polígono del territorio, pines por estado y navegación a Google Maps.
- **GPS del dispositivo**: al iniciar pide activar la ubicación; si se concede muestra "GPS ACTIVO" en el header y un punto azul con tu posición en el mapa; si no, "UBICACIÓN NO DISPONIBLE".
- **Configuración** (engranaje en el header): tema **claro/oscuro** y **app de direcciones** (Google Maps, Waze o Mapas de iOS) que se abre al tocar "Cómo llegar".

> Este repo se **extrajo** de [`territorio-gps`](../territorio-gps) (repo principal con la
> app de escritorio/central, esquema SQL y migraciones). Comparte la **misma base
> Supabase**; el backend (tablas, RLS y RPCs) vive en el repo principal.

---

## Índice

- [Requisitos](#requisitos)
- [Puesta en marcha](#puesta-en-marcha)
- [Scripts](#scripts)
- [Estructura del repo](#estructura-del-repo)
- [Backend (RPCs que consume)](#backend-rpcs-que-consume)
- [Cola offline](#cola-offline)
- [Tests y lint](#tests-y-lint)
- [Despliegue](#despliegue)
- [Seguridad](#seguridad)

---

## Requisitos

- Node.js 18+ (solo para tests y lint; la app en sí no tiene build).
- Una cuenta [Supabase](https://supabase.com) con el backend de Territorio GPS
  ya instalado (ver repo principal: `schema.sql` + migraciones).
- Navegador móvil moderno (Chrome/Android, Safari/iOS).

## Puesta en marcha

1. **Configura Supabase** al inicio de [`app.js`](app.js):

   ```js
   const SUPABASE_URL = 'https://TU-PROYECTO.supabase.co';
   const SUPABASE_ANON_KEY = 'sb_publishable_...'; // clave publicable/anon
   const MAP_STYLE = 'https://tiles.openfreemap.org/styles/positron';
   ```

   Debe ser la **misma** Supabase que usa la app de escritorio/central.

2. **Sirve la carpeta** con cualquier servidor estático:

   ```bash
   npm install          # solo si vas a correr tests o lint
   npx serve .
   ```

3. En el teléfono, abre la URL, inicia sesión con tu cuenta de colaborador
   (creada en Supabase → Authentication) y espera a que central te asigne un territorio.

> No hay build ni bundler: `index.html` + `lib.js` + `app.js` son scripts
> clásicos que se sirven tal cual (funciona también abriendo `index.html`
> desde disco).

## Scripts

| Comando | Qué hace |
|---|---|
| `npm test` | Tests unitarios de `lib.js` con Vitest (escaping, EWKB, punto-en-polígono, estados, cola offline, avance) |
| `npm run test:watch` | Tests en modo watch |
| `npm run lint` | ESLint sobre `lib.js`, `app.js`, tests y config |

## Estructura del repo

```
index.html            Shell de la app: login, tarjeta de territorio, lista/mapa/sync, bottom sheets
app.js                Lógica de terreno: territorio único, fichas, estados, devolución, cola offline
lib.js                Funciones puras: escaping, EWKB/GeoJSON, punto-en-polígono, estados, cola offline
tests/lib.test.js     Tests unitarios de lib.js (Vitest)
eslint.config.js      Configuración de lint (browser + node)
```

**Por qué scripts clásicos y no módulos:** la app se sirve como archivos
estáticos y a veces se abre desde disco; `<script src>` sin `type="module"`
funciona en ambos casos. `lib.js` se declara antes que `app.js` y expone sus
funciones como globales; `eslint.config.js` lista esas globales para que el
lint detecte usos/definiciones.

## Backend (RPCs que consume)

El front **no** toca tablas directamente para escribir: usa las RPCs del repo
principal (RLS garantiza que un colaborador solo afecte su territorio):

| RPC | Uso en la app |
|---|---|
| `marcar_estado` | Cambiar estado de un punto (devuelve el estado anterior para "Deshacer") |
| `guardar_punto` | Crear punto (dentro del polígono del territorio) |
| `actualizar_punto_terreno` | Editar nombre/dirección/notas/coordenadas |
| `eliminar_punto_propio` | Borrar un punto creado por el propio colaborador |
| `devolver_territorio` | Devolver el territorio a central (ciclo de vida activa/devuelta) |

Lecturas: `territorios_asignaciones` (asignación activa con el territorio anidado) y
`puntos` (RLS ya filtra al territorio activo).

## Cola offline

- Las operaciones (`estado`, `crear`, `editar`, `borrar`) se guardan en
  `localStorage` (clave `gps_movil_cola`) con helpers puros de `lib.js`.
- Si dos operaciones del mismo tipo afectan al mismo punto, la cola conserva
  **solo la última** (p. ej. dos cambios de estado = un solo envío).
- Al recuperar señal (evento `online` o cada 45 s) se sincroniza en orden; si
  una op ya no aplica (punto borrado, RLS), se **descarta** en vez de bloquear la cola.
- La sesión usa su propio `storageKey` (`gps-movil-session`) para no competir
  con la app de escritorio en el mismo origen.

## Tests y lint

```bash
npm test        # toda la suite: unitarias + integración + E2E (mock) + E2E real
npm run test:db # solo E2E real contra la BD (fetch directo, sin deps)
npm run lint    # ESLint, 0 errores
```

Cuatro capas de pruebas (Vitest + jsdom):

| Capa | Archivo | Qué prueba |
|---|---|---|
| **Unitarias** | `tests/lib.test.js` | Funciones puras de `lib.js`: escaping, EWKB/GeoJSON, punto-en-polígono, estados, cola offline, avance (mocks: ninguno) |
| **Integración** | `tests/integracion.app.test.js` | Lógica de `app.js` con **DB mock** (`tests/helpers/mockSupabase.js`) y el DOM real de `index.html` en jsdom: `cargarAsignacion` (reintentos, red caída), cola offline (`ejecutarOp`, `sincronizar`), `aplicarEstado` (optimista/revertir/encolar), notas, GPS, links de mapas, sesión |
| **E2E con mock** | `tests/e2e.mock.test.js` | Flujo completo del usuario sobre el DOM + DB simulada: arranque con sesión restaurada, marcar estados desde cards, modal de territorio completado → revisión in situ → enviar, offline→online, nota rápida, devolución |
| **E2E real** | `tests/e2e.db.test.js` | Solo lo mínimo y crítico contra la BD real con `fetch` (sin dependencias): API viva, tablas existen, login real, consulta autenticada (grants+RLS) y RPCs desplegados. Los tests autenticados se **saltan** sin env vars: `SUPABASE_TEST_EMAIL` / `SUPABASE_TEST_PASSWORD` (y opcionalmente `SUPABASE_URL` / `SUPABASE_ANON_KEY`) |

`lib.js` está pensado para testearse: las funciones no tocan DOM ni estado
global. `app.js` se evalúa en los tests igual que en el navegador: `lib.js`
+ `app.js` como scripts clásicos dentro del DOM real de `index.html`, con
`supabase` sustituido por el mock (`accessToken`/`from`/`rpc` simulados;
sin señal el mock devuelve error de red, igual que un fetch real).
Si agregas una función a `lib.js`, agrégala al `return` del wrapper de
tests y a `libGlobals` en `eslint.config.js`.

## Despliegue

Sitio 100% estático (Supabase Hosting, Netlify, Vercel, GitHub Pages,
Cloudflare Pages): apunta la raíz del repo y listo, no hay build.

## Seguridad

La clave anon/publicable del front **no es secreta**: está pensada para ir en
el cliente. La protección real (quién ve qué, quién escribe qué) la da **RLS**
en Supabase, definida en el repo principal. No subas nunca una
`service_role` key a este repo.
