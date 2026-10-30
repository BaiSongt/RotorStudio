import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { setOC, importSTEP, iterTopo } from 'replicad';
import { buildModel, exportModel } from '../src/cad.js';
import { createSegment, upgradeModel, PRESETS } from '../src/schema.js';
import { ROTATIONAL_PRESETS } from '../src/features.js';

const require = createRequire(import.meta.url);
const loaderPath = require.resolve('replicad-opencascadejs/src/replicad_single.js');
const loaderText = readFileSync(loaderPath, 'utf8').replace(/export default Module;\s*$/, 'return Module;');
const initOC = new Function('require', '__dirname', '__filename', loaderText)(require, path.dirname(loaderPath), loaderPath);
const oc = await initOC({ wasmBinary: readFileSync(path.join(path.dirname(loaderPath), 'replicad_single.wasm')),
  print: () => {}, printErr: () => {} });
setOC(oc);

const segment = (overrides = {}) => createSegment({ id: 'outer', name: '外圆柱', length: 80,
  diameter: 50, endDiameter: 50, ...overrides });
const modelOf = (features = [], overrides = {}) => ({ schemaVersion: 2, partFamily: 'shaft', name: '回转特征验证',
  material: 'steel', quality: 'standard', segments: [segment()], keyways: [], holes: [], features, ...overrides });
const inner = (overrides = {}) => ({ id: 'inner', name: '内圆柱', type: 'cylinder', length: 80,
  diameter: 24, endDiameter: 24, ...overrides });
const bore = (overrides = {}) => ({ id: 'bore', type: 'bore', name: '独立内腔', enabled: true,
  face: 'left', offset: 0, termination: 'through-all', segments: [inner()], ...overrides });
const hole = (overrides = {}) => ({ id: 'cross-hole', type: 'hole', name: '径向孔', enabled: true,
  placement: 'radial', face: 'right', segmentId: 'outer', position: 40, angle: 0, count: 1, pcd: 0,
  diameter: 6, depth: 5, termination: 'through-wall', boreId: 'bore',
  counterboreDiameter: 0, counterboreDepth: 0,
  thread: { enabled: false, nominal: 8, pitch: 1.25, hand: 'right', toleranceClass: '6H', length: 5, offset: 0 },
  ...overrides });
const groove = (overrides = {}) => ({ id: 'groove', type: 'groove', name: '环槽', enabled: true,
  location: 'outer', segmentId: 'outer', boreId: 'bore', boreSegmentId: 'inner', position: 10,
  width: 4, depth: 2, ...overrides });
const keyway = (overrides = {}) => ({ id: 'inner-keyway', type: 'internal-keyway', name: '内键槽', enabled: true,
  boreId: 'bore', boreSegmentId: 'inner', position: 45, length: 20, width: 6, depth: 2, angle: 0,
  ...overrides });
const near = (actual, expected, relative = 1e-7) => assert.ok(
  Math.abs(actual - expected) <= relative * Math.max(1, Math.abs(expected)),
  `实际 ${actual}，期望 ${expected}`,
);
function verify(result) {
  assert.equal(result.stats.solids, 1);
  assert.ok(result.mesh.triangles.length > 0);
  assert.ok(result.mesh.vertices.every(Number.isFinite));
  const checker = new oc.BRepCheck_Analyzer(result.shape.wrapped, true, false);
  try { assert.ok(checker.IsValid_2()); } finally { checker.delete(); }
}
function volume(shape) {
  const props = new oc.GProp_GProps_1();
  try { oc.BRepGProp.VolumeProperties_2(shape.wrapped, props, 1e-9, true, false); return props.Mass(); }
  finally { props.delete(); }
}

