/*! AuraKit 1.0.0 — a framework for web pages running in Aura Browser and the AuraClip App Clip.
 *
 * One script, no dependencies, no build step. It wraps the native `window.Aura` bridge and adds:
 *   AuraKit.ready()       environment detection (Aura Browser, App Clip, iframe, simulator, plain browser)
 *   AuraKit.haptics       one-line haptics, presets, Morse, fallbacks
 *   AuraKit.link()        iPhone-to-iPhone link: automatic pairing, reconnection, typed messages,
 *                         request/answer, state sync, shared state, messages larger than 64 KB
 *   AuraKit.ble           Bluetooth LE devices with notifications and automatic reconnection
 *   AuraKit.proximity     proximity sensor
 *   AuraKit.camera        camera, torch, snapshots
 *   AuraKit.device()      device identifiers
 *   AuraKit.quitAppClip() closes the App Clip
 *   iframes               pages inside an iframe get the same API through their parent page
 *
 * Reference: docs/API.md. */
(function (root) {
  'use strict';
  if (root.AuraKit) return;

  var VERSION = '1.0.0';
  var TAG = '__aurakit';
  var params = new URLSearchParams(location.search);
  var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  var uid = function () { return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4); };
  var inFrame = (function () { try { return window.self !== window.top; } catch (e) { return true; } })();
  var quiet = function (p) { if (p && typeof p.catch === 'function') p.catch(function () {}); return p; };

  // ------------------------------------------------------------------ Emitter
  class Emitter {
    constructor() { this._listeners = new Map(); }
    on(name, fn) {
      if (!this._listeners.has(name)) this._listeners.set(name, new Set());
      this._listeners.get(name).add(fn);
      return () => this.off(name, fn);
    }
    once(name, fn) { const off = this.on(name, (...a) => { off(); fn(...a); }); return off; }
    off(name, fn) { const set = this._listeners.get(name); if (set) set.delete(fn); }
    emit(name, ...args) {
      const set = this._listeners.get(name);
      if (!set) return;
      [...set].forEach((fn) => { try { fn(...args); } catch (e) { console.error('[AuraKit]', e); } });
    }
  }

  // Every native event, re-emitted here (works the same in iframes).
  var EVENTS = ['peer.connected', 'peer.message', 'peer.disconnected', 'bluetooth.discovered',
    'bluetooth.notification', 'bluetooth.state', 'bluetooth.disconnected', 'proximity'];
  var bus = new Emitter();
  var native = function () { return window.Aura || null; };
  (function subscribeNative() {
    var A = native();
    if (!A || typeof A.on !== 'function') return;
    EVENTS.forEach(function (name) { A.on(name, function (detail) { bus.emit(name, detail); }); });
  })();

  // ------------------------------------------------------------------ Calls (native or through the parent page)
  // Native functions an iframe may call through its parent page. The peer link goes through AuraKit.link() instead.
  var FRAME_CALLS = ['capabilities', 'deviceInfo', 'haptic', 'prepareHaptics', 'proximity.start', 'proximity.stop',
    'bluetooth.state', 'bluetooth.requestDevice', 'bluetooth.scan', 'bluetooth.stopScan', 'bluetooth.connect',
    'bluetooth.disconnect', 'bluetooth.read', 'bluetooth.write', 'bluetooth.startNotifications', 'bluetooth.stopNotifications'];

  function callNative(path, args) {
    var A = native();
    if (!A) return Promise.reject(new Error('Aura is not available on this page.'));
    var parts = path.split('.');
    var owner = A;
    for (var i = 0; i < parts.length - 1; i++) owner = owner && owner[parts[i]];
    var fn = owner && owner[parts[parts.length - 1]];
    if (typeof fn !== 'function') return Promise.reject(new Error('Aura.' + path + ' does not exist.'));
    try { return Promise.resolve(fn.apply(owner, args || [])); } catch (e) { return Promise.reject(e); }
  }

  var mode = 'none';           // 'native' | 'frame' | 'none' once ready() has run
  function call(path) {
    var args = Array.prototype.slice.call(arguments, 1);
    if (mode === 'frame') return frameChild.call(path, args);
    return callNative(path, args);
  }

  // ------------------------------------------------------------------ Environment
  var env = null;
  var readyPromise = null;
  var withTimeout = function (p, ms) {
    return Promise.race([p, new Promise(function (_, reject) { setTimeout(function () { reject(new Error('timeout')); }, ms); })]);
  };

  async function detect() {
    var e = { available: false, appClip: false, browser: false, caps: null, frame: inFrame, mock: false, reason: '', version: VERSION };
    var A = native();
    if (A) {
      try {
        e.caps = await withTimeout(callNative('capabilities'), 3000);
        e.available = true;
        e.mock = !!A.__mock;
        mode = 'native';
      } catch (err) {
        e.reason = err && err.message === 'timeout' ? 'Aura did not answer.' : (err && err.message) || String(err);
      }
    } else {
      e.reason = 'Not running in Aura (open the page in Aura Browser or the AuraClip App Clip, or add ?mock=host for the simulator).';
    }
    if (!e.available && inFrame) {
      var parentEnv = await frameChild.hello();
      if (parentEnv && parentEnv.available) {
        e.caps = parentEnv.caps;
        e.available = true;
        e.mock = parentEnv.mock;
        e.proxied = true;
        e.reason = '';
        mode = 'frame';
      }
    }
    if (e.available) {
      e.appClip = !!e.caps.appClip;
      e.browser = !e.appClip;
    } else if (location.protocol !== 'https:' && A) {
      e.reason += ' (the page must be served over HTTPS)';
    }
    env = e;
    return e;
  }

  function ready() { return readyPromise || (readyPromise = detect()); }

  // ------------------------------------------------------------------ iframe proxy: child side
  var frameChild = (function () {
    var pending = new Map();
    var parentOrigin = location.origin;
    var helloResolve = null;
    var linkListener = null;

    function post(msg) {
      msg[TAG] = 1;
      try { window.parent.postMessage(msg, parentOrigin === 'null' ? '*' : parentOrigin); } catch (e) { /* ignore */ }
    }
    if (inFrame) {
      window.addEventListener('message', function (ev) {
        var m = ev.data;
        if (!m || m[TAG] !== 1 || ev.source !== window.parent) return;
        if (parentOrigin !== '*' && ev.origin !== parentOrigin && parentOrigin !== 'null') return;
        switch (m.op) {
          case 'hello.ok': if (helloResolve) { helloResolve(m.env); helloResolve = null; } break;
          case 'result': {
            var p = pending.get(m.id);
            if (!p) return;
            pending.delete(m.id);
            if (m.ok) p.resolve(m.value); else p.reject(new Error(m.error));
            break;
          }
          case 'event': bus.emit(m.name, m.detail); break;
          default: if (m.op.indexOf('link.') === 0 && linkListener) linkListener(m);
        }
      });
    }
    return {
      setParentOrigin: function (o) { parentOrigin = o; },
      hello: function () {
        return new Promise(function (resolve) {
          helloResolve = resolve;
          post({ op: 'hello' });
          setTimeout(function () { if (helloResolve) { helloResolve(null); helloResolve = null; } }, 3500);
        });
      },
      // Request to the parent page, answered with op 'result'.
      rpc: function (msg, timeout) {
        return new Promise(function (resolve, reject) {
          var id = uid();
          msg.id = id;
          pending.set(id, { resolve: resolve, reject: reject });
          post(msg);
          setTimeout(function () {
            if (pending.has(id)) { pending.delete(id); reject(new Error('The parent page did not answer (' + (msg.path || msg.op) + ').')); }
          }, timeout || 10000);
        });
      },
      call: function (path, args) {
        return this.rpc({ op: 'call', path: path, args: args }, path.indexOf('bluetooth.') === 0 ? 60000 : 10000);
      },
      post: post,
      onLink: function (fn) { linkListener = fn; },
    };
  })();

  // ------------------------------------------------------------------ iframe proxy: parent side
  var frameHost = (function () {
    var allowed = [location.origin];      // origins whose frames may use Aura through this page
    var frames = new Map();               // source window -> origin
    var linked = new Map();               // source window -> origin, frames attached to the link

    function send(win, origin, msg) {
      msg[TAG] = 1;
      try { win.postMessage(msg, origin === 'null' ? '*' : origin); } catch (e) { frames.delete(win); linked.delete(win); }
    }
    function broadcast(map, msg) { map.forEach(function (origin, win) { send(win, origin, Object.assign({}, msg)); }); }

    window.addEventListener('message', async function (ev) {
      var m = ev.data;
      if (!m || m[TAG] !== 1 || !ev.source || ev.source === window) return;
      if (inFrame && ev.source === window.parent) return;      // answers from our own parent: handled by frameChild
      if (allowed.indexOf('*') < 0 && allowed.indexOf(ev.origin) < 0) return;
      var win = ev.source, origin = ev.origin;
      var e = await ready();
      if (mode !== 'native') {
        if (m.op === 'hello') send(win, origin, { op: 'hello.ok', env: null });
        return;
      }
      frames.set(win, origin);
      switch (m.op) {
        case 'hello': send(win, origin, { op: 'hello.ok', env: e }); break;
        case 'call':
          if (FRAME_CALLS.indexOf(m.path) < 0) { send(win, origin, { op: 'result', id: m.id, ok: false, error: 'Aura.' + m.path + ' is not available in an iframe.' }); return; }
          callNative(m.path, m.args).then(
            function (value) { send(win, origin, { op: 'result', id: m.id, ok: true, value: value }); },
            function (err) { send(win, origin, { op: 'result', id: m.id, ok: false, error: (err && err.message) || String(err) }); });
          break;
        case 'link.attach': {
          linked.set(win, origin);
          var l0 = link(m.options || {});      // the frame may be the first to ask for the link
          send(win, origin, { op: 'link.state', state: l0._snapshot() });
          break;
        }
        case 'link.send': {
          var l = mainLink;
          var ok = l ? await l._sendEnvelope({ t: m.t, d: m.d }, m.to) : false;
          // shared state changed in a frame: this page (and its other frames) see it too
          if (l && m.t === '~state') l._receive({ t: m.t, d: m.d }, 'frame');
          send(win, origin, { op: 'result', id: m.id, ok: true, value: ok });
          break;
        }
        case 'link.control': if (mainLink && typeof mainLink[m.action] === 'function' && ['start', 'stop', 'restart', 'setRoom'].indexOf(m.action) >= 0) mainLink[m.action].apply(mainLink, m.args || []); break;
      }
    });

    // Native events are forwarded to every frame that said hello (the peer link goes through link.* instead).
    EVENTS.forEach(function (name) {
      if (name.indexOf('peer.') === 0) return;
      bus.on(name, function (detail) { if (frames.size) broadcast(frames, { op: 'event', name: name, detail: detail }); });
    });

    return {
      allow: function (origins) { allowed = [].concat(origins || []); if (allowed.indexOf(location.origin) < 0) allowed.push(location.origin); },
      linkEvent: function (name, payload) { if (linked.size) broadcast(linked, { op: 'link.event', name: name, payload: payload }); },
    };
  })();

  // ------------------------------------------------------------------ Haptics
  var vibrate = function (pattern) { try { return !!(navigator.vibrate && navigator.vibrate(pattern)); } catch (e) { return false; } };
  var hapticsOn = function () { return env && env.available && env.caps && env.caps.haptics !== false; };

  function playNative() {
    var args = arguments;
    if (env) return hapticsOn() ? quiet(call.apply(null, ['haptic'].concat([].slice.call(args)))) : null;
    return ready().then(function () { return hapticsOn() ? quiet(call.apply(null, ['haptic'].concat([].slice.call(args)))) : null; });
  }

  var PRESETS = {
    tick: [{ time: 0, intensity: 0.6, sharpness: 1 }],
    double: [{ time: 0, intensity: 1, sharpness: 1 }, { time: 0.15, intensity: 1, sharpness: 1 }],
    triple: [{ time: 0, intensity: 1, sharpness: 1 }, { time: 0.13, intensity: 1, sharpness: 1 }, { time: 0.26, intensity: 1, sharpness: 1 }],
    heartbeat: [{ time: 0, intensity: 1, sharpness: 0.4 }, { time: 0.18, intensity: 0.7, sharpness: 0.3 }, { time: 0.9, intensity: 1, sharpness: 0.4 }, { time: 1.08, intensity: 0.7, sharpness: 0.3 }],
    knock: [{ time: 0, intensity: 1, sharpness: 0.2 }, { time: 0.25, intensity: 1, sharpness: 0.2 }, { time: 0.5, intensity: 1, sharpness: 0.2 }],
    alarm: [0, 0.25, 0.5, 0.75].map(function (t) { return { time: t, duration: 0.15, intensity: 1, sharpness: 0.8 }; }),
    ramp: [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7].map(function (t, i) { return { time: t, intensity: 0.2 + i * 0.11, sharpness: 0.5 }; }),
    drumroll: Array.from({ length: 16 }, function (_, i) { return { time: i * 0.05, intensity: 0.4 + i * 0.035, sharpness: 0.9 }; }).concat([{ time: 1.0, intensity: 1, sharpness: 1 }]),
    buzz: [{ time: 0, duration: 0.5, intensity: 1, sharpness: 0.3 }],
  };

  var MORSE = { a: '.-', b: '-...', c: '-.-.', d: '-..', e: '.', f: '..-.', g: '--.', h: '....', i: '..', j: '.---', k: '-.-', l: '.-..',
    m: '--', n: '-.', o: '---', p: '.--.', q: '--.-', r: '.-.', s: '...', t: '-', u: '..-', v: '...-', w: '.--', x: '-..-', y: '-.--',
    z: '--..', 0: '-----', 1: '.----', 2: '..---', 3: '...--', 4: '....-', 5: '.....', 6: '-....', 7: '--...', 8: '---..', 9: '----.' };

  // Pattern → navigator.vibrate list (fallback outside Aura, e.g. Android browsers).
  function toVibrate(events) {
    var list = [], at = 0;
    events.slice().sort(function (a, b) { return a.time - b.time; }).forEach(function (ev) {
      var start = Math.round(ev.time * 1000), len = Math.max(15, Math.round((ev.duration || 0.03) * 1000));
      if (list.length) list.push(Math.max(0, start - at)); else if (start > 0) list.push(0, start);
      list.push(len);
      at = start + len;
    });
    return list;
  }

  var haptics = {
    /** Raw call, same arguments as Aura.haptic(). */
    play: function () { return playNative.apply(null, arguments); },
    impact: function (style, intensity) {
      var o = { style: style || 'medium' };
      if (intensity != null) o.intensity = intensity;
      if (env && !hapticsOn()) { vibrate(style === 'heavy' || style === 'rigid' ? 30 : 15); return null; }
      return playNative('impact', o);
    },
    tap: function (style, intensity) { return haptics.impact(style || 'medium', intensity); },
    light: function () { return haptics.impact('light'); },
    medium: function () { return haptics.impact('medium'); },
    heavy: function () { return haptics.impact('heavy'); },
    soft: function () { return haptics.impact('soft'); },
    rigid: function () { return haptics.impact('rigid'); },
    success: function () { if (env && !hapticsOn()) vibrate([20, 60, 30]); return playNative('notification', { style: 'success' }); },
    warning: function () { if (env && !hapticsOn()) vibrate([30, 80, 30]); return playNative('notification', { style: 'warning' }); },
    error: function () { if (env && !hapticsOn()) vibrate([40, 60, 40, 60, 40]); return playNative('notification', { style: 'error' }); },
    selection: function () { if (env && !hapticsOn()) vibrate(8); return playNative('selection'); },
    /** Core Haptics pattern: [{ time, intensity, sharpness, duration }], times in seconds. */
    pattern: function (events) {
      if (!Array.isArray(events) || !events.length) return null;
      var run = function () {
        if (!hapticsOn()) { vibrate(toVibrate(events)); return null; }
        if (env.caps.customHaptics === false) {            // old hardware: a sequence of taps
          events.forEach(function (ev) { setTimeout(function () { quiet(call('haptic', 'impact', { style: 'heavy', intensity: ev.intensity == null ? 1 : ev.intensity })); }, ev.time * 1000); });
          return null;
        }
        return quiet(call('haptic', { type: 'pattern', events: events }));
      };
      return env ? run() : ready().then(run);
    },
    /** Continuous buzz. */
    buzz: function (seconds, intensity, sharpness) {
      return haptics.pattern([{ time: 0, duration: seconds == null ? 0.4 : seconds, intensity: intensity == null ? 1 : intensity, sharpness: sharpness == null ? 0.3 : sharpness }]);
    },
    /** Named pattern: tick, double, triple, heartbeat, knock, alarm, ramp, drumroll, buzz. */
    preset: function (name) {
      var p = PRESETS[name];
      if (!p) throw new Error('Unknown haptic preset: ' + name + ' (available: ' + Object.keys(PRESETS).join(', ') + ')');
      return haptics.pattern(p);
    },
    presets: PRESETS,
    /** Morse code: '.' and '-' or plain text. Returns the duration in seconds. */
    morse: function (text, options) {
      var unit = (options && options.unit) || 0.08, t = 0, events = [];
      var code = /^[\s.\-/]+$/.test(text) ? text : String(text).toLowerCase().split('').map(function (c) { return c === ' ' ? '/' : (MORSE[c] || ''); }).join(' ');
      code.split('').forEach(function (c) {
        if (c === '.') { events.push({ time: t, duration: unit, intensity: 1, sharpness: 0.6 }); t += unit * 2; }
        else if (c === '-') { events.push({ time: t, duration: unit * 3, intensity: 1, sharpness: 0.6 }); t += unit * 4; }
        else if (c === ' ') t += unit * 2;
        else if (c === '/') t += unit * 4;
      });
      haptics.pattern(events);
      return t;
    },
    morseCode: function (text) { return String(text).toLowerCase().split('').map(function (c) { return c === ' ' ? '/' : (MORSE[c] || ''); }).join(' '); },
    /** navigator.vibrate (works in Aura, no-op in Safari). */
    vibrate: vibrate,
    /** Removes the small latency of the first haptic. Called automatically on the first touch. */
    prepare: function () { return ready().then(function () { if (hapticsOn()) return quiet(call('prepareHaptics')); }); },
  };
  (function autoPrepare() {
    var done = false;
    var go = function () { if (done) return; done = true; haptics.prepare(); window.removeEventListener('pointerdown', go, true); };
    window.addEventListener('pointerdown', go, true);
  })();

  // ------------------------------------------------------------------ Device
  var deviceInfoPromise = null;
  function device() {
    return deviceInfoPromise || (deviceInfoPromise = ready().then(function (e) {
      if (!e.available || (e.caps && e.caps.deviceInfo === false)) return null;
      return call('deviceInfo').catch(function () { return null; });
    }));
  }

  // ------------------------------------------------------------------ Proximity
  var proxWatchers = new Set();
  var proximity = {
    near: false,
    /** fn({ near }) on each change. Resolves to { supported, near, stop() }. */
    watch: async function (fn) {
      var e = await ready();
      if (!e.available || (e.caps && e.caps.proximity === false)) return { supported: false, near: false, stop: function () {} };
      var off = bus.on('proximity', function (d) { proximity.near = !!(d && d.near); fn(d); });
      proxWatchers.add(off);
      var r;
      try { r = await call('proximity.start'); } catch (err) { off(); proxWatchers.delete(off); throw err; }
      proximity.near = !!(r && r.near);
      return {
        supported: !!(r && r.supported), near: proximity.near,
        stop: function () {
          if (!proxWatchers.has(off)) return;
          off(); proxWatchers.delete(off);
          if (!proxWatchers.size) quiet(call('proximity.stop'));
        },
      };
    },
  };

  // ------------------------------------------------------------------ Camera / torch
  var camera = {
    stream: null,
    facing: null,
    video: null,
    /** Opens the camera. options: { facing: 'environment' | 'user', audio, video: <video> element to show it in }. */
    open: async function (options) {
      var o = options || {};
      var facing = o.facing || 'environment';
      if (camera.stream && camera.facing === facing && !o.audio) { if (o.video) camera.attach(o.video); return camera.stream; }
      camera.close();
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error('Camera not available on this page.');
      camera.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: facing } }, audio: !!o.audio });
      camera.facing = facing;
      if (o.video) camera.attach(o.video);
      return camera.stream;
    },
    attach: function (video) {
      camera.video = video;
      video.setAttribute('playsinline', '');
      video.muted = true;
      video.srcObject = camera.stream;
      quiet(video.play());
    },
    track: function () { return camera.stream ? camera.stream.getVideoTracks()[0] : null; },
    hasTorch: function () {
      var t = camera.track();
      var c = t && t.getCapabilities ? t.getCapabilities() : null;
      return !!(c && c.torch);
    },
    /** Torch on/off (opens the back camera if needed). Resolves to the reported torch state. */
    torch: async function (on) {
      if (on === undefined) on = true;
      if (!camera.stream || camera.facing !== 'environment') {
        if (!on) return false;
        await camera.open({ facing: 'environment' });
      }
      var track = camera.track();
      await track.applyConstraints({ advanced: [{ torch: !!on }] });
      var s = track.getSettings ? track.getSettings() : {};
      return s.torch === undefined ? !!on : !!s.torch;
    },
    /** JPEG data URL of the current frame. options: { maxSize: 240, quality: 0.7, type: 'image/jpeg' }. */
    snapshot: async function (options) {
      var o = Object.assign({ maxSize: 240, quality: 0.7, type: 'image/jpeg' }, options);
      if (!camera.stream) await camera.open();
      var video = camera.video;
      if (!video) { video = document.createElement('video'); camera.attach(video); }
      if (!video.videoWidth) await new Promise(function (r) { video.addEventListener('loadeddata', r, { once: true }); setTimeout(r, 1500); });
      var w = video.videoWidth || 320, h = video.videoHeight || 240;
      var scale = Math.min(1, o.maxSize / Math.max(w, h));
      var canvas = document.createElement('canvas');
      canvas.width = Math.round(w * scale); canvas.height = Math.round(h * scale);
      canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
      return canvas.toDataURL(o.type, o.quality);
    },
    close: function () {
      if (camera.stream) camera.stream.getTracks().forEach(function (t) { t.stop(); });
      if (camera.video) camera.video.srcObject = null;
      camera.stream = null; camera.facing = null;
    },
  };

  // ------------------------------------------------------------------ Bluetooth LE
  // '0000180d-0000-1000-8000-00805f9b34fb', '180d' and '180D' all become '180D'.
  function shortUUID(u) {
    var s = String(u || '').toUpperCase();
    var m = /^0000([0-9A-F]{4})-0000-1000-8000-00805F9B34FB$/.exec(s);
    return m ? m[1] : s;
  }
  var decoder = new TextDecoder();
  function toBytes(v) {
    if (v instanceof DataView) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
    if (v instanceof ArrayBuffer) return new Uint8Array(v);
    if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
    if (Array.isArray(v)) return Uint8Array.from(v);
    return new TextEncoder().encode(String(v == null ? '' : v));
  }

  class BleDevice extends Emitter {
    constructor(info, options) {
      super();
      this.id = info.id;
      this.name = info.name || null;
      this.services = info.services || [];
      this.connected = true;
      this.options = Object.assign({ autoReconnect: false, timeout: 10, reconnectDelay: 1500 }, options);
      this._subs = new Map();          // 'SERVICE/CHAR' -> Set(fn)
      this._manual = false;
      this._offNotif = bus.on('bluetooth.notification', (d) => {
        if (!d || d.id !== this.id) return;
        const set = this._subs.get(shortUUID(d.service) + '/' + shortUUID(d.characteristic));
        if (set) set.forEach((fn) => { try { fn(d.value, d); } catch (e) { console.error(e); } });
        this.emit('notification', d);
      });
      this._offDisc = bus.on('bluetooth.disconnected', (d) => { if (d && d.id === this.id) this._dropped(); });
    }
    read(service, characteristic) { return call('bluetooth.read', this.id, service, characteristic); }
    async readText(service, characteristic) { return decoder.decode(toBytes(await this.read(service, characteristic))); }
    /** data: string, bytes, ArrayBuffer or typed array. options: { withoutResponse, chunkSize, delay (ms between chunks) }. */
    async write(service, characteristic, data, options) {
      const o = options || {};
      if (!o.chunkSize) return call('bluetooth.write', this.id, service, characteristic, data, { withoutResponse: !!o.withoutResponse });
      const bytes = toBytes(data);
      for (let i = 0; i < bytes.length; i += o.chunkSize) {
        await call('bluetooth.write', this.id, service, characteristic, Array.from(bytes.slice(i, i + o.chunkSize)), { withoutResponse: !!o.withoutResponse });
        if (o.delay && i + o.chunkSize < bytes.length) await sleep(o.delay);
      }
    }
    /** fn(DataView, detail) for each value. Resolves to a function that stops it. */
    async notify(service, characteristic, fn) {
      const key = shortUUID(service) + '/' + shortUUID(characteristic);
      const first = !this._subs.has(key);
      if (first) this._subs.set(key, new Set());
      this._subs.get(key).add(fn);
      if (first) await call('bluetooth.startNotifications', this.id, service, characteristic);
      return async () => {
        const set = this._subs.get(key);
        if (!set) return;
        set.delete(fn);
        if (!set.size) { this._subs.delete(key); if (this.connected) await quiet(call('bluetooth.stopNotifications', this.id, service, characteristic)); }
      };
    }
    async disconnect() {
      this._manual = true;
      this._offNotif(); this._offDisc();
      this.connected = false;
      await quiet(call('bluetooth.disconnect', this.id));
      this.emit('disconnect', { manual: true });
    }
    async _dropped() {
      if (!this.connected) return;
      this.connected = false;
      this.emit('disconnect', { manual: false });
      if (!this.options.autoReconnect || this._manual) return;
      this.emit('reconnecting');
      while (!this._manual) {
        try {
          const info = await call('bluetooth.connect', this.id, { timeout: this.options.timeout });
          this.services = info.services || this.services;
          this.connected = true;
          for (const key of this._subs.keys()) { const [s, c] = key.split('/'); await quiet(call('bluetooth.startNotifications', this.id, s, c)); }
          this.emit('reconnect');
          return;
        } catch (e) { await sleep(this.options.reconnectDelay); }
      }
    }
  }

  var ble = {
    state: function () { return call('bluetooth.state'); },
    /** First matching device: { id, name, rssi }. filter: { services, name, namePrefix, timeout }. */
    find: function (filter) { return call('bluetooth.requestDevice', filter || {}); },
    /** Continuous scan; onDevice({ id, name, rssi }). Resolves to an async stop() function. */
    scan: async function (filter, onDevice) {
      var seen = new Map();
      var off = bus.on('bluetooth.discovered', function (d) { seen.set(d.id, d); if (onDevice) onDevice(d, seen); });
      try { await call('bluetooth.scan', filter || {}); } catch (e) { off(); throw e; }
      return async function stop() { off(); await quiet(call('bluetooth.stopScan')); return [...seen.values()]; };
    },
    /** Finds (unless given a device or an id) and connects. Resolves to a BleDevice.
     * target: { services, name, namePrefix, timeout } | { id } | 'device-id'. options: { autoReconnect, timeout }. */
    connect: async function (target, options) {
      var o = options || {};
      var id = typeof target === 'string' ? target : target && target.id;
      var found = null;
      if (!id) { found = await ble.find(target); id = found.id; }
      var info = await call('bluetooth.connect', id, { timeout: o.timeout || (target && target.timeout) || 10 });
      if (!info.name && found) info.name = found.name;
      return new BleDevice(info, o);
    },
    text: function (value) { return decoder.decode(toBytes(value)); },
    bytes: toBytes,
    hex: function (value) { return Array.from(toBytes(value)).map(function (b) { return b.toString(16).padStart(2, '0'); }).join(' '); },
    shortUUID: shortUUID,
    Device: BleDevice,
  };

  // ------------------------------------------------------------------ Link between two iPhones
  var CHUNK_LIMIT = 60000;   // bytes of JSON; Aura.peer accepts 64 KB per message
  var CHUNK_SIZE = 16000;    // characters per chunk (at most 48 KB in UTF-8)
  var encoder = new TextEncoder();
  var mainLink = null;

  // One Link per page. In the main frame it drives Aura.peer; in an iframe it goes through the parent page's link.
  class Link extends Emitter {
    constructor(options) {
      super();
      var o = Object.assign({ room: undefined, role: 'auto', name: undefined, joinTimeout: 15, retryDelay: 3000,
        autoStart: true, urlParams: true, rememberRoom: true, debug: false }, options);
      this.options = o;
      this.id = uid();
      var room = o.room;
      if (o.urlParams && params.get('room')) room = params.get('room');
      if (room === undefined && o.rememberRoom) { try { room = localStorage.getItem('aurakit.room') || undefined; } catch (e) { /* ignore */ } }
      this.room = room ? String(room).toLowerCase() : undefined;
      var role = o.urlParams && params.get('role') ? params.get('role') : o.role;
      this.wantedRole = role === 'join' ? 'guest' : role;
      this.role = null;            // 'host' | 'guest' once started
      this.name = o.name;
      this.status = 'idle';        // idle | starting | waiting | searching | connected | error | stopped | unavailable
      this.error = null;
      this.peers = new Map();      // id -> name
      this.logs = [];
      this.transport = null;       // 'native' | 'frame'
      this._types = new Map();
      this._answers = new Map();
      this._pending = new Map();
      this._chunks = new Map();
      this._shared = new Map();
      this._stateCache = new Map();
      this._gen = 0;
      this._joining = false;
      this._started = false;
      this._offs = [];
      if (o.autoStart) this.start();
    }

    get connected() { return this.peers.size > 0; }
    get isHost() { return this.role === 'host'; }
    get isGuest() { return this.role === 'guest'; }

    // ---------------------------------------------------------------- public API
    /** Typed messages: fn(data, from). '*' receives everything: fn(type, data, from). Returns off(). */
    onMessage(type, fn) {
      if (!this._types.has(type)) this._types.set(type, new Set());
      this._types.get(type).add(fn);
      return () => { const s = this._types.get(type); if (s) s.delete(fn); };
    }
    /** Called when the link connects, to send your state: on the host each time a guest is ready, on the guest on connect. */
    onSync(fn) { return this.on('sync', fn); }

    /** Sends { type, data }. Resolves to true once handed to Bluetooth, false if not connected. options: { to }. */
    send(type, data, options) {
      if (typeof type !== 'string' || !type) throw new TypeError('link.send(type, data): type must be a non-empty string');
      return this._sendEnvelope({ t: type, d: data === undefined ? null : data }, options && options.to);
    }

    /** Asks the other iPhone and waits for its answer (see answer()). options: { timeout (ms, 8000), to }. */
    request(type, data, options) {
      var o = Object.assign({ timeout: 8000 }, options);
      var id = uid();
      return new Promise((resolve, reject) => {
        var timer = setTimeout(() => { this._pending.delete(id); reject(new Error('No answer to "' + type + '".')); }, o.timeout);
        this._pending.set(id, { resolve: resolve, reject: reject, timer: timer });
        this.send('~req', { id: id, type: type, data: data === undefined ? null : data }, o).then((ok) => {
          if (!ok && this._pending.has(id)) { clearTimeout(timer); this._pending.delete(id); reject(new Error('Not connected.')); }
        });
      });
    }
    /** fn(data, from) returns (or resolves to) the answer to request(type, …). Returns off(). */
    answer(type, fn) { this._answers.set(type, fn); return () => this._answers.delete(type); }

    /** A value kept identical on both iPhones (see SharedState). */
    shared(name, initial) {
      if (this._shared.has(name)) return this._shared.get(name);
      var s = new SharedState(this, name, initial);
      this._shared.set(name, s);
      var cached = this._stateCache.get(name);
      if (cached) s._remote(cached);
      return s;
    }

    /** Starts the link (called automatically unless autoStart: false). */
    async start() {
      if (this._started) return;
      this._started = true;
      var e = await ready();
      if (!e.available) { this._started = false; this._setStatus('unavailable', e.reason); this.log('Unavailable: ' + e.reason); return; }
      if (mode === 'frame') {
        this.transport = 'frame';
        frameChild.onLink((m) => this._fromParent(m));
        var o = Object.assign({}, this.options, { autoStart: true });
        frameChild.post({ op: 'link.attach', options: JSON.parse(JSON.stringify(o)) });
        return;
      }
      this.transport = 'native';
      if (e.caps && e.caps.peer === false) { this._started = false; this._setStatus('unavailable', 'Aura.peer is not available.'); return; }
      this.role = this.wantedRole === 'host' || this.wantedRole === 'guest' ? this.wantedRole : (e.appClip ? 'guest' : 'host');
      if (!this.name) this.name = e.appClip ? 'App Clip' : 'Aura Browser';
      if (!this._offs.length) {
        this._offs.push(bus.on('peer.connected', (d) => this._connected(d.id, d.name)));
        this._offs.push(bus.on('peer.disconnected', (d) => this._disconnected(d.id)));
        this._offs.push(bus.on('peer.message', (m) => this._receive(this._decode(m), m.from)));
      }
      this.log('Role: ' + (this.isHost ? 'host (waits for the other iPhone)' : 'guest (looks for the other iPhone)') +
        ' · room: ' + (this.room ? '"' + this.room + '"' : 'automatic (App Clip link)'));
      var gen = ++this._gen;
      if (this.isHost) this._host(gen); else this._join(gen);
    }

    /** Closes the link until start() or restart(). */
    async stop() {
      if (this.transport === 'frame') return frameChild.post({ op: 'link.control', action: 'stop' });
      this._gen++;
      this._started = false;
      this._joining = false;
      await quiet(callNative('peer.leave'));
      var had = [...this.peers];
      this.peers.clear();
      had.forEach((p) => { this.emit('disconnect', { id: p[0], name: p[1] }); frameHost.linkEvent('disconnect', { id: p[0], name: p[1] }); });
      this._setStatus('stopped');
      this.log('Link stopped');
    }

    /** Closes and opens the link again. */
    async restart() {
      if (this.transport === 'frame') return frameChild.post({ op: 'link.control', action: 'restart' });
      this.log('Restarting the link');
      await this.stop();
      await sleep(400);
      return this.start();
    }

    /** Changes the room (same code on both iPhones; empty = automatic pairing) and restarts the link. */
    setRoom(code, options) {
      if (this.transport === 'frame') return frameChild.post({ op: 'link.control', action: 'setRoom', args: [code] });
      var room = code ? String(code).trim().toLowerCase() : '';
      this.room = room || undefined;
      if (this.options.rememberRoom && !(options && options.remember === false)) {
        try { if (room) localStorage.setItem('aurakit.room', room); else localStorage.removeItem('aurakit.room'); } catch (e) { /* ignore */ }
      }
      this.log('Room: ' + (room ? '"' + room + '"' : 'automatic'));
      return this.restart();
    }

    /** Sends a raw value with Aura.peer.send, for pages that do not use AuraKit (main frame only). */
    sendRaw(data, options) { return callNative('peer.send', [data, options].filter(Boolean)); }

    log(text) {
      var line = { time: new Date(), text: String(text) };
      this.logs.unshift(line);
      if (this.logs.length > 200) this.logs.length = 200;
      if (this.options.debug) console.log('[AuraKit link]', line.text);
      this.emit('log', line);
      if (this.transport !== 'frame') frameHost.linkEvent('log', { time: +line.time, text: line.text });
    }

    // ---------------------------------------------------------------- internals
    _setStatus(status, error) {
      var changed = this.status !== status || (error || null) !== this.error;
      this.status = status;
      this.error = error || null;
      if (!changed) return;
      this.emit('status', status, this.error);
      if (this.transport !== 'frame') frameHost.linkEvent('state', this._snapshot());
    }
    _snapshot() {
      return { status: this.status, error: this.error, role: this.role, room: this.room || null,
        peers: [...this.peers].map(function (p) { return { id: p[0], name: p[1] }; }) };
    }

    _sendEnvelope(env, to) {
      if (!this.connected) return Promise.resolve(false);
      if (this.transport === 'frame') {
        return frameChild.rpc({ op: 'link.send', t: env.t, d: env.d, to: to || null }, 20000).then(Boolean, function () { return false; });
      }
      return this._sendNative(env, to);
    }
    async _sendNative(env, to) {
      var opts = to ? [{ to: to }] : [];
      var json = JSON.stringify(env);
      try {
        if (json.length * 3 <= CHUNK_LIMIT || encoder.encode(json).length <= CHUNK_LIMIT) {
          await callNative('peer.send', [env].concat(opts));
          return true;
        }
        var id = uid(), n = Math.ceil(json.length / CHUNK_SIZE);   // too big: sent in pieces, put back together on arrival
        for (var i = 0; i < n; i++) {
          await callNative('peer.send', [{ t: '~chunk', d: { id: id, i: i, n: n, s: json.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE) } }].concat(opts));
        }
        return true;
      } catch (e) {
        this.log('send failed: ' + e.message);
        return false;
      }
    }

    _decode(msg) {
      var data = msg.data;
      if (msg.kind === 'text') return { t: 'text', d: data };
      if (msg.kind === 'binary') return { t: 'binary', d: data };
      // { t, d } from AuraKit; { t, …fields } from other pages (data is then the whole object)
      if (data && typeof data === 'object' && typeof data.t === 'string') return { t: data.t, d: 'd' in data ? data.d : data };
      return { t: 'json', d: data };
    }

    // Message from the other iPhone (or forwarded by the parent page).
    _receive(env, from) {
      var type = env.t, data = env.d;
      if (type === '~chunk') return this._chunk(data, from);
      if (type === '~sync') { if (this.isHost && this.transport === 'native') this._sync(from); return; }
      if (this.transport === 'native') frameHost.linkEvent('message', { t: type, d: data, from: from });
      if (type === '~req') { this._answer(data, from); return; }
      if (type === '~res') {
        var p = this._pending.get(data && data.id);
        if (!p) return;
        this._pending.delete(data.id); clearTimeout(p.timer);
        if (data.error) p.reject(new Error(data.error)); else p.resolve(data.data);
        return;
      }
      if (type === '~state') {
        this._stateCache.set(data.name, data);
        var s = this._shared.get(data.name);
        if (s) s._remote(data);
        return;
      }
      if (type.charAt(0) === '~') return;
      var set = this._types.get(type);
      if (set) set.forEach(function (fn) { try { fn(data, from); } catch (e) { console.error('[AuraKit]', e); } });
      var all = this._types.get('*');
      if (all) all.forEach(function (fn) { try { fn(type, data, from); } catch (e) { console.error('[AuraKit]', e); } });
      this.emit('message', type, data, from);
    }
    async _answer(req, from) {
      var fn = req && this._answers.get(req.type);
      if (!fn) return;              // an iframe may answer it; otherwise the requester times out
      try { this.send('~res', { id: req.id, data: await fn(req.data, from) }, { to: from }); }
      catch (e) { this.send('~res', { id: req.id, error: (e && e.message) || String(e) }, { to: from }); }
    }
    _chunk(c, from) {
      var key = from + '/' + c.id;
      var entry = this._chunks.get(key) || { parts: [], count: 0 };
      if (entry.parts[c.i] === undefined) { entry.parts[c.i] = c.s; entry.count++; }
      this._chunks.set(key, entry);
      this.emit('progress', { id: c.id, received: entry.count, total: c.n, from: from });
      if (entry.count < c.n) return;
      this._chunks.delete(key);
      var env;
      try { env = JSON.parse(entry.parts.join('')); } catch (e) { console.warn('[AuraKit] bad chunked message'); return; }
      this._receive(env, from);
    }
    _sync(peer) {
      this.emit('sync', { peer: peer, role: this.role });
      if (this.transport === 'native') frameHost.linkEvent('sync', { peer: peer });
      if (this.isHost) this._shared.forEach(function (s) { s._push(true); });
    }

    // ---- Aura.peer (main frame)
    _connected(id, name) {
      var isNew = !this.peers.has(id);
      this.peers.set(id, name || null);
      if (!isNew) return;
      this.log('Connected to ' + (name || id));
      this._setStatus('connected');
      this.emit('connect', { id: id, name: name || null });
      frameHost.linkEvent('connect', { id: id, name: name || null });
      frameHost.linkEvent('state', this._snapshot());
      if (this.isGuest) {           // the guest asks for the host's state once it is ready to receive it
        this._sendNative({ t: '~sync', d: null });
        this._sync(id);
      }
    }
    _disconnected(id) {
      if (!this.peers.has(id)) return;
      var name = this.peers.get(id);
      this.peers.delete(id);
      this.log('Disconnected from ' + (name || id));
      this.emit('disconnect', { id: id, name: name });
      frameHost.linkEvent('disconnect', { id: id, name: name });
      if (this.connected) { frameHost.linkEvent('state', this._snapshot()); return; }
      if (this.isHost) this._setStatus('waiting');   // still advertising: the guest can come back
      else if (this._started) this._join(this._gen);
    }
    async _host(gen) {
      var attempt = 0;
      while (gen === this._gen) {
        attempt++;
        this._setStatus('starting');
        try {
          var r = await callNative('peer.host', [{ room: this.room, name: this.name }]);
          if (gen !== this._gen) return;
          this.log('Advertising' + (r && r.room ? ' (room ' + r.room + ')' : '') + ', waiting for the other iPhone');
          this._setStatus(this.connected ? 'connected' : 'waiting');
          return;
        } catch (e) {
          if (gen !== this._gen) return;
          this.log('host() failed' + (attempt > 1 ? ' (attempt ' + attempt + ')' : '') + ': ' + e.message);
          this._setStatus('error', e.message);
          this.emit('error', e);
          await sleep(this.options.retryDelay);     // Bluetooth off, permission prompt open…: try again
        }
      }
    }
    async _join(gen) {
      if (this._joining || this.connected) return;
      this._joining = true;
      this._setStatus('searching');
      var attempt = 0;
      while (!this.connected && gen === this._gen) {
        attempt++;
        if (attempt === 1 || attempt % 5 === 0) this.log('join() — searching (attempt ' + attempt + ')');
        try {
          var host = await callNative('peer.join', [{ room: this.room, name: this.name, timeout: this.options.joinTimeout }]);
          if (gen !== this._gen) break;
          this._connected(host.id, host.name);
        } catch (e) {
          if (gen !== this._gen) break;
          if (/no device is hosting/i.test(e.message)) {
            this._setStatus('searching');
            if (attempt === 1) this.log('No host found yet, still searching…');
          } else {
            this.log('join() failed: ' + e.message);
            this._setStatus('error', e.message);
            this.emit('error', e);
          }
          await sleep(1500);
        }
      }
      this._joining = false;
    }

    // ---- iframe: events from the parent page's link
    _fromParent(m) {
      if (m.op === 'link.state') return this._apply(m.state);
      if (m.op !== 'link.event') return;
      var p = m.payload;
      switch (m.name) {
        case 'state': this._apply(p); break;
        case 'log': {
          var line = { time: new Date(p.time), text: p.text };
          this.logs.unshift(line);
          if (this.logs.length > 200) this.logs.length = 200;
          this.emit('log', line);
          break;
        }
        case 'connect': if (!this.peers.has(p.id)) { this.peers.set(p.id, p.name); this.emit('connect', p); } break;
        case 'disconnect': if (this.peers.delete(p.id)) this.emit('disconnect', p); break;
        case 'sync': this._sync(p.peer); break;
        case 'message': this._receive({ t: p.t, d: p.d }, p.from); break;
      }
    }
    _apply(s) {
      this.role = s.role;
      this.room = s.room || undefined;
      var before = new Map(this.peers);
      this.peers = new Map(s.peers.map(function (p) { return [p.id, p.name]; }));
      this.peers.forEach((name, id) => { if (!before.has(id)) this.emit('connect', { id: id, name: name }); });
      before.forEach((name, id) => { if (!this.peers.has(id)) this.emit('disconnect', { id: id, name: name }); });
      if (this.status !== s.status || this.error !== s.error) { this.status = s.status; this.error = s.error; this.emit('status', s.status, s.error); }
    }
  }

  // ---- Shared state: the same value on both iPhones (last write wins; the host's value wins when they connect)
  class SharedState extends Emitter {
    constructor(link, name, initial) {
      super();
      this.link = link;
      this.name = name;
      this.value = clone(initial === undefined ? null : initial);
      this.stamp = { ts: 0, by: '' };
    }
    get() { return this.value; }
    /** Replaces the value and sends it. */
    set(value) {
      this.value = clone(value);
      this.stamp = { ts: Math.max(Date.now(), this.stamp.ts + 1), by: this.link.id };   // always newer than the last value seen
      this.emit('change', this.value, { local: true });
      this._push(false);
      return this.value;
    }
    /** Merges an object into the value (shallow). */
    patch(partial) { return this.set(Object.assign({}, this.value, partial)); }
    /** fn(copy of the current value) returns the new value. */
    update(fn) { return this.set(fn(clone(this.value))); }
    /** fn(value, { local }) now and on each change. Returns off(). */
    subscribe(fn) { fn(this.value, { local: true, initial: true }); return this.on('change', fn); }
    _push(full) { this.link.send('~state', { name: this.name, value: this.value, ts: this.stamp.ts, by: this.stamp.by, full: !!full }); }
    _remote(m) {
      if (m.full) { if (this.link.isHost) return; }          // on connect the guest takes the host's value
      else if (!(m.ts > this.stamp.ts || (m.ts === this.stamp.ts && m.by > this.stamp.by))) return;
      this.value = m.value;
      this.stamp = { ts: m.ts, by: m.by };
      this.emit('change', this.value, { local: false });
    }
  }
  function clone(v) { return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); }

  /** The page's link to the other iPhone. Created on the first call; later calls return the same object. */
  function link(options) {
    if (!mainLink) mainLink = new Link(options || {});
    return mainLink;
  }

  // ------------------------------------------------------------------ Quitting the App Clip
  // iOS gives an App Clip no way to close itself. This relies on a crash in the native bridge: Aura.peer.join
  // converts its timeout to nanoseconds without a bound, so an oversized value overflows and iOS kills the
  // App Clip. If the bridge ever bounds that value, the call settles and the promise rejects instead.
  var QUIT_TIMEOUT = 1e300;
  async function quitAppClip() {
    await ready();
    if (!env.available) throw new Error('Aura is not available on this page.');
    if (!env.appClip) throw new Error('quitAppClip() only works in the AuraClip App Clip.');
    if (mode !== 'native') throw new Error('quitAppClip() must be called from the main page, not from an iframe.');
    try { await callNative('peer.join', [{ room: '~quit-' + uid(), timeout: QUIT_TIMEOUT }]); } catch (e) { /* see below */ }
    throw new Error('The App Clip did not quit (check that Bluetooth is on and allowed).');
  }

  // ------------------------------------------------------------------ Public API
  var AuraKit = {
    version: VERSION,
    ready: ready,
    get env() { return env; },
    get available() { return !!(env && env.available); },
    get isAppClip() { return !!(env && env.appClip); },
    get isBrowser() { return !!(env && env.browser); },
    get inFrame() { return inFrame; },
    /** Native events (bluetooth.*, proximity, peer.*). Returns off(). */
    on: function (name, fn) { return bus.on(name, fn); },
    off: function (name, fn) { bus.off(name, fn); },
    /** Raw call: AuraKit.call('bluetooth.state'). */
    call: function () { var a = arguments; return ready().then(function () { return call.apply(null, a); }); },
    haptics: haptics,
    haptic: function () { return haptics.play.apply(null, arguments); },
    device: device,
    proximity: proximity,
    camera: camera,
    ble: ble,
    link: link,
    /** App Clip only: closes the App Clip. Never resolves when it works; rejects otherwise. */
    quitAppClip: quitAppClip,
    frames: {
      /** Parent page: lets frames from these origins use Aura (same origin is always allowed). */
      allow: frameHost.allow,
      /** Iframe: origin of the parent page when it differs from the iframe's. */
      parentOrigin: frameChild.setParentOrigin,
    },
    Emitter: Emitter,
    params: params,
    sleep: sleep,
  };
  root.AuraKit = AuraKit;
})(window);
