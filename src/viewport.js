import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { OBJExporter } from 'three/addons/exporters/OBJExporter.js';
import { getFeatureView } from './feature-view.js';

const PALETTES = {
  light: {
    background: 0xf4f6f7,
    floor: 0xf5f7f8,
    grid: 0xd6dfe4,
    gridCenter: 0xc8d3da,
    metal: 0xb9c5cf,
    edge: 0x304451,
    accent: 0x197d8c,
    axis: 0x9aadb7,
    label: '#516773',
    labelBackground: 'rgba(248,250,251,.92)',
  },
  dark: {
    background: 0x162028,
    floor: 0x19242d,
    grid: 0x2a3b46,
    gridCenter: 0x3c505b,
    metal: 0xaab9c4,
    edge: 0x7895a7,
    accent: 0x6bc9d5,
    axis: 0x627c89,
    label: '#b8cbd6',
    labelBackground: 'rgba(24,36,46,.92)',
  },
};

const VIEW_DIRECTIONS = {
  iso: new THREE.Vector3(0.77, 0.55, 1.12).normalize(),
  front: new THREE.Vector3(0, 0, 1),
  top: new THREE.Vector3(0, 1, 0.0001).normalize(),
  left: new THREE.Vector3(-1, 0, 0),
  right: new THREE.Vector3(1, 0, 0),
};

const fmt = (value) => Number(value.toFixed(2)).toLocaleString('zh-CN', { maximumFractionDigits: 2 });

function segmentDiameter(segment) {
  if (segment.type === 'gear') {
    return segment.gear.module * (segment.gear.teeth + 2 * (segment.gear.addendum ?? 1));
  }
  return Math.max(segment.diameter, segment.type === 'cone' ? segment.endDiameter : segment.diameter);
}

function releaseObject(object) {
  object.traverse((child) => {
    child.geometry?.dispose();
    if (Array.isArray(child.material)) child.material.forEach((material) => material.dispose());
    else child.material?.dispose();
  });
  object.removeFromParent();
}

function lineGeometry(coordinates) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(coordinates, 3));
  return geometry;
}

/** 创建可直接编辑的尺寸按钮；不依赖 WebGL，使用原生按钮的键盘激活行为。 */
export function createDimensionButton({ documentRef = globalThis.document, text, target, label, onActivate }) {
  const element = documentRef.createElement('button');
  const editTarget = Object.freeze({ ...target });
  const selectFeature = editTarget.kind === 'feature-select';
  element.type = 'button';
  element.textContent = text;
  element.className = `rotor-dimension-label ${selectFeature ? 'is-feature-link' : 'is-editable'}`;
  element.dataset.dimensionKind = editTarget.kind;
  if (editTarget.id) {
    if (editTarget.kind === 'feature-parameter' || selectFeature) element.dataset.featureId = editTarget.id;
    else element.dataset.segmentId = editTarget.id;
  }
  if (editTarget.key) element.dataset.dimensionKey = editTarget.key;
  if (editTarget.subId) element.dataset.dimensionSubId = editTarget.subId;
  element.title = `${label}；点击或按 Enter / 空格${selectFeature ? '查看特征参数' : '编辑'}`;
  element.setAttribute('aria-label', `${selectFeature ? '查看' : '编辑'}${label}`);
  if (!selectFeature) element.setAttribute('aria-haspopup', 'dialog');
  element.style.pointerEvents = 'auto';
  element.style.touchAction = 'manipulation';

  // 尺寸按钮只占自身区域，不让按钮上的操作启动视口旋转、双击适配或触摸拖动。
  for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'mousedown', 'mousemove', 'mouseup', 'dblclick', 'touchstart', 'touchmove', 'touchend', 'touchcancel', 'wheel', 'contextmenu']) {
    element.addEventListener(type, (event) => {
      event.stopPropagation();
      if (type === 'dblclick') event.preventDefault();
    }, { passive: type.startsWith('touch') || type === 'wheel' });
  }
  for (const type of ['keydown', 'keyup']) {
    element.addEventListener(type, (event) => {
      if (['Enter', ' ', 'Spacebar'].includes(event.key)) event.stopPropagation();
    });
  }
  element.addEventListener('click', (event) => {
    event.stopPropagation();
    onActivate({ ...editTarget }, element);
  });
  return element;
}

