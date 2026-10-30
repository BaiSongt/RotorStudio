import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_MODEL, PRESETS, createSegment, createKeyway, createHole,
  cloneModel, getSegmentLayout, getModelBounds, validateModel, normalizeModel,
  segmentRadiusAt, minSegmentRadius, getChamferRun, getKeywayAxialLength,
} from '../src/schema.js';

function simpleModel(segment = {}) {
  return {
    schemaVersion: 1, name: '校验试件', material: 'steel', quality: 'standard',
    segments: [createSegment({ id: 's1', length: 100, diameter: 40, endDiameter: 40, ...segment })],
    keyways: [], holes: [],
  };
}

function expectError(model, pattern) {
  const result = validateModel(model);
  assert.ok(result.errors.some((message) => pattern.test(message)), `未找到 ${pattern}，实际：${result.errors.join(';')}`);
}

test('四个预置工程全部合法，默认模型保持180毫米与52毫米齿顶径', () => {
  for (const preset of PRESETS) assert.deepEqual(validateModel(preset.model).errors, [], preset.name);
  assert.deepEqual(getModelBounds(DEFAULT_MODEL), { length: 180, maxDiameter: 52 });
  const layout = getSegmentLayout(DEFAULT_MODEL);
  assert.deepEqual(layout.map((s) => [s.start, s.end]), [[0, 28], [28, 60], [60, 94], [94, 146], [146, 180]]);
  assert.equal(layout[2].rootDiameter, 43);
});

test('改变阶梯长度后起终点与后续阶梯位置联动，输入保持不变', () => {
  const model = cloneModel(DEFAULT_MODEL);
  model.segments[1].length = 40;
  const layout = getSegmentLayout(model);
  assert.equal(layout[2].start, 68);
  assert.equal(layout.at(-1).end, 188);
  assert.equal(DEFAULT_MODEL.segments[1].length, 32);
  assert.equal(model.segments[2].start, undefined);
});

test('齿轮节圆、齿根和齿顶派生尺寸由模数齿数控制', () => {
  const model = simpleModel({ type: 'gear', gear: { teeth: 30, module: 3 } });
  const segment = getSegmentLayout(model)[0];
  assert.equal(segment.maxDiameter, 96);
  assert.equal(segment.rootDiameter, 82.5);
  assert.deepEqual(validateModel(model).errors, []);
  assert.equal(segmentRadiusAt(segment, 50), 41.25);
});

test('严格拒绝非有限数、数字字符串、错误版本和重复标识', () => {
  for (const invalid of [NaN, Infinity, -Infinity, '40', null]) {
    const model = simpleModel(); model.segments[0].diameter = invalid;
    expectError(model, /有限数字/);
  }
  const model = simpleModel(); model.schemaVersion = 2;
  expectError(model, /工程版本/);
  const duplicate = simpleModel(); duplicate.segments.push(createSegment({ id: 's1' }));
  expectError(duplicate, /重复 id/);
});

test('不可信文件结构给出诊断而不抛出内部异常', () => {
  for (const value of [null, undefined, [], 42, '', {}, { segments: [] }]) {
    assert.doesNotThrow(() => validateModel(value));
    assert.ok(validateModel(value).errors.length);
  }
  const model = simpleModel(); model.segments[0].gear = null;
  expectError(model, /齿轮参数/);
});

test('导入往返保持全部尺寸与附加元数据，不自动修复非法值', () => {
  const model = cloneModel(DEFAULT_MODEL); model.notes = { author: '工程师' };
  const imported = normalizeModel(JSON.parse(JSON.stringify(model)));
  assert.deepEqual(imported, model);
  imported.segments[0].length = 42;
  assert.equal(model.segments[0].length, 28);
  const invalid = cloneModel(model); invalid.segments[0].length = -10;
  assert.throws(() => normalizeModel(invalid), /长度/);
});

test('圆柱保留超范围的隐藏齿轮和锥端草稿，切换类型后重新校验且不静默改值', () => {
  const model = simpleModel({ endDiameter: -5, gear: { pressureAngle: 5, teeth: 10000 } });
  assert.deepEqual(validateModel(model).errors, []);
  assert.deepEqual(normalizeModel(model), model);
  assert.equal(model.segments[0].endDiameter, -5);
  assert.equal(model.segments[0].gear.pressureAngle, 5);
  assert.equal(model.segments[0].gear.teeth, 10000);
  model.segments[0].type = 'cone';
  expectError(model, /右端直径必须在/);
  model.segments[0].type = 'gear';
  expectError(model, /压力角必须在/);
  expectError(model, /齿数必须在/);
  const gear = simpleModel({ type: 'gear', diameter: -2, endDiameter: -5 });
  assert.deepEqual(validateModel(gear).errors, []);
  gear.segments[0].type = 'cylinder';
  expectError(gear, /直径必须在/);
});

