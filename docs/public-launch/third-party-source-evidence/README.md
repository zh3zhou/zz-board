# Third-party source evidence (release-review input)

This directory records reproducible public sources for dependency licence records
that the local dependency scan could not pair with a physical licence file.
It is evidence for release review, not a legal conclusion and not an assertion
that every downstream distribution obligation has been met.

## What was verified on 2026-10-11

- Each Rust record in `resolved-licenses.json` has the exact crate version and
  crates.io checksum locked in `src-tauri/Cargo.lock`.  For projects whose
  published crate carries `.cargo_vcs_info.json`, the GitHub commit below is
  the commit recorded by the crate itself, not a branch name.
- The listed GitHub commits were resolved through the public GitHub API.  Where
  a repository contains a licence file, `licenseBlobSha` is GitHub's immutable
  Git blob identifier for that path at that commit.
- `cargo tree --target x86_64-pc-windows-msvc -i <crate>` was used only to
  distinguish Windows runtime reachability from build-only reachability.  It
  does not prove that a particular object file is linked into a final binary.
- The npm source URLs point to immutable version tarballs selected by
  `pnpm-lock.yaml`; the lock integrity remains the primary byte-level check.
- The six saved licence texts were base64-decoded from the listed immutable
  GitHub blob API responses and written as their original bytes. `git
  hash-object` matched every saved file to its recorded `licenseBlobSha`; the
  record's SHA-256 identifies those same saved bytes.

## Release interpretation

`buildOnly` is a packaging-scope observation.  A source export normally ships
the manifests and lockfiles, not `node_modules`, so the build-only npm tools do
not need their licence texts copied into a Windows portable asset merely
because the conservative inventory lists them.  Keep their records in the
source audit and have the release reviewer confirm the export does not include
their package files.

The following dependencies are runtime-reachable in the Windows Cargo graph
and must remain in the attribution/licence review for a Windows release:

- `alloc-stdlib`, `selectors`, `unic-char-property`, `unic-char-range`,
  `unic-common`, `unic-ucd-ident`, `unic-ucd-version`, `webview2-com`, and
  `webview2-com-sys`.

`webview2-com-macros` is a proc-macro (build-time) dependency. `defmt-parser`
had no path for the selected Windows target. This is not a claim about other
targets or development builds.

## Review items recorded on 2026-10-11

- `selectors` is MPL-2.0.  Its exact source is identified, but release review
  must still determine whether any MPL-covered source file was modified and
  provide the required corresponding source for any such distributed modified
  file. A link alone is not a complete MPL compliance analysis.
