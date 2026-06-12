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
const HISTORY_URL = `${ONWATCH_URL}/api/history`;
const POLL_SECONDS = 60;

// How many trailing history points to render in the sparkline.
const SPARKLINE_POINTS = 48;

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

        // Peak Hours banner (hidden unless we're currently in a peak window).
        this._peakBanner = new St.Label({
            text: '',
            style_class: 'onwatch-peak-banner',
        });
        this._peakBanner.hide();
        popupBox.add_child(this._peakBanner);

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
        // Fetch current usage and history in parallel; history is best-effort.
        Promise.all([
            this._fetchJson(API_URL),
            this._fetchJson(HISTORY_URL).catch(() => null),
        ])
            .then(([data, history]) => this._updateUI(data, history))
            .catch(e => this._showError(e.message));
    }

    // Fetch and parse JSON from an onWatch endpoint via curl (GJS has no Soup
    // bundled reliably across shell versions, so we shell out).
    async _fetchJson(url) {
        return new Promise((resolve, reject) => {
            const argv = ['curl', '-s', '--max-time', '10', '-u',
                `${this._credentials?.user ?? ''}:${this._credentials?.pass ?? ''}`,
                url];

            try {
                const proc = Gio.Subprocess.new(
                    argv,
                    Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE
                );

                proc.communicate_utf8_async(null, null, (proc, res) => {
                    try {
                        const [ok, stdout] = proc.communicate_utf8_finish(res);
                        // curl returns a non-zero exit (and empty stdout) when
                        // onWatch is down or unreachable.
                        if (!proc.get_successful() || !ok || !stdout) {
                            reject(new Error('onWatch injoignable'));
                            return;
                        }
                        const data = JSON.parse(stdout);
                        if (data && data.error) {
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

    _updateUI(data, history) {
        // Remove old quota rows
        this._quotaContainer.destroy_all_children();

        if (!data || !data.quotas || data.quotas.length === 0) {
            this._panelLabel.set_text('--');
            return;
        }

        // Find the most relevant quota for the panel label (5-hour first, then weekly)
        const fiveHour = data.quotas.find(q => q.name === 'five_hour');
        const weekly = data.quotas.find(q => q.name === 'seven_day');
        const primary = fiveHour ?? weekly ?? data.quotas[0];

        const util = Math.round(primary.utilization);
        this._panelLabel.set_text(`${util}%`);

        // Color the icon (and the panel %) with the same gradient as the bars,
        // so the panel reflects the real utilization continuously rather than
        // only switching at the three coarse status thresholds.
        const panelColor = this._gradientColor(util);
        this._icon.style = `color: ${panelColor};`;
        this._panelLabel.style = `font-size: 11px; margin-left: 4px; color: ${panelColor};`;

        // Peak Hours banner
        this._updatePeakBanner(data.promo);

        // Build quota rows
        for (const quota of data.quotas) {
            const row = this._buildQuotaRow(quota);
            this._quotaContainer.add_child(row);
        }

        // History sparkline (5-hour and weekly trends over time).
        const spark = this._buildSparkline(history);
        if (spark) this._quotaContainer.add_child(spark);

        // Footer
        const ago = data.capturedAt
            ? this._timeAgo(new Date(data.capturedAt))
            : '';
        this._footerLabel.set_text(ago ? `Mis à jour ${ago}` : '');
    }

    // Build a small sparkline showing the recent trend of the 5-hour and
    // weekly quotas, drawn on a Cairo surface from /api/history data points.
    // The Y axis auto-scales to the data range (with margin) so small values
    // are not crushed against the bottom, and shows min/max gridlines.
    _buildSparkline(history) {
        if (!Array.isArray(history) || history.length < 2) return null;

        const points = history.slice(-SPARKLINE_POINTS);
        const series = [
            { key: 'five_hour', label: '5h', color: [0.30, 0.69, 0.31] }, // green
            { key: 'seven_day', label: '7j', color: [0.13, 0.59, 0.95] }, // blue
        ];

        // Compute the value range across both series for auto-scaling.
        let dataMin = Infinity, dataMax = -Infinity, hasData = false;
        for (const p of points) {
            for (const s of series) {
                const v = p[s.key];
                if (v == null) continue;
                hasData = true;
                if (v < dataMin) dataMin = v;
                if (v > dataMax) dataMax = v;
            }
        }
        if (!hasData) return null;

        // Add 10% headroom, clamp to [0,100], and enforce a minimum span so a
        // flat line still shows a sensible scale instead of dividing by ~0.
        let lo = Math.max(0, Math.floor(dataMin - (dataMax - dataMin) * 0.1 - 1));
        let hi = Math.min(100, Math.ceil(dataMax + (dataMax - dataMin) * 0.1 + 1));
        if (hi - lo < 5) { hi = Math.min(100, lo + 5); }
        const span = hi - lo;

        const container = new St.BoxLayout({
            vertical: true,
            style_class: 'onwatch-spark-row',
        });

        // Title + legend
        const header = new St.BoxLayout();
        header.add_child(new St.Label({
            text: 'Historique',
            style_class: 'onwatch-quota-label',
            x_expand: true,
        }));
        header.add_child(new St.Label({
            text: '5h',
            style: 'color: rgb(76,175,80); font-size: 10px; margin-right: 8px;',
        }));
        header.add_child(new St.Label({
            text: '7j',
            style: 'color: rgb(33,150,243); font-size: 10px;',
        }));
        container.add_child(header);

        const HEIGHT = 56;
        const PAD_L = 28;   // left gutter for Y-axis labels
        const PAD_TB = 4;   // top/bottom padding inside the plot
        const area = new St.DrawingArea({
            style_class: 'onwatch-spark-area',
            x_expand: true,
        });
        area.height = HEIGHT;

        area.connect('repaint', (a) => {
            const [w, h] = a.get_surface_size();
            const cr = a.get_context();
            const n = points.length;
            const plotW = w - PAD_L;
            const plotH = h - PAD_TB * 2;

            // Map a value (%) to a Y pixel within the plot area.
            const yOf = (v) => PAD_TB + (1 - (v - lo) / span) * plotH;
            const xOf = (i) => PAD_L + (n > 1 ? (i / (n - 1)) * plotW : 0);

            // Gridlines + Y labels at hi (top) and lo (bottom).
            cr.setLineWidth(1);
            for (const gv of [hi, lo]) {
                const gy = yOf(gv);
                cr.setSourceRGBA(1, 1, 1, 0.10);
                cr.moveTo(PAD_L, gy);
                cr.lineTo(w, gy);
                cr.stroke();
            }

            for (const s of series) {
                // Build the path once.
                const path = [];
                for (let i = 0; i < n; i++) {
                    const v = points[i][s.key];
                    if (v == null) continue;
                    path.push([xOf(i), yOf(Math.max(0, Math.min(100, v)))]);
                }
                if (path.length < 1) continue;

                // Filled area under the curve (subtle).
                cr.setSourceRGBA(s.color[0], s.color[1], s.color[2], 0.12);
                cr.moveTo(path[0][0], h - PAD_TB);
                for (const [x, y] of path) cr.lineTo(x, y);
                cr.lineTo(path[path.length - 1][0], h - PAD_TB);
                cr.closePath();
                cr.fill();

                // Stroke the line.
                cr.setLineWidth(1.5);
                cr.setSourceRGBA(s.color[0], s.color[1], s.color[2], 1.0);
                cr.moveTo(path[0][0], path[0][1]);
                for (const [x, y] of path) cr.lineTo(x, y);
                cr.stroke();
            }
            cr.$dispose();
        });

        // Y-axis min/max labels overlaid on the left gutter.
        const axisOverlay = new St.Widget({
            layout_manager: new Clutter.BinLayout(),
            x_expand: true,
        });
        axisOverlay.add_child(area);
        const maxLbl = new St.Label({
            text: `${hi}%`,
            style: 'font-size: 9px; color: #888;',
        });
        maxLbl.set_position(0, 2);
        const minLbl = new St.Label({
            text: `${lo}%`,
            style: 'font-size: 9px; color: #888;',
        });
        minLbl.set_position(0, HEIGHT - 14);
        axisOverlay.add_child(maxLbl);
        axisOverlay.add_child(minLbl);
        container.add_child(axisOverlay);

        // Time-range label (oldest point → now).
        const oldest = points[0]?.capturedAt;
        if (oldest) {
            const range = this._timeAgo(new Date(oldest)).replace(/^il y a /, '−');
            container.add_child(new St.Label({
                text: `${range} → maintenant`,
                style: 'font-size: 9px; color: #888; margin-top: 2px;',
            }));
        }

        return container;
    }

    _buildQuotaRow(quota) {
        const row = new St.BoxLayout({
            vertical: true,
            style_class: 'onwatch-quota-row',
        });

        const util = Math.round(quota.utilization);
        const projected = Math.round(quota.projectedUtil ?? 0);
        const isExtra = quota.name === 'extra_usage';

        // Label line: name + value (percentage, or USD for Extra Usage)
        const labelBox = new St.BoxLayout();
        labelBox.add_child(new St.Label({
            text: quota.displayName,
            style_class: 'onwatch-quota-label',
            x_expand: true,
        }));
        const valueText = isExtra
            ? this._formatExtraUsage(quota)
            : `${util}%`;
        labelBox.add_child(new St.Label({
            text: valueText,
            style_class: 'onwatch-quota-label',
            style: `color: ${this._gradientColor(util)}; font-weight: bold;`,
        }));
        row.add_child(labelBox);

        // Progress bar.
        //
        // The fill width is driven by a Clutter.BindConstraint that binds the
        // fill's width to the background's width, scaled by a coefficient. This
        // avoids the circular-allocation bug of the previous implementation
        // (where set_width on the fill resized its auto-sizing parent, which in
        // turn re-fired notify::width, collapsing the fill to 0 above ~50%).
        const barBg = new St.BoxLayout({ style_class: 'onwatch-bar-bg', x_expand: true });
        const fillFactor = Math.min(util, 100) / 100;
        const barFill = new St.Widget({
            style_class: 'onwatch-bar-fill',
            style: `background-color: ${this._gradientColor(util)};`,
            x_expand: false,
        });
        const widthConstraint = new Clutter.BindConstraint({
            source: barBg,
            coordinate: Clutter.BindCoordinate.WIDTH,
            // offset = -(1 - factor) * sourceWidth, applied each allocation pass.
            // We recompute the offset whenever the background width changes.
        });
        barFill.add_constraint(widthConstraint);
        const applyOffset = () => {
            const w = barBg.get_width();
            if (w > 0)
                widthConstraint.set_offset(-Math.round(w * (1 - fillFactor)));
        };
        barBg.connect('notify::width', applyOffset);
        applyOffset();

        barBg.add_child(barFill);
        row.add_child(barBg);

        // Sub-label: reset time + projection + consumption rate / ETA
        const parts = [];
        if (quota.timeUntilReset) parts.push(`Reset ${quota.timeUntilReset}`);
        if (!isExtra && projected > 0) parts.push(`Proj ${projected}%`);

        // Consumption rate (% per hour) and projected exhaustion ETA.
        const rate = quota.currentRate ?? 0;
        if (!isExtra && rate > 0.01) {
            parts.push(`${rate.toFixed(1)}%/h`);
            const eta = this._exhaustionEta(util, rate, quota.timeUntilResetSeconds);
            if (eta) parts.push(`épuisé ${eta}`);
        }

        if (parts.length > 0) {
            row.add_child(new St.Label({
                text: parts.join('  ·  '),
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

    // Continuous green→yellow→red gradient based on utilization (0–100).
    // 0–50% interpolates green→yellow, 50–100% interpolates yellow→red.
    _gradientColor(util) {
        const t = Math.max(0, Math.min(100, util)) / 100;
        let r, g;
        if (t < 0.5) {
            // green (76,175,80) → amber (255,193,7)
            const k = t / 0.5;
            r = Math.round(76 + (255 - 76) * k);
            g = Math.round(175 + (193 - 175) * k);
        } else {
            // amber (255,193,7) → red (244,67,54)
            const k = (t - 0.5) / 0.5;
            r = Math.round(255 + (244 - 255) * k);
            g = Math.round(193 + (67 - 193) * k);
        }
        const b = t < 0.5 ? Math.round(80 + (7 - 80) * (t / 0.5)) : Math.round(7 + (54 - 7) * ((t - 0.5) / 0.5));
        return `rgb(${r},${g},${b})`;
    }

    // Format the Extra Usage quota. onWatch only exposes a utilization
    // percentage for this quota (no USD amount), so we display the percentage.
    _formatExtraUsage(quota) {
        return `${Math.round(quota.utilization)}%`;
    }

    // Estimate when the quota will hit 100%, given current rate (%/h) and the
    // remaining seconds until reset. Returns a short human string or null if the
    // quota resets before exhaustion (or is already full / not progressing).
    _exhaustionEta(util, ratePerHour, secondsUntilReset) {
        if (ratePerHour <= 0 || util >= 100) return null;
        const hoursToFull = (100 - util) / ratePerHour;
        // If it resets before it would fill up, no exhaustion to report.
        if (secondsUntilReset && hoursToFull * 3600 > secondsUntilReset)
            return null;
        if (hoursToFull < 1) {
            const mins = Math.max(1, Math.round(hoursToFull * 60));
            return `dans ${mins}min`;
        }
        if (hoursToFull < 24)
            return `dans ${Math.round(hoursToFull)}h`;
        return `dans ${Math.round(hoursToFull / 24)}j`;
    }

    // Show/hide the Peak Hours banner depending on whether we're currently in
    // the promo's peak window. Peak hours are expressed in US Eastern time.
    _updatePeakBanner(promo) {
        if (!promo || promo.peakStartHourET == null || promo.peakEndHourET == null) {
            this._peakBanner.hide();
            return;
        }

        if (this._isInPeakWindow(promo)) {
            this._peakBanner.set_text(`⚡ ${promo.title ?? 'Peak Hours'} — la limite 5h se consomme plus vite`);
            this._peakBanner.show();
        } else {
            this._peakBanner.hide();
        }
    }

    // Determine if "now" falls within the peak window. ET is UTC-5 (EST) or
    // UTC-4 (EDT); we approximate US DST (2nd Sun of March → 1st Sun of Nov)
    // to convert the current UTC hour to Eastern.
    _isInPeakWindow(promo) {
        const now = new Date();
        const offset = this._easternUtcOffset(now); // hours to add to UTC
        const etHour = ((now.getUTCHours() + offset) % 24 + 24) % 24;

        // Day-of-week in ET (may shift across midnight after offset).
        let etDay = now.getUTCDay();
        if (now.getUTCHours() + offset < 0) etDay = (etDay + 6) % 7;
        else if (now.getUTCHours() + offset >= 24) etDay = (etDay + 1) % 7;

        if (promo.peakWeekdaysOnly && (etDay === 0 || etDay === 6))
            return false;

        return etHour >= promo.peakStartHourET && etHour < promo.peakEndHourET;
    }

    // Returns the ET offset from UTC in hours (-4 during DST, -5 otherwise).
    _easternUtcOffset(date) {
        const year = date.getUTCFullYear();
        // 2nd Sunday of March, 02:00 local → use 07:00 UTC as DST start.
        const dstStart = this._nthSundayUTC(year, 2, 2) + 7 * 3600 * 1000;
        // 1st Sunday of November, 02:00 local → 06:00 UTC as DST end.
        const dstEnd = this._nthSundayUTC(year, 10, 1) + 6 * 3600 * 1000;
        const t = date.getTime();
        return (t >= dstStart && t < dstEnd) ? -4 : -5;
    }

    // Epoch ms (UTC midnight) of the nth Sunday of a given month (0-indexed).
    _nthSundayUTC(year, month, n) {
        const first = new Date(Date.UTC(year, month, 1));
        const firstDow = first.getUTCDay();
        const day = 1 + ((7 - firstDow) % 7) + (n - 1) * 7;
        return Date.UTC(year, month, day);
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
