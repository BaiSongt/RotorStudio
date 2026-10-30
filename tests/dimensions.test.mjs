import test from 'node:test';
import assert from 'node:assert/strict';
import { createSegment, createKeyway, createHole, DEFAULT_MODEL, cloneModel, getSegmentLayout, getModelBounds, validateModel } from '../src/schema.js';
import { getDimensionSpec, applyDimensionEdit } from '../src/dimensions.js';
import { createFeature, createBoreSegment, getBoreLayout, ROTATIONAL_PRESETS } from '../src/features.js';

function modelWith(segments = [createSegment({ id: 's1', name: '试件', length: 100, diameter: 40, endDiameter: 40 })]) {
  return { schemaVersion: 1, name: '尺寸编辑试件', material: 'steel', quality: 'standard', segments, keyways: [], holes: [] };
}

function unchangedAfterFailure(model, target, input, expected) {
  const before = cloneModel(model);
  assert.throws(() => applyDimensionEdit(model, target, input), expected);
  assert.deepEqual(model, before, '被拒绝的修改不得污染原工程');
}

test('尺寸规格区分圆柱、圆锥和齿轮，并提示实际联动方式', () => {
  const model = cloneModel(DEFAULT_MODEL);
  const length = getDimensionSpec(model, { kind: 'segment-length', id: 'shaft-03' });
  assert.equal(length.value, 34);
  assert.equal(length.unit, 'mm');
  assert.equal(length.step, 0.1);
  assert.equal(length.segmentId, 'shaft-03');
  assert.match(length.title, /齿宽/);
  const gear = getDimensionSpec(model, { kind: 'gear-tip-diameter', id: 'shaft-03' });
  assert.equal(gear.value, 52);
  assert.equal(gear.min, 2.6);
  assert.equal(gear.max, 650);
  assert.match(gear.hint, /调整模数/);
  const total = getDimensionSpec(model, { kind: 'total-length' });
  assert.equal(total.value, 180);
  assert.equal(total.min, 146.1);
  assert.equal(total.max, 2146);
  assert.match(total.hint, /只调整末段/);
});

test('修改段长只改该段并移动后续位置，特征尺寸保持原值', () => {
  const model = cloneModel(DEFAULT_MODEL), before = cloneModel(model);
  const next = applyDimensionEdit(model, { kind: 'segment-length', id: 'shaft-02' }, '40.123456789');
  assert.equal(next.segments[1].length, 40.123456789);
  assert.equal(getSegmentLayout(next)[2].start, 68.123456789);
  assert.deepEqual(next.keyways, model.keyways);
  assert.deepEqual(next.holes, model.holes);
  for (const index of [0, 2, 3, 4]) assert.deepEqual(next.segments[index], model.segments[index]);
  assert.deepEqual(model, before);
});

test('圆柱直径与圆锥两端直径独立编辑，不自动改写隐藏草稿', () => {
  const cylinder = modelWith();
  const changed = applyDimensionEdit(cylinder, { kind: 'segment-diameter', id: 's1' }, 45.123456789);
  assert.equal(changed.segments[0].diameter, 45.123456789);
  assert.equal(changed.segments[0].endDiameter, 40);
  const cone = modelWith([createSegment({ id: 'cone', type: 'cone', length: 40, diameter: 40, endDiameter: 30 })]);
  const left = applyDimensionEdit(cone, { kind: 'segment-diameter', id: 'cone' }, '42.005');
  const right = applyDimensionEdit(left, { kind: 'segment-end-diameter', id: 'cone' }, '28.009');
  assert.equal(right.segments[0].diameter, 42.005);
  assert.equal(right.segments[0].endDiameter, 28.009);
  assert.equal(right.segments[0].length, 40);
});

test('编辑齿顶直径仅逆算模数，保持齿数与其余齿轮、键槽和孔参数', () => {
  const model = cloneModel(DEFAULT_MODEL);
  const next = applyDimensionEdit(model, { kind: 'gear-tip-diameter', id: 'shaft-03' }, 65);
  assert.equal(next.segments[2].gear.module, 2.5);
  assert.equal(getSegmentLayout(next)[2].maxDiameter, 65);
  const expected = cloneModel(model); expected.segments[2].gear.module = 2.5;
  assert.deepEqual(next, expected);
  assert.equal(model.segments[2].gear.module, 2);
});

