// 업데이트 재시작 후 자동 이어하기 — 탭마다 실행 중인 에이전트(claude/codex)를 판별하고
// 재시작 뒤 그 탭에 입력할 재개 명령을 만든다.
//
// 판별 근거(unix): PTY 의 전경 프로세스 그룹. 셸이 전경이면 에이전트가 없는 것이다.
// 실행 중인 Claude Code 는 프로세스 제목을 `Claude` 로 덮어써 ps 로 플래그를 읽을 수 없다 —
// 그래서 플래그는 사용자가 셸에서 실행한 명령 줄(프론트가 note_agent_command 로 알림)에서 가져온다.
// 순수 파서는 unix 조회 경로에서만 쓰인다 — Windows 빌드의 미사용 경고를 막는다
#![cfg_attr(not(unix), allow(dead_code))]
use crate::store::ResumeEntry;
use std::collections::{HashMap, HashSet};

#[derive(Clone, Copy, PartialEq, Eq, Debug, Hash)]
pub enum Agent {
    Claude,
    Codex,
}

/// 재개 명령을 만들 탭 하나의 스냅샷 (PtyManager 가 채운다)
pub struct ResumeTarget {
    pub id: String,
    pub cwd: String, // 셸을 띄운 경로
    pub agent_cmd: Option<String>,
    pub shell_pid: Option<u32>,
    pub fg_pgid: Option<i32>,
    pub created_at_ms: u64, // 이보다 오래된 훅 기록은 이전 실행(같은 id 로 복원되기 전)의 것이다
}

/// 판별된 에이전트 하나 — 세션 id 배정 전 단계
#[derive(Clone, Debug)]
pub struct Detected {
    pub id: String,
    pub agent: Agent,
    pub proc_cwd: Option<String>, // 에이전트 프로세스의 실제 작업 경로 (unix 에서만)
    pub spawn_cwd: String,
    pub agent_cmd: Option<String>,
    pub hook_sid: Option<String>,
}

impl Detected {
    /// 기록 조회 기준 경로 — 에이전트가 다른 폴더로 cd 한 뒤 실행됐으면 그 폴더가 기록의 키다
    fn history_cwd(&self) -> &str {
        self.proc_cwd.as_deref().unwrap_or(&self.spawn_cwd)
    }
}

/// 공백 열 n 개를 떼고 남은 꼬리(공백 포함 가능)를 돌려준다 — ps 의 마지막 열(comm/args)은 공백을 품는다
pub fn split_fields(line: &str, n: usize) -> Option<(Vec<&str>, &str)> {
    let mut rest = line.trim_start();
    let mut fields = Vec::with_capacity(n);
    for _ in 0..n {
        let end = rest.find(char::is_whitespace)?;
        fields.push(&rest[..end]);
        rest = rest[end..].trim_start();
    }
    Some((fields, rest.trim_end()))
}

/// `ps -axo pid=,pgid=,comm=` → (pid, pgid, comm).
/// comm 을 중간 열에 두면 16자로 잘리므로(실측: `/Applications/Ch`) 반드시 마지막 열로 받는다.
pub fn parse_pid_pgid_comm(text: &str) -> Vec<(u32, i32, String)> {
    text.lines()
        .filter_map(|l| {
            let (f, rest) = split_fields(l, 2)?;
            Some((f[0].parse().ok()?, f[1].parse().ok()?, rest.to_string()))
        })
        .collect()
}

/// `ps -axo pid=,args=` → pid → args
pub fn parse_pid_args(text: &str) -> HashMap<u32, String> {
    text.lines()
        .filter_map(|l| {
            let (f, rest) = split_fields(l, 1)?;
            Some((f[0].parse().ok()?, rest.to_string()))
        })
        .collect()
}

fn basename(s: &str) -> &str {
    s.rsplit(['/', '\\']).next().unwrap_or(s)
}

fn agent_by_name(name: &str) -> Option<Agent> {
    match name {
        "claude" | "Claude" => Some(Agent::Claude),
        "codex" => Some(Agent::Codex),
        _ => None,
    }
}

// 스크립트형 설치(npm 의 node 래퍼 등)는 인터프리터가 첫 토큰이고 실제 명령은 둘째 토큰이다
const INTERPRETERS: &[&str] = &["node", "bun", "deno", "sh", "bash", "zsh", "dash"];

