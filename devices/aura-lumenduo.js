/*!
 * aura-lumenduo.js — Lumen Duo (Lumen S Eye) smart-glasses display for Aura pages.
 *
 * Uses the app's Bluetooth LE bridge (window.Aura.bluetooth). Main frame only.
 *
 *   const duo = await AuraLumenDuo.connect();
 *   await duo.text('Q♥', { color: '#fff', background: '#000' });
 *   await duo.image(canvasOrImgOrFile);           // 160 × 80, one bit per pixel
 *   duo.on('click', ({ button }) => …);            // 'left' | 'right'
 *   duo.on('doubleclick', ({ button }) => …);
 *   duo.on('longpress', ({ button }) => …);        // the SDK only knows the right one
 *   duo.on('battery', ({ volts, charging }) => …);
 *   await duo.vibrate(0.5);
 *   await duo.clear();
 *
 * Protocol: read from the LumenDuoFramework binary (no source exists; see docs/LUMENDUO.md):
 *   - names "Lumen-ZY-Duo" or "Lumen_S_Eye"; commands written WITHOUT response to 6E40FF02-…,
 *     text notifications on 6E40FF03-… (the service UUID is not in the SDK: found at connection);
 *   - the display is 160 × 80 px (160 × 60 for "Lumen_ZY_EyeV2"), one bit per pixel, two colours per page;
 *     text is drawn by the phone and sent as a picture, as the SDK does.
 */
