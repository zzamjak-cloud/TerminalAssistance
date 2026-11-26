// 남은 백그라운드 프로세스 — 앱(또는 앱의 에이전트)이 띄웠다가 탭이 닫히며 고아가 된 프로세스 표시·종료.
//
// PTY 자식은 앱 종료 시 SIGHUP 으로 죽지만, 에이전트가 백그라운드로 띄운 서버·감시 루프
// (`bash ./run.sh` → `python3 serve.py`, `zsh -c 'until grep …; do sleep 3; done'`)는
// ppid=1, tty=`??` 로 살아남는다(실측). TA_SESSION_ID 환경변수가 보이거나 작업 경로가
// 등록 프로젝트 안인 것만 앱 출신으로 채택한다. 에이전트 자신의 상주 프로세스(codex app-server 데몬 등)는
// 사용자가 띄운 작업이 아니므로 제외한다. Windows 는 지원하지 않는다(빈 목록).
// 순수 파서는 unix 조회 경로에서만 쓰인다 — Windows 빌드의 미사용 경고를 막는다
#![cfg_attr(not(unix), allow(dead_code))]
use crate::i18n::{tr, trf};
use serde::Serialize;
use std::collections::{HashMap, HashSet};

#[derive(Clone, Debug, PartialEq)]
pub struct OrphanRow {
    pub pid: u32,
    pub ppid: u32,
    pub pgid: i32,
    pub tty: String,
    pub elapsed_s: u64, // 실행된 지 몇 초 — 같은 스냅샷의 앱 자신과 비교해 '앱보다 먼저 뜬 것'을 가린다
    pub started: String,
    pub user: String,
    pub comm: String,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Orphan {
    pub pgid: i32,
    pub pids: Vec<u32>,
    pub command: String,
    pub cwd: Option<String>,
    pub project_id: Option<String>,
    pub started_at: String,
    pub elapsed_sec: u64,
    pub ports: Vec<u16>,
    /// 묶인 프로세스 전체의 CPU 사용률 합(%)과 상주 메모리 합(KB)
    pub cpu: f32,
    pub rss_kb: u64,
    pub from_app: bool,
    /// 이 프로세스를 띄운 탭 id (TA_SESSION_ID)
    pub session_id: Option<String>,
    /// 그 탭이 지금도 열려 있다 — '남은 프로세스'가 아니라 열린 탭 소속으로 따로 보여 준다
    pub live_tab: bool,
    /// 그룹 리더와 다른 프로세스 그룹에 속한 자손 — 그룹 신호가 닿지 않아 따로 보낸다
    #[serde(skip)]
    pub outside_pids: Vec<u32>,
    /// 그룹 전체가 이 항목의 프로세스뿐이라 그룹 신호로 종료해도 안전한가
    #[serde(skip)]
    pub group_kill: bool,
}

pub const PS_ROW_FORMAT: &str = "pid=,ppid=,pgid=,tty=,etime=,lstart=,user=,comm=";

/// `ps -axo pid=,ppid=,pgid=,tty=,etime=,lstart=,user=,comm=` (LC_ALL=C) 파싱.
/// lstart 는 `Thu Nov  5 21:45:53 2026` 처럼 공백 5토큰, comm 은 공백을 품을 수 있어 마지막 열이다.
pub fn parse_ps_rows(text: &str) -> Vec<OrphanRow> {
    text.lines()
        .filter_map(|l| {
            let (f, comm) = crate::resume::split_fields(l, 11)?;
            Some(OrphanRow {
                pid: f[0].parse().ok()?,
                ppid: f[1].parse().ok()?,
                pgid: f[2].parse().ok()?,
                tty: f[3].to_string(),
                elapsed_s: parse_etime(f[4])?,
                started: f[5..10].join(" "),
                user: f[10].to_string(),
                comm: comm.to_string(),
            })
        })
        .collect()
}

/// ps etime `[[dd-]hh:]mm:ss` → 초
pub fn parse_etime(s: &str) -> Option<u64> {
    let (days, rest) = match s.split_once('-') {
        Some((d, r)) => (d.parse::<u64>().ok()?, r),
        None => (0, s),
    };
    let parts: Vec<u64> = rest.split(':').map(|x| x.parse().ok()).collect::<Option<_>>()?;
    let (h, m, sec) = match parts.as_slice() {
        [m, s] => (0, *m, *s),
        [h, m, s] => (*h, *m, *s),
        _ => return None,
    };
    Some(days * 86400 + h * 3600 + m * 60 + sec)
}

/// `ps -axo pid=,%cpu=,rss=` → pid → (CPU%, RSS KB)
pub fn parse_stats(text: &str) -> HashMap<u32, (f32, u64)> {
    text.lines()
        .filter_map(|l| {
            let mut it = l.split_whitespace();
            let pid = it.next()?.parse().ok()?;
            let cpu = it.next()?.parse().ok()?;
            let rss = it.next()?.parse().ok()?;
            Some((pid, (cpu, rss)))
        })
        .collect()
}

/// 스캔하는 앱 자신에 관한 기준값
pub struct Me<'a> {
    pub pgid: i32,
    pub elapsed_s: u64,
    pub live: &'a HashSet<String>,
}

/// 시스템·앱 번들 소속 실행 파일 — 사용자가 띄운 작업이 아니다
pub fn excluded_path(comm: &str) -> bool {
    comm.contains(".app/Contents")
        || ["/System/", "/usr/libexec/", "/usr/sbin/", "/sbin/"].iter().any(|p| comm.starts_with(p))
}

/// 고아 후보: 내 계정, 부모가 init(1), 제어 터미널 없음(macOS `??`, Linux `?`), 시스템 경로 아님
pub fn is_candidate(r: &OrphanRow, user: &str, self_pid: u32) -> bool {
    r.user == user
        && r.ppid == 1
        && (r.tty == "??" || r.tty == "?")
        && r.pid != self_pid
        && !excluded_path(&r.comm)
}

/// `ps -E -o pid=,command= -p …` 출력 → pid → TA_SESSION_ID 값
pub fn parse_ta_env(text: &str) -> HashMap<u32, String> {
    text.lines()
        .filter_map(|l| {
            let (f, rest) = crate::resume::split_fields(l, 1)?;
            let v = rest.split_whitespace().find_map(|t| t.strip_prefix("TA_SESSION_ID="))?;
            Some((f[0].parse().ok()?, v.to_string()))
        })
        .collect()
}

