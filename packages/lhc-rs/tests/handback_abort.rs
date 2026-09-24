//! Builds the SQLITE_BUSY two-database hand-back case with panic=abort.
//!
//! The probe is a separate integration-test binary so this harness does not
//! itself compile with abort.

use std::path::Path;
use std::process::Command;

#[test]
fn abort_profile_busy_handback_does_not_abort_and_releases_the_other_database() {
    let manifest = Path::new(env!("CARGO_MANIFEST_DIR")).join("Cargo.toml");
    let target = std::env::temp_dir().join("lhc-handback-abort-probe");
    let cargo = env!("CARGO");
    let output = Command::new(cargo)
        .args([
            "test",
            "--offline",
            "--manifest-path",
            manifest.to_str().expect("manifest utf-8"),
            "--profile",
            "abort-probe",
            "--test",
            "handback_abort_probe",
            "--",
            "--exact",
            "probe_busy_handback_releases_the_other_database",
        ])
        .env("CARGO_TARGET_DIR", &target)
        .output()
        .expect("spawn abort-probe cargo test");
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        output.status.success(),
        "panic=abort hand-back subprocess must exit 0 (no abort); status={:?}\nstdout:\n{stdout}\nstderr:\n{stderr}",
        output.status
    );
    assert!(
        stdout.contains("probe_busy_handback_releases_the_other_database") && stdout.contains("ok"),
        "abort-probe must run the SQLITE_BUSY case; stdout:\n{stdout}\nstderr:\n{stderr}"
    );
}
