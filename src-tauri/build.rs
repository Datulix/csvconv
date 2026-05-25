fn main() {
    tauri_build::build();

    // Copy the pdfium DLL next to the binary so it can be found at runtime.
    let out_dir = std::env::var("OUT_DIR").unwrap();
    // OUT_DIR is e.g. target/debug/build/csvconv-xxx/out — go up 3 levels to reach target/debug/
    let target_dir = std::path::Path::new(&out_dir)
        .ancestors()
        .nth(3)
        .unwrap()
        .to_path_buf();

    let src = std::path::Path::new("binaries/pdfium.dll");
    if src.exists() {
        std::fs::copy(src, target_dir.join("pdfium.dll"))
            .expect("failed to copy pdfium.dll to target dir");
    }

    println!("cargo:rerun-if-changed=binaries/pdfium.dll");
}
