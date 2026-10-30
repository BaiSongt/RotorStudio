import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { PartViewport, createDimensionButton } from '../src/viewport.js';
import { createSegment, getSegmentLayout, getModelBounds } from '../src/schema.js';
import { createFeature, createBoreSegment } from '../src/features.js';

// 使用 Node 原生 EventTarget 检查实际注册的事件和回调，不创建 WebGL。
// 此替身不模拟浏览器的键盘默认行为；Enter / Space 激活由真实浏览器另行检查。
class ElementFixture extends EventTarget {
  constructor(tagName, ownerDocument) {
    super();
    this.tagName = tagName.toUpperCase();
    this.ownerDocument = ownerDocument;
    this.dataset = {};
    this.style = {};
    this.attributes = new Map();
    this.children = [];
    this.className = '';
    this.classList = {
      add: (...names) => { this.className = [...new Set([...this.className.split(/\s+/).filter(Boolean), ...names])].join(' '); },
    };
  }

  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  appendChild(element) { element.parentElement = this; this.children.push(element); return element; }
  remove() {
    if (this.parentElement) this.parentElement.children = this.parentElement.children.filter((element) => element !== this);
    if (this.ownerDocument.activeElement === this) this.ownerDocument.activeElement = null;
    this.parentElement = null;
  }
  focus(options) { this.ownerDocument.activeElement = this; this.lastFocusOptions = options; }
  click() { this.dispatchEvent(new Event('click', { bubbles: true, cancelable: true })); }
}

function documentFixture() {
  const documentRef = { createElement: (tagName) => new ElementFixture(tagName, documentRef) };
  return documentRef;
}

function viewportFixture(segments, selectedId = segments[0].id, features = []) {
  const viewport = Object.create(PartViewport.prototype);
  const documentRef = documentFixture();
  viewport.model = { segments, features };
  viewport.layout = getSegmentLayout(viewport.model);
  const bounds = getModelBounds(viewport.model);
  viewport.length = bounds.length;
  viewport.radius = bounds.maxDiameter / 2;
  viewport.palette = { accent: 0x197d8c, axis: 0x9aadb7, label: '#516773', labelBackground: 'rgba(248,250,251,.92)' };
  viewport.dimensionGroup = new THREE.Group();
  viewport.featureGroup = new THREE.Group();
  viewport.labelLayer = documentRef.createElement('div');
  viewport.labels = [];
  viewport.dimensionsVisible = true;
  viewport.dimensionEditing = false;
  viewport.selectedId = selectedId;
  viewport.controls = { enabled: true, autoRotate: true };
  viewport.rotationChanges = [];
  viewport.editRequests = [];
  viewport.featureRequests = [];
  viewport.onAutoRotateChange = (enabled) => viewport.rotationChanges.push(enabled);
  viewport.onDimensionEdit = (target, anchorElement) => viewport.editRequests.push({ target, anchorElement, rotating: viewport.controls.autoRotate });
  viewport.onFeatureSelect = (id, subId) => viewport.featureRequests.push({ id, subId, rotating: viewport.controls.autoRotate });
  viewport._createDimensions();
  return viewport;
}

function findLabel(viewport, kind, id) {
  return viewport.labels.find(({ target }) => target.kind === kind && (id === undefined || target.id === id));
}

test('每段长度、总长和圆柱直径按钮映射到各自工程参数，回调前停止旋转', () => {
  const segments = [
    createSegment({ id: 'first', name: '前轴颈', length: 28, diameter: 30 }),
    createSegment({ id: 'middle', name: '安装轴段', length: 42, diameter: 44 }),
    createSegment({ id: 'last', name: '后轴颈', length: 32, diameter: 24 }),
  ];
  const viewport = viewportFixture(segments, 'middle');
  const originalParameters = JSON.stringify(viewport.model);
  for (const segment of segments) {
    const label = findLabel(viewport, 'segment-length', segment.id);
    assert.ok(label, `${segment.name}应有可编辑长度`);
    assert.equal(label.element.tagName, 'BUTTON');
    assert.equal(label.element.type, 'button');
    assert.equal(label.element.textContent, String(segment.length));
    assert.ok(label.element.getAttribute('aria-label').includes(segment.name));
    assert.ok(label.element.title.includes(`${segment.length} mm`));
    label.element.click();
    assert.deepEqual(viewport.editRequests.at(-1).target, { kind: 'segment-length', id: segment.id });
    assert.equal(viewport.editRequests.at(-1).anchorElement, label.element);
    assert.equal(viewport.editRequests.at(-1).rotating, false);
  }
  const total = findLabel(viewport, 'total-length');
  assert.equal(total.element.textContent, 'L 102 mm');
  total.element.click();
  assert.deepEqual(viewport.editRequests.at(-1).target, { kind: 'total-length' });
  const diameter = findLabel(viewport, 'segment-diameter', 'middle');
  assert.equal(diameter.element.textContent, '⌀44');
  diameter.element.click();
  assert.deepEqual(viewport.editRequests.at(-1).target, { kind: 'segment-diameter', id: 'middle' });
  assert.equal(JSON.stringify(viewport.model), originalParameters);
});

