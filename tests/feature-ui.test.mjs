import test from 'node:test';
import assert from 'node:assert/strict';
import { PRESETS, upgradeModel, validateModel } from '../src/schema.js';
import { ROTATIONAL_PRESETS } from '../src/features.js';
import { createFeatureForModel, featureDependents } from '../src/feature-ui-model.js';
import { dimensionAttributes, dimensionTarget, sameDimension, renderEndProfile } from '../src/feature-profile.js';
import { createHoleTableCSV } from '../src/feature-report.js';

test('七种模板添加适用新特征的初值合法，工厂不修改原工程', () => {
  for (const p of [...PRESETS, ...ROTATIONAL_PRESETS]) for (const type of ['bore', 'hole', 'groove', 'internal-keyway']) {
    const model = upgradeModel(p.model), original = structuredClone(model);
    if (type === 'internal-keyway' && !model.features.some(f => f.type === 'bore')) {
      assert.throws(() => createFeatureForModel(model, type), /先添加/); continue;
    }
    const feature = createFeatureForModel(model, type, model.segments[0].id);
    assert.deepEqual(model, original);
    model.features.push(feature);
    assert.deepEqual(validateModel(model).errors, [], `${p.name} ${type}`);
  }
});

test('删除依赖仅识别实际内腔引用，端面孔和外环槽的隐藏草稿不阻止删除', () => {
  const model = upgradeModel(ROTATIONAL_PRESETS[2].model);
  const bore = model.features[0], radial = model.features[1];
  const end = createFeatureForModel(model, 'hole');
  model.features.push(end);
  assert.equal(end.boreId, bore.id);
  assert.deepEqual(featureDependents(model, bore.id).map(f => f.id), [radial.id]);
  radial.termination = 'blind';
  assert.deepEqual(featureDependents(model, bore.id), []);
});

test('同一特征的内阶梯和尺寸键有独立DOM身份，端面视图不会注入工程文本', () => {
  const a = { kind: 'feature-parameter', id: 'bore-a', key: 'diameter', subId: 'inner-1' };
  const b = { ...a, key: 'length' }, c = { ...a, subId: 'inner-2' };
  assert.equal(sameDimension(a, b), false); assert.equal(sameDimension(a, c), false);
  assert.deepEqual(dimensionTarget({ dataset: { dimensionKind: 'feature-parameter', featureId: 'bore-a', dimensionKey: 'diameter', dimensionSubId: 'inner-1' } }), a);
  assert.match(dimensionAttributes(a), /data-feature-id="bore-a"/);
  const model = upgradeModel(ROTATIONAL_PRESETS[0].model);
  model.features[1].name = '<script>alert(1)</script>';
  const view = renderEndProfile(model, model.features[1].id);
  assert.ok(!view.includes('<script>'));
  assert.match(view, /&lt;script&gt;/);
});

function parseRow(line) {
  const cells = []; let current = '', quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') { if (quoted && line[i + 1] === '"') { current += '"'; i++; } else quoted = !quoted; }
    else if (c === ',' && !quoted) { cells.push(current); current = ''; }
    else current += c;
  }
  cells.push(current); return cells;
}

test('孔表按实例记录方向/螺纹语义，分开牙深与钻深并防止文本公式注入', () => {
  const model = upgradeModel(ROTATIONAL_PRESETS[2].model);
  model.name = '=HYPERLINK("https://invalid.example")';
  const csv = createHoleTableCSV(model), lines = csv.slice(1).trimEnd().split('\r\n');
  assert.equal(csv[0], '\uFEFF');
  assert.equal(lines.length, 3);
  const rows = lines.slice(1).map(parseRow);
  assert.equal(rows[0][0][0], "'");
  assert.equal(rows[0][4], '46'); assert.equal(rows[0][5], '40'); assert.equal(rows[1][5], '-40');
  assert.equal(rows[0][8], '-1'); assert.equal(rows[1][8], '1');
  assert.equal(rows[0][10], '穿透当前壁'); assert.equal(rows[0][12], '');
  assert.equal(rows[0][16], 'M6×1'); assert.equal(rows[0][20], '6');
  assert.match(rows[0][21], /无实体牙形/);
});
