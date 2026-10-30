import test from 'node:test';
import assert from 'node:assert/strict';
import { createSegment, PRESETS, normalizeModel, upgradeModel, validateModel, SCHEMA_VERSION } from '../src/schema.js';
import { createFeature, createBoreSegment, getBoreLayout, resolveRadialHole, getFeatureDimensions, ROTATIONAL_PRESETS } from '../src/features.js';

const outer = (overrides = {}) => createSegment({ id: 'outer', name: '外圆', length: 100, diameter: 60, endDiameter: 60, ...overrides });
const inner = (overrides = {}) => createBoreSegment({ id: 'inner', name: '内圆', length: 70, diameter: 40, endDiameter: 40, ...overrides });
const bore = (overrides = {}) => createFeature('bore', { id: 'bore', name: '测试内腔', face: 'right', segments: [inner()], ...overrides });
const modelOf = (features = [], segments = [outer()]) => ({ schemaVersion: 2, name: '测试零件', partFamily: 'housing',
  material: 'steel', quality: 'standard', segments, keyways: [], holes: [], features });
const radial = (overrides = {}) => createFeature('hole', { id: 'radial', name: '测试径向孔', placement: 'radial',
  segmentId: 'outer', position: 60, diameter: 5, termination: 'through-wall', boreId: 'bore', ...overrides });
const valid = (model) => assert.deepEqual(validateModel(model).errors, []);
const invalid = (model, pattern) => assert.match(validateModel(model).errors.join('\n'), pattern);

test('v1 显式升级保留全部旧参数和 id；导入 v1 本身不偷偷升级', () => {
  assert.equal(SCHEMA_VERSION, 2);
  for (const preset of PRESETS) {
    const source = structuredClone(preset.model), before = structuredClone(source);
    const normalized = normalizeModel(source), upgraded = upgradeModel(source);
    assert.equal(normalized.schemaVersion, 1);
    assert.equal(upgraded.schemaVersion, 2);
    assert.equal(upgraded.partFamily, 'shaft');
    assert.deepEqual(upgraded.features, []);
    for (const key of ['segments', 'keyways', 'holes']) assert.deepEqual(upgraded[key], source[key]);
    assert.deepEqual(source, before);
    valid(upgraded);
  }
  const incomplete = modelOf(); delete incomplete.features;
  invalid(incomplete, /features.*数组/);
  const badFamily = modelOf(); badFamily.partFamily = 'box';
  invalid(badFamily, /零件类型/);
});

test('法兰盘、独立内阶梯套和杯壳模板均为完整合法 v2 工程', () => {
  assert.deepEqual(ROTATIONAL_PRESETS.map((p) => p.model.partFamily), ['disk', 'sleeve', 'housing']);
  for (const preset of ROTATIONAL_PRESETS) {
    valid(preset.model);
    assert.deepEqual(normalizeModel(preset.model), preset.model);
  }
  assert.match(validateModel(ROTATIONAL_PRESETS[2].model).warnings.join('\n'), /未生成真实牙形/);
});

test('左右入口的内锥全局端径正确，贯穿末段保留草稿且只派生剩余长度', () => {
  const segments = [inner({ id: 'i1', length: 20, diameter: 20 }),
    inner({ id: 'i2', type: 'cone', length: 30, diameter: 20, endDiameter: 30 }),
    inner({ id: 'i3', length: 1, diameter: 30 })];
  for (const face of ['left', 'right']) {
    const b = bore({ face, offset: 5, termination: 'through-all', segments }), model = modelOf([b]);
    valid(model);
    const result = getBoreLayout(model, b);
    assert.deepEqual(result.map((s) => s.localStart), [0, 20, 50]);
    assert.deepEqual(result.map((s) => s.length), [20, 30, 45]);
    assert.equal(b.segments[2].length, 1);
    assert.deepEqual(result.map((s) => [s.start, s.end]), face === 'left' ? [[5, 25], [25, 55], [55, 100]] : [[75, 95], [45, 75], [0, 45]]);
    assert.deepEqual([result[1].diameter, result[1].endDiameter], face === 'left' ? [20, 30] : [30, 20]);
  }
});

