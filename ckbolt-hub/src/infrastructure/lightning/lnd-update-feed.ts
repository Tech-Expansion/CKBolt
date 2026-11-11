import type { EventEmitter } from "node:events";
import type { LoggerService } from "@nestjs/common";
import { LIGHTNING_LIB_EVENT } from "../../common/constants/lnd.constants";
import { describeError } from "../../common/utils/error.util";
import { toHex32 } from "../../common/utils/hex.util";
import type { Hex32 } from "../../domain/types";
import { readLndError } from "./lnd.errors";

export type UpdateListener = (paymentHash: Hex32) => void;

/** The part of an invoice update the feed reads. */
interface UpdatedInvoice {
  id: string;
}

/**
 * Push hints behind LightningPort.onUpdate. While anyone listens, it follows LND's invoice stream (the `lightning`
 * package restarts it after transient errors); payment outcomes arrive through `notify`. A failing listener is logged,
 * never thrown back into an LND stream.
 */
export class LndUpdateFeed {
  private readonly listeners = new Set<UpdateListener>();
  private invoiceStream: EventEmitter | null = null;

  constructor(
    private readonly openInvoiceStream: () => EventEmitter,
    private readonly logger: LoggerService,
  ) {}

  subscribe(listener: UpdateListener): () => void {
    this.listeners.add(listener);
    this.invoiceStream ??= this.watchInvoices();
    return () => this.unsubscribe(listener);
  }

  notify(paymentHash: Hex32): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(paymentHash);
      } catch (error) {
        this.logger.warn(`A Lightning update listener failed: ${describeError(error)}`);
      }
    }
  }

  close(): void {
    this.listeners.clear();
    this.stopInvoiceStream();
  }

  private unsubscribe(listener: UpdateListener): void {
    this.listeners.delete(listener);
    if (this.listeners.size === 0) this.stopInvoiceStream();
  }

  private watchInvoices(): EventEmitter {
    const stream = this.openInvoiceStream();
    stream.on(LIGHTNING_LIB_EVENT.INVOICE_UPDATED, (invoice: UpdatedInvoice) => this.notify(toHex32(invoice.id)));
    stream.on(LIGHTNING_LIB_EVENT.ERROR, (error: unknown) => {
      const { details, name } = readLndError(error);
      this.logger.warn(`The LND invoice stream stopped; invoice updates now come from polling only: ${details || name}`);
    });
    stream.on(LIGHTNING_LIB_EVENT.END, () => {
      if (this.invoiceStream === stream) this.invoiceStream = null;
    });
    return stream;
  }

  /** Removing the listeners ends the package's invoice subscription. */
  private stopInvoiceStream(): void {
    this.invoiceStream?.removeAllListeners();
    this.invoiceStream = null;
  }
}
