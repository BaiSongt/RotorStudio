import test from 'node:test';
import assert from 'node:assert/strict';
import { createSegment } from '../src/schema.js';
import { createFeature, createBoreSegment } from '../src/features.js';
import { getFeatureDimensionAnchors, getFeatureView } from '../src/feature-view.js';

function modelWith(features, segments = [createSegment({ id: 'outer', length: 100, diameter: 60 })]) {
  return { schemaVersion: 2, partFamily: 'sleeve', name: '特征标注测试', material: 'steel', quality: 'standard', segments, keyways: [], holes: [], features };
}

function dimension(view, key, subId) {
  return view.dimensions.find(({ target }) => target.key === key && (subId === undefined || target.subId === subId));
}

function hasPoint(coordinates, expected) {
  for (let index = 0; index < coordinates.length; index += 3) {
    if (expected.every((value, axis) => Math.abs(coordinates[index + axis] - value) < 1e-8)) return true;
  }
  return false;
}

test('右入口锥内腔的入口径/末端径目标绑定正确，并且入口偏置不移动外形', () => {
  const bore = createFeature('bore', {
    id: 'bore', face: 'right', offset: 5,
    segments: [createBoreSegment({ id: 'cone', name: '锥内孔', type: 'cone', length: 24, diameter: 20, endDiameter: 30 })],
  });
  const model = modelWith([bore]);
  const original = JSON.stringify(model);
  const view = getFeatureView(model, 'bore', 'cone');
  const entrance = dimension(view, 'diameter', 'cone'), exit = dimension(view, 'endDiameter', 'cone');
  assert.deepEqual(entrance.target, { kind: 'feature-parameter', id: 'bore', key: 'diameter', subId: 'cone' });
  assert.equal(entrance.value, 20);
  assert.equal(exit.value, 30);
  assert.equal(entrance.position[0], 95);
  assert.equal(exit.position[0], 71);
  assert.ok(hasPoint(entrance.lines, [95, 10, 0]));
  assert.ok(hasPoint(exit.lines, [71, 15, 0]));
  assert.equal(dimension(view, 'offset').value, 5);
  assert.equal(dimension(view, 'bottomThickness').value, 71);
  assert.equal(JSON.stringify(model), original, '坐标生成不得修改参数模型');

  bore.segments[0].diameter = 22;
  const updated = getFeatureDimensionAnchors(model, bore, 'cone');
  assert.ok(hasPoint(updated.find((item) => item.target.key === 'diameter').lines, [95, 11, 0]));
  assert.ok(hasPoint(updated.find((item) => item.target.key === 'endDiameter').lines, [71, 15, 0]));
});

test('贯穿内腔末段只显示派生长度，子段选择不会混入别段的尺寸', () => {
  const bore = createFeature('bore', {
    id: 'bore', face: 'left', offset: 5, termination: 'through-all',
    segments: [createBoreSegment({ id: 'lead', length: 20, diameter: 30 }), createBoreSegment({ id: 'tail', length: 10, diameter: 20 })],
  });
  const view = getFeatureView(modelWith([bore]), bore, 'tail');
  assert.equal(dimension(view, 'length', 'tail').value, 75);
  assert.equal(dimension(view, 'length', 'tail').editable, false);
  assert.equal(dimension(view, 'bottomThickness'), undefined);
  assert.ok(view.dimensions.filter((item) => item.target.subId).every((item) => item.target.subId === 'tail'));
  assert.ok(view.markers.length > 0, '未展开的子段仍保留定位轮廓');
});

test('径向孔的轴向位置属于宿主，角度90°沿+Z入孔，圆周阵列各有准确入口', () => {
  const segments = [createSegment({ id: 'first', length: 40, diameter: 36 }), createSegment({ id: 'second', length: 60, diameter: 50 })];
  const hole = createFeature('hole', { id: 'oil', placement: 'radial', segmentId: 'second', position: 20, angle: 90, count: 4, diameter: 6, depth: 7 });
  const view = getFeatureView(modelWith([hole], segments), hole);
  assert.equal(dimension(view, 'position').value, 20);
  assert.equal(dimension(view, 'depth').value, 7);
  assert.equal(dimension(view, 'count').value, 4);
  assert.ok(hasPoint(view.markers, [60, 0, 25]));
  assert.ok(hasPoint(view.markers, [60, 0, 18]));
  assert.ok(hasPoint(view.markers, [60, -25, 0]));
  assert.ok(hasPoint(view.markers, [60, 0, -25]));
  assert.ok(hasPoint(view.markers, [60, 25, 0]));
  assert.equal(dimension(view, 'pcd'), undefined, '径向孔无需误导性的端面PCD');
});

