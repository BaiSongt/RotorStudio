import { getSegmentLayout } from './schema.js';

const TERMINATIONS = { blind: '指定深度', 'through-wall': '穿透当前壁', 'through-all': '贯穿全部' };

function cell(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  let text = String(value ?? '');
  // 名称可由用户输入，避免表格软件把导出文本作为公式执行。
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

/** 导出设计语义表；不把简化底孔宣称为实体螺纹或 STEP PMI。 */
export function createHoleTableCSV(model) {
  const layout = getSegmentLayout(model), length = layout.at(-1).end;
  const rows = [['零件名称', '特征ID', '特征名称', '孔序号', '入口X_mm', '入口Y_mm', '入口Z_mm', '轴向X', '轴向Y', '轴向Z', '终止方式', '底孔直径_mm', '指定钻深_mm', '目标内腔ID', '沉孔直径_mm', '沉孔深度_mm', '螺纹规格', '旋向', '公差带记录', '起牙偏移_mm', '有效牙深_mm', '几何表达']];
  const holes = [
    ...model.holes.filter(h => h.enabled).map((h, i) => ({ ...h, name: `原有端面孔 ${i + 1}`, placement: 'end', termination: h.through ? 'through-all' : 'blind' })),
    ...(model.features || []).filter(f => f.enabled && f.type === 'hole'),
  ];
  for (const h of holes) {
    for (let i = 0; i < h.count; i++) {
      const angle = (h.angle + i * 360 / h.count) * Math.PI / 180;
      let point, direction;
      if (h.placement === 'radial') {
        const s = layout.find(s => s.id === h.segmentId);
        if (!s) throw new Error(`${h.name}：孔位宿主不存在，无法导出孔表。`);
        point = [s.start + h.position, s.diameter / 2 * Math.cos(angle), s.diameter / 2 * Math.sin(angle)];
        direction = [0, -Math.cos(angle), -Math.sin(angle)];
      } else {
        point = [h.face === 'left' ? 0 : length, h.pcd / 2 * Math.cos(angle), h.pcd / 2 * Math.sin(angle)];
        direction = [h.face === 'left' ? 1 : -1, 0, 0];
      }
      const t = h.thread?.enabled ? h.thread : null;
      const clean = values => values.map(value => Math.abs(value) < 1e-12 ? 0 : value);
      rows.push([model.name, h.id, h.name, i + 1, ...clean(point), ...clean(direction), TERMINATIONS[h.termination], h.diameter, h.termination === 'blind' ? h.depth : '', h.termination === 'through-wall' ? h.boreId : '', h.counterboreDiameter, h.counterboreDepth, t ? `M${t.nominal}×${t.pitch}` : '', t ? t.hand === 'left' ? '左旋' : '右旋' : '', t?.toleranceClass || '', t?.offset ?? '', t?.length ?? '', t ? '简化底孔；无实体牙形；无STEP螺纹PMI' : '光孔实体']);
    }
  }
  return '\uFEFF' + rows.map(row => row.map(cell).join(',')).join('\r\n') + '\r\n';
}
