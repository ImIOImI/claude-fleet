fn main() {
    let target = std::env::var("TARGET").unwrap_or_default();
    if target.contains("linux-gnu") {
        cc::Build::new().file("glibc_compat.c").compile("glibc_compat");
    }
    println!("cargo:rerun-if-changed=glibc_compat.c");
}
