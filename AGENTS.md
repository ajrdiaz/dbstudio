# AGENTS.md — DBStudio

Guía para agentes (y personas) que trabajen en este repositorio: qué es, cómo
está armado, cómo probar sin riesgo y qué reglas no romper. Mantenla al día
cuando cambie algo importante.

## Qué es

Cliente de **MySQL / MariaDB** al estilo SQLyog (con ideas de Navicat y
pgAdmin). Backend **Node + Express + mysql2** (`server/`), frontend
**React 18 + Vite + Monaco** (`client/`). Un solo usuario, sin login: el API
solo escucha en `127.0.0.1`.

- El usuario escribe en **español**; la interfaz es español por defecto con
  inglés disponible. Responde y documenta en español.
- El usuario **lo usa a diario contra servidores reales de producción** (y una
  réplica de solo lectura). Trátalo como software en producción.

## Cómo correrlo

```bash
bash run.sh          # API (puerto libre desde 4000) + UI Vite (desde 5180); Ctrl+C cierra ambos
```

- El API corre con `node --watch`: los cambios en `server/` se recargan solos.
- Vite hace HMR en `client/`. Si se edita `client/src/i18n.jsx` con la app
  abierta, puede requerir recargar la página (hay un fallback en `useI18n`).
- Compilar para verificar: `cd client && npx vite build` (o esbuild sobre
  `src/main.jsx` para un chequeo rápido). `node --check server/*.js` para el API.

## Arquitectura

### Server (`server/`)
| Archivo | Responsabilidad |
|---|---|
| `index.js` | Express, middleware de seguridad (solo loopback + Origin), rutas de conexiones, datos, filas, query, export/import, almacenamiento. `start()` exportado (lo usa la app de escritorio). |
| `paths.js` | Carpeta de datos configurable (`~/.dbstudio` o OneDrive/Google Drive), `config.json`, ubicación de la `.key`, escritura atómica. |
| `store.js` | Perfiles de conexión (contraseñas y secretos SSH cifrados AES-256-GCM), entorno (`env`, `confirmWrites`, `readOnly`), `group`. |
| `workspace.js` | Consultas guardadas, historial, workspace (pestañas abiertas). |
| `pools.js` | Pool mysql2 por conexión (async por el túnel SSH), `sessionConfig`. |
| `tunnel.js` | Túneles SSH (ssh2) con forwarder local. |
| `sessions.js` | Sesiones de editor: una conexión dedicada por pestaña SQL (transacciones, cancelar con KILL QUERY, `sql_select_limit`). |
| `sql.js` | `quoteId` / `quoteVal`, introspección (`listObjects`, `columnMeta`, `primaryKey`…). |
| `sqlKind.js` | Clasifica sentencias lectura/escritura + `assertWritable`. **Duplicado** en `client/src/lib/sqlKind.js`: mantener ambos iguales. |
| `admin.js` | Procesos, variables/estado, usuarios y permisos, replicación, consultas pesadas. |
| `objects.js` | Búsqueda de objetos y DDL de cualquier objeto. |
| `dbinfo.js` | Estadísticas/mantenimiento de tablas, modelo del diagrama ER, importación por lotes. |
| `tools.js` | Comparar esquemas (script de sync) y copiar tablas (jobs con progreso). |
| `ddl.js` | Diseñador de tablas (CREATE/ALTER). |
| `monitor.js` | Alertas: reglas por conexión (replicación, caído, conexiones, consultas largas/lentas), estado alerta/resuelta, historial y SSE `/api/monitor/stream`. Arranca con `start()`. |

### Client (`client/src/`)
- `App.jsx`: pestañas (`kind`: query, data, structure, designer, server, tools, database), modales, atajos globales (Ctrl+P buscar, Ctrl+B panel).
- `components/EditableGrid.jsx`: grilla compartida (filas como arrays, edición tipo Excel, undo, preview SQL, virtualización).
- `components/QueryTab.jsx`: editor Monaco + pestañas de resultados + transacciones.
- `lib/env.jsx`: entornos de conexión, `guardWrite` (confirmación antes de escribir) y `ConfirmHost`.
- `lib/polling.js`: auto-refresh que se pausa si la pestaña no se ve o tras un error.
- `i18n.jsx`: diccionarios `es` y `en`.

### Desktop (`desktop/`)
- Electron. `main.mjs` arranca el API en el mismo proceso (`start({ port: 4799…, staticDir: web })`),
  ventana + bandeja, notificaciones nativas desde `monitorEvents`, iniciar con Windows (`--hidden`).
  Log en `%APPDATA%\DBStudio\desktop.log`.