test('圆锥左右直径各自可编辑，齿轮齿顶径明确联动模数', () => {
  const cone = viewportFixture([createSegment({ id: 'cone', name: '锥形过渡段', type: 'cone', length: 36, diameter: 28, endDiameter: 46 })]);
  const left = findLabel(cone, 'segment-diameter', 'cone');
  const right = findLabel(cone, 'segment-end-diameter', 'cone');
  assert.equal(left.element.textContent, '左径 ⌀28');
  assert.equal(right.element.textContent, '右径 ⌀46');
  assert.ok(left.element.getAttribute('aria-label').includes('左端直径'));
  assert.ok(right.element.getAttribute('aria-label').includes('右端直径'));
  left.element.click();
  right.element.click();
  assert.deepEqual(cone.editRequests.map(({ target }) => target), [
    { kind: 'segment-diameter', id: 'cone' },
    { kind: 'segment-end-diameter', id: 'cone' },
  ]);

  const gear = viewportFixture([createSegment({ id: 'gear', name: '传动齿轮', type: 'gear', gear: { module: 2, teeth: 24, addendum: 1 } })]);
  const tip = findLabel(gear, 'gear-tip-diameter', 'gear');
  assert.equal(tip.element.textContent, '齿顶 ⌀52');
  assert.ok(tip.element.title.includes('联动模数'));
  assert.equal(findLabel(gear, 'segment-diameter', 'gear'), undefined);
  tip.element.click();
  assert.deepEqual(gear.editRequests[0].target, { kind: 'gear-tip-diameter', id: 'gear' });
});

test('尺寸按钮隔离指针、触摸和双击事件，保留原生按钮激活且不重复合成点击', () => {
  const requests = [];
  const target = { kind: 'segment-length', id: 'segment-a' };
  const element = createDimensionButton({
    documentRef: documentFixture(), text: '20', target,
    label: '测试轴段的长度，当前 20 mm',
    onActivate: (value, anchor) => requests.push({ value, anchor }),
  });
  assert.equal(element.type, 'button');
  assert.equal(element.style.pointerEvents, 'auto');
  assert.equal(element.dataset.dimensionKind, 'segment-length');
  assert.equal(element.dataset.segmentId, 'segment-a');
  for (const type of ['pointerdown', 'pointermove', 'pointerup', 'mousedown', 'dblclick', 'touchstart', 'touchmove', 'touchend', 'wheel']) {
    let propagationStopped = false;
    let defaultPrevented = false;
    element.addEventListener(type, (event) => { propagationStopped = event.cancelBubble; defaultPrevented = event.defaultPrevented; }, { once: true });
    element.dispatchEvent(new Event(type, { bubbles: true, cancelable: true }));
    assert.equal(propagationStopped, true, `${type}应在标签上停止传播`);
    assert.equal(defaultPrevented, type === 'dblclick', `${type}不应阻止原生聚焦或按钮点击`);
  }
  for (const key of ['Enter', ' ']) {
    for (const type of ['keydown', 'keyup']) {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'key', { value: key });
      element.dispatchEvent(event);
      assert.equal(event.defaultPrevented, false);
    }
  }
  assert.equal(requests.length, 0, '键盘监听不能再手工合成一次激活');
  target.id = 'changed-outside';
  element.click();
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0].value, { kind: 'segment-length', id: 'segment-a' });
  assert.equal(requests[0].anchor, element);
});

test('尺寸编辑暂停相机交互并同步旋转状态，恢复后不自动旋转或丢失既有禁用状态', () => {
  for (const initiallyEnabled of [true, false]) {
    const viewport = viewportFixture([createSegment({ id: 'shaft', name: '轴段' })]);
    viewport.controls.enabled = initiallyEnabled;
    viewport.controls.autoRotate = true;
    viewport._transition = { active: true };
    viewport.setDimensionEditing(true);
    viewport.setDimensionEditing(true);
    assert.equal(viewport.controls.enabled, false);
    assert.equal(viewport.controls.autoRotate, false);
    assert.equal(viewport._transition, null);
    assert.equal(viewport.rotationChanges.at(-1), false);
    viewport.setAutoRotate(true);
    assert.equal(viewport.controls.autoRotate, false, '编辑过程中不能重新开启自动旋转');
    viewport.setDimensionEditing(false);
    assert.equal(viewport.controls.enabled, initiallyEnabled);
    assert.equal(viewport.controls.autoRotate, false);
    assert.equal(viewport.dimensionEditing, false);
  }
});

