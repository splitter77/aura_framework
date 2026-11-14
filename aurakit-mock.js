/*! AuraKit simulator — a fake window.Aura for testing pages on a computer. Never active inside Aura.
 *
 * Load it BEFORE aurakit.js. It does nothing unless the URL contains ?mock=…
 *   ?mock=host    behaves like Aura Browser   (appClip: false)
 *   ?mock=join    behaves like the App Clip    (appClip: true)
 * Open two tabs of the same browser (one host, one join): Aura.peer goes through BroadcastChannel,
 * so the iPhone-to-iPhone link, messages, shared state and rooms work between the tabs.
 * Haptics are logged to the console. Press P to toggle the proximity sensor while it is watched.
 * Bluetooth LE: "Mock Sensor", with a counter notifying every second (service FFE0, characteristic FFE1),
 * and "60BP-MOCK", a Nova pen that writes a random number on a new sheet every few seconds (devices/aura-nova.js). */
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
      return ok({ version: 1, appClip: appClip, haptics: true, customHaptics: true, bluetooth: true, peer: true, proximity: true, deviceInfo: true });
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
    bluetooth: {
      state: function () { return ok('poweredOn'); },
      requestDevice: function (o) {
        return matches(o) ? new Promise(function (r) { setTimeout(function () { r(Object.assign({}, DEV)); }, 400); })
          : new Promise(function (_, j) { setTimeout(function () { j(new Error('No matching device found.')); }, Math.min(((o && o.timeout) || 10) * 1000, 2000)); });
      },
      scan: function (o) {
        clearInterval(scanTimer);
        var found = [DEV, NOVA].filter(function (d) { return d === NOVA ? novaMatches(o) : matches(o); });
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
        if (id !== DEV.id) return fail('Unknown device.');
        connected = true;
        return ok({ id: DEV.id, name: DEV.name, services: [{ uuid: 'FFE0', characteristics: [{ uuid: 'FFE1', properties: ['read', 'write', 'notify'] }] }] });
      },
      disconnect: function (id) {
        if (id === NOVA.id) { nova.connected = false; novaStop(); return ok(); }
        connected = false; clearInterval(notifyTimer); return ok();
      },
      read: function () { return connected ? ok(new DataView(bytes(lastWrite).buffer.slice(0))) : fail('Not connected.'); },
      write: function (id, s, c, data) { if (!connected) return fail('Not connected.'); lastWrite = new TextDecoder().decode(bytes(data)); log('bluetooth write', lastWrite); return ok(); },
      startNotifications: function (id, service, characteristic) {
        if (id === NOVA.id) { if (!nova.connected) return fail('Not connected.'); novaStart(); return ok(); }
        if (!connected) return fail('Not connected.');
        clearInterval(notifyTimer);
        notifyTimer = setInterval(function () {
          counter = (counter + 1) % 256;
          emit('bluetooth.notification', { id: DEV.id, service: service, characteristic: characteristic, value: new DataView(Uint8Array.from([counter]).buffer) });
        }, 1000);
        return ok();
      },
      stopNotifications: function (id) { if (id === NOVA.id) novaStop(); else clearInterval(notifyTimer); return ok(); },
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
