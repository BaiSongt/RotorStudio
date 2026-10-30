import { getBoreLayout, getFeatureDimensions, THREAD_PRESETS } from './features.js';

export const FAMILY_NAMES = { shaft: '轴类', disk: '盘 / 法兰', sleeve: '套 / 衬套', housing: '回转壳体' };
export const FEATURE_NAMES = { bore: '内腔轮廓', hole: '孔 / 螺纹孔', groove: '环槽', 'internal-keyway': '内键槽' };
const FEATURE_ICONS = { bore: 'layers', hole: 'circle-dot', groove: 'scissors', 'internal-keyway': 'scissors' };

/** 特征树和参数编辑器共用旧界面的输入组件，所有修改交由主工程事务处理。 */
export function renderFeaturePanel(model, selectedId, selectedBoreSegment, ui) {
  const { ico, escape, fmt, numberField: number, selectField: select, toggleField: toggle, sectionHeading: heading } = ui;
  const features = model.features || [];
  const f = features.find(item => item.id === selectedId);
  const nf = (label, key, value, options = {}) => number(label, 'feature', key, value, options);
  const sf = (label, key, value, options, wide = false) => select(label, 'feature', key, value, options, wide);
  const external = [['', '请选择圆柱段'], ...model.segments.filter(s => s.type === 'cylinder').map(s => [s.id, s.name])];
  const bores = features.slice(0, f ? features.indexOf(f) : features.length).filter(item => item.type === 'bore' && item.enabled).map(item => [item.id, item.name]);
  const summary = item => item.type === 'bore' ? `${item.segments.length} 段内轮廓 · ${item.face === 'left' ? '左' : '右'}侧入口 · ${item.termination === 'through-all' ? '贯通' : '盲腔'}`
    : item.type === 'hole' ? `${item.count} × ${item.thread?.enabled ? `M${item.thread.nominal} × ${item.thread.pitch}` : `Ø${fmt(item.diameter)}`} · ${item.placement === 'radial' ? '径向' : '端面'} · ${item.termination === 'through-wall' ? '穿当前壁' : item.termination === 'through-all' ? '贯穿全部' : `深 ${fmt(item.depth)}`}`
      : item.type === 'groove' ? `${item.location === 'inner' ? '内孔' : '外圆'} · 宽 ${fmt(item.width)} / 深 ${fmt(item.depth)}` : `宽 ${fmt(item.width)} × 深 ${fmt(item.depth)} × 长 ${fmt(item.length)}`;
  let html = `<div class="feature-intro"><span class="family-badge">${ico('box')}${escape(FAMILY_NAMES[model.partFamily] || '轴类')}</span><span>基体 → 有序特征</span></div>`;
  html += `<div class="feature-add-tools">${Object.entries(FEATURE_NAMES).map(([type, label]) => `<button class="mini-button" data-add-feature="${type}" title="添加${label}">${ico(FEATURE_ICONS[type])}${label}</button>`).join('')}</div>`;
  html += `<details class="base-tree"><summary>${ico('layers')}回转基体 <span>${model.segments.length} 段 · 原有特征 ${model.keyways.length + model.holes.length}</span></summary><div>${model.segments.map((s, i) => `<button data-segment="${escape(s.id)}"><span>${String(i + 1).padStart(2, '0')}</span>${escape(s.name)}</button>`).join('')}${model.keyways.map(k => `<button data-legacy-keyway="${escape(k.id)}">${ico('scissors')}原有键槽</button>`).join('')}${model.holes.map(h => `<button data-legacy-hole="${escape(h.id)}">${ico('circle-dot')}原有${h.face === 'left' ? '左' : '右'}端孔 · Ø${fmt(h.diameter)}</button>`).join('')}</div></details>`;
  html += `<div class="feature-list ordered-feature-list">${features.map((item, i) => `<button class="feature-row ${item.id === selectedId ? 'selected' : ''} ${item.enabled ? '' : 'suppressed'}" data-feature="${escape(item.id)}"><span class="feature-step">${String(i + 1).padStart(2, '0')}</span><span class="feature-icon ${item.type === 'hole' ? 'orange' : ''}">${ico(FEATURE_ICONS[item.type] || 'box')}</span><span><strong>${escape(item.name || FEATURE_NAMES[item.type])}${item.enabled ? '' : ' · 停用'}</strong><small>${escape(summary(item))}</small></span></button>`).join('') || '<div class="feature-empty">从内腔、孔或槽开始添加特征。<br/>也可以从上方「新建 / 示例」选择盘、套或壳体。</div>'}</div>`;
  if (!f) return html;
  const index = features.indexOf(f);
  html += `<div class="properties feature-properties"><div class="selected-heading"><span><b class="tiny-number">${String(index + 1).padStart(2, '0')}</b><strong>${escape(FEATURE_NAMES[f.type])}</strong></span><div class="mini-actions"><button class="icon-button small" data-action="feature-up" title="提前构建" aria-label="提前构建" ${index === 0 ? 'disabled' : ''}>${ico('arrow-up')}</button><button class="icon-button small" data-action="feature-down" title="延后构建" aria-label="延后构建" ${index === features.length - 1 ? 'disabled' : ''}>${ico('arrow-down')}</button><button class="icon-button small" data-action="duplicate-feature" title="复制特征" aria-label="复制特征">${ico('copy')}</button><button class="icon-button small danger" data-action="delete-feature" title="删除特征" aria-label="删除特征">${ico('trash-2')}</button></div></div>`;
  html += `<label class="field"><span>名称</span><input class="text-input" data-scope="feature" data-field="name" aria-label="特征名称" maxlength="80" value="${escape(f.name)}"/></label>`;
  html += toggle('启用特征', 'feature', 'enabled', f.enabled, '按特征树顺序参与实体构建');
  if (f.type === 'bore') {
    let layout = [];
    try { layout = getBoreLayout(model, f); } catch { /* 草稿错误交给统一校验面板。 */ }
    html += '<div class="field-grid">' + sf('内腔入口', 'face', f.face, [['left', '左端 · X=0'], ['right', '右端 · X=L']]) + sf('终止方式', 'termination', f.termination, [['blind', '指定各段长度'], ['through-all', '贯通至另一端']]) + nf('入口偏移', 'offset', f.offset, { min: 0, wide: true }) + '</div>';
    html += `${heading('内轮廓阶梯', '从入口向内排列')}<div class="bore-segment-list">${f.segments.map((s, i) => `<button class="bore-segment ${s.id === selectedBoreSegment ? 'selected' : ''}" data-bore-segment="${escape(s.id)}"><span>${String(i + 1).padStart(2, '0')}</span><strong>${escape(s.name || `内阶梯 ${i + 1}`)}</strong><small>Ø${fmt(s.diameter)}${s.type === 'cone' ? ` → ${fmt(s.endDiameter)}` : ''} · L ${fmt(layout[i]?.length ?? s.length)}</small></button>`).join('')}</div>`;
    html += `<div class="bore-tools"><button class="mini-button" data-action="add-bore-segment">${ico('plus')}添加内阶梯</button><button class="mini-button" data-action="duplicate-bore-segment">${ico('copy')}复制</button><button class="mini-button" data-action="delete-bore-segment" ${f.segments.length <= 1 ? 'disabled' : ''}>${ico('trash-2')}删除</button></div>`;
    const s = f.segments.find(item => item.id === selectedBoreSegment) || f.segments[0];
    if (s) {
      const i = f.segments.indexOf(s), actual = layout[i], autoLength = f.termination === 'through-all' && i === f.segments.length - 1;
      html += `<div class="subfeature-heading"><strong>内阶梯 ${i + 1}</strong><span>${actual ? `X ${fmt(actual.start)} → ${fmt(actual.end)}` : '待修正'}</span></div><div class="field-grid">`;
      html += select('截面类型', 'bore-segment', 'type', s.type, [['cylinder', '圆柱内孔'], ['cone', '锥形内孔']], true);
      html += number('段长 L', 'bore-segment', 'length', autoLength ? actual?.length : s.length, { min: .1, disabled: autoLength, hint: autoLength ? '贯通联动' : '' });
      html += number(s.type === 'cone' ? '入口侧直径' : '内径 D', 'bore-segment', 'diameter', s.diameter, { min: .1 });
      if (s.type === 'cone') html += number('深处侧直径', 'bore-segment', 'endDiameter', s.endDiameter, { min: .1, wide: true });
      html += '</div>';
    }
    html += '<p class="panel-note">内外阶梯分别定义，分界位置可以错开。贯通模式由末段延伸到另一端；已有段长作为草稿保留。底部尺寸可直接输入。</p>';
    html += `<button class="button full outline" data-action="inspect-section">${ico('scissors')}剖切查看内腔</button>`;
  } else if (f.type === 'hole') {
    const radial = f.placement === 'radial';
    html += heading('孔的位置与方向') + '<div class="field-grid">' + sf('放置方式', 'placement', f.placement, [['end', '端面 · 沿轴向'], ['radial', '外圆 · 沿径向']], true);
    if (radial) html += sf('外圆宿主', 'segmentId', f.segmentId, external, true) + nf('段内位置 X', 'position', f.position, { min: 0 }) + nf('周向角度 θ', 'angle', f.angle, { unit: '°', step: 1 });
    else html += sf('起始端面', 'face', f.face, [['left', '左端 · 向 +X'], ['right', '右端 · 向 −X']], true);
    html += '</div>' + heading('孔形与终止方式') + '<div class="field-grid">' + nf('底孔 / 光孔直径', 'diameter', f.diameter, { min: .1, wide: f.termination !== 'blind' }) + (f.termination === 'blind' ? nf('钻孔深度', 'depth', f.depth, { min: .1 }) : '');
    const terminations = [['blind', '指定深度'], ['through-all', '贯穿全部材料']];
    if (radial) terminations.splice(1, 0, ['through-wall', '仅穿透当前壁']);
    html += sf('终止方式', 'termination', f.termination, terminations, true);
    if (f.termination === 'through-wall') html += sf('目标内腔', 'boreId', f.boreId, [['', '请选择上游内腔'], ...bores], true);
    html += '</div><p class="field-help">' + (radial ? '周向角度从 +Y 开始。仅穿透当前壁会保留远侧壁；贯穿全部会切穿所有经过的材料。' : '孔在端面以 PCD 和相位定位。钻入空腔后可继续按设定范围切除材料。') + '</p>';
    html += heading(radial ? '圆周分布' : '孔位与圆周阵列') + '<div class="field-grid">' + nf('孔数量', 'count', f.count, { unit: '个', min: 1, max: 24, step: 1 });
    if (!radial) html += nf('分布圆 PCD', 'pcd', f.pcd, { min: 0 }) + nf('起始角度', 'angle', f.angle, { unit: '°', step: 1, wide: true });
    html += '</div>';
    html += heading('平底沉孔', '同时设为 0 关闭') + '<div class="field-grid">' + nf('沉孔直径', 'counterboreDiameter', f.counterboreDiameter, { min: 0 }) + nf('沉孔深度', 'counterboreDepth', f.counterboreDepth, { min: 0 }) + '</div>';
    const t = f.thread;
    html += heading('螺纹定义', '简化实体') + toggle('螺纹孔', 'thread', 'enabled', t.enabled, '保存规格，实体保持底孔；不生成螺旋牙面');
    if (t.enabled) {
      const presets = Array.isArray(THREAD_PRESETS) ? THREAD_PRESETS : Object.values(THREAD_PRESETS);
      const current = presets.find(p => p.nominal === t.nominal && p.pitch === t.pitch);
      html += '<div class="field-grid">' + select('规格预设', 'thread', 'preset', current?.id || '', [['', '自定义参数'], ...presets.map(p => [p.id || `${p.nominal}-${p.pitch}`, p.label || `M${p.nominal} × ${p.pitch}`])], true);
      html += number('公称直径', 'thread', 'nominal', t.nominal, { min: 1 }) + number('螺距 P', 'thread', 'pitch', t.pitch, { min: .1, step: .05 });
      html += select('旋向', 'thread', 'hand', t.hand, [['right', '右旋'], ['left', '左旋']]) + select('公差带记录', 'thread', 'toleranceClass', t.toleranceClass, [['6H', '6H'], ['7H', '7H'], ['5H', '5H']]);
      html += number('有效螺纹深度', 'thread', 'length', t.length, { min: .1 }) + number('螺纹起始偏移', 'thread', 'offset', t.offset, { min: 0 }) + '</div>';
      html += '<div class="semantic-note">规格写入工程与孔表。STEP 中为底孔实体，未写入螺纹 PMI；公差带为工程记录，不代表已经生成公差牙型。选预设会填入切削底孔建议，可继续修改。</div>';
    }
  } else if (f.type === 'groove' || f.type === 'internal-keyway') {
    const internal = f.type === 'internal-keyway' || f.location === 'inner';
    html += heading('附着位置') + '<div class="field-grid">';
    if (f.type === 'groove') html += sf('槽的位置', 'location', f.location, [['outer', '外圆环槽'], ['inner', '内孔环槽']], true);
    if (internal) {
      html += sf('所属内腔', 'boreId', f.boreId, [['', '请选择内腔'], ...bores], true);
      const b = features.find(item => item.id === f.boreId && item.type === 'bore');
      html += sf('内孔圆柱段', 'boreSegmentId', f.boreSegmentId, [['', '请选择内孔段'], ...(b?.segments || []).filter(s => s.type === 'cylinder').map((s, i) => [s.id, s.name || `内阶梯 ${i + 1}`])], true);
    } else html += sf('外圆宿主', 'segmentId', f.segmentId, external, true);
    html += nf('段内起点 X', 'position', f.position, { min: 0, wide: true }) + '</div>';
    html += heading('槽尺寸') + '<div class="field-grid">' + (f.type === 'internal-keyway' ? nf('轴向长度', 'length', f.length, { min: .1 }) : '') + nf(f.type === 'groove' ? '轴向槽宽' : '键槽宽度', 'width', f.width, { min: .1 }) + nf('径向槽深', 'depth', f.depth, { min: .05 });
    if (f.type === 'internal-keyway') html += nf('周向角度 θ', 'angle', f.angle, { unit: '°', step: 1 });
    html += '</div><p class="panel-note">起点从宿主段全局 X 左边界测量。' + (internal ? '内槽从内孔表面向外切除；需保留外侧壁厚。' : '外槽从外圆向轴心切除；需保留内部材料。') + (f.type === 'internal-keyway' ? '本版本为矩形端平底内键槽。' : '') + '</p>';
  }
  let dimensions = [];
  try { dimensions = getFeatureDimensions(model, f).filter(d => !d.subId || d.subId === selectedBoreSegment); } catch { /* 不完整草稿继续可编辑。 */ }
  const derived = dimensions.filter(d => ['bottomThickness', 'wallThickness'].includes(d.key));
  if (derived.length) html += `<div class="derived-feature-dimensions">${derived.map(d => `<span>${escape(d.title)}<b>${fmt(d.value)} ${escape(d.unit || 'mm')}</b></span>`).join('')}</div>`;
  html += '</div>';
  return html;
}
