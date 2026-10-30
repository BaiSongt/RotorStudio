import './style.css';
import { createIcons, Plus, ChevronDown, Download, FolderOpen, Save, Undo2, Redo2, Copy, Trash2, ArrowUp, ArrowDown, X, Check, Settings2, Layers, Cog, Box, CircleDot, Scissors, Ruler, MoveHorizontal, Focus, Rotate3d, Sun, Moon, HelpCircle, PanelLeftClose, PanelLeftOpen, FileJson, TriangleAlert, LoaderCircle, Info, RotateCcw } from 'lucide';
import { PartViewport } from './viewport.js';
import { DEFAULT_MODEL, PRESETS, MATERIALS, LIMITS, createSegment, createKeyway, createHole, cloneModel, normalizeModel, validateModel, getSegmentLayout, getModelBounds, getKeywayAxialLength, uid, minSegmentRadius } from './schema.js';
import { getDimensionSpec, applyDimensionEdit } from './dimensions.js';

const icons = { Plus, ChevronDown, Download, FolderOpen, Save, Undo2, Redo2, Copy, Trash2, ArrowUp, ArrowDown, X, Check, Settings2, Layers, Cog, Box, CircleDot, Scissors, Ruler, MoveHorizontal, Focus, Rotate3d, Sun, Moon, HelpCircle, PanelLeftClose, PanelLeftOpen, FileJson, TriangleAlert, LoaderCircle, Info, RotateCcw };
const $ = (selector) => document.querySelector(selector);
const escape = (value) => String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const ico = (name, cls = '') => `<i data-lucide="${name}"${cls ? ` class="${cls}"` : ''}></i>`;
const decorate = () => createIcons({ icons, attrs: { 'stroke-width': 1.6 } });
const fmt = (value, places = 2) => Number.isFinite(value) ? Number(value.toFixed(places)).toLocaleString('zh-CN', { maximumFractionDigits: places }) : '—';
const typeNames = { cylinder: '圆柱段', cone: '圆锥段', gear: '直齿轮' };
const typeIcons = { cylinder: 'box', cone: 'layers', gear: 'cog' };
const keywayTypes = { round: '两端圆平键槽', square: '两端方平键槽', 'round-left': '左圆右方平键槽', 'round-right': '左方右圆平键槽', woodruff: '半圆键槽 · Woodruff' };
const STORAGE = 'rotor-studio-v1';
let model = cloneModel(DEFAULT_MODEL);
let restored = false;
try { const saved = localStorage.getItem(STORAGE); if (saved) { model = normalizeModel(JSON.parse(saved)); restored = true; } } catch { /* 无效旧工程不会覆盖内置案例。 */ }
let activeTab = 'segments';
let selectedSegment = model.segments.find((s) => s.type === 'gear')?.id || model.segments[0].id;
let selectedKeyway = model.keyways[0]?.id;
let selectedHole = model.holes[0]?.id;
let history = [], future = [];
let revision = 0, serial = 0, ready = false, worker, inFlight = null, pending = null, buildTimer;
let lastResult = null, lastBuiltRevision = -1, lastModel = null, currentValidation = validateModel(model);
let engineState = 'loading', engineMessage = '正在启动实体内核', exportBusy = false;
let needsFit = true, theme = 'light', wireMode = 'edges', dimensions = true, section = false, spin = false, draggingProfile = false;
const exportTasks = new Map();
let toastTimer;
let activeDownloadUrl = null;
let dimensionEditState = null;

$('#app').innerHTML = `
  <header class="app-header">
    <a class="brand" href="#" aria-label="Rotor Studio 首页"><img src="./favicon.svg" alt=""/><span><strong>Rotor Studio</strong><small>回转体参数化建模</small></span></a>
    <div class="header-divider"></div>
    <div class="project-title"><input id="project-name" aria-label="零件名称" maxlength="100" value="${escape(model.name)}"/><span class="save-state" id="save-state">${ico('check')}<span>${restored ? '已恢复本机工程' : '参数自动保存'}</span></span></div>
    <div class="header-actions">
      <div class="history-actions"><button class="icon-button" id="undo" title="撤销 · Ctrl+Z" aria-label="撤销">${ico('undo-2')}</button><button class="icon-button" id="redo" title="重做 · Ctrl+Shift+Z" aria-label="重做">${ico('redo-2')}</button></div>
      <button class="button ghost" id="presets-button">${ico('layers')}<span>示例</span>${ico('chevron-down')}</button>
      <button class="button ghost" id="import-button" title="打开参数工程 JSON">${ico('folder-open')}<span>打开</span></button>
      <button class="button ghost" id="save-button" title="保存可继续编辑的参数工程">${ico('save')}<span>保存工程</span></button>
      <button class="button primary" id="export-button" disabled>${ico('download')}<span>导出模型</span>${ico('chevron-down')}</button>
      <button class="icon-button" id="help-button" title="使用说明" aria-label="使用说明">${ico('help-circle')}</button>
    </div>
  </header>
  <div class="app-body">
    <aside class="sidebar" id="sidebar">
      <div class="sidebar-heading"><span>设计参数</span><span class="unit-label">mm · deg</span><button class="icon-button small" id="collapse-sidebar" title="收起参数面板" aria-label="收起参数面板">${ico('panel-left-close')}</button></div>
      <nav class="tabs" aria-label="特征类型"><button data-tab="segments" class="active">${ico('layers')}阶梯</button><button data-tab="keyways">${ico('scissors')}键槽</button><button data-tab="holes">${ico('circle-dot')}端面孔</button><button data-tab="project">${ico('settings-2')}设置</button></nav>
      <div id="panel-content" class="panel-content"></div>
      <div class="sidebar-bottom"><span class="dot teal"></span><span>参数驱动 · 实体建模</span><span>v1.1</span></div>
    </aside>
    <div id="resize-handle" class="resize-handle" role="separator" aria-label="调整参数面板宽度" aria-orientation="vertical" tabindex="0"></div>
    <main class="workspace">
      <div class="workspace-toolbar">
        <div class="toolbar-group"><button class="icon-button" id="expand-sidebar" title="展开参数面板" aria-label="展开参数面板" hidden>${ico('panel-left-open')}</button><span class="workspace-label">${ico('box')}<strong>模型空间</strong></span><span class="toolbar-separator"></span><button class="tool-button active" id="mode-button" title="切换着色与边线">${ico('box')}<span>实体 + 边线</span></button><button class="tool-button active" id="dimensions-button" title="显示或隐藏尺寸">${ico('ruler')}<span>尺寸</span></button><button class="tool-button" id="section-button" title="显示剖切，便于查看内孔">${ico('scissors')}<span>剖切</span></button></div>
        <div class="toolbar-group"><button class="icon-button" id="spin-button" title="自动旋转" aria-label="自动旋转">${ico('rotate-3d')}</button><button class="icon-button" id="theme-button" title="切换浅色或深色" aria-label="切换主题">${ico('moon')}</button><span class="toolbar-separator"></span><button class="tool-button" id="fit-button" title="适应窗口 · F">${ico('focus')}<span>适应</span><kbd>F</kbd></button></div>
      </div>
      <div class="viewport-area">
        <div id="viewport"></div>
        <div class="viewport-top"><div class="model-breadcrumb"><span>零件</span><span>/</span><strong id="model-label">${escape(model.name)}</strong></div><div class="engine-pill loading" id="engine-pill">${ico('loader-circle', 'spin')}<span id="engine-message">正在启动实体内核</span></div></div>
        <div class="viewport-note" id="section-note" hidden>剖切仅用于观察 · 导出保持完整实体</div>
        <div class="validation-banner" id="validation-banner" hidden></div>
        <div id="initial-loader" class="initial-loader"><span class="loading-orbit"></span><strong>正在生成你的零件</strong><span>载入几何内核，构建参数化实体</span><small>首次启动需要下载约 11 MB 内核</small></div>
        <div class="viewport-bottom"><div class="selection-info" id="selection-info"></div><div class="view-switcher" aria-label="标准视图"><button data-view="iso" class="active">等轴</button><button data-view="front">正视</button><button data-view="top">俯视</button><button data-view="left">左端</button><button data-view="right">右端</button></div><span class="mouse-hint">点击尺寸输入 · 拖动旋转 · 滚轮缩放</span></div>
      </div>
      <section class="profile-panel" id="profile-panel"><div class="profile-heading"><span>${ico('move-horizontal')}<strong>轴向轮廓</strong><span class="muted">点击尺寸输入 · 拖动分界线调整位置</span></span><div class="profile-stats" id="profile-stats"></div><button class="icon-button small" id="profile-toggle" title="收起轮廓" aria-label="收起轮廓">${ico('chevron-down')}</button></div><div id="profile-chart"></div></section>
      <footer class="statusbar"><div id="model-stats">${ico('loader-circle', 'spin')}<span>准备实体模型…</span></div><div><span id="quality-label">标准显示精度</span><span class="status-divider"></span><span>Three.js + OpenCascade</span></div></footer>
    </main>
  </div>
  <input type="file" id="import-file" accept=".json,.rotor.json,application/json" hidden/>
  <div class="popover" id="presets-menu" hidden><div class="menu-heading">从示例开始</div>${PRESETS.map((p) => `<button data-preset="${escape(p.id)}"><span class="preset-icon">${ico(p.id.includes('gear') ? 'cog' : p.id.includes('flange') ? 'circle-dot' : 'layers')}</span><span><strong>${escape(p.name)}</strong><small>${escape(p.description)}</small></span></button>`).join('')}<div class="menu-foot">当前工程会自动保留在撤销历史中</div></div>
  <div class="popover export-menu" id="export-menu" hidden><div class="menu-heading">导出当前实体 <span>含全部特征</span></div><button data-export="step"><span class="format-mark">STP</span><span><strong>STEP 实体模型</strong><small>用于 CAD / CAM · B-Rep · mm</small></span><span class="recommended">推荐</span></button><button data-export="stl"><span class="format-mark">STL</span><span><strong>STL 三角网格</strong><small>二进制 · 3D 打印 / 网格处理 · mm</small></span></button><button data-export="glb"><span class="format-mark">GLB</span><span><strong>GLB 三维模型</strong><small>含材质 · 网页 / 展示 · m</small></span></button><button data-export="obj"><span class="format-mark">OBJ</span><span><strong>OBJ 三角网格</strong><small>通用网格 · mm</small></span></button><div class="menu-foot">继续参数化编辑请使用「保存工程」</div></div>
  <div class="toast" id="toast" role="status" hidden></div>
  <form id="dimension-editor" class="dimension-editor" role="dialog" aria-labelledby="dimension-editor-title" aria-describedby="dimension-editor-hint" novalidate hidden>
    <div class="dimension-editor-heading"><span>${ico('ruler')}<strong id="dimension-editor-title">编辑尺寸</strong></span><button type="button" class="icon-button small" id="dimension-editor-close" aria-label="取消尺寸编辑">${ico('x')}</button></div>
    <label class="input-wrap" for="dimension-editor-input"><input id="dimension-editor-input" type="number" inputmode="decimal" aria-describedby="dimension-editor-hint dimension-editor-error" autocomplete="off"/><em id="dimension-editor-unit">mm</em></label>
    <p id="dimension-editor-hint" class="dimension-editor-hint"></p>
    <p id="dimension-editor-error" class="dimension-editor-error" role="alert" hidden></p>
    <div class="dimension-editor-actions"><span><kbd>Enter</kbd> 确认 · <kbd>Esc</kbd> 取消</span><button type="submit" class="button primary">应用 ${ico('check')}</button></div>
  </form>
  <div class="download-ready" id="download-ready" hidden><span>${ico('check')}文件已生成</span><a id="download-ready-link">下载文件</a><button class="icon-button small" id="dismiss-download" title="关闭下载提示" aria-label="关闭下载提示">${ico('x')}</button></div>
  <dialog id="help-dialog" class="help-dialog"><div class="dialog-heading"><div><span class="eyebrow">ROTOR STUDIO</span><h2>从尺寸到实体，六步完成设计</h2></div><button class="icon-button" data-close-dialog aria-label="关闭说明">${ico('x')}</button></div><div class="help-grid"><section><b>01 / 定义阶梯</b><p>添加、复制或调整阶梯顺序。长度控制各段尺寸，起点控制轴向位置。圆柱段可切换为圆锥或直齿轮。</p></section><section><b>02 / 调整位置</b><p>点击三维或底部尺寸直接输入，Enter 应用、Esc 取消。起点联动前一段长度；总长联动末段长度。拖动底部分界线保持总长，所有修改均可撤销。</p></section><section><b>03 / 设置齿形</b><p>选择直齿轮，输入模数、齿数与压力角。节圆、齿顶和齿根直径按公式联动；齿廓按渐开线采样构建。</p></section><section><b>04 / 添加键槽</b><p>支持两端圆、两端方、左圆右方、左方右圆平键槽及半圆键槽。半圆键槽仅用于圆柱段，由圆盘刀直径与槽深联动槽口长度；0° 位于 +Y 上方。</p></section><section><b>05 / 设置端面孔</b><p>支持左右端面中心孔、偏置孔、圆周孔阵列、盲孔、通孔与沉孔。孔径、深度、分布圆和相位均可调。</p></section><section><b>06 / 保存与导出</b><p>STEP 保留实体；STL / OBJ 为毫米网格；GLB 转为米。工程 JSON 保留全部可编辑参数，可随时重新打开。</p></section></div><div class="help-note">${ico('info')}<p>支持无变位渐开线直齿的采样近似、平底圆孔和45°直倒角。齿根未模拟滚刀包络；不包含斜齿、螺纹、圆角、PMI与公差。用于制造前，请在 CAD / CAM 中核验尺寸及工艺要求。</p></div><div class="dialog-footer"><span>快捷键：<kbd>Ctrl Z</kbd> 撤销 <kbd>Ctrl S</kbd> 保存 <kbd>F</kbd> 适应窗口</span><button class="button primary" data-close-dialog>开始设计 ${ico('check')}</button></div></dialog>
`;

