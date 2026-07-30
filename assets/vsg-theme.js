/* ═══════════════════════════════════════════════════════════════════════════════
   VSG SHARED THEME LOADER                                     /assets/vsg-theme.js
   ─────────────────────────────────────────────────────────────────────────────
   Applies the site theme by setting data-theme on <body>. Pairs with
   /assets/vsg-theme.css, which holds every body[data-theme="…"] rule.

   SOURCE OF TRUTH
   Drive (vsg-site-config.json → siteTheme) is authoritative. This file does NOT
   fetch it — each page already loads that config for its own content and calls
   VSGTheme.set(theme) with the value it read. localStorage is only a paint-time
   CACHE so a returning visitor doesn't see the default theme flash before the
   Drive round-trip lands. If the two disagree, the Drive value wins the moment
   it arrives, and set() rewrites the cache.

   FIRST PAINT
   Every page also carries a one-line inline snippet as the first child of
   <body> that reads the cache and sets the attribute before anything renders:

     <script>try{document.body.setAttribute('data-theme',
       localStorage.getItem('vsg-site-theme')||'dark')}catch(e){}</script>

   That snippet is deliberately inline and duplicated rather than living here —
   loading this file early enough to beat first paint would require a blocking
   network request, which costs more than the three lines it saves. A first-ever
   visitor briefly sees the default; everyone else sees the right theme
   immediately.
   ═══════════════════════════════════════════════════════════════════════════ */
window.VSGTheme = {
  KEY: 'vsg-site-theme',
  DEFAULT: 'dark',

  /* Cached theme, or null if never cached / storage unavailable (Safari private
     mode throws on localStorage access rather than returning null). */
  read: function () {
    try { return localStorage.getItem(this.KEY) || null; } catch (e) { return null; }
  },

  /* Paint the theme without touching the cache. */
  apply: function (t) {
    var v = t || this.DEFAULT;
    if (document.body) document.body.setAttribute('data-theme', v);
    return v;
  },

  /* Paint the theme AND cache it. Call this with the value from Drive. */
  set: function (t) {
    var v = this.apply(t);
    try { localStorage.setItem(this.KEY, v); } catch (e) {}
    return v;
  },

  /* Call this with cms.siteTheme straight off the Drive config.
     A missing value means the fetch failed or the key isn't set — NOT that the
     theme is 'dark'. In that case keep whatever the boot snippet already painted
     from cache, because resetting to the default would make a transient Drive
     error look like the theme had been changed. Only a value that actually came
     back from Drive is allowed to overwrite the cache. */
  setFromConfig: function (t) {
    if (t === undefined || t === null || t === '') return this.read() || this.DEFAULT;
    return this.set(t);
  }
};
