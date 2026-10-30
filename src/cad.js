import {
  draw, makeBox, makeCylinder,
  measureShapeSurfaceProperties, getOC, iterTopo,
} from 'replicad';
import { validateModel, getSegmentLayout, getKeywayAxialLength } from './schema.js';
import { applyFeature } from './cad-features.js';

const DEG = Math.PI / 180;
const EPS = 0.01;

// 所有几何运算均使用毫米；X 是零件轴线，左端面位于 X=0。
export function meshOptions(quality = 'standard') {
  return quality === 'fine'
    ? { tolerance: 0.025, angularTolerance: 0.08 }
    : { tolerance: 0.08, angularTolerance: 0.16 };
}

function dispose(item) {
  if (!item) return;
  try { item.delete(); } catch { /* 已被上游操作消费的临时对象无需再次释放。 */ }
}

function joined(left, right, operation = 'fuse') {
  try { return left[operation](right); }
  finally { dispose(left); dispose(right); }
}

function polygonDrawing(points) {
  let pen = draw(points[0]);
  for (let i = 1; i < points.length; i++) pen = pen.lineTo(points[i]);
  return pen.close();
}

function roundSegment(segment) {
  const start = segment.start;
  const length = segment.length;
  const r0 = segment.diameter / 2;
  const r1 = segment.type === 'cone' ? segment.endDiameter / 2 : r0;
  const c0 = segment.chamferLeft || 0;
  const c1 = segment.chamferRight || 0;
  if (segment.type === 'cylinder' && c0 === 0 && c1 === 0) {
    return makeCylinder(r0, length, [start, 0, 0], [1, 0, 0]);
  }
  // C 为端面径向退让量，倒角线相对轴线为 45°，圆锥段联动计算交点。
  const slope = (r1 - r0) / length;
  if ((c0 > 0 && slope >= 1) || (c1 > 0 && slope <= -1)) {
    throw new Error(`${segment.name}：圆锥斜率过大，无法生成所设 45° 倒角。`);
  }
  const dx0 = c0 === 0 ? 0 : c0 / (1 - slope);
  const dx1 = c1 === 0 ? 0 : c1 / (1 + slope);
  if (dx0 + dx1 >= length || r0 - c0 <= 0 || r1 - c1 <= 0) {
    throw new Error(`${segment.name}：倒角超出该阶梯的有效长度或半径。`);
  }
  const points = [[start, 0], [start, r0 - c0]];
  if (c0 > 0) points.push([start + dx0, r0 + slope * dx0]);
  if (c1 > 0) points.push([start + length - dx1, r1 - slope * dx1]);
  points.push([start + length, r1 - c1], [start + length, 0]);
  const drawing = polygonDrawing(points);
  try { return drawing.sketchOnPlane('XY').revolve([1, 0, 0], { origin: [0, 0, 0] }); }
  finally { dispose(drawing); }
}

const involuteAngle = (radius, base) => {
  if (radius <= base) return 0;
  const t = Math.sqrt((radius / base) ** 2 - 1);
  return t - Math.atan(t);
};

