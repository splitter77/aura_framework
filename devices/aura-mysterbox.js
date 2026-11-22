/*!
 * aura-mysterbox.js — MysterBox and MysterBox Watch (MysterSmith's secret display) for Aura pages.
 *
 * Uses the app's Bluetooth LE bridge (window.Aura.bluetooth). Main frame only.
 *
 *   const box = await AuraMysterBox.connect();
 *   await box.text('Q♥', { color: '#ffd700', only: true });
 *   box.on('tap', ({ x, y }) => …);
 *   box.on('button', ({ button }) => …);     // 'boot' | 'power'
 *   await box.showPicture(file);             // resized for this screen, uploaded, then shown
 *   await box.black();
 *
 * Guide and reference: docs/MYSTERBOX.md
 * Protocol: https://mystersmith.info/user-guide/mysterbox-ble-protocol/
 *
 * What the Aura bridge imposes, handled here:
 *   - one read or write at a time per characteristic: every operation goes through one queue, which
 *     also keeps the order the box relies on;
 *   - writes without response are never refused, iOS drops them when its buffer is full: uploads use
 *     180-byte packets, 10 ms apart, and wait for an answer from the box every 32 packets;
 *   - a notification that arrives during a read of the same characteristic answers that read:
 *     readPosition() accepts a motion packet as its answer;
 *   - turning Bluetooth off sends no 'bluetooth.disconnected': 'bluetooth.state' is watched too.
 */
