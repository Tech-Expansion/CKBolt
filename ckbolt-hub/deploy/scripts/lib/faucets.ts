import { CKB_FAUCET, MUTINYNET_FAUCET } from "./constants";
import { isSuccess, parseJsonBody, type HttpClient, type HttpResponse } from "./http";

/**
 * The Mutinynet faucet's unauthenticated API: it makes invoices of its own Lightning node (`/api/bolt11`, 60 per day per
 * IP). Paying one moves sats to the faucet's side of a channel, which is how the hub's LND gets inbound liquidity, and
 * gives testnet:smoke a real payout destination.
 */
export class MutinynetFaucet {
  constructor(
    private readonly http: HttpClient,
    private readonly baseUrl: string,
    private readonly timeoutMs: number,
  ) {}

  async invoice(sats: bigint): Promise<string> {
    const description = `Mutinynet faucet invoice for ${sats} sats`;
    const response = await this.http({
      method: "POST",
      url: `${this.baseUrl}${MUTINYNET_FAUCET.BOLT11_PATH}`,
      json: { amount_sats: Number(sats) },
      timeoutMs: this.timeoutMs,
    });
    if (!isSuccess(response.status)) throw new Error(`${description}: HTTP ${response.status} ${response.text.trim().slice(0, 200)}`);
    const { bolt11 } = parseJsonBody<{ bolt11?: string }>(response, description);
    if (!bolt11) throw new Error(`${description}: the answer has no bolt11`);
    return bolt11;
  }

  /** The faucet's web page, to tell whether the faucet is up (read-only). */
  home(): Promise<HttpResponse> {
    return this.http({ method: "GET", url: this.baseUrl, timeoutMs: this.timeoutMs });
  }
}

/**
 * The CKB testnet faucet's API (faucet.nervos.org): a claim needs no login or captcha; each address gets at most
 * 300,000 CKB per calendar month. The answer's format is not documented, so callers show it rather than parse it.
 */
export class CkbFaucet {
  constructor(
    private readonly http: HttpClient,
    private readonly apiUrl: string,
    private readonly timeoutMs: number,
  ) {}

  claim(address: string, wholeCkb: string): Promise<HttpResponse> {
    return this.http({
      method: "POST",
      url: `${this.apiUrl}${CKB_FAUCET.CLAIM_PATH}`,
      json: { claim_event: { address_hash: address, amount: wholeCkb } },
      timeoutMs: this.timeoutMs,
    });
  }

  /** The address's claims (read-only). */
  claims(address: string): Promise<HttpResponse> {
    const query = new URLSearchParams({ address_hash: address });
    return this.http({ method: "GET", url: `${this.apiUrl}${CKB_FAUCET.CLAIM_PATH}?${query}`, timeoutMs: this.timeoutMs });
  }
}
