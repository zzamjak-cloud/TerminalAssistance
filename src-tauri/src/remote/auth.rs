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
    TooMany, // 실패 한도 초과 — 새 코드를 발급할 때까지 잠김
}

/// 1회용 페어링 코드 상태. 시각을 인자로 받아 TTL 을 테스트할 수 있게 한다
#[derive(Default)]
pub struct Pairing {
    active: Option<(String, Instant)>,
    failures: u32,
    locked: bool,
}

impl Pairing {
    /// 새 코드 발급 — 이전 코드·실패 횟수·잠금은 모두 초기화된다
    pub fn start(&mut self, now: Instant) -> (String, Instant) {
        let raw = random_bytes::<CODE_LEN>();
        let code: String = raw.iter().map(|b| CODE_ALPHABET[(b & 31) as usize] as char).collect();
        let expires = now + PAIR_TTL;
        self.active = Some((code.clone(), expires));
        self.failures = 0;
        self.locked = false;
        (code, expires)
    }

    pub fn consume(&mut self, code: &str, now: Instant) -> PairCheck {
        if self.locked {
            return PairCheck::TooMany;
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
            return PairCheck::Ok;
        }
        self.failures += 1;
        if self.failures >= PAIR_MAX_FAILS {
            self.active = None;
            self.locked = true;
            return PairCheck::TooMany;
        }
        PairCheck::Invalid
    }
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

/// Origin 이 있으면 같은 출처(http://<Host>)여야 한다 — 크로스 사이트 WebSocket 하이재킹 방어
pub fn origin_ok(origin: Option<&str>, host: &str) -> bool {
    match origin {
        None => true,
        Some(o) => o.eq_ignore_ascii_case(&format!("http://{}", host)),
    }
}

fn is_cgnat(ip: &IpAddr) -> bool {
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

    #[test]
    fn pairing_code_is_single_use_and_expires() {
        let t0 = Instant::now();
        let mut p = Pairing::default();
        assert_eq!(p.consume("ANY", t0), PairCheck::Invalid); // 발급 전
        let (code, exp) = p.start(t0);
        assert_eq!(code.len(), CODE_LEN);
        assert_eq!(exp, t0 + PAIR_TTL);
        // 소문자·공백도 허용
        assert_eq!(p.consume(&format!(" {} ", code.to_lowercase()), t0), PairCheck::Ok);
        assert_eq!(p.consume(&code, t0), PairCheck::Invalid); // 1회용

        let (code, _) = p.start(t0);
        assert_eq!(p.consume(&code, t0 + PAIR_TTL), PairCheck::Invalid); // TTL 경과
        assert_eq!(p.consume(&code, t0), PairCheck::Invalid); // 만료 후 폐기됨
    }

    #[test]
    fn pairing_locks_after_repeated_failures() {
        let t0 = Instant::now();
        let mut p = Pairing::default();
        let (code, _) = p.start(t0);
        for _ in 0..PAIR_MAX_FAILS - 1 {
            assert_eq!(p.consume("WRONG", t0), PairCheck::Invalid);
        }
        assert_eq!(p.consume("WRONG", t0), PairCheck::TooMany);
        // 잠긴 뒤에는 맞는 코드도 거부
        assert_eq!(p.consume(&code, t0), PairCheck::TooMany);
        // 새 발급으로 해제
        let (code2, _) = p.start(t0);
        assert_eq!(p.consume(&code2, t0), PairCheck::Ok);
    }

    #[test]
    fn bind_classification() {
        let w = |s: &str| bind_warning(&s.parse().unwrap());
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

        assert!(origin_ok(None, "127.0.0.1:7788"));
        assert!(origin_ok(Some("http://127.0.0.1:7788"), "127.0.0.1:7788"));
        assert!(!origin_ok(Some("http://evil.example"), "127.0.0.1:7788"));
        assert!(!origin_ok(Some("https://127.0.0.1:7788"), "127.0.0.1:7788"));
        assert!(!origin_ok(Some("null"), "127.0.0.1:7788"));
    }
}
