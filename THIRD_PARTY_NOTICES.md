# 第三方组件、通知与对应源码

本次首发分发源码，由使用者在本机安装依赖并构建桌面程序。源码包含锁文件、许可与来源材料、五个 Rust MPL 原始源码归档。Node 可执行程序、Sharp 原生模块、libvips DLL 和编译好的桌面程序都由本机构建流程取得或生成。以下分别列出公开源码中的材料和历史 Windows 二进制审阅依据。

- 随附的第三方原文、crate 与补充通知在 `docs/public-launch/third-party-source-evidence/`。Node 的许可与出处在 `docs/public-launch/licenses/`。完整的 Windows 构建依赖盘点含开发工具，可查[版本与哈希](docs/public-launch/dependency-audit.json)和[许可文本](docs/public-launch/dependency-licenses.txt)。
- 可选的反馈后端使用 `postgres@3.4.9`。驱动声明 Unlicense，原文核对到精确发布提交。云函数部署包附上该原文；使用者从源码部署自己的桌面无需配置反馈数据库。[驱动许可](cloudbase/feedback/licenses/postgres-unlicense.txt)

## 获取 Rust MPL 组件源码

公开源码的 `docs/public-launch/third-party-source-evidence/mpl/` 含下表五个原始 `.crate`。它们是 gzip 压缩的 tar 源码归档，保留发行包里的源文件、声明和通知。可用 `tar -tf <文件名>` 查看，解压后即可阅读或修改。构建包按 `src-tauri/Cargo.lock` 核对 SHA-256。也可以从 crates.io 独立取得相同字节。

| 组件 | 版本 | 对应源码 |
| --- | --- | --- |
| cssparser | 0.36.0 | [crates.io 归档](https://static.crates.io/crates/cssparser/cssparser-0.36.0.crate) |
| cssparser-macros | 0.6.1 | [crates.io 归档](https://static.crates.io/crates/cssparser-macros/cssparser-macros-0.6.1.crate) |
| dtoa-short | 0.3.5 | [crates.io 归档](https://static.crates.io/crates/dtoa-short/dtoa-short-0.3.5.crate) |
| option-ext | 0.2.0 | [crates.io 归档](https://static.crates.io/crates/option-ext/option-ext-0.2.0.crate) |
| selectors | 0.36.1 | [crates.io 归档](https://static.crates.io/crates/selectors/selectors-0.36.1.crate) |

## 本机构建使用的 Windows 图像组件

Windows 构建使用 `@img/sharp-win32-x64@0.35.4`。其声明为 `Apache-2.0 AND LGPL-3.0-or-later`。Sharp 列出的图像与字体依赖包含 LGPL 组件及 MPL 的 Cairo。精确组件版本见随包模块的 `versions.json`，该模块的 README 提供组件清单。本地二进制回归包的 `THIRD-PARTY-LICENSES.txt` 包含该 README、Windows 上游包的原始 COPYING 文本以及 GNU GPLv3、LGPLv3 和 MPL 2.0 正文。第三方库及其修改可按各自条款使用、替换和调试。[Sharp 0.35.4 源码](https://github.com/lovell/sharp/tree/7f1a0a22cc285fe180766f4935d50b55af6e8432)

- **libvips C 库。** `libvips-42.dll` 与 libvips 8.18.6 官方 Windows x64 web static ZIP 中的文件逐字节相同。Windows 构建仓库包含生成脚本、组件版本、依赖覆盖和补丁，其中包括 GLib、Cairo、libheif 和 librsvg 使用的修改。Windows 包记录的 aom 为 3.14.1。[libvips 8.18.6 源码](https://github.com/libvips/libvips/tree/426af3f44246fce9cfa8dd51a353aa4dfd48c553) · [Windows 构建与补丁](https://github.com/libvips/build-win64-mxe/tree/09cfccf20b91b441fbe97fa7a7ed8a597e55e830) · [Sharp 的 Windows 打包脚本](https://github.com/lovell/sharp-libvips/blob/6e5971d333377743163edc3ad9e5d0b897abcbc9/build/win.sh)
- **C++ 库。** `libvips-cpp-8.18.6.dll` 可用 MSVC 从 libvips 8.18.6 的五个 C++ 源文件编译。`@img/sharp-libvips-dev@1.3.3` 提供相同源文件与头文件，Windows x64 开发包提供导入库及 GLib 平台头文件。使用 Sharp 的 Windows 构建目标选择导出符号、包含目录及链接配置。[Sharp 编译配置](https://github.com/lovell/sharp/blob/7f1a0a22cc285fe180766f4935d50b55af6e8432/src/binding.gyp) · [开发源码和头文件](https://registry.npmjs.org/@img/sharp-libvips-dev/-/sharp-libvips-dev-1.3.3.tgz) · [Windows 开发包](https://registry.npmjs.org/@img/sharp-libvips-win32-x64/-/sharp-libvips-win32-x64-1.3.3.tgz)

**在独立副本里测试自己的兼容构建。** 将本机构建的完整桌面程序及相邻资源复制到可写目录，保留两份原 DLL。在该副本的程序及服务退出后，用兼容的替换文件覆盖 `resources/runtime/node_modules/@img/sharp-win32-x64/lib/` 内的同名文件。重新启动该副本中的进程以加载新 DLL。开发测试可以直接用此 `resources/runtime/` 内的 `node.exe` 运行 Sharp 的 PNG 编解码。一次验证中，上游 8.18.7 的 x64 web static C DLL 与从 8.18.6 源码重新编译的 C++ DLL 可分别或一起使用，样例像素读写一致。另一个 static-ffi 构建的导出不兼容；即使补齐两个 GLib 依赖也无法加载。安装器会校验官方资源清单，升级或重新安装前请保留自己的修改及原包。

**将来分发二进制时复核。** 上述资料定位了当前 Windows 组件，记录的构建使用上游基础镜像和 MXE 源分支。覆盖库及其内嵌依赖的完整对应源码、可获取期限、必要归属与分发条件仍须按实际首发制品核查。补充的来源与验证记录在配套源码的 `docs/public-launch/third-party-source-evidence/`。
