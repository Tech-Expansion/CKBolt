import { HubError } from "../errors/hub.error";

/**
 * Runs `call`. A HubError it throws passes through unchanged (it already tells the user what is wrong); anything else
 * is replaced by `toHubError(error)`, which keeps the original as its cause.
 */
export async function rethrowAsHubError<T>(call: () => Promise<T>, toHubError: (error: unknown) => HubError): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof HubError) throw error;
    throw toHubError(error);
  }
}