/// 프로세스 하나가 어떤 에이전트인지. 데스크톱 앱 번들 안의 동명 바이너리
/// (`/Applications/ChatGPT.app/.../codex`, Claude 데스크톱 앱)는 터미널 에이전트가 아니다.
pub fn classify_process(comm: &str, args: &str) -> Option<Agent> {
    let mut toks = args.split_whitespace();
    let first = toks.next().unwrap_or("");
    if comm.contains(".app/Contents") || first.contains(".app/Contents") {
        return None;
    }
    if args.contains("@anthropic-ai/claude-code") {
        return Some(Agent::Claude);
    }
    if args.contains("@openai/codex") {
        return Some(Agent::Codex);
    }
    if let Some(a) = agent_by_name(basename(comm)).or_else(|| agent_by_name(basename(first))) {
        return Some(a);
    }
    if INTERPRETERS.contains(&basename(first)) {
        if let Some(second) = toks.next() {
            return agent_by_name(basename(second));
        }
    }
    None
}

/// 전경 프로세스 그룹에서 에이전트를 찾는다 → (종류, 그 프로세스 pid).
/// 셸 자신이 전경이면(프롬프트 대기) 에이전트가 없다.
pub fn detect_agent(
    rows: &[(u32, i32, String)],
    args: &HashMap<u32, String>,
    fg_pgid: i32,
    shell_pid: Option<u32>,
) -> Option<(Agent, u32)> {
    if fg_pgid <= 0 || shell_pid.is_some_and(|p| p as i32 == fg_pgid) {
        return None;
    }
    let mut members: Vec<&(u32, i32, String)> = rows.iter().filter(|r| r.1 == fg_pgid).collect();
    members.sort_by_key(|r| r.0);
    members.into_iter().find_map(|(pid, _, comm)| {
        let a = args.get(pid).map(String::as_str).unwrap_or(comm.as_str());
        classify_process(comm, a).map(|agent| (agent, *pid))
    })
}

/// `lsof -Fpn` 출력 → [(pid, n 값)]. cwd 조회·LISTEN 포트 조회가 같은 형식을 쓴다
pub fn parse_lsof_pn(text: &str) -> Vec<(u32, String)> {
    let mut out = Vec::new();
    let mut pid: Option<u32> = None;
    for line in text.lines() {
        if let Some(p) = line.strip_prefix('p') {
            pid = p.trim().parse().ok();
        } else if let Some(n) = line.strip_prefix('n') {
            if let Some(p) = pid {
                out.push((p, n.to_string()));
            }
        }
    }
    out
}

/// 셸식 토큰화 — 작은/큰따옴표와 역슬래시 이스케이프만 처리한다
pub fn tokenize(line: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut has = false;
    let mut quote: Option<char> = None;
    let mut chars = line.chars();
    while let Some(c) = chars.next() {
        match quote {
            Some(q) if c == q => quote = None,
            Some('"') if c == '\\' => {
                if let Some(n) = chars.next() {
                    cur.push(n);
                }
            }
            Some(_) => cur.push(c),
            None if c == '\'' || c == '"' => {
                quote = Some(c);
                has = true;
            }
            None if c == '\\' => {
                if let Some(n) = chars.next() {
                    cur.push(n);
                    has = true;
                }
            }
            None if c.is_whitespace() => {
                if has {
                    out.push(std::mem::take(&mut cur));
                    has = false;
                }
            }
            None => {
                cur.push(c);
                has = true;
            }
        }
    }
    if has {
        out.push(cur);
    }
    out
}

/// 플래그 값은 모델 이름·모드 같은 단순 토큰만 — 셸에 다시 입력되는 문자열이라 메타문자를 막는다
fn safe_value(v: &str) -> bool {
    !v.is_empty()
        && !v.starts_with('-')
        && v.chars().all(|c| c.is_ascii_alphanumeric() || "._:/=-".contains(c))
}

