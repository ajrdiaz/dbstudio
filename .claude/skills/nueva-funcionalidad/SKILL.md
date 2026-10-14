---
name: nueva-funcionalidad
description: Checklist para agregar o cambiar una funcionalidad de DBStudio y dejarla funcionando igual en la versión web (run.sh) y en la app de escritorio (Electron), con la prueba y la publicación del instalador. Usar SIEMPRE que se agregue o modifique una funcionalidad visible, un endpoint del server o algo de la app de escritorio.
---

# Nueva funcionalidad en DBStudio (web + escritorio)

DBStudio tiene **un solo código** para las dos versiones:

| | Web | Escritorio |
|---|---|---|
| Server | `server/` con `run.sh` (`node --watch`) | el mismo `server/`, dentro de Electron (`desktop/main.mjs` → `start()`) |
| Interfaz | `client/` con Vite (HMR) | `client/` compilado en `desktop/stage/web` |
| Se actualiza | solo, al guardar | **solo al publicar un instalador nuevo** (`npm run release`) |

Nunca dupliques lógica por plataforma. Lo propio del escritorio va en
`desktop/main.mjs`; en la interfaz se detecta con `isDesktop()` (`client/src/lib/alerts.js`).

Lee primero `AGENTS.md` (reglas de seguridad, `guardWrite`, i18n, CSS, cómo probar sin riesgo).

## 1. Implementar
- [ ] API en `server/` (las rutas que escriben quedan bajo el middleware de solo lectura; las de lectura usan GET o `preview: true`).
- [ ] UI en `client/src/`; textos en `i18n.jsx` en **es y en**.
- [ ] Acciones que modifican datos pasan por `guardWrite` (producción / solo lectura).

## 2. Lo que rompe el escritorio (evitar)
- `window.prompt()` no existe en Electron → usar `askText()` de `lib/dialogs.jsx`.
- Recursos de internet (CDN, fuentes, scripts externos) → empaquetarlos; el escritorio debe funcionar sin internet.
- `new Notification()` en la interfaz → usar `browserNotify()` (`lib/alerts.js`); en escritorio notifica `main.mjs` vía `monitorEvents`.
- Rutas relativas / `process.cwd()` en el server → en escritorio el cwd es la carpeta de instalación; usar `paths.js` o `import.meta.url`.
- Dependencias nuevas del server → van en `server/package.json` (el build las copia a `stage/package.json`). Si es nativa (tiene `binding.gyp`), avisar: requiere reconstruirla para Electron.
- Puertos nuevos → el escritorio solo expone el de `start()`.
- Archivos estáticos nuevos → dentro de `client/` (Vite los incluye) o servidos por el API.
- Si la funcionalidad necesita algo nativo (bandeja, notificación, diálogo del sistema, iniciar con Windows) → implementarlo en `desktop/main.mjs` y exponer lo mínimo por `desktop/preload.cjs`.

## 3. Verificar
```bash
cd desktop && npm run check     # compatibilidad web/escritorio + i18n (debe dar 0 errores)
```
- [ ] Web: instancia aislada (ver AGENTS.md → "Cómo probar sin riesgo"), probar el flujo en el navegador, tema claro y oscuro. **Siempre cargar la app** si se tocó `App.jsx` (esbuild no detecta errores de ejecución).
- [ ] Escritorio, si la funcionalidad toca algo del punto 2 o de `desktop/`: `npm run start` con `DBSTUDIO_DATA_DIR=<scratch>` y `--hidden --remote-debugging-port=9333` (conectar por CDP). No cambiar `USERPROFILE`.

## 4. Guardar y publicar
1. `git add -A && git commit` — mensaje en español con la línea de atribución.
2. `cd desktop && npm run release` (o `npm run release -- minor` para funcionalidades grandes). Hace:
   check → repo limpio → sube versión → instalador → **prueba del app empaquetado** → acceso directo `Instalador DBStudio.lnk` → commit `Escritorio vX.Y.Z`.
   Si la prueba falla, la versión no se sube: corregir y repetir.
3. `git push` solo si el usuario lo pidió.
4. Actualizar `README.md` (lista de funciones) y `AGENTS.md` si cambió la arquitectura.

## 5. Avisar al usuario
- Web: recargar con F5 (el server ya recargó).
- Escritorio: el app instalado detecta la versión nueva en ~15 s al abrir (o cada 30 min) y ofrece instalarla; también **bandeja → Buscar actualizaciones**. Sus datos se conservan.
