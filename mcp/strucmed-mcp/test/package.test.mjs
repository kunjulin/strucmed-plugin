import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPackage, validatePackage, packageHash, renderHtm, extractPackage, folderCode, FORMAT } from '../src/package.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA = JSON.parse(fs.readFileSync(path.join(HERE, '../../../schemas/strucmed-template-v2.schema.json'), 'utf8'));
const form = [
  { itemtype: 'form', authread: ['doctor'], authwrite: ['doctor'], gettext: true,
    item: [{ datatype: 'text', datavalue: 'a </script><!-- \u2028 b' }], itemid: '1' },
  { itemtype: 'javascript', content: '// generated-by: test' },
  { itemtype: 'iot', editorver: '1.6', sheetid: '', templateID: '' }
];
const meta = { name: 'T', shortcut: 'AbC', groups: ['All'], description: 'd', dept_no: '33F00', folder_type: 'sub' };

test('schema and validator agree on top-level fields', () => {
  assert.equal(SCHEMA.properties.format.const, FORMAT);
  const pkg = buildPackage({ form, meta, generator: 'test' });
  assert.deepEqual(Object.keys(pkg).sort(), Object.keys(SCHEMA.properties).sort());
  for (const k of SCHEMA.required) assert.ok(k in pkg, k);
  for (const k of SCHEMA.properties.template.required) assert.ok(k in pkg.template, 'template.' + k);
});

test('buildPackage normalises groups, shortcut and folder', () => {
  const pkg = buildPackage({ form, meta, generator: 'test' });
  assert.deepEqual(pkg.template.groups, ['門', '住', '急', '手術', '檢查', '助手'], 'All expands to all six');
  assert.equal(pkg.template.shortcut, 'abc');
  assert.deepEqual(pkg.template.folder, { type: 'sub', code: '33F0' });
  assert.equal(pkg.integrity.sha256, packageHash(form, []));
  assert.deepEqual(validatePackage(pkg), []);
});

test('folder codes follow the shortcutsourceID contract ', () => {
  assert.equal(folderCode('sub', '33F00'), '33F0');
  assert.equal(folderCode('dpt', '33F00'), '33F');
  assert.equal(folderCode('sys', '33F00'), '3F');
  assert.equal(folderCode('sys', '!@00'), '@0');
  assert.equal(folderCode('usr', '33F00', 'U1'), 'U1');
});

test('validatePackage catches tampering and bad fields', () => {
  const pkg = buildPackage({ form, meta, generator: 'test' });
  const t1 = structuredClone(pkg); t1.form[0].item[0].datavalue = 'changed';
  assert.ok(validatePackage(t1).some(e => e.includes('sha256')));
  const t2 = structuredClone(pkg); t2.template.groups = ['All'];
  assert.ok(validatePackage(t2).some(e => e.includes('groups')));
  const t3 = structuredClone(pkg); t3.extra = 1;
  assert.ok(validatePackage(t3).some(e => e.includes('extra')));
  assert.throws(() => buildPackage({ form, meta: { ...meta, name: '' }, generator: 'test' }), /name/);
});

test('.htm keeps legacy tempdata first and embeds the package safely', () => {
  const pkg = buildPackage({ form, meta, generator: 'test' });
  const htm = renderHtm(pkg, 'T');
  // legacy importer: first "<script>var tempdata =" up to the next "</script>" (平台 web/js/shortcut.js:2081-2107)
  const start = htm.indexOf('<script>var tempdata =');
  let s = htm.substring(start); s = s.substring(0, s.indexOf('</script>'));
  assert.deepEqual(JSON.parse(s.replace('<script>var tempdata =', '').trim()), form);
  assert.ok(start < htm.indexOf('id="strucmed-package"'), 'tempdata comes first');
  // no raw "</script" or "<!--" inside the package script
  const body = /id="strucmed-package">([\s\S]*?)<\/script>/.exec(htm)[1];
  assert.ok(!body.includes('<'), 'package JSON has no raw "<"');
  assert.deepEqual(extractPackage(htm), pkg);
});
