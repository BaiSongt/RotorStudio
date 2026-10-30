import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { setOC, importSTEP, measureShapeVolumeProperties, iterTopo } from 'replicad';
import { buildModel, exportModel } from '../src/cad.js';
import { createSegment, createKeyway, createHole, PRESETS } from '../src/schema.js';

// 上游 WASM 加载器包含 CommonJS 环境分支；在 Node 中显式提供其所需环境。
const require = createRequire(import.meta.url);
const loaderPath = require.resolve('replicad-opencascadejs/src/replicad_single.js');
const loaderText = readFileSync(loaderPath, 'utf8').replace(/export default Module;\s*$/, 'return Module;');
const initOC = new Function('require', '__dirname', '__filename', loaderText)(require, path.dirname(loaderPath), loaderPath);
const oc = await initOC({
  wasmBinary: readFileSync(path.join(path.dirname(loaderPath), 'replicad_single.wasm')),
  print: () => {}, printErr: () => {},
});
setOC(oc);

const plainModel = (segments, overrides = {}) => ({
  schemaVersion: 1, name: '验证零件', material: 'steel', quality: 'standard',
  segments, keyways: [], holes: [], ...overrides,
});
const cylinder = (overrides = {}) => createSegment({ id: 's1', name: '验证圆柱', length: 60, diameter: 40, endDiameter: 40, ...overrides });
const near = (actual, expected, relative = 1e-7) => assert.ok(
  Math.abs(actual - expected) <= relative * Math.max(Math.abs(expected), 1),
  `实际值 ${actual} 应接近期望值 ${expected}`,
);
function verifyMesh(result) {
  assert.equal(result.stats.solids, 1);
  assert.ok(result.mesh.triangles.length > 0);
  assert.equal(result.mesh.normals.length, result.mesh.vertices.length);
  assert.ok(result.mesh.vertices.every(Number.isFinite));
  assert.ok(result.mesh.normals.every(Number.isFinite));
  assert.ok(result.mesh.triangles.every(i => Number.isInteger(i) && i >= 0 && i < result.mesh.vertices.length / 3));
  assert.equal(result.edges.lines.length % 6, 0);
  const xs = result.mesh.vertices.filter((_, index) => index % 3 === 0);
  near(Math.min(...xs), 0);
  near(Math.max(...xs), result.stats.length);
}

test('精确圆柱体积、表面积和 X 轴范围符合解析结果', () => {
  const result = buildModel(plainModel([cylinder()]));
  try {
    near(result.stats.volume, Math.PI * 20 ** 2 * 60);
    near(result.stats.area, 2 * Math.PI * 20 * (60 + 20));
    verifyMesh(result);
  } finally { result.shape.delete(); }
});

test('阶梯融合为单个连续实体，圆锥体积符合解析结果', () => {
  const result = buildModel(plainModel([
    cylinder({ length: 30 }),
    cylinder({ id: 's2', type: 'cone', length: 20, diameter: 40, endDiameter: 20 }),
    cylinder({ id: 's3', length: 15, diameter: 20, endDiameter: 20 }),
  ]));
  try {
    near(result.stats.volume, Math.PI * (400 * 30 + 20 / 3 * (400 + 200 + 100) + 100 * 15));
    verifyMesh(result);
  } finally { result.shape.delete(); }
});

test('左右 45° 倒角真实去料，体积符合解析结果', () => {
  const result = buildModel(plainModel([cylinder({ chamferLeft: 2, chamferRight: 1 })]));
  try {
    const removed = Math.PI * (20 * 2 ** 2 - 2 ** 3 / 3 + 20 - 1 / 3);
    near(result.stats.volume, Math.PI * 400 * 60 - removed);
    verifyMesh(result);
  } finally { result.shape.delete(); }
});

test('圆头和方头键槽实际去料，周向旋转保持去料体积', () => {
  const volumes = [];
  for (const [ends, angle] of [['round', 0], ['round', 90], ['square', 0]]) {
    const result = buildModel(plainModel([cylinder()], { keyways: [createKeyway('s1', { position: 10, length: 30, width: 8, depth: 4, ends, angle })] }));
    try { verifyMesh(result); volumes.push(result.stats.volume); }
    finally { result.shape.delete(); }
  }
  // OCCT 对圆弧槽面采用数值积分，换向允许百万分之一的体积积分误差。
  near(volumes[0], volumes[1], 1e-6);
  assert.ok(volumes[0] < Math.PI * 400 * 60);
  assert.ok(volumes[2] < volumes[0], '同长宽方头槽的去料体积应大于圆头槽');
});

