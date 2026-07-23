//! SdkMode is a closed enum — unknown variants are compile errors
//! (TS `mode: "later" as unknown as "manual"`).

use lhc::shared_tech::derivation::SdkMode;

fn main() {
    let _mode = SdkMode::Later;
}
