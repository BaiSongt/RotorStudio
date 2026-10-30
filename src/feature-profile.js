import { getBoreLayout, getFeatureDimensions } from './features.js';
import { getSegmentLayout, segmentRadiusAt } from './schema.js';

const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmt = value => Number.isFinite(value) ? Number(value.toFixed(3)).toLocaleString('zh-CN', { maximumFractionDigits: 3 }) : '—';

export function dimensionAttributes(target) {
  let html = `data-dimension-kind="${escape(target.kind)}"`;
  if (target.kind === 'feature-parameter') {
    html += ` data-feature-id="${escape(target.id)}" data-dimension-key="${escape(target.key)}"`;
    if (target.subId) html += ` data-dimension-sub-id="${escape(target.subId)}"`;
  } else if (target.id) html += ` data-segment-id="${escape(target.id)}"`;
  return html;
}

export function dimensionTarget(element) {
  const d = element.dataset;
  return d.dimensionKind === 'feature-parameter'
    ? { kind: d.dimensionKind, id: d.featureId, key: d.dimensionKey, ...(d.dimensionSubId ? { subId: d.dimensionSubId } : {}) }
    : { kind: d.dimensionKind, ...(d.segmentId ? { id: d.segmentId } : {}) };
}

export function sameDimension(a, b) {
  return a.kind === b.kind && (a.id || '') === (b.id || '') && (a.key || '') === (b.key || '') && (a.subId || '') === (b.subId || '');
}

/** 数值按钮始终使用工程参数，不从绘制坐标反算尺寸。 */
export function renderFeatureDimensionStrip(model, feature, subId) {
  if (!feature) return '';
  let dims;
  try { dims = getFeatureDimensions(model, feature); } catch { return '<span class="muted">修正参数后显示关联尺寸</span>'; }
  return `<span class="feature-dim-owner">${escape(feature.name)}</span>` + dims.filter(d => !d.subId || d.subId === subId).map(d => {
    const target = d.target || { kind: 'feature-parameter', id: feature.id, key: d.key, ...(d.subId ? { subId: d.subId } : {}) };
    const title = d.title.startsWith(`${feature.name} · `) ? d.title.slice(feature.name.length + 3) : d.title;
    const content = `<span>${escape(title)}</span><b>${fmt(d.value)}</b><small>${escape(d.unit || 'mm')}</small>`;
    return d.editable === false ? `<span class="feature-dim-readonly" title="${escape(d.hint || '派生尺寸')}">${content}</span>` : `<button type="button" class="feature-dim-button" ${dimensionAttributes(target)} title="${escape(d.hint || d.title)} · 点击输入" aria-label="编辑${escape(d.title)}">${content}</button>`;
  }).join('');
}

/** 底部为参数剖面/投影示意；真实切除结果由三维实体和剖切观察。 */
export function renderInnerOverlay(model, selectedFeature, selectedSubId, { x, y, radial, scale }) {
  let html = '';
  const layout = getSegmentLayout(model), total = layout.at(-1).end;
  const features = (model.features || []).filter(f => f.enabled);
  const attrs = (f, subId = '') => `data-profile-feature="${escape(f.id)}"${subId ? ` data-profile-sub-id="${escape(subId)}"` : ''} tabindex="0" role="button" aria-label="选择${escape(f.name)}"`;
  for (const f of features.filter(f => f.type === 'bore')) {
    let segments;
    try { segments = getBoreLayout(model, f); } catch { continue; }
    for (const s of segments) {
      if (![s.start, s.end, s.diameter, s.endDiameter].every(Number.isFinite) || s.length <= 0) continue;
      const active = f.id === selectedFeature && s.id === selectedSubId;
      html += `<g class="profile-bore ${active ? 'selected' : ''}" ${attrs(f, s.id)}><polygon points="${x(s.start)},${y(s.diameter / 2)} ${x(s.end)},${y(s.endDiameter / 2)} ${x(s.end)},${y(-s.endDiameter / 2)} ${x(s.start)},${y(-s.diameter / 2)}"/><title>${escape(f.name)} · ${escape(s.name || '内阶梯')} · Ø${fmt(s.diameter)}</title></g>`;
    }
  }
  for (const f of features.filter(f => f.type !== 'bore')) {
    const active = f.id === selectedFeature ? ' selected' : '';
    if (f.type === 'hole') {
      if (f.placement === 'radial') {
        const s = layout.find(s => s.id === f.segmentId);
        if (!s || !Number.isFinite(f.position)) continue;
        const px = s.start + f.position, r = s.diameter / 2, theta = f.angle * Math.PI / 180, top = r * Math.cos(theta);
        const bottom = f.termination === 'blind' ? (r - f.depth) * Math.cos(theta) : f.termination === 'through-wall' ? 0 : -top;
        html += `<g class="profile-feature-marker${active}" ${attrs(f)}><path d="M${x(px)} ${y(top)}L${x(px)} ${y(bottom)}"/><circle cx="${x(px)}" cy="${y(top)}" r="3"/><title>${escape(f.name)} · ${f.thread?.enabled ? '简化螺纹孔' : '径向孔'}</title></g>`;
      } else {
        const depth = f.termination === 'through-all' ? total : f.depth, start = f.face === 'left' ? 0 : total - depth;
        const center = f.pcd / 2 * Math.cos(f.angle * Math.PI / 180);
        if (![depth, start, center, f.diameter].every(Number.isFinite)) continue;
        html += `<g class="profile-feature-marker${active}" ${attrs(f)}><rect x="${x(start)}" y="${y(center + f.diameter / 2)}" width="${Math.max(0, depth * scale)}" height="${Math.max(0, f.diameter * radial)}"/><title>${escape(f.name)} · 孔位投影</title></g>`;
      }
    } else {
      const inner = f.type === 'internal-keyway' || f.location === 'inner';
      let s;
      if (inner) {
        const b = features.find(b => b.id === f.boreId && b.type === 'bore');
        try { s = b && getBoreLayout(model, b).find(s => s.id === f.boreSegmentId); } catch { continue; }
      } else s = layout.find(s => s.id === f.segmentId);
      if (!s) continue;
      const start = s.start + f.position, width = f.type === 'groove' ? f.width : f.length, r = s.diameter / 2;
      if (![start, width, r, f.depth].every(Number.isFinite)) continue;
      const marks = f.type === 'groove' ? [1, -1] : [Math.cos((f.angle || 0) * Math.PI / 180)];
      html += `<g class="profile-feature-marker${active}" ${attrs(f)}>${marks.map(sign => {
        const a = sign * r, b = sign * (r + (inner ? f.depth : -f.depth));
        return `<rect x="${x(start)}" y="${y(Math.max(a, b))}" width="${Math.max(.5, width * scale)}" height="${Math.max(1, Math.abs(a - b) * radial)}"/>`;
      }).join('')}<title>${escape(f.name)} · 槽投影</title></g>`;
    }
  }
  return html;
}

