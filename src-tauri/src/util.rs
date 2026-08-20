// 모듈 공용 유틸리티
use std::sync::{Mutex, MutexGuard};

/// 뮤텍스 poisoning 무해화 — 한 스레드의 패닉이 다른 스레드의 패닉으로 전파되지 않게.
/// 락을 쥔 채 패닉해도 데이터는 유효한 상태로 남는 설계(짧은 임계 구역)를 전제로 한다.
pub fn plock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// ids 순서대로 재배열하고, ids 에 없던 항목은 원래 순서대로 뒤에 보존
pub fn reorder_by_ids<T>(items: &mut Vec<T>, ids: &[String], id_of: impl Fn(&T) -> &str) {
    let mut rest: Vec<T> = items.drain(..).collect();
    let mut ordered = Vec::with_capacity(rest.len());
    for id in ids {
        if let Some(pos) = rest.iter().position(|x| id_of(x) == id.as_str()) {
            ordered.push(rest.remove(pos));
        }
    }
    ordered.extend(rest);
    *items = ordered;
}