test('壁厚遍历内外轮廓全部交界与倒角，不能只检查内孔两端', () => {
  const b = bore({ face: 'left', termination: 'through-all', segments: [inner({ diameter: 40 })] });
  const bottleneck = modelOf([b], [outer({ id: 'o1', length: 30 }), outer({ id: 'o2', length: 20, diameter: 30 }), outer({ id: 'o3', length: 50 })]);
  invalid(bottleneck, /壁厚.*X=30/);
  const chamfered = modelOf([bore({ face: 'left', segments: [inner({ diameter: 58 })] })], [outer({ chamferLeft: 2 })]);
  invalid(chamfered, /壁厚.*X=0/);
  const badRemainder = modelOf([bore({ termination: 'through-all', offset: 95, segments: [inner({ id: 'one', length: 10 }), inner({ id: 'two' })] })]);
  invalid(badRemainder, /派生长度|轴向范围/);
});

test('新特征只可引用上游启用内腔，重复 id 和非有限隐藏草稿均被拒绝', () => {
  invalid(modelOf([radial(), bore()]), /上游启用内腔/);
  invalid(modelOf([bore({ enabled: false }), radial()]), /上游启用内腔/);
  invalid(modelOf([bore(), radial({ id: 'inner' })]), /重复 id/);
  const invalidDraft = modelOf([bore({ termination: 'through-all', segments: [inner({ length: NaN })] })]);
  invalid(invalidDraft, /长度草稿必须是有限数字/);
  const finiteDraft = modelOf([bore({ termination: 'through-all', segments: [inner({ length: -100 })] })]);
  valid(finiteDraft);
  const hidden = radial({ enabled: false, thread: { nominal: Infinity } });
  invalid(modelOf([hidden]), /公称直径必须是有限数字/);
  for (const malformed of [null, 7, [], { id: 'malformed', name: '损坏特征', enabled: true, type: 'bore', segments: [null] }]) {
    assert.doesNotThrow(() => validateModel(modelOf([malformed])));
    assert.ok(validateModel(modelOf([malformed])).errors.length);
  }
});

test('穿当前壁与贯穿全部保持不同终止范围，孔截面不能跨内阶梯或倒角', () => {
  const model = modelOf([bore(), radial()]), h = model.features[1];
  valid(model);
  const near = resolveRadialHole(model, h);
  assert.equal(near.outerRadius, 30); assert.equal(near.innerRadius, 20);
  assert.equal(near.wallThickness, 10); assert.equal(near.effectiveDepth, 30);
  assert.equal(resolveRadialHole(model, { ...h, termination: 'through-all' }).effectiveDepth, 60);
  const crossStep = modelOf([bore(), radial({ position: 31 })]);
  invalid(crossStep, /整个孔截面.*同一内圆柱/);
  invalid(modelOf([bore(), radial({ position: 3 })], [outer({ chamferLeft: 1 })]), /非倒角区间/);
  invalid(modelOf([bore(), radial({ diameter: 42 })]), /目标内腔半径/);
  invalid(modelOf([bore(), radial({ placement: 'end' })]), /穿当前壁只支持径向孔/);
  const dimensions = getFeatureDimensions(model, h);
  assert.equal(dimensions.some((d) => d.key === 'depth'), false);
  const wall = dimensions.find((d) => d.key === 'wallThickness');
  assert.equal(wall.value, 10); assert.equal(wall.editable, false);
});

