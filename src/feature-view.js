import { getChamferRun, getSegmentLayout, segmentRadiusAt } from './schema.js';
import { getBoreLayout, getFeatureDimensions, resolveRadialHole } from './features.js';

// 所有坐标均为毫米；本模块不依赖 Three.js、DOM 或几何内核。
const TAU = Math.PI * 2;
const X = [1, 0, 0];
const Y = [0, 1, 0];
const Z = [0, 0, 1];
const add = (a, b) => a.map((value, index) => value + b[index]);
const scale = (a, factor) => a.map((value) => value * factor);
const middle = (a, b) => a.map((value, index) => (value + b[index]) / 2);
const fmt = (value) => Number(value.toFixed(3)).toLocaleString('zh-CN', { maximumFractionDigits: 3 });
const radians = (degrees) => degrees * Math.PI / 180;
const radial = (degrees) => [0, Math.cos(radians(degrees)), Math.sin(radians(degrees))];
const tangent = (degrees) => [0, -Math.sin(radians(degrees)), Math.cos(radians(degrees))];

function line(points, a, b) { points.push(...a, ...b); }

function circle(points, center, radius, u = Y, v = Z, sections = 48) {
  if (!(radius > 0)) return;
  const at = (angle) => add(center, add(scale(u, radius * Math.cos(angle)), scale(v, radius * Math.sin(angle))));
  for (let index = 0; index < sections; index++) line(points, at(TAU * index / sections), at(TAU * (index + 1) / sections));
}

function arc(points, x, radius, angle) {
  if (!(radius > 0)) return;
  const sweep = angle % 360;
  const count = Math.max(1, Math.ceil(Math.abs(sweep) / 7.5));
  for (let index = 0; index < count; index++) {
    line(points, add([x, 0, 0], scale(radial(sweep * index / count), radius)), add([x, 0, 0], scale(radial(sweep * (index + 1) / count), radius)));
  }
}

/** 尺寸线由真实测量点引出；偏移只改变标注位置，不改变建模参数。 */
function dimension(a, b, offset, tickDirection, spacing) {
  const start = add(a, offset), end = add(b, offset), points = [];
  line(points, start, end);
  line(points, a, start);
  line(points, b, end);
  const tick = scale(tickDirection, Math.max(0.8, spacing * 0.23));
  for (const point of [start, end]) line(points, add(point, scale(tick, -1)), add(point, tick));
  return { lines: points, position: middle(start, end) };
}

function ringProfile(points, start, end, leftRadius, rightRadius) {
  circle(points, [start, 0, 0], leftRadius);
  circle(points, [end, 0, 0], rightRadius);
  for (const angle of [0, 90, 180, 270]) line(points, add([start, 0, 0], scale(radial(angle), leftRadius)), add([end, 0, 0], scale(radial(angle), rightRadius)));
}

function resolveFeature(model, featureOrId) {
  return typeof featureOrId === 'string' ? model?.features?.find((feature) => feature.id === featureOrId) : featureOrId;
}

function minimumOuterPosition(layout, start, end) {
  let minimum = { x: (start + end) / 2, radius: Infinity };
  for (const host of layout) {
    const first = Math.max(start, host.start), last = Math.min(end, host.end);
    if (last - first <= 1e-7) continue;
    const run = getChamferRun(host);
    const candidates = [first, last, host.start + run.left, host.end - run.right];
    for (const x of candidates) {
      if (x < first || x > last) continue;
      const radius = segmentRadiusAt(host, x - host.start);
      if (radius < minimum.radius) minimum = { x, radius };
    }
  }
  return minimum;
}

function radiusOnBore(segment, x) {
  const fraction = segment.length > 0 ? Math.max(0, Math.min(1, (x - segment.start) / segment.length)) : 0;
  return (segment.diameter + ((segment.endDiameter ?? segment.diameter) - segment.diameter) * fraction) / 2;
}