/// 에이전트 도구 자체의 상주 프로세스 (`~/.codex/…/codex app-server daemon`, `~/.claude/…`, 앱 번들)
pub fn is_agent_infra(comm: &str, args: &str) -> bool {
    let first = args.split_whitespace().next().unwrap_or("");
    [comm, first]
        .iter()
        .any(|p| p.contains("/.codex/") || p.contains("/.claude/") || p.contains(".app/Contents"))
        || args.split_whitespace().any(|t| t == "app-server")
}

/// lsof LISTEN 주소(`*:8766`, `127.0.0.1:3000`, `[::1]:5173`) → 포트
pub fn parse_port(addr: &str) -> Option<u16> {
    addr.rsplit(':').next()?.parse().ok()
}

fn trim_dir(p: &str) -> &str {
    let t = p.trim_end_matches(['/', '\\']);
    if t.is_empty() { p } else { t }
}

/// cwd 를 담는 프로젝트 중 가장 깊은 것 (워크트리가 부모 안에 있어도 정확히 고른다)
pub fn project_for(cwd: &str, projects: &[(String, String)]) -> Option<String> {
    let c = trim_dir(cwd);
    projects
        .iter()
        .filter(|(_, path)| {
            let p = trim_dir(path);
            !p.is_empty() && (c == p || c.strip_prefix(p).is_some_and(|rest| rest.starts_with('/')))
        })
        .max_by_key(|(_, path)| trim_dir(path).len())
        .map(|(id, _)| id.clone())
}

/// 채택된 후보와 그 자손을 프로세스 그룹 단위로 묶는다 (포트는 호출부가 채운다)
pub fn build_orphans(
    rows: &[OrphanRow],
    args: &HashMap<u32, String>,
    candidates: &[u32],
    cwds: &HashMap<u32, String>,
    ta_env: &HashMap<u32, String>,
    projects: &[(String, String)],
    me: &Me,
) -> Vec<Orphan> {
    let self_pgid = me.pgid;
    let by_pid: HashMap<u32, &OrphanRow> = rows.iter().map(|r| (r.pid, r)).collect();
    let mut children: HashMap<u32, Vec<u32>> = HashMap::new();
    for r in rows {
        children.entry(r.ppid).or_default().push(r.pid);
    }
    let adopted: Vec<u32> = candidates
        .iter()
        .copied()
        .filter(|pid| {
            ta_env.contains_key(pid) || cwds.get(pid).is_some_and(|c| project_for(c, projects).is_some())
        })
        .filter(|pid| by_pid.get(pid).is_some_and(|r| r.pgid > 1 && r.pgid != self_pgid))
        .filter(|pid| {
            let r = by_pid[pid];
            !is_agent_infra(&r.comm, args.get(pid).map(String::as_str).unwrap_or(""))
        })
        .collect();

    // pgid → (채택 후보들, 자손 포함 전체 pid)
    let mut groups: Vec<(i32, Vec<u32>, HashSet<u32>)> = Vec::new();
    for pid in adopted {
        let pgid = by_pid[&pid].pgid;
        let mut all = HashSet::new();
        let mut stack = vec![pid];
        while let Some(p) = stack.pop() {
            if all.insert(p) {
                stack.extend(children.get(&p).into_iter().flatten().copied());
            }
        }
        match groups.iter_mut().find(|g| g.0 == pgid) {
            Some(g) => {
                g.1.push(pid);
                g.2.extend(all);
            }
            None => groups.push((pgid, vec![pid], all)),
        }
    }

    let mut out: Vec<Orphan> = groups
        .into_iter()
        .map(|(pgid, mut heads, all)| {
            heads.sort_unstable();
            // 대표: 그룹 리더가 후보면 리더, 아니면 가장 먼저 뜬(작은 pid) 후보
            let rep = if heads.contains(&(pgid as u32)) { pgid as u32 } else { heads[0] };
            let row = by_pid[&rep];
            let cwd = heads.iter().find_map(|p| cwds.get(p)).cloned();
            let mut pids: Vec<u32> = all.into_iter().collect();
            pids.sort_unstable();
            let members: HashSet<u32> = rows.iter().filter(|r| r.pgid == pgid).map(|r| r.pid).collect();
            let session_id = std::iter::once(&rep).chain(pids.iter()).find_map(|p| ta_env.get(p)).cloned();
            Orphan {
                pgid,
                group_kill: members.iter().all(|p| pids.contains(p)),
                outside_pids: pids.iter().copied().filter(|p| !members.contains(p)).collect(),
                // 복원된 탭은 지난 실행과 같은 id 를 쓴다 — 앱보다 먼저 뜬 프로세스는 같은 id 라도
                // 지난 실행(비정상 종료 등)이 남긴 것이다
                live_tab: row.elapsed_s < me.elapsed_s && session_id.as_ref().is_some_and(|id| me.live.contains(id)),
                session_id,
                command: args.get(&rep).cloned().unwrap_or_else(|| row.comm.clone()),
                project_id: cwd.as_deref().and_then(|c| project_for(c, projects)),
                cwd,
                started_at: row.started.clone(),
                elapsed_sec: row.elapsed_s,
                ports: Vec::new(),
                cpu: 0.0,
                rss_kb: 0,
                from_app: pids.iter().any(|p| ta_env.contains_key(p)),
                pids,
            }
        })
        .collect();
    out.sort_by_key(|o| o.pgid);
    out
}

/// CPU·메모리를 합산해 붙이고 메모리 많은 순으로 정렬한다 — 자원을 많이 먹는 것부터 보이게
pub fn attach_stats(orphans: &mut Vec<Orphan>, stats: &HashMap<u32, (f32, u64)>) {
    for o in orphans.iter_mut() {
        o.cpu = o.pids.iter().filter_map(|p| stats.get(p)).map(|s| s.0).sum();
        o.rss_kb = o.pids.iter().filter_map(|p| stats.get(p)).map(|s| s.1).sum();
    }
    orphans.sort_by(|a, b| b.rss_kb.cmp(&a.rss_kb).then(a.pgid.cmp(&b.pgid)));
}

/// 포트 조회 결과를 항목에 붙인다
pub fn attach_ports(orphans: &mut [Orphan], listen: &[(u32, String)]) {
    for o in orphans.iter_mut() {
        let mut ports: Vec<u16> = listen
            .iter()
            .filter(|(p, _)| o.pids.contains(p))
            .filter_map(|(_, addr)| parse_port(addr))
            .collect();
        ports.sort_unstable();
        ports.dedup();
        o.ports = ports;
    }
}

