use super::TokenFamily;

#[test]
fn prefix_resolution_and_exact_rounding() {
    for model in ["grok-4.6", "grok-4.3", "grok-future"] {
        let family = TokenFamily::for_model(model);
        assert_eq!(
            [0, 1, 19, 20, 21, 100].map(|raw| family.weigh(raw)),
            [0, 2, 20, 21, 23, 105]
        );
    }
    for model in ["gpt-5.5", "o200k", "unknown", "", "not-grok-4.6"] {
        let family = TokenFamily::for_model(model);
        assert_eq!(
            [0, 1, 20, 21, i64::MAX].map(|raw| family.weigh(raw)),
            [0, 1, 20, 21, i64::MAX]
        );
    }
}

#[tokio::test]
async fn model_changes_do_not_reprice_an_in_flight_operation() {
    use crate::shared_tech::context::{InstanceSeam, run_with_instance_seam};
    use std::sync::{Arc, RwLock};
    let seam = Arc::new(InstanceSeam {
        token_family: RwLock::new(TokenFamily::Grok),
        poke: Box::new(|_| {}),
        touch: Box::new(|_, _| {}),
        view: None,
        config: None,
    });
    run_with_instance_seam(seam.clone(), async {
        assert_eq!(super::weigh_tokens(100), 105);
        *seam.token_family.write().unwrap() = TokenFamily::O200k;
        tokio::task::yield_now().await;
        assert_eq!(super::weigh_tokens(100), 105);
    })
    .await;
    run_with_instance_seam(seam, async {
        assert_eq!(super::weigh_tokens(100), 100);
    })
    .await;
}