test('超过九段时保留选中段和总长，重建标签不取消已打开的编辑会话', () => {
  const segments = Array.from({ length: 12 }, (_, index) => createSegment({ id: `s-${index}`, name: `阶梯${index + 1}`, length: 20 + index }));
  const viewport = viewportFixture(segments, 's-7');
  const lengths = viewport.labels.filter(({ target }) => target.kind === 'segment-length');
  assert.equal(lengths.length, 1);
  assert.equal(lengths[0].target.id, 's-7');
  assert.ok(findLabel(viewport, 'total-length'));
  lengths[0].element.click();
  const originalRequest = viewport.editRequests[0];
  viewport.setDimensionEditing(true);
  viewport._createDimensions();
  assert.equal(viewport.dimensionEditing, true);
  assert.equal(viewport.controls.enabled, false);
  assert.equal(viewport.editRequests.length, 1);
  assert.deepEqual(originalRequest.target, { kind: 'segment-length', id: 's-7' });
  assert.notEqual(findLabel(viewport, 'segment-length', 's-7').element, originalRequest.anchorElement);
});

test('标签重建保持原尺寸目标的键盘焦点，但不会抢走共享输入框的焦点', () => {
  const viewport = viewportFixture([
    createSegment({ id: 's1', name: '前轴段' }),
    createSegment({ id: 's2', name: '后轴段' }),
  ]);
  const documentRef = viewport.labelLayer.ownerDocument;
  const original = findLabel(viewport, 'segment-length', 's2').element;
  original.focus();
  viewport._createDimensions();
  const replacement = findLabel(viewport, 'segment-length', 's2').element;
  assert.notEqual(replacement, original);
  assert.equal(documentRef.activeElement, replacement);
  assert.deepEqual(replacement.lastFocusOptions, { preventScroll: true });

  const sharedInput = documentRef.createElement('input');
  sharedInput.value = '45.6';
  sharedInput.focus();
  viewport.setDimensionEditing(true);
  viewport._createDimensions();
  assert.equal(documentRef.activeElement, sharedInput);
  assert.equal(sharedInput.value, '45.6');
  assert.ok(viewport.labels.every(({ element }) => element.lastFocusOptions === undefined));
  assert.equal(viewport.dimensionEditing, true);
});

test('新特征尺寸保留完整字段和子段映射，只显示当前特征并在切回轴段时清除辅助线', () => {
  const bore = createFeature('bore', { id: 'bore', segments: [
    createBoreSegment({ id: 'inner-a', name: '内孔一', length: 20, diameter: 24 }),
    createBoreSegment({ id: 'inner-b', name: '内孔二', length: 30, diameter: 20 }),
  ] });
  const viewport = viewportFixture([createSegment({ id: 'outer', length: 100, diameter: 60 })], 'outer', [bore]);
  viewport.setFeatureSelection('bore', 'inner-b');
  assert.ok(viewport.featureGroup.children.length > 0);
  assert.ok(viewport.labels.every(({ target }) => target.kind === 'feature-parameter' && target.id === 'bore'));
  const diameter = viewport.labels.find(({ target }) => target.key === 'diameter');
  assert.equal(diameter.element.dataset.featureId, 'bore');
  assert.equal(diameter.element.dataset.segmentId, undefined);
  assert.equal(diameter.element.dataset.dimensionKey, 'diameter');
  assert.equal(diameter.element.dataset.dimensionSubId, 'inner-b');
  diameter.element.click();
  assert.deepEqual(viewport.editRequests.at(-1).target, { kind: 'feature-parameter', id: 'bore', key: 'diameter', subId: 'inner-b' });
  assert.equal(viewport.editRequests.at(-1).rotating, false);

  viewport.setSelection('outer');
  assert.equal(viewport.selectedFeatureId, null);
  assert.equal(viewport.featureGroup.children.length, 0);
  assert.ok(findLabel(viewport, 'segment-diameter', 'outer'));
  assert.ok(viewport.labels.every(({ target }) => target.kind !== 'feature-parameter'));
});