#[cfg(unix)]
fn pid_list(pids: &[u32]) -> String {
    pids.iter().map(u32::to_string).collect::<Vec<_>>().join(",")
}

/// 전체 스캔 (unix). projects = [(id, 경로)], live = 열린 탭 id
#[cfg(unix)]
pub fn scan(projects: &[(String, String)], live: &HashSet<String>) -> Vec<Orphan> {
    use crate::resume::{parse_lsof_pn, parse_pid_args, run_tool, LSOF, PS};
    let Some(text) = run_tool(PS, &["-axo", PS_ROW_FORMAT]) else {
        return Vec::new();
    };
    let rows = parse_ps_rows(&text);
    let self_pid = std::process::id();
    let Some(me) = rows.iter().find(|r| r.pid == self_pid) else { return Vec::new() };
    let (user, self_pgid, self_elapsed) = (me.user.clone(), me.pgid, me.elapsed_s);
    let candidates: Vec<u32> = rows.iter().filter(|r| is_candidate(r, &user, self_pid)).map(|r| r.pid).collect();
    if candidates.is_empty() {
        return Vec::new();
    }
    let list = pid_list(&candidates);
    let cwds: HashMap<u32, String> = run_tool(LSOF, &["-w", "-n", "-P", "-a", "-d", "cwd", "-Fpn", "-p", &list])
        .map(|t| parse_lsof_pn(&t).into_iter().collect())
        .unwrap_or_default();
    let ta_env = read_ta_env(&candidates);
    let args = run_tool(PS, &["-axo", "pid=,args="]).map(|t| parse_pid_args(&t)).unwrap_or_default();
    let me = Me { pgid: self_pgid, elapsed_s: self_elapsed, live };
    let mut orphans = build_orphans(&rows, &args, &candidates, &cwds, &ta_env, projects, &me);
    let all: Vec<u32> = orphans.iter().flat_map(|o| o.pids.iter().copied()).collect();
    if !all.is_empty() {
        let listen = run_tool(LSOF, &["-w", "-n", "-P", "-a", "-iTCP", "-sTCP:LISTEN", "-Fpn", "-p", &pid_list(&all)])
            .map(|t| parse_lsof_pn(&t))
            .unwrap_or_default();
        attach_ports(&mut orphans, &listen);
        let stats = run_tool(PS, &["-axo", "pid=,%cpu=,rss="]).map(|t| parse_stats(&t)).unwrap_or_default();
        attach_stats(&mut orphans, &stats);
    }
    orphans
}

/// pid → TA_SESSION_ID. Linux 는 /proc, macOS 는 `ps -E`
#[cfg(unix)]
fn read_ta_env(pids: &[u32]) -> HashMap<u32, String> {
    let mut found = HashMap::new();
    let mut rest = Vec::new();
    for &pid in pids {
        match std::fs::read(format!("/proc/{pid}/environ")) {
            Ok(env) => {
                if let Some(v) = env.split(|b| *b == 0).find_map(|kv| kv.strip_prefix(b"TA_SESSION_ID=")) {
                    found.insert(pid, String::from_utf8_lossy(v).into_owned());
                }
            }
            Err(_) => rest.push(pid),
        }
    }
    if !rest.is_empty() {
        if let Some(t) = crate::resume::run_tool(crate::resume::PS, &["-E", "-o", "pid=,command=", "-p", &pid_list(&rest)]) {
            found.extend(parse_ta_env(&t));
        }
    }
    found
}

#[cfg(not(unix))]
pub fn scan(_projects: &[(String, String)], _live: &HashSet<String>) -> Vec<Orphan> {
    Vec::new()
}

#[cfg(unix)]
fn alive(pid: u32) -> bool {
    unsafe { libc::kill(pid as i32, 0) == 0 }
}

/// 그룹 전체가 우리 것이면 그룹 신호 + 그룹 밖으로 나간 자손은 개별 신호, 아니면 전부 개별 신호
#[cfg(unix)]
fn signal(o: &Orphan, sig: i32) {
    unsafe {
        if o.group_kill {
            libc::kill(-o.pgid, sig);
            for &p in &o.outside_pids {
                libc::kill(p as i32, sig);
            }
        } else {
            for &p in &o.pids {
                libc::kill(p as i32, sig);
            }
        }
    }
}

fn project_paths(store: &std::sync::Mutex<crate::store::Store>) -> Vec<(String, String)> {
    crate::util::plock(store).data.projects.iter().map(|p| (p.id.clone(), p.path.clone())).collect()
}

type StoreArg<'a> = tauri::State<'a, std::sync::Mutex<crate::store::Store>>;
type PtysArg<'a> = tauri::State<'a, crate::pty::PtyManager>;

#[tauri::command]
pub async fn list_orphans(store: StoreArg<'_>, ptys: PtysArg<'_>) -> Result<Vec<Orphan>, String> {
    let projects = project_paths(&store);
    let live = ptys.live_ids();
    tauri::async_runtime::spawn_blocking(move || scan(&projects, &live)).await.map_err(|e| e.to_string())
}

/// 하나 종료. 재스캔해 여전히 목록에 있을 때만 신호를 보낸다 — 그 사이 pid 가 재사용됐을 수 있다
#[tauri::command]
pub async fn kill_orphan(store: StoreArg<'_>, ptys: PtysArg<'_>, pgid: i32) -> Result<(), String> {
    let results = kill_batch(&store, &ptys, vec![pgid]).await?;
    results.into_iter().next().map(|r| r.result).unwrap_or_else(|| Err(tr("종료 대상이 없습니다").into()))
}

#[derive(Serialize)]
pub struct KillResult {
    pub pgid: i32,
    #[serde(skip)]
    pub result: Result<(), String>,
    pub ok: bool,
    pub error: Option<String>,
}

/// 여러 개를 한 번의 재스캔으로 종료 ('모두 종료') → 항목별 결과
#[tauri::command]
pub async fn kill_orphans(store: StoreArg<'_>, ptys: PtysArg<'_>, pgids: Vec<i32>) -> Result<Vec<KillResult>, String> {
    kill_batch(&store, &ptys, pgids).await
}

