#!/bin/bash
set -e

EXT_UUID="onwatch@onllm.dev"
EXT_DIR="$HOME/.local/share/gnome-shell/extensions/$EXT_UUID"
SRC_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "Installing OnWatch GNOME extension..."

mkdir -p "$EXT_DIR"
cp "$SRC_DIR/metadata.json" "$EXT_DIR/"
cp "$SRC_DIR/extension.js" "$EXT_DIR/"
cp "$SRC_DIR/stylesheet.css" "$EXT_DIR/"

echo "Extension installed to $EXT_DIR"
echo ""
echo "To activate:"
echo "  1. Restart GNOME Shell: press Alt+F2, type 'r', press Enter"
echo "     (or log out and log back in on Wayland)"
echo "  2. Enable the extension:"
echo "     gnome-extensions enable $EXT_UUID"
echo ""
echo "Or enable directly (may need shell restart first):"
echo "  gnome-extensions enable $EXT_UUID"
