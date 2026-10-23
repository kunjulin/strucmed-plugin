// v0.2 HTML 預覽的模擬層：載入在 TempHtml.js（HIS 端 runtime）之後、表單資料之後。
// - 網路：guard.js（JS 層）＋伺服器送出的 CSP（瀏覽器層）雙重封鎖，任何對外請求都送不出去。
// - LLM／影像 LLM／語音／HIS 查詢改成「在目標欄位顯示將送出的內容」，不實際呼叫，方便檢查 prompt 與寫入位置。
// - 頁面頂端顯示離線預覽橫幅與被封鎖、被模擬的請求。
(function () {
  'use strict';
  var simulated = (window.__simulated = []);
  function note(kind, detail) {
    simulated.push({ kind: kind, detail: String(detail).slice(0, 300) });
    render();
  }
  function write(id, text) {
    try { SetValueByID(id, text); } catch (e) { console.warn('[preview] SetValueByID 失敗', id, e); }
  }

  // ── LLMQUERY 與 LLM 按鈕（TempHtml.js LLMquery）──
  window.LLMquery = function (id, prompt, model) {
    var m = model ? String(model) : '（預設）';
    var p = prompt === undefined || prompt === null ? '' : String(prompt);
    var text = '〔離線預覽：未呼叫 LLM｜模型 ' + m + '｜將送出 ' + p.length + ' 字〕\n' + p;
    note('LLM', '#' + id + ' ← 模型 ' + m + '，' + p.length + ' 字');
    write(id, text);
    return Promise.resolve(text);
  };
  // ── LLMvision（影像 LLM）──
  window.LLMvision = function (id, prompt, model) {
    var p = prompt === undefined || prompt === null ? '' : String(prompt);
    var text = '〔離線預覽：未呼叫影像 LLM｜模型 ' + (model || '（預設）') + '｜未選取影像〕\n' + p;
    note('LLMvision', '#' + id + ' ← ' + (model || '（預設）'));
    write(id, text);
    return Promise.resolve(text);
  };
  // ── VOICETOTEXT（語音轉文字）：calcSetval 會把回傳值寫入目標 ──
  window.voiceToText = function (id, provider) {
    note('語音', '#' + id + ' ← ' + (provider || 'ASUS'));
    return Promise.resolve('〔離線預覽：未錄音、未呼叫語音服務 ' + (provider || 'ASUS') + '〕');
  };
  // ── HIS 查詢（label format=hisquery 與 HISQUERY 巨集）──
  window.HISquery = function (queryString) {
    var pairs = [];
    if (queryString) {
      var q = String(queryString).replace(/[\r\n]+/g, '').trim();
      if (/^[A-Z]+\(/.test(q)) { try { q = $(targetid).calx('evaluate', q); } catch (e) { /* 與 runtime 相同：失敗就用原字串 */ } }
      String(q).split(';').forEach(function (pair) {
        var parts = pair.split(',');
        if (parts.length === 2) pairs.push({ key: parts[0].trim(), value: parts[1].trim() });
      });
    } else {
      (function walk(items) {
        (items || []).forEach(function (it) {
          if (!it || typeof it !== 'object') return;
          if (it.itemid && it.format === 'hisquery') pairs.push({ key: String(it.itemid), value: it.hisquery });
          if (Array.isArray(it.datavalue)) walk(it.datavalue);
          if (Array.isArray(it.item)) walk(it.item);
        });
      })(tempdata);
    }
    pairs.forEach(function (x) {
      note('HIS 查詢', (x.key === '0' ? '（回傳值）' : '#' + x.key) + ' ← ' + x.value);
      if (x.key !== '0') write(x.key, '〔HIS 參照：' + x.value + '〕');
    });
    return queryString ? '' : undefined;
  };

  // ── 橫幅 ──
  var bar;
  function render() {
    if (!document.body) return;
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'strucmed-preview-bar';
      bar.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:99999;background:#fff8e1;border-top:2px solid #f9a825;' +
        'font:13px/1.5 sans-serif;color:#333;padding:6px 12px;max-height:40vh;overflow:auto';
      document.body.appendChild(bar);
    }
    var blocked = window.__blocked || [];
    var kinds = {};
    blocked.forEach(function (b) {
      var k = /Struct_/i.test(b.url) ? '倉儲' : /:45678/.test(b.url) ? 'HIS API' : /generate|chat\/completions|llm/i.test(b.url) ? 'LLM'
        : /asr/i.test(b.url) ? '語音' : '其他';
      kinds[k] = (kinds[k] || 0) + 1;
    });
    var summary = Object.keys(kinds).map(function (k) { return k + ' ×' + kinds[k]; }).join('、') || '無';
    var esc = function (s) { return String(s).replace(/[&<>]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]; }); };
    bar.innerHTML = '<b>離線預覽（不連線、不存檔）</b>｜以 HIS 端 runtime（TempHtml）呈現；網路由 CSP 與 guard 封鎖。' +
      '<br>已封鎖的請求：' + esc(summary) +
      (simulated.length ? '<br>已模擬（未實際呼叫）：<ul style="margin:2px 0 0 18px;padding:0">' +
        simulated.map(function (s) { return '<li>' + esc(s.kind) + '：' + esc(s.detail) + '</li>'; }).join('') + '</ul>' : '');
    // 留白加在 HIS 畫面自己的捲動區（.body-content）底部，不加在 body，避免整頁多出第二條捲軸
    var sc = document.querySelector('.body-content');
    if (sc) sc.style.paddingBottom = (bar.offsetHeight + 12) + 'px';
    liftBottomFixed(bar.offsetHeight);
  }
  // HIS 畫面固定在底部的元件（預覽／編輯切換鈕、字數統計、語音小助手）往上移一個橫幅高度，避免被橫幅蓋住。
  // 第一次記下原本的 bottom，之後都以原值＋橫幅高度重算（橫幅會因模擬紀錄變高）。
  function liftBottomFixed(h) {
    document.querySelectorAll('body *').forEach(function (e) {
      if (e === bar || bar.contains(e)) return;
      if (e.dataset.previewOrigBottom === undefined) {
        var cs = getComputedStyle(e);
        if (cs.position !== 'fixed' || !/px$/.test(cs.bottom)) return;
        var b = parseFloat(cs.bottom);
        if (!(b >= 0 && b < window.innerHeight / 2)) return;
        e.dataset.previewOrigBottom = String(b);
      }
      e.style.bottom = (parseFloat(e.dataset.previewOrigBottom) + h) + 'px';
      e.style.top = 'auto';   // 樣式表若同時指定 top，bottom 會被忽略
    });
  }
  window.__previewRender = render;

  // 截圖存檔給使用者（瀏覽器工具的截圖只有 Claude 看得到）：用 TempHtml 已載入的 html2canvas，
  // 以同源 POST 存到 tools/v0-harness/out/snapshots/<name>.png。selector 省略時截整張表單（#rowArea）。
  window.__snapshot = function (name, selector) {
    var el = selector ? document.querySelector(selector) : (document.querySelector(targetid) || document.body);
    if (!el) return Promise.reject(new Error('找不到要截圖的元素：' + selector));
    // TempHtml 載入的是舊版 html2canvas（0.4：onrendered 回呼）；新版回傳 Promise，兩種都支援
    return new Promise(function (resolve, reject) {
      var opts = { background: '#ffffff', backgroundColor: '#ffffff', scale: 1.5, logging: false, onrendered: resolve };
      try {
        var r = html2canvas(el, opts);
        if (r && typeof r.then === 'function') r.then(resolve, reject);
      } catch (e) { reject(e); }
    }).then(function (canvas) {
      return new Promise(function (resolve) { canvas.toBlob(resolve, 'image/png'); });
    }).then(function (blob) {
      return fetch('/__snapshot?name=' + encodeURIComponent(name || 'preview'), { method: 'POST', body: blob });
    }).then(function (r) { return r.text(); });
  };
  setInterval(render, 1500);

  // 與編輯器「預覽」相同：頁面載入後呼叫 getheader()，一般瀏覽器會走 initData(tempdata)（TempHtml.js:7557-7564）
  window.addEventListener('load', function () {
    if (window.__previewData) tempdata = window.__previewData;   // 蓋過 TempHtml.html 結尾的預設假資料
    try { getheader(); } catch (e) { console.error('[preview] getheader 失敗', e); }
    render();
  });
})();