test('合法齿顶直径边界不会因模数除法或直径回乘的浮点误差被拒绝', () => {
  const fractional = modelWith([createSegment({ id: 'g', type: 'gear', gear: { teeth: 12, addendum: 0.4 } })]);
  assert.equal(getDimensionSpec(fractional, { kind: 'gear-tip-diameter', id: 'g' }).min, 1.28);
  assert.equal(applyDimensionEdit(fractional, { kind: 'gear-tip-diameter', id: 'g' }, '1.28').segments[0].gear.module, 0.1);
  const small = modelWith([createSegment({ id: 'g', type: 'gear', gear: { teeth: 18, addendum: 1.3 } })]);
  const min = applyDimensionEdit(small, { kind: 'gear-tip-diameter', id: 'g' }, '2.06');
  assert.equal(min.segments[0].gear.module, 0.1);
  assert.deepEqual(validateModel(min).errors, []);
  const large = modelWith([createSegment({ id: 'g', type: 'gear', gear: { teeth: 120, addendum: 1.5 } })]);
  const max = applyDimensionEdit(large, { kind: 'gear-tip-diameter', id: 'g' }, '2000');
  const diameter = getSegmentLayout(max)[0].maxDiameter;
  assert.ok(diameter <= 2000 && 2000 - diameter < 1e-10);
  assert.deepEqual(validateModel(max).errors, []);
  assert.equal(large.segments[0].gear.module, 2);
});

test('轴向起点仅改变前段长度，当前及后续段保持长度并平移', () => {
  const model = cloneModel(DEFAULT_MODEL);
  const next = applyDimensionEdit(model, { kind: 'segment-start', id: 'shaft-03' }, '67.123456789');
  assert.equal(next.segments[1].length, 39.123456789);
  const layout = getSegmentLayout(next);
  assert.equal(layout[2].start, 67.123456789);
  assert.equal(next.segments[2].length, 34);
  assert.deepEqual(next.keyways, model.keyways);
  assert.deepEqual(next.holes, model.holes);
  assert.equal(next.segments[3].length, model.segments[3].length);
});

test('修改总长只调整末段，不缩放前段和特征', () => {
  const model = cloneModel(DEFAULT_MODEL);
  const next = applyDimensionEdit(model, { kind: 'total-length' }, '196.123456789');
  assert.equal(next.segments[4].length, 50.123456789);
  assert.deepEqual(next.segments.slice(0, 4), model.segments.slice(0, 4));
  assert.deepEqual(next.keyways, model.keyways);
  assert.deepEqual(next.holes, model.holes);
  assert.ok(Math.abs(getModelBounds(next).length - 196.123456789) < 1e-12);
});

test('联动减法保留十进制精度，并接受合法的0.1毫米边界', () => {
  const model = modelWith([
    createSegment({ id: 's1', length: 10.1 }),
    createSegment({ id: 's2', length: 10 }),
    createSegment({ id: 's3', length: 10 }),
  ]);
  const start = applyDimensionEdit(model, { kind: 'segment-start', id: 's3' }, '10.2');
  assert.equal(start.segments[1].length, 0.1);
  assert.deepEqual(validateModel(start).errors, []);
  const total = applyDimensionEdit(model, { kind: 'total-length' }, '20.2');
  assert.equal(total.segments[2].length, 0.1);
  assert.deepEqual(validateModel(total).errors, []);
  const precise = applyDimensionEdit(model, { kind: 'total-length' }, '30.223456789');
  assert.equal(precise.segments[2].length, 10.123456789);
});

test('空值、非有限值和带单位文本全部拒绝，合法十进制文本可输入', () => {
  const model = modelWith(), target = { kind: 'segment-length', id: 's1' };
  for (const value of ['', '   ', NaN, Infinity, -Infinity, 'NaN', 'Infinity', '20 mm', '20mm', '1e2', '0x20', '1,000', '1_000', '1+2', null, undefined, true, {}]) {
    unchangedAfterFailure(model, target, value, /尺寸|数值|数字|十进制/);
  }
  for (const value of [' 25.125 ', '+25.125', '025.125']) assert.equal(applyDimensionEdit(model, target, value).segments[0].length, 25.125);
  assert.equal(applyDimensionEdit(model, target, '.5').segments[0].length, 0.5);
});

test('不存在、类型不匹配、未知标注和固定原点不能编辑', () => {
  const model = modelWith();
  for (const target of [{ kind: 'segment-length', id: 'missing' }, { kind: 'unknown', id: 's1' }, { kind: 'segment-start', id: 's1' }, { kind: 'gear-tip-diameter', id: 's1' }, { kind: 'segment-end-diameter', id: 's1' }, null]) {
    unchangedAfterFailure(model, target, 20, /尺寸|阶梯|起点|齿轮|圆锥|标注/);
  }
  const gear = cloneModel(DEFAULT_MODEL);
  unchangedAfterFailure(gear, { kind: 'segment-diameter', id: 'shaft-03' }, 60, /齿顶直径/);
});

