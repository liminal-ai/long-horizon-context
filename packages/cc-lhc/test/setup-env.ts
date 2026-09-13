/**
 * Parent shells may export DISABLE_AUTO_COMPACT=1. The suite asserts when
 * cc-lhc itself injects or omits that variable on a managed child, so the
 * inherited value must not leak in.
 */
delete process.env.DISABLE_AUTO_COMPACT;
