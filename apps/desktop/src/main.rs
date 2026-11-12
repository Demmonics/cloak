#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

mod capture;
mod native_shell;
mod server;

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;
use std::sync::atomic::AtomicU16;
use std::time::Instant;

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use cloak_p2p::P2pNode;
use rand::RngCore;
use rand::rngs::OsRng;
use tokio::net::TcpListener;
use tracing_subscriber::EnvFilter;

use crate::server::{DesktopState, build_router};

struct CliOptions {
    data_dir: PathBuf,
    p2p_bind: String,
    http_port: u16,
    display_name: String,
    api_token: Option<String>,
    api_token_file: Option<PathBuf>,
    autoclose_ms: Option<u64>,
    headless: bool,
    edge_app: bool,
}

fn default_data_dir() -> PathBuf {
    if let Some(local_app_data) = std::env::var_os("LOCALAPPDATA") {
        return PathBuf::from(local_app_data).join("CloakDesktop");
    }
    if let Some(home) = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")) {
        return PathBuf::from(home).join(".cloak-desktop");
    }
    PathBuf::from(".cloak-desktop")
}

fn generate_session_token() -> String {
    let mut raw = [0u8; 32];
    OsRng.fill_bytes(&mut raw);
    URL_SAFE_NO_PAD.encode(raw)
}

fn parse_args() -> CliOptions {
    let mut opts = CliOptions {
        data_dir: default_data_dir(),
        p2p_bind: "0.0.0.0:0".to_string(),
        http_port: 0,
        display_name: "Cloak Desktop".to_string(),
        api_token: None,
        api_token_file: None,
        autoclose_ms: None,
        headless: false,
        edge_app: false,
    };

    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--data-dir" => {
                if let Some(val) = args.next() {
                    opts.data_dir = PathBuf::from(val);
                }
            }
            "--p2p-bind" => {
                if let Some(val) = args.next() {
                    opts.p2p_bind = val;
                }
            }
            "--http-port" => {
                if let Some(val) = args.next()
                    && let Ok(p) = val.parse()
                {
                    opts.http_port = p;
                }
            }
            "--name" => {
                if let Some(val) = args.next() {
                    opts.display_name = val;
                }
            }
            "--api-token" => {
                if let Some(val) = args.next() {
                    opts.api_token = Some(val);
                }
            }
            "--api-token-file" => {
                if let Some(val) = args.next() {
                    opts.api_token_file = Some(PathBuf::from(val));
                }
            }
            "--autoclose-ms" => {
                if let Some(val) = args.next()
                    && let Ok(ms) = val.parse()
                {
                    opts.autoclose_ms = Some(ms);
                }
            }
            "--headless" => opts.headless = true,
            "--edge-app" => opts.edge_app = true,
            _ => {}
        }
    }
    opts
}

fn launch_edge_app_fallback(url: &str, data_dir: &Path) -> Option<std::process::Child> {
    let webview_profile = data_dir.join("webview-profile");
    let _ = std::fs::create_dir_all(&webview_profile);

    #[cfg(target_os = "windows")]
    {
        let candidates = [
            r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
            r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
        ];
        for exe in candidates {
            if Path::new(exe).exists()
                && let Ok(child) = Command::new(exe)
                    .arg(format!("--app={url}"))
                    .arg(format!("--user-data-dir={}", webview_profile.display()))
                    .arg("--new-window")
                    .arg("--no-first-run")
                    .spawn()
            {
                return Some(child);
            }
        }
        let _ = Command::new("cmd").args(["/c", "start", "", url]).spawn();
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = Command::new("xdg-open").arg(url).spawn();
    }

    None
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let boot_start = Instant::now();
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .init();

    let opts = parse_args();
    let session_token = opts
        .api_token
        .clone()
        .filter(|t| !t.trim().is_empty())
        .unwrap_or_else(generate_session_token);

    if let Some(tok_file) = &opts.api_token_file {
        if let Some(parent) = tok_file.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        std::fs::write(tok_file, &session_token)?;
    }

    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?;

    let (node, p2p_addr, http_addr, server_handle) = rt.block_on(async {
        let node = P2pNode::start(&opts.data_dir, &opts.p2p_bind, &opts.display_name).await?;
        let p2p_addr = node.local_addr();

        let http_listener = TcpListener::bind(("127.0.0.1", opts.http_port)).await?;
        let http_addr = http_listener.local_addr()?;

        let app = build_router(DesktopState {
            node: node.clone(),
            data_dir: opts.data_dir.clone(),
            session_token: session_token.clone(),
            expected_http_port: Arc::new(AtomicU16::new(http_addr.port())),
        });

        let server_handle = tokio::spawn(async move {
            let _ = axum::serve(http_listener, app).await;
        });

        Ok::<_, Box<dyn std::error::Error>>((node, p2p_addr, http_addr, server_handle))
    })?;

    let app_url = format!("http://{http_addr}/p2p");
    let startup_ms = boot_start.elapsed().as_secs_f64() * 1000.0;
    println!(
        "cloak-desktop ready in {startup_ms:.1} ms | ui={app_url} | p2p={p2p_addr} | vault={}",
        opts.data_dir.display()
    );

    if opts.headless {
        println!("cloak-desktop-token={session_token}");
        rt.block_on(async {
            if let Some(ms) = opts.autoclose_ms {
                tokio::time::sleep(std::time::Duration::from_millis(ms)).await;
            } else {
                let _ = tokio::signal::ctrl_c().await;
            }
        });
    } else if !opts.edge_app && cfg!(target_os = "windows") {
        // Primary native embedded WebView2 desktop shell (tao EventLoop MUST own the main OS thread!)
        if let Err(err) = native_shell::run_native_window(
            &app_url,
            &opts.data_dir,
            &session_token,
            node.clone(),
            opts.autoclose_ms,
            boot_start,
        ) {
            tracing::warn!(?err, "Native WebView2 shell failed; falling back cleanly");
            let url_with_tok = format!("{app_url}#cloakToken={session_token}");
            if let Some(mut child) = launch_edge_app_fallback(&url_with_tok, &opts.data_dir) {
                let _ = child.wait();
            }
        }
    } else {
        let url_with_tok = format!("{app_url}#cloakToken={session_token}");
        if let Some(mut child) = launch_edge_app_fallback(&url_with_tok, &opts.data_dir) {
            let _ = child.wait();
        } else {
            rt.block_on(async {
                let _ = tokio::signal::ctrl_c().await;
            });
        }
    }

    node.shutdown();
    server_handle.abort();
    Ok(())
}
