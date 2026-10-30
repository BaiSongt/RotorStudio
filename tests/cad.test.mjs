import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { setOC, importSTEP, iterTopo } from 'replicad';
import { buildModel, exportModel } from '../src/cad.js';
import { createSegment, createKeyway, createHole, getKeywayAxialLength, PRESETS } from '../src/schema.js';

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

// 独立从最终三角网格向 -Y 投射，检测给定 X/Z 的实际可见顶面高度。
function topAt(mesh, x, z) {
  let top = -Infinity;
  for (let index = 0; index < mesh.triangles.length; index += 3) {
    const p = [0, 1, 2].map(offset => {
      const vertex = mesh.triangles[index + offset] * 3;
      return mesh.vertices.slice(vertex, vertex + 3);
    });
    const denominator = (p[1][2] - p[2][2]) * (p[0][0] - p[2][0]) + (p[2][0] - p[1][0]) * (p[0][2] - p[2][2]);
    if (Math.abs(denominator) < 1e-10) continue;
    const a = ((p[1][2] - p[2][2]) * (x - p[2][0]) + (p[2][0] - p[1][0]) * (z - p[2][2])) / denominator;
    const b = ((p[2][2] - p[0][2]) * (x - p[2][0]) + (p[0][0] - p[2][0]) * (z - p[2][2])) / denominator;
    const c = 1 - a - b;
    if (Math.min(a, b, c) >= -1e-8) top = Math.max(top, a * p[0][1] + b * p[1][1] + c * p[2][1]);
  }
  return top;
}

// 独立体积预言机：对圆柱不同 Z 截面中的圆弓面积进行 Simpson 积分。
function woodruffRemovedVolume(shaftRadius, cutterRadius, depth, width) {
  const intervals = 4096;
  const increment = width / intervals;
  let sum = 0;
  for (let i = 0; i <= intervals; i++) {
    const z = -width / 2 + i * increment;
    const capHeight = Math.sqrt(shaftRadius ** 2 - z ** 2) - (shaftRadius - depth);
    const centerDistance = cutterRadius - capHeight;
    const area = cutterRadius ** 2 * Math.acos(centerDistance / cutterRadius)
      - centerDistance * Math.sqrt(cutterRadius ** 2 - centerDistance ** 2);
    sum += area * (i === 0 || i === intervals ? 1 : i % 2 ? 4 : 2);
  }
  return sum * increment / 3;
}

