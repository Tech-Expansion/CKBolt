import { randomBytes } from "node:crypto";
import type { Page } from "@playwright/test";
import { WEBLN_READY_EVENT } from "../../../lib/wallets/lightning/constants";

/*
 * The visitor's browser Lightning wallet, faked for Playwright: a WebLN provider as `window.webln` (a browser extension
 * such as Alby), injected before the page loads or later with webln:ready. The test decides each answer and when it
 * comes. Paying by QR code or a pasted invoice happens in the visitor's own wallet, outside the page: the fake hub's
 * state stands in for it.
 */

export const hex32 = () => randomBytes(32).toString("hex");

/** A promise the test resolves later: a wallet that answers only when the test says so. */
export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => (resolve = res));
  return { promise, resolve };
}

export type WeblnReply = { ok: unknown } | { error: string };
const WEBLN_BRIDGE = "__lnTestWeblnCall";
/** A late provider is injected by calling this global from the test. */
export const WEBLN_INJECT = "__lnTestInjectWebln";

/** A WebLN provider as an extension injects it: now, or later with the webln:ready event. Runs in the browser. */
function installWebln({ bridge, late, inject, readyEvent }: { bridge: string; late: boolean; inject: string; readyEvent: string }) {
  type Reply = { ok: unknown } | { error: string };
  const w = window as unknown as Record<string, unknown>;
  const call = async (method: string, args: unknown) => {
    const reply = (await (w[bridge] as (m: string, a: unknown) => Promise<Reply>)(method, args)) as Reply;
    if ("ok" in reply) return reply.ok;
    // WebLN has no error codes: providers reject with plain messages.
    throw new Error(reply.error);
  };
  const provider = {
    enable: () => call("enable", null),
    sendPayment: (paymentRequest: string) => call("sendPayment", paymentRequest),
  };
  const put = () => {
    w.webln = provider;
    window.dispatchEvent(new Event(readyEvent));
  };
  if (late) w[inject] = put;
  else w.webln = provider;
}

/** A scripted WebLN wallet: records every call; `enable` and `sendPayment` answer as the test sets them. */
export class FakeWebln {
  readonly calls: { method: string; args: unknown }[] = [];
  enable: () => WeblnReply = () => ({ ok: null });
  sendPayment: (invoice: string) => WeblnReply | Promise<WeblnReply> = () => ({ ok: { preimage: hex32() } });

  async install(page: Page, opts: { late?: boolean } = {}) {
    await page.exposeFunction(WEBLN_BRIDGE, (method: string, args: unknown) => this.handle(method, args));
    await page.addInitScript(installWebln, { bridge: WEBLN_BRIDGE, late: !!opts.late, inject: WEBLN_INJECT, readyEvent: WEBLN_READY_EVENT });
  }

  /** Injects a late provider now, as an extension that loads after the page does. */
  async inject(page: Page) {
    await page.evaluate((name) => (window as unknown as Record<string, () => void>)[name](), WEBLN_INJECT);
  }

  of(method: string) {
    return this.calls.filter((c) => c.method === method);
  }

  private async handle(method: string, args: unknown): Promise<WeblnReply> {
    this.calls.push({ method, args });
    switch (method) {
      case "enable":
        return this.enable();
      case "sendPayment":
        return this.sendPayment(args as string);
      default:
        return { error: `unknown method ${method}` };
    }
  }
}
