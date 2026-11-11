"""Tests of deploy/testnet/add_token.py with --apply on a temporary kit: a fake `docker` stands in for Compose, the hub
image's generator and fnn's RPC, and a local HTTP server for the hub's API.

`testnet sync` runs `python3 add_token.py --regenerate --apply` after every upload (docs/add-token.md), so this covers what
that run may and may not do: back up only when it writes, never recreate the hub, check only the services that run,
print the rollback commands only when there is a backup, and never print HUB_PROXY_SECRET.

Run from the repo root (Python 3, stdlib only):  python3 -m unittest discover -s deploy/test/python -v
"""
from __future__ import annotations

import contextlib
import http.server
import io
import json
import os
import re
import shutil
import stat
import sys
import tempfile
import textwrap
import threading
import unittest

sys.dont_write_bytecode = True
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from test_add_token import KIT_COMPOSE, KIT_FNN, SCRIPT_RUSD, SCRIPT_TKN, SECRET, asset, at  # noqa: E402

FAKE_DOCKER_SERVER = textwrap.dedent(r'''
    """A stand-in for `docker` on the server: the hub image's whitelist generator (`compose run`), `compose ps`,
    `restart`, `up`, `port`, and fnn's JSON-RPC through `compose exec`. FAKE_* variables give the state; every call is
    logged with its stdin."""
    import json, os, sys

    args = sys.argv[1:]
    compose = args[1:] if args[:1] == ["compose"] else []
    stdin = sys.stdin.read() if compose[:2] == ["exec", "-T"] else ""
    with open(os.environ["FAKE_DOCKER_LOG"], "a", encoding="utf-8") as log:
        log.write(json.dumps({"argv": args, "stdin": stdin}) + "\n")
    running = [name for name in os.environ.get("FAKE_RUNNING", "").split(",") if name]

    def fail(message):
        sys.stderr.write(message + "\n")
        sys.exit(1)

    if not compose:
        fail("fake docker: unexpected call " + " ".join(args))
    if compose[0] == "run":
        hub = compose.index("hub")
        head, generator = compose[:hub], compose[hub + 3:]
        mounts = {}
        for flag, value in zip(head, head[1:]):
            if flag == "-v":
                host, container = value.split(":")[:2]
                mounts[container] = host
        options = dict(zip(generator, generator[1:]))
        changed = [name for name in os.environ.get("FAKE_CHANGE", "").split(",") if name]
        print("hub configuration ok: assets CKB, RUSD; peer channels: none")
        for flag in ("--hub-yml", "--demo-yml"):
            folder, name = options[flag].rsplit("/", 1)
            with open(os.path.join(mounts[folder], name), encoding="utf-8", newline="") as source:
                text = source.read()
            if name in changed:
                text += "# regenerated from FIBER_ASSETS\n"
            with open(os.path.join(mounts[options["--out-dir"]], name), "w", encoding="utf-8", newline="") as out:
                out.write(text)
            print(options[flag] + (": changed" if name in changed else ": unchanged"))
    elif compose[:4] == ["ps", "--services", "--status", "running"]:
        print("\n".join(running))
    elif compose[:3] == ["ps", "--format", "json"]:
        print(json.dumps({"Service": compose[3], "State": "running", "Health": "healthy"}))
    elif compose[0] in ("restart", "up"):
        pass
    elif compose[:3] == ["port", "hub", "8787"]:
        print("127.0.0.1:" + os.environ["FAKE_HUB_PORT"])
    elif compose[:2] == ["exec", "-T"]:
        service = compose[2]
        if service not in running:
            fail('service "' + service + '" is not running')
        request = json.loads(stdin)
        if request["method"] != "node_info":
            fail("fake fnn: unexpected method " + request["method"])
        infos = json.loads(os.environ.get("FAKE_UDT_INFOS", "{}")).get(service, [])
        print(json.dumps({"jsonrpc": "2.0", "id": request["id"], "result": {"udt_cfg_infos": infos}}))
    else:
        fail("fake docker: unexpected call " + " ".join(args))
''')

ALL_RUNNING = ("bitcoind", "lnd-hub", "fnn-hub", "fnn-demo", "hub")
CHANGED_LINE = "# regenerated from FIBER_ASSETS\n"
DEMO_AUTO_ACCEPT = 1000000000
BACKUP_NAME = re.compile(r"^add-token-\d{8}T\d{6}Z$")