(function (global) {
  'use strict';

  const SERVICE = '6E40FF01-B5A3-F393-E0A9-E50E24DCCA9E';   // guess: the SDK discovers every service
  const WRITE = '6E40FF02-B5A3-F393-E0A9-E50E24DCCA9E';     // write without response: commands
  const NOTIFY = '6E40FF03-B5A3-F393-E0A9-E50E24DCCA9E';    // notify: text (buttons, battery, firmware)
  const NAMES = ['Lumen-ZY-Duo', 'Lumen_S_Eye'];            // the SDK's scan filter
  const NAME_HINTS = ['LUMEN'];
  const SMALL_NAME = 'Lumen_ZY_EyeV2';                      // the SDK uses 60 rows for this one

  const WIDTH = 160;
  const ROWS_PER_CHUNK = 10;
  const BYTES_PER_ROW = WIDTH / 8;                          // 20
  const CHUNK = ROWS_PER_CHUNK * BYTES_PER_ROW;             // 200 bytes of pixels per packet
  const CHUNK_GAP = 10;                                     // ms between two packets, as the SDK
  const COLOR_GAP = 40;                                     // ms after the colours, as the SDK

  const OP = { CHUNK: 0xAE, SHOW: 0xE0, COLORS: 0xF2, BRIGHTNESS: 0xBB, VIBRATE: 0xE3, STATUS_BAR: 0xFB, FIRMWARE: 0xFF };
  const CLEAR = [[0x5A, 0xA5, 0x00], [0xAA]];               // two writes: "clear all pages to black"

  const BUTTONS = {                                          // "<press>K<button>"
    '0K0': ['left', 'single'], '0K1': ['right', 'single'],
    '1K0': ['left', 'double'], '1K1': ['right', 'double'],
    '2K0': ['left', 'long'], '2K1': ['right', 'long'],      // 2K0 is not in the SDK: kept in case the firmware sends it
  };
  const PRESS_EVENTS = { single: 'click', double: 'doubleclick', long: 'longpress' };
  const FIRMWARE_PREFIXES = ['ZY_S_EYE-V', 'ZY_DUO096-V', 'ZY-DUO096-V'];

  const MESSAGES = {
    fr: {
      noAura: "window.Aura indisponible : ouvrez cette page dans Aura, en HTTPS, sur un domaine présent dans vos favoris.",
      notTrusted: "Aura refuse le Bluetooth à cette page : ajoutez son domaine à vos favoris Aura, puis rechargez-la.",
      bluetooth: (s) => `Bluetooth indisponible (${s}).`,
      unauthorized: "Accès Bluetooth refusé : autorisez-le dans Réglages › Aura › Bluetooth.",
      poweredOff: 'Le Bluetooth est éteint : allumez-le et réessayez.',
      noAnswer: "Bluetooth sans réponse : acceptez la demande d'accès au Bluetooth, puis réessayez.",
      notFound: 'Aucune Lumen Duo trouvée à proximité. Allumez-la et réessayez.',
      notDuo: "Cet appareil n'a pas la caractéristique Lumen Duo (6E40FF02).",
      cancelled: 'Connexion annulée.',
      disconnected: 'Lumen Duo déconnectée.',
      notConnected: 'Lumen Duo non connectée.',
      noFirmware: "La Lumen Duo n'a pas donné sa version.",
      badImage: "Image illisible : donnez un canvas, une image, une ImageBitmap, un fichier ou une URL.",
    },
    en: {
      noAura: 'window.Aura is unavailable: open this page in Aura, over HTTPS, on a domain in your bookmarks.',
      notTrusted: 'Aura refuses Bluetooth to this page: add its domain to your Aura bookmarks, then reload it.',
      bluetooth: (s) => `Bluetooth is unavailable (${s}).`,
      unauthorized: 'Bluetooth access was denied: allow it in Settings › Aura › Bluetooth.',
      poweredOff: 'Bluetooth is turned off: turn it on and try again.',
      noAnswer: 'Bluetooth does not answer: accept the Bluetooth access request, then try again.',
      notFound: 'No Lumen Duo found nearby. Turn it on and try again.',
      notDuo: 'This device has no Lumen Duo characteristic (6E40FF02).',
      cancelled: 'Connection cancelled.',
      disconnected: 'Lumen Duo disconnected.',
      notConnected: 'Lumen Duo is not connected.',
      noFirmware: 'The Lumen Duo did not give its version.',
      badImage: 'Unreadable picture: give a canvas, an image, an ImageBitmap, a file or a URL.',
    },
  };
  const defaultLang = () =>
    ((global.navigator && navigator.language) || 'fr').toLowerCase().startsWith('fr') ? 'fr' : 'en';

  const sameUUID = (a, b) => String(a || '').toUpperCase() === String(b || '').toUpperCase();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const byte = (n) => clamp(Math.round(Number(n) || 0), 0, 255);

  // ------------------------------------------------------------------ Protocol (pure, no Bluetooth)

  /** '#rgb', '#rrggbb', 'rgb(…)', [r, g, b] or a 16-bit number → RGB565. */
  function rgb565(color) {
    if (typeof color === 'number') return color & 0xFFFF;
    let r = 0, g = 0, b = 0;
    if (Array.isArray(color)) [r, g, b] = color;
    else {
      const s = String(color || '').trim();
      let m = /^#?([0-9a-f]{3})$/i.exec(s);
      if (m) [r, g, b] = m[1].split('').map((h) => parseInt(h + h, 16));
      else if ((m = /^#?([0-9a-f]{6})$/i.exec(s))) [r, g, b] = [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16));
      else if ((m = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/i.exec(s))) [r, g, b] = [m[1], m[2], m[3]].map(Number);
      else if (typeof document !== 'undefined') {         // named colours: let the browser parse them
        const g2 = document.createElement('canvas').getContext('2d');
        g2.fillStyle = '#000'; g2.fillStyle = s;
        return rgb565(g2.fillStyle);
      }
    }
    return ((byte(r) >> 3) << 11) | ((byte(g) >> 2) << 5) | (byte(b) >> 3);
  }

  /** Grey levels (one byte per pixel, WIDTH × height) → bitmap: 1 = lit, leftmost pixel in bit 0. */
  function packBitmap(grey, height, threshold = 128) {
    const out = new Uint8Array(BYTES_PER_ROW * height);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < WIDTH; x++) {
        if (grey[y * WIDTH + x] >= threshold) out[y * BYTES_PER_ROW + (x >> 3)] |= 1 << (x & 7);
      }
    }
    return out;
  }

  /** Bitmap → the packets that draw it on `page`: 0xAE page 0 row + 200 bytes, 10 rows each. */
  function bitmapPackets(bitmap, page = 0) {
    const packets = [];
    for (let i = 0; i * CHUNK < bitmap.length; i++) {
      const p = new Uint8Array(4 + CHUNK);
      p.set([OP.CHUNK, byte(page), 0, i * ROWS_PER_CHUNK]);
      p.set(bitmap.subarray(i * CHUNK, (i + 1) * CHUNK), 4);
      packets.push(p);
    }
    return packets;
  }

  /**
   * One notification (text) → { type: 'button', button, press, code } | { type: 'firmware', version, raw }
   * | { type: 'status', charging, full, state, p, volts, raw } | { type: 'message', text }, as the SDK reads it.
   */
  function parseMessage(text) {
    const t = String(text).replace(/\0+/g, '').trim().replace(/:/g, '0');
    if (BUTTONS[t]) return { type: 'button', button: BUTTONS[t][0], press: BUTTONS[t][1], code: t };
    if (FIRMWARE_PREFIXES.some((p) => t.startsWith(p))) {
      let version = t;
      FIRMWARE_PREFIXES.forEach((p) => { version = version.split(p).join(''); });
      return { type: 'firmware', version, raw: t };
    }
    if (!t.includes('REFRESH') && t.length === 11 && t.includes('P') && t !== 'UPGRADE-img') {
      const state = t[0];
      const volts = t[6] === 'V' ? parseFloat(t[7] + '.' + t.slice(8, 10)) : NaN;
      const p = t[4] === 'P' ? parseInt(t[5], 10) : NaN;
      return {
        type: 'status', raw: t, state,
        charging: state === '1', full: state === '2',
        p: Number.isFinite(p) ? p : null,                  // read but unused by the SDK: meaning unknown
        volts: Number.isFinite(volts) ? volts : null,
      };
    }
    return { type: 'message', text: t };
  }

  /** Rough charge estimate from the voltage (single Li-ion cell, 3.5 V → 0 %, 4.15 V → 100 %). Not the SDK's formula. */
  function percentFromVolts(volts) {
    if (volts == null) return null;
    return Math.round(clamp((volts - 3.5) / 0.65, 0, 1) * 100);
  }

  // ------------------------------------------------------------------ Driver

  class AuraLumenDuo {
    /** True when the page runs in Aura with the bridge active (HTTPS + bookmarked domain). */
    static isAvailable() {
      return !!(global.Aura && global.Aura.bluetooth);
    }

    /**
     * Finds the first Lumen Duo nearby (or takes the one with this id) and connects to it.
     * @param {{ id?: string, name?: string, nameHints?: string[], timeout?: number, autoReconnect?: boolean,
     *   hideStatusBar?: boolean, brightness?: number, vibrationStrength?: number, leftHanded?: boolean,
     *   mirror?: boolean, height?: number, lang?: 'fr'|'en' }} options
     */
    static async connect(options = {}) {
      const duo = new AuraLumenDuo(options);
      await duo.connect();
      return duo;
    }

    constructor(options = {}) {
      this.options = Object.assign({
        timeout: 20, autoReconnect: true, nameHints: NAME_HINTS, hideStatusBar: true,
        vibrationStrength: 0.5, leftHanded: false, mirror: false,
      }, options);
      this._t = MESSAGES[this.options.lang] || MESSAGES[defaultLang()];
      this.id = this.options.id || null;
      this.name = '';
      this.service = SERVICE;
      this.connected = false;
      this.firmware = '';
      this.battery = { volts: null, percent: null, charging: false, full: false };
      this.leftHanded = !!this.options.leftHanded;     // rotate pictures 180°
      this.mirror = !!this.options.mirror;             // flip pictures horizontally
      this.vibrationStrength = clamp(Number(this.options.vibrationStrength) || 0, 0, 1);
      this.level = this.options.brightness == null ? null : clamp(Math.round(this.options.brightness), 0, 100);
      this._listeners = {};
      this._queue = Promise.resolve();
      this._session = 0;
      this._link = false;
      this._manual = false;
      this._connecting = null;
      this._reconnecting = false;
      this._cancelFind = null;
      this._firmwareWaiters = [];
      this._decoder = new TextDecoder();
      this._unsubscribers = [];
    }

    /** Display size in pixels. */
    get width() { return WIDTH; }
    get height() {
      if (this.options.height) return this.options.height === 60 ? 60 : 80;
      return this.name === SMALL_NAME ? 60 : 80;
    }

    // MARK: Connection

    connect() {
      this._manual = false;
      if (this.connected) return Promise.resolve(this);
      if (!this._connecting) this._connecting = this._open().finally(() => { this._connecting = null; });
      return this._connecting;
    }

    async _open() {
      if (!AuraLumenDuo.isAvailable()) throw new Error(this._t.noAura);
      const bt = global.Aura.bluetooth;
      const checkCancelled = () => { if (this._manual) throw new Error(this._t.cancelled); };
      await this._ready();
      checkCancelled();
      if (!this.id) {
        this._emit('status', { state: 'scanning' });
        const device = await this._find();
        this.id = device.id;
        this.name = device.name || 'Lumen Duo';
      }
      checkCancelled();
      this._emit('status', { state: 'connecting', name: this.name, id: this.id });
      try {
        const info = await bt.connect(this.id, { timeout: this.options.timeout });
        checkCancelled();
        if (info && info.name) this.name = info.name;
        const service = this._pickService((info && info.services) || []);
        if (service === false) {
          const id = this.id;
          this.id = null;
          try { await bt.disconnect(id); } catch (_) {}
          throw new Error(this._t.notDuo);
        }
        this.service = service;
        this._listen();
        this._session++;
        this._queue = Promise.resolve();
        this._link = true;
        await this._enqueue(() => bt.startNotifications(this.id, this.service, NOTIFY));
        await this._setup();
        checkCancelled();
      } catch (e) {
        const linked = this._link;
        this._dropped();
        if (linked && this.id) { try { await bt.disconnect(this.id); } catch (_) {} }
        throw this._bridgeError(e);
      }
      this.connected = true;
      this._emit('status', { state: 'connected', name: this.name, id: this.id });
      this._emit('connect', { name: this.name, id: this.id, firmware: this.firmware });
      return this;
    }

    /**
     * The service holding 6E40FF02, or 6E40FF01 when the bridge lists no characteristics.
     * false when the device clearly is not a Lumen Duo.
     */
    _pickService(services) {
      if (!services.length) return SERVICE;
      const withWrite = services.find((s) => (s.characteristics || []).some((c) => sameUUID(c.uuid, WRITE)));
      if (withWrite) return withWrite.uuid;
      const listed = services.some((s) => (s.characteristics || []).length);
      if (listed) return false;
      const guess = services.find((s) => /^6E40FF/i.test(s.uuid || ''));
      return guess ? guess.uuid : SERVICE;
    }

    /** What the SDK does once connected (without its "DUO" splash): status bar, brightness, firmware. */
    async _setup() {
      if (this.options.hideStatusBar) await this.toggleStatusBar();
      if (this.level != null) await this.brightness(this.level);
      this.requestFirmware().catch(() => {});        // the answer comes as a notification, maybe never
    }

    async disconnect() {
      this._manual = true;
      if (this._cancelFind) this._cancelFind();
      const active = this._link;
      this._dropped();
      if (active && this.id) { try { await global.Aura.bluetooth.disconnect(this.id); } catch (_) {} }
      this._emit('status', { state: 'disconnected' });
    }

    /** Waits for Bluetooth to be usable (the first call makes iOS ask for the Bluetooth permission). */
    async _ready() {
      const bt = global.Aura.bluetooth;
      let state;
      try { state = await bt.state(); } catch (e) { throw this._bridgeError(e); }
      if (state === 'unknown' || state === 'resetting') {
        this._emit('status', { state: 'permission' });
        state = await new Promise((resolve) => {
          const off = global.Aura.on('bluetooth.state', (d) => {
            if (d && d.state !== 'unknown' && d.state !== 'resetting') { clearInterval(poll); off(); resolve(d.state); }
          });
          const t0 = Date.now();
          const poll = setInterval(async () => {
            let s = 'unknown';
            try { s = await bt.state(); } catch (_) {}
            if ((s !== 'unknown' && s !== 'resetting') || Date.now() - t0 > AuraLumenDuo.PERMISSION_TIMEOUT * 1000) {
              clearInterval(poll); off(); resolve(s);
            }
          }, 500);
        });
      }
      if (state === 'poweredOn') return;
      if (state === 'unauthorized') throw new Error(this._t.unauthorized);
      if (state === 'poweredOff') throw new Error(this._t.poweredOff);
      if (state === 'unknown' || state === 'resetting') throw new Error(this._t.noAnswer);
      throw new Error(this._t.bluetooth(state));
    }

    _bridgeError(e) {
      const msg = String((e && e.message) || e);
      if (/not allowed to use native features|only the page opened by the App Clip/i.test(msg)) return new Error(this._t.notTrusted);
      if (/permission was denied/i.test(msg)) return new Error(this._t.unauthorized);
      if (/turned off/i.test(msg)) return new Error(this._t.poweredOff);
      return e instanceof Error ? e : new Error(msg);
    }

    /** Scan without a service filter (the SDK scans by name): exact name, or one of the hints. */
    _find() {
      const bt = global.Aura.bluetooth;
      const matches = (name) => {
        const n = String(name || '').toUpperCase();
        if (!n) return false;
        if (this.options.name) return n === String(this.options.name).toUpperCase();
        return NAMES.some((x) => n === x.toUpperCase()) || this.options.nameHints.some((h) => n.includes(String(h).toUpperCase()));
      };
      return new Promise((resolve, reject) => {
        let done = false;
        const finish = (fn, value) => {
          if (done) return;
          done = true;
          this._cancelFind = null;
          clearTimeout(timer);
          off();
          Promise.resolve(bt.stopScan()).catch(() => {}).then(() => fn(value));
        };
        const off = global.Aura.on('bluetooth.discovered', (d) => {
          this._emit('discovered', d);
          if (matches(d.name)) finish(resolve, d);
        });
        const timer = setTimeout(() => finish(reject, new Error(this._t.notFound)), this.options.timeout * 1000);
        this._cancelFind = () => finish(reject, new Error(this._t.cancelled));
        Promise.resolve(bt.scan({ services: [] })).catch((e) => finish(reject, this._bridgeError(e)));
      });
    }

    _listen() {
      this._unsubscribers.forEach((off) => off());
      const lost = () => {
        const was = this.connected;
        this._dropped();
        if (!was) return;            // during setup, connect() reports the error itself
        this._emit('status', { state: 'disconnected' });
        if (this.options.autoReconnect && !this._manual) this._reconnect();
      };
      this._unsubscribers = [
        global.Aura.on('bluetooth.notification', (d) => {
          if (!this._link || d.id !== this.id || !sameUUID(d.characteristic, NOTIFY)) return;
          this._receive(d.value);
        }),
        global.Aura.on('bluetooth.disconnected', (d) => { if (d.id === this.id && this._link) lost(); }),
        global.Aura.on('bluetooth.state', (d) => { if (d && d.state !== 'poweredOn' && this._link) lost(); }),
      ];
    }

    _dropped() {
      const was = this.connected;
      this.connected = false;
      this._link = false;
      this._session++;
      this._firmwareWaiters.splice(0).forEach((w) => w.reject(new Error(this._t.disconnected)));
      if (was) this._emit('disconnect', { manual: this._manual });
    }

    /** Like the SDK: keep trying until the glasses come back, or disconnect() is called. */
    async _reconnect() {
      if (this._reconnecting) return;
      this._reconnecting = true;
      let attempt = 0;
      while (!this._manual && !this.connected) {
        attempt++;
        this._emit('status', { state: 'reconnecting', attempt });
        await sleep(Math.min(1000 * attempt, 4000));
        if (this._manual || this.connected) break;
        try { await this.connect(); } catch (_) {}
      }
      this._reconnecting = false;
    }

    // MARK: Reception

    _receive(view) {
      const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
      const text = this._decoder.decode(bytes);
      this._emit('data', { text, bytes });
      const m = parseMessage(text);
      if (m.type === 'button') {
        const detail = { button: m.button, press: m.press, code: m.code };
        this._emit('button', detail);
        this._emit(PRESS_EVENTS[m.press], detail);
      } else if (m.type === 'firmware') {
        this.firmware = m.version;
        this._firmwareWaiters.splice(0).forEach((w) => w.resolve(m.version));
        this._emit('firmware', { version: m.version, raw: m.raw });
      } else if (m.type === 'status') {
        const was = this.battery.charging;
        this.battery = { volts: m.volts, percent: percentFromVolts(m.volts), charging: m.charging, full: m.full };
        this._emit('battery', Object.assign({ raw: m.raw, p: m.p }, this.battery));
        if (was !== m.charging) this._emit('charging', { charging: m.charging, full: m.full });
      } else {
        this._emit('message', { text: m.text });
      }
    }

    // MARK: Sending

    _enqueue(job) {
      if (!this._link) return Promise.reject(new Error(this._t.notConnected));
      const session = this._session;
      const result = this._queue.then(() => {
        if (session !== this._session) throw new Error(this._t.disconnected);
        return job();
      });
      this._queue = result.catch(() => {});
      return result;
    }

    _write(bytes) {
      return global.Aura.bluetooth.write(this.id, this.service, WRITE, bytes, { withoutResponse: true });
    }

    /** Raw packets: one array of bytes, or an array of them (written in order, `gap` ms apart). */
    send(packets, { gap = 0 } = {}) {
      const list = Array.isArray(packets) && (Array.isArray(packets[0]) || ArrayBuffer.isView(packets[0])) ? packets : [packets];
      return this._enqueue(async () => {
        for (let i = 0; i < list.length; i++) {
          await this._write(Uint8Array.from(list[i]));
          if (gap) await sleep(gap);
        }
      });
    }

    // MARK: Commands

    /** Turns every page black. */
    clear() { return this.send(CLEAR); }

    /** Display brightness, 0 to 100 %. Kept and sent again after a reconnection. */
    brightness(percent) {
      this.level = clamp(Math.round(Number(percent) || 0), 0, 100);
      return this.send([OP.BRIGHTNESS, this.level]);
    }

    /**
     * Vibrates. `amount` 0 to 1 (default: vibrationStrength); the SDK calls it a duration and sends 0 to 255.
     */
    vibrate(amount = this.vibrationStrength) {
      const v = clamp(Number(amount) || 0, 0, 1);
      return this.send([OP.VIBRATE, Math.floor(v * 255)]);
    }

    /** Default for vibrate(), 0 to 1. */
    setVibrationStrength(value) { this.vibrationStrength = clamp(Number(value) || 0, 0, 1); }

    /** Shows or hides the glasses' status bar: it is a toggle, the glasses do not say which state they are in. */
    toggleStatusBar(page = 0) { return this.send([OP.STATUS_BAR, byte(page), 0, 0, 0x5A]); }

    /** Asks for the firmware version; resolves with it ('' when it does not come within `timeout` ms). */
    requestFirmware(timeout = AuraLumenDuo.REPLY_TIMEOUT) {
      return new Promise((resolve, reject) => {
        const waiter = { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } };
        const timer = setTimeout(() => {
          const i = this._firmwareWaiters.indexOf(waiter);
          if (i >= 0) this._firmwareWaiters.splice(i, 1);
          resolve(this.firmware);
        }, timeout);
        this._firmwareWaiters.push(waiter);
        this.send([OP.FIRMWARE]).catch(waiter.reject);
      });
    }

    /** Colours of a page: lit pixels in `color`, the others in `background` (CSS colours or RGB565 numbers). */
    colors({ color = '#fff', background = '#000', page = 0 } = {}) {
      const bg = rgb565(background), fg = rgb565(color);
      return this.send([OP.COLORS, byte(page), bg >> 8, bg & 255, fg >> 8, fg & 255]);
    }

    /** Shows a page (after its pixels were sent). */
    showPage(page = 0) { return this.send([OP.SHOW, byte(page)]); }

    /** Sends a ready bitmap (20 bytes per row, bit 0 = leftmost pixel, 1 = lit), then shows the page. */
    async bitmap(bits, { page = 0, show = true } = {}) {
      await this.send(bitmapPackets(Uint8Array.from(bits), page), { gap: CHUNK_GAP });
      if (show) await this.showPage(page);
    }

    /**
     * Text drawn by the page, then sent as a picture (as the SDK does): the biggest bold font that fits.
     * @param {string} value  '\n' starts a new line
     * @param {{ color?: string, background?: string, page?: number, show?: boolean, font?: string,
     *   maxSize?: number, align?: 'center'|'left'|'right' }} options
     */
    async text(value, options = {}) {
      const { color = '#fff', background = '#000', page = 0, show = true } = options;
      await this.colors({ color, background, page });
      await sleep(COLOR_GAP);
      const canvas = this.renderText(value, options);
      await this.bitmap(this.toBitmap(canvas), { page, show });
      return canvas;
    }

    /**
     * A picture (canvas, img, ImageBitmap, video, Blob/File or URL), fitted into 160 × 80 and turned into
     * one bit per pixel. Bright pixels light up. Resolves with the canvas that was sent (what the glasses show).
     * @param {{ fit?: 'contain'|'cover'|'stretch', threshold?: number, dither?: boolean, invert?: boolean,
     *   color?: string, background?: string, page?: number, show?: boolean }} options
     */
    async image(source, options = {}) {
      const { page = 0, show = true } = options;
      const canvas = await this.renderImage(source, options);
      if (options.color != null || options.background != null) {
        await this.colors({ color: options.color || '#fff', background: options.background || '#000', page });
        await sleep(COLOR_GAP);
      }
      await this.bitmap(this.toBitmap(canvas, options), { page, show });
      return canvas;
    }

    // MARK: Rendering (no Bluetooth: usable for previews)

    _canvas() {
      const c = document.createElement('canvas');
      c.width = WIDTH; c.height = this.height;
      const g = c.getContext('2d');
      g.fillStyle = '#000'; g.fillRect(0, 0, c.width, c.height);
      return c;
    }

    /** The text, white on black, as the glasses will receive it. */
    renderText(value, { font = '-apple-system, system-ui, sans-serif', maxSize = 100, align = 'center' } = {}) {
      const c = this._canvas(), g = c.getContext('2d'), W = c.width, H = c.height, pad = 2;
      const text = String(value == null ? '' : value);
      let lines = [], size = Math.min(maxSize, H);
      for (; size >= 8; size -= 2) {
        g.font = `bold ${size}px ${font}`;
        lines = [];
        text.split('\n').forEach((part) => {
          let line = '';
          part.split(' ').forEach((word) => {
            const next = line ? line + ' ' + word : word;
            if (line && g.measureText(next).width > W - pad * 2) { lines.push(line); line = word; } else line = next;
          });
          lines.push(line);
        });
        if (lines.length * size * 1.1 <= H && lines.every((l) => g.measureText(l).width <= W - pad * 2)) break;
      }
      g.fillStyle = '#fff';
      g.textAlign = align;
      g.textBaseline = 'middle';
      const x = align === 'left' ? pad : align === 'right' ? W - pad : W / 2;
      lines.forEach((l, i) => g.fillText(l, x, H / 2 + (i - (lines.length - 1) / 2) * size * 1.1));
      return c;
    }

    /** The picture fitted into the display, in grey on black. */
    async renderImage(source, { fit = 'contain' } = {}) {
      let img = source;
      if (typeof source === 'string') {
        img = new Image();
        img.crossOrigin = 'anonymous';
        img.src = source;
        await img.decode();
      } else if (typeof Blob !== 'undefined' && source instanceof Blob) {
        img = await createImageBitmap(source);
      }
      const w = img && (img.naturalWidth || img.videoWidth || img.width);
      const h = img && (img.naturalHeight || img.videoHeight || img.height);
      if (!w || !h) throw new Error(this._t.badImage);
      const c = this._canvas(), g = c.getContext('2d');
      let dw = c.width, dh = c.height;
      if (fit !== 'stretch') {
        const s = (fit === 'cover' ? Math.max : Math.min)(c.width / w, c.height / h);
        dw = w * s; dh = h * s;
      }
      g.drawImage(img, (c.width - dw) / 2, (c.height - dh) / 2, dw, dh);
      return c;
    }

    /**
     * Canvas → bitmap, with the left-handed (180°) and mirror settings applied, as the SDK does.
     * Grey ≥ threshold lights a pixel; `dither` spreads the error (Floyd–Steinberg) for photos.
     */
    toBitmap(canvas, { threshold = 128, dither = false, invert = false } = {}) {
      const H = this.height;
      const c = document.createElement('canvas');
      c.width = WIDTH; c.height = H;
      const g = c.getContext('2d');
      g.save();
      if (this.leftHanded) { g.translate(WIDTH, H); g.rotate(Math.PI); }
      if (this.mirror) { g.translate(WIDTH, 0); g.scale(-1, 1); }
      g.drawImage(canvas, 0, 0, WIDTH, H);
      g.restore();
      const px = g.getImageData(0, 0, WIDTH, H).data;
      const grey = new Float32Array(WIDTH * H);
      for (let i = 0; i < grey.length; i++) {
        const v = 0.299 * px[i * 4] + 0.587 * px[i * 4 + 1] + 0.114 * px[i * 4 + 2];
        grey[i] = invert ? 255 - v : v;
      }
      if (dither) {
        for (let y = 0; y < H; y++) {
          for (let x = 0; x < WIDTH; x++) {
            const i = y * WIDTH + x, old = grey[i], v = old >= threshold ? 255 : 0, e = old - v;
            grey[i] = v;
            if (x + 1 < WIDTH) grey[i + 1] += e * 7 / 16;
            if (y + 1 < H) {
              if (x > 0) grey[i + WIDTH - 1] += e * 3 / 16;
              grey[i + WIDTH] += e * 5 / 16;
              if (x + 1 < WIDTH) grey[i + WIDTH + 1] += e / 16;
            }
          }
        }
      }
      return packBitmap(grey, H, threshold);
    }

    // MARK: Events

    /**
     * 'button' ({ button: 'left'|'right', press: 'single'|'double'|'long', code }), 'click', 'doubleclick',
     * 'longpress' (same detail), 'battery' ({ volts, percent, charging, full, raw, p }), 'charging',
     * 'firmware' ({ version, raw }), 'message' ({ text }: any other notification), 'data' ({ text, bytes }: raw),
     * 'discovered', 'status' ({ state: 'permission' | 'scanning' | 'connecting' | 'connected' | 'reconnecting'
     * | 'disconnected' }), 'connect', 'disconnect'. Returns off().
     */
    on(name, callback) {
      (this._listeners[name] = this._listeners[name] || new Set()).add(callback);
      return () => this.off(name, callback);
    }

    off(name, callback) {
      if (this._listeners[name]) this._listeners[name].delete(callback);
    }

    _emit(name, detail) {
      (this._listeners[name] || []).forEach((cb) => {
        try { cb(detail); } catch (e) { console.error(e); }
      });
    }
  }

  AuraLumenDuo.SERVICE = SERVICE;
  AuraLumenDuo.WRITE_CHARACTERISTIC = WRITE;
  AuraLumenDuo.NOTIFY_CHARACTERISTIC = NOTIFY;
  AuraLumenDuo.NAMES = NAMES;
  AuraLumenDuo.WIDTH = WIDTH;
  AuraLumenDuo.OP = OP;
  /** Milliseconds to wait for the firmware version. */
  AuraLumenDuo.REPLY_TIMEOUT = 3000;
  /** Seconds left to the user to answer the iOS Bluetooth permission request. */
  AuraLumenDuo.PERMISSION_TIMEOUT = 60;
  AuraLumenDuo.parseMessage = parseMessage;
  AuraLumenDuo.packBitmap = packBitmap;
  AuraLumenDuo.bitmapPackets = bitmapPackets;
  AuraLumenDuo.rgb565 = rgb565;
  AuraLumenDuo.percentFromVolts = percentFromVolts;
  global.AuraLumenDuo = AuraLumenDuo;
})(window);