/// 기록된 실행 명령 줄에서 재개 때 유지할 플래그만 남긴다.
/// 허용 목록 밖의 플래그·위치 인자(첫 프롬프트)·기존 resume/continue 인자는 버린다.
pub fn allowed_flags(agent: Agent, line: &str) -> Vec<String> {
    let toks = tokenize(line);
    let (name, bools, vals): (&str, &[&str], &[&str]) = match agent {
        Agent::Claude => (
            "claude",
            &["--dangerously-skip-permissions", "--allow-dangerously-skip-permissions"],
            &["--permission-mode", "--model"],
        ),
        Agent::Codex => (
            "codex",
            &["--yolo", "--dangerously-bypass-approvals-and-sandbox", "--full-auto"],
            &["-m", "--model", "-a", "--ask-for-approval", "-s", "--sandbox"],
        ),
    };
    if toks.first().map(String::as_str) != Some(name) {
        return Vec::new();
    }
    let mut out = Vec::new();
    let mut i = 1;
    while i < toks.len() {
        let t = toks[i].as_str();
        if bools.contains(&t) {
            out.push(t.to_string());
            i += 1;
        } else if vals.contains(&t) {
            if let Some(v) = toks.get(i + 1).filter(|v| safe_value(v)) {
                out.push(t.to_string());
                out.push(v.clone());
            }
            i += 2;
        } else if let Some((k, v)) = t.split_once('=').filter(|(k, _)| k.starts_with("--") && vals.contains(k)) {
            if safe_value(v) {
                out.push(k.to_string());
                out.push(v.to_string());
            }
            i += 1;
        } else {
            i += 1;
        }
    }
    out
}

/// 셸 작은따옴표 인용 (내부의 ' 는 '\'' 로)
pub fn sh_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

fn same_dir(a: &str, b: &str) -> bool {
    let t = |s: &str| s.trim_end_matches(['/', '\\']).to_string();
    t(a) == t(b)
}

/// 재개 명령. 에이전트가 셸 시작 경로와 다른 폴더에서 돌고 있었으면 그 폴더로 먼저 이동한다
/// (기록은 경로 기준으로 저장되므로 다른 폴더에서 --resume 하면 세션을 못 찾는다)
pub fn build_resume_command(
    agent: Agent,
    flags: &[String],
    session_id: &str,
    proc_cwd: Option<&str>,
    spawn_cwd: &str,
) -> String {
    let flag_str: String = flags.iter().map(|f| format!(" {f}")).collect();
    let base = match agent {
        Agent::Claude => format!("claude{flag_str} --resume {session_id}"),
        Agent::Codex => format!("codex{flag_str} resume {session_id}"),
    };
    match proc_cwd {
        Some(c) if !same_dir(c, spawn_cwd) => format!("cd {} && {}", sh_quote(c), base),
        _ => base,
    }
}

/// 8-4-4-4-12 16진 UUID — 이 값은 셸 명령에 그대로 들어간다
pub fn is_uuid(s: &str) -> bool {
    s.len() == 36
        && s.char_indices().all(|(i, c)| {
            if matches!(i, 8 | 13 | 18 | 23) {
                c == '-'
            } else {
                c.is_ascii_hexdigit()
            }
        })
}

/// 탭마다 재개할 세션 id 를 배정한다.
/// 훅이 기록한 id(그 탭에서 실제로 돌던 세션)를 먼저 확정하고, 나머지는 같은 경로의 기록을
/// 최신순으로 중복 없이 나눠 준다 — 같은 대화를 두 탭에서 재개하면 기록이 엉킨다.
/// history: (종류, 경로) → 최신순 세션 id 목록
pub fn assign_sessions(
    detected: &[Detected],
    history: &HashMap<(Agent, String), Vec<String>>,
) -> Vec<ResumeEntry> {
    let mut claimed: HashSet<String> = HashSet::new();
    let mut picked: Vec<Option<String>> = vec![None; detected.len()];
    for (i, d) in detected.iter().enumerate() {
        if let Some(sid) = d.hook_sid.as_ref().filter(|s| is_uuid(s)) {
            if claimed.insert(sid.clone()) {
                picked[i] = Some(sid.clone());
            }
        }
    }
    for (i, d) in detected.iter().enumerate() {
        if picked[i].is_some() {
            continue;
        }
        let key = (d.agent, d.history_cwd().to_string());
        if let Some(ids) = history.get(&key) {
            if let Some(sid) = ids.iter().find(|s| is_uuid(s) && !claimed.contains(*s)) {
                claimed.insert(sid.clone());
                picked[i] = Some(sid.clone());
            }
        }
    }
    detected
        .iter()
        .zip(picked)
        .filter_map(|(d, sid)| {
            let sid = sid?;
            let flags = d.agent_cmd.as_deref().map(|l| allowed_flags(d.agent, l)).unwrap_or_default();
            Some(ResumeEntry {
                session_id: d.id.clone(),
                command: build_resume_command(d.agent, &flags, &sid, d.proc_cwd.as_deref(), &d.spawn_cwd),
            })
        })
        .collect()
}

/// 프론트가 알리는 줄이 에이전트 실행 명령인가 (`claude ...` / `codex ...`)
pub fn is_agent_command_line(line: &str) -> bool {
    let first = line.split_whitespace().next().unwrap_or("");
    agent_by_name(first).is_some() && first != "Claude"
}