test('隐藏参数依然拒绝非有限数字、非数字和非整数齿数', () => {
  for (const invalid of [NaN, Infinity, -Infinity, '5', null]) {
    const model = simpleModel();
    model.segments[0].gear.pressureAngle = invalid;
    expectError(model, /压力角必须是有限数字/);
    model.segments[0].gear.pressureAngle = 20;
    model.segments[0].endDiameter = invalid;
    expectError(model, /右端直径必须是有限数字/);
  }
  expectError(simpleModel({ gear: { teeth: 12.5 } }), /齿数必须为整数/);
  const budget = simpleModel({ type: 'gear', length: 10, gear: { teeth: 120 } });
  budget.segments = Array.from({ length: 7 }, (_, i) => createSegment({ id: `g${i}`, type: 'gear', length: 10, gear: { teeth: 120 } }));
  expectError(budget, /齿数合计不能超过720/);
  for (const segment of budget.segments) segment.type = 'cylinder';
  assert.deepEqual(validateModel(budget).errors, []);
});

test('圆柱倒角与圆锥倒角的实际45度截面具有正确半径', () => {
  const cylinder = createSegment({ length: 20, diameter: 40, endDiameter: 40, chamferLeft: 2, chamferRight: 3 });
  assert.deepEqual(getChamferRun(cylinder), { left: 2, right: 3 });
  assert.equal(segmentRadiusAt(cylinder, 0), 18);
  assert.equal(segmentRadiusAt(cylinder, 1), 19);
  assert.equal(segmentRadiusAt(cylinder, 10), 20);
  assert.equal(segmentRadiusAt(cylinder, 20), 17);
  assert.equal(minSegmentRadius(cylinder), 17);
  const cone = createSegment({ type: 'cone', length: 20, diameter: 20, endDiameter: 30, chamferLeft: 1, chamferRight: 1 });
  const run = getChamferRun(cone);
  assert.ok(Math.abs(run.left - 4 / 3) < 1e-12);
  assert.ok(Math.abs(run.right - 0.8) < 1e-12);
  assert.equal(segmentRadiusAt(cone, 0), 9);
  assert.equal(segmentRadiusAt(cone, 20), 14);
});

test('倒角拒绝重叠、穿过轴心、陡锥以及齿轮倒角', () => {
  expectError(simpleModel({ length: 4, chamferLeft: 2, chamferRight: 2 }), /相互重叠/);
  expectError(simpleModel({ diameter: 4, endDiameter: 4, chamferLeft: 2 }), /允许半径/);
  expectError(simpleModel({ type: 'cone', length: 10, diameter: 10, endDiameter: 50, chamferLeft: 1 }), /斜率/);
  expectError(simpleModel({ type: 'gear', chamferLeft: 1 }), /齿轮段暂不支持/);
});

test('齿轮的尖齿与根切分别作为错误与风险提示', () => {
  expectError(simpleModel({ type: 'gear', gear: { backlash: 10 } }), /齿顶已变尖|齿厚/);
  const model = simpleModel({ type: 'gear', gear: { teeth: 12, pressureAngle: 20 } });
  const result = validateModel(model);
  assert.deepEqual(result.errors, []);
  assert.ok(result.warnings.some((message) => /根切/.test(message)));
});

test('高压力角深齿根在进入内核前拒绝相交，相同齿数的浅齿根保持合法', () => {
  const model = simpleModel({ type: 'gear', gear: { teeth: 18, module: 2, pressureAngle: 35, dedendum: 2 } });
  expectError(model, /齿根侧边相交/);
  assert.throws(() => normalizeModel(model), /齿根侧边相交/);
  model.segments[0].gear.dedendum = 1.25;
  assert.deepEqual(validateModel(model).errors, []);
});

test('键槽必须位于当前段内，圆头总长不能小于宽度', () => {
  const model = simpleModel();
  model.keyways = [createKeyway('s1', { position: 90, length: 20 })];
  expectError(model, /超出/);
  model.keyways[0] = createKeyway('s1', { length: 5, width: 8 });
  expectError(model, /总长度不能小于槽宽/);
  model.keyways[0] = createKeyway('missing');
  expectError(model, /引用的阶梯不存在/);
});

