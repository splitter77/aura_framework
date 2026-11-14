/*!
 * aura-nova.js — Nova Pen (Ophaya 60BP, optical smartpen) for Aura pages.
 *
 * Uses the app's Bluetooth LE bridge (window.Aura.bluetooth). Main frame only.
 *
 *   const pen = await AuraNova.connect();
 *   pen.on('point', ({ x, y, force, page }) => …);   // pen units (~23.6 per mm)
 *   pen.on('stroke', (stroke) => …);                  // [{ x, y, force }] once the tip lifts
 *   pen.on('page', ({ page }) => …);                  // a new sheet: strokes are cleared
 *   pen.draw(canvas);                                 // fits the ink in a canvas
 *   const jpeg = pen.toDataURL();                     // white image for handwriting recognition
 *
 * Protocol (measured on hardware, ported from acaat_swift OphayaPen / OphayaPenFrame):
 *   - the pen does not advertise its 128-bit service: unfiltered scan, matched on the NAME;
 *   - no init command, no pairing: subscribing to 69400003 is enough; ~33 Hz;
 *   - frame: FF FE | type (2) | length (2) | payload | CRC16 (2, ignored) | FF FD;
 *   - type 0x0301 payload, big-endian: rawX (2) rawY (2) pageRaw (4) force (2);
 *   - the pen never says "tip up": it is inferred from sentinel frames or 120 ms of silence.
 */
