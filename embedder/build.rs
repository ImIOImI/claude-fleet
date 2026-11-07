use std::process::Command;

fn main() {
    println!("cargo:rerun-if-changed=glibc_compat.c");
    println!("cargo:rerun-if-env-changed=FLEET_GLIBC_COMPAT");
    // Release Linux builds only (scripts/ci-build.sh, zig against glibc 2.28;
    // README "glibc floor"). A dev build links against the host glibc as usual.
    if std::env::var("FLEET_GLIBC_COMPAT").as_deref() != Ok("1") {
        return;
    }
    cc::Build::new().file("glibc_compat.c").compile("glibc_compat");
    // libstdc++ static, so the binary needs only glibc; the script sets
    // ORT_CXX_STDLIB="" so ort-sys doesn't also link it dynamically.
    let out = Command::new("g++")
        .arg("-print-file-name=libstdc++.a")
        .output()
        .expect("run g++ -print-file-name");
    let path = String::from_utf8(out.stdout).unwrap().trim().to_string();
    assert!(std::path::Path::new(&path).is_file(), "libstdc++.a not found (g++ said {path:?}); install g++");
    // A trailing link arg, so it follows ort-sys's libonnxruntime.a.
    println!("cargo:rustc-link-arg-bins={path}");
}
