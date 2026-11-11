import { readFileSync } from "node:fs";
import { join } from "node:path";
import { API_ERROR_CODE, API_ROUTES } from "../../../src/common/constants/api.constants";

/**
 * The public contract is documented where the coding rules say: every API_ERROR_CODE in docs/architecture.md's error
 * table with its status (inbound_disabled added by this part), and the three Fiber node routes in the REST table.
 */

const ARCHITECTURE = readFileSync(join(__dirname, "..", "..", "..", "docs", "architecture.md"), "utf8");

/** The rows of the error table: "| `code` | status | when |". */
const errorTableRows = (): Map<string, string> =>
  new Map(
    ARCHITECTURE.split(/\r?\n/)
      .map((line) => /^\| `([a-z_]+)` \| ([^|]+) \|/.exec(line))
      .filter((match): match is RegExpExecArray => match !== null)
      .map((match) => [match[1] ?? "", (match[2] ?? "").trim()]),
  );

describe("docs/architecture.md documents the Fiber node API", () => {
  it("has a row for every API error code", () => {
    const rows = errorTableRows();
    for (const code of Object.values(API_ERROR_CODE)) expect(rows.has(code)).toBe(true);
  });

  it("documents inbound_disabled as a 404", () => {
    expect(API_ERROR_CODE.INBOUND_DISABLED).toBe("inbound_disabled");
    expect(errorTableRows().get("inbound_disabled")).toBe("404");
  });

  it("lists the three routes in the REST table, with their success statuses", () => {
    expect(API_ROUTES.FIBER_NODE).toBe("fiber/node");
    expect(API_ROUTES.FIBER_INBOUND_CHANNELS).toBe("fiber/inbound-channels");
    expect(ARCHITECTURE).toMatch(/\| GET \| `\/v1\/fiber\/node` \| 200/);
    expect(ARCHITECTURE).toMatch(/\| POST \| `\/v1\/fiber\/inbound-channels` \| 202/);
    expect(ARCHITECTURE).toMatch(/\| GET \| `\/v1\/fiber\/inbound-channels\/:nodeId` \| 200/);
  });
});