let viewport;
let viewportError = '';
try { viewport = new PartViewport($('#viewport'), { onSelect: (id) => selectSegment(id, true), onDimensionEdit: openDimensionEditor, onAutoRotateChange: (enabled) => { spin = enabled; $('#spin-button').classList.toggle('active', enabled); } }); }
catch (error) {
  viewportError = error.message;
  $('#initial-loader').innerHTML = `<strong>当前浏览器未启用 WebGL</strong><span>启用浏览器硬件加速后，可查看交互式三维模型。</span><small>参数编辑、轴向轮廓及 STEP / STL 导出仍可使用。</small>`;
  for (const selector of ['#mode-button', '#dimensions-button', '#section-button', '#spin-button', '#fit-button', '[data-export="glb"]', '[data-export="obj"]', '[data-view]']) document.querySelectorAll(selector).forEach((b) => { b.disabled = true; b.title = '需要可用的 WebGL 三维视图'; });
}

function numberField(label, scope, key, value, { unit = 'mm', min, max, step = 0.1, disabled = false, hint = '', wide = false } = {}) {
  const id = `field-${scope}-${key.replace('.', '-')}`;
  return `<label class="field${wide ? ' wide' : ''}" for="${id}"><span>${label}${hint ? `<small>${hint}</small>` : ''}</span><div class="input-wrap${disabled ? ' disabled' : ''}"><input id="${id}" data-scope="${scope}" data-field="${key}" type="number" value="${Number.isFinite(value) ? value : ''}" step="${step}"${min !== undefined ? ` min="${min}"` : ''}${max !== undefined ? ` max="${max}"` : ''}${disabled ? ' disabled' : ''} inputmode="decimal"/><em>${unit}</em></div></label>`;
}
function selectField(label, scope, key, value, options, wide = false) {
  return `<label class="field${wide ? ' wide' : ''}"><span>${label}</span><select data-scope="${scope}" data-field="${key}" aria-label="${label}">${options.map(([v, n]) => `<option value="${escape(v)}"${value === v ? ' selected' : ''}>${escape(n)}</option>`).join('')}</select></label>`;
}
function toggleField(label, scope, key, value, caption = '') {
  return `<label class="toggle-row"><span><strong>${label}</strong>${caption ? `<small>${caption}</small>` : ''}</span><input type="checkbox" data-scope="${scope}" data-field="${key}"${value ? ' checked' : ''}/><span class="toggle-track"></span></label>`;
}
function sectionHeading(title, sub = '') { return `<div class="property-heading"><strong>${title}</strong>${sub ? `<span>${sub}</span>` : ''}</div>`; }

function dimensionAttributes(target) {
  return `data-dimension-kind="${escape(target.kind)}"${target.id ? ` data-segment-id="${escape(target.id)}"` : ''}`;
}

// 两个视图共用一个编辑器；只有完整通过约束校验的尺寸才进入撤销历史。
function openDimensionEditor(target, anchor) {
  if (draggingProfile) return;
  let spec;
  try { spec = getDimensionSpec(model, target); }
  catch (error) { toast(error.message, true); return; }
  const rect = anchor.getBoundingClientRect();
  const surface = anchor.closest('#viewport') ? '3d' : 'profile';
  closeDimensionEditor(false);
  closeMenus();
  if (spec.segmentId) {
    selectedSegment = spec.segmentId; activeTab = 'segments'; renderPanel();
    // 保留尺寸按钮与滚动位置，避免重建轮廓触发排队的 scroll 事件关闭输入框。
    document.querySelectorAll('[data-profile-segment]').forEach((el) => el.classList.toggle('selected', el.dataset.profileSegment === selectedSegment));
    document.querySelectorAll('.profile-value[data-segment-id]').forEach((el) => el.classList.toggle('is-selected', el.dataset.segmentId === selectedSegment));
  }
  dimensionEditState = { target: { ...target }, revision, rect, surface, anchor, value: spec.value, scrollLeft: $('#profile-chart').scrollLeft };
  viewport?.setDimensionEditing(true);
  const editor = $('#dimension-editor'), input = $('#dimension-editor-input');
  $('#dimension-editor-title').textContent = spec.title;
  $('#dimension-editor-unit').textContent = spec.unit;
  $('#dimension-editor-hint').textContent = spec.hint;
  $('#dimension-editor-error').hidden = true;
  input.setAttribute('aria-label', spec.title);
  input.removeAttribute('aria-invalid');
  input.value = String(spec.value); input.step = String(spec.step);
  for (const attr of ['min', 'max']) if (Number.isFinite(spec[attr])) input.setAttribute(attr, spec[attr]); else input.removeAttribute(attr);
  editor.hidden = false;
  positionDimensionEditor();
  input.focus({ preventScroll: true }); input.select();
}