// 从最终三角网格独立求径向截线交点，用于检查近壁、背壁和圆柱内外径。
function radialHits(mesh, x, tangent = 0, angle = 0) {
  const theta = angle * Math.PI / 180;
  const cosine = Math.cos(theta), sine = Math.sin(theta);
  const hits = [];
  for (let i = 0; i < mesh.triangles.length; i += 3) {
    const points = [0, 1, 2].map(offset => {
      const vertex = mesh.triangles[i + offset] * 3;
      const [px, y, z] = mesh.vertices.slice(vertex, vertex + 3);
      return [px, y * cosine + z * sine, -y * sine + z * cosine];
    });
    const [p, q, r] = points;
    const denominator = (q[2] - r[2]) * (p[0] - r[0]) + (r[0] - q[0]) * (p[2] - r[2]);
    if (Math.abs(denominator) < 1e-10) continue;
    const a = ((q[2] - r[2]) * (x - r[0]) + (r[0] - q[0]) * (tangent - r[2])) / denominator;
    const b = ((r[2] - p[2]) * (x - r[0]) + (p[0] - r[0]) * (tangent - r[2])) / denominator;
    const c = 1 - a - b;
    if (Math.min(a, b, c) >= -1e-8) hits.push(a * p[1] + b * q[1] + c * r[1]);
  }
  return hits.sort((a, b) => a - b).filter((value, index, sorted) => index === 0 || value - sorted[index - 1] > 1e-5);
}
function assertHits(actual, expected, tolerance = 0.12) {
  assert.equal(actual.length, expected.length, `截线交点 ${actual}，期望 ${expected}`);
  actual.forEach((value, index) => assert.ok(Math.abs(value - expected[index]) < tolerance,
    `截线交点 ${value}，期望 ${expected[index]}`));
}

// 孔截面用 z=a·sin(theta) 换元，避免圆盘边缘的积分奇点；与 CAD 刀具构造独立。
function radialRemoved(outerRadius, holeRadius, floorAt) {
  const intervals = 1024;
  const step = Math.PI / intervals;
  let sum = 0;
  for (let i = 0; i <= intervals; i++) {
    const theta = -Math.PI / 2 + i * step;
    const z = holeRadius * Math.sin(theta);
    const thickness = Math.sqrt(outerRadius ** 2 - z ** 2) - floorAt(z);
    const value = 2 * holeRadius ** 2 * Math.cos(theta) ** 2 * thickness;
    sum += value * (i === 0 || i === intervals ? 1 : i % 2 ? 4 : 2);
  }
  return sum * step / 3;
}

test('独立阶梯内腔和外轮廓分界错位，盲底与锥段体积符合解析结果', () => {
  const feature = bore({ termination: 'blind', segments: [
    inner({ id: 'b1', length: 20, diameter: 16, endDiameter: 16 }),
    inner({ id: 'b2', type: 'cone', length: 25, diameter: 16, endDiameter: 24 }),
    inner({ id: 'b3', length: 15 }),
  ] });
  const model = modelOf([feature], { segments: [segment({ length: 30 }),
    segment({ id: 'middle', length: 45, diameter: 60, endDiameter: 60 }),
    segment({ id: 'right', length: 25 })] });
  const result = buildModel(model);
  try {
    verify(result);
    const initial = Math.PI * (25 ** 2 * 55 + 30 ** 2 * 45);
    const removed = Math.PI * (8 ** 2 * 20 + (8 ** 2 + 8 * 12 + 12 ** 2) * 25 / 3 + 12 ** 2 * 15);
    near(result.stats.volume, initial - removed);
    assertHits(radialHits(result.mesh, 10), [-25, -8, 8, 25]);
    assertHits(radialHits(result.mesh, 50), [-30, -12, 12, 30]);
    assertHits(radialHits(result.mesh, 65), [-30, 30]);
  } finally { result.shape.delete(); }
});

test('左右入口镜像保持锥度与台阶位置，贯通末段长度由零件总长派生', () => {
  const segments = [inner({ id: 'b1', length: 20, diameter: 16, endDiameter: 16 }),
    inner({ id: 'b2', type: 'cone', length: 20, diameter: 16, endDiameter: 24 }),
    inner({ id: 'b3', length: 1 })];
  const expected = Math.PI * (25 ** 2 * 80 - 8 ** 2 * 20 - (8 ** 2 + 8 * 12 + 12 ** 2) * 20 / 3 - 12 ** 2 * 40);
  for (const face of ['left', 'right']) {
    const result = buildModel(modelOf([bore({ face, segments })]));
    try {
      verify(result); near(result.stats.volume, expected);
      const startRadius = face === 'left' ? 8 : 12;
      const endRadius = face === 'left' ? 12 : 8;
      assertHits(radialHits(result.mesh, 10), [-25, -startRadius, startRadius, 25]);
      assertHits(radialHits(result.mesh, 70), [-25, -endRadius, endRadius, 25]);
      assertHits(radialHits(result.mesh, face === 'left' ? 30 : 50), [-25, -10, 10, 25]);
    } finally { result.shape.delete(); }
  }
});

