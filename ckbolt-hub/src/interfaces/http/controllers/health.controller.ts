import { Controller, Get, Inject, Res } from "@nestjs/common";
import type { Response } from "express";
import { API_ROUTES } from "../../../common/constants/api.constants";
import { HEALTH_HTTP_STATUS } from "../../../common/constants/http.constants";
import { HEALTH_SERVICE, type HealthService } from "../../../application/health/health.contract";
import { resourcePath, type HealthDto } from "../contract/responses";
import { toHealthDto } from "../presenters/api.presenter";

@Controller(resourcePath(API_ROUTES.HEALTH))
export class HealthController {
  constructor(@Inject(HEALTH_SERVICE) private readonly health: HealthService) {}

  /** GET /v1/health: 200 when both nodes answer, 503 (same body) when the hub is degraded. */
  @Get()
  async get(@Res({ passthrough: true }) response: Response): Promise<HealthDto> {
    const report = await this.health.check();
    response.status(HEALTH_HTTP_STATUS[report.status]);
    return toHealthDto(report);
  }
}
