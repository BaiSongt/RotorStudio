import { draw, makeBox, makeCylinder } from 'replicad';
import { getBoreLayout, resolveBoreHost, resolveRadialHole } from './features.js';

const EPS = 0.01;
const DEG = Math.PI / 180;
const AXIS = [1, 0, 0];

function dispose(item) {
  if (!item) return;
  try { item.delete(); } catch { /* 临时对象可能已被上游几何操作释放。 */ }
}

// 消费两个临时刀具；最终零件的输入实体不经此函数释放。
function combine(left, right, operation = 'fuse') {
  try { return left[operation](right); }
  finally { dispose(left); dispose(right); }
}

function revolvePolygon(points) {
  const clean = [];
  for (const point of points) {
    const last = clean.at(-1);
    if (last && point[0] === last[0] && point[1] === last[1]) continue;
    // 拆分一个圆柱/锥段只增加参数边界，不应留下同一解析曲面的内部接缝。
    // 距离容差远小于内核建模容差，不合并可辨识的台阶或锥度变化。
    while (clean.length >= 2) {
      const a = clean.at(-2), b = clean.at(-1);
      const ab = [b[0] - a[0], b[1] - a[1]];
      const bc = [point[0] - b[0], point[1] - b[1]];
      const cross = ab[0] * bc[1] - ab[1] * bc[0];
      const tolerance = 1e-10 * Math.max(1, Math.hypot(...ab) + Math.hypot(...bc));
      if (Math.abs(cross) > tolerance || ab[0] * bc[0] + ab[1] * bc[1] < 0) break;
      clean.pop();
    }
    clean.push(point);
  }
  let pen = draw(clean[0]);
  for (const point of clean.slice(1)) pen = pen.lineTo(point);
  const drawing = pen.close();
  try { return drawing.sketchOnPlane('XY').revolve(AXIS, { origin: [0, 0, 0] }); }
  finally { dispose(drawing); }
}

function boreTool(model, bore, totalLength) {
  // 一条内轮廓只旋转一次，避免将共享同一圆锥面的相邻刀具做布尔融合。
  // 此处仅派生几何，不修改各参数段、稳定 id 或内槽对原段的引用。
  const layout = [...getBoreLayout(model, bore)].sort((a, b) => a.start - b.start);
  const first = layout[0], last = layout.at(-1);
  if (!first) throw new Error('内腔没有有效阶梯。');
  // 只在零件的真实端面越界；内部盲底和段间台阶的轴向位置保持精确。
  const start = first.start <= 1e-7 ? first.start - EPS : first.start;
  const end = last.end >= totalLength - 1e-7 ? last.end + EPS : last.end;
  const points = [[start, 0], [start, first.diameter / 2]];
  for (const segment of layout) {
    points.push([segment.start, segment.diameter / 2],
      [segment.end, (segment.type === 'cone' ? segment.endDiameter : segment.diameter) / 2]);
  }
  // 越界部分沿端点半径延伸，不因加长刀具而改变零件内部的锥度。
  points.push([end, (last.type === 'cone' ? last.endDiameter : last.diameter) / 2], [end, 0]);
  return revolvePolygon(points);
}

function referencedBoreSegment(model, feature) {
  return resolveBoreHost(model, feature).boreSegment;
}

function grooveTool(model, feature, layout) {
  if (feature.location === 'inner') {
    const segment = referencedBoreSegment(model, feature);
    return makeCylinder(segment.diameter / 2 + feature.depth, feature.width,
      [segment.start + feature.position, 0, 0], AXIS);
  }
  const segment = layout.find(item => item.id === feature.segmentId);
  if (!segment) throw new Error('引用的外圆阶梯不存在。');
  const x = segment.start + feature.position;
  const radius = segment.diameter / 2;
  const outside = makeCylinder(radius + EPS, feature.width, [x, 0, 0], AXIS);
  let inside;
  try { inside = makeCylinder(radius - feature.depth, feature.width + 2 * EPS, [x - EPS, 0, 0], AXIS); }
  catch (error) { dispose(outside); throw error; }
  return combine(outside, inside, 'cut');
}

