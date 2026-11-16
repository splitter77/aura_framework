/*!
 * aura-plb.js — PLB (Marc-Antoine's thumb button with a light) for Aura pages.
 *
 * Uses the app's Bluetooth LE bridge (window.Aura.bluetooth). Main frame only.
 *
 *   const plb = await AuraPLB.connect();
 *   plb.on('push', () => …);                 // button pressed
 *   plb.on('release', ({ duration }) => …);  // button released
 *   plb.on('longpress', () => …);            // held about one second
 *   await plb.light(60);                     // light at 60 %, plb.light(0) turns it off
 *   const mv = await plb.battery();          // battery in millivolts
 *
 * Protocol (read from the nRF52 firmware main.c, version 010 of 24/08/2025):
 *   - name "MA_Pouce_XXXXXX" (6 hex digits of the address); Nordic UART Service (NUS) in the scan response;
 *   - commands: text written to 6E400002, ending with \n (or \r), case-insensitive;
 *   - answers: notifications on 6E400003, "<answer>\r\nOK\r\n";
 *   - button: "+BTN: PUSH", "+BTN: RELEASE", "+BTN: LONG", with NO line ending;
 *   - while no app is connected the PLB is only awake while its button is held (the light turns on after
 *     200 ms): hold the button until the page is connected. Connecting turns the light off;
 *   - once connected it stays on until TMROFF seconds without a press or a command (1 hour by default),
 *     PWROFF, or the disconnection: a disconnected PLB turns itself off.
 */
