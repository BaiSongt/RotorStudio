import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { PartViewport } from '../src/viewport.js';

// 只测试网格文件边界，不启动 WebGL，也不模拟浏览器交互。
function exportFixture() {
  const viewport = Object.create(PartViewport.prototype);
  const geometry = new THREE.BoxGeometry(120, 30, 20);
  geometry.translate(60, 0, 0);
  viewport.part = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ wireframe: true }));
  viewport.part.material.clippingPlanes = [new THREE.Plane(new THREE.Vector3(0, -1, 0), 0)];
  viewport.part.position.set(13, 14, 15);
  viewport.palette = { metal: 0xb9c5cf };
  viewport.model = { name: '导出边界测试' };
  return viewport;
}

function releaseFixture(viewport) {
  viewport.part.geometry.dispose();
  viewport.part.material.dispose();
}

test('OBJ 保留毫米尺寸和模型原点，不写入显示变换或辅助线', () => {
  const viewport = exportFixture();
  try {
    const obj = viewport.exportOBJ();
    assert.match(obj, /^# Units: millimeter/);
    const vertices = obj.split('\n').filter((line) => line.startsWith('v ')).map((line) => line.split(' ').slice(1).map(Number));
    assert.equal(Math.min(...vertices.map((vertex) => vertex[0])), 0);
    assert.equal(Math.max(...vertices.map((vertex) => vertex[0])), 120);
    assert.equal(Math.max(...vertices.map((vertex) => vertex[1])), 15);
    assert.equal(obj.split('\n').filter((line) => line.startsWith('l ')).length, 0);
    assert.equal(viewport.part.material.wireframe, true);
    assert.equal(viewport.part.material.clippingPlanes.length, 1);
  } finally {
    releaseFixture(viewport);
  }
});

test('GLB 文件含单一实体，数值尺寸转换为米，源显示网格不被修改', async () => {
  const previousFileReader = globalThis.FileReader;
  globalThis.FileReader = class {
    readAsArrayBuffer(blob) {
      blob.arrayBuffer().then((result) => {
        this.result = result;
        this.onloadend?.();
      });
    }
  };
  const viewport = exportFixture();
  try {
    const glb = await viewport.exportGLB();
    const view = new DataView(glb);
    assert.equal(view.getUint32(0, true), 0x46546c67);
    assert.equal(view.getUint32(4, true), 2);
    assert.equal(view.getUint32(8, true), glb.byteLength);
    const jsonLength = view.getUint32(12, true);
    const json = JSON.parse(new TextDecoder().decode(new Uint8Array(glb, 20, jsonLength)));
    assert.equal(json.meshes.length, 1);
    assert.equal(json.nodes.length, 1);
    const positions = json.accessors[json.meshes[0].primitives[0].attributes.POSITION];
    assert.ok(Math.abs(positions.max[0] - 0.12) < 1e-7);
    assert.ok(Math.abs(positions.min[0]) < 1e-7);
    assert.ok(Math.abs(positions.max[1] - 0.015) < 1e-7);
    assert.equal(json.nodes[0].extras.units, 'meter');
    viewport.part.geometry.computeBoundingBox();
    assert.equal(viewport.part.geometry.boundingBox.max.x, 120);
    assert.equal(viewport.part.material.wireframe, true);
  } finally {
    globalThis.FileReader = previousFileReader;
    releaseFixture(viewport);
  }
});
