use std::process::Command;

fn main() {
    let target = std::env::var("TARGET").unwrap_or_default();
    if target.contains("linux-gnu") {
        cc::Build::new().file("glibc_compat.c").compile("glibc_compat");
        // libstdc++ is linked statically so the binary needs only glibc (see
        // README "glibc floor"); scripts/ci-build.sh sets ORT_CXX_STDLIB=""
        // so ort-sys doesn't also link it dynamically.
        let out = Command::new("g++")
            .arg("-print-file-name=libstdc++.a")
            .output()
            .expect("run g++ -print-file-name");
        let path = String::from_utf8(out.stdout).unwrap().trim().to_string();
        assert!(std::path::Path::new(&path).is_file(), "libstdc++.a not found (g++ said {path:?}); install g++");
        // A trailing link arg, so it follows ort-sys's libonnxruntime.a.
        println!("cargo:rustc-link-arg-bins={path}");
    }
    println!("cargo:rerun-if-changed=glibc_compat.c");
}
