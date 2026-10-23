// v0 round-trip harness — injected at the end of editor.html (after guard.js).
// For each fixture: SetData(F) -> G1 = GetData() -> SetData(G1) -> G2 = GetData()
// (the second pass mirrors _saveShortcutAPI's SetData(GetData()) before upload,
//  平台 web/js/shortcut.js:1133). Also checks the .htm import extractor
// getFormData() (平台 web/js/shortcut.js:2081). Results are POSTed to the local
// harness server (/__result) and shown in <pre id="v0-result">.
(function () {
  'use strict';
  var VOLATILE = { modifiedDate: 1 };            // changes on every GetData()
  var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

  function diff(a, b, path, out) {
    out = out || [];
    path = path || '$';
    if (a === b) return out;
    var ta = Object.prototype.toString.call(a), tb = Object.prototype.toString.call(b);
    if (ta !== tb) { out.push({ path: path, kind: 'type', from: a, to: b }); return out; }
    if (ta === '[object Array]') {
      var n = Math.max(a.length, b.length);
      for (var i = 0; i < n; i++) {
        if (i >= a.length) out.push({ path: path + '[' + i + ']', kind: 'added', to: b[i] });
        else if (i >= b.length) out.push({ path: path + '[' + i + ']', kind: 'removed', from: a[i] });
        else diff(a[i], b[i], path + '[' + i + ']', out);
      }
      return out;
    }
    if (ta === '[object Object]') {
      Object.keys(a).forEach(function (k) {
        if (VOLATILE[k]) return;
        if (!(k in b)) out.push({ path: path + '.' + k, kind: 'removed', from: a[k] });
        else diff(a[k], b[k], path + '.' + k, out);
      });
      Object.keys(b).forEach(function (k) {
        if (VOLATILE[k]) return;
        if (!(k in a)) out.push({ path: path + '.' + k, kind: 'added', to: b[k] });
      });
      return out;
    }
    out.push({ path: path, kind: 'changed', from: a, to: b });
    return out;
  }

  // Semantic lint: runtime calls Auth('doctor') (平台 web/js/TempHtml.js:2223,2602-2628).
  // An area without "doctor" in authread is hidden, without it in authwrite is
  // locked; gettext=false drops its text from the HIS return (TempHtml.js:5393).
  // In the editor, role "doctor" is labelled 「所有人」 (平台 web/js/scripts.js:26).
  var RUNTIME_ROLE = 'doctor';
  function lintAreas(form) {
    var out = [];
    form.forEach(function (a, i) {
      if (!a || a.itemtype === 'javascript' || a.itemtype === 'iot') return;
      var where = '$[' + i + '] ' + a.itemtype + '#' + a.itemid;
      if (!Array.isArray(a.authread) || a.authread.indexOf(RUNTIME_ROLE) < 0)
        out.push({ code: 'W_AREA_HIDDEN', where: where, message: '所有人「顯示」未勾：runtime 會隱藏此區塊' });
      if (!Array.isArray(a.authwrite) || a.authwrite.indexOf(RUNTIME_ROLE) < 0)
        out.push({ code: 'W_AREA_READONLY', where: where, message: '所有人「編輯」未勾：runtime 會鎖定此區塊' });
      if (a.gettext !== true)
        out.push({ code: 'W_AREA_NO_TEXT', where: where, message: '「回傳文字」未勾：此區塊不會帶回 HIS' });
    });
    return out;
  }

  async function roundTrip(fx) {
    // isolated editor state (values are test placeholders, not real users)
    window.userID = 'V0TEST';
    window.userName = 'v0-harness';
    window.deptNo = fx.deptNo || 'TEST0';
    window.ck_ImportDic = !!fx.importDic;       // true would call newDictionary -> blocked
    window.dicsource = fx.dicsource || [];
    window.f_dicsource = window.dicsource;
    // real editor calls SetRole("doctor,所有人") on 新增/編輯 (平台 web/js/shortcut.js:1576,1940);
    // without it, omitted authread/authwrite default to [] instead of the panel checkboxes.
    try { window.SetRole(window.authroles); } catch (e) { /* already set */ }
    // GetData() measures picture areas from the rendered <img> (平台 web/js/scripts.js:3791);
    // with the edit screen hidden, imagesize would read "0*0". Mirror the real editor state.
    var list = document.querySelector('#shortcutManagerContainer');
    var edit = document.querySelector('#addEditContainer');
    if (list) list.style.display = 'none';
    if (edit) edit.style.display = 'block';
    var before = window.__blocked.length;
    var errors = [];
    var onerr = function (e) { errors.push(String(e.message || e)); };
    window.addEventListener('error', onerr);

    var F = fx.form;
    var Fs = JSON.stringify(F);
    var htm = '<html><body><script>var tempdata =' + Fs + '<\/script></body></html>';
    var extracted = window.getFormData(htm);
    var importOk = extracted !== 'error' && JSON.stringify(JSON.parse(extracted)) === Fs;

    try { window.SetData(Fs); } catch (e) { errors.push('SetData#1: ' + e.message); }
    await sleep(fx.wait || 2500);
    var G1s = window.GetData();
    try { window.SetData(G1s); } catch (e) { errors.push('SetData#2: ' + e.message); }
    await sleep(fx.wait || 2500);
    var G2s = window.GetData();
    window.removeEventListener('error', onerr);

    var G1 = JSON.parse(G1s), G2 = JSON.parse(G2s);
    return {
      name: fx.name,
      description: fx.description,
      htmImportExtractOk: importOk,
      lintInput: lintAreas(F),
      lintAfterRoundTrip: lintAreas(G1),
      errors: errors,
      blockedRequests: window.__blocked.slice(before),
      diff_F_to_G1: diff(F, G1),
      diff_G1_to_G2: diff(G1, G2),
      G1: G1,
      G2: G2
    };
  }

  async function runAll() {
    // ?set=samples runs real exported forms (tools/v0-harness/samples, git-ignored);
    // they carry real dicids but no dicsource, so bindings are kept as-is.
    // ?set=fixtures（預設）｜samples｜out/<目錄>（例：?set=out/v1out2）
    var m = /[?&]set=([^&]+)/.exec(location.search);
    var set = m ? decodeURIComponent(m[1]) : 'fixtures';
    var base = set.indexOf('out/') === 0 ? '/__out/' + set.slice(4) : '/__' + set;
    var list = await (await fetch(base + '/index.json')).json();
    var results = [];
    for (var i = 0; i < list.length; i++) {
      var fx = await (await fetch(base + '/' + encodeURIComponent(list[i]))).json();
      if (Array.isArray(fx)) fx = { name: list[i], description: 'sample', deptNo: 'TEST0', dicsource: [], form: fx };
      results.push(await roundTrip(fx));
    }
    var report = { ranAt: new Date().toISOString(), set: set, editorver: window.editorver, results: results };
    await fetch('/__result?set=' + set, { method: 'POST', body: JSON.stringify(report, null, 2) });
    var pre = document.createElement('pre');
    pre.id = 'v0-result';
    pre.textContent = JSON.stringify(results.map(function (r) {
      return { name: r.name, importOk: r.htmImportExtractOk, lint: r.lintAfterRoundTrip.length, errors: r.errors.length,
               blocked: r.blockedRequests.length, F_G1: r.diff_F_to_G1.length, G1_G2: r.diff_G1_to_G2.length };
    }), null, 2);
    document.body.prepend(pre);
    window.__v0done = true;
  }

  window.__v0run = runAll;
  if (/[?&]autorun=1/.test(location.search)) {
    window.addEventListener('load', function () { setTimeout(runAll, 1500); });
  }
})();