async fn kill_batch(store: &std::sync::Mutex<crate::store::Store>, ptys: &crate::pty::PtyManager, pgids: Vec<i32>) -> Result<Vec<KillResult>, String> {
    let projects = project_paths(store);
    let live = ptys.live_ids();
    let results = tauri::async_runtime::spawn_blocking(move || kill_blocking(&projects, &live, &pgids))
        .await
        .map_err(|e| e.to_string())?;
    Ok(results
        .into_iter()
        .map(|(pgid, result)| KillResult { pgid, ok: result.is_ok(), error: result.clone().err(), result })
        .collect())
}

/// SIGTERM → 3초 기다려 남은 것에 SIGKILL → 1초 더 기다려도 살아 있는 pid 는 에러로 알린다
#[cfg(unix)]
fn kill_blocking(projects: &[(String, String)], live: &HashSet<String>, pgids: &[i32]) -> Vec<(i32, Result<(), String>)> {
    use std::time::{Duration, Instant};
    let current = scan(projects, live);
    let mut targets: Vec<Orphan> = Vec::new();
    let mut out: Vec<(i32, Result<(), String>)> = Vec::new();
    for &pgid in pgids {
        match current.iter().find(|o| o.pgid == pgid && pgid > 1) {
            Some(o) => targets.push(o.clone()),
            None => out.push((pgid, Err(tr("이미 종료되었거나 목록에 없는 프로세스입니다").into()))),
        }
    }
    let any_alive = |ts: &[Orphan]| ts.iter().any(|o| o.pids.iter().any(|p| alive(*p)));
    let wait = |ts: &[Orphan], d: Duration| {
        let deadline = Instant::now() + d;
        while Instant::now() < deadline && any_alive(ts) {
            std::thread::sleep(Duration::from_millis(200));
        }
    };
    for o in &targets {
        signal(o, libc::SIGTERM);
    }
    wait(&targets, Duration::from_secs(3));
    let stubborn: Vec<Orphan> = targets.iter().filter(|o| o.pids.iter().any(|p| alive(*p))).cloned().collect();
    for o in &stubborn {
        signal(o, libc::SIGKILL);
    }
    if !stubborn.is_empty() {
        wait(&stubborn, Duration::from_secs(1));
    }
    for o in targets {
        let left: Vec<String> = o.pids.iter().filter(|p| alive(**p)).map(u32::to_string).collect();
        let r = if left.is_empty() { Ok(()) } else { Err(trf("종료되지 않은 프로세스: {left}", &[("left", &left.join(", "))])) };
        out.push((o.pgid, r));
    }
    out
}

#[cfg(not(unix))]
fn kill_blocking(_projects: &[(String, String)], _live: &HashSet<String>, pgids: &[i32]) -> Vec<(i32, Result<(), String>)> {
    pgids.iter().map(|&p| (p, Err(tr("이 OS 에서는 지원하지 않습니다").into()))).collect()
}

// ── 탭·앱을 닫을 때 그 세션이 띄운 백그라운드 프로세스 정리 ──
// 셸을 죽이면 셸의 자식은 대개 SIGHUP 으로 함께 죽지만, nohup·setsid·`&` 로 띄운 서버는 살아남아
// 자원을 계속 쓴다. 셸의 자손 트리와, 이미 고아가 된(ppid=1) 같은 탭 출신(TA_SESSION_ID)을 모아 끝낸다.

/// 종료 계획 — 그룹 전체가 대상이면 그룹 신호, 아니면 pid 별 신호
#[derive(Debug, Default, PartialEq)]
pub struct ReapPlan {
    pub groups: Vec<i32>,
    pub pids: Vec<u32>,
    pub all: Vec<u32>,
}

/// `ps -axo pid=,ppid=,pgid=,user=,comm=` 한 줄
#[derive(Clone, Debug)]
pub struct ProcRow {
    pub pid: u32,
    pub ppid: u32,
    pub pgid: i32,
    pub user: String,
    pub comm: String,
}

pub fn parse_proc_rows(text: &str) -> Vec<ProcRow> {
    text.lines()
        .filter_map(|l| {
            let (f, comm) = crate::resume::split_fields(l, 4)?;
            Some(ProcRow {
                pid: f[0].parse().ok()?,
                ppid: f[1].parse().ok()?,
                pgid: f[2].parse().ok()?,
                user: f[3].to_string(),
                comm: comm.to_string(),
            })
        })
        .collect()
}

/// sessions = [(탭 id, 셸 pid)]. env = ppid=1 후보의 TA_SESSION_ID.
/// 셸 자신은 PtyManager 가 따로 끝내므로 넣지 않는다. 에이전트 상주 프로세스·앱 번들·앱 자신의 그룹은 건드리지 않는다
pub fn session_reap_plan(
    rows: &[ProcRow],
    args: &HashMap<u32, String>,
    env: &HashMap<u32, String>,
    sessions: &[(String, Option<u32>)],
    self_pid: u32,
    self_pgid: i32,
) -> ReapPlan {
    let mut children: HashMap<u32, Vec<&ProcRow>> = HashMap::new();
    for r in rows {
        children.entry(r.ppid).or_default().push(r);
    }
    let skip = |r: &ProcRow| {
        r.pid <= 1
            || r.pid == self_pid
            || r.pgid == self_pgid
            || excluded_path(&r.comm)
            || is_agent_infra(&r.comm, args.get(&r.pid).map(String::as_str).unwrap_or(""))
    };
    let ids: HashSet<&str> = sessions.iter().map(|(id, _)| id.as_str()).collect();
    let shells: HashSet<u32> = sessions.iter().filter_map(|(_, p)| *p).collect();
    let mut stack: Vec<&ProcRow> = Vec::new();
    for sh in &shells {
        stack.extend(children.get(sh).into_iter().flatten().copied());
    }
    stack.extend(rows.iter().filter(|r| r.ppid == 1 && env.get(&r.pid).is_some_and(|id| ids.contains(id.as_str()))));
    let mut set: HashSet<u32> = HashSet::new();
    while let Some(r) = stack.pop() {
        if skip(r) || shells.contains(&r.pid) || !set.insert(r.pid) {
            continue;
        }
        stack.extend(children.get(&r.pid).into_iter().flatten().copied());
    }
    let mut plan = ReapPlan::default();
    let mut grouped: HashSet<i32> = HashSet::new();
    for r in rows.iter().filter(|r| set.contains(&r.pid)) {
        if grouped.contains(&r.pgid) || r.pgid <= 1 {
            continue;
        }
        if rows.iter().filter(|x| x.pgid == r.pgid).all(|x| set.contains(&x.pid)) {
            grouped.insert(r.pgid);
        }
    }
    plan.groups = grouped.into_iter().collect();
    plan.groups.sort_unstable();
    plan.all = set.iter().copied().collect();
    plan.all.sort_unstable();
    plan.pids = rows
        .iter()
        .filter(|r| set.contains(&r.pid) && !plan.groups.contains(&r.pgid))
        .map(|r| r.pid)
        .collect();
    plan.pids.sort_unstable();
    plan
}

