/*! AuraKit simulator — a fake window.Aura for testing pages on a computer. Never active inside Aura.
 *
 * Load it BEFORE aurakit.js. It does nothing unless the URL contains ?mock=…
 *   ?mock=host    behaves like Aura Browser   (appClip: false)
 *   ?mock=join    behaves like the App Clip    (appClip: true)
 * Open two tabs of the same browser (one host, one join): Aura.peer goes through BroadcastChannel,
 * so the iPhone-to-iPhone link, messages, shared state and rooms work between the tabs.
 * Haptics are logged to the console. Press P to toggle the proximity sensor while it is watched.
 * Volume buttons: press + (or =) and - while they are watched. Status bar and rotation lock are logged.
 * Glass buttons (experimental): drawn as CSS glass, outlined in pink, where Aura would put the native ones.
 * Bluetooth LE: "Mock Sensor", with a counter notifying every second (service FFE0, characteristic FFE1),
 * "60BP-MOCK", a Nova pen that writes a random number on a new sheet every few seconds (devices/aura-nova.js),
 * and "MA_Pouce_M0CK01", a PLB thumb button (devices/aura-plb.js): hold B to press its button. */
(function () {
  'use strict';
  if (window.Aura) return;
  var params = new URLSearchParams(location.search);
  var mode = params.get('mock');
  if (!mode) return;
  var appClip = mode === 'join' || mode === 'guest' || mode === 'clip';
  var me = Math.random().toString(36).slice(2, 10);
  var listeners = {};
  var emit = function (name, detail) {
    (listeners[name] || []).slice().forEach(function (f) { try { f(detail); } catch (e) { console.error(e); } });
    window.dispatchEvent(new CustomEvent('aura:' + name, { detail: detail }));
  };
  var ok = function (v) { return new Promise(function (r) { setTimeout(function () { r(v); }, 5); }); };
  var fail = function (msg) { return Promise.reject(new Error(msg)); };
  var log = function () { console.log.apply(console, ['%c[Aura mock]', 'color:#0a84ff'].concat([].slice.call(arguments))); };

  // ---------------------------------------------------------------- peer link over BroadcastChannel
  var bc = new BroadcastChannel('aurakit-mock');
  var role = null, myName = null, hostId = null, myRoom = '';
  var peers = new Map();
  var joinResolve = null;
  var hostingStarted = false;
  var norm = function (v) { return String(v || '').toLowerCase(); };
  var copy = function (kind, data) {
    if (kind === 'binary') return new DataView(new Uint8Array(data).buffer);
    return kind === 'json' ? JSON.parse(JSON.stringify(data)) : data;
  };

  bc.onmessage = function (ev) {
    var m = ev.data;
    if (m.to && m.to !== me) return;
    if (m.type !== 'bye' && norm(m.r) !== myRoom) return;      // other rooms are invisible
    switch (m.type) {
      case 'join-req':
        if (role !== 'host' || !hostingStarted) return;
        bc.postMessage({ type: 'join-ok', from: me, to: m.from, name: myName, r: myRoom });
        if (!peers.has(m.from)) { peers.set(m.from, m.name); emit('peer.connected', { id: m.from, name: m.name }); }
        break;
      case 'join-ok':
        if (role !== 'guest' || !joinResolve) return;
        hostId = m.from; peers.set(m.from, m.name);
        emit('peer.connected', { id: m.from, name: m.name });
        joinResolve({ id: m.from, name: m.name, room: myRoom || null, role: 'guest' });
        joinResolve = null;
        break;
      case 'msg':
        if (!peers.has(m.from)) return;
        emit('peer.message', { from: m.from, kind: m.kind, data: copy(m.kind, m.data) });
        break;
      case 'bye':
        if (peers.delete(m.from)) { if (m.from === hostId) hostId = null; emit('peer.disconnected', { id: m.from }); }
        break;
    }
  };
  window.addEventListener('pagehide', function () { bc.postMessage({ type: 'bye', from: me }); });

  // ---------------------------------------------------------------- proximity (key P)
  var proxOn = false, near = false;
  window.addEventListener('keydown', function (e) {
    if (!proxOn || (e.key !== 'p' && e.key !== 'P') || /input|textarea/i.test((e.target && e.target.tagName) || '')) return;
    near = !near;
    log('proximity', near ? 'near' : 'far');
    emit('proximity', { near: near });
  });

  // ---------------------------------------------------------------- status bar, rotation, volume buttons (+ / -)
  var bar = { hidden: appClip, transparent: true };
  var lockedOrientation = null;
  var currentOrientation = function () {
    return window.matchMedia && window.matchMedia('(orientation: landscape)').matches ? 'landscapeRight' : 'portrait';
  };
  var ORIENTATIONS = ['portrait', 'landscape', 'landscapeLeft', 'landscapeRight', 'current'];
  var volumeOn = false, volume = 0.5;
  window.addEventListener('keydown', function (e) {
    if (!volumeOn || /input|textarea/i.test((e.target && e.target.tagName) || '')) return;
    var button = e.key === '+' || e.key === '=' ? 'up' : e.key === '-' ? 'down' : null;
    if (!button) return;
    log('volume button', button);
    emit('volumeButton', { button: button, volume: volume });
  });

  // ---------------------------------------------------------------- glass buttons, drawn in CSS where Aura puts native ones
  var glassLayer = null, glassEls = {};
  var glassBox = function (id) {
    if (!glassLayer) {
      glassLayer = document.createElement('div');
      glassLayer.style.cssText = 'position:absolute;left:0;top:0;width:0;height:0;z-index:2147483646';
      document.documentElement.appendChild(glassLayer);
    }
    var b = glassEls[id];
    if (!b) {
      b = glassEls[id] = document.createElement('button');
      b.type = 'button';
      b.addEventListener('click', function (e) { e.stopPropagation(); log('glass tap', id); emit('glass.tap', { id: id }); });
      glassLayer.appendChild(b);
    }
    return b;
  };
  var glassPlace = function (b, f) {
    b.style.position = f.fixed ? 'fixed' : 'absolute';
    b.style.left = (f.x || 0) + 'px'; b.style.top = (f.y || 0) + 'px';
    b.style.width = Math.max(f.width || 0, 1) + 'px'; b.style.height = Math.max(f.height || 0, 1) + 'px';
    if (typeof f.hidden === 'boolean') b.style.display = f.hidden ? 'none' : 'flex';
  };

  // ---------------------------------------------------------------- fake Bluetooth devices
  var DEV = { id: 'MOCK-BLE-0001', name: 'Mock Sensor', rssi: -52 };
  var scanTimer = null, notifyTimer = null, counter = 0, connected = false, lastWrite = 'hello';
  var matches = function (o) {
    o = o || {};
    if (o.name && o.name !== DEV.name) return false;
    if (o.namePrefix && DEV.name.indexOf(o.namePrefix) !== 0) return false;
    if (o.services && o.services.length && o.services.map(function (s) { return String(s).toUpperCase(); }).indexOf('FFE0') < 0) return false;
    return true;
  };

  // A Nova pen (Ophaya 60BP): writes a random number on a new sheet every few seconds, with real binary frames.
  var NOVA = { id: 'MOCK-NOVA-0001', name: '60BP-MOCK', rssi: -48 };
  var NOVA_SERVICE = '69400001-B5A3-F393-E0A9-E50E24DCCA99', NOVA_NOTIFY = '69400003-B5A3-F393-E0A9-E50E24DCCA99';
  var nova = { connected: false, timer: null, stream: [], idleUntil: 0, page: 0x00012340 };
  var novaMatches = function (o) {
    o = o || {};
    if (o.name && o.name !== NOVA.name) return false;
    if (o.namePrefix && NOVA.name.indexOf(o.namePrefix) !== 0) return false;
    if (o.services && o.services.length && o.services.map(function (s) { return String(s).toUpperCase(); }).indexOf(NOVA_SERVICE) < 0) return false;
    return true;
  };
  var arc = function (cx, cy, rx, ry, a0, a1, n) {
    var pts = [];
    for (var i = 0; i <= n; i++) { var a = (a0 + (a1 - a0) * i / n) * Math.PI / 180; pts.push([cx + rx * Math.cos(a), cy + ry * Math.sin(a)]); }
    return pts;
  };
  // Digits in a 1 × 1 box (y down), one stroke each.
  var DIGITS = [
    arc(0.5, 0.5, 0.4, 0.5, -90, 270, 24),
    [[0.3, 0.2], [0.55, 0], [0.55, 1]],
    arc(0.5, 0.28, 0.38, 0.28, -170, 30, 12).concat([[0.1, 1], [0.9, 1]]),
    arc(0.48, 0.26, 0.36, 0.26, -160, 90, 12).concat(arc(0.48, 0.74, 0.4, 0.26, -90, 160, 12)),
    [[0.65, 1], [0.65, 0], [0.05, 0.7], [0.95, 0.7]],
    [[0.85, 0], [0.2, 0], [0.15, 0.45]].concat(arc(0.5, 0.68, 0.4, 0.32, -150, 150, 14)),
    [[0.75, 0], [0.3, 0.35], [0.12, 0.7]].concat(arc(0.5, 0.72, 0.38, 0.28, 180, 540, 24)),
    [[0.05, 0], [0.95, 0], [0.35, 1]],
    arc(0.5, 0.25, 0.3, 0.25, 90, 450, 20).concat(arc(0.5, 0.75, 0.4, 0.25, -90, 270, 24)),
    arc(0.5, 0.3, 0.38, 0.3, 0, 360, 24).concat([[0.88, 0.3], [0.8, 1]]),
  ];
  // FF FE | 03 01 | 00 0A | rawX rawY pageRaw force | CRC (ignored) | FF FD
  var novaFrame = function (x, y, page, force) {
    var rawX = x == null ? 0 : (0x8000 | (x & 0x1FFF));
    var pg = page >>> 0;
    return [0xFF, 0xFE, 0x03, 0x01, 0x00, 0x0A, rawX >> 8, rawX & 255, (y >> 8) & 0x3F, y & 255,
      pg >>> 24, (pg >> 16) & 255, (pg >> 8) & 255, pg & 255, (force >> 8) & 3, force & 255, 0, 0, 0xFF, 0xFD];
  };
  var novaWrite = function () {
    var n = 1 + Math.floor(Math.random() * 99), text = String(n), bytesOut = [];
    nova.page = (nova.page + 0x100) >>> 0;
    log('Nova pen writes', n, 'on page', nova.page.toString(16));
    var ox = 1500 + Math.round(Math.random() * 300), oy = 2000 + Math.round(Math.random() * 300), H = 236, W = 150;
    text.split('').forEach(function (ch, i) {
      var pts = DIGITS[+ch].map(function (p) { return [ox + i * 210 + p[0] * W, oy + p[1] * H]; });
      for (var k = 1; k < pts.length; k++) {
        var a = pts[k - 1], b = pts[k], steps = Math.max(1, Math.round(Math.hypot(b[0] - a[0], b[1] - a[1]) / 7));
        for (var j = k === 1 ? 0 : 1; j <= steps; j++) {
          var x = Math.round(a[0] + (b[0] - a[0]) * j / steps + Math.random() * 2), y = Math.round(a[1] + (b[1] - a[1]) * j / steps + Math.random() * 2);
          bytesOut.push.apply(bytesOut, novaFrame(x, y, nova.page, 350 + Math.round(Math.random() * 300)));
        }
      }
      for (var s = 0; s < 7; s++) bytesOut.push.apply(bytesOut, novaFrame(null, 0, 0xFFFFFFF8, 0));   // tip up: sentinels
    });
    nova.stream = bytesOut;
  };
  var novaStart = function () {
    clearInterval(nova.timer);
    nova.stream = []; nova.idleUntil = Date.now() + 800;
    nova.timer = setInterval(function () {
      if (!nova.stream.length) {
        if (Date.now() < nova.idleUntil) return;
        novaWrite();
        nova.idleUntil = Date.now() + 1e9;
      }
      // 10 to 30 bytes per notification: frames arrive whole, split or two at a time, as on the iPhone.
      var chunk = nova.stream.splice(0, 10 + Math.floor(Math.random() * 21));
      emit('bluetooth.notification', { id: NOVA.id, service: NOVA_SERVICE, characteristic: NOVA_NOTIFY, value: new DataView(Uint8Array.from(chunk).buffer) });
      if (!nova.stream.length) nova.idleUntil = Date.now() + 4000;
    }, 30);
  };
  var novaStop = function () { clearInterval(nova.timer); nova.timer = null; nova.stream = []; };

  // A PLB (Marc-Antoine's thumb button, Nordic UART): answers its text commands; hold B to press the button.
  var PLB = { id: 'MOCK-PLB-0001', name: 'MA_Pouce_M0CK01', rssi: -45 };
  var NUS = '6E400001-B5A3-F393-E0A9-E50E24DCCA9E', NUS_TX = '6E400003-B5A3-F393-E0A9-E50E24DCCA9E';
  var plb = { connected: false, notifying: false, rx: '', autoOff: 3600, light: 0, longTimer: null, down: false };
  var plbNotify = function (text) {
    if (!plb.notifying) return;
    var data = new TextEncoder().encode(text);
    // 20-byte notifications, as with the default MTU.
    for (var i = 0; i < data.length; i += 20) {
      emit('bluetooth.notification', { id: PLB.id, service: NUS, characteristic: NUS_TX, value: new DataView(data.slice(i, i + 20).buffer) });
    }
  };
  var plbAnswer = function (text) { setTimeout(function () { plbNotify(text + '\r\nOK\r\n'); }, 30); };
  var plbCommand = function (line) {
    var c = line.toUpperCase(), v;
    if (!c) return;
    log('PLB command', line);
    if (c === 'GET_VER') plbAnswer('V=010 Aug 24 2025 12:00:00');
    else if (c === 'GET_ADD') plbAnswer('ADD=C0DE4D0C4B01');
    else if (c.indexOf('GET_BATT=') === 0) plbAnswer('Batt=' + (2980 + Math.round(Math.random() * 60)));
    else if (c === 'GETCFG_X') {
      var a = plb.autoOff, cfg = [0x04, 0x00, 0x55, 0xAA, a & 255, (a >> 8) & 255, (a >> 16) & 255, (a >>> 24) & 255, 9, 255, 255, 255, 255, 255, 255, 0];
      plbAnswer(cfg.map(function (x) { return (x < 16 ? '0' : '') + x.toString(16).toUpperCase(); }).join(''));
    }
    else if (c.indexOf('TMROFF=') === 0) {
      if (c.slice(7) !== '?') plb.autoOff = Math.max(60, parseInt(c.slice(7), 10) || 0);
      plbAnswer('TimeBeforeOff=' + plb.autoOff);
    } else if (c.indexOf('LAMPPWM=') === 0) {
      v = parseInt(c.slice(8), 10) || 0;
      plb.light = v > 0 && v <= 100 ? v : 0;
      log('PLB light', plb.light ? plb.light + ' %' : 'off');
      plbAnswer('LAMPPWM=' + v);
    } else if (c === 'FACT_RESET') { plb.autoOff = 3600; plbAnswer('Factory reset'); }
    else if (c === 'PWROFF' || c === 'RESTART') {
      setTimeout(function () { plb.connected = plb.notifying = false; emit('bluetooth.disconnected', { id: PLB.id }); }, 100);
    }
  };
  window.addEventListener('keydown', function (e) {
    if ((e.key !== 'b' && e.key !== 'B') || e.repeat || !plb.notifying || /input|textarea/i.test((e.target && e.target.tagName) || '')) return;
    plb.down = true;
    plbNotify('+BTN: PUSH');
    plb.longTimer = setTimeout(function () { if (plb.down) plbNotify('+BTN: LONG'); }, 1000);
  });
  window.addEventListener('keyup', function (e) {
    if ((e.key !== 'b' && e.key !== 'B') || !plb.down) return;
    plb.down = false;
    clearTimeout(plb.longTimer);
    plbNotify('+BTN: RELEASE');
  });
  var bytes = function (v) {
    if (typeof v === 'string') return new TextEncoder().encode(v);
    if (v instanceof ArrayBuffer) return new Uint8Array(v);
    if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
    return Uint8Array.from(v || []);
  };

  // Simulates iOS killing the app: the peer leaves and the page is replaced by a notice.
  var crash = function () {
    log('peer.join timeout overflow: the app is killed (simulated)');
    bc.postMessage({ type: 'bye', from: me });
    peers.clear(); role = null; joinResolve = null; hostId = null;
    setTimeout(function () {
      document.title = 'Aura (closed)';
      document.body.innerHTML = '<p style="font:16px -apple-system,system-ui,sans-serif;text-align:center;margin-top:40vh;color:#888">' +
        (appClip ? 'App Clip closed' : 'Aura Browser closed') + ' (simulator)</p>';
    }, 50);
    return new Promise(function () {});
  };

  var Aura = {
    __mock: true,
    version: 1,
    capabilities: function () {
      return ok({ version: 1, appClip: appClip, haptics: true, customHaptics: true, bluetooth: true, peer: true, proximity: true, deviceInfo: true,
        statusBar: true, orientationLock: true, volumeButtons: true, glass: true, liquidGlass: false });
    },
    deviceInfo: function () {
      return ok({ userId: appClip ? 'MOCK-TAG-ID' : 'MOCK-USER-ID', vendorId: 'MOCK-' + me, model: 'Simulator', systemName: 'Web', systemVersion: '1', appClip: appClip });
    },
    haptic: function (type, options) { log('haptic', type, options || ''); return ok(); },
    prepareHaptics: function () { return ok(); },
    on: function (name, fn) { (listeners[name] = listeners[name] || []).push(fn); return function () { Aura.off(name, fn); }; },
    off: function (name, fn) { listeners[name] = (listeners[name] || []).filter(function (f) { return f !== fn; }); },
    proximity: {
      start: function () { proxOn = true; log('proximity watched — press P to cover / uncover the sensor'); return ok({ supported: true, near: near }); },
      stop: function () { proxOn = false; return ok(); },
    },
    statusBar: {
      set: function (o) {
        o = o || {};
        if (typeof o.hidden === 'boolean') bar.hidden = o.hidden;
        if (typeof o.transparent === 'boolean') bar.transparent = o.transparent;
        log('status bar', bar.hidden ? 'hidden' : 'shown' + (bar.transparent ? ' (transparent)' : ' (opaque)'));
        return ok({ hidden: bar.hidden, transparent: bar.transparent, fullScreen: true });
      },
      show: function (o) { return Aura.statusBar.set(Object.assign({}, o, { hidden: false })); },
      hide: function () { return Aura.statusBar.set({ hidden: true }); },
      get: function () { return ok({ hidden: bar.hidden, transparent: bar.transparent, fullScreen: true }); },
    },
    orientation: {
      lock: function (name) {
        name = name || 'current';
        if (ORIENTATIONS.indexOf(name) < 0) return fail('Aura: unknown orientation "' + name + '".');
        lockedOrientation = name === 'current' ? currentOrientation() : name;
        log('rotation locked:', lockedOrientation);
        return ok({ orientation: currentOrientation(), locked: lockedOrientation });
      },
      unlock: function () { lockedOrientation = null; log('rotation unlocked'); return ok({ orientation: currentOrientation(), locked: null }); },
      get: function () { return ok({ orientation: currentOrientation(), locked: lockedOrientation }); },
    },
    glass: {
      set: function (o) {
        o = o || {};
        if (!o.id) return fail('Aura: missing or invalid glass button id.');
        var b = glassBox(o.id), prominent = /^prominent/.test(o.style || '');
        b.textContent = (o.symbol ? '◆ ' : '') + (o.title || '');
        b.style.cssText += ';display:flex;align-items:center;justify-content:center;box-sizing:border-box;white-space:nowrap;overflow:hidden;margin:0;padding:0 12px;cursor:pointer;' +
          'font:' + (prominent ? '600 ' : '500 ') + (o.fontSize || 17) + 'px -apple-system,system-ui,sans-serif;' +
          'border-radius:' + (o.cornerRadius != null ? o.cornerRadius + 'px' : '999px') + ';' +
          'color:' + (o.color || (prominent ? '#fff' : o.tint || '#fff')) + ';' +
          'background:' + (prominent ? (o.tint || '#0a84ff') : /clear/i.test(o.style || '') ? 'rgba(255,255,255,0.06)' : 'rgba(255,255,255,0.16)') + ';' +
          'border:1px solid rgba(255,255,255,0.35);outline:1px dashed #ff2d95;outline-offset:2px;' +
          '-webkit-backdrop-filter:blur(14px) saturate(1.8);backdrop-filter:blur(14px) saturate(1.8);box-shadow:0 6px 20px rgba(0,0,0,0.3)';
        glassPlace(b, o);
        return ok();
      },
      frames: function (items) { (items || []).forEach(function (f) { if (glassEls[f.id]) glassPlace(glassEls[f.id], f); }); return ok(); },
      remove: function (id) { var b = glassEls[id]; if (b) { b.remove(); delete glassEls[id]; } return ok(); },
      clear: function () { Object.keys(glassEls).forEach(function (id) { glassEls[id].remove(); delete glassEls[id]; }); return ok(); },
    },
    volumeButtons: {
      start: function (o) {
        volumeOn = true;
        log('volume buttons watched — press + and - (keepVolume: ' + !(o && o.keepVolume === false) + ')');
        return ok({ volume: volume, keepVolume: !(o && o.keepVolume === false) });
      },
      stop: function () { volumeOn = false; return ok(); },
    },
    bluetooth: {
      state: function () { return ok('poweredOn'); },
      requestDevice: function (o) {
        return matches(o) ? new Promise(function (r) { setTimeout(function () { r(Object.assign({}, DEV)); }, 400); })
          : new Promise(function (_, j) { setTimeout(function () { j(new Error('No matching device found.')); }, Math.min(((o && o.timeout) || 10) * 1000, 2000)); });
      },
      scan: function (o) {
        clearInterval(scanTimer);
        var found = [DEV, NOVA, PLB].filter(function (d) {
          if (d === PLB) return !(o && o.services && o.services.length) || o.services.map(function (s) { return String(s).toUpperCase(); }).indexOf(NUS) >= 0;
          return d === NOVA ? novaMatches(o) : matches(o);
        });
        if (found.length) scanTimer = setInterval(function () {
          found.forEach(function (d) { emit('bluetooth.discovered', Object.assign({}, d, { rssi: d.rssi - Math.round(Math.random() * 15) })); });
        }, 700);
        return ok();
      },
      stopScan: function () { clearInterval(scanTimer); return ok(); },
      connect: function (id) {
        if (id === NOVA.id) {
          nova.connected = true;
          return ok({ id: NOVA.id, name: NOVA.name, services: [{ uuid: NOVA_SERVICE, characteristics: [{ uuid: '69400002-B5A3-F393-E0A9-E50E24DCCA99', properties: ['write'] }, { uuid: NOVA_NOTIFY, properties: ['notify'] }] }] });
        }
        if (id === PLB.id) {
          plb.connected = true; plb.light = 0;
          log('PLB connected: hold B to press its button');
          return ok({ id: PLB.id, name: PLB.name, services: [{ uuid: NUS, characteristics: [{ uuid: '6E400002-B5A3-F393-E0A9-E50E24DCCA9E', properties: ['write', 'writeWithoutResponse'] }, { uuid: NUS_TX, properties: ['notify'] }] }] });
        }
        if (id !== DEV.id) return fail('Unknown device.');
        connected = true;
        return ok({ id: DEV.id, name: DEV.name, services: [{ uuid: 'FFE0', characteristics: [{ uuid: 'FFE1', properties: ['read', 'write', 'notify'] }] }] });
      },
      disconnect: function (id) {
        if (id === NOVA.id) { nova.connected = false; novaStop(); return ok(); }
        if (id === PLB.id) { plb.connected = plb.notifying = false; return ok(); }
        connected = false; clearInterval(notifyTimer); return ok();
      },
      read: function () { return connected ? ok(new DataView(bytes(lastWrite).buffer.slice(0))) : fail('Not connected.'); },
      write: function (id, s, c, data) {
        if (id === PLB.id) {
          if (!plb.connected) return fail('Not connected.');
          plb.rx += new TextDecoder().decode(bytes(data));
          var lines = plb.rx.split(/[\r\n]/);
          plb.rx = lines.pop();
          lines.forEach(plbCommand);
          return ok();
        }
        if (!connected) return fail('Not connected.'); lastWrite = new TextDecoder().decode(bytes(data)); log('bluetooth write', lastWrite); return ok(); },
      startNotifications: function (id, service, characteristic) {
        if (id === NOVA.id) { if (!nova.connected) return fail('Not connected.'); novaStart(); return ok(); }
        if (id === PLB.id) { if (!plb.connected) return fail('Not connected.'); plb.notifying = true; return ok(); }
        if (!connected) return fail('Not connected.');
        clearInterval(notifyTimer);
        notifyTimer = setInterval(function () {
          counter = (counter + 1) % 256;
          emit('bluetooth.notification', { id: DEV.id, service: service, characteristic: characteristic, value: new DataView(Uint8Array.from([counter]).buffer) });
        }, 1000);
        return ok();
      },
      stopNotifications: function (id) { if (id === PLB.id) plb.notifying = false; else if (id === NOVA.id) novaStop(); else clearInterval(notifyTimer); return ok(); },
    },
    peer: {
      host: function (o) {
        o = o || {};
        role = 'host'; myName = o.name || null; myRoom = norm(o.room); hostingStarted = true;
        return ok({ room: myRoom || null, role: 'host' });
      },
      join: function (o) {
        o = o || {};
        // Same overflow as the native bridge: a timeout too large for Int64 nanoseconds kills the app.
        if (typeof o.timeout === 'number' && !(o.timeout * 1e9 < 9223372036854775807)) return crash();
        return new Promise(function (resolve, reject) {
          role = 'guest'; myName = o.name || null; myRoom = norm(o.room); joinResolve = resolve;
          var timeout = (o.timeout || 30) * 1000, t0 = Date.now();
          (function tick() {
            if (!joinResolve) return;
            if (Date.now() - t0 > timeout) { joinResolve = null; reject(new Error('Aura: no device is hosting this room nearby.')); return; }
            bc.postMessage({ type: 'join-req', from: me, name: myName, r: myRoom });
            setTimeout(tick, 500);
          })();
        });
      },
      send: function (data, o) {
        o = o || {};
        if (!peers.size) return fail('Aura: not connected.');
        var kind = typeof data === 'string' ? 'text' : (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) ? 'binary' : 'json';
        var payload = kind === 'binary' ? Array.from(bytes(data)) : kind === 'json' ? JSON.parse(JSON.stringify(data === undefined ? null : data)) : data;
        var size = kind === 'json' ? new TextEncoder().encode(JSON.stringify(payload)).length : kind === 'text' ? new TextEncoder().encode(data).length : payload.length;
        if (size > 65536) return fail('Aura: message too large (64 KB max).');
        bc.postMessage({ type: 'msg', from: me, to: o.to || (role === 'guest' ? hostId : null), kind: kind, data: payload, r: myRoom });
        return ok();
      },
      peers: function () { return ok(Array.from(peers, function (p) { return { id: p[0], name: p[1] }; })); },
      leave: function () {
        bc.postMessage({ type: 'bye', from: me });
        peers.clear(); role = null; hostingStarted = false; joinResolve = null; hostId = null;
        return ok();
      },
    },
  };
  window.Aura = Aura;
  log('simulating ' + (appClip ? 'the AuraClip App Clip (guest)' : 'Aura Browser (host)'));
})();
