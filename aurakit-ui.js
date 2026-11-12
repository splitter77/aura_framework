/*! AuraKit UI — small helpers for pages built with AuraKit (optional; goes with aurakit-ui.css).
 *
 *   AuraUI.toast(text)            short message at the bottom
 *   AuraUI.flash(color)           flashes the whole screen
 *   AuraUI.reveal(text)           full-screen text, tap to close
 *   AuraUI.bindStatus(el, link)   connection pill (dot + label)
 *   AuraUI.bindLog(el, link)      timestamped link log
 *   AuraUI.bindRoomForm(form, link)  manual room code (same code on both iPhones)
 *
 * Automatic binding when the page has loaded (uses AuraKit.link(), created with default options if
 * the page did not create it):
 *   <span data-aura-status></span>   <pre data-aura-log></pre>   <form data-aura-room>…<input>…</form>
 *   <button data-aura-needs-peer>    disabled while the other iPhone is not connected
 *   <span data-aura-env>             "Aura Browser", "App Clip", "Simulator" or "Not in Aura"
 *   <span data-aura-role>            "Host" / "Guest"
 *   <span data-aura-peer>            name of the other iPhone
 * Labels follow AuraI18n (aurakit-i18n.js) when it is loaded: French or English. */
(function () {
  'use strict';
  var L = {
    idle: ['Inactive', 'Inactif'], starting: ['Starting…', 'Démarrage…'], waiting: ['Waiting for the other iPhone', 'En attente de l\'autre iPhone'],
    searching: ['Looking for the other iPhone', 'Recherche de l\'autre iPhone'], connected: ['Connected', 'Connecté'], error: ['Error', 'Erreur'],
    stopped: ['Link off', 'Liaison coupée'], unavailable: ['Not in Aura', 'Hors d\'Aura'],
    host: ['Host', 'Hôte'], guest: ['Guest', 'Invité'], browser: ['Aura Browser', 'Aura Browser'], clip: ['App Clip', 'App Clip'],
    mock: ['Simulator', 'Simulateur'], none: ['Not in Aura', 'Hors d\'Aura'], nobody: ['Nobody yet', 'Personne pour l\'instant'],
  };
  var fr = function () { return window.AuraI18n ? window.AuraI18n.lang === 'fr' : /^fr/i.test(document.documentElement.lang || ''); };
  var label = function (k) { var v = L[k]; return v ? v[fr() ? 1 : 0] : k; };
  var pad = function (n) { return String(n).padStart(2, '0'); };

  function layer(cls) {
    var el = document.querySelector('.' + cls);
    if (!el) { el = document.createElement('div'); el.className = cls; document.body.appendChild(el); }
    return el;
  }

  var toastTimer;
  function toast(text, ms) {
    var el = layer('ak-toast');
    el.textContent = text;
    el.classList.add('on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove('on'); }, ms || 2200);
  }

  function flash(color) {
    var el = layer('ak-flash');
    el.style.background = color || '#fff';
    el.classList.add('on');
    requestAnimationFrame(function () { requestAnimationFrame(function () { el.classList.remove('on'); }); });
  }

  function reveal(text, options) {
    var o = options || {};
    var el = layer('ak-reveal');
    el.innerHTML = '';
    var span = document.createElement('div');
    span.className = 'ak-reveal-text';
    if (o.html) span.innerHTML = text; else span.textContent = text;
    el.appendChild(span);
    el.hidden = false;
    el.onclick = function () { el.hidden = true; if (o.onClose) o.onClose(); };
    return function close() { el.hidden = true; };
  }

  function bindStatus(el, link) {
    el.classList.add('ak-pill');
    var render = function () {
      var s = link.status;
      var names = Array.from(link.peers.values()).map(function (n) { return n || '?'; }).join(', ');
      el.dataset.state = s === 'connected' ? 'ok' : s === 'error' || s === 'unavailable' || s === 'stopped' ? 'err' : 'wait';
      el.innerHTML = '<i class="ak-dot"></i><span></span>';
      el.lastChild.textContent = s === 'connected' && names ? label('connected') + ' · ' + names : label(s);
      el.title = link.error || '';
    };
    render();
    link.on('status', render); link.on('connect', render); link.on('disconnect', render);
  }

  function bindLog(el, link) {
    var render = function () {
      el.textContent = link.logs.map(function (l) {
        var d = l.time;
        return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()) + '  ' + l.text;
      }).join('\n');
    };
    render();
    link.on('log', render);
  }

  function bindRoomForm(form, link) {
    var input = form.querySelector('input');
    if (input) input.value = link.room || '';
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var code = input ? input.value.trim() : '';
      link.setRoom(code);
      toast(code ? (fr() ? 'Salon « ' + code + ' »' : 'Room “' + code + '”') : (fr() ? 'Appairage automatique' : 'Automatic pairing'));
    });
  }

  function autoBind() {
    if (!window.AuraKit) return;
    var needs = document.querySelector('[data-aura-status],[data-aura-log],[data-aura-room],[data-aura-needs-peer],[data-aura-role],[data-aura-peer]');
    AuraKit.ready().then(function (env) {
      document.querySelectorAll('[data-aura-env]').forEach(function (el) {
        el.textContent = !env.available ? label('none') : env.mock ? label('mock') + ' · ' + label(env.appClip ? 'clip' : 'browser') : label(env.appClip ? 'clip' : 'browser');
      });
      document.documentElement.classList.toggle('ak-in-aura', env.available);
      document.documentElement.classList.toggle('ak-app-clip', env.appClip);
    });
    if (!needs) return;
    var link = AuraKit.link();
    document.querySelectorAll('[data-aura-status]').forEach(function (el) { bindStatus(el, link); });
    document.querySelectorAll('[data-aura-log]').forEach(function (el) { bindLog(el, link); });
    document.querySelectorAll('form[data-aura-room]').forEach(function (el) { bindRoomForm(el, link); });
    var refresh = function () {
      document.querySelectorAll('[data-aura-needs-peer]').forEach(function (el) { el.disabled = !link.connected; });
      document.querySelectorAll('[data-aura-role]').forEach(function (el) { el.textContent = link.role ? label(link.role) : '—'; });
      document.querySelectorAll('[data-aura-peer]').forEach(function (el) {
        el.textContent = link.connected ? Array.from(link.peers.values()).map(function (n) { return n || '?'; }).join(', ') : label('nobody');
      });
      document.documentElement.classList.toggle('ak-connected', link.connected);
    };
    refresh();
    link.on('status', refresh); link.on('connect', refresh); link.on('disconnect', refresh);
  }

  window.AuraUI = { toast: toast, flash: flash, reveal: reveal, bindStatus: bindStatus, bindLog: bindLog, bindRoomForm: bindRoomForm, label: label };
  // After the page's own scripts, so that AuraKit.link(options) from the page is used.
  var later = function () { setTimeout(autoBind, 0); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', later); else later();
})();