function preciseVolume(shape) {
  const properties = new oc.GProp_GProps_1();
  try {
    oc.BRepGProp.VolumeProperties_2(shape.wrapped, properties, 1e-9, true, false);
    return properties.Mass();
  } finally { properties.delete(); }
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

test('左右单圆头槽的圆端方向、去料体积和最短半圆边界正确', () => {
  const volumes = {};
  for (const ends of ['round', 'square', 'round-left', 'round-right']) {
    const model = plainModel([cylinder()], { keyways: [createKeyway('s1', { position: 10, length: 30, width: 8, depth: 4, ends })] });
    const result = buildModel(model);
    try {
      verifyMesh(result);
      volumes[ends] = result.stats.volume;
      if (ends === 'round-left' || ends === 'round-right') {
        const nearLeft = topAt(result.mesh, 10.25, 3.5);
        const nearRight = topAt(result.mesh, 39.75, 3.5);
        if (ends === 'round-left') {
          assert.ok(nearLeft > 19 && Math.abs(nearRight - 16) < 0.01);
        } else {
          assert.ok(nearRight > 19 && Math.abs(nearLeft - 16) < 0.01);
        }
      }
    } finally { result.shape.delete(); }
  }
  near(volumes['round-left'], volumes['round-right'], 1e-6);
  near(volumes['round-left'], (volumes.round + volumes.square) / 2, 1e-6);
  for (const ends of ['round-left', 'round-right']) {
    const result = buildModel(plainModel([cylinder()], { keyways: [createKeyway('s1', { ends, length: 4, width: 8, depth: 3, angle: 90 })] }));
    try { verifyMesh(result); assert.ok(result.stats.volume < Math.PI * 400 * 60); }
    finally { result.shape.delete(); }
  }
});

test('半圆键槽体积与独立圆弓积分一致，槽底确为圆弧且可绕轴旋转', () => {
  const key = createKeyway('s1', { ends: 'woodruff', position: 10, width: 8, depth: 3, cutterDiameter: 24, length: 1000 });
  const expectedRemoved = woodruffRemovedVolume(20, 12, 3, 8);
  const volumes = [];
  for (const angle of [0, 90, 137]) {
    const result = buildModel(plainModel([cylinder()], { keyways: [{ ...key, angle }] }));
    try {
      verifyMesh(result);
      near(Math.PI * 400 * 60 - result.stats.volume, expectedRemoved, 1e-4);
      volumes.push(result.stats.volume);
      if (angle === 0) {
        const length = getKeywayAxialLength(key);
        const center = key.position + length / 2;
        const centerHeight = topAt(result.mesh, center, 0);
        const quarterHeight = topAt(result.mesh, center + length / 4, 0);
        assert.ok(Math.abs(centerHeight - 17) < 0.08);
        const circleHeight = 29 - Math.sqrt(12 ** 2 - (length / 4) ** 2);
        assert.ok(Math.abs(quarterHeight - circleHeight) < 0.08);
        assert.ok(quarterHeight - centerHeight > 0.5, '圆弧槽底不能被平底槽替代');
      }
    } finally { result.shape.delete(); }
  }
  near(volumes[0], volumes[1], 1e-6);
  near(volumes[0], volumes[2], 1e-6);
});

test('半圆键槽不会误切宿主阶梯外的相邻大轴肩', () => {
  const model = plainModel([
    cylinder({ id: 'left', length: 20, diameter: 60, endDiameter: 60 }),
    cylinder({ length: 30 }),
    cylinder({ id: 'right', length: 20, diameter: 60, endDiameter: 60 }),
  ], { keyways: [createKeyway('s1', { ends: 'woodruff', position: 0, cutterDiameter: 24, width: 8, depth: 3 })] });
  const result = buildModel(model);
  try {
    verifyMesh(result);
    const initialVolume = Math.PI * (900 * 40 + 400 * 30);
    near(initialVolume - result.stats.volume, woodruffRemovedVolume(20, 12, 3, 8), 1e-4);
    assert.ok(topAt(result.mesh, 18, 0) > 29.9);
  } finally { result.shape.delete(); }
});

test('新增三种槽型的混合零件 STEP 回读保持体积和有效单实体', async () => {
  const model = plainModel([cylinder()], { keyways: [
    createKeyway('s1', { ends: 'round-left', position: 4, length: 12, width: 5, depth: 3 }),
    createKeyway('s1', { ends: 'round-right', position: 22, length: 12, width: 5, depth: 3, angle: 90 }),
    createKeyway('s1', { ends: 'woodruff', position: 40, cutterDiameter: 16, width: 5, depth: 2, angle: 137 }),
  ], holes: [createHole({ face: 'left', diameter: 8, depth: 20 })] });
  const result = buildModel(model);
  try {
    verifyMesh(result);
    const step = await exportModel(result, model, 'step');
    const imported = await importSTEP(new Blob([step.data]));
    try {
      near(preciseVolume(imported), result.stats.volume, 1e-6);
      let solids = 0;
      for (const item of iterTopo(imported.wrapped, 'solid')) { solids++; item.delete(); }
      assert.equal(solids, 1);
      const checker = new oc.BRepCheck_Analyzer(imported.wrapped, true, false);
      assert.ok(checker.IsValid_2());
      checker.delete();
    } finally { imported.delete(); }
  } finally { result.shape.delete(); }
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
      near(preciseVolume(imported), result.stats.volume, 1e-6);
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
      near(preciseVolume(imported), result.stats.volume, 1e-6);
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
