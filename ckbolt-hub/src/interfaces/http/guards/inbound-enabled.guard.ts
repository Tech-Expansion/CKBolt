import { Inject, Injectable, type CanActivate } from "@nestjs/common";
import { FIBER_NODE_ERROR } from "../../../application/fiber-node/fiber-node.errors";
import { INBOUND_CHANNELS, type InboundChannels } from "../../../application/fiber-node/inbound-channels.contract";

/** Inbound channel routes answer 404 inbound_disabled when the hub opens none, before the request is read. */
@Injectable()
export class InboundEnabledGuard implements CanActivate {
  constructor(@Inject(INBOUND_CHANNELS) private readonly inbound: InboundChannels) {}

  canActivate(): boolean {
    if (!this.inbound.enabled) throw FIBER_NODE_ERROR.inboundDisabled();
    return true;
  }
}
