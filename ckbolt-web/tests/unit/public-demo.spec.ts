import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test } from "@playwright/test";
import { ALBY_HUB_DOCKER_RUN, MEGALITH_PEER_URI } from "../../components/app/guide/constants";
import { GUIDE_STEPS } from "../../components/app/guide/copy";
import { FEEDBACK_COPY, FEEDBACK_DEFAULT_URL, feedbackBaseUrl, feedbackUrl } from "../../lib/feedback";
import { LIGHTNING_CHANNEL_TITLE } from "../../lib/swap/copy";
import { TEST_FIBER_NODE_GLOBAL } from "../../lib/wallets/fiber-browser/fiber-test-hook";

/*
 * The public testnet demo (../ckbolt-hub/docs/phase-3c-public-demo-plan.md): the "Report a problem" link (F9.1), test
 * hooks only in builds made for tests (S1), and the copy that must stay in step across files (F0.2, F1.1).
 */

const WEB = path.resolve(__dirname, "../..");
const read = (p: string) => readFileSync(path.join(WEB, p), "utf8");
/** The build to check: `.next`, or the folder CKBOLT_DIST_DIR names, as next.config.mjs reads it. */
const DIST_DIR = process.env.CKBOLT_DIST_DIR || ".next";
const SWAP_ID = "3f2b8c1e-4a5d-4e6f-8a9b-0c1d2e3f4a5b";

/* ------------------------------------------------------------------------------------------- feedback */

test.describe("Report a problem (F9.1)", () => {
  test("by default a new issue on the web repo, its title and body naming the swap, URL-encoded", () => {
    const url = new URL(feedbackUrl(SWAP_ID, FEEDBACK_DEFAULT_URL));
    expect(`${url.origin}${url.pathname}`).toBe("https://github.com/Tech-Expansion/CKBolt/issues/new");
    expect(url.searchParams.get("title")).toBe(`Problem with swap ${SWAP_ID}`);
    expect(url.searchParams.get("body")).toContain(`Swap id: ${SWAP_ID}`);
    expect(url.searchParams.get("body")).toContain("What happened:");
    // Anyone with the id can read the swap from the hub, so the reporter is told the report shows it publicly.
    expect(url.searchParams.get("body")!.split("\n").slice(0, 2)).toEqual([`Swap id: ${SWAP_ID}`, FEEDBACK_COPY.SWAP_ID_PUBLIC]);
    expect(FEEDBACK_COPY.SWAP_ID_PUBLIC).toBe("This report and its swap id are public; testnet swaps hold no real value.");
    // Spaces as %20 and new lines as %0A: no raw spaces, and no "+" GitHub would have to read as a space.
    expect(url.search).not.toMatch(/[ +\n]/);
    expect(url.search).toContain("Problem%20with%20swap");
    expect(url.search).toContain("%0A");
  });

  test("without a swap the title names the demo and the body asks the same questions", () => {
    const url = new URL(feedbackUrl(null, FEEDBACK_DEFAULT_URL));
    expect(url.searchParams.get("title")).toBe(FEEDBACK_COPY.TITLE);
    expect(url.searchParams.get("body")).not.toContain("Swap id");
    expect(url.searchParams.get("body")).not.toContain(FEEDBACK_COPY.SWAP_ID_PUBLIC);
    expect(url.searchParams.get("body")).toBe(FEEDBACK_COPY.BODY(null));
  });

  test("NEXT_PUBLIC_FEEDBACK_URL replaces the default when it is an http(s) URL; its own query parameters stay", () => {
    expect(feedbackBaseUrl(undefined)).toBe(FEEDBACK_DEFAULT_URL);
    expect(feedbackBaseUrl("  ")).toBe(FEEDBACK_DEFAULT_URL);
    for (const bad of ["not a url", "javascript:alert(1)", "ftp://example.com/x", "data:text/html,x"]) expect(feedbackBaseUrl(bad), bad).toBe(FEEDBACK_DEFAULT_URL);
    const form = "https://forms.example.com/report?form=ckbolt&lang=en";
    expect(feedbackBaseUrl(` ${form} `)).toBe(form);
    const url = new URL(feedbackUrl(SWAP_ID, form));
    expect(url.searchParams.get("form")).toBe("ckbolt");
    expect(url.searchParams.get("lang")).toBe("en");
    expect(url.searchParams.get("title")).toBe(`Problem with swap ${SWAP_ID}`);
  });

  test("characters that mean something in a URL stay inside their value", () => {
    const odd = "a&b=c#d+e?f";
    const url = new URL(feedbackUrl(odd, FEEDBACK_DEFAULT_URL));
    expect(url.searchParams.get("title")).toBe(`Problem with swap ${odd}`);
    expect(url.hash).toBe("");
  });
});

