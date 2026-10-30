import { LIMITS, cloneModel, validateModel } from './schema.js';
import { getFeatureDimensions, getBoreWallInfo } from './features.js';

const MIN_MODULE = 0.1;
const MAX_MODULE = 25;

function decimalParts(value) {
  if (!Number.isFinite(value)) throw new Error('当前尺寸参数不是有限数字，请先修正参数。');
  const [mantissa, exponent = '0'] = String(value).toLowerCase().split('e');
  const [integer, fraction = ''] = mantissa.split('.');
  return { coefficient: BigInt(integer + fraction), scale: fraction.length - Number(exponent) };
}

/** 用十进制系数执行联动加减，避免 10.2−10.1 落到最小段长0.1以下；不量化输入。 */
function decimalSum(values) {
  const parts = values.map(decimalParts);
  const scale = Math.max(0, ...parts.map((part) => part.scale));
  const coefficient = parts.reduce((sum, part) => sum + part.coefficient * 10n ** BigInt(scale - part.scale), 0n);
  return Number(`${coefficient}e-${scale}`);
}

/** 派生输入范围也按十进制乘法生成，避免合法的1.28被误判小于1.2800000000000002。 */
function decimalProduct(values) {
  const parts = values.map(decimalParts);
  const scale = parts.reduce((sum, part) => sum + part.scale, 0);
  const coefficient = parts.reduce((product, part) => product * part.coefficient, 1n);
  return Number(`${coefficient}e${-scale}`);
}

function resolveTarget(model, target) {
  if (!model || !Array.isArray(model.segments) || model.segments.length === 0) throw new Error('当前工程没有可编辑的阶梯。');
  if (!target || typeof target !== 'object' || typeof target.kind !== 'string') throw new Error('未找到可编辑的尺寸标注。');
  if (!model.segments.every((segment) => segment && Number.isFinite(segment.length))) throw new Error('当前阶梯长度不是有限数字，请先修正参数。');
  const total = decimalSum(model.segments.map((segment) => segment.length));
  if (target.kind === 'total-length') return { total, index: model.segments.length - 1, segment: model.segments.at(-1) };
  const index = model.segments.findIndex((segment) => segment.id === target.id);
  if (index < 0) throw new Error('尺寸对应的阶梯已不存在，请重新选择尺寸。');
  return { total, index, segment: model.segments[index] };
}

function prefixLength(model, count) {
  return decimalSum(model.segments.slice(0, count).map((segment) => segment.length));
}