(function (global) {
  'use strict';

  const SERVICE = '69400001-B5A3-F393-E0A9-E50E24DCCA99';
  const NOTIFY = '69400003-B5A3-F393-E0A9-E50E24DCCA99';
  const NAME_HINTS = ['60BP', 'AFPEN', 'OPHAYA', 'SMARTPEN', 'APEN'];
  const UNITS_PER_MM = 600 / 25.4;   // 600 DPI optical sensor

  const MESSAGES = {
    fr: {
      noAura: "window.Aura indisponible : ouvrez cette page dans Aura, en HTTPS, sur un domaine présent dans vos favoris.",
      bluetooth: (s) => `Bluetooth indisponible (${s}).`,
      notFound: 'Aucun stylo Nova trouvé à proximité. Allumez-le et réessayez.',
      notPen: "Cet appareil n'a pas de caractéristique notifiable : ce n'est pas le stylo.",
    },
    en: {
      noAura: 'window.Aura is unavailable: open this page in Aura, over HTTPS, on a domain in your bookmarks.',
      bluetooth: (s) => `Bluetooth is unavailable (${s}).`,
      notFound: 'No Nova pen found nearby. Turn it on and try again.',
      notPen: 'This device has no notifying characteristic: it is not the pen.',
    },
  };
  const defaultLang = () =>
    ((global.navigator && navigator.language) || 'fr').toLowerCase().startsWith('fr') ? 'fr' : 'en';

  const sameUUID = (a, b) => String(a || '').toUpperCase() === String(b || '').toUpperCase();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const now = () => performance.now() / 1000;

  // ------------------------------------------------------------------ Frame decoding (pure, no state)
  const POINT_TYPE = 0x0301;
  const COORD_MASK = 0x3FFF;      // 0x7FFF lets bit 14 through → jumps of 16384 = false breaks
  const PAGE_MASK = 0x1FFFFFF8;
  const FORCE_MASK = 0x03FF;

  /** → { kind: 'point', x, y, page, force } | { kind: 'sentinel' } (tip up) | { kind: 'reject' } | { kind: 'ignore' } */
  function decodeFrame(type, p) {
    if (type !== POINT_TYPE || p.length < 10) return { kind: 'ignore' };
    const rawX = (p[0] << 8) | p[1];
    const rawY = (p[2] << 8) | p[3];
    const pageRaw = ((p[4] << 24) | (p[5] << 16) | (p[6] << 8) | p[7]) >>> 0;
    const force = ((p[8] << 8) | p[9]) & FORCE_MASK;
    const page = (pageRaw & PAGE_MASK) >>> 0;
    // Seen: FFFFFFF8, 3FFFFFF8, 1FFFFFFE.
    if (page >= 0x1FFFFFF0 || ((pageRaw & 0x0FFFFFF8) >>> 0) === 0x0FFFFFF8) return { kind: 'sentinel' };
    // Seen when lifting and right after connecting: off paper (validity bits) or no pressure.
    if ((rawX & 0x8000) === 0 || (rawX & 0x2000) !== 0 || force === 0) return { kind: 'reject' };
    return { kind: 'point', x: rawX & COORD_MASK, y: rawY & COORD_MASK, page, force };
  }

  /** Reassembles frames: one notification may hold 0, 1, 2 frames or half of one. */
  class FrameAssembler {
    constructor() { this.buffer = []; }
    reset() { this.buffer = []; }
    feed(bytes) {
      const b = this.buffer;
      for (let k = 0; k < bytes.length; k++) b.push(bytes[k]);
      const out = [];
      let i = 0, keepFrom = -1;
      while (i + 1 < b.length) {
        if (b[i] !== 0xFF || b[i + 1] !== 0xFE) { i++; continue; }
        if (b.length - i < 6) { keepFrom = i; break; }
        const len = (b[i + 4] << 8) | b[i + 5];
        if (len === 0 || len > FrameAssembler.CAPACITY) { i++; continue; }      // false header
        const total = 6 + len + 2 + 2;
        if (b.length - i < total) { keepFrom = i; break; }                      // incomplete frame
        if (b[i + total - 2] !== 0xFF || b[i + total - 1] !== 0xFD) { i++; continue; }
        out.push(decodeFrame((b[i + 2] << 8) | b[i + 3], b.slice(i + 6, i + 6 + len)));
        i += total;
      }
      if (keepFrom >= 0) this.buffer = b.slice(keepFrom);
      else if (i < b.length) this.buffer = [b[b.length - 1]];   // keeps 1 byte: header split across notifications
      else this.buffer = [];
      if (this.buffer.length > FrameAssembler.CAPACITY) this.buffer = [];
      return out;
    }
  }
  FrameAssembler.CAPACITY = 512;

  /** Debounce: tip up and page changes. → [{ type: 'point', x, y, force, page } | { type: 'up' } | { type: 'page', page }] */
  class StreamProcessor {
    constructor() { this.reset(); }
    reset() {
      this.frames = 0; this.rejects = 0; this.sentinels = 0;
      this._open = false; this._sentinelRun = 0; this._lastPoint = 0;
      this._page = null; this._candidate = 0; this._candidateCount = 0;
    }
    process(r, t) {
      this.frames++;
      switch (r.kind) {
        case 'ignore': return [];
        case 'reject': this.rejects++; return [];
        case 'sentinel':
          this.sentinels++;
          this._sentinelRun++;
          // A real lift gives ≥ 6 sentinels; mid-stroke there are 1-3 isolated ones.
          if (this._open && this._sentinelRun >= StreamProcessor.SENTINELS_FOR_UP) { this._open = false; return [{ type: 'up' }]; }
          return [];
        default: {
          this._sentinelRun = 0;
          const events = [];
          if (this._page === null) {
            this._page = r.page;
            events.push({ type: 'page', page: r.page });
          } else if (r.page !== this._page) {
            // The low bits of the id are noisy: a new id must hold for 5 consecutive frames.
            if (r.page === this._candidate) this._candidateCount++; else { this._candidate = r.page; this._candidateCount = 1; }
            if (this._candidateCount < StreamProcessor.FRAMES_FOR_PAGE) return [];   // isolated frame: dropped
            if (this._open) { this._open = false; events.push({ type: 'up' }); }
            this._page = r.page;
            this._candidateCount = 0;
            events.push({ type: 'page', page: r.page });
          } else {
            this._candidateCount = 0;
          }
          this._open = true;
          this._lastPoint = t;
          events.push({ type: 'point', x: r.x, y: r.y, force: r.force, page: r.page });
          return events;
        }
      }
    }
    /** Call every ~30 ms: closes a stroke left open by silence (the pen does not announce the end). */
    tick(t) {
      if (!this._open || t - this._lastPoint <= StreamProcessor.SILENCE_FOR_UP) return [];
      this._open = false;
      this._sentinelRun = 0;
      return [{ type: 'up' }];
    }
  }
  StreamProcessor.SENTINELS_FOR_UP = 4;
  StreamProcessor.SILENCE_FOR_UP = 0.120;
  StreamProcessor.FRAMES_FOR_PAGE = 5;

  // ------------------------------------------------------------------ Ink helpers
  function bounds(strokes) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const s of strokes) for (const p of s) {
      if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
    }
    return isFinite(minX) ? { x: minX, y: minY, width: maxX - minX, height: maxY - minY } : null;
  }

  /** Draws strokes centred and scaled to fit (w × h) on a 2D context. */
  function paint(ctx, strokes, w, h, o) {
    const box = bounds(strokes);
    if (!box) return;
    const pad = o.padding || 0;
    const scale = Math.min((w - 2 * pad) / Math.max(box.width, 1), (h - 2 * pad) / Math.max(box.height, 1), o.maxScale || Infinity) * (o.fill || 0.9);
    const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
    ctx.save();
    ctx.strokeStyle = o.color; ctx.fillStyle = o.color;
    ctx.lineWidth = o.lineWidth; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    for (const s of strokes) {
      if (!s.length) continue;
      const X = (p) => w / 2 + (p.x - cx) * scale, Y = (p) => h / 2 + (p.y - cy) * scale;
      if (s.length === 1) { ctx.beginPath(); ctx.arc(X(s[0]), Y(s[0]), o.lineWidth / 2, 0, Math.PI * 2); ctx.fill(); continue; }
      ctx.beginPath();
      ctx.moveTo(X(s[0]), Y(s[0]));
      for (let i = 1; i < s.length; i++) ctx.lineTo(X(s[i]), Y(s[i]));
      ctx.stroke();
    }
    ctx.restore();
  }

  // ------------------------------------------------------------------ Driver
  class AuraNova {
    static isAvailable() { return !!(global.Aura && global.Aura.bluetooth); }

    /**
     * Finds the first Nova pen nearby and connects to it.
     * @param {{ timeout?: number, name?: string, nameHints?: string[], autoReconnect?: boolean, lang?: 'fr'|'en' }} options
     */
    static async connect(options = {}) {
      const pen = new AuraNova(options);
      await pen.connect();
      return pen;
    }

    constructor(options = {}) {
      this.options = Object.assign({ timeout: 20, autoReconnect: true, nameHints: NAME_HINTS, clearOnPageChange: true }, options);
      this._t = MESSAGES[this.options.lang] || MESSAGES[defaultLang()];
      this.id = null;
      this.name = '';
      this.connected = false;
      this.page = null;            // current sheet id (number)
      this.strokes = [];           // strokes of the current sheet: [[{ x, y, force }]]
      this.hz = 0;
      this._listeners = {};
      this._assembler = new FrameAssembler();
      this._processor = new StreamProcessor();
      this._open = false;
      this._timer = null;
      this._hzCount = 0;
      this._hzStart = now();
      this._manual = false;
      this._unsubscribers = [];
    }

    get stats() {
      return { frames: this._processor.frames, rejects: this._processor.rejects, sentinels: this._processor.sentinels, hz: this.hz };
    }

    // MARK: Connection

    async connect() {
      if (!AuraNova.isAvailable()) throw new Error(this._t.noAura);
      const bt = global.Aura.bluetooth;
      this._manual = false;
      const state = await bt.state().catch(() => 'unknown');
      if (state !== 'poweredOn' && state !== 'unknown') throw new Error(this._t.bluetooth(state));

      if (!this.id) {
        this._emit('status', { state: 'scanning' });
        const device = await this._find();
        this.id = device.id;
        this.name = device.name || 'Nova';
      }
      this._emit('status', { state: 'connecting', name: this.name });
      const info = await bt.connect(this.id, { timeout: this.options.timeout });
      const target = this._pickCharacteristic((info && info.services) || []);
      if (!target) {
        try { await bt.disconnect(this.id); } catch (_) {}
        this.id = null;
        throw new Error(this._t.notPen);
      }
      this._listen();
      this._assembler.reset();
      this._processor.reset();
      this._open = false;
      await bt.startNotifications(this.id, target.service, target.characteristic);
      this._notify = target;
      this.connected = true;
      this._startTimer();
      this._emit('status', { state: 'connected', name: this.name, id: this.id });
      this._emit('connect', { name: this.name, id: this.id });
      return this;
    }

    async disconnect() {
      this._manual = true;
      if (this.id && this.connected) {
        try { await global.Aura.bluetooth.disconnect(this.id); } catch (_) {}
      }
      this._dropped();
    }

    /** Unfiltered scan (the pen does not advertise its service), matched on the name. */
    _find() {
      const bt = global.Aura.bluetooth;
      const wanted = this.options.name ? [this.options.name] : this.options.nameHints;
      const matches = (name) => {
        const n = String(name || '').toUpperCase();
        if (!n) return false;
        return this.options.name ? n === this.options.name.toUpperCase() : wanted.some((h) => n.includes(String(h).toUpperCase()));
      };
      return new Promise((resolve, reject) => {
        let done = false;
        const finish = (fn, value) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          off();
          Promise.resolve(bt.stopScan()).catch(() => {}).then(() => fn(value));
        };
        const off = global.Aura.on('bluetooth.discovered', (d) => {
          this._emit('discovered', d);
          if (matches(d.name)) finish(resolve, d);
        });
        const timer = setTimeout(() => finish(reject, new Error(this._t.notFound)), this.options.timeout * 1000);
        Promise.resolve(bt.scan({ services: [] })).catch((e) => finish(reject, e));
      });
    }

    /** The known characteristic first, else the first notifying one (proven fallback). */
    _pickCharacteristic(services) {
      let fallback = null;
      for (const s of services) for (const c of s.characteristics || []) {
        if (sameUUID(c.uuid, NOTIFY)) return { service: s.uuid, characteristic: c.uuid };
        const props = (c.properties || []).map((p) => String(p).toLowerCase());
        if (!fallback && (props.includes('notify') || props.includes('indicate'))) fallback = { service: s.uuid, characteristic: c.uuid };
      }
      if (fallback) return fallback;
      // The bridge did not list characteristics: try the documented ones.
      return services.length ? null : { service: SERVICE, characteristic: NOTIFY };
    }

    _listen() {
      this._unsubscribers.forEach((off) => off());
      this._unsubscribers = [
        global.Aura.on('bluetooth.notification', (d) => {
          if (d.id !== this.id || !this._notify || !sameUUID(d.characteristic, this._notify.characteristic)) return;
          this._receive(d.value);
        }),
        global.Aura.on('bluetooth.disconnected', (d) => {
          if (d.id !== this.id) return;
          this._dropped();
          if (this.options.autoReconnect && !this._manual) this._reconnect();
        }),
      ];
    }

    _dropped() {
      const was = this.connected;
      this.connected = false;
      this._stopTimer();
      this._apply(this._processor.tick(Infinity));   // closes an open stroke
      this._assembler.reset();
      if (was) {
        this._emit('status', { state: 'disconnected' });
        this._emit('disconnect', { manual: this._manual });
      }
    }

    async _reconnect() {
      let attempt = 0;
      while (!this._manual && !this.connected) {
        attempt++;
        this._emit('status', { state: 'reconnecting', attempt });
        await sleep(Math.min(1500 * attempt, 6000));
        if (this._manual || this.connected) return;
        try { await this.connect(); return; } catch (_) {}
      }
    }

    _startTimer() {
      this._stopTimer();
      this._hzCount = 0; this._hzStart = now();
      this._timer = setInterval(() => {
        const t = now();
        this._apply(this._processor.tick(t));
        if (t - this._hzStart >= 1) {
          this.hz = this._hzCount / (t - this._hzStart);
          this._hzCount = 0; this._hzStart = t;
          this._emit('stats', this.stats);
        }
      }, 30);
    }

    _stopTimer() { clearInterval(this._timer); this._timer = null; }

    // MARK: Reception

    _receive(dataView) {
      const bytes = new Uint8Array(dataView.buffer, dataView.byteOffset, dataView.byteLength);
      const t = now();
      for (const r of this._assembler.feed(bytes)) {
        this._hzCount++;
        this._apply(this._processor.process(r, t));
      }
    }

    _apply(events) {
      for (const e of events) {
        if (e.type === 'page') {
          this.page = e.page;
          if (this.options.clearOnPageChange) this.strokes = [];
          this._open = false;
          this._emit('page', { page: e.page });
        } else if (e.type === 'point') {
          const p = { x: e.x, y: e.y, force: e.force };
          if (!this._open) {
            this.strokes.push([]);
            this._open = true;
            this._emit('down', { x: e.x, y: e.y, force: e.force, page: e.page });
          }
          this.strokes[this.strokes.length - 1].push(p);
          this._emit('point', { x: e.x, y: e.y, force: e.force, page: e.page });
        } else if (e.type === 'up') {
          if (!this._open) continue;
          this._open = false;
          const stroke = this.strokes[this.strokes.length - 1] || [];
          this._emit('up', { stroke });
          this._emit('stroke', stroke);
        }
      }
      if (events.length) this._emit('change', this.strokes);
    }

    // MARK: Ink

    /** Forgets the strokes of the current sheet. */
    clear() {
      this.strokes = [];
      this._open = false;
      this._emit('change', this.strokes);
    }

    /** Removes the last stroke. */
    undo() {
      if (this._open) return;
      this.strokes.pop();
      this._emit('change', this.strokes);
    }

    /** Bounding box of the ink in pen units, or null. */
    bounds() { return bounds(this.strokes); }

    /**
     * Draws the ink fitted to a canvas (clears it first, uses its CSS size × devicePixelRatio).
     * @param {HTMLCanvasElement} canvas
     * @param {{ color?: string, lineWidth?: number, background?: string, maxScale?: number }} options
     *   maxScale (default 0.25 screen px per pen unit) keeps a lone dot from filling the canvas.
     */
    draw(canvas, options = {}) {
      const o = Object.assign({ color: '#0a84ff', lineWidth: 2.5, background: null, maxScale: 0.25, fill: 0.9 }, options);
      const dpr = global.devicePixelRatio || 1;
      const w = canvas.clientWidth || canvas.width, h = canvas.clientHeight || canvas.height;
      if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
        canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
      }
      const ctx = canvas.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      if (o.background) { ctx.fillStyle = o.background; ctx.fillRect(0, 0, w, h); }
      paint(ctx, this.strokes, w, h, o);
    }

    /**
     * The ink as an image (black on white, thick lines, fitted): ready for handwriting recognition.
     * @param {{ width?: number, height?: number, lineWidth?: number, type?: string, quality?: number }} options
     */
    toDataURL(options = {}) {
      const o = Object.assign({ width: 500, height: 800, lineWidth: 15, type: 'image/jpeg', quality: 0.8 }, options);
      const canvas = document.createElement('canvas');
      canvas.width = o.width; canvas.height = o.height;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, o.width, o.height);
      paint(ctx, this.strokes, o.width, o.height, { color: '#000', lineWidth: o.lineWidth, padding: 10, fill: 0.9 });
      return canvas.toDataURL(o.type, o.quality);
    }

    /** The ink as SVG, in millimetres (1 pen unit = 1 / 23.622 mm), cropped to the ink with a margin. */
    toSVG({ color = '#000', strokeWidth = 0.4, margin = 5 } = {}) {
      const box = this.bounds() || { x: 0, y: 0, width: 0, height: 0 };
      const mm = (v) => +(v / UNITS_PER_MM).toFixed(2);
      const w = mm(box.width) + 2 * margin, h = mm(box.height) + 2 * margin;
      const paths = this.strokes.filter((s) => s.length).map((s) =>
        '<path d="' + s.map((p, i) => (i ? 'L' : 'M') + (mm(p.x - box.x) + margin) + ' ' + (mm(p.y - box.y) + margin)).join(' ') + '"/>').join('');
      return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}mm" height="${h}mm" viewBox="0 0 ${w} ${h}">` +
        `<g fill="none" stroke="${color}" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round">${paths}</g></svg>`;
    }

    // MARK: Events

    /**
     * 'point' ({ x, y, force, page }), 'down' (same, first point of a stroke), 'up' ({ stroke }),
     * 'stroke' (the finished stroke), 'page' ({ page }), 'change' (strokes), 'stats' ({ frames, rejects, sentinels, hz }),
     * 'discovered' (each device seen while scanning), 'status', 'connect', 'disconnect'. Returns off().
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

  AuraNova.SERVICE = SERVICE;
  AuraNova.NOTIFY_CHARACTERISTIC = NOTIFY;
  AuraNova.NAME_HINTS = NAME_HINTS;
  AuraNova.UNITS_PER_MM = UNITS_PER_MM;
  AuraNova.decodeFrame = decodeFrame;
  AuraNova.FrameAssembler = FrameAssembler;
  AuraNova.StreamProcessor = StreamProcessor;
  global.AuraNova = AuraNova;
})(window);
