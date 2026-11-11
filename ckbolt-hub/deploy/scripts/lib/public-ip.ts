import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { CommandRunner } from "./process";

/** The SSH host's real name as `ssh -G` resolves it (aliases in ~/.ssh/config included). */
const SSH_CONFIG_HOSTNAME_KEY = "hostname";
const IPV4 = 4;

/** The `hostname` line of `ssh -G <host>` output; null when absent. */
export function sshConfigHostname(output: string): string | null {
  for (const line of output.split("\n")) {
    const [key, value] = line.trim().split(/\s+/, 2);
    if (key?.toLowerCase() === SSH_CONFIG_HOSTNAME_KEY && value) return value;
  }
  return null;
}

/**
 * The server's public IPv4 address, from the SSH host: the address itself when ~/.ssh/config names one, else the IPv4
 * address its name resolves to. Null when neither works (set DEPLOY_PUBLIC_IP then).
 */
export async function publicIpOfSshHost(host: string, runLocal: CommandRunner): Promise<string | null> {
  const result = await runLocal("ssh", ["-G", host]);
  const hostname = result.exitCode === 0 ? (sshConfigHostname(result.stdout) ?? host) : host;
  if (isIP(hostname) === IPV4) return hostname;
  try {
    return (await lookup(hostname, { family: IPV4 })).address;
  } catch {
    return null;
  }
}
