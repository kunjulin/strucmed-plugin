// form_preview（tree / markdown；html 預覽排在 v0.2）
// v1：可呈現既有表單的巢狀結構（表格格、圖示、群組子項）與計算式、巨集
const LABEL = {
  textbox: '文字', numberbox: '數字', textarea: '段落', calendar: '日期時間', selection: '下拉', combobox: '組合框',
  radiobutton: '單選', checkbox: '核取', submenu: '階層選單', label: '計算式/顯示', imgbox: '圖片',
  form: '彈出片語', subgroup: '群組', action: '巨集按鈕', action2: 'LLM 按鈕'
};
const AREA = {
  form: '文字', form2: '雙欄', formtable: '固定表格', table1: '動態表格(欄向，按＋加列)', table2: '動態表格(列向，按＋加欄)',
  // tab1 是垂直頁籤、tab2 是水平頁籤（平台 web/js/scripts.js:1174、1136；TempHtml.js:2509、2531）
  tab1: '頁籤(垂直)', tab2: '頁籤(水平)', picture: '圖形', picture_table: '圖形表格'
};
const ROLE = { nohis: '無', tohis: '僅寫入', fromhis: '僅讀取', puthis: '可讀寫' };
const clip = (s, n = 40) => { s = String(s); return s.length > n ? s.slice(0, n) + '…' : s; };

function describe(c, touched) {
  const bits = [`#${c.itemid} ${LABEL[c.datatype] || c.datatype}`];
  if (touched && touched.has(String(c.itemid))) bits.push('✎');
  if (Array.isArray(c.option) && c.option.length) {
    bits.push('[' + c.option.map(o => (typeof o === 'string' ? o : o.value + (o.further ? `→#${o.further}` : ''))).join(' / ') + ']');
  }
  if (c.datatype === 'numberbox' && (c.minval || c.maxval)) bits.push(`範圍 ${c.minval || '−∞'}~${c.maxval || '∞'}`);
  if (c.datatype === 'calendar') bits.push(c.format);
  if (c.formula) bits.push(`公式「${clip(c.formula)}」`);
  if (c.hisquery) bits.push(`HIS「${clip(c.hisquery)}」`);
  if (c.actionScript) bits.push(`${c.actionName ? `「${c.actionName}」` : ''}腳本「${clip(c.actionScript)}」→#${c.actionID}`);
  if (typeof c.datavalue === 'string' && c.datavalue) bits.push(`預設「${clip(c.datavalue, 20)}」`);
  if (Array.isArray(c.datavalue)) bits.push(`子項 ${c.datavalue.filter(x => x && x.itemid !== undefined).length}`);
  if (c.reference) bits.push(`引用 #${c.reference}`);
  if (c.required) bits.push('必填');
  bits.push(c.dictionary ? `字典 ${c.dictionary}${c.dicid ? '' : '（新建）'}／${ROLE[c.dicrole] || c.dicrole}` : '無字典');
  return bits.join(' ');
}

// 依「文字＋控制項＋換行」串流排成多行
function streamLines(items, touched) {
  const out = [];
  let line = [];
  const flush = () => { if (line.length) { out.push(line.join(' ')); line = []; } };
  for (const it of items || []) {
    if (!it) continue;
    if (it.datatype === 'newline') flush();
    else if (it.datatype === 'text') line.push(String(it.datavalue || '').trim());
    else if (it.datatype) line.push(`〔${describe(it, touched)}〕`);
  }
  flush();
  return out;
}

// 非文字區塊：逐格（td / row / icon）列出內容
function nestedLines(area, touched) {
  const out = [];
  // 標示格子位置（index／row,col），對應 form_add_control 的 cell 參數
  const cellName = { tab1: '頁籤', tab2: '頁籤', table1: '欄', table2: '列' }[area.itemtype];
  const rec = (node, label, parentType) => {
    (node.item || []).forEach((child, i) => {
      if (!child || child.datatype) return;
      const tag = child.itemtype === 'row' ? `[row ${i}] 列 ${child.columns || ''}`
        : child.itemtype === 'icon' ? `標示(${child.iconshape || ''})`
          : parentType === 'row' ? `[col ${i}]`
            : cellName ? `[index ${i}] ${cellName}「${child.datatitle || ''}」`
              : child.datatitle ? `欄「${child.datatitle}」` : (child.itemtype || '格');
      const lines = streamLines(child.item, touched);
      if (lines.length) out.push(`${label}${tag}：${lines.join(' ／ ')}`);
      else if (cellName || parentType === 'row') out.push(`${label}${tag}：（空白）`);
      if (child.item && child.item.some(x => x && !x.datatype)) rec(child, `${label}${tag} › `, child.itemtype);
    });
  };
  if ((area.item || []).some(x => x && x.datatype)) out.push(...streamLines(area.item, touched));
  rec(area, '', area.itemtype);
  if (Array.isArray(area.itemtemp) && area.itemtemp.length) out.push(`暫存區：${streamLines(area.itemtemp, touched).join(' ／ ')}`);
  if (area.itemtype === 'picture' || area.itemtype === 'picture_table') out.push(`（底圖 ${area.imagesize || ''}，${area.dataimage ? Math.round(area.dataimage.length / 1024) + 'KB' : '無'}）`);
  return out;
}

export function preview(draft, format = 'tree') {
  const m = draft.meta;
  const touched = new Set((draft.touched || []).map(String));
  const lines = [];
  const md = format === 'markdown';
  lines.push(md ? `### ${m.name}` : `表單：${m.name}`);
  lines.push(`${md ? '- ' : ''}捷徑：${m.shortcut || '（未設）'}　作業別：${(m.groups || []).join('、') || '（未設）'}　科部：${m.dept_no}`);
  if (draft.source && draft.source.derivedFrom) {
    const d = draft.source.derivedFrom;
    lines.push(`${md ? '- ' : ''}改版自：${d.name || '（未命名）'}${d.templateID ? `（${String(d.templateID).slice(0, 8)}…）` : ''}；✎＝本次新增或修改`);
  }
  for (const a of draft.areas) {
    const node = a.imported || a.structured ? a.area : { itemtype: 'form', itemid: a.itemid, authread: a.authread, gettext: a.gettext, item: a.items };
    const hidden = a.imported ? !(node.authread || []).includes('doctor') : a.hidden;
    const flags = [a.imported ? null : '新增', hidden ? '隱藏' : null, node.gettext ? null : '不回傳 HIS'].filter(Boolean).join('、');
    const head = `區塊 #${node.itemid} ${AREA[node.itemtype] || node.itemtype}${a.title ? '：' + a.title : ''}${flags ? `（${flags}）` : ''}`;
    lines.push(md ? `\n**${head}**\n` : `└ ${head}`);
    const body = node.itemtype === 'form' ? streamLines(node.item, touched) : nestedLines(node, touched);
    for (const l of body) lines.push(md ? '- ' + l : '   ├ ' + l);
  }
  const pend = draft.pendingDictionaries || [];
  if (pend.length) lines.push(`${md ? '\n' : ''}待新建字典（${pend.length}）：${pend.map(p => p.name).join('、')}`);
  if (draft.source && draft.source.javascript) lines.push(`${md ? '\n' : ''}表單 JS：保留原表單 ${draft.source.javascript.length} 字元（未審查）`);
  return lines.join('\n');
}
