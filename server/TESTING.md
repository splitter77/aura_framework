# Testing App Clip phone registration, step by step

This guide tests the whole flow on a real server. A phone opens the page with the AuraClip App Clip. It is recorded, then you turn it off from the admin page, and it is sent to the "Access disabled" page.

You need:

- a PHP host (Hostinger shared hosting works) with HTTPS;
- an iPhone with your Aura tag or Aura link, to open the page in the AuraClip App Clip;
- a computer with a browser, for the admin page.

## 1. Upload the files

Create a folder on your server, for example `demo/`, and upload these five files into it, side by side:

| File | Where it comes from |
| --- | --- |
| `index.html` | `server/index.html` |
| `blocked.html` | `server/blocked.html` |
| `aurakit-devices.php` | `server/aurakit-devices.php` |
| `aurakit-admin.php` | `server/aurakit-admin.php` |
| `aurakit.js` | `aurakit.js`, at the **root** of the repository (not in `server/`) |

Do not create `devices_appcliped/`: the server creates it on the first launch.

## 2. Set the admin password

On the server, open `aurakit-admin.php` in the file manager and change this line:

```php
const ADMIN_PASSWORD = '';
```

Put a long password between the quotes and save. While the password is empty, the admin page shows "Page not set up".

## 3. Point your Aura tag or link to the page

The App Clip must open `https://your-site/demo/index.html` (or `https://your-site/demo/`). The page's domain must be the one the App Clip opens.

## 4. First launch on the iPhone

1. Scan your Aura tag (or open your Aura link) with the iPhone. The App Clip opens the demo page.
2. In **This phone**, check that you see:
   - **Check**: `new` first launch
   - **Registration**: `new` devices_appcliped/xxxxxxxx….json
   - **Id**: a long identifier, such as `8b551bcf-989a-4057-a097-1b68b9d98c7f`
   - **Launches**: `1`
3. Write down the first 8 characters of the id. You will look for them on the admin page.

If you see `error` instead, go to [Troubleshooting](#troubleshooting).

## 5. Second launch

1. Close the App Clip (swipe it away), then scan the tag again.
2. Check that you now see:
   - **Check**: `on` allowed
   - **Registration**: `updated`
   - **Id**: the same as before
   - **Launches**: `2`

The id is the same, so the phone is recognized.

## 6. Open the admin page

1. On the computer, open `https://your-site/demo/aurakit-admin.php`.
2. Enter the password from step 2 and click **Sign in**.
3. The list shows your iPhone: status `on`, the model, the iOS version, the id, and 2 launches.

## 7. Turn the phone off

1. On the iPhone's row, click **Set off**. The status becomes `off`.
2. On the iPhone, close the App Clip and scan the tag again.
3. The phone lands on **Access disabled**: "This phone no longer has access to this experience." The demo page never shows.

## 8. Turn it back on

1. On the admin page, click **Set on** on the iPhone's row.
2. Launch the App Clip again: the demo page shows, with **Check**: `on` allowed and one more launch.

## 9. Several phones at once (optional)

Repeat step 4 with a second iPhone, then on the admin page:

- check both boxes and click **Selection off**: both phones are sent to **Access disabled** at their next launch;
- click **All on** (and confirm): every phone gets access again.

## 10. Check that the folder is private

In a browser, open `https://your-site/demo/devices_appcliped/`. You should get an error (403 Forbidden), not the list of files. The phones' details are only visible on the admin page.

## Troubleshooting

| What you see | Cause and fix |
| --- | --- |
| Everything stays on `…` | The page is an old copy. Upload `index.html` again and clear the cache (Hostinger hPanel, or reload in the App Clip). |
| `aurakit.js not found` | `aurakit.js` is not next to `index.html`. Upload it from the root of the repository. |
| `aurakit.js is an old version` | Replace `aurakit.js` with the one from the repository, then clear the cache. |
| **Check**: `skipped`, not in the App Clip | The page was opened in Safari or Aura Browser. Open it with the App Clip (tag or link). |
| **Registration**: `error` … `answered 404` | `aurakit-devices.php` is missing or not in the same folder as `index.html`. |
| **Registration**: `error` … `cannot create devices_appcliped/` | PHP cannot write in the folder. In the file manager, give the `demo/` folder permission 755. |
| The phone is `off` but still sees the page | The page was not reloaded. Close the App Clip completely and scan the tag again. |
| The admin page says "Page not set up" | `ADMIN_PASSWORD` is still empty (step 2). |
| The admin page is in French | The server still has an old `aurakit-admin.php`. Upload the new one (keep your password in it) and clear the cache. |
| The id changes on every launch | iOS deleted the App Clip's data, or the page is opened from different domains (the id is kept per domain). |

## Good to know

- A phone's status takes effect at its **next launch**, not while the page is open.
- A phone that iOS has cleaned (App Clip data deleted after a long time without use) gets a new id and shows up as a new phone, `on`.
- The check runs in the phone: it stops ordinary users, not someone who reads the page's source.