- `@img/sharp-win32-x64` declares `Apache-2.0 AND LGPL-3.0-or-later`. The
  package's local `LICENSE` is Apache-2.0 text, while the package metadata
  flags the separately relevant LGPL component. Before distributing the
  portable package, record the exact bundled libvips binary version, preserve
  its notices, provide the LGPL source/corresponding-source offer or durable
  source location as applicable, and assess whether users can replace the
  relevant shared component. Do not mark this cleared merely because `sharp`
  itself is Apache-2.0.
  The installed Windows x64 package contains `libvips-42.dll` (SHA-256
  `e6cc51bbc763e7deda536c6f56ce96b4c51ea769690ce4f4ed07607527b81dae`)
  and `libvips-cpp-8.18.6.dll` (SHA-256
  `4f458afdb7b8a4290dbda3f287d7db037b239b8a9d21f0b87333f92192cdee76`).
  Its `versions.json` declares libvips `8.18.6`. Public review sources are
  [sharp v0.35.4](https://github.com/lovell/sharp/tree/7f1a0a22cc285fe180766f4935d50b55af6e8432)
  and [libvips v8.18.6](https://github.com/libvips/libvips/tree/426af3f44246fce9cfa8dd51a353aa4dfd48c553).
  No PE dependency-inspection utility was available in this workspace, so the
  presence of separately packaged DLLs is not proof of a complete dynamic-link
  or user-replacement analysis.
- `abstract-logging@2.0.1` declares MIT in its exact package metadata but its
  published tarball and `v2.0.1` Git tag contain no standalone licence file.
  Preserve the package metadata and repository/tag reference, then have a
  reviewer decide the attribution text to use; do not invent a package-specific
  copyright notice.

The records deliberately have empty `files` arrays when no original licence
text was present in the exact published package or was not copied verbatim.
That preserves the scan's blocker rather than substituting a generic SPDX text
and claiming it was the package's distributed notice.

## 2026-11-27 Windows x64 evidence

The packaged server includes abstract-logging 2.0.1. The published npm tarball and exact tagged README link the author's MIT licence site. The evidence map records the README Git blob, notice URL, retrieval date and SHA-256. The service rendered the year 2026 on retrieval. This preserves the author's published notice as retrieved without inferring a 2016 package copyright year. The selectors declaration and source are pinned in its crate, and Mozilla supplied the full MPL 2.0 text. [Tagged README](https://github.com/jsumners/abstract-logging/blob/80dfaef91ee87008f4ed2b6e78921d383bccd406/Readme.md) · [Author's licence](https://jsumners.mit-license.org/license.txt) · [Mozilla licence](https://www.mozilla.org/media/MPL/2.0/index.815ca599c9df.txt)

The five files in `mpl/` are the exact crates.io publication archives selected by the Windows Cargo graph. Each archive hash matched Cargo.lock. All 65 archived regular files matched the corresponding unpacked build input. Cargo bookkeeping such as `.cargo-ok` is outside those archives. The Windows portable package copies the same archive bytes into `third-party-source/`.

The native npm package, its developer archive and the Windows libvips input were checked against npm SHA-512 integrity. The C runtime DLL also matched the byte-identical file inside upstream's x64 web static release ZIP (SHA-256 `42ceea0c2f53d1244f3cb54c059881487b37452ee46c1c98c0d4b47480b20588`). Its original LICENSE is included alongside the upstream Sharp native package notice. The C++ source members in the developer package match the five corresponding Git blobs in the libvips 8.18.6 commit. PE imports show that the Sharp addon uses both libvips DLLs and the C++ DLL imports the C DLL.

A full isolated copy of the package runtime decoded the same 3 × 2 RGB image using the original libraries, a local MSVC rebuild of the C++ library, the 8.18.7 stable x64 web static C library, both replacements, and the restored original files. The decoded bytes had SHA-256 `606a6ed1fe56b53b072dfe2aa1b3245af8426a0c57053ba4eb2b7ee041715368`. The stable replacement C DLL hashed to `06dab07cc386748513337a31672b1d5269fbc770a14ff403080575665bf0813f`. A separate 8.18.6 static-ffi substitution failed to load, including with its two required GLib DLLs present. The result is specific to the compatible replacement and measured decoder path. [Windows release inputs, build configuration, and patches](https://github.com/libvips/build-win64-mxe/tree/09cfccf20b91b441fbe97fa7a7ed8a597e55e830) · [Stable replacement release](https://github.com/libvips/build-win64-mxe/releases/tag/v8.18.7)

The public review still needs a distribution decision for complete corresponding sources of the LGPL components inside the C binary and continued source availability. The Windows build recipe uses a base image and an MXE branch. A pinned libvips source commit by itself does not identify those dependencies and their changes. The actual Windows component inventory and upstream GPL/LGPL texts are included in the notices. The precise source and replacement instructions for users are in the root THIRD_PARTY_NOTICES.md.

## Source-first Alpha distribution

The published source inventory includes the five MPL crate archives and the saved attribution texts. Windows native libraries and executables are acquired or built locally. The Windows binary redistribution investigation above remains open if that channel is resumed. The optional cloud-function driver postgres 3.4.9 declares the Unlicense. Its upstream UNLICENSE file is pinned in `resolved-licenses.json` and travels with the function bundle.
