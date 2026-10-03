// Tailscale CLI 연동 — IP 탐지, `status --json` 파싱(HTTPS 가능 여부·기기 온라인), `serve` 매핑.
// 모든 CLI 호출은 블로킹이므로 spawn_blocking 안에서 부른다
use super::auth;
use serde::Deserialize;
use std::collections::HashMap;
use std::io::Read;
use std::net::IpAddr;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

/// HTTPS 노출 전용 포트 — 사용자가 쓰는 기본 443 serve 설정을 건드리지 않게 따로 둔다
pub const HTTPS_PORT: u16 = 7443;
// 데몬이 멈춰 있어도 감시 주기를 붙잡지 않게 짧게
const CLI_TIMEOUT: Duration = Duration::from_millis(2000);
// serve 는 HTTPS 미활성 등에서 안내를 띄우고 대기할 수 있어 시간 초과로 끊는다
const SERVE_TIMEOUT: Duration = Duration::from_secs(6);

// CLI 가 없을 때 감시 주기마다 프로세스 생성을 시도하지 않게 — 설치 직후를 놓치지 않도록 TTL 을 둔다
static CLI_MISSING_AT: std::sync::Mutex<Option<Instant>> = std::sync::Mutex::new(None);
const CLI_MISSING_TTL: Duration = Duration::from_secs(30);
// 마지막 탐색 결과 — 마법사의 '미설치' 판정용
static CLI_FOUND: AtomicBool = AtomicBool::new(true);

// GUI 앱은 PATH 가 짧아 흔한 설치 위치를 직접 본다. 절대 경로를 먼저 — PATH 의 같은 이름 다른 프로그램보다 우선
const CANDIDATES: &[&str] = &[
    "/usr/local/bin/tailscale",
    "/opt/homebrew/bin/tailscale",
    "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
    r"C:\Program Files\Tailscale\tailscale.exe",
    "tailscale",
];

/// GUI 앱 설치 위치 — CLI 가 없어도 앱이 있으면 '미설치' 가 아니라 '꺼짐' 으로 본다
const APP_PATHS: &[&str] = &["/Applications/Tailscale.app", r"C:\Program Files\Tailscale\tailscale-ipn.exe"];

pub fn cli_missing() -> bool {
    !CLI_FOUND.load(Ordering::Relaxed)
}

fn missing_cached(marked: Option<Instant>, now: Instant) -> bool {
    marked.is_some_and(|t| now.duration_since(t) < CLI_MISSING_TTL)
}

pub fn app_installed() -> bool {
    APP_PATHS.iter().any(|p| std::path::Path::new(p).exists())
}

/// 이 PC 의 Tailscale 상태 — 마법사 1단계 판정
pub fn host_state(cli_found: bool, app_installed: bool, status: Option<&TsStatus>) -> &'static str {
    match status {
        Some(s) => match s.backend_state.as_str() {
            "Running" => "running",
            "NeedsLogin" | "NeedsMachineAuth" => "needs-login",
            _ => "stopped",
        },
        // CLI 는 있는데 응답이 없으면 데몬(앱)이 꺼진 것
        None if cli_found || app_installed => "stopped",
        None => "missing",
    }
}

/// Tailscale 앱을 띄우는 명령 (상태를 바꾸지 않고 창만 연다). 지원하지 않는 OS 면 None
pub fn open_app_command(os: &str) -> Option<(String, Vec<String>)> {
    match os {
        "macos" => Some(("open".into(), vec!["-a".into(), "Tailscale".into()])),
        "windows" => Some((APP_PATHS[1].into(), Vec::new())),
        _ => None,
    }
}

enum Run {
    NotFound,
    Done(Option<String>), // 성공 종료면 stdout
}

fn run_with(bin: &str, args: &[String], timeout: Duration) -> Run {
    let mut cmd = Command::new(bin);
    cmd.args(args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let Ok(mut child) = cmd.spawn() else { return Run::NotFound };
    // 출력이 파이프 버퍼보다 크면(피어가 많은 status --json) 읽지 않는 한 자식이 멈춘다 — 별도 스레드로 비운다
    let reader = child.stdout.take().map(|mut so| {
        std::thread::spawn(move || {
            let mut out = String::new();
            let _ = so.read_to_string(&mut out);
            out
        })
    });
    let deadline = Instant::now() + timeout;
    let ok = loop {
        match child.try_wait() {
            Ok(Some(st)) => break st.success(),
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(30)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                break false;
            }
        }
    };
    let out = reader.and_then(|h| h.join().ok()).unwrap_or_default();
    Run::Done(ok.then_some(out))
}