/** 单一 Three.js 场景；所有建模坐标与显示尺寸均使用毫米。 */
export class PartViewport {
  constructor(container, { onSelect = () => {}, onAutoRotateChange = () => {}, onDimensionEdit = () => {}, onFeatureSelect = () => {} } = {}) {
    this.container = container;
    this.onSelect = onSelect;
    this.onAutoRotateChange = onAutoRotateChange;
    this.onDimensionEdit = onDimensionEdit;
    this.onFeatureSelect = onFeatureSelect;
    this.theme = 'light';
    this.palette = PALETTES.light;
    this.mode = 'edges';
    this.dimensionsVisible = true;
    this.dimensionEditing = false;
    this.sectionEnabled = false;
    this.selectedId = null;
    this.selectedFeatureId = null;
    this.selectedFeatureSubId = null;
    this.model = null;
    this.layout = [];
    this.width = 1;
    this.height = 1;
    this.radius = 30;
    this.length = 180;
    this.disposed = false;
    this.dirty = true;
    this.labels = [];
    this._projection = new THREE.Vector3();
    this._raycaster = new THREE.Raycaster();
    this._pointer = new THREE.Vector2();
    this._center = new THREE.Vector3(this.length / 2, 0, 0);
    this._clock = new THREE.Clock();
    this._abort = new AbortController();

    if (getComputedStyle(container).position === 'static') container.style.position = 'relative';
    container.style.overflow = 'hidden';

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(this.palette.background);
    this.camera = new THREE.PerspectiveCamera(32, 1, 0.1, 10000);
    this.camera.position.copy(this._center).addScaledVector(VIEW_DIRECTIONS.iso, 440);
    this.camera.lookAt(this._center);

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, preserveDrawingBuffer: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.15;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.localClippingEnabled = true;
    this.renderer.domElement.className = 'rotor-canvas';
    this.renderer.domElement.style.cssText = 'display:block;width:100%;height:100%;outline:none;touch-action:none;';
    this.renderer.domElement.setAttribute('aria-label', '零件三维视图，左键旋转、右键平移、滚轮缩放，单击选择阶梯或特征辅助标记');
    this.renderer.domElement.setAttribute('role', 'img');
    container.appendChild(this.renderer.domElement);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.copy(this._center);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.085;
    this.controls.rotateSpeed = 0.65;
    this.controls.panSpeed = 0.8;
    this.controls.zoomSpeed = 0.9;
    this.controls.autoRotateSpeed = 0.6;
    this.controls.minDistance = 8;
    this.controls.maxDistance = 12000;
    this.controls.addEventListener('change', () => { this.dirty = true; });
    this.controls.addEventListener('start', () => { this._transition = null; });

    // 棚灯完全由场景生成，不依赖联网加载的环境贴图。
    const room = new RoomEnvironment();
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.environment = pmrem.fromScene(room, 0.05);
    this.scene.environment = this.environment.texture;
    this.scene.environmentIntensity = 1.2;
    room.dispose();
    pmrem.dispose();

    this.scene.add(new THREE.HemisphereLight(0xeaf4ff, 0x7c8b99, 1.5));
    this.keyLight = new THREE.DirectionalLight(0xfff5e8, 3.2);
    this.keyLight.position.set(150, 300, 200);
    this.keyLight.castShadow = true;
    this.keyLight.shadow.mapSize.set(2048, 2048);
    this.keyLight.shadow.normalBias = 0.3;
    this.keyLight.shadow.bias = -0.0001;
    this.keyLight.shadow.radius = 4;
    this.scene.add(this.keyLight, this.keyLight.target);
    this.fillLight = new THREE.DirectionalLight(0xc7e5ff, 1.3);
    this.fillLight.position.set(-200, 120, -160);
    this.scene.add(this.fillLight);

    this.modelGroup = new THREE.Group();
    this.modelGroup.name = '零件';
    this.scene.add(this.modelGroup);
    this.dimensionGroup = new THREE.Group();
    this.dimensionGroup.name = '显示尺寸';
    this.scene.add(this.dimensionGroup);
    this.featureGroup = new THREE.Group();
    this.featureGroup.name = '特征辅助定位';
    this.scene.add(this.featureGroup);
    this.sectionPlane = new THREE.Plane(new THREE.Vector3(0, -1, 0), 0);

    this.labelLayer = document.createElement('div');
    this.labelLayer.className = 'rotor-annotations';
    this.labelLayer.style.cssText = 'position:absolute;inset:0;pointer-events:none;overflow:hidden;z-index:2;';
    container.appendChild(this.labelLayer);

    this._createAxisGizmo();
    this._createGround();
    this._resizeObserver = new ResizeObserver(() => this._resize());
    this._resizeObserver.observe(container);
    this._resize();
    this._bindInteractions();
    this._animate();
  }

  _bindInteractions() {
    const canvas = this.renderer.domElement;
    const options = { signal: this._abort.signal };
    canvas.addEventListener('pointerdown', (event) => {
      this._pointerStart = { x: event.clientX, y: event.clientY, button: event.button };
    }, options);
    canvas.addEventListener('pointerup', (event) => {
      const start = this._pointerStart;
      this._pointerStart = null;
      if (!start || start.button !== 0 || Math.hypot(event.clientX - start.x, event.clientY - start.y) > 5) return;
      if (this._pickFeature(event)) {
        this.setAutoRotate(false);
        this.onFeatureSelect(this.selectedFeatureId, this.selectedFeatureSubId || undefined);
        return;
      }
      const segment = this._pick(event);
      if (segment) this.onSelect(segment.id);
    }, options);
    canvas.addEventListener('pointermove', (event) => {
      if (event.buttons) return;
      if (performance.now() - (this._lastHoverPick || 0) < 50) return;
      this._lastHoverPick = performance.now();
      canvas.style.cursor = this._pickFeature(event) || this._pick(event) ? 'pointer' : 'grab';
    }, options);
    canvas.addEventListener('dblclick', () => this.fit(), options);
    canvas.addEventListener('contextmenu', (event) => event.preventDefault(), options);
  }