function positionDimensionEditor() {
  if (!dimensionEditState) return;
  const editor = $('#dimension-editor'), rect = dimensionEditState.rect, gap = 9;
  editor.style.left = `${Math.max(8, Math.min(innerWidth - editor.offsetWidth - 8, rect.left + rect.width / 2 - editor.offsetWidth / 2))}px`;
  const below = rect.bottom + gap;
  editor.style.top = `${Math.max(8, Math.min(innerHeight - editor.offsetHeight - 8, below + editor.offsetHeight <= innerHeight - 8 ? below : rect.top - editor.offsetHeight - gap))}px`;
}

function closeDimensionEditor(restoreFocus = true) {
  const previous = dimensionEditState;
  dimensionEditState = null;
  $('#dimension-editor').hidden = true;
  if (!previous) return;
  viewport?.setDimensionEditing(false);
  if (restoreFocus) focusDimensionAnchor(previous);
}

function focusDimensionAnchor(state) {
  const region = state.surface === '3d' ? $('#viewport') : $('#profile-panel');
  const anchor = state.anchor.isConnected ? state.anchor : [...region.querySelectorAll('[data-dimension-kind]')].find((el) => el.dataset.dimensionKind === state.target.kind && (el.dataset.segmentId || '') === (state.target.id || ''));
  anchor?.focus({ preventScroll: true });
}

function applyDimensionEditor() {
  if (!dimensionEditState) return false;
  const state = dimensionEditState, input = $('#dimension-editor-input');
  try {
    if (state.revision !== revision) throw new Error('参数已发生变化，请取消后重新打开这个尺寸。');
    const next = applyDimensionEdit(model, state.target, input.value);
    closeDimensionEditor(false);
    if (Number(input.value) !== state.value) commit(() => { model = next; }, { message: '尺寸已更新，正在重建实体' });
    focusDimensionAnchor(state);
    return true;
  } catch (error) {
    const message = $('#dimension-editor-error'); message.textContent = error.message; message.hidden = false;
    input.setAttribute('aria-invalid', 'true'); positionDimensionEditor(); input.focus({ preventScroll: true });
    return false;
  }
}

function keywayPreview(key) {
  const paths = {
    round: 'M36 16H104A14 14 0 0 1 104 44H36A14 14 0 0 1 36 16Z',
    square: 'M22 16H118V44H22Z',
    'round-left': 'M36 16H118V44H36A14 14 0 0 1 36 16Z',
    'round-right': 'M22 16H104A14 14 0 0 1 104 44H22Z',
    woodruff: 'M26 17H114A50 50 0 0 1 26 17Z',
  };
  return `<div class="keyway-preview"><svg viewBox="0 0 140 64" role="img" aria-label="${escape(keywayTypes[key.ends] || '')}形状示意"><path class="keyway-preview-axis" d="M10 30H130"/><path class="keyway-preview-shape" d="${paths[key.ends] || paths.round}"/></svg><span><strong>${escape(keywayTypes[key.ends] || '')}</strong><small>${key.ends === 'woodruff' ? '轴向剖面 · 圆盘刀形成圆弧槽底' : '上视轮廓 · 总长包含圆弧端部'}</small></span></div>`;
}

