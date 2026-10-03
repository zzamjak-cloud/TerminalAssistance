// 원격 인증 — 1회용 페어링 코드, 기기 토큰(해시만 저장), Host/Origin 검사, 바인드 주소 분류
use crate::store::RemoteDevice;
use sha2::{Digest, Sha256};
use std::net::IpAddr;
use std::time::{Duration, Instant};

pub const PAIR_TTL: Duration = Duration::from_secs(5 * 60);
pub const PAIR_MAX_FAILS: u32 = 5;
// I·O 를 뺀 32자 — 사람이 옮겨 적을 때 1/I, 0/O 혼동이 없고 바이트 & 31 로 균등 추출된다
const CODE_ALPHABET: &[u8; 32] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_LEN: usize = 8;

pub fn random_bytes<const N: usize>() -> [u8; N] {
    let mut buf = [0u8; N];
    // OS 난수원 실패는 사실상 발생하지 않으며, 약한 값으로 대체하면 보안이 조용히 무너진다
    getrandom::getrandom(&mut buf).expect("OS 난수 생성 실패");
    buf
}

pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

/// 새 기기 토큰 (32바이트 → 64 hex). 원문은 쿠키로 1회만 전달하고 저장하지 않는다
pub fn new_token() -> String {
    hex(&random_bytes::<32>())
}

pub fn hash_token(token: &str) -> String {
    hex(&Sha256::digest(token.as_bytes()))
}

/// 상수시간 비교 — 일치하는 접두 길이에 따라 응답 시간이 달라지지 않게 한다
pub fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// 토큰 원문으로 기기 찾기. 모든 기기와 비교해 일치 위치로 시간이 달라지지 않게 한다
pub fn find_device<'a>(token: &str, devices: &'a [RemoteDevice]) -> Option<&'a RemoteDevice> {
    let h = hash_token(token);
    let mut found = None;
    for d in devices {
        if ct_eq(h.as_bytes(), d.token_hash.as_bytes()) && found.is_none() {
            found = Some(d);
        }
    }
    found
}

#[derive(Debug, PartialEq)]
pub enum PairCheck {
    Ok,
    Invalid, // 코드 없음·만료·불일치
    TooMany, // 이 IP 가 실패 한도를 넘어 잠김 (백오프 중)
}

// IP 별 실패 잠금 — 첫 잠금 30초, 이후 2배씩 최대 15분
const LOCK_BASE: Duration = Duration::from_secs(30);
const LOCK_MAX: Duration = Duration::from_secs(15 * 60);
const FAIL_FORGET: Duration = Duration::from_secs(60 * 60); // 이만큼 조용한 IP 기록은 버린다
const FAIL_MAP_CAP: usize = 4096; // 위조 출발지 남발로 맵이 무한히 크지 않게

struct IpFail {
    fails: u32,
    strikes: u32, // 누적 잠금 횟수 — 백오프 지수
    locked_until: Option<Instant>,
    last: Instant,
}

/// 1회용 페어링 코드 상태. 실패는 원격 IP 별로 센다 — 한 공격자가 잠금을 유발해
/// 정상 기기의 페어링까지 막는 것(전역 잠금의 DoS)을 피한다. 시각을 인자로 받아 테스트 가능
#[derive(Default)]
pub struct Pairing {
    active: Option<(String, Instant)>,
    fails: std::collections::HashMap<IpAddr, IpFail>,
}

impl Pairing {
    /// 새 코드 발급 — 이전 코드는 무효. IP 잠금은 유지한다 (재발급으로 백오프를 우회하지 못하게)
    pub fn start(&mut self, now: Instant) -> (String, Instant) {
        let raw = random_bytes::<CODE_LEN>();
        let code: String = raw.iter().map(|b| CODE_ALPHABET[(b & 31) as usize] as char).collect();
        let expires = now + PAIR_TTL;
        self.active = Some((code.clone(), expires));
        (code, expires)
    }

