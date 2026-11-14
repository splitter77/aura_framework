# AuraKit reference

1. [Loading](#1-loading)
2. [Environment: `AuraKit.ready()`](#2-environment-aurakitready)
3. [Haptics: `AuraKit.haptics`](#3-haptics-aurakithaptics)
4. [Link between two iPhones: `AuraKit.link()`](#4-link-between-two-iphones-aurakitlink)
5. [Shared state: `link.shared()`](#5-shared-state-linkshared)
6. [Bluetooth LE: `AuraKit.ble`](#6-bluetooth-le-aurakitble)
7. [Proximity: `AuraKit.proximity`](#7-proximity-aurakitproximity)
8. [Camera and torch: `AuraKit.camera`](#8-camera-and-torch-aurakitcamera)
9. [Device identifiers: `AuraKit.device()`](#9-device-identifiers-aurakitdevice)
10. [Events and raw calls](#10-events-and-raw-calls)
11. [iframes](#11-iframes)
12. [UI helpers: `aurakit-ui.js`](#12-ui-helpers-aurakit-uijs)
13. [Translations: `aurakit-i18n.js`](#13-translations-aurakit-i18njs)
14. [Simulator: `aurakit-mock.js`](#14-simulator-aurakit-mockjs)
15. [Device drivers: `devices/`](#15-device-drivers-devices)
16. [Wire format](#16-wire-format)
17. [The native `window.Aura` bridge](#17-the-native-windowaura-bridge)

---

## 1. Loading

```html
<link rel="stylesheet" href="aurakit-ui.css">                                   <!-- optional -->
<script src="aurakit-i18n.js" data-default="fr" data-languages="fr,en"></script> <!-- optional -->
<script src="aurakit-mock.js"></script>                                          <!-- optional, before aurakit.js -->
<script src="aurakit.js"></script>
<script src="aurakit-ui.js"></script>                                            <!-- optional, after aurakit.js -->
```

`aurakit.js` defines a single global, `AuraKit`. It runs in iOS Safari 15+ (the WebKit used by Aura) and in any current desktop browser.

## 2. Environment: `AuraKit.ready()`

```js
const env = await AuraKit.ready();
if (!env.available) console.log(env.reason);
```

Resolves once (later calls return the same promise) to:

| Field | Meaning |
| --- | --- |
| `available` | `true` when native features work on this page. |
| `appClip` | `true` in the AuraClip App Clip. |
| `browser` | `true` in Aura Browser. |
| `caps` | `Aura.capabilities()`: `{ version, appClip, haptics, customHaptics, bluetooth, peer, proximity, deviceInfo }`, or `null`. |
| `frame` | `true` when the page is inside an iframe. |
| `proxied` | `true` when an iframe uses Aura through its parent page (see [iframes](#11-iframes)). |
| `mock` | `true` with the desktop simulator. |
| `reason` | Why native features are not available (not in Aura, domain not in bookmarks, not HTTPS…). |
| `version` | AuraKit version. |

Shortcuts, filled once `ready()` has resolved: `AuraKit.env`, `AuraKit.available`, `AuraKit.isAppClip`, `AuraKit.isBrowser`. `AuraKit.inFrame` is known immediately. `AuraKit.version` is the framework version.

You never have to wait for `ready()` before calling the rest of the API: every function waits for it internally.

### Quitting the App Clip: `AuraKit.quitAppClip()`

```js
quitButton.onclick = () => AuraKit.quitAppClip().catch((e) => alert(e.message));
```

Closes the App Clip. iOS gives App Clips no official way to close themselves, so this relies on a crash in the native bridge: `Aura.peer.join()` converts its `timeout` to nanoseconds without a bound, and an oversized value overflows. When it works the promise never settles, because the App Clip is gone.

It rejects when the page is not in the App Clip (Aura Browser, plain browser), when it is called from an iframe, or when the App Clip is still running afterwards: Bluetooth must be on and allowed, otherwise `peer.join` fails before reaching the overflow. If a future version of Aura bounds the timeout, the call rejects instead of quitting.

## 3. Haptics: `AuraKit.haptics`

```js
AuraKit.haptics.tap();                 // medium impact
AuraKit.haptics.success();
AuraKit.haptics.preset('heartbeat');
AuraKit.haptics.morse('SOS');
```

| Function | Effect |
| --- | --- |
| `impact(style = 'medium', intensity?)` / `tap(style, intensity?)` | Impact. `style`: `light`, `medium`, `heavy`, `soft`, `rigid`. `intensity` 0–1. |
| `light()` `medium()` `heavy()` `soft()` `rigid()` | Impact shortcuts. |
| `success()` `warning()` `error()` | Notification feedback. |
| `selection()` | Selection tick. |
| `pattern(events)` | Core Haptics pattern. `events`: `[{ time, intensity, sharpness, duration }]`, times in seconds, values 0–1; `duration` 0 or missing = a tap, > 0 = continuous. |
| `buzz(seconds = 0.4, intensity = 1, sharpness = 0.3)` | Continuous vibration. |
| `preset(name)` | Named pattern: `tick`, `double`, `triple`, `heartbeat`, `knock`, `alarm`, `ramp`, `drumroll`, `buzz`. `presets` holds them (add your own: `AuraKit.haptics.presets.mine = [...]`). |
| `morse(text, { unit = 0.08 })` | Plays text (letters and digits) or a code made of `.`, `-`, spaces and `/`. Returns the duration in seconds. |
| `morseCode(text)` | Text → Morse code string (`'SOS'` → `'... --- ...'`). |
| `play(...)` | Raw call, same arguments as `Aura.haptic()`. |
| `vibrate(pattern)` | `navigator.vibrate` (works in Aura, does nothing in Safari). |
| `prepare()` | Removes the latency of the first haptic. Called automatically on the first touch of the page. |

Fallbacks: on hardware without Core Haptics, patterns are played as a sequence of impacts; outside Aura, everything is mapped to `navigator.vibrate` (Android browsers).

## 4. Link between two iPhones: `AuraKit.link()`

```js
const link = AuraKit.link(options);
```

Creates the page's link on the first call and returns the **same object** on later calls (the native link is shared by the whole page). It starts by itself:

- In **Aura Browser** it **hosts**: it advertises over Bluetooth and waits, retrying every 3 s if Bluetooth is off or the permission prompt is open.
- In the **App Clip** it **joins**: it searches for the host, in a loop, and searches again whenever the link drops.
- **Pairing is automatic**: without a `room`, the App Clip only connects to the Aura Browser of the person whose tag or link opened it, even with several Aura users nearby. With a `room`, any two Aura pages using the same code connect.

### Options

| Option | Default | Meaning |
| --- | --- | --- |
| `room` | automatic | Room code (case-insensitive, 64 characters max). Same code on both iPhones. |
| `role` | `'auto'` | `'host'`, `'guest'` (or `'join'`), or `'auto'` (Aura Browser hosts, App Clip joins). |
| `name` | `'Aura Browser'` / `'App Clip'` | Name shown to the other iPhone. |
| `joinTimeout` | `15` | Seconds of each search attempt. |
| `retryDelay` | `3000` | Milliseconds between two `host()` attempts after an error. |
| `autoStart` | `true` | `false` to call `link.start()` yourself. |
| `urlParams` | `true` | Read `?room=` and `?role=` from the URL (they win over the options). |
| `rememberRoom` | `true` | Keep the code given to `setRoom()` in `localStorage` (`aurakit.room`) and reuse it. |
| `debug` | `false` | Log every step to the console. |

### Properties

| Property | Meaning |
| --- | --- |
| `status` | `idle`, `starting`, `waiting` (host, advertising), `searching` (guest), `connected`, `error`, `stopped`, `unavailable`. |
| `error` | Last error message, with `status === 'error'` or `'unavailable'`. |
| `connected` | `true` while at least one other iPhone is connected. |
| `role` / `isHost` / `isGuest` | `'host'` or `'guest'` once started. |
| `room` | Current room code, or `undefined` for automatic pairing. |
| `peers` | `Map` of connected iPhones: id → name. A host can accept several guests. |
| `logs` | Last 200 steps, newest first: `[{ time: Date, text }]`. |
| `transport` | `'native'` (main frame) or `'frame'` (inside an iframe). |

### Messages

```js
link.send('card', 'Q♥');                         // → Promise<boolean>
link.onMessage('card', (card, from) => show(card));
```

| Function | Meaning |
| --- | --- |
| `send(type, data, { to })` | Sends a message. `type`: any non-empty string not starting with `~`. `data`: anything JSON can hold. Resolves to `true` once handed to Bluetooth, `false` when not connected. `to` (host only): one guest id instead of all. Messages over 64 KB are split and put back together automatically (a few KB/s: fine for a photo thumbnail, slow for big files). |
| `onMessage(type, fn)` | `fn(data, from)` for each message of that type. `'*'` receives every message: `fn(type, data, from)`. Returns a function that removes the handler. |
| `request(type, data, { timeout = 8000, to })` | Sends a question and resolves with the answer, or rejects after `timeout` ms. |
| `answer(type, fn)` | `fn(data, from)` returns (or resolves to) the answer to `request(type)`. If it throws, `request()` rejects with its message. |
| `onSync(fn)` | `fn({ peer, role })` each time the link connects: on the guest when it connects, on the host when a guest is ready to receive. Send your current state there, so a late guest catches up. |
| `sendRaw(data, options)` | `Aura.peer.send()` without the AuraKit envelope, to talk to pages that do not use AuraKit. |

Messages from pages that do not use AuraKit arrive as type `'text'` (string), `'binary'` (`DataView`) or `'json'` (object). An object with a string `t` field arrives as type `t` (e.g. `{ t: 'card', card: 'AS' }` → `onMessage('card', (obj) => …)`), so AuraKit pages can talk to existing Aura pages.

### Control

| Function | Meaning |
| --- | --- |
| `start()` | Starts the link (automatic unless `autoStart: false`). |
| `stop()` | Closes it until `start()` or `restart()`. |
| `restart()` | Closes and opens it again. |
| `setRoom(code, { remember = true })` | Changes the room (empty = automatic pairing) and restarts. |
| `log(text)` | Adds a line to `logs`. |

### Events

`link.on(name, fn)` returns a function that removes the listener; `link.once()` and `link.off()` also exist.

| Event | Arguments |
| --- | --- |
| `status` | `(status, error)` |
| `connect` | `({ id, name })` |
| `disconnect` | `({ id, name })` |
| `sync` | `({ peer, role })` (same as `onSync`) |
| `message` | `(type, data, from)` for every message |
| `progress` | `({ id, received, total, from })` while a message larger than 64 KB arrives |
| `log` | `({ time, text })` |
| `error` | `(Error)` when `host()` or `join()` fails (the link keeps retrying) |

## 5. Shared state: `link.shared()`

```js
const game = link.shared('game', { round: 1, score: 0 });
game.subscribe((value, { local }) => render(value));
game.patch({ score: game.get().score + 10 });
```

A value kept identical on both iPhones. Either side can change it; the last change wins. When the link connects, the guest takes the host's value.

| Member | Meaning |
| --- | --- |
| `link.shared(name, initial)` | Creates (or returns) the state named `name`. The value must be JSON-compatible. |
| `get()` / `value` | Current value. |
| `set(value)` | Replaces the value and sends it. |
| `patch(object)` | Merges an object into the value (shallow) and sends it. |
| `update(fn)` | `fn(copy)` returns the new value. |
| `subscribe(fn)` | `fn(value, { local, initial })` now and after each change. `local` is `false` when the change came from the other iPhone. Returns an unsubscribe function. |
| `on('change', fn)` | Same as `subscribe` without the first call. |

Each `set` sends the whole value: keep shared states small (a few KB), and use one state per topic.

## 6. Bluetooth LE: `AuraKit.ble`

```js
const sensor = await AuraKit.ble.connect({ services: ['180D'] }, { autoReconnect: true });
await sensor.notify('180D', '2A37', (value) => console.log('Heart rate', value.getUint8(1)));
const battery = await sensor.read('180F', '2A19');
await sensor.write('FFE0', 'FFE1', 'hello');
```

UUIDs are 16-bit (`'180D'`, any case) or full; `'0000180d-0000-1000-8000-00805f9b34fb'` and `'180D'` are the same. Data to write can be a string (UTF-8), an array of bytes, an `ArrayBuffer` or a typed array. Values read arrive as a `DataView`.

| Function | Meaning |
| --- | --- |
| `state()` | `'poweredOn'`, `'poweredOff'`, `'unauthorized'`, `'unsupported'`, `'resetting'` or `'unknown'`. |
| `find({ services, name, namePrefix, timeout = 10 })` | First matching device: `{ id, name, rssi }`. |
| `scan(filter, onDevice)` | Continuous scan. `onDevice(device, seen)` for each advertisement; `seen` is a `Map` id → device. Resolves to an async `stop()` that returns the devices seen. |
| `connect(target, { autoReconnect = false, timeout = 10, reconnectDelay = 1500 })` | `target`: a filter (as `find`), a device from `find`/`scan`, or an id. Resolves to a `BleDevice`. |
| `text(value)` / `bytes(value)` / `hex(value)` | `DataView` → string / `Uint8Array` / `'0a 1b …'`. |
| `shortUUID(uuid)` | Normalizes a UUID (`'0000180d-…'` → `'180D'`). |

### `BleDevice`

| Member | Meaning |
| --- | --- |
| `id`, `name`, `services`, `connected` | `services`: `[{ uuid, characteristics: [{ uuid, properties }] }]`. |
| `read(service, characteristic)` | `DataView`. |
| `readText(service, characteristic)` | String (UTF-8). |
| `write(service, characteristic, data, { withoutResponse, chunkSize, delay })` | `chunkSize` splits the data into packets, `delay` ms apart (for devices with small buffers). |
| `notify(service, characteristic, fn)` | `fn(DataView, detail)` for each value. Resolves to an async function that stops it. |
| `disconnect()` | — |
| Events | `disconnect` (`{ manual }`), `reconnecting`, `reconnect`, `notification` (every value). With `autoReconnect`, notifications are turned on again after a reconnection. |

The first Bluetooth call shows the iOS permission prompt. Bluetooth only works while the page is on screen.

## 7. Proximity: `AuraKit.proximity`

```js
const watcher = await AuraKit.proximity.watch(({ near }) => console.log(near ? 'covered' : 'uncovered'));
if (!watcher.supported) console.log('no sensor');
watcher.stop();
```

`watch(fn)` resolves to `{ supported, near, stop() }`. Several watchers can run; the sensor stops with the last one. `AuraKit.proximity.near` is the last known state. While it is watched, iOS turns the screen off when the sensor is covered.

## 8. Camera and torch: `AuraKit.camera`

```js
await AuraKit.camera.open({ facing: 'environment', video: document.querySelector('video') });
await AuraKit.camera.torch(true);
const jpeg = await AuraKit.camera.snapshot({ maxSize: 240 });   // data URL, small enough for link.send()
AuraKit.camera.close();
```

| Member | Meaning |
| --- | --- |
| `open({ facing = 'environment', audio = false, video })` | Opens the camera (`'user'` = front) and shows it in `video` if given. Resolves to the `MediaStream`. |
| `torch(on = true)` | Turns the torch on or off, opening the back camera if needed. Resolves to the state reported by the camera. |
| `hasTorch()` | `true` if the open camera has a torch. |
| `snapshot({ maxSize = 240, quality = 0.7, type = 'image/jpeg' })` | Data URL of the current frame, scaled down to `maxSize` px. |
| `close()` | Stops the camera. |
| `stream`, `facing`, `video`, `track()` | Current stream, side, video element, video track. |

These use the standard web APIs; Aura adds the iOS permissions they need. Microphone and location work with the standard APIs too (`getUserMedia({ audio: true })`, `navigator.geolocation`).

## 9. Device identifiers: `AuraKit.device()`

```js
const info = await AuraKit.device();   // null outside Aura
// { userId, vendorId, model, systemName, systemVersion, appClip }
```

`userId` is the Aura identifier: in Aura Browser it follows your iCloud Keychain; in the App Clip it is the identifier of the scanned tag or link. `vendorId` is specific to this device. The result is cached.

## 10. Events and raw calls

```js
const off = AuraKit.on('bluetooth.state', ({ state }) => console.log(state));
const state = await AuraKit.call('bluetooth.state');
```

| Function | Meaning |
| --- | --- |
| `AuraKit.on(name, fn)` / `AuraKit.off(name, fn)` | Native events: `peer.connected`, `peer.message`, `peer.disconnected`, `bluetooth.discovered`, `bluetooth.notification`, `bluetooth.state`, `bluetooth.disconnected`, `proximity`. They also work in iframes (except `peer.*`, which go through the link). |
| `AuraKit.call(path, ...args)` | Any native function by its path, e.g. `AuraKit.call('haptic', 'impact', { style: 'rigid' })`. |
| `AuraKit.Emitter` | The small event class used everywhere (`on`, `once`, `off`, `emit`), for your own objects. |
| `AuraKit.params` | `URLSearchParams` of the page. |
| `AuraKit.sleep(ms)` | Promise that resolves after `ms`. |

## 11. iframes

Aura does not answer pages inside an iframe. AuraKit fixes that: **load `aurakit.js` on both the parent page and the iframe page**, and the iframe gets the same API through its parent, with no extra code.

- `AuraKit.ready()` in the iframe resolves with `available: true` and `proxied: true`.
- Haptics, Bluetooth, proximity, device identifiers and native events go through the parent.
- `AuraKit.link()` in the iframe uses the parent's link (the parent creates it if it has not already). Messages, `request`/`answer`, `onSync` and shared states work as usual; a shared state changed in the iframe is also seen by the parent page and by its other iframes.
- The camera is not proxied: open it in the parent page, or allow it on the iframe (`<iframe allow="camera">`).

By default only iframes from the **same origin** are served. To allow others, call on the parent page:

```js
AuraKit.frames.allow(['https://other.example']);
```

and in an iframe whose parent has a different origin:

```js
AuraKit.frames.parentOrigin('https://parent.example');
```

`env(safe-area-inset-*)` is 0 inside an iframe; pass the values from the parent if you need them.

## 12. UI helpers: `aurakit-ui.js`

Load `aurakit-ui.css` and `aurakit-ui.js` (after `aurakit.js`), and put `class="ak"` on `<body>` for the base theme.

### HTML attributes (bound automatically)

| Attribute | Effect |
| --- | --- |
| `data-aura-status` | Connection pill: coloured dot + status + name of the other iPhone. |
| `data-aura-log` | Timestamped link log (use on a `<pre class="ak-log">`). |
| `<form data-aura-room>` | Room code form: its `<input>` holds the code, submitting calls `link.setRoom()`. |
| `data-aura-needs-peer` | Disabled while the other iPhone is not connected. |
| `data-aura-env` | `Aura Browser`, `App Clip`, `Simulator · …` or `Not in Aura`. |
| `data-aura-role` | `Host` / `Guest`. |
| `data-aura-peer` | Name of the other iPhone. |

Elements that need the link create it with default options, unless the page already called `AuraKit.link(options)` in a script before the page finished loading.

Classes on `<html>`: `ak-in-aura`, `ak-app-clip`, `ak-connected`. CSS helpers: `.ak-only-aura`, `.ak-only-connected`, `.ak-hide-in-aura`, `.ak-hide-connected`.

### JavaScript

| Function | Effect |
| --- | --- |
| `AuraUI.toast(text, ms = 2200)` | Short message at the bottom. |
| `AuraUI.flash(color = '#fff')` | Flashes the screen. |
| `AuraUI.reveal(text, { html, onClose })` | Full-screen text, tap to close. Returns `close()`. |
| `AuraUI.bindStatus(el, link)`, `bindLog(el, link)`, `bindRoomForm(form, link)` | The bindings above, by hand. |

### CSS classes

`ak-card`, `ak-row`, `ak-grid`, `ak-btn` (`.primary`, `.green`, `.red`), `ak-input`, `ak-log`, `ak-pill`, `ak-muted`, `ak-big`, `ak-list`, `ak-kv`, `ak-back`, `ak-lang`. Colours and radius are CSS variables (`--ak-bg`, `--ak-surface`, `--ak-accent`, `--ak-radius`…), and `--ak-safe-top` / `--ak-safe-bottom` hold the iPhone safe areas.

Labels follow `aurakit-i18n.js` when it is loaded (French or English), otherwise the page's `lang`.

## 13. Translations: `aurakit-i18n.js`

```html
<script src="aurakit-i18n.js" data-default="fr" data-languages="fr,en"></script>

<title data-en="Card trick">Tour de cartes</title>
<h1 data-en="Pick a card">Choisissez une carte</h1>
<p data-en-html="Scan the <b>tag</b>">Scannez le <b>tag</b></p>
<input placeholder="Mot" data-en-placeholder="Word">
<nav class="ak-lang"><button data-set-lang="fr">Français</button><button data-set-lang="en">English</button></nav>
```

| Script attribute | Default | Meaning |
| --- | --- | --- |
| `data-languages` | `fr,en` | Supported languages. |
| `data-default` | first language | Language the markup is written in. |
| `data-key` | `aurakit.lang` | `localStorage` key of the saved choice. |

Element attributes, for each language other than the default (`xx` = language code): `data-xx` (text), `data-xx-html`, `data-xx-placeholder`, `data-xx-aria` (aria-label), `data-xx-title`.

Language: `?lang=xx`, else the saved choice, else the phone language, else the default.

| JavaScript | Meaning |
| --- | --- |
| `t('Bonjour', 'Hello')` | String in the current language (arguments in the order of `data-languages`). Also `t({ fr: 'Bonjour', en: 'Hello' })`. Defined as `window.t` unless the page already has one; always available as `AuraI18n.t`. |
| `AuraI18n.lang` | Current language. |
| `AuraI18n.set('en')` | Saves the choice and reloads (the link reconnects by itself). `[data-set-lang]` buttons call it. |
| `AuraI18n.apply(root)` | Translates elements added later. |

## 14. Simulator: `aurakit-mock.js`

A fake `window.Aura` for desktop browsers. Load it **before** `aurakit.js`. It does nothing unless the URL has `?mock=`, and never runs inside Aura.

| URL | Simulates |
| --- | --- |
| `?mock=host` | Aura Browser |
| `?mock=join` | The App Clip |

- `Aura.peer` goes through `BroadcastChannel`: open two tabs of the same browser. Rooms are respected, messages over 64 KB are refused like on the iPhone.
- Haptics are logged to the console.
- Proximity: press **P** to cover / uncover the sensor while it is watched.
- Bluetooth: one device, **Mock Sensor** (`id` `MOCK-BLE-0001`, service `FFE0`, characteristic `FFE1`: read returns the last value written, notifications send a counter every second).
- Bluetooth: a Nova pen, **60BP-MOCK** (`id` `MOCK-NOVA-0001`), found by an unfiltered scan: once connected it writes a random number on a new sheet every few seconds, with real binary frames split across notifications.
- `deviceInfo()` returns fake identifiers.
- `quitAppClip()` (any `peer.join` whose timeout overflows) replaces the page with a “closed” notice, as if iOS had killed the app.

The tabs share `localStorage`: a room code saved in one tab is used by the other one after a reload.

## 15. Device drivers: `devices/`

`devices/aura-atom.js` (Electricks **Atom 2**), `devices/aura-peeksmith.js` (Electricks **PeekSmith 3**) and `devices/aura-nova.js` (**Nova Pen**, below) drive these devices over `window.Aura.bluetooth`. They run in the main frame.

```js
const atom = await AuraAtom.connect({ timeout: 15, lang: 'en' });
atom.on('click', ({ button }) => console.log('button', button));
await atom.vibrate('..');

const ps = await AuraPeekSmith.connect({ lang: 'en' });
await ps.text('Q♥');
```

Main members: `connect(options)` (`timeout`, `name`, `autoReconnect`, `lang`), `disconnect()`, `vibrate(pattern)`, `battery()`, `on(event, fn)`; Atom: `led(color, { blink })`, `configureButtons()`, `runScript(code)`; PeekSmith: `text(value)`, `clear()`, `brightness()`, `font()`, `align()`, `rotate()`, `subscribeTaps()`. Events: `button`, `press`, `release`, `click`, `longpress`, `status`, `connect`, `disconnect`… Protocols: [Electricks developer docs](https://developers.electricks.info/docs/bluetooth/devices/atom-2).

### Nova Pen: `devices/aura-nova.js`

`AuraNova` reads the **Nova Pen** (Ophaya 60BP optical smartpen) live. Demo: `examples/aura_nova.html`.

```js
const pen = await AuraNova.connect({ lang: 'en' });
pen.on('point', ({ x, y, force, page }) => console.log(x, y, force));
pen.on('stroke', (points) => console.log('stroke of', points.length, 'points'));
pen.on('page', ({ page }) => console.log('new sheet', page));
pen.on('change', () => pen.draw(canvas));
```

The pen does not advertise its service, so `connect()` scans without a filter and keeps the first device whose name contains `60BP`, `AFPEN`, `OPHAYA`, `SMARTPEN` or `APEN`. It needs no pairing and no init command: it subscribes to `69400003-B5A3-F393-E0A9-E50E24DCCA99` and receives about 33 points per second. The pen never says when the tip lifts: AuraNova infers it from sentinel frames, or from 120 ms without a point. A new page id must hold for 5 frames before it counts.

| Member | Meaning |
| --- | --- |
| `connect(options)` | `timeout` (20 s), `name` (exact name instead of the hints), `nameHints`, `autoReconnect` (`true`), `clearOnPageChange` (`true`), `lang`. |
| `disconnect()` | Disconnects and stops reconnecting. |
| `strokes` | Strokes of the current sheet: `[[{ x, y, force }]]`, in pen units (`AuraNova.UNITS_PER_MM` ≈ 23.6 per mm; force 0 to 1023). |
| `page`, `connected`, `name`, `stats` | Current sheet id, connection, pen name, `{ frames, rejects, sentinels, hz }`. |
| `clear()` / `undo()` | Forgets all strokes / the last one. |
| `bounds()` | Bounding box of the ink, or `null`. |
| `draw(canvas, { color, lineWidth, background, maxScale })` | Draws the ink fitted to the canvas. |
| `toDataURL({ width = 500, height = 800, lineWidth = 15 })` | Black ink on white, fitted (JPEG): ready to send to a handwriting recognition service. |
| `toSVG({ color, strokeWidth, margin })` | The ink as SVG, in millimetres. |

Events: `point`, `down` (first point of a stroke), `up` (`{ stroke }`), `stroke` (the finished points), `page`, `change`, `stats` (every second), `discovered` (each device seen while scanning), `status` (`scanning`, `connecting`, `connected`, `reconnecting`, `disconnected`), `connect`, `disconnect`. The decoder is exposed for tests: `AuraNova.decodeFrame`, `AuraNova.FrameAssembler`, `AuraNova.StreamProcessor`.

## 16. Wire format

Each `link.send(type, data)` is one `Aura.peer.send()` of the JSON object `{ t: type, d: data }`. Types starting with `~` are used by AuraKit:

| `t` | `d` | Purpose |
| --- | --- | --- |
| `~sync` | `null` | Guest → host once connected: “send me your state”. Triggers `sync` on the host. |
| `~req` | `{ id, type, data }` | `request()`. |
| `~res` | `{ id, data }` or `{ id, error }` | Answer to a `~req`. |
| `~state` | `{ name, value, ts, by, full }` | Shared state change; `full: true` when the host sends its states on sync. Newer `ts` wins (ties: higher `by`). |
| `~chunk` | `{ id, i, n, s }` | Piece `i` of `n` of a JSON envelope longer than 60 KB, `s` being up to 16 000 characters. |

## 17. The native `window.Aura` bridge

AuraKit is built on the bridge that Aura Browser and the App Clip inject into trusted pages (HTTPS, main frame, bookmarked domain or the App Clip's domain). You can mix both: everything below stays available as `window.Aura`.

| Function | Returns |
| --- | --- |
| `Aura.capabilities()` | `{ version, appClip, haptics, customHaptics, bluetooth, peer, proximity, deviceInfo }` |
| `Aura.deviceInfo()` | `{ userId, vendorId, model, systemName, systemVersion, appClip }` |
| `Aura.haptic(type, options)` / `Aura.haptic({ type: 'pattern', events })` | `impact` (`style`, `intensity`), `notification` (`style`), `selection`, or a pattern. |
| `Aura.prepareHaptics()` | — |
| `Aura.bluetooth.state()`, `requestDevice(o)`, `scan(o)`, `stopScan()`, `connect(id, o)`, `disconnect(id)`, `read(id, s, c)`, `write(id, s, c, data, o)`, `startNotifications(id, s, c)`, `stopNotifications(id, s, c)` | See [section 6](#6-bluetooth-le-aurakitble). |
| `Aura.peer.host({ room, name })` | `{ room, role: 'host' }` once advertising. |
| `Aura.peer.join({ room, name, timeout })` | The host `{ id, name, room, role: 'guest' }`, or rejects with “no device is hosting this room nearby”. |
| `Aura.peer.send(data, { to })` | Strings → `text`, `ArrayBuffer` / typed arrays → `binary`, anything else → `json`. 64 KB max. |
| `Aura.peer.peers()` / `Aura.peer.leave()` | `[{ id, name }]` / — |
| `Aura.proximity.start()` / `stop()` | `{ supported, near }` / — |
| `Aura.on(name, fn)` / `Aura.off(name, fn)` | Events; each one is also dispatched on `window` as `aura:<name>`. |

Limits: no motion sensors (Apple blocks Core Motion in App Clips); every new page load closes the link, disconnects Bluetooth devices and stops the proximity sensor, which is why a multi-screen experience should stay on one page (use `#hash` navigation or show/hide sections).