// ── 시스템 조회 (unix) ──

/// 외부 도구 한 번의 상한 — 멈춘 lsof(끊긴 네트워크 볼륨 등)가 업데이트·종료를 붙잡지 않게
#[cfg(unix)]
const TOOL_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(3);

/// GUI 앱은 PATH 가 빈약할 수 있어 절대 경로부터 시도한다. 로캘은 C 로 고정해 출력 형식을 고정한다.
/// 상한 시간을 넘기면 죽이고 결과 없음으로 본다
#[cfg(unix)]
pub fn run_tool(candidates: &[&str], args: &[&str]) -> Option<String> {
    use std::io::Read;
    use std::process::{Command, Stdio};
    for prog in candidates {
        let Ok(mut child) = Command::new(prog)
            .args(args)
            .env("LC_ALL", "C")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
        else {
            continue;
        };
        // 출력이 파이프 용량을 넘으면 읽어 주기 전엔 끝나지 않으므로 별도 스레드에서 비운다
        let mut out = child.stdout.take()?;
        let reader = std::thread::spawn(move || {
            let mut buf = Vec::new();
            let _ = out.read_to_end(&mut buf);
            buf
        });
        let deadline = std::time::Instant::now() + TOOL_TIMEOUT;
        loop {
            match child.try_wait() {
                Ok(Some(_)) => break,
                Ok(None) if std::time::Instant::now() < deadline => {
                    std::thread::sleep(std::time::Duration::from_millis(10))
                }
                _ => {
                    let _ = child.kill();
                    let _ = child.wait();
                    let _ = reader.join();
                    return None;
                }
            }
        }
        // lsof 는 일부 pid 가 사라졌을 때 1 을 돌려주지만 나머지 결과는 유효하다
        let buf = reader.join().ok()?;
        return Some(String::from_utf8_lossy(&buf).into_owned());
    }
    None
}

#[cfg(unix)]
pub const PS: &[&str] = &["/bin/ps", "ps"];
#[cfg(unix)]
pub const LSOF: &[&str] = &["/usr/sbin/lsof", "/usr/bin/lsof", "lsof"];

/// 프로세스의 현재 작업 경로
#[cfg(unix)]
pub fn process_cwd(pid: u32) -> Option<String> {
    let text = run_tool(LSOF, &["-w", "-n", "-P", "-a", "-p", &pid.to_string(), "-d", "cwd", "-Fpn"])?;
    parse_lsof_pn(&text).into_iter().find(|(p, _)| *p == pid).map(|(_, n)| n)
}

/// 전경 에이전트 판별 → [(타깃 인덱스, 종류, 프로세스 cwd)]. ps 는 한 번만 읽는다
#[cfg(unix)]
pub fn probe_agents(targets: &[ResumeTarget]) -> Vec<(usize, Agent, Option<String>)> {
    let need = targets.iter().any(|t| match (t.fg_pgid, t.shell_pid) {
        (Some(g), Some(s)) => g != s as i32,
        (Some(_), None) => true,
        _ => false,
    });
    if !need {
        return Vec::new();
    }
    let Some(rows_text) = run_tool(PS, &["-axo", "pid=,pgid=,comm="]) else { return Vec::new() };
    let rows = parse_pid_pgid_comm(&rows_text);
    let args = run_tool(PS, &["-axo", "pid=,args="]).map(|t| parse_pid_args(&t)).unwrap_or_default();
    targets
        .iter()
        .enumerate()
        .filter_map(|(i, t)| {
            let (agent, pid) = detect_agent(&rows, &args, t.fg_pgid?, t.shell_pid)?;
            Some((i, agent, process_cwd(pid)))
        })
        .collect()
}

/// Windows 는 전경 프로세스 그룹 개념이 없어 이 PTY 가 생긴 뒤 훅이 Claude 세션을 기록한 탭만 Claude 로 본다
#[cfg(not(unix))]
pub fn probe_agents(targets: &[ResumeTarget]) -> Vec<(usize, Agent, Option<String>)> {
    targets
        .iter()
        .enumerate()
        .filter(|(_, t)| crate::hooks::claude_session_of(t.id.clone()).is_some() && hook_is_fresh(t))
        .map(|(i, _)| (i, Agent::Claude, None))
        .collect()
}

#[cfg(not(unix))]
fn hook_is_fresh(t: &ResumeTarget) -> bool {
    crate::hooks::state_ts(&t.id).is_some_and(|ts| ts > t.created_at_ms)
}

