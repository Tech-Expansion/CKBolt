import { Inject, Injectable, type CanActivate } from "@nestjs/common";
import { DEMO_WALLET, type DemoWallet } from "../../../application/demo/demo-wallet.contract";
import { DemoDisabledError } from "../../../application/demo/demo.errors";

/** Demo routes answer 404 demo_disabled when the hub runs without demo nodes, before any demo budget is spent. */
@Injectable()
export class DemoEnabledGuard implements CanActivate {
  constructor(@Inject(DEMO_WALLET) private readonly demo: DemoWallet) {}

  canActivate(): boolean {
    if (!this.demo.enabled) throw new DemoDisabledError();
    return true;
  }
}
