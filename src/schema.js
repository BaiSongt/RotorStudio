import { validateFeatures } from './features.js';
export { createFeature, createBoreSegment, getBoreLayout, getFeatureDimensions, featureLabel, THREAD_PRESETS, ROTATIONAL_PRESETS } from './features.js';

/** 参数工程数据、几何约束与演示案例。所有长度均使用毫米。 */
export const SCHEMA_VERSION = 2;
export const MATERIALS = Object.freeze({
  steel: { name: '钢', density: 7.85 },
  aluminum: { name: '铝合金', density: 2.7 },
  titanium: { name: '钛合金', density: 4.51 },
});
export const LIMITS = Object.freeze({
  segments: 24, features: 48, holesPerPattern: 24, totalHoles: 96, totalTeeth: 720,
  minLength: 0.1, maxLength: 2000, maxTotalLength: 10000,
  minDiameter: 0.5, maxDiameter: 2000,
});
const EPS = 1e-7;
const MIN_WALL = 0.05;
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isFiniteNumber = (value) => typeof value === 'number' && Number.isFinite(value);
const radians = (degrees) => degrees * Math.PI / 180;

export function uid(prefix = 'item') {
  return `${prefix}-${globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`}`;
}

export function createSegment(overrides = {}) {
  return {
    id: uid('seg'), name: '新阶梯', type: 'cylinder', length: 30, diameter: 30,
    endDiameter: 30, chamferLeft: 0, chamferRight: 0,
    ...overrides,
    gear: {
      teeth: 24, module: 2, pressureAngle: 20, rotation: 0,
      addendum: 1, dedendum: 1.25, backlash: 0,
      ...(overrides.gear ?? {}),
    },
  };
}

export function createKeyway(segmentId, overrides = {}) {
  return {
    id: uid('key'), segmentId, position: 5, length: 20, width: 8, depth: 3,
    angle: 0, ends: 'round', cutterDiameter: 24, enabled: true, ...overrides,
  };
}

/**
 * 返回槽口沿 X 轴的有效总长。半圆键槽由圆盘刀与轴顶切平面的交线确定，
 * length 仅保留切换前的平键槽草稿。旧版工程没有刀径时按 24 mm 读取。
 */
export function getKeywayAxialLength(key) {
  if (!isObject(key)) return NaN;
  if (key.ends !== 'woodruff') return isFiniteNumber(key.length) ? key.length : NaN;
  const diameter = Object.hasOwn(key, 'cutterDiameter') ? key.cutterDiameter : 24;
  if (!isFiniteNumber(diameter) || !isFiniteNumber(key.depth)) return NaN;
  const squaredHalfLength = key.depth * (diameter - key.depth);
  return squaredHalfLength >= 0 ? 2 * Math.sqrt(squaredHalfLength) : NaN;
}

export function createHole(overrides = {}) {
  return {
    id: uid('hole'), face: 'right', diameter: 8, depth: 20, through: false,
    count: 1, pcd: 0, angle: 0, counterboreDiameter: 0, counterboreDepth: 0,
    enabled: true, ...overrides,
  };
}

export function cloneModel(model) {
  return structuredClone(model);
}

/** 派生尺寸不写回参数，齿轮直径始终由模数和齿数计算。 */
export function getSegmentLayout(model) {
  let start = 0;
  return model.segments.map((segment) => {
    const gear = segment.gear;
    const maxDiameter = segment.type === 'gear'
      ? gear.module * (gear.teeth + 2 * gear.addendum)
      : segment.type === 'cone' ? Math.max(segment.diameter, segment.endDiameter) : segment.diameter;
    const rootDiameter = segment.type === 'gear'
      ? gear.module * (gear.teeth - 2 * gear.dedendum)
      : segment.type === 'cone' ? Math.min(segment.diameter, segment.endDiameter) : segment.diameter;
    const end = start + segment.length;
    const item = { ...segment, start, end, maxDiameter, rootDiameter };
    start = end;
    return item;
  });
}

export function getModelBounds(model) {
  const layout = getSegmentLayout(model);
  return {
    length: layout.at(-1)?.end ?? 0,
    maxDiameter: Math.max(0, ...layout.map((segment) => segment.maxDiameter)),
  };
}

/** 圆柱、圆锥端部45°倒角的轴向占用，输入须先通过验证。 */
export function getChamferRun(segment) {
  if (segment.type === 'gear') return { left: 0, right: 0 };
  const slope = segment.type === 'cone' ? (segment.endDiameter - segment.diameter) / (2 * segment.length) : 0;
  return {
    left: segment.chamferLeft > 0 ? segment.chamferLeft / (1 - slope) : 0,
    right: segment.chamferRight > 0 ? segment.chamferRight / (1 + slope) : 0,
  };
}

/** 指定轴向位置的保守实体半径；齿轮使用齿根圆以保证完整壁厚。 */
export function segmentRadiusAt(segment, localX, includeChamfers = true) {
  if (segment.type === 'gear') return segment.gear.module * (segment.gear.teeth - 2 * segment.gear.dedendum) / 2;
  const leftRadius = segment.diameter / 2;
  const rightRadius = segment.type === 'cone' ? segment.endDiameter / 2 : leftRadius;
  const x = Math.min(segment.length, Math.max(0, localX));
  const nominal = leftRadius + (rightRadius - leftRadius) * x / segment.length;
  if (!includeChamfers) return nominal;
  const run = getChamferRun(segment);
  if (run.left > 0 && x < run.left) return leftRadius - segment.chamferLeft + x;
  if (run.right > 0 && x > segment.length - run.right) return rightRadius - segment.chamferRight + segment.length - x;
  return nominal;
}

/** 线性回转外形在区间端点及倒角交点处取得半径极值。 */
export function minSegmentRadius(segment, localStart = 0, localEnd = segment.length, includeChamfers = true) {
  const points = [localStart, localEnd];
  if (includeChamfers && segment.type !== 'gear') {
    const run = getChamferRun(segment);
    for (const x of [run.left, segment.length - run.right]) {
      if (x > localStart && x < localEnd) points.push(x);
    }
  }
  return Math.min(...points.map((x) => segmentRadiusAt(segment, x, includeChamfers)));
}

function validateStructure(model, errors) {
  if (!isObject(model)) { errors.push('参数工程必须是 JSON 对象。'); return false; }
  if (![1, 2].includes(model.schemaVersion)) errors.push('不支持的工程版本：仅支持 schemaVersion = 1 或 2。');
  if (model.schemaVersion === 2) {
    if (!['shaft', 'disk', 'sleeve', 'housing'].includes(model.partFamily)) errors.push('v2 零件类型必须为 shaft、disk、sleeve 或 housing。');
    if (!Array.isArray(model.features)) errors.push('v2 工程的 features 必须为数组。');
  }
  if (typeof model.name !== 'string' || !model.name.trim() || model.name.length > 100) errors.push('零件名称必须为1～100个字符。');
  if (!Object.hasOwn(MATERIALS, model.material)) errors.push('材料必须为 steel、aluminum 或 titanium。');
  if (!['standard', 'fine'].includes(model.quality)) errors.push('网格精度必须为 standard 或 fine。');
  for (const key of ['segments', 'keyways', 'holes']) {
    if (!Array.isArray(model[key])) errors.push(`${key} 必须为数组。`);
  }
  if (!Array.isArray(model.segments) || !Array.isArray(model.keyways) || !Array.isArray(model.holes)) return false;
  if (model.segments.length < 1 || model.segments.length > LIMITS.segments) errors.push(`阶梯数量必须为1～${LIMITS.segments}。`);
  if (model.keyways.length + model.holes.length > LIMITS.features) errors.push(`键槽和孔组总数不能超过${LIMITS.features}。`);
  return model.segments.length > 0 && model.segments.length <= LIMITS.segments && model.keyways.length + model.holes.length <= LIMITS.features;
}

/** 返回所有可读诊断；错误阻止建模，警告保留设计自由度。 */
export function validateModel(model) {
  const errors = [];
  const warnings = [];
  if (!validateStructure(model, errors)) return { errors, warnings };
  const ids = new Set();
  const finite = (value, label, integer = false) => {
    if (!isFiniteNumber(value)) { errors.push(`${label}必须是有限数字。`); return false; }
    if (integer && !Number.isInteger(value)) { errors.push(`${label}必须为整数。`); return false; }
    return true;
  };
  const number = (value, label, min, max, integer = false) => {
    if (!finite(value, label, integer)) return false;
    if (value < min || value > max) { errors.push(`${label}必须在${min}～${max}之间。`); return false; }
    return true;
  };
  const identity = (item, label) => {
    if (!isObject(item)) { errors.push(`${label}必须为对象。`); return false; }
    if (typeof item.id !== 'string' || !item.id || item.id.length > 100) errors.push(`${label}的 id 必须是1～100字符的字符串。`);
    else if (ids.has(item.id)) errors.push(`${label}存在重复 id：${item.id}。`);
    else ids.add(item.id);
    return true;
  };
  let totalTeeth = 0;
  let totalLength = 0;
  for (const [index, segment] of model.segments.entries()) {
    const label = `阶梯${index + 1}`;
    if (!identity(segment, label)) continue;
    if (typeof segment.name !== 'string' || !segment.name.trim() || segment.name.length > 100) errors.push(`${label}名称必须为1～100个字符。`);
    if (!['cylinder', 'cone', 'gear'].includes(segment.type)) errors.push(`${label}类型必须为 cylinder、cone 或 gear。`);
    const basicStart = errors.length;
    number(segment.length, `${label}长度`, LIMITS.minLength, LIMITS.maxLength);
    // 切换类型时保留历史尺寸；隐藏字段仅验证可安全保存，实际使用时才施加物理范围。
    if (segment.type === 'gear') finite(segment.diameter, `${label}直径`);
    else number(segment.diameter, `${label}直径`, LIMITS.minDiameter, LIMITS.maxDiameter);
    if (segment.type === 'cone') number(segment.endDiameter, `${label}右端直径`, LIMITS.minDiameter, LIMITS.maxDiameter);
    else finite(segment.endDiameter, `${label}右端直径`);
    number(segment.chamferLeft, `${label}左倒角`, 0, LIMITS.maxDiameter / 2);
    number(segment.chamferRight, `${label}右倒角`, 0, LIMITS.maxDiameter / 2);
    if (isFiniteNumber(segment.length)) totalLength += segment.length;
    if (!isObject(segment.gear)) { errors.push(`${label}缺少齿轮参数对象。`); continue; }
    const g = segment.gear;
    const gearValidStart = errors.length;
    if (segment.type === 'gear') {
      number(g.teeth, `${label}齿数`, 12, 120, true);
      number(g.module, `${label}模数`, 0.1, 25);
      number(g.pressureAngle, `${label}压力角`, 10, 35);
      number(g.rotation, `${label}齿轮相位`, -3600, 3600);
      number(g.addendum, `${label}齿顶高系数`, 0.3, 1.5);
      number(g.dedendum, `${label}齿根高系数`, 0.5, 2);
      number(g.backlash, `${label}齿厚减薄量`, 0, 100);
    } else {
      finite(g.teeth, `${label}齿数`, true);
      finite(g.module, `${label}模数`);
      finite(g.pressureAngle, `${label}压力角`);
      finite(g.rotation, `${label}齿轮相位`);
      finite(g.addendum, `${label}齿顶高系数`);
      finite(g.dedendum, `${label}齿根高系数`);
      finite(g.backlash, `${label}齿厚减薄量`);
    }
    if (segment.type === 'gear' && errors.length === gearValidStart) {
      totalTeeth += g.teeth;
      const pitchRadius = g.module * g.teeth / 2;
      const baseRadius = pitchRadius * Math.cos(radians(g.pressureAngle));
      const tipRadius = pitchRadius + g.module * g.addendum;
      const rootRadius = pitchRadius - g.module * g.dedendum;
      const involute = (angle) => Math.tan(angle) - angle;
      const halfPitchThickness = Math.PI / (2 * g.teeth) - g.backlash / (2 * pitchRadius);
      const tipPressure = Math.acos(baseRadius / tipRadius);
      const tipHalfAngle = halfPitchThickness + involute(radians(g.pressureAngle)) - involute(tipPressure);
      // 齿根在基圆以内时使用径向过渡；相邻齿根侧边不能越过一个齿距。
      const rootPressure = Math.acos(baseRadius / Math.max(rootRadius, baseRadius));
      const rootHalfAngle = halfPitchThickness + involute(radians(g.pressureAngle)) - involute(rootPressure);
      if (2 * tipRadius > LIMITS.maxDiameter) errors.push(`${label}齿顶直径不能超过${LIMITS.maxDiameter} mm。`);
      if (rootRadius <= MIN_WALL) errors.push(`${label}齿根半径过小。`);
      if (halfPitchThickness <= 0 || tipHalfAngle <= 0.0001) errors.push(`${label}齿顶已变尖或齿厚为负，请减小齿顶高或齿厚减薄量。`);
      else if (2 * tipRadius * tipHalfAngle < 0.15 * g.module) warnings.push(`${label}齿顶较薄，建议降低齿顶高或齿厚减薄量。`);
      if (2 * rootHalfAngle >= 2 * Math.PI / g.teeth) errors.push(`${label}相邻齿根侧边相交，请减小压力角、齿根高系数，或适当增加齿厚减薄量。`);
      if (segment.chamferLeft > 0 || segment.chamferRight > 0) errors.push(`${label}齿轮段暂不支持端部倒角，请将两端倒角设为0。`);
      if (g.teeth < 2 * g.addendum / Math.sin(radians(g.pressureAngle)) ** 2) warnings.push(`${label}存在标准齿条展成时的根切风险；当前齿根为几何过渡，未模拟滚刀包络。`);
    }
    if (segment.type !== 'gear' && errors.length === basicStart) {
      const slope = segment.type === 'cone' ? (segment.endDiameter - segment.diameter) / (2 * segment.length) : 0;
      if ((segment.chamferLeft > 0 || segment.chamferRight > 0) && Math.abs(slope) >= 1) errors.push(`${label}圆锥斜率过大，无法设置当前45°端部倒角。`);
      else {
        const run = getChamferRun(segment);
        if (run.left + run.right >= segment.length - EPS) errors.push(`${label}两端倒角的轴向范围相互重叠。`);
      }
      const endDiameter = segment.type === 'cone' ? segment.endDiameter : segment.diameter;
      if (segment.chamferLeft >= segment.diameter / 2 - MIN_WALL || segment.chamferRight >= endDiameter / 2 - MIN_WALL) errors.push(`${label}倒角超过端面允许半径。`);
    }
  }
  if (totalLength > LIMITS.maxTotalLength) errors.push(`总长度不能超过${LIMITS.maxTotalLength} mm。`);
  if (totalTeeth > LIMITS.totalTeeth) errors.push(`所有齿轮段的齿数合计不能超过${LIMITS.totalTeeth}。`);
  // 结构和阶梯非法时不继续派生计算，避免导入文件触发异常。
  if (errors.length) return { errors, warnings };
  const layout = getSegmentLayout(model);
  const segmentMap = new Map(layout.map((segment) => [segment.id, segment]));
  const activeKeys = [];
  const activeHolePatterns = [];
  for (const [index, key] of model.keyways.entries()) {
    const label = `键槽${index + 1}`;
    if (!identity(key, label)) continue;
    const previousErrors = errors.length;
    if (typeof key.enabled !== 'boolean') errors.push(`${label}启用状态必须为布尔值。`);
    if (typeof key.segmentId !== 'string' || !segmentMap.has(key.segmentId)) errors.push(`${label}引用的阶梯不存在。`);
    number(key.position, `${label}起点`, 0, LIMITS.maxLength);
    if (key.ends === 'woodruff') finite(key.length, `${label}平键槽长度草稿`);
    else number(key.length, `${label}长度`, LIMITS.minLength, LIMITS.maxLength);
    number(key.width, `${label}宽度`, 0.1, LIMITS.maxDiameter);
    number(key.depth, `${label}深度`, 0.05, LIMITS.maxDiameter);
    number(key.angle, `${label}周向角度`, -3600, 3600);
    const cutterDiameter = Object.hasOwn(key, 'cutterDiameter') ? key.cutterDiameter : 24;
    if (key.ends === 'woodruff') number(cutterDiameter, `${label}圆盘刀直径`, LIMITS.minDiameter, LIMITS.maxDiameter);
    else finite(cutterDiameter, `${label}圆盘刀直径草稿`);
    if (!['round', 'square', 'round-left', 'round-right', 'woodruff'].includes(key.ends)) {
      errors.push(`${label}类型必须为 round、square、round-left、round-right 或 woodruff。`);
    }
    if (errors.length !== previousErrors || !key.enabled) continue;
    const segment = segmentMap.get(key.segmentId);
    const axialLength = getKeywayAxialLength(key);
    if (!isFiniteNumber(axialLength) || axialLength < LIMITS.minLength || axialLength > LIMITS.maxLength) {
      errors.push(`${label}有效轴向长度必须在${LIMITS.minLength}～${LIMITS.maxLength} mm之间，请检查刀径和深度。`);
      continue;
    }
    if (key.position + axialLength > segment.length + EPS) errors.push(`${label}超出所属阶梯长度。`);
    if (key.ends === 'round' && key.length < key.width - EPS) errors.push(`${label}圆头槽的总长度不能小于槽宽。`);
    if (['round-left', 'round-right'].includes(key.ends) && key.length < key.width / 2 - EPS) {
      errors.push(`${label}单圆头槽的总长度不能小于槽宽的一半。`);
    }
    if (key.ends === 'woodruff') {
      if (segment.type !== 'cylinder') errors.push(`${label}半圆键槽仅支持圆柱段；圆锥或齿轮段请选择平键槽。`);
      if (key.depth >= cutterDiameter / 2 - EPS) errors.push(`${label}半圆键槽深度必须小于圆盘刀半径，避免生成大于半圆的槽。`);
    }
    const radius = minSegmentRadius(segment, key.position, Math.min(key.position + axialLength, segment.length), false);
    if (key.width >= 2 * radius - MIN_WALL) errors.push(`${label}宽度必须小于所属区间直径。`);
    if (key.depth >= radius - MIN_WALL) errors.push(`${label}深度必须小于所属区间半径，避免穿越轴心。`);
    if (key.width < 2 * radius) {
      const shoulderSag = radius - Math.sqrt(radius * radius - (key.width / 2) ** 2);
      if (key.depth <= shoulderSag + EPS) errors.push(`${label}深度不足以在圆面上形成完整槽宽，请增大深度或减小宽度。`);
    }
    const run = getChamferRun(segment);
    if (key.position < run.left - EPS || key.position + axialLength > segment.length - run.right + EPS) warnings.push(`${label}与端部倒角相交，槽口会随端面外形截断。`);
    if (key.ends !== 'woodruff' && segment.type === 'cone') warnings.push(`${label}位于圆锥面：槽底保持平面，深度以槽区间的最小半径计算。`);
    if (key.ends !== 'woodruff' && segment.type === 'gear') warnings.push(`${label}位于齿轮段：深度以齿根圆计算，槽口会切除局部齿形。`);
    activeKeys.push({ key, segment, label, minRadius: radius, axialLength });
  }
  let totalHoles = 0;
  const minRadiusOverInterval = (start, end) => {
    const radii = [];
    for (const segment of layout) {
      if (segment.end <= start + EPS || segment.start >= end - EPS) continue;
      radii.push(minSegmentRadius(segment, Math.max(0, start - segment.start), Math.min(segment.length, end - segment.start)));
    }
    return Math.min(...radii);
  };
  for (const [index, hole] of model.holes.entries()) {
    const label = `孔组${index + 1}`;
    if (!identity(hole, label)) continue;
    const previousErrors = errors.length;
    if (typeof hole.enabled !== 'boolean') errors.push(`${label}启用状态必须为布尔值。`);
    if (typeof hole.through !== 'boolean') errors.push(`${label}贯通状态必须为布尔值。`);
    if (!['left', 'right'].includes(hole.face)) errors.push(`${label}必须位于左端面或右端面。`);
    number(hole.diameter, `${label}孔径`, 0.1, LIMITS.maxDiameter);
    number(hole.depth, `${label}孔深`, 0.1, LIMITS.maxTotalLength);
    number(hole.count, `${label}数量`, 1, LIMITS.holesPerPattern, true);
    number(hole.pcd, `${label}分布圆直径`, 0, LIMITS.maxDiameter);
    number(hole.angle, `${label}相位角`, -3600, 3600);
    number(hole.counterboreDiameter, `${label}沉孔直径`, 0, LIMITS.maxDiameter);
    number(hole.counterboreDepth, `${label}沉孔深度`, 0, LIMITS.maxTotalLength);
    if (errors.length !== previousErrors || !hole.enabled) continue;
    totalHoles += hole.count;
    const depth = hole.through ? totalLength : hole.depth;
    if (!hole.through && hole.depth >= totalLength - EPS) errors.push(`${label}盲孔深度必须小于总长；贯穿零件请启用通孔。`);
    if (hole.count > 1 && hole.pcd <= 0) errors.push(`${label}多孔阵列的分布圆直径必须大于0。`);
    const hasCounterbore = hole.counterboreDiameter > 0 || hole.counterboreDepth > 0;
    if (hasCounterbore && (hole.counterboreDiameter <= hole.diameter || hole.counterboreDepth <= 0)) errors.push(`${label}沉孔直径必须大于孔径，并设置正的沉孔深度。`);
    if (hasCounterbore && hole.counterboreDepth >= depth - EPS) errors.push(`${label}沉孔深度必须小于主孔有效深度。`);
    if (hole.count > 1) {
      const spacing = hole.pcd * Math.sin(Math.PI / hole.count);
      const neededDiameter = hasCounterbore ? hole.counterboreDiameter : hole.diameter;
      if (spacing <= neededDiameter + MIN_WALL) errors.push(`${label}相邻孔或沉孔重叠，请增大分布圆或减小孔径/数量。`);
    }
    const start = hole.face === 'left' ? 0 : Math.max(0, totalLength - depth);
    const end = hole.face === 'left' ? Math.min(totalLength, depth) : totalLength;
    const availableRadius = minRadiusOverInterval(start, end);
    if (hole.pcd / 2 + hole.diameter / 2 >= availableRadius - MIN_WALL) errors.push(`${label}孔径或分布圆超出钻孔路径的实体半径，请缩小孔或调整深度。`);
    if (hasCounterbore) {
      const cbStart = hole.face === 'left' ? 0 : Math.max(0, totalLength - hole.counterboreDepth);
      const cbEnd = hole.face === 'left' ? Math.min(totalLength, hole.counterboreDepth) : totalLength;
      if (hole.pcd / 2 + hole.counterboreDiameter / 2 >= minRadiusOverInterval(cbStart, cbEnd) - MIN_WALL) errors.push(`${label}沉孔超出端面可用半径。`);
    }
    const centers = Array.from({ length: hole.count }, (_, n) => {
      const angle = radians(hole.angle + n * 360 / hole.count);
      return [hole.pcd / 2 * Math.cos(angle), hole.pcd / 2 * Math.sin(angle)];
    });
    activeHolePatterns.push({ hole, label, centers, start, end });
  }
  if (totalHoles > LIMITS.totalHoles) errors.push(`启用孔的总数量不能超过${LIMITS.totalHoles}。`);
  // 特征之间允许实际相交，但给出可定位提示；完全重合的重复孔组阻止提交。
  for (let i = 0; i < activeHolePatterns.length; i++) {
    const a = activeHolePatterns[i];
    for (let j = i + 1; j < activeHolePatterns.length; j++) {
      const b = activeHolePatterns[j];
      if (Math.min(a.end, b.end) <= Math.max(a.start, b.start) + EPS) continue;
      let overlap = false;
      let duplicate = false;
      for (const ca of a.centers) for (const cb of b.centers) {
        const distance = Math.hypot(ca[0] - cb[0], ca[1] - cb[1]);
        if (distance < (a.hole.diameter + b.hole.diameter) / 2 + EPS) overlap = true;
        if (distance < EPS && a.hole.face === b.hole.face && a.hole.diameter === b.hole.diameter && a.hole.depth === b.hole.depth && a.hole.through === b.hole.through) duplicate = true;
      }
      if (duplicate) errors.push(`${a.label}与${b.label}有完全重合的重复孔，请删除重复特征。`);
      else if (overlap) warnings.push(`${a.label}与${b.label}相交，生成的孔腔会连通。`);
    }
  }
  for (const item of activeKeys) {
    const keyStart = item.segment.start + item.key.position;
    const keyEnd = keyStart + item.axialLength;
    for (const pattern of activeHolePatterns) {
      if (Math.min(keyEnd, pattern.end) <= Math.max(keyStart, pattern.start) + EPS) continue;
      if (pattern.hole.pcd / 2 + pattern.hole.diameter / 2 >= item.minRadius - item.key.depth - EPS) {
        warnings.push(`${item.label}与${pattern.label}可能相通，建议使用剖切视图检查。`);
      }
    }
  }
  if (model.schemaVersion === 2 && !errors.length) {
    const result = validateFeatures(model, { outerLayout: layout });
    errors.push(...result.errors);
    warnings.push(...result.warnings);
  }
  return { errors: [...new Set(errors)], warnings: [...new Set(warnings)] };
}

/** 导入按当前格式严格验证，不将字符串强转数字，不静默改变用户尺寸。 */
export function normalizeModel(raw) {
  const model = cloneModel(raw);
  if (isObject(model) && Array.isArray(model.keyways)) {
    for (const key of model.keyways) {
      // 只补不存在的新增字段；显式 null、字符串或其他非法值仍交给验证处理。
      if (isObject(key) && !Object.hasOwn(key, 'cutterDiameter')) key.cutterDiameter = 24;
    }
  }
  const { errors } = validateModel(model);
  if (errors.length) throw new Error(errors.join('\n'));
  return model;
}

/** 显式升级仅补 v2 容器；旧基体、键槽、孔的 id、尺寸和执行顺序完全保留。 */
export function upgradeModel(raw) {
  const model = normalizeModel(raw);
  if (model.schemaVersion === 1) {
    model.schemaVersion = 2;
    model.partFamily = 'shaft';
    model.features = [];
  }
  return model;
}

const gearShaft = {
  schemaVersion: 1, name: '阶梯齿轮轴', material: 'steel', quality: 'standard',
  segments: [
    createSegment({ id: 'shaft-01', name: '左轴颈', length: 28, diameter: 28, endDiameter: 28, chamferLeft: 1 }),
    createSegment({ id: 'shaft-02', name: '左轴肩', length: 32, diameter: 36, endDiameter: 36 }),
    createSegment({ id: 'shaft-03', name: '直齿轮', type: 'gear', length: 34, diameter: 48, endDiameter: 48 }),
    createSegment({ id: 'shaft-04', name: '键连接段', length: 52, diameter: 34, endDiameter: 34 }),
    createSegment({ id: 'shaft-05', name: '右轴颈', length: 34, diameter: 26, endDiameter: 26, chamferRight: 1 }),
  ],
  keyways: [createKeyway('shaft-04', { id: 'key-01', position: 7, length: 36, width: 8, depth: 3 })],
  holes: [createHole({ id: 'hole-01', face: 'right', diameter: 10, depth: 22, counterboreDiameter: 14, counterboreDepth: 3 })],
};

const steppedShaft = {
  schemaVersion: 1, name: '五级阶梯轴', material: 'steel', quality: 'standard',
  segments: [
    createSegment({ id: 'step-01', name: '左轴颈', length: 25, diameter: 24, endDiameter: 24, chamferLeft: 0.8 }),
    createSegment({ id: 'step-02', name: '左连接段', length: 35, diameter: 32, endDiameter: 32 }),
    createSegment({ id: 'step-03', name: '中间轴肩', length: 28, diameter: 44, endDiameter: 44, chamferLeft: 0.5, chamferRight: 0.5 }),
    createSegment({ id: 'step-04', name: '锥形过渡', type: 'cone', length: 32, diameter: 38, endDiameter: 30 }),
    createSegment({ id: 'step-05', name: '右轴颈', length: 40, diameter: 26, endDiameter: 26, chamferRight: 0.8 }),
  ], keyways: [], holes: [],
};

const flange = {
  schemaVersion: 1, name: '法兰连接轴', material: 'steel', quality: 'standard',
  segments: [
    createSegment({ id: 'flange-01', name: '连接轴', length: 65, diameter: 32, endDiameter: 32, chamferLeft: 1 }),
    createSegment({ id: 'flange-02', name: '轴肩', length: 25, diameter: 46, endDiameter: 46 }),
    createSegment({ id: 'flange-03', name: '六孔法兰', length: 20, diameter: 88, endDiameter: 88, chamferRight: 1 }),
  ],
  keyways: [createKeyway('flange-01', { id: 'flange-key', position: 12, length: 36, width: 8, depth: 3 })],
  holes: [
    createHole({ id: 'flange-pattern', face: 'right', diameter: 7, depth: 16, count: 6, pcd: 64, counterboreDiameter: 11, counterboreDepth: 4 }),
    createHole({ id: 'flange-center', face: 'right', diameter: 12, depth: 30 }),
  ],
};

const sleeve = {
  schemaVersion: 1, name: '空心阶梯套筒', material: 'aluminum', quality: 'standard',
  segments: [
    createSegment({ id: 'sleeve-01', name: '左定位段', length: 20, diameter: 42, endDiameter: 42, chamferLeft: 1 }),
    createSegment({ id: 'sleeve-02', name: '套筒主体', length: 65, diameter: 52, endDiameter: 52 }),
    createSegment({ id: 'sleeve-03', name: '右定位段', length: 25, diameter: 42, endDiameter: 42, chamferRight: 1 }),
  ], keyways: [],
  holes: [createHole({ id: 'sleeve-bore', face: 'right', diameter: 26, depth: 110, through: true, counterboreDiameter: 32, counterboreDepth: 8 })],
};

export const DEFAULT_MODEL = cloneModel(gearShaft);
export const PRESETS = [
  { id: 'gear-shaft', name: '阶梯齿轮轴', description: '五段轴身 · 24齿直齿轮 · 键槽 · 端面盲孔', model: gearShaft },
  { id: 'stepped-shaft', name: '五级阶梯轴', description: '圆柱阶梯 · 圆锥过渡 · 两端倒角', model: steppedShaft },
  { id: 'flange-shaft', name: '法兰连接轴', description: '六孔阵列 · 平底沉孔 · 键连接轴段', model: flange },
  { id: 'hollow-sleeve', name: '空心套筒', description: '中心通孔 · 定位轴肩 · 端面沉孔', model: sleeve },
];
