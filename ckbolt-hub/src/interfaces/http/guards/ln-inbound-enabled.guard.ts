import { Inject, Injectable, type CanActivate } from "@nestjs/common";
import { LIGHTNING_NODE_ERROR } from "../../../application/lightning-node/lightning-node.errors";
import { LN_INBOUND_CHANNELS, type LnInboundChannels } from "../../../application/lightning-node/ln-inbound-channels.contract";

/** Inbound Lightning channel routes answer 404 inbound_disabled when the hub opens none, before the request is read. */
@Injectable()
export class LnInboundEnabledGuard implements CanActivate {
  constructor(@Inject(LN_INBOUND_CHANNELS) private readonly inbound: LnInboundChannels) {}

  canActivate(): boolean {
    if (!this.inbound.enabled) throw LIGHTNING_NODE_ERROR.inboundDisabled();
    return true;
  }
}
