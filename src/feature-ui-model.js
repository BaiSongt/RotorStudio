import { getSegmentLayout, minSegmentRadius, segmentRadiusAt, validateModel } from './schema.js';
import { createFeature, createBoreSegment, getBoreLayout } from './features.js';

/** 根据当前实体的宿主和剩余材料给出可编辑初值，不改变已有特征参数。 */
export function createFeatureForModel(model, type, selectedSegmentId) {
  const layout = getSegmentLayout(model), total = layout.at(-1).end;
  const cylinders = layout.filter(s => s.type === 'cylinder');
  const host = cylinders.find(s => s.id === selectedSegmentId) || cylinders[0];
  const bores = (model.features || []).filter(f => f.type === 'bore' && f.enabled);
  const round = value => Math.round(value * 1000) / 1000;
  const radiusAt = x => {
    const s = layout.find(s => x >= s.start && x <= s.end) || layout.at(-1);
    return segmentRadiusAt(s, x - s.start);
  };
  if (type === 'bore') {
    const diameter = round(Math.max(.2, Math.min(...layout.map(s => minSegmentRadius(s))) * .9));
    return createFeature(type, { name: `内腔 ${bores.length + 1}`, segments: [createBoreSegment({ name: '内孔主体', diameter, endDiameter: diameter, length: round(total * .7) })] });
  }
  if (type === 'hole') {
    const end = layout.at(-1), outer = minSegmentRadius(end, end.length, end.length);
    let inner = 0;
    for (const b of bores) for (const s of getBoreLayout(model, b)) if (s.end >= total - 1e-7) inner = Math.max(inner, s.endDiameter / 2);
    const diameter = round(Math.max(.2, Math.min(5, (outer - inner) * .5)));
    const depth = round(Math.max(.2, Math.min(12, end.length * .5)));
    return createFeature(type, { name: '安装孔', placement: 'end', face: 'right', segmentId: host?.id || '', position: round((host?.length || 10) / 2), boreId: bores[0]?.id || '', diameter, depth, pcd: inner ? round(outer + inner) : 0, thread: { enabled: false, nominal: 6, pitch: 1, hand: 'right', toleranceClass: '6H', length: round(Math.min(8, depth * .6)), offset: 0 } });
  }
  if (type === 'groove') {
    if (!host) throw new Error('外环槽需要一个圆柱外形段，请先选择或添加圆柱段。');
    const position = host.length * .45, x = host.start + position;
    let inner = 0;
    for (const b of bores) for (const s of getBoreLayout(model, b)) if (s.start <= x && s.end >= x) inner = Math.max(inner, Math.max(s.diameter, s.endDiameter) / 2);
    return createFeature(type, { name: '外圆环槽', segmentId: host.id, position: round(position), width: round(Math.max(.1, Math.min(4, host.length * .15))), depth: round(Math.max(.05, Math.min(1, (host.diameter / 2 - inner) * .15))), boreId: bores[0]?.id || '', boreSegmentId: bores[0]?.segments.find(s => s.type === 'cylinder')?.id || '' });
  }
  if (type === 'internal-keyway') {
    const bore = bores.find(b => b.segments.some(s => s.type === 'cylinder'));
    if (!bore) throw new Error('请先添加并启用含圆柱段的内腔，再添加内键槽。');
    const s = getBoreLayout(model, bore).find(s => s.type === 'cylinder');
    const wall = radiusAt((s.start + s.end) / 2) - s.diameter / 2;
    const depth = Math.max(.05, Math.min(2, wall * .25));
    const feature = createFeature(type, { name: '内孔键槽', boreId: bore.id, boreSegmentId: s.id, position: round(s.length * .2), length: round(s.length * .6), width: round(Math.max(.2, Math.min(6, s.diameter * .15))), depth: round(depth), angle: 0 });
    // 优先保留零度；已有径向螺纹孔时寻找不相交的常用角度。
    for (const angle of [0, 90, 180, 270, 45, 135, 225, 315]) {
      const candidate = { ...feature, angle };
      if (!validateModel({ ...model, features: [...(model.features || []), candidate] }).errors.length) return candidate;
    }
    return feature; // 无合法初值时，由统一提交校验给出具体冲突位置。
  }
  throw new Error('不支持的特征类型。');
}

/** 依赖只允许指向上游对象；删除和重排前复用该查询给出具体提示。 */
export function featureDependents(model, id, segmentId) {
  return (model.features || []).filter(f => {
    const bound = f.type === 'internal-keyway' || f.type === 'groove' && f.location === 'inner' || f.type === 'hole' && f.placement === 'radial' && f.termination === 'through-wall';
    return bound && f.boreId === id && (!segmentId || f.boreSegmentId === segmentId || !f.boreSegmentId);
  });
}
