//! Open Rock desktop shell.
//!
//! The UI is the same React app as the website. On launch we start the bundled Open Rock server
//! (a sidecar binary built from ../server) on a free localhost port with a random access token,
//! and hand both to the UI through the `backend_info` command. The server holds the Bedrock API
//! key and talks to Bedrock and the dedicated servers; the webview never sees those secrets.

use std::net::TcpListener;
use std::sync::Mutex;

use tauri::{Manager, RunEvent};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

struct Backend {
    url: String,
    token: String,
    child: Mutex<Option<CommandChild>>,
}

#[derive(serde::Serialize)]
struct BackendInfo {
    url: String,
    token: String,
}

#[tauri::command]
fn backend_info(state: tauri::State<'_, Backend>) -> BackendInfo {
    BackendInfo {
        url: state.url.clone(),
        token: state.token.clone(),
    }
}

fn free_port() -> std::io::Result<u16> {
    let listener = TcpListener::bind("127.0.0.1:0")?;
    Ok(listener.local_addr()?.port())
}

fn random_token() -> String {
    let mut bytes = [0u8; 32];
    getrandom::getrandom(&mut bytes).expect("OS random number generator unavailable");
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let port = free_port()?;
            let token = random_token();
            let data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data_dir)?;

            let command = app
                .shell()
                .sidecar("open-rock-server")?
                .env("OPEN_ROCK_HOST", "127.0.0.1")
                .env("OPEN_ROCK_PORT", port.to_string())
                .env("OPEN_ROCK_AUTH_TOKEN", &token)
                .env("OPEN_ROCK_DATA_DIR", data_dir.to_string_lossy().to_string())
                .env("OPEN_ROCK_PARENT_PID", std::process::id().to_string());

            let (mut events, child) = command.spawn()?;
            tauri::async_runtime::spawn(async move {
                while let Some(event) = events.recv().await {
                    match event {
                        CommandEvent::Stdout(line) => println!("[server] {}", String::from_utf8_lossy(&line).trim_end()),
                        CommandEvent::Stderr(line) => eprintln!("[server] {}", String::from_utf8_lossy(&line).trim_end()),
                        CommandEvent::Error(err) => eprintln!("[server] error: {err}"),
                        CommandEvent::Terminated(status) => {
                            eprintln!("[server] exited with {:?}", status.code);
                            break;
                        }
                        _ => {}
                    }
                }
            });

            app.manage(Backend {
                url: format!("http://127.0.0.1:{port}"),
                token,
                child: Mutex::new(Some(child)),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![backend_info])
        .build(tauri::generate_context!())
        .expect("error while starting Open Rock")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                if let Some(state) = app.try_state::<Backend>() {
                    if let Some(child) = state.child.lock().ok().and_then(|mut c| c.take()) {
                        let _ = child.kill();
                    }
                }
            }
        });
}