// 齿侧按渐开线方程采样；齿根为径向延伸和圆弧，不声称是滚刀包络齿根。
export function gearProfile(gear) {
  const { teeth, module: moduleSize, pressureAngle, rotation = 0,
    addendum = 1, dedendum = 1.25, backlash = 0 } = gear;
  const pitch = moduleSize * teeth / 2;
  const base = pitch * Math.cos(pressureAngle * DEG);
  const root = pitch - moduleSize * dedendum;
  const tip = pitch + moduleSize * addendum;
  const flankStart = Math.max(root, base);
  const toothStep = 2 * Math.PI / teeth;
  const halfThickness = Math.PI / (2 * teeth) - backlash / (2 * pitch);
  const pitchInvolute = involuteAngle(pitch, base);
  const halfAngle = radius => halfThickness + pitchInvolute - involuteAngle(radius, base);
  const rootHalf = halfAngle(flankStart);
  const tipHalf = halfAngle(tip);
  if (!(root > 0 && tip > flankStart && tipHalf > 0 && rootHalf * 2 < toothStep)) {
    throw new Error('齿轮参数使齿顶变尖或齿根相交，请减小齿顶高、压力角或侧隙。');
  }
  // 实体齿廓使用固定采样；显示网格精度切换不得改变 B-Rep 或实体体积。
  const steps = 12;
  const arcSteps = 5;
  const points = [];
  const add = (radius, angle) => {
    const point = [radius * Math.cos(angle), radius * Math.sin(angle)];
    const last = points.at(-1);
    if (!last || Math.hypot(point[0] - last[0], point[1] - last[1]) > 1e-9) points.push(point);
  };
  for (let tooth = 0; tooth < teeth; tooth++) {
    const angle = tooth * toothStep + rotation * DEG;
    add(root, angle - rootHalf);
    for (let i = 0; i <= steps; i++) {
      const radius = flankStart + (tip - flankStart) * i / steps;
      add(radius, angle - halfAngle(radius));
    }
    for (let i = 1; i <= arcSteps; i++) add(tip, angle - tipHalf + 2 * tipHalf * i / arcSteps);
    for (let i = steps - 1; i >= 0; i--) {
      const radius = flankStart + (tip - flankStart) * i / steps;
      add(radius, angle + halfAngle(radius));
    }
    add(root, angle + rootHalf);
    for (let i = 1; i < arcSteps; i++) {
      add(root, angle + rootHalf + (toothStep - 2 * rootHalf) * i / arcSteps);
    }
  }
  return points;
}

function gearSegment(segment) {
  if (segment.chamferLeft || segment.chamferRight) {
    throw new Error(`${segment.name}：首版齿轮段不支持端部倒角，请将倒角设为 0。`);
  }
  const drawing = polygonDrawing(gearProfile(segment.gear));
  try { return drawing.sketchOnPlane('YZ', segment.start).extrude(segment.length); }
  finally { dispose(drawing); }
}

function radiusAt(segment, position) {
  if (segment.type === 'gear') return segment.rootDiameter / 2;
  if (segment.type === 'cone') {
    return (segment.diameter + (segment.endDiameter - segment.diameter) * position / segment.length) / 2;
  }
  return segment.diameter / 2;
}

function keywayTool(keyway, segment) {
  const x0 = segment.start + keyway.position;
  const axialLength = getKeywayAxialLength(keyway);
  const x1 = x0 + axialLength;
  const radius = Math.min(radiusAt(segment, keyway.position), radiusAt(segment, keyway.position + axialLength));
  const floor = radius - keyway.depth;
  const top = segment.maxDiameter / 2 + EPS;
  const width = keyway.width;
  let tool;
  if (keyway.ends === 'woodruff') {
    const cutterRadius = (keyway.cutterDiameter ?? 24) / 2;
    const centerX = x0 + axialLength / 2;
    const centerY = radius - keyway.depth + cutterRadius;
    // 圆盘刀轴线沿 Z，切削厚度就是槽宽；最低点为外圆顶部减去设定深度。
    tool = makeCylinder(cutterRadius, width, [centerX, centerY, -width / 2], [0, 0, 1]);
    // 圆盘伸出名义槽口的部分高于本段外圆；限于宿主阶梯，避免误切相邻大轴肩。
    const clip = makeBox([segment.start, centerY - cutterRadius - EPS, -width / 2 - EPS],
      [segment.end, centerY + cutterRadius + EPS, width / 2 + EPS]);
    tool = joined(tool, clip, 'intersect');
  } else if (keyway.ends === 'round') {
    const half = width / 2;
    tool = makeCylinder(half, top - floor, [x0 + half, floor, 0], [0, 1, 0]);
    if (keyway.length > width + 1e-8) {
      const far = makeCylinder(half, top - floor, [x1 - half, floor, 0], [0, 1, 0]);
      tool = joined(tool, far);
      tool = joined(tool, makeBox([x0 + half, floor, -half], [x1 - half, top, half]));
    }
  } else if (keyway.ends === 'round-left' || keyway.ends === 'round-right') {
    const half = width / 2;
    const leftRounded = keyway.ends === 'round-left';
    const capCenter = leftRounded ? x0 + half : x1 - half;
    tool = makeCylinder(half, top - floor, [capCenter, floor, 0], [0, 1, 0]);
    // 保留指定一侧的真实半圆，长度等于半个槽宽时也能形成合法的半圆槽。
    const capClip = makeBox([leftRounded ? x0 - EPS : capCenter, floor - EPS, -half - EPS],
      [leftRounded ? capCenter : x1 + EPS, top + EPS, half + EPS]);
    tool = joined(tool, capClip, 'intersect');
    if (axialLength > half + 1e-8) {
      const body = makeBox([leftRounded ? capCenter : x0, floor, -half],
        [leftRounded ? x1 : capCenter, top, half]);
      tool = joined(tool, body);
    }
  } else {
    tool = makeBox([x0, floor, -width / 2], [x1, top, width / 2]);
  }
  if (keyway.angle) tool = tool.rotate(keyway.angle, [0, 0, 0], [1, 0, 0]);
  return tool;
}