/// 작업 중 판정 후보 (실행·허가 대기 상태인 탭)
pub struct BusyCandidate {
    pub title: String,
    pub hook_seen: bool,
    pub target: ResumeTarget,
}

/// 실행·허가 대기 중인 탭 가운데 에이전트 탭만 '작업 중'으로 본다 → [(id, 제목)].
/// 출력만으로는 `npm run dev` 같은 셸 작업도 running 이라, 업데이트 대기·종료 확인이 끝없이 걸린다.
/// 훅이 살아 있는 탭은 바로 인정하고, 나머지는 전경 프로세스로 판별한다(unix)
pub fn agent_busy(cands: Vec<BusyCandidate>) -> Vec<(String, String)> {
    let (hooked, rest): (Vec<_>, Vec<_>) = cands.into_iter().partition(|c| c.hook_seen);
    let targets: Vec<ResumeTarget> = rest.iter().map(|c| clone_target(&c.target)).collect();
    let probed: HashSet<usize> = if targets.is_empty() {
        HashSet::new()
    } else {
        probe_agents(&targets).into_iter().map(|(i, _, _)| i).collect()
    };
    hooked
        .into_iter()
        .map(|c| (c.target.id, c.title))
        .chain(
            rest.into_iter()
                .enumerate()
                .filter(|(i, _)| probed.contains(i))
                .map(|(_, c)| (c.target.id, c.title)),
        )
        .collect()
}

fn clone_target(t: &ResumeTarget) -> ResumeTarget {
    ResumeTarget {
        id: t.id.clone(),
        cwd: t.cwd.clone(),
        agent_cmd: t.agent_cmd.clone(),
        shell_pid: t.shell_pid,
        fg_pgid: t.fg_pgid,
        created_at_ms: t.created_at_ms,
    }
}

/// 업데이트 직전 호출 — 탭별 재개 명령 목록
pub async fn collect_resume_entries(targets: Vec<ResumeTarget>) -> Vec<ResumeEntry> {
    let (targets, probed) = tauri::async_runtime::spawn_blocking(move || {
        let probed = probe_agents(&targets);
        (targets, probed)
    })
    .await
    .unwrap_or_default();
    let detected: Vec<Detected> = probed
        .into_iter()
        .map(|(i, agent, proc_cwd)| {
            let t = &targets[i];
            Detected {
                id: t.id.clone(),
                agent,
                proc_cwd,
                spawn_cwd: t.cwd.clone(),
                agent_cmd: t.agent_cmd.clone(),
                hook_sid: if agent == Agent::Claude { crate::hooks::claude_session_of(t.id.clone()) } else { None },
            }
        })
        .collect();
    let mut history: HashMap<(Agent, String), Vec<String>> = HashMap::new();
    for d in &detected {
        let key = (d.agent, d.history_cwd().to_string());
        if history.contains_key(&key) {
            continue;
        }
        let ids = match d.agent {
            Agent::Claude => crate::claude::list_claude_sessions(key.1.clone()).await.into_iter().map(|s| s.id).collect(),
            Agent::Codex => crate::codex::list_codex_sessions(key.1.clone()).await.into_iter().map(|s| s.id).collect(),
        };
        history.insert(key, ids);
    }
    assign_sessions(&detected, &history)
}

/// 셸에서 Enter 로 낸 줄을 알린다 (업데이트 후 이어하기의 플래그 출처).
/// 에이전트 실행 줄이면 기억하고, 그 밖의 줄·빈 문자열(추적 불가한 줄)이면 지운다.
#[tauri::command]
pub fn note_agent_command(ptys: tauri::State<crate::pty::PtyManager>, session_id: String, line: String) {
    // Windows 는 셸 전경 판정이 없어 Claude 실행 중에 친 프롬프트도 여기로 온다 — 훅이 Claude 세션을
    // 기록 중인 동안은 무시한다
    #[cfg(not(unix))]
    if crate::hooks::claude_session_of(session_id.clone()).is_some() {
        return;
    }
    // 반드시 탭 id 형식이어야 한다 (파일 경로에 쓰이는 곳이 있다)
    if session_id.is_empty() || !session_id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return;
    }
    let line = line.trim();
    let keep = (line.len() <= 2000 && is_agent_command_line(line)).then_some(line);
    ptys.note_agent_command(&session_id, keep);
    crate::crash::poke();
}

#[cfg(test)]
mod tests {
    use super::*;