/** 返回尺寸输入框所需的值、范围和联动说明；不会改变工程。 */
export function getDimensionSpec(model, target) {
  if (target?.kind === 'feature-parameter') {
    if (!Array.isArray(model?.features) || !Array.isArray(model?.segments) || !model.segments.every((s) => s && Number.isFinite(s.length))) {
      throw new Error('当前工程缺少有效的特征或外形数组，请先修正参数。');
    }
    const feature = model.features.find((item) => item?.id === target.id);
    if (!feature) throw new Error('尺寸对应的特征已不存在，请重新选择尺寸。');
    const spec = getFeatureDimensions(model, feature).find((item) => item.key === target.key && item.subId === target.subId);
    if (!spec) throw new Error('未找到该特征的可编辑尺寸，请重新选择标注。');
    if (!spec.editable) throw new Error(spec.hint || '该尺寸由终止模式派生，不能独立编辑。');
    if (![spec.value, spec.min, spec.max].every(Number.isFinite) || spec.max < spec.min) throw new Error('当前特征尺寸超出可编辑范围，请先修正参数。');
    return { ...spec, featureId: feature.id, ...(target.subId ? { subId: target.subId } : {}) };
  }
  const { total, index, segment } = resolveTarget(model, target);
  const name = typeof segment.name === 'string' && segment.name ? segment.name : `阶梯 ${index + 1}`;
  const common = { unit: 'mm', step: 0.1, segmentId: segment.id };
  let spec;
  switch (target.kind) {
    case 'segment-length': {
      const otherLength = decimalSum([total, -segment.length]);
      spec = { title: `${name} · ${segment.type === 'gear' ? '齿宽' : '段长'} L`, value: segment.length,
        min: LIMITS.minLength, max: Math.min(LIMITS.maxLength, decimalSum([LIMITS.maxTotalLength, -otherLength])),
        hint: '只修改当前阶梯长度，后续阶梯随之移动。键槽和孔的尺寸保持原值，超出实体范围时拒绝修改。' };
      break;
    }
    case 'segment-diameter':
      if (!['cylinder', 'cone'].includes(segment.type)) throw new Error('齿轮段请编辑齿顶直径，由模数联动生成齿形。');
      spec = { title: `${name} · ${segment.type === 'cone' ? '左端直径 D₁' : '直径 D'}`, value: segment.diameter,
        min: LIMITS.minDiameter, max: LIMITS.maxDiameter,
        hint: segment.type === 'cone'
          ? '只修改圆锥左端直径，右端直径保持原值；不会缩放倒角、键槽或孔。'
          : '只修改当前圆柱直径；不会缩放倒角、键槽或孔，实体约束不满足时拒绝修改。' };
      break;
    case 'segment-end-diameter':
      if (segment.type !== 'cone') throw new Error('只有圆锥段具有可独立编辑的右端直径。');
      spec = { title: `${name} · 右端直径 D₂`, value: segment.endDiameter,
        min: LIMITS.minDiameter, max: LIMITS.maxDiameter,
        hint: '只修改圆锥右端直径，左端直径保持原值；不会缩放倒角、键槽或孔。' };
      break;
    case 'gear-tip-diameter': {
      if (segment.type !== 'gear') throw new Error('只有直齿轮段具有可编辑的齿顶直径。');
      const coefficient = segment.gear?.teeth + 2 * segment.gear?.addendum;
      if (!Number.isFinite(coefficient) || coefficient <= 0 || !Number.isFinite(segment.gear?.module)) throw new Error('当前齿轮参数无效，请先修正齿数、模数与齿顶高系数。');
      spec = { title: `${name} · 齿顶直径 Dₐ`, value: segment.gear.module * coefficient,
        min: decimalProduct([MIN_MODULE, coefficient]), max: Math.min(LIMITS.maxDiameter, decimalProduct([MAX_MODULE, coefficient])),
        hint: '通过 m = 齿顶直径 ÷（齿数 + 2 × 齿顶高系数）调整模数。齿数、齿宽、压力角和系数保持原值；键槽与孔不缩放。' };
      break;
    }
    case 'segment-start': {
      if (index === 0) throw new Error('第一段起点固定为 X = 0，不能直接编辑。');
      const previous = model.segments[index - 1];
      const previousStart = prefixLength(model, index - 1);
      const others = decimalSum([total, -previous.length]);
      const maximumPreviousLength = Math.min(LIMITS.maxLength, decimalSum([LIMITS.maxTotalLength, -others]));
      spec = { title: `${name} · 轴向起点 X`, value: prefixLength(model, index),
        min: decimalSum([previousStart, LIMITS.minLength]), max: decimalSum([previousStart, maximumPreviousLength]),
        hint: '仅调整前一阶梯的长度，当前及后续阶梯随之移动；当前段长度保持原值。前段键槽超界时拒绝修改。' };
      break;
    }
    case 'total-length': {
      const beforeLast = prefixLength(model, model.segments.length - 1);
      spec = { title: '零件总长 L', value: total,
        min: decimalSum([beforeLast, LIMITS.minLength]), max: Math.min(LIMITS.maxTotalLength, decimalSum([beforeLast, LIMITS.maxLength])),
        hint: `只调整末段“${name}”的长度，前面各段、键槽与孔参数保持原值；不会整体缩放零件，超界时拒绝修改。` };
      break;
    }
    default:
      throw new Error('该标注不是可直接编辑的尺寸。');
  }
  if (!Number.isFinite(spec.value) || !Number.isFinite(spec.min) || !Number.isFinite(spec.max) || spec.max < spec.min) {
    throw new Error('当前尺寸或关联阶梯超出可编辑范围，请先修正参数。');
  }
  return { ...common, ...spec };
}