    fn prune(&mut self, now: Instant) {
        let idle = |f: &IpFail| {
            f.locked_until.is_none_or(|t| t <= now) && now.duration_since(f.last) >= FAIL_FORGET
        };
        self.fails.retain(|_, f| !idle(f));
        if self.fails.len() > FAIL_MAP_CAP {
            self.fails.retain(|_, f| f.locked_until.is_some_and(|t| t > now));
        }
    }

    pub fn consume(&mut self, ip: IpAddr, code: &str, now: Instant) -> PairCheck {
        self.prune(now);
        if let Some(f) = self.fails.get(&ip) {
            if f.locked_until.is_some_and(|t| t > now) {
                return PairCheck::TooMany;
            }
        }
        let Some((expected, expires)) = self.active.as_ref() else {
            return PairCheck::Invalid;
        };
        if now >= *expires {
            self.active = None;
            return PairCheck::Invalid;
        }
        let given = code.trim().to_ascii_uppercase();
        if ct_eq(given.as_bytes(), expected.as_bytes()) {
            self.active = None; // 1회용
            self.fails.remove(&ip);
            return PairCheck::Ok;
        }
        let f = self.fails.entry(ip).or_insert(IpFail { fails: 0, strikes: 0, locked_until: None, last: now });
        f.last = now;
        f.fails += 1;
        if f.fails >= PAIR_MAX_FAILS {
            f.fails = 0;
            f.strikes += 1;
            let backoff = LOCK_BASE.saturating_mul(1u32 << (f.strikes - 1).min(10)).min(LOCK_MAX);
            f.locked_until = Some(now + backoff);
            return PairCheck::TooMany;
        }
        PairCheck::Invalid
    }
}

/// 토큰 유휴 만료 — 마지막 사용 후 이 기간이 지나면 기기를 자동 제거한다
pub const IDLE_EXPIRY_MS: u64 = 30 * 24 * 60 * 60 * 1000;

pub fn idle_expired(dev: &RemoteDevice, now_ms: u64) -> bool {
    // last_seen 이 비어 있던 기록은 생성 시각 기준
    now_ms.saturating_sub(dev.last_seen_ms.max(dev.created_ms)) > IDLE_EXPIRY_MS
}

fn host_port(ip: &IpAddr, port: u16) -> String {
    match ip {
        IpAddr::V6(v6) => format!("[{}]:{}", v6, port),
        IpAddr::V4(v4) => format!("{}:{}", v4, port),
    }
}

/// Host 헤더 허용 목록 (DNS 리바인딩 방어). 바인드 주소·루프백 + 0.0.0.0 바인드일 때의 인터페이스 IP
pub fn allowed_hosts(bind: &IpAddr, port: u16, iface_ips: &[IpAddr]) -> Vec<String> {
    let mut v = vec![format!("localhost:{}", port), format!("127.0.0.1:{}", port), format!("[::1]:{}", port)];
    if !bind.is_unspecified() {
        v.push(host_port(bind, port));
    }
    for ip in iface_ips {
        v.push(host_port(ip, port));
    }
    if port == 80 {
        // 기본 포트면 브라우저가 Host 에서 포트를 생략한다
        let bare: Vec<String> =
            v.iter().filter_map(|h| h.strip_suffix(":80").map(str::to_string)).collect();
        v.extend(bare);
    }
    v.sort();
    v.dedup();
    v
}

pub fn host_allowed(host: &str, allowed: &[String]) -> bool {
    allowed.iter().any(|h| h.eq_ignore_ascii_case(host))
}

/// Origin 이 있으면 같은 출처(<scheme>://<Host>)여야 한다 — 크로스 사이트 WebSocket 하이재킹 방어.
/// https 는 tailscale serve 경유 Host 일 때만
pub fn origin_ok(origin: Option<&str>, host: &str, https: bool) -> bool {
    let scheme = if https { "https" } else { "http" };
    match origin {
        None => true,
        Some(o) => o.eq_ignore_ascii_case(&format!("{}://{}", scheme, host)),
    }
}