/// force: 사용자 조작 경로 — '없음' 캐시를 무시하고 다시 찾는다 (방금 설치했을 수 있다)
fn run_cli(args: &[String], timeout: Duration, force: bool) -> Option<String> {
    if !force && missing_cached(*CLI_MISSING_AT.lock().unwrap_or_else(|e| e.into_inner()), Instant::now()) {
        return None;
    }
    for bin in CANDIDATES {
        match run_with(bin, args, timeout) {
            Run::NotFound => continue,
            Run::Done(out) => {
                CLI_FOUND.store(true, Ordering::Relaxed);
                *CLI_MISSING_AT.lock().unwrap_or_else(|e| e.into_inner()) = None;
                return out;
            }
        }
    }
    CLI_FOUND.store(false, Ordering::Relaxed);
    *CLI_MISSING_AT.lock().unwrap_or_else(|e| e.into_inner()) = Some(Instant::now());
    None
}

fn strs(v: &[&str]) -> Vec<String> {
    v.iter().map(|s| s.to_string()).collect()
}

/// `tailscale ip -4` — status 를 못 읽을 때의 보조 경로
pub fn cli_ip(force: bool) -> Option<IpAddr> {
    run_cli(&strs(&["ip", "-4"]), CLI_TIMEOUT, force)?.lines().next().and_then(|l| l.trim().parse().ok())
}

#[derive(Deserialize)]
struct RawPeer {
    #[serde(rename = "DNSName", default)]
    dns_name: String,
    #[serde(rename = "TailscaleIPs", default)]
    tailscale_ips: Option<Vec<String>>,
    #[serde(rename = "Online", default)]
    online: bool,
    #[serde(rename = "LastSeen", default)]
    last_seen: Option<String>,
    #[serde(rename = "HostName", default)]
    host_name: String,
    #[serde(rename = "OS", default)]
    os: String,
}

