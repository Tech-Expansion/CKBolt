import type { ArgumentMetadata, PipeTransform } from "@nestjs/common";
import type { z, ZodTypeAny } from "zod";
import { formatValidationIssues } from "../../../common/utils/validation-message.util";
import { RequestValidationError } from "../errors/http.errors";

/**
 * Validates and parses a body or route parameter with a zod schema from the HTTP contract. Returns the parsed value
 * (defaults applied); throws RequestValidationError (400 validation_failed) with every issue in one plain message.
 */
export class ZodValidationPipe<T extends ZodTypeAny> implements PipeTransform<unknown, z.output<T>> {
  constructor(private readonly schema: T) {}

  transform(value: unknown, metadata: ArgumentMetadata): z.output<T> {
    const result = this.schema.safeParse(value);
    if (result.success) return result.data as z.output<T>;
    throw new RequestValidationError(formatValidationIssues(result.error.issues, metadata.data ?? metadata.type));
  }
}