- `npm run stage` arma `desktop/stage` (UI compilada en `web/`, fuentes del server en `server/`,
  dependencias del server en `stage/node_modules` declaradas en `stage/package.json`: si quedan
  en `stage/server/node_modules` electron-builder NO las empaqueta).
- `npm run dist` → `desktop/release/DBStudio-Setup-<versión>.exe` (NSIS, sin firma de código).
- Electron no implementa `window.prompt`: usar `askText()` de `lib/dialogs.jsx`.

### Datos del usuario
En la carpeta de datos (por defecto `~/.dbstudio`, hoy en OneDrive):
`connections.json`, `queries.json`, `history.json`, `workspace.json` y `.key`.
**Nunca** se versionan ni se borran; el repositorio no contiene datos del usuario.

## Reglas (no romper)

1. **Seguridad del API**: escucha solo en `127.0.0.1` y rechaza Host/Origin
   que no sean loopback (protege contra sitios web y DNS rebinding). No
   reactivar `cors()` ni escuchar en `0.0.0.0` sin agregar autenticación.
2. **Toda acción que modifica datos/estructura pasa por `guardWrite`** en el
   cliente (confirmación en producción, bloqueo en solo lectura) y el server
   aplica `readOnly` con el middleware de `/api/connections/:id` +
   `assertWritable` en `/query`. Las rutas nuevas que escriben quedan cubiertas
   por ese middleware; las de solo lectura usan GET o `preview: true`.
3. **Mostrar el SQL antes de ejecutarlo** en acciones administrativas
   (endpoints con `preview: true`).
4. **i18n**: todo texto visible va en `i18n.jsx`, en **ambos** diccionarios.
5. **CSS**: tema con variables (`--bg`, `--panel`, `--text`, `--accent`…) en
   `:root` y `:root[data-theme="dark"]`. Nada de clases globales genéricas
   (`.main` chocaba con Monaco y ocultaba el autocompletado). Íconos Unicode
   con el selector de texto U+FE0E (`⚙︎`) para que no salgan como emoji de color.
6. **Gráficos**: colores `--series-1..4` (paleta validada con el skill dataviz),
   un solo eje Y, leyenda con valores.
7. **Polling**: usar `usePolling` (no `setInterval` suelto) para no consultar
   producción desde pestañas ocultas.
8. Commits en español, con la línea de atribución de Claude.

## Cómo probar sin riesgo

- **Nunca** ejecutar escrituras contra las conexiones reales del usuario ni
  modificar su workspace. Leer está bien si es necesario y liviano.
- Instancia aislada: API con `USERPROFILE=<scratch>/uihome PORT=4100 node --watch index.js`
  y Vite con `API_PORT=4100 CLIENT_PORT=5190`. Usa datos falsos en esa carpeta.
- BD de prueba: MariaDB 11.4 instalada en `C:\Program Files\MariaDB 11.4`:
  `mariadb-install-db --datadir=<scratch>/mdb --password=test123 --port=3310`
  y `mariadbd --defaults-file=<scratch>/mdb/my.ini` (añadir
  `--performance-schema=ON` para consultas pesadas; `--log-bin --server-id=1`
  más una segunda instancia con `--server-id=2 --read-only` para replicación).
- En Playwright contra la app real del usuario (5180), interceptar
  `PUT /api/workspace` para no tocar su sesión.
- Errores en tiempo de ejecución (p. ej. usar una función antes de definirla en `App.jsx`)
  no los detecta esbuild: **siempre cargar la app en el navegador** tras tocar `App.jsx`.
- App de escritorio: probar con `DBSTUDIO_DATA_DIR=<scratch>` (datos aislados),
  `--hidden --remote-debugging-port=9333` y conectarse por CDP. **No** cambiar `USERPROFILE`
  (Electron no arranca bien). Probar también el **empaquetado** (`release/win-unpacked/DBStudio.exe`),
  no solo `electron stage`.
- Probar en navegador los flujos tocados (tema claro y oscuro) y apagar al
  final los servidores de prueba.

## Estado / pendientes

- Hecho: alertas + app de escritorio (instalador sin firmar: Windows SmartScreen
  muestra "Editor desconocido" la primera vez).
- Idea evaluada: migrar el backend a Go + Wails reduciría instalador (~15 MB) y RAM; no
  mejora la velocidad de consultas. Pospuesto hasta que el usuario lo pida.
- Limitaciones conocidas: comparar esquemas no detecta renombres; copiar BD
  solo copia tablas; resultados editables solo de una tabla con PK; en
  conexiones de solo lectura los `CALL` quedan bloqueados.
