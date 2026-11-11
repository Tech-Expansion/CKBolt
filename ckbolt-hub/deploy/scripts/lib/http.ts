/** HTTP calls the scripts make from this machine (faucets, the public CKB RPC), injectable for tests. */

export interface HttpResponse {
  status: number;
  text: string;
}

export interface HttpRequest {
  method: "GET" | "POST";
  url: string;
  /** Sent as a JSON body. */
  json?: unknown;
  timeoutMs: number;
}

export type HttpClient = (request: HttpRequest) => Promise<HttpResponse>;

const JSON_CONTENT_TYPE = "application/json";

export const fetchHttpClient: HttpClient = async ({ method, url, json, timeoutMs }) => {
  const response = await fetch(url, {
    method,
    headers: { accept: JSON_CONTENT_TYPE, ...(json === undefined ? {} : { "content-type": JSON_CONTENT_TYPE }) },
    body: json === undefined ? undefined : JSON.stringify(json),
    signal: AbortSignal.timeout(timeoutMs),
  });
  return { status: response.status, text: await response.text() };
};

/** True for a 2xx status. */
export const isSuccess = (status: number): boolean => status >= 200 && status < 300;

/** Parses a JSON body; the error names what was asked and shows the start of the answer. */
export function parseJsonBody<T>(response: HttpResponse, description: string): T {
  try {
    return JSON.parse(response.text) as T;
  } catch {
    throw new Error(`${description}: HTTP ${response.status}, not JSON: ${response.text.trim().slice(0, 200)}`);
  }
}