function renderPanel() {
  document.querySelectorAll('[data-tab]').forEach((b) => b.classList.toggle('active', b.dataset.tab === activeTab));
  const panel = $('#panel-content');
  const savedScroll = panel.scrollTop;
  let html = '';
  if (activeTab === 'segments') {
    const layout = getSegmentLayout(model), segment = model.segments.find((s) => s.id === selectedSegment) || model.segments[0];
    selectedSegment = segment.id;
    const index = model.segments.indexOf(segment), pos = layout[index];
    html = `<div class="list-heading"><span>阶梯序列 <b>${String(model.segments.length).padStart(2, '0')}</b></span><button class="mini-button" data-action="add-segment"${model.segments.length >= LIMITS.segments ? ' disabled' : ''}>${ico('plus')}添加阶梯</button></div><div class="segment-list">`;
    html += layout.map((s, i) => `<button class="segment-row ${s.id === selectedSegment ? 'selected' : ''}" data-segment="${escape(s.id)}"><span class="segment-number">${String(i + 1).padStart(2, '0')}</span><span class="segment-symbol ${s.type}">${ico(typeIcons[s.type])}</span><span class="segment-summary"><strong>${escape(s.name)}</strong><small>${s.type === 'gear' ? `m ${fmt(s.gear.module)} · z ${s.gear.teeth}` : `Ø ${fmt(s.diameter)}${s.type === 'cone' ? ` → ${fmt(s.endDiameter)}` : ''}`}<span>L ${fmt(s.length)}</span></small></span><span class="segment-feature-dots">${model.keyways.some((k) => k.segmentId === s.id && k.enabled) ? '<i title="包含键槽"></i>' : ''}</span></button>`).join('') + '</div>';
    html += `<div class="properties"><div class="selected-heading"><span><span class="tiny-number">${String(index + 1).padStart(2, '0')}</span><strong>阶梯参数</strong></span><div class="mini-actions"><button class="icon-button small" data-action="segment-up" title="前移阶梯" aria-label="前移阶梯"${index === 0 ? ' disabled' : ''}>${ico('arrow-up')}</button><button class="icon-button small" data-action="segment-down" title="后移阶梯" aria-label="后移阶梯"${index === model.segments.length - 1 ? ' disabled' : ''}>${ico('arrow-down')}</button><button class="icon-button small" data-action="duplicate-segment" title="复制阶梯" aria-label="复制阶梯"${model.segments.length >= LIMITS.segments ? ' disabled' : ''}>${ico('copy')}</button><button class="icon-button small danger" data-action="delete-segment" title="删除阶梯及其键槽" aria-label="删除阶梯及其键槽"${model.segments.length === 1 ? ' disabled' : ''}>${ico('trash-2')}</button></div></div>`;
    html += `<label class="field wide"><span>名称</span><input class="text-input" data-scope="segment" data-field="name" maxlength="100" value="${escape(segment.name)}" aria-label="阶梯名称"/></label><div class="type-selector" aria-label="阶梯类型">${Object.entries(typeNames).map(([value, label]) => `<button data-segment-type="${value}" class="${segment.type === value ? 'active' : ''}">${ico(typeIcons[value])}${label}</button>`).join('')}</div>`;
    html += sectionHeading('轴向尺寸', 'X 轴 / 左 → 右') + '<div class="field-grid">' + numberField('轴向起点', 'segment', 'start', pos.start, { min: 0, disabled: index === 0 }) + numberField('段长 L', 'segment', 'length', segment.length, { min: .1 }) + '</div>';
    html += `<div class="field-help">终点 X = ${fmt(pos.end)} mm${index > 0 ? ' · 修改起点将联动前段长度' : ' · 第一段固定从原点开始'}</div>`;
    if (segment.type === 'gear') {
      html += sectionHeading('直齿轮参数', '无变位 / 外齿') + '<div class="field-grid">' + numberField('模数 m', 'gear', 'module', segment.gear.module, { min: .1, max: 25, step: .25 }) + numberField('齿数 z', 'gear', 'teeth', segment.gear.teeth, { unit: '齿', min: 12, max: 120, step: 1 }) + numberField('压力角 α', 'gear', 'pressureAngle', segment.gear.pressureAngle, { unit: '°', min: 10, max: 35, step: .5 }) + numberField('周向相位', 'gear', 'rotation', segment.gear.rotation, { unit: '°', step: 1 }) + '</div>';
      const g = segment.gear;
      html += `<div class="derived-grid"><span>节圆 Ø<strong>${fmt(g.module * g.teeth)}</strong></span><span>齿顶 Ø<strong>${fmt(pos.maxDiameter)}</strong></span><span>齿根 Ø<strong>${fmt(pos.rootDiameter)}</strong></span></div><details class="advanced"><summary>齿顶 / 齿根与齿厚</summary><div class="field-grid">${numberField('齿顶高系数', 'gear', 'addendum', g.addendum, { unit: 'hₐ*', min: .3, max: 1.5, step: .05 })}${numberField('齿根高系数', 'gear', 'dedendum', g.dedendum, { unit: 'hբ*', min: .5, max: 2, step: .05 })}${numberField('齿厚减薄量', 'gear', 'backlash', g.backlash, { min: 0, step: .01, wide: true })}</div></details><p class="panel-note">渐开线齿廓采样近似。直径随模数和齿数联动；齿轮段暂不设置倒角。</p>`;
    } else {
      html += sectionHeading('径向尺寸') + '<div class="field-grid">' + numberField(segment.type === 'cone' ? '左端直径' : '直径 D', 'segment', 'diameter', segment.diameter, { min: .5, wide: segment.type === 'cylinder' }) + (segment.type === 'cone' ? numberField('右端直径', 'segment', 'endDiameter', segment.endDiameter, { min: .5 }) : '') + '</div>';
      html += sectionHeading('端部倒角', '45°') + '<div class="field-grid">' + numberField('左端 C', 'segment', 'chamferLeft', segment.chamferLeft, { min: 0 }) + numberField('右端 C', 'segment', 'chamferRight', segment.chamferRight, { min: 0 }) + '</div>';
    }
    html += `<button class="button full outline" data-action="keyway-on-segment">${ico('plus')}在此阶梯添加键槽</button></div>`;
  } else if (activeTab === 'keyways') {
    html = `<div class="list-heading"><span>键槽特征 <b>${String(model.keyways.length).padStart(2, '0')}</b></span><button class="mini-button" data-action="add-keyway">${ico('plus')}添加键槽</button></div>`;
    html += model.keyways.length ? `<div class="feature-list">${model.keyways.map((k, i) => `<button class="feature-row ${k.id === selectedKeyway ? 'selected' : ''}" data-keyway="${escape(k.id)}"><span class="feature-icon">${ico('scissors')}</span><span><strong>键槽 ${String(i + 1).padStart(2, '0')} · ${escape(keywayTypes[k.ends] || k.ends)}${k.enabled ? '' : ' · 已停用'}</strong><small>${escape(model.segments.find((s) => s.id === k.segmentId)?.name || '')} · ${fmt(k.width)} × ${fmt(k.depth)} × ${fmt(getKeywayAxialLength(k))}</small></span></button>`).join('')}</div>` : emptyPanel('scissors', '给轴面添加键槽', '选中一个阶梯，定义键槽的位置、宽度与深度。');
    const k = model.keyways.find((k) => k.id === selectedKeyway);
    if (k) {
      html += `<div class="properties"><div class="selected-heading"><strong>键槽参数</strong><div class="mini-actions"><button class="icon-button small" data-action="duplicate-keyway" title="复制并旋转180°" aria-label="复制并旋转180°">${ico('copy')}</button><button class="icon-button small danger" data-action="delete-keyway" title="删除键槽" aria-label="删除键槽">${ico('trash-2')}</button></div></div>`;
      const woodruff = k.ends === 'woodruff';
      html += toggleField('启用特征', 'keyway', 'enabled', k.enabled) + '<div class="field-grid">' + selectField('所属阶梯', 'keyway', 'segmentId', k.segmentId, model.segments.map((s, i) => [s.id, `${i + 1} · ${s.name}`]), true) + selectField('键槽类型', 'keyway', 'ends', k.ends, Object.entries(keywayTypes), true) + '</div>' + keywayPreview(k);
      html += '<div class="field-grid">' + (woodruff ? numberField('圆盘刀直径 Dc', 'keyway', 'cutterDiameter', k.cutterDiameter ?? 24, { min: LIMITS.minDiameter, wide: true }) : '') + numberField('段内起点', 'keyway', 'position', k.position, { min: 0 }) + numberField(woodruff ? '槽口长度 L' : '总长 L', 'keyway', 'length', woodruff ? Number(getKeywayAxialLength(k).toFixed(4)) : k.length, { min: .1, disabled: woodruff, hint: woodruff ? '自动计算' : '' }) + numberField('槽宽 W', 'keyway', 'width', k.width, { min: .1 }) + numberField('槽深 t', 'keyway', 'depth', k.depth, { min: .05 }) + numberField('周向角度 θ', 'keyway', 'angle', k.angle, { unit: '°', step: 1, wide: true }) + '</div>';
      html += `<p class="panel-note">${woodruff ? '半圆键槽仅用于圆柱段。圆盘刀直径与槽深决定槽口长度；起点为槽口最左端，槽底保持真实圆弧。' : '总长包含圆弧端部；左、右按 X 轴方向区分。端点设在阶梯边界，可形成端部开口。'}<br/>0° 位于 +Y 上方，正角度绕 +X 轴旋转。支持多组独立键槽。</p></div>`;
    }
  } else if (activeTab === 'holes') {
    html = `<div class="list-heading"><span>端面孔组 <b>${String(model.holes.length).padStart(2, '0')}</b></span><button class="mini-button" data-action="add-hole">${ico('plus')}添加孔组</button></div>`;
    html += model.holes.length ? `<div class="feature-list">${model.holes.map((h, i) => `<button class="feature-row ${h.id === selectedHole ? 'selected' : ''}" data-hole="${escape(h.id)}"><span class="feature-icon orange">${ico('circle-dot')}</span><span><strong>${h.face === 'left' ? '左' : '右'}端孔组 ${String(i + 1).padStart(2, '0')}${h.enabled ? '' : ' · 已停用'}</strong><small>${h.count} × Ø${fmt(h.diameter)} · ${h.through ? '通孔' : `深 ${fmt(h.depth)}`} ${h.pcd ? `· PCD ${fmt(h.pcd)}` : ''}</small></span></button>`).join('')}</div>` : emptyPanel('circle-dot', '设置端面孔', '从左端或右端钻入，可定义中心孔与圆周阵列。');
    const h = model.holes.find((h) => h.id === selectedHole);
    if (h) {
      html += `<div class="properties"><div class="selected-heading"><strong>端面孔参数</strong><div class="mini-actions"><button class="icon-button small" data-action="duplicate-hole" title="复制到另一端" aria-label="复制到另一端">${ico('copy')}</button><button class="icon-button small danger" data-action="delete-hole" title="删除孔组" aria-label="删除孔组">${ico('trash-2')}</button></div></div>`;
      html += toggleField('启用特征', 'hole', 'enabled', h.enabled) + '<div class="field-grid">' + selectField('加工端面', 'hole', 'face', h.face, [['left', '左端 · X=0'], ['right', '右端 · X=L']], true) + numberField('孔径 D', 'hole', 'diameter', h.diameter, { min: .1 }) + numberField('孔深', 'hole', 'depth', h.depth, { min: .1, disabled: h.through }) + '</div>' + toggleField('贯穿整个零件', 'hole', 'through', h.through, '孔深由零件总长决定');
      html += sectionHeading('孔位与圆周阵列') + '<div class="field-grid">' + numberField('孔数量', 'hole', 'count', h.count, { unit: '个', min: 1, max: 24, step: 1 }) + numberField('分布圆 PCD', 'hole', 'pcd', h.pcd, { min: 0 }) + numberField('起始角度', 'hole', 'angle', h.angle, { unit: '°', step: 1, wide: true }) + '</div><div class="field-help">中心孔：数量 1，PCD 0。偏置孔：PCD &gt; 0。</div>';
      html += sectionHeading('端面沉孔', '均为平底') + '<div class="field-grid">' + numberField('沉孔直径', 'hole', 'counterboreDiameter', h.counterboreDiameter, { min: 0 }) + numberField('沉孔深度', 'hole', 'counterboreDepth', h.counterboreDepth, { min: 0 }) + '</div><p class="panel-note">沉孔直径与深度同时设为 0 即关闭。孔组会校验整个钻入区间，避免穿出细轴侧壁。暂不包含螺纹和钻尖。</p></div>';
    }
  } else {
    html = `<div class="properties project-settings">${sectionHeading('工程设置')}<div class="field-grid">${selectField('材料 / 质量估算', 'model', 'material', model.material, Object.entries(MATERIALS).map(([id, v]) => [id, `${v.name} · ${v.density} g/cm³`]), true)}${selectField('网格显示与 STL 精度', 'model', 'quality', model.quality, [['standard', '标准 · 日常编辑'], ['fine', '精细 · 导出与展示']], true)}</div><p class="panel-note">材料用于质量估算。STEP 导出使用同一实体；显示精度只改变三角网格的细密程度。</p>${sectionHeading('坐标与单位')}<div class="definition-list"><span>轴向</span><strong>X，左 → 右</strong><span>径向</span><strong>Y / Z 平面</strong><span>长度 / 角度</span><strong>mm / °</strong><span>工程格式</span><strong>JSON v1</strong><span>数据位置</span><strong>当前浏览器本机</strong></div>${sectionHeading('支持范围')}<div class="capabilities"><span>${ico('check')}圆柱 / 圆锥 / 直齿</span><span>${ico('check')}多阶梯与45°倒角</span><span>${ico('check')}平键槽 / 单圆头 / 半圆键槽</span><span>${ico('check')}孔阵列 / 通孔 / 沉孔</span></div><p class="panel-note">齿轮使用采样渐开线，齿根为几何过渡。未包含变位、斜齿、螺纹、圆角、PMI 和公差。</p><button class="button full outline" data-action="help">${ico('help-circle')}查看使用说明</button><button class="button full ghost" data-action="reset">${ico('rotate-ccw')}恢复默认齿轮轴</button></div>`;
  }
  panel.innerHTML = html;
  panel.scrollTop = savedScroll;
  renderSelection();
  decorate();
}
function emptyPanel(icon, title, caption) { return `<div class="empty-panel">${ico(icon)}<strong>${title}</strong><p>${caption}</p></div>`; }

