// MCP Apps (SEP-1865) card for form_preview / form_export: one `ui://` HTML resource rendered by a
// UI-capable host (MaiAgent web chat / admin console) next to the tool's text result. Text-only
// hosts ignore `_meta.ui` and `structuredContent` and keep reading the JSON text as before.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateDraft } from './validate.mjs';
import { preview } from './preview.mjs';
import { VERSION } from './export.mjs';
import * as store from './store.mjs';

export const CARD_URI = 'ui://strucmed/form-card.html';
export const CARD_MIME = 'text/html;profile=mcp-app';
const CARD_FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../ui/form-card.html');
/** Tools whose results the card renders. */
export const CARD_TOOLS = new Set(['form_preview', 'form_export']);

export const uiMeta = () => ({ ui: { resourceUri: CARD_URI } });

export function listResources() {
  return [{ uri: CARD_URI, name: 'StrucMed 表單卡片', description: '表單預覽、匯出計畫確認與下載（MCP App）', mimeType: CARD_MIME }];
}

export function readResource(uri) {
  if (uri !== CARD_URI) return null;
  return { contents: [{ uri: CARD_URI, mimeType: CARD_MIME, text: fs.readFileSync(CARD_FILE, 'utf8') }] };
}

const LABEL = {
  textbox: '文字', numberbox: '數字', textarea: '段落', calendar: '日期時間', selection: '下拉', combobox: '組合框',
  radiobutton: '單選', checkbox: '核取', submenu: '階層選單', label: '計算式/顯示', imgbox: '圖片',
  form: '彈出片語', subgroup: '群組', action: '巨集按鈕', action2: 'LLM 按鈕'
};

function control(c) {
  return {
    type: 'control', itemid: c.itemid, datatype: c.datatype, kind: LABEL[c.datatype] || c.datatype,
    options: Array.isArray(c.option) ? c.option.map(o => (typeof o === 'string' ? o : String(o.value))) : [],
    multiple: !!c.multiple, required: !!c.required, format: c.format || '',
    dictionary: c.dictionary || '', dictionary_new: !!c.dictionary && !c.dicid, dicrole: c.dicrole || '',
    formula: c.formula || '', hisquery: c.hisquery || '', default: typeof c.datavalue === 'string' ? c.datavalue : '',
    min: c.minval || '', max: c.maxval || ''
  };
}

/** `form` areas as rows of text / control items; other area types fall back to the text preview. */
function areas(draft) {
  return (draft.areas || []).map(a => {
    const node = a.imported || a.structured ? a.area : { itemtype: 'form', itemid: a.itemid, item: a.items };
    const rows = [];
    let row = [];
    const flush = () => { if (row.length) { rows.push(row); row = []; } };
    if (node.itemtype === 'form') {
      for (const it of node.item || []) {
        if (!it) continue;
        if (it.datatype === 'newline') flush();
        else if (it.datatype === 'text') row.push({ type: 'text', text: String(it.datavalue || '').trim() });
        else if (it.datatype) row.push(control(it));
      }
      flush();
    }
    return { itemid: node.itemid, type: node.itemtype, title: a.title || '', hidden: !!a.hidden, structured: node.itemtype !== 'form', rows };
  });
}

/**
 * Card data for a draft. `kind` is the card's state: preview, export_plan (plan + confirm_token
 * waiting for the user) or exported (files written; `files` carry download links when known).
 */
export function cardData(draft, kind, extra = {}) {
  const v = extra.validation || validateDraft(draft, store.loadDictIndex(), store.loadPolicy());
  const m = draft.meta;
  const status = kind === 'exported' ? '已匯出' : kind === 'export_plan' ? '匯出計畫待確認' : v.valid ? '草稿已驗證' : '草稿有錯誤';
  return {
    kind,
    draft_id: draft.draft_id,
    generator: `strucmed-mcp v${VERSION}`,
    form: { name: m.name, shortcut: m.shortcut || '', groups: m.groups || [], dept_no: m.dept_no, description: m.description || '', folder_type: m.folder_type || '' },
    areas: areas(draft),
    // 文字預覽只在有結構化區塊（表格、頁籤等卡片不畫的）時附上，避免模型每輪多讀一份
    preview_markdown: (draft.areas || []).some(a => a.imported || a.structured) ? preview(draft, 'markdown') : '',
    pending_dictionaries: (draft.pendingDictionaries || []).map(p => p.name),
    validation: { valid: v.valid, errors: v.errors || [], warnings: v.warnings || [], stats: v.stats || {} },
    plan: extra.plan, confirm_token: extra.confirm_token, files: extra.files, import_mode: extra.import_mode,
    ui_hints: {
      modelContext: `表單「${m.name}」（draft ${draft.draft_id}）目前狀態：${status}。${kind === 'export_plan' ? '使用者可在卡片按「確認匯出」完成第二段。' : kind === 'exported' ? '檔案已輸出，使用者可從卡片下載 .htm 後到編輯器匯入。' : '使用者可在卡片按「產生匯出計畫」或輸入修改指示。'}`,
      statusLine: `${m.name}：${status}`
    }
  };
}
