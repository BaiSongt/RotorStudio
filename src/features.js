/** v2 回转特征：纯参数、定位和约束。此模块不依赖 schema 或 CAD 内核。长度单位为 mm。 */
const EPS = 1e-7;
const MIN_WALL = 0.05;
const LIMITS = Object.freeze({ segments: 24, boreSegments: 96, features: 48, holesPerPattern: 24, totalHoles: 96,
  minLength: 0.1, maxLength: 2000, maxTotalLength: 10000, minDiameter: 0.5, maxDiameter: 2000 });
const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const uid = (prefix) => `${prefix}-${globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`}`;

/** 常用公制粗牙切削攻丝建议底孔，最终应依材料、刀具和公差核实；不适用于挤压丝锥。
 * 公称尺寸/螺距：OSG https://osgtool.com/800274ca-v3/
 * 切削底孔范围：Guhring https://guhring.com/ProductsServices/SizeDetails?EDP=9029200030000
 */
export const THREAD_PRESETS = Object.freeze([
  [3, 0.5, 2.5], [4, 0.7, 3.3], [5, 0.8, 4.2], [6, 1, 5], [8, 1.25, 6.8], [10, 1.5, 8.5], [12, 1.75, 10.2],
].map(([nominal, pitch, drillDiameter]) => Object.freeze({
  id: `M${nominal}`, name: `M${nominal} × ${pitch}`, label: `M${nominal} × ${pitch}`, nominal, pitch, drillDiameter,
  toleranceClass: '6H', source: 'https://guhring.com/ProductsServices/SizeDetails?EDP=9029200030000',
})));

export function createBoreSegment(overrides = {}) {
  return { id: uid('inner'), name: '内孔阶梯', type: 'cylinder', length: 20, diameter: 20, endDiameter: 20, ...overrides };
}

export function createFeature(type, overrides = {}) {
  const common = { id: uid(type), type, name: '', enabled: true };
  switch (type) {
    case 'bore': return { ...common, name: '独立内腔', face: 'right', offset: 0, termination: 'blind',
      segments: [createBoreSegment()], ...overrides };
    case 'hole': return { ...common, name: '孔特征', placement: 'end', face: 'right', segmentId: '', position: 15,
      angle: 0, count: 1, pcd: 0, diameter: 5, depth: 12, termination: 'blind', boreId: '',
      counterboreDiameter: 0, counterboreDepth: 0, ...overrides,
      thread: { enabled: false, nominal: 6, pitch: 1, hand: 'right', toleranceClass: '6H', length: 8, offset: 0,
        ...(overrides.thread ?? {}) } };
    case 'groove': return { ...common, name: '环槽', location: 'outer', segmentId: '', boreId: '', boreSegmentId: '',
      position: 5, width: 3, depth: 1, ...overrides };
    case 'internal-keyway': return { ...common, name: '内孔键槽', boreId: '', boreSegmentId: '',
      position: 0, length: 20, width: 6, depth: 2, angle: 0, ...overrides };
    default: throw new Error(`不支持的特征类型：${String(type)}。`);
  }
}

export function featureLabel(feature) {
  const types = { bore: '内腔', hole: '孔', groove: '环槽', 'internal-keyway': '内键槽' };
  const name = typeof feature?.name === 'string' && feature.name.trim() ? feature.name : types[feature?.type] ?? '特征';
  return `${name.slice(0, 100)}（${typeof feature?.id === 'string' ? feature.id.slice(0, 100) : '未命名 id'}）`;
}

/** 与 v1 外轮廓相同的保守基体布局；齿轮壁厚以齿根圆计算。 */
export function getOuterLayout(model) {
  let start = 0;
  return (model.segments ?? []).map((segment) => {
    const end = start + segment.length;
    const maxDiameter = segment.type === 'gear' ? segment.gear.module * (segment.gear.teeth + 2 * segment.gear.addendum)
      : segment.type === 'cone' ? Math.max(segment.diameter, segment.endDiameter) : segment.diameter;
    const rootDiameter = segment.type === 'gear' ? segment.gear.module * (segment.gear.teeth - 2 * segment.gear.dedendum)
      : segment.type === 'cone' ? Math.min(segment.diameter, segment.endDiameter) : segment.diameter;
    const result = { ...segment, start, end, maxDiameter, rootDiameter };
    start = end;
    return result;
  });
}

const modelLength = (model) => model.segments.reduce((sum, segment) => sum + segment.length, 0);

function chamferRun(segment) {
  if (segment.type === 'gear') return { left: 0, right: 0 };
  const slope = segment.type === 'cone' ? (segment.endDiameter - segment.diameter) / (2 * segment.length) : 0;
  return { left: segment.chamferLeft > 0 ? segment.chamferLeft / (1 - slope) : 0,
    right: segment.chamferRight > 0 ? segment.chamferRight / (1 + slope) : 0 };
}

function outerRadiusAt(segment, globalX) {
  if (segment.type === 'gear') return segment.rootDiameter / 2;
  const x = Math.min(segment.length, Math.max(0, globalX - segment.start));
  const left = segment.diameter / 2, right = segment.type === 'cone' ? segment.endDiameter / 2 : left;
  const run = chamferRun(segment);
  if (run.left > 0 && x < run.left) return left - segment.chamferLeft + x;
  if (run.right > 0 && x > segment.length - run.right) return right - segment.chamferRight + segment.length - x;
  return left + (right - left) * x / segment.length;
}

function overlapPieces(layout, start, end) {
  return layout.filter((s) => s.end > start + EPS && s.start < end - EPS);
}

function outerPoints(segment, start, end) {
  const run = chamferRun(segment);
  return [Math.max(start, segment.start), Math.min(end, segment.end), segment.start + run.left, segment.end - run.right]
    .filter((x) => x >= Math.max(start, segment.start) - EPS && x <= Math.min(end, segment.end) + EPS);
}

function minOuterRadius(layout, start, end) {
  const values = overlapPieces(layout, start, end).flatMap((s) => outerPoints(s, start, end).map((x) => outerRadiusAt(s, x)));
  return values.length ? Math.min(...values) : NaN;
}

function boreRadiusAt(segment, globalX) {
  const left = segment.diameter / 2;
  return segment.type === 'cone' ? left + (segment.endDiameter / 2 - left) * (globalX - segment.start) / segment.length : left;
}

/** 入口顺序不变；start/end 及 diameter/endDiameter 均映射至全局 X 的左/右。不回写派生段长。 */
export function getBoreLayout(model, bore) {
  if (!Array.isArray(bore?.segments)) throw new Error('内腔缺少阶梯数组。');
  const total = modelLength(model);
  let localStart = 0;
  return bore.segments.map((segment, index) => {
    const length = bore.termination === 'through-all' && index === bore.segments.length - 1
      ? total - bore.offset - localStart : segment.length;
    const rightEntry = bore.face === 'right';
    const start = rightEntry ? total - bore.offset - localStart - length : bore.offset + localStart;
    const end = start + length;
    const entryDiameter = segment.diameter, innerDiameter = segment.type === 'cone' ? segment.endDiameter : segment.diameter;
    const result = { ...segment, boreId: bore.id, start, end, length, draftLength: segment.length, localStart,
      diameter: rightEntry ? innerDiameter : entryDiameter, endDiameter: rightEntry ? entryDiameter : innerDiameter };
    localStart += length;
    return result;
  });
}

function previousFeatures(model, feature) {
  const features = Array.isArray(model.features) ? model.features : [];
  const index = features.findIndex((f) => f?.id === feature?.id);
  return features.slice(0, index < 0 ? features.length : index).filter((f) => f?.enabled);
}

function previousBores(model, feature) {
  return previousFeatures(model, feature).filter((f) => f.type === 'bore');
}

export function resolveBoreHost(model, feature) {
  const bore = previousBores(model, feature).find((b) => b.id === feature.boreId);
  if (!bore) throw new Error(`${featureLabel(feature)}必须引用此前启用的内腔。`);
  const boreSegment = getBoreLayout(model, bore).find((s) => s.id === feature.boreSegmentId);
  if (!boreSegment) throw new Error(`${featureLabel(feature)}引用的内腔阶梯不存在。`);
  return { bore, boreSegment };
}

/** 壁厚控制只开放内圆柱与外圆柱组合；跨外阶梯时使用最小可用外半径。 */
export function getBoreWallInfo(model, bore, subId) {
  const segment = getBoreLayout(model, bore).find((s) => s.id === subId);
  if (!segment || segment.type !== 'cylinder') return null;
  const layout = getOuterLayout(model), hosts = overlapPieces(layout, segment.start, segment.end);
  if (!hosts.length || hosts.some((s) => s.type !== 'cylinder')) return null;
  const outerRadius = minOuterRadius(layout, segment.start, segment.end);
  return { segment, outerRadius, wallThickness: outerRadius - segment.diameter / 2 };
}

/** 径向孔从外圆轴交点向轴心量深度，穿当前壁只切近侧半空间，贯穿全部才切到背侧。 */
export function resolveRadialHole(model, hole) {
  const host = getOuterLayout(model).find((s) => s.id === hole.segmentId);
  if (!host || host.type !== 'cylinder') throw new Error(`${featureLabel(hole)}径向孔仅支持已存在的外圆柱阶梯。`);
  const x = host.start + hole.position, outerRadius = host.diameter / 2;
  const bores = previousBores(model, hole);
  const bore = bores.find((b) => b.id === hole.boreId);
  const envelopeRadius = Math.max(hole.diameter, hole.counterboreDiameter > 0 && hole.counterboreDepth > 0 ? hole.counterboreDiameter : 0,
    hole.thread?.enabled ? hole.thread.nominal : 0) / 2;
  const boreSegment = bore ? getBoreLayout(model, bore).find((s) => s.type === 'cylinder' &&
    s.start <= x - envelopeRadius + EPS && s.end >= x + envelopeRadius - EPS) : undefined;
  const innerRadius = boreSegment?.diameter / 2;
  const effectiveDepth = hole.termination === 'through-all' ? 2 * outerRadius
    : hole.termination === 'through-wall' ? outerRadius : hole.depth;
  const threadRadius = (hole.thread?.enabled ? hole.thread.nominal : hole.diameter) / 2;
  const entrySag = threadRadius < outerRadius ? outerRadius - Math.sqrt(outerRadius ** 2 - threadRadius ** 2) : Infinity;
  // 任意上游内腔都截断连续牙段；不把空腔后的背壁拼成同一段有效螺纹。
  let firstVoid = 2 * outerRadius;
  for (const upstream of bores) for (const s of getBoreLayout(model, upstream)) {
    const left = Math.max(s.start, x - threadRadius), right = Math.min(s.end, x + threadRadius);
    if (right <= left + EPS) continue;
    const radius = Math.max(boreRadiusAt(s, left), boreRadiusAt(s, right));
    firstVoid = Math.min(firstVoid, outerRadius - radius);
  }
  for (const upstream of previousFeatures(model, hole)) {
    if (upstream.type !== 'groove' || upstream.location !== 'inner') continue;
    try {
      const s = resolveBoreHost(model, upstream).boreSegment;
      const start = s.start + upstream.position, end = start + upstream.width;
      if (Math.min(end, x + threadRadius) > Math.max(start, x - threadRadius) + EPS) {
        firstVoid = Math.min(firstVoid, outerRadius - s.diameter / 2 - upstream.depth);
      }
    } catch { /* 无效上游引用由结构校验报告；不修改或猜测尺寸。 */ }
  }
  return { host, x, outerRadius, innerRadius, effectiveDepth, boreSegment, bore, envelopeRadius,
    wallThickness: finite(innerRadius) ? outerRadius - innerRadius : undefined, entrySag,
    threadStart: Math.max(entrySag, hole.counterboreDepth || 0), threadEnd: Math.min(effectiveDepth, firstVoid, 2 * outerRadius - entrySag) };
}

/** 描述可直接编辑的唯一驱动量；只读派生量带 editable:false，供 UI 显示规则。 */
export function getFeatureDimensions(model, feature) {
  if (!object(feature)) return [];
  const result = [], total = modelLength(model);
  const add = (key, title, value, options = {}) => result.push({
    key, title: `${feature.name || '特征'} · ${title}`, value, unit: 'mm', min: 0, max: LIMITS.maxLength, step: 0.1,
    hint: '只修改该尺寸，其他外形和特征参数保持不变；约束不满足时拒绝修改。', editable: true,
    ...options, target: { kind: 'feature-parameter', id: feature.id, key, ...(options.subId ? { subId: options.subId } : {}) },
  });
  switch (feature.type) {
    case 'bore': {
      const layout = getBoreLayout(model, feature);
      add('offset', '入口偏移', feature.offset, { max: Math.max(0, total - LIMITS.minLength),
        hint: '只移动内腔入口；偏移范围内保留原材料。贯穿模式的末内段长度自动随之派生。' });
      for (const [i, segment] of feature.segments.entries()) {
        const subId = segment.id, lastThrough = feature.termination === 'through-all' && i === feature.segments.length - 1;
        add('length', `${segment.name}长度`, layout[i].length, { subId, min: LIMITS.minLength, max: LIMITS.maxLength,
          editable: !lastThrough, hint: lastThrough ? '贯穿内腔的末段长度由剩余总长派生，不能独立编辑。'
            : '只修改当前内阶梯长度，沿入口方向移动后续内阶梯；外轮廓不移动。' });
        add('diameter', `${segment.name}${segment.type === 'cone' ? '入口直径' : '内径'}`, segment.diameter,
          { subId, min: LIMITS.minDiameter, max: LIMITS.maxDiameter, hint: '只修改内孔直径，外径保持不变，壁厚随之变化。' });
        if (segment.type === 'cone') add('endDiameter', `${segment.name}末端直径`, segment.endDiameter,
          { subId, min: LIMITS.minDiameter, max: LIMITS.maxDiameter, hint: '修改从入口向内的末端直径，外轮廓保持不变。' });
        const wall = getBoreWallInfo(model, feature, subId);
        if (wall) add('wallThickness', `${segment.name}最小壁厚`, wall.wallThickness, { subId, min: MIN_WALL,
          max: wall.outerRadius - LIMITS.minDiameter / 2,
          hint: '保持外径，只通过内径 = 2 ×（所在区间最小外半径 − 壁厚）驱动当前内圆柱。' });
      }
      const anotherCavity = (model.features ?? []).some((f) => f?.enabled && f.type === 'bore' && f.id !== feature.id);
      if (feature.termination === 'blind' && !anotherCavity) add('bottomThickness', '对侧底厚', total - feature.offset - layout.reduce((s, x) => s + x.length, 0),
        { min: MIN_WALL, max: total - feature.offset - layout.slice(0, -1).reduce((s, x) => s + x.length, 0) - LIMITS.minLength,
          hint: '保持外形和前面内阶梯，只改变最后内阶梯长度来控制对侧底厚。入口偏移厚度独立。' });
      break;
    }
    case 'hole': {
      add('diameter', feature.thread?.enabled ? '螺纹底孔直径' : '孔径', feature.diameter, { min: 0.1, max: LIMITS.maxDiameter });
      let depth = feature.depth;
      if (feature.termination !== 'blind') {
        try { depth = feature.placement === 'radial' ? resolveRadialHole(model, feature).effectiveDepth : total; } catch { depth = feature.depth; }
      }
      if (feature.termination === 'through-wall' && feature.placement === 'radial') {
        let wallThickness = NaN;
        try { wallThickness = resolveRadialHole(model, feature).wallThickness; } catch { /* 缺失宿主交给验证显示。 */ }
        add('wallThickness', '目标内腔壁厚', wallThickness, { min: MIN_WALL, max: LIMITS.maxDiameter / 2, editable: false,
          hint: '仅表示外圆与所选目标内腔的半径差；其他内腔、槽或孔可能使实际局部壁厚更小。穿当前壁只打通近侧壁并保留背壁。' });
      } else add('depth', '钻孔深度', depth, { min: 0.1, max: LIMITS.maxTotalLength, editable: feature.termination === 'blind',
        hint: feature.termination === 'blind' ? '只改变钻孔深度，螺纹有效长度保持不变。' : '贯穿范围由终止模式确定，深度是只读派生值。' });
      if (feature.placement === 'radial') add('position', '宿主内轴向位置', feature.position,
        { max: getOuterLayout(model).find((s) => s.id === feature.segmentId)?.length ?? LIMITS.maxLength });
      if (feature.placement === 'end') add('pcd', '孔分布圆直径', feature.pcd, { max: LIMITS.maxDiameter });
      add('angle', '周向角度', feature.angle, { unit: '°', min: -3600, max: 3600 });
      add('count', '阵列数量', feature.count, { unit: '个', min: 1, max: LIMITS.holesPerPattern, step: 1 });
      add('counterboreDiameter', '沉孔直径', feature.counterboreDiameter, { max: LIMITS.maxDiameter });
      add('counterboreDepth', '沉孔深度', feature.counterboreDepth, { max: LIMITS.maxTotalLength });
      if (feature.thread?.enabled) {
        add('thread.length', '有效螺纹长度', feature.thread.length, { min: 0.1, max: LIMITS.maxTotalLength,
          hint: '仅修改螺纹语义长度；必须完全落在连续材料与已钻孔范围内，不改变底孔实体。' });
        add('thread.offset', '螺纹起始偏移', feature.thread.offset, { max: LIMITS.maxTotalLength,
          hint: '从钻孔入口沿钻轴向内量；需避开沉孔及曲面入口不完整牙区。' });
      }
      break;
    }
    case 'groove': {
      let maximum = LIMITS.maxTotalLength;
      try { maximum = feature.location === 'outer' ? getOuterLayout(model).find((s) => s.id === feature.segmentId)?.length ?? maximum
        : resolveBoreHost(model, feature).boreSegment.length; } catch { /* 引用缺失由校验报告。 */ }
      add('position', '槽左端位置', feature.position, { max: maximum });
      add('width', '环槽轴向宽度', feature.width, { min: 0.1 });
      add('depth', '环槽径向深度', feature.depth, { min: 0.05, max: LIMITS.maxDiameter });
      break;
    }
    case 'internal-keyway': {
      let maximum = LIMITS.maxTotalLength;
      try { maximum = resolveBoreHost(model, feature).boreSegment.length; } catch { /* 引用缺失由校验报告。 */ }
      add('position', '键槽左端位置', feature.position, { max: maximum });
      add('length', '键槽长度', feature.length, { min: 0.1 });
      add('width', '键槽宽度', feature.width, { min: 0.1, max: LIMITS.maxDiameter });
      add('depth', '键槽径向深度', feature.depth, { min: 0.05, max: LIMITS.maxDiameter });
      add('angle', '键槽周向角度', feature.angle, { unit: '°', min: -3600, max: 3600 });
      break;
    }
  }
  return result;
}

const vectorSubtract = (a, b) => a.map((value, i) => value - b[i]);
const dot = (a, b) => a.reduce((value, x, i) => value + x * b[i], 0);
/** 线段间最短距离，用包围胶囊保守诊断螺纹与既有孔/键槽的碰撞。 */
function segmentDistance(p0, p1, q0, q1) {
  const u = vectorSubtract(p1, p0), v = vectorSubtract(q1, q0), w = vectorSubtract(p0, q0);
  const a = dot(u, u), b = dot(u, v), c = dot(v, v), d = dot(u, w), e = dot(v, w);
  if (a <= EPS && c <= EPS) return Math.hypot(...w);
  let s = 0, t = 0;
  if (a <= EPS) t = Math.max(0, Math.min(1, e / c));
  else if (c <= EPS) s = Math.max(0, Math.min(1, -d / a));
  else {
    const determinant = a * c - b * b;
    s = determinant > EPS ? Math.max(0, Math.min(1, (b * e - c * d) / determinant)) : 0;
    t = (b * s + e) / c;
    if (t < 0) { t = 0; s = Math.max(0, Math.min(1, -d / a)); }
    else if (t > 1) { t = 1; s = Math.max(0, Math.min(1, (b - d) / a)); }
  }
  return Math.hypot(...w.map((x, i) => x + s * u[i] - t * v[i]));
}

function holeAxes(model, hole, threadOnly = false) {
  const total = modelLength(model), radial = hole.placement === 'radial';
  const resolved = radial ? resolveRadialHole(model, hole) : null;
  const depth = radial ? resolved.effectiveDepth : ('through' in hole ? hole.through : hole.termination === 'through-all') ? total : hole.depth;
  const from = threadOnly ? hole.thread.offset : 0, to = threadOnly ? from + hole.thread.length : depth;
  const radius = (threadOnly ? hole.thread.nominal : hole.diameter) / 2;
  const result = [];
  for (let i = 0; i < hole.count; i++) {
    const angle = (hole.angle + 360 * i / hole.count) * Math.PI / 180;
    let at;
    if (radial) at = (distance) => [resolved.x, (resolved.outerRadius - distance) * Math.cos(angle), (resolved.outerRadius - distance) * Math.sin(angle)];
    else at = (distance) => [hole.face === 'left' ? distance : total - distance,
      hole.pcd / 2 * Math.cos(angle), hole.pcd / 2 * Math.sin(angle)];
    result.push({ start: at(from), end: at(to), radius });
    if (!threadOnly && hole.counterboreDepth > 0 && hole.counterboreDiameter > 0) result.push({ start: at(0), end: at(hole.counterboreDepth), radius: hole.counterboreDiameter / 2 });
  }
  return result;
}

function threadCollision(model, feature, layout) {
  const axes = holeAxes(model, feature, true), obstacles = [];
  for (const hole of [...(model.holes ?? []).filter((h) => h.enabled), ...previousFeatures(model, feature).filter((f) => f.type === 'hole')]) {
    obstacles.push(...holeAxes(model, hole).map((axis) => ({ ...axis, label: featureLabel(hole) })));
  }
  for (const key of (model.keyways ?? []).filter((k) => k.enabled)) {
    const host = layout.find((s) => s.id === key.segmentId);
    if (!host) continue;
    const length = key.ends === 'woodruff' ? 2 * Math.sqrt(key.depth * ((key.cutterDiameter ?? 24) - key.depth)) : key.length;
    const start = host.start + key.position, end = start + length;
    const surface = host.type === 'cone' ? Math.min(outerRadiusAt(host, start), outerRadiusAt(host, end)) : host.rootDiameter / 2;
    const centerRadius = surface - key.depth / 2, angle = key.angle * Math.PI / 180;
    obstacles.push({ start: [start, centerRadius * Math.cos(angle), centerRadius * Math.sin(angle)],
      end: [end, centerRadius * Math.cos(angle), centerRadius * Math.sin(angle)],
      radius: Math.hypot(key.depth / 2, key.width / 2), label: `已有外键槽（${key.id}）` });
  }
  for (const key of previousFeatures(model, feature).filter((f) => f.type === 'internal-keyway')) {
    const host = resolveBoreHost(model, key).boreSegment, r = host.diameter / 2;
    const bottom = Math.sqrt(Math.max(0, r ** 2 - (key.width / 2) ** 2));
    const centerRadius = (bottom + r + key.depth) / 2, angle = key.angle * Math.PI / 180;
    obstacles.push({ start: [host.start + key.position, centerRadius * Math.cos(angle), centerRadius * Math.sin(angle)],
      end: [host.start + key.position + key.length, centerRadius * Math.cos(angle), centerRadius * Math.sin(angle)],
      radius: Math.hypot((r + key.depth - bottom) / 2, key.width / 2), label: featureLabel(key) });
  }
  for (const axis of axes) for (const obstacle of obstacles) {
    if (segmentDistance(axis.start, axis.end, obstacle.start, obstacle.end) < axis.radius + obstacle.radius - EPS) return obstacle.label;
  }
  return null;
}

/** 有序特征校验。只允许引用已成功定义且启用的上游内腔，避免悬空或循环依赖。 */
export function validateFeatures(model, context = {}) {
  const errors = [], warnings = [];
  if (!Array.isArray(model.features)) return { errors: ['v2 工程的 features 必须为数组。'], warnings };
  if (model.features.length + (model.keyways?.length ?? 0) + (model.holes?.length ?? 0) > LIMITS.features) {
    return { errors: [`所有键槽、孔组与新特征的总数不能超过${LIMITS.features}。`], warnings };
  }
  const layout = context.outerLayout ?? getOuterLayout(model), total = modelLength(model);
  const ids = new Set([...(model.segments ?? []), ...(model.keyways ?? []), ...(model.holes ?? [])].map((s) => s?.id));
  const accepted = [];
  let totalBoreSegments = 0, totalHoles = (model.holes ?? []).reduce((n, h) => n + (h.enabled ? h.count : 0), 0);
  const checkNumber = (v, label, min, max, integer = false, active = true) => {
    if (!finite(v)) { errors.push(`${label}必须是有限数字。`); return false; }
    if (integer && !Number.isInteger(v)) { errors.push(`${label}必须为整数。`); return false; }
    if (active && (v < min || v > max)) { errors.push(`${label}必须在${min}～${max}之间。`); return false; }
    return true;
  };
  const checkId = (item, label) => {
    if (!object(item)) { errors.push(`${label}必须为对象。`); return false; }
    if (typeof item.id !== 'string' || !item.id || item.id.length > 100) errors.push(`${label}的 id 必须是1～100个字符。`);
    else if (ids.has(item.id)) errors.push(`${label}存在重复 id：${item.id}。`);
    else ids.add(item.id);
    if (typeof item.name !== 'string' || !item.name.trim() || item.name.length > 100) errors.push(`${label}名称必须为1～100个字符。`);
    return true;
  };
  const reference = (value, label) => {
    if (typeof value !== 'string' || value.length > 100) errors.push(`${label}必须为不超过100字符的 id 文本。`);
  };
  const safeWall = (feature, start, end, innerRadiusAt, description = '剩余壁厚') => {
    for (const outer of overlapPieces(layout, start, end)) for (const x of outerPoints(outer, start, end)) {
      if (outerRadiusAt(outer, x) - innerRadiusAt(x) < MIN_WALL - EPS) {
        errors.push(`${featureLabel(feature)}${description}不足${MIN_WALL} mm，位置 X=${Number(x.toFixed(4))}。`);
        return false;
      }
    }
    for (const groove of accepted.filter((f) => f.enabled && f.type === 'groove' && f.location === 'outer')) {
      const host = layout.find((s) => s.id === groove.segmentId);
      if (!host) continue;
      const a = Math.max(start, host.start + groove.position), b = Math.min(end, host.start + groove.position + groove.width);
      if (b > a + EPS && host.diameter / 2 - groove.depth - Math.max(innerRadiusAt(a), innerRadiusAt(b)) < MIN_WALL - EPS) {
        errors.push(`${featureLabel(feature)}与上游外环槽共同切穿壁厚。`); return false;
      }
    }
    return true;
  };
  const innerMax = (currentModel, feature, start, end) => {
    let radius = 0;
    for (const bore of previousBores(currentModel, feature)) for (const s of getBoreLayout(currentModel, bore)) {
      const a = Math.max(start, s.start), b = Math.min(end, s.end);
      if (b > a + EPS) radius = Math.max(radius, boreRadiusAt(s, a), boreRadiusAt(s, b));
    }
    for (const f of previousFeatures(currentModel, feature)) {
      if (!((f.type === 'groove' && f.location === 'inner') || f.type === 'internal-keyway')) continue;
      const host = resolveBoreHost(currentModel, f).boreSegment, a = host.start + f.position;
      const b = a + (f.type === 'groove' ? f.width : f.length);
      if (Math.min(b, end) <= Math.max(a, start) + EPS) continue;
      const envelope = f.type === 'groove' ? host.diameter / 2 + f.depth : Math.hypot(host.diameter / 2 + f.depth, f.width / 2);
      radius = Math.max(radius, envelope);
    }
    // 旧中心端面孔仍是实体中的空腔，新增环槽不能把它切断。
    for (const hole of model.holes ?? []) {
      if (!hole.enabled || hole.pcd !== 0 || hole.count !== 1) continue;
      const depth = hole.through ? total : hole.depth;
      const a = hole.face === 'left' ? 0 : total - depth, b = hole.face === 'left' ? depth : total;
      if (Math.min(b, end) > Math.max(a, start) + EPS) radius = Math.max(radius, hole.diameter / 2);
      const ca = hole.face === 'left' ? 0 : total - hole.counterboreDepth;
      const cb = hole.face === 'left' ? hole.counterboreDepth : total;
      if (hole.counterboreDepth > 0 && Math.min(cb, end) > Math.max(ca, start) + EPS) radius = Math.max(radius, hole.counterboreDiameter / 2);
    }
    return radius;
  };
  for (const [index, feature] of model.features.entries()) {
    const begin = errors.length, label = featureLabel(feature);
    if (!checkId(feature, `特征${index + 1}`)) continue;
    if (!['bore', 'hole', 'groove', 'internal-keyway'].includes(feature.type)) { errors.push(`${label}类型不受支持。`); continue; }
    if (typeof feature.enabled !== 'boolean') errors.push(`${label}启用状态必须为布尔值。`);
    const active = feature.enabled === true;
    const number = (key, title, min, max, integer = false, used = true) =>
      checkNumber(feature[key], `${label}${title}`, min, max, integer, active && used);
    const currentModel = { ...model, features: [...accepted, feature] };
    switch (feature.type) {
      case 'bore': {
        if (!['left', 'right'].includes(feature.face)) errors.push(`${label}入口必须为 left 或 right。`);
        if (!['blind', 'through-all'].includes(feature.termination)) errors.push(`${label}终止模式必须为 blind 或 through-all。`);
        number('offset', '入口偏移', 0, LIMITS.maxTotalLength);
        if (!Array.isArray(feature.segments) || feature.segments.length < 1 || feature.segments.length > LIMITS.segments) {
          errors.push(`${label}内阶梯数量必须为1～${LIMITS.segments}。`); break;
        }
        totalBoreSegments += feature.segments.length;
        for (const [n, segment] of feature.segments.entries()) {
          const sl = `${label}内阶梯${n + 1}`;
          if (!checkId(segment, sl)) continue;
          if (!['cylinder', 'cone'].includes(segment.type)) errors.push(`${sl}仅支持 cylinder 或 cone。`);
          const derived = feature.termination === 'through-all' && n === feature.segments.length - 1;
          checkNumber(segment.length, `${sl}长度${derived ? '草稿' : ''}`, LIMITS.minLength, LIMITS.maxLength, false, active && !derived);
          checkNumber(segment.diameter, `${sl}内径`, LIMITS.minDiameter, LIMITS.maxDiameter, false, active);
          checkNumber(segment.endDiameter, `${sl}末端直径`, LIMITS.minDiameter, LIMITS.maxDiameter, false, active && segment.type === 'cone');
        }
        if (errors.length !== begin || !active) break;
        const inner = getBoreLayout(currentModel, feature), last = inner.at(-1);
        for (const s of inner) {
          if (s.length < LIMITS.minLength - EPS || s.length > LIMITS.maxTotalLength || s.start < -EPS || s.end > total + EPS) {
            errors.push(`${label}内阶梯超出零件轴向范围，或派生长度小于${LIMITS.minLength} mm。`); continue;
          }
          safeWall(feature, s.start, s.end, (x) => boreRadiusAt(s, x));
          for (const key of (model.keyways ?? []).filter((k) => k.enabled)) {
            const outer = layout.find((o) => o.id === key.segmentId);
            const keyLength = key.ends === 'woodruff' ? 2 * Math.sqrt(key.depth * ((key.cutterDiameter ?? 24) - key.depth)) : key.length;
            const a = Math.max(s.start, outer.start + key.position), b = Math.min(s.end, outer.start + key.position + keyLength);
            if (b > a + EPS && minOuterRadius(layout, a, b) - key.depth - Math.max(boreRadiusAt(s, a), boreRadiusAt(s, b)) < MIN_WALL - EPS) {
              errors.push(`${label}切入已有外键槽底部，剩余壁厚不足${MIN_WALL} mm。`);
            }
          }
        }
        if (feature.termination === 'blind' && total - feature.offset - inner.reduce((s, p) => s + p.length, 0) < MIN_WALL - EPS) {
          errors.push(`${label}盲腔对侧底厚必须至少为${MIN_WALL} mm；穿透请改为贯穿全部。`);
        }
        if (feature.offset > 0) warnings.push(`${label}入口偏移保留${feature.offset} mm封口材料；刀具不会自动切开偏移区域。`);
        if (!finite(last?.end)) errors.push(`${label}内腔布局无法计算。`);
        break;
      }
      case 'hole': {
        if (!['end', 'radial'].includes(feature.placement)) errors.push(`${label}孔位置必须为 end 或 radial。`);
        if (!['left', 'right'].includes(feature.face)) errors.push(`${label}端面方向必须为 left 或 right。`);
        if (!['blind', 'through-all', 'through-wall'].includes(feature.termination)) errors.push(`${label}孔终止模式不受支持。`);
        reference(feature.segmentId, `${label}宿主阶梯`); reference(feature.boreId, `${label}目标内腔`);
        number('position', '轴向位置', 0, LIMITS.maxLength, false, feature.placement === 'radial');
        number('angle', '角度', -3600, 3600);
        number('count', '阵列数量', 1, LIMITS.holesPerPattern, true);
        number('pcd', '分布圆直径', 0, LIMITS.maxDiameter, false, feature.placement === 'end');
        number('diameter', '孔径', 0.1, LIMITS.maxDiameter);
        number('depth', '钻孔深度', 0.1, LIMITS.maxTotalLength, false, feature.termination === 'blind');
        number('counterboreDiameter', '沉孔直径', 0, LIMITS.maxDiameter);
        number('counterboreDepth', '沉孔深度', 0, LIMITS.maxTotalLength);
        const thread = feature.thread;
        if (!object(thread)) errors.push(`${label}缺少螺纹参数对象。`);
        else {
          if (typeof thread.enabled !== 'boolean') errors.push(`${label}螺纹启用状态必须为布尔值。`);
          if (!['left', 'right'].includes(thread.hand)) errors.push(`${label}螺纹旋向必须为 left 或 right。`);
          if (typeof thread.toleranceClass !== 'string' || !thread.toleranceClass.trim() || thread.toleranceClass.length > 20) errors.push(`${label}螺纹公差带必须为1～20字符。`);
          const on = active && thread.enabled;
          checkNumber(thread.nominal, `${label}螺纹公称直径`, 0.5, LIMITS.maxDiameter, false, on);
          checkNumber(thread.pitch, `${label}螺距`, 0.1, 100, false, on);
          checkNumber(thread.length, `${label}有效螺纹长度`, 0.1, LIMITS.maxTotalLength, false, on);
          checkNumber(thread.offset, `${label}螺纹起始偏移`, 0, LIMITS.maxTotalLength, false, on);
        }
        if (errors.length !== begin || !active) break;
        totalHoles += feature.count;
        const cb = feature.counterboreDiameter > 0 || feature.counterboreDepth > 0;
        if (cb && (feature.counterboreDiameter <= feature.diameter || feature.counterboreDepth <= 0)) errors.push(`${label}沉孔直径必须大于底孔直径，且沉孔深度必须大于0。`);
        const envelopeRadius = Math.max(feature.diameter, cb ? feature.counterboreDiameter : 0, thread.enabled ? thread.nominal : 0) / 2;
        let effectiveDepth, threadStart = cb ? feature.counterboreDepth : 0, threadEnd;
        if (feature.placement === 'radial') {
          let resolved;
          try { resolved = resolveRadialHole(currentModel, feature); } catch (error) { errors.push(error.message); break; }
          const { host, x, outerRadius, innerRadius, boreSegment } = resolved;
          effectiveDepth = resolved.effectiveDepth; threadStart = resolved.threadStart; threadEnd = resolved.threadEnd;
          const run = chamferRun(host);
          if (x - envelopeRadius < host.start + run.left - EPS || x + envelopeRadius > host.end - run.right + EPS) errors.push(`${label}整个孔截面必须落在同一外圆柱的非倒角区间内。`);
          if (envelopeRadius >= outerRadius - MIN_WALL) errors.push(`${label}孔或螺纹包络半径必须小于宿主外半径。`);
          if (feature.termination === 'blind' && feature.depth >= 2 * outerRadius - MIN_WALL) errors.push(`${label}径向盲孔深度必须小于宿主直径；贯穿背壁请使用贯穿全部。`);
          const sag = (radius) => radius < outerRadius ? outerRadius - Math.sqrt(outerRadius ** 2 - radius ** 2) : Infinity;
          if (feature.termination === 'blind' && feature.depth <= sag(feature.diameter / 2) + EPS) errors.push(`${label}钻孔深度不足以在曲面入口形成完整孔径。`);
          if (cb && feature.counterboreDepth <= sag(feature.counterboreDiameter / 2) + EPS) errors.push(`${label}沉孔深度不足以在曲面入口形成完整沉孔直径。`);
          if (feature.termination === 'through-wall') {
            if (!resolved.bore || !boreSegment) errors.push(`${label}穿当前壁必须引用上游启用内腔，且整个孔截面落在同一内圆柱段内。`);
            else if (envelopeRadius >= innerRadius - MIN_WALL) errors.push(`${label}孔、沉孔或螺纹包络半径必须小于目标内腔半径，才能完整穿过近侧壁。`);
          }
          if (feature.count > 1 && 2 * outerRadius * Math.sin(Math.PI / feature.count) <= 2 * envelopeRadius + MIN_WALL) errors.push(`${label}径向阵列入口重叠，请减少数量或缩小孔径。`);
          if (feature.count > 1 && feature.termination === 'through-all') warnings.push(`${label}径向贯穿阵列可能在轴心或对向孔处连通。`);
          for (const upstream of accepted) {
            if (upstream.type === 'groove' && upstream.enabled && upstream.location === 'outer' && upstream.segmentId === host.id &&
              Math.min(x + envelopeRadius, host.start + upstream.position + upstream.width) > Math.max(x - envelopeRadius, host.start + upstream.position) + EPS) {
              errors.push(`${label}与上游外环槽交叠，当前径向入口不再是完整外圆柱，请移动孔或环槽。`);
            }
          }
        } else {
          if (feature.termination === 'through-wall') { errors.push(`${label}穿当前壁只支持径向孔；端面孔请选择盲孔或贯穿全部。`); break; }
          effectiveDepth = feature.termination === 'through-all' ? total : feature.depth;
          threadEnd = effectiveDepth;
          if (feature.termination === 'blind' && feature.depth >= total - MIN_WALL) errors.push(`${label}端面盲孔深度必须小于零件总长；穿透请使用贯穿全部。`);
          if (feature.count > 1 && feature.pcd <= 0) errors.push(`${label}端面多孔阵列需要大于0的分布圆直径。`);
          if (feature.count > 1 && feature.pcd * Math.sin(Math.PI / feature.count) <= 2 * envelopeRadius + MIN_WALL) errors.push(`${label}相邻端面孔或沉孔重叠。`);
          const outer = feature.face === 'left' ? layout[0] : layout.at(-1), entryX = feature.face === 'left' ? 0 : total;
          if (feature.pcd / 2 + envelopeRadius >= outerRadiusAt(outer, entryX) - MIN_WALL) errors.push(`${label}孔、沉孔或螺纹包络超出入口端面的外边界。`);
          // 螺纹必须从入口起存在连续完整材料；中心内腔穿过牙型包络时在其首个交点终止。
          const a = (thread.enabled ? thread.nominal : feature.diameter) / 2, center = feature.pcd / 2;
          const minR = Math.max(0, center - a), maxR = center + a;
          for (const bore of previousBores(currentModel, feature)) for (const s of getBoreLayout(currentModel, bore)) {
            const d0 = feature.face === 'left' ? s.start : total - s.end;
            const d1 = feature.face === 'left' ? s.end : total - s.start;
            const r0 = feature.face === 'left' ? s.diameter / 2 : s.endDiameter / 2;
            const r1 = feature.face === 'left' ? s.endDiameter / 2 : s.diameter / 2;
            if (d0 <= EPS && r0 >= center + feature.diameter / 2 - EPS) errors.push(`${label}入口孔截面完全位于已有内腔，不能形成新的端面孔。`);
            if (Math.max(r0, r1) > minR + EPS) {
              const first = r0 > minR + EPS ? d0 : d0 + (d1 - d0) * (minR - r0) / (r1 - r0);
              threadEnd = Math.min(threadEnd, first);
            }
          }
          if (thread.enabled) {
            const start = feature.face === 'left' ? thread.offset : total - thread.offset - thread.length;
            const end = start + thread.length;
            if (minOuterRadius(layout, start, end) < maxR + MIN_WALL - EPS) errors.push(`${label}螺纹有效牙段超出连续外壁材料。`);
          }
        }
        if (cb && feature.counterboreDepth >= effectiveDepth - EPS) errors.push(`${label}沉孔深度必须小于主孔有效深度。`);
        if (thread.enabled) {
          if (thread.nominal <= feature.diameter + EPS) errors.push(`${label}螺纹公称直径必须大于切削底孔直径。`);
          if (thread.pitch >= thread.nominal / 2) errors.push(`${label}螺距过大，无法形成合理的公制螺纹语义。`);
          if (thread.offset < threadStart - EPS) errors.push(`${label}螺纹起始偏移至少为${Number(threadStart.toFixed(6))} mm，以避开曲面入口或沉孔。`);
          if (thread.offset + thread.length > threadEnd + EPS) errors.push(`${label}有效螺纹长度超出钻深或近侧连续壁厚，不能跨越内腔计入背壁。`);
          if (errors.length === begin) {
            const collision = threadCollision(currentModel, feature, layout);
            if (collision) errors.push(`${label}螺纹包络可能与${collision}相交，当前无法保证完整有效牙段，请移动特征或取消螺纹语义。`);
          }
          warnings.push(`${label}仅保存螺纹规格与底孔实体，未生成真实牙形或制造级螺纹标注。`);
        }
        break;
      }
      case 'groove':
      case 'internal-keyway': {
        const groove = feature.type === 'groove', outer = groove && feature.location === 'outer';
        if (groove && !['outer', 'inner'].includes(feature.location)) errors.push(`${label}环槽位置必须为 outer 或 inner。`);
        if (groove) reference(feature.segmentId, `${label}宿主阶梯`);
        reference(feature.boreId, `${label}宿主内腔`); reference(feature.boreSegmentId, `${label}宿主内阶梯`);
        number('position', '轴向起点', 0, LIMITS.maxTotalLength);
        number('width', groove ? '轴向宽度' : '槽宽', 0.1, groove ? LIMITS.maxLength : LIMITS.maxDiameter);
        number('depth', '径向深度', 0.05, LIMITS.maxDiameter);
        if (!groove) { number('length', '轴向长度', LIMITS.minLength, LIMITS.maxLength); number('angle', '周向角度', -3600, 3600); }
        if (errors.length !== begin || !active) break;
        let host;
        if (outer) {
          host = layout.find((s) => s.id === feature.segmentId);
          if (!host || host.type !== 'cylinder') { errors.push(`${label}外环槽必须引用外圆柱阶梯。`); break; }
        } else {
          try { host = resolveBoreHost(currentModel, feature).boreSegment; } catch (error) { errors.push(error.message); break; }
          if (host.type !== 'cylinder') { errors.push(`${label}仅支持内圆柱阶梯，不支持内锥面。`); break; }
        }
        const length = groove ? feature.width : feature.length, start = host.start + feature.position, end = start + length;
        if (feature.position + length > host.length + EPS) errors.push(`${label}轴向范围超出所属圆柱阶梯。`);
        if (outer) {
          const run = chamferRun(host);
          if (start < host.start + run.left - EPS || end > host.end - run.right + EPS) errors.push(`${label}外环槽不能跨入宿主端部倒角。`);
          const remaining = host.diameter / 2 - feature.depth;
          if (remaining < MIN_WALL || remaining - innerMax(currentModel, feature, start, end) < MIN_WALL - EPS) errors.push(`${label}环槽切穿内腔或剩余壁厚不足${MIN_WALL} mm。`);
        } else {
          const r = host.diameter / 2;
          if (!groove && feature.width >= host.diameter - MIN_WALL) errors.push(`${label}内键槽宽度必须小于内孔直径。`);
          const envelope = groove ? r + feature.depth : Math.hypot(r + feature.depth, feature.width / 2);
          safeWall(feature, start, end, () => envelope, '槽底及外角剩余壁厚');
          for (const upstream of accepted) {
            if (upstream.type !== 'groove' || !upstream.enabled || upstream.location !== 'outer') continue;
            const s = layout.find((p) => p.id === upstream.segmentId);
            if (s && Math.min(end, s.start + upstream.position + upstream.width) > Math.max(start, s.start + upstream.position) + EPS &&
              envelope > s.diameter / 2 - upstream.depth - MIN_WALL + EPS) errors.push(`${label}与上游外环槽共同切穿壁厚。`);
          }
        }
        break;
      }
    }
    if (errors.length === begin) accepted.push(feature);
  }
  if (totalBoreSegments > LIMITS.boreSegments) errors.push(`所有内腔阶梯总数不能超过${LIMITS.boreSegments}。`);
  if (totalHoles > LIMITS.totalHoles) errors.push(`启用孔的总数量不能超过${LIMITS.totalHoles}。`);
  // 语义螺纹在最终实体上也必须成立：后续内腔/孔/槽同样不能破坏先前声明的有效牙段。
  if (!errors.length) for (const hole of accepted.filter((f) => f.enabled && f.type === 'hole' && f.thread.enabled)) {
    const label = featureLabel(hole), thread = hole.thread;
    const finalModel = { ...model, features: [...accepted.filter((f) => f.id !== hole.id), hole] };
    if (hole.placement === 'radial') {
      const resolved = resolveRadialHole(finalModel, hole);
      if (thread.offset + thread.length > resolved.threadEnd + EPS) errors.push(`${label}后续内腔或内环槽切入有效螺纹段，请缩短牙长或移动特征。`);
      for (const groove of accepted.filter((f) => f.enabled && f.type === 'groove' && f.location === 'outer' && f.segmentId === hole.segmentId)) {
        const a = resolved.host.start + groove.position, b = a + groove.width;
        if (Math.min(b, resolved.x + thread.nominal / 2) > Math.max(a, resolved.x - thread.nominal / 2) + EPS) {
          errors.push(`${label}外环槽破坏了螺纹曲面入口的完整材料，请错开轴向位置。`);
        }
      }
    } else {
      const minimumRadius = Math.max(0, hole.pcd / 2 - thread.nominal / 2);
      let limit = hole.termination === 'through-all' ? total : hole.depth;
      for (const bore of previousBores(finalModel, hole)) for (const s of getBoreLayout(finalModel, bore)) {
        const d0 = hole.face === 'left' ? s.start : total - s.end, d1 = hole.face === 'left' ? s.end : total - s.start;
        const r0 = hole.face === 'left' ? s.diameter / 2 : s.endDiameter / 2;
        const r1 = hole.face === 'left' ? s.endDiameter / 2 : s.diameter / 2;
        if (Math.max(r0, r1) > minimumRadius + EPS) {
          limit = Math.min(limit, r0 > minimumRadius + EPS ? d0 : d0 + (d1 - d0) * (minimumRadius - r0) / (r1 - r0));
        }
      }
      const start = hole.face === 'left' ? thread.offset : total - thread.offset - thread.length, end = start + thread.length;
      for (const groove of accepted.filter((f) => f.enabled && f.type === 'groove')) {
        if (groove.location === 'inner') {
          const host = resolveBoreHost(finalModel, groove).boreSegment;
          if (host.diameter / 2 + groove.depth <= minimumRadius + EPS) continue;
          const a = host.start + groove.position, b = a + groove.width;
          limit = Math.min(limit, hole.face === 'left' ? a : total - b);
        } else {
          const host = layout.find((s) => s.id === groove.segmentId), a = host.start + groove.position, b = a + groove.width;
          if (Math.min(end, b) > Math.max(start, a) + EPS && hole.pcd / 2 + thread.nominal / 2 > host.diameter / 2 - groove.depth - MIN_WALL + EPS) {
            errors.push(`${label}外环槽切入有效螺纹的外侧材料。`);
          }
        }
      }
      if (thread.offset + thread.length > limit + EPS) errors.push(`${label}最终内腔或内环槽切入有效螺纹段，不能把空腔计入牙长。`);
    }
    const collision = threadCollision(finalModel, hole, layout);
    if (collision) errors.push(`${label}最终螺纹包络可能与${collision}相交，请移动特征或取消螺纹语义。`);
  }
  const activeBores = accepted.filter((f) => f.enabled && f.type === 'bore');
  for (let i = 0; i < activeBores.length; i++) for (let j = i + 1; j < activeBores.length; j++) {
    const a = getBoreLayout(model, activeBores[i]), b = getBoreLayout(model, activeBores[j]);
    if (a.some((sa) => b.some((sb) => Math.min(sa.end, sb.end) >= Math.max(sa.start, sb.start) - EPS))) {
      warnings.push(`${featureLabel(activeBores[i])}与${featureLabel(activeBores[j])}已经连通；单腔到端面的轴向余量不代表实际封底厚度。`);
    }
  }
  return { errors: [...new Set(errors)], warnings: [...new Set(warnings)] };
}

// 模板基体保持 v1 外轮廓字段齐全，继续交给原有圆柱/锥面/齿轮生成器。
const sampleOuter = (overrides) => ({ id: uid('outer'), name: '外圆阶梯', type: 'cylinder', length: 30, diameter: 50,
  endDiameter: 50, chamferLeft: 0, chamferRight: 0, gear: { teeth: 24, module: 2, pressureAngle: 20, rotation: 0,
    addendum: 1, dedendum: 1.25, backlash: 0 }, ...overrides });
const sampleModel = (name, partFamily, segments, features) => ({ schemaVersion: 2, name, partFamily,
  material: 'steel', quality: 'standard', segments, keyways: [], holes: [], features });
const disk = sampleModel('六孔法兰盘', 'disk', [
  sampleOuter({ id: 'disk-flange', name: '法兰盘体', length: 18, diameter: 100, endDiameter: 100, chamferLeft: 0.8 }),
  sampleOuter({ id: 'disk-hub', name: '定位轮毂', length: 12, diameter: 54, endDiameter: 54, chamferRight: 0.6 }),
], [
  createFeature('bore', { id: 'disk-bore', name: '中心定位通孔', face: 'left', termination: 'through-all',
    segments: [createBoreSegment({ id: 'disk-inner', name: '中心孔', diameter: 28, endDiameter: 28, length: 30 })] }),
  createFeature('hole', { id: 'disk-bolts', name: '法兰六孔阵列', face: 'left', termination: 'through-all',
    diameter: 6.6, count: 6, pcd: 76, counterboreDiameter: 11, counterboreDepth: 4 }),
  createFeature('groove', { id: 'disk-groove', name: '轮毂外环槽', segmentId: 'disk-hub', position: 4, width: 2, depth: 1 }),
]);
const independentSleeve = sampleModel('独立内阶梯套', 'sleeve', [
  sampleOuter({ id: 'tube-left', name: '左定位外圆', length: 20, diameter: 54, endDiameter: 54, chamferLeft: 0.8 }),
  sampleOuter({ id: 'tube-body', name: '套筒主体', length: 60, diameter: 62, endDiameter: 62 }),
  sampleOuter({ id: 'tube-right', name: '右定位外圆', length: 20, diameter: 54, endDiameter: 54, chamferRight: 0.8 }),
], [
  createFeature('bore', { id: 'tube-bore', name: '四级独立内轮廓', face: 'left', termination: 'through-all', segments: [
    createBoreSegment({ id: 'tube-in-1', name: '入口内圆', length: 18, diameter: 32, endDiameter: 32 }),
    createBoreSegment({ id: 'tube-in-2', name: '内锥过渡', type: 'cone', length: 12, diameter: 32, endDiameter: 38 }),
    createBoreSegment({ id: 'tube-in-3', name: '主内孔', length: 55, diameter: 38, endDiameter: 38 }),
    createBoreSegment({ id: 'tube-in-4', name: '末端内圆', length: 15, diameter: 34, endDiameter: 34 }),
  ] }),
  createFeature('groove', { id: 'tube-seal', name: '内密封环槽', location: 'inner', boreId: 'tube-bore', boreSegmentId: 'tube-in-3', position: 10, width: 3, depth: 1.2 }),
  createFeature('internal-keyway', { id: 'tube-key', name: '内孔键槽', boreId: 'tube-bore', boreSegmentId: 'tube-in-3', position: 20, length: 24, width: 6, depth: 2 }),
]);
const cup = sampleModel('杯形安装壳', 'housing', [
  sampleOuter({ id: 'cup-base', name: '安装法兰', length: 8, diameter: 96, endDiameter: 96, chamferLeft: 0.8 }),
  sampleOuter({ id: 'cup-body', name: '壳体外圆', length: 72, diameter: 80, endDiameter: 80, chamferRight: 0.8 }),
], [
  createFeature('bore', { id: 'cup-cavity', name: '杯形盲腔', face: 'right', termination: 'blind',
    segments: [createBoreSegment({ id: 'cup-inner', name: '圆柱内腔', length: 62, diameter: 60, endDiameter: 60 })] }),
  createFeature('hole', { id: 'cup-radial', name: 'M6 径向紧定孔', placement: 'radial', segmentId: 'cup-body', position: 38,
    termination: 'through-wall', boreId: 'cup-cavity', diameter: 5, count: 2, thread: { enabled: true, nominal: 6, pitch: 1, length: 6, offset: 0.5 } }),
  createFeature('groove', { id: 'cup-seal', name: '壳体外环槽', segmentId: 'cup-body', position: 57, width: 3, depth: 1.5 }),
]);

export const ROTATIONAL_PRESETS = [
  { id: 'flange-disk', name: '六孔法兰盘', description: '独立中心通孔 · 六孔贯穿阵列 · 轮毂环槽', model: disk },
  { id: 'independent-sleeve', name: '独立内阶梯套', description: '内外阶梯独立 · 内锥过渡 · 内环槽与内键槽', model: independentSleeve },
  { id: 'cup-housing', name: '杯形安装壳', description: '可控底厚盲腔 · 径向穿壁孔 · M6 螺纹语义', model: cup },
];
