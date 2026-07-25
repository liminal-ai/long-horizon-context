//! Spawnable counterpart of the TS test fixture `drain-runner.ts`.
//!
//! Auto-discovered Cargo example; not part of the library surface. Process
//! suites and manual probes spawn this binary the way Node spawns the TS
//! fixture (module top-level `main().catch(...)`).

#[path = "../tests/fixtures/mod.rs"]
mod fixtures;

fn main() {
    fixtures::drain_runner::process_main();
}
