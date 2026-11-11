import { KIT_FILE, LND_HUB_FILES, TLS_CERT_FILE, type LndService } from "./constants";

/** Paths of per-node secrets in the kit folder (relative to it), as docker-compose.yml and hub.env.example name them. */

const WALLET_PASSWORD_SUFFIX = ".password";
const SEED_SUFFIX = ".seed";

/** The LND wallet unlock password (compose secret `lnd_<node>_wallet_password`). */
export const walletPasswordPath = (service: LndService): string => `${KIT_FILE.WALLET_SECRETS_DIR}/${service}${WALLET_PASSWORD_SUFFIX}`;

/** The 24 seed words `testnet wallet` saves once, for the operator to copy offline. */
export const walletSeedPath = (service: LndService): string => `${KIT_FILE.WALLET_SECRETS_DIR}/${service}${SEED_SUFFIX}`;

/** What the hub reads of one LND node: secrets/hub/<node>/ (mounted at /secrets/<node>/). */
export const hubSecretsDir = (service: LndService): string => `${KIT_FILE.HUB_SECRETS_DIR}/${service}`;
export const hubMacaroonPath = (service: LndService): string => `${hubSecretsDir(service)}/${LND_HUB_FILES[service].macaroon}`;
export const hubTlsCertPath = (service: LndService): string => `${hubSecretsDir(service)}/${TLS_CERT_FILE}`;
