/*!
 * aura-peeksmith.js — Pilote l'Electricks PeekSmith 3 depuis une page ouverte dans Aura.
 *
 * Utilise la passerelle Bluetooth LE de l'app (window.Aura.bluetooth) : aucune
 * modification de l'app ni de l'App Clip n'est nécessaire.
 *
 * Conditions : page en HTTPS, sur un domaine présent dans les favoris Aura
 * (ou sur le domaine de la page de l'App Clip).
 *
 *   const ps = await AuraPeekSmith.connect();
 *   ps.on('click', ({ button }) => console.log('bouton', button)); // 0 côté, 1 gauche, 2 droite
 *   await ps.text('Hello');
 *   await ps.vibrate('...');
 *
 * Contraintes du PeekSmith 3 gérées ici (cf. doc Electricks) :
 *  - il n'annonce pas son service : recherche par nom « PeekSmith- », sans filtre de service ;
 *  - les envois juste après la connexion sont perdus : attente de 1,5 s ;
 *  - 19 octets maximum par envoi et ~200 ms entre deux envois : file d'attente interne.
 *
 * Protocole : https://developers.electricks.info/docs/bluetooth/devices/peeksmith-3
 */
(function (global) {
  'use strict';

  const SERVICE = '0000FFE0-0000-1000-8000-00805F9B34FB';
  const MAIN = '0000FFE1-0000-1000-8000-00805F9B34FB';   // commandes texte + notifications
  const CUSTOM = '0000FFE2-0000-1000-8000-00805F9B34FB'; // commandes binaires (dés, cartes, images)
  const NAME_PREFIX = 'PeekSmith-';
  const CHUNK = 19;          // octets max par envoi
  const WRITE_GAP = 200;     // ms entre deux envois
  const READY_DELAY = 1500;  // ms après la connexion avant la première commande
  const BUTTON_EVENTS = ['press', 'release', 'click', 'longpress'];
  const BUTTON_NAMES = { 0: 'side', 1: 'left', 2: 'right' };

  const MESSAGES = {
    fr: {
      noAura: "window.Aura indisponible : ouvrez cette page dans Aura, en HTTPS, sur un domaine présent dans vos favoris.",
      disconnected: 'PeekSmith déconnecté.',
      notConnected: 'PeekSmith non connecté.',
      noReply: (cmd) => `Pas de réponse à ${cmd}`,
    },
    en: {
      noAura: 'window.Aura is unavailable: open this page in Aura, over HTTPS, on a domain in your bookmarks.',
      disconnected: 'PeekSmith disconnected.',
      notConnected: 'PeekSmith is not connected.',
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
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  class AuraPeekSmith {
    /** Vrai si la page tourne dans Aura avec la passerelle active (HTTPS + domaine en favori). */
    static isAvailable() {
      return !!(global.Aura && global.Aura.bluetooth);
    }

    /**
     * Cherche le premier PeekSmith à proximité et s'y connecte.
     * @param {{ timeout?: number, name?: string, autoReconnect?: boolean, lang?: 'fr' | 'en' }} options
     */
    static async connect(options = {}) {
      const ps = new AuraPeekSmith(options);
      await ps.connect();
      return ps;
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
      this._queue = Promise.resolve();
      this._lastWrite = 0;
      this._manualDisconnect = false;
      this._unsubscribers = [];
    }

    // MARK: Connexion

    async connect() {
      if (!AuraPeekSmith.isAvailable()) throw new Error(this._t.noAura);
      const bt = global.Aura.bluetooth;
      this._manualDisconnect = false;
      this._emit('status', { state: 'scanning' });

      if (!this.id) {
        // Le PeekSmith 3 n'annonce pas FFE0 : surtout pas de filtre de service.
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
      await bt.startNotifications(this.id, SERVICE, MAIN);
      // Les commandes envoyées trop tôt sont perdues sans erreur.
      await sleep(this.options.readyDelay != null ? this.options.readyDelay : READY_DELAY);
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
          if (d.id !== this.id || !sameUUID(d.characteristic, MAIN)) return;
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
        await sleep(1000 * attempt);
        try { await this.connect(); return; } catch (_) {}
      }
      if (!this.connected) this._emit('status', { state: 'disconnected' });
    }

    // MARK: Réception (FFE1)

    _receive(dataView) {
      const bytes = new Uint8Array(dataView.buffer, dataView.byteOffset, dataView.byteLength);
      this._buffer += this._decoder.decode(bytes, { stream: true });
      // Flux d'octets : une notification n'est pas un message, on découpe sur \n.
      let index;
      while ((index = this._buffer.indexOf('\n')) >= 0) {
        const line = this._buffer.slice(0, index).replace(/\r$/, '').trim();
        this._buffer = this._buffer.slice(index + 1);
        if (line) this._handleLine(line);
      }
    }

    _handleLine(line) {
      this._emit('line', { line });

      let m;
      if ((m = /^isb(\d+),(\w+)$/.exec(line))) {
        const button = Number(m[1]);
        const detail = { button, position: BUTTON_NAMES[button] || String(button), event: m[2], raw: line };
        this._emit('button', detail);
        if (BUTTON_EVENTS.includes(detail.event)) this._emit(detail.event, detail);
      } else if ((m = /^iets(\d+)$/.exec(line))) {
        this._emit('tap', { count: Number(m[1]) });
      } else if (line === 'iem') {
        this._emit('move', {});
      } else if (line === 'ievf') {
        this._emit('vibrationEnd', {});
      } else if ((m = /^ic([01])$/.exec(line))) {
        this._emit('charging', { charging: m[1] === '1' });
      } else if ((m = /^isa(-?\d+),(-?\d+),(-?\d+)$/.exec(line))) {
        this._emit('accelerometer', { x: Number(m[1]), y: Number(m[2]), z: Number(m[3]) });
      } else if ((m = /^ist(-?[\d.]+)$/.exec(line))) {
        this._emit('temperature', { celsius: Number(m[1]) });
      } else if (line === 'ik') {
        this._emit('keepalive', {});
      }

      // Réponses aux requêtes /?…
      const i = this._waiters.findIndex((w) => line.startsWith(w.prefix));
      if (i >= 0) {
        const [waiter] = this._waiters.splice(i, 1);
        waiter.resolve(line.slice(waiter.prefix.length).trim());
      }
    }

    // MARK: Envoi (file d'attente : 19 octets max, 200 ms d'écart)

    /** Envoie une commande texte brute (le \n final est ajouté si besoin). */
    send(command) {
      if (!this.connected) return Promise.reject(new Error(this._t.notConnected));
      const text = command.endsWith('\n') ? command : command + '\n';
      const bytes = this._encoder.encode(text);
      // Une commande à la fois : ses morceaux ne doivent pas se mélanger à ceux d'une autre.
      const job = this._queue.then(async () => {
        for (let offset = 0; offset < bytes.length; offset += CHUNK) {
          if (!this.connected) throw new Error(this._t.disconnected);
          const wait = this._lastWrite + WRITE_GAP - Date.now();
          if (wait > 0) await sleep(wait);
          await global.Aura.bluetooth.write(this.id, SERVICE, MAIN, bytes.subarray(offset, offset + CHUNK), { withoutResponse: true });
          this._lastWrite = Date.now();
        }
      });
      this._queue = job.catch(() => {});
      return job;
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

    // MARK: Écran

    /**
     * Affiche un texte. Retour à la ligne : '\n' dans le texte (converti en \r pour l'appareil).
     * { raw: true } désactive la reconnaissance des cartes (« AH » reste « AH »).
     */
    text(value, { raw = false } = {}) {
      const body = String(value).replace(/\r?\n/g, '\r');
      return this.send((raw ? "'" : '$') + body);
    }

    clear() { return this.send('$'); }

    /** Luminosité de 0 à 8. */
    brightness(level) {
      const n = Math.max(0, Math.min(8, Math.round(Number(level) || 0)));
      return this.send('/B' + n);
    }

    /** Police : 'au' (auto), '16', '24', '32', '64', 'ro' (Roboto, hébreu/arabe), 'uni'… */
    font(code = 'au') { return this.send('/Tf' + code); }

    /** Couleurs : nom à deux lettres (wh bk re gr bl ye or pu cy gy br pi) ou [r, g, b]. */
    textColor(color) { return this.send('/Tc' + (Array.isArray(color) ? color.join(',') : color)); }
    backgroundColor(color) { return this.send('/Tb' + (Array.isArray(color) ? color.join(',') : color)); }

    /** Alignement : 'left' | 'center' | 'right'. */
    align(where = 'center') { return this.send('/Ta' + ({ left: 'l', center: 'c', right: 'r' }[where] || 'c')); }

    /** Écran retourné (180°) et/ou en miroir — réglages enregistrés dans l'appareil. */
    rotate(upsideDown) { return this.send(upsideDown ? '/R2' : '/R0'); }
    mirror(on) { return this.send(on ? '/M1' : '/M0'); }

    // MARK: Vibration

    /** '.' court, '-' long, '=' très long, "'" tic, ' ' pause, '!' répète. */
    vibrate(pattern = '.') { return this.send('~' + pattern); }

    // MARK: Infos

    async battery() { return Number(await this.query('/?%', 'i%')); }
    async batteryVoltage() { return Number(await this.query('/?b', 'ib')); }
    async isCharging() { return (await this.query('/?c', 'ic')) === '1'; }
    firmware() { return this.query('/?f', 'if'); }

    // MARK: Capteurs (abonnements perdus à la déconnexion)

    subscribeTaps(on = true) { return this.send(on ? '/Sta' : '/Uta'); }
    subscribeMovement(on = true) { return this.send(on ? '/Sm' : '/Um'); }

    /** Éteint le PeekSmith (rallumage uniquement avec le bouton latéral). */
    powerOff() { return this.send('/X'); }

    // MARK: Événements

    /**
     * Événements : 'button' (tous), 'press', 'release', 'click', 'longpress',
     * 'tap' ({ count }), 'move', 'vibrationEnd', 'charging', 'accelerometer', 'temperature',
     * 'keepalive', 'line' (toute ligne reçue), 'status', 'connect', 'disconnect'.
     * Boutons : 0 = côté (power), 1 = avant gauche, 2 = avant droit.
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

  AuraPeekSmith.SERVICE = SERVICE;
  AuraPeekSmith.MAIN_CHARACTERISTIC = MAIN;
  AuraPeekSmith.CUSTOM_CHARACTERISTIC = CUSTOM;
  global.AuraPeekSmith = AuraPeekSmith;
})(window);
