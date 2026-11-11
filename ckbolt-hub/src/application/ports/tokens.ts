/**
 * Nest injection tokens for the ports. Modules bind implementations to these; services inject by token,
 * so tests can swap in the fakes from test/fakes.
 */
export const LIGHTNING = Symbol("LIGHTNING");
export const FIBER = Symbol("FIBER");
/** The hub LND with the channel-only credential (LightningChannelsPort), or null when inbound channels are off. */
export const LIGHTNING_CHANNELS = Symbol("LIGHTNING_CHANNELS");
/** The demo wallet's own nodes (the "visitor" side), separate from the hub's nodes. */
export const DEMO_LIGHTNING = Symbol("DEMO_LIGHTNING");
export const DEMO_FIBER = Symbol("DEMO_FIBER");
export const PRICE_SOURCES = Symbol("PRICE_SOURCES");
export const CLOCK = Symbol("CLOCK");
export const SWAP_STORE = Symbol("SWAP_STORE");
/** The channels the hub's nodes opened on request (ChannelOpenLog), in the same database as the swaps. */
export const CHANNEL_OPEN_LOG = Symbol("CHANNEL_OPEN_LOG");
/** The inbound Fiber channels the hub asked to open and may abandon unaccepted (InboundOpenStore), in the same database. */
export const INBOUND_OPEN_STORE = Symbol("INBOUND_OPEN_STORE");
export const ASSETS = Symbol("ASSETS");
export const TIMING_PROFILE = Symbol("TIMING_PROFILE");
export const HUB_CONFIG = Symbol("HUB_CONFIG");
