// The build the Playwright suite runs against (`npm run build:test`): the production build, with the test hooks
// (window.__ckboltTestFiberNode, a fake fiber-js) switched on by NEXT_PUBLIC_CKBOLT_TEST_HOOKS=1 (next.config.mjs).
// Never deploy it; `npm run build` makes the build without them. A script, so the variable is set the same way on Windows.
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const TEST_HOOKS_ENV = { NEXT_PUBLIC_CKBOLT_TEST_HOOKS: "1" };

const next = createRequire(import.meta.url).resolve("next/dist/bin/next");
const { status } = spawnSync(process.execPath, [next, "build"], { stdio: "inherit", env: { ...process.env, ...TEST_HOOKS_ENV } });
process.exit(status ?? 1);
