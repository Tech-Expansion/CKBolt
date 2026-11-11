import { Body, Param } from "@nestjs/common";
import type { ZodTypeAny } from "zod";
import { ROUTE_PARAM } from "../../../common/constants/http.constants";
import { fiberNodeIdSchema, lnPubkeySchema, uuidSchema } from "../contract/requests";
import { ZodValidationPipe } from "../pipes/zod-validation.pipe";

/** The request body, validated and parsed with `schema`. */
export const ValidBody = (schema: ZodTypeAny): ParameterDecorator => Body(new ZodValidationPipe(schema));

/** The `:id` route parameter, required to be a UUID. */
export const IdParam = (): ParameterDecorator => Param(ROUTE_PARAM.ID, new ZodValidationPipe(uuidSchema));

/** The `:nodeId` route parameter, required to be a Fiber node id; read as lower-case hex without 0x. */
export const NodeIdParam = (): ParameterDecorator => Param(ROUTE_PARAM.NODE_ID, new ZodValidationPipe(fiberNodeIdSchema));

/** The `:pubkey` route parameter, required to be a Lightning node public key; read as lower-case hex. */
export const LnPubkeyParam = (): ParameterDecorator => Param(ROUTE_PARAM.PUBKEY, new ZodValidationPipe(lnPubkeySchema));
