import type { FiberNetwork } from "@/lib/payment-request";
import { DEFAULT_FIBER_NETWORK, FIBER_CURRENCY } from "./constants";

const isFiberNetwork = (value: string): value is FiberNetwork => Object.hasOwn(FIBER_CURRENCY, value);

/** The hub's CKB network from its health (`fiber.network`), or testnet when it does not say. */
export const fiberNetworkOf = (network: string | null | undefined): FiberNetwork =>
  network && isFiberNetwork(network) ? network : DEFAULT_FIBER_NETWORK;

/** The text a Fiber invoice on this network starts with: "fibt" on testnet. */
export const invoicePrefix = (network: FiberNetwork): string => FIBER_CURRENCY[network].toLowerCase();