test('穿壁孔不把刀具终点当可编辑孔深，简化螺纹没有额外实体轮廓', () => {
  const bore = createFeature('bore', { id: 'bore', termination: 'through-all', segments: [createBoreSegment({ id: 'inner', diameter: 30 })] });
  const hole = createFeature('hole', { id: 'radial', placement: 'radial', segmentId: 'outer', boreId: 'bore', position: 50,
    diameter: 5, termination: 'through-wall' });
  const model = modelWith([bore, hole]);
  const plain = getFeatureView(model, hole);
  assert.equal(dimension(plain, 'depth'), undefined);
  const wall = dimension(plain, 'wallThickness');
  assert.equal(wall.value, 15);
  assert.equal(wall.editable, false);
  assert.ok(hasPoint(wall.lines, [50, 30, 0]));
  assert.ok(hasPoint(wall.lines, [50, 15, 0]));
  assert.equal(hasPoint(wall.lines, [50, 0, 0]), false, '壁厚尺寸不能量到轴心');
  assert.ok(plain.annotations.some((item) => item.text === '穿透当前壁'));
  hole.thread.enabled = true;
  const threaded = getFeatureView(model, hole);
  assert.deepEqual(threaded.markers, plain.markers, '语义螺纹不得伪造实体牙形');
  const annotation = threaded.annotations.find((item) => item.text.startsWith('简化螺纹'));
  assert.ok(annotation);
  assert.deepEqual(annotation.target, { kind: 'feature-select', id: 'radial' });
  assert.ok(annotation.label.includes('没有实体牙形'));
  assert.ok(threaded.dimensions.every((item) => !item.target.key.startsWith('thread.')));
});

test('右入口内腔上的环槽和内键槽从宿主全局左端定位，槽深沿正确径向', () => {
  const bore = createFeature('bore', { id: 'bore', face: 'right', offset: 10,
    segments: [createBoreSegment({ id: 'inner', length: 60, diameter: 24 })] });
  const groove = createFeature('groove', { id: 'ring', location: 'inner', boreId: 'bore', boreSegmentId: 'inner', position: 8, width: 6, depth: 2 });
  const key = createFeature('internal-keyway', { id: 'key', boreId: 'bore', boreSegmentId: 'inner', position: 10, length: 18, width: 6, depth: 2, angle: 90 });
  const model = modelWith([bore, groove, key]);
  const ringView = getFeatureView(model, groove);
  assert.ok(hasPoint(ringView.markers, [38, 12, 0]));
  assert.ok(hasPoint(ringView.markers, [44, 14, 0]));
  assert.equal(dimension(ringView, 'width').value, 6);
  assert.ok(ringView.dimensions.every(({ target }) => target.id === 'ring'));

  const keyView = getFeatureView(model, key);
  assert.ok(hasPoint(keyView.markers, [40, 3, 14]));
  assert.ok(hasPoint(keyView.markers, [58, -3, 14]));
  assert.ok(hasPoint(keyView.markers, [40, 3, Math.sqrt(12 ** 2 - 3 ** 2)]));
  assert.equal(dimension(keyView, 'position').value, 10);
  assert.equal(dimension(keyView, 'length').value, 18);
  assert.equal(dimension(keyView, 'depth').value, 2);
});

test('最小壁厚锚点落在实际最薄外阶梯，停用与缺失特征不留下标注', () => {
  const outer = [createSegment({ id: 'wide', length: 40, diameter: 60 }), createSegment({ id: 'narrow', length: 60, diameter: 40 })];
  const bore = createFeature('bore', { id: 'bore', face: 'left', offset: 10,
    segments: [createBoreSegment({ id: 'inner', length: 80, diameter: 24 })] });
  const model = modelWith([bore], outer), view = getFeatureView(model, bore, 'inner');
  const wall = dimension(view, 'wallThickness', 'inner');
  assert.equal(wall.value, 8);
  assert.ok(wall.position[0] >= 40 && wall.position[0] <= 90);
  assert.ok(hasPoint(wall.lines, [wall.position[0], 20, 0]));
  assert.deepEqual(getFeatureView(model, 'not-found'), { dimensions: [], markers: [], annotations: [] });
  bore.enabled = false;
  assert.deepEqual(getFeatureDimensionAnchors(model, bore), []);
  assert.deepEqual(getFeatureView(null, 'not-built-yet'), { dimensions: [], markers: [], annotations: [] });
});
