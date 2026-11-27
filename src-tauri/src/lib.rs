mod runtime;
mod trial_diagnostics;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::Arc;
use std::time::{Duration, Instant};

use runtime::DesktopRuntime;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use trial_diagnostics::TrialDiagnostics;

const MAIN_WINDOW: &str = "main";

pub fn run() {
    let quitting = Arc::new(AtomicBool::new(false));
    let quitting_for_setup = Arc::clone(&quitting);
    let quitting_for_window = Arc::clone(&quitting);

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_main_window(app);
        }))
        .setup(move |app| {
            let background = std::env::args_os().any(|arg| arg == "--background");
            let hint_at = Instant::now() + runtime::STARTUP_HINT_DELAY;
            let paths = runtime::resolve_paths(app.handle());
            let trial = paths.as_ref().ok().and_then(|paths| paths.trial.clone());
            if let Some(trial) = &trial {
                app.manage(Arc::clone(trial));
                trial.record("app_start", "start");
            }
            let initial_service = paths.as_ref().ok().map(|paths| runtime::prepare_initial_service(paths, hint_at));
            let initial_ready = initial_service
                .as_ref()
                .is_some_and(runtime::InitialService::is_ready);
            let data_directory = paths
                .as_ref()
                .map(|paths| paths.data_dir.clone())
                .unwrap_or_else(|_| runtime::fallback_data_dir())
                .join("webview");
            let startup_url = match (&paths, initial_ready) {
                (Ok(_), true) => runtime::board_url(),
                (Ok(_), false) => runtime::startup_page(hint_at.saturating_duration_since(Instant::now())),
                (Err(error), _) => runtime::status_page("桌面配置不可用", error, None),
            };
            let mut window =
                WebviewWindowBuilder::new(app, MAIN_WINDOW, WebviewUrl::External(startup_url))
                    .initialization_script(include_str!("desktop-bootstrap.js"));
            if let Some(trial) = &trial {
                let on_load = Arc::clone(trial);
                window = window.initialization_script(trial.initialization_script()).on_page_load(move |window, _| {
                    on_load.report_failure(window.app_handle());
                });
            }
            let window = window
                    .title("ZZ Board")
                    .inner_size(1280.0, 820.0)
                    .min_inner_size(860.0, 600.0)
                    // Windowed maximization only at creation. Tray restore must
                    // preserve a size the user subsequently chose.
                    .maximized(true)
                    .data_directory(data_directory)
                    .visible(!background)
                    .build();
            trace(app.handle(), "window_ready", if window.is_ok() { "ok" } else { "failed" });
            let window = window?;

            let (control_tx, control_rx) = mpsc::channel();
            app.manage(DesktopRuntime::new(control_tx));
            build_tray(app.handle(), Arc::clone(&quitting_for_setup))?;

            if let (Ok(paths), Some(initial_service)) = (paths, initial_service) {
                let app_handle = app.handle().clone();
                std::thread::Builder::new()
                    .name("zz-board-sidecar-supervisor".into())
                    .spawn(move || {
                        runtime::supervise(app_handle, control_rx, paths, initial_service)
                    })?;
            }

            if background {
                let outcome = if window.hide().is_ok() { "ok" } else { "failed" };
                trace(app.handle(), "window_hide", outcome);
            }
            Ok(())
        })
        .on_window_event(move |window, event| {
            if window.label() != MAIN_WINDOW || quitting_for_window.load(Ordering::SeqCst) {
                return;
            }
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let outcome = if window.hide().is_ok() { "ok" } else { "failed" };
                trace(window.app_handle(), "window_hide", outcome);
            }
        })
        .run(tauri::generate_context!())
        .expect("failed to run ZZ Board desktop runtime");
}

fn build_tray(app: &AppHandle, quitting: Arc<AtomicBool>) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "打开看板", true, None::<&str>)?;
    let restart = MenuItem::with_id(app, "restart", "重启本地服务", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "真正退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &restart, &quit])?;
    let icon = tray_icon();

    TrayIconBuilder::new()
        .icon(icon)
        .tooltip("ZZ Board")
        .menu(&menu)
        .on_menu_event(move |app, event| match event.id.as_ref() {
            "open" => {
                trace(app, "tray_open", "start");
                show_main_window(app);
            }
            "restart" => {
                trace(app, "tray_restart", "start");
                if let Some(runtime) = app.try_state::<DesktopRuntime>() {
                    runtime.restart();
                }
                show_main_window(app);
            }
            "quit" => {
                quitting.store(true, Ordering::SeqCst);
                trace(app, "tray_quit", "start");
                let stopped = app.try_state::<DesktopRuntime>().is_some_and(|runtime| runtime.quit(Duration::from_secs(3)));
                trace(app, "tray_quit", if stopped { "ok" } else { "failed" });
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if matches!(
                event,
                TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                }
            ) {
                trace(tray.app_handle(), "tray_open", "start");
                show_main_window(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}

fn trace(app: &AppHandle, event: &'static str, outcome: &'static str) {
    if let Some(trial) = app.try_state::<Arc<TrialDiagnostics>>() {
        trial.record(event, outcome);
        trial.report_failure(app);
    }
}

fn show_main_window(app: &AppHandle) {
    let outcome = if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
        let shown = window.show().is_ok();
        let restored = window.unminimize().is_ok();
        let _ = window.set_focus();
        if shown && restored { "ok" } else { "failed" }
    } else {
        "failed"
    };
    trace(app, "window_show", outcome);
}

fn tray_icon() -> tauri::image::Image<'static> {
    const SIZE: usize = 32;
    let mut rgba = vec![0_u8; SIZE * SIZE * 4];
    for y in 0..SIZE {
        for x in 0..SIZE {
            let index = (y * SIZE + x) * 4;
            let dx = x as f32 - 15.5;
            let dy = y as f32 - 15.5;
            let distance = (dx * dx + dy * dy).sqrt();
            if distance <= 14.0 {
                rgba[index] = 42;
                rgba[index + 1] = 52;
                rgba[index + 2] = 50;
                rgba[index + 3] = 255;
            }
            if (9..=21).contains(&x) && (10..=13).contains(&y)
                || (9..=21).contains(&x) && (19..=22).contains(&y)
                || (18..=21).contains(&x) && (10..=22).contains(&y)
            {
                rgba[index] = 234;
                rgba[index + 1] = 223;
                rgba[index + 2] = 185;
                rgba[index + 3] = 255;
            }
        }
    }
    tauri::image::Image::new_owned(rgba, SIZE as u32, SIZE as u32)
}