function parseDimension(input) {
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) throw new Error('请输入有限的尺寸数值。');
    return input;
  }
  if (typeof input !== 'string') throw new Error('请输入数字或十进制数值文本。');
  const text = input.trim();
  if (!text) throw new Error('尺寸不能为空。');
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(text)) throw new Error('请输入十进制数值，不要包含单位、千分位或其他文本。');
  const value = Number(text);
  if (!Number.isFinite(value)) throw new Error('请输入有限的尺寸数值。');
  return value;
}

/** 仅用于正数边界：向下一个可表示浮点数移动，避免逆算后回乘越过直径上限。 */
function nextPositiveFloatDown(value) {
  const number = new Float64Array([value]);
  const bits = new BigUint64Array(number.buffer);
  bits[0] -= 1n;
  return number[0];
}

/** 克隆后仅修改指定尺寸；关联特征不缩放，任何校验失败均保留原工程。 */
export function applyDimensionEdit(model, target, input) {
  const value = parseDimension(input);
  const spec = getDimensionSpec(model, target);
  if (value < spec.min || value > spec.max) throw new Error(`${spec.title}必须在 ${spec.min}～${spec.max} ${spec.unit} 之间。`);
  const next = cloneModel(model);
  if (target.kind === 'feature-parameter') {
    const feature = next.features.find((item) => item.id === target.id);
    if (feature.type === 'bore') {
      if (target.key === 'offset') feature.offset = value;
      else if (target.key === 'bottomThickness') {
        feature.segments.at(-1).length = decimalSum([
          ...next.segments.map((segment) => segment.length), -feature.offset,
          ...feature.segments.slice(0, -1).map((segment) => -segment.length), -value,
        ]);
      } else {
        const segment = feature.segments.find((item) => item.id === target.subId);
        if (target.key === 'wallThickness') {
          const wall = getBoreWallInfo(next, feature, target.subId);
          if (!wall) throw new Error('当前内外轮廓不能通过单一壁厚驱动，请编辑内径。');
          segment.diameter = decimalProduct([2, decimalSum([wall.outerRadius, -value])]);
        } else if (['length', 'diameter', 'endDiameter'].includes(target.key)) segment[target.key] = value;
        else throw new Error('该内腔尺寸不能直接编辑。');
      }
    } else if (feature.type === 'hole' && ['thread.length', 'thread.offset'].includes(target.key)) {
      feature.thread[target.key.slice(7)] = value;
    } else {
      // key 必须已由 getFeatureDimensions 白名单解析，不能借任意属性路径修改工程。
      feature[target.key] = value;
    }
    const { errors } = validateModel(next);
    if (errors.length) throw new Error(errors.join('\n'));
    return next;
  }
  const { index, segment } = resolveTarget(next, target);
  switch (target.kind) {
    case 'segment-length':
      segment.length = value;
      break;
    case 'segment-diameter':
      segment.diameter = value;
      break;
    case 'segment-end-diameter':
      segment.endDiameter = value;
      break;
    case 'gear-tip-diameter': {
      const coefficient = segment.gear.teeth + 2 * segment.gear.addendum;
      // 输入已满足派生范围；此处只修复除法产生的边界舍入误差，不量化普通尺寸。
      let moduleSize = Math.max(MIN_MODULE, Math.min(MAX_MODULE, value / coefficient));
      if (value === LIMITS.maxDiameter && moduleSize * coefficient > LIMITS.maxDiameter) {
        moduleSize = nextPositiveFloatDown(moduleSize);
      }
      segment.gear.module = moduleSize;
      break;
    }
    case 'segment-start':
      next.segments[index - 1].length = decimalSum([value, -prefixLength(next, index - 1)]);
      break;
    case 'total-length':
      segment.length = decimalSum([value, -prefixLength(next, next.segments.length - 1)]);
      break;
  }
  const { errors } = validateModel(next);
  if (errors.length) throw new Error(errors.join('\n'));
  return next;
}