export function renderEndProfile(model, selectedFeature) {
  const layout = getSegmentLayout(model), total = layout.at(-1).end;
  const f = (model.features || []).find(f => f.id === selectedFeature);
  const radialHost = f?.type === 'hole' && f.placement === 'radial' ? layout.find(s => s.id === f.segmentId) : null;
  const face = f?.face || 'right', xx = radialHost ? radialHost.start + f.position : face === 'left' ? 0 : total;
  const host = radialHost || (face === 'left' ? layout[0] : layout.at(-1));
  const outer = segmentRadiusAt(host, xx - host.start), k = 57 / Math.max(outer, .01), cx = 130, cy = 73;
  let inner = 0;
  for (const b of (model.features || []).filter(b => b.enabled && b.type === 'bore')) {
    try { for (const s of getBoreLayout(model, b)) if (xx >= s.start - 1e-7 && xx <= s.end + 1e-7) inner = Math.max(inner, (s.diameter + (s.endDiameter - s.diameter) * (xx - s.start) / s.length) / 2); } catch { /* 不画非法草稿。 */ }
  }
  let marks = '';
  for (const h of (model.features || []).filter(h => h.enabled && h.type === 'hole' && (h.placement === 'end' ? h.face === face : radialHost && h.segmentId === radialHost.id))) {
    if (![h.count, h.pcd, h.angle, h.diameter].every(Number.isFinite)) continue;
    if (h.placement === 'end' && h.pcd > 0) marks += `<circle class="end-pcd" cx="${cx}" cy="${cy}" r="${h.pcd / 2 * k}"/>`;
    for (let i = 0; i < Math.min(24, h.count); i++) {
      const a = (h.angle + 360 * i / h.count) * Math.PI / 180, r = h.placement === 'end' ? h.pcd / 2 : outer;
      const px = cx + r * Math.sin(a) * k, py = cy - r * Math.cos(a) * k;
      marks += `<g class="end-hole ${h.id === selectedFeature ? 'selected' : ''}" data-profile-feature="${escape(h.id)}" role="button" tabindex="0" aria-label="选择${escape(h.name)}"><circle cx="${px}" cy="${py}" r="${Math.max(2, h.diameter / 2 * k)}"/>${h.thread?.enabled ? `<circle class="thread-symbol" cx="${px}" cy="${py}" r="${Math.max(3, h.thread.nominal / 2 * k)}"/>` : ''}<title>${escape(h.name)} · ${i + 1}</title></g>`;
    }
  }
  return `<div class="end-profile"><svg viewBox="0 0 260 146" aria-label="端面孔位参数示意"><path class="profile-axis" d="M${cx} 4V142M48 ${cy}H212"/><circle class="end-body" cx="${cx}" cy="${cy}" r="${outer * k}"/>${inner ? `<circle class="end-bore" cx="${cx}" cy="${cy}" r="${inner * k}"/>` : ''}${marks}<text class="end-axis-label" x="${cx + 4}" y="12">+Y</text><text class="end-axis-label" x="210" y="${cy - 4}">+Z</text></svg><div class="end-profile-info"><strong>${radialHost ? '径向孔分布' : `${face === 'left' ? '左' : '右'}端面孔位`}</strong><span>X = ${fmt(xx)} mm · 外径 Ø${fmt(outer * 2)}</span><p>角度从 +Y 开始，向 +Z 增加。点击孔选择特征，再直接输入下方尺寸。</p><small>孔位投影示意 · 螺纹双圆为符号</small></div></div>`;
}
