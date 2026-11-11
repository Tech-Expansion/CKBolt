import { CKB_FAUCET, MUTINYNET_FAUCET } from "../../scripts/lib/constants";
import type { HttpRequest } from "../../scripts/lib/http";
import type { DeploySettings } from "../../scripts/lib/settings";
import { FakeHttp, json } from "./fakes";

/**
 * The public services the scripts call over HTTP from this machine, faked on one FakeHttp: the CKB testnet RPC
 * (get_cells_capacity per lock args), the CKB faucet (claims) and the Mutinynet faucet (its page and /api/bolt11).
 */

const GET_CELLS_CAPACITY = "get_cells_capacity";

interface JsonRpcRequest {
  id: number;
  method: string;
  params: { script: { args: string } }[];
}

export class FakeNetwork {
  readonly http = new FakeHttp();
  /** Shannons each fnn wallet holds on chain, by its lock script's args. */
  readonly capacities = new Map<string, bigint>();
  /** Status of the CKB faucet's answer to a claim. */
  claimStatus = 201;
  /** Status of the Mutinynet faucet's page. */
  faucetHomeStatus = 200;
  /** Status of /api/bolt11; anything else than 2xx is a refusal. */
  bolt11Status = 200;
  /** When false, /api/bolt11 answers 200 without a bolt11 field. */
  bolt11HasInvoice = true;
  /** A JSON-RPC error message the CKB RPC answers with instead of a result. */
  ckbRpcError: string | null = null;
  private invoiceCount = 0;

  constructor(private readonly settings: DeploySettings) {
    this.http.on((request) => this.answer(request));
  }

  private answer(request: HttpRequest) {
    const { urls } = this.settings;
    if (request.method === "POST" && request.url === urls.ckbRpc) {
      const body = request.json as JsonRpcRequest;
      if (body.method !== GET_CELLS_CAPACITY) return json(200, { jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "method not found" } });
      if (this.ckbRpcError) return json(200, { jsonrpc: "2.0", id: body.id, error: { code: -1, message: this.ckbRpcError } });
      const capacity = this.capacities.get(body.params[0]?.script.args ?? "") ?? 0n;
      return json(200, { jsonrpc: "2.0", id: body.id, result: { capacity: `0x${capacity.toString(16)}`, block_hash: `0x${"0".repeat(64)}`, block_number: "0x1" } });
    }
    if (request.method === "POST" && request.url === `${urls.ckbFaucetApi}${CKB_FAUCET.CLAIM_PATH}`) {
      return json(this.claimStatus, this.claimStatus < 300 ? { data: { id: "1" } } : { error: "monthly limit reached" });
    }
    if (request.method === "GET" && request.url === urls.mutinynetFaucet) return { status: this.faucetHomeStatus, text: "<html>Mutinynet faucet</html>" };
    if (request.method === "POST" && request.url === `${urls.mutinynetFaucet}${MUTINYNET_FAUCET.BOLT11_PATH}`) {
      if (this.bolt11Status >= 300) return { status: this.bolt11Status, text: "Too Many Requests" };
      this.invoiceCount += 1;
      const sats = (request.json as { amount_sats: number }).amount_sats;
      return json(200, this.bolt11HasInvoice ? { bolt11: `lntbs${sats}faucet${this.invoiceCount}` } : {});
    }
    return undefined;
  }

  /** Every request to one URL. */
  requestsTo(url: string): HttpRequest[] {
    return this.http.requests.filter((request) => request.url === url);
  }

  /** The CKB faucet claims made, as { address, amount }. */
  claims(): { address: string; amount: string }[] {
    return this.requestsTo(`${this.settings.urls.ckbFaucetApi}${CKB_FAUCET.CLAIM_PATH}`).map((request) => {
      const event = (request.json as { claim_event: { address_hash: string; amount: string } }).claim_event;
      return { address: event.address_hash, amount: event.amount };
    });
  }

  /** The amounts of the Mutinynet faucet invoices asked for. */
  faucetInvoiceAmounts(): number[] {
    return this.requestsTo(`${this.settings.urls.mutinynetFaucet}${MUTINYNET_FAUCET.BOLT11_PATH}`).map(
      (request) => (request.json as { amount_sats: number }).amount_sats,
    );
  }
}
