import { PROXY_SECRET_MIN_LENGTH } from "../../src/common/constants/http.constants";

/**
 * A HUB_PROXY_SECRET of exactly the shortest length the hub takes. A hub whose HUB_HOST is not loopback needs one to
 * start (or HUB_ALLOW_OPEN_API=true), so specs about other settings of such a host pass it.
 */
export const TEST_PROXY_SECRET = "s".repeat(PROXY_SECRET_MIN_LENGTH);
