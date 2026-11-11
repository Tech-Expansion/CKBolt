/** Helpers shared by the swap engine's direction flows. Pure. */

/** The smallest value, or null for an empty list (Math.min would give Infinity). */
export const earliestOf = (values: readonly number[]): number | null => (values.length === 0 ? null : Math.min(...values));

/**
 * `value` when it is set. Throws when it is null or undefined: for fields an earlier step must have saved, so a
 * missing one is a bug, never a user error.
 */
export function requirePresent<T>(value: T | null | undefined, name: string): T {
  if (value === null || value === undefined) throw new Error(`${name} is required at this point but is missing.`);
  return value;
}
