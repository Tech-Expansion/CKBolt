import type { Response } from "express";
import { HTTP_HEADER } from "../../common/constants/http.constants";

/** Location of a resource a POST just created (`201 Created`). */
export const setLocation = (response: Response, path: string): void => {
  response.setHeader(HTTP_HEADER.LOCATION, path);
};

export const setHeaders = (response: Response, headers: Record<string, string>): void => {
  for (const [name, value] of Object.entries(headers)) response.setHeader(name, value);
};