  _pick(event) {
    if (!this.part) return null;
    const rect = this.renderer.domElement.getBoundingClientRect();
    this._pointer.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
    this._raycaster.setFromCamera(this._pointer, this.camera);
    const hits = this._raycaster.intersectObject(this.part, false);
    const hit = hits.find((item) => !this.sectionEnabled || this.sectionPlane.distanceToPoint(item.point) >= -1e-5);
    if (!hit) return null;
    return this.layout.find((item) => hit.point.x >= item.start - 1e-4 && hit.point.x <= item.end + 1e-4) || null;
  }

  _pickFeature(event) {
    if (!this.featureGroup?.visible || !this.featureGroup.children.length || !this.selectedFeatureId) return false;
    const rect = this.renderer.domElement.getBoundingClientRect();
    this._pointer.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
    this._raycaster.setFromCamera(this._pointer, this.camera);
    // 维持约四个屏幕像素的命中宽度，避免小孔的辅助线过分难选或遮住整段轴。
    const distance = this.camera.position.distanceTo(this.controls.target);
    this._raycaster.params.Line.threshold = 8 * distance * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2)) / Math.max(1, rect.height);
    return this._raycaster.intersectObjects(this.featureGroup.children, false).length > 0;
  }

  _createGround() {
    if (this.ground) releaseObject(this.ground);
    if (this.grid) releaseObject(this.grid);
    if (this.axisLine) releaseObject(this.axisLine);
    const extent = Math.max(this.length * 2.4, this.radius * 10, 120);
    const targetStep = extent / 45;
    const power = 10 ** Math.floor(Math.log10(targetStep));
    const step = [1, 2, 5, 10].map((n) => n * power).find((n) => n >= targetStep) || targetStep;
    const divisions = Math.ceil(extent / step);
    const size = divisions * step;
    const floorY = -this.radius - Math.max(3, this.radius * 0.15);
    this.ground = new THREE.Mesh(
      new THREE.PlaneGeometry(size * 3, size * 3),
      new THREE.MeshStandardMaterial({ color: this.palette.floor, roughness: 1, metalness: 0 }),
    );
    this.ground.rotation.x = -Math.PI / 2;
    this.ground.position.set(this.length / 2, floorY, 0);
    this.ground.receiveShadow = true;
    this.scene.add(this.ground);
    this.grid = new THREE.GridHelper(size, divisions, this.palette.gridCenter, this.palette.grid);
    this.grid.position.set(this.length / 2, floorY + 0.025, 0);
    this.grid.material.transparent = true;
    this.grid.material.opacity = this.theme === 'dark' ? 0.5 : 0.55;
    this.grid.material.depthWrite = false;
    this.scene.add(this.grid);

    const axisMaterial = new THREE.LineDashedMaterial({ color: this.palette.axis, dashSize: Math.max(2, this.length * 0.025), gapSize: Math.max(1, this.length * 0.012), transparent: true, opacity: 0.65 });
    this.axisLine = new THREE.Line(lineGeometry([-this.length * 0.12, 0, 0, this.length * 1.12, 0, 0]), axisMaterial);
    this.axisLine.computeLineDistances();
    this.scene.add(this.axisLine);

    const shadowExtent = Math.max(this.length * 0.8, this.radius * 2.2);
    Object.assign(this.keyLight.shadow.camera, { left: -shadowExtent, right: shadowExtent, top: shadowExtent, bottom: -shadowExtent, near: 0.1, far: Math.max(1500, this.length * 12) });
    this.keyLight.shadow.camera.updateProjectionMatrix();
    this.keyLight.position.set(this.length / 2 + this.radius * 3, this.radius * 9, this.radius * 5);
    this.keyLight.target.position.set(this.length / 2, 0, 0);
    this.keyLight.shadow.normalBias = Math.max(0.03, this.radius * 0.006);
  }

  _createAxisGizmo() {
    this.axisGizmo = document.createElement('div');
    this.axisGizmo.style.cssText = 'position:absolute;left:16px;bottom:18px;width:76px;height:76px;pointer-events:none;z-index:3;';
    this.axisGizmo.setAttribute('aria-label', '模型坐标系：X轴为零件轴向');
    this.axisGizmo.innerHTML = '<svg viewBox="0 0 76 76" width="76" height="76" aria-hidden="true"><circle cx="38" cy="38" r="3" fill="#8da0ad"/><g data-axis="x" stroke="#d18a55" fill="#b87143"><line stroke-width="1.6"/><text font-size="10" font-family="ui-monospace,monospace" text-anchor="middle" dominant-baseline="central" stroke="none">X</text></g><g data-axis="y" stroke="#6c9e82" fill="#5d9273"><line stroke-width="1.6"/><text font-size="10" font-family="ui-monospace,monospace" text-anchor="middle" dominant-baseline="central" stroke="none">Y</text></g><g data-axis="z" stroke="#759fc5" fill="#5a8cb5"><line stroke-width="1.6"/><text font-size="10" font-family="ui-monospace,monospace" text-anchor="middle" dominant-baseline="central" stroke="none">Z</text></g></svg>';
    this.container.appendChild(this.axisGizmo);
    this.axisElements = ['x', 'y', 'z'].map((axis) => ({
      axis,
      group: this.axisGizmo.querySelector(`[data-axis="${axis}"]`),
      line: this.axisGizmo.querySelector(`[data-axis="${axis}"] line`),
      text: this.axisGizmo.querySelector(`[data-axis="${axis}"] text`),
    }));
  }

  _updateAxisGizmo() {
    const inverse = this.camera.quaternion.clone().invert();
    const axes = [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1)];
    this.axisElements.forEach((elements, index) => {
      const v = axes[index].applyQuaternion(inverse);
      elements.line.setAttribute('x1', '38');
      elements.line.setAttribute('y1', '38');
      elements.line.setAttribute('x2', String(38 + v.x * 22));
      elements.line.setAttribute('y2', String(38 - v.y * 22));
      elements.text.setAttribute('x', String(38 + v.x * 30));
      elements.text.setAttribute('y', String(38 - v.y * 30));
      elements.group.setAttribute('opacity', String(v.z < -0.15 ? 0.5 : 1));
    });
  }

  _resize() {
    const width = Math.max(1, this.container.clientWidth);
    const height = Math.max(1, this.container.clientHeight);
    if (width === this.width && height === this.height) return;
    this.width = width;
    this.height = height;
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height, false);
    this.dirty = true;
  }

  setModel(result, model) {
    const mesh = result.mesh;
    if (!mesh?.vertices?.length || !mesh?.triangles?.length) throw new Error('几何内核未返回可显示的三角网格。');
    const wasEmpty = !this.part;
    const previousLength = this.length;
    const previousRadius = this.radius;
    this.model = structuredClone(model);
    this.result = result;
    let start = 0;
    this.layout = model.segments.map((segment) => {
      const item = { ...segment, start, end: start + segment.length };
      start = item.end;
      return item;
    });
    this.length = result.stats?.length || start;
    this.radius = (result.stats?.maxDiameter || Math.max(...model.segments.map(segmentDiameter))) / 2;
    this._center.set(this.length / 2, 0, 0);

    while (this.modelGroup.children.length) releaseObject(this.modelGroup.children[0]);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(mesh.vertices, 3));
    geometry.setIndex(new THREE.BufferAttribute(new Uint32Array(mesh.triangles), 1));
    if (mesh.normals?.length === mesh.vertices.length) geometry.setAttribute('normal', new THREE.Float32BufferAttribute(mesh.normals, 3));
    else geometry.computeVertexNormals();
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    const material = new THREE.MeshStandardMaterial({
      color: this.palette.metal,
      metalness: 0.72,
      roughness: 0.3,
      envMapIntensity: 1.15,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: 1,
      polygonOffsetUnits: 1,
    });
    this.part = new THREE.Mesh(geometry, material);
    this.part.name = model.name || '回转体零件';
    this.part.castShadow = true;
    this.part.receiveShadow = true;
    this.modelGroup.add(this.part);

    let edgeGeometry;
    const suppliedLines = result.edges?.lines;
    if (suppliedLines?.length) {
      const lines = Array.isArray(suppliedLines[0]) ? suppliedLines.flat(Infinity) : suppliedLines;
      edgeGeometry = lineGeometry(lines);
    } else {
      edgeGeometry = new THREE.EdgesGeometry(geometry, 24);
    }
    this.edges = new THREE.LineSegments(edgeGeometry, new THREE.LineBasicMaterial({ color: this.palette.edge, transparent: true, opacity: 0.23, depthWrite: false }));
    this.edges.name = '拓扑边界';
    this.edges.renderOrder = 1;
    this.modelGroup.add(this.edges);
    this.selection = null;
    this._createGround();
    this.setMode(this.mode);
    this.setSection(this.sectionEnabled);
    if (this.selectedFeatureId) this.setFeatureSelection(this.selectedFeatureId, this.selectedFeatureSubId);
    else this.setSelection(this.selectedId);

    // 连续修改参数时保留观察角度；尺寸明显改变时重新适配视野。
    const sizeChanged = this.length / previousLength > 1.3 || this.length / previousLength < 0.7 || this.radius / previousRadius > 1.4;
    if (wasEmpty || sizeChanged) this.fit({ animate: !wasEmpty });
    else {
      const delta = (this.length - previousLength) / 2;
      this.camera.position.x += delta;
      this.controls.target.x += delta;
      this.controls.update();
    }
    this.dirty = true;
  }

  setSelection(segmentId) {
    this.selectedId = segmentId;
    this.selectedFeatureId = null;
    this.selectedFeatureSubId = null;
    if (this.featureGroup) while (this.featureGroup.children.length) releaseObject(this.featureGroup.children[0]);
    if (this.selection) {
      releaseObject(this.selection);
      this.selection = null;
    }
    const selected = this.layout.find((item) => item.id === segmentId);
    if (selected && this.edges) {
      const points = this.edges.geometry.getAttribute('position');
      const coordinates = [];
      for (let index = 0; index < points.count; index += 2) {
        const ax = points.getX(index);
        const bx = points.getX(index + 1);
        if (Math.min(ax, bx) >= selected.start - 1e-4 && Math.max(ax, bx) <= selected.end + 1e-4) {
          coordinates.push(ax, points.getY(index), points.getZ(index), bx, points.getY(index + 1), points.getZ(index + 1));
        }
      }
      if (coordinates.length) {
        this.selection = new THREE.LineSegments(lineGeometry(coordinates), new THREE.LineBasicMaterial({ color: this.palette.accent, transparent: true, opacity: 0.8, depthWrite: false }));
        this.selection.renderOrder = 2;
        this.selection.material.clippingPlanes = this.sectionEnabled ? [this.sectionPlane] : [];
        this.modelGroup.add(this.selection);
      }
    }
    this._createDimensions();
    this.dirty = true;
  }

  setFeatureSelection(featureId, subId) {
    this.selectedFeatureId = featureId || null;
    this.selectedFeatureSubId = subId || null;
    if (this.selection) {
      releaseObject(this.selection);
      this.selection = null;
    }
    if (this.featureGroup) {
      while (this.featureGroup.children.length) releaseObject(this.featureGroup.children[0]);
      const view = getFeatureView(this.model, featureId, subId);
      if (view.markers.length) {
        // 半透明虚线表达被选特征的定义范围；不填充实体，也不模拟螺纹牙形。
        const dash = Math.max(.7, this.radius * .04);
        const marker = new THREE.LineSegments(lineGeometry(view.markers), new THREE.LineDashedMaterial({
          color: this.palette.accent, transparent: true, opacity: .66,
          dashSize: dash, gapSize: dash * .65, depthTest: false, depthWrite: false,
        }));
        marker.name = '选中特征定位轮廓';
        marker.computeLineDistances();
        marker.renderOrder = 3;
        this.featureGroup.add(marker);
      }
    }
    this._createDimensions();
    this.dirty = true;
  }

  _label(text, position, { accent = false, name = false, target, label, editable = true } = {}) {
    let element;
    if (editable) {
      element = createDimensionButton({
        documentRef: this.labelLayer.ownerDocument,
        text,
        target,
        label,
        onActivate: (editTarget, anchorElement) => {
          this.setAutoRotate(false);
          if (editTarget.kind === 'feature-select') this.onFeatureSelect?.(editTarget.id, editTarget.subId);
          else this.onDimensionEdit(editTarget, anchorElement);
        },
      });
    } else {
      element = this.labelLayer.ownerDocument.createElement('span');
      element.textContent = `${text} · 联动`;
      element.className = 'rotor-dimension-label is-derived';
      element.title = label;
      element.setAttribute('aria-label', label);
    }
    if (accent) element.classList.add('is-selected');
    const cursor = !editable ? 'default' : target?.kind === 'feature-select' ? 'pointer' : 'text';
    element.style.cssText = `position:absolute;left:0;top:0;transform:translate(-50%,-50%);white-space:nowrap;font:500 ${name ? 11 : 10}px/1.4 ui-monospace,SFMono-Regular,Consolas,"Microsoft YaHei",monospace;color:var(--dimension-label-color,${accent ? `#${new THREE.Color(this.palette.accent).getHexString()}` : this.palette.label});background:var(--dimension-label-bg,${this.palette.labelBackground});border:1px solid var(--dimension-label-border,transparent);padding:2px 5px;margin:0;border-radius:3px;letter-spacing:.01em;pointer-events:${editable ? 'auto' : 'none'};touch-action:manipulation;cursor:${cursor};appearance:none;`;
    this.labelLayer.appendChild(element);
    this.labels.push({ element, position: new THREE.Vector3(...position), target: { ...target }, editable });
  }

  _restoreDimensionFocus(target) {
    if (!target || !this.dimensionsVisible) return;
    const replacement = this.labels.find((label) => label.editable !== false &&
      ['kind', 'id', 'key', 'subId'].every((key) => (label.target[key] || '') === (target[key] || '')));
    replacement?.element.focus({ preventScroll: true });
  }

  _createDimensions() {
    // 只迁移旧尺寸按钮自身的焦点，不能干扰共享输入框或其他工作区控件。
    const activeElement = this.labelLayer.ownerDocument.activeElement;
    const focusedTarget = this.labels.find(({ element }) => element === activeElement)?.target;
    while (this.dimensionGroup.children.length) releaseObject(this.dimensionGroup.children[0]);
    this.labels.forEach(({ element }) => element.remove());
    this.labels = [];
    this.dimensionGroup.visible = this.dimensionsVisible;
    this.labelLayer.style.display = this.dimensionsVisible ? '' : 'none';
    if (!this.model) return;

    if (this.selectedFeatureId) {
      const view = getFeatureView(this.model, this.selectedFeatureId, this.selectedFeatureSubId);
      const coordinates = [];
      view.dimensions.forEach((item) => {
        coordinates.push(...item.lines);
        this._label(item.text, item.position, { accent: true, target: item.target, label: item.label, editable: item.editable });
      });
      view.annotations.forEach((item) => this._label(item.text, item.position, { accent: true, name: true, target: item.target, label: item.label }));
      if (coordinates.length) {
        const lines = new THREE.LineSegments(lineGeometry(coordinates), new THREE.LineBasicMaterial({ color: this.palette.accent, transparent: true, opacity: .78, depthTest: false, depthWrite: false }));
        lines.renderOrder = 4;
        this.dimensionGroup.add(lines);
      }
      this._restoreDimensionFocus(focusedTarget);
      return;
    }

    const points = [];
    const accentPoints = [];
    const spacing = Math.max(5, this.radius * 0.22);
    const y = -this.radius - spacing * 3.3;
    const z = this.radius * 0.85;
    const tick = Math.max(1, spacing * 0.36);
    const line = (array, a, b) => array.push(...a, ...b);
    const dimension = (start, end, yy, array) => {
      line(array, [start, yy, z], [end, yy, z]);
      [start, end].forEach((xx) => {
        line(array, [xx, yy - tick, z], [xx, yy + tick, z]);
      });
    };
    dimension(0, this.length, y - spacing * 2, points);
    line(points, [0, -this.radius, z], [0, y - spacing * 2 - tick, z]);
    line(points, [this.length, -this.radius, z], [this.length, y - spacing * 2 - tick, z]);
    this._label(`L ${fmt(this.length)} mm`, [this.length / 2, y - spacing * 2, z], {
      name: true,
      target: { kind: 'total-length' },
      label: `零件总长，当前 ${fmt(this.length)} mm`,
    });

    const shownSegments = this.layout.length <= 9 ? this.layout : this.layout.filter((segment) => segment.id === this.selectedId);
    shownSegments.forEach((segment) => {
      const active = segment.id === this.selectedId;
      const target = active ? accentPoints : points;
      dimension(segment.start, segment.end, y, target);
      line(target, [segment.start, -this.radius - spacing, z], [segment.start, y + tick, z]);
      line(target, [segment.end, -this.radius - spacing, z], [segment.end, y + tick, z]);
      this._label(fmt(segment.length), [(segment.start + segment.end) / 2, y, z], {
        accent: active,
        target: { kind: 'segment-length', id: segment.id },
        label: `${segment.name}的长度，当前 ${fmt(segment.length)} mm`,
      });
    });

    const selected = this.layout.find((segment) => segment.id === this.selectedId);
    if (selected) {
      const diameterLabels = selected.type === 'cone'
        ? [
          { kind: 'segment-diameter', diameter: selected.diameter, x: selected.start, prefix: '左径 ', label: '左端直径', below: false },
          { kind: 'segment-end-diameter', diameter: selected.endDiameter, x: selected.end, prefix: '右径 ', label: '右端直径', below: true },
        ]
        : [{ kind: selected.type === 'gear' ? 'gear-tip-diameter' : 'segment-diameter', diameter: segmentDiameter(selected), x: (selected.start + selected.end) / 2, prefix: selected.type === 'gear' ? '齿顶 ' : '', label: selected.type === 'gear' ? '齿顶圆直径' : '直径', below: false }];
      diameterLabels.forEach(({ kind, diameter, x, prefix, label, below }) => {
        const r = diameter / 2;
        const zz = r + spacing * 1.5;
        line(accentPoints, [x, -r, zz], [x, r, zz]);
        [-r, r].forEach((yy) => line(accentPoints, [x - tick, yy, zz], [x + tick, yy, zz]));
        this._label(`${prefix}⌀${fmt(diameter)}`, [x, (below ? -1 : 1) * (r + spacing * 1.2), zz], {
          accent: true,
          target: { kind, id: selected.id },
          label: `${selected.name}的${label}，当前 ${fmt(diameter)} mm${kind === 'gear-tip-diameter' ? '，修改将联动模数' : ''}`,
        });
      });
    }
    [
      [points, this.palette.axis, 0.8],
      [accentPoints, this.palette.accent, 0.88],
    ].forEach(([coordinates, color, opacity]) => {
      if (!coordinates.length) return;
      const lines = new THREE.LineSegments(lineGeometry(coordinates), new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthTest: false, depthWrite: false }));
      lines.renderOrder = 4;
      this.dimensionGroup.add(lines);
    });
    this._restoreDimensionFocus(focusedTarget);
  }

  _updateLabels() {
    if (!this.dimensionsVisible) return;
    this.labels.forEach(({ element, position }) => {
      this._projection.copy(position).project(this.camera);
      const visible = this._projection.z >= -1 && this._projection.z <= 1 && Math.abs(this._projection.x) < 1.15 && Math.abs(this._projection.y) < 1.15;
      element.style.display = visible ? '' : 'none';
      if (!visible) return;
      element.style.left = `${(this._projection.x * 0.5 + 0.5) * this.width}px`;
      element.style.top = `${(-this._projection.y * 0.5 + 0.5) * this.height}px`;
    });
  }

  _fitDistance(direction, up = this.camera.up) {
    const right = new THREE.Vector3().crossVectors(up, direction).normalize();
    const vertical = new THREE.Vector3().crossVectors(direction, right).normalize();
    const verticalTangent = Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2));
    const horizontalTangent = verticalTangent * this.camera.aspect;
    let distance = 1;
    const include = (point) => {
      const depth = point.dot(direction);
      distance = Math.max(distance, Math.abs(point.dot(right)) / horizontalTangent + depth, Math.abs(point.dot(vertical)) / verticalTangent + depth);
    };
    // 按当前观察方向投影包围盒，避免长轴与窄视口被裁切。
    for (const x of [-this.length / 2, this.length / 2]) {
      for (const y of [-this.radius * 1.65, this.radius * 1.2]) {
        for (const z of [-this.radius, this.radius * 1.3]) {
          const corner = new THREE.Vector3(x, y, z);
          include(corner);
        }
      }
    }
    // 特征尺寸可在端面之外；适配窗口时一并纳入当前可见标注的锚点。
    if (this.selectedFeatureId && this.dimensionsVisible) {
      this.labels.forEach(({ position }) => include(position.clone().sub(this._center)));
    }
    return distance * 1.25;
  }

  _moveCamera(position, up, animate = true) {
    this.controls.autoRotate = false;
    this.onAutoRotateChange(false);
    if (animate && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      this._transition = {
        start: performance.now(),
        fromPosition: this.camera.position.clone(),
        toPosition: position,
        fromTarget: this.controls.target.clone(),
        toTarget: this._center.clone(),
        fromUp: this.camera.up.clone(),
        toUp: up,
      };
    } else {
      this._transition = null;
      this.camera.up.copy(up);
      this.camera.position.copy(position);
      this.controls.target.copy(this._center);
      this.camera.lookAt(this._center);
      this.controls.update();
    }
    const distance = position.distanceTo(this._center);
    this.camera.near = Math.max(0.01, distance / 2000);
    this.camera.far = Math.max(10000, distance * 50);
    this.controls.minDistance = Math.max(1, this.radius * 0.5);
    this.controls.maxDistance = Math.max(1000, distance * 12);
    this.camera.updateProjectionMatrix();
    this.dirty = true;
  }

  fit({ animate = true } = {}) {
    const direction = this.camera.position.clone().sub(this.controls.target).normalize();
    if (direction.lengthSq() < 0.5) direction.copy(VIEW_DIRECTIONS.iso);
    const position = this._center.clone().addScaledVector(direction, this._fitDistance(direction));
    this._moveCamera(position, this.camera.up.clone(), animate);
  }

  setView(view) {
    const direction = VIEW_DIRECTIONS[view] || VIEW_DIRECTIONS.iso;
    const up = view === 'top' ? new THREE.Vector3(0, 0, -1) : new THREE.Vector3(0, 1, 0);
    const position = this._center.clone().addScaledVector(direction, this._fitDistance(direction, up));
    this._moveCamera(position, up);
  }

  setMode(mode) {
    this.mode = ['solid', 'edges', 'wireframe'].includes(mode) ? mode : 'solid';
    if (this.part) {
      this.part.material.wireframe = this.mode === 'wireframe';
      this.part.material.metalness = this.mode === 'wireframe' ? 0 : 0.72;
      this.part.material.color.set(this.mode === 'wireframe' ? this.palette.accent : this.palette.metal);
      this.edges.visible = this.mode === 'edges';
    }
    this.dirty = true;
  }

  setDimensions(visible) {
    this.dimensionsVisible = Boolean(visible);
    this.dimensionGroup.visible = this.dimensionsVisible;
    this.labelLayer.style.display = this.dimensionsVisible ? '' : 'none';
    this.dirty = true;
  }

  setDimensionEditing(editing) {
    const next = Boolean(editing);
    if (next === this.dimensionEditing) return;
    this.dimensionEditing = next;
    if (next) {
      this._controlsEnabledBeforeDimensionEdit = this.controls.enabled;
      this.controls.enabled = false;
    } else {
      this.controls.enabled = this._controlsEnabledBeforeDimensionEdit ?? true;
      delete this._controlsEnabledBeforeDimensionEdit;
    }
    // 结束尺寸编辑只恢复交互，不恢复进入编辑前的自动旋转状态。
    this.setAutoRotate(false);
    this.dirty = true;
  }

  setSection(enabled) {
    this.sectionEnabled = Boolean(enabled);
    const clippingPlanes = this.sectionEnabled ? [this.sectionPlane] : [];
    [this.part, this.edges, this.selection].forEach((object) => {
      if (!object) return;
      object.material.clippingPlanes = clippingPlanes;
      object.material.clipShadows = true;
      object.material.needsUpdate = true;
    });
    this.dirty = true;
  }

  setAutoRotate(enabled) {
    this._transition = null;
    const next = Boolean(enabled) && !this.dimensionEditing;
    this.controls.autoRotate = next;
    this.onAutoRotateChange(next);
    this.dirty = true;
  }

  setTheme(theme) {
    this.theme = theme === 'dark' ? 'dark' : 'light';
    this.palette = PALETTES[this.theme];
    this.scene.background.set(this.palette.background);
    this.renderer.toneMappingExposure = this.theme === 'dark' ? 1 : 1.15;
    if (this.part) this.part.material.color.set(this.palette.metal);
    if (this.edges) this.edges.material.color.set(this.palette.edge);
    this._createGround();
    this.setMode(this.mode);
    if (this.selectedFeatureId) this.setFeatureSelection(this.selectedFeatureId, this.selectedFeatureSubId);
    else this.setSelection(this.selectedId);
    this.dirty = true;
  }

  /** 返回独立的干净网格；调用方负责释放它的 geometry 与 material。 */
  getExportMesh() {
    if (!this.part) throw new Error('请等待零件建模完成后再导出。');
    const mesh = new THREE.Mesh(this.part.geometry.clone(), new THREE.MeshStandardMaterial({ color: this.palette.metal, metalness: 0.72, roughness: 0.3 }));
    mesh.name = this.model?.name || '回转体零件';
    mesh.userData = { units: 'millimeter', source: 'Rotor Studio' };
    return mesh;
  }

  async exportGLB() {
    const mesh = this.getExportMesh();
    // glTF 使用米；仅导出实体，不能带入尺寸线、网格或显示剖切状态。
    mesh.geometry.scale(0.001, 0.001, 0.001);
    mesh.userData.units = 'meter';
    const scene = new THREE.Scene();
    scene.name = this.model?.name || '回转体零件';
    scene.add(mesh);
    try {
      return await new GLTFExporter().parseAsync(scene, { binary: true, onlyVisible: true });
    } finally {
      releaseObject(mesh);
    }
  }

  exportOBJ() {
    const mesh = this.getExportMesh();
    try {
      return '# Units: millimeter\n' + new OBJExporter().parse(mesh);
    } finally {
      releaseObject(mesh);
    }
  }

  _animate() {
    if (this.disposed) return;
    this._frame = requestAnimationFrame(() => this._animate());
    const delta = Math.min(this._clock.getDelta(), 0.1);
    if (this._transition && !this.dimensionEditing) {
      const t = Math.min(1, (performance.now() - this._transition.start) / 360);
      const ease = 1 - (1 - t) ** 3;
      this.camera.position.lerpVectors(this._transition.fromPosition, this._transition.toPosition, ease);
      this.controls.target.lerpVectors(this._transition.fromTarget, this._transition.toTarget, ease);
      this.camera.up.lerpVectors(this._transition.fromUp, this._transition.toUp, ease).normalize();
      this.camera.lookAt(this.controls.target);
      this.dirty = true;
      if (t === 1) this._transition = null;
    }
    const changed = this.dimensionEditing ? false : this.controls.update(delta);
    if (this.dirty || changed || this.controls.autoRotate) {
      this.renderer.render(this.scene, this.camera);
      this._updateLabels();
      this._updateAxisGizmo();
      this.dirty = false;
    }
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    cancelAnimationFrame(this._frame);
    this._abort.abort();
    this._resizeObserver.disconnect();
    this.controls.dispose();
    while (this.scene.children.length) releaseObject(this.scene.children[0]);
    this.keyLight.shadow.map?.dispose();
    this.environment.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
    this.labelLayer.remove();
    this.axisGizmo.remove();
  }
}
