#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! Desktop shell for Loop Studio.
//!
//! The app itself is a Next.js server. This shell's whole job is to run that
//! server privately and put a native window in front of it:
//!
//!   1. grab a free loopback port (the app has no auth — it must never listen
//!      anywhere else)
//!   2. apply pending database migrations, as a separate process that exits
//!      (PGlite allows a single connection, so migrating and serving can't
//!      overlap)
//!   3. start the server, wait until the port answers
//!   4. open the window on it, and kill the server when the window closes

use std::net::{Ipv4Addr, SocketAddrV4, TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tauri::{Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};
use tauri_plugin_shell::process::CommandChild;
use tauri_plugin_shell::ShellExt;

/// How long to wait for the server to answer before giving up.
const READY_TIMEOUT: Duration = Duration::from_secs(60);

/// Asks the OS for an unused port by binding to :0 and reading it back.
///
/// There is a race between releasing the listener and the server binding, but
/// it is the standard trick and the window is a beat behind either way.
fn free_port() -> u16 {
    TcpListener::bind(SocketAddrV4::new(Ipv4Addr::LOCALHOST, 0))
        .and_then(|l| l.local_addr())
        .map(|a| a.port())
        .unwrap_or(43117)
}

fn port_answers(port: u16) -> bool {
    TcpStream::connect_timeout(
        &SocketAddrV4::new(Ipv4Addr::LOCALHOST, port).into(),
        Duration::from_millis(300),
    )
    .is_ok()
}

/// Directories a GUI-launched app is missing from PATH.
///
/// macOS starts .app bundles with a bare `/usr/bin:/bin:/usr/sbin:/sbin`, so
/// the user's `claude` or `cursor-agent` is invisible. The server also probes
/// the login shell, but seeding the common locations avoids that round trip.
fn augmented_path(home: &str) -> String {
    let existing = std::env::var("PATH").unwrap_or_default();
    let extra = [
        format!("{home}/.local/bin"),
        format!("{home}/.bun/bin"),
        format!("{home}/.cargo/bin"),
        format!("{home}/.npm-global/bin"),
        "/opt/homebrew/bin".to_string(),
        "/usr/local/bin".to_string(),
    ];
    let mut parts: Vec<String> = extra.to_vec();
    parts.push(existing);
    parts.join(":")
}

struct ServerEnv {
    app_dir: PathBuf,
    data_dir: PathBuf,
    port: u16,
    path: String,
}

impl ServerEnv {
    fn vars(&self) -> Vec<(String, String)> {
        let app = self.app_dir.to_string_lossy().to_string();
        vec![
            ("LOOP_DATA_DIR".into(), self.data_dir.to_string_lossy().to_string()),
            ("LOOP_MIGRATIONS_DIR".into(), format!("{app}/drizzle")),
            ("LOOP_SAMPLER_SCRIPT".into(), format!("{app}/scripts/sample-personas.mjs")),
            ("PERSONA_DB_PATH".into(), format!("{app}/data/personas.db")),
            ("HOSTNAME".into(), "127.0.0.1".into()),
            ("PORT".into(), self.port.to_string()),
            ("NODE_ENV".into(), "production".into()),
            ("PATH".into(), self.path.clone()),
        ]
    }
}

/// Migrates, starts the server, waits for it, then opens the window.
///
/// Runs off the main thread — see the note in `setup`.
fn start_backend(handle: &tauri::AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let resource_dir = handle.path().resource_dir()?;
    let app_dir = resource_dir.join("app");

    // The Node runtime lives under Resources, NOT Contents/MacOS.
    //
    // Tauri's `externalBin` sidecar mechanism puts binaries in Contents/MacOS,
    // and LaunchServices treats any executable there as an app of its own: the
    // bundled Node showed up in the Dock as a separate "exec" tile. From
    // Resources it is just a file we execute.
    let node = resource_dir.join("bin/node");
    // Resource copying does not preserve the executable bit.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = std::fs::metadata(&node)?.permissions();
        if perms.mode() & 0o111 == 0 {
            perms.set_mode(0o755);
            std::fs::set_permissions(&node, perms)?;
        }
    }
    let data_dir = handle.path().app_data_dir()?;
    std::fs::create_dir_all(&data_dir)?;

    let home = handle
        .path()
        .home_dir()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();

    let env = ServerEnv {
        app_dir: app_dir.clone(),
        data_dir,
        port: free_port(),
        path: augmented_path(&home),
    };
    let vars: std::collections::HashMap<_, _> = env.vars().into_iter().collect();

    // 1. Migrate, and wait for it to finish before anything opens the database
    //    for serving (PGlite allows a single connection).
    let migrate = tauri::async_runtime::block_on(
        handle
            .shell()
            .command(node.to_string_lossy().to_string())
            .args([app_dir.join("scripts/db-migrate.mjs").to_string_lossy().to_string()])
            .envs(vars.clone())
            .output(),
    )?;
    if !migrate.status.success() {
        return Err(format!(
            "데이터베이스 준비에 실패했습니다: {}",
            String::from_utf8_lossy(&migrate.stderr)
        )
        .into());
    }

    // 2. Serve.
    let (_rx, child) = handle
        .shell()
        .command(node.to_string_lossy().to_string())
        .args([app_dir.join("server.js").to_string_lossy().to_string()])
        .envs(vars)
        .spawn()?;
    handle.manage(ServerHandle(Arc::new(Mutex::new(Some(child)))));

    // 3. Wait for the port, then open the window.
    let started = Instant::now();
    while !port_answers(env.port) {
        if started.elapsed() > READY_TIMEOUT {
            return Err("서버가 제한 시간 안에 시작되지 않았습니다.".into());
        }
        std::thread::sleep(Duration::from_millis(150));
    }

    let url = format!("http://127.0.0.1:{}/dashboard", env.port);
    WebviewWindowBuilder::new(handle, "main", WebviewUrl::External(url.parse()?))
        .title("Loop Studio")
        .inner_size(1280.0, 860.0)
        .min_inner_size(900.0, 600.0)
        .build()?;

    Ok(())
}

