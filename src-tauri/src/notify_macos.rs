// macOS 데스크톱 알림 — 스레드·폴링 없이 델리게이트 콜백으로만 클릭을 받는다.
//
// mac-notification-sys 의 wait_for_click 은 알림 하나당 대기 스레드 1개와 메인 스레드의 0.5초
// 폴링 타이머를 만들고, 알림이 알림 센터에 남아 있는 동안 끝나지 않는다. 앱을 오래 켜 두면
// 이 타이머가 메인 스레드를 점유해(실측 44개 누적 시 약 68%) 키 입력까지 밀렸다.
#![allow(deprecated)] // NSUserNotification 은 deprecated 지만 UNUserNotificationCenter 는 서명 요건이 다르다

use objc2::rc::Retained;
use objc2::runtime::{NSObject, ProtocolObject};
use objc2::{define_class, msg_send, ClassType, MainThreadMarker, MainThreadOnly};
use objc2_foundation::{
    NSObjectProtocol, NSString, NSUserNotification, NSUserNotificationActivationType,
    NSUserNotificationCenter, NSUserNotificationCenterDelegate,
};
use std::sync::OnceLock;
use tauri::AppHandle;

const SESSION_ID_PREFIX: &str = "ta-session:";

static APP: OnceLock<AppHandle> = OnceLock::new();

// 세션별 identifier — 새 알림을 보낼 때 같은 세션의 이전 알림을 지워 세션당 1개만 남긴다
fn identifier_for_session(session_id: &str) -> String {
    format!("{SESSION_ID_PREFIX}{session_id}")
}

fn session_from_identifier(identifier: &str) -> Option<String> {
    identifier.strip_prefix(SESSION_ID_PREFIX).map(str::to_owned)
}

define_class!(
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[name = "TANotificationDelegate"]
    struct NotificationDelegate;

    unsafe impl NSObjectProtocol for NotificationDelegate {}

    unsafe impl NSUserNotificationCenterDelegate for NotificationDelegate {
        #[unsafe(method(userNotificationCenter:didActivateNotification:))]
        fn did_activate(&self, center: &NSUserNotificationCenter, notification: &NSUserNotification) {
            let clicked = notification.activationType() != NSUserNotificationActivationType::None;
            if clicked {
                if let Some(app) = APP.get() {
                    let session_id = notification
                        .identifier()
                        .and_then(|id| session_from_identifier(&id.to_string()));
                    crate::reveal_session(app, session_id);
                }
            }
            center.removeDeliveredNotification(notification);
        }
    }
);

// 번들 식별자가 없는 실행(미등록 dev 빌드)에서는 nil 을 돌려주므로 Option 으로 받는다
fn default_center() -> Option<Retained<NSUserNotificationCenter>> {
    unsafe { msg_send![NSUserNotificationCenter::class(), defaultUserNotificationCenter] }
}

// 앱 시작 시 메인 스레드에서 1회 호출한다
pub fn init(app: &AppHandle, identifier: &str) {
    let Some(mtm) = MainThreadMarker::new() else {
        return;
    };
    let _ = APP.set(app.clone());
    // 번들 없는 dev 실행에서도 설치본 번들 ID 로 알림을 보내기 위한 훅
    let _ = mac_notification_sys::set_application(identifier);
    let Some(center) = default_center() else {
        return;
    };
    let delegate: Retained<NotificationDelegate> =
        unsafe { msg_send![NotificationDelegate::alloc(mtm), init] };
    unsafe { center.setDelegate(Some(ProtocolObject::from_ref(&*delegate))) };
    // center 의 delegate 는 약한 참조다 — 프로세스 수명 동안 유지한다
    std::mem::forget(delegate);
}

pub fn show(
    app: &AppHandle,
    title: String,
    body: String,
    session_id: Option<String>,
) -> Result<(), String> {
    app.run_on_main_thread(move || {
        let Some(center) = default_center() else {
            return;
        };
        let notification = NSUserNotification::new();
        notification.setTitle(Some(&NSString::from_str(&title)));
        notification.setInformativeText(Some(&NSString::from_str(&body)));
        notification.setHasActionButton(false);
        if let Some(id) = session_id.as_deref() {
            let identifier = NSString::from_str(&identifier_for_session(id));
            // 같은 identifier 로 바로 보내면 배너 없이 내용만 교체될 수 있어 먼저 지운다
            for delivered in center.deliveredNotifications().iter() {
                if delivered.identifier().as_deref() == Some(&*identifier) {
                    center.removeDeliveredNotification(&delivered);
                }
            }
            notification.setIdentifier(Some(&identifier));
        }
        center.deliverNotification(&notification);
    })
    .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identifier_roundtrips_session_id() {
        let id = identifier_for_session("abc-123");
        assert_eq!(session_from_identifier(&id).as_deref(), Some("abc-123"));
    }

    #[test]
    fn foreign_identifier_has_no_session() {
        assert_eq!(session_from_identifier("6F9619FF-8B86-D011"), None);
    }
}
