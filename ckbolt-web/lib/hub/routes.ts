import { API_ROUTES, API_VERSION, SWAP_CANCEL_TOKEN_HEADER } from "./contract";
import { FIBER_NODE_ID_PATTERN, LIGHTNING_PUBKEY_PATTERN, UUID_PATTERN, type HttpMethod } from "./constants";

/** The version segment every hub path starts with ("v1"). */
export const HUB_VERSION_SEGMENT = `v${API_VERSION}`;

/** Placeholder for a resource id (a UUID) in a route pattern. */
const ID = ":id";
/** Placeholder for a Fiber node id (a public key) in a route pattern. */
const NODE_ID = ":nodeId";
/** Placeholder for a Lightning wallet's node public key in a route pattern. */
const PUBKEY = ":pubkey";

/** What each placeholder matches; any other pattern segment matches only itself. */
const PLACEHOLDER_PATTERNS: ReadonlyMap<string, RegExp> = new Map([
  [ID, UUID_PATTERN],
  [NODE_ID, FIBER_NODE_ID_PATTERN],
  [PUBKEY, LIGHTNING_PUBKEY_PATTERN],
]);

export interface HubRoute {
  /**
   * Path segments after the proxy base, version first; `:id` matches one UUID, `:nodeId` one Fiber node id, `:pubkey`
   * one Lightning node public key.
   */
  pattern: readonly string[];
  methods: readonly HttpMethod[];
  /**
   * Request headers (lower case) the proxy passes on to the hub for this route, besides its own: the cancel token of
   * POST /v1/swaps/:id/cancel. Every other route forwards none of the browser's headers.
   */
  forwardedHeaders?: readonly string[];
}

const segmentsOf = (route: string): string[] => route.split("/");
const route = (methods: HttpMethod[], ...parts: string[]): HubRoute => ({
  pattern: [HUB_VERSION_SEGMENT, ...parts.flatMap(segmentsOf)],
  methods,
});
/** `r`, with request headers the proxy passes on for it. */
const forwarding = (r: HubRoute, ...headers: string[]): HubRoute => ({ ...r, forwardedHeaders: headers });

/**
 * The hub's v1 paths the app calls (./client.ts), with their methods. The proxy forwards nothing else: the hub's other
 * paths, its demo wallet (`/v1/demo/*`) and GET /v1/quotes/:id among them, answer 404 at the proxy.
 */
export const HUB_ROUTES: readonly HubRoute[] = [
  route(["GET"], API_ROUTES.HEALTH),
  route(["GET"], API_ROUTES.ASSETS),
  route(["POST"], API_ROUTES.QUOTES),
  route(["POST"], API_ROUTES.SWAPS),
  route(["GET"], API_ROUTES.SWAPS, ID),
  route(["GET"], API_ROUTES.SWAPS, ID, API_ROUTES.SWAP_EVENTS),
  // Get paid cancels its unpaid Lightning invoice's swap with the token POST /v1/swaps answered.
  forwarding(route(["POST"], API_ROUTES.SWAPS, ID, API_ROUTES.SWAP_CANCEL), SWAP_CANCEL_TOKEN_HEADER),
  route(["GET"], API_ROUTES.FIBER_NODE),
  route(["POST"], API_ROUTES.FIBER_INBOUND_CHANNELS),
  route(["GET"], API_ROUTES.FIBER_INBOUND_CHANNELS, NODE_ID),
  route(["GET"], API_ROUTES.LIGHTNING_NODE),
  route(["POST"], API_ROUTES.LIGHTNING_INBOUND_CHANNELS),
  route(["GET"], API_ROUTES.LIGHTNING_INBOUND_CHANNELS, PUBKEY),
];

const segmentMatches = (expected: string, actual: string): boolean => {
  const placeholder = PLACEHOLDER_PATTERNS.get(expected);
  return placeholder ? placeholder.test(actual) : expected === actual;
};

/**
 * The route a path belongs to, or null. Ids must be UUIDs, node ids and pubkeys hex public keys, so no segment can
 * climb out of the API.
 */
export function matchHubRoute(segments: readonly string[]): HubRoute | null {
  return (
    HUB_ROUTES.find((r) => r.pattern.length === segments.length && r.pattern.every((expected, i) => segmentMatches(expected, segments[i]))) ??
    null
  );
}

/**
 * A hub resource path such as `/v1/swaps/<id>/events`. `route` and `subRoute` are `API_ROUTES` values; the id is
 * encoded as one segment.
 */
export function hubResourcePath(route: string, id?: string, subRoute?: string): string {
  const parts = [
    HUB_VERSION_SEGMENT,
    ...segmentsOf(route),
    ...(id === undefined ? [] : [encodeURIComponent(id)]),
    ...(subRoute === undefined ? [] : segmentsOf(subRoute)),
  ];
  return `/${parts.join("/")}`;
}