#[derive(Deserialize)]
struct RawStatus {
    #[serde(rename = "BackendState", default)]
    backend_state: String,
    #[serde(rename = "CertDomains", default)]
    cert_domains: Option<Vec<String>>,
    #[serde(rename = "Self", default)]
    self_node: Option<RawPeer>,
    #[serde(rename = "Peer", default)]
    peer: Option<HashMap<String, RawPeer>>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct TsPeer {
    pub ips: Vec<IpAddr>,
    pub online: bool,
    /// RFC3339. 온라인이거나 기록이 없으면(0001-01-01) None
    pub last_seen: Option<String>,
    pub host_name: String,
    pub os: String,
}

impl TsPeer {
    /// 마법사 '폰 Tailscale' 단계 대상
    pub fn is_phone(&self) -> bool {
        self.os.eq_ignore_ascii_case("android") || self.os.eq_ignore_ascii_case("ios")
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct TsStatus {
    pub backend_state: String,
    pub running: bool,
    pub dns_name: Option<String>,
    pub cert_domains: Vec<String>,
    pub self_ips: Vec<IpAddr>,
    pub peers: Vec<TsPeer>,
}

fn ips_of(v: &Option<Vec<String>>) -> Vec<IpAddr> {
    v.iter().flatten().filter_map(|s| s.parse().ok()).collect()
}

pub fn parse_status(json: &str) -> Option<TsStatus> {
    let raw: RawStatus = serde_json::from_str(json).ok()?;
    let me = raw.self_node.as_ref();
    let dns = me.map(|p| p.dns_name.trim_end_matches('.').to_string()).filter(|s| !s.is_empty());
    Some(TsStatus {
        running: raw.backend_state == "Running",
        backend_state: raw.backend_state.clone(),
        dns_name: dns,
        cert_domains: raw
            .cert_domains
            .unwrap_or_default()
            .into_iter()
            .map(|d| d.trim_end_matches('.').to_string())
            .filter(|d| !d.is_empty())
            .collect(),
        self_ips: me.map(|p| ips_of(&p.tailscale_ips)).unwrap_or_default(),
        peers: raw
            .peer
            .unwrap_or_default()
            .into_values()
            .map(|p| TsPeer {
                ips: ips_of(&p.tailscale_ips),
                online: p.online,
                last_seen: p.last_seen.filter(|s| !s.starts_with("0001-")),
                host_name: if p.host_name.is_empty() {
                    p.dns_name.split('.').next().unwrap_or_default().to_string()
                } else {
                    p.host_name
                },
                os: p.os,
            })
            .collect(),
    })
}

impl TsStatus {
    /// HTTPS 인증서를 받을 수 있는 이 기기의 이름 — admin 에서 HTTPS 를 켜야 CertDomains 가 생긴다
    pub fn https_host(&self) -> Option<String> {
        if !self.running || self.cert_domains.is_empty() {
            return None;
        }
        match &self.dns_name {
            Some(d) if self.cert_domains.iter().any(|c| c.eq_ignore_ascii_case(d)) => Some(d.clone()),
            _ => self.cert_domains.first().cloned(),
        }
    }

    pub fn self_ipv4(&self) -> Option<IpAddr> {
        self.self_ips.iter().copied().find(|ip| ip.is_ipv4() && auth::is_cgnat(ip))
    }

    /// 기기 IP 로 피어를 찾아 (온라인, 마지막 접속). 모르는 IP 면 None
    pub fn peer_state(&self, ip: &IpAddr) -> Option<(bool, Option<String>)> {
        self.peers.iter().find(|p| p.ips.contains(ip)).map(|p| (p.online, p.last_seen.clone()))
    }
}

pub fn status(force: bool) -> Option<TsStatus> {
    parse_status(&run_cli(&strs(&["status", "--json"]), CLI_TIMEOUT, force)?)
}

/// `serve status --json` 에 우리 매핑(<host>:7443 → http://127.0.0.1:<port>)이 있는가
pub fn serve_mapped_in(json: &str, local_port: u16) -> bool {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(json) else { return false };
    let want = format!("http://127.0.0.1:{}", local_port);
    let suffix = format!(":{}", HTTPS_PORT);
    v.get("Web").and_then(|w| w.as_object()).is_some_and(|web| {
        web.iter().filter(|(k, _)| k.ends_with(&suffix)).any(|(_, site)| {
            site.get("Handlers").and_then(|h| h.as_object()).is_some_and(|hs| {
                hs.values().any(|h| h.get("Proxy").and_then(|p| p.as_str()) == Some(want.as_str()))
            })
        })
    })
}

/// 매핑 확인 — CLI 를 못 읽으면 None (판단 보류)
pub fn serve_mapped(local_port: u16) -> Option<bool> {
    run_cli(&strs(&["serve", "status", "--json"]), CLI_TIMEOUT, false).map(|j| serve_mapped_in(&j, local_port))
}

pub fn serve_on_args(local_port: u16) -> Vec<String> {
    vec![
        "serve".into(),
        "--bg".into(),
        format!("--https={}", HTTPS_PORT),
        format!("http://127.0.0.1:{}", local_port),
    ]
}

/// 우리 포트 매핑만 끈다 — `serve reset` 은 사용자의 다른 serve 설정까지 지우므로 쓰지 않는다
pub fn serve_off_args() -> Vec<String> {
    vec!["serve".into(), format!("--https={}", HTTPS_PORT), "off".into()]
}

pub fn serve_on(local_port: u16) -> Result<(), String> {
    run_cli(&serve_on_args(local_port), SERVE_TIMEOUT, true)
        .map(|_| ())
        .ok_or_else(|| "tailscale serve 설정 실패 — Tailscale 관리 페이지에서 HTTPS 가 켜져 있는지 확인하세요".into())
}

pub fn serve_off() {
    let _ = run_cli(&serve_off_args(), CLI_TIMEOUT, false);
}

/// 지난 실행이 남긴 우리 매핑만 지운다 — 매핑이 없거나 남의 것(다른 포트 대상)이면 손대지 않는다
pub fn serve_cleanup_stale(local_port: u16) {
    if serve_mapped(local_port) == Some(true) {
        serve_off();
    }
}

pub fn https_url(host: &str) -> String {
    format!("https://{}:{}", host, HTTPS_PORT)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = r#"{
      "BackendState": "Running",
      "CertDomains": ["mac.tail1234.ts.net"],
      "Self": { "DNSName": "mac.tail1234.ts.net.", "TailscaleIPs": ["100.120.51.80", "fd7a::1"], "Online": true },
      "Peer": {
        "k1": { "DNSName": "fold.tail1234.ts.net.", "TailscaleIPs": ["100.72.45.122"], "Online": true,
                "LastSeen": "0001-01-01T00:00:00Z" },
        "k2": { "DNSName": "ipad.tail1234.ts.net.", "TailscaleIPs": ["100.80.1.2"], "Online": false,
                "LastSeen": "2026-10-01T12:00:00Z" }
      }
    }"#;

    #[test]
    fn parses_cert_domains_and_https_host() {
        let s = parse_status(SAMPLE).unwrap();
        assert!(s.running);
        assert_eq!(s.dns_name.as_deref(), Some("mac.tail1234.ts.net"));
        assert_eq!(s.https_host().as_deref(), Some("mac.tail1234.ts.net"));
        assert_eq!(s.self_ipv4(), Some("100.120.51.80".parse().unwrap()));
        // 인증서 미활성(null)이면 HTTPS 불가
        let off = parse_status(&SAMPLE.replace(r#"["mac.tail1234.ts.net"]"#, "null")).unwrap();
        assert_eq!(off.https_host(), None);
        // 데몬이 멈춰 있으면 CertDomains 가 있어도 불가
        let stopped = parse_status(&SAMPLE.replace("\"Running\"", "\"Stopped\"")).unwrap();
        assert_eq!(stopped.https_host(), None);
        assert!(parse_status("not json").is_none());
        // 필드가 빠진 최소 JSON 도 받아들인다
        assert!(parse_status("{}").is_some());
    }

    #[test]
    fn peer_state_matches_by_ip() {
        let s = parse_status(SAMPLE).unwrap();
        assert_eq!(s.peer_state(&"100.72.45.122".parse().unwrap()), Some((true, None)));
        assert_eq!(
            s.peer_state(&"100.80.1.2".parse().unwrap()),
            Some((false, Some("2026-10-01T12:00:00Z".into())))
        );
        assert_eq!(s.peer_state(&"100.99.9.9".parse().unwrap()), None);
    }

    #[test]
    fn host_state_and_phones() {
        let run = parse_status(SAMPLE).unwrap();
        assert_eq!(host_state(true, true, Some(&run)), "running");
        let login = parse_status(&SAMPLE.replace("\"Running\"", "\"NeedsLogin\"")).unwrap();
        assert_eq!(host_state(true, true, Some(&login)), "needs-login");
        let stop = parse_status(&SAMPLE.replace("\"Running\"", "\"Stopped\"")).unwrap();
        assert_eq!(host_state(true, false, Some(&stop)), "stopped");
        assert_eq!(host_state(true, false, None), "stopped", "CLI 는 있는데 응답 없음");
        assert_eq!(host_state(false, true, None), "stopped", "앱만 설치");
        assert_eq!(host_state(false, false, None), "missing");
        let phones = parse_status(&SAMPLE.replace(
            r#""Online": true,
                "LastSeen""#,
            r#""Online": true, "OS": "android", "HostName": "Galaxy Z Fold",
                "LastSeen""#,
        ))
        .unwrap();
        let p: Vec<_> = phones.peers.iter().filter(|p| p.is_phone()).collect();
        assert_eq!(p.len(), 1);
        assert_eq!(p[0].host_name, "Galaxy Z Fold");
        // HostName 이 없으면 DNSName 첫 마디
        assert!(run.peers.iter().any(|p| p.host_name == "ipad"));
    }

    #[test]
    fn open_app_command_per_os() {
        assert_eq!(open_app_command("macos"), Some(("open".into(), vec!["-a".into(), "Tailscale".into()])));
        assert!(open_app_command("windows").unwrap().0.ends_with("tailscale-ipn.exe"));
        assert_eq!(open_app_command("linux"), None);
    }

    #[test]
    fn serve_status_detects_our_mapping() {
        let j = r#"{"TCP":{"7443":{"HTTPS":true}},"Web":{"mac.t.ts.net:7443":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:7788"}}}}}"#;
        assert!(serve_mapped_in(j, 7788));
        assert!(!serve_mapped_in(j, 7789), "다른 포트 대상이면 우리 것 아님");
        let other = r#"{"Web":{"mac.t.ts.net:443":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:7788"}}}}}"#;
        assert!(!serve_mapped_in(other, 7788), "443 매핑은 사용자 것");
        assert!(!serve_mapped_in("{}", 7788) && !serve_mapped_in("x", 7788));
    }

    #[test]
    fn cli_missing_cache_expires() {
        let t0 = Instant::now();
        assert!(!missing_cached(None, t0));
        assert!(missing_cached(Some(t0), t0 + Duration::from_secs(29)));
        assert!(!missing_cached(Some(t0), t0 + CLI_MISSING_TTL));
        assert_eq!(CANDIDATES.last(), Some(&"tailscale"), "PATH 이름은 마지막");
    }

    #[test]
    fn serve_commands_touch_only_our_port() {
        assert_eq!(serve_on_args(7788), ["serve", "--bg", "--https=7443", "http://127.0.0.1:7788"]);
        assert_eq!(serve_off_args(), ["serve", "--https=7443", "off"]);
        assert_eq!(https_url("mac.ts.net"), "https://mac.ts.net:7443");
    }
}
