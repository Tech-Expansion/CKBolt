import { Module } from "@nestjs/common";
import { readPackageVersion } from "../../common/utils/package-version.util";
import { HEALTH_SERVICE } from "./health.contract";
import { HealthServiceImpl } from "./health.service";
import { HUB_VERSION } from "./health.tokens";

/** The health check (HEALTH_SERVICE). LIGHTNING, FIBER and HUB_CONFIG come from global modules. */
@Module({
  providers: [
    { provide: HUB_VERSION, useFactory: () => readPackageVersion(__dirname) },
    HealthServiceImpl,
    { provide: HEALTH_SERVICE, useExisting: HealthServiceImpl },
  ],
  exports: [HEALTH_SERVICE],
})
export class HealthModule {}
