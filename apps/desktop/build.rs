use std::path::PathBuf;
use std::process::Command;

fn main() {
    println!("cargo:rerun-if-changed=assets/cloak.ico");
    println!("cargo:rerun-if-changed=assets/cloak.rc");

    #[cfg(target_os = "windows")]
    {
        let out_dir = PathBuf::from(std::env::var("OUT_DIR").expect("OUT_DIR"));
        let res_obj = out_dir.join("cloak_res.o");
        let lib_file = out_dir.join("libcloak_res.a");
        let rc_path = PathBuf::from("assets/cloak.rc");
        if rc_path.exists()
            && Command::new("windres")
                .args(["assets/cloak.rc", "-O", "coff", "-o"])
                .arg(&res_obj)
                .status()
                .is_ok_and(|s| s.success())
            && Command::new("ar")
                .args(["rcs"])
                .arg(&lib_file)
                .arg(&res_obj)
                .status()
                .is_ok_and(|s| s.success())
        {
            println!("cargo:rustc-link-search=native={}", out_dir.display());
            println!("cargo:rustc-link-lib=static=cloak_res");
        }
    }
}