test('穿当前壁孔完整打穿近壁并保留背壁；贯穿孔去料恰好为双壁且径向旋转一致', () => {
  const initial = Math.PI * (20 ** 2 - 12 ** 2) * 80;
  const nearWall = radialRemoved(20, 3, z => Math.sqrt(12 ** 2 - z ** 2));
  for (const [termination, angle] of [['through-wall', 0], ['through-all', 0], ['through-wall', 67]]) {
    const result = buildModel(modelOf([bore(), hole({ termination, angle })],
      { segments: [segment({ diameter: 40, endDiameter: 40 })] }));
    try {
      verify(result);
      near(initial - result.stats.volume, nearWall * (termination === 'through-all' ? 2 : 1), 1e-6);
      for (const tangent of [0, 2.7]) {
        const expected = termination === 'through-all' ? []
          : [-Math.sqrt(20 ** 2 - tangent ** 2), -Math.sqrt(12 ** 2 - tangent ** 2)];
        assertHits(radialHits(result.mesh, 40.1, tangent, angle), expected);
      }
      assertHits(radialHits(result.mesh, 44, 0, angle), [-20, -12, 12, 20]);
    } finally { result.shape.delete(); }
  }
});

test('径向盲孔与沉孔从外圆顶点计深，曲面孔口实际去料符合独立积分', () => {
  const result = buildModel(modelOf([hole({ termination: 'blind', diameter: 6, depth: 5,
    counterboreDiameter: 8, counterboreDepth: 2 })],
  { segments: [segment({ diameter: 40, endDiameter: 40 })] }));
  try {
    verify(result);
    const removed = radialRemoved(20, 3, () => 15)
      + radialRemoved(20, 4, () => 18) - radialRemoved(20, 3, () => 18);
    near(Math.PI * 400 * 80 - result.stats.volume, removed, 1e-6);
    assertHits(radialHits(result.mesh, 40, 0), [-20, 15]);
    assertHits(radialHits(result.mesh, 43.5, 0), [-20, 18]);
  } finally { result.shape.delete(); }
});

test('盘件端面孔阵列与沉孔正确去料，简化螺纹不偷偷生成实体牙型', () => {
  const initial = Math.PI * (30 ** 2 - 10 ** 2) * 20;
  const removed = 6 * Math.PI * (2.1 ** 2 * 20 + (3.5 ** 2 - 2.1 ** 2) * 3);
  const volumes = [], faces = [];
  for (const enabled of [false, true]) {
    const threaded = hole({ placement: 'end', face: 'right', name: 'M5 安装孔', diameter: 4.2,
      count: 6, pcd: 44, termination: 'through-all', depth: 20,
      counterboreDiameter: 7, counterboreDepth: 3,
      thread: { enabled, nominal: 5, pitch: 0.8, hand: 'right', toleranceClass: '6H', length: 10, offset: 3 } });
    const result = buildModel(modelOf([bore({ segments: [inner({ diameter: 20, endDiameter: 20, length: 20 })] }), threaded],
      { segments: [segment({ length: 20, diameter: 60, endDiameter: 60 })] }));
    try {
      verify(result); near(result.stats.volume, initial - removed);
      volumes.push(result.stats.volume); faces.push(result.stats.faces);
      if (enabled) assert.ok(result.warnings.some(item => /螺纹/.test(item)));
    } finally { result.shape.delete(); }
  }
  near(volumes[0], volumes[1], 1e-12);
  assert.equal(faces[0], faces[1]);
});

