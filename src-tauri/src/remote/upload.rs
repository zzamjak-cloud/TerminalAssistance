// 폰 이미지 업로드 검증·디코드. 선언된 Content-Type 과 매직바이트가 모두 맞아야 하고,
// 디코드는 크기 제한을 둔다 (압축 폭탄 방지). 저장은 데스크톱과 같은 images::save_png
pub const UPLOAD_MAX: usize = 15 * 1024 * 1024;
const MAX_DIM: u32 = 8192;
// RGBA 결과 버퍼 상한. 디코더 버퍼(같은 크기 이하, 16비트 PNG 는 2배)와 RGBA 변환이 겹칠 수 있어
// 최악 피크는 대략 이 값의 2~3배 — 동시 업로드 수 제한(Semaphore)과 함께 메모리를 묶는다
const MAX_RGBA_BYTES: u64 = 256 * 1024 * 1024;

#[derive(Debug, PartialEq)]
pub enum UploadError {
    Unsupported(&'static str), // 415
    TooLarge,                  // 413 — 픽셀 수가 상한을 넘음
}

/// 헤더에서 읽은 크기로 디코드 전에 거절 (순수 함수)
fn dims_ok(w: u32, h: u32) -> bool {
    w > 0 && h > 0 && w <= MAX_DIM && h <= MAX_DIM && (w as u64) * (h as u64) * 4 <= MAX_RGBA_BYTES
}

fn sniff(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("image/png")
    } else if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        Some("image/jpeg")
    } else if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        Some("image/webp")
    } else if bytes.len() >= 12
        && &bytes[4..8] == b"ftyp"
        && matches!(&bytes[8..12], b"heic" | b"heix" | b"heim" | b"heis" | b"mif1" | b"msf1" | b"hevc")
    {
        Some("image/heic")
    } else {
        None
    }
}

/// 검증 + RGBA 디코드 (CPU 작업 — spawn_blocking 안에서 호출)
pub fn decode(content_type: &str, bytes: &[u8]) -> Result<image::RgbaImage, UploadError> {
    let declared = content_type.split(';').next().unwrap_or("").trim().to_ascii_lowercase();
    if !matches!(declared.as_str(), "image/png" | "image/jpeg" | "image/webp" | "image/heic") {
        return Err(UploadError::Unsupported("unsupported content type"));
    }
    if sniff(bytes) != Some(declared.as_str()) {
        return Err(UploadError::Unsupported("content does not match type"));
    }
    let format = match declared.as_str() {
        "image/png" => image::ImageFormat::Png,
        "image/jpeg" => image::ImageFormat::Jpeg,
        "image/webp" => image::ImageFormat::WebP,
        // HEIC 디코더는 내장하지 않는다 — 폰 웹앱이 JPEG 로 변환해 다시 보내게 415
        _ => return Err(UploadError::Unsupported("heic not supported")),
    };
    // 1) 헤더만 읽어 크기 확인 — 큰 버퍼를 잡기 전에 거절한다
    let (w, h) = image::ImageReader::with_format(std::io::Cursor::new(bytes), format)
        .into_dimensions()
        .map_err(|_| UploadError::Unsupported("decode failed"))?;
    if !dims_ok(w, h) {
        return Err(UploadError::TooLarge);
    }
    // 2) 디코드 — 헤더가 거짓이어도 디코더 할당 상한이 막는다
    let mut reader = image::ImageReader::with_format(std::io::Cursor::new(bytes), format);
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(MAX_DIM);
    limits.max_image_height = Some(MAX_DIM);
    limits.max_alloc = Some(MAX_RGBA_BYTES * 2); // 16비트 채널 디코드 여유
    reader.limits(limits);
    let img = reader.decode().map_err(|_| UploadError::Unsupported("decode failed"))?;
    // 이미 RGBA8 이면 복사 없이 넘긴다 (to_rgba8 은 항상 새로 할당)
    Ok(img.into_rgba8())
}

#[cfg(test)]
mod tests {
    use super::*;

    pub fn png_bytes() -> Vec<u8> {
        let img = image::RgbaImage::from_pixel(3, 2, image::Rgba([9, 9, 9, 255]));
        let mut out = std::io::Cursor::new(Vec::new());
        img.write_to(&mut out, image::ImageFormat::Png).unwrap();
        out.into_inner()
    }

    #[test]
    fn accepts_matching_png_and_jpeg() {
        let img = decode("image/png", &png_bytes()).unwrap();
        assert_eq!((img.width(), img.height()), (3, 2));
        let rgb = image::DynamicImage::ImageRgba8(img).to_rgb8();
        let mut jpg = std::io::Cursor::new(Vec::new());
        rgb.write_to(&mut jpg, image::ImageFormat::Jpeg).unwrap();
        assert!(decode("image/jpeg; charset=binary", jpg.get_ref()).is_ok());
    }

    #[test]
    fn rejects_oversized_dimensions_before_decoding() {
        assert!(dims_ok(8192, 8192));
        assert!(!dims_ok(8193, 10));
        assert!(!dims_ok(0, 10));
        // 헤더만 큰 PNG — 실제 픽셀 데이터 없이도 디코드 전에 413 성격으로 거절
        let mut png = Vec::new();
        {
            let enc = image::codecs::png::PngEncoder::new(&mut png);
            use image::ImageEncoder;
            // 1x1 을 인코딩한 뒤 IHDR 의 폭·높이를 9000 으로 바꾸고 CRC 를 다시 계산한다
            enc.write_image(&[0, 0, 0, 255], 1, 1, image::ExtendedColorType::Rgba8).unwrap();
        }
        png[16..20].copy_from_slice(&9000u32.to_be_bytes());
        png[20..24].copy_from_slice(&9000u32.to_be_bytes());
        let crc = png[12..29].iter().fold(!0u32, |mut c, &b| {
            c ^= b as u32;
            for _ in 0..8 {
                c = if c & 1 != 0 { (c >> 1) ^ 0xEDB8_8320 } else { c >> 1 };
            }
            c
        });
        png[29..33].copy_from_slice(&(!crc).to_be_bytes());
        assert_eq!(decode("image/png", &png), Err(UploadError::TooLarge));
    }

    #[test]
    fn rejects_mismatch_unknown_heic_and_garbage() {
        let png = png_bytes();
        assert!(decode("image/jpeg", &png).is_err()); // 타입 위장
        assert!(decode("text/html", &png).is_err());
        assert!(decode("image/gif", b"GIF89a....").is_err());
        let mut heic = vec![0, 0, 0, 24];
        heic.extend_from_slice(b"ftypheic0000");
        assert_eq!(decode("image/heic", &heic), Err(UploadError::Unsupported("heic not supported")));
        // 매직만 맞고 내용이 깨진 PNG
        assert!(decode("image/png", b"\x89PNG\r\n\x1a\n garbage").is_err());
    }
}
