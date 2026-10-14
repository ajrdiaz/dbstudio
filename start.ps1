# Arranca el backend (API, puerto 4000) y el frontend (Vite, puerto 5180)
# en ventanas separadas. Ejecuta:  powershell -ExecutionPolicy Bypass -File start.ps1
$root = $PSScriptRoot

Write-Host "Instalando dependencias (si hace falta)..."
if (-not (Test-Path "$root\server\node_modules")) { Push-Location "$root\server"; npm install; Pop-Location }
if (-not (Test-Path "$root\client\node_modules")) { Push-Location "$root\client"; npm install; Pop-Location }

Write-Host "Arrancando API en http://localhost:4000 ..."
Start-Process powershell -ArgumentList "-NoExit","-Command","cd '$root\server'; npm start"

Write-Host "Arrancando UI en http://localhost:5180 ..."
Start-Process powershell -ArgumentList "-NoExit","-Command","cd '$root\client'; npm run dev"

Start-Sleep -Seconds 3
Start-Process "http://localhost:5180"
