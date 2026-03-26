# OnWatch GNOME Extension

GNOME Shell extension to monitor Claude Code usage from the top bar, powered by [onWatch](https://github.com/onllm-dev/onwatch).

![GNOME Shell 45+](https://img.shields.io/badge/GNOME_Shell-45%2B-blue)

## Features

- Displays current quota utilization in the top bar (e.g. `12%`)
- Icon color changes based on status: green (healthy), orange (elevated), red (critical)
- Click to expand a popup with all quotas: 5-Hour, Weekly All-Model, Weekly Sonnet, Extra Usage
- Each quota shows a progress bar, reset countdown, and projected utilization
- "Open dashboard" button to launch the full onWatch web UI
- Polls the onWatch API every 60 seconds
- Reads credentials automatically from `~/.onwatch/.env`

## Prerequisites

- GNOME Shell 45+
- [onWatch](https://github.com/onllm-dev/onwatch) running on `localhost:9211`

## Install

```bash
git clone https://github.com/nmolins/onwatch-gnome-menubar.git
cd onwatch-gnome-menubar
bash install.sh
```

Then log out and log back in (Wayland), and enable the extension:

```bash
gnome-extensions enable onwatch@onllm.dev
```

## Uninstall

```bash
gnome-extensions disable onwatch@onllm.dev
rm -rf ~/.local/share/gnome-shell/extensions/onwatch@onllm.dev
```