test('同一特征的多个尺寸重建后按key与subId恢复焦点，浮动编辑输入仍不会被抢焦点', () => {
  const bore = createFeature('bore', { id: 'bore', segments: [createBoreSegment({ id: 'inner', length: 40, diameter: 20 })] });
  const viewport = viewportFixture([createSegment({ id: 'outer', length: 100, diameter: 60 })], 'outer', [bore]);
  viewport.setFeatureSelection('bore', 'inner');
  const doc = viewport.labelLayer.ownerDocument;
  viewport.labels.find(({ target }) => target.key === 'diameter').element.focus();
  viewport._createDimensions();
  assert.equal(doc.activeElement, viewport.labels.find(({ target }) => target.key === 'diameter').element);
  assert.notEqual(doc.activeElement, viewport.labels.find(({ target }) => target.key === 'length').element);
  const input = doc.createElement('input');
  input.value = '22.5';
  input.focus();
  viewport.setDimensionEditing(true);
  viewport.setFeatureSelection('bore', 'inner');
  assert.equal(doc.activeElement, input);
  assert.equal(input.value, '22.5');
  assert.equal(viewport.controls.enabled, false);
});

test('派生内腔长度为不可编辑文本，简化螺纹按钮只打开特征参数', () => {
  const bore = createFeature('bore', { id: 'bore', termination: 'through-all', segments: [createBoreSegment({ id: 'inner', diameter: 20 })] });
  const hole = createFeature('hole', { id: 'threaded', placement: 'end', diameter: 5, depth: 14,
    thread: { enabled: true, nominal: 6, pitch: 1, length: 8 } });
  const viewport = viewportFixture([createSegment({ id: 'outer', length: 100, diameter: 60 })], 'outer', [bore, hole]);
  viewport.setFeatureSelection('bore', 'inner');
  const length = viewport.labels.find(({ target }) => target.key === 'length');
  assert.equal(length.element.tagName, 'SPAN');
  assert.ok(length.element.textContent.includes('联动'));
  length.element.click();
  assert.equal(viewport.editRequests.length, 0);

  viewport.setFeatureSelection('threaded');
  const thread = viewport.labels.find(({ target }) => target.kind === 'feature-select');
  assert.ok(thread.element.textContent.includes('简化螺纹'));
  assert.equal(thread.element.type, 'button');
  assert.equal(thread.element.getAttribute('aria-haspopup'), null);
  thread.element.click();
  assert.deepEqual(viewport.featureRequests, [{ id: 'threaded', subId: undefined, rotating: false }]);
  assert.equal(viewport.editRequests.length, 0);
});

test('真实网格替换路径保留特征选择、完整目标与打开的输入焦点', () => {
  const bore = createFeature('bore', { id: 'bore', segments: [createBoreSegment({ id: 'inner', length: 40, diameter: 20 })] });
  const segments = [createSegment({ id: 'outer', length: 100, diameter: 60 })];
  const viewport = viewportFixture(segments, 'outer', [bore]);
  viewport.modelGroup = new THREE.Group();
  viewport.palette.metal = 0xb9c5cf;
  viewport.palette.edge = 0x304451;
  viewport._center = new THREE.Vector3(50, 0, 0);
  viewport.camera = new THREE.PerspectiveCamera(32, 1, .1, 10000);
  viewport.controls.target = new THREE.Vector3(50, 0, 0);
  viewport.controls.update = () => false;
  viewport._createGround = () => {};
  viewport.fit = () => {};
  viewport.setFeatureSelection('bore', 'inner');
  const input = viewport.labelLayer.ownerDocument.createElement('input');
  input.value = '22.8';
  input.focus();
  viewport.setDimensionEditing(true);
  const geometry = new THREE.BoxGeometry(100, 60, 60);
  geometry.translate(50, 0, 0);
  const result = { mesh: { vertices: [...geometry.attributes.position.array], normals: [...geometry.attributes.normal.array], triangles: [...geometry.index.array] },
    stats: { length: 100, maxDiameter: 60 } };
  viewport.setModel(result, { segments, features: [bore] });
  assert.equal(viewport.selectedFeatureId, 'bore');
  assert.equal(viewport.selectedFeatureSubId, 'inner');
  assert.equal(viewport.labelLayer.ownerDocument.activeElement, input);
  assert.equal(input.value, '22.8');
  assert.equal(viewport.dimensionEditing, true);
  assert.equal(viewport.controls.enabled, false);
  assert.ok(viewport.labels.some(({ target }) => target.key === 'diameter' && target.subId === 'inner'));
  assert.ok(viewport.labels.every(({ target }) => target.kind === 'feature-parameter'));
  assert.ok(viewport.featureGroup.children.length > 0);
  viewport.setDimensionEditing(false);
  assert.equal(viewport.controls.enabled, true);
  assert.equal(viewport.controls.autoRotate, false);
  geometry.dispose();
});