test('键槽拒绝穿心与不能形成完整槽宽的浅槽', () => {
  const model = simpleModel();
  model.keyways = [createKeyway('s1', { depth: 20 })];
  expectError(model, /穿越轴心/);
  model.keyways[0] = createKeyway('s1', { width: 20, depth: 0.2 });
  expectError(model, /完整槽宽/);
  model.keyways[0] = createKeyway('s1', { width: 8, depth: 3 });
  assert.deepEqual(validateModel(model).errors, []);
});

test('五种键槽共用轴向长度接口，半圆键槽长度只由刀径和深度派生', () => {
  for (const ends of ['round', 'square', 'round-left', 'round-right']) {
    const key = createKeyway('s1', { ends, length: 25 });
    assert.equal(getKeywayAxialLength(key), 25);
    const model = simpleModel(); model.keyways = [key];
    assert.deepEqual(validateModel(model).errors, []);
  }
  const key = createKeyway('s1', { ends: 'woodruff', cutterDiameter: 24, depth: 3, length: 1000 });
  assert.equal(getKeywayAxialLength(key), 2 * Math.sqrt(63));
  key.length = -7;
  assert.equal(getKeywayAxialLength(key), 2 * Math.sqrt(63));
  const model = simpleModel(); model.keyways = [key];
  assert.deepEqual(validateModel(model).errors, []);
  key.ends = 'square';
  expectError(model, /长度必须在/);
  assert.ok(Number.isNaN(getKeywayAxialLength({ ends: 'woodruff', cutterDiameter: 10, depth: 11 })));
  assert.ok(Number.isNaN(getKeywayAxialLength({ ends: 'woodruff', cutterDiameter: Infinity, depth: 3 })));
});

test('旧版键槽工程只补缺失刀径，保留类型、尺寸和附加字段且不修改输入', () => {
  for (const ends of ['round', 'square']) {
    const model = simpleModel();
    model.keyways = [createKeyway('s1', { ends, length: 26, notes: '旧版参数' })];
    delete model.keyways[0].cutterDiameter;
    assert.deepEqual(validateModel(model).errors, []);
    const imported = normalizeModel(model);
    assert.equal(model.keyways[0].cutterDiameter, undefined);
    assert.equal(imported.keyways[0].cutterDiameter, 24);
    assert.equal(imported.keyways[0].ends, ends);
    assert.equal(imported.keyways[0].length, 26);
    assert.equal(imported.keyways[0].notes, '旧版参数');
    assert.equal(imported.schemaVersion, 1);
  }
  const model = simpleModel();
  model.keyways = [createKeyway('s1', { cutterDiameter: -3 })];
  assert.equal(normalizeModel(model).keyways[0].cutterDiameter, -3);
  model.keyways[0].ends = 'woodruff';
  expectError(model, /圆盘刀直径必须在/);
  for (const value of [null, '24', NaN, Infinity, undefined]) {
    model.keyways[0].ends = 'round';
    model.keyways[0].cutterDiameter = value;
    assert.throws(() => normalizeModel(model), /圆盘刀直径草稿必须是有限数字/);
  }
});

test('单圆头槽允许半槽宽边界，并拒绝更短的自相交轮廓', () => {
  for (const ends of ['round-left', 'round-right']) {
    const model = simpleModel();
    model.keyways = [createKeyway('s1', { ends, length: 4, width: 8 })];
    assert.deepEqual(validateModel(model).errors, []);
    model.keyways[0].length = 3.99;
    expectError(model, /单圆头槽的总长度不能小于槽宽的一半/);
  }
});

test('半圆键槽只支持圆柱，深度同时受圆盘半径、轴半径和完整槽宽约束', () => {
  for (const type of ['cone', 'gear']) {
    const model = simpleModel({ type });
    model.keyways = [createKeyway('s1', { ends: 'woodruff' })];
    expectError(model, /半圆键槽仅支持圆柱段/);
  }
  const model = simpleModel();
  model.keyways = [createKeyway('s1', { ends: 'woodruff', cutterDiameter: 24, depth: 12 })];
  expectError(model, /深度必须小于圆盘刀半径/);
  model.keyways[0].depth = 11.99;
  assert.deepEqual(validateModel(model).errors, []);
  model.keyways[0] = createKeyway('s1', { ends: 'woodruff', cutterDiameter: 60, depth: 20 });
  expectError(model, /穿越轴心/);
  model.keyways[0] = createKeyway('s1', { ends: 'woodruff', cutterDiameter: 24, width: 20, depth: 0.2 });
  expectError(model, /完整槽宽/);
  model.keyways[0].depth = 3;
  assert.deepEqual(validateModel(model).errors, []);
});

