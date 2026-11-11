/** Builders for the SQL text the store prepares once. Column lists come from compile-checked row types. */

/** Every column of a row type, checked by the compiler: a missing or unknown column is a type error. */
export const columnsOf = <Row>(columns: Record<keyof Row & string, true>): (keyof Row & string)[] =>
  Object.keys(columns) as (keyof Row & string)[];

const namedParameter = (column: string): string => `@${column}`;

/** `?, ?, ?`: one positional parameter per value of an IN list. */
export const positionalParameters = (count: number): string => Array.from({ length: count }, () => "?").join(", ");

export const selectSql = (table: string, columns: readonly string[]): string => `SELECT ${columns.join(", ")} FROM ${table}`;

/** INSERT binding each column to the named parameter of the same name (`@column`). */
export const insertSql = (table: string, columns: readonly string[]): string =>
  `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(namedParameter).join(", ")})`;

/** `a = @a, b = @b`, for UPDATE ... SET. */
export const assignmentsSql = (columns: readonly string[]): string =>
  columns.map((column) => `${column} = ${namedParameter(column)}`).join(", ");

/** `a = excluded.a, b = excluded.b`, for INSERT ... ON CONFLICT DO UPDATE SET. */
export const upsertAssignmentsSql = (columns: readonly string[]): string =>
  columns.map((column) => `${column} = excluded.${column}`).join(", ");
