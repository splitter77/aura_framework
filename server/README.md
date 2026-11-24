# server/: recording and blocking App Clip phones

A demo you can upload as it is, plus the two PHP scripts behind `AuraKit.registerDevice()` and `AuraKit.checkDevice()`. Reference: [docs/API.md, section 13](../docs/API.md#13-device-info-aurakitdevice).

## Files to upload

Put these files in one folder of your PHP host (Hostinger shared hosting works), next to each other:

```
your-site/demo/
├── index.html            demo page: checkDevice(), then registerDevice()
├── blocked.html          page shown to phones set to "off"
├── aurakit.js            copied from the root of AuraKit
├── aurakit-devices.php   records the phones, answers their status
├── aurakit-admin.php     on/off list (set ADMIN_PASSWORD first)
└── devices_appcliped/    created by itself on the first launch
    ├── .htaccess         keeps the folder private
    ├── index.html
    └── <id>.json         one file per phone, "status": "on" | "off"
```

`aurakit.js` is the only file to copy from elsewhere. In this repository, `index.html` falls back to `../aurakit.js`.

## Trying it

1. Open `aurakit-admin.php` on the server and set `ADMIN_PASSWORD`.
2. Open `index.html` with the App Clip (your Aura tag or link): the page shows the phone's id and number of launches, and the phone appears in `devices_appcliped/`.
3. On a computer, open `aurakit-admin.php`, sign in and set the phone to **off**.
4. Launch the App Clip again: the phone lands on `blocked.html`. Set it back to **on** and it sees the demo again.

## In your own page

```html
<script src="aurakit.js"></script>
<script>
  AuraKit.checkDevice({ redirect: 'blocked.html' })
    .then((r) => { if (!r.redirected) AuraKit.registerDevice(); });
</script>
```

Put it in the `<head>`: the page stays hidden until the server answers.

## On a computer

`python3 -m http.server` does not run PHP. With PHP installed, from the repository root:

```bash
php -S localhost:8770
```

Then open `http://localhost:8770/server/?mock=join` (the simulator acts as the App Clip) and `http://localhost:8770/server/aurakit-admin.php`.