fn main() {
    tauri::Builder::default()
        // One instance per machine. Without this, opening the app while it is
        // already running spawns a second process that can never get anywhere:
        // the data directory is already claimed (see src/db/lock.ts), so its
        // server never comes up and it sits there with no window — which reads
        // as "the app is broken". Re-launching now just focuses what's open.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            let handle = app.handle().clone();

            // Everything slow happens on a worker thread.
            //
            // The first version did this inline: migrate, start the server,
            // then sleep-poll the port before building the window. That blocks
            // the main thread through setup, so the event loop never starts
            // pumping — and on a loaded machine the app ended up with WebKit
            // children but no window-server connection at all (cgsConnection
            // NULL, zero windows). Keep setup instant; report progress by
            // opening the window and letting it load when the server answers.
            std::thread::spawn(move || {
                if let Err(e) = start_backend(&handle) {
                    eprintln!("[loop-studio] 백엔드 기동 실패: {e}");
                    // Surface it instead of sitting there windowless.
                    handle.dialog()
                        .message(format!("앱을 시작할 수 없습니다.\n\n{e}"))
                        .kind(MessageDialogKind::Error)
                        .title("Loop Studio")
                        .blocking_show();
                    handle.exit(1);
                }
            });

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to start Loop Studio")
        .run(|app, event| {
            // The server is a child process, not a daemon: it goes when we go.
            if let RunEvent::Exit = event {
                if let Some(handle) = app.try_state::<ServerHandle>() {
                    if let Some(child) = handle.0.lock().unwrap().take() {
                        let _ = child.kill();
                    }
                }
            }
        });
}

struct ServerHandle(Arc<Mutex<Option<CommandChild>>>);
