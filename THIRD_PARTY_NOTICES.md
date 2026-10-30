# 第三方组件与许可声明

Rotor Studio 使用下列开源组件实现三维显示、实体建模、图标及相关数据处理。各组件的著作权归其原作者与贡献者所有，具体使用、修改和再分发条件见随附许可原文。

本清单记录本次交付实际安装的运行时依赖。许可文件从本地对应版本的软件包逐字节复制；OCCT 的两份底层许可从其官方源码仓库取得。Vite 等开发构建工具未随本清单扩展打包，其许可随开发时安装的原软件包提供。

## 1. 随附的 npm 组件许可

| 组件 | 实际版本 | npm 包声明的许可 | 随附原文 |
| --- | --- | --- | --- |
| Three.js | 0.180.0 | MIT | [three.LICENSE.txt](licenses/three.LICENSE.txt) |
| Replicad | 0.19.1 | MIT | [replicad.LICENSE.txt](licenses/replicad.LICENSE.txt) |
| replicad-opencascadejs 包装层 | 0.19.0 | MIT；底层 OCCT 另见下一节 | [replicad-opencascadejs.LICENSE.txt](licenses/replicad-opencascadejs.LICENSE.txt) |
| Lucide | 0.468.0 | ISC | [lucide.LICENSE.txt](licenses/lucide.LICENSE.txt) |
| Flatbush | 4.6.2 | ISC | [flatbush.LICENSE.txt](licenses/flatbush.LICENSE.txt) |
| Flatqueue | 3.1.0 | ISC | [flatqueue.LICENSE.txt](licenses/flatqueue.LICENSE.txt) |
| OpenType.js | 1.3.4 | MIT | [opentype.js.LICENSE.txt](licenses/opentype.js.LICENSE.txt) |
| tiny-inflate | 1.0.3 | MIT | [tiny-inflate.LICENSE.txt](licenses/tiny-inflate.LICENSE.txt) |
| string.prototype.codepointat | 0.2.1 | MIT | [string.prototype.codepointat.LICENSE.txt](licenses/string.prototype.codepointat.LICENSE.txt) |

本地复制来源及 SHA-256 校验值保存在 [runtime-license-sources.json](licenses/runtime-license-sources.json)。这些许可原文保留了原始作者、版权声明、许可条件和免责条款。

## 2. Open CASCADE Technology 的使用声明

**本应用使用 Open CASCADE Technology（OCCT）软件提供的几何建模和数据交换能力。** OCCT 通过 OpenCascade.js / replicad-opencascadejs 的 WebAssembly 构建运行，用于实体构造、布尔运算、网格化及 STEP / STL 数据交换。

OCCT 官方源码仓库声明其采用 **GNU Lesser General Public License 2.1，附 Open CASCADE Exception 1.0**。`replicad-opencascadejs` 的 npm 包装层标注 MIT，不代表其中的 OCCT 底层代码因此改为 MIT。关于 OCCT 及其使用的权利和条件，请阅读以下原文：

- [LICENSE_LGPL_21.txt](licenses/LICENSE_LGPL_21.txt)：GNU LGPL 2.1 完整许可。
- [OCCT_LGPL_EXCEPTION.txt](licenses/OCCT_LGPL_EXCEPTION.txt)：Open CASCADE 附加例外完整原文。
- [OCCT 官方许可说明](https://github.com/Open-Cascade-SAS/OCCT#license)。

本项目使用 `replicad-opencascadejs@0.19.0` 发布包提供的预编译 WASM，没有修改该发布包的几何内核。当前记录没有独立确定该 WASM 内嵌 OCCT 的准确版本和源码提交；下面的官方许可文件获取记录只标识许可文本来源，不表示本应用使用了 OCCT `master` 分支的二进制。

| 官方原文 | 来源 | Git blob SHA |
| --- | --- | --- |
| LGPL 2.1 | [官方仓库文件](https://github.com/Open-Cascade-SAS/OCCT/blob/master/LICENSE_LGPL_21.txt) | `732811e4f1faf71870b7350f211b26e00d7bfbe9` |
| OCCT Exception 1.0 | [官方仓库文件](https://github.com/Open-Cascade-SAS/OCCT/blob/master/OCCT_LGPL_EXCEPTION.txt) | `263d14ef75d9172e59213d880605729eed3041fc` |

取得日期：2026-10-30。原文件字节数、SHA-256 和来源信息见 [occt-license-sources.json](licenses/occt-license-sources.json)。

## 3. 组件源码与构建入口

- Three.js：[mrdoob/three.js](https://github.com/mrdoob/three.js)
- Replicad 与其 OpenCascade.js 定制构建：[sgenoud/replicad](https://github.com/sgenoud/replicad)
- OpenCascade.js：[donalffons/opencascade.js](https://github.com/donalffons/opencascade.js)
- Open CASCADE Technology：[Open-Cascade-SAS/OCCT](https://github.com/Open-Cascade-SAS/OCCT)
- Lucide：[lucide-icons/lucide](https://github.com/lucide-icons/lucide)
- Flatbush：[mourner/flatbush](https://github.com/mourner/flatbush)
- Flatqueue：[mourner/flatqueue](https://github.com/mourner/flatqueue)
- OpenType.js：[opentypejs/opentype.js](https://github.com/opentypejs/opentype.js)
- tiny-inflate：[devongovett/tiny-inflate](https://github.com/devongovett/tiny-inflate)
- string.prototype.codepointat：[mathiasbynens/String.prototype.codePointAt](https://github.com/mathiasbynens/String.prototype.codePointAt)

Rotor Studio 的应用源代码与构建文件一并提供。几何内核入口位于 `src/cad.worker.js`，由 `replicad-opencascadejs/src/replicad_single.js` 和 `replicad_single.wasm` 初始化；使用兼容的替换构建后，可重新运行 `npm run build` 生成应用。内核的源码构建说明应以对应上游版本为准。

本清单及 `licenses/` 保存本次使用组件的许可通知，不取代原许可条款，也不对未核实的 OCCT 二进制版本或其源码对应关系作出保证。
