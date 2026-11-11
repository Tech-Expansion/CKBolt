import { Module, type DynamicModule, type ModuleMetadata } from "@nestjs/common";
import { DEMO_WALLET } from "./demo-wallet.contract";
import { DemoWalletService } from "./demo-wallet.service";

export interface DemoModuleOptions {
  /** Modules that export SWAP_ENGINE (unless it is global). DEMO_LIGHTNING, DEMO_FIBER and the config are global. */
  imports?: ModuleMetadata["imports"];
}

/** The demo wallet (DEMO_WALLET). The composition root says where the swap engine comes from. */
@Module({})
export class DemoModule {
  static register(options: DemoModuleOptions = {}): DynamicModule {
    return {
      module: DemoModule,
      imports: options.imports ?? [],
      providers: [DemoWalletService, { provide: DEMO_WALLET, useExisting: DemoWalletService }],
      exports: [DEMO_WALLET],
    };
  }
}