function renderSelection() {
  const s = model.segments.find((s) => s.id === selectedSegment);
  if (!s) return;
  $('#selection-info').innerHTML = `<span class="selection-dot"></span><strong>${escape(s.name)}</strong><span>${s.type === 'gear' ? `m ${fmt(s.gear.module)} · z ${s.gear.teeth}` : `Ø ${fmt(s.diameter)}`} × ${fmt(s.length)}</span>`;
  viewport?.setSelection(selectedSegment);
}

function renderProfile() {
  const { length, maxDiameter } = getModelBounds(model);
  if (!Number.isFinite(length) || length <= 0 || !Number.isFinite(maxDiameter) || maxDiameter <= 0) return;
  const layout = getSegmentLayout(model), w = 1000, h = 136, left = 48, right = 48, axis = 60, scale = (w - left - right) / length;
  const diameterTarget = (s, rightEnd = false) => ({ kind: s.type === 'gear' ? 'gear-tip-diameter' : rightEnd ? 'segment-end-diameter' : 'segment-diameter', id: s.id });
  const largest = layout.find((s) => s.maxDiameter === maxDiameter);
  const largestTarget = diameterTarget(largest, largest.type === 'cone' && largest.endDiameter > largest.diameter);
  $('#profile-stats').innerHTML = `<button type="button" ${dimensionAttributes({ kind: 'total-length' })} title="点击编辑总长，通过末段长度调整">总长 <b>${fmt(length)}</b> mm</button><button type="button" ${dimensionAttributes(largestTarget)} title="编辑${escape(largest.name)}的${largest.type === 'gear' ? '齿顶' : ''}直径">最大 Ø <b>${fmt(maxDiameter)}</b> mm</button>`;
  const radial = Math.min(37 / (maxDiameter / 2), 1.8);
  const x = (v) => left + v * scale, y = (v) => axis - v * radial;
  let paths = '', annotations = '', features = '', labels = '';
  const dimensionButton = (target, text, xx, yy, title, cls = '') => `<button type="button" class="profile-value ${cls}" ${dimensionAttributes(target)} style="left:${xx / w * 100}%;top:${yy / h * 100}%" title="${escape(title)} · 点击输入" aria-label="编辑${escape(title)}">${escape(text)}</button>`;
  layout.forEach((s, i) => {
    const r1 = (s.type === 'gear' ? s.maxDiameter : s.diameter) / 2, r2 = s.type === 'cone' ? s.endDiameter / 2 : r1;
    const points = `${x(s.start)},${y(r1)} ${x(s.end)},${y(r2)} ${x(s.end)},${y(-r2)} ${x(s.start)},${y(-r1)}`;
    const active = s.id === selectedSegment ? ' is-selected' : '';
    paths += `<g class="profile-segment${active ? ' selected' : ''} ${s.type}" data-profile-segment="${escape(s.id)}" role="button" tabindex="0" aria-label="选择${escape(s.name)}"><polygon points="${points}"/>${s.type === 'gear' ? `<path class="gear-root-line" d="M${x(s.start)} ${y(s.rootDiameter / 2)}H${x(s.end)}M${x(s.start)} ${y(-s.rootDiameter / 2)}H${x(s.end)}"/>` : ''}<text x="${x((s.start + s.end) / 2)}" y="${axis - 3}" text-anchor="middle">${String(i + 1).padStart(2, '0')}</text></g>`;
    annotations += `<path class="profile-dimension" d="M${x(s.start)} 103V113M${x(s.start)} 108H${x(s.end)}M${x(s.end)} 103V113"/>`;
    labels += dimensionButton({ kind: 'segment-length', id: s.id }, fmt(s.length), x((s.start + s.end) / 2), 124, `${s.name} 段长 ${fmt(s.length)} mm`, `profile-length${active}`);
    if (i > 0) {
      annotations += `<g class="profile-boundary" data-boundary="${i}" tabindex="0" role="slider" aria-label="拖动第${i + 1}段起点" aria-valuenow="${s.start}" aria-valuemin="${layout[i - 1].start + .1}" aria-valuemax="${s.end - .1}"><path d="M${x(s.start)} 26V101"/><rect x="${x(s.start) - 3}" y="21" width="6" height="8" rx="2"/><rect class="boundary-hit" x="${x(s.start) - 7}" y="20" width="14" height="81"/></g>`;
      labels += dimensionButton({ kind: 'segment-start', id: s.id }, fmt(s.start), x(s.start), 10, `${s.name} 起点 X ${fmt(s.start)} mm`, 'profile-position');
    } else labels += `<span class="profile-origin" style="left:${x(0) / w * 100}%;top:${10 / h * 100}%" title="原点 X=0 固定">0</span>`;
    if (s.type === 'cone') {
      labels += dimensionButton(diameterTarget(s), `Ø${fmt(s.diameter)}`, x(s.start + s.length * .28), axis + 13, `${s.name} 左端直径 ${fmt(s.diameter)} mm`, `profile-diameter${active}`);
      labels += dimensionButton(diameterTarget(s, true), `Ø${fmt(s.endDiameter)}`, x(s.start + s.length * .72), axis + 13, `${s.name} 右端直径 ${fmt(s.endDiameter)} mm`, `profile-diameter${active}`);
    } else labels += dimensionButton(diameterTarget(s), `${s.type === 'gear' ? '齿顶 ' : ''}Ø${fmt(s.maxDiameter)}`, x((s.start + s.end) / 2), axis + 13, `${s.name} ${s.type === 'gear' ? '齿顶' : ''}直径 ${fmt(s.maxDiameter)} mm`, `profile-diameter${active}`);
  });
  model.keyways.filter((k) => k.enabled).forEach((k) => {
    const s = layout.find((s) => s.id === k.segmentId), axialLength = getKeywayAxialLength(k);
    if (!s || !Number.isFinite(axialLength) || axialLength <= 0) return;
    const start = s.start + k.position, radius = s.rootDiameter / 2;
    if (k.ends === 'woodruff') {
      const cutterRadius = (k.cutterDiameter ?? 24) / 2, center = start + axialLength / 2;
      const points = Array.from({ length: 25 }, (_, i) => { const xx = start + axialLength * i / 24; const yy = radius - k.depth + cutterRadius - Math.sqrt(Math.max(0, cutterRadius ** 2 - (xx - center) ** 2)); return `${x(xx)},${y(yy)}`; });
      features += `<polygon class="profile-keyway" points="${points.join(' ')}"><title>半圆键槽轴向剖面示意</title></polygon>`;
    } else {
      const x0 = x(start), x1 = x(start + axialLength), top = y(radius) + 3, bottom = top + 4;
      const roundLeft = ['round', 'round-left'].includes(k.ends), roundRight = ['round', 'round-right'].includes(k.ends), r = Math.min(2, (x1 - x0) / 2);
      features += `<path class="profile-keyway" d="M${x0 + (roundLeft ? r : 0)} ${top}H${x1 - (roundRight ? r : 0)}${roundRight ? `Q${x1} ${top} ${x1} ${top + 2}Q${x1} ${bottom} ${x1 - r} ${bottom}` : `V${bottom}`}H${x0 + (roundLeft ? r : 0)}${roundLeft ? `Q${x0} ${bottom} ${x0} ${top + 2}Q${x0} ${top} ${x0 + r} ${top}` : `V${top}`}Z"/>`;
    }
  });
  model.holes.filter((hole) => hole.enabled && hole.pcd === 0).forEach((hole) => { const d = hole.through ? length : hole.depth, start = hole.face === 'left' ? 0 : length - d; features += `<rect class="profile-hole" x="${x(start)}" y="${y(hole.diameter / 2)}" width="${d * scale}" height="${hole.diameter * radial}"/>`; });
  labels += dimensionButton({ kind: 'total-length' }, fmt(length), x(length), 10, `总长 ${fmt(length)} mm`, 'profile-position');
  const chart = $('#profile-chart'), scrollLeft = chart.scrollLeft;
  chart.innerHTML = `<div class="profile-drawing" style="min-width:${Math.max(560, layout.length * 72 + 96)}px"><svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-label="阶梯轴向轮廓"><path class="profile-axis" d="M15 ${axis}H${w - 15}"/>${paths}${features}${annotations}<text class="profile-axis-label" x="${w - 10}" y="${axis - 6}" text-anchor="end">X</text></svg><div class="profile-label-layer">${labels}</div></div>`;
  chart.scrollLeft = scrollLeft;
}

