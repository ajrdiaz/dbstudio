# DBStudio

Un cliente web para **MySQL / MariaDB**, al estilo de SQLyog. Construido desde
cero (no es ingeniería inversa de ningún producto): **Express + mysql2** en el
backend y **React + Vite + Monaco** en el frontend.

## Funciones

- **Administrador de conexiones** — crea, edita, prueba y guarda conexiones.
  Las contraseñas se guardan cifradas (AES-256-GCM) en la carpeta de datos.
  **Túnel SSH** opcional (contraseña o llave privada con frase), como en SQLyog.
- **Entornos por conexión** (como Navicat) — Desarrollo, Pruebas, Pre-producción o
  Producción (o color propio): se ve en el árbol, en las pestañas y como franja en cada
  pestaña. Opciones: *pedir confirmación antes de modificar* (activa por defecto en
  producción: avisa antes de ejecutar UPDATE/DELETE/DDL, guardar la grilla, importar,
  sincronizar, copiar, matar procesos…) y *solo lectura* (bloquea cambios también en
  el servidor).
- **Panel lateral contraíble y redimensionable** — `«` o `Ctrl+B` lo reduce a una franja
  con íconos (Conexiones / Guardadas / Historial); arrastra el borde para cambiar el ancho
  (doble clic lo restablece). Estado, ancho y vista se recuerdan en el navegador.
- **Transacciones en el editor** — cada pestaña SQL tiene su propia conexión al servidor:
  Auto-commit on/off, **Commit / Rollback**, aviso de "Transacción abierta" (y al cerrar la
  pestaña o la página), **■ Cancelar** la consulta en curso (KILL QUERY) y **límite de filas**
  por SELECT (100 … 50.000 o sin límite). Las ediciones de la grilla entran en la transacción.
- **Buscar objetos** (`Ctrl+P` o ⌕) — tablas, vistas, columnas, procedimientos, funciones,
  disparadores y eventos de todas las bases de una conexión, opcionalmente dentro del código;
  abre datos, estructura o el código (DDL listo para re-ejecutar). Doble clic en
  procedimientos/funciones/disparadores del árbol abre su código.
- **Pestaña de base de datos** (▤ en el árbol) — estadísticas por tabla (filas, datos, índices,
  espacio libre/fragmentación) con **Analizar / Optimizar / Revisar / Reparar**, y
  **Diagrama ER** interactivo (zoom, mover tablas, resaltar relaciones, solo claves,
  exportar PNG/SVG).
- **Importar CSV / Excel** (⤒ en el árbol o en los datos de una tabla) — a tabla nueva o
  existente, mapeo de columnas, tipos sugeridos, separador y codificación (UTF-8 / Latin-1),
  coma decimal, fechas dd/mm/aaaa, duplicados (ignorar/actualizar/reemplazar), progreso.
- **Grupos de conexiones** — carpetas en el árbol (campo "Grupo" o arrastrar y soltar),
  plegables y recordadas.
- **Servidor → Dashboard** en vivo (conexiones, consultas/s por tipo, tráfico, filas InnoDB,
  aciertos del buffer pool) y **Consultas pesadas** (performance_schema o slow log: tiempo
  total/promedio, filas examinadas, sin índice). Las actualizaciones automáticas se pausan
  si la pestaña no está visible o tras un error.
- **Árbol de objetos** — bases de datos → Tablas, Vistas, Procedimientos,
  Funciones y Triggers, con conteos y carga perezosa.
- **Editor SQL** (Monaco) — `Ctrl+Enter`/`F9` ejecuta la sentencia del cursor (o la
  selección), `Ctrl+Shift+Enter`/`F5` ejecuta todo (con soporte de `DELIMITER`).
  Cada resultado va en su propia pestaña (**Resultado 1, 2…**) más **Mensajes**
  con el detalle de cada sentencia. **Formatear SQL** (`Ctrl+Shift+F`, `F12` la
  sentencia actual) y **EXPLAIN visual** con sugerencias (recorridos completos,
  filesort, tablas temporales…). Divisor arrastrable editor/resultados.
- **Grilla editable estilo Excel** — en los datos de tabla **y en los resultados de
  un query** (si el SELECT es de una sola tabla e incluye su clave primaria):
  flechas/Tab/Enter, `F2` editar, escribir reemplaza, `Esc` cancela, `Supr` = NULL,
  `Ctrl+Supr` borrar fila, `Insert` nueva fila, `Ctrl+D` duplicar, `Ctrl+Z` deshacer,
  `Ctrl+C`/`Ctrl+V` compatibles con Excel (pegar crea filas), `F4` editor de textos
  largos/JSON, menú de clic derecho, **vista de formulario**, columnas
  redimensionables (doble clic = autoajuste), listas para columnas `ENUM`,
  **vista previa del SQL** antes de guardar y renderizado virtual (100.000+ filas).
- **Administración del servidor** (`⛭ Servidor`) — procesos (cancelar consulta /
  matar conexión, auto-actualizar), estado con métricas por segundo, variables
  (`SET GLOBAL` con doble clic) y **usuarios y permisos** (crear, contraseña,
  GRANT/REVOKE, eliminar; siempre muestra el SQL antes de ejecutar).
  **Replicación**: rol (réplica / primario), atraso respecto al primario con historial,
  estado de los hilos IO/SQL, posiciones leído/aplicado y últimos errores; en el
  primario, binlog actual y réplicas conectadas. Solo monitorea (funciona en conexiones
  de solo lectura); el usuario necesita `REPLICATION CLIENT` (MySQL) o
  `SLAVE MONITOR`/`REPLICA MONITOR` (MariaDB).