test('径向螺纹避开入口弓高、沉孔与空腔，不能把背壁合计为有效牙长', () => {
  const h = radial({ thread: { enabled: true, nominal: 6, pitch: 1, offset: 0.2, length: 8 } });
  valid(modelOf([bore(), h]));
  invalid(modelOf([bore(), radial({ thread: { enabled: true, offset: 0, length: 8 } })]), /螺纹起始偏移/);
  invalid(modelOf([bore(), radial({ termination: 'through-all', thread: { enabled: true, offset: 0.2, length: 12 } })]), /连续壁厚/);
  invalid(modelOf([bore(), radial({ counterboreDiameter: 8, counterboreDepth: 2, thread: { enabled: true, offset: 1, length: 5 } })]), /螺纹起始偏移/);
  invalid(modelOf([radial({ termination: 'blind', diameter: 10, depth: 0.1 })]), /完整孔径/);
  const full = radial({ termination: 'through-all', thread: { enabled: true, offset: 0.2, length: 59.7 } });
  invalid(modelOf([full]), /有效螺纹长度/);
});

test('内环槽与最终后续去料都重新约束螺纹有效长度', () => {
  const h = radial({ thread: { enabled: true, offset: 0.2, length: 8 } });
  const groove = createFeature('groove', { id: 'inner-groove', location: 'inner', boreId: 'bore', boreSegmentId: 'inner', position: 25, width: 10, depth: 3 });
  invalid(modelOf([bore(), groove, h]), /有效螺纹长度/);
  invalid(modelOf([bore(), h, groove]), /后续内腔或内环槽/);
  const cross = radial({ id: 'later-hole', diameter: 8, angle: 0, position: 60 });
  invalid(modelOf([bore(), h, cross]), /最终螺纹包络.*later-hole/);
  const ordinary = modelOf([bore(), radial(), cross]);
  valid(ordinary);
});

test('内外槽组合双向校验剩余壁厚，内键槽外角也计入包络', () => {
  const innerGroove = createFeature('groove', { id: 'inside', location: 'inner', boreId: 'bore', boreSegmentId: 'inner', position: 20, width: 10, depth: 6 });
  const outerGroove = createFeature('groove', { id: 'outside', segmentId: 'outer', position: 50, width: 10, depth: 5 });
  invalid(modelOf([bore(), innerGroove, outerGroove]), /切穿内腔|壁厚/);
  invalid(modelOf([bore(), outerGroove, innerGroove]), /外环槽.*切穿壁厚/);
  const key = createFeature('internal-keyway', { id: 'key', boreId: 'bore', boreSegmentId: 'inner', position: 10, length: 20, width: 18, depth: 9 });
  invalid(modelOf([bore(), key]), /槽底及外角剩余壁厚/);
  const validKey = { ...key, width: 6, depth: 2 }; valid(modelOf([bore(), validKey]));
  assert.equal(getBoreLayout(modelOf([bore()]), bore())[0].start, 30);
});

test('相通盲腔明确提示封底语义，多个内腔时不提供误导性底厚驱动', () => {
  const left = bore({ id: 'left-bore', face: 'left', segments: [inner({ id: 'left-inner', length: 60 })] });
  const right = bore({ id: 'right-bore', segments: [inner({ id: 'right-inner', length: 50 })] });
  const model = modelOf([left, right]); valid(model);
  assert.match(validateModel(model).warnings.join('\n'), /已经连通.*不代表实际封底/);
  assert.equal(getFeatureDimensions(model, left).some((d) => d.key === 'bottomThickness'), false);
});

test('新孔复杂度与旧孔统一计数，过量阵列在几何前拒绝', () => {
  const features = Array.from({ length: 5 }, (_, i) => radial({ id: `pattern-${i}`, count: 24, diameter: 0.5, position: 50 + i, termination: 'blind', depth: 1 }));
  invalid(modelOf(features), /总数量不能超过96/);
  const tooMany = modelOf(Array.from({ length: 49 }, (_, i) => bore({ id: `b-${i}`, enabled: false, segments: [inner({ id: `i-${i}` })] })));
  invalid(tooMany, /总数不能超过48/);
});
