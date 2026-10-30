import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setOC, importSTEP, iterTopo } from 'replicad';
import { buildModel, exportModel } from '../src/cad.js';
import { ROTATIONAL_PRESETS } from '../src/features.js';

// 运行：node scripts/export-rotational-examples.mjs [临时网格输出目录]
// 示例工程与 STEP 固定输出到 examples/v1.2；网格仅用于实际实体的软件渲染。
const root = fileURLToPath(new URL('../', import.meta.url));
const outputDirectory = path.join(root, 'examples', 'v1.2');
const meshDirectory = path.resolve(process.argv[2] || '/tmp/rotor-studio-v1.2-mesh');
const require = createRequire(import.meta.url);
const loaderPath = require.resolve('replicad-opencascadejs/src/replicad_single.js');
const loaderText = readFileSync(loaderPath, 'utf8').replace(/export default Module;\s*$/, 'return Module;');
const initOC = new Function('require', '__dirname', '__filename', loaderText)(require, path.dirname(loaderPath), loaderPath);
const oc = await initOC({
  wasmBinary: readFileSync(path.join(path.dirname(loaderPath), 'replicad_single.wasm')),
  print: () => {}, printErr: () => {},
});
setOC(oc);

function verifyStep(shape) {
  let solids = 0;
  for (const item of iterTopo(shape.wrapped, 'solid')) { solids++; item.delete(); }
  const checker = new oc.BRepCheck_Analyzer(shape.wrapped, true, false);
  let valid;
  try { valid = checker.IsValid_2(); } finally { checker.delete(); }
  const props = new oc.GProp_GProps_1();
  let volume;
  try {
    oc.BRepGProp.VolumeProperties_2(shape.wrapped, props, 1e-9, true, false);
    volume = props.Mass();
  } finally { props.delete(); }
  if (!valid || solids !== 1 || !(volume > 0)) throw new Error('STEP 回读未得到有效单实体。');
  return { valid, solids, volume };
}

mkdirSync(outputDirectory, { recursive: true });
mkdirSync(meshDirectory, { recursive: true });
const summary = [];
for (const preset of ROTATIONAL_PRESETS) {
  const model = structuredClone(preset.model);
  const result = buildModel(model);
  try {
    const step = await exportModel(result, model, 'step');
    const imported = await importSTEP(new Blob([step.data]));
    let check;
    try { check = verifyStep(imported); } finally { imported.delete(); }
    const relativeVolumeError = Math.abs(check.volume - result.stats.volume) / result.stats.volume;
    if (relativeVolumeError > 1e-6) throw new Error(`${preset.name} 的 STEP 回读体积超出容差。`);
    const stats = {
      presetId: preset.id, name: model.name, schemaVersion: model.schemaVersion, partFamily: model.partFamily,
      units: { length: 'mm', area: 'mm²', volume: 'mm³' },
      ...result.stats, warnings: result.warnings,
      stepValidation: { ...check, relativeVolumeError, byteLength: step.data.byteLength },
    };
    writeFileSync(path.join(outputDirectory, `${preset.id}.rotor.json`), `${JSON.stringify(model, null, 2)}\n`);
    writeFileSync(path.join(outputDirectory, `${preset.id}.step`), Buffer.from(step.data));
    writeFileSync(path.join(outputDirectory, `${preset.id}.stats.json`), `${JSON.stringify(stats, null, 2)}\n`);
    writeFileSync(path.join(meshDirectory, `${preset.id}.mesh.json`), JSON.stringify({
      presetId: preset.id, name: model.name, model,
      mesh: result.mesh, edges: result.edges, stats: result.stats, warnings: result.warnings,
    }));
    summary.push(stats);
    process.stdout.write(`${preset.name}：有效单实体，体积 ${result.stats.volume.toFixed(6)} mm³，STEP 相对体积误差 ${relativeVolumeError.toExponential(3)}\n`);
  } finally { result.shape.delete(); }
}
writeFileSync(path.join(outputDirectory, 'validation-summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
process.stdout.write(`示例：${outputDirectory}\n临时网格：${meshDirectory}\n`);
