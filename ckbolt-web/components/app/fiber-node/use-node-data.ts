"use client";

import { useCallback, useEffect, useState } from "react";
import type { Script } from "@/lib/hub/contract";
import type { CkbRpcClient } from "@/lib/wallets/fiber-browser/ckb-rpc";
import { fiberErrorMessage } from "@/lib/wallets/fiber-browser/errors";
import type { BrowserFiberNode, NodeChannel } from "@/lib/wallets/fiber-browser/node-port";
import { NODE_TIMING } from "@/lib/wallets/fiber-browser/constants";
import { usePolling } from "./use-polling";

export interface NodeData {
  channels: NodeChannel[];
  /** Node ids of the connected peers. */
  peers: string[];
  /** Shannons in plain cells at the node's address, or null until read. */
  balance: bigint | null;
  balanceError: string | null;
  nodeError: string | null;
  refreshNode: () => Promise<void>;
  refreshBalance: () => Promise<void>;
}

/** The running node's channels and peers (from the node) and its on-chain balance (from the CKB RPC), kept fresh. */
export function useNodeData(node: BrowserFiberNode | null, fundingLock: Script | null, rpc: CkbRpcClient): NodeData {
  const [channels, setChannels] = useState<NodeChannel[]>([]);
  const [peers, setPeers] = useState<string[]>([]);
  const [balance, setBalance] = useState<bigint | null>(null);
  const [balanceError, setBalanceError] = useState<string | null>(null);
  const [nodeError, setNodeError] = useState<string | null>(null);

  const refreshNode = useCallback(async () => {
    if (!node) return;
    try {
      const [nextChannels, nextPeers] = await Promise.all([node.listChannels(), node.listPeers()]);
      setChannels(nextChannels);
      setPeers(nextPeers);
      setNodeError(null);
    } catch (e) {
      setNodeError(fiberErrorMessage(e));
    }
  }, [node]);

  const refreshBalance = useCallback(async () => {
    if (!fundingLock) return;
    try {
      setBalance(await rpc.spendableCapacity(fundingLock));
      setBalanceError(null);
    } catch (e) {
      setBalanceError(e instanceof Error ? e.message : String(e));
    }
  }, [fundingLock, rpc]);

  // A stopped node shows nothing old.
  useEffect(() => {
    if (node) return;
    setChannels([]);
    setPeers([]);
    setNodeError(null);
  }, [node]);
  useEffect(() => {
    if (fundingLock) return;
    setBalance(null);
    setBalanceError(null);
  }, [fundingLock]);

  usePolling(refreshNode, NODE_TIMING.nodePollMs, node !== null);
  usePolling(refreshBalance, NODE_TIMING.balancePollMs, fundingLock !== null);

  return { channels, peers, balance, balanceError, nodeError, refreshNode, refreshBalance };
}
