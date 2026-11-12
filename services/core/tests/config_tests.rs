use cloak_core::auth::{
    hash_invite_password, issue_session_jwt, verify_invite_password, verify_session_jwt,
};
use cloak_core::config::AppConfig;
use std::sync::Mutex;
use uuid::Uuid;

static ENV_LOCK: Mutex<()> = Mutex::new(());

#[test]
fn production_config_fails_closed_without_real_infra() {
    let _g = ENV_LOCK.lock().unwrap();
    unsafe {
        std::env::set_var("CLOAK_ENV", "production");
        std::env::set_var(
            "DATABASE_URL",
            "postgres://cloak:cloak@127.0.0.1:5432/cloak",
        );
        std::env::set_var("CLOAK_DEV_ALLOW_IN_MEMORY_REDIS", "true");
        std::env::remove_var("REDIS_URL");
    }
    let err = AppConfig::from_env().expect_err("production must reject missing REDIS_URL");
    assert!(err.to_string().contains("REDIS_URL"));

    unsafe {
        std::env::set_var("CLOAK_DEV_ALLOW_IN_MEMORY_REDIS", "false");
        std::env::set_var("REDIS_URL", "redis://127.0.0.1:6379");
        std::env::set_var("OBJECT_STORE_BACKEND", "local");
    }
    let err2 = AppConfig::from_env().expect_err("production must reject local object store");
    assert!(err2.to_string().contains("local"));

    // Restore clean defaults for other tests
    unsafe {
        std::env::remove_var("CLOAK_ENV");
        std::env::remove_var("DATABASE_URL");
        std::env::remove_var("CLOAK_DEV_ALLOW_IN_MEMORY_REDIS");
        std::env::remove_var("REDIS_URL");
        std::env::remove_var("OBJECT_STORE_BACKEND");
    }
}

#[test]
fn jwt_and_argon2_invite_password_roundtrip() {
    let dev_id = Uuid::new_v4();
    let secret = "test_only_session_jwt_secret_minimum_64_characters_long_1234567890";
    let (jwt, jti, _) = issue_session_jwt(dev_id, secret, 2).expect("jwt");
    let (sub, parsed_jti, _) = verify_session_jwt(&jwt, secret).expect("verify jwt");
    assert_eq!(sub, dev_id);
    assert_eq!(parsed_jti, jti);
    assert!(verify_session_jwt(&jwt, "wrong_secret_01234567890123456789012345").is_err());

    let hash = hash_invite_password("horse-battery-99").expect("hash");
    assert!(verify_invite_password("horse-battery-99", &hash).expect("verify"));
    assert!(!verify_invite_password("wrong-password", &hash).expect("verify"));
}
