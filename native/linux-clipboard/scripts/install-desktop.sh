#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
BIN_DIR="${XDG_BIN_HOME:-${HOME}/.local/bin}"
APPS_DIR="${XDG_DATA_HOME:-${HOME}/.local/share}/applications"

mkdir -p "${BIN_DIR}" "${APPS_DIR}"
chmod +x "${APP_ROOT}/aih-lumen"
ln -sf "${APP_ROOT}/aih-lumen" "${BIN_DIR}/aih-lumen"

sed "s|^Exec=aih-lumen|Exec=${BIN_DIR}/aih-lumen|g" \
  "${APP_ROOT}/packaging/io.meadeo.AIHome.Lumen.desktop" \
  > "${APPS_DIR}/io.meadeo.AIHome.Lumen.desktop"

if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database "${APPS_DIR}" >/dev/null 2>&1 || true
fi

echo "Installed aih-lumen -> ${BIN_DIR}/aih-lumen"
echo "Installed desktop entry -> ${APPS_DIR}/io.meadeo.AIHome.Lumen.desktop"
