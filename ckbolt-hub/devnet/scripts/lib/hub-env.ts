import { TIMING_PROFILES } from "../../../src/common/constants/timing.constants";
import type { HubEnv } from "../../../src/config/hub.config";
import type { Script } from "../../../src/domain/types";
import { FNN_PUBSUB_ENABLED } from "./devnet.constants";
import type { HostEndpoints } from "./endpoints";

/** Hub-root-relative paths of an LND node's TLS certificate and least-privilege macaroon. */
export interface LndCredentials {
  tlsCertPath: string;
  macaroonPath: string;
}

export interface HubEnvInput {
  endpoints: HostEndpoints;
  hubLnd: LndCredentials;
  demoLnd: LndCredentials;
  rusdTypeScript: Script;
}

type HubEnvVars = Partial<Record<keyof HubEnv, string>>;

interface Section {
  comment: string;
  vars: HubEnvVars;
}

const HEADER = [
  "# CKBolt hub settings for the local devnet, written by `npm run bootstrap` and `npm run up` in devnet/.",
  "# From the hub root: cp devnet/hub.env .env  (paths are relative to the hub root).",
  "# Variables not listed keep their defaults (.env.example, src/config/hub.config.ts).",
];

const sections = (input: HubEnvInput): Section[] => [
  {
    comment: "Networks: bitcoind regtest and the CKB devnet",
    vars: {
      BTC_NETWORK: "regtest",
      TIMING_PROFILE: TIMING_PROFILES.regtest.name,
      CKB_NETWORK: "devnet",
      UDT_RUSD_SCRIPT: JSON.stringify(input.rusdTypeScript),
    },
  },
  {
    comment: "Hub LND (lnd-hub) with the least-privilege macaroon",
    vars: {
      LND_GRPC_HOST: input.endpoints.lndHubGrpc,
      LND_TLS_CERT_PATH: input.hubLnd.tlsCertPath,
      LND_MACAROON_PATH: input.hubLnd.macaroonPath,
    },
  },
  {
    comment: "Hub Fiber node (fnn-hub)",
    vars: {
      FIBER_RPC_URL: input.endpoints.fnnHubRpcUrl,
      FIBER_PUBSUB: String(FNN_PUBSUB_ENABLED),
    },
  },
  {
    comment: "Demo wallet: the user nodes (lnd-user, fnn-user)",
    vars: {
      DEMO_ENABLED: "true",
      DEMO_LND_GRPC_HOST: input.endpoints.lndUserGrpc,
      DEMO_LND_TLS_CERT_PATH: input.demoLnd.tlsCertPath,
      DEMO_LND_MACAROON_PATH: input.demoLnd.macaroonPath,
      DEMO_FIBER_RPC_URL: input.endpoints.fnnUserRpcUrl,
    },
  },
];

const renderSection = ({ comment, vars }: Section): string =>
  [`# --- ${comment}`, ...Object.entries(vars).map(([name, value]) => `${name}=${value}`)].join("\n");

export function renderHubEnv(input: HubEnvInput): string {
  return [HEADER.join("\n"), ...sections(input).map(renderSection)].join("\n\n") + "\n";
}
