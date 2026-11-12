/*! AuraKit i18n — translate a page with HTML attributes, no build step.
 *
 *   <script src="aurakit-i18n.js" data-default="fr" data-languages="fr,en"></script>
 *
 * The markup is written in the default language. Other languages go in attributes:
 *   data-en="…"               replaces the text
 *   data-en-html="…"          replaces the HTML (text with links or <b>)
 *   data-en-placeholder="…"   data-en-aria="…" (aria-label)   data-en-title="…"
 *   <title data-en="…">       the page title
 * In JavaScript:  t({ fr: 'Bonjour', en: 'Hello' })  or, with two languages,  t('Bonjour', 'Hello')
 *   (arguments in the order of data-languages).
 * Language: ?lang=xx in the URL, else the last choice, else the phone language, else the default.
 * Switch:   <button data-set-lang="en">English</button>  (the current one gets aria-current="true"),
 *           or AuraI18n.set('en'). The page reloads; an AuraKit link reconnects by itself. */
(function () {
  'use strict';
  var script = document.currentScript;
  var cfg = function (name, fallback) { return (script && script.getAttribute('data-' + name)) || fallback; };
  var languages = cfg('languages', 'fr,en').split(',').map(function (s) { return s.trim().toLowerCase(); }).filter(Boolean);
  var base = cfg('default', languages[0]);
  var KEY = cfg('key', 'aurakit.lang');
  var known = function (v) { return languages.indexOf(v) >= 0; };

  var query = new URLSearchParams(location.search).get('lang');
  var saved = null;
  try { saved = localStorage.getItem(KEY); } catch (e) { /* storage blocked */ }
  if (known(query)) { try { localStorage.setItem(KEY, query); } catch (e) { /* ignore */ } }
  var phone = ((navigator.languages || [navigator.language || '']).map(function (l) { return String(l).slice(0, 2).toLowerCase(); }).filter(known))[0];
  var lang = known(query) ? query : known(saved) ? saved : phone || base;

  document.documentElement.lang = lang;

  function t(first) {
    if (first && typeof first === 'object') return first[lang] != null ? first[lang] : first[base];
    var i = languages.indexOf(lang);
    var v = arguments[i];
    return v != null ? v : first;
  }

  function apply(root) {
    root = root || document;
    if (lang !== base) {
      var p = 'data-' + lang;
      var each = function (attr, fn) { root.querySelectorAll('[' + attr + ']').forEach(function (el) { fn(el, el.getAttribute(attr)); }); };
      each(p, function (el, v) { if (el.tagName === 'TITLE') document.title = v; else el.textContent = v; });
      each(p + '-html', function (el, v) { el.innerHTML = v; });
      each(p + '-placeholder', function (el, v) { el.placeholder = v; });
      each(p + '-aria', function (el, v) { el.setAttribute('aria-label', v); });
      each(p + '-title', function (el, v) { el.title = v; });
    }
    root.querySelectorAll('[data-set-lang]').forEach(function (el) {
      var target = el.getAttribute('data-set-lang');
      el.setAttribute('aria-current', String(target === lang));
      if (!el.__akLang) { el.__akLang = true; el.addEventListener('click', function (e) { e.preventDefault(); set(target); }); }
    });
  }

  // Saves the choice (or puts it in the URL when storage is blocked) and reloads.
  function set(value) {
    if (!known(value) || value === lang) return;
    var stored = false;
    try { localStorage.setItem(KEY, value); stored = localStorage.getItem(KEY) === value; } catch (e) { /* ignore */ }
    var q = new URLSearchParams(location.search);
    if (stored) q.delete('lang'); else q.set('lang', value);
    var search = q.toString();
    // replaceState + reload: assigning a URL that only differs by its #hash would not reload the page.
    try { history.replaceState(history.state, '', location.pathname + (search ? '?' + search : '') + location.hash); } catch (e) { /* ignore */ }
    location.reload();
  }

  window.AuraI18n = { lang: lang, languages: languages, base: base, t: t, apply: apply, set: set };
  if (!window.t) window.t = t;
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { apply(document); });
  else apply(document);
})();
