#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::process::Command;

const PAYLOAD_MAGIC: &[u8; 9] = b"CLOAKPKG1";

struct SetupOptions {
    silent: bool,
    uninstall: bool,
    keep_data: bool,
    install_dir: PathBuf,
    desktop_shortcut: bool,
    launch_after: bool,
}

fn default_install_dir() -> PathBuf {
    std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
        .join("Programs")
        .join("Cloak")
}

fn default_vault_dir() -> PathBuf {
    std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
        .join("CloakDesktop")
}

fn parse_args() -> SetupOptions {
    let mut opts = SetupOptions {
        silent: false,
        uninstall: false,
        keep_data: true,
        install_dir: default_install_dir(),
        desktop_shortcut: true,
        launch_after: false,
    };
    let mut args = std::env::args().skip(1);
    while let Some(a) = args.next() {
        match a.as_str() {
            "--silent" | "/S" => opts.silent = true,
            "--uninstall" => opts.uninstall = true,
            "--purge-data" => opts.keep_data = false,
            "--keep-data" => opts.keep_data = true,
            "--no-desktop-shortcut" => opts.desktop_shortcut = false,
            "--launch" => opts.launch_after = true,
            "--install-dir" => {
                if let Some(d) = args.next() {
                    opts.install_dir = PathBuf::from(d);
                }
            }
            _ => {}
        }
    }
    opts
}

/// Reads embedded `cloak-desktop.exe` appended at the tail of `cloak-setup.exe`, or sibling file.
fn read_desktop_payload() -> Result<Vec<u8>, String> {
    let self_exe = std::env::current_exe().map_err(|e| format!("current_exe: {e}"))?;
    let mut f = File::open(&self_exe).map_err(|e| format!("open setup exe: {e}"))?;
    let len = f.metadata().map_err(|e| format!("stat: {e}"))?.len();
    if len > 17 {
        f.seek(SeekFrom::End(-17)).map_err(|e| e.to_string())?;
        let mut trailer = [0u8; 17];
        f.read_exact(&mut trailer).map_err(|e| e.to_string())?;
        if &trailer[8..17] == PAYLOAD_MAGIC {
            let payload_len = u64::from_le_bytes(trailer[0..8].try_into().unwrap());
            let start = len
                .checked_sub(17 + payload_len)
                .ok_or("Invalid trailer offset")?;
            f.seek(SeekFrom::Start(start)).map_err(|e| e.to_string())?;
            let mut payload = vec![0u8; payload_len as usize];
            f.read_exact(&mut payload).map_err(|e| e.to_string())?;
            return Ok(payload);
        }
    }

    let sibling = self_exe
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join("cloak-desktop.exe");
    if sibling.exists() {
        return fs::read(&sibling).map_err(|e| format!("read sibling cloak-desktop.exe: {e}"));
    }
    Err("No embedded or sibling cloak-desktop.exe payload found.".into())
}

#[cfg(target_os = "windows")]
fn run_powershell(script: &str) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let _ = Command::new("powershell")
        .args([
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            script,
        ])
        .creation_flags(CREATE_NO_WINDOW)
        .status();
}

#[cfg(target_os = "windows")]
fn create_shortcut(lnk_path: &Path, target: &Path, work_dir: &Path, desc: &str) {
    if let Some(parent) = lnk_path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let lnk = lnk_path.display().to_string().replace('\'', "''");
    let tgt = target.display().to_string().replace('\'', "''");
    let wd = work_dir.display().to_string().replace('\'', "''");
    let d = desc.replace('\'', "''");
    let ps = format!(
        "$ws = New-Object -ComObject WScript.Shell; $s = $ws.CreateShortcut('{lnk}'); $s.TargetPath = '{tgt}'; $s.WorkingDirectory = '{wd}'; $s.IconLocation = '{tgt},0'; $s.Description = '{d}'; $s.Save()"
    );
    run_powershell(&ps);
}

#[cfg(target_os = "windows")]
fn register_uninstall_key(install_dir: &Path, exe_path: &Path, uninst_path: &Path) {
    let key = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\CloakDesktop";
    let dir_s = install_dir.display().to_string();
    let exe_s = exe_path.display().to_string();
    let uninst_cmd = format!(
        "\"{}\" --uninstall --install-dir \"{}\"",
        uninst_path.display(),
        install_dir.display()
    );
    for (name, val) in [
        ("DisplayName", "Cloak (Local-First P2P Messenger)"),
        ("DisplayVersion", "0.1.0"),
        ("Publisher", "Cloak Privacy"),
        ("DisplayIcon", exe_s.as_str()),
        ("InstallLocation", dir_s.as_str()),
        ("UninstallString", uninst_cmd.as_str()),
    ] {
        let _ = Command::new("reg")
            .args(["add", key, "/v", name, "/t", "REG_SZ", "/d", val, "/f"])
            .status();
    }
}

#[cfg(target_os = "windows")]
fn unregister_uninstall_key() {
    let key = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\CloakDesktop";
    let _ = Command::new("reg").args(["delete", key, "/f"]).status();
}