function internalKeywayTool(model, feature) {
  const segment = referencedBoreSegment(model, feature);
  const x = segment.start + feature.position;
  // 从已存在的孔腔伸向外壁；深度以圆柱内孔在槽中心线处的半径为基准。
  let tool = makeBox([x, 0, -feature.width / 2],
    [x + feature.length, segment.diameter / 2 + feature.depth, feature.width / 2]);
  try {
    if (feature.angle) tool = tool.rotate(feature.angle, [0, 0, 0], AXIS);
    return tool;
  } catch (error) { dispose(tool); throw error; }
}

// 每个刀具都在本地释放。中途失败时只释放本特征产生的实体，保留调用者输入。
function cutTools(input, tools) {
  let result = input;
  let ownsResult = false;
  try {
    for (const tool of tools) {
      let next;
      try { next = result.cut(tool); }
      finally { dispose(tool); }
      if (ownsResult) dispose(result);
      result = next;
      ownsResult = true;
    }
    if (!ownsResult) throw new Error('特征没有生成有效刀具。');
    return result;
  } catch (error) {
    if (ownsResult) dispose(result);
    throw error;
  }
}

function* holeTools(model, hole, totalLength) {
  if (hole.placement === 'radial') {
    const resolved = resolveRadialHole(model, hole);
    const { x, outerRadius, effectiveDepth } = resolved;
    for (let index = 0; index < hole.count; index++) {
      const angle = (hole.angle + index * 360 / hole.count) * DEG;
      const radial = [0, Math.cos(angle), Math.sin(angle)];
      const direction = radial.map(value => -value);
      const origin = [x, radial[1] * (outerRadius + EPS), radial[2] * (outerRadius + EPS)];
      // 穿当前壁时 effectiveDepth=R，终点为轴线处的近侧半空间边界。
      // schema 保证整个孔口小于同一内腔且未跨段，因此终端整截面均位于空腔，
      // 不依赖孔轴射线的单点出口，也不会误切对面的壳壁。
      const overrun = hole.termination === 'through-all' ? 2 * EPS : EPS;
      yield makeCylinder(hole.diameter / 2, effectiveDepth + overrun, origin, direction);
      if (hole.counterboreDiameter > 0 && hole.counterboreDepth > 0) {
        yield makeCylinder(hole.counterboreDiameter / 2, hole.counterboreDepth + EPS, origin, direction);
      }
    }
    return;
  }
  const direction = hole.face === 'left' ? AXIS : [-1, 0, 0];
  const x = hole.face === 'left' ? -EPS : totalLength + EPS;
  const depth = hole.termination === 'through-all' ? totalLength + 2 * EPS : hole.depth + EPS;
  for (let index = 0; index < hole.count; index++) {
    const angle = (hole.angle + index * 360 / hole.count) * DEG;
    const origin = [x, hole.pcd / 2 * Math.cos(angle), hole.pcd / 2 * Math.sin(angle)];
    yield makeCylinder(hole.diameter / 2, depth, origin, direction);
    if (hole.counterboreDiameter > 0 && hole.counterboreDepth > 0) {
      yield makeCylinder(hole.counterboreDiameter / 2, hole.counterboreDepth + EPS, origin, direction);
    }
  }
}

/** 返回新实体；输入实体所有权属于调用者。螺纹参数仅作为语义保存，不生成实体牙型。 */
export function applyFeature(shape, model, feature, { layout, length }) {
  switch (feature.type) {
    case 'bore': return cutTools(shape, [boreTool(model, feature, length)]);
    case 'hole': return cutTools(shape, holeTools(model, feature, length));
    case 'groove': return cutTools(shape, [grooveTool(model, feature, layout)]);
    case 'internal-keyway': return cutTools(shape, [internalKeywayTool(model, feature)]);
    default: throw new Error(`不支持的特征类型：${feature.type}`);
  }
}