(function (global) {
  'use strict';

  const SERVICE = '6E400001-B5A3-F393-E0A9-E50E24DCCA9E';
  const RX = '6E400002-B5A3-F393-E0A9-E50E24DCCA9E';   // write: commands
  const TX = '6E400003-B5A3-F393-E0A9-E50E24DCCA9E';   // notify: answers and button events
  const NAME_HINTS = ['MA_POUCE', 'PLB'];
  const OK = '\r\nOK\r\n';
  const CHUNK = 20;                 // default ATT MTU − 3: the firmware does not need more
  const LOW_BATTERY_MV = 2950;      // the firmware's own "low battery" threshold (it shuts down under 2850)

  const MESSAGES = {
    fr: {
      noAura: "window.Aura indisponible : ouvrez cette page dans Aura, en HTTPS, sur un domaine présent dans vos favoris.",
      notTrusted: "Aura refuse le Bluetooth à cette page : ajoutez son domaine à vos favoris Aura, puis rechargez-la.",
      bluetooth: (s) => `Bluetooth indisponible (${s}).`,
      unauthorized: "Accès Bluetooth refusé : autorisez-le dans Réglages › Aura › Bluetooth.",
      poweredOff: 'Le Bluetooth est éteint : allumez-le et réessayez.',
      noAnswer: "Bluetooth sans réponse : acceptez la demande d'accès au Bluetooth, puis réessayez.",
      notFound: 'Aucun PLB trouvé. Maintenez son bouton appuyé pendant la connexion, puis réessayez.',
      notPLB: "Cet appareil n'a pas le service UART Nordic : ce n'est pas un PLB.",
      disconnected: 'PLB déconnecté.',
      notConnected: 'PLB non connecté.',
      noReply: (cmd) => `Pas de réponse du PLB à ${cmd}.`,
    },
    en: {
      noAura: 'window.Aura is unavailable: open this page in Aura, over HTTPS, on a domain in your bookmarks.',
      notTrusted: 'Aura refuses Bluetooth to this page: add its domain to your Aura bookmarks, then reload it.',
      bluetooth: (s) => `Bluetooth is unavailable (${s}).`,
      unauthorized: 'Bluetooth access was denied: allow it in Settings › Aura › Bluetooth.',
      poweredOff: 'Bluetooth is turned off: turn it on and try again.',
      noAnswer: 'Bluetooth does not answer: accept the Bluetooth access request, then try again.',
      notFound: 'No PLB found. Hold its button down while connecting, then try again.',
      notPLB: 'This device has no Nordic UART service: it is not a PLB.',
      disconnected: 'PLB disconnected.',
      notConnected: 'PLB is not connected.',
      noReply: (cmd) => `The PLB did not answer ${cmd}.`,
    },
  };
  const defaultLang = () =>
    ((global.navigator && navigator.language) || 'fr').toLowerCase().startsWith('fr') ? 'fr' : 'en';

  const sameUUID = (a, b) => {
    const norm = (u) => {
      u = String(u || '').toUpperCase();
      return u.length === 4 ? `0000${u}-0000-1000-8000-00805F9B34FB` : u;
    };
    return norm(a) === norm(b);
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ------------------------------------------------------------------ Stream parsing (pure, no Bluetooth)
  const BUTTON = /\+BTN: (PUSH|RELEASE|LONG)/;
  const BUTTON_EVENTS = { PUSH: 'push', RELEASE: 'release', LONG: 'longpress' };

  /**
   * Splits the text the PLB sends into button events and answers. Button events have no line ending
   * and may sit in front of an answer; an answer may be split across notifications.
   * feed(text) → [{ type: 'button', event: 'push' | 'release' | 'longpress' } | { type: 'answer', text }]
   */
  class StreamParser {
    constructor() { this.buffer = ''; }
    reset() { this.buffer = ''; }
    feed(text) {
      this.buffer += text;
      const out = [];
      for (;;) {
        const b = BUTTON.exec(this.buffer);
        const end = this.buffer.indexOf(OK);
        if (b && (end < 0 || b.index < end)) {
          const before = this.buffer.slice(0, b.index);
          this.buffer = before + this.buffer.slice(b.index + b[0].length);
          out.push({ type: 'button', event: BUTTON_EVENTS[b[1]] });
          continue;
        }
        if (end < 0) break;
        const answer = this.buffer.slice(0, end).replace(/^[\r\n]+/, '').trim();
        this.buffer = this.buffer.slice(end + OK.length);
        if (answer) out.push({ type: 'answer', text: answer });
      }
      // Never keep garbage forever (e.g. a lost "OK"): keep only a possible partial "+BTN: …" or answer.
      if (this.buffer.length > 512) this.buffer = this.buffer.slice(-64);
      return out;
    }
  }

  /** GETCFG_X answer (hex of the packed config struct, little-endian) → object, or null. */
  function parseConfig(hex) {
    if (!/^[0-9A-F]+$/i.test(hex) || hex.length < 30) return null;
    const b = hex.match(/../g).map((h) => parseInt(h, 16));
    const u32 = (i) => (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0;
    const u16 = (i) => b[i] | (b[i + 1] << 8);
    return {
      version: u32(0),
      autoOff: u32(4),                        // seconds
      channel: b[8],                          // radio channel of the (disabled) ESB buttons
      buttonIds: [u16(9), u16(11), u16(13)],  // paired ESB buttons, 0xFFFF = empty
    };
  }

  class AuraPLB {
    /** True when the page runs in Aura with the bridge active (HTTPS + bookmarked domain). */
    static isAvailable() {
      return !!(global.Aura && global.Aura.bluetooth);
    }

    /**
     * Finds the first PLB nearby and connects to it. Hold the PLB's button down meanwhile.
     * @param {{ timeout?: number, name?: string, nameHints?: string[], autoReconnect?: boolean,
     *           keepAwake?: boolean | number, lang?: 'fr'|'en' }} options
     */
    static async connect(options = {}) {
      const plb = new AuraPLB(options);
      await plb.connect();
      return plb;
    }

    constructor(options = {}) {
      this.options = Object.assign({ timeout: 20, autoReconnect: true, nameHints: NAME_HINTS, keepAwake: false }, options);
      this._t = MESSAGES[this.options.lang] || MESSAGES[defaultLang()];
      this.id = null;
      this.name = '';
      this.connected = false;
      this.pressed = false;        // button currently held
      this.level = 0;              // last light level sent, in %
      this._pressedAt = 0;
      this._long = false;
      this._listeners = {};
      this._parser = new StreamParser();
      this._decoder = new TextDecoder();
      this._encoder = new TextEncoder();
      this._waiters = [];
      this._queue = Promise.resolve();
      this._keepAwake = null;
      this._manual = false;
      this._unsubscribers = [];
    }

    // MARK: Connection

    async connect() {
      if (!AuraPLB.isAvailable()) throw new Error(this._t.noAura);
      const bt = global.Aura.bluetooth;
      this._manual = false;
      await this._ready();

      if (!this.id) {
        this._emit('status', { state: 'scanning' });
        const device = await this._find();
        this.id = device.id;
        this.name = device.name || 'PLB';
      }
      this._emit('status', { state: 'connecting', name: this.name });
      let info;
      try { info = await bt.connect(this.id, { timeout: this.options.timeout }); } catch (e) { throw this._bridgeError(e); }
      const services = (info && info.services) || [];
      if (services.length && !services.some((s) => sameUUID(s.uuid, SERVICE))) {
        try { await bt.disconnect(this.id); } catch (_) {}
        this.id = null;
        throw new Error(this._t.notPLB);
      }
      this._listen();
      this._parser.reset();
      this.pressed = false;
      this.level = 0;               // the firmware turns the light off when an app connects
      await bt.startNotifications(this.id, SERVICE, TX);
      this.connected = true;
      this._startKeepAwake();
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
            if ((s !== 'unknown' && s !== 'resetting') || Date.now() - t0 > AuraPLB.PERMISSION_TIMEOUT * 1000) {
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

    /** Unfiltered scan matched on the name (iOS only sees the NUS service in the scan response). */
    _find() {
      const bt = global.Aura.bluetooth;
      const matches = (name) => {
        const n = String(name || '').toUpperCase();
        if (!n) return false;
        if (this.options.name) return n === String(this.options.name).toUpperCase();
        return this.options.nameHints.some((h) => n.includes(String(h).toUpperCase()));
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
        Promise.resolve(bt.scan({ services: [] })).catch((e) => finish(reject, this._bridgeError(e)));
      });
    }

    _listen() {
      this._unsubscribers.forEach((off) => off());
      this._unsubscribers = [
        global.Aura.on('bluetooth.notification', (d) => {
          if (d.id !== this.id || !sameUUID(d.characteristic, TX)) return;
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
      this._stopKeepAwake();
      this._parser.reset();
      this._waiters.splice(0).forEach((w) => w.reject(new Error(this._t.disconnected)));
      if (this.pressed) {
        this.pressed = false;
        this._emit('release', { duration: Date.now() - this._pressedAt, long: this._long, lost: true });
      }
      if (was) {
        this._emit('status', { state: 'disconnected' });
        this._emit('disconnect', { manual: this._manual });
      }
    }

    /** A disconnected PLB is off: it comes back when someone holds its button. Keep trying until then. */
    async _reconnect() {
      let attempt = 0;
      while (!this._manual && !this.connected) {
        attempt++;
        this._emit('status', { state: 'reconnecting', attempt });
        await sleep(Math.min(1000 * attempt, 4000));
        if (this._manual || this.connected) return;
        try { await this.connect(); return; } catch (_) {}
      }
    }

    // The firmware resets its power-off countdown on every byte it receives: an empty line is enough.
    _startKeepAwake() {
      this._stopKeepAwake();
      const k = this.options.keepAwake;
      if (!k) return;
      const seconds = typeof k === 'number' ? k : 30;
      this._keepAwake = setInterval(() => { this.send('').catch(() => {}); }, seconds * 1000);
    }

    _stopKeepAwake() { clearInterval(this._keepAwake); this._keepAwake = null; }

    /** true (every 30 s), a number of seconds, or false: sends an empty command so the PLB never turns itself off. */
    setKeepAwake(value) {
      this.options.keepAwake = value;
      if (this.connected) this._startKeepAwake();
    }

    // MARK: Reception

    _receive(dataView) {
      const bytes = new Uint8Array(dataView.buffer, dataView.byteOffset, dataView.byteLength);
      const text = this._decoder.decode(bytes, { stream: true });
      this._emit('data', { text });
      for (const item of this._parser.feed(text)) {
        if (item.type === 'button') this._button(item.event);
        else this._answer(item.text);
      }
    }

    _button(event) {
      const now = Date.now();
      let detail;
      if (event === 'push') {
        this.pressed = true;
        this._pressedAt = now;
        this._long = false;
        detail = { event };
      } else if (event === 'longpress') {
        this._long = true;
        detail = { event, duration: now - this._pressedAt };
      } else {
        this.pressed = false;
        detail = { event, duration: now - this._pressedAt, long: this._long };
      }
      this._emit('button', detail);
      this._emit(event, detail);
      if (event === 'release' && !this._long) this._emit('click', detail);
    }

    _answer(text) {
      this._emit('message', { text });
      const i = this._waiters.findIndex((w) => w.match(text));
      if (i >= 0) {
        const [waiter] = this._waiters.splice(i, 1);
        waiter.resolve(text);
      }
    }

    // MARK: Sending

    /** Sends one raw command (the \n is added). Commands are queued: one write at a time. */
    send(command) {
      if (!this.connected) return Promise.reject(new Error(this._t.notConnected));
      const data = this._encoder.encode(String(command).replace(/[\r\n]+$/, '') + '\n');
      const bt = global.Aura.bluetooth;
      const job = this._queue.then(async () => {
        for (let offset = 0; offset < data.length; offset += CHUNK) {
          await bt.write(this.id, SERVICE, RX, data.subarray(offset, offset + CHUNK));
        }
      });
      this._queue = job.catch(() => {});
      return job;
    }

    /**
     * Sends a command and waits for the answer that starts with `prefix` (or passes the `prefix` function).
     * Resolves with the whole answer text, without the trailing OK.
     */
    query(command, prefix, timeout = AuraPLB.REPLY_TIMEOUT) {
      const match = typeof prefix === 'function' ? prefix : (text) => text.toUpperCase().startsWith(String(prefix).toUpperCase());
      return new Promise((resolve, reject) => {
        const waiter = { match, resolve, reject };
        const timer = setTimeout(() => {
          const i = this._waiters.indexOf(waiter);
          if (i >= 0) this._waiters.splice(i, 1);
          reject(new Error(this._t.noReply(command)));
        }, timeout);
        waiter.resolve = (v) => { clearTimeout(timer); resolve(v); };
        waiter.reject = (e) => { clearTimeout(timer); reject(e); };
        this._waiters.push(waiter);
        this.send(command).catch(waiter.reject);
      });
    }

    _value(text) { return text.slice(text.indexOf('=') + 1).trim(); }

    // MARK: Commands

    /** Light level in % (1 to 100); 0 turns it off. Resolves with the level the PLB applied. */
    async light(percent = 100) {
      const level = Math.max(0, Math.min(100, Math.round(Number(percent) || 0)));
      const applied = Number(this._value(await this.query('LAMPPWM=' + level, 'LAMPPWM=')));
      this.level = applied > 0 && applied <= 100 ? applied : 0;
      return this.level;
    }

    lightOff() { return this.light(0); }

    /** Battery voltage in millivolts (the PLB turns itself off under 2850 mV). */
    async battery() {
      return Number(this._value(await this.query('GET_BATT=', 'Batt=')));
    }

    /** { millivolts, low } — low under 2950 mV, the firmware's own warning threshold. */
    async batteryStatus() {
      const millivolts = await this.battery();
      return { millivolts, low: millivolts < LOW_BATTERY_MV };
    }

    /** { version: '010', build: 'Aug 24 2025 12:34:56' } */
    async firmware() {
      const v = this._value(await this.query('GET_VER', 'V='));
      const space = v.indexOf(' ');
      return space < 0 ? { version: v, build: '' } : { version: v.slice(0, space), build: v.slice(space + 1).trim() };
    }

    /** Bluetooth address, 12 hex digits ('C0…' for a random static address). */
    async address() {
      return this._value(await this.query('GET_ADD', 'ADD='));
    }

    /**
     * Seconds without a press or a command before the PLB turns itself off. Without an argument, reads it;
     * with one, sets and saves it (the firmware keeps at least 60). Resolves with the stored value.
     */
    async autoOff(seconds) {
      const arg = seconds == null ? '?' : String(Math.max(60, Math.round(seconds)));
      return Number(this._value(await this.query('TMROFF=' + arg, 'TimeBeforeOff=')));
    }

    /** Stored configuration: { version, autoOff, channel, buttonIds }. */
    async config() {
      return parseConfig(await this.query('GETCFG_X', (text) => /^[0-9A-F]{30,}$/i.test(text)));
    }

    /** Turns the PLB off (no answer: it disconnects). */
    async powerOff() {
      this._manual = true;
      await this.send('PWROFF');
    }

    /**
     * Restarts the PLB (no answer: it disconnects). After the restart it is not connected, so it goes back
     * to sleep unless its button is held; with autoReconnect the page reconnects when it is.
     */
    restart() { return this.send('RESTART'); }

    /** Factory settings (auto-off back to 1 hour). */
    factoryReset() { return this.query('FACT_RESET', 'Factory reset'); }

    // MARK: Events

    /**
     * 'push', 'release' ({ duration, long }), 'longpress' ({ duration }), 'click' (release of a short press),
     * 'button' (all three, with { event }), 'message' ({ text }: every answer), 'data' ({ text }: raw text),
     * 'discovered' (each device seen while scanning), 'status' ({ state: 'permission' | 'scanning' |
     * 'connecting' | 'connected' | 'reconnecting' | 'disconnected' }), 'connect', 'disconnect'. Returns off().
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

  AuraPLB.SERVICE = SERVICE;
  AuraPLB.RX_CHARACTERISTIC = RX;
  AuraPLB.TX_CHARACTERISTIC = TX;
  AuraPLB.NAME_HINTS = NAME_HINTS;
  AuraPLB.LOW_BATTERY_MV = LOW_BATTERY_MV;
  /** Milliseconds to wait for an answer. */
  AuraPLB.REPLY_TIMEOUT = 3000;
  /** Seconds left to the user to answer the iOS Bluetooth permission request. */
  AuraPLB.PERMISSION_TIMEOUT = 60;
  AuraPLB.StreamParser = StreamParser;
  AuraPLB.parseConfig = parseConfig;
  global.AuraPLB = AuraPLB;
})(window);