    // 실측 행을 본뜬 픽스처 (`ps -axo pid=,pgid=,comm=` / `ps -axo pid=,args=`)
    const PS_COMM: &str = "\
46886 46886 Claude
46235 46235 claude
47100 47100 /Users/u/.local/bin/codex
47200 47200 /bin/zsh
25553 25276 /Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex
48000 48000 /opt/homebrew/bin/node
48001 48000 /opt/homebrew/bin/node
";
    const PS_ARGS: &str = "\
46886 Claude
46235 claude --resume ae8e03ca-3ebb-4ad3-8187-b4faafd6abc3
47100 /Users/u/.local/bin/codex --yolo
47200 -zsh
25553 /Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex -c features.code_mode_host=true app-server
48000 node /opt/homebrew/bin/codex -m gpt-5
48001 node /some/worker.js
";

    #[test]
    fn classify_matches_measured_process_titles() {
        assert_eq!(classify_process("Claude", "Claude"), Some(Agent::Claude));
        assert_eq!(classify_process("claude", "claude --resume x"), Some(Agent::Claude));
        assert_eq!(classify_process("/Users/u/.local/bin/codex", "/Users/u/.local/bin/codex"), Some(Agent::Codex));
        assert_eq!(
            classify_process("node", "node /usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js"),
            Some(Agent::Claude)
        );
        assert_eq!(classify_process("/bin/sh", "/bin/sh /tmp/x/bin/claude"), Some(Agent::Claude));
        // 데스크톱 앱 번들 안의 동명 바이너리는 제외
        assert_eq!(
            classify_process(
                "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex",
                "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex app-server"
            ),
            None
        );
        assert_eq!(classify_process("/Applications/Claude.app/Contents/MacOS/Claude", "/Applications/Claude.app/Contents/MacOS/Claude"), None);
        assert_eq!(classify_process("bash", "bash ./run.sh"), None);
        assert_eq!(classify_process("zsh", "zsh -c until grep -q done log; do sleep 3; done"), None);
        assert_eq!(classify_process("/bin/zsh", "-zsh"), None);
    }

    #[test]
    fn detect_agent_uses_foreground_group_only() {
        let rows = parse_pid_pgid_comm(PS_COMM);
        let args = parse_pid_args(PS_ARGS);
        assert_eq!(rows.len(), 7);
        assert_eq!(args[&25553].split_whitespace().nth(1), Some("-c"));
        assert_eq!(detect_agent(&rows, &args, 46886, Some(1)), Some((Agent::Claude, 46886)));
        assert_eq!(detect_agent(&rows, &args, 47100, Some(1)), Some((Agent::Codex, 47100)));
        // node 래퍼 그룹: 래퍼가 codex 로 판별되고 워커는 무시
        assert_eq!(detect_agent(&rows, &args, 48000, Some(1)), Some((Agent::Codex, 48000)));
        // 셸 자신이 전경 = 프롬프트 대기
        assert_eq!(detect_agent(&rows, &args, 47200, Some(47200)), None);
        // 앱 번들 codex 는 전경이어도 제외
        assert_eq!(detect_agent(&rows, &args, 25276, Some(1)), None);
        assert_eq!(detect_agent(&rows, &args, 0, None), None);
    }

    #[test]
    fn split_fields_keeps_spaces_in_last_column() {
        let (f, rest) = split_fields("  483     1 Core Audio Driver (Parrot.driver) ", 2).unwrap();
        assert_eq!(f, vec!["483", "1"]);
        assert_eq!(rest, "Core Audio Driver (Parrot.driver)");
        assert!(split_fields("123", 2).is_none());
    }

    #[test]
    fn lsof_pn_parse() {
        let text = "p123\nfcwd\nn/Users/u/My Project\np124\nfcwd\nn/tmp\n";
        assert_eq!(
            parse_lsof_pn(text),
            vec![(123, "/Users/u/My Project".to_string()), (124, "/tmp".to_string())]
        );
    }