/// 지금 시스템에서 계획을 세운다 (unix)
#[cfg(unix)]
pub fn collect_reap_plan(sessions: &[(String, Option<u32>)]) -> ReapPlan {
    use crate::resume::{parse_pid_args, run_tool, PS};
    if sessions.is_empty() {
        return ReapPlan::default();
    }
    let Some(text) = run_tool(PS, &["-axo", "pid=,ppid=,pgid=,user=,comm="]) else { return ReapPlan::default() };
    let rows = parse_proc_rows(&text);
    let self_pid = std::process::id();
    let Some(me) = rows.iter().find(|r| r.pid == self_pid) else { return ReapPlan::default() };
    let (user, self_pgid) = (me.user.clone(), me.pgid);
    let args = run_tool(PS, &["-axo", "pid=,args="]).map(|t| parse_pid_args(&t)).unwrap_or_default();
    let orphan_pids: Vec<u32> = rows
        .iter()
        .filter(|r| r.ppid == 1 && r.user == user && r.pid != self_pid && !excluded_path(&r.comm))
        .map(|r| r.pid)
        .collect();
    let env = if orphan_pids.is_empty() { HashMap::new() } else { read_ta_env(&orphan_pids) };
    session_reap_plan(&rows, &args, &env, sessions, self_pid, self_pgid)
}

