fn main() {
    use sha2::{Digest, Sha256};

    let manifest = "resources/runtime/manifest.json";
    println!("cargo:rerun-if-changed={manifest}");
    let slot = match std::fs::read(manifest) {
        Ok(bytes) => format!("zzb-runtime-{:x}", Sha256::digest(bytes)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => "development".into(),
        Err(e) => panic!("Cannot identify the desktop runtime: {e}"),
    };
    println!("cargo:rustc-env=ZZ_BOARD_PACKAGED_RUNTIME={slot}");
    ensure_windows_icon();
    tauri_build::build()
}

fn ensure_windows_icon() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("windows") {
        return;
    }
    let icon_path = std::path::Path::new("icons/icon.ico");
    if icon_path.is_file() {
        return;
    }
    std::fs::create_dir_all("icons").expect("create generated icon directory");

    const SIZE: usize = 32;
    const PIXELS: usize = SIZE * SIZE * 4;
    const MASK: usize = 4 * SIZE;
    const IMAGE_BYTES: u32 = (40 + PIXELS + MASK) as u32;
    let mut icon = Vec::with_capacity(22 + IMAGE_BYTES as usize);
    icon.extend_from_slice(&0_u16.to_le_bytes());
    icon.extend_from_slice(&1_u16.to_le_bytes());
    icon.extend_from_slice(&1_u16.to_le_bytes());
    icon.extend_from_slice(&[SIZE as u8, SIZE as u8, 0, 0]);
    icon.extend_from_slice(&1_u16.to_le_bytes());
    icon.extend_from_slice(&32_u16.to_le_bytes());
    icon.extend_from_slice(&IMAGE_BYTES.to_le_bytes());
    icon.extend_from_slice(&22_u32.to_le_bytes());
    icon.extend_from_slice(&40_u32.to_le_bytes());
    icon.extend_from_slice(&(SIZE as i32).to_le_bytes());
    icon.extend_from_slice(&((SIZE * 2) as i32).to_le_bytes());
    icon.extend_from_slice(&1_u16.to_le_bytes());
    icon.extend_from_slice(&32_u16.to_le_bytes());
    icon.extend_from_slice(&0_u32.to_le_bytes());
    icon.extend_from_slice(&(PIXELS as u32).to_le_bytes());
    icon.extend_from_slice(&0_i32.to_le_bytes());
    icon.extend_from_slice(&0_i32.to_le_bytes());
    icon.extend_from_slice(&0_u32.to_le_bytes());
    icon.extend_from_slice(&0_u32.to_le_bytes());

    for y in (0..SIZE).rev() {
        for x in 0..SIZE {
            let dx = x as f32 - 15.5;
            let dy = y as f32 - 15.5;
            let inside = (dx * dx + dy * dy).sqrt() <= 14.0;
            let mark = ((9..=21).contains(&x) && (10..=13).contains(&y))
                || ((9..=21).contains(&x) && (19..=22).contains(&y))
                || ((18..=21).contains(&x) && (10..=22).contains(&y));
            let [red, green, blue, alpha] = if mark {
                [234, 223, 185, 255]
            } else if inside {
                [42, 52, 50, 255]
            } else {
                [0, 0, 0, 0]
            };
            icon.extend_from_slice(&[blue, green, red, alpha]);
        }
    }
    icon.resize(icon.len() + MASK, 0);
    std::fs::write(icon_path, icon).expect("write generated Windows icon");
}