    #[test]
    fn flags_keep_allowlist_only() {
        let f = allowed_flags(Agent::Claude, "claude --dangerously-skip-permissions --model opus \"첫 프롬프트\" --resume abc -p x");
        assert_eq!(f, vec!["--dangerously-skip-permissions", "--model", "opus"]);
        let f = allowed_flags(Agent::Claude, "claude --permission-mode=acceptEdits --model 'a;rm -rf /'");
        assert_eq!(f, vec!["--permission-mode", "acceptEdits"], "위험한 값의 플래그는 통째로 버린다");
        let f = allowed_flags(Agent::Codex, "codex --yolo -m gpt-5.1-codex -a never -s workspace-write resume 0199");
        assert_eq!(f, vec!["--yolo", "-m", "gpt-5.1-codex", "-a", "never", "-s", "workspace-write"]);
        let f = allowed_flags(Agent::Codex, "codex --full-auto --model=o3 --sandbox");
        assert_eq!(f, vec!["--full-auto", "--model", "o3"], "값 없는 끝 플래그는 버린다");
        assert!(allowed_flags(Agent::Codex, "claude --yolo").is_empty(), "다른 에이전트의 명령 줄");
        assert!(allowed_flags(Agent::Claude, "claude --continue").is_empty());
        assert_eq!(allowed_flags(Agent::Claude, "claude --model -x"), Vec::<String>::new());
    }

    #[test]
    fn resume_command_and_cd_quoting() {
        let flags = vec!["--model".to_string(), "opus".to_string()];
        assert_eq!(
            build_resume_command(Agent::Claude, &flags, "id1", Some("/p/"), "/p"),
            "claude --model opus --resume id1"
        );
        assert_eq!(build_resume_command(Agent::Codex, &[], "id2", None, "/p"), "codex resume id2");
        assert_eq!(
            build_resume_command(Agent::Codex, &["--yolo".to_string()], "id3", Some("/p/it's sub"), "/p"),
            "cd '/p/it'\\''s sub' && codex --yolo resume id3"
        );
    }

    #[test]
    fn uuid_validation() {
        assert!(is_uuid("ae8e03ca-3ebb-4ad3-8187-b4faafd6abc3"));
        assert!(!is_uuid("ae8e03ca-3ebb-4ad3-8187-b4faafd6abc"));
        assert!(!is_uuid("ae8e03ca-3ebb-4ad3-8187-b4faafd6abcz"));
        assert!(!is_uuid("ae8e03ca;3ebb-4ad3-8187-b4faafd6abc3"));
    }

    #[test]
    fn assign_prefers_hook_ids_and_never_duplicates() {
        let u = |n: u8| format!("{:08x}-0000-4000-8000-{:012x}", n, n);
        let det = |id: &str, agent, cwd: &str, hook: Option<String>, cmd: Option<&str>| Detected {
            id: id.into(),
            agent,
            proc_cwd: Some(cwd.into()),
            spawn_cwd: "/p".into(),
            agent_cmd: cmd.map(str::to_string),
            hook_sid: hook,
        };
        let detected = vec![
            det("t1", Agent::Claude, "/p", None, Some("claude --dangerously-skip-permissions")),
            det("t2", Agent::Claude, "/p", Some(u(1)), None), // 훅 id 가 최신 기록과 같다
            det("t3", Agent::Codex, "/p/sub", None, Some("codex --yolo")),
            det("t4", Agent::Claude, "/p", Some("bad id".into()), None),
            det("t5", Agent::Claude, "/p", None, None), // 남은 기록 없음 → 제외
        ];
        let mut history = HashMap::new();
        history.insert((Agent::Claude, "/p".to_string()), vec![u(1), u(2), "junk".into(), u(3)]);
        history.insert((Agent::Codex, "/p/sub".to_string()), vec![u(9)]);
        let out = assign_sessions(&detected, &history);
        let got: Vec<(&str, &str)> = out.iter().map(|e| (e.session_id.as_str(), e.command.as_str())).collect();
        let c1 = format!("claude --dangerously-skip-permissions --resume {}", u(2));
        let c2 = format!("claude --resume {}", u(1));
        let c3 = format!("cd '/p/sub' && codex --yolo resume {}", u(9));
        let c4 = format!("claude --resume {}", u(3));
        assert_eq!(got, vec![("t1", c1.as_str()), ("t2", c2.as_str()), ("t3", c3.as_str()), ("t4", c4.as_str())]);
    }

    #[test]
    fn agent_busy_keeps_hooked_tabs_and_skips_shell_only_tabs() {
        let cand = |id: &str, hook_seen: bool, fg: Option<i32>, shell: Option<u32>| BusyCandidate {
            title: id.to_uppercase(),
            hook_seen,
            target: ResumeTarget { id: id.into(), cwd: "/".into(), agent_cmd: None, shell_pid: shell, fg_pgid: fg, created_at_ms: 0 },
        };
        // 훅이 살아 있는 탭은 판별 없이 작업 중, 셸이 전경인 탭(npm run dev 출력 등)은 제외
        let out = agent_busy(vec![cand("a", true, None, None), cand("b", false, Some(7), Some(7)), cand("c", false, None, Some(3))]);
        assert_eq!(out, vec![("a".to_string(), "A".to_string())]);
    }

