import initOpenCascade from 'replicad-opencascadejs/src/replicad_single.js';
import wasmUrl from 'replicad-opencascadejs/src/replicad_single.wasm?url';
import { setOC } from 'replicad';
import { buildModel, exportModel } from './cad.js';

let cached = null;
let cachedKey = null;
let queue = Promise.resolve();

const ready = initOpenCascade({ locateFile: () => wasmUrl }).then(oc => {
  setOC(oc);
  self.postMessage({ type: 'ready' });
});

function errorMessage(error) {
  if (error instanceof Error) return error.message;
  return `几何内核无法生成当前特征（${String(error).slice(0, 160)}），请调整相关尺寸。`;
}

ready.catch(error => self.postMessage({ type: 'error', id: null,
  message: `几何内核加载失败：${errorMessage(error)}` }));

function getResult(model, id) {
  const key = JSON.stringify(model);
  if (cached && cachedKey === key) return cached;
  // 只有新模型全部生成成功后才替换缓存，失败时保留上一版已验证实体。
  const next = buildModel(model, message => self.postMessage({ type: 'progress', id, message }));
  cached?.shape.delete();
  cached = next;
  cachedKey = key;
  return next;
}

self.onmessage = ({ data }) => {
  queue = queue.then(async () => {
    const { type, id, model } = data;
    try {
      await ready;
      if (type === 'build') {
        const result = getResult(model, id);
        self.postMessage({ type: 'result', id, mesh: result.mesh, edges: result.edges,
          stats: result.stats, warnings: result.warnings });
      } else if (type === 'export') {
        const result = getResult(model, id);
        const exported = await exportModel(result, model, data.format);
        self.postMessage({ type: 'export', id, ...exported }, [exported.data]);
      } else if (type === 'clear') {
        cached?.shape.delete(); cached = null; cachedKey = null;
      }
    } catch (error) {
      self.postMessage({ type: 'error', id, message: errorMessage(error) });
    }
  });
};
