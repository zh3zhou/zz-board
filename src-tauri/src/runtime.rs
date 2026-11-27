use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc::{Receiver, RecvTimeoutError, Sender};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Deserialize;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager, Url};

use crate::trial_diagnostics::{check_local_path, TrialDiagnostics};

const APP_VERSION: &str = env!("CARGO_PKG_VERSION");
const PACKAGED_RUNTIME: &str = env!("ZZ_BOARD_PACKAGED_RUNTIME");
const HOST: &str = "127.0.0.1";
const PORT: u16 = 4318;
const BOARD_URL: &str = "http://127.0.0.1:4318";
pub(crate) const STARTUP_HINT_DELAY: Duration = Duration::from_secs(2);
const HEALTH_PATH: &str = "/api/health";
const RETRY_SECONDS: [u64; 5] = [1, 2, 4, 8, 16];

#[derive(Debug)]
pub enum Control {
    Restart,
    Quit(Sender<()>),
}

pub struct DesktopRuntime {
    control: Sender<Control>,
}

impl DesktopRuntime {
    pub fn new(control: Sender<Control>) -> Self {
        Self { control }
    }

    pub fn restart(&self) {
        let _ = self.control.send(Control::Restart);
    }

    pub fn quit(&self, timeout: Duration) -> bool {
        let (acknowledge, completed) = std::sync::mpsc::channel();
        self.control.send(Control::Quit(acknowledge)).is_ok()
            && completed.recv_timeout(timeout).is_ok()
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Health {
    ok: bool,
    app_version: String,
    runtime: String,
    packaged_runtime: Option<String>,
    data_store_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Binding {
    schema_version: u8,
    project_root: PathBuf,
    data_dir: PathBuf,
    desktop_executable: PathBuf,
    board_url: String,
}

pub(crate) struct Paths {
    project_root: PathBuf,
    pub(crate) data_dir: PathBuf,
    runtime_dir: PathBuf,
    log_path: PathBuf,
    pub(crate) trial: Option<Arc<TrialDiagnostics>>,
}

impl Paths {
    fn trace(&self, event: &'static str, outcome: &'static str) {
        if let Some(trial) = &self.trial {
            trial.record(event, outcome);
        }
    }
}

enum Probe {
    Available(Health),
    Unavailable,
    Invalid(String),
}

pub(crate) struct InitialService {
    ready: bool,
    child: Option<Child>,
}

impl InitialService {
    pub(crate) fn is_ready(&self) -> bool {
        self.ready
    }
}

pub(crate) fn board_url() -> Url {
    Url::parse(BOARD_URL).expect("the fixed loopback board URL must be valid")
}

pub(crate) fn prepare_initial_service(paths: &Paths, window_deadline: Instant) -> InitialService {
    let expected_store = data_store_id(&paths.data_dir);
    match probe_health(&expected_store) {
        Probe::Available(_) => {
            paths.trace("sidecar_ready", "ok");
            return InitialService {
                ready: true,
                child: None,
            };
        }
        Probe::Invalid(_) => {
            paths.trace("health_conflict", "blocked");
            return InitialService {
                ready: false,
                child: None,
            };
        }
        Probe::Unavailable => {}
    }

    let mut child = match spawn_sidecar(paths, &expected_store) {
        Ok(child) => Some(child),
        Err(error) => {
            log_line(
                &paths.log_path,
                &format!("initial sidecar spawn failed: {error}"),
            );
            return InitialService {
                ready: false,
                child: None,
            };
        }
    };
    while Instant::now() < window_deadline {
        if let Some(owned) = child.as_mut() {
            if matches!(owned.try_wait(), Ok(Some(_)) | Err(_)) {
                paths.trace("sidecar_exit", "failed");
                stop_owned(&mut child, paths);
                return InitialService {
                    ready: false,
                    child: None,
                };
            }
        }
        match probe_health(&expected_store) {
            Probe::Available(_) => {
                log_line(
                    &paths.log_path,
                    "initial sidecar ready before window creation",
                );
                paths.trace("sidecar_ready", "ok");
                return InitialService { ready: true, child };
            }
            Probe::Invalid(_) => {
                paths.trace("health_conflict", "blocked");
                stop_owned(&mut child, paths);
                return InitialService {
                    ready: false,
                    child: None,
                };
            }
            Probe::Unavailable => std::thread::sleep(Duration::from_millis(150)),
        }
    }
    // The window can show its quiet waiting page while this same child starts.
    InitialService { ready: false, child }
}

pub fn supervise(
    app: AppHandle,
    controls: Receiver<Control>,
    paths: Paths,
    initial: InitialService,
) {
    let expected_store = data_store_id(&paths.data_dir);
    let continuing_start = !initial.ready && initial.child.is_some();
    let mut child = initial.child;
    let mut failures = 0_usize;

    log_line(
        &paths.log_path,
        &format!("desktop runtime {APP_VERSION} starting"),
    );

    if continuing_start {
        match wait_until_ready(&controls, &mut child, &paths, &expected_store) {
            StartWait::Ready => {}
            StartWait::Quit => return,
            StartWait::Restart | StartWait::Failed => stop_owned(&mut child, &paths),
        }
    }

    loop {
        if let Some(trial) = &paths.trial { trial.report_failure(&app); }
        match controls.try_recv() {
            Ok(Control::Quit(acknowledge)) => {
                stop_owned(&mut child, &paths);
                let _ = acknowledge.send(());
                break;
            }
            Ok(Control::Restart) => {
                stop_owned(&mut child, &paths);
                failures = 0;
            }
            Err(_) => {}
        }

        match probe_health(&expected_store) {
            Probe::Available(_) => {
                navigate_board(&app, &paths.log_path);
                if supervise_healthy_service(
                    &app,
                    &controls,
                    &mut child,
                    &paths,
                    &expected_store,
                    &mut failures,
                ) {
                    break;
                }
            }
            Probe::Invalid(reason) => {
                paths.trace("health_conflict", "blocked");
                stop_owned(&mut child, &paths);
                show_recovery(&app, "无法验证本地服务", &reason, Some(&paths.log_path));
                if wait_for_control(
                    &controls,
                    Duration::from_secs(2),
                    &mut child,
                    &paths,
                ) {
                    break;
                }
            }
            Probe::Unavailable => {
                stop_owned(&mut child, &paths);
                if failures >= RETRY_SECONDS.len() {
                    show_recovery(
                        &app,
                        "本地服务持续启动失败",
                        "已完成五次退避重试。可从托盘选择“重启本地服务”再次尝试。",
                        Some(&paths.log_path),
                    );
                    match controls.recv() {
                        Ok(Control::Restart) => failures = 0,
                        Ok(Control::Quit(acknowledge)) => {
                            stop_owned(&mut child, &paths);
                            let _ = acknowledge.send(());
                            break;
                        }
                        Err(_) => {
                            stop_owned(&mut child, &paths);
                            break;
                        }
                    }
                    continue;
                }

                match spawn_sidecar(&paths, &expected_store) {
                    Ok(spawned) => {
                        child = Some(spawned);
                        match wait_until_ready(&controls, &mut child, &paths, &expected_store) {
                            StartWait::Ready => continue,
                            StartWait::Quit => return,
                            StartWait::Restart => {
                                stop_owned(&mut child, &paths);
                                failures = 0;
                                continue;
                            }
                            StartWait::Failed => {}
                        }
                    }
                    Err(error) => {
                        log_line(&paths.log_path, &format!("sidecar spawn failed: {error}"))
                    }
                }

                stop_owned(&mut child, &paths);
                let delay = RETRY_SECONDS[failures];
                failures += 1;
                show_recovery(
                    &app,
                    "正在恢复本地服务",
                    &format!("第 {failures} 次启动未成功，{delay} 秒后重试。"),
                    Some(&paths.log_path),
                );
                if wait_for_control(
                    &controls,
                    Duration::from_secs(delay),
                    &mut child,
                    &paths,
                ) {
                    break;
                }
            }
        }
    }
}

fn supervise_healthy_service(
    app: &AppHandle,
    controls: &Receiver<Control>,
    child: &mut Option<Child>,
    paths: &Paths,
    expected_store: &str,
    failures: &mut usize,
) -> bool {
    let log_path = &paths.log_path;
    let healthy_since = Instant::now();
    let mut health_misses = 0_u8;
    loop {
        if let Some(trial) = &paths.trial { trial.report_failure(app); }
        match controls.recv_timeout(Duration::from_secs(2)) {
            Ok(Control::Quit(acknowledge)) => {
                stop_owned(child, paths);
                let _ = acknowledge.send(());
                return true;
            }
            Ok(Control::Restart) => {
                stop_owned(child, paths);
                return false;
            }
            Err(RecvTimeoutError::Disconnected) => {
                stop_owned(child, paths);
                return true;
            }
            Err(RecvTimeoutError::Timeout) => {}
        }

        if let Some(owned) = child.as_mut() {
            match owned.try_wait() {
                Ok(Some(status)) => {
                    paths.trace("sidecar_exit", "failed");
                    log_line(log_path, &format!("owned sidecar exited: {status}"));
                    *child = None;
                    if healthy_since.elapsed() >= Duration::from_secs(60) {
                        *failures = 0;
                    }
                    let delay = RETRY_SECONDS[(*failures).min(RETRY_SECONDS.len() - 1)];
                    *failures += 1;
                    show_recovery(
                        app,
                        "本地服务意外停止",
                        &format!("{delay} 秒后尝试恢复（第 {failures} 次）。"),
                        Some(log_path),
                    );
                    if wait_for_control(controls, Duration::from_secs(delay), child, paths) {
                        return true;
                    }
                    return false;
                }
                Ok(None) => {}
                Err(error) => {
                    paths.trace("sidecar_exit", "failed");
                    log_line(log_path, &format!("sidecar status failed: {error}"));
                    *child = None;
                    return false;
                }
            }
        }

        match probe_health(expected_store) {
            Probe::Available(_) => health_misses = 0,
            Probe::Unavailable => {
                health_misses += 1;
                log_line(
                    log_path,
                    &format!("health transport miss {health_misses}/3; retaining current canvas"),
                );
                if health_misses < 3 {
                    continue;
                }
                paths.trace("health_unavailable", "failed");
                if healthy_since.elapsed() >= Duration::from_secs(60) {
                    *failures = 0;
                }
                stop_owned(child, paths);
                show_recovery(
                    app,
                    "本地服务暂时不可用",
                    "连续三次健康检查失败，正在尝试恢复。",
                    Some(log_path),
                );
                return false;
            }
            Probe::Invalid(reason) => {
                paths.trace("health_conflict", "blocked");
                log_line(log_path, &format!("health protocol invalid: {reason}"));
                stop_owned(child, paths);
                return false;
            }
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
enum StartWait {
    Ready,
    Restart,
    Failed,
    Quit,
}

fn wait_until_ready(
    controls: &Receiver<Control>,
    child: &mut Option<Child>,
    paths: &Paths,
    expected_store: &str,
) -> StartWait {
    let deadline = Instant::now() + Duration::from_secs(12);
    while Instant::now() < deadline {
        match controls.recv_timeout(Duration::from_millis(200)) {
            Ok(Control::Quit(acknowledge)) => {
                stop_owned(child, paths);
                let _ = acknowledge.send(());
                return StartWait::Quit;
            }
            Ok(Control::Restart) => return StartWait::Restart,
            Err(RecvTimeoutError::Disconnected) => {
                stop_owned(child, paths);
                return StartWait::Quit;
            }
            Err(RecvTimeoutError::Timeout) => {}
        }
        if let Some(owned) = child.as_mut() {
            if matches!(owned.try_wait(), Ok(Some(_)) | Err(_)) {
                paths.trace("sidecar_exit", "failed");
                return StartWait::Failed;
            }
        }
        match probe_health(expected_store) {
            Probe::Available(health) => {
                log_line(
                    &paths.log_path,
                    &format!("sidecar ready with runtime {}", health.runtime),
                );
                paths.trace("sidecar_ready", "ok");
                return StartWait::Ready;
            }
            Probe::Invalid(_) => {
                paths.trace("health_conflict", "blocked");
                return StartWait::Failed;
            }
            Probe::Unavailable => {}
        }
    }
    paths.trace("sidecar_ready", "failed");
    StartWait::Failed
}

fn wait_for_control(
    controls: &Receiver<Control>,
    duration: Duration,
    child: &mut Option<Child>,
    paths: &Paths,
) -> bool {
    match controls.recv_timeout(duration) {
        Ok(Control::Quit(acknowledge)) => {
            stop_owned(child, paths);
            let _ = acknowledge.send(());
            true
        }
        Err(RecvTimeoutError::Disconnected) => {
            stop_owned(child, paths);
            true
        }
        Ok(Control::Restart) | Err(RecvTimeoutError::Timeout) => false,
    }
}

fn spawn_sidecar(paths: &Paths, expected_store: &str) -> Result<Child, String> {
    let child = spawn_packaged_runtime(paths, expected_store);
    paths.trace("sidecar_spawn", if child.is_ok() { "ok" } else { "failed" });
    child
}

fn spawn_packaged_runtime(paths: &Paths, expected_store: &str) -> Result<Child, String> {
    let node = paths.runtime_dir.join("node.exe");
    let server = paths.runtime_dir.join("server.cjs");
    if !node.is_file() {
        return Err(format!("missing packaged Node runtime: {}", node.display()));
    }
    if !server.is_file() {
        return Err(format!("missing packaged server: {}", server.display()));
    }
    fs::create_dir_all(&paths.data_dir).map_err(|error| error.to_string())?;
    if let Some(parent) = paths.log_path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    rotate_log(&paths.log_path)?;
    let stdout = append_log(&paths.log_path)?;
    let stderr = stdout.try_clone().map_err(|error| error.to_string())?;

    log_line(
        &paths.log_path,
        &format!(
            "starting packaged sidecar for {}",
            paths.project_root.display()
        ),
    );
    let mut command = Command::new(node);
    command
        .arg("server.cjs")
        .current_dir(&paths.runtime_dir)
        .env("ZZ_BOARD_HOST", HOST)
        .env("ZZ_BOARD_PORT", PORT.to_string())
        .env("ZZ_BOARD_DATA_DIR", &paths.data_dir)
        .env("ZZ_BOARD_PROJECT_ROOT", &paths.project_root)
        .env("ZZ_BOARD_DEMO", "0")
        .env("ZZ_BOARD_RUNTIME", "desktop-sidecar")
        .env("ZZ_BOARD_PACKAGED_RUNTIME", PACKAGED_RUNTIME)
        .env("ZZ_BOARD_DATA_STORE_ID", expected_store)
        .stdin(Stdio::null())
        .stdout(Stdio::from(stdout))
        .stderr(Stdio::from(stderr));
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    command.spawn().map_err(|error| error.to_string())
}

fn stop_owned(child: &mut Option<Child>, paths: &Paths) {
    let Some(mut owned) = child.take() else {
        return;
    };
    log_line(
        &paths.log_path,
        &format!("stopping owned sidecar pid {}", owned.id()),
    );
    let _ = owned.kill();
    let stopped = owned.wait().is_ok();
    paths.trace("sidecar_stop", if stopped { "ok" } else { "failed" });
}

fn probe_health(expected_store: &str) -> Probe {
    let address = SocketAddr::from(([127, 0, 0, 1], PORT));
    let mut stream = match TcpStream::connect_timeout(&address, Duration::from_millis(550)) {
        Ok(stream) => stream,
        Err(_) => return Probe::Unavailable,
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(800)));
    let _ = stream.set_write_timeout(Some(Duration::from_millis(800)));
    let request = format!(
        "GET {HEALTH_PATH} HTTP/1.1\r\nHost: {HOST}:{PORT}\r\nConnection: close\r\nAccept: application/json\r\n\r\n"
    );
    if stream.write_all(request.as_bytes()).is_err() {
        return Probe::Unavailable;
    }
    read_health_response(stream, expected_store)
}

fn read_health_response(reader: impl Read, expected_store: &str) -> Probe {
    let mut response = Vec::with_capacity(2048);
    // Transport failures (including a busy service's read timeout) do not prove
    // an incompatible service. They must pass the consecutive-miss gate.
    if reader.take(32 * 1024).read_to_end(&mut response).is_err() {
        return Probe::Unavailable;
    }
    let Some(separator) = response.windows(4).position(|part| part == b"\r\n\r\n") else {
        return Probe::Invalid("健康检查响应不是有效 HTTP。".into());
    };
    let header = String::from_utf8_lossy(&response[..separator]);
    if !header.starts_with("HTTP/1.1 200") && !header.starts_with("HTTP/1.0 200") {
        return Probe::Invalid("4318 端口返回了非成功响应。".into());
    }
    match serde_json::from_slice::<Health>(&response[separator + 4..]) {
        Ok(health) => match validate_health(&health, expected_store) {
            Ok(()) => Probe::Available(health),
            Err(reason) => Probe::Invalid(reason),
        },
        Err(_) => Probe::Invalid("4318 端口没有返回兼容的 ZZ Board 健康信息。".into()),
    }
}

fn validate_health(health: &Health, expected_store: &str) -> Result<(), String> {
    if !health.ok {
        return Err("本地服务报告未就绪。".into());
    }
    if health.app_version != APP_VERSION {
        return Err(format!(
            "端口上的版本为 {}，桌面版本为 {APP_VERSION}。不会终止未知进程。",
            health.app_version
        ));
    }
    if health.data_store_id != expected_store {
        return Err("端口上的服务使用了另一个数据目录。不会终止未知进程。".into());
    }
    match health.runtime.as_str() {
        "web-fallback" => Ok(()),
        "desktop-sidecar" if health.packaged_runtime.as_deref() == Some(PACKAGED_RUNTIME) => Ok(()),
        "desktop-sidecar" => Err("本地服务来自另一套桌面程序，请保存并从旧版托盘选择「真正退出」后重试。".into()),
        _ => Err("4318 端口的服务类型不受支持。".into()),
    }
}

pub(crate) fn resolve_paths(app: &AppHandle) -> Result<Paths, String> {
    let executable = std::env::current_exe().map_err(|error| error.to_string())?;
    let runtime_dir = runtime_dir(app)?;
    let fallback_root = infer_project_root(&executable);
    let trial_data = executable.with_file_name(".local-data");
    let trial = TrialDiagnostics::for_runtime(&trial_data, &runtime_dir, PACKAGED_RUNTIME, APP_VERSION).map(Arc::new);

    let (project_root, data_dir) = match read_binding()? {
        Some(binding) => {
            if binding.schema_version != 1 {
                return Err("ZZ Board 本地绑定版本不受支持。".into());
            }
            if binding.board_url != BOARD_URL {
                return Err("ZZ Board 本地绑定使用了非标准地址。".into());
            }
            let matching_executable = same_path(&binding.desktop_executable, &executable);
            if trial.is_some() && (!matching_executable || !same_path(&binding.data_dir, &trial_data)) {
                return Err("试用版需要独立安装，请让 Agent 检查现有绑定与试用安装位置。".into());
            }
            if !matching_executable {
                log_line(
                    &binding.data_dir.join("logs/desktop.log"),
                    "binding desktopExecutable differs from the running executable; continuing with the configured data store",
                );
            }
            (binding.project_root, binding.data_dir)
        }
        None => {
            let root = std::env::var_os("ZZ_BOARD_PROJECT_ROOT")
                .map(PathBuf::from)
                .unwrap_or(fallback_root);
            let data = std::env::var_os("ZZ_BOARD_DATA_DIR")
                .map(PathBuf::from)
                .unwrap_or_else(|| if trial.is_some() { trial_data.clone() } else { root.join(".local-data") });
            (root, data)
        }
    };

    let mut data_dir = absolute_path(data_dir)?;
    if trial.is_some() {
        let environment_conflict = std::env::var_os("ZZ_BOARD_DATA_DIR")
            .is_some_and(|value| !same_path(Path::new(&value), &trial_data));
        if environment_conflict || !same_path(&data_dir, &trial_data) || check_local_path(&trial_data).is_err() {
            return Err("试用版需使用程序旁独立的本机数据目录，请让 Agent 检查配置。".into());
        }
        data_dir = trial_data;
    }
    let log_path = data_dir.join("logs/desktop.log");
    Ok(Paths {
        project_root: absolute_path(project_root)?,
        data_dir,
        runtime_dir,
        log_path,
        trial,
    })
}

pub(crate) fn fallback_data_dir() -> PathBuf {
    // An invalid binding/resource set must never give the recovery window
    // access to the WebView profile of an existing board.
    std::env::current_exe()
        .map(|executable| executable.with_file_name(".zz-board-recovery"))
        .unwrap_or_else(|_| PathBuf::from(".zz-board-recovery"))
}

fn infer_project_root(executable: &Path) -> PathBuf {
    let executable_dir = executable.parent().unwrap_or_else(|| Path::new("."));
    let profile = executable_dir.file_name().and_then(|name| name.to_str());
    let target = executable_dir.parent();
    let source = target.and_then(Path::parent);
    if matches!(profile, Some("debug" | "release"))
        && target
            .and_then(Path::file_name)
            .and_then(|name| name.to_str())
            == Some("target")
        && source
            .and_then(Path::file_name)
            .and_then(|name| name.to_str())
            == Some("src-tauri")
    {
        return source
            .and_then(Path::parent)
            .map(Path::to_path_buf)
            .unwrap_or_else(|| executable_dir.to_path_buf());
    }
    executable_dir.to_path_buf()
}

fn read_binding() -> Result<Option<Binding>, String> {
    let Some(home) = std::env::var_os("USERPROFILE") else {
        return Ok(None);
    };
    let path = PathBuf::from(home).join(".codex/zz-board.json");
    if !path.is_file() {
        return Ok(None);
    }
    let text = fs::read_to_string(&path)
        .map_err(|error| format!("无法读取 {}：{error}", path.display()))?;
    serde_json::from_str(&text)
        .map(Some)
        .map_err(|error| format!("本地绑定 {} 格式无效：{error}", path.display()))
}

fn runtime_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let resource_root = app
        .path()
        .resource_dir()
        .map_err(|error| error.to_string())?;
    // A portable update prepares an immutable runtime before replacing the pinned
    // executable. The installer and the raw build use the normal Tauri layout.
    let candidates = vec![
        resource_root.join("resources").join(PACKAGED_RUNTIME),
        resource_root.join("resources/runtime"),
        resource_root.join("runtime"),
    ];
    #[cfg(debug_assertions)]
    let candidates = {
        let mut candidates = candidates;
        candidates.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/runtime"));
        candidates
    };
    candidates
        .into_iter()
        .find(|candidate| {
            if !candidate.join("server.cjs").is_file() {
                return false;
            }
            if PACKAGED_RUNTIME == "development" {
                return true;
            }
            fs::read(candidate.join("manifest.json")).is_ok_and(|bytes| {
                format!("zzb-runtime-{:x}", Sha256::digest(&bytes)) == PACKAGED_RUNTIME
            })
        })
        .ok_or_else(|| "找不到与此程序匹配的本地服务资源。请重新应用完整的 ZZ Board 安装包。".into())
}

fn absolute_path(path: PathBuf) -> Result<PathBuf, String> {
    if path.is_absolute() {
        Ok(path)
    } else {
        std::env::current_dir()
            .map(|cwd| cwd.join(path))
            .map_err(|error| error.to_string())
    }
}

fn data_store_id(data_dir: &Path) -> String {
    let normalized = data_dir.to_string_lossy().replace('\\', "/").to_lowercase();
    let digest = Sha256::digest(normalized.as_bytes());
    format!("{digest:x}")[..16].to_string()
}

fn same_path(left: &Path, right: &Path) -> bool {
    left.to_string_lossy().replace('\\', "/").to_lowercase()
        == right.to_string_lossy().replace('\\', "/").to_lowercase()
}

fn navigate_board(app: &AppHandle, log_path: &Path) {
    let app = app.clone();
    let callback_log_path = log_path.to_path_buf();
    let scheduling_log_path = callback_log_path.clone();
    if let Ok(url) = Url::parse(BOARD_URL) {
        if let Err(error) = app.clone().run_on_main_thread(move || {
            if let Some(window) = app.get_webview_window("main") {
                if window
                    .url()
                    .is_ok_and(|current| is_board_document(&current))
                {
                    // An HTTP error document can still have the board URL.
                    // Retry that document, but never reload a mounted/loading app.
                    let _ = window.eval(include_str!("desktop-open.js"));
                    return;
                }
                match window.navigate(url) {
                    Ok(()) => log_line(&callback_log_path, "board navigation requested"),
                    Err(error) => log_line(
                        &callback_log_path,
                        &format!("board navigation failed: {error}"),
                    ),
                }
            } else {
                log_line(
                    &callback_log_path,
                    "board navigation skipped: main window missing",
                );
            }
        }) {
            log_line(
                &scheduling_log_path,
                &format!("board navigation scheduling failed: {error}"),
            );
        }
    }
}

fn navigate_status(app: &AppHandle, url: Url) {
    let app = app.clone();
    let _ = app.clone().run_on_main_thread(move || {
        if let Some(window) = app.get_webview_window("main") {
            // Keep an already-rendered board (including drafts and selection)
            // alive while the service recovers. Only cold startup uses a page.
            let fallback = serde_json::to_string(url.as_str()).expect("URL is JSON-safe");
            let script = include_str!("desktop-recovery.js").replace("__STATUS_URL__", &fallback);
            let _ = window.eval(&script);
        }
    });
}

fn is_board_document(url: &Url) -> bool {
    url.origin() == board_url().origin() && url.path() == "/"
}

fn show_recovery(app: &AppHandle, title: &str, detail: &str, log_path: Option<&Path>) {
    navigate_status(app, status_page(title, detail, log_path));
}

pub fn startup_page(hint_delay: Duration) -> Url {
    let html = format!(
        r#"<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>ZZ Board</title>
<style>html,body{{height:100%;margin:0}}body{{display:grid;place-items:center;background:#e8e2d4;color:#596461;font:15px system-ui,sans-serif}}p{{visibility:hidden;animation:show 0s {}ms forwards}}@keyframes show{{to{{visibility:visible}}}}</style>
<p role="status">正在打开看板…</p></html>"#,
        hint_delay.as_millis()
    );
    inline_page(&html)
}

pub fn status_page(title: &str, detail: &str, log_path: Option<&Path>) -> Url {
    let log = log_path.map(|path| format!("<p>日志：{}</p>", html_escape(&path.display().to_string()))).unwrap_or_default();
    let retry = if log_path.is_some() {
        "可从系统托盘选择「重启本地服务」重试。"
    } else {
        "请查看故障详情。从系统托盘选择「真正退出」后可以重新打开桌面版。"
    };
    let html = format!(
        r#"<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>ZZ Board</title>
<style>html,body{{height:100%;margin:0}}body{{display:grid;place-items:center;background:#e8e2d4;color:#293432;font:16px system-ui,sans-serif}}main{{max-width:38rem;padding:2rem}}h1{{font-size:23px}}p{{line-height:1.7;overflow-wrap:anywhere}}summary{{cursor:pointer}}textarea{{box-sizing:border-box;width:100%;min-height:6em;font:13px monospace}}</style>
<main><h1>{}</h1><p>{retry}</p><details><summary>故障详情与帮助</summary><p>{}</p>{log}<p>如需反馈，可以复制下方报告。报告只包含版本、平台和故障阶段。</p><textarea readonly aria-label="安全反馈报告">{}</textarea><p>问题入口：github.com/zh3zhou/zz-board/issues</p></details></main></html>"#,
        html_escape(title), html_escape(detail), safe_feedback_report()
    );
    inline_page(&html)
}

fn inline_page(html: &str) -> Url {
    Url::parse(&format!("data:text/html;charset=utf-8,{}", percent_encode(html)))
        .expect("static desktop page must form a valid data URL")
}

fn safe_feedback_report() -> String {
    format!("ZZ Board v{APP_VERSION}\nplatform: windows\nphase: desktop_startup_unavailable")
}

fn html_escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

fn percent_encode(value: &str) -> String {
    let mut encoded = String::with_capacity(value.len() * 2);
    for byte in value.as_bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
            encoded.push(*byte as char);
        } else {
            encoded.push_str(&format!("%{byte:02X}"));
        }
    }
    encoded
}

fn append_log(path: &Path) -> Result<File, String> {
    OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|error| error.to_string())
}

fn rotate_log(path: &Path) -> Result<(), String> {
    let Ok(metadata) = fs::metadata(path) else {
        return Ok(());
    };
    if metadata.len() <= 10 * 1024 * 1024 {
        return Ok(());
    }
    let previous = path.with_file_name("server.previous.log");
    let _ = fs::remove_file(&previous);
    fs::rename(path, previous).map_err(|error| error.to_string())
}

fn log_line(path: &Path, message: &str) {
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if let Ok(mut log) = append_log(path) {
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|value| value.as_secs())
            .unwrap_or_default();
        let _ = writeln!(log, "[{timestamp}] {message}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn transient_health_read_errors_are_not_incompatible_services() {
        struct BrokenReader(std::io::ErrorKind);
        impl Read for BrokenReader {
            fn read(&mut self, _: &mut [u8]) -> std::io::Result<usize> {
                Err(std::io::Error::from(self.0))
            }
        }
        for kind in [
            std::io::ErrorKind::TimedOut,
            std::io::ErrorKind::WouldBlock,
            std::io::ErrorKind::ConnectionReset,
        ] {
            assert!(matches!(
                read_health_response(BrokenReader(kind), "synthetic"),
                Probe::Unavailable
            ));
        }
    }

    #[test]
    fn health_protocol_validation_is_not_weakened() {
        for malformed in [
            "",
            "HTTP/1.1 500 Error\r\n\r\n{}",
            "HTTP/1.1 200 OK\r\n\r\n{}",
        ] {
            assert!(matches!(
                read_health_response(malformed.as_bytes(), "synthetic"),
                Probe::Invalid(_)
            ));
        }
    }

    #[test]
    fn only_a_matching_desktop_runtime_or_compatible_web_service_is_ready() {
        let health = serde_json::json!({
            "ok": true, "appVersion": APP_VERSION, "dataStoreId": "synthetic",
            "runtime": "desktop-sidecar", "packagedRuntime": PACKAGED_RUNTIME
        });
        let probe = |health: &serde_json::Value| {
            let response = format!("HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n{health}");
            read_health_response(response.as_bytes(), "synthetic")
        };
        assert!(matches!(probe(&health), Probe::Available(_)));
        for (key, value) in [
            ("ok", serde_json::json!(false)),
            ("appVersion", serde_json::json!("0.0.0")),
            ("dataStoreId", serde_json::json!("other")),
            ("runtime", serde_json::json!("other")),
            ("packagedRuntime", serde_json::json!("other-build")),
        ] {
            let mut other = health.clone();
            other[key] = value;
            assert!(matches!(probe(&other), Probe::Invalid(_)), "{key}");
        }
        let mut legacy = health;
        legacy.as_object_mut().unwrap().remove("packagedRuntime");
        assert!(matches!(probe(&legacy), Probe::Invalid(_)));
        legacy["runtime"] = serde_json::json!("web-fallback");
        assert!(matches!(probe(&legacy), Probe::Available(_)));
        legacy["dataStoreId"] = serde_json::json!("other");
        assert!(matches!(probe(&legacy), Probe::Invalid(_)));
    }

    #[test]
    fn healthy_board_urls_are_not_navigated_again() {
        for value in [
            BOARD_URL,
            "http://127.0.0.1:4318/?desktop-recovery=1",
            "http://127.0.0.1:4318/#canvas",
        ] {
            assert!(is_board_document(&Url::parse(value).unwrap()));
        }
        for value in [
            "data:text/html,recover",
            "http://127.0.0.1:4318/error",
            "http://127.0.0.1:4319/",
        ] {
            assert!(!is_board_document(&Url::parse(value).unwrap()));
        }
    }

    #[test]
    fn store_id_is_stable_across_windows_path_case_and_separators() {
        assert_eq!(
            data_store_id(Path::new(r"E:\Project\.local-data")),
            data_store_id(Path::new("e:/project/.local-data"))
        );
        assert_eq!(data_store_id(Path::new("e:/project/.local-data")).len(), 16);
    }

    #[test]
    fn status_page_escapes_untrusted_text() {
        let url = status_page("<title>", "x & y", None);
        let text = url.as_str();
        assert!(!text.contains("<title>"));
        assert!(text.starts_with("data:text/html"));
    }

    #[test]
    fn startup_and_recovery_pages_leave_navigation_to_validated_native_health() {
        for url in [startup_page(STARTUP_HINT_DELAY), status_page("恢复", "错误", None)] {
            assert!(!url.as_str().contains("zz-mark.svg"));
            assert!(!url.as_str().contains("%3Cscript"));
        }
    }

    #[test]
    fn portable_release_infers_the_repository_root_without_embedding_it() {
        assert_eq!(
            infer_project_root(Path::new(
                r"E:\work\zz-board\src-tauri\target\release\zz-board.exe"
            )),
            PathBuf::from(r"E:\work\zz-board")
        );
        assert_eq!(
            infer_project_root(Path::new(r"E:\portable\ZZ Board.exe")),
            PathBuf::from(r"E:\portable")
        );
    }
    #[test]
    fn waiting_shows_one_delayed_line_and_only_failures_offer_a_report() {
        let waiting = startup_page(STARTUP_HINT_DELAY);
        assert!(waiting.as_str().contains("2000ms"));
        assert!(waiting.as_str().contains(&percent_encode("正在打开看板…")));
        assert!(!waiting.as_str().contains("textarea"));
        assert!(!waiting.as_str().contains("phase"));
        let problem = status_page("启动失败", "private path <local>", None);
        assert!(problem.as_str().contains("textarea"));
        assert!(problem.as_str().contains(&percent_encode("private path &lt;local&gt;")));
        assert_eq!(safe_feedback_report(), format!("ZZ Board v{APP_VERSION}\nplatform: windows\nphase: desktop_startup_unavailable"));
    }

    #[test]
    fn slow_start_observes_quit_and_restart_before_another_health_probe_or_spawn() {
        let paths = Paths { data_dir: PathBuf::new(), project_root: PathBuf::new(), runtime_dir: PathBuf::new(), log_path: PathBuf::new(), trial: None };
        let (tx, rx) = std::sync::mpsc::channel();
        let (ack, done) = std::sync::mpsc::channel();
        tx.send(Control::Quit(ack)).unwrap();
        assert_eq!(wait_until_ready(&rx, &mut None, &paths, "fixture"), StartWait::Quit);
        assert!(done.try_recv().is_ok());
        tx.send(Control::Restart).unwrap();
        assert_eq!(wait_until_ready(&rx, &mut None, &paths, "fixture"), StartWait::Restart);
    }
}