def udt_info(entry: dict, auto_accept: int | None) -> dict:
    """A node_info.udt_cfg_infos entry as fnn reports a generated whitelist entry (args anchored as ^args$)."""
    script = entry["typeScript"]
    return {"name": entry["symbol"], "script": {"code_hash": script["codeHash"], "hash_type": script["hashType"], "args": f"^{script['args']}$"},
            "auto_accept_amount": None if auto_accept is None else hex(auto_accept), "cell_deps": []}


def node_infos(assets: list) -> dict:
    """What fnn-hub (peerChannels.minAmount) and fnn-demo report once they run the whitelists generated from `assets`."""
    def hub_amount(entry: dict) -> int | None:
        peer = entry.get("peerChannels")
        return int(peer["minAmount"]) if peer else None
    return {"fnn-hub": [udt_info(a, hub_amount(a)) for a in assets], "fnn-demo": [udt_info(a, DEMO_AUTO_ACCEPT) for a in assets]}


class FakeHubHandler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):  # noqa: N802 (http.server's name)
        hub = self.server.fake_hub
        hub.requests.append({"path": self.path, "headers": {key.lower(): value for key, value in self.headers.items()}})
        status, body = hub.answer(self.path)
        data = json.dumps(body).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, format, *args):  # noqa: A002 (http.server's signature): keep stderr to the script's output
        pass


class FakeHub:
    """The hub's API on 127.0.0.1, serving the assets of the kit's hub.env as a hub (re)created from it would."""

    def __init__(self, hub_env_path: str):
        self.hub_env_path = hub_env_path
        self.requests: list = []
        self.overrides: dict = {}
        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), FakeHubHandler)
        self.server.fake_hub = self
        self.thread = threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True)
        self.thread.start()

    @property
    def port(self) -> int:
        return self.server.server_address[1]

    def assets(self) -> list:
        with open(self.hub_env_path, encoding="utf-8", newline="") as handle:
            return at.parse_assets(at.read_env_value(handle.read(), "FIBER_ASSETS"))

    def answer(self, path: str) -> tuple:
        if path in self.overrides:
            return self.overrides[path]
        if path == "/v1/health":
            return 200, {"status": "ok"}
        if path == "/v1/assets":
            return 200, {"data": [{"id": "CKB"}] + [{"id": a["id"]} for a in self.assets()]}
        if path == "/v1/fiber/node":
            return 200, {"assets": [{"id": "CKB", "peerChannels": None}] + [{"id": a["id"], "peerChannels": a.get("peerChannels")} for a in self.assets()]}
        return 404, {"error": {"code": "not_found", "message": path}}

    def paths(self) -> list:
        return [request["path"] for request in self.requests]

    def close(self) -> None:
        self.server.shutdown()
        self.server.server_close()


