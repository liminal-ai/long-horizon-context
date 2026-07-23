//! InferenceCallbacks requires all four operation fields at construction
//! (TS incomplete object cast).

use lhc::InferenceCallbacks;

fn main() {
    let _cbs = InferenceCallbacks {
        // missing all four operation fields
    };
}
