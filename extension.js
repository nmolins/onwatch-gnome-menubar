import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Clutter from 'gi://Clutter';
import St from 'gi://St';
import GObject from 'gi://GObject';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';

const ONWATCH_URL = 'http://localhost:9211';
const API_URL = `${ONWATCH_URL}/api/current`;
const POLL_SECONDS = 60;

const OnWatchIndicator = GObject.registerClass(
class OnWatchIndicator extends PanelMenu.Button {
    _init(extensionPath) {
        super._init(0.0, 'OnWatch');

        this._extensionPath = extensionPath;
        this._credentials = this._loadCredentials();

        // Panel icon + label
        const box = new St.BoxLayout({ style_class: 'panel-status-menu-box' });

        this._icon = new St.Icon({
            icon_name: 'utilities-system-monitor-symbolic',
            style_class: 'system-status-icon',
        });
        box.add_child(this._icon);

        this._panelLabel = new St.Label({
            text: '…',
            y_align: Clutter.ActorAlign.CENTER,
            style: 'font-size: 11px; margin-left: 4px;',
        });
        box.add_child(this._panelLabel);

        this.add_child(box);

        // Popup content
        this._buildPopup();

        // Start polling
        this._refresh();
        this._timerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, POLL_SECONDS, () => {
            this._refresh();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _loadCredentials() {
        try {
            const envPath = GLib.get_home_dir() + '/.onwatch/.env';
            const [ok, contents] = GLib.file_get_contents(envPath);
            if (!ok) return null;

            const text = new TextDecoder().decode(contents);
            let user = '', pass = '';
            for (const line of text.split('\n')) {
                const trimmed = line.trim();
                if (trimmed.startsWith('ONWATCH_ADMIN_USER='))
                    user = trimmed.split('=', 2)[1];
                if (trimmed.startsWith('ONWATCH_ADMIN_PASS='))
                    pass = trimmed.split('=', 2)[1];
            }
            if (user && pass) return { user, pass };
        } catch (e) {
            log(`[OnWatch] Failed to load credentials: ${e.message}`);
        }
        return null;
    }

    _buildPopup() {
        const popupBox = new St.BoxLayout({
            vertical: true,
            style_class: 'onwatch-popup',
        });

        this._titleLabel = new St.Label({
            text: 'OnWatch — Claude Usage',
            style_class: 'onwatch-title',
        });
        popupBox.add_child(this._titleLabel);

        this._quotaContainer = new St.BoxLayout({ vertical: true });
        popupBox.add_child(this._quotaContainer);

        this._footerLabel = new St.Label({
            text: '',
            style_class: 'onwatch-footer',
        });
        popupBox.add_child(this._footerLabel);

        // Open dashboard button
        const openItem = new PopupMenu.PopupMenuItem('Ouvrir le dashboard');
        openItem.connect('activate', () => {
            Gio.AppInfo.launch_default_for_uri(ONWATCH_URL, null);
        });

        const menuItem = new PopupMenu.PopupBaseMenuItem({ reactive: false });
        menuItem.add_child(popupBox);
        this.menu.addMenuItem(menuItem);
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this.menu.addMenuItem(openItem);
    }

    _refresh() {
        this._fetchData()
            .then(data => this._updateUI(data))
            .catch(e => this._showError(e.message));
    }

    async _fetchData() {
        const message = Gio.File.new_for_uri(API_URL);

        return new Promise((resolve, reject) => {
            const session = new Gio.SocketClient();

            // Use Soup-less approach: raw HTTP via Gio subprocess curl
            const argv = ['curl', '-s', '-u',
                `${this._credentials?.user ?? ''}:${this._credentials?.pass ?? ''}`,
                API_URL];

            try {
                const proc = Gio.Subprocess.new(
                    argv,
                    Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE
                );

                proc.communicate_utf8_async(null, null, (proc, res) => {
                    try {
                        const [ok, stdout, stderr] = proc.communicate_utf8_finish(res);
                        if (!ok || !stdout) {
                            reject(new Error('No response from onWatch'));
                            return;
                        }
                        const data = JSON.parse(stdout);
                        if (data.error) {
                            reject(new Error(data.error));
                            return;
                        }
                        resolve(data);
                    } catch (e) {
                        reject(e);
                    }
                });
            } catch (e) {
                reject(e);
            }
        });
    }

    _updateUI(data) {
        // Remove old quota rows
        this._quotaContainer.destroy_all_children();

        if (!data.quotas || data.quotas.length === 0) {
            this._panelLabel.set_text('--');
            return;
        }

        // Find the most relevant quota for the panel label (5-hour first, then weekly)
        const fiveHour = data.quotas.find(q => q.name === 'five_hour');
        const weekly = data.quotas.find(q => q.name === 'seven_day');
        const primary = fiveHour ?? weekly ?? data.quotas[0];

        const util = Math.round(primary.utilization);
        this._panelLabel.set_text(`${util}%`);

        // Color the icon based on status
        if (primary.status === 'critical')
            this._icon.style = 'color: #f44336;';
        else if (primary.status === 'elevated')
            this._icon.style = 'color: #ff9800;';
        else
            this._icon.style = '';

        // Build quota rows
        for (const quota of data.quotas) {
            const row = this._buildQuotaRow(quota);
            this._quotaContainer.add_child(row);
        }

        // Footer
        const ago = data.capturedAt
            ? this._timeAgo(new Date(data.capturedAt))
            : '';
        this._footerLabel.set_text(ago ? `Mis à jour ${ago}` : '');
    }

    _buildQuotaRow(quota) {
        const row = new St.BoxLayout({
            vertical: true,
            style_class: 'onwatch-quota-row',
        });

        const util = Math.round(quota.utilization);
        const projected = Math.round(quota.projectedUtil ?? 0);

        // Label line: name + percentage
        const labelBox = new St.BoxLayout();
        labelBox.add_child(new St.Label({
            text: quota.displayName,
            style_class: 'onwatch-quota-label',
            x_expand: true,
        }));
        labelBox.add_child(new St.Label({
            text: `${util}%`,
            style_class: 'onwatch-quota-label',
            style: `color: ${this._statusColor(quota.status)};`,
        }));
        row.add_child(labelBox);

        // Progress bar
        const barBg = new St.BoxLayout({ style_class: 'onwatch-bar-bg', x_expand: true });
        const fillWidth = Math.min(util, 100);
        const barFill = new St.Widget({
            style_class: `onwatch-bar-fill onwatch-bar-${quota.status ?? 'healthy'}`,
            style: `width: ${fillWidth}%;`,
            x_expand: false,
        });
        // Use a constraint-based approach for percentage width
        barBg.add_child(barFill);

        // We need to set width after allocation
        barBg.connect('notify::width', () => {
            const parentWidth = barBg.get_width();
            if (parentWidth > 0)
                barFill.set_width(Math.round(parentWidth * fillWidth / 100));
        });

        row.add_child(barBg);

        // Sub-label: reset time + projected
        const parts = [];
        if (quota.timeUntilReset) parts.push(`Reset: ${quota.timeUntilReset}`);
        if (projected > 0) parts.push(`Proj: ${projected}%`);
        if (parts.length > 0) {
            row.add_child(new St.Label({
                text: parts.join(' · '),
                style_class: 'onwatch-quota-sublabel',
            }));
        }

        return row;
    }

    _statusColor(status) {
        if (status === 'critical') return '#f44336';
        if (status === 'elevated') return '#ff9800';
        return '#4caf50';
    }

    _timeAgo(date) {
        const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
        if (seconds < 60) return 'à l\'instant';
        const minutes = Math.floor(seconds / 60);
        if (minutes < 60) return `il y a ${minutes}min`;
        const hours = Math.floor(minutes / 60);
        return `il y a ${hours}h`;
    }

    _showError(msg) {
        this._panelLabel.set_text('ERR');
        this._icon.style = 'color: #f44336;';
        this._quotaContainer.destroy_all_children();
        this._quotaContainer.add_child(new St.Label({
            text: `Erreur: ${msg}`,
            style_class: 'onwatch-error',
        }));
    }

    destroy() {
        if (this._timerId) {
            GLib.source_remove(this._timerId);
            this._timerId = null;
        }
        super.destroy();
    }
});

export default class OnWatchExtension extends Extension {
    enable() {
        this._indicator = new OnWatchIndicator(this.path);
        Main.panel.addToStatusArea('onwatch', this._indicator);
    }

    disable() {
        this._indicator?.destroy();
        this._indicator = null;
    }
}
