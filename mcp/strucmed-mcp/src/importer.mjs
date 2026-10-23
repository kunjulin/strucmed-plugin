// v1：載入既有表單作為改版的基礎
// 支援：範本套件 v2（.package.json 或含 strucmed-package 的 .htm）、
//       舊版 .htm（<script>var tempdata =…</script>，擷取規則同編輯器 getFormData，平台 web/js/shortcut.js:2081-2107）、
//       編輯器「匯出 JSON 文件」的 .json（GetData() 陣列）。
import crypto from 'node:crypto';
import { E, fail } from './errors.mjs';
import { FORMAT, validatePackage, extractPackage } from './package.mjs';

export const sha256 = s => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

function legacyTempdata(htm) {
  const start = htm.indexOf('<script>var tempdata =');
  if (start < 0) return null;
  let s = htm.substring(start);
  const end = s.indexOf('</script>');
  if (end < 0) return null;
  s = s.substring(0, end).replace('<script>var tempdata =', '').trim();
  return JSON.parse(s);
}

function checkForm(form) {
  if (!Array.isArray(form) || form.length < 2) fail(E.INVALID_INPUT, '不是有效的表單定義（GetData() 陣列）');
  if (!form.some(x => x && x.itemtype === 'iot')) fail(E.INVALID_INPUT, '表單定義缺少 iot 表頭');
  if (form.some(x => !x || typeof x !== 'object' || typeof x.itemtype !== 'string')) fail(E.INVALID_INPUT, '表單定義含無法辨識的項目');
}

// 回傳 { kind, form, template?, presets, dictionaries }
export function parseSource(text, fileName) {
  const t = String(text).replace(/^﻿/, '');
  const lower = String(fileName || '').toLowerCase();
  let pkg = null, form = null, kind;

  if (lower.endsWith('.htm') || lower.endsWith('.html') || /^\s*</.test(t)) {
    pkg = extractPackage(t);
    if (pkg) kind = 'package-htm';
    else {
      try { form = legacyTempdata(t); } catch (e) { fail(E.INVALID_INPUT, `.htm 中的 tempdata 無法解析：${e.message}`); }
      if (!form) fail(E.INVALID_INPUT, '.htm 中找不到範本套件或 var tempdata');
      kind = 'legacy-htm';
    }
  } else {
    let j;
    try { j = JSON.parse(t); } catch (e) { fail(E.INVALID_INPUT, `JSON 無法解析：${e.message}`); }
    if (Array.isArray(j)) { form = j; kind = 'getdata-json'; }
    else if (j && j.format === FORMAT) { pkg = j; kind = 'package-json'; }
    else fail(E.INVALID_INPUT, '無法辨識的 JSON：不是 GetData() 陣列，也不是 strucmed.template/v2 套件');
  }

  if (pkg) {
    const errs = validatePackage(pkg);
    if (errs.length) fail(E.INVALID_INPUT, '範本套件驗證失敗（可能被修改或格式錯誤），拒絕載入', { errors: errs });
    checkForm(pkg.form);
    return { kind, form: pkg.form, template: pkg.template, presets: pkg.presets, dictionaries: pkg.dictionaries };
  }
  checkForm(form);
  return { kind, form, template: null, presets: [], dictionaries: [] };
}