test('缩短带键槽段或其前方起点联动时，越界拒绝并保持原状态', () => {
  const model = cloneModel(DEFAULT_MODEL);
  unchangedAfterFailure(model, { kind: 'segment-length', id: 'shaft-04' }, 30, /键槽.*超出/);
  unchangedAfterFailure(model, { kind: 'segment-start', id: 'shaft-05' }, 124, /键槽.*超出/);
  const withLastKey = modelWith();
  withLastKey.keyways.push(createKeyway('s1', { position: 70, length: 20, width: 8, depth: 3 }));
  unchangedAfterFailure(withLastKey, { kind: 'total-length' }, 80, /键槽.*超出/);
});

test('直径缩小导致倒角、键槽或端孔越界时拒绝，不缩放特征', () => {
  const chamfer = modelWith([createSegment({ id: 's1', length: 50, diameter: 20, endDiameter: 20, chamferLeft: 3 })]);
  unchangedAfterFailure(chamfer, { kind: 'segment-diameter', id: 's1' }, 5, /倒角/);
  const key = modelWith();
  key.keyways.push(createKeyway('s1', { width: 8, depth: 3 }));
  unchangedAfterFailure(key, { kind: 'segment-diameter', id: 's1' }, 5, /键槽/);
  const hole = modelWith();
  hole.holes.push(createHole({ diameter: 18, depth: 20 }));
  unchangedAfterFailure(hole, { kind: 'segment-diameter', id: 's1' }, 16, /孔组.*半径/);
});

test('编辑长度检查倒角相交、盲孔深度与全局规模限制', () => {
  const chamfer = modelWith([createSegment({ id: 's1', length: 50, diameter: 20, endDiameter: 20, chamferLeft: 3, chamferRight: 3 })]);
  unchangedAfterFailure(chamfer, { kind: 'segment-length', id: 's1' }, 5, /倒角.*重叠/);
  const hole = modelWith(); hole.holes.push(createHole({ depth: 80 }));
  unchangedAfterFailure(hole, { kind: 'total-length' }, 70, /盲孔深度/);
  unchangedAfterFailure(modelWith(), { kind: 'segment-length', id: 's1' }, 2001, /必须在/);
  unchangedAfterFailure(modelWith(), { kind: 'segment-diameter', id: 's1' }, 2001, /必须在/);
  const long = modelWith(Array.from({ length: 5 }, (_, i) => createSegment({ id: `s${i}`, length: 2000 })));
  assert.equal(getDimensionSpec(long, { kind: 'segment-length', id: 's0' }).max, 2000);
  assert.equal(getDimensionSpec(long, { kind: 'total-length' }).max, 10000);
  unchangedAfterFailure(long, { kind: 'total-length' }, 10000.1, /必须在/);
});

function cavityModel() {
  const model = modelWith([createSegment({ id: 's1', name: '杯形外圆', length: 100, diameter: 60, endDiameter: 60 })]);
  return { ...model, schemaVersion: 2, partFamily: 'housing', features: [createFeature('bore', {
    id: 'bore', name: '盲腔', face: 'right', segments: [
      createBoreSegment({ id: 'inner-first', name: '入口内圆', length: 20, diameter: 40, endDiameter: 40 }),
      createBoreSegment({ id: 'inner-last', name: '末内圆', length: 40, diameter: 30, endDiameter: 30 }),
    ],
  })] };
}
const ft = (key, subId, id = 'bore') => ({ kind: 'feature-parameter', id, key, ...(subId ? { subId } : {}) });

test('内阶梯尺寸驱动保持外轮廓独立，精确保存输入且不改隐藏末端草稿', () => {
  const model = cavityModel(), before = cloneModel(model);
  const spec = getDimensionSpec(model, ft('diameter', 'inner-last'));
  assert.equal(spec.featureId, 'bore'); assert.equal(spec.subId, 'inner-last'); assert.equal(spec.unit, 'mm');
  const next = applyDimensionEdit(model, ft('diameter', 'inner-last'), '31.123456789');
  assert.equal(next.features[0].segments[1].diameter, 31.123456789);
  assert.equal(next.features[0].segments[1].endDiameter, 30);
  assert.deepEqual(next.segments, model.segments);
  assert.deepEqual(model, before);
  const longer = applyDimensionEdit(next, ft('length', 'inner-first'), '24.123456789');
  assert.equal(longer.features[0].segments[0].length, 24.123456789);
  assert.equal(longer.features[0].segments[1].length, 40);
  assert.deepEqual(longer.segments, model.segments);
});

