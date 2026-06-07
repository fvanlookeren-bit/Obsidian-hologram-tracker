#!/bin/bash
# Doble clic para lanzar Topologías de Pensamiento.
cd "$(dirname "$0")" || exit 1

echo "▸ Actualizando grafo desde el vault Obsidian…"
node scan-vault.mjs || echo "  (no pude re-escanear; uso graph.json existente)"

PORT=8123
# si el puerto está ocupado, sube hasta encontrar uno libre
while lsof -nP -iTCP:$PORT -sTCP:LISTEN >/dev/null 2>&1; do
  PORT=$((PORT + 1))
done

echo "▸ Sirviendo en http://localhost:$PORT  (Ctrl+C para detener)"
python3 serve.py "$PORT" >/dev/null 2>&1 &
SRV=$!
sleep 1
open "http://localhost:$PORT"
trap 'kill $SRV 2>/dev/null' EXIT
wait $SRV