- **Comparar / Copiar** (`⇄`) — compara el esquema de dos BDs (tablas, columnas,
  índices, FKs, vistas, procedimientos, funciones, disparadores) y genera el script
  de sincronización (abrir en editor o ejecutar en destino); copia tablas
  (estructura y/o datos) a otra BD o conexión con progreso y cancelación.
- **Estructura de tabla** — columnas, índices, claves foráneas y el `CREATE TABLE`.
- **Exportar / Importar** — dump `.sql` (estructura y/o datos) de tablas
  seleccionadas, e importación de un archivo `.sql`.
- **Sesión persistente** — las pestañas abiertas (editores SQL con su texto y BD,
  pestañas de datos/estructura) se auto-guardan y se restauran al recargar o
  reabrir. Persistencia local en el servidor (`~/.dbstudio/`), sin login.
- **Consultas guardadas** (favoritos) — guarda SQL con nombre (`💾` / `Ctrl+S`),
  reábrelas desde el panel **Saved**, renómbralas o bórralas.
- **Historial de consultas** — cada ejecución (éxito o error) se registra
  automáticamente con hora, resumen y duración; reábrelas desde el panel **History**.
- **Selector de BD** desplegable por pestaña, poblado desde la conexión.
- **Diseñador visual de tablas** — crea tablas nuevas o altera existentes desde una
  grilla de columnas (nombre, tipo, longitud, unsigned, null, default, PK,
  auto_increment, comentario); genera `CREATE`/`ALTER TABLE` con vista previa del SQL.
- **Autocompletado** en el editor SQL — sugiere tablas y columnas de la BD actual
  (leídas de `information_schema`) además de palabras clave.
- **Tema claro / oscuro** — conmutador en la barra, recordado en el navegador.
- **Idioma español / inglés** — selector en la barra; **español por defecto**,
  elección recordada en el navegador (`client/src/i18n.jsx`).

## Requisitos

- Node.js (probado con v24).
- Un servidor MySQL o MariaDB accesible.

## Arranque

### Opción 1 — `run.sh` (recomendada, Git Bash)

Arranca backend + frontend, **detecta puertos libres** (por si 4000/5180 están
ocupados) y mantiene el proxy sincronizado. Abre el navegador solo. `Ctrl+C` detiene ambos.

```sh
bash run.sh
# o con puertos de partida distintos:
API_PORT=4100 CLIENT_PORT=5200 bash run.sh
```

### Opción 2 — `start.ps1` (PowerShell)

```powershell
powershell -ExecutionPolicy Bypass -File start.ps1
```

### Opción 3 — manual, en dos terminales

```sh
# Terminal 1 — API en http://localhost:4000
cd server
npm install
npm start

# Terminal 2 — UI en http://localhost:5180
cd client
npm install
npm run dev
```

Abre <http://localhost:5180>, pulsa **＋ New connection**, prueba la conexión y
guárdala. Expándela en el árbol y haz doble clic en una tabla para ver sus datos,
o abre un editor SQL con el botón ⌨.

## Dónde se guardan los datos (y sincronizar con OneDrive / Google Drive)

Por defecto todo vive en `~/.dbstudio/` (en Windows `C:\Users\<usuario>\.dbstudio\`):
`connections.json`, `queries.json`, `history.json`, `workspace.json` y la clave `.key`.

Con el botón **⚙ Almacenamiento** de la barra superior puedes mover los datos a otra
carpeta. Detecta OneDrive y Google Drive (`X:\Mi unidad`) automáticamente, o puedes
escribir cualquier ruta (Dropbox, carpeta de red…).

- Al cambiar se copian tus datos a la nueva carpeta; los de la anterior quedan como respaldo.
- **Otra PC:** elige la misma carpeta y la opción *Usar los datos de esa carpeta*.
- **Clave de cifrado:** si marcas *Guardar también la clave en la carpeta*, las otras PCs
  podrán usar las contraseñas guardadas (a cambio, quien acceda a tu nube podría descifrarlas).
  Si no, la clave queda solo en `~/.dbstudio/.key` de esta PC.
- `~/.dbstudio/config.json` guarda la ruta elegida. La variable de entorno
  `DBSTUDIO_DATA_DIR` tiene prioridad sobre ella.
- Evita usar la app en dos PCs a la vez con la misma carpeta: la nube se queda con el último cambio.

## Arquitectura

```
dbstudio/
  server/            API Express
    index.js         rutas HTTP
    pools.js         pools mysql2 por conexión
    store.js         persistencia + cifrado de conexiones
    workspace.js     consultas guardadas, historial y sesión (tabs)
    ddl.js           generación de CREATE/ALTER TABLE (diseñador)
    sql.js           quoting seguro + introspección (information_schema)
  client/            app React (Vite)
    src/
      api.js         cliente HTTP
      App.jsx        layout, pestañas, toasts
      components/    Sidebar, QueryTab, DataTab, StructureTab,
                     TableDesigner, SavedQueries, History, modales
      lib/           completion.js (autocomplete), download.js
```

## Seguridad / notas

- Herramienta pensada para uso **local**. El backend no tiene autenticación: no
  lo expongas a una red pública sin añadir una capa de auth y HTTPS.
- Los valores de las celdas y filtros se escapan antes de construir el SQL, pero
  el editor SQL ejecuta lo que escribas: trátalo como una consola con todos los
  permisos del usuario de la conexión.