function selectSegment(id, switchTab = false) {
  if (!model.segments.some((s) => s.id === id)) return;
  closeDimensionEditor(false);
  selectedSegment = id;
  if (switchTab) activeTab = 'segments';
  renderPanel(); renderProfile();
}
function record() { history.push(cloneModel(model)); if (history.length > 60) history.shift(); future = []; }
function commit(change, { fit = false, message = '', rerender = true } = {}) {
  closeDimensionEditor(false);
  record(); change(model); revision++; needsFit ||= fit;
  currentValidation = validateModel(model);
  if (currentValidation.errors.length === 0) { try { localStorage.setItem(STORAGE, JSON.stringify(model)); $('#save-state span').textContent = '已自动保存'; } catch { $('#save-state span').textContent = '本机保存不可用'; } }
  else $('#save-state span').textContent = '参数待修正';
  $('#project-name').value = model.name; $('#model-label').textContent = model.name;
  if (rerender) renderPanel();
  renderProfile(); renderValidation(); updateButtons(); scheduleBuild();
  if (message) toast(message);
}
function restoreState(next, fromHistory = false) {
  closeDimensionEditor(false);
  model = cloneModel(next); revision++; needsFit = true;
  if (!model.segments.some((s) => s.id === selectedSegment)) selectedSegment = model.segments[0].id;
  selectedKeyway = model.keyways.find((k) => k.id === selectedKeyway)?.id || model.keyways[0]?.id;
  selectedHole = model.holes.find((h) => h.id === selectedHole)?.id || model.holes[0]?.id;
  currentValidation = validateModel(model);
  try { if (!currentValidation.errors.length) localStorage.setItem(STORAGE, JSON.stringify(model)); } catch { /* 下载工程仍然可用。 */ }
  $('#project-name').value = model.name; $('#model-label').textContent = model.name;
  renderPanel(); renderProfile(); renderValidation(); updateButtons(); scheduleBuild();
  if (fromHistory) toast('已恢复参数状态');
}
function undo() { if (draggingProfile || !history.length) return; future.push(cloneModel(model)); restoreState(history.pop(), true); }
function redo() { if (draggingProfile || !future.length) return; history.push(cloneModel(model)); restoreState(future.pop(), true); }
function updateButtons() {
  $('#undo').disabled = history.length === 0; $('#redo').disabled = future.length === 0;
  $('#export-button').disabled = draggingProfile || exportBusy || !ready || lastBuiltRevision !== revision || currentValidation.errors.length > 0;
  $('#quality-label').textContent = model.quality === 'fine' ? '精细显示精度' : '标准显示精度';
}
function renderValidation(extraError = '') {
  const banner = $('#validation-banner');
  const errors = extraError ? [extraError] : currentValidation.errors;
  const warnings = [...new Set([...currentValidation.warnings, ...(lastBuiltRevision === revision ? (lastResult?.warnings || []) : [])])];
  if (!errors.length && !warnings.length) { banner.hidden = true; return; }
  banner.hidden = false; banner.className = `validation-banner ${errors.length ? 'error' : 'warning'}`;
  banner.innerHTML = `${ico(errors.length ? 'triangle-alert' : 'info')}<div><strong>${errors.length ? '参数尚未应用' : '建模提示'}</strong><p>${escape((errors.length ? errors : warnings).slice(0, 3).join(' '))}</p>${errors.length ? '<small>三维视图保留上一次有效模型；修正参数后自动重建，当前导出已暂停。</small>' : ''}</div>`;
  decorate();
}
function setEngine(state, message) {
  engineState = state; engineMessage = message;
  const pill = $('#engine-pill'); pill.className = `engine-pill ${state}`;
  pill.innerHTML = `${ico(state === 'ready' ? 'check' : state === 'error' ? 'triangle-alert' : 'loader-circle', state === 'loading' || state === 'building' ? 'spin' : '')}<span id="engine-message">${escape(message)}</span>`;
  decorate();
}
function scheduleBuild() {
  clearTimeout(buildTimer);
  if (currentValidation.errors.length) { pending = null; setEngine('error', '请修正参数'); return; }
  setEngine(ready ? 'building' : 'loading', ready ? '等待实体重建' : '正在启动实体内核');
  pending = { model: cloneModel(model), revision };
  buildTimer = setTimeout(dispatchBuild, 220);
}
function dispatchBuild() {
  if (!ready || inFlight || !pending) return;
  inFlight = { ...pending, id: ++serial, started: performance.now() }; pending = null;
  setEngine('building', '正在重建实体');
  worker.postMessage({ type: 'build', id: inFlight.id, model: inFlight.model });
}
function initWorker() {
  worker = new Worker(new URL('./cad.worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = (event) => {
    const data = event.data;
    if (data.type === 'ready') { ready = true; dispatchBuild(); return; }
    if (data.type === 'progress') { if (data.id === inFlight?.id && inFlight.revision === revision) setEngine('building', data.message); return; }
    if (data.type === 'export') {
      const task = exportTasks.get(data.id); if (!task) return;
      exportTasks.delete(data.id); exportBusy = false;
      download(new Blob([data.data], { type: data.mime || 'application/octet-stream' }), task.filename);
      if (lastBuiltRevision === revision) setEngine('ready', '实体已就绪');
      updateButtons(); toast(`${task.format.toUpperCase()} 已导出`); return;
    }
    if (data.type === 'error' && exportTasks.has(data.id)) { exportTasks.delete(data.id); exportBusy = false; setEngine('error', '导出失败'); updateButtons(); toast(data.message || '导出失败，请重试', true); return; }
    if ((data.type === 'result' || data.type === 'error') && data.id === inFlight?.id) {
      const task = inFlight; inFlight = null;
      if (task.revision === revision) {
        if (data.type === 'result') {
          lastResult = data; lastModel = cloneModel(task.model); lastBuiltRevision = task.revision;
          viewport?.setModel(data, lastModel); viewport?.setSelection(selectedSegment);
          if (needsFit) { viewport?.fit(); needsFit = false; }
          const seconds = (performance.now() - task.started) / 1000;
          setEngine('ready', `实体已就绪 · ${fmt(seconds, 1)} s`); $('#initial-loader').hidden = !viewportError;
          updateStats(data); renderValidation();
        } else {
          setEngine('error', '实体重建失败'); renderValidation(data.message || '几何运算失败，请检查特征间的位置关系。');
          if (!lastResult) $('#initial-loader').hidden = true;
        }
      }
      updateButtons(); dispatchBuild();
    }
    if (data.type === 'error' && data.id == null) failWorker(data.message || '内核初始化失败');
  };
  worker.onerror = (event) => failWorker(event.message || '内核加载失败');
}
function failWorker(message) {
  ready = false; inFlight = null; exportBusy = false; exportTasks.clear();
  setEngine('error', '内核加载失败'); updateButtons();
  $('#initial-loader').hidden = false;
  $('#initial-loader').innerHTML = `<strong>几何内核尚未就绪</strong><span>${escape(message)}</span><button class="button outline" id="retry-engine">重新加载</button>`;
  $('#retry-engine').onclick = () => { worker?.terminate(); $('#initial-loader').innerHTML = '<span class="loading-orbit"></span><strong>正在重新加载几何内核</strong>'; initWorker(); scheduleBuild(); };
}
function updateStats(result) {
  const volume = result.stats?.volume || 0, mass = volume * MATERIALS[model.material].density / 1e6;
  $('#model-stats').innerHTML = `<span class="dot teal"></span><strong>${result.stats?.solids || 1} 个实体</strong><span class="status-divider"></span><span>体积 <b>${fmt(volume / 1000)} cm³</b></span><span class="status-divider"></span><span>估算质量 <b>${fmt(mass, 3)} kg</b></span><span class="status-divider optional"></span><span class="optional">${fmt(result.stats?.faces || 0, 0)} 个面</span>`;
}
function toast(message, error = false) { const el = $('#toast'); clearTimeout(toastTimer); el.textContent = message; el.className = `toast${error ? ' error' : ''}`; el.hidden = false; toastTimer = setTimeout(() => { el.hidden = true; }, error ? 6500 : 3200); }
function fileStem() { return (model.name || 'rotor-part').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').slice(0, 80); }
function download(blob, name) {
  if (activeDownloadUrl) URL.revokeObjectURL(activeDownloadUrl);
  activeDownloadUrl = URL.createObjectURL(blob);
  const a = $('#download-ready-link');
  a.href = activeDownloadUrl; a.download = name; a.textContent = `下载 ${name}`;
  $('#download-ready').hidden = false;
  // 保留显式下载入口，浏览器限制自动下载时用户仍可直接点击文件。
  a.click();
}
function saveProject() { if (draggingProfile) { toast('请先完成轮廓拖动，再保存工程。'); return; } if (validateModel(model).errors.length) { toast('请先修正参数，再保存工程。', true); return; } download(new Blob([JSON.stringify(model, null, 2)], { type: 'application/json' }), `${fileStem()}.rotor.json`); toast('参数工程已保存，可通过「打开」继续编辑'); }
async function exportModel(format) {
  closeMenus();
  if (draggingProfile || lastBuiltRevision !== revision || currentValidation.errors.length || exportBusy || !lastModel) { toast('请等待当前参数生成有效实体。', true); return; }
  const filename = `${fileStem()}.${format === 'step' ? 'step' : format}`;
  exportBusy = true; updateButtons(); setEngine('building', `正在导出 ${format.toUpperCase()}`);
  try {
    if (format === 'glb') { const data = await viewport.exportGLB(); download(new Blob([data], { type: 'model/gltf-binary' }), filename); }
    else if (format === 'obj') { download(new Blob([viewport.exportOBJ()], { type: 'text/plain;charset=utf-8' }), filename); }
    else { const id = ++serial; exportTasks.set(id, { format, filename }); worker.postMessage({ type: 'export', id, format, model: cloneModel(lastModel) }); return; }
    exportBusy = false; if (lastBuiltRevision === revision) setEngine('ready', '实体已就绪'); updateButtons(); toast(`${format.toUpperCase()} 已导出`);
  } catch (error) { exportBusy = false; setEngine('error', '导出失败'); updateButtons(); toast(error.message, true); }
}

function addKeyToCurrent() {
  const segment = model.segments.find((s) => s.id === selectedSegment) || model.segments[0];
  const radius = minSegmentRadius(segment, 0, segment.length, false);
  const width = Math.max(.2, Math.min(8, radius * .45, segment.length * .32));
  const length = Math.max(width, Math.min(36, segment.length * .65));
  const key = createKeyway(segment.id, { position: +(Math.max(0, (segment.length - length) / 2)).toFixed(2), length: +length.toFixed(2), width: +width.toFixed(2), depth: +Math.min(radius * .4, Math.max(.2, width * .38)).toFixed(2) });
  selectedKeyway = key.id; activeTab = 'keyways'; commit((m) => m.keyways.push(key), { message: '已添加键槽，调整参数后自动重建' });
}
const actions = {
  'add-segment': () => { const s = createSegment({ name: `阶梯 ${model.segments.length + 1}` }); selectedSegment = s.id; commit((m) => m.segments.push(s), { fit: true }); },
  'duplicate-segment': () => { const index = model.segments.findIndex((s) => s.id === selectedSegment), s = cloneModel(model.segments[index]); s.id = uid('seg'); s.name += ' 副本'; selectedSegment = s.id; commit((m) => m.segments.splice(index + 1, 0, s), { fit: true }); },
  'delete-segment': () => { if (model.segments.length <= 1) return; const id = selectedSegment, index = model.segments.findIndex((s) => s.id === id); selectedSegment = model.segments[index > 0 ? index - 1 : 1].id; commit((m) => { m.segments.splice(index, 1); m.keyways = m.keyways.filter((k) => k.segmentId !== id); }, { fit: true, message: '阶梯及其关联键槽已删除，可撤销恢复' }); },
  'segment-up': () => moveSegment(-1), 'segment-down': () => moveSegment(1),
  'keyway-on-segment': addKeyToCurrent, 'add-keyway': addKeyToCurrent,
  'delete-keyway': () => { const id = selectedKeyway; commit((m) => { m.keyways = m.keyways.filter((k) => k.id !== id); selectedKeyway = m.keyways[0]?.id; }); },
  'duplicate-keyway': () => { const k = cloneModel(model.keyways.find((k) => k.id === selectedKeyway)); k.id = uid('key'); k.angle = ((k.angle + 180) % 360 + 360) % 360; selectedKeyway = k.id; commit((m) => m.keyways.push(k)); },
  'add-hole': () => {
    const face = !model.holes.some((h) => h.enabled && h.face === 'right') ? 'right' : 'left';
    const end = face === 'right' ? model.segments.at(-1) : model.segments[0];
    const length = getModelBounds(model).length, radius = minSegmentRadius(end);
    const enabled = !model.holes.some((h) => h.enabled && h.face === face);
    const h = createHole({ face, enabled, diameter: +Math.max(.1, Math.min(8, radius * .6)).toFixed(2), depth: +Math.max(.1, Math.min(20, end.length * .6, length * .4)).toFixed(2) });
    selectedHole = h.id; commit((m) => m.holes.push(h), { message: enabled ? '' : '已添加待配置孔组，请调整孔位后启用' });
  },
  'delete-hole': () => { const id = selectedHole; commit((m) => { m.holes = m.holes.filter((h) => h.id !== id); selectedHole = m.holes[0]?.id; }); },
  'duplicate-hole': () => { const h = cloneModel(model.holes.find((h) => h.id === selectedHole)); h.id = uid('hole'); h.face = h.face === 'left' ? 'right' : 'left'; selectedHole = h.id; commit((m) => m.holes.push(h)); },
  'help': () => $('#help-dialog').showModal(),
  'reset': () => { record(); activeTab = 'segments'; restoreState(DEFAULT_MODEL); toast('已恢复默认案例，可撤销'); },
};
function moveSegment(direction) { const i = model.segments.findIndex((s) => s.id === selectedSegment), target = i + direction; if (target < 0 || target >= model.segments.length) return; commit((m) => { [m.segments[i], m.segments[target]] = [m.segments[target], m.segments[i]]; }); }

$('#panel-content').addEventListener('click', (event) => {
  const b = event.target.closest('button'); if (!b) return;
  if (b.dataset.segment) selectSegment(b.dataset.segment);
  if (b.dataset.keyway) { selectedKeyway = b.dataset.keyway; const k = model.keyways.find((k) => k.id === selectedKeyway); selectedSegment = k.segmentId; renderPanel(); renderProfile(); }
  if (b.dataset.hole) { selectedHole = b.dataset.hole; renderPanel(); }
  if (b.dataset.action && actions[b.dataset.action]) actions[b.dataset.action]();
  if (b.dataset.segmentType) {
    const s = model.segments.find((s) => s.id === selectedSegment), type = b.dataset.segmentType;
    if (s.type === type) return;
    const hadChamfer = s.chamferLeft || s.chamferRight;
    commit(() => { s.type = type; if (type === 'gear') { s.chamferLeft = 0; s.chamferRight = 0; } if (type === 'cone') s.endDiameter = s.diameter * .8; }, { message: type === 'gear' && hadChamfer ? '已切换为直齿轮，并将不适用的端部倒角设为 0' : '' });
  }
});
$('#panel-content').addEventListener('change', (event) => {
  const el = event.target, scope = el.dataset.scope, field = el.dataset.field;
  if (!scope || !field) return;
  const value = el.type === 'checkbox' ? el.checked : el.type === 'number' ? (el.value.trim() ? Number(el.value) : NaN) : el.value;
  if (el.type === 'number' && !Number.isFinite(value)) { toast('请输入有效数字；原尺寸已保留。', true); renderPanel(); return; }
  const s = model.segments.find((s) => s.id === selectedSegment);
  commit((m) => {
    if (scope === 'segment' && field === 'start') { const index = m.segments.indexOf(s); if (index > 0) { const previousStart = getSegmentLayout(m)[index - 1].start; m.segments[index - 1].length = value - previousStart; } }
    else {
      const target = scope === 'segment' ? s : scope === 'gear' ? s.gear : scope === 'keyway' ? m.keyways.find((k) => k.id === selectedKeyway) : scope === 'hole' ? m.holes.find((h) => h.id === selectedHole) : m;
      if (target) target[field] = value;
      if (scope === 'keyway' && field === 'segmentId') selectedSegment = value;
    }
  });
});
$('#panel-content').addEventListener('keydown', (event) => { if (event.key === 'Enter' && event.target.matches('input')) event.target.blur(); });
document.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => { activeTab = b.dataset.tab; if (activeTab === 'keyways') { if (!model.keyways.some((k) => k.id === selectedKeyway)) selectedKeyway = model.keyways[0]?.id; const key = model.keyways.find((k) => k.id === selectedKeyway); if (key) selectedSegment = key.segmentId; } if (activeTab === 'holes' && !model.holes.some((h) => h.id === selectedHole)) selectedHole = model.holes[0]?.id; $('#panel-content').scrollTop = 0; renderPanel(); renderProfile(); }));
$('#project-name').addEventListener('change', (event) => { const value = event.target.value.trim(); commit((m) => { m.name = value; }); });
$('#undo').onclick = undo; $('#redo').onclick = redo; $('#save-button').onclick = saveProject;
$('#dismiss-download').onclick = () => { $('#download-ready').hidden = true; if (activeDownloadUrl) { URL.revokeObjectURL(activeDownloadUrl); activeDownloadUrl = null; } };
$('#import-button').onclick = () => $('#import-file').click();
$('#import-file').onchange = async (event) => {
  const file = event.target.files[0]; if (!file) return;
  try { if (file.size > 2 * 1024 * 1024) throw new Error('工程文件不能超过 2 MB。'); const imported = normalizeModel(JSON.parse(await file.text())); record(); activeTab = 'segments'; restoreState(imported); toast(`已打开 ${imported.name}`); }
  catch (error) { toast(`无法打开工程：${error.message}`, true); } finally { event.target.value = ''; }
};
function closeMenus() { $('#presets-menu').hidden = true; $('#export-menu').hidden = true; }
function toggleMenu(menuId, anchor) { const menu = $(menuId), was = menu.hidden; closeMenus(); if (was) { const rect = anchor.getBoundingClientRect(); menu.style.right = `${Math.max(12, innerWidth - rect.right)}px`; menu.style.top = `${rect.bottom + 8}px`; menu.hidden = false; } }
$('#presets-button').onclick = (e) => { e.stopPropagation(); toggleMenu('#presets-menu', $('#presets-button')); };
$('#export-button').onclick = (e) => { e.stopPropagation(); toggleMenu('#export-menu', $('#export-button')); };
document.addEventListener('click', (event) => { if (!event.target.closest('.popover')) closeMenus(); });
document.querySelectorAll('[data-preset]').forEach((b) => b.onclick = () => { const p = PRESETS.find((p) => p.id === b.dataset.preset); if (!p) return; record(); activeTab = 'segments'; restoreState(p.model); closeMenus(); toast(`已载入 ${p.name}`); });
document.querySelectorAll('[data-export]').forEach((b) => b.onclick = () => exportModel(b.dataset.export));
$('#dimension-editor').addEventListener('submit', (event) => { event.preventDefault(); applyDimensionEditor(); });
$('#dimension-editor-close').addEventListener('click', () => closeDimensionEditor());
$('#dimension-editor-input').addEventListener('input', () => { $('#dimension-editor-input').removeAttribute('aria-invalid'); $('#dimension-editor-error').hidden = true; positionDimensionEditor(); });
$('#dimension-editor').addEventListener('keydown', (event) => {
  if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeDimensionEditor(); }
  if (event.key === 'Tab') {
    const controls = [...$('#dimension-editor').querySelectorAll('input,button')], first = controls[0], last = controls.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }
});
document.addEventListener('pointerdown', (event) => { if (dimensionEditState && !$('#dimension-editor').contains(event.target)) closeDimensionEditor(false); }, true);
window.addEventListener('resize', () => closeDimensionEditor(false));
$('#profile-chart').addEventListener('scroll', () => { if (dimensionEditState?.surface === 'profile' && $('#profile-chart').scrollLeft !== dimensionEditState.scrollLeft) closeDimensionEditor(false); });
$('#profile-panel').addEventListener('click', (event) => {
  const anchor = event.target.closest('[data-dimension-kind]');
  if (!anchor) return;
  event.stopPropagation();
  openDimensionEditor({ kind: anchor.dataset.dimensionKind, ...(anchor.dataset.segmentId ? { id: anchor.dataset.segmentId } : {}) }, anchor);
});
$('#help-button').onclick = () => $('#help-dialog').showModal(); document.querySelectorAll('[data-close-dialog]').forEach((b) => b.onclick = () => $('#help-dialog').close());
$('#help-dialog').addEventListener('click', (e) => { if (e.target === $('#help-dialog')) $('#help-dialog').close(); });
$('#fit-button').onclick = () => viewport?.fit();
$('#mode-button').onclick = () => { const modes = ['edges', 'solid', 'wireframe']; wireMode = modes[(modes.indexOf(wireMode) + 1) % 3]; viewport?.setMode(wireMode); $('#mode-button span').textContent = { edges: '实体 + 边线', solid: '实体着色', wireframe: '三角线框' }[wireMode]; };
$('#dimensions-button').onclick = () => { dimensions = !dimensions; viewport?.setDimensions(dimensions); $('#dimensions-button').classList.toggle('active', dimensions); };
$('#section-button').onclick = () => { section = !section; viewport?.setSection(section); $('#section-button').classList.toggle('active', section); $('#section-note').hidden = !section; };
$('#spin-button').onclick = () => { spin = !spin; viewport?.setAutoRotate(spin); $('#spin-button').classList.toggle('active', spin); };
$('#theme-button').onclick = () => { theme = theme === 'light' ? 'dark' : 'light'; document.documentElement.dataset.theme = theme; viewport?.setTheme(theme); $('#theme-button').innerHTML = ico(theme === 'light' ? 'moon' : 'sun'); decorate(); };
document.querySelectorAll('[data-view]').forEach((b) => b.onclick = () => { document.querySelectorAll('[data-view]').forEach((v) => v.classList.remove('active')); b.classList.add('active'); viewport?.setView(b.dataset.view); });
$('#profile-toggle').onclick = () => { $('#profile-panel').classList.toggle('collapsed'); $('#profile-toggle').setAttribute('aria-label', $('#profile-panel').classList.contains('collapsed') ? '展开轮廓' : '收起轮廓'); };
function collapseSidebar(collapse) { $('.app-body').classList.toggle('sidebar-collapsed', collapse); $('#expand-sidebar').hidden = !collapse; }
$('#collapse-sidebar').onclick = () => collapseSidebar(true); $('#expand-sidebar').onclick = () => collapseSidebar(false);
$('#resize-handle').addEventListener('pointerdown', (event) => { const el = event.currentTarget; el.setPointerCapture(event.pointerId); const move = (e) => document.documentElement.style.setProperty('--sidebar-width', `${Math.max(270, Math.min(480, e.clientX))}px`); const end = () => { el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', end); }; el.addEventListener('pointermove', move); el.addEventListener('pointerup', end); });
$('#resize-handle').addEventListener('keydown', (event) => { if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return; event.preventDefault(); const width = $('#sidebar').getBoundingClientRect().width; document.documentElement.style.setProperty('--sidebar-width', `${Math.max(270, Math.min(480, width + (event.key === 'ArrowRight' ? 10 : -10)))}px`); });

// 轮廓拖拽只移动内部边界；相邻两段长度之和保持不变。
$('#profile-chart').addEventListener('pointerdown', (event) => {
  const boundary = event.target.closest('[data-boundary]');
  if (!boundary) return;
  event.preventDefault();
  const index = Number(boundary.dataset.boundary), original = cloneModel(model), layout = getSegmentLayout(original), svg = $('#profile-chart svg'), rect = svg.getBoundingClientRect();
  if (original.segments[index - 1].length < .1 || original.segments[index].length < .1) return;
  draggingProfile = true; updateButtons();
  const total = getModelBounds(original).length, scale = total / (rect.width * 904 / 1000), startX = event.clientX;
  let delta = 0;
  const move = (e) => { delta = Math.max(.1 - original.segments[index - 1].length, Math.min(original.segments[index].length - .1, Math.round((e.clientX - startX) * scale * 100) / 100)); model.segments[index - 1].length = original.segments[index - 1].length + delta; model.segments[index].length = original.segments[index].length - delta; renderProfile(); };
  const end = () => { document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', end); document.removeEventListener('pointercancel', cancel); const lengths = [model.segments[index - 1].length, model.segments[index].length]; model = original; draggingProfile = false; if (Math.abs(delta) > .001) commit((m) => { m.segments[index - 1].length = lengths[0]; m.segments[index].length = lengths[1]; }); else { renderProfile(); updateButtons(); } };
  const cancel = () => { document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', end); document.removeEventListener('pointercancel', cancel); model = original; draggingProfile = false; renderProfile(); updateButtons(); };
  document.addEventListener('pointermove', move); document.addEventListener('pointerup', end, { once: true }); document.addEventListener('pointercancel', cancel, { once: true });
});
$('#profile-chart').addEventListener('click', (event) => { const s = event.target.closest('[data-profile-segment]'); if (s) selectSegment(s.dataset.profileSegment, true); });
$('#profile-chart').addEventListener('keydown', (event) => { const el = event.target; if (el.dataset.profileSegment && ['Enter', ' '].includes(event.key)) { event.preventDefault(); selectSegment(el.dataset.profileSegment, true); } const i = Number(el.dataset.boundary); if (i && ['ArrowLeft', 'ArrowRight'].includes(event.key)) { event.preventDefault(); const d = event.key === 'ArrowRight' ? 1 : -1; commit((m) => { m.segments[i - 1].length += d; m.segments[i].length -= d; }); } });
document.addEventListener('keydown', (event) => {
  if (dimensionEditState) {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); if (applyDimensionEditor()) saveProject(); }
    return;
  }
  const editing = event.target.matches('input,select,textarea');
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); if (editing) event.target.blur(); saveProject(); }
  else if (!editing && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') { event.preventDefault(); event.shiftKey ? redo() : undo(); }
  else if (!editing && event.key.toLowerCase() === 'f' && !event.ctrlKey && !event.metaKey) viewport?.fit();
  else if (event.key === 'Escape') closeMenus();
});

renderPanel(); renderProfile(); updateButtons(); decorate(); initWorker(); scheduleBuild();
