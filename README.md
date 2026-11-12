# AuraKit

A small framework for building web pages that run in **Aura Browser** and the **AuraClip App Clip** on iPhone.

It is one script with no dependencies and no build step. It wraps the native `window.Aura` bridge and takes care of the parts every page would otherwise rewrite:

| Module | What it gives you |
| --- | --- |
| `AuraKit.ready()` | Tells you where the page is running: Aura Browser, App Clip, an iframe, the desktop simulator, or a plain browser (with the reason). |
| `AuraKit.haptics` | One-line haptics (`tap()`, `success()`…), named patterns (`preset('heartbeat')`), Morse code, continuous buzz, automatic warm-up, `navigator.vibrate` fallback. |
| `AuraKit.link()` | **Link between two iPhones** over Bluetooth: automatic pairing, automatic reconnection, typed messages, request/answer, sync on connect, **shared state**, and messages **larger than 64 KB**. |
| `AuraKit.ble` | Bluetooth LE devices: scan, connect, read, write (with chunking), notifications, automatic reconnection. |
| `AuraKit.proximity` | Proximity sensor. |
| `AuraKit.camera` | Camera, torch, JPEG snapshots. |
| `AuraKit.device()` | Device identifiers. |
| iframes | A page inside an iframe gets the same API through its parent page (Aura itself does not answer iframes). |

Optional add-ons:

| File | What it gives you |
| --- | --- |
| `aurakit-ui.css` + `aurakit-ui.js` | iOS-style dark theme, connection pill, link log, room code form, toast, screen flash, full-screen reveal, all usable with plain HTML attributes. |
| `aurakit-i18n.js` | Translate a page with HTML attributes (`data-en="…"`), language switch, `t('Bonjour', 'Hello')` in JavaScript. |
| `aurakit-mock.js` | Desktop simulator of `window.Aura`: test two iPhones with two browser tabs. |
| `devices/` | Ready-made drivers for the Electricks **Atom 2** and **PeekSmith 3**. |

## Quick start

```html
<!doctype html>
<html>
<head>
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <link rel="stylesheet" href="aurakit-ui.css">
  <script src="aurakit-mock.js"></script>   <!-- simulator, only active with ?mock=… -->
  <script src="aurakit.js"></script>
  <script src="aurakit-ui.js"></script>
</head>
<body class="ak">
  <span data-aura-status></span>
  <button class="ak-btn" id="buzz" data-aura-needs-peer>Buzz the other iPhone</button>

  <script>
    const link = AuraKit.link();                       // pairs Aura Browser and the App Clip by itself

    document.getElementById('buzz').onclick = () => link.send('buzz');
    link.onMessage('buzz', () => AuraKit.haptics.preset('double'));
  </script>
</body>
</html>
```

Open it in Aura Browser on your iPhone, then scan your Aura tag with a second iPhone: the App Clip opens the same page, the two iPhones connect, and the button buzzes the other phone.

### Shared state in three lines

```js
const score = AuraKit.link().shared('score', 0);
score.subscribe((value) => { scoreEl.textContent = value; });
plusButton.onclick = () => score.update((n) => n + 1);
```

Both iPhones always show the same value. A guest that connects late gets the host's value.

## Requirements

- **Aura Browser** on your iPhone; the **AuraClip** App Clip, opened from your Aura tag or link, on the second iPhone.
- The page must be served over **HTTPS**, on a domain that is in your **Aura bookmarks** (in the App Clip: the domain of the page the App Clip opened). Aura only gives native features to those pages, in the main frame.
- Both screens must stay on: locking a phone or leaving the page closes the Bluetooth link.

Outside Aura, every call still works and does nothing harmful: `AuraKit.ready()` resolves with `available: false` and a `reason`, haptics fall back to `navigator.vibrate`, and the link status is `unavailable`.

## Testing on a computer

Include `aurakit-mock.js` before `aurakit.js` and serve the folder:

```bash
python3 -m http.server 8770
```

Then open two tabs of the same browser:

- `http://localhost:8770/examples/?mock=host` behaves like Aura Browser (host)
- `http://localhost:8770/examples/?mock=join` behaves like the App Clip (guest)

The link, messages, shared state, rooms and iframes work between the two tabs. Haptics are logged to the console. Press **P** to cover the proximity sensor. Bluetooth shows one fake device, **Mock Sensor**, that sends a counter every second.

## Examples and templates

| Path | Shows |
| --- | --- |
| [`examples/haptics.html`](examples/haptics.html) | Every haptic, presets, Morse, played here or on the other iPhone |
| [`examples/sensors.html`](examples/sensors.html) | Environment, device identifiers, proximity, camera, torch, photo sent to the other iPhone |
| [`examples/bluetooth.html`](examples/bluetooth.html) | Scan, connect, notifications, write, PeekSmith |
| [`examples/counter.html`](examples/counter.html) | Shared state |
| [`examples/chat.html`](examples/chat.html) | Messages, request/answer (round trip), screen flash, reveal, 200 KB message |
| [`examples/card.html`](examples/card.html) | Performer picks a card, spectator sees it; sync for a guest that connects late |
| [`examples/frames/`](examples/frames/) | AuraKit inside an iframe |
| [`templates/starter/`](templates/starter/) | Starting point for a one-iPhone page |
| [`templates/two-iphones/`](templates/two-iphones/) | Starting point for a performer / spectator page, in French and English |

## Files

```
aurakit.js          The framework (required)
aurakit-mock.js     Desktop simulator (only with ?mock=…, never inside Aura)
aurakit-ui.css      iOS-style dark theme (optional)
aurakit-ui.js       UI helpers and HTML attributes (optional)
aurakit-i18n.js     Translations (optional)
devices/            Electricks Atom 2 and PeekSmith 3 drivers (optional)
examples/           One short HTML file per feature
templates/          Pages to copy and start from
docs/API.md         Full reference
```

## Documentation

**[docs/API.md](docs/API.md)** documents every function, option, event and HTML attribute, the message format between the two iPhones, and the native `window.Aura` bridge underneath.