test('半圆键槽按派生长度检查阶梯边界与倒角，不使用隐藏长度草稿', () => {
  const model = simpleModel({ chamferRight: 2 });
  model.keyways = [createKeyway('s1', { ends: 'woodruff', position: 90, length: 1, cutterDiameter: 24, depth: 3 })];
  expectError(model, /超出所属阶梯长度/);
  model.keyways[0].cutterDiameter = 8;
  model.keyways[0].length = 5000;
  assert.deepEqual(validateModel(model).errors, []);
  model.keyways[0].position = 92;
  const result = validateModel(model);
  assert.deepEqual(result.errors, []);
  assert.ok(result.warnings.some((message) => /与端部倒角相交/.test(message)));
});

test('半圆键槽与端面孔的相交通知使用真实派生轴向范围', () => {
  const model = simpleModel();
  model.keyways = [createKeyway('s1', { ends: 'woodruff', position: 10, length: 1, cutterDiameter: 40, depth: 8 })];
  model.holes = [createHole({ face: 'right', depth: 70, diameter: 26 })];
  let result = validateModel(model);
  assert.deepEqual(result.errors, []);
  assert.ok(result.warnings.some((message) => /可能相通/.test(message)));
  model.keyways[0] = createKeyway('s1', { ends: 'woodruff', position: 10, length: 80, cutterDiameter: 8, depth: 3 });
  model.holes[0].diameter = 36;
  result = validateModel(model);
  assert.deepEqual(result.errors, []);
  assert.ok(!result.warnings.some((message) => /可能相通/.test(message)));
});

test('孔阵列拒绝孔间重叠与超出端面', () => {
  const model = simpleModel();
  model.holes = [createHole({ count: 6, pcd: 10, diameter: 8 })];
  expectError(model, /相邻孔/);
  model.holes[0] = createHole({ count: 4, pcd: 36, diameter: 8 });
  expectError(model, /超出钻孔路径/);
  model.holes[0] = createHole({ count: 4, pcd: 24, diameter: 5 });
  assert.deepEqual(validateModel(model).errors, []);
});

test('贯通孔校验整个轴的最小半径，盲孔只检查实际钻孔区间', () => {
  const model = simpleModel({ length: 20, diameter: 20, endDiameter: 20 });
  model.segments.push(createSegment({ id: 's2', length: 20, diameter: 60, endDiameter: 60 }));
  model.holes = [createHole({ face: 'right', pcd: 40, diameter: 5, depth: 10, count: 4 })];
  assert.deepEqual(validateModel(model).errors, []);
  model.holes[0].through = true;
  expectError(model, /超出钻孔路径/);
  model.holes[0] = createHole({ face: 'left', diameter: 18, depth: 10 });
  model.segments[0].chamferLeft = 2;
  expectError(model, /超出钻孔路径/);
});

test('沉孔同时约束直径、深度以及阵列间距', () => {
  const model = simpleModel();
  model.holes = [createHole({ diameter: 8, counterboreDiameter: 6, counterboreDepth: 2 })];
  expectError(model, /沉孔直径必须大于/);
  model.holes[0] = createHole({ diameter: 8, depth: 10, counterboreDiameter: 12, counterboreDepth: 10 });
  expectError(model, /沉孔深度必须小于/);
  model.holes[0] = createHole({ diameter: 5, count: 6, pcd: 20, counterboreDiameter: 11, counterboreDepth: 2 });
  expectError(model, /相邻孔或沉孔重叠/);
});

test('重复孔组被拒绝，来自两端的相交孔给出连通提示', () => {
  const model = simpleModel();
  model.holes = [createHole({ id: 'h1', depth: 60 }), createHole({ id: 'h2', depth: 60 })];
  expectError(model, /重复孔/);
  model.holes[1].face = 'left';
  const result = validateModel(model);
  assert.deepEqual(result.errors, []);
  assert.ok(result.warnings.some((message) => /孔腔会连通/.test(message)));
});

test('输入规模限制在内核执行之前生效', () => {
  const model = simpleModel();
  model.segments = Array.from({ length: 25 }, (_, i) => createSegment({ id: `s${i}` }));
  expectError(model, /阶梯数量/);
  model.segments = [createSegment({ id: 's1' })];
  model.holes = [createHole({ count: 1000000 })];
  expectError(model, /数量必须在1～24/);
});
