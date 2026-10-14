#!/usr/bin/env bash
# Arranca el backend (API) y el frontend (Vite) de DBStudio.
# Detecta puertos libres para no cruzarse con otros servicios y mantiene el
# proxy del frontend apuntando al puerto real de la API.
#
#   bash run.sh            # puertos por defecto 4000 (API) y 5180 (UI)
#   API_PORT=4100 bash run.sh
#
# Ctrl+C detiene ambos.
set -u

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER_DIR="$DIR/server"
CLIENT_DIR="$DIR/client"

# --- Detección de puertos -------------------------------------------------
# Devuelve 0 (éxito) si el puerto está OCUPADO.
port_busy() {
  if command -v netstat >/dev/null 2>&1; then
    netstat -ano 2>/dev/null | grep -E "[:.]$1[[:space:]]" | grep -qi "LISTEN"
  else
    # Fallback: intenta abrir el puerto con bash /dev/tcp
    (exec 3<>"/dev/tcp/127.0.0.1/$1") >/dev/null 2>&1 && { exec 3>&- 3<&-; return 0; } || return 1
  fi
}

# Primer puerto libre a partir de $1 (evitando los de $2... ya elegidos).
find_free_port() {
  local p="$1"; shift
  local taken=" $* "
  while port_busy "$p" || [[ "$taken" == *" $p "* ]]; do
    p=$((p + 1))
  done
  echo "$p"
}

API_PORT="$(find_free_port "${API_PORT:-4000}")"
CLIENT_PORT="$(find_free_port "${CLIENT_PORT:-5180}" "$API_PORT")"

# --- Dependencias ---------------------------------------------------------
if [[ ! -d "$SERVER_DIR/node_modules" ]]; then
  echo "Instalando dependencias del backend…"
  (cd "$SERVER_DIR" && npm install)
fi
if [[ ! -d "$CLIENT_DIR/node_modules" ]]; then
  echo "Instalando dependencias del frontend…"
  (cd "$CLIENT_DIR" && npm install)
fi

# --- Arranque -------------------------------------------------------------
PIDS=()
cleanup() {
  echo ""
  echo "Deteniendo DBStudio…"
  for pid in "${PIDS[@]}"; do
    kill "$pid" >/dev/null 2>&1
  done
  # Respaldo: libera los puertos por si quedaron procesos hijos (Vite en Windows)
  for port in "$API_PORT" "$CLIENT_PORT"; do
    local victim
    victim="$(netstat -ano 2>/dev/null | grep -E "[:.]$port[[:space:]]" | grep -i LISTEN | awk '{print $NF}' | head -1)"
    [[ -z "${victim:-}" ]] && continue
    # Con `node --watch` el puerto lo tiene un hijo; cierra también al vigilante.
    local parent
    parent="$(powershell -NoProfile -Command "\$p = Get-CimInstance Win32_Process -Filter 'ProcessId=$victim'; \$q = Get-CimInstance Win32_Process -Filter \"ProcessId=\$(\$p.ParentProcessId)\"; if (\$q.CommandLine -like '*--watch*') { \$q.ProcessId }" 2>/dev/null | tr -d '\r')"
    [[ -n "${parent:-}" ]] && taskkill //F //T //PID "$parent" >/dev/null 2>&1
    taskkill //F //PID "$victim" >/dev/null 2>&1
  done
  exit 0
}
trap cleanup INT TERM

echo "▶ API      → http://localhost:$API_PORT"
echo "▶ DBStudio → http://localhost:$CLIENT_PORT"
echo ""

# Backend (PID directo). --watch lo reinicia solo cuando cambia el código del servidor.
( cd "$SERVER_DIR" && PORT="$API_PORT" node --watch index.js ) &
PIDS+=("$!")

# Frontend: ejecuta el binario de Vite directamente para tener un PID limpio
# y pásale los puertos por entorno (los lee vite.config.js).
( cd "$CLIENT_DIR" && API_PORT="$API_PORT" CLIENT_PORT="$CLIENT_PORT" node ./node_modules/vite/bin/vite.js ) &
PIDS+=("$!")

# Abre el navegador (best-effort, sin fallar si no se puede).
sleep 3
if command -v cmd.exe >/dev/null 2>&1; then
  cmd.exe /c start "" "http://localhost:$CLIENT_PORT" >/dev/null 2>&1 || true
elif command -v xdg-open >/dev/null 2>&1; then
  xdg-open "http://localhost:$CLIENT_PORT" >/dev/null 2>&1 || true
elif command -v open >/dev/null 2>&1; then
  open "http://localhost:$CLIENT_PORT" >/dev/null 2>&1 || true
fi

echo "DBStudio en marcha. Pulsa Ctrl+C para detener."
wait
