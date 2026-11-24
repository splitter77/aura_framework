# Lumen Duo

`devices/aura-lumenduo.js` drives the **Lumen Duo** (also sold as **Lumen S Eye**), a small display clipped on glasses, with two buttons and a vibration motor. It goes through Aura's Bluetooth LE bridge (`window.Aura.bluetooth`) and runs in the main frame. Demo: [`examples/lumenduo.html`](../examples/lumenduo.html).

```html
<script src="aurakit-mock.js"></script>          <!-- simulator, only with ?mock=… -->
<script src="devices/aura-lumenduo.js"></script>
<script>
  const duo = await AuraLumenDuo.connect({ lang: 'en', brightness: 80 });
  await duo.text('Q♥', { color: '#ff3b30' });               // red on black
  duo.on('click', ({ button }) => duo.text(button === 'left' ? '◀' : '▶'));
  duo.on('longpress', () => duo.clear());
  duo.on('battery', ({ volts, charging }) => console.log(volts, 'V', charging ? 'charging' : ''));
  await duo.vibrate(0.4);
</script>
```

> **Where the protocol comes from.** The manufacturer only ships a closed iOS framework (`LumenDuoFramework.xcframework`, in `acaat_swift/LumenDuoSDK`). There is no source and no protocol document: everything below was read from the framework's ARM64 code. The simulator follows it byte for byte, but it was **not tested with real glasses**. See [What was not checked](#what-was-not-checked).

## Connecting

`AuraLumenDuo.connect(options)` scans without a service filter (the SDK scans by name) and connects to the first device named **`Lumen-ZY-Duo`** or **`Lumen_S_Eye`**, or whose name contains `LUMEN`. Once connected it does what the SDK does, minus its green “DUO” splash: it toggles the status bar off, applies the brightness you passed, and asks for the firmware version.

If the link drops, the driver reconnects on its own (1 s, 2 s, 3 s, then every 4 s) until `disconnect()` is called; the brightness is sent again each time.

