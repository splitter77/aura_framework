/*!
 * aura-peek.js — Pilote le peek device AuraPeek (Waveshare ESP32-S3 AMOLED 1.8) depuis une page Aura.
 *
 * Utilise la passerelle Bluetooth LE de l'app (window.Aura.bluetooth).
 * Conditions : page en HTTPS, sur un domaine présent dans les favoris Aura.
 *
 *   const peek = await AuraPeek.connect();
 *   await peek.text('Hello');
 *   await peek.card('QH');
 *   peek.on('tap', ({ zone }) => console.log('tap', zone));
 *   peek.on('swipe', ({ dir }) => console.log('swipe', dir));
 *
 * Protocole : lignes JSON (voir PROTOCOL.md).
 */
(function (global) {
  'use strict';

  const SERVICE = '41555241-5045-454B-0001-000000000000';
  const CMD = '41555241-5045-454B-0002-000000000000';
  const EVT = '41555241-5045-454B-0003-000000000000';
  const NAME_PREFIX = 'AuraPeek-';
  const CHUNK = 100;  // octets par écriture (écritures acquittées : pas de perte)

  const EVENTS = ['tap', 'doubletap', 'longpress', 'swipe', 'knock', 'flip', 'shake', 'imu', 'info', 'pong', 'error'];

  const MESSAGES = {
    fr: {
      noAura: "window.Aura indisponible : ouvrez cette page dans Aura, en HTTPS, sur un domaine présent dans vos favoris.",
      disconnected: 'AuraPeek déconnecté.',
      notConnected: 'AuraPeek non connecté.',
      noReply: (t) => `Pas de réponse à « ${t} »`,
    },
    en: {
      noAura: 'window.Aura is unavailable: open this page in Aura, over HTTPS, on a domain in your bookmarks.',
      disconnected: 'AuraPeek disconnected.',
      notConnected: 'AuraPeek is not connected.',
      noReply: (t) => `No reply to "${t}"`,
    },
  };
  const defaultLang = () =>
    ((global.navigator && navigator.language) || 'fr').toLowerCase().startsWith('fr') ? 'fr' : 'en';

  const sameUUID = (a, b) => String(a || '').toUpperCase() === String(b || '').toUpperCase();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /** L'écran n'a qu'une police ASCII : accents retirés, symboles courants remplacés. */
  const toAscii = (value) =>
    String(value)
      .replace(/[«»“”]/g, '"').replace(/[‘’]/g, "'").replace(/[–—]/g, '-').replace(/…/g, '...')
      .replace(/œ/g, 'oe').replace(/Œ/g, 'OE').replace(/æ/g, 'ae').replace(/ß/g, 'ss')
      .normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/[^\x20-\x7E\n]/g, '?');

  const SUITS = { '♠': 'S', '♥': 'H', '♦': 'D', '♣': 'C', s: 'S', h: 'H', d: 'D', c: 'C' };

  class AuraPeek {
    static isAvailable() {
      return !!(global.Aura && global.Aura.bluetooth);
    }

    /**
     * Cherche le premier AuraPeek à proximité et s'y connecte.
     * @param {{ timeout?: number, name?: string, autoReconnect?: boolean, lang?: 'fr' | 'en' }} options
     */
    static async connect(options = {}) {
      const peek = new AuraPeek(options);
      await peek.connect();
      return peek;
    }

    constructor(options = {}) {
      this.options = Object.assign({ timeout: 15, autoReconnect: true }, options);
      this._t = MESSAGES[this.options.lang] || MESSAGES[defaultLang()];
      this.id = null;
      this.name = '';
      this.connected = false;
      this.info = null;
      this._listeners = {};
      this._buffer = '';
      this._decoder = new TextDecoder();
      this._encoder = new TextEncoder();
      this._pending = new Map();
      this._nextId = 1;
      this._queue = Promise.resolve();
      this._manualDisconnect = false;
      this._unsubscribers = [];
    }

    // MARK: Connexion

    async connect() {
      if (!AuraPeek.isAvailable()) throw new Error(this._t.noAura);
      const bt = global.Aura.bluetooth;
      this._manualDisconnect = false;
      this._emit('status', { state: 'scanning' });

      if (!this.id) {
        const device = await bt.requestDevice({
          services: [],
          name: this.options.name || null,
          namePrefix: this.options.name ? null : NAME_PREFIX,
          timeout: this.options.timeout,
        });
        this.id = device.id;
        this.name = device.name;
      }

      this._emit('status', { state: 'connecting', name: this.name });
      await bt.connect(this.id, { timeout: this.options.timeout });
      this._listen();
      await bt.startNotifications(this.id, SERVICE, EVT);
      this.connected = true;
      try { this.info = await this.getInfo(); } catch (_) {}
      this._emit('status', { state: 'connected', name: this.name, id: this.id });
      this._emit('connect', { name: this.name, id: this.id, info: this.info });
      return this;
    }

    async disconnect() {
      this._manualDisconnect = true;
      if (this.id && this.connected) {
        try { await global.Aura.bluetooth.disconnect(this.id); } catch (_) {}
      }
      this._setDisconnected();
    }

    _listen() {
      this._unsubscribers.forEach((off) => off());
      this._unsubscribers = [
        global.Aura.on('bluetooth.notification', (d) => {
          if (d.id !== this.id || !sameUUID(d.characteristic, EVT)) return;
          this._receive(d.value);
        }),
        global.Aura.on('bluetooth.disconnected', (d) => {
          if (d.id !== this.id) return;
          this._setDisconnected();
          if (this.options.autoReconnect && !this._manualDisconnect) this._reconnect();
        }),
      ];
    }

    _setDisconnected() {
      const was = this.connected;
      this.connected = false;
      this._buffer = '';
      this._pending.forEach((p) => p.reject(new Error(this._t.disconnected)));
      this._pending.clear();
      if (was) {
        this._emit('status', { state: 'disconnected' });
        this._emit('disconnect', {});
      }
    }

    async _reconnect() {
      for (let attempt = 1; attempt <= 5 && !this._manualDisconnect && !this.connected; attempt++) {
        this._emit('status', { state: 'reconnecting', attempt });
        await sleep(1000 * attempt);
        try { await this.connect(); return; } catch (_) {}
      }
      if (!this.connected) this._emit('status', { state: 'disconnected' });
    }

    // MARK: Réception

    _receive(dataView) {
      const bytes = new Uint8Array(dataView.buffer, dataView.byteOffset, dataView.byteLength);
      this._buffer += this._decoder.decode(bytes, { stream: true });
      let index;
      while ((index = this._buffer.indexOf('\n')) >= 0) {
        const line = this._buffer.slice(0, index).trim();
        this._buffer = this._buffer.slice(index + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch (_) { continue; }
        this._handle(msg);
      }
    }

    _handle(msg) {
      this._emit('message', msg);
      if (msg.id != null && this._pending.has(msg.id)) {
        const p = this._pending.get(msg.id);
        this._pending.delete(msg.id);
        if (msg.e === 'error') p.reject(new Error(msg.msg || 'error'));
        else p.resolve(msg);
        return;
      }
      // Réponses sans id (info) : premier en attente du même type.
      for (const [id, p] of this._pending) {
        if (p.expect && p.expect === msg.e) {
          this._pending.delete(id);
          p.resolve(msg);
          break;
        }
      }
      if (EVENTS.includes(msg.e)) this._emit(msg.e, msg);
    }

    // MARK: Envoi

    /** Envoie une commande brute (objet), sans attendre de réponse. */
    send(command) {
      if (!this.connected) return Promise.reject(new Error(this._t.notConnected));
      const bytes = this._encoder.encode(JSON.stringify(command) + '\n');
      const job = this._queue.then(async () => {
        for (let offset = 0; offset < bytes.length; offset += CHUNK) {
          if (!this.connected) throw new Error(this._t.disconnected);
          await global.Aura.bluetooth.write(this.id, SERVICE, CMD, bytes.subarray(offset, offset + CHUNK), { withoutResponse: false });
        }
      });
      this._queue = job.catch(() => {});
      return job;
    }

    /** Envoie une commande et attend son acquittement (ou l'événement `expect`). */
    request(command, { timeout = 4000, expect = null } = {}) {
      const id = this._nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          this._pending.delete(id);
          reject(new Error(this._t.noReply(command.t)));
        }, timeout);
        this._pending.set(id, {
          expect,
          resolve: (v) => { clearTimeout(timer); resolve(v); },
          reject: (e) => { clearTimeout(timer); reject(e); },
        });
        this.send(expect ? command : Object.assign({}, command, { id })).catch((e) => {
          this._pending.delete(id);
          clearTimeout(timer);
          reject(e);
        });
      });
    }

    // MARK: Écran

    /**
     * Affiche un texte.
     * @param {string} value  '\n' pour un retour à la ligne.
     * @param {{ zone?: 'full'|'top'|'mid'|'bot', size?: number, color?: string, bg?: string, align?: 'left'|'center'|'right' }} options
     *   size : 0 = auto (le plus grand possible), 1 à 7 sinon. color/bg : '#rgb', '#rrggbb' ou un nom (red, green…).
     */
    text(value, options = {}) {
      const cmd = { t: 'text', v: toAscii(value) };
      if (options.zone) cmd.zone = options.zone;
      if (options.size != null) cmd.size = options.size;
      if (options.color) cmd.color = options.color;
      if (options.bg) cmd.bg = options.bg;
      if (options.align) cmd.align = options.align[0];
      return this.request(cmd);
    }

    /** Carte à jouer : 'QH', '10S', 'TD', 'A♠', '7♥'… */
    card(value, { zone } = {}) {
      let v = String(value).trim();
      const suit = SUITS[v.slice(-1)];
      if (suit) v = v.slice(0, -1) + suit;
      const cmd = { t: 'card', v: v.toUpperCase() };
      if (zone) cmd.zone = zone;
      return this.request(cmd);
    }

    clear(zone) { return this.request(zone ? { t: 'clear', zone } : { t: 'clear' }); }

    /** Luminosité de 0 à 100 (mémorisée par l'appareil). */
    brightness(percent) { return this.request({ t: 'bright', v: Math.round(Math.max(0, Math.min(100, Number(percent) || 0))) }); }

    /** Allume / éteint la dalle sans couper la connexion. */
    screen(on) { return this.request({ t: 'screen', v: !!on }); }

    /** Rotation 0, 1, 2, 3 (×90°), mémorisée. */
    rotate(quarterTurns) { return this.request({ t: 'rotate', v: Number(quarterTurns) & 3 }); }

    /** Remplit l'écran un instant. */
    flash(color = '#fff', ms = 120) { return this.request({ t: 'flash', color, ms }); }

    /** Cercle sous le doigt pour les tests (désactivé par défaut, non mémorisé). */
    feedback(on = true) { return this.request({ t: 'feedback', v: !!on }); }

    // MARK: Capteurs

    /** Flux accéléromètre/gyroscope (événement 'imu'). */
    imu(on = true, hz = 10) { return this.request({ t: 'imu', v: !!on, hz }); }

    /** Sensibilité du « knock » en g (0.2 à 4, défaut 0.8 : plus petit = plus sensible). */
    knockSensitivity(g) { return this.request({ t: 'imu', knock: g }); }

    // MARK: Infos

    getInfo() { return this.request({ t: 'info' }, { expect: 'info' }); }

    /** Aller-retour en ms. */
    async ping() {
      const t0 = performance.now();
      await this.request({ t: 'ping' });
      return Math.round(performance.now() - t0);
    }

    // MARK: Événements

    /**
     * 'tap', 'doubletap', 'longpress' ({ x, y, zone }), 'swipe' ({ dir }), 'knock' ({ g }),
     * 'flip' ({ face: 'up'|'down' }), 'shake', 'imu', 'message' (tout message reçu),
     * 'status', 'connect', 'disconnect'. Retourne une fonction pour se désabonner.
     * Un double toucher émet 'tap', 'tap' puis 'doubletap'.
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

  AuraPeek.SERVICE = SERVICE;
  AuraPeek.CMD_CHARACTERISTIC = CMD;
  AuraPeek.EVT_CHARACTERISTIC = EVT;
  AuraPeek.toAscii = toAscii;
  global.AuraPeek = AuraPeek;
})(window);
