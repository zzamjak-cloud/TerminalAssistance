// 모바일 웹 앱 정적 파일 — 바이너리에 내장한다 (비밀 없음, 인증 불필요)

/// 요청 경로 → (본문, Content-Type). 목록에 없는 경로는 None
pub fn lookup(path: &str) -> Option<(&'static [u8], &'static str)> {
    const JS: &str = "text/javascript; charset=utf-8";
    const CSS: &str = "text/css; charset=utf-8";
    Some(match path {
        "/" | "/index.html" => (
            include_bytes!("../../../src/mobile/index.html").as_slice(),
            "text/html; charset=utf-8",
        ),
        "/mobile.css" => (include_bytes!("../../../src/mobile/mobile.css").as_slice(), CSS),
        "/mobile.js" => (include_bytes!("../../../src/mobile/mobile.js").as_slice(), JS),
        "/remote-core.js" => (include_bytes!("../../../src/mobile/remote-core.js").as_slice(), JS),
        "/dashboard-core.js" => {
            (include_bytes!("../../../src/renderer/dashboard-core.js").as_slice(), JS)
        }
        "/xterm.js" => (include_bytes!("../../../src/renderer/vendor/xterm.js").as_slice(), JS),
        "/xterm.css" => (include_bytes!("../../../src/renderer/vendor/xterm.css").as_slice(), CSS),
        "/addon-fit.js" => {
            (include_bytes!("../../../src/renderer/vendor/addon-fit.js").as_slice(), JS)
        }
        "/manifest.webmanifest" => (
            include_bytes!("../../../src/mobile/manifest.webmanifest").as_slice(),
            "application/manifest+json",
        ),
        "/sw.js" => (include_bytes!("../../../src/mobile/sw.js").as_slice(), JS),
        "/icon.png" => (include_bytes!("../../icons/128x128@2x.png").as_slice(), "image/png"),
        _ => return None,
    })
}