(function (global) {
  'use strict';

  const DEVICE_NAME = 'MysterBox';
  const uuid = (n) => `7A1D000${n}-3B6E-4F2A-9C4D-2E8F1A5B0C01`;
  const SERVICE = uuid(1);
  const COMMAND = uuid(2);      // write, write without response
  const EVENT = uuid(3);        // notify: 6-byte events
  const STATUS = uuid(4);       // read: one line of text
  const TRANSFER = uuid(5);     // write without response: file data
  const IMU = uuid(6);          // notify: motion stream, read: position

  const OP = {
    TEXT: 0x01, BLACK: 0x02, BRIGHTNESS: 0x03, FILL: 0x04, TEXT_SIZE: 0x05, TEXT_COLOR: 0x06, BEEP: 0x07,
    MORSE: 0x08, PLAY: 0x09, STOP_SOUND: 0x0A, VOLUME: 0x0B, MODE: 0x0D, EFFECT: 0x0E, ROTATION: 0x0F,
    VIBRATE: 0x10, STYLED_TEXT: 0x11, PEN: 0x12, POINTS: 0x13, PEN_UP: 0x14, CLEAR_DRAWING: 0x15,
    MOTION: 0x16, BATTERY: 0x17, UPLOAD_START: 0x18, UPLOAD_END: 0x19, SHOW_IMAGE: 0x1A, DELETE_FILE: 0x1B,
    HIDE_IMAGE: 0x1C, PRELOAD_IMAGE: 0x1D, CARD: 0x1E, SCREENSHOT: 0x1F,
  };
  const EV = {
    DOWN: 0x01, UP: 0x02, TAP: 0x03, SWIPE: 0x05, BUTTON: 0x06, UPLOAD: 0x10, IMAGE: 0x11,
    POSITION: 0x20, SHAKE: 0x21, BATTERY: 0x22, SOUND_END: 0x23,
  };

  const PACKET = 180;           // safe payload on iOS, which does not report the real MTU
  const PACKET_GAP = 10;        // ms between two writes without response
  const FENCE_EVERY = 32;       // packets between two flow-control answers
  const FENCE_FILE = 'none.none';
  const MAX_COMMAND = 509;      // bytes (MTU 512 − 3)
  const MAX_PICTURE = 80000;    // bytes: keeps uploads short
  const POINT_BATCH = 40;       // ms

  const POSITIONS = { 1: 'screenUp', 2: 'screenDown', 3: 'standing', 4: 'upsideDown', 5: 'leftSide', 6: 'rightSide' };
  const SWIPES = { 1: 'up', 2: 'down', 3: 'left', 4: 'right' };
  const BUTTONS = { 1: 'boot', 2: 'power' };
  const MODES = {
    off: 0, on: 1, confused: 2, excited: 3, angry: 4, sad: 5, surprised: 6, neutral: 7,
    react: 8, ignoreMovement: 9, love: 10, next: 11, pitataDice: 12, bleDice: 13, menu: 14, happy: 15,
  };
  const EFFECTS = {
    beep: 1, doubleBeep: 2, powerUp: 3, powerDown: 4, alarm: 5, laser: 6, error: 7, success: 8, click: 9, robot: 10,
    huh: 11, tada: 12, siren: 13, excited: 14, angry: 15, sad: 16, love: 17, card: 18, shutter: 19, surprised: 20, happy: 21,
  };
  const VIBRATIONS = { short: [150], long: [400], double: [150, 150, 150] };
  const UPLOAD_RESULTS = { 0: 'ok', 1: 'writeError', 2: 'sizeMismatch', 3: 'crcError', 6: 'badName', 7: 'noUpload' };
  const IMAGE_RESULTS = { 0: 'ok', 1: 'cannotDecode', 4: 'notFound' };
  const SOUND_RESULTS = { 0: 'ok', 1: 'cannotDecode', 2: 'stopped', 3: 'outOfMemory', 4: 'notFound' };

  const MESSAGES = {
    fr: {
      noAura: "window.Aura indisponible : ouvrez cette page dans Aura, en HTTPS, sur un domaine présent dans vos favoris.",
      notTrusted: "Aura refuse le Bluetooth à cette page : ajoutez son domaine à vos favoris Aura, puis rechargez-la.",
      bluetooth: (s) => `Bluetooth indisponible (${s}).`,
      unauthorized: "Accès Bluetooth refusé : autorisez-le dans Réglages › Aura › Bluetooth.",
      poweredOff: 'Le Bluetooth est éteint : allumez-le et réessayez.',
      noAnswer: "Bluetooth sans réponse : acceptez la demande d'accès au Bluetooth, puis réessayez.",
      notFound: 'Aucune MysterBox trouvée à proximité. Allumez-la (bouton PWR) et réessayez.',
      notBox: "Cet appareil n'a pas le service MysterBox.",
      cancelled: 'Connexion annulée.',
      disconnected: 'MysterBox déconnectée.',
      notConnected: 'MysterBox non connectée.',
      noReply: "La MysterBox n'a pas répondu.",
      tooLong: (n, max) => `Commande trop longue : ${n} octets, ${max} au plus.`,
      badName: (s) => `Nom de fichier invalide « ${s} » : 1 à 48 caractères parmi lettres, chiffres, . _ -`,
      badValue: (what, v) => `Valeur invalide pour ${what} : ${v}`,
      upload: (name, reason) => `Envoi de ${name} échoué (${reason}).`,
      image: (name, reason) => `Affichage de ${name} impossible (${reason}).`,
      picture: "Impossible de convertir l'image en JPEG.",
    },
    en: {
      noAura: 'window.Aura is unavailable: open this page in Aura, over HTTPS, on a domain in your bookmarks.',
      notTrusted: 'Aura refuses Bluetooth to this page: add its domain to your Aura bookmarks, then reload it.',
      bluetooth: (s) => `Bluetooth is unavailable (${s}).`,
      unauthorized: 'Bluetooth access was denied: allow it in Settings › Aura › Bluetooth.',
      poweredOff: 'Bluetooth is turned off: turn it on and try again.',
      noAnswer: 'Bluetooth does not answer: accept the Bluetooth access request, then try again.',
      notFound: 'No MysterBox found nearby. Turn it on (PWR button) and try again.',
      notBox: 'This device has no MysterBox service.',
      cancelled: 'Connection cancelled.',
      disconnected: 'MysterBox disconnected.',
      notConnected: 'MysterBox is not connected.',
      noReply: 'MysterBox did not answer.',
      tooLong: (n, max) => `Command too long: ${n} bytes, ${max} at most.`,
      badName: (s) => `Invalid file name "${s}": 1 to 48 letters, digits, . _ -`,
      badValue: (what, v) => `Invalid value for ${what}: ${v}`,
      upload: (name, reason) => `Upload of ${name} failed (${reason}).`,
      image: (name, reason) => `Cannot show ${name} (${reason}).`,
      picture: 'Cannot convert the picture to JPEG.',
    },
  };
  const defaultLang = () =>
    ((global.navigator && navigator.language) || 'fr').toLowerCase().startsWith('fr') ? 'fr' : 'en';

  // Commands that decide what is on screen: a showPicture() called earlier must not draw over them.
  const TAKES_SCREEN = new Set([OP.BLACK, OP.FILL, OP.MODE, OP.CARD, OP.SHOW_IMAGE, OP.HIDE_IMAGE]);
  // A write that does not start with an opcode is shown as text.
  const setsText = (op) => op === OP.TEXT || op === OP.STYLED_TEXT || op >= 0x20;

  const sameUUID = (a, b) => String(a || '').toUpperCase() === String(b || '').toUpperCase();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const encoder = new TextEncoder();
  const utf8 = (v) => encoder.encode(String(v == null ? '' : v));
  const u16 = (n) => [n & 255, (n >> 8) & 255];
  const u32 = (n) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255];
  const viewBytes = (v) => new Uint8Array(v.buffer, v.byteOffset, v.byteLength);

  // ------------------------------------------------------------------ Protocol (pure, no Bluetooth)

  const CRC_TABLE = new Uint32Array(256).map((_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    return c;
  });

  /** Standard CRC-32 (as in zlib). */
  function crc32(bytes) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 255] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  /** The Status line → object. Read by field name: firmware updates may add fields. */
  function parseStatus(line) {
    const raw = String(line).replace(/\0+$/, '').trim();
    const words = raw.split(/\s+/);
    const f = {};
    for (const word of words) {
      const i = word.indexOf('=');
      if (i > 0) f[word.slice(0, i)] = word.slice(i + 1);
    }
    const number = (v) => (v == null || !/^-?\d/.test(v) ? null : parseFloat(v));
    const millivolts = words.find((w) => /^\d+mV$/.test(w));
    const size = /^(\d+)x(\d+)$/.exec(f.res || '');
    const board = f.board || 'amoled18';      // before 0.11.0: no board, res or motor = the 1.8" box
    return {
      raw,
      fields: f,
      version: words[0] === DEVICE_NAME && /^\d+(\.\d+)*/.test(words[1] || '') ? words[1] : null,
      board,
      watch: board === 'amoled206',
      width: size ? Number(size[1]) : 368,
      height: size ? Number(size[2]) : 448,
      motor: f.motor === '1',
      sd: f.sd === '1',
      root: f.root || null,
      imu: f.imu === '1',
      audio: f.audio === '1',
      volume: number(f.vol),
      rotation: number(f.rot),
      position: POSITIONS[f.face] || null,
      battery: {
        percent: number(f.bat),
        millivolts: number(millivolts),
        charging: words.includes('chg'),
        usb: words.includes('usb'),
      },
    };
  }

  /** One 6-byte Event notification → { type, name, …fields }, or null when too short. */
  function parseEvent(b) {
    if (b.length < 6) return null;
    const type = b[0], x = b[1] | (b[2] << 8), y = b[3] | (b[4] << 8), arg = b[5];
    const make = (name, fields) => Object.assign({ type, name }, fields);
    switch (type) {
      case EV.DOWN: return make('touchDown', { x, y });
      case EV.UP: return make('touchUp', { x, y });
      case EV.TAP: return make('tap', { x, y });
      case EV.SWIPE: return make('swipe', { direction: SWIPES[arg] || null, x, y });
      case EV.BUTTON: return make('button', { button: BUTTONS[arg] || null, duration: x });
      case EV.UPLOAD: return make('upload', { ok: arg === 0, code: arg, reason: UPLOAD_RESULTS[arg] || String(arg), received: x + y * 65536 });
      case EV.IMAGE: return make('image', { ok: arg === 0, code: arg, reason: IMAGE_RESULTS[arg] || String(arg) });
      case EV.POSITION: return make('position', { position: POSITIONS[arg] || null });
      case EV.SHAKE: return make('shake', { strength: arg / 10 });
      case EV.BATTERY: return make('battery', { percent: arg, millivolts: x, present: !!(y & 1), charging: !!(y & 2), usb: !!(y & 4) });
      case EV.SOUND_END: return make('soundEnd', { ok: arg === 0, code: arg, reason: SOUND_RESULTS[arg] || String(arg) });
      default: return make('unknown', { x, y, arg });
    }
  }

  /** One 13-byte IMU notification → acceleration in g, rotation in °/s, position; or null. */
  function parseMotion(b) {
    if (b.length < 13) return null;
    const d = new DataView(b.buffer, b.byteOffset, b.byteLength);
    const at = (i) => d.getInt16(i * 2, true);
    return {
      ax: at(0) / 1000, ay: at(1) / 1000, az: at(2) / 1000,
      gx: at(3) / 10, gy: at(4) / 10, gz: at(5) / 10,
      position: POSITIONS[b[12]] || null,
    };
  }

  // ------------------------------------------------------------------ Driver

  class AuraMysterBox {
    /** True when the page runs in Aura with the bridge active (HTTPS + bookmarked domain). */
    static isAvailable() {
      return !!(global.Aura && global.Aura.bluetooth);
    }

    /**
     * Finds the first MysterBox nearby (or takes the one with this id) and connects to it.
     * @param {{ id?: string, timeout?: number, autoReconnect?: boolean, lang?: 'fr'|'en', settings?: {
     *   brightness?: number, textSize?: number, textColor?: string|number[], rotation?: number, volume?: number } }} options
     */
    static async connect(options = {}) {
      const box = new AuraMysterBox(options);
      await box.connect();
      return box;
    }

    /** Every box has the same name: scan to let the user choose. onDevice(device, seen). Resolves to stop(). */
    static async scan(onDevice, options = {}) {
      const box = new AuraMysterBox(options);
      if (!AuraMysterBox.isAvailable()) throw new Error(box._t.noAura);
      await box._ready();
      const seen = new Map();
      const off = global.Aura.on('bluetooth.discovered', (d) => {
        if (d.name !== DEVICE_NAME) return;
        seen.set(d.id, d);
        if (onDevice) onDevice(d, seen);
      });
      try { await global.Aura.bluetooth.scan({ services: [] }); } catch (e) { off(); throw box._bridgeError(e); }
      return async () => {
        off();
        try { await global.Aura.bluetooth.stopScan(); } catch (_) {}
        return [...seen.values()];
      };
    }

    constructor(options = {}) {
      this.options = Object.assign({ timeout: 20, autoReconnect: true }, options);
      this._t = MESSAGES[this.options.lang] || MESSAGES[defaultLang()];
      this.id = this.options.id || null;
      this.name = DEVICE_NAME;
      this.connected = false;
      this.info = parseStatus('');   // 1.8" box until the Status is read
      this.position = null;
      this._settings = Object.assign({}, this.options.settings);   // sent again at each connection
      this._listeners = {};
      this._waiters = {};
      this._queue = Promise.resolve();
      this._uploads = Promise.resolve();
      this._pictures = Promise.resolve();
      this._session = 0;             // a job queued before a disconnection never runs after it
      this._link = false;            // GATT link up, setup included
      this._points = [];
      this._pointTimer = null;
      this._slot = 'b';
      this._screen = 0;              // changes when showPicture() calls in progress become outdated
      this._text = 0;                // changes with the text layer
      this._motionHz = 0;
      this._manual = false;
      this._connecting = null;
      this._cancelFind = null;
      this._reconnecting = false;
      this._unsubscribers = [];
    }

    get width() { return this.info.width; }
    get height() { return this.info.height; }
    get hasMotor() { return this.info.motor; }

    /** atLeast('0.11.0'): is the firmware that version or newer? */
    atLeast(version) {
      if (!this.info.version) return false;
      const have = this.info.version.split('.').map((n) => parseInt(n, 10) || 0);
      const need = String(version).split('.').map(Number);
      for (let i = 0; i < need.length; i++) {
        if ((have[i] || 0) !== need[i]) return (have[i] || 0) > need[i];
      }
      return true;
    }

    // MARK: Connection

    connect() {
      this._manual = false;
      if (this.connected) return Promise.resolve(this);
      if (!this._connecting) this._connecting = this._open().finally(() => { this._connecting = null; });
      return this._connecting;
    }

    async _open() {
      if (!AuraMysterBox.isAvailable()) throw new Error(this._t.noAura);
      const bt = global.Aura.bluetooth;
      const checkCancelled = () => { if (this._manual) throw new Error(this._t.cancelled); };
      await this._ready();
      checkCancelled();
      if (!this.id) {
        this._emit('status', { state: 'scanning' });
        this.id = (await this._find()).id;
      }
      checkCancelled();
      this._emit('status', { state: 'connecting', name: this.name, id: this.id });
      try {
        const found = await bt.connect(this.id, { timeout: this.options.timeout });
        checkCancelled();
        const services = (found && found.services) || [];
        if (services.length && !services.some((s) => sameUUID(s.uuid, SERVICE))) {
          const id = this.id;
          this.id = null;
          try { await bt.disconnect(id); } catch (_) {}
          throw new Error(this._t.notBox);
        }
        this._listen();
        this._session++;
        this._queue = Promise.resolve();
        this._link = true;
        await this._enqueue(() => bt.startNotifications(this.id, SERVICE, EVENT));
        await this._restore();
        await this.readStatus();
        checkCancelled();
      } catch (e) {
        this._dropped();
        if (this.id) { try { await bt.disconnect(this.id); } catch (_) {} }
        throw this._bridgeError(e);
      }
      this.connected = true;
      this._emit('status', { state: 'connected', name: this.name, id: this.id });
      this._emit('connect', { name: this.name, id: this.id, info: this.info });
      return this;
    }

    async disconnect() {
      this._manual = true;
      if (this._cancelFind) this._cancelFind();
      const active = this._link;
      this._dropped();
      if (active && this.id) {
        try { await global.Aura.bluetooth.disconnect(this.id); } catch (_) {}
      }
      this._emit('status', { state: 'disconnected' });
    }

    /** The box forgets some settings (rotation, motion stream): send back what the page chose. */
    async _restore() {
      const s = this._settings;
      if (s.brightness != null) await this.brightness(s.brightness);
      if (s.textSize != null) await this.textSize(s.textSize);
      if (s.textColor != null) await this.textColor(s.textColor);
      if (s.rotation != null) await this.rotation(s.rotation);
      if (s.volume != null) await this.volume(s.volume);
      if (this._motionHz) await this.motion(this._motionHz);
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
            if ((s !== 'unknown' && s !== 'resetting') || Date.now() - t0 > AuraMysterBox.PERMISSION_TIMEOUT * 1000) {
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

    /** Scan without a service filter, as the protocol requires: matched on the exact name. */
    _find() {
      const bt = global.Aura.bluetooth;
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
          if (d.name === DEVICE_NAME) finish(resolve, d);
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
          if (!this._link || d.id !== this.id) return;
          if (sameUUID(d.characteristic, EVENT)) this._receive(viewBytes(d.value));
          else if (sameUUID(d.characteristic, IMU)) this._moved(viewBytes(d.value));
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
      this._screen++;                // no picture chosen before a disconnection appears after it
      clearTimeout(this._pointTimer);
      this._pointTimer = null;
      this._points = [];
      const waiting = Object.values(this._waiters).flat();
      this._waiters = {};
      waiting.forEach((w) => w.fail(new Error(this._t.disconnected)));
      if (was) this._emit('disconnect', { manual: this._manual });
    }

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

    _receive(bytes) {
      const event = parseEvent(bytes);
      if (!event) return;
      let internal = false;
      const waiter = (this._waiters[event.type] || [])[0];
      if (waiter) {
        internal = waiter.internal;
        waiter.done(event);
      }
      if (event.type === EV.POSITION) this.position = event.position;
      if (event.type === EV.BATTERY) {
        const { percent, millivolts, present, charging, usb } = event;
        this.info.battery = { percent, millivolts, present, charging, usb };
      }
      if (internal) return;          // flow-control answers are not the page's business
      this._emit('event', event);
      if (event.name !== 'unknown') this._emit(event.name, event);
    }

    _moved(bytes) {
      const motion = parseMotion(bytes);
      if (motion) this._emit('motion', motion);
    }

    /**
     * Answers carry no id, but the box works strictly in order: the oldest waiter of a type gets the answer.
     * Call it inside the queue, right before the write.
     */
    _expect(type, timeout, internal = false) {
      let settle;
      const promise = new Promise((resolve, reject) => { settle = { resolve, reject }; });
      promise.catch(() => {});       // may fail before anyone awaits it
      const list = this._waiters[type] = this._waiters[type] || [];
      let timer = null;
      const remove = () => {
        clearTimeout(timer);
        const i = list.indexOf(waiter);
        if (i >= 0) list.splice(i, 1);
      };
      const waiter = {
        internal, promise, event: null,
        done: (event) => { waiter.event = event; remove(); settle.resolve(event); },
        fail: (error) => { remove(); settle.reject(error); },
        arm: (ms) => {
          clearTimeout(timer);
          timer = setTimeout(() => waiter.fail(Object.assign(new Error(this._t.noReply), { retry: true })), ms);
        },
      };
      list.push(waiter);
      if (timeout) waiter.arm(timeout);
      return waiter;
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

    _write(characteristic, bytes, withoutResponse) {
      return global.Aura.bluetooth.write(this.id, SERVICE, characteristic, bytes, { withoutResponse });
    }

    /** Raw command: bytes (first one = opcode), or a string shown as plain text by the box. */
    async send(data, { withoutResponse = false } = {}) {
      const bytes = typeof data === 'string' ? utf8(data) : Uint8Array.from(data);
      if (!bytes.length) throw new Error(this._t.badValue('send()', '""'));
      const max = withoutResponse ? PACKET : MAX_COMMAND;     // iOS silently drops longer writes without response
      if (bytes.length > max) throw new Error(this._t.tooLong(bytes.length, max));
      // Counted when called, not when written: showPicture() checks while this may still be queued.
      if (TAKES_SCREEN.has(bytes[0])) this._screen++;
      if (setsText(bytes[0])) this._text++;
      if (bytes[0] !== OP.POINTS) this._flushPoints().catch((e) => this._emit('error', { error: e }));
      return this._enqueue(async () => {
        await this._write(COMMAND, bytes, withoutResponse);
        if (withoutResponse) await sleep(PACKET_GAP);
      });
    }

    /** Sends a command and resolves with the event that answers it. */
    async _request(bytes, type, { timeout = AuraMysterBox.REPLY_TIMEOUT, internal = false } = {}) {
      let waiter;
      await this._enqueue(async () => {
        waiter = this._expect(type, timeout, internal);
        try { await this._write(COMMAND, Uint8Array.from(bytes), false); } catch (e) { waiter.fail(e); throw e; }
      });
      return waiter.promise;
    }

    _number(what, value, min, max) {
      const n = Number(value);
      if (value === null || value === '' || !Number.isFinite(n)) throw new Error(this._t.badValue(what, value));
      return Math.max(min, Math.min(max, Math.round(n)));
    }

    _color(value) {
      if (Array.isArray(value) && value.length === 3) return value.map((v) => this._number('color', v, 0, 255));
      let hex = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(value));
      if (!hex) throw new Error(this._t.badValue('color', value));
      hex = hex[1].length === 3 ? hex[1].replace(/./g, '$&$&') : hex[1];
      return [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
    }

    _choice(what, table, value) {
      if (Object.prototype.hasOwnProperty.call(table, value)) return table[value];
      if (Object.values(table).includes(value)) return value;
      throw new Error(this._t.badValue(what, value));
    }

    _fileName(name) {
      if (!/^[A-Za-z0-9._-]{1,48}$/.test(String(name))) throw new Error(this._t.badName(name));
      return utf8(name);
    }

    // MARK: Screen and text

    /**
     * Centred, auto-sized text ('\n' breaks lines). size and color apply to this text only.
     * Text is drawn over the image: only = true hides the image first.
     */
    async text(value, { size, color, only = false } = {}) {
      const body = utf8(value);
      let head = [OP.TEXT];
      if (size != null || color != null) {
        const px = this._number('size', size != null ? size : (this._settings.textSize || 160), 0, 200);
        const rgb = this._color(color != null ? color : (this._settings.textColor || '#fff'));
        head = [OP.STYLED_TEXT, px ? Math.max(20, px) : 160, ...rgb];
      }
      if (head.length + body.length > MAX_COMMAND) throw new Error(this._t.tooLong(head.length + body.length, MAX_COMMAND));
      const jobs = only ? [this.hideImage()] : [];
      jobs.push(this.send([...head, ...body]));
      await Promise.all(jobs);
    }

    /** Black screen, looks switched off: clears text, image and drawing. */
    async black() { return this.send([OP.BLACK]); }

    async fill(color) { return this.send([OP.FILL, ...this._color(color)]); }

    async brightness(percent) {
      const v = this._settings.brightness = this._number('brightness', percent, 0, 100);
      return this.send([OP.BRIGHTNESS, v]);
    }

    /** Default maximum text size, 20 to 200 px; 0 = 160. */
    async textSize(px) {
      const n = this._number('textSize', px, 0, 200);
      const v = this._settings.textSize = n ? Math.max(20, n) : 0;
      return this.send([OP.TEXT_SIZE, v]);
    }

    async textColor(color) {
      const v = this._settings.textColor = this._color(color);
      return this.send([OP.TEXT_COLOR, ...v]);
    }

    /** 0 upright, 1 = 90° right, 2 = 180°, 3 = 90° left. Text only. */
    async rotation(turns) {
      if (![0, 1, 2, 3].includes(turns)) throw new Error(this._t.badValue('rotation', turns));
      this._settings.rotation = turns;
      return this.send([OP.ROTATION, turns]);
    }

    // MARK: Drawing (screen pixels, use width and height)

    async pen(color = '#fff', width = 6) {
      return this.send([OP.PEN, ...this._color(color), this._number('width', width, 1, 40)]);
    }

    /** Points of the current line: [{ x, y }] or [[x, y]]. */
    async points(list) {
      const bytes = [];
      for (const p of list) {
        const [x, y] = Array.isArray(p) ? p : [p.x, p.y];
        bytes.push(...u16(this._number('x', x, -32768, 32767)), ...u16(this._number('y', y, -32768, 32767)));
      }
      const jobs = [this._flushPoints()];
      const size = Math.floor((PACKET - 1) / 4) * 4;
      for (let i = 0; i < bytes.length; i += size) {
        jobs.push(this.send([OP.POINTS, ...bytes.slice(i, i + size)], { withoutResponse: true }));
      }
      await Promise.all(jobs);
    }

    /** One live point (pointermove…): sent in batches every 40 ms. */
    point(x, y) {
      if (!this._link || !Number.isFinite(x) || !Number.isFinite(y)) return;
      this._points.push([x, y]);
      if (this._pointTimer) return;
      this._pointTimer = setTimeout(() => this._flushPoints().catch((e) => this._emit('error', { error: e })), POINT_BATCH);
    }

    async _flushPoints() {
      clearTimeout(this._pointTimer);
      this._pointTimer = null;
      if (!this._points.length) return;
      return this.points(this._points.splice(0));
    }

    async penUp() { return this.send([OP.PEN_UP]); }

    async clearDrawing() { return this.send([OP.CLEAR_DRAWING]); }

    /** A whole line at once. */
    async stroke(list, { color = '#fff', width = 6 } = {}) {
      await Promise.all([this.pen(color, width), this.points(list), this.penUp()]);
    }

    // MARK: Files

    /**
     * Sends a file (Blob, ArrayBuffer, typed array or bytes) and resolves once the box has checked it.
     * One upload at a time, retried more slowly (retries = 1) when packets were lost.
     */
    async upload(name, data, { onProgress, retries = 1 } = {}) {
      this._fileName(name);
      const run = this._uploads.then(async () => {
        let bytes;
        if (data instanceof Blob) bytes = new Uint8Array(await data.arrayBuffer());
        else if (data instanceof ArrayBuffer) bytes = new Uint8Array(data.slice(0));
        else if (ArrayBuffer.isView(data)) bytes = new Uint8Array(viewBytes(data));
        else if (Array.isArray(data)) bytes = Uint8Array.from(data);
        if (!bytes || !bytes.length) throw new Error(this._t.badValue('upload()', data));
        for (let attempt = 0; ; attempt++) {
          try {
            return await this._uploadOnce(name, bytes, PACKET_GAP * (attempt + 1), onProgress);
          } catch (e) {
            if (!this._link || !e.retry || attempt >= retries) throw e;
          }
        }
      });
      this._uploads = run.catch(() => {});
      return run;
    }

    async _uploadOnce(name, bytes, gap, onProgress) {
      let result = null;
      const fence = () => this._request([OP.SHOW_IMAGE, ...utf8(FENCE_FILE)], EV.IMAGE, { internal: true });
      try {
        await this._enqueue(async () => {
          result = this._expect(EV.UPLOAD);       // can come early when the box refuses the file
          await this._write(COMMAND, Uint8Array.from([OP.UPLOAD_START, ...u32(bytes.length), ...utf8(name)]), false);
        });
        await fence();
        for (let sent = 0, n = 1; sent < bytes.length && !result.event; n++) {
          const chunk = bytes.slice(sent, sent + PACKET);
          // One job per packet, so a text or a vibration can slip in during an upload.
          await this._enqueue(async () => {
            await this._write(TRANSFER, chunk, true);
            await sleep(gap);
          });
          sent += chunk.length;
          if (n % FENCE_EVERY === 0 && sent < bytes.length) await fence();
          if (onProgress) onProgress(sent / bytes.length, sent, bytes.length);
        }
        if (!result.event) {
          await this._enqueue(async () => {
            result.arm(AuraMysterBox.UPLOAD_TIMEOUT);
            await this._write(COMMAND, Uint8Array.from([OP.UPLOAD_END, ...u32(crc32(bytes))]), false);
          });
        }
        const answer = await result.promise;
        if (!answer.ok) {
          const error = new Error(this._t.upload(name, answer.reason));
          error.reason = answer.reason;
          error.retry = answer.code === 2 || answer.code === 3;     // lost or damaged packets
          throw error;
        }
        return { name, size: bytes.length };
      } catch (e) {
        if (result) result.fail(e);
        // Close the half-finished upload and swallow its answer, or the next upload would take it as its own.
        if (this._link) {
          try { await this._request([OP.UPLOAD_END], EV.UPLOAD, { timeout: 3000, internal: true }); } catch (_) {}
        }
        throw e;
      }
    }

    /** Shows an uploaded image. Image and text are layers: only = true also clears the text. */
    async showImage(name, { only = false } = {}) {
      this._fileName(name);
      this._screen++;
      const jobs = [this._image(OP.SHOW_IMAGE, name)];
      if (only) jobs.push(this.text(''));
      return (await Promise.all(jobs))[0];
    }

    /** Decodes an image into the box's memory (it keeps 4): showImage is then instant. */
    async preloadImage(name) { return this._image(OP.PRELOAD_IMAGE, name); }

    async _image(op, name) {
      const result = await this._request([op, ...this._fileName(name)], EV.IMAGE);
      if (result.ok) return result;
      const error = new Error(this._t.image(name, result.reason));
      error.reason = result.reason;
      throw error;
    }

    async hideImage() { return this.send([OP.HIDE_IMAGE]); }

    async deleteFile(name) { return this.send([OP.DELETE_FILE, ...this._fileName(name)]); }

    /**
     * A picture (Blob / File, URL, <img>, canvas) → baseline JPEG of exactly the screen size, under about 80 KB.
     * A URL from another site needs CORS.
     */
    async fitImage(source, { fit = 'contain', background = '#000', quality = 0.85 } = {}) {
      let image = source, url = null;
      try {
        if (typeof source === 'string' || source instanceof Blob) {
          image = new Image();
          if (typeof source === 'string') image.crossOrigin = 'anonymous';
          else url = URL.createObjectURL(source);
          image.src = url || source;
          await image.decode();
        } else if (source instanceof HTMLImageElement) {
          await source.decode();
        }
        const w = image.naturalWidth || image.videoWidth || image.width;
        const h = image.naturalHeight || image.videoHeight || image.height;
        if (!w || !h) throw new Error(this._t.picture);
        const canvas = document.createElement('canvas');
        canvas.width = this.width;
        canvas.height = this.height;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = background;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        const scale = (fit === 'cover' ? Math.max : Math.min)(canvas.width / w, canvas.height / h);
        ctx.drawImage(image, (canvas.width - w * scale) / 2, (canvas.height - h * scale) / 2, w * scale, h * scale);
        for (let q = quality; ; q -= 0.15) {
          const jpeg = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', q));
          if (!jpeg || jpeg.type !== 'image/jpeg') throw new Error(this._t.picture);
          if (jpeg.size <= MAX_PICTURE || q - 0.15 < 0.2) return jpeg;
        }
      } finally {
        if (url) URL.revokeObjectURL(url);
      }
    }

    /**
     * fitImage + upload + show, alternating two names so the current picture stays until the new one is ready.
     * A later black(), fill(), mode(), card(), hideImage(), showImage() or text(…, { only: true }) wins:
     * resolves { shown: false }. A later text() stays over the picture.
     */
    async showPicture(source, options = {}) {
      const screen = this._screen, text = this._text;     // at the call, not when its turn comes
      const outdated = () => screen !== this._screen;
      const run = this._pictures.then(async () => {
        if (outdated()) return { shown: false };
        const jpeg = await this.fitImage(source, options);
        const slot = this._slot === 'a' ? 'b' : 'a';
        const name = `aura-${slot}.jpg`;
        if (outdated()) return { shown: false };
        await this.upload(name, jpeg, options);
        if (outdated()) return { shown: false };
        // No await between that check and queueing both writes. Neither counts as a change made by the page.
        const jobs = [this._image(OP.SHOW_IMAGE, name)];
        if (options.only !== false && text === this._text) {
          jobs.push(this._enqueue(() => this._write(COMMAND, Uint8Array.from([OP.TEXT]), false)));
        }
        await Promise.all(jobs);
        this._slot = slot;
        return { shown: true, name, size: jpeg.size };
      });
      this._pictures = run.catch(() => {});
      return run;
    }

    // MARK: Sound

    async beep(frequency = 1000, ms = 150) {
      return this.send([OP.BEEP, ...u16(this._number('frequency', frequency, 20, 8000)), ...u16(this._number('ms', ms, 1, 65535))]);
    }

    async morse(text, wpm = 20) { return this.send([OP.MORSE, this._number('wpm', wpm, 5, 40), ...utf8(text)]); }

    /** Built-in sound: a name of AuraMysterBox.EFFECTS or its number. */
    async effect(effect) { return this.send([OP.EFFECT, this._choice('effect', EFFECTS, effect)]); }

    /** Queues an uploaded MP3 or WAV. Its end, or a missing file, comes as 'soundEnd'. */
    async play(name) { return this.send([OP.PLAY, ...this._fileName(name)]); }

    async stopSound() { return this.send([OP.STOP_SOUND]); }

    async volume(percent) {
      const v = this._settings.volume = this._number('volume', percent, 0, 100);
      return this.send([OP.VOLUME, v]);
    }

    // MARK: Robot, dice, menu

    /** A name of AuraMysterBox.MODES or its number. Emotions come back to neutral after 4 s. */
    async mode(mode) { return this.send([OP.MODE, this._choice('mode', MODES, mode)]); }

    /** Playing card in the robot's eyes for 5 s: card('QH'), card('10♠'), card(12, 2); card() = random. */
    async card(rank = 0, suit = 0) {
      let r = rank, s = suit;
      if (typeof r === 'string') {
        const m = /^(A|J|Q|K|10|[2-9])([CHSD♣♥♠♦]?)$/i.exec(r.trim());
        if (!m) throw new Error(this._t.badValue('card', rank));
        r = { A: 1, J: 11, Q: 12, K: 13 }[m[1].toUpperCase()] || Number(m[1]);
        if (m[2]) s = m[2];
      }
      if (typeof s === 'string') s = { C: 1, '♣': 1, H: 2, '♥': 2, S: 3, '♠': 3, D: 4, '♦': 4 }[s.toUpperCase()];
      if (!Number.isInteger(r) || r < 0 || r > 13 || !Number.isInteger(s) || s < 0 || s > 4) {
        throw new Error(this._t.badValue('card', `${rank} ${suit}`));
      }
      return this.send([OP.CARD, r, s]);
    }

    /** Saved on the microSD card. */
    async screenshot() { return this.send([OP.SCREENSHOT]); }

    // MARK: Vibration (the Watch; the box ignores it)

    /** 'short' | 'long' | 'double', a duration in ms, or [on, off, on…] in ms (10 to 2550 each, 64 at most). */
    async vibrate(pattern = 'short') {
      const list = typeof pattern === 'number' ? [pattern] : Array.isArray(pattern) ? pattern : VIBRATIONS[pattern];
      if (!Array.isArray(list) || !list.length || list.length > 64) throw new Error(this._t.badValue('vibrate', pattern));
      return this.send([OP.VIBRATE, ...list.map((ms) => this._number('vibrate', ms / 10, 1, 255))]);
    }

    async stopVibration() { return this.send([OP.VIBRATE]); }

    // MARK: Device and sensors

    async readStatus() {
      const value = await this._enqueue(() => global.Aura.bluetooth.read(this.id, SERVICE, STATUS));
      this.info = parseStatus(new TextDecoder().decode(viewBytes(value)));
      if (this.info.position) this.position = this.info.position;
      return this.info;
    }

    async battery() {
      const { percent, millivolts, present, charging, usb } = await this._request([OP.BATTERY], EV.BATTERY);
      return { percent, millivolts, present, charging, usb };
    }

    async readPosition() {
      const b = viewBytes(await this._enqueue(() => global.Aura.bluetooth.read(this.id, SERVICE, IMU)));
      // While the stream runs, iOS may answer the read with a 13-byte motion packet.
      this.position = POSITIONS[b.length >= 13 ? b[12] : b[0]] || null;
      return this.position;
    }

    /** Raw motion stream as 'motion' events, up to 100 Hz; 0 stops it. */
    async motion(hz = 20) {
      const rate = this._number('motion', hz, 0, 100);
      this._motionHz = rate;
      const bt = global.Aura.bluetooth;
      await Promise.all([
        this.send([OP.MOTION, rate]),
        this._enqueue(() => (rate ? bt.startNotifications : bt.stopNotifications)(this.id, SERVICE, IMU)),
      ]);
    }

    // MARK: Events

    /**
     * Events: 'touchDown', 'touchUp', 'tap', 'swipe', 'button', 'position', 'shake', 'battery', 'motion',
     * 'soundEnd', 'upload', 'image', 'event' (all box events), 'error' (live drawing), 'discovered',
     * 'status', 'connect', 'disconnect'. Returns a function that unsubscribes.
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

  AuraMysterBox.DEVICE_NAME = DEVICE_NAME;
  AuraMysterBox.SERVICE = SERVICE;
  AuraMysterBox.CHARACTERISTICS = { COMMAND, EVENT, STATUS, TRANSFER, IMU };
  AuraMysterBox.MODES = MODES;
  AuraMysterBox.EFFECTS = EFFECTS;
  AuraMysterBox.PERMISSION_TIMEOUT = 60;   // seconds
  AuraMysterBox.REPLY_TIMEOUT = 10000;     // ms
  AuraMysterBox.UPLOAD_TIMEOUT = 20000;    // ms
  AuraMysterBox.crc32 = crc32;
  AuraMysterBox.parseStatus = parseStatus;
  AuraMysterBox.parseEvent = parseEvent;
  AuraMysterBox.parseMotion = parseMotion;
  global.AuraMysterBox = AuraMysterBox;
})(window);
