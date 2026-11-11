import type { PriceSource } from "../../application/ports/prices.port";

const normalizeName = (name: string): string => name.trim().toLowerCase();

/**
 * The sources named in config, in config order, each once. Throws at start-up on an empty list or an unknown name, so a
 * typo in PRICE_SOURCES cannot silently leave the hub without prices.
 */
export function selectPriceSources(names: readonly string[], available: readonly PriceSource[]): PriceSource[] {
  const wanted = [...new Set(names.map(normalizeName).filter(Boolean))];
  if (wanted.length === 0) throw new Error("Invalid hub configuration: PRICE_SOURCES must name at least one price source.");

  return wanted.map((name) => {
    const source = available.find((candidate) => candidate.name === name);
    if (source) return source;
    const known = available.map((candidate) => candidate.name).join(", ");
    throw new Error(`Invalid hub configuration: unknown price source "${name}" in PRICE_SOURCES. Known sources: ${known}.`);
  });
}
