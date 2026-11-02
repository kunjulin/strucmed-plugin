// 預覽審閱模式（docs/15 §2）：接在 preview-shim.js 之後載入，資料來自 serve.mjs 注入的 window.__reviewMeta。
// - 標記與卡片都畫在 body 底下的獨立圖層，不放進表單 DOM：GetText2 走訪 .area 的子節點產生 HIS 文字，塞東西進去會污染輸出。
// - 圖層用 position:absolute 掛在一個高度 0 的 fixed 容器內：preview-shim.js 的 liftBottomFixed 會改寫其他貼底的 fixed 元件。
// - 所有內容以 textContent 寫入：說明文字、字典補述都可能是別人寫的。
// - 只呼叫同源 /__review；修改與填值都留在頁面記憶體，按「送出意見」才寫檔。
(function () {
  'use strict';
  var meta = window.__reviewMeta;
  var draftId = (location.pathname.match(/\/__preview\/(d-[0-9a-f]{12})/) || [])[1];
  // runtime 會改寫 tempdata，卡片的原值以載入前的快照為準
  var source = window.__previewData ? JSON.parse(JSON.stringify(window.__previewData)) : [];
  var MEMO_KEYS = ['meaning', 'type', 'unit', 'range', 'func', 'usecase', 'interop', 'asr', 'calx', 'llm', 'scope'];
  var MEMO_LABEL = { meaning: '語意', type: '控制項', unit: '單位', range: '範圍', func: '表單功能', usecase: '使用情境', interop: '交換引用',
    asr: '語音別名（以／分隔）', calx: '計算式說明', llm: 'LLM 提示', scope: '適用範圍' };
  var LEVEL_LABEL = { sys: '體系', own: '本科', sub: '次專', dpt: '科部', system: '全院', other: '其他' };
  var TYPE_LABEL = { textbox: '文字', numberbox: '數字', textarea: '段落', calendar: '日期時間', selection: '下拉', combobox: '組合框', radiobutton: '單選', checkbox: '核取',
    submenu: '階層選單', label: '計算式／顯示', imgbox: '圖片', form: '彈出片語', subgroup: '群組', action: '巨集按鈕', action2: 'LLM 按鈕' };

  var fields = {}, areas = {}, nodes = {}, base = {};
  var edits = {}, areaComments = {};        // 尚未送出的修改
  var reviewOn = true, panelMode = '', panelId = '', textOpened = false;
  var layer, panel, statusLine, formComment, badges = {};

  function el(tag, props, kids) {
    var e = document.createElement(tag);
    Object.keys(props || {}).forEach(function (k) {
      if (k === 'style') e.style.cssText = props[k];
      else if (k === 'on') Object.keys(props.on).forEach(function (t) { e.addEventListener(t, props.on[t]); });
      else e[k] = props[k];
    });
    (kids || []).forEach(function (c) { if (c !== null && c !== undefined) e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return e;
  }
  var same = function (a, b) { return JSON.stringify(a) === JSON.stringify(b); };
  var row = function (label, control) { return el('label', { className: 'rv-row' }, [el('span', { className: 'rv-key', textContent: label }), control]); };
  var section = function (title) { return el('div', { className: 'rv-sec', textContent: title }); };
  var line = function (text) { return el('div', { className: 'rv-text', textContent: text }); };

  // ── 資料整理 ──
  function indexNodes(list) {
    (Array.isArray(list) ? list : []).forEach(function (n, i) {
      if (!n || typeof n !== 'object') return;
      if (n.datatype && n.datatype !== 'text' && n.datatype !== 'newline' && n.itemid !== undefined) {
        // 說明文字是控制項緊鄰的前一個文字節點：form_update_control 的 label_text 改的就是它（fieldMap 的 caption 是去掉冒號的欄位名稱）
        var prev = list[i - 1];
        nodes[String(n.itemid)] = { node: n, label: prev && prev.datatype === 'text' ? String(prev.datavalue || '') : '' };
      }
      indexNodes(n.item); indexNodes(n.itemtemp); indexNodes(n.datavalue);
    });
  }
  function memoInputs(memo) {
    var out = {};
    MEMO_KEYS.forEach(function (k) {
      var v = memo ? memo[k] : '';
      out[k] = Array.isArray(v) ? v.join('／') : String(v === undefined || v === null ? '' : v);
    });
    return out;
  }
  function memoValue(k, text) {
    if (k !== 'asr') return text;
    var list = text.split('／').map(function (s) { return s.trim(); }).filter(Boolean);
    return list.length ? list : '';
  }
  function prepare() {
    indexNodes(source);
    (meta.areas || []).forEach(function (a) { areas[String(a.itemid)] = a; });
    (meta.fields || []).forEach(function (f) {
      var id = String(f.itemid), n = (nodes[id] || {}).node || {}, d = f.dictionary;
      fields[id] = f;
      base[id] = {
        caption: (nodes[id] || {}).label || '', options: f.options ? f.options.slice() : null,
        'default': typeof n.datavalue === 'string' ? n.datavalue : '', required: !!f.required,
        memo: d ? memoInputs(d.memo) : null, fhir: d ? (d.fhir || []) : null
      };
    });
  }
  function editableDefault(f) {
    var n = (nodes[String(f.itemid)] || {}).node || {};
    if (typeof n.datavalue !== 'string' || ['action', 'action2', 'imgbox'].indexOf(f.datatype) >= 0) return false;
    return f.datatype !== 'label' || !n.format || n.format === 'defaultValue';
  }
  var memoEditable = function (f) { return !!f.dictionary && !f.dictionary.unknown; };
  var hasEdits = function (id) { return !!edits[id] && Object.keys(edits[id]).length > 0; };

  function setEdit(id, key, value, baseValue) {
    var e = edits[id] || (edits[id] = {});
    if (same(value, baseValue)) delete e[key]; else e[key] = value;
    refreshMarks();
  }
  function setMemo(id, k, text) {
    var e = edits[id] || (edits[id] = {}), m = e.memo || {};
    if (text === base[id].memo[k]) delete m[k]; else m[k] = text;
    if (Object.keys(m).length) e.memo = m; else delete e.memo;
    refreshMarks();
  }

  // ── 送出 ──
  function collectItems() {
    var items = [];
    Object.keys(edits).sort(function (a, b) { return a - b; }).forEach(function (id) {
      var e = edits[id], b = base[id], f = fields[id], itemid = Number(id), dic = f && f.dictionary;
      if (!b) return;
      if ('caption' in e) items.push({ itemid: itemid, kind: 'caption', before: b.caption, after: e.caption });
      if ('options' in e) items.push({ itemid: itemid, kind: 'options', before: b.options, after: e.options });
      if ('default' in e) items.push({ itemid: itemid, kind: 'default', before: b['default'], after: e['default'] });
      if ('required' in e) items.push({ itemid: itemid, kind: 'required', before: b.required, after: e.required });
      if (e.memo) {
        var before = {}, after = {};
        Object.keys(e.memo).forEach(function (k) { before[k] = memoValue(k, b.memo[k]); after[k] = memoValue(k, e.memo[k]); });
        items.push({ itemid: itemid, kind: 'memo', dic_id: dic.id || '', dic_name: dic.name, before: before, after: after });
      }
      if ('fhir' in e) items.push({ itemid: itemid, kind: 'fhir', dic_id: dic.id || '', dic_name: dic.name, after: e.fhir });
      if ('comment' in e) items.push({ itemid: itemid, kind: 'comment', text: e.comment });
    });
    Object.keys(areaComments).forEach(function (id) { if (areaComments[id]) items.push({ area: Number(id), kind: 'comment', text: areaComments[id] }); });
    if (formComment && formComment.value.trim()) items.push({ kind: 'comment', text: formComment.value.trim() });
    return items;
  }
  // 送出後以這次的新值當基準、清掉修改：同一頁再送一次時只帶之後的修改
  function rebase() {
    Object.keys(edits).forEach(function (id) {
      var e = edits[id], b = base[id];
      if (!b) return;
      ['caption', 'options', 'default', 'required', 'fhir'].forEach(function (k) { if (k in e) b[k] = e[k]; });
      if (e.memo) Object.keys(e.memo).forEach(function (k) { b.memo[k] = e.memo[k]; });
    });
    edits = {}; areaComments = {};
    if (formComment) formComment.value = '';
  }
  // 用 runtime 的 GetValue3 讀值；它會累積 IOTjson.detail、只讀看得見的欄位，呼叫前後自己復原
  function readValues() {
    var out = {}, show = window.ck_show, iot = window.IOTjson, mark = iot && iot.detail ? iot.detail.length : 0;
    window.ck_show = true;
    try {
      GetValue3($('.area')).forEach(function (x) {
        var f = fields[String(x.itemid)];
        if (f && f.datatype !== 'imgbox' && x.value !== undefined && x.value !== '') out[String(x.itemid)] = String(x.value);
      });
    } catch (e) { console.warn('[review] 讀取欄位值失敗', e); }
    window.ck_show = show;
    if (iot && iot.detail) iot.detail.length = mark;
    return out;
  }
  // 什麼都沒改就按「送出意見」：多半是看完了，直接問要不要定稿（F-38）
  function askFinalize() {
    var box = el('span', { className: 'rv-ask' }, ['沒有修改，要直接「定稿」嗎？ ',
      el('button', { type: 'button', textContent: '定稿', on: { click: function () { statusLine.textContent = ''; submit('finalize'); } } }), ' ',
      el('button', { type: 'button', textContent: '先不要', on: { click: function () { statusLine.textContent = ''; } } })]);
    statusLine.textContent = '';
    statusLine.style.color = '';
    statusLine.appendChild(box);
  }
  function submit(status) {
    if (!draftId) return setStatus('網址沒有 draft_id，無法送出', true);
    if (status === 'revise' && !collectItems().length) return askFinalize();
    var body = { v: 1, draft_id: draftId, status: status, values: readValues(), items: collectItems() };
    if (textOpened) body.text_output = readText();
    setStatus('送出中…');
    fetch('/__review/' + draftId, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (!j.ok) throw new Error(j.error || '伺服器拒絕');
        rebase();
        if (panelMode === 'card' || panelMode === 'area') renderPanel();
        refreshMarks();
        setStatus(status === 'finalize' ? '已定稿（第 ' + j.seq + ' 次意見），請回到對話' : '第 ' + j.seq + ' 次意見已送出，請回到對話');
      })
      .catch(function (e) { setStatus('送出失敗：' + e.message + '（修改還留在頁面上，可再按一次）', true); });
  }
  // 重新整理後回填上一次的值；SetValueByID 不會重算，填完統一 calculate。label 是計算結果不回填
  function restore() {
    if (!draftId) return;
    fetch('/__review/' + draftId + '/latest')
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        if (!j) return;
        Object.keys(j.values || {}).forEach(function (id) {
          var f = fields[id];
          if (!f || ['label', 'action', 'action2', 'imgbox'].indexOf(f.datatype) >= 0) return;
          try { SetValueByID(id, j.values[id]); } catch (e) { console.warn('[review] 回填失敗', id, e); }
        });
        $(targetid).calx('refresh');
        $(targetid).calx('calculate');
        if (j.status === 'finalize') setStatus('已定稿（第 ' + j.seq + ' 次意見）');
        else if (j.seq > (meta.applied_seq || 0)) setStatus('第 ' + j.seq + ' 次意見尚未套用到這份預覽');
      })
      .catch(function (e) { console.warn('[review] 讀取上次意見失敗', e); });
  }

  // ── 文字輸出 ──
  function readText() {
    var parsed = {};
    try { parsed = JSON.parse(GetJsonText() || '{}'); } catch (e) { console.warn('[review] GetJsonText 失敗', e); }
    var keys = {};
    Object.keys(parsed).forEach(function (k) { if (k !== 'all') keys[k] = parsed[k]; });
    return { all: parsed.all || '', keys: keys };
  }
  var showBreaks = function (s) { return String(s).replace(/\r\n/g, '↵\n'); };
  function compareKeys(have, want) {
    var lower = {}, r = { ok: [], missing: [], extra: [], caseDiff: [] };
    have.forEach(function (k) { lower[k.toLowerCase()] = k; });
    want.forEach(function (k) {
      if (have.indexOf(k) >= 0) r.ok.push(k);
      else if (lower[k.toLowerCase()]) r.caseDiff.push(k + ' ↔ ' + lower[k.toLowerCase()]);
      else r.missing.push(k);
    });
    var wantLower = want.map(function (k) { return k.toLowerCase(); });
    r.extra = have.filter(function (k) { return wantLower.indexOf(k.toLowerCase()) < 0; });
    return r;
  }
  function keyChips(title, list, cls) {
    if (!list.length) return null;
    return el('div', { className: 'rv-chips' }, [title + '：'].concat(list.map(function (k) { return el('span', { className: 'rv-chip ' + cls, textContent: k }); })));
  }
  function renderText() {
    textOpened = true;
    var out = readText(), m = meta || {}, have = Object.keys(out.keys), want = m.his_text_keys || [], cmp = compareKeys(have, want);
    var gettext = (m.areas || []).filter(function (a) { return a.gettext; }).map(function (a) { return '#' + a.itemid + (a.title ? ' ' + a.title : ''); });
    var kids = [
      section('文字輸出（GetJsonText）'),
      line('模式：' + (m.histext || window.ck_histext || '')),
      line('回 HIS 的區塊：' + (gettext.join('、') || '（無）')),
      want.length ? line('HIS 接收端要的鍵：' + want.join('、')) : line('HIS 接收端要的鍵：（draft 沒有設定 his_text_keys）'),
      keyChips('相符', cmp.ok, 'rv-ok'), keyChips('缺少', cmp.missing, 'rv-bad'), keyChips('大小寫不同', cmp.caseDiff, 'rv-case'),
      keyChips(want.length ? '多出' : '輸出的鍵', cmp.extra, want.length ? 'rv-warn' : 'rv-ok'),
      section('all'), el('pre', { className: 'rv-pre', textContent: out.all ? showBreaks(out.all) : '（空白：還沒有填值，或 histextbydict 模式找不到 HIStext 欄位）' })
    ];
    have.forEach(function (k) { kids.push(section(k)); kids.push(el('pre', { className: 'rv-pre', textContent: showBreaks(out.keys[k]) })); });
    kids.push(el('button', { type: 'button', textContent: '重新產生', on: { click: renderText } }));
    fillPanel(kids);
  }

  // ── 卡片 ──
  function fillPanel(kids) {
    panel.textContent = '';
    panel.appendChild(el('button', { type: 'button', className: 'rv-close', textContent: '×', title: '關閉', on: { click: closePanel } }));
    kids.forEach(function (k) { if (k) panel.appendChild(k); });
    panel.style.display = 'block';
  }
  function closePanel() { panelMode = ''; panelId = ''; panel.style.display = 'none'; refreshMarks(); }
  function open(mode, id) { panelMode = mode; panelId = id; renderPanel(); refreshMarks(); }
  function renderPanel() {
    if (panelMode === 'text') renderText();
    else if (panelMode === 'area') renderAreaCard(panelId);
    else if (panelMode === 'card') renderCard(panelId);
  }
  function textInput(value, onInput) { return el('input', { type: 'text', value: value, className: 'rv-input', on: { input: function () { onInput(this.value); } } }); }
  function textArea(value, onInput) { return el('textarea', { value: value, rows: 2, className: 'rv-input', on: { input: function () { onInput(this.value); } } }); }
  function commentBox(value, onInput) { return [section('意見（要增減欄位、搬區塊、改計算式請寫在這裡）'), textArea(value, onInput)]; }
  function changedTag(id) { return el('span', { className: 'rv-changed', textContent: '已修改', id: 'rv-changed-tag', style: hasEdits(id) ? '' : 'display:none' }); }

  function dictionarySection(id, f) {
    var d = f.dictionary, e = edits[id] || {}, b = base[id];
    if (!d) return [section('字典'), line('（未綁字典）')];
    var kids = [section(memoEditable(f) ? '字典補述（可在此修改）' : '字典'),
      line(d.name + (d.pending ? '（待新建）' : '') + (d.level ? '｜' + (LEVEL_LABEL[d.level] || d.level) : '') + (d.memo_by ? '｜補述：' + d.memo_by : ''))];
    if (d.desc) kids.push(line('說明：' + d.desc));
    if (!memoEditable(f)) { kids.push(line('這本字典不在本機索引，補述無法在這裡改')); return kids; }
    MEMO_KEYS.forEach(function (k) {
      var v = e.memo && k in e.memo ? e.memo[k] : b.memo[k];
      kids.push(row(MEMO_LABEL[k], textArea(v, function (t) { setMemo(id, k, t); })));
    });
    var err = el('div', { className: 'rv-err' });
    var fhirText = JSON.stringify('fhir' in e ? e.fhir : b.fhir, null, 1);
    kids.push(row('FHIR（JSON 陣列）', el('textarea', { value: fhirText, rows: 4, className: 'rv-input', on: { input: function () {
      try {
        var v = this.value.trim() ? JSON.parse(this.value) : [];
        if (!Array.isArray(v)) throw new Error('必須是陣列');
        err.textContent = '';
        setEdit(id, 'fhir', v, b.fhir);
      } catch (x) { err.textContent = 'JSON 不正確：' + x.message + '（這次的修改不會送出）'; setEdit(id, 'fhir', b.fhir, b.fhir); }
    } } })));
    kids.push(err);
    return kids;
  }
  function formulaSection(f) {
    var hit = (meta.formulas || []).filter(function (x) { return x.itemid === f.itemid; })[0];
    if (!hit) return [];
    var kids = [section('計算式'), line(hit.labeled || hit.formula)];
    if (hit.labeled) kids.push(el('code', { className: 'rv-code', textContent: hit.formula }));
    (hit.samples || []).forEach(function (s) {
      var result = 'reason' in s ? '無法試算：' + s.reason : '＝' + s.value;
      kids.push(line(JSON.stringify(s.values) + ' ' + result + ('expect' in s ? '（預期 ' + s.expect + (s.match ? '，相符' : '，不符') + '）' : '')));
    });
    return kids;
  }
  function renderCard(id) {
    var f = fields[id], e = edits[id] || {}, b = base[id];
    if (!f) return;
    var kids = [el('div', { className: 'rv-head' }, ['#' + id + ' ' + (f.caption || '（無說明）') + '　', el('span', { className: 'rv-dim', textContent: TYPE_LABEL[f.datatype] || f.datatype }), changedTag(id)]),
      row('控制項前的文字（說明）', textInput('caption' in e ? e.caption : b.caption, function (v) { setEdit(id, 'caption', v, b.caption); }))];
    if (b.options) {
      var cur = (e.options || b.options).slice();
      cur.forEach(function (opt, i) {
        kids.push(row('選項 ' + (i + 1), textInput(opt, function (v) { cur[i] = v; setEdit(id, 'options', cur.slice(), b.options); })));
      });
    }
    if (editableDefault(f)) kids.push(row('預設值', textInput('default' in e ? e['default'] : b['default'], function (v) { setEdit(id, 'default', v, b['default']); })));
    if (['label', 'action', 'action2'].indexOf(f.datatype) < 0) {
      kids.push(row('必填', el('input', { type: 'checkbox', checked: 'required' in e ? e.required : b.required, on: { change: function () { setEdit(id, 'required', this.checked, b.required); } } })));
    }
    kids = kids.concat(dictionarySection(id, f), formulaSection(f));
    if ((f.refs_in || []).length) {
      kids.push(section('誰參照它'));
      f.refs_in.forEach(function (r) { kids.push(line('#' + r.from + ' ' + r.from_caption + '（' + r.kind + '）')); });
    }
    if ((f.ai || []).length) {
      kids.push(section('AI 資料流'));
      f.ai.forEach(function (a) { kids.push(line(a)); });
    }
    kids = kids.concat(commentBox(e.comment || '', function (v) { setEdit(id, 'comment', v.trim(), ''); }));
    fillPanel(kids);
  }
  function renderAreaCard(id) {
    var a = areas[id];
    if (!a) return;
    fillPanel([el('div', { className: 'rv-head', textContent: '區塊 #' + id + '　' + (a.title || '（無標題）') }),
      line('類型：' + a.type), line('回傳 HIS 文字：' + (a.gettext ? '是' : '否'))]
      .concat(commentBox(areaComments[id] || '', function (v) { areaComments[id] = v.trim(); refreshMarks(); })));
  }

  // ── 標記圖層 ──
  function makeBadge(key, cls, onClick) {
    var b = el('button', { type: 'button', className: 'rv-badge ' + cls, title: cls === 'rv-area' ? '審閱：留區塊意見' : '審閱：改說明文字、補述、留意見', on: { click: onClick } });
    badges[key] = b;
    layer.appendChild(b);
  }
  function refreshMarks() {
    Object.keys(badges).forEach(function (key) {
      var kind = key.charAt(0), id = key.slice(2);
      var dirty = kind === 'c' ? hasEdits(id) : !!areaComments[id];
      badges[key].classList.toggle('rv-dirty', dirty);
      badges[key].classList.toggle('rv-active', panelId === id && panelMode === (kind === 'c' ? 'card' : 'area'));
    });
    var tag = document.getElementById('rv-changed-tag');
    if (tag && panelMode === 'card') tag.style.display = hasEdits(panelId) ? '' : 'none';
  }
  // 同一個 itemid 可能有多個元素（span＋隱藏的 select）：取第一個真的畫在畫面上的
  function anchorOf(id, isArea) {
    var list = document.querySelectorAll('[itemid="' + id + '"]');
    for (var i = 0; i < list.length; i++) {
      var e = list[i];
      if (e.classList.contains('area') !== isArea) continue;
      var r = e.getBoundingClientRect();
      // 還沒有值的 label 是寬度 0 的 span，仍要有標記；display:none（未選的頁籤、連動隱藏）寬高都是 0
      if ((r.width > 0 || r.height > 0) && getComputedStyle(e).visibility !== 'hidden') return r;
    }
    return null;
  }
  function place() {
    if (!layer) return;
    var box = document.querySelector('.body-content'), bar = document.getElementById('strucmed-preview-bar');
    var top = box ? box.getBoundingClientRect().top : 0;
    var bottom = bar ? bar.getBoundingClientRect().top : window.innerHeight;
    Object.keys(badges).forEach(function (key) {
      var r = reviewOn ? anchorOf(key.slice(2), key.charAt(0) === 'a') : null, b = badges[key];
      if (!r || r.top < top || r.top > bottom) { b.style.display = 'none'; return; }
      b.style.display = 'block';
      // 貼在右上角外側，不蓋住欄位值
      b.style.left = (r.right - 2) + 'px';
      b.style.top = (r.top - 9) + 'px';
    });
    panel.style.height = Math.max(120, bottom) + 'px';
  }
  var placing = false;
  function schedulePlace() {
    if (placing) return;
    placing = true;
    requestAnimationFrame(function () { placing = false; place(); });
  }

  // ── 橫幅 ──
  function setStatus(text, bad) {
    if (!statusLine) return;
    statusLine.textContent = text;
    statusLine.style.color = bad ? '#c62828' : '#2e7d32';
  }
  function buildBanner(tools) {
    var when = meta.updated_at ? new Date(meta.updated_at).toLocaleString('zh-TW') : '';
    statusLine = el('span', { className: 'rv-status' });
    formComment = el('textarea', { rows: 1, className: 'rv-input rv-form-comment', placeholder: '整體意見（例如表單名稱、區塊順序）' });
    tools.appendChild(el('span', { className: 'rv-title', textContent: ' ' + (meta.name || '') + (when ? '｜更新 ' + when : '') + '｜' + (meta.applied_seq ? '已套用至第 ' + meta.applied_seq + ' 次意見' : '尚未套用意見') + '｜請勿填入真實病人資料 ' }));
    var prefilled = (meta.pending_dictionaries || []).length && (meta.fields || []).some(function (f) { return f.dictionary && f.dictionary.pending && f.dictionary.memo; });
    if (prefilled) tools.appendChild(el('div', { className: 'rv-hint', textContent: '字典補述已由 AI 預填，請看藍點卡片' }));
    tools.appendChild(formComment);
    tools.appendChild(el('button', { type: 'button', textContent: '送出意見', on: { click: function () { submit('revise'); } } }));
    tools.appendChild(document.createTextNode(' '));
    tools.appendChild(el('button', { type: 'button', textContent: '定稿', on: { click: function () { submit('finalize'); } } }));
    tools.appendChild(document.createTextNode(' '));
    tools.appendChild(statusLine);
  }
  function bindToggles(tools) {
    var reviewBtn = tools.querySelector('[data-review-toggle="review"]'), textBtn = tools.querySelector('[data-review-toggle="text"]');
    var mark = function () { reviewBtn.classList.toggle('rv-on', reviewOn); textBtn.classList.toggle('rv-on', panelMode === 'text'); };
    reviewBtn.addEventListener('click', function () {
      reviewOn = !reviewOn;
      if (!reviewOn && panelMode !== 'text') closePanel();
      mark(); place();
    });
    textBtn.addEventListener('click', function () {
      if (panelMode === 'text') closePanel(); else open('text', '');
      mark();
    });
    panel.addEventListener('click', mark);
    layer.addEventListener('click', mark);
    mark();
  }
  var STYLE = '#rv-layer{position:fixed;left:0;top:0;width:0;height:0;z-index:99990;font:13px/1.5 sans-serif;color:#333}' +
    '.rv-badge{position:absolute;display:none;width:12px;height:12px;padding:0;border:1px solid #fff;border-radius:50%;background:#1976d2;opacity:.75;cursor:pointer}' +
    '.rv-badge:hover{opacity:1}.rv-badge.rv-area{background:#6d4c41;border-radius:3px}.rv-badge.rv-dirty{background:#e65100;opacity:1}.rv-badge.rv-active{box-shadow:0 0 0 2px #ffb300}' +
    '#rv-panel{display:none;position:absolute;z-index:1;top:0;left:calc(100vw - min(380px,100vw));width:min(380px,100vw);box-sizing:border-box;padding:10px 12px;overflow:auto;background:#fff;border-left:2px solid #1976d2;box-shadow:-2px 0 6px rgba(0,0,0,.2)}' +
    '.rv-close{float:right;border:0;background:none;font-size:18px;line-height:1;cursor:pointer}.rv-head{font-weight:bold;margin-bottom:6px}.rv-dim{color:#777;font-weight:normal}' +
    '.rv-changed{margin-left:6px;padding:0 5px;border-radius:3px;background:#e65100;color:#fff;font-size:11px;font-weight:normal}' +
    '.rv-row{display:block;margin:4px 0}.rv-key{display:block;color:#555;font-size:12px}.rv-input{box-sizing:border-box;width:100%;font:inherit;padding:2px 4px;border:1px solid #bbb;border-radius:3px}' +
    '.rv-row input[type=checkbox]{width:auto}.rv-sec{margin-top:10px;padding-top:4px;border-top:1px solid #ddd;font-weight:bold}.rv-text{margin:2px 0;word-break:break-word}' +
    '.rv-err{color:#c62828;font-size:12px}.rv-code{display:block;margin:2px 0;font-size:12px;word-break:break-all;color:#555}' +
    '.rv-pre{margin:2px 0;padding:4px 6px;background:#f5f5f5;white-space:pre-wrap;word-break:break-word;font:12px/1.5 monospace}' +
    '.rv-chips{margin:2px 0}.rv-chip{display:inline-block;margin:1px 3px;padding:0 5px;border-radius:3px;font-size:12px}.rv-ok{background:#c8e6c9}.rv-bad{background:#ffcdd2}.rv-warn{background:#ffe0b2}.rv-case{background:#e1bee7}' +
    '#strucmed-review-tools{margin-bottom:4px}#strucmed-review-tools button{cursor:pointer}#strucmed-review-tools button.rv-on{background:#1976d2;color:#fff;border:1px solid #1976d2}' +
    '.rv-form-comment{display:block;margin:3px 0;max-width:640px}.rv-status{font-weight:bold}.rv-hint{margin:2px 0;color:#1565c0}.rv-ask{color:#333;font-weight:normal}';

  function start() {
    var tools = document.getElementById('strucmed-review-tools');
    if (!tools) return;
    if (!meta) {
      tools.querySelector('[data-review-toggle="review"]').disabled = true;
      tools.appendChild(document.createTextNode(' 沒有審閱資料：請重新呼叫 form_preview（format: "html"）'));
      meta = {};
    } else prepare();
    document.head.appendChild(el('style', { textContent: STYLE }));
    layer = el('div', { id: 'rv-layer' });
    panel = el('div', { id: 'rv-panel' });
    layer.appendChild(panel);
    document.body.appendChild(layer);
    Object.keys(fields).forEach(function (id) { makeBadge('c:' + id, 'rv-control', function () { open('card', id); }); });
    Object.keys(areas).forEach(function (id) { makeBadge('a:' + id, 'rv-area', function () { open('area', id); }); });
    if (meta.draft_id) buildBanner(tools);
    bindToggles(tools);
    window.addEventListener('scroll', schedulePlace, true);
    window.addEventListener('resize', schedulePlace);
    setInterval(place, 800);       // 選項連動、頁籤切換都會改版面，沒有事件可掛
    place();
    if (meta.draft_id) restore();
  }
  // 表單由 getheader() 在 load 事件畫出；.area 出現才能定位標記與回填
  window.addEventListener('load', function () {
    var tries = 0;
    (function wait() {
      if (document.querySelector('.area') || ++tries > 50) return start();
      setTimeout(wait, 100);
    })();
  });
})();
