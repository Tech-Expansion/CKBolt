/**
 * The sliding-window limiter moved to common/utils, since the application layer counts with it too (the caps on inbound
 * channels). The HTTP layer's rate limits keep importing it from here.
 */
export { SlidingWindowRateLimiter, type RateLimitDecision } from "../../../common/utils/sliding-window-limiter.util";
