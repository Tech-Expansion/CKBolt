import { unifiedDiff } from "../../../src/interfaces/cli/fnn-whitelist/line-diff";
import { FIXTURE, GOLDEN } from "./fnn-whitelist.fixtures";

/** unifiedDiff: the diff the CLI prints, in `diff -u` form (always with ",count"), line ends aside. */

const lines = (count: number, change: Record<number, string> = {}): string =>
  Array.from({ length: count }, (_, i) => change[i + 1] ?? `l${i + 1}`).join("\n") + "\n";

describe("unifiedDiff", () => {
  it.each([
    ["the same text", "a\nb\n", "a\nb\n"],
    ["two empty texts", "", ""],
    ["CRLF against LF", "a\r\nb\r\n", "a\nb\n"],
    ["a missing final line end", "a\nb", "a\nb\n"],
  ])("is empty for %s", (_case, before, after) => {
    expect(unifiedDiff(before, after, "old", "new")).toBe("");
  });

  it("starts with the two labels and shows one change with three lines of context on each side", () => {
    expect(unifiedDiff(lines(10), lines(10, { 5: "L5" }), "fnn/hub.yml", "fnn/hub.yml (generated)")).toBe(
      ["--- fnn/hub.yml", "+++ fnn/hub.yml (generated)", "@@ -2,7 +2,7 @@", " l2", " l3", " l4", "-l5", "+L5", " l6", " l7", " l8", ""].join("\n"),
    );
  });

  it("splits changes more than six lines apart into hunks with their own line numbers", () => {
    expect(unifiedDiff(lines(20), lines(20, { 3: "L3", 17: "L17" }), "a", "b")).toBe(
      [
        "--- a",
        "+++ b",
        "@@ -1,6 +1,6 @@",
        " l1",
        " l2",
        "-l3",
        "+L3",
        " l4",
        " l5",
        " l6",
        "@@ -14,7 +14,7 @@",
        " l14",
        " l15",
        " l16",
        "-l17",
        "+L17",
        " l18",
        " l19",
        " l20",
        "",
      ].join("\n"),
    );
  });

  it("merges changes six lines apart into one hunk, and keeps seven apart as two (as diff -u)", () => {
    const six = unifiedDiff(lines(20), lines(20, { 3: "L3", 10: "L10" }), "a", "b");
    const seven = unifiedDiff(lines(20), lines(20, { 3: "L3", 11: "L11" }), "a", "b");
    expect(six.match(/^@@.*@@$/gm)).toEqual(["@@ -1,13 +1,13 @@"]);
    expect(seven.match(/^@@.*@@$/gm)).toEqual(["@@ -1,6 +1,6 @@", "@@ -8,7 +8,7 @@"]);
  });

  it("counts added and removed lines in the hunk header", () => {
    expect(unifiedDiff("b\nc\n", "a\nb\nc\n", "a", "b")).toBe("--- a\n+++ b\n@@ -1,2 +1,3 @@\n+a\n b\n c\n");
    expect(unifiedDiff("a\nb\nc\nd\ne\n", "a\nb\nc\nd\ne\nf\n", "a", "b")).toBe("--- a\n+++ b\n@@ -3,3 +3,4 @@\n c\n d\n e\n+f\n");
    expect(unifiedDiff("a\nx\nb\n", "a\nb\n", "a", "b")).toBe("--- a\n+++ b\n@@ -1,3 +1,2 @@\n a\n-x\n b\n");
  });

  it("starts an empty side at line 0", () => {
    expect(unifiedDiff("", "a\nb\n", "a", "b")).toBe("--- a\n+++ b\n@@ -0,0 +1,2 @@\n+a\n+b\n");
    expect(unifiedDiff("a\nb\n", "", "a", "b")).toBe("--- a\n+++ b\n@@ -1,2 +0,0 @@\n-a\n-b\n");
  });

  it("shows a blank line as a context line of one space", () => {
    expect(unifiedDiff("a\n\nb\n", "a\n\nc\n", "a", "b")).toBe("--- a\n+++ b\n@@ -1,3 +1,3 @@\n a\n \n-b\n+c\n");
  });

  it("gives the hunks diff -u gives for the golden files", () => {
    expect(unifiedDiff(FIXTURE.hubYml, GOLDEN.hubYml, "a", "b").match(/^@@.*@@$/gm)).toEqual(["@@ -64,11 +64,13 @@", "@@ -86,6 +88,8 @@"]);
    expect(unifiedDiff(FIXTURE.demoYml, GOLDEN.demoYml, "a", "b").match(/^@@.*@@$/gm)).toEqual(["@@ -61,17 +61,19 @@", "@@ -85,7 +87,7 @@"]);
  });

  it("reapplied by hand, gives the new text back", () => {
    const diff = unifiedDiff(FIXTURE.demoYml, GOLDEN.demoYml, "a", "b");
    expect(applyUnifiedDiff(FIXTURE.demoYml, diff)).toBe(GOLDEN.demoYml);
  });
});

/** A minimal patch: enough to check that the hunks' numbers and lines describe the change exactly. */
function applyUnifiedDiff(before: string, diff: string): string {
  const old = before.replace(/\n$/, "").split("\n");
  const result: string[] = [];
  let next = 0;
  const body = diff.replace(/\n$/, "").split("\n").slice(2);
  for (const line of body) {
    const header = /^@@ -(\d+),(\d+) \+\d+,\d+ @@$/.exec(line);
    if (header) {
      const start = Number(header[2]) === 0 ? Number(header[1]) : Number(header[1]) - 1;
      result.push(...old.slice(next, start));
      next = start;
      continue;
    }
    const kind = line[0];
    const text = line.slice(1);
    if (kind === " " || kind === "-") {
      expect(old[next]).toBe(text);
      next += 1;
    }
    if (kind === " " || kind === "+") result.push(text);
  }
  result.push(...old.slice(next));
  return result.join("\n") + "\n";
}