| Option | Default | Meaning |
| --- | --- | --- |
| `timeout` | `20` | Seconds to find and to connect. |
| `name` | — | Exact name to look for, instead of the names above. |
| `nameHints` | `['LUMEN']` | Parts of the name that are accepted. |
| `id` | — | Bluetooth id of a known device: no scan. |
| `autoReconnect` | `true` | Reconnect after an unexpected disconnection. |
| `hideStatusBar` | `true` | Send the status-bar toggle at each connection, as the SDK does. |
| `brightness` | — | 0 to 100 %, applied at each connection. |
| `vibrationStrength` | `0.5` | Default for `vibrate()`, 0 to 1. |
| `leftHanded` | `false` | Turn every picture 180°. |
| `mirror` | `false` | Flip every picture horizontally. |
| `height` | — | Force 60 or 80 rows (see [Display](#display)). |
| `lang` | browser | `'fr'` or `'en'`, for error messages. |

## Display

The display is **160 × 80 pixels, one bit per pixel**, with two colours per page: a lit pixel shows the page's foreground colour, an unlit one its background colour. The SDK uses 60 rows instead of 80 for a device it knows as `Lumen_ZY_EyeV2`; the driver does the same when the device has that name (`duo.height`).

The glasses do not draw text: the phone draws it and sends a picture. `text()` and `image()` do this in a canvas, turn it into one bit per pixel (grey ≥ 128 lights a pixel), and send it in 8 packets of 10 rows.

## Methods

| Member | Meaning |
| --- | --- |
| `connect()` / `disconnect()` | See above. `disconnect()` also stops the reconnection. |
| `text(value, { color, background, page, show, font, maxSize, align })` | Draws `value` in the biggest bold font that fits (from `maxSize` = 100 px down), `'\n'` for a new line, then sends it. Colours: any CSS colour (default white on black). Resolves with the canvas that was sent. |
| `image(source, { fit, threshold, dither, invert, color, background, page, show })` | `source`: canvas, `<img>`, `ImageBitmap`, video, `Blob`/`File` or URL. `fit`: `'contain'` (default), `'cover'` or `'stretch'`. `dither: true` spreads the error (Floyd–Steinberg): better for photos. Colours are only sent if you give them. Resolves with the canvas that was sent. |
| `bitmap(bits, { page, show })` | Sends a ready bitmap: 20 bytes per row, bit 0 = leftmost pixel, 1 = lit. |
| `colors({ color, background, page })` | Colours of a page. |
| `showPage(page)` | Shows a page whose pixels were sent with `show: false`. |
| `clear()` | Every page black. |
| `brightness(percent)` | 0 to 100. |
| `vibrate(amount)` | 0 to 1 (default `vibrationStrength`). The SDK calls it a duration. |
| `setVibrationStrength(value)` | Default for `vibrate()`. |
| `toggleStatusBar()` | Shows or hides the glasses' own status bar. It is a toggle: the glasses never say whether it is shown. |
| `requestFirmware(timeout = 3000)` | Resolves with the version (`''` if no answer). |
| `renderText(value, options)` / `renderImage(source, options)` / `toBitmap(canvas, options)` | The steps of `text()` and `image()`, without Bluetooth: use them for a preview. |
| `send(packets, { gap })` | Raw packets (one array of bytes, or an array of them). |
| `connected`, `name`, `id`, `width`, `height`, `firmware`, `battery`, `level`, `leftHanded`, `mirror`, `vibrationStrength` | State. `battery` is `{ volts, percent, charging, full }`. |

`page` is 0 everywhere by default, as in the SDK, which never uses another page. Other pages are accepted by the protocol; whether the glasses keep several pages is not known.

## Events

`duo.on(name, fn)` returns a function that removes the listener.

| Event | Detail |
| --- | --- |
| `button` | `{ button: 'left' \| 'right', press: 'single' \| 'double' \| 'long', code }` for every press. |
| `click`, `doubleclick`, `longpress` | Same detail, one event per kind of press. The SDK only knows the long press of the right button. |
| `battery` | `{ volts, percent, charging, full, raw, p }`. The glasses send it by themselves. `percent` is a rough estimate (3.5 V = 0 %, 4.15 V = 100 %), not the SDK's formula. |
| `charging` | `{ charging, full }` when the charging state changes. |
| `firmware` | `{ version, raw }`. |
| `message` | `{ text }`: any other notification. |
| `data` | `{ text, bytes }`: every notification, raw. |
| `status` | `{ state }`: `permission`, `scanning`, `connecting`, `connected`, `reconnecting` (with `attempt`), `disconnected`. |
| `connect`, `disconnect`, `discovered` | Connection, disconnection (`{ manual }`), each device seen while scanning. |

## Protocol

Commands are written **without response** to `6E40FF02-B5A3-F393-E0A9-E50E24DCCA9E`. The glasses answer with text notifications on `6E40FF03-B5A3-F393-E0A9-E50E24DCCA9E`. The service UUID is not in the SDK, which discovers every service: the driver takes the service that holds `6E40FF02`, and falls back to `6E40FF01-B5A3-F393-E0A9-E50E24DCCA9E` if the bridge does not list characteristics.

### Commands

| Bytes | Meaning |
| --- | --- |
| `5A A5 00`, then `AA` | Clear every page to black (two writes). |
| `BB level` | Brightness, `level` = 0 to 100. |
| `E3 v` | Vibrate, `v` = 0 to 255. |
| `FB page 00 00 5A` | Toggle the status bar. |
| `FF` | Sent by the SDK once connected; the glasses then send their firmware version. |
| `F2 page bgHi bgLo fgHi fgLo` | Page colours, RGB565, high byte first. |
| `AE page 00 row` + 200 bytes | 10 rows of pixels starting at `row` (0, 10, 20 … 70): 20 bytes per row, bit 0 = leftmost pixel, 1 = lit. The SDK waits 10 ms between packets. |
| `E0 page` | Show the page. |

The SDK sends text as: `F2` (colours), 40 ms pause, the `AE` packets, `E0`. A picture is the same without `F2`.

### Notifications

The text is trimmed, every `:` is replaced by `0`, then:

| Text | Meaning |
| --- | --- |
| `0K0` / `0K1` | Left / right button, single press. |
| `1K0` / `1K1` | Left / right button, double press. |
| `2K1` | Right button, long press (`2K0`, left long press, is not in the SDK; the driver accepts it). |
| `ZY_S_EYE-V…`, `ZY_DUO096-V…`, `ZY-DUO096-V…` | Firmware version: what follows the prefix. |
| 11 characters with a `P`, e.g. `1000P5V3980` | Status: character 0 is `0` (not charging), `1` (charging) or `2` (fully charged); characters 4–5 are `P` and a digit that the SDK reads but does not use; characters 6–9 are `V` and the voltage × 100 (`V398` = 3.98 V). Texts containing `REFRESH` and `UPGRADE-img` (firmware update) are not statuses. |

## Simulator

With `?mock=host` or `?mock=join`, `aurakit-mock.js` adds a fake **Lumen-ZY-Duo** (`id` `MOCK-LUMENDUO-0001`). Once connected, a panel at the bottom left shows its display at the real resolution, in the page colours, with its brightness and status bar. Its buttons send the button codes (**L**, **L×2**, **R**, **R×2**, **R long**), and **Charge** toggles charging. It sends a status at connection and every 10 seconds, and answers `FF` with `ZY_DUO096-V1.0.3`. The vibration shakes the panel.

```text
http://localhost:8770/examples/lumenduo.html?mock=host
```

## What was not checked

The simulator was built from the same reading of the SDK, so it cannot catch a misreading. Before relying on the driver, check with real glasses:

- **Service UUID.** `6E40FF01-…` is a guess. The driver picks whatever service holds `6E40FF02`, so this only matters if the bridge does not list characteristics.
- **204-byte writes without response.** The SDK writes each 204-byte pixel packet in one go, which needs an ATT MTU of at least 207. iOS silently drops writes without response that are too long (the MysterBox driver keeps its packets at 180 bytes for this reason). If pictures do not appear, this is the first suspect.
- **Order of the two colours in `F2`.** Read as background first, then foreground, from the SDK's `sendText(text, backgroundColor, textColor)`. If colours come out swapped, swap them in `colors()`.
- **Pixel order and threshold.** Bit 0 = leftmost pixel and grey ≥ 128 = lit come from the code that packs the image. A mirrored or inverted picture would point here.
- **Status bar.** `FB` is a toggle. The driver, like the SDK, assumes the bar is shown when the glasses start; if it is already hidden, the connection shows it.
- **`FF` = firmware request.** Inferred: the SDK sends it once connected, and the README says it then asks for the firmware version.
- **Vibration byte.** The SDK scales its “duration” (0 to 1) to 0–255. Whether the glasses read it as a duration or a strength is not known.
- **Status message.** Only the characters the SDK reads are known: 0 (charge), 4–5 (`P` + digit) and 6–9 (voltage). The meaning of the `P` digit, and how the SDK turns the voltage into a percentage, were not decoded.
- **Names.** `Lumen-ZY-Duo` and `Lumen_S_Eye` are the SDK's scan filter; the 60-row variant `Lumen_ZY_EyeV2` comes from a comparison in the SDK whose exact source (advertised name or stored name) was not traced.
- **Left button long press**, **pages other than 0**: not used by the SDK.
