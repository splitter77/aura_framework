/*! AuraKit simulator — a fake window.Aura for testing pages on a computer. Never active inside Aura.
 *
 * Load it BEFORE aurakit.js. It does nothing unless the URL contains ?mock=…
 *   ?mock=host    behaves like Aura Browser   (appClip: false)
 *   ?mock=join    behaves like the App Clip    (appClip: true)
 * Open two tabs of the same browser (one host, one join): Aura.peer goes through BroadcastChannel,
 * so the iPhone-to-iPhone link, messages, shared state and rooms work between the tabs.
 * Haptics are logged to the console. Press P to toggle the proximity sensor while it is watched.
 * Bluetooth LE: one fake device, "Mock Sensor", with a counter notifying every second (service FFE0, characteristic FFE1). */
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

  // ---------------------------------------------------------------- one fake Bluetooth device
  var DEV = { id: 'MOCK-BLE-0001', name: 'Mock Sensor', rssi: -52 };
  var scanTimer = null, notifyTimer = null, counter = 0, connected = false, lastWrite = 'hello';
  var matches = function (o) {
    o = o || {};
    if (o.name && o.name !== DEV.name) return false;
    if (o.namePrefix && DEV.name.indexOf(o.namePrefix) !== 0) return false;
    if (o.services && o.services.length && o.services.map(function (s) { return String(s).toUpperCase(); }).indexOf('FFE0') < 0) return false;
    return true;
  };
  var bytes = function (v) {
    if (typeof v === 'string') return new TextEncoder().encode(v);
    if (v instanceof ArrayBuffer) return new Uint8Array(v);
    if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
    return Uint8Array.from(v || []);
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
        if (matches(o)) scanTimer = setInterval(function () { emit('bluetooth.discovered', Object.assign({}, DEV, { rssi: -45 - Math.round(Math.random() * 20) })); }, 700);
        return ok();
      },
      stopScan: function () { clearInterval(scanTimer); return ok(); },
      connect: function (id) {
        if (id !== DEV.id) return fail('Unknown device.');
        connected = true;
        return ok({ id: DEV.id, name: DEV.name, services: [{ uuid: 'FFE0', characteristics: [{ uuid: 'FFE1', properties: ['read', 'write', 'notify'] }] }] });
      },
      disconnect: function () { connected = false; clearInterval(notifyTimer); return ok(); },
      read: function () { return connected ? ok(new DataView(bytes(lastWrite).buffer.slice(0))) : fail('Not connected.'); },
      write: function (id, s, c, data) { if (!connected) return fail('Not connected.'); lastWrite = new TextDecoder().decode(bytes(data)); log('bluetooth write', lastWrite); return ok(); },
      startNotifications: function (id, service, characteristic) {
        if (!connected) return fail('Not connected.');
        clearInterval(notifyTimer);
        notifyTimer = setInterval(function () {
          counter = (counter + 1) % 256;
          emit('bluetooth.notification', { id: DEV.id, service: service, characteristic: characteristic, value: new DataView(Uint8Array.from([counter]).buffer) });
        }, 1000);
        return ok();
      },
      stopNotifications: function () { clearInterval(notifyTimer); return ok(); },
    },
    peer: {
      host: function (o) {
        o = o || {};
        role = 'host'; myName = o.name || null; myRoom = norm(o.room); hostingStarted = true;
        return ok({ room: myRoom || null, role: 'host' });
      },
      join: function (o) {
        o = o || {};
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
