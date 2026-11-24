/*! AuraKit simulator — a fake window.Aura for testing pages on a computer. Never active inside Aura.
 *
 * Load it BEFORE aurakit.js. It does nothing unless the URL contains ?mock=…
 *   ?mock=host    behaves like Aura Browser   (appClip: false)
 *   ?mock=join    behaves like the App Clip    (appClip: true)
 * Open two tabs of the same browser (one host, one join): Aura.peer goes through BroadcastChannel,
 * so the iPhone-to-iPhone link, messages, shared state and rooms work between the tabs.
 * Haptics are logged to the console. Press P to toggle the proximity sensor while it is watched.
 * Flic: Aura.flic.pair() adds a fake button after 1.5 s; once armed, keys 1 / 2 / 3 send single / double / hold
 * (any of them sends down in 'immediate' mode).
 * Volume buttons: press + (or =) and - while they are watched. Status bar and rotation lock are logged.
 * Contact card: Aura.contact.add() shows a simple card (name, company, phone, e-mail) with a button to download the .vcf.
 * Glass buttons (experimental): drawn as CSS glass, outlined in pink, where Aura would put the native ones.
 * Bluetooth LE: "Mock Sensor", with a counter notifying every second (service FFE0, characteristic FFE1),
 * "60BP-MOCK", a Nova pen that writes a random number on a new sheet every few seconds (devices/aura-nova.js),
 * "MA_Pouce_M0CK01", a PLB thumb button (devices/aura-plb.js): hold B to press its button,
 * "MysterBox" (devices/aura-mysterbox.js), with its screen and buttons in a panel (&mysterbox=watch for the Watch),
 * and "Lumen-ZY-Duo" (devices/aura-lumenduo.js), with its 160 × 80 display and L / R buttons in a panel. */
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

  // ---------------------------------------------------------------- Flic (keys 1 / 2 / 3)
  var flicState = { started: false, restored: false, bluetooth: 'poweredOn', scanning: false, scanStatus: 'idle',
    armed: false, mode: 'gestures', lastError: null, buttons: [] };
  var flicCopy = function () { return JSON.parse(JSON.stringify(flicState)); };
  var flicChanged = function () { emit('flic.state', flicCopy()); return ok(flicCopy()); };
  var flicPairTimer = null;
  window.addEventListener('keydown', function (e) {
    var gesture = { 1: 'single', 2: 'double', 3: 'hold' }[e.key];
    if (!gesture || /input|textarea/i.test((e.target && e.target.tagName) || '')) return;
    if (!flicState.armed || !flicState.buttons.length) { log('flic: pair a button and arm reception first'); return; }
    if (flicState.mode === 'immediate') gesture = 'down';
    log('flic', gesture);
    emit('flic.press', { id: Math.random().toString(36).slice(2), buttonID: flicState.buttons[0].id, buttonNumber: 0, gesture: gesture, timestamp: Date.now() });
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

  // A MysterBox (devices/aura-mysterbox.js): speaks the binary protocol and draws its screen in a small panel.
  // Click = tap, drag = swipe. &mysterbox=watch simulates the Watch.
  var boxId = function (n) { return '7A1D000' + n + '-3B6E-4F2A-9C4D-2E8F1A5B0C01'; };
  var BOX = { id: 'MOCK-MYSTERBOX-0001', name: 'MysterBox', rssi: -50 };
  var boxWatch = params.get('mysterbox') === 'watch';
  var box = { connected: false, events: false, imu: false, files: {}, upload: null, w: boxWatch ? 410 : 368, h: boxWatch ? 502 : 448,
    volume: 30, light: 100, rot: 0, face: 1, size: 160, color: '#fff', bg: '#000', text: null, image: null, lines: [], line: null,
    pen: { color: '#fff', width: 6 }, panel: null, timer: null, motionTimer: null };
  var boxRGB = function (b, i) { return 'rgb(' + b[i] + ',' + b[i + 1] + ',' + b[i + 2] + ')'; };
  var boxNotify = function (char, data) {
    if (!box.connected) return;
    emit('bluetooth.notification', { id: BOX.id, service: boxId(1), characteristic: boxId(char), value: new DataView(Uint8Array.from(data).buffer) });
  };
  var boxEvent = function (type, x, y, arg) {
    setTimeout(function () { if (box.events) boxNotify(3, [type, x & 255, (x >> 8) & 255, y & 255, (y >> 8) & 255, arg || 0]); }, 15);
  };
  var boxCRC = function (b) {
    var c = -1;
    for (var i = 0; i < b.length; i++) { c ^= b[i]; for (var k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1)); }
    return (c ^ -1) >>> 0;
  };
  var boxDraw = function () {
    if (!box.panel) return;
    var screen = box.panel.querySelector('canvas'), g = screen.getContext('2d');
    screen.style.opacity = 0.2 + box.light / 125;
    g.fillStyle = box.bg; g.fillRect(0, 0, box.w, box.h);
    if (box.image) g.drawImage(box.image, (box.w - box.image.width) / 2, (box.h - box.image.height) / 2);
    g.lineCap = g.lineJoin = 'round';
    box.lines.forEach(function (l) {
      g.strokeStyle = l.color; g.lineWidth = l.width; g.beginPath();
      l.points.forEach(function (p, i) { if (i) g.lineTo(p[0], p[1]); else { g.moveTo(p[0], p[1]); g.lineTo(p[0], p[1]); } });
      g.stroke();
    });
    if (!box.text || !box.text.value) return;
    var turned = box.rot % 2, width = (turned ? box.h : box.w) - 20, height = (turned ? box.w : box.h) - 20;
    var lines, size = box.text.size;
    for (; size > 10; size -= 2) {
      g.font = size + 'px system-ui, sans-serif'; lines = [];
      box.text.value.split('\n').forEach(function (part) {
        var line = '';
        part.split(' ').forEach(function (word) {
          var next = line ? line + ' ' + word : word;
          if (line && g.measureText(next).width > width) { lines.push(line); line = word; } else line = next;
        });
        lines.push(line);
      });
      if (lines.length * size * 1.15 <= height && lines.every(function (l) { return g.measureText(l).width <= width; })) break;
    }
    g.save(); g.translate(box.w / 2, box.h / 2); g.rotate(box.rot * Math.PI / 2);
    g.fillStyle = box.text.color; g.textAlign = 'center'; g.textBaseline = 'middle';
    (lines || []).forEach(function (l, i) { g.fillText(l, 0, (i - (lines.length - 1) / 2) * size * 1.15); });
    g.restore();
  };
  var boxShow = function () {
    if (box.panel || !document.body) return;
    var p = box.panel = document.createElement('div');
    p.id = 'aura-mock-mysterbox';
    p.style.cssText = 'position:fixed;right:8px;bottom:8px;z-index:2147483000;width:140px;padding:6px;border:1px solid #ff2d92;border-radius:14px;background:#111';
    p.innerHTML = '<canvas width="' + box.w + '" height="' + box.h + '" style="display:block;width:100%;border-radius:9px;touch-action:none"></canvas><div style="display:flex;gap:3px;margin-top:5px"></div>';
    var screen = p.querySelector('canvas'), start = null;
    var at = function (e) {
      var r = screen.getBoundingClientRect();
      return [Math.max(0, Math.round((e.clientX - r.left) * box.w / r.width)), Math.max(0, Math.round((e.clientY - r.top) * box.h / r.height))];
    };
    screen.onpointerdown = function (e) { start = at(e); boxEvent(1, start[0], start[1]); };
    screen.onpointerup = function (e) {
      if (!start) return;
      var q = at(e), dx = q[0] - start[0], dy = q[1] - start[1];
      boxEvent(2, q[0], q[1]);
      if (Math.max(Math.abs(dx), Math.abs(dy)) < 30) boxEvent(3, q[0], q[1]);
      else boxEvent(5, q[0], q[1], Math.abs(dx) > Math.abs(dy) ? (dx < 0 ? 3 : 4) : (dy < 0 ? 1 : 2));
      start = null;
    };
    [['BOOT', function () { boxEvent(6, 120, 0, 1); }], ['PWR', function () { boxEvent(6, 120, 0, 2); }],
      ['Shake', function () { boxEvent(0x21, 0, 0, 25); }], ['Turn', function () { box.face = box.face % 6 + 1; boxEvent(0x20, 0, 0, box.face); }]
    ].forEach(function (item) {
      var b = document.createElement('button');
      b.textContent = item[0]; b.onclick = item[1];
      b.style.cssText = 'flex:1;min-width:0;padding:4px 0;border:0;border-radius:4px;background:#333;color:#fff;font:9px system-ui';
      p.lastChild.appendChild(b);
    });
    document.body.appendChild(p);
    boxDraw();
  };
  var boxReset = function () {
    box.connected = box.events = box.imu = false;
    box.upload = null;
    clearInterval(box.motionTimer);
  };
  var boxCommand = function (b) {
    var op = b[0], args = b.slice(1), str = function (from) { return new TextDecoder().decode(Uint8Array.from(b.slice(from))); };
    var u16 = function (i) { return b[i] | (b[i + 1] << 8); };
    var u32 = function (i) { return (u16(i) | (u16(i + 2) << 16)) >>> 0; };
    var clear = function () { box.bg = '#000'; box.text = box.image = box.line = null; box.lines = []; };
    var soundEnd = function (code) { setTimeout(function () { boxEvent(0x23, 0, 0, code); }, 200); };
    if (op >= 0x20) box.text = { value: str(0), size: box.size, color: box.color };
    else if (op === 0x01) box.text = { value: str(1), size: box.size, color: box.color };
    else if (op === 0x11) box.text = { value: str(5), size: b[1], color: boxRGB(b, 2) };
    else if (op === 0x02) clear();
    else if (op === 0x03) box.light = b[1];
    else if (op === 0x04) { clear(); box.bg = boxRGB(b, 1); }
    else if (op === 0x05) box.size = b[1] || 160;
    else if (op === 0x06) box.color = boxRGB(b, 1);
    else if (op === 0x0F) box.rot = b[1];
    else if (op === 0x0B) box.volume = b[1];
    else if (op === 0x07 || op === 0x08 || op === 0x0E) soundEnd(0);
    else if (op === 0x09) soundEnd(box.files[str(1)] ? 0 : 4);
    else if (op === 0x0D) { clear(); box.text = { value: b[1] ? 'mode ' + b[1] : '', size: 60, color: '#0af' }; }
    else if (op === 0x1E) box.text = { value: 'card ' + args.join(' / '), size: 60, color: '#0af' };
    else if (op === 0x12) { box.pen = { color: boxRGB(b, 1), width: b[4] }; box.line = null; }
    else if (op === 0x13) {
      if (!box.line) box.lines.push(box.line = { color: box.pen.color, width: box.pen.width, points: [] });
      for (var i = 1; i + 3 < b.length; i += 4) box.line.points.push([u16(i) << 16 >> 16, u16(i + 2) << 16 >> 16]);
    } else if (op === 0x14) box.line = null;
    else if (op === 0x15) { box.lines = []; box.line = null; }
    else if (op === 0x16) {
      clearInterval(box.motionTimer);
      if (b[1]) box.motionTimer = setInterval(function () {
        if (box.imu) boxNotify(6, [0, 0, 0, 0, 0xE8, 3, 0, 0, 0, 0, 0, 0, box.face]);
      }, 1000 / Math.min(100, b[1]));
    } else if (op === 0x17) boxEvent(0x22, 4012, 7, 87);
    else if (op === 0x18) box.upload = { size: u32(1), name: str(5), data: [] };
    else if (op === 0x19) {
      var up = box.upload, code = 0;
      box.upload = null;
      if (!up) code = 7;
      else if (up.data.length !== up.size) code = 2;
      else if (b.length >= 5 && boxCRC(up.data) !== u32(1)) code = 3;
      else if (!/^[\w.-]{1,48}$/.test(up.name)) code = 6;
      else box.files[up.name] = Uint8Array.from(up.data);
      var got = up ? up.data.length : 0;
      boxEvent(0x10, got & 65535, Math.floor(got / 65536), code);
    } else if (op === 0x1A || op === 0x1D) {
      var file = box.files[str(1)];
      boxEvent(0x11, 0, 0, file ? 0 : 4);
      if (file && op === 0x1A && window.createImageBitmap) createImageBitmap(new Blob([file])).then(function (im) { box.image = im; boxDraw(); }, function () {});
    } else if (op === 0x1B) delete box.files[str(1)];
    else if (op === 0x1C) box.image = null;
    if (op !== 0x13) log('MysterBox command', '0x' + op.toString(16), args.slice(0, 24).join(' '));
    clearTimeout(box.timer);
    box.timer = setTimeout(boxDraw, 10);
  };
  var boxStatus = function () {
    return 'MysterBox 0.11.1 sd=0 root=/flash/mb imu=1 face=' + box.face + ' bat=87% 4012mV chg usb audio=1 vol=' + box.volume + ' rot=' + box.rot +
      ' board=' + (boxWatch ? 'amoled206' : 'amoled18') + ' res=' + box.w + 'x' + box.h + ' motor=' + (boxWatch ? 1 : 0) + ' heap=6981k';
  };
  var boxBusy = {};             // like the native bridge: one operation at a time per characteristic
  var boxOp = function (kind, c, run) {
    if (!box.connected) return fail('Aura: device is not connected.');
    var key = kind + String(c).toUpperCase();
    if (boxBusy[key]) return fail('Aura: a Bluetooth operation of this kind is already in progress.');
    boxBusy[key] = true;
    return ok().then(function () { delete boxBusy[key]; return run(String(c).toUpperCase()); });
  };
  var boxWrite = function (c, data, o) {
    var b = Array.from(bytes(data)), char = String(c).toUpperCase();
    if (!box.connected) return fail('Aura: device is not connected.');
    var handle = function () {
      if (char === boxId(5)) { if (box.upload) b.forEach(function (x) { box.upload.data.push(x); }); }
      else if (b.length) boxCommand(b);
    };
    if (o && o.withoutResponse) {
      if (b.length > 182) log('MysterBox: packet dropped, over the MTU (' + b.length + ' bytes)');
      else handle();
      return Promise.resolve();
    }
    return boxOp('write', char, handle);
  };

  // A Lumen Duo (devices/aura-lumenduo.js): 160 × 80 one-bit display drawn in a panel, buttons L / R,
  // battery status every 10 s. Speaks the binary commands and text notifications read from the SDK.
  var LUM = { id: 'MOCK-LUMENDUO-0001', name: 'Lumen-ZY-Duo', rssi: -47 };
  var LUM_SERVICE = '6E40FF01-B5A3-F393-E0A9-E50E24DCCA9E', LUM_WRITE = '6E40FF02-B5A3-F393-E0A9-E50E24DCCA9E',
    LUM_NOTIFY = '6E40FF03-B5A3-F393-E0A9-E50E24DCCA9E';
  var lum = { connected: false, notifying: false, w: 160, h: 80, pages: {}, colors: {}, shown: 0, light: 90, bar: false,
    charging: false, volts: 4.12, panel: null, timer: null, statusTimer: null, clearArmed: false };
  var lumPage = function (p) { return lum.pages[p] || (lum.pages[p] = new Uint8Array(lum.w / 8 * lum.h)); };
  var lumRGB = function (c) {    // RGB565 → [r, g, b]
    return [Math.round((c >> 11) * 255 / 31), Math.round(((c >> 5) & 63) * 255 / 63), Math.round((c & 31) * 255 / 31)];
  };
  var lumNotify = function (text) {
    if (!lum.notifying) return;
    emit('bluetooth.notification', { id: LUM.id, service: LUM_SERVICE, characteristic: LUM_NOTIFY, value: new DataView(new TextEncoder().encode(text).buffer) });
  };
  var lumStatus = function () {   // 11 characters: state, 000, P + digit, V + volts × 100, 0
    lumNotify((lum.charging ? '1' : '0') + '000P5V' + Math.round(lum.volts * 100) + '0');
  };
  var lumDraw = function () {
    if (!lum.panel) return;
    var screen = lum.panel.querySelector('canvas'), g = screen.getContext('2d');
    var bits = lumPage(lum.shown), c = lum.colors[lum.shown] || { bg: [0, 0, 0], fg: [255, 255, 255] }, img = g.createImageData(lum.w, lum.h);
    var bg = c.bg, fg = c.fg;
    for (var y = 0; y < lum.h; y++) for (var x = 0; x < lum.w; x++) {
      var on = bits[y * lum.w / 8 + (x >> 3)] & (1 << (x & 7)), col = on ? fg : bg, i = (y * lum.w + x) * 4;
      img.data[i] = col[0]; img.data[i + 1] = col[1]; img.data[i + 2] = col[2]; img.data[i + 3] = 255;
    }
    g.putImageData(img, 0, 0);
    if (lum.bar) {
      g.fillStyle = 'rgba(0,0,0,.6)'; g.fillRect(0, 0, lum.w, 11);
      g.fillStyle = '#aaa'; g.font = '9px system-ui'; g.textBaseline = 'top';
      g.fillText(new Date().toTimeString().slice(0, 5), 3, 1);
      g.fillText(Math.round(Math.max(0, Math.min(1, (lum.volts - 3.5) / 0.65)) * 100) + '%', lum.w - 26, 1);
    }
    screen.style.opacity = 0.25 + lum.light / 133;
  };
  var lumShow = function () {
    if (lum.panel || !document.body) return;
    var p = lum.panel = document.createElement('div');
    p.id = 'aura-mock-lumenduo';
    p.style.cssText = 'position:fixed;left:8px;bottom:8px;z-index:2147483000;width:252px;padding:6px;border:1px solid #ff2d92;border-radius:14px;background:#111;font:10px system-ui;color:#888';
    p.innerHTML = '<div style="margin:0 2px 4px">Lumen Duo (mock)</div><canvas width="' + lum.w + '" height="' + lum.h + '" style="display:block;width:100%;image-rendering:pixelated;border-radius:6px;background:#000"></canvas><div style="display:flex;gap:3px;margin-top:5px"></div>';
    [['L', '0K0'], ['L×2', '1K0'], ['R', '0K1'], ['R×2', '1K1'], ['R long', '2K1'],
      ['Charge', function (b) { lum.charging = !lum.charging; b.style.background = lum.charging ? '#0a84ff' : '#333'; lumStatus(); }]
    ].forEach(function (item) {
      var b = document.createElement('button');
      b.textContent = item[0];
      b.onclick = typeof item[1] === 'function' ? function () { item[1](b); } : function () { log('Lumen Duo button', item[1]); lumNotify(item[1]); };
      b.style.cssText = 'flex:1;min-width:0;padding:4px 0;border:0;border-radius:4px;background:#333;color:#fff;font:9px system-ui';
      p.lastChild.appendChild(b);
    });
    document.body.appendChild(p);
    lumDraw();
  };
  var lumReset = function () { lum.connected = lum.notifying = false; clearInterval(lum.statusTimer); };
  var lumCommand = function (b) {
    var op = b[0], page = b[1] || 0;
    if (op === 0xAE) {
      var rows = lumPage(page), at = b[3] * lum.w / 8;
      for (var i = 4; i < b.length && at + i - 4 < rows.length; i++) rows[at + i - 4] = b[i];
    } else if (op === 0xE0) lum.shown = page;
    else if (op === 0xF2) lum.colors[page] = { bg: lumRGB((b[2] << 8) | b[3]), fg: lumRGB((b[4] << 8) | b[5]) };
    else if (op === 0x5A && b[1] === 0xA5) lum.clearArmed = true;
    else if (op === 0xAA && lum.clearArmed) { lum.clearArmed = false; lum.pages = {}; }
    else if (op === 0xBB) lum.light = b[1];
    else if (op === 0xE3) {
      if (lum.panel && lum.panel.animate) lum.panel.animate([{ transform: 'translateX(-3px)' }, { transform: 'translateX(3px)' }, { transform: 'none' }], { duration: 60 + b[1] * 2, iterations: 2 });
    } else if (op === 0xFB) lum.bar = !lum.bar;
    else if (op === 0xFF) setTimeout(function () { lumNotify('ZY_DUO096-V1.0.3'); }, 40);
    if (op !== 0xAE) log('Lumen Duo command', '0x' + op.toString(16), Array.from(b.slice(1, 8)).join(' '));
    clearTimeout(lum.timer);
    lum.timer = setTimeout(lumDraw, 10);
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

  // Aura.contact : une fiche simple à la place de la fiche native, avec le .vcf à télécharger.
  var showContact = function (text) {
    var unfolded = text.replace(/\r?\n[ \t]/g, '');
    var field = function (name) {
      return unfolded.split(/\r?\n/).filter(function (l) { return l.toUpperCase().indexOf(name + ':') === 0 || l.toUpperCase().indexOf(name + ';') === 0; })
        .map(function (l) { return l.slice(l.indexOf(':') + 1).replace(/\\n/gi, '\n').replace(/\\(.)/g, '$1'); });
    };
    var old = document.getElementById('aura-mock-contact');
    if (old) old.remove();
    var box = document.createElement('div');
    box.id = 'aura-mock-contact';
    box.style.cssText = 'position:fixed;inset:0;z-index:2147483647;display:flex;align-items:flex-end;justify-content:center;background:rgba(0,0,0,.45);font:15px -apple-system,system-ui,sans-serif';
    var sheet = document.createElement('div');
    sheet.style.cssText = 'width:min(420px,100%);background:#1c1c1e;color:#fff;border-radius:14px 14px 0 0;padding:18px 18px 24px;box-sizing:border-box;text-align:center';
    var photo = field('PHOTO')[0];
    var add = function (tag, txt, css) { var el = document.createElement(tag); el.textContent = txt; el.style.cssText = css || ''; sheet.appendChild(el); return el; };
    add('div', '[Aura mock] contact card', 'color:#8e8e93;font-size:12px;margin-bottom:10px');
    if (photo) { var img = document.createElement('img'); img.src = 'data:image/jpeg;base64,' + photo; img.style.cssText = 'width:72px;height:72px;border-radius:50%;object-fit:cover'; sheet.appendChild(img); }
    add('div', field('FN')[0] || '', 'font-size:22px;font-weight:600;margin:6px 0 2px');
    var org = [field('TITLE')[0], field('ORG')[0]].filter(Boolean).join(' · ');
    if (org) add('div', org, 'color:#8e8e93');
    field('TEL').concat(field('EMAIL'), field('URL')).forEach(function (v) { add('div', v, 'color:#0a84ff;margin-top:6px'); });
    var buttons = document.createElement('div');
    buttons.style.cssText = 'display:flex;gap:10px;margin-top:16px';
    var btn = function (label, fn) {
      var b = document.createElement('button');
      b.textContent = label; b.onclick = fn;
      b.style.cssText = 'flex:1;border:0;border-radius:10px;padding:12px;font:inherit;font-weight:600;background:#2c2c2e;color:#0a84ff;cursor:pointer';
      buttons.appendChild(b);
    };
    btn('Download .vcf', function () {
      var a = document.createElement('a');
      a.href = 'data:text/vcard;charset=utf-8,' + encodeURIComponent(text);
      a.download = ((field('FN')[0] || 'contact').replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'contact') + '.vcf';
      document.body.appendChild(a); a.click(); a.remove();
    });
    btn('Close', function () { box.remove(); });
    sheet.appendChild(buttons);
    box.appendChild(sheet);
    box.addEventListener('click', function (e) { if (e.target === box) box.remove(); });
    document.body.appendChild(box);
  };

  var Aura = {
    __mock: true,
    version: 1,
    capabilities: function () {
      return ok({ version: 1, appClip: appClip, haptics: true, customHaptics: true, bluetooth: true, peer: true, proximity: true, deviceInfo: true,
        statusBar: true, orientationLock: true, volumeButtons: true, glass: true, liquidGlass: false, contacts: true, keyboard: true, flic: true });
    },
    deviceInfo: function () {
      var dark = !!(window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches);
      var mq = function (q) { return !!(window.matchMedia && matchMedia(q).matches); };
      var dpr = window.devicePixelRatio || 1;
      var langs = (navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language || 'en']).slice();
      var resolved = Intl.DateTimeFormat().resolvedOptions();
      var h12 = new Intl.DateTimeFormat(undefined, { hour: 'numeric' }).resolvedOptions().hour12;
      return ok({
        userId: appClip ? 'MOCK-TAG-ID' : 'MOCK-USER-ID', vendorId: 'MOCK-' + me, model: 'Simulator', systemName: 'Web', systemVersion: '1', appClip: appClip,
        modelIdentifier: 'Mock1,1', modelName: 'Simulator', idiom: 'phone',
        screen: {
          width: screen.width, height: screen.height,
          nativeWidth: Math.round(Math.min(screen.width, screen.height) * dpr), nativeHeight: Math.round(Math.max(screen.width, screen.height) * dpr),
          scale: dpr, maxFrameRate: 60, safeArea: { top: 0, left: 0, bottom: 0, right: 0 },
          orientation: screen.width > screen.height ? 'landscapeLeft' : 'portrait'
        },
        appearance: {
          colorScheme: dark ? 'dark' : 'light', contentSize: 'l', boldText: false,
          reduceMotion: mq('(prefers-reduced-motion: reduce)'), reduceTransparency: mq('(prefers-reduced-transparency: reduce)'),
          increaseContrast: mq('(prefers-contrast: more)'), voiceOver: false, invertColors: mq('(inverted-colors: inverted)')
        },
        locale: {
          languages: langs, language: langs[0].split('-')[0], region: langs[0].split('-')[1] || null, currency: null,
          timeZone: resolved.timeZone, hourCycle: h12 ? '12h' : '24h', measurementSystem: 'metric', firstWeekday: 'monday'
        }
      });
    },
    haptic: function (type, options) { log('haptic', type, options || ''); return ok(); },
    prepareHaptics: function () { return ok(); },
    on: function (name, fn) { (listeners[name] = listeners[name] || []).push(fn); return function () { Aura.off(name, fn); }; },
    off: function (name, fn) { listeners[name] = (listeners[name] || []).filter(function (f) { return f !== fn; }); },
    // Aura.keyboard : pas de barre native ici (journalisée) ; la hauteur vient de visualViewport
    // (clavier virtuel d'un téléphone ou d'une tablette), --aura-keyboard-height est tenu à jour.
    keyboard: (function () {
      var state = { visible: false, height: 0, accessoryHeight: 0, duration: 0.25 };
      var watching = false, toolbarItems = null;
      var css = function () {
        var root = document.documentElement;
        root.style.setProperty('--aura-keyboard-height', state.height + 'px');
        root.style.setProperty('--aura-keyboard-duration', state.duration + 's');
        root.classList.toggle('aura-keyboard-visible', state.visible);
      };
      var measure = function () {
        var vv = window.visualViewport;
        if (!watching || !vv) return;
        var height = Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop));
        if (height < 80) height = 0;                       // barres du navigateur, pas un clavier
        if (height === state.height) return;
        var was = state.visible;
        state = { visible: height > 0, height: height, accessoryHeight: toolbarItems ? 64 : 0, duration: 0.25 };
        css();
        if (state.visible !== was) emit(state.visible ? 'keyboard.show' : 'keyboard.hide', state);
        emit('keyboard.change', state);
      };
      if (window.visualViewport) window.visualViewport.addEventListener('resize', measure);
      return {
        watch: function () { watching = true; css(); measure(); return ok(state); },
        unwatch: function () { watching = false; return ok(); },
        state: function () { return ok(state); },
        hide: function () { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); return ok(); },
        set: function (o) { log('keyboard.set', o || {}); return ok({ accessory: (o && o.accessory) || 'default', dismissMode: (o && o.dismissMode) || 'none' }); },
        toolbar: function (o) {
          o = Array.isArray(o) ? { items: o } : (o || {});
          toolbarItems = o.items || [];
          log('keyboard toolbar (call Aura._mockTap(id) to simulate a tap)', toolbarItems);
          return ok({ accessory: 'toolbar', dismissMode: 'none' });
        },
        update: function (id, changes) { log('keyboard toolbar update', id, changes || {}); return ok(); },
        reset: function () { toolbarItems = null; return ok(); },
      };
    })(),
    _mockTap: function (id) { emit('keyboard.toolbar.tap', { id: String(id) }); },
    flic: {
      start: function () {
        if (!flicState.started) {
          flicState.started = true;
          setTimeout(function () { flicState.restored = true; flicChanged(); }, 300);
        }
        return ok(flicCopy());
      },
      state: function () { return ok(flicCopy()); },
      pair: function () {
        if (!flicState.restored) { flicState.lastError = 'Wait for the restore and turn Bluetooth on.'; return ok(flicCopy()); }
        flicState.scanning = true; flicState.scanStatus = 'searching'; flicState.lastError = null;
        clearTimeout(flicPairTimer);
        flicPairTimer = setTimeout(function () {
          var n = flicState.buttons.length + 1;
          flicState.buttons.push({ id: 'MOCK-FLIC-' + n, name: 'Flic ' + n, ready: true, state: 'connected', batteryVoltage: 3.0 });
          flicState.scanning = false; flicState.scanStatus = 'completed';
          log('flic: paired "Flic ' + n + '" — arm reception, then press 1 / 2 / 3');
          flicChanged();
        }, 1500);
        return flicChanged();
      },
      cancelPairing: function () {
        clearTimeout(flicPairTimer);
        flicState.scanning = false; flicState.scanStatus = 'failed'; flicState.lastError = 'Pairing cancelled.';
        return flicChanged();
      },
      arm: function (value) { flicState.armed = value !== false; return flicChanged(); },
      mode: function (value) {
        if (value !== 'gestures' && value !== 'immediate') return fail("Aura: flic.mode must be 'gestures' or 'immediate'.");
        flicState.mode = value; return flicChanged();
      },
      connect: function () { return flicChanged(); },
      disconnect: function () { return flicChanged(); },
      forget: function (id) {
        flicState.buttons = flicState.buttons.filter(function (b) { return b.id !== id; });
        return flicChanged();
      },
    },
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
    contact: {
      add: function (card) {
        var text = typeof card === 'string' ? card : (window.AuraKit ? window.AuraKit.contact.vcard(card) : '');
        if (!/^\s*BEGIN:VCARD/i.test(text)) return fail('Aura: contact.add needs a vCard string.');
        log('contact card\n' + text);
        showContact(text);
        return ok();
      },
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
        var found = [DEV, NOVA, PLB, BOX, LUM].filter(function (d) {
          if (d === LUM) return !o || ((!o.name || o.name === LUM.name) && (!o.namePrefix || LUM.name.indexOf(o.namePrefix) === 0) && !(o.services && o.services.length));
          if (d === BOX) return !o || ((!o.name || o.name === BOX.name) && (!o.namePrefix || BOX.name.indexOf(o.namePrefix) === 0) && !(o.services && o.services.length));
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
        if (id === LUM.id) {
          lum.connected = true;
          lum.bar = true;           // assumed: shown after power-up, so the SDK's toggle at connection hides it
          lumShow();
          clearInterval(lum.statusTimer);
          lum.statusTimer = setInterval(function () { lum.volts = Math.max(3.6, lum.volts - (lum.charging ? -0.01 : 0.005)); lumStatus(); }, 10000);
          log('Lumen Duo connected: use its panel to press L / R');
          return ok({ id: LUM.id, name: LUM.name, services: [{ uuid: LUM_SERVICE, characteristics: [
            { uuid: LUM_WRITE, properties: ['write', 'writeWithoutResponse'] }, { uuid: LUM_NOTIFY, properties: ['notify'] }] }] });
        }
        if (id === BOX.id) {
          box.connected = true;
          boxShow();
          log('MysterBox connected: use its panel to touch, press, shake or turn it');
          return ok({ id: BOX.id, name: BOX.name, services: [{ uuid: boxId(1), characteristics: [
            { uuid: boxId(2), properties: ['write', 'writeWithoutResponse'] }, { uuid: boxId(3), properties: ['notify'] },
            { uuid: boxId(4), properties: ['read'] }, { uuid: boxId(5), properties: ['writeWithoutResponse'] },
            { uuid: boxId(6), properties: ['notify', 'read'] }] }] });
        }
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
        if (id === LUM.id) {
          var wasLum = lum.connected;
          lumReset();
          return ok().then(function () { if (wasLum) emit('bluetooth.disconnected', { id: LUM.id }); });
        }
        if (id === BOX.id) {
          var was = box.connected;
          boxReset();
          return ok().then(function () { if (was) emit('bluetooth.disconnected', { id: BOX.id }); });
        }
        if (id === NOVA.id) { nova.connected = false; novaStop(); return ok(); }
        if (id === PLB.id) { plb.connected = plb.notifying = false; return ok(); }
        connected = false; clearInterval(notifyTimer); return ok();
      },
      read: function (id, s, c) {
        if (id === BOX.id) return boxOp('read', c, function (char) {
          return new DataView((char === boxId(4) ? new TextEncoder().encode(boxStatus()) : Uint8Array.from([box.face])).buffer);
        });
        return connected ? ok(new DataView(bytes(lastWrite).buffer.slice(0))) : fail('Not connected.');
      },
      write: function (id, s, c, data, o) {
        if (id === BOX.id) return boxWrite(c, data, o);
        if (id === LUM.id) {
          if (!lum.connected) return fail('Aura: device is not connected.');
          var lb = bytes(data);
          if (String(c).toUpperCase() === LUM_WRITE && lb.length) lumCommand(lb);
          return o && o.withoutResponse ? Promise.resolve() : ok();
        }
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
        if (id === BOX.id) return boxOp('notify', characteristic, function (char) { box[char === boxId(3) ? 'events' : 'imu'] = true; });
        if (id === LUM.id) {
          if (!lum.connected) return fail('Aura: device is not connected.');
          lum.notifying = true;
          setTimeout(lumStatus, 300);
          return ok();
        }
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
      stopNotifications: function (id, service, characteristic) {
        if (id === BOX.id) return boxOp('notify', characteristic, function (char) { box[char === boxId(3) ? 'events' : 'imu'] = false; });
        if (id === LUM.id) lum.notifying = false; else if (id === PLB.id) plb.notifying = false; else if (id === NOVA.id) novaStop(); else clearInterval(notifyTimer); return ok(); },
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