function hostFor(model, feature, layout) {
  if (feature.type === 'groove' && feature.location === 'outer') {
    const host = layout.find((segment) => segment.id === feature.segmentId);
    return host ? { ...host, radiusAt: (x) => segmentRadiusAt(host, x - host.start) } : null;
  }
  const bore = model.features?.find((item) => item.id === feature.boreId && item.type === 'bore');
  if (!bore) return null;
  const host = getBoreLayout(model, bore).find((segment) => segment.id === feature.boreSegmentId);
  return host ? { ...host, radiusAt: (x) => radiusOnBore(host, x) } : null;
}

/**
 * 选中特征的尺寸、定位轮廓和语义标签。轮廓仅用于辅助定位，不是新增实体。
 * 内腔 subId 指向入口顺序中的原始子段 ID；右入口的直径字段仍按原始入口定义。
 */
export function getFeatureView(model, featureOrId, subId) {
  const feature = resolveFeature(model, featureOrId);
  const empty = { dimensions: [], markers: [], annotations: [] };
  if (!feature || feature.enabled === false || !Array.isArray(model?.segments) || !model.segments.length) return empty;
  const layout = getSegmentLayout(model);
  const length = layout.at(-1).end;
  const radius = Math.max(...layout.map((segment) => segment.maxDiameter / 2));
  const spacing = Math.max(3, radius * 0.18);
  const specs = getFeatureDimensions(model, feature);
  const dimensions = [], markers = [], annotations = [];
  const specFor = (key, childId) => specs.find((spec) => spec.key === key && (spec.subId || '') === (childId || ''));
  const emit = (key, geometry, options = {}) => {
    const spec = specFor(key, options.subId);
    if (!spec || !Number.isFinite(spec.value)) return;
    const text = options.text ?? `${options.prefix ?? ''}${fmt(spec.value)}${spec.unit === '°' ? '°' : ''}`;
    const unit = spec.unit ?? 'mm';
    dimensions.push({
      target: { kind: 'feature-parameter', id: feature.id, key, ...(options.subId ? { subId: options.subId } : {}) },
      text, label: `${spec.title}，当前 ${fmt(spec.value)}${unit ? ` ${unit}` : ''}${spec.editable === false ? '，由其他参数联动' : ''}`,
      position: geometry.position, lines: geometry.lines || [], editable: spec.editable !== false,
      value: spec.value, unit,
    });
  };
  const annotate = (text, label, position, childId) => annotations.push({
    text, label, position, target: { kind: 'feature-select', id: feature.id, ...(childId ? { subId: childId } : {}) },
  });

  if (feature.type === 'bore') {
    const boreLayout = getBoreLayout(model, feature);
    if (!boreLayout.length) return empty;
    boreLayout.forEach((segment) => ringProfile(markers, segment.start, segment.end, segment.diameter / 2, segment.endDiameter / 2));
    // 多段内腔只展开正在编辑的一段；少量子段在没有明确选择时可一起显示。
    const chosen = boreLayout.find((segment) => segment.id === subId);
    const shown = chosen ? [chosen] : boreLayout.length <= 3 ? boreLayout : [boreLayout[0]];
    shown.forEach((segment, index) => {
      const z = radius + spacing * 1.2;
      const y = -radius - spacing * (2.1 + index * 1.5);
      emit('length', dimension([segment.start, 0, 0], [segment.end, 0, 0], [0, y, z], Y, spacing), { subId: segment.id, prefix: 'L ' });
      const fromRight = feature.face === 'right';
      const source = feature.segments.find((item) => item.id === segment.id);
      const entranceX = fromRight ? segment.end : segment.start;
      const exitX = fromRight ? segment.start : segment.end;
      const diameterKeys = source?.type === 'cone'
        ? [['diameter', entranceX, '入口 ⌀', false], ['endDiameter', exitX, '末端 ⌀', true]]
        : [['diameter', (segment.start + segment.end) / 2, '内径 ⌀', false]];
      for (const [key, x, prefix, below] of diameterKeys) {
        const spec = specFor(key, segment.id);
        if (!spec) continue;
        const r = spec.value / 2;
        const measure = dimension([x, -r, 0], [x, r, 0], [0, 0, z], X, spacing);
        measure.position = [x, (below ? -1 : 1) * (r + spacing), z];
        emit(key, measure, { subId: segment.id, prefix });
      }
      const wall = specFor('wallThickness', segment.id);
      if (wall) {
        const x = minimumOuterPosition(layout, segment.start, segment.end).x;
        const inner = radiusOnBore(segment, x);
        const measure = dimension([x, inner, 0], [x, inner + wall.value, 0], [0, 0, -radius - spacing], X, spacing);
        measure.position = add(measure.position, [0, spacing, 0]);
        emit('wallThickness', measure, { subId: segment.id, prefix: '壁厚 ' });
      }
    });
    const fromRight = feature.face === 'right';
    const faceX = fromRight ? length : 0;
    const entrance = fromRight ? boreLayout[0].end : boreLayout[0].start;
    const offset = dimension([faceX, 0, 0], [entrance, 0, 0], [0, radius + spacing * 2.2, radius * .45], Y, spacing);
    offset.position = add(offset.position, [0, spacing * .5, 0]);
    emit('offset', offset, { prefix: '偏置 ' });
    const last = boreLayout.at(-1), bottomX = fromRight ? last.start : last.end, oppositeX = fromRight ? 0 : length;
    const bottom = dimension([bottomX, 0, 0], [oppositeX, 0, 0], [0, radius + spacing * 2.2, -radius * .5], Y, spacing);
    bottom.position = add(bottom.position, [0, spacing * .5, 0]);
    emit('bottomThickness', bottom, { prefix: '底厚 ' });
  } else if (feature.type === 'hole') {
    const isRadial = feature.placement === 'radial';
    let center, inward, normal, u, v, effectiveDepth, host, wallThickness;
    if (isRadial) {
      const placement = resolveRadialHole(model, feature);
      if (!placement?.host || !Number.isFinite(placement.x)) return empty;
      host = placement.host;
      normal = radial(feature.angle || 0);
      inward = scale(normal, -1);
      u = X;
      v = tangent(feature.angle || 0);
      center = add([placement.x, 0, 0], scale(normal, placement.outerRadius));
      effectiveDepth = placement.effectiveDepth;
      wallThickness = placement.wallThickness;
    } else {
      const fromRight = feature.face === 'right';
      inward = [fromRight ? -1 : 1, 0, 0];
      normal = scale(inward, -1);
      u = Y;
      v = Z;
      center = add([fromRight ? length : 0, 0, 0], scale(radial(feature.angle || 0), (feature.pcd || 0) / 2));
      effectiveDepth = feature.termination === 'through-all' ? length : feature.depth;
    }
    if (!Number.isFinite(effectiveDepth)) effectiveDepth = feature.depth;
    const holeRadius = feature.diameter / 2;
    const end = add(center, scale(inward, effectiveDepth));
    const count = Math.max(1, feature.count || 1);
    for (let index = 0; index < count; index++) {
      const angle = (feature.angle || 0) + 360 * index / count;
      const direction = isRadial ? scale(radial(angle), -1) : inward;
      const entry = add([center[0], 0, 0], scale(radial(angle), isRadial ? host.diameter / 2 : (feature.pcd || 0) / 2));
      const bottom = add(entry, scale(direction, effectiveDepth));
      const across = isRadial ? tangent(angle) : v;
      circle(markers, entry, holeRadius, u, across);
      // 穿壁刀具止于空腔内，不能在该处画一个看似真实孔底的端圈。
      if (feature.termination !== 'through-wall') circle(markers, bottom, holeRadius, u, across);
      line(markers, entry, bottom);
      for (const sign of [-1, 1]) line(markers, add(entry, scale(u, holeRadius * sign)), add(bottom, scale(u, holeRadius * sign)));
      if (feature.counterboreDiameter > 0 && feature.counterboreDepth > 0) {
        const cbRadius = feature.counterboreDiameter / 2, cbBottom = add(entry, scale(direction, feature.counterboreDepth));
        circle(markers, entry, cbRadius, u, across);
        circle(markers, cbBottom, cbRadius, u, across);
      }
    }
    const dia = dimension(add(center, scale(u, -holeRadius)), add(center, scale(u, holeRadius)), scale(normal, spacing * 1.5), v, spacing);
    dia.position = add(dia.position, scale(v, holeRadius + spacing));
    emit('diameter', dia, { prefix: '⌀' });
    if (feature.termination === 'blind') {
      const depth = dimension(center, end, scale(v, holeRadius + spacing * 1.6), u, spacing);
      depth.position = add(depth.position, scale(v, spacing * .5));
      emit('depth', depth, { prefix: '深 ' });
    } else {
      annotate(feature.termination === 'through-wall' ? '穿透当前壁' : '贯穿全部', `${feature.name || '孔'}的终止方式，定位虚线只表示切削方向`, add(center, add(scale(normal, spacing * 3.2), scale(v, -spacing * 2))));
      if (feature.termination === 'through-wall' && Number.isFinite(wallThickness)) {
        const wall = dimension(center, add(center, scale(inward, wallThickness)), scale(v, holeRadius + spacing * 1.6), u, spacing);
        wall.position = add(wall.position, scale(v, spacing * .5));
        emit('wallThickness', wall, { prefix: '壁厚 ' });
      }
    }
    if (isRadial) {
      const axisCenter = [center[0], 0, 0];
      const lane = scale(normal, radius + spacing * 2.3);
      emit('position', dimension([host.start, 0, 0], axisCenter, lane, v, spacing), { prefix: '段内 X ' });
      const angleLines = [], angleRadius = radius + spacing * 3.8;
      arc(angleLines, center[0], angleRadius, feature.angle || 0);
      emit('angle', { lines: angleLines, position: add(axisCenter, scale(radial(((feature.angle || 0) % 360) / 2), angleRadius + spacing)) }, { prefix: 'θ ' });
      emit('count', { position: add(axisCenter, add(scale(normal, radius + spacing * 2.5), scale(v, -holeRadius - spacing * 2))) }, { prefix: '数量 ' });
    } else {
      const faceCenter = [center[0], 0, 0], pcdRadius = (feature.pcd || 0) / 2;
      const planeOffset = scale(normal, spacing * 2.7);
      const pcd = dimension(add(faceCenter, scale(Y, -pcdRadius)), add(faceCenter, scale(Y, pcdRadius)), planeOffset, Z, spacing);
      pcd.position = add(faceCenter, add(planeOffset, [0, pcdRadius + spacing * 1.5, -spacing]));
      emit('pcd', pcd, { prefix: 'PCD ⌀' });
      emit('count', { position: add(faceCenter, add(scale(normal, spacing * 4.3), [0, -radius - spacing, spacing])) }, { prefix: '数量 ' });
      if (pcdRadius > 0) {
        const angleLines = [], angleRadius = pcdRadius + spacing * 2;
        arc(angleLines, center[0] + normal[0] * spacing * 2.7, angleRadius, feature.angle || 0);
        emit('angle', { lines: angleLines, position: add(faceCenter, add(planeOffset, scale(radial(((feature.angle || 0) % 360) / 2), angleRadius + spacing))) }, { prefix: '相位 ' });
      }
    }
    if (feature.counterboreDiameter > 0 && feature.counterboreDepth > 0) {
      const cbRadius = feature.counterboreDiameter / 2;
      const cb = dimension(add(center, scale(u, -cbRadius)), add(center, scale(u, cbRadius)), scale(normal, spacing * 3.7), v, spacing);
      cb.position = add(cb.position, scale(v, -cbRadius - spacing));
      emit('counterboreDiameter', cb, { prefix: '沉孔 ⌀' });
      emit('counterboreDepth', dimension(center, add(center, scale(inward, feature.counterboreDepth)), scale(v, -cbRadius - spacing * 2), u, spacing), { prefix: '沉深 ' });
    }
    if (feature.thread?.enabled) {
      const thread = feature.thread;
      const designation = `M${fmt(thread.nominal)}×${fmt(thread.pitch)}${['left', 'LH'].includes(thread.hand) ? ' 左旋' : ''}`;
      annotate(`简化螺纹 ${designation}`, `${feature.name || '孔'}，${designation}，有效螺纹长 ${fmt(thread.length)} mm；仅显示设计标注，没有实体牙形；查看特征参数`, add(center, add(scale(normal, spacing * 5.2), scale(v, holeRadius + spacing * 2.4))));
    }
  } else if (feature.type === 'groove' || feature.type === 'internal-keyway') {
    const host = hostFor(model, feature, layout);
    if (!host) return empty;
    const start = host.start + feature.position;
    const axialLength = feature.type === 'groove' ? feature.width : feature.length;
    const end = start + axialLength;
    const x = (start + end) / 2;
    if (feature.type === 'groove') {
      const inner = feature.location === 'inner';
      const sign = inner ? 1 : -1;
      const leftRadius = host.radiusAt(start), rightRadius = host.radiusAt(end), midRadius = host.radiusAt(x);
      ringProfile(markers, start, end, leftRadius, rightRadius);
      ringProfile(markers, start, end, leftRadius + sign * feature.depth, rightRadius + sign * feature.depth);
      for (const xx of [start, end]) for (const angle of [0, 90, 180, 270]) {
        const r = host.radiusAt(xx);
        line(markers, add([xx, 0, 0], scale(radial(angle), r)), add([xx, 0, 0], scale(radial(angle), r + sign * feature.depth)));
      }
      emit('position', dimension([host.start, 0, 0], [start, 0, 0], [0, radius + spacing * 2, radius * .65], Y, spacing), { prefix: '起点 ' });
      emit('width', dimension([start, 0, 0], [end, 0, 0], [0, -radius - spacing * 2, radius * .85], Y, spacing), { prefix: '槽宽 ' });
      const depth = dimension([x, midRadius, 0], [x, midRadius + sign * feature.depth, 0], [0, 0, radius + spacing], X, spacing);
      depth.position = add(depth.position, [spacing, spacing * .6, 0]);
      emit('depth', depth, { prefix: '槽深 ' });
    } else {
      const normal = radial(feature.angle || 0), across = tangent(feature.angle || 0), r = host.radiusAt(x);
      const halfWidth = feature.width / 2;
      const corners = (atRadius) => [
        add([start, 0, 0], add(scale(normal, atRadius), scale(across, -halfWidth))),
        add([end, 0, 0], add(scale(normal, atRadius), scale(across, -halfWidth))),
        add([end, 0, 0], add(scale(normal, atRadius), scale(across, halfWidth))),
        add([start, 0, 0], add(scale(normal, atRadius), scale(across, halfWidth))),
      ];
      const mouth = corners(Math.sqrt(Math.max(0, r * r - halfWidth * halfWidth))), floor = corners(r + feature.depth);
      for (let index = 0; index < 4; index++) {
        line(markers, mouth[index], mouth[(index + 1) % 4]);
        line(markers, floor[index], floor[(index + 1) % 4]);
        line(markers, mouth[index], floor[index]);
      }
      emit('position', dimension([host.start, 0, 0], [start, 0, 0], scale(normal, radius + spacing * 2), across, spacing), { prefix: '起点 ' });
      emit('length', dimension([start, 0, 0], [end, 0, 0], add(scale(normal, radius + spacing * 3.7), scale(across, -halfWidth - spacing)), across, spacing), { prefix: '槽长 ' });
      const at = add([x, 0, 0], scale(normal, r));
      const width = dimension(add(at, scale(across, -halfWidth)), add(at, scale(across, halfWidth)), scale(normal, feature.depth + spacing), X, spacing);
      width.position = add(width.position, scale(normal, spacing * .5));
      emit('width', width, { prefix: '槽宽 ' });
      const depth = dimension(at, add(at, scale(normal, feature.depth)), add([spacing, 0, 0], scale(across, halfWidth + spacing * 1.8)), X, spacing);
      depth.position = add(depth.position, scale(across, spacing));
      emit('depth', depth, { prefix: '槽深 ' });
      const angleLines = [], angleRadius = radius + spacing * 5.2;
      arc(angleLines, x, angleRadius, feature.angle || 0);
      emit('angle', { lines: angleLines, position: add([x, 0, 0], scale(radial(((feature.angle || 0) % 360) / 2), angleRadius + spacing)) }, { prefix: 'θ ' });
    }
  }
  return { dimensions, markers, annotations };
}

/** 给主界面/测试共享尺寸目标与数值；position/lines 是三维世界坐标。 */
export function getFeatureDimensionAnchors(model, featureOrId, subId) {
  return getFeatureView(model, featureOrId, subId).dimensions;
}
