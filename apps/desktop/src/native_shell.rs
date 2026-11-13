#[cfg(target_os = "windows")]
mod imp {
    use std::path::Path;
    use std::sync::atomic::{AtomicIsize, Ordering};
    use std::sync::{Arc, OnceLock};
    use std::time::{Duration, Instant};

    use cloak_p2p::{
        ActiveSurface, GhostTriggerKind, NodeEvent, P2pNode, PrivacyTriggerKind,
        StealthBootstrapState,
    };
    use tao::dpi::LogicalSize;
    use tao::event::{Event, WindowEvent};
    use tao::event_loop::{ControlFlow, EventLoopBuilder, EventLoopProxy};
    use tao::platform::windows::WindowExtWindows;
    use tao::window::{Icon as WindowIcon, WindowBuilder};
    use tray_icon::menu::{Menu, MenuEvent, MenuItem};
    use tray_icon::{Icon as TrayIconImage, TrayIconBuilder};
    use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
    use windows_sys::Win32::System::RemoteDesktop::{
        NOTIFY_FOR_THIS_SESSION, WTSRegisterSessionNotification, WTSUnRegisterSessionNotification,
    };
    use windows_sys::Win32::System::Threading::GetCurrentProcessId;
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        CallWindowProcW, GWLP_WNDPROC, GetForegroundWindow, GetWindowThreadProcessId,
        SetWindowDisplayAffinity, SetWindowLongPtrW, WM_ACTIVATEAPP, WM_WTSSESSION_CHANGE,
    };
    use wry::{WebContext, WebViewBuilder};

    const WDA_NONE: u32 = 0x0000_0000;
    const WDA_EXCLUDEFROMCAPTURE: u32 = 0x0000_0011;
    const WTS_SESSION_LOCK: usize = 0x7;
    const WTS_SESSION_UNLOCK: usize = 0x8;
    const WM_POWERBROADCAST: u32 = 0x0218;
    const PBT_APMRESUMEAUTOMATIC: usize = 0x0012;
    const PBT_APMRESUMESUSPEND: usize = 0x0007;

    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetTickCount() -> u32;
    }

    static PREV_WNDPROC: AtomicIsize = AtomicIsize::new(0);
    static GLOBAL_PROXY: OnceLock<EventLoopProxy<ShellUserEvent>> = OnceLock::new();

    #[derive(Debug, Clone)]
    enum ShellUserEvent {
        AppActivated,
        AppDeactivated,
        SessionLocked,
        SessionUnlocked,
        PowerResume,
        CaptureProtection(bool),
        StealthUpdated(Box<StealthBootstrapState>),
        SyncAuthoritativeTitle,
        TrayShow,
        TraySwitchPdf,
        TrayLockNow,
        TrayQuit,
        ShutdownExit,
    }

    unsafe extern "system" fn cloak_wnd_subclass(
        hwnd: HWND,
        msg: u32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT {
        if let Some(proxy) = GLOBAL_PROXY.get() {
            if msg == WM_ACTIVATEAPP {
                if wparam == 0 {
                    let _ = proxy.send_event(ShellUserEvent::AppDeactivated);
                } else {
                    let _ = proxy.send_event(ShellUserEvent::AppActivated);
                }
            } else if msg == WM_WTSSESSION_CHANGE {
                if wparam == WTS_SESSION_LOCK {
                    let _ = proxy.send_event(ShellUserEvent::SessionLocked);
                } else if wparam == WTS_SESSION_UNLOCK {
                    let _ = proxy.send_event(ShellUserEvent::SessionUnlocked);
                }
            } else if msg == WM_POWERBROADCAST
                && (wparam == PBT_APMRESUMEAUTOMATIC || wparam == PBT_APMRESUMESUSPEND)
            {
                let _ = proxy.send_event(ShellUserEvent::PowerResume);
            }
        }
        let prev = PREV_WNDPROC.load(Ordering::Acquire);
        if prev != 0 {
            let proc_fn: unsafe extern "system" fn(HWND, u32, WPARAM, LPARAM) -> LRESULT =
                unsafe { std::mem::transmute(prev) };
            unsafe { CallWindowProcW(Some(proc_fn), hwnd, msg, wparam, lparam) }
        } else {
            0
        }
    }

    fn cloak_rgba_32x32() -> Vec<u8> {
        let mut rgba = vec![0u8; 32 * 32 * 4];
        for py in 0..32 {
            for px in 0..32 {
                let dx = (px as f32 - 15.5) / 15.5;
                let dy = (py as f32 - 15.5) / 15.5;
                let idx = (py * 32 + px) * 4;
                if dx.abs().max(dy.abs()) > 0.94 {
                    continue;
                }
                let in_shield = dx.abs() < 0.56
                    && dy > -0.58
                    && (dy < 0.18 || (dy - 0.18) * 1.15 + dx.abs() < 0.56);
                let in_visor = in_shield && dy > -0.22 && dy < 0.04 && dx.abs() < 0.32;
                let (r, g, b) = if in_visor {
                    (14, 165, 233)
                } else if in_shield {
                    (45, 212, 191)
                } else {
                    (13, 17, 23)
                };
                rgba[idx] = r;
                rgba[idx + 1] = g;
                rgba[idx + 2] = b;
                rgba[idx + 3] = 255;
            }
        }
        rgba
    }

    /// Launches the real native Win32/WebView2 desktop shell backed directly by `P2pNode`.
    pub fn run_native_window(
        url: &str,
        data_dir: &Path,
        session_token: &str,
        node: P2pNode,
        autoclose_ms: Option<u64>,
        boot_start: Instant,
    ) -> Result<(), Box<dyn std::error::Error>> {
        let event_loop = EventLoopBuilder::<ShellUserEvent>::with_user_event().build();
        let proxy = event_loop.create_proxy();
        let _ = GLOBAL_PROXY.set(proxy.clone());

        let rgba = cloak_rgba_32x32();
        let win_icon = WindowIcon::from_rgba(rgba.clone(), 32, 32).ok();
        let tray_img = TrayIconImage::from_rgba(rgba, 32, 32).ok();

        let initial_stealth = node.get_stealth_bootstrap();
        let window = Arc::new(
            WindowBuilder::new()
                .with_title(&initial_stealth.window_title)
                .with_inner_size(LogicalSize::new(1280.0, 820.0))
                .with_min_inner_size(LogicalSize::new(720.0, 560.0))
                .with_window_icon(win_icon)
                .build(&event_loop)?,
        );

        let hwnd = window.hwnd() as HWND;
        unsafe {
            let _ = WTSRegisterSessionNotification(hwnd, NOTIFY_FOR_THIS_SESSION);
            let prev =
                SetWindowLongPtrW(hwnd, GWLP_WNDPROC, cloak_wnd_subclass as *const () as isize);
            PREV_WNDPROC.store(prev, Ordering::Release);
            if node
                .get_ghost_policy()
                .map(|p| p.capture_protection)
                .unwrap_or(false)
            {
                let _ = SetWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE);
            }
        }

        let webview_dir = data_dir.join("webview2");
        let _ = std::fs::create_dir_all(&webview_dir);
        let mut web_context = WebContext::new(Some(webview_dir));

        let token_escaped = serde_json::to_string(session_token)?;
        let init_js = format!(
            "window.__CLOAK_SESSION_TOKEN__ = {token_escaped}; window.__CLOAK_NATIVE_SHELL__ = true;"
        );

        let doc_title_proxy = proxy.clone();
        let mut webview = Some(
            WebViewBuilder::with_web_context(&mut web_context)
                .with_url(url)
                .with_initialization_script(&init_js)
                .with_document_title_changed_handler(move |_title| {
                    let _ = doc_title_proxy.send_event(ShellUserEvent::SyncAuthoritativeTitle);
                })
                .with_devtools(cfg!(debug_assertions))
                .build(&window)?,
        );

        // Native Windows System Tray Icon + Menu (neutral presentation when Stealth enabled)
        let tray_menu = Menu::new();
        let item_show = MenuItem::new("Show Application", true, None);
        let item_pdf = MenuItem::new("Switch to PDF Reader", true, None);
        let item_lock = MenuItem::new("Privacy Lock Now", true, None);
        let item_quit = MenuItem::new("Quit", true, None);
        let id_show = item_show.id().clone();
        let id_pdf = item_pdf.id().clone();
        let id_lock = item_lock.id().clone();
        let id_quit = item_quit.id().clone();
        let _ = tray_menu.append_items(&[&item_show, &item_pdf, &item_lock, &item_quit]);

        let tray_tooltip = if initial_stealth.stealth_enabled {
            initial_stealth.window_title.as_str()
        } else {
            "Cloak — Encrypted Local-First P2P"
        };
        let tray_icon = tray_img.and_then(|icon| {
            TrayIconBuilder::new()
                .with_menu(Box::new(tray_menu))
                .with_tooltip(tray_tooltip)
                .with_icon(icon)
                .build()
                .ok()
        });

        let tray_proxy = proxy.clone();
        MenuEvent::set_event_handler(Some(move |ev: MenuEvent| {
            if ev.id == id_show {
                let _ = tray_proxy.send_event(ShellUserEvent::TrayShow);
            } else if ev.id == id_pdf {
                let _ = tray_proxy.send_event(ShellUserEvent::TraySwitchPdf);
            } else if ev.id == id_lock {
                let _ = tray_proxy.send_event(ShellUserEvent::TrayLockNow);
            } else if ev.id == id_quit {
                let _ = tray_proxy.send_event(ShellUserEvent::TrayQuit);
            }
        }));

        // Propagate Rust P2pNode Ghost & Stealth state changes directly onto HWND / window title
        let mut rx = node.subscribe();
        let cap_proxy = proxy.clone();
        let sync_node = node.clone();
        std::thread::spawn(move || {
            loop {
                match rx.blocking_recv() {
                    Ok(NodeEvent::GhostStateChanged(st)) => {
                        let _ = cap_proxy.send_event(ShellUserEvent::CaptureProtection(
                            st.capture_protection_active,
                        ));
                    }
                    Ok(NodeEvent::StealthStateChanged(boot)) => {
                        let _ =
                            cap_proxy.send_event(ShellUserEvent::StealthUpdated(Box::new(boot)));
                    }
                    Ok(_) => {}
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                        let boot = sync_node.get_stealth_bootstrap();
                        let _ =
                            cap_proxy.send_event(ShellUserEvent::StealthUpdated(Box::new(boot)));
                        let st = sync_node.get_ghost_state();
                        let _ = cap_proxy.send_event(ShellUserEvent::CaptureProtection(
                            st.capture_protection_active,
                        ));
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                }
            }
        });

        // Windows GetLastInputInfo sampler for OS-wide system idle (distinct from app foreground idle!)
        let idle_node = node.clone();
        std::thread::spawn(move || {
            loop {
                std::thread::sleep(Duration::from_secs(2));
                unsafe {
                    let mut lii = LASTINPUTINFO {
                        cbSize: std::mem::size_of::<LASTINPUTINFO>() as u32,
                        dwTime: 0,
                    };
                    if GetLastInputInfo(&mut lii) != 0 {
                        let now_tick = GetTickCount();
                        let idle_ms = now_tick.wrapping_sub(lii.dwTime) as u64;
                        let _ = idle_node.stealth().report_system_idle_ms(idle_ms);
                    }
                }
            }
        });

        if let Some(ms) = autoclose_ms {
            let exit_proxy = proxy;
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_millis(ms));
                let _ = exit_proxy.send_event(ShellUserEvent::ShutdownExit);
            });
        }

        let gui_ready_ms = boot_start.elapsed().as_secs_f64() * 1000.0;
        tracing::info!(gui_ready_ms, "Native WebView2 desktop shell initialized");
        println!("cloak-desktop native-gui ready in {gui_ready_ms:.1} ms");

        let mut was_minimized = false;
        let current_pid = unsafe { GetCurrentProcessId() };

        event_loop.run(move |event, _, control_flow| {
            *control_flow = ControlFlow::Wait;
            match event {
                Event::WindowEvent {
                    event: WindowEvent::CloseRequested,
                    ..
                }
                | Event::UserEvent(ShellUserEvent::TrayQuit)
                | Event::UserEvent(ShellUserEvent::ShutdownExit) => {
                    let _ = node.handle_ghost_trigger(GhostTriggerKind::AppClose);
                    unsafe {
                        let _ = WTSUnRegisterSessionNotification(hwnd);
                    }
                    // Explicitly drop WebView2 COM object cleanly before closing HWND
                    let _ = webview.take();
                    *control_flow = ControlFlow::Exit;
                }
                Event::WindowEvent {
                    event: WindowEvent::Focused(false),
                    ..
                } => {
                    // Check whether focus stayed within our own process (e.g., native file dialog / modal)
                    let fg_hwnd = unsafe { GetForegroundWindow() };
                    let mut fg_pid = 0u32;
                    if !fg_hwnd.is_null() {
                        unsafe { GetWindowThreadProcessId(fg_hwnd, &mut fg_pid) };
                    }
                    if fg_pid != current_pid && !window.is_minimized() {
                        let _ = node.handle_ghost_trigger(GhostTriggerKind::ExternalFocusLoss);
                    }
                }
                Event::WindowEvent {
                    event: WindowEvent::Focused(true),
                    ..
                } => {
                    if !window.is_minimized() {
                        let _ = node.handle_ghost_trigger(GhostTriggerKind::RestoreFocus);
                    }
                }
                Event::WindowEvent {
                    event: WindowEvent::Resized(_),
                    ..
                } => {
                    let min_now = window.is_minimized();
                    if min_now && !was_minimized {
                        let _ = node.handle_ghost_trigger(GhostTriggerKind::Minimize);
                    } else if !min_now && was_minimized && window.is_focused() {
                        let _ = node.handle_ghost_trigger(GhostTriggerKind::RestoreFocus);
                    }
                    was_minimized = min_now;
                }
                Event::UserEvent(ShellUserEvent::AppDeactivated) => {
                    if !window.is_minimized() {
                        let _ = node.handle_ghost_trigger(GhostTriggerKind::ExternalFocusLoss);
                    }
                }
                Event::UserEvent(ShellUserEvent::AppActivated) => {
                    if !window.is_minimized() {
                        let _ = node.handle_ghost_trigger(GhostTriggerKind::RestoreFocus);
                    }
                }
                Event::UserEvent(ShellUserEvent::SessionLocked) => {
                    let _ = node.handle_ghost_trigger(GhostTriggerKind::SessionLock);
                }
                Event::UserEvent(ShellUserEvent::SessionUnlocked) => {
                    if window.is_focused() && !window.is_minimized() {
                        let _ = node.handle_ghost_trigger(GhostTriggerKind::RestoreFocus);
                    }
                }
                Event::UserEvent(ShellUserEvent::PowerResume) => {
                    let _ = node.stealth().tick_timers();
                }
                Event::UserEvent(ShellUserEvent::TraySwitchPdf) => {
                    let _ = node
                        .stealth()
                        .handle_trigger(PrivacyTriggerKind::ManualSwitchToPdf);
                }
                Event::UserEvent(ShellUserEvent::TrayLockNow) => {
                    let _ = node.handle_ghost_trigger(GhostTriggerKind::ManualLock);
                }
                Event::UserEvent(ShellUserEvent::TrayShow) => {
                    window.set_minimized(false);
                    window.set_focus();
                    let _ = node.stealth().notify_window_focus_restored(true);
                }
                Event::UserEvent(ShellUserEvent::StealthUpdated(boot)) => {
                    window.set_title(&boot.window_title);
                    if let Some(ref ti) = tray_icon {
                        let tip = if boot.locked || boot.active_surface != ActiveSurface::Messenger
                        {
                            boot.window_title.as_str()
                        } else {
                            "Cloak — Encrypted Local-First P2P"
                        };
                        let _ = ti.set_tooltip(Some(tip));
                    }
                }
                Event::UserEvent(ShellUserEvent::SyncAuthoritativeTitle) => {
                    let boot = node.get_stealth_bootstrap();
                    window.set_title(&boot.window_title);
                }
                Event::UserEvent(ShellUserEvent::CaptureProtection(active)) => unsafe {
                    let aff = if active {
                        WDA_EXCLUDEFROMCAPTURE
                    } else {
                        WDA_NONE
                    };
                    let _ = SetWindowDisplayAffinity(hwnd, aff);
                },
                _ => {}
            }
        });
    }
}

#[cfg(target_os = "windows")]
pub use imp::run_native_window;

#[cfg(not(target_os = "windows"))]
pub fn run_native_window(
    _url: &str,
    _data_dir: &std::path::Path,
    _session_token: &str,
    _node: cloak_p2p::P2pNode,
    _autoclose_ms: Option<u64>,
    _boot_start: std::time::Instant,
) -> Result<(), Box<dyn std::error::Error>> {
    Err("Native Windows WebView2 shell requires Windows".into())
}