/* ----------------------------------------------------------------------------------------- test hooks */

const HOOK_NAMES = [TEST_FIBER_NODE_GLOBAL];
const SOURCE_DIRS = ["app", "components", "hooks", "lib"];
const HOOK_MODULES = ["lib/wallets/fiber-browser/fiber-test-hook.ts"];

/** Every file under `dir` (relative to the repo) whose name matches `pattern`. */
function filesUnder(dir: string, pattern: RegExp): string[] {
  const root = path.join(WEB, dir);
  if (!existsSync(root)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(root)) {
    const rel = path.join(dir, entry);
    if (statSync(path.join(WEB, rel)).isDirectory()) out.push(...filesUnder(rel, pattern));
    else if (pattern.test(entry)) out.push(rel.split(path.sep).join("/"));
  }
  return out;
}

test.describe("test hooks only in builds made for tests (S1)", () => {
  test("the hook name lives only in its module, which the app loads only behind the build-time switch", () => {
    const sources = SOURCE_DIRS.flatMap((dir) => filesUnder(dir, /\.(ts|tsx)$/));
    for (const file of sources) {
      const text = read(file);
      for (const name of HOOK_NAMES) {
        if (text.includes(name)) expect(HOOK_MODULES, `${file} names ${name}`).toContain(file);
      }
      for (const module of ["fiber-test-hook"]) {
        // Only a dynamic import inside the switch: a static one would keep the module in every build.
        expect(text, file).not.toMatch(new RegExp(`from "[^"]*${module}"`));
        if (text.includes(`import("./${module}")`)) expect(text, file).toContain('process.env.NEXT_PUBLIC_CKBOLT_TEST_HOOKS === "1"');
      }
    }
  });

  test("next.config.mjs always defines the switch, and only `npm run build:test` turns it on", () => {
    const config = read("next.config.mjs");
    expect(config).toMatch(/env:\s*\{\s*NEXT_PUBLIC_CKBOLT_TEST_HOOKS:/);
    expect(read("scripts/build-test.mjs")).toContain('NEXT_PUBLIC_CKBOLT_TEST_HOOKS: "1"');
    expect(JSON.parse(read("package.json")).scripts["build:test"]).toBe("node scripts/build-test.mjs");
  });

  test("next.config.mjs stops a Vercel production build that has the switch on; previews and other builds go on", () => {
    const config = pathToFileURL(path.join(WEB, "next.config.mjs")).href;
    /** Loads next.config.mjs in a fresh Node with exactly these two variables, as `next build` would. */
    const load = (vercelEnv: string | undefined, hooks: string | undefined) => {
      const env: NodeJS.ProcessEnv = { ...process.env };
      delete env.VERCEL_ENV;
      delete env.NEXT_PUBLIC_CKBOLT_TEST_HOOKS;
      if (vercelEnv !== undefined) env.VERCEL_ENV = vercelEnv;
      if (hooks !== undefined) env.NEXT_PUBLIC_CKBOLT_TEST_HOOKS = hooks;
      const script = `const { default: c } = await import(${JSON.stringify(config)}); console.log(c.env.NEXT_PUBLIC_CKBOLT_TEST_HOOKS || "off");`;
      return spawnSync(process.execPath, ["--input-type=module", "-e", script], { env, encoding: "utf8" });
    };
    const refused = load("production", "1");
    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toContain("NEXT_PUBLIC_CKBOLT_TEST_HOOKS=1 is set for a Vercel production build");
    for (const [vercelEnv, hooks, flag] of [
      ["production", undefined, "off"],
      ["production", "", "off"],
      ["production", "true", "off"],
      ["preview", "1", "1"],
      ["development", "1", "1"],
      [undefined, "1", "1"],
      [undefined, undefined, "off"],
    ] as const) {
      const run = load(vercelEnv, hooks);
      expect(run.status, `${vercelEnv} ${hooks}: ${run.stderr}`).toBe(0);
      expect(run.stdout.trim(), `${vercelEnv} ${hooks}`).toBe(flag);
    }
  });

  test("the build in .next carries the hooks exactly when it was made with the switch on", () => {
    const manifest = path.join(WEB, DIST_DIR, "required-server-files.json");
    test.skip(!existsSync(manifest), `no build in ${DIST_DIR}`);
    const flag = JSON.parse(readFileSync(manifest, "utf8")).config.env.NEXT_PUBLIC_CKBOLT_TEST_HOOKS;
    // Defined in every build, so a production build inlines "" and drops the hooks.
    expect(["", "1"]).toContain(flag);
    const chunks = [...filesUnder(`${DIST_DIR}/static`, /\.js$/), ...filesUnder(`${DIST_DIR}/server`, /\.js$/)];
    expect(chunks.length).toBeGreaterThan(0);
    for (const name of HOOK_NAMES) {
      const carrying = chunks.filter((file) => read(file).includes(name));
      if (flag === "1") expect(carrying.length, `${name} in a build made for tests`).toBeGreaterThan(0);
      else expect(carrying, `${name} in a production build`).toEqual([]);
    }
  });
});

/* ------------------------------------------------------------------------------------ copy in step */

const HUB_REPO = path.resolve(WEB, "../ckbolt-hub");
const TESTING_TESTNET = path.join(HUB_REPO, "docs/testing-testnet.md");

test.describe("copy that must stay in step (F0.2, F1.1)", () => {
  test("the roadmap doc and the roadmap cards agree: stage 2 Done, stage 3 Now", () => {
    const cards = read("components/landing/pricing-section.tsx");
    const statusOf = (stage: number) => cards.match(new RegExp(`phase: "Stage ${stage}",\\s*status: "(\\w+)"`))?.[1];
    expect(statusOf(2)).toBe("Done");
    expect(statusOf(3)).toBe("Now");
    const doc = read("docs/roadmap.md");
    for (const [stage, status] of [
      [2, "Done"],
      [3, "Now"],
    ] as const) {
      expect(doc.split("\n").find((l) => l.startsWith(`| ${stage} |`)), `stage ${stage}`).toMatch(new RegExp(`\\| ${status} \\|`));
    }
    expect(cards.match(/status: "Now"/g)).toHaveLength(1);
  });

  test("stage 4 stays Planned in both, its Get paid and Pay deliverables tagged live on testnet in an early version, nothing else", () => {
    const cards = read("components/landing/pricing-section.tsx");
    expect(cards.match(/phase: "Stage 4",\s*status: "(\w+)"/)?.[1]).toBe("Planned");
    const tags = ["Live on testnet, early version: Get paid", "Live on testnet, early version: Pay"];
    expect(cards.match(/live: "[^"]*"/g)).toEqual(tags.map((t) => `live: "${t}"`));
    const doc = read("docs/roadmap.md");
    expect(doc.split("\n").find((l) => l.startsWith("| 4 |"))).toMatch(/\| Planned \|/);
    const stage4 = doc.slice(doc.indexOf("## Stage 4:"), doc.indexOf("## Stage 5:")).replace(/\s+/g, " ");
    for (const tag of tags) expect(stage4).toContain(tag);
    expect(stage4.match(/Live on testnet/g)).toHaveLength(tags.length);
  });

  test("the guide's Alby Hub command and Megalith's address are the ones the hub's testnet doc tested", () => {
    test.skip(!existsSync(TESTING_TESTNET), "the sibling hub repo is not present");
    const doc = readFileSync(TESTING_TESTNET, "utf8");
    expect(doc).toContain(ALBY_HUB_DOCKER_RUN);
    expect(doc).toContain(MEGALITH_PEER_URI);
  });

  test("the guide names the hub card's channel step as the card does", () => {
    expect(GUIDE_STEPS.map((s) => s.title)).toContain(LIGHTNING_CHANNEL_TITLE);
  });
});