function countTopology(shape, kind) {
  let count = 0;
  for (const item of iterTopo(shape.wrapped, kind)) {
    count++;
    dispose(item);
  }
  return count;
}

function checkedVolume(shape) {
  const oc = getOC();
  const props = new oc.GProp_GProps_1();
  try {
    // 交叉圆柱和单圆头槽含裁剪曲面，使用自适应积分保证镜像、旋转后的统计一致。
    oc.BRepGProp.VolumeProperties_2(shape.wrapped, props, 1e-9, true, false);
    return props.Mass();
  }
  finally { dispose(props); }
}

function checkSolid(shape) {
  const count = countTopology(shape, 'solid');
  if (count !== 1) throw new Error(`当前参数生成了 ${count} 个实体；请检查孔、键槽和阶梯连接，保持零件连续。`);
  const oc = getOC();
  const Analyzer = oc.BRepCheck_Analyzer_2 || oc.BRepCheck_Analyzer;
  if (Analyzer) {
    let checker;
    try {
      checker = new Analyzer(shape.wrapped, true, false);
      if (!checker.IsValid_2?.() && !checker.IsValid?.()) {
        // 部分 OCCT 版本提供 IsValid_1(shape)、IsValid_2() 的不同重载。
        if (typeof checker.IsValid_2 === 'function' || typeof checker.IsValid === 'function') {
          throw new Error('实体拓扑校验未通过，请减小倒角或调整相交特征。');
        }
      }
    } finally { dispose(checker); }
  }
  return count;
}

