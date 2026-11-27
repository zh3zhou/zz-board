# Project storage

Source, lockfiles, synthetic fixtures and project documentation belong in Git. Generated runtime, build output, diagnostics, credentials and real user data do not.

Check the installation and running desktop using the source deployment guide before deciding where to back up or restore. A local desktop running from a stand-alone installation without a binding or environment override defaults to `.local-data/` beside the portable application; an existing user binding or explicit `ZZ_BOARD_DATA_DIR` can select another writable directory. The data directory contains SQLite, image originals/previews, backups, runtime metadata, logs and the WebView profile. Keep database and image files together for backups. Snapshots do not include every private history or picture.

The summary runtime maintains a private local metadata index and removes per-request evidence/configuration files after use. It must pass the no-tools safety gate before sending bounded evidence through the current Codex login. This is separate from public feedback, which requires user preview and submission.

`dist/`, `src-tauri/target/` and `src-tauri/resources/runtime/` are generated. A portable artifact includes `zz-board.exe` and its complete adjacent `resources/`; the EXE alone is insufficient. Generated exports are independent copies and are not automatically deleted.

The public repository begins from a reviewed current-source baseline, with no imported private Git history. A public source identity is the new public commit and source inventory, not an earlier private commit. Original private audit hashes remain outside the exported tree.