test('壁厚固定外径只逆算当前内径，底厚固定外形只改最后内段长度', () => {
  const model = cavityModel();
  const wall = applyDimensionEdit(model, ft('wallThickness', 'inner-first'), '12.123456789');
  assert.equal(wall.features[0].segments[0].diameter, 35.753086422);
  assert.deepEqual(wall.segments, model.segments);
  assert.equal(wall.features[0].segments[0].endDiameter, 40);
  const bottom = applyDimensionEdit(model, ft('bottomThickness'), '30.123456789');
  assert.equal(bottom.features[0].segments[1].length, 49.876543211);
  assert.deepEqual(bottom.features[0].segments[0], model.features[0].segments[0]);
  assert.deepEqual(bottom.segments, model.segments);
  unchangedAfterFailure(model, ft('diameter', 'inner-first'), 61, /壁厚/);
  unchangedAfterFailure(model, ft('bottomThickness'), 0, /必须在/);
});

test('贯穿末段长度与径向穿壁厚度是只读尺寸，入口偏移与外总长仍联动派生', () => {
  const model = cavityModel(); model.features[0].termination = 'through-all';
  unchangedAfterFailure(model, ft('length', 'inner-last'), 30, /贯穿内腔.*不能独立编辑/);
  const next = applyDimensionEdit(model, ft('offset'), 5);
  assert.equal(getBoreLayout(next, next.features[0]).at(-1).length, 75);
  assert.equal(next.features[0].segments[1].length, 40);
  const total = applyDimensionEdit(next, { kind: 'total-length' }, 110);
  assert.equal(getBoreLayout(total, total.features[0]).at(-1).length, 85);
  assert.equal(total.features[0].segments[1].length, 40);
  const cup = cloneModel(ROTATIONAL_PRESETS.find((p) => p.id === 'cup-housing').model);
  unchangedAfterFailure(cup, ft('wallThickness', undefined, 'cup-radial'), 11, /派生|近侧壁/);
  unchangedAfterFailure(cup, ft('depth', undefined, 'cup-radial'), 11, /未找到.*尺寸/);
});

test('内腔修改导致已有内槽或穿壁孔超界会拒绝，状态与关联尺寸完全不变', () => {
  const model = cavityModel();
  model.features.push(createFeature('internal-keyway', { id: 'key', boreId: 'bore', boreSegmentId: 'inner-last', position: 20, length: 15, width: 6, depth: 2 }));
  unchangedAfterFailure(model, ft('length', 'inner-last'), 25, /轴向范围超出/);
  const cup = cloneModel(ROTATIONAL_PRESETS.find((p) => p.id === 'cup-housing').model);
  unchangedAfterFailure(cup, ft('position', undefined, 'cup-radial'), 10, /同一内圆柱/);
  unchangedAfterFailure(cup, ft('diameter', 'cup-inner', 'cup-cavity'), 76, /有效螺纹长度|连续壁厚/);
});

test('特征角度、孔阵列数量与螺纹语义尺寸按各自单位编辑并严格校验', () => {
  const model = cloneModel(ROTATIONAL_PRESETS.find((p) => p.id === 'cup-housing').model);
  const angleTarget = ft('angle', undefined, 'cup-radial');
  assert.equal(getDimensionSpec(model, angleTarget).unit, '°');
  const next = applyDimensionEdit(model, angleTarget, '37.123456789');
  assert.equal(next.features[1].angle, 37.123456789);
  const thread = applyDimensionEdit(next, ft('thread.length', undefined, 'cup-radial'), 5.25);
  assert.equal(thread.features[1].thread.length, 5.25);
  assert.equal(thread.features[1].diameter, model.features[1].diameter);
  unchangedAfterFailure(model, ft('count', undefined, 'cup-radial'), 1.5, /整数/);
  unchangedAfterFailure(model, ft('thread.offset', undefined, 'cup-radial'), 0, /螺纹起始偏移/);
});

test('特征尺寸目标只接受白名单，输入攻击与失效引用不得污染工程', () => {
  const model = cavityModel();
  for (const key of ['__proto__', 'constructor', 'enabled', 'type', 'segments', 'thread.__proto__']) {
    unchangedAfterFailure(model, ft(key), 20, /未找到.*尺寸/);
  }
  for (const value of ['', '20 mm', '1e2', Infinity, NaN, { valueOf: () => 10 }]) {
    unchangedAfterFailure(model, ft('diameter', 'inner-first'), value, /尺寸|十进制|有限|数字/);
  }
  unchangedAfterFailure(model, ft('diameter', 'missing'), 20, /未找到.*尺寸/);
  unchangedAfterFailure(model, ft('diameter', 'inner-first', 'gone'), 20, /已不存在/);
});