fn start_menu_shortcut_path() -> PathBuf {
    std::env::var_os("APPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
        .join("Microsoft")
        .join("Windows")
        .join("Start Menu")
        .join("Programs")
        .join("Cloak")
        .join("Cloak.lnk")
}

fn desktop_shortcut_path() -> PathBuf {
    std::env::var_os("USERPROFILE")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
        .join("Desktop")
        .join("Cloak.lnk")
}

#[cfg(target_os = "windows")]
fn show_info(_title: &str, msg: &str, silent: bool) {
    if !silent {
        rfd::MessageDialog::new()
            .set_title(_title)
            .set_description(msg)
            .set_buttons(rfd::MessageButtons::Ok)
            .show();
    } else {
        println!("{msg}");
    }
}

#[cfg(not(target_os = "windows"))]
fn show_info(_title: &str, msg: &str, _silent: bool) {
    println!("{msg}");
}

fn perform_install(opts: &SetupOptions) -> Result<(), String> {
    let mut target_dir = opts.install_dir.clone();
    #[cfg(target_os = "windows")]
    if !opts.silent {
        let proceed = rfd::MessageDialog::new()
            .set_title("Install Cloak Desktop")
            .set_description(format!(
                "Install Cloak (Local-First P2P Messenger) into:\n{}\n\nIncludes Start Menu & Desktop shortcuts plus local uninstaller.",
                target_dir.display()
            ))
            .set_buttons(rfd::MessageButtons::OkCancel)
            .show();
        if proceed != rfd::MessageDialogResult::Ok {
            return Ok(());
        }
        if let Some(chosen) = rfd::FileDialog::new()
            .set_title("Choose Cloak Installation Folder (Cancel uses default)")
            .set_directory(&target_dir)
            .pick_folder()
        {
            target_dir = chosen;
        }
    }

    let payload = read_desktop_payload()?;
    fs::create_dir_all(&target_dir).map_err(|e| format!("mkdir {}: {e}", target_dir.display()))?;

    let dest_exe = target_dir.join("cloak-desktop.exe");
    let mut out = File::create(&dest_exe).map_err(|e| format!("create cloak-desktop.exe: {e}"))?;
    out.write_all(&payload)
        .map_err(|e| format!("write payload: {e}"))?;
    drop(out);

    let dest_uninst = target_dir.join("uninstall.exe");
    if let Ok(self_exe) = std::env::current_exe()
        && self_exe != dest_uninst
    {
        let _ = fs::copy(&self_exe, &dest_uninst);
    }

    #[cfg(target_os = "windows")]
    {
        create_shortcut(
            &start_menu_shortcut_path(),
            &dest_exe,
            &target_dir,
            "Cloak Encrypted P2P Messenger",
        );
        if opts.desktop_shortcut {
            create_shortcut(
                &desktop_shortcut_path(),
                &dest_exe,
                &target_dir,
                "Cloak Encrypted P2P Messenger",
            );
        }
        register_uninstall_key(&target_dir, &dest_exe, &dest_uninst);
    }

    if opts.launch_after {
        let _ = Command::new(&dest_exe).spawn();
    }

    show_info(
        "Cloak Installed",
        &format!(
            "Cloak was installed successfully to {}.",
            target_dir.display()
        ),
        opts.silent,
    );
    Ok(())
}

fn perform_uninstall(opts: &SetupOptions) -> Result<(), String> {
    let mut keep_data = opts.keep_data;
    #[cfg(target_os = "windows")]
    if !opts.silent {
        let choice = rfd::MessageDialog::new()
            .set_title("Uninstall Cloak Desktop")
            .set_description("Keep your local encrypted SQLite conversations and identity keys in %LOCALAPPDATA%\\CloakDesktop?")
            .set_buttons(rfd::MessageButtons::YesNoCancel)
            .show();
        match choice {
            rfd::MessageDialogResult::Yes => keep_data = true,
            rfd::MessageDialogResult::No => keep_data = false,
            _ => return Ok(()),
        }
    }

    let _ = fs::remove_file(start_menu_shortcut_path());
    let _ = fs::remove_file(desktop_shortcut_path());
    if let Some(sm_dir) = start_menu_shortcut_path().parent() {
        let _ = fs::remove_dir(sm_dir);
    }

    #[cfg(target_os = "windows")]
    unregister_uninstall_key();

    let installed_exe = opts.install_dir.join("cloak-desktop.exe");
    let _ = fs::remove_file(&installed_exe);

    if !keep_data {
        let vault = default_vault_dir();
        if vault.exists() {
            let _ = fs::remove_dir_all(&vault);
        }
    }

    // Schedule clean removal of install folder once uninstall.exe exits
    #[cfg(target_os = "windows")]
    {
        let dir_str = opts.install_dir.display().to_string();
        let _ = Command::new("cmd")
            .args([
                "/c",
                "ping",
                "127.0.0.1",
                "-n",
                "2",
                ">nul",
                "&",
                "rmdir",
                "/s",
                "/q",
                &dir_str,
            ])
            .spawn();
    }

    show_info(
        "Cloak Uninstalled",
        if keep_data {
            "Cloak binaries and shortcuts removed. Your local encrypted vault was preserved."
        } else {
            "Cloak binaries, shortcuts, and local encrypted vault were removed."
        },
        opts.silent,
    );
    Ok(())
}

fn main() {
    let opts = parse_args();
    let res = if opts.uninstall {
        perform_uninstall(&opts)
    } else {
        perform_install(&opts)
    };
    if let Err(err) = res {
        show_info("Cloak Setup Error", &err, opts.silent);
        std::process::exit(1);
    }
}
