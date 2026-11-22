# MysterBox

[MysterBox](https://mystersmith.info/user-guide/mysterbox/) is the MysterSmith firmware that turns a small AMOLED board into a secret display for magicians. `devices/aura-mysterbox.js` drives it from a page opened in Aura, without the MysterSmith app and without any change to Aura.

Demo: [`examples/mysterbox.html`](../examples/mysterbox.html). On a computer, add `?mock=host`, or `?mock=host&mysterbox=watch` for the Watch.

- [Using the device](#using-the-device): hardware, installation, buttons, screens
- [Programming it](#programming-it): connection, methods, events
- [Protocol](#protocol): what travels over Bluetooth

Sources: the official [user guide](https://mystersmith.info/user-guide/mysterbox/) and [BLE protocol](https://mystersmith.info/user-guide/mysterbox-ble-protocol/), read on 2026-11-22 (firmware 0.11.1). They are the reference if the firmware has changed since.

# Using the device

## Hardware

| | MysterBox | MysterBox Watch |
| --- | --- | --- |
| Waveshare board | ESP32-S3-Touch-AMOLED-1.8 (V2) | ESP32-S3-Touch-AMOLED-2.06 |
| Screen | 368 × 448 | 410 × 502 |
| Vibration motor | no | yes |
| Both | touch, motion sensor, speaker, microSD slot, BOOT and PWR buttons | |

Buy the **ESP32-S3** version **with battery**. The ESP32-C6 boards look identical and cannot run MysterBox.

The microSD card (FAT32, inserted before power-on) is optional: files otherwise go to about 3 MB of internal memory. Screenshots need the card.

## Installing or updating the firmware

1. On a computer, open the [installer](https://bsmagic.app/mysterbox/) in Chrome or Edge.
2. For the watch, choose **MysterBox Watch 2.06″** first.
3. Plug the board in with a USB-C data cable, click **Connect & install** and pick **USB JTAG/serial debug unit**.
4. Click **Install MysterBox**. Tick **Erase device** for a first installation only: leave it off to update and keep settings and files.

The installed version is shown at the bottom of the mode menu, on the start screen, and in `box.info.version`.

## Buttons

| Action | BOOT | PWR |
| --- | --- | --- |
| Short press | volume +10 % | volume −10 % (switches on when off) |
| Short press on a dice screen | brightness + | brightness − |
| Double press | robot ↔ Pitata dice | robot ↔ BLE dice |
| Hold | 1 s: mode menu | 2 s: switch off |
| Both together | screenshot | |

A short press reaches the page as a `button` event **and still does its own job on the device**: a button used as a trigger also changes the volume.

## Screens

- **Standby**: waits for an app, and stays black once one is connected.
- **Mr.Boxy**: robot eyes that react to movement. A swipe gives an emotion, a tap shows a card in the eyes.
- **Pitata Dice** / **BLE Dice**: the box reads three Pitata dice, or up to five BLE dice, by itself.

The first text, image, fill or black screen sent by the page replaces the robot and dice screens.

# Programming it

```html
<script src="devices/aura-mysterbox.js"></script>
<button id="connect">Connect</button>
<script>
  document.getElementById('connect').onclick = async () => {
    const box = await AuraMysterBox.connect({ lang: 'en', settings: { brightness: 40, volume: 0 } });
    await box.black();
    box.on('tap', () => box.text('Q♥', { color: '#ff3b30', only: true }));
    box.on('swipe', ({ direction }) => { if (direction === 'down') box.black(); });
  };
</script>
```

The page must be opened in Aura or the App Clip (HTTPS, trusted domain), in the main frame, and stay on screen. No pairing is needed.

## Connection

| Member | Meaning |
| --- | --- |
| `AuraMysterBox.connect(options)` | Connects to the first device named exactly `MysterBox`, and resolves to the box. |
| `new AuraMysterBox(options)`, then `connect()` | Same, with the time to register `status` and `connect` listeners first. |
| `AuraMysterBox.scan(onDevice)` | Every box has the same name: lists them with `onDevice(device, seen)`. Resolves to `stop()`. Connect with `{ id: device.id }`. |
| `AuraMysterBox.isAvailable()` | The bridge is present. |
| `disconnect()` | Disconnects and stops reconnecting; resolves once iOS has closed the link (2 s at most). The screen keeps its content. `connect()` can follow right away. |
| `connected`, `id`, `name` | Connection. |
| `info` | `{ version, board, watch, width, height, motor, sd, root, imu, audio, volume, rotation, position, battery, fields, raw }`, read when connecting. |
| `width`, `height`, `hasMotor`, `position` | Shortcuts; `position` follows the events. |
| `atLeast('0.11.0')` | Firmware version check. |

Options:

| Option | Default | Meaning |
| --- | --- | --- |
| `id` | first box found | The box to connect to. |
| `timeout` | `20` | Seconds to find it and to connect. |
| `autoReconnect` | `true` | Retries until `disconnect()` after the link drops. |
| `lang` | browser's | `'fr'` or `'en'`, for error messages. |
| `settings` | none | `{ brightness, textSize, textColor, rotation, volume }`, sent at each connection. |

The last values given to `brightness()`, `textSize()`, `textColor()`, `rotation()`, `volume()` and `motion()` are sent again after a reconnection.

Colors are `'#rgb'`, `'#rrggbb'` or `[r, g, b]`. All methods below return promises, except `point()`. Commands run in the order they are called: there is no need to await each one.

## Screen and text

| Method | Meaning |
| --- | --- |
| `text(value, { size, color, only })` | Centred, auto-sized text; `\n` breaks lines. `size` and `color` apply to this text only. `only: true` hides the image first. 509 bytes at most, opcode and style included. |
| `black()` | Clears text, image and drawing: the box looks switched off. |
| `fill(color)` | Fills the screen. |
| `brightness(percent)` | 0 to 100. |
| `textSize(px)` | Default maximum size, 20 to 200; 0 = 160. |
| `textColor(color)` | Default color. |
| `rotation(turns)` | Text rotation: 0 upright, 1 = 90° right, 2 = 180°, 3 = 90° left. |

There are three layers, from bottom to top: image, drawing, text. Changing one does not clear the others, hence the `only` options.

## Drawing

Coordinates are screen pixels: always scale with `box.width` and `box.height`.

| Method | Meaning |
| --- | --- |
| `stroke(points, { color, width })` | A whole line. Points: `[{ x, y }]` or `[[x, y]]`. |
| `pen(color, width)` | Pen of the next line, 1 to 40 px. |
| `point(x, y)` | One live point, batched every 40 ms. |
| `points(list)` | Points of the current line. |
| `penUp()` | Ends the line. |
| `clearDrawing()` | Clears the drawing only. |

```js
canvas.onpointerdown = (e) => { box.pen('#fff', 6); box.point(...toBox(e)); };
canvas.onpointermove = (e) => { if (e.buttons) box.point(...toBox(e)); };
canvas.onpointerup = () => box.penUp();
// toBox(e): your function, from the canvas position to [x, y] in box pixels
```

## Images and files

```js
await box.showPicture(fileInput.files[0], { fit: 'cover', onProgress: (p) => console.log(p) });

// Prepared before the trick, instant during it:
await box.upload('queen.jpg', await box.fitImage('cards/qh.png'));
await box.preloadImage('queen.jpg');
await box.showImage('queen.jpg', { only: true });
```

| Method | Meaning |
| --- | --- |
| `showPicture(source, options)` | Fits, uploads and shows a picture, alternating two file names so the current one stays until the next is ready. Takes the options of `fitImage` and `upload`, plus `only` (`true`). Resolves to `{ shown: true, name, size }`, or `{ shown: false }` when outdated (see below). |
| `fitImage(source, { fit, background, quality })` | JPEG `Blob` of exactly the screen size, about 80 KB at most. `source`: `Blob`, URL (CORS), `<img>` or canvas. `fit`: `'contain'` (default) or `'cover'`. |
| `upload(name, data, { onProgress, retries })` | `data`: `Blob`, `ArrayBuffer`, typed array or bytes. `onProgress(fraction, sent, total)`. Resolves once the box has checked the CRC. |
| `showImage(name, { only })` | Shows an uploaded image; `only: true` clears the text. |
| `preloadImage(name)` | Decodes it in advance; the box keeps 4 images. |
| `hideImage()` | Hides the image. |
| `deleteFile(name)` | Deletes a file. |

The screen command called last wins over a `showPicture()` still in progress:

- After `black()`, `fill()`, `mode()`, `card()`, `hideImage()`, `showImage()`, `text(…, { only: true })` or a disconnection, the picture is not shown and `showPicture()` resolves to `{ shown: false }`. An upload already started may finish, without being shown.
- After a plain `text()`, the picture is shown under that text, which is not cleared.
- Several `showPicture()` are shown one after the other, in order; the commands above drop all those called before them.

Only commands sent through the same `AuraMysterBox` object count: the driver does not know what is done on the box itself.

Names have 1 to 48 letters, digits, `.`, `_` or `-`. Images are baseline JPEG or PNG and are not scaled by the box. Uploads run one after the other, at 18 KB/s at most on iPhone: count at least 4 s for 80 KB, and prepare files before performing.

## Sound

| Method | Meaning |
| --- | --- |
| `beep(frequency, ms)` | 20 to 8000 Hz; default 1000 Hz, 150 ms. |
| `morse(text, wpm)` | 5 to 40 words per minute; default 20. |
| `effect(name)` | `beep`, `doubleBeep`, `powerUp`, `powerDown`, `alarm`, `laser`, `error`, `success`, `click`, `robot`, `huh`, `tada`, `siren`, `excited`, `angry`, `sad`, `love`, `card`, `shutter`, `surprised`, `happy`. |
| `play(name)` | An uploaded MP3 or WAV. A missing file comes as `soundEnd` with reason `notFound`. |
| `stopSound()` | Stops and empties the sound queue. |
| `volume(percent)` | 0 to 100, saved by the box. |

Emotions, effects and screenshots make noise: use `volume(0)` for a silent performance.

## Robot, dice, vibration

| Method | Meaning |
| --- | --- |
| `mode(name)` | `off`, `on`, `confused`, `excited`, `angry`, `sad`, `surprised`, `neutral`, `react`, `ignoreMovement`, `love`, `next`, `pitataDice`, `bleDice`, `menu`, `happy` (0.10.6 or newer). |
| `card(rank, suit)` | Card in the robot's eyes for 5 s: `card('QH')`, `card('10♠')`, `card(12, 2)` (suits 1 ♣, 2 ♥, 3 ♠, 4 ♦), `card()` = random. |
| `screenshot()` | Saved in `mb/shots/` on the microSD card. |
| `vibrate(pattern)` | `'short'` (150 ms), `'long'` (400 ms), `'double'`, a duration, or `[on, off, on…]` in ms: 10 to 2550 each, 64 at most. Watch with 0.11.0 or newer; ignored by the box. |
| `stopVibration()` | Stops the motor. |

To count on the wrist, for example 7:

```js
await box.vibrate(Array.from({ length: 7 }, () => [150, 250]).flat().slice(0, -1));
```

## Sensors

| Method | Meaning |
| --- | --- |
| `battery()` | `{ percent, millivolts, present, charging, usb }`. |
| `readStatus()` | Reads `info` again. |
| `readPosition()` | Current position. |
| `motion(hz)` | Starts the `motion` events, up to 100 Hz (default 20); 0 stops them. |

## Events

`box.on(name, fn)` returns a function that unsubscribes.

| Event | Detail |
| --- | --- |
| `touchDown`, `touchUp`, `tap` | `{ x, y }` in screen pixels. |
| `swipe` | `{ direction }`: `up`, `down`, `left`, `right`. |
| `button` | `{ button, duration }`: `boot` or `power`, ms. |
| `position` | `{ position }`: `screenUp`, `screenDown`, `standing`, `upsideDown`, `leftSide`, `rightSide`. |
| `shake` | `{ strength }` in g. |
| `battery` | `{ percent, millivolts, present, charging, usb }`. |
| `motion` | `{ ax, ay, az, gx, gy, gz, position }` in g and °/s. |
| `soundEnd` | `{ ok, code, reason }`: `ok`, `cannotDecode`, `stopped`, `outOfMemory`, `notFound`. |
| `image` | `{ ok, code, reason }`: `ok`, `cannotDecode`, `notFound`. |
| `upload` | `{ ok, code, reason, received }`: `ok`, `writeError`, `sizeMismatch`, `crcError`, `badName`, `noUpload`. |
| `event` | Every event above except `motion`, with `type` and `name`. |
| `status` | `{ state }`: `permission`, `scanning`, `connecting`, `connected`, `reconnecting`, `disconnected`. |
| `connect` | `{ id, name, info }`. |
| `disconnect` | `{ manual }`. |
| `discovered` | Each device seen while connecting. |
| `error` | `{ error }`: live points that could not be sent. |

# Protocol

Service `7A1D0001-3B6E-4F2A-9C4D-2E8F1A5B0C01`. The characteristics only differ by the first group:

| UUID starts with | Name | Use |
| --- | --- | --- |
| `7A1D0002` | Command | write: opcode + parameters |
| `7A1D0003` | Event | notify: `type, x (u16), y (u16), arg` |
| `7A1D0004` | Status | read: one line of `key=value` text |
| `7A1D0005` | Transfer | write without response: file bytes |
| `7A1D0006` | IMU | notify: 13-byte motion packets; read: position |

Numbers are little-endian. Opcodes and the methods that send them:

| Opcode | Method | Opcode | Method |
| --- | --- | --- | --- |
| `01` | `text` | `12` | `pen` |
| `02` | `black` | `13` | `points`, `point` |
| `03` | `brightness` | `14` | `penUp` |
| `04` | `fill` | `15` | `clearDrawing` |
| `05` | `textSize` | `16` | `motion` |
| `06` | `textColor` | `17` | `battery` |
| `07` | `beep` | `18` | `upload` (start) |
| `08` | `morse` | `19` | `upload` (end, CRC-32) |
| `09` | `play` | `1A` | `showImage` |
| `0A` | `stopSound` | `1B` | `deleteFile` |
| `0B` | `volume` | `1C` | `hideImage` |
| `0D` | `mode` | `1D` | `preloadImage` |
| `0E` | `effect` | `1E` | `card` |
| `0F` | `rotation` | `1F` | `screenshot` |
| `10` | `vibrate`, `stopVibration` | `11` | `text` with `size` or `color` |

For a command the driver does not cover, `send([opcode, …])` goes through the same queue (`{ withoutResponse: true }` up to 180 bytes). `send('Hello')` is shown as plain text by the box.

## What the driver does for you on iPhone

- **One queue.** Aura refuses two simultaneous writes on one characteristic, and the box relies on the order.
- **Upload flow control.** iOS silently drops writes without response when its buffer is full: the driver sends 180-byte packets 10 ms apart, waits for the box after the start and every 32 packets, checks the CRC, and tries once more, at half speed, after lost packets.
- **Answers without ids.** They are matched in order, so do not send opcodes `17`, `19`, `1A` or `1D` with `send()` while the matching methods are in use.
- **Bluetooth switched off.** Aura sends no disconnection event in that case: the driver watches the Bluetooth state as well.

For tests, the pure functions are exposed: `AuraMysterBox.parseStatus`, `parseEvent`, `parseMotion`, `crc32`.