/// SIGTERM → 최대 `grace` 기다린 뒤 남은 것에 SIGKILL
#[cfg(unix)]
pub fn execute_reap(plan: &ReapPlan, grace: std::time::Duration) {
    if plan.all.is_empty() {
        return;
    }
    let send = |sig: i32| unsafe {
        for g in &plan.groups {
            libc::kill(-*g, sig);
        }
        for p in &plan.pids {
            libc::kill(*p as i32, sig);
        }
    };
    send(libc::SIGTERM);
    let deadline = std::time::Instant::now() + grace;
    while std::time::Instant::now() < deadline && plan.all.iter().any(|p| alive(*p)) {
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    if plan.all.iter().any(|p| alive(*p)) {
        send(libc::SIGKILL);
    }
}

/// 탭을 닫을 때·앱을 끝낼 때 공용 — 계획 수립 + 종료 (블로킹, 최대 약 grace + 조회 시간)
#[cfg(unix)]
pub fn reap_sessions(sessions: &[(String, Option<u32>)], grace: std::time::Duration) {
    let plan = collect_reap_plan(sessions);
    execute_reap(&plan, grace);
}

/// Windows 는 프로세스 그룹·고아 판별 수단이 없어 지원하지 않는다
#[cfg(not(unix))]
pub fn reap_sessions(_sessions: &[(String, Option<u32>)], _grace: std::time::Duration) {}

/// 탭 닫기용 — 셸이 살아 있을 때 트리를 뜬 뒤(자손을 놓치지 않게) 셸을 끝내고 나머지를 정리한다
#[cfg(unix)]
pub fn reap_around(sessions: &[(String, Option<u32>)], grace: std::time::Duration, kill_shell: impl FnOnce()) {
    let plan = collect_reap_plan(sessions);
    kill_shell();
    execute_reap(&plan, grace);
}

#[cfg(not(unix))]
pub fn reap_around(_sessions: &[(String, Option<u32>)], _grace: std::time::Duration, kill_shell: impl FnOnce()) {
    kill_shell();
}

#[cfg(test)]
mod tests {
    use super::*;

    // 실측 행을 본뜬 픽스처 (LC_ALL=C)
    const PS_ROWS: &str = "\
    1     0     1 ??        1-00:00:00 Thu Nov  5 21:45:40 2026     root             /sbin/launchd
  483     1   483 ??        1-00:00:00 Thu Nov  5 21:45:45 2026     _coreaudiod      Core Audio Driver (ParrotAudioPlugin.driver)
  785     1   785 ??        1-00:00:00 Thu Nov  5 21:45:55 2026     u                /Applications/Logi Options.app/Contents/Support/LogiMgrDaemon.app/Contents/MacOS/LogiMgrDaemon
25553     1 25276 ??        1-00:00:00 Sat Nov 21 09:00:00 2026     u                /Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex
  900     1   900 ??        1-00:00:00 Thu Nov  5 21:46:00 2026     u                /usr/libexec/trustd
 5000  4000  5000 ??        1-00:00:00 Sat Nov 22 10:00:00 2026     u                /Applications/Terminal Assistance.app/Contents/MacOS/terminal-assistance
 6100     1  6100 ??        1-00:00:00 Sat Nov 22 10:01:00 2026     u                /bin/bash
 6101  6100  6100 ??        1-00:00:00 Sat Nov 22 10:01:01 2026     u                /opt/homebrew/bin/python3
 6200     1  6150 ??        1-00:00:00 Sat Nov 22 10:02:00 2026     u                /bin/zsh
 6201  6200  6150 ??        1-00:00:00 Sat Nov 22 10:02:01 2026     u                /bin/sleep
 6300     1  6300 ??        1-00:00:00 Sat Nov 22 10:03:00 2026     u                /Users/u/.codex/packages/bin/codex
 6400     1  6400 ttys003   1-00:00:00 Sat Nov 22 10:04:00 2026     u                /bin/zsh
 6500     1  6500 ??        1-00:00:00 Sat Nov 22 10:05:00 2026     other            /bin/bash
 6600     1  6600 ??             10:00 Sat Nov 22 10:06:00 2026     u                /usr/local/bin/node
 6601  6600  6600 ??             10:00 Sat Nov 22 10:06:01 2026     u                /usr/local/bin/node
 7000     1  7000 ??        1-00:00:00 Sat Nov 22 10:07:00 2026     u                /bin/zsh
 7001  7000  7000 ??        1-00:00:00 Sat Nov 22 10:07:01 2026     u                /bin/sleep
 7002     1  7000 ??        1-00:00:00 Sat Nov 22 10:07:02 2026     u                /bin/bash
";

    fn args() -> HashMap<u32, String> {
        [
            (6100, "bash ./run.sh"),
            (6101, "python3 serve.py --port=8766"),
            (6200, "zsh -c until grep -q READY out.log; do sleep 3; done"),
            (6201, "sleep 3"),
            (6300, "/Users/u/.codex/packages/bin/codex app-server"),
            (7000, "zsh -c watch"),
        ]
        .into_iter()
        .map(|(p, a)| (p, a.to_string()))
        .collect()
    }

    #[test]
    fn parse_rows_with_lstart_and_spaced_comm() {
        let rows = parse_ps_rows(PS_ROWS);
        assert_eq!(rows.len(), 18);
        let r = rows.iter().find(|r| r.pid == 483).unwrap();
        assert_eq!(r.started, "Thu Nov 5 21:45:45 2026");
        assert_eq!(r.user, "_coreaudiod");
        assert_eq!(r.comm, "Core Audio Driver (ParrotAudioPlugin.driver)");
        let r = rows.iter().find(|r| r.pid == 785).unwrap();
        assert!(r.comm.ends_with("MacOS/LogiMgrDaemon"));
    }

    #[test]
    fn candidates_exclude_system_bundles_other_users_and_ttys() {
        let rows = parse_ps_rows(PS_ROWS);
        let c: Vec<u32> = rows.iter().filter(|r| is_candidate(r, "u", 5000)).map(|r| r.pid).collect();
        // ChatGPT.app 의 codex·Logi 데몬(.app/Contents)·/usr/libexec·tty 있는 셸·다른 계정은 제외
        assert_eq!(c, vec![6100, 6200, 6300, 6600, 7000, 7002]);
    }

    #[test]
    fn adopt_by_env_or_project_cwd_and_group_by_pgid() {
        let rows = parse_ps_rows(PS_ROWS);
        let cands: Vec<u32> = rows.iter().filter(|r| is_candidate(r, "u", 5000)).map(|r| r.pid).collect();
        let cwds: HashMap<u32, String> = [
            (6100, "/Users/u/proj/web"),
            (6200, "/Users/u/proj"),
            (6300, "/Users/u"),          // 프로젝트 밖 + 앱 환경 없음 → 미채택
            (6600, "/Users/u/elsewhere"), // 프로젝트 밖이지만 TA_SESSION_ID 가 있다
            (7000, "/Users/u/proj"),
            (7002, "/Users/u/proj"),
        ]
        .into_iter()
        .map(|(p, c)| (p, c.to_string()))
        .collect();
        let env = parse_ta_env("6600 node server.js TA_SESSION_ID=abc PATH=/bin\n6300 codex PATH=/bin\n");
        assert_eq!(env, [(6600, "abc".to_string())].into_iter().collect());
        let projects = vec![("p1".to_string(), "/Users/u/proj/".to_string()), ("p2".to_string(), "/Users/u/proj/web".to_string())];
        let mut out = build_orphans(&rows, &args(), &cands, &cwds, &env, &projects, &Me { pgid: 5000, elapsed_s: 3600, live: &HashSet::new() });
        attach_ports(&mut out, &[(6101, "*:8766".into()), (6101, "[::1]:8766".into()), (9999, "*:1".into())]);

        let pg: Vec<i32> = out.iter().map(|o| o.pgid).collect();
        assert_eq!(pg, vec![6100, 6150, 6600, 7000]);
        let run = &out[0];
        assert_eq!(run.pids, vec![6100, 6101], "자식 python 까지 한 항목");
        assert_eq!(run.command, "bash ./run.sh");
        assert_eq!(run.project_id.as_deref(), Some("p2"), "가장 깊은 프로젝트");
        assert_eq!(run.ports, vec![8766]);
        assert!(run.group_kill && !run.from_app);
        assert_eq!(run.started_at, "Sat Nov 22 10:01:00 2026");

        let watch = &out[1];
        assert_eq!((watch.pids.clone(), watch.project_id.as_deref()), (vec![6200, 6201], Some("p1")));
        assert!(watch.command.starts_with("zsh -c until grep"));

        let node = &out[2];
        assert!(node.from_app && node.project_id.is_none());
        assert_eq!(node.session_id.as_deref(), Some("abc"));
        assert!(!node.live_tab);
        assert_eq!(node.pids, vec![6600, 6601]);

        // 두 후보가 한 그룹 — 리더(7000)가 대표
        let grp = &out[3];
        assert_eq!(grp.pids, vec![7000, 7001, 7002]);
        assert_eq!(grp.command, "zsh -c watch");
    }

    #[test]
    fn group_kill_only_when_group_is_fully_ours() {
        // 그룹 6150 에 이 항목 밖의 프로세스(살아 있는 다른 셸)가 섞여 있다
        let text = format!("{PS_ROWS} 6250  6249  6150 ttys009  1-00:00:00 Sat Nov 22 10:02:30 2026     u                /bin/zsh\n");
        let rows = parse_ps_rows(&text);
        let cwds: HashMap<u32, String> = [(6200, "/p".to_string())].into_iter().collect();
        let out = build_orphans(&rows, &args(), &[6200], &cwds, &HashMap::new(), &[("p".into(), "/p".into())], &Me { pgid: 5000, elapsed_s: 3600, live: &HashSet::new() });
        assert_eq!(out.len(), 1);
        assert!(!out[0].group_kill, "남의 프로세스가 섞인 그룹은 pid 별로 종료");
        // 자기 그룹은 절대 채택하지 않는다
        let out = build_orphans(&rows, &args(), &[6200], &cwds, &HashMap::new(), &[("p".into(), "/p".into())], &Me { pgid: 6150, elapsed_s: 3600, live: &HashSet::new() });
        assert!(out.is_empty());
    }

    #[test]
    fn agent_infra_daemon_is_never_listed() {
        // 실측: ppid=1·tty ?? 인 codex app-server 데몬이 TA_SESSION_ID 를 물려받고 프로젝트 안에서 돈다
        let text = "65197     1 65197 ??       1-00:00:00 Sat Nov 21 08:00:00 2026     u                /Users/u/.codex/packages/app-server-daemon/releases/0.171.0-aarch64-apple-darwin/bin/codex\n";
        let rows = parse_ps_rows(text);
        assert!(is_candidate(&rows[0], "u", 1));
        let args: HashMap<u32, String> = [(
            65197,
            "/Users/u/.codex/packages/app-server-daemon/releases/0.171.0-aarch64-apple-darwin/bin/codex app-server daemon pid-update-loop".to_string(),
        )]
        .into_iter()
        .collect();
        let cwds: HashMap<u32, String> = [(65197, "/p".to_string())].into_iter().collect();
        let env: HashMap<u32, String> = [(65197, "tab1".to_string())].into_iter().collect();
        let out = build_orphans(&rows, &args, &[65197], &cwds, &env, &[("p".into(), "/p".into())], &Me { pgid: 1, elapsed_s: 3600, live: &HashSet::new() });
        assert!(out.is_empty(), "에이전트 상주 프로세스는 목록·모두 종료 대상이 아니다");
        assert!(is_agent_infra("/Users/u/.claude/local/node", "node x"));
        assert!(is_agent_infra("node", "node /opt/codex.js app-server"));
        assert!(!is_agent_infra("/bin/bash", "bash ./run.sh"));
    }

    #[test]
    fn live_tab_processes_are_marked_and_outside_children_tracked() {
        let rows = parse_ps_rows(PS_ROWS);
        let env: HashMap<u32, String> = [(6600, "tabA".to_string())].into_iter().collect();
        let live: HashSet<String> = ["tabA".to_string()].into_iter().collect();
        let cwds: HashMap<u32, String> = [(6100, "/Users/u/proj".to_string())].into_iter().collect();
        let out = build_orphans(&rows, &args(), &[6100, 6600], &cwds, &env, &[("p".into(), "/Users/u/proj".into())], &Me { pgid: 5000, elapsed_s: 3600, live: &live });
        let node = out.iter().find(|o| o.pgid == 6600).unwrap();
        assert!(node.live_tab, "열린 탭이 띄운 프로세스");
        assert!(!out.iter().find(|o| o.pgid == 6100).unwrap().live_tab);
        // 복원된 탭이 같은 id 를 이어받아도, 앱보다 먼저 뜬 프로세스는 지난 실행의 잔여물이다 (비정상 종료 복구)
        let env_old: HashMap<u32, String> = [(6100, "tabA".to_string()), (6600, "tabA".to_string())].into_iter().collect();
        let out = build_orphans(&rows, &args(), &[6100, 6600], &cwds, &env_old, &[("p".into(), "/Users/u/proj".into())], &Me { pgid: 5000, elapsed_s: 3600, live: &live });
        assert!(!out.iter().find(|o| o.pgid == 6100).unwrap().live_tab, "하루 전 뜬 프로세스");
        assert!(out.iter().find(|o| o.pgid == 6600).unwrap().live_tab, "앱 실행 후 10분 전에 뜬 프로세스");
        // 자손이 다른 그룹으로 옮겨 갔으면 그룹 신호와 별도로 보낸다
        let text = format!("{PS_ROWS} 6102  6100  6190 ??       1-00:00:00 Sat Nov 22 10:01:02 2026     u                /bin/sleep\n");
        let rows = parse_ps_rows(&text);
        let out = build_orphans(&rows, &args(), &[6100], &cwds, &HashMap::new(), &[("p".into(), "/Users/u/proj".into())], &Me { pgid: 5000, elapsed_s: 3600, live: &HashSet::new() });
        assert_eq!(out[0].pids, vec![6100, 6101, 6102]);
        assert_eq!(out[0].outside_pids, vec![6102]);
        assert!(out[0].group_kill);
    }

    #[test]
    fn etime_and_stats_parse_and_sort_by_memory() {
        assert_eq!(parse_etime("05:07"), Some(307));
        assert_eq!(parse_etime("02:05:07"), Some(7507));
        assert_eq!(parse_etime("3-02:05:07"), Some(3 * 86400 + 7507));
        assert_eq!(parse_etime("x"), None);
        let stats = parse_stats(" 6100   0.0   1200\n 6101  12.5 340000\n 6200   1.0   900\n 6201   0.0   800\n");
        assert_eq!(stats[&6101], (12.5, 340000));
        let rows = parse_ps_rows(PS_ROWS);
        let cwds: HashMap<u32, String> = [(6100, "/p".to_string()), (6200, "/p".to_string())].into_iter().collect();
        let mut out = build_orphans(&rows, &args(), &[6100, 6200], &cwds, &HashMap::new(), &[("p".into(), "/p".into())], &Me { pgid: 5000, elapsed_s: 3600, live: &HashSet::new() });
        attach_stats(&mut out, &stats);
        assert_eq!(out.iter().map(|o| o.pgid).collect::<Vec<_>>(), vec![6100, 6150]);
        assert_eq!((out[0].cpu, out[0].rss_kb), (12.5, 341200), "자식 python 까지 합산");
        assert_eq!(out[1].rss_kb, 1700);
    }

    #[test]
    fn reap_plan_takes_shell_tree_and_same_tab_orphans_only() {
        // 5000 = 앱(그룹 5000), 8000 = 탭 t1 의 셸, 9000 = 탭 t2 의 셸
        let text = "\
 5000  4000  5000 u /Applications/Terminal Assistance.app/Contents/MacOS/terminal-assistance
 8000  5000  8000 u /bin/zsh
 8100  8000  8100 u /usr/local/bin/node
 8101  8100  8100 u /usr/local/bin/node
 8200  8000  8200 u /opt/homebrew/bin/python3
 8201  8200  8300 u /bin/sleep
 8300     1  8300 u /bin/bash
 8400  8000  8400 u /Users/u/.codex/packages/bin/codex
 8401  8400  8400 u /bin/sleep
 8500     1  8500 u /bin/bash
 8600     1  8600 u /bin/bash
 9000  5000  9000 u /bin/zsh
 9100  9000  9100 u /usr/bin/tail
 8700  8000  5000 u /bin/cat
";
        let rows = parse_proc_rows(text);
        assert_eq!(rows.len(), 14);
        let args: HashMap<u32, String> = [(8400, "/Users/u/.codex/packages/bin/codex app-server".to_string())].into_iter().collect();
        // 8500 은 t1 이 띄웠다 고아가 된 서버, 8600 은 다른 탭(t9) 출신
        let env: HashMap<u32, String> = [(8500, "t1".to_string()), (8600, "t9".to_string())].into_iter().collect();
        let plan = session_reap_plan(&rows, &args, &env, &[("t1".into(), Some(8000))], 5000, 5000);
        assert_eq!(plan.all, vec![8100, 8101, 8200, 8201, 8500], "셸 자손 + 같은 탭 고아 (셸·codex 상주·앱 그룹·다른 탭 제외)");
        // 그룹 8300 에는 대상 밖 프로세스(8300)가 있어 8201 은 개별 신호
        assert_eq!(plan.groups, vec![8100, 8200, 8500]);
        assert_eq!(plan.pids, vec![8201]);
        assert_eq!(session_reap_plan(&rows, &args, &env, &[], 5000, 5000), ReapPlan::default());
    }

    // 실제 시스템에서 조회 경로 전체(ps·lsof 호출과 파싱)가 돌아가는지만 본다 — 신호는 보내지 않는다
    #[cfg(unix)]
    #[test]
    fn real_system_scan_and_plan_are_read_only_and_parse() {
        let started = std::time::Instant::now();
        let list = scan(&[], &HashSet::new());
        for o in &list {
            assert!(o.pgid > 1 && !o.pids.is_empty());
        }
        // 존재하지 않는 셸 pid 의 탭 → 대상 없음
        let plan = collect_reap_plan(&[("no-such-tab".into(), Some(u32::MAX - 7))]);
        assert!(plan.all.is_empty(), "{plan:?}");
        assert!(started.elapsed() < std::time::Duration::from_secs(15));
    }

    #[test]
    fn project_matching_respects_path_boundaries() {
        let projects = vec![("a".to_string(), "/x/app".to_string())];
        assert_eq!(project_for("/x/app", &projects).as_deref(), Some("a"));
        assert_eq!(project_for("/x/app/sub/", &projects).as_deref(), Some("a"));
        assert_eq!(project_for("/x/apple", &projects), None);
        assert_eq!(parse_port("127.0.0.1:3000"), Some(3000));
        assert_eq!(parse_port("*:*"), None);
    }

    #[test]
    fn serializes_camel_case_without_internal_flag() {
        let o = Orphan {
            pgid: 1,
            pids: vec![2],
            command: "c".into(),
            cwd: None,
            project_id: Some("p".into()),
            started_at: "s".into(),
            elapsed_sec: 1,
            ports: vec![],
            cpu: 1.5,
            rss_kb: 2048,
            from_app: true,
            session_id: Some("t".into()),
            live_tab: false,
            outside_pids: vec![],
            group_kill: true,
        };
        let v = serde_json::to_value(&o).unwrap();
        assert_eq!(v["projectId"], "p");
        assert_eq!(v["fromApp"], true);
        assert_eq!(v["startedAt"], "s");
        assert!(v.get("groupKill").is_none() && v.get("outsidePids").is_none());
        assert_eq!(v["liveTab"], false);
        assert_eq!(v["sessionId"], "t");
    }

    /// 실제 신호 검증 — 이 테스트가 직접 띄운 프로세스만 대상으로 한다.
    /// 셸 자손(일반·TERM 무시) + 셸과 끊긴 고아(TA_SESSION_ID 보유)를 만든 뒤 reap_around 로 모두 사라지는지 확인
    #[cfg(unix)]
    #[test]
    fn real_reap_kills_tree_and_detached_env_orphan() {
        use std::process::{Command, Stdio};
        use std::time::{Duration, Instant};
        let Some(node) = ["/usr/local/bin/node", "/opt/homebrew/bin/node"].iter().find(|p| std::path::Path::new(p).exists()) else {
            eprintln!("node 없음 — 건너뜀");
            return;
        };
        let tag = format!("ta_reap_test_{}", std::process::id());
        let sid = format!("reaptest{}", std::process::id());
        // 플랫폼 바이너리(/bin/*)는 ps -E 로 환경변수가 안 보이므로 고아는 node 로 만든다
        let script = format!(
            "sleep 611 & \
             sh -c 'trap \"\" TERM; while :; do sleep 1; done' {tag}_trap & \
             ( TA_SESSION_ID={sid} {node} -e 'setInterval(()=>{{}},1000)' {tag}_orphan & ) ; \
             wait",
        );
        use std::os::unix::process::CommandExt;
        // 실제 탭 셸처럼 앱과 다른 프로세스 그룹에 둔다 (앱 자신의 그룹은 정리 대상에서 빠지므로)
        let mut shell = Command::new("/bin/sh")
            .process_group(0)
            .arg("-c").arg(&script).arg(format!("{tag}_shell"))
            .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null())
            .spawn().expect("셸 실행");
        let shell_pid = shell.id();
        std::thread::sleep(Duration::from_millis(1500));
        let find = |pat: &str| -> Vec<u32> {
            let out = Command::new("pgrep").arg("-f").arg(pat).output().unwrap();
            String::from_utf8_lossy(&out.stdout).split_whitespace().filter_map(|x| x.parse().ok()).collect()
        };
        let orphan = find(&format!("^{node} .*{tag}_orphan"));
        let trap = find(&format!("^sh -c trap.*{tag}_trap"));
        assert_eq!(orphan.len(), 1, "고아 node 가 떠 있어야 함");
        assert!(!trap.is_empty(), "TERM 무시 루프가 떠 있어야 함");
        let ppid = Command::new("ps").args(["-o", "ppid=", "-p", &orphan[0].to_string()]).output().unwrap();
        assert_eq!(String::from_utf8_lossy(&ppid.stdout).trim(), "1", "고아는 셸과 끊겨 있어야 함");

        let start = Instant::now();
        reap_around(&[(sid.clone(), Some(shell_pid))], Duration::from_secs(2), || {
            let _ = shell.kill();
            let _ = shell.wait();
        });
        let took = start.elapsed();
        std::thread::sleep(Duration::from_millis(300));
        let left: Vec<u32> = [orphan, trap, find("^sleep 611")].concat().into_iter().filter(|p| alive(*p)).collect();
        // 실패해도 남기지 않는다
        for p in &left { unsafe { libc::kill(*p as i32, libc::SIGKILL); } }
        assert!(left.is_empty(), "남은 프로세스: {left:?}");
        assert!(took < Duration::from_secs(8), "정리 시간 {took:?}");
    }
}
