/*!
 * aura-atom.js — Pilote l'Electricks Atom 2 depuis une page ouverte dans Aura.
 *
 * Utilise la passerelle Bluetooth LE de l'app (window.Aura.bluetooth) : aucune
 * modification de l'app ni de l'App Clip n'est nécessaire.
 *
 * Conditions : page en HTTPS, sur un domaine présent dans les favoris Aura
 * (ou sur le domaine de la page de l'App Clip).
 *
 *   const atom = await AuraAtom.connect();
 *   atom.on('click', ({ button }) => console.log('bouton', button));
 *   atom.vibrate('...');
 *   atom.led('g');
 *
 * Protocole : https://developers.electricks.info/docs/bluetooth/devices/atom-2
 */
(function (global) {
  'use strict';

  const SERVICE = '0000FFE0-0000-1000-8000-00805F9B34FB';
  const TEXT = '0000FFE1-0000-1000-8000-00805F9B34FB';   // commandes texte + notifications
  const BINARY = '0000FFE2-0000-1000-8000-00805F9B34FB'; // commandes binaires (MagiScript, fichiers)
  const NAME_PREFIX = 'Atom-2';
  const BUTTON_EVENTS = ['press', 'release', 'click', 'longpress', 'repeatpress'];

  const MESSAGES = {
    fr: {
      noAura: "window.Aura indisponible : ouvrez cette page dans Aura, en HTTPS, sur un domaine présent dans vos favoris.",
      disconnected: 'Atom déconnecté.',
      notConnected: 'Atom non connecté.',
      noReply: (cmd) => `Pas de réponse à ${cmd}`,
    },
    en: {
      noAura: 'window.Aura is unavailable: open this page in Aura, over HTTPS, on a domain in your bookmarks.',
      disconnected: 'Atom disconnected.',
      notConnected: 'Atom is not connected.',
      noReply: (cmd) => `No reply to ${cmd}`,
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

  class AuraAtom {
    /** Vrai si la page tourne dans Aura avec la passerelle active (HTTPS + domaine en favori). */
    static isAvailable() {
      return !!(global.Aura && global.Aura.bluetooth);
    }

    /**
     * Cherche le premier Atom 2 à proximité et s'y connecte.
     * @param {{ timeout?: number, name?: string, autoReconnect?: boolean, lang?: 'fr' | 'en' }} options
     */
    static async connect(options = {}) {
      const atom = new AuraAtom(options);
      await atom.connect();
      return atom;
    }

    constructor(options = {}) {
      this.options = Object.assign({ timeout: 15, autoReconnect: true }, options);
      this._t = MESSAGES[this.options.lang] || MESSAGES[defaultLang()];
      this.id = null;
      this.name = '';
      this.connected = false;
      this._listeners = {};
      this._buffer = '';
      this._decoder = new TextDecoder();
      this._encoder = new TextEncoder();
      this._waiters = [];
      this._manualDisconnect = false;
      this._unsubscribers = [];
    }

    // MARK: Connexion

    async connect() {
      if (!AuraAtom.isAvailable()) {
        throw new Error(this._t.noAura);
      }
      const bt = global.Aura.bluetooth;
      this._manualDisconnect = false;
      this._emit('status', { state: 'scanning' });

      if (!this.id) {
        // Pas de filtre par service : iOS ne retient que les services annoncés dans la publicité,
        // et l'Atom n'annonce pas forcément FFE0. Le filtre sur le nom suffit.
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
      await bt.startNotifications(this.id, SERVICE, TEXT);
      this.connected = true;
      this._emit('status', { state: 'connected', name: this.name, id: this.id });
      this._emit('connect', { name: this.name, id: this.id });
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
          if (d.id !== this.id || !sameUUID(d.characteristic, TEXT)) return;
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
      this._waiters.splice(0).forEach((w) => w.reject(new Error(this._t.disconnected)));
      if (was) {
        this._emit('status', { state: 'disconnected' });
        this._emit('disconnect', {});
      }
    }

    async _reconnect() {
      for (let attempt = 1; attempt <= 5 && !this._manualDisconnect && !this.connected; attempt++) {
        this._emit('status', { state: 'reconnecting', attempt });
        await new Promise((r) => setTimeout(r, 1000 * attempt));
        try { await this.connect(); return; } catch (_) {}
      }
      if (!this.connected) this._emit('status', { state: 'disconnected' });
    }

    // MARK: Réception (FFE1)

    _receive(dataView) {
      const bytes = new Uint8Array(dataView.buffer, dataView.byteOffset, dataView.byteLength);
      this._buffer += this._decoder.decode(bytes, { stream: true });
      // Une notification n'est pas forcément un message : on découpe sur \n.
      let index;
      while ((index = this._buffer.indexOf('\n')) >= 0) {
        const line = this._buffer.slice(0, index).replace(/\r$/, '');
        this._buffer = this._buffer.slice(index + 1);
        if (line) this._handleLine(line);
      }
    }

    _handleLine(line) {
      this._emit('line', { line });

      const button = /^isb(\d+),(\w+)$/.exec(line);
      if (button) {
        const detail = { button: Number(button[1]), event: button[2], raw: line };
        const multi = /^click(\d+)$/.exec(detail.event);
        if (multi) detail.clicks = Number(multi[1]);
        else if (detail.event === 'click') detail.clicks = 1;
        this._emit('button', detail);
        if (multi) this._emit('multiclick', detail);
        if (BUTTON_EVENTS.includes(detail.event) || multi) this._emit(detail.event, detail);
        return;
      }

      // Réponses aux requêtes /?…
      const i = this._waiters.findIndex((w) => line.startsWith(w.prefix));
      if (i >= 0) {
        const [waiter] = this._waiters.splice(i, 1);
        waiter.resolve(line.slice(waiter.prefix.length).trim());
      }
    }

    // MARK: Envoi

    /** Envoie une commande texte brute (le \n final est ajouté si besoin). */
    async send(command) {
      if (!this.connected) throw new Error(this._t.notConnected);
      const text = command.endsWith('\n') ? command : command + '\n';
      await global.Aura.bluetooth.write(this.id, SERVICE, TEXT, this._encoder.encode(text));
    }

    /** Envoie une commande /?… et attend la réponse commençant par `prefix`. */
    query(command, prefix, timeout = 5000) {
      return new Promise((resolve, reject) => {
        const waiter = { prefix, resolve, reject };
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

    async battery() { return Number(await this.query('/?b', 'ib')); }
    async isCharging() { return (await this.query('/?l', 'il')) === '1'; }
    firmware() { return this.query('/?f', 'if'); }

    /** Vibration façon morse : '.' court, '-' long, '=' très long, ' ' pause. */
    vibrate(pattern = '.') { return this.send('~' + pattern); }

    /** LED : r g b y o p w c, ou null pour éteindre. { blink: true } pour clignoter. */
    led(color, { blink = false } = {}) {
      if (!color) return this.send('%');
      return this.send(`%${color}-${blink ? '*' : ''}`);
    }

    /** Délais des boutons en ms : { click, longPress, repeatDelay, repeatInterval }. */
    async configureButtons({ click, longPress, repeatDelay, repeatInterval } = {}) {
      if (click != null) await this.send(`/P1${click}`);
      if (longPress != null) await this.send(`/PL${longPress}`);
      if (repeatDelay != null) await this.send(`/PR${repeatDelay}`);
      if (repeatInterval != null) await this.send(`/PI${repeatInterval}`);
    }

    /** Envoie un script MagiScript (FFE2) puis le compile. */
    async runScript(code) {
      if (!this.connected) throw new Error(this._t.notConnected);
      const data = this._encoder.encode(code);
      const bt = global.Aura.bluetooth;
      for (let offset = 0; offset < data.length; offset += 256) {
        const chunk = data.subarray(offset, offset + 256);
        const packet = new Uint8Array(3 + chunk.length);
        packet.set([0x01, offset & 0xff, (offset >> 8) & 0xff]);
        packet.set(chunk, 3);
        await bt.write(this.id, SERVICE, BINARY, packet, { withoutResponse: true });
        await new Promise((r) => setTimeout(r, 15));
      }
      await bt.write(this.id, SERVICE, BINARY, [0x02], { withoutResponse: true });
    }

    // MARK: Événements

    /**
     * Événements : 'button' (tous), 'press', 'release', 'click', 'multiclick', 'click2', 'click3'…,
     * 'longpress', 'repeatpress', 'line' (toute ligne reçue), 'status', 'connect', 'disconnect'.
     * Retourne une fonction pour se désabonner.
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

  AuraAtom.SERVICE = SERVICE;
  AuraAtom.TEXT_CHARACTERISTIC = TEXT;
  AuraAtom.BINARY_CHARACTERISTIC = BINARY;
  global.AuraAtom = AuraAtom;
})(window);
