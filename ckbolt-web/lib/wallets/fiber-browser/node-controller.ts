import type { BrowserNodeConfig } from "./config";
import type { NodePhase } from "./bridge-protocol";
import { FiberJsNode, type FiberLike } from "./fiber-js-adapter";
import { fiberErrorMessage } from "./errors";
import { keyTag, wipeKeys, type NodeKeys } from "./keys";
import { browserNodeConfig } from "./node-config";
import { readUdtWhitelist, type NodeUdt, type WhitelistEntry } from "./udt-whitelist";
import type { NodeLockHandle } from "./node-lock";
import type { BrowserFiberNode, BrowserNodeInfo } from "./node-port";
import { databasePrefix, storageKey } from "./storage";
import { FIBER_LOG_LEVEL, STORAGE_NAME } from "./constants";

export interface NodeState {
  phase: NodePhase;
  info: BrowserNodeInfo | null;
  error: string | null;
  /** False when the browser has no Web Locks, so nothing stops a second tab from starting the same node. */
  exclusive: boolean;
  /**
   * The UDT whitelist the running node started with (its config's, read back: fiber-js's entries and the hub's), or
   * null while it does not run. fnn reads it only at start, so a token the hub added since needs a restart.
   */
  udts: readonly NodeUdt[] | null;
}

export interface NodeControllerDeps {
  config: BrowserNodeConfig;
  /** fiber-js, loaded on demand (or a test's fake). */
  load: () => Promise<FiberLike>;
  /** The single-tab lock; null when another tab holds it. */
  lock: (name: string) => Promise<NodeLockHandle | null>;
  /** Wraps the started fiber-js instance; the adapter by default. */
  wrap?: (fiber: FiberLike) => BrowserFiberNode;
}

export const LOCKED_STATE: NodeState = { phase: "locked", info: null, error: null, exclusive: true, udts: null };

/** The Web Lock name for a network's node. */
export const nodeLockName = (network: string): string => storageKey(network, STORAGE_NAME.NODE_LOCK);

/**
 * Starts and stops the browser node and says where it is, for React's useSyncExternalStore. One instance per page.
 * Start takes the Web Lock first, so a second tab sees "other-tab" instead of opening the same database; the keys are
 * wiped from memory once fiber-js has its own copy.
 */
export class BrowserNodeController {
  private state: NodeState = LOCKED_STATE;
  private readonly listeners = new Set<() => void>();
  private fiber: FiberLike | null = null;
  private running: BrowserFiberNode | null = null;
  private held: NodeLockHandle | null = null;

  constructor(private readonly deps: NodeControllerDeps) {}

  readonly getState = (): NodeState => this.state;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** The running node, or null. */
  get node(): BrowserFiberNode | null {
    return this.running;
  }

  /**
   * Starts the node with `keys` (wiped afterwards), dialling `bootnodes` from its config. The config, built afresh each
   * time, leaves CKB channels to be accepted by the app (hub-accept.ts) and whitelists the hub's tokens (`udtWhitelist`,
   * from GET /v1/fiber/node). True once it runs.
   */
  async start(keys: NodeKeys, bootnodes: readonly string[], udtWhitelist: readonly WhitelistEntry[] = []): Promise<boolean> {
    if (this.state.phase === "starting" || this.state.phase === "running") {
      wipeKeys(keys);
      return this.state.phase === "running";
    }
    this.set({ ...LOCKED_STATE, phase: "starting" });
    const { config } = this.deps;
    try {
      const lock = await this.deps.lock(nodeLockName(config.network));
      if (!lock) {
        this.set({ ...LOCKED_STATE, phase: "other-tab" });
        return false;
      }
      this.held = lock;
      const fiber = await this.deps.load();
      this.fiber = fiber;
      const yaml = browserNodeConfig(fiber.getDefaultConfig?.(config.network, config.ckbRpcUrl) ?? "", bootnodes, undefined, udtWhitelist);
      await fiber.start(yaml, keys.fiberKey, keys.ckbKey, undefined, FIBER_LOG_LEVEL, databasePrefix(config.network, keyTag(keys)));
      const node = (this.deps.wrap ?? ((f: FiberLike) => new FiberJsNode(f)))(fiber);
      const info = await node.info();
      this.running = node;
      this.set({ phase: "running", info, error: null, exclusive: lock.exclusive, udts: readUdtWhitelist(yaml) });
      return true;
    } catch (e) {
      await this.teardown();
      this.set({ ...LOCKED_STATE, phase: "failed", error: fiberErrorMessage(e) });
      return false;
    } finally {
      wipeKeys(keys);
    }
  }

  /** Stops the node and frees the lock. fiber-js 0.9.1 can cut a database write on stop, so call it only when idle. */
  async stop(): Promise<void> {
    await this.teardown();
    this.set(LOCKED_STATE);
  }

  private async teardown(): Promise<void> {
    const fiber = this.fiber;
    this.fiber = null;
    this.running = null;
    try {
      await fiber?.stop();
    } catch {
      // The workers are gone either way.
    }
    this.held?.release();
    this.held = null;
  }

  private set(next: NodeState): void {
    this.state = next;
    for (const listener of this.listeners) listener();
  }
}
