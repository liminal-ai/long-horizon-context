//! Builds and runs the SQLITE_BUSY two-database case as a real executable
//! with panic=abort. `cargo test --profile abort-probe` does not honor abort
//! for libtest, so the child is an example, not a #[test].

use std::path::Path;
use std::process::Command;

#[test]
fn abort_profile_busy_handback_does_not_abort_and_releases_the_other_database() {
    let manifest = Path::new(env!("CARGO_MANIFEST_DIR")).join("Cargo.toml");
    let target = std::env::temp_dir().join("lhc-handback-abort-probe");
    let cargo = env!("CARGO");
    let output = Command::new(cargo)
        .args([
            "run",
            "--offline",
            "--manifest-path",
            manifest.to_str().expect("manifest utf-8"),
            "--profile",
            "abort-probe",
            "--example",
            "handback_abort_probe",
        ])
        .env("CARGO_TARGET_DIR", &target)
        .output()
        .expect("spawn abort-probe example");
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        output.status.success(),
        "panic=abort hand-back executable must exit 0 (no abort); status={:?}\nstdout:\n{stdout}\nstderr:\n{stderr}",
        output.status
    );
    assert!(
        stdout.contains("panic=abort"),
        "executable must report cfg!(panic = \"abort\"); stdout:\n{stdout}\nstderr:\n{stderr}"
    );
    assert!(
        stdout.contains("released=1")
            && stdout.contains("busy=claimed")
            && stdout.contains("free=queued"),
        "SQLITE_BUSY must skip the locked DB and release the other; stdout:\n{stdout}\nstderr:\n{stderr}"
    );
}
