use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager};

const LOG_BYTES: u64 = 8 * 1024 * 1024;
const ENABLE_SCRIPT: &str = r#"if (location.origin === 'http://127.0.0.1:4318') { window.__ZZ_BOARD_TRIAL_DIAGNOSTICS__ = 'active'; }"#;
const FAIL_SCRIPT: &str = r#"if (window.__ZZ_BOARD_TRIAL_DIAGNOSTICS__ === 'active') { window.__ZZ_BOARD_TRIAL_DIAGNOSTICS__ = 'write_failed'; window.dispatchEvent(new Event('zz-board:trial-native-failed')); }"#;

pub(crate) struct TrialDiagnostics {
    file: PathBuf,
    failed: Mutex<bool>,
}

impl TrialDiagnostics {
    pub(crate) fn for_runtime(data_dir: &Path, runtime_dir: &Path, slot: &str, version: &str) -> Option<Self> {
        let manifest = runtime_dir.join("manifest.json");
        let entry = fs::symlink_metadata(&manifest).ok()?;
        if !entry.is_file() || entry.len() > 2_000_000 || redirected(&entry) {
            return None;
        }
        let bytes = fs::read(manifest).ok()?;
        if format!("zzb-runtime-{:x}", Sha256::digest(&bytes)) != slot {
            return None;
        }
        let json: Value = serde_json::from_slice(&bytes).ok()?;
        if json["schemaVersion"] != 2 || json["appVersion"] != version
            || json["trialDiagnostics"] != json!({ "schemaVersion": 1 })
        {
            return None;
        }
        Some(Self { file: data_dir.join("logs/trial/desktop.jsonl"), failed: Mutex::new(false) })
    }

    pub(crate) fn record(&self, event: &'static str, outcome: &'static str) {
        let Ok(mut failed) = self.failed.lock() else { return };
        let at = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64;
        let mut line = json!({ "schemaVersion": 1, "at": at, "layer": "desktop", "event": event, "outcome": outcome })
            .to_string();
        line.push('\n');
        if append(&self.file, line.as_bytes()).is_err() {
            *failed = true;
        }
    }

    pub(crate) fn failed(&self) -> bool {
        self.failed.lock().map_or(true, |failed| *failed)
    }

    pub(crate) fn initialization_script(&self) -> String {
        if self.failed() {
            format!("{ENABLE_SCRIPT}\n{FAIL_SCRIPT}")
        } else {
            ENABLE_SCRIPT.into()
        }
    }

    pub(crate) fn report_failure(&self, app: &AppHandle) {
        if self.failed() {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.eval(FAIL_SCRIPT);
            }
        }
    }
}

fn redirected(entry: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const REPARSE_POINT: u32 = 0x400;
        entry.file_attributes() & REPARSE_POINT != 0
    }
    #[cfg(not(windows))]
    {
        entry.file_type().is_symlink()
    }
}

pub(crate) fn check_local_path(file: &Path) -> io::Result<()> {
    for path in file.ancestors() {
        match fs::symlink_metadata(path) {
            Ok(entry) if redirected(&entry) => return Err(io::ErrorKind::InvalidInput.into()),
            Ok(_) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }
    }
    Ok(())
}

fn append(file: &Path, line: &[u8]) -> io::Result<()> {
    check_local_path(file)?;
    fs::create_dir_all(file.parent().ok_or(io::ErrorKind::InvalidInput)?)?;
    let mut output = OpenOptions::new().create(true).append(true).open(file)?;
    let entry = output.metadata()?;
    if !entry.is_file() || entry.len().saturating_add(line.len() as u64) > LOG_BYTES {
        return Err(io::ErrorKind::InvalidData.into());
    }
    output.write_all(line)
}
