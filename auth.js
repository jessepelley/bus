/**
 * auth.js — Client-side auth module for bus.jjjp.ca (GitHub Pages)
 *
 * Adapted from the music.jjjp.ca integration. Loaded as a classic script;
 * exposes `window.auth`.
 *
 * The bus app does NOT require login — transit data is public and the NAS
 * proxy (jjjp.ca/bus/api.php) serves the realtime feeds without a token.
 * This module is here so login can be switched on later: flip REQUIRE_AUTH
 * in api.php, add 'bus' to $allowedApps and 'bus.jjjp.ca' to $allowedHosts
 * in jjjp.ca/auth/app_token.php, and the flow below already works.
 *
 *   auth.handleCallback();                 // call once on page load
 *   if (auth.isAuthenticated()) { ... }
 *   auth.login();                          // redirect to jjjp.ca/auth
 *   auth.getToken();                       // token for X-API-Key header
 *   await auth.whoami();                   // { given_name, picture, ... }
 *   auth.logout();
 */
(function () {
  'use strict';

  const AUTH_CONFIG = {
    authUrl:    'https://jjjp.ca/auth/app_token.php',
    apiUrl:     'https://jjjp.ca/bus/api.php',
    app:        'bus',
    storageKey: 'jjjp_bus_token',
    userKey:    'jjjp_bus_user',
  };

  const auth = {

    /** Capture ?token= after redirect from jjjp.ca/auth, then clean the URL. */
    handleCallback() {
      const params = new URLSearchParams(window.location.search);
      const token = params.get('token');
      if (!token) return false;
      localStorage.setItem(AUTH_CONFIG.storageKey, token);
      params.delete('token');
      const clean = params.toString();
      const newUrl = window.location.pathname +
        (clean ? '?' + clean : '') + window.location.hash;
      window.history.replaceState({}, '', newUrl);
      return true;
    },

    /** Redirect to jjjp.ca/auth; user returns here with ?token=. */
    login() {
      const redirectUrl = window.location.origin + window.location.pathname;
      const authUrl = AUTH_CONFIG.authUrl +
        '?app=' + encodeURIComponent(AUTH_CONFIG.app) +
        '&redirect=' + encodeURIComponent(redirectUrl);
      const isStandalone = window.matchMedia('(display-mode: standalone)').matches
        || window.navigator.standalone === true;
      if (isStandalone) {
        // PWA: open in the real browser so WebAuthn passkeys work.
        window.open(authUrl, '_blank');
      } else {
        window.location.href = authUrl;
      }
    },

    isAuthenticated() {
      return !!localStorage.getItem(AUTH_CONFIG.storageKey);
    },

    getToken() {
      return localStorage.getItem(AUTH_CONFIG.storageKey) || '';
    },

    async whoami() {
      const token = this.getToken();
      if (!token) return null;
      const cached = localStorage.getItem(AUTH_CONFIG.userKey);
      if (cached) {
        try {
          const parsed = JSON.parse(cached);
          if (parsed._ts && Date.now() - parsed._ts < 3600000) return parsed;
        } catch (e) { /* ignore bad cache */ }
      }
      try {
        const res = await fetch(AUTH_CONFIG.apiUrl + '?action=whoami', {
          headers: { 'X-API-Key': token },
        });
        if (!res.ok) {
          if (res.status === 401) this.logout();
          return null;
        }
        const data = await res.json();
        data._ts = Date.now();
        localStorage.setItem(AUTH_CONFIG.userKey, JSON.stringify(data));
        return data;
      } catch (e) {
        console.error('whoami failed:', e);
        return null;
      }
    },

    logout() {
      localStorage.removeItem(AUTH_CONFIG.storageKey);
      localStorage.removeItem(AUTH_CONFIG.userKey);
    },
  };

  window.auth = auth;
})();
