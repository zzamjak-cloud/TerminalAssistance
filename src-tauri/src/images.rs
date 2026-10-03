// 첨부 이미지 저장 — 데스크톱 클립보드 붙여넣기와 원격(폰) 업로드가 같은 위치·이름·형식을 쓴다
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const KEEP: Duration = Duration::from_secs(7 * 24 * 3600);

/// `<dir>/img_<unix ms>.png` 로 저장하고 경로를 돌려준다. 이름은 여기서만 만든다(외부 입력 미사용).
/// 같은 밀리초 충돌은 `_n` 을 붙여 피한다. 저장 후 7일 지난 파일을 정리한다 (디스크 누수 방지)
pub fn save_png(dir: &Path, img: &image::RgbaImage) -> Result<PathBuf, String> {
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let ts = SystemTime::now().duration_since(UNIX_EPOCH).map_err(|e| e.to_string())?.as_millis();
    let mut path = dir.join(format!("img_{}.png", ts));
    let mut n = 1;
    while path.exists() {
        path = dir.join(format!("img_{}_{}.png", ts, n));
        n += 1;
    }
    img.save_with_format(&path, image::ImageFormat::Png).map_err(|e| e.to_string())?;
    prune(dir);
    Ok(path)
}

fn prune(dir: &Path) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    let cutoff = SystemTime::now() - KEEP;
    for e in entries.flatten() {
        if let Ok(md) = e.metadata() {
            if md.modified().map(|m| m < cutoff).unwrap_or(false) {
                let _ = fs::remove_file(e.path());
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn saves_png_with_unique_names() {
        let dir = std::env::temp_dir().join(format!("ta-img-test-{}", std::process::id()));
        let img = image::RgbaImage::from_pixel(2, 2, image::Rgba([1, 2, 3, 255]));
        let a = save_png(&dir, &img).unwrap();
        let b = save_png(&dir, &img).unwrap();
        assert_ne!(a, b);
        for p in [&a, &b] {
            assert_eq!(p.parent().unwrap(), dir);
            let name = p.file_name().unwrap().to_str().unwrap();
            assert!(name.starts_with("img_") && name.ends_with(".png"), "{name}");
            assert_eq!(image::open(p).unwrap().width(), 2);
        }
        let _ = fs::remove_dir_all(&dir);
    }
}
