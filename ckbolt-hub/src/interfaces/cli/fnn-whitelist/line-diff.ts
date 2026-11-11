/** Unchanged lines shown around each change. */
const CONTEXT_LINES = 3;

/** One step from the old lines to the new: kept, removed or added; the indexes are where it starts in each text. */
type Op = { kind: " " | "-" | "+"; text: string; oldIndex: number; newIndex: number };

const toLines = (text: string): string[] => (text === "" ? [] : text.replace(/\r?\n$/, "").split(/\r?\n/));

/** The edit script from `a` to `b` by longest common subsequence (the files are a few hundred lines at most). */
function editScript(a: readonly string[], b: readonly string[]): Op[] {
  const common: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      common[i]![j] = a[i] === b[j] ? common[i + 1]![j + 1]! + 1 : Math.max(common[i + 1]![j]!, common[i]![j + 1]!);
    }
  }
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    const at = { oldIndex: i, newIndex: j };
    if (i < a.length && j < b.length && a[i] === b[j]) {
      ops.push({ kind: " ", text: a[i]!, ...at });
      i += 1;
      j += 1;
    } else if (i < a.length && (j === b.length || common[i + 1]![j]! >= common[i]![j + 1]!)) {
      ops.push({ kind: "-", text: a[i]!, ...at });
      i += 1;
    } else {
      ops.push({ kind: "+", text: b[j]!, ...at });
      j += 1;
    }
  }
  return ops;
}

/** Runs of ops to show: each change with its context, merged when the contexts touch. Inclusive index pairs. */
function hunks(ops: readonly Op[]): Array<[number, number]> {
  const groups: Array<[number, number]> = [];
  ops.forEach((op, index) => {
    if (op.kind === " ") return;
    const start = Math.max(0, index - CONTEXT_LINES);
    const end = Math.min(ops.length - 1, index + CONTEXT_LINES);
    const previous = groups[groups.length - 1];
    if (previous && start <= previous[1] + 1) previous[1] = end;
    else groups.push([start, end]);
  });
  return groups;
}

/** `@@ -start,count +start,count @@`, 1-based; an empty side starts at the line before it, as diff writes it. */
function hunkHeader(slice: readonly Op[]): string {
  const oldCount = slice.filter((op) => op.kind !== "+").length;
  const newCount = slice.filter((op) => op.kind !== "-").length;
  const first = slice[0]!;
  const oldStart = oldCount === 0 ? first.oldIndex : first.oldIndex + 1;
  const newStart = newCount === 0 ? first.newIndex : first.newIndex + 1;
  return `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`;
}

/** A unified diff of two texts by line (line ends aside), "" when they have the same lines. */
export function unifiedDiff(before: string, after: string, beforeLabel: string, afterLabel: string): string {
  const ops = editScript(toLines(before), toLines(after));
  const groups = hunks(ops);
  if (groups.length === 0) return "";
  const body = groups.flatMap(([start, end]) => {
    const slice = ops.slice(start, end + 1);
    return [hunkHeader(slice), ...slice.map((op) => `${op.kind}${op.text}`)];
  });
  return [`--- ${beforeLabel}`, `+++ ${afterLabel}`, ...body].join("\n") + "\n";
}
