// v0 harness network guard — injected as the FIRST script of editor.html.
// Blocks every request that is not same-origin static content, so the real
// editor code can run offline without touching the hospital warehouse / LLM /
// HIS APIs. Blocked calls are recorded in window.__blocked for the report.
(function () {
  'use strict';
  var blocked = (window.__blocked = []);
  var origin = location.origin;

  function allowed(url) {
    try {
      var u = new URL(url, location.href);
      if (u.origin !== origin) return false;
      // same-origin API endpoints are blocked too; only static files pass
      return !/^\/(api|struc)\//i.test(u.pathname);
    } catch (e) {
      return false;
    }
  }
  function record(kind, url, body) {
    blocked.push({ kind: kind, url: String(url), bytes: body ? String(body).length : 0 });
  }

  var realFetch = window.fetch;
  window.fetch = function (input, init) {
    var url = typeof input === 'string' ? input : input && input.url;
    if (allowed(url)) return realFetch.apply(this, arguments);
    record('fetch', url, init && init.body);
    return Promise.reject(new TypeError('[v0-guard] blocked: ' + url));
  };

  var XO = XMLHttpRequest.prototype.open;
  var XS = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__v0url = url;
    this.__v0ok = allowed(url);
    return XO.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function (body) {
    if (this.__v0ok) return XS.apply(this, arguments);
    record('xhr', this.__v0url, body);
    throw new Error('[v0-guard] blocked: ' + this.__v0url);
  };

  if (navigator.sendBeacon) {
    navigator.sendBeacon = function (url, data) {
      record('beacon', url, data);
      return false;
    };
  }
  window.WebSocket = function (url) {
    record('websocket', url);
    throw new Error('[v0-guard] blocked websocket');
  };
  // window.open / external navigation are not needed by the harness
  window.open = function (url) {
    record('window.open', url || 'about:blank');
    return null;
  };
})();