/// 실제 접속 기기 IP. serve 경유(HTTPS 모드에서 피어가 루프백)면 Tailscale 이 붙인 X-Forwarded-For 의
/// 마지막 값 — 프록시가 자기가 본 피어를 끝에 덧붙이므로 앞쪽 값은 클라이언트가 위조할 수 있다
pub fn client_ip(peer: IpAddr, https_mode: bool, xff: Option<&str>) -> IpAddr {
    if !(https_mode && peer.is_loopback()) {
        return peer;
    }
    xff.and_then(|v| v.rsplit(',').next())
        .and_then(|s| s.trim().parse().ok())
        .unwrap_or(peer)
}

/// 연결 진단 안내 분기용 플랫폼
pub fn platform_from_ua(ua: &str) -> &'static str {
    if ua.contains("Android") {
        "android"
    } else if ua.contains("iPhone") || ua.contains("iPad") || ua.contains("iPod") {
        "ios"
    } else {
        "other"
    }
}

pub fn is_cgnat(ip: &IpAddr) -> bool {
    // 100.64.0.0/10 — Tailscale 이 기기에 주는 대역
    matches!(ip, IpAddr::V4(v4) if v4.octets()[0] == 100 && (v4.octets()[1] & 0xC0) == 64)
}

fn is_private(ip: &IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => v4.is_private() || v4.is_link_local(),
        // fc00::/7 (ULA), fe80::/10 (link-local)
        IpAddr::V6(v6) => (v6.segments()[0] & 0xfe00) == 0xfc00 || (v6.segments()[0] & 0xffc0) == 0xfe80,
    }
}

/// 설정 UI 용 바인드 등급 — 프론트는 lan/public 적용 시 한 번 더 확인한다. 0.0.0.0 은 public
pub fn bind_level(ip: &IpAddr) -> &'static str {
    if ip.is_loopback() {
        "loopback"
    } else if ip.is_unspecified() {
        "public"
    } else if is_cgnat(ip) {
        "tailscale"
    } else if is_private(ip) {
        "lan"
    } else {
        "public"
    }
}