test('左右盲孔和沉孔体积符合解析结果', () => {
  for (const face of ['left', 'right']) {
    const model = plainModel([cylinder()], { holes: [createHole({ face, diameter: 10, depth: 22, counterboreDiameter: 14, counterboreDepth: 3 })] });
    const result = buildModel(model);
    try {
      near(result.stats.volume, Math.PI * (400 * 60 - 25 * 22 - (49 - 25) * 3));
      verifyMesh(result);
    } finally { result.shape.delete(); }
  }
});

test('中心通孔保持单实体，六孔阵列按孔数准确去料', () => {
  const bore = buildModel(plainModel([cylinder()], { holes: [createHole({ through: true, diameter: 12 })] }));
  try { near(bore.stats.volume, Math.PI * (400 - 36) * 60); verifyMesh(bore); }
  finally { bore.shape.delete(); }
  const array = buildModel(plainModel([cylinder({ length: 20, diameter: 88, endDiameter: 88 })], {
    holes: [createHole({ face: 'right', count: 6, pcd: 64, diameter: 7, depth: 16, counterboreDiameter: 11, counterboreDepth: 4 })],
  }));
  try {
    near(array.stats.volume, Math.PI * (44 ** 2 * 20 - 6 * (3.5 ** 2 * 16 + (5.5 ** 2 - 3.5 ** 2) * 4)));
    verifyMesh(array);
  } finally { array.shape.delete(); }
});

test('默认齿轮轴和全部示例可生成有效单实体', () => {
  for (const preset of PRESETS) {
    const result = buildModel(preset.model);
    try { verifyMesh(result); assert.ok(result.stats.volume > 0); }
    finally { result.shape.delete(); }
  }
});

test('STEP 实体导出后重新导入，体积保持一致；STL 是完整二进制网格', async () => {
  const model = plainModel([cylinder({ chamferLeft: 1, chamferRight: 1 })], {
    keyways: [createKeyway('s1', { position: 8, length: 28 })],
    holes: [createHole({ diameter: 10, depth: 20 })],
  });
  const result = buildModel(model);
  try {
    const step = await exportModel(result, model, 'step');
    const text = new TextDecoder().decode(step.data);
    assert.match(text, /ISO-10303-21/);
    assert.match(text, /MANIFOLD_SOLID_BREP/);
    const imported = await importSTEP(new Blob([step.data]));
    try {
      const properties = measureShapeVolumeProperties(imported);
      near(properties.volume, result.stats.volume, 1e-6);
      properties.delete();
      let count = 0;
      for (const item of iterTopo(imported.wrapped, 'solid')) { count++; item.delete(); }
      assert.equal(count, 1);
    } finally { imported.delete(); }
    const stl = await exportModel(result, model, 'stl');
    const view = new DataView(stl.data);
    const triangleCount = view.getUint32(80, true);
    assert.ok(triangleCount > 0);
    assert.equal(stl.data.byteLength, 84 + 50 * triangleCount);
  } finally { result.shape.delete(); }
});

test('多个齿轮阶梯可融合，齿轮 STEP 往返与网格精度切换不改变体积', async () => {
  const model = plainModel([
    cylinder({ length: 15, diameter: 25, endDiameter: 25 }),
    cylinder({ id: 'gear1', type: 'gear', length: 20, gear: { teeth: 18, module: 2 } }),
    cylinder({ id: 'mid', length: 15, diameter: 30, endDiameter: 30 }),
    cylinder({ id: 'gear2', type: 'gear', length: 25, gear: { teeth: 24, module: 2, rotation: 8 } }),
  ]);
  const result = buildModel(model);
  try {
    verifyMesh(result);
    const step = await exportModel(result, model, 'step');
    const imported = await importSTEP(new Blob([step.data]));
    try {
      const properties = measureShapeVolumeProperties(imported);
      near(properties.volume, result.stats.volume, 1e-6);
      properties.delete();
      const checker = new oc.BRepCheck_Analyzer(imported.wrapped, true, false);
      assert.ok(checker.IsValid_2());
      checker.delete();
    } finally { imported.delete(); }
    const fine = buildModel({ ...model, quality: 'fine' });
    try {
      near(fine.stats.volume, result.stats.volume, 1e-10);
      assert.ok(fine.stats.triangles >= result.stats.triangles);
    } finally { fine.shape.delete(); }
  } finally { result.shape.delete(); }
});

test('无效尺寸、断裂设计和未实现齿轮倒角不能静默导出', () => {
  assert.throws(() => buildModel(plainModel([cylinder({ diameter: -1 })])), /直径/);
  assert.throws(() => buildModel(plainModel([cylinder()], { keyways: [createKeyway('s1', { position: 55, length: 20 })] })), /超出/);
  assert.throws(() => buildModel(plainModel([cylinder()], { holes: [createHole({ through: true, diameter: 50 })] })), /半径/);
  assert.throws(() => buildModel(plainModel([cylinder({ type: 'gear', chamferLeft: 1 })])), /倒角/);
});