export function buildModel(model, onProgress = () => {}) {
  const validation = validateModel(model);
  if (validation.errors.length) throw new Error(validation.errors.join('\n'));
  const warnings = [...validation.warnings];
  const layout = getSegmentLayout(model);
  const length = layout.at(-1).end;
  let shape = null;
  try {
    for (let index = 0; index < layout.length; index++) {
      const segment = layout[index];
      onProgress(`正在生成阶梯 ${index + 1} / ${layout.length}`);
      const next = segment.type === 'gear' ? gearSegment(segment) : roundSegment(segment);
      shape = shape ? joined(shape, next) : next;
    }
    for (const keyway of model.keyways || []) {
      if (keyway.enabled === false) continue;
      onProgress('正在切除键槽');
      const segment = layout.find(item => item.id === keyway.segmentId);
      const before = checkedVolume(shape);
      shape = joined(shape, keywayTool(keyway, segment), 'cut');
      if (before - checkedVolume(shape) < 1e-7) warnings.push('某个键槽未产生新的去料，可能与已有特征重叠。');
    }
    for (const hole of model.holes || []) {
      if (hole.enabled === false) continue;
      onProgress(`正在切除${hole.face === 'left' ? '左' : '右'}端面孔`);
      const before = checkedVolume(shape);
      const direction = hole.face === 'left' ? [1, 0, 0] : [-1, 0, 0];
      const start = hole.face === 'left' ? -EPS : length + EPS;
      const depth = hole.through ? length + 2 * EPS : hole.depth + EPS;
      for (let i = 0; i < hole.count; i++) {
        const angle = (hole.angle + i * 360 / hole.count) * DEG;
        const y = hole.pcd / 2 * Math.cos(angle);
        const z = hole.pcd / 2 * Math.sin(angle);
        shape = joined(shape, makeCylinder(hole.diameter / 2, depth, [start, y, z], direction), 'cut');
        if (hole.counterboreDiameter > 0 && hole.counterboreDepth > 0) {
          shape = joined(shape, makeCylinder(hole.counterboreDiameter / 2,
            hole.counterboreDepth + EPS, [start, y, z], direction), 'cut');
        }
      }
      if (before - checkedVolume(shape) < 1e-7) warnings.push('某组端面孔未产生新的去料，可能与已有孔完全重叠。');
    }
    // v1 的阶梯、齿轮、键槽和端面孔保持原构建顺序；新特征在其后按列表顺序执行。
    for (const feature of model.features || []) {
      if (feature.enabled === false) continue;
      const label = `${feature.name || feature.type}（${feature.id}）`;
      onProgress(`正在生成特征：${label}`);
      let candidate = null;
      try {
        const before = checkedVolume(shape);
        candidate = applyFeature(shape, model, feature, { layout, length });
        checkSolid(candidate);
        const after = checkedVolume(candidate);
        if (!Number.isFinite(after) || after <= 0) throw new Error('特征生成的实体体积无效。');
        if (before - after < 1e-7) warnings.push(`${label}未产生新的去料，可能与已有特征完全重叠。`);
        // 只有该特征通过实体检查后才替换当前构建结果；Worker 仍只缓存整次成功结果。
        dispose(shape);
        shape = candidate;
        candidate = null;
      } catch (error) {
        dispose(candidate);
        const reason = error instanceof Error ? error.message : `几何内核运算失败（${String(error).slice(0, 120)}）。`;
        const failure = new Error(`特征 ${label}：${reason}`, { cause: error });
        failure.featureId = feature.id;
        failure.featureName = feature.name;
        failure.code = 'FEATURE_BUILD_FAILED';
        throw failure;
      }
    }
    onProgress('正在校验实体并生成显示网格');
    const solids = checkSolid(shape);
    const volume = checkedVolume(shape);
    if (!Number.isFinite(volume) || volume <= 0) throw new Error('零件实体体积无效，请检查尺寸和特征。');
    const surface = measureShapeSurfaceProperties(shape);
    let area;
    try { area = surface.area; } finally { dispose(surface); }
    const options = meshOptions(model.quality);
    const mesh = shape.mesh(options);
    const edges = shape.meshEdges({ ...options, keepMesh: true });
    return {
      shape, mesh, edges, warnings: [...new Set(warnings)],
      stats: { volume, area, solids, faces: countTopology(shape, 'face'), length,
        maxDiameter: Math.max(...layout.map(segment => segment.maxDiameter)),
        triangles: mesh.triangles.length / 3 },
    };
  } catch (error) {
    dispose(shape);
    throw error;
  }
}

export async function exportModel(result, model, format) {
  const blob = format === 'step' ? result.shape.blobSTEP()
    : format === 'stl' ? result.shape.blobSTL({ ...meshOptions(model.quality), binary: true })
      : null;
  if (!blob) throw new Error('不支持的导出格式。');
  const filename = `${String(model.name || '回转体零件').replace(/[\\/:*?"<>|\x00-\x1F]/g, '_')}.${format}`;
  return { data: await blob.arrayBuffer(), mime: blob.type, filename, format };
}