    #[test]
    fn agent_command_line_filter() {
        assert!(is_agent_command_line("claude --yolo"));
        assert!(is_agent_command_line("codex"));
        assert!(!is_agent_command_line("claude-foo"));
        assert!(!is_agent_command_line("echo claude"));
        assert!(!is_agent_command_line(""));
    }

    // 실제 PTY 에 셸을 띄우고 임시 폴더의 가짜 `claude` 를 전경으로 실행해
    // 전경 pgid → ps 판별 → lsof cwd 경로가 실제 시스템에서 맞는지 본다.
    // PTY 를 열 수 없는 환경(CI 샌드박스 등)에서는 건너뛴다.
    #[cfg(unix)]
    #[test]
    fn real_pty_detects_foreground_fake_claude() {
        use portable_pty::{native_pty_system, CommandBuilder, PtySize};
        use std::io::{Read, Write};
        use std::time::{Duration, Instant};

        let base = std::env::temp_dir().join(format!("ta-resume-test-{}", std::process::id()));
        let bin = base.join("bin");
        let work = base.join("work dir");
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&bin).unwrap();
        std::fs::create_dir_all(&work).unwrap();
        let fake = bin.join("claude");
        std::fs::write(&fake, "#!/bin/sh\nsleep 20\n").unwrap();
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let work = work.canonicalize().unwrap(); // macOS: /var → /private/var (lsof 는 실경로를 준다)

        let Ok(pair) = native_pty_system().openpty(PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 }) else {
            eprintln!("PTY 를 열 수 없어 건너뜀");
            let _ = std::fs::remove_dir_all(&base);
            return;
        };
        let mut cmd = CommandBuilder::new("/bin/sh");
        cmd.arg("-i");
        cmd.cwd(&base);
        cmd.env("ENV", "");
        cmd.env("PS1", "$ ");
        let Ok(mut child) = pair.slave.spawn_command(cmd) else {
            eprintln!("셸 실행 실패로 건너뜀");
            let _ = std::fs::remove_dir_all(&base);
            return;
        };
        drop(pair.slave);
        // 출력을 계속 비워야 셸이 쓰기에서 막히지 않는다
        let mut reader = pair.master.try_clone_reader().unwrap();
        std::thread::spawn(move || {
            let mut buf = [0u8; 4096];
            while matches!(reader.read(&mut buf), Ok(n) if n > 0) {}
        });
        let mut writer = pair.master.take_writer().unwrap();
        let shell_pid = child.process_id();
        let line = format!("cd {} && {}\n", sh_quote(&work.to_string_lossy()), sh_quote(&fake.to_string_lossy()));
        writer.write_all(line.as_bytes()).unwrap();
        writer.flush().unwrap();

        let deadline = Instant::now() + Duration::from_secs(10);
        let mut found = None;
        let mut last_fg = None;
        while Instant::now() < deadline {
            if let Some(fg) = pair.master.process_group_leader() {
                last_fg = Some(fg);
                let target = ResumeTarget {
                    id: "t".into(),
                    cwd: base.to_string_lossy().into_owned(),
                    agent_cmd: None,
                    shell_pid,
                    fg_pgid: Some(fg),
                    created_at_ms: 0,
                };
                if let Some(hit) = probe_agents(&[target]).into_iter().next() {
                    found = Some(hit);
                    break;
                }
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        // 가짜 claude(전경 그룹)부터 정리 — 셸만 죽이면 sleep 이 고아로 남는다
        if let Some(fg) = last_fg.filter(|g| *g > 1 && Some(*g as u32) != shell_pid) {
            unsafe {
                libc::kill(-fg, libc::SIGKILL);
            }
        }
        let _ = child.kill();
        let _ = child.wait();
        let _ = std::fs::remove_dir_all(&base);

        let (idx, agent, cwd) = found.expect("10초 안에 전경 가짜 claude 를 찾지 못함");
        assert_eq!((idx, agent), (0, Agent::Claude));
        assert_eq!(cwd.as_deref(), Some(work.to_string_lossy().as_ref()));
        let cmd = build_resume_command(agent, &[], "id", cwd.as_deref(), &base.to_string_lossy());
        assert!(cmd.starts_with("cd '") && cmd.ends_with("&& claude --resume id"), "{cmd}");
    }
}