@unittest.skipIf(os.name == "nt", "the fake docker is a POSIX executable script")
class ApplyTest(unittest.TestCase):
    ENV_KEYS = ("PATH", "FAKE_DOCKER_LOG", "FAKE_RUNNING", "FAKE_CHANGE", "FAKE_UDT_INFOS", "FAKE_HUB_PORT", "no_proxy", "NO_PROXY")

    def setUp(self):
        self.root = tempfile.mkdtemp(prefix="add-token-apply-test-")
        self.kit = os.path.join(self.root, "kit")
        self.bin = os.path.join(self.root, "bin")
        self.log = os.path.join(self.root, "docker.log")
        os.makedirs(os.path.join(self.kit, "fnn"))
        os.makedirs(self.bin)
        docker = os.path.join(self.bin, "docker")
        with open(docker, "w", encoding="utf-8") as handle:
            handle.write(f"#!{sys.executable}" + FAKE_DOCKER_SERVER)
        os.chmod(docker, os.stat(docker).st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
        self.rusd = asset("RUSD", SCRIPT_RUSD)
        self.tkn = asset("TKN", SCRIPT_TKN, peerChannels={"minAmount": "10000000"})
        self.originals = {
            "docker-compose.yml": KIT_COMPOSE,
            "hub.env": ("# hub.env of the test kit\n"
                        f"HUB_PROXY_SECRET={SECRET}\n"
                        "CKB_NETWORK=testnet\n"
                        f"FIBER_ASSETS={at.env_json_literal(at.compact_json([self.rusd]))}\n"
                        "QUOTE_SIGNING_KEY=" + "ab" * 32 + "\n"),
            os.path.join("fnn", "hub.yml"): KIT_FNN,
            os.path.join("fnn", "demo.yml"): KIT_FNN.replace("ckb:\n", "# demo\nckb:\n"),
        }
        self.reset_kit()
        self.token = os.path.join(self.root, "tkn.json")
        with open(self.token, "w", encoding="utf-8") as handle:
            json.dump(self.tkn, handle)
        self.hub = FakeHub(os.path.join(self.kit, "hub.env"))

        self.saved_env = {key: os.environ.get(key) for key in self.ENV_KEYS}
        os.environ["PATH"] = self.bin + os.pathsep + os.environ.get("PATH", "")
        os.environ["FAKE_DOCKER_LOG"] = self.log
        os.environ["FAKE_HUB_PORT"] = str(self.hub.port)
        os.environ["no_proxy"] = os.environ["NO_PROXY"] = "*"  # urllib must call the local fake hub directly
        self.set_running(*ALL_RUNNING)
        self.set_changed()
        self.set_node_infos(node_infos([self.rusd]))
        # Fail fast instead of waiting minutes if a fake service never looks healthy.
        self.saved_waits = (at.HEALTH_WAIT_SECONDS, at.POLL_SECONDS)
        at.HEALTH_WAIT_SECONDS, at.POLL_SECONDS = 2, 0.05

    def tearDown(self):
        at.HEALTH_WAIT_SECONDS, at.POLL_SECONDS = self.saved_waits
        for key, value in self.saved_env.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
        self.hub.close()
        shutil.rmtree(self.root, ignore_errors=True)

    # ------------------------------------------------------------------------------------------------ helpers
    def reset_kit(self) -> None:
        shutil.rmtree(os.path.join(self.kit, "backups"), ignore_errors=True)
        for relative, text in self.originals.items():
            with open(os.path.join(self.kit, relative), "w", encoding="utf-8", newline="") as handle:
                handle.write(text)
        if os.path.exists(self.log):
            os.remove(self.log)
        if hasattr(self, "hub"):
            self.hub.requests.clear()

    def set_running(self, *services: str) -> None:
        os.environ["FAKE_RUNNING"] = ",".join(services)

    def set_changed(self, *names: str) -> None:
        os.environ["FAKE_CHANGE"] = ",".join(names)

    def set_node_infos(self, infos: dict) -> None:
        os.environ["FAKE_UDT_INFOS"] = json.dumps(infos)

    def read(self, relative: str) -> str:
        with open(os.path.join(self.kit, relative), encoding="utf-8", newline="") as handle:
            return handle.read()

    def snapshot(self) -> dict:
        files = {}
        for folder, _, names in os.walk(self.kit):
            for name in names:
                path = os.path.join(folder, name)
                with open(path, "rb") as handle:
                    files[os.path.relpath(path, self.kit)] = (handle.read(), os.stat(path).st_mtime_ns)
        return files

    def run_main(self, argv: list) -> tuple:
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = at.main(argv)
        return code, out.getvalue(), err.getvalue()

    def regenerate(self) -> tuple:
        return self.run_main(["--regenerate", "--apply", "--kit-dir", self.kit])

    def compose_calls(self) -> list:
        """The arguments after `docker compose` of every call, in order."""
        if not os.path.exists(self.log):
            return []
        with open(self.log, encoding="utf-8") as handle:
            calls = [json.loads(line) for line in handle if line.strip()]
        self.assertTrue(all(call["argv"][0] == "compose" for call in calls), calls)
        return [call["argv"][1:] for call in calls]

    def docker_log_text(self) -> str:
        if not os.path.exists(self.log):
            return ""
        with open(self.log, encoding="utf-8") as handle:
            return handle.read()

    def restarted(self) -> list:
        return [call[1:] for call in self.compose_calls() if call[0] == "restart"]

    def recreated(self) -> list:
        return [call for call in self.compose_calls() if call[0] == "up" or "--force-recreate" in call]

    def exec_services(self) -> list:
        return [call[2] for call in self.compose_calls() if call[:2] == ["exec", "-T"]]

    def backups(self) -> list:
        folder = os.path.join(self.kit, "backups")
        return sorted(os.listdir(folder)) if os.path.isdir(folder) else []

    def assert_secret_not_printed(self, out: str, err: str) -> None:
        self.assertNotIn(SECRET, out)
        self.assertNotIn(SECRET, err)

    # ------------------------------------------------------------------------------------------- backups
    def test_a_regenerate_that_changes_nothing_makes_no_backup_and_touches_no_file(self):
        before = self.snapshot()
        code, out, err = self.regenerate()

        self.assertEqual(code, 0, err)
        self.assertEqual(self.snapshot(), before, "no file written, none added")
        self.assertEqual(self.backups(), [])
        self.assertFalse(os.path.exists(os.path.join(self.kit, "backups")), "not even an empty backups folder")
        self.assertNotIn("backed up into", out)
        self.assertEqual(self.restarted(), [])
        self.assertEqual(self.recreated(), [])
        self.assertEqual(sorted(set(self.exec_services())), ["fnn-demo", "fnn-hub"], "the running nodes are still checked")
        self.assertIn("/v1/assets", self.hub.paths())
        self.assert_secret_not_printed(out, err)

    def test_a_backup_of_the_files_as_they_were_whenever_a_whitelist_is_written(self):
        for changed in (["hub.yml"], ["demo.yml"], ["hub.yml", "demo.yml"]):
            with self.subTest(changed=changed):
                self.reset_kit()
                self.set_changed(*changed)
                code, out, err = self.regenerate()

                self.assertEqual(code, 0, err)
                backups = self.backups()
                self.assertEqual(len(backups), 1, backups)
                self.assertRegex(backups[0], BACKUP_NAME)
                folder = os.path.join(self.kit, "backups", backups[0])
                self.assertIn(f"backed up into {folder}", out)
                for relative in ("hub.env", os.path.join("fnn", "hub.yml"), os.path.join("fnn", "demo.yml")):
                    with open(os.path.join(folder, relative), encoding="utf-8", newline="") as handle:
                        self.assertEqual(handle.read(), self.originals[relative], f"{relative} is backed up as it was before the write")
                self.assertEqual(stat.S_IMODE(os.stat(os.path.join(self.kit, "backups")).st_mode), 0o700, "backups hold hub.env: owner-only")
                for name, service in (("hub.yml", "fnn-hub"), ("demo.yml", "fnn-demo")):
                    original = self.originals[os.path.join("fnn", name)]
                    expected = original + CHANGED_LINE if name in changed else original
                    self.assertEqual(self.read(os.path.join("fnn", name)), expected, name)
                    self.assertEqual([service] in self.restarted(), name in changed, f"{service} restarted only when {name} changed")
                self.assertEqual(self.read("hub.env"), self.originals["hub.env"])
                self.assert_secret_not_printed(out, err)

    def test_a_backup_when_only_hub_env_is_written(self):
        self.set_node_infos(node_infos([self.rusd, self.tkn]))
        code, out, err = self.run_main([self.token, "--apply", "--kit-dir", self.kit])

        self.assertEqual(code, 0, err)
        backups = self.backups()
        self.assertEqual(len(backups), 1, backups)
        with open(os.path.join(self.kit, "backups", backups[0], "hub.env"), encoding="utf-8", newline="") as handle:
            self.assertEqual(handle.read(), self.originals["hub.env"])
        self.assertEqual([a["id"] for a in at.parse_assets(at.read_env_value(self.read("hub.env"), "FIBER_ASSETS"))], ["RUSD", "TKN"])
        self.assertEqual(self.read(os.path.join("fnn", "hub.yml")), self.originals[os.path.join("fnn", "hub.yml")], "whitelists unchanged")
        self.assertEqual(self.restarted(), [])
        self.assertEqual(self.recreated(), [["up", "-d", "--no-deps", "--force-recreate", "hub"]], "a token run recreates the hub to read hub.env")
        self.assert_secret_not_printed(out, err)

    # ---------------------------------------------------------------------------------------- --regenerate
    def test_regenerate_never_recreates_the_hub_nor_writes_hub_env(self):
        for changed in ([], ["hub.yml"], ["hub.yml", "demo.yml"]):
            with self.subTest(changed=changed):
                self.reset_kit()
                self.set_changed(*changed)
                hub_env = os.path.join(self.kit, "hub.env")
                before = (self.read("hub.env"), os.stat(hub_env).st_mtime_ns)
                code, out, err = self.regenerate()

                self.assertEqual(code, 0, err)
                self.assertEqual((self.read("hub.env"), os.stat(hub_env).st_mtime_ns), before, "hub.env is not rewritten")
                self.assertEqual(self.recreated(), [])
                touched = {call[0] for call in self.compose_calls()} - {"run", "ps", "exec", "port"}
                self.assertLessEqual(touched, {"restart"}, f"nothing but fnn restarts changes a service: {self.compose_calls()}")
                self.assertTrue(all(service[0] in ("fnn-hub", "fnn-demo") for service in self.restarted()), self.restarted())
                self.assertNotIn("recreating", out)

    # -------------------------------------------------------------------------------- checks of what runs
    def test_a_stopped_fnn_hub_is_neither_restarted_nor_checked_and_the_hub_checks_are_skipped(self):
        self.set_running("bitcoind", "lnd-hub", "fnn-demo", "hub")
        self.set_changed("hub.yml")
        code, out, err = self.regenerate()

        self.assertEqual(code, 0, err)
        self.assertNotIn("fnn-hub", self.exec_services(), "a stopped node cannot answer node_info")
        self.assertNotIn(["fnn-hub"], self.restarted(), "it reads the new whitelist when it starts")
        self.assertIn("fnn-demo", self.exec_services(), "fnn-demo runs: it is checked")
        self.assertEqual(self.hub.requests, [], "the hub's checks need fnn-hub")
        self.assertFalse(any(call[0] == "port" for call in self.compose_calls()))
        self.assertIn("fnn-hub: not running, not checked", out)
        self.assert_secret_not_printed(out, err)

    def test_the_hub_checks_are_skipped_when_the_hub_is_stopped(self):
        self.set_running("bitcoind", "lnd-hub", "fnn-hub", "fnn-demo")
        code, out, err = self.regenerate()

        self.assertEqual(code, 0, err)
        self.assertEqual(self.hub.requests, [])
        self.assertFalse(any(call[0] == "port" for call in self.compose_calls()), "the hub publishes no port while stopped")
        self.assertEqual(sorted(set(self.exec_services())), ["fnn-demo", "fnn-hub"], "the running nodes are checked")
        self.assertIn("not checked", out)

    def test_a_stopped_fnn_demo_is_not_checked(self):
        self.set_running("bitcoind", "lnd-hub", "fnn-hub", "hub")
        code, out, err = self.regenerate()

        self.assertEqual(code, 0, err)
        self.assertEqual(sorted(set(self.exec_services())), ["fnn-hub"])
        self.assertIn("/v1/fiber/node", self.hub.paths())

    def test_the_hub_is_checked_when_it_and_fnn_hub_run(self):
        code, out, err = self.regenerate()

        self.assertEqual(code, 0, err)
        self.assertIn("/v1/health", self.hub.paths())
        self.assertIn("/v1/assets", self.hub.paths())
        self.assertIn("/v1/fiber/node", self.hub.paths())
        self.assertIn("hub: GET /v1/assets lists CKB, RUSD", out)

    # ------------------------------------------------------------------------------------------ rollback
    def test_the_rollback_commands_are_printed_when_a_check_fails_after_a_backup(self):
        self.set_changed("hub.yml")
        self.set_node_infos({"fnn-hub": [], "fnn-demo": node_infos([self.rusd])["fnn-demo"]})
        code, out, err = self.regenerate()

        self.assertEqual(code, 1)
        self.assertIn("fnn-hub does not whitelist RUSD", err)
        backups = self.backups()
        self.assertEqual(len(backups), 1, backups)
        folder = os.path.join(self.kit, "backups", backups[0])
        self.assertIn("To go back", out)
        self.assertIn(f"cp -p {folder}/hub.env {os.path.join(self.kit, 'hub.env')}", out)
        self.assertIn(f"cp -p {folder}/fnn/*.yml", out)
        self.assert_secret_not_printed(out, err)

    def test_no_rollback_commands_without_a_backup(self):
        self.set_node_infos({"fnn-hub": [], "fnn-demo": node_infos([self.rusd])["fnn-demo"]})
        before = self.snapshot()
        code, out, err = self.regenerate()

        self.assertEqual(code, 1)
        self.assertIn("fnn-hub does not whitelist RUSD", err)
        self.assertEqual(self.backups(), [])
        self.assertEqual(self.snapshot(), before)
        self.assertNotIn("To go back", out + err)
        self.assertNotIn("cp -p", out + err)
        self.assertNotIn("backups/", out + err)

    # ------------------------------------------------------------------------------------- the secret
    def test_the_proxy_secret_goes_to_the_hub_and_is_never_printed(self):
        failing_assets = (401, {"error": {"code": "unauthorized", "message": "missing or wrong X-CKBolt-Proxy-Secret"}})
        scenarios = {
            "regenerate, all checks pass": (["--regenerate", "--apply"], [], None, node_infos([self.rusd]), 0),
            "a token, hub.env written and the hub recreated": ([self.token, "--apply"], [], None, node_infos([self.rusd, self.tkn]), 0),
            "a hub check fails after the files were written": (["--regenerate", "--apply"], ["hub.yml"], failing_assets, node_infos([self.rusd]), 1),
        }
        for name, (argv, changed, assets_answer, infos, expected_code) in scenarios.items():
            with self.subTest(name):
                self.reset_kit()
                self.set_changed(*changed)
                self.set_node_infos(infos)
                self.hub.overrides = {"/v1/assets": assets_answer} if assets_answer else {}
                code, out, err = self.run_main([*argv, "--kit-dir", self.kit])

                self.assertEqual(code, expected_code, err)
                self.assertTrue(self.hub.requests, "the hub was called")
                self.assertTrue(all(r["headers"].get("x-ckbolt-proxy-secret") == SECRET for r in self.hub.requests),
                                "every call carries HUB_PROXY_SECRET")
                self.assert_secret_not_printed(out, err)
                self.assertNotIn(SECRET, self.docker_log_text(), "nor put on a docker command line")
                if expected_code:
                    self.assertIn("GET /v1/assets answered 401", err)
                    self.assertIn("To go back", out)

    def test_no_proxy_secret_header_when_hub_env_sets_none(self):
        self.originals["hub.env"] = self.originals["hub.env"].replace(f"HUB_PROXY_SECRET={SECRET}\n", "")
        self.reset_kit()
        code, out, err = self.regenerate()

        self.assertEqual(code, 0, err)
        self.assertTrue(self.hub.requests)
        self.assertTrue(all("x-ckbolt-proxy-secret" not in r["headers"] for r in self.hub.requests))


    # ------------------------------------------------------------------------- templates (`testnet sync`)
    def write_templates(self, hub: str | None, demo: str | None) -> None:
        folder = os.path.join(self.kit, ".sync-templates", "fnn")
        os.makedirs(folder, exist_ok=True)
        for name, text in (("hub.yml", hub), ("demo.yml", demo)):
            if text is not None:
                with open(os.path.join(folder, name), "w", encoding="utf-8", newline="") as handle:
                    handle.write(text)

    def regenerate_from_templates(self, *extra: str) -> tuple:
        return self.run_main(["--regenerate", "--apply", "--template-dir", ".sync-templates", "--kit-dir", self.kit, *extra])

    def test_templates_equal_to_the_running_files_write_restart_and_back_up_nothing(self):
        self.write_templates(self.originals[os.path.join("fnn", "hub.yml")], self.originals[os.path.join("fnn", "demo.yml")])
        code, out, err = self.regenerate_from_templates()

        self.assertEqual(code, 0, err)
        self.assertEqual(self.backups(), [])
        self.assertEqual(self.restarted(), [])
        self.assertEqual(self.read(os.path.join("fnn", "hub.yml")), self.originals[os.path.join("fnn", "hub.yml")])

    def test_generates_from_the_templates_and_compares_with_what_fnn_runs(self):
        repo_hub = "# repo copy\n" + self.originals[os.path.join("fnn", "hub.yml")]
        self.write_templates(repo_hub, self.originals[os.path.join("fnn", "demo.yml")])
        code, out, err = self.regenerate_from_templates()

        self.assertEqual(code, 0, err)
        self.assertEqual(self.read(os.path.join("fnn", "hub.yml")), repo_hub, "the template's other lines reach the server")
        self.assertEqual(self.restarted(), [["fnn-hub"]], "only the node whose file changed")
        backups = self.backups()
        self.assertEqual(len(backups), 1, backups)
        with open(os.path.join(self.kit, "backups", backups[0], "fnn", "hub.yml"), encoding="utf-8", newline="") as handle:
            self.assertEqual(handle.read(), self.originals[os.path.join("fnn", "hub.yml")], "the backup is what fnn ran, not the template")

    def test_a_first_sync_writes_a_file_the_server_does_not_have_yet(self):
        os.remove(os.path.join(self.kit, "fnn", "demo.yml"))
        self.write_templates(self.originals[os.path.join("fnn", "hub.yml")], self.originals[os.path.join("fnn", "demo.yml")])
        code, out, err = self.regenerate_from_templates()

        self.assertEqual(code, 0, err)
        self.assertEqual(self.read(os.path.join("fnn", "demo.yml")), self.originals[os.path.join("fnn", "demo.yml")])
        backups = self.backups()
        self.assertEqual(len(backups), 1, backups)
        self.assertFalse(os.path.exists(os.path.join(self.kit, "backups", backups[0], "fnn", "demo.yml")), "nothing to back up for it")

    def test_refuses_to_drop_a_token_the_running_whitelist_names_unless_allowed(self):
        rusd = self.rusd["typeScript"]
        running = self.originals[os.path.join("fnn", "hub.yml")].replace(
            "  udt_whitelist: []\n",
            "  udt_whitelist:\n    - name: RUSD\n      script:\n"
            f"        code_hash: {rusd['codeHash']}\n        hash_type: {rusd['hashType']}\n        args: {rusd['args'].upper().replace('0X', '0x')}\n"
            "      cell_deps: []\n",
        )
        self.originals[os.path.join("fnn", "hub.yml")] = running
        self.reset_kit()
        self.write_templates(KIT_FNN, self.originals[os.path.join("fnn", "demo.yml")])
        before = self.snapshot()

        code, out, err = self.regenerate_from_templates()
        self.assertEqual(code, 1)
        self.assertIn("fnn/hub.yml: RUSD", err)
        self.assertIn("--allow-drop", err)
        self.assertEqual({k: v for k, v in self.snapshot().items() if not k.startswith(".sync-templates")},
                         {k: v for k, v in before.items() if not k.startswith(".sync-templates")}, "nothing written")
        self.assertEqual(self.restarted(), [])

        code, out, err = self.regenerate_from_templates("--allow-drop")
        self.assertEqual(code, 0, err)
        self.assertEqual(self.read(os.path.join("fnn", "hub.yml")), KIT_FNN)
        self.assertEqual(self.restarted(), [["fnn-hub"]])

    def test_an_unanchored_entry_and_its_generated_anchored_form_are_the_same_token(self):
        text = "ckb:\n  udt_whitelist:\n    - name: RUSD\n      script:\n        code_hash: 0xAB\n        hash_type: type\n        args: 0x01\n"
        anchored = text.replace("args: 0x01", 'args: "^0x01$"').replace("0xAB", "0xab")
        self.assertEqual(at.whitelisted_scripts(text), {("0xab", "0x01"): "RUSD"})
        self.assertEqual(at.dropped_tokens({"hub.yml": (text, anchored)}), [])
        self.assertEqual(at.dropped_tokens({"hub.yml": (None, anchored)}), [], "a file the server lacks drops nothing")

    def test_the_rollback_commands_are_printed_for_any_failure_after_a_write(self):
        self.set_changed("hub.yml")
        original = at.restart_fnn

        def timing_out(kit, changed):
            raise at.subprocess.TimeoutExpired(["docker", "compose", "restart"], 300)

        at.restart_fnn = timing_out
        try:
            code, out, err = self.regenerate()
        finally:
            at.restart_fnn = original
        self.assertEqual(code, 1)
        self.assertIn("To go back", out)
        self.assertEqual(len(self.backups()), 1)


if __name__ == "__main__":
    unittest.main()
