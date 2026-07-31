#!/usr/bin/env sh
# SPDX-License-Identifier: GPL-3.0-or-later
#
# Installs the open-lux build in this folder for the current user only -- no
# root, nothing outside $HOME.
#
#   ./install-linux.sh              install (or upgrade in place)
#   ./install-linux.sh --uninstall  remove it again
#
# Run it from inside the extracted release folder.

set -eu

PREFIX="${HOME}/.local"
APPDIR="${PREFIX}/opt/openlux"
BIN="${PREFIX}/bin/openlux"
DESKTOP="${PREFIX}/share/applications/openlux.desktop"
ICON="${PREFIX}/share/icons/hicolor/256x256/apps/openlux.png"
AUTOSTART="${HOME}/.config/autostart/openlux.desktop"

here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

uninstall() {
    rm -rf "$APPDIR"
    rm -f "$BIN" "$DESKTOP" "$ICON" "$AUTOSTART"
    echo "Removed open-lux. Your settings in ~/.config/open-lux were left alone."
    echo "Delete them too with:  rm -r ~/.config/open-lux"
}

if [ "${1:-}" = "--uninstall" ]; then
    uninstall
    exit 0
fi

if [ ! -x "${here}/openlux" ]; then
    echo "error: no 'openlux' executable next to this script." >&2
    echo "Run it from inside the extracted release folder." >&2
    exit 1
fi

echo "Installing to ${APPDIR}"
rm -rf "$APPDIR"
mkdir -p "$APPDIR" "${PREFIX}/bin" "$(dirname "$DESKTOP")" "$(dirname "$ICON")"
cp -a "${here}/." "$APPDIR/"

ln -sf "${APPDIR}/openlux" "$BIN"
cp "${APPDIR}/_internal/openlux/icon.png" "$ICON" 2>/dev/null || true
sed "s|^Exec=.*|Exec=${APPDIR}/openlux|" "${here}/openlux.desktop" > "$DESKTOP" \
    2>/dev/null || cp "${here}/openlux.desktop" "$DESKTOP"

command -v update-desktop-database >/dev/null 2>&1 &&
    update-desktop-database "${PREFIX}/share/applications" || true

printf 'Start open-lux automatically when you log in? [y/N] '
read -r reply
case "$reply" in
    [yY]*) mkdir -p "$(dirname "$AUTOSTART")"; cp "$DESKTOP" "$AUTOSTART";
           echo "Autostart enabled." ;;
    *)     echo "Skipped autostart." ;;
esac

echo
echo "Installed. Launch it from your applications menu, or run: openlux"
case ":${PATH}:" in
    *":${PREFIX}/bin:"*) ;;
    *) echo "Note: ${PREFIX}/bin is not on your PATH, so the 'openlux' command"
       echo "      will not work until you add it." ;;
esac
echo
echo "Your monitors need DDC/CI over i2c. If open-lux finds no displays, add"
echo "yourself to the i2c group and reboot:  sudo usermod -aG i2c \"\$USER\""