test('内外环槽和内键槽体积、深度及旋转正确，混合特征 STEP 回读为有效单实体', async () => {
  const initial = Math.PI * (25 ** 2 - 12 ** 2) * 80;
  const rings = Math.PI * ((25 ** 2 - 23 ** 2) * 4 + (15 ** 2 - 12 ** 2) * 6);
  const halfWidth = 3;
  const innerArcIntegral = halfWidth * Math.sqrt(12 ** 2 - halfWidth ** 2) + 12 ** 2 * Math.asin(halfWidth / 12);
  const slot = 20 * (6 * 14 - innerArcIntegral);
  for (const angle of [0, 90]) {
    const model = modelOf([bore(), groove(), groove({ id: 'inner-groove', location: 'inner', position: 30, width: 6, depth: 3 }), keyway({ angle })]);
    const result = buildModel(model);
    try {
      verify(result); near(result.stats.volume, initial - rings - slot);
      assertHits(radialHits(result.mesh, 12), [-23, -12, 12, 23]);
      assertHits(radialHits(result.mesh, 32), [-25, -15, 15, 25]);
      assertHits(radialHits(result.mesh, 55, 0, angle), [-25, -12, 14, 25]);
      if (angle === 0) {
        const step = await exportModel(result, model, 'step');
        const imported = await importSTEP(new Blob([step.data]));
        try {
          near(volume(imported), result.stats.volume, 1e-6);
          let solids = 0;
          for (const item of iterTopo(imported.wrapped, 'solid')) { solids++; item.delete(); }
          assert.equal(solids, 1);
          const checker = new oc.BRepCheck_Analyzer(imported.wrapped, true, false);
          try { assert.ok(checker.IsValid_2()); } finally { checker.delete(); }
        } finally { imported.delete(); }
      }
    } finally { result.shape.delete(); }
  }
});

test('旧齿轮工程迁移到 v2 后保留原参数、实体体积、曲面面积和齿轮拓扑', () => {
  const legacy = structuredClone(PRESETS.find(item => item.id === 'gear-shaft').model);
  legacy.schemaVersion = 1;
  delete legacy.features;
  const migrated = upgradeModel(legacy);
  assert.equal(migrated.schemaVersion, 2);
  assert.deepEqual(migrated.segments, legacy.segments);
  assert.deepEqual(migrated.keyways, legacy.keyways);
  assert.deepEqual(migrated.holes, legacy.holes);
  assert.deepEqual(migrated.features, []);
  const original = buildModel(legacy);
  let current;
  try {
    current = buildModel(migrated);
    verify(original); verify(current);
    near(current.stats.volume, original.stats.volume, 1e-12);
    near(current.stats.area, original.stats.area, 1e-12);
    assert.equal(current.stats.faces, original.stats.faces);
    assert.equal(current.stats.triangles, original.stats.triangles);
    assert.equal(current.stats.length, original.stats.length);
    assert.equal(current.stats.maxDiameter, original.stats.maxDiameter);
  } finally { original.shape.delete(); current?.shape.delete(); }
});

test('盘、独立阶梯套和杯形壳体模板均能构建为有效单实体', () => {
  assert.equal(ROTATIONAL_PRESETS.length, 3);
  for (const preset of ROTATIONAL_PRESETS) {
    const result = buildModel(preset.model);
    try { verify(result); assert.ok(result.stats.volume > 0, preset.name); }
    finally { result.shape.delete(); }
  }
});

test('拆分内阶梯保持连续锥面或同径圆柱，左右入口的体积、单实体与 STEP 往返不变', async () => {
  for (const face of ['left', 'right']) for (const index of [1, 0]) {
    const originalModel = structuredClone(ROTATIONAL_PRESETS.find(item => item.id === 'independent-sleeve').model);
    const originalBore = originalModel.features.find(item => item.type === 'bore');
    originalBore.face = face;
    const splitModel = structuredClone(originalModel);
    const splitBore = splitModel.features.find(item => item.type === 'bore');
    const source = splitBore.segments[index];
    const middleDiameter = source.type === 'cone' ? (source.diameter + source.endDiameter) / 2 : source.diameter;
    splitBore.segments.splice(index, 1,
      { ...source, length: source.length / 2, endDiameter: middleDiameter },
      { ...source, id: `${source.id}-split`, name: `${source.name}后半段`, length: source.length / 2, diameter: middleDiameter });
    const original = buildModel(originalModel);
    let split;
    try {
      split = buildModel(splitModel);
      verify(original); verify(split);
      near(split.stats.volume, original.stats.volume, 1e-10);
      near(split.stats.area, original.stats.area, 1e-10);
      const step = await exportModel(split, splitModel, 'step');
      const imported = await importSTEP(new Blob([step.data]));
      try {
        near(volume(imported), original.stats.volume, 1e-6);
        let solids = 0;
        for (const item of iterTopo(imported.wrapped, 'solid')) { solids++; item.delete(); }
        assert.equal(solids, 1);
        const checker = new oc.BRepCheck_Analyzer(imported.wrapped, true, false);
        try { assert.ok(checker.IsValid_2()); } finally { checker.delete(); }
      } finally { imported.delete(); }
    } finally { original.shape.delete(); split?.shape.delete(); }
  }
});