/// 바인드 주소 위험도 경고. 루프백이면 None
pub fn bind_warning(ip: &IpAddr) -> Option<String> {
    if ip.is_loopback() {
        return None;
    }
    if ip.is_unspecified() {
        return Some(
            "⚠ 모든 네트워크 인터페이스에 공개됩니다. 같은 네트워크(공용 Wi-Fi 포함)나 인터넷의 누구나 \
             접속을 시도할 수 있고, 통신은 암호화되지 않은 HTTP 입니다. Tailscale IP 바인드를 권장합니다."
                .into(),
        );
    }
    if is_cgnat(ip) {
        return Some(
            "Tailscale(100.64/10) 대역 주소입니다. tailnet 안의 기기만 접근할 수 있고 전송은 Tailscale 이 \
             암호화합니다. 서버 자체는 HTTP 평문입니다."
                .into(),
        );
    }
    if is_private(ip) {
        return Some(
            "사설 네트워크(LAN) 주소입니다. 같은 네트워크의 기기가 접속을 시도할 수 있고, 통신은 \
             암호화되지 않은 HTTP 라 같은 망에서 엿볼 수 있습니다."
                .into(),
        );
    }
    Some(
        "⚠ 공인 IP 입니다. 인터넷 어디서나 접속을 시도할 수 있고 통신은 암호화되지 않습니다. \
         사용을 권장하지 않습니다 — Tailscale IP 바인드를 쓰세요."
            .into(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_hash_is_sha256_hex_and_lookup_matches_only_owner() {
        let t = new_token();
        assert_eq!(t.len(), 64);
        let h = hash_token(&t);
        assert_eq!(h.len(), 64);
        assert_ne!(h, t);
        // 알려진 벡터: sha256("abc")
        assert_eq!(
            hash_token("abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        let dev = |id: &str, tok: &str| RemoteDevice {
            id: id.into(),
            name: id.into(),
            token_hash: hash_token(tok),
            created_ms: 0,
            last_seen_ms: 0,
            tailscale_ip: None,
            platform: None,
        };
        let devices = vec![dev("a", "tok-a"), dev("b", "tok-b")];
        assert_eq!(find_device("tok-b", &devices).map(|d| d.id.as_str()), Some("b"));
        assert!(find_device("tok-c", &devices).is_none());
        // 해시 자체를 토큰으로 내밀어도 통하지 않는다
        assert!(find_device(&devices[0].token_hash, &devices).is_none());
    }

    #[test]
    fn ct_eq_basic() {
        assert!(ct_eq(b"abc", b"abc"));
        assert!(!ct_eq(b"abc", b"abd"));
        assert!(!ct_eq(b"abc", b"ab"));
    }

    fn ip(s: &str) -> IpAddr {
        s.parse().unwrap()
    }

    #[test]
    fn pairing_code_is_single_use_and_expires() {
        let t0 = Instant::now();
        let a = ip("100.64.0.2");
        let mut p = Pairing::default();
        assert_eq!(p.consume(a, "ANY", t0), PairCheck::Invalid); // 발급 전
        let (code, exp) = p.start(t0);
        assert_eq!(code.len(), CODE_LEN);
        assert_eq!(exp, t0 + PAIR_TTL);
        // 소문자·공백도 허용
        assert_eq!(p.consume(a, &format!(" {} ", code.to_lowercase()), t0), PairCheck::Ok);
        assert_eq!(p.consume(a, &code, t0), PairCheck::Invalid); // 1회용

        let (code, _) = p.start(t0);
        assert_eq!(p.consume(a, &code, t0 + PAIR_TTL), PairCheck::Invalid); // TTL 경과
        assert_eq!(p.consume(a, &code, t0), PairCheck::Invalid); // 만료 후 폐기됨
    }

    #[test]
    fn pairing_locks_per_ip_with_backoff() {
        let t0 = Instant::now();
        let (bad, good) = (ip("192.168.0.66"), ip("100.64.0.2"));
        let mut p = Pairing::default();
        let (code, _) = p.start(t0);
        for _ in 0..PAIR_MAX_FAILS - 1 {
            assert_eq!(p.consume(bad, "WRONG", t0), PairCheck::Invalid);
        }
        assert_eq!(p.consume(bad, "WRONG", t0), PairCheck::TooMany);
        // 잠긴 IP 는 맞는 코드도 거부 — 하지만 코드 자체는 살아 있어 다른 IP 는 페어링된다
        assert_eq!(p.consume(bad, &code, t0), PairCheck::TooMany);
        assert_eq!(p.consume(good, &code, t0), PairCheck::Ok);

        // 첫 잠금 30초 후 해제, 두 번째 잠금은 60초 (재발급으로 해제되지 않음)
        let (code, _) = p.start(t0);
        let t1 = t0 + LOCK_BASE;
        for _ in 0..PAIR_MAX_FAILS - 1 {
            assert_eq!(p.consume(bad, "WRONG", t1), PairCheck::Invalid);
        }
        assert_eq!(p.consume(bad, "WRONG", t1), PairCheck::TooMany);
        p.start(t1);
        assert_eq!(p.consume(bad, &code, t1 + LOCK_BASE), PairCheck::TooMany);
        let (code, _) = p.start(t1 + LOCK_BASE * 2);
        assert_eq!(p.consume(bad, &code, t1 + LOCK_BASE * 2), PairCheck::Ok);
    }

    #[test]
    fn idle_expiry_after_30_days() {
        let day = 24 * 60 * 60 * 1000;
        let dev = |created, seen| RemoteDevice {
            id: "d".into(),
            name: "d".into(),
            token_hash: String::new(),
            created_ms: created,
            last_seen_ms: seen,
            tailscale_ip: None,
            platform: None,
        };
        assert!(!idle_expired(&dev(0, 10 * day), 40 * day));
        assert!(idle_expired(&dev(0, 10 * day), 41 * day));
        assert!(!idle_expired(&dev(5 * day, 0), 30 * day)); // last_seen 없음 → 생성 시각 기준
    }

    #[test]
    fn bind_classification() {
        let w = |s: &str| bind_warning(&s.parse().unwrap());
        let lv = |s: &str| bind_level(&s.parse().unwrap());
        assert_eq!(lv("127.0.0.1"), "loopback");
        assert_eq!(lv("0.0.0.0"), "public");
        assert_eq!(lv("100.100.1.1"), "tailscale");
        assert_eq!(lv("192.168.1.1"), "lan");
        assert_eq!(lv("8.8.8.8"), "public");
        assert!(w("127.0.0.1").is_none());
        assert!(w("::1").is_none());
        assert!(w("0.0.0.0").unwrap().starts_with('⚠'));
        assert!(w("::").unwrap().starts_with('⚠'));
        assert!(w("8.8.8.8").unwrap().starts_with('⚠'));
        assert!(w("100.101.102.103").unwrap().contains("Tailscale"));
        assert!(w("100.128.0.1").unwrap().starts_with('⚠')); // 100.64/10 밖은 공인
        for lan in ["192.168.0.5", "10.1.2.3", "172.16.0.1", "169.254.1.1", "fd00::1", "fe80::1"] {
            let msg = w(lan).unwrap();
            assert!(msg.contains("LAN"), "{lan}: {msg}");
        }
    }

    #[test]
    fn host_and_origin_checks() {
        let bind: IpAddr = "100.100.1.2".parse().unwrap();
        let hosts = allowed_hosts(&bind, 7788, &[]);
        assert!(host_allowed("100.100.1.2:7788", &hosts));
        assert!(host_allowed("LOCALHOST:7788", &hosts));
        assert!(host_allowed("127.0.0.1:7788", &hosts));
        assert!(!host_allowed("evil.example:7788", &hosts)); // DNS 리바인딩
        assert!(!host_allowed("100.100.1.2:7789", &hosts));
        assert!(!host_allowed("100.100.1.2", &hosts));

        // 0.0.0.0 바인드: 인터페이스 IP 가 허용 목록에 들어간다
        let any: IpAddr = "0.0.0.0".parse().unwrap();
        let lan: IpAddr = "192.168.0.9".parse().unwrap();
        let hosts = allowed_hosts(&any, 80, &[lan]);
        assert!(host_allowed("192.168.0.9:80", &hosts));
        assert!(host_allowed("192.168.0.9", &hosts));
        assert!(!host_allowed("0.0.0.0:80", &hosts));

        assert!(origin_ok(None, "127.0.0.1:7788", false));
        assert!(origin_ok(Some("http://127.0.0.1:7788"), "127.0.0.1:7788", false));
        assert!(!origin_ok(Some("http://evil.example"), "127.0.0.1:7788", false));
        assert!(!origin_ok(Some("https://127.0.0.1:7788"), "127.0.0.1:7788", false));
        assert!(!origin_ok(Some("null"), "127.0.0.1:7788", false));
        let ts = "mac.tail1.ts.net:7443";
        assert!(origin_ok(Some("https://mac.tail1.ts.net:7443"), ts, true));
        assert!(!origin_ok(Some("http://mac.tail1.ts.net:7443"), ts, true), "HTTPS 모드에서 http 출처 거부");
    }

    #[test]
    fn client_ip_uses_forwarded_only_behind_serve() {
        let lo = ip("127.0.0.1");
        let phone = ip("100.72.45.122");
        assert_eq!(client_ip(lo, true, Some("100.72.45.122")), phone);
        assert_eq!(client_ip(lo, true, Some("1.2.3.4, 100.72.45.122")), phone, "위조 가능한 앞쪽 값 무시");
        assert_eq!(client_ip(lo, false, Some("100.72.45.122")), lo, "HTTP 모드는 헤더를 믿지 않는다");
        assert_eq!(client_ip(phone, true, Some("9.9.9.9")), phone, "직접 접속은 헤더를 믿지 않는다");
        assert_eq!(client_ip(lo, true, Some("garbage")), lo);
        assert_eq!(client_ip(lo, true, None), lo);
    }

    #[test]
    fn platform_from_user_agent() {
        assert_eq!(platform_from_ua("Mozilla/5.0 (Linux; Android 14; K) Chrome/124"), "android");
        assert_eq!(platform_from_ua("Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X)"), "ios");
        assert_eq!(platform_from_ua("Mozilla/5.0 (Macintosh)"), "other");
    }
}
