#!/usr/bin/env python3
"""Adds a token (a UDT) to the CKBolt hub on the testnet server, with FIBER_ASSETS as the one place it is configured.

Runbook: docs/add-token.md. Runs on the server in the kit folder (/opt/ckbolt/testnet), with Python 3 and Docker only:

    python3 add_token.py cwbtc.json                     # dry run: what would change, nothing is touched
    python3 add_token.py cwbtc.json --apply             # merge, regenerate the fnn whitelists, restart, check
    python3 add_token.py cwbtc.json --apply --open-channel <pubkey>@<multiaddr>=<base units> ...
    python3 add_token.py --regenerate --apply           # only regenerate the whitelists from hub.env
    python3 add_token.py --regenerate --apply --template-dir .sync-templates   # what `testnet sync` runs after its upload

The token file is one FIBER_ASSETS entry (docs/architecture.md, "Assets"). The hub image validates the merged list with
the hub's own rules and generates fnn's udt_whitelist (dist/interfaces/cli/fnn-whitelist), so nothing here duplicates
them. It never prints a secret: of hub.env it shows only FIBER_ASSETS.
"""
from __future__ import annotations

import argparse
import datetime
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

# --------------------------------------------------------------------------------------------------- kit facts
HUB_ENV = "hub.env"
FNN_DIR = "fnn"
HUB_YML = "hub.yml"
DEMO_YML = "demo.yml"
BACKUP_DIR = "backups"
SERVICE_HUB = "hub"
SERVICE_FNN_HUB = "fnn-hub"
SERVICE_FNN_DEMO = "fnn-demo"
HUB_CONTAINER_PORT = 8787
# The generator inside the hub image, and where the one-off container sees the kit's files.
GENERATOR = "dist/interfaces/cli/fnn-whitelist/main.js"
CONTAINER_FNN_DIR = "/kit-fnn"
CONTAINER_OUT_DIR = "/kit-out"

FIBER_ASSETS_KEY = "FIBER_ASSETS"
PROXY_SECRET_KEY = "HUB_PROXY_SECRET"
PROXY_SECRET_HEADER = "X-CKBolt-Proxy-Secret"
ASSETS_PATH = "/v1/assets"
FIBER_NODE_PATH = "/v1/fiber/node"
HEALTH_PATH = "/v1/health"

ASSET_ID = re.compile(r"^[A-Z][A-Z0-9]{1,15}$")
NODE_ID = re.compile(r"^0[23][0-9a-f]{64}$")
WHOLE_NUMBER = re.compile(r"^[1-9][0-9]*$")
ENV_LINE = re.compile(r"^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*?)(\r?\n)?$")
CHANNEL_READY = "ChannelReady"
# Channels on their way out: a new channel to the same peer may be opened next to them.
FNN_ENDING_STATES = ("ShuttingDown", "Closed")
JSON_RPC_VERSION = "2.0"
FNN_RPC_CURL = 'curl -sS -m 30 -H "Content-Type: application/json" --data-binary @- "http://$RPC_LISTENING_ADDR"'
HEALTHY = "healthy"

COMMAND_TIMEOUT_SECONDS = 300
HTTP_TIMEOUT_SECONDS = 30
POLL_SECONDS = 10
HEALTH_WAIT_SECONDS = 300
DEFAULT_CHANNEL_WAIT_MINUTES = 60
SECRET_DIR_MODE = 0o700
OUT_DIR_MODE = 0o777


class Refused(Exception):
    """Input or state the script will not act on; the message says why and what to do."""


# ------------------------------------------------------------------------------------------- hub.env (pure)
SINGLE_QUOTED = re.compile(r"^'([^']*)'\s*(#.*)?$")
DOUBLE_QUOTED = re.compile(r'^"((?:[^"\\]|\\.)*)"\s*(#.*)?$')


def _unquote(raw: str) -> str:
    """An env value as Compose reads it: quotes removed (a comment may follow them), or a plain value without its comment."""
    value = raw.strip()
    single = SINGLE_QUOTED.match(value)
    if single:
        return single.group(1)
    double = DOUBLE_QUOTED.match(value)
    if double:
        return double.group(1).replace('\\"', '"').replace("\\\\", "\\")
    return re.sub(r"\s+#.*$", "", value)


def _lines(text: str) -> list:
    """Lines with their ends, split at \\n only: str.splitlines would also split at characters JSON may hold (U+2028)."""
    return re.findall(r"[^\n]*\n|[^\n]+$", text)


def read_env_value(text: str, key: str) -> str | None:
    """The value of `key` in an env file (quotes removed), None when unset; refuses a key set twice."""
    found = [m for m in (ENV_LINE.match(line) for line in _lines(text)) if m and m.group(1) == key]
    if len(found) > 1:
        raise Refused(f"{HUB_ENV} sets {key} {len(found)} times: keep one line")
    return _unquote(found[0].group(2)) if found else None


def env_json_literal(json_text: str) -> str:
    """JSON as a single-quoted env value (Compose keeps it literal); a ' inside a JSON string becomes \\u0027."""
    return "'" + json_text.replace("'", "\\u0027") + "'"


def set_env_value(text: str, key: str, literal: str) -> str:
    """The env file with `key` set to `literal` (already quoted), every other line kept; appended when missing."""
    lines = _lines(text)
    for index, line in enumerate(lines):
        match = ENV_LINE.match(line)
        if match and match.group(1) == key:
            lines[index] = f"{key}={literal}{match.group(3) or ''}"
            return "".join(lines)
    newline = "\r\n" if "\r\n" in text else "\n"
    prefix = "" if text == "" or text.endswith("\n") else newline
    return f"{text}{prefix}{key}={literal}{newline}"


# ------------------------------------------------------------------------------------------- assets (pure)
def load_token(text: str) -> dict:
    """One FIBER_ASSETS entry from the token file; the hub image checks it fully."""
    try:
        entry = json.loads(text)
    except json.JSONDecodeError as error:
        raise Refused(f"the token file is not JSON: {error}") from None
    if not isinstance(entry, dict):
        raise Refused("the token file must hold one FIBER_ASSETS entry: a JSON object, not a list")
    if not isinstance(entry.get("id"), str) or not ASSET_ID.match(entry["id"]):
        raise Refused('the token needs an "id" of 2 to 16 upper-case letters or digits, starting with a letter')
    return entry


def parse_assets(value: str | None) -> list:
    """FIBER_ASSETS from hub.env as a list; refuses a hub that still runs on the legacy variables."""
    if value is None or value.strip() == "":
        raise Refused(
            f"{HUB_ENV} has no {FIBER_ASSETS_KEY}: move the hub to it first (docs/testing-testnet.md, section 6), "
            "then add tokens with this script"
        )
    try:
        assets = json.loads(value)
    except json.JSONDecodeError as error:
        raise Refused(f"{FIBER_ASSETS_KEY} in {HUB_ENV} is not JSON: {error}") from None
    if not isinstance(assets, list):
        raise Refused(f"{FIBER_ASSETS_KEY} in {HUB_ENV} must be a JSON list")
    return assets


def _script_key(script: object) -> tuple:
    if not isinstance(script, dict):
        return ()
    return (str(script.get("codeHash", "")).lower(), script.get("hashType"), str(script.get("args", "")).lower())


def merge_asset(assets: list, entry: dict, replace: bool) -> tuple[list, str]:
    """The list with `entry` added, or put in place of the entry with its id (only with `replace`)."""
    index = next((i for i, other in enumerate(assets) if isinstance(other, dict) and other.get("id") == entry["id"]), None)
    clash = [
        other.get("id") for other in assets
        if isinstance(other, dict) and other.get("id") != entry["id"] and _script_key(other.get("typeScript")) == _script_key(entry.get("typeScript"))
    ]
    if clash:
        raise Refused(f"{clash[0]} already has this type script")
    if index is None:
        return [*assets, entry], "added"
    if not replace:
        raise Refused(f"{FIBER_ASSETS_KEY} already lists {entry['id']}: pass --replace to change its entry")
    return [*assets[:index], entry, *assets[index + 1:]], "replaced"


def compact_json(value: object) -> str:
    """One-line JSON, ASCII only: no character in it can end the env line or be read differently by a tool."""
    return json.dumps(value, separators=(",", ":"), ensure_ascii=True)


# ------------------------------------------------------------------------------------- command line (pure)
def parse_channel_spec(spec: str) -> dict:
    """`<pubkey>[@<multiaddr>]=<base units>` as {pubkey, address, amount}."""
    target, sep, amount = spec.rpartition("=")
    if not sep or not WHOLE_NUMBER.match(amount):
        raise Refused(f"--open-channel takes <pubkey>[@<multiaddr>]=<base units above 0>, got {spec!r}")
    pubkey, _, address = target.partition("@")
    pubkey = re.sub(r"^0x", "", pubkey.lower())
    if not NODE_ID.match(pubkey):
        raise Refused(f"--open-channel: {target!r} does not start with a node id (66 hex characters, 02 or 03 first)")
    return {"pubkey": pubkey, "address": address or None, "amount": int(amount)}


def parse_demo_auto_accept(values: list) -> str | None:
    """The --demo-auto-accept values as the generator takes them (ID=AMOUNT,...), None when none are given."""
    pairs = []
    for value in values:
        for pair in filter(None, (part.strip() for part in value.split(","))):
            asset, sep, amount = pair.partition("=")
            if not sep or not ASSET_ID.match(asset) or not WHOLE_NUMBER.match(amount):
                raise Refused(f"--demo-auto-accept takes ID=AMOUNT (base units above 0), got {pair!r}")
            pairs.append(f"{asset}={amount}")
    return ",".join(pairs) or None


def backup_name(now: datetime.datetime) -> str:
    return "add-token-" + now.strftime("%Y%m%dT%H%M%SZ")


def generator_command(demo_auto_accept: str | None) -> list:
    """The hub image's generator: validates the whole hub config with FIBER_ASSETS from the environment, then writes
    both regenerated files into the out folder."""
    command = [
        "node", GENERATOR, "--from-env", "--check-config",
        "--hub-yml", f"{CONTAINER_FNN_DIR}/{HUB_YML}", "--demo-yml", f"{CONTAINER_FNN_DIR}/{DEMO_YML}",
        "--out-dir", CONTAINER_OUT_DIR,
    ]
    if demo_auto_accept:
        command += ["--demo-auto-accept", demo_auto_accept]
    return command


def compose_run_command(fiber_assets: str, fnn_dir: str, out_dir: str, demo_auto_accept: str | None) -> list:
    """A one-off hub container with the kit's settings, FIBER_ASSETS replaced by the merged list (-e wins over hub.env)."""
    return [
        "docker", "compose", "run", "--rm", "--no-deps", "-T",
        "-e", f"{FIBER_ASSETS_KEY}={fiber_assets}",
        "-v", f"{fnn_dir}:{CONTAINER_FNN_DIR}:ro", "-v", f"{out_dir}:{CONTAINER_OUT_DIR}",
        SERVICE_HUB, *generator_command(demo_auto_accept),
    ]


def udt_entry_matches(info: dict, script: dict) -> bool:
    """A node_info.udt_cfg_infos entry for this exact script (the whitelist writes args as ^args$)."""
    found = info.get("script") or {}
    args = str(found.get("args", "")).lower()
    return (
        str(found.get("code_hash", "")).lower() == str(script.get("codeHash", "")).lower()
        and found.get("hash_type") == script.get("hashType")
        and args in (str(script.get("args", "")).lower(), f"^{str(script.get('args', '')).lower()}$")
    )


def auto_accept_of(info: dict) -> int | None:
    value = info.get("auto_accept_amount")
    if value is None:
        return None
    return int(value, 16) if isinstance(value, str) else int(value)


def expected_hub_auto_accept(entry: dict) -> int | None:
    """What fnn-hub must auto-accept for the token: its peerChannels.minAmount, or nothing."""
    peer = entry.get("peerChannels")
    return int(peer["minAmount"]) if isinstance(peer, dict) and "minAmount" in peer else None


def is_live_channel_in(channel: dict, script: dict) -> bool:
    funding = channel.get("funding_udt_type_script")
    state = (channel.get("state") or {}).get("state_name")
    return state not in FNN_ENDING_STATES and funding is not None and udt_entry_matches({"script": funding}, script)


# ------------------------------------------------------------------------------------------------ the server
class Kit:
    """The kit folder on the server and the compose project in it."""

    def __init__(self, directory: str):
        self.dir = os.path.abspath(directory)
        self.hub_env = os.path.join(self.dir, HUB_ENV)
        self.fnn_dir = os.path.join(self.dir, FNN_DIR)

    def path(self, *parts: str) -> str:
        return os.path.join(self.dir, *parts)

    def check_layout(self, template_fnn_dir: str | None = None) -> None:
        """The kit's files; the fnn files from `template_fnn_dir` when given (the server's own may not exist yet)."""
        fnn_dir = template_fnn_dir or self.fnn_dir
        for path in (self.path("docker-compose.yml"), self.hub_env, os.path.join(fnn_dir, HUB_YML), os.path.join(fnn_dir, DEMO_YML)):
            if not os.path.isfile(path):
                raise Refused(f"{path} is missing: run this in the kit folder (or pass --kit-dir)")

    def compose(self, args: list, input_text: str | None = None, timeout: int = COMMAND_TIMEOUT_SECONDS) -> str:
        """Runs `docker compose <args>` in the kit folder; raises Refused with its stderr when it fails."""
        result = subprocess.run(
            ["docker", "compose", *args], cwd=self.dir, input=input_text, capture_output=True, text=True, timeout=timeout
        )
        if result.returncode != 0:
            raise Refused(f"docker compose {args[0]} failed: {(result.stderr or result.stdout).strip()}")
        return result.stdout

    def running_services(self) -> set:
        return set(self.compose(["ps", "--services", "--status", "running"]).split())

    def health(self, service: str) -> str | None:
        output = self.compose(["ps", "--format", "json", service]).strip()
        if not output:
            return None
        rows = json.loads(output) if output.startswith("[") else [json.loads(line) for line in output.splitlines() if line.strip()]
        return (rows[0].get("Health") or rows[0].get("State")) if rows else None

    def wait_healthy(self, service: str) -> None:
        deadline = time.time() + HEALTH_WAIT_SECONDS
        while time.time() < deadline:
            if self.health(service) == HEALTHY:
                return
            time.sleep(POLL_SECONDS)
        raise Refused(f"{service} is not healthy after {HEALTH_WAIT_SECONDS} s: check `docker compose logs {service}`")

    def fnn_rpc(self, service: str, method: str, params: list | None = None) -> object:
        request = json.dumps({"jsonrpc": JSON_RPC_VERSION, "id": 1, "method": method, "params": params or []})
        output = self.compose(["exec", "-T", service, "sh", "-c", FNN_RPC_CURL], input_text=request)
        answer = json.loads(output)
        if answer.get("error"):
            raise Refused(f"{service} {method}: {answer['error'].get('message')}")
        return answer.get("result")


class HubHttp:
    """The hub's API from the server, on the port Compose publishes on 127.0.0.1 (as the deploy kit's checks call it)."""

    def __init__(self, kit: Kit, proxy_secret: str | None):
        address = kit.compose(["port", SERVICE_HUB, str(HUB_CONTAINER_PORT)]).strip().splitlines()
        if not address:
            raise Refused("the hub publishes no port: is it running?")
        host, _, port = address[0].rpartition(":")
        self.base = f"http://{'127.0.0.1' if host in ('0.0.0.0', '') else host}:{port}"
        self.headers = {"accept": "application/json", **({PROXY_SECRET_HEADER: proxy_secret} if proxy_secret else {})}

    def get(self, path: str) -> tuple:
        request = urllib.request.Request(self.base + path, headers=self.headers)
        try:
            with urllib.request.urlopen(request, timeout=HTTP_TIMEOUT_SECONDS) as response:
                return response.status, json.loads(response.read() or b"null")
        except urllib.error.HTTPError as error:
            return error.code, json.loads(error.read() or b"null")

    def wait_up(self) -> None:
        deadline = time.time() + HEALTH_WAIT_SECONDS
        while time.time() < deadline:
            try:
                status, _ = self.get(HEALTH_PATH)
                if status in (200, 503):
                    return
            except (urllib.error.URLError, ConnectionError, json.JSONDecodeError, OSError):
                pass
            time.sleep(POLL_SECONDS)
        raise Refused(f"the hub does not answer {HEALTH_PATH} after {HEALTH_WAIT_SECONDS} s: `docker compose logs hub`")


# ------------------------------------------------------------------------------------------------ the steps
def say(text: str) -> None:
    print(text, flush=True)


WHITELIST_KEY = re.compile(r"^(\s*)udt_whitelist:\s*$")
ENTRY_START = re.compile(r"^\s*-\s+name:\s*(.+?)\s*$")
SCRIPT_KEY = re.compile(r"^\s*script:\s*$")
CODE_HASH_LINE = re.compile(r"^\s*code_hash:\s*(0x[0-9a-fA-F]+)")
ARGS_LINE = re.compile(r'^\s*args:\s*"?\^?(0x[0-9a-fA-F]*)\$?"?\s*(#.*)?$')


def whitelisted_scripts(text: str | None) -> dict:
    """The scripts a fnn config's ckb.udt_whitelist names, {(code_hash, args) in lower case: entry name}; args are
    read with or without the ^…$ anchors, so an older unanchored file compares with a generated one."""
    found, inside, base, name, in_script, code_hash = {}, False, 0, None, False, None
    for line in (text or "").splitlines():
        key = WHITELIST_KEY.match(line)
        if key:
            inside, base = True, len(key.group(1))
            continue
        if not inside or not line.strip() or line.lstrip().startswith("#"):
            continue
        if len(line) - len(line.lstrip()) <= base and not line.lstrip().startswith("-"):
            break
        entry = ENTRY_START.match(line)
        if entry:
            name, in_script, code_hash = entry.group(1).strip('"'), False, None
        elif SCRIPT_KEY.match(line):
            in_script = True
        elif in_script and CODE_HASH_LINE.match(line):
            code_hash = CODE_HASH_LINE.match(line).group(1).lower()
        elif in_script and code_hash and ARGS_LINE.match(line):
            found[(code_hash, ARGS_LINE.match(line).group(1).lower())] = name
            in_script = False
    return found


def dropped_tokens(files: dict) -> list:
    """Tokens a node's current whitelist names that the regenerated one leaves out, as "<file>: <name>"."""
    dropped = []
    for name, (old, new) in files.items():
        kept = whitelisted_scripts(new)
        dropped += [f"{FNN_DIR}/{name}: {token}" for script, token in whitelisted_scripts(old).items() if script not in kept]
    return dropped


def read_if_present(path: str) -> str | None:
    if not os.path.isfile(path):
        return None
    with open(path, encoding="utf-8", newline="") as handle:
        return handle.read()


def render_whitelists(kit: Kit, assets_json: str, demo_auto_accept: str | None, template_fnn_dir: str | None = None) -> dict:
    """Validates the merged list and generates both files in the hub image, from `template_fnn_dir`'s copies (the
    repo's, which `testnet sync` uploads there) or else the kit's own; returns {name: (old, new)}, old being what the
    kit's fnn folder holds now (what fnn runs; None when the file does not exist yet)."""
    out_dir = tempfile.mkdtemp(prefix="ckbolt-add-token-")
    try:
        os.chmod(out_dir, OUT_DIR_MODE)  # the container writes as its `node` user
        result = subprocess.run(
            compose_run_command(assets_json, template_fnn_dir or kit.fnn_dir, out_dir, demo_auto_accept),
            cwd=kit.dir, capture_output=True, text=True, timeout=COMMAND_TIMEOUT_SECONDS,
        )
        say(result.stdout.rstrip())
        if result.returncode != 0:
            raise Refused(
                "the hub image refused the new configuration (nothing was changed):\n" + result.stderr.strip()
                + "\nIf it says it cannot find the generator, update the image first: `testnet sync`, `testnet build hub`."
            )
        files = {}
        for name in (HUB_YML, DEMO_YML):
            with open(os.path.join(out_dir, name), encoding="utf-8", newline="") as new:
                files[name] = (read_if_present(os.path.join(kit.fnn_dir, name)), new.read())
        return files
    finally:
        shutil.rmtree(out_dir, ignore_errors=True)


def back_up(kit: Kit) -> str:
    folder = kit.path(BACKUP_DIR, backup_name(datetime.datetime.now(datetime.timezone.utc)))
    os.makedirs(os.path.join(folder, FNN_DIR), mode=SECRET_DIR_MODE, exist_ok=False)
    os.chmod(kit.path(BACKUP_DIR), SECRET_DIR_MODE)
    shutil.copy2(kit.hub_env, os.path.join(folder, HUB_ENV))
    for name in (HUB_YML, DEMO_YML):
        if os.path.isfile(os.path.join(kit.fnn_dir, name)):
            shutil.copy2(os.path.join(kit.fnn_dir, name), os.path.join(folder, FNN_DIR, name))
    return folder


def write_keeping_mode(path: str, text: str) -> None:
    """Rewrites a file in place, so its owner and mode stay (hub.env is owner-only)."""
    with open(path, "w", encoding="utf-8", newline="") as handle:
        handle.write(text)


def restart_fnn(kit: Kit, changed: dict) -> None:
    running = kit.running_services()
    for name, service in ((HUB_YML, SERVICE_FNN_HUB), (DEMO_YML, SERVICE_FNN_DEMO)):
        if not changed[name]:
            say(f"{service}: whitelist unchanged, not restarted")
        elif service not in running:
            say(f"{service}: not running; it reads the new whitelist when it starts")
        else:
            say(f"{service}: restarting (fnn reads its whitelist only at start)")
            kit.compose(["restart", service])
            kit.wait_healthy(service)


def check_whitelist(kit: Kit, service: str, entry: dict, expected_auto_accept: int | None, check_amount: bool) -> None:
    """The node whitelists the token; with `check_amount`, auto-accepts exactly from `expected_auto_accept` (None: off)."""
    infos = (kit.fnn_rpc(service, "node_info") or {}).get("udt_cfg_infos") or []
    found = next((info for info in infos if udt_entry_matches(info, entry["typeScript"])), None)
    if found is None:
        raise Refused(f"{service} does not whitelist {entry['id']} (node_info.udt_cfg_infos): check its config and logs")
    actual = auto_accept_of(found)
    if check_amount and actual != expected_auto_accept:
        expected = expected_auto_accept if expected_auto_accept is not None else "no auto-accept"
        raise Refused(f"{service} auto-accepts {entry['id']} from {actual}, expected {expected}")
    say(f"{service}: whitelists {entry['id']}, auto-accept {actual if actual is not None else 'off'}")


def check_hub(http: HubHttp, entry: dict) -> None:
    status, body = http.get(ASSETS_PATH)
    ids = [asset.get("id") for asset in (body or {}).get("data", [])] if status == 200 else []
    if entry["id"] not in ids:
        raise Refused(f"GET {ASSETS_PATH} answered {status} without {entry['id']}: check `docker compose logs hub`")
    say(f"hub: GET {ASSETS_PATH} lists {', '.join(ids)}")
    status, body = http.get(FIBER_NODE_PATH)
    asset = next((a for a in (body or {}).get("assets", []) if a.get("id") == entry["id"]), None) if status == 200 else None
    if asset is None:
        raise Refused(f"GET {FIBER_NODE_PATH} answered {status} without {entry['id']}")
    say(f"hub: GET {FIBER_NODE_PATH} peerChannels for {entry['id']}: {json.dumps(asset.get('peerChannels'))}")


def open_channels(kit: Kit, entry: dict, specs: list, wait_minutes: int) -> None:
    """Opens public channels from fnn-hub one at a time, each ChannelReady before the next: fnn funds UDT channels from
    the same token cells, and two funding at once fail with "can not find enough UDT owner cells"."""
    script = entry["typeScript"]
    fnn_script = {"code_hash": script["codeHash"], "hash_type": script["hashType"], "args": script["args"]}
    for spec in specs:
        label = f"{entry['id']} channel to {spec['pubkey'][:12]}... ({spec['amount']} base units)"
        if spec["address"]:
            kit.fnn_rpc(SERVICE_FNN_HUB, "connect_peer", [{"address": spec["address"], "save": True}])
        existing = (kit.fnn_rpc(SERVICE_FNN_HUB, "list_channels", [{"pubkey": spec["pubkey"]}]) or {}).get("channels", [])
        if any(is_live_channel_in(channel, script) for channel in existing):
            say(f"{label}: one is already open or opening, skipped")
            continue
        kit.fnn_rpc(SERVICE_FNN_HUB, "open_channel", [
            {"pubkey": spec["pubkey"], "funding_amount": hex(spec["amount"]), "public": True, "funding_udt_type_script": fnn_script}
        ])
        say(f"{label}: opening; waiting for {CHANNEL_READY} (CKB confirmations take minutes)")
        wait_ready(kit, spec["pubkey"], script, label, wait_minutes)


def wait_ready(kit: Kit, pubkey: str, script: dict, label: str, wait_minutes: int) -> None:
    deadline = time.time() + wait_minutes * 60
    while time.time() < deadline:
        channels = (kit.fnn_rpc(SERVICE_FNN_HUB, "list_channels", [{"pubkey": pubkey}]) or {}).get("channels", [])
        if any(is_live_channel_in(c, script) and (c.get("state") or {}).get("state_name") == CHANNEL_READY for c in channels):
            say(f"{label}: {CHANNEL_READY}")
            return
        time.sleep(POLL_SECONDS)
    raise Refused(f"{label} is not {CHANNEL_READY} after {wait_minutes} minutes: the next channels were not opened")


def asset_ids(assets: list) -> str:
    return ", ".join(str(a.get("id")) for a in assets if isinstance(a, dict)) or "none"


def describe_assets_change(before: list, after: list, entry: dict | None, outcome: str) -> None:
    say(f"{FIBER_ASSETS_KEY}: {asset_ids(before)}  ->  {asset_ids(after)}")
    if entry is not None:
        say(f"{entry['id']} {outcome}:\n{json.dumps(entry, indent=2, ensure_ascii=False)}")


def run(args: argparse.Namespace) -> int:
    kit = Kit(args.kit_dir)
    template_fnn_dir = os.path.join(kit.path(args.template_dir), FNN_DIR) if args.template_dir else None
    kit.check_layout(template_fnn_dir)
    with open(kit.hub_env, encoding="utf-8", newline="") as handle:
        env_text = handle.read()
    before = parse_assets(read_env_value(env_text, FIBER_ASSETS_KEY))
    entry = None
    if args.token:
        with open(args.token, encoding="utf-8") as handle:
            entry = load_token(handle.read())
        after, outcome = merge_asset(before, entry, args.replace)
    else:
        after, outcome = before, "unchanged"
    specs = [parse_channel_spec(spec) for spec in args.open_channel]
    if specs and entry is None:
        raise Refused("--open-channel needs a token file: it opens channels in that token")
    assets_json = compact_json(after)
    describe_assets_change(before, after, entry, outcome)

    files = render_whitelists(kit, assets_json, parse_demo_auto_accept(args.demo_auto_accept), template_fnn_dir)
    changed = {name: old != new for name, (old, new) in files.items()}
    dropped = dropped_tokens(files)
    if dropped and not args.allow_drop:
        raise Refused(
            "the new whitelist leaves out tokens fnn has now (nothing was changed): " + ", ".join(dropped)
            + ". A channel in a token fnn no longer whitelists cannot close after fnn restarts. Put the token back in "
            + f"{FIBER_ASSETS_KEY}, or pass --allow-drop once no channel in it is left."
        )
    new_env = set_env_value(env_text, FIBER_ASSETS_KEY, env_json_literal(assets_json)) if entry is not None else env_text
    if not args.apply:
        say("\nDry run: nothing was changed. With --apply it would:")
        say(f"  - back up {HUB_ENV} and {FNN_DIR}/*.yml into {BACKUP_DIR}/add-token-<UTC time>/, if it writes anything")
        if new_env != env_text:
            say(f"  - write {FIBER_ASSETS_KEY} in {HUB_ENV}")
        for name, service in ((HUB_YML, SERVICE_FNN_HUB), (DEMO_YML, SERVICE_FNN_DEMO)):
            say(f"  - {'write ' + FNN_DIR + '/' + name + ' and restart ' + service if changed[name] else 'leave ' + FNN_DIR + '/' + name}")
        say(f"  - {'recreate the hub, then ' if new_env != env_text else ''}check node_info.udt_cfg_infos, GET {ASSETS_PATH} and GET {FIBER_NODE_PATH}")
        for spec in specs:
            say(f"  - open a public channel from fnn-hub to {spec['pubkey']} with {spec['amount']} base units, then wait for it")
        return 0

    # `testnet sync` runs --regenerate --apply every time: a backup (a copy of hub.env) only when something is written.
    folder = back_up(kit) if new_env != env_text or any(changed.values()) else None
    say(f"backed up into {folder}" if folder else "nothing to write, no backup made")
    if new_env != env_text:
        write_keeping_mode(kit.hub_env, new_env)
        say(f"{HUB_ENV}: {FIBER_ASSETS_KEY} written")
    for name, (_, new) in files.items():
        if changed[name]:
            write_keeping_mode(os.path.join(kit.fnn_dir, name), new)
            say(f"{FNN_DIR}/{name}: written")
    try:
        restart_fnn(kit, changed)
        if new_env != env_text:
            say("hub: recreating it with the new settings (a restart would keep the old hub.env)")
            kit.compose(["up", "-d", "--no-deps", "--force-recreate", SERVICE_HUB])
        # A stopped service reads the files when it starts: only what runs is checked (`testnet sync` runs this anytime)
        running = kit.running_services()
        if SERVICE_FNN_HUB not in running:
            say(f"{SERVICE_FNN_HUB}: not running, not checked")
        hub_checkable = SERVICE_HUB in running and SERVICE_FNN_HUB in running
        if not hub_checkable:
            say(f"hub: GET {ASSETS_PATH} and GET {FIBER_NODE_PATH} not checked ({SERVICE_HUB} or {SERVICE_FNN_HUB} not running)")
        http = HubHttp(kit, read_env_value(new_env, PROXY_SECRET_KEY) or None) if hub_checkable else None
        if http:
            http.wait_up()
        for asset in after if entry is None else [entry]:
            if SERVICE_FNN_HUB in running:
                check_whitelist(kit, SERVICE_FNN_HUB, asset, expected_hub_auto_accept(asset), check_amount=True)
            if SERVICE_FNN_DEMO in running:
                check_whitelist(kit, SERVICE_FNN_DEMO, asset, None, check_amount=False)
            if http:
                check_hub(http, asset)
        if entry is not None:
            open_channels(kit, entry, specs, args.wait_minutes)
    except Exception:
        if folder:
            say(f"\nSomething failed after the files were written. To go back: cp -p {folder}/{HUB_ENV} {kit.hub_env}; "
                f"cp -p {folder}/{FNN_DIR}/*.yml {kit.fnn_dir}/; then docker compose restart {SERVICE_FNN_HUB} {SERVICE_FNN_DEMO}; "
                f"docker compose up -d --no-deps --force-recreate {SERVICE_HUB}")
        raise
    say("\nDone. `testnet sync` uploads the repo's fnn/*.yml as templates and runs `python3 add_token.py --regenerate "
        "--apply --template-dir .sync-templates` itself: fnn restarts only when the regenerated whitelist differs from "
        "these files.")
    return 0


def parse_args(argv: list) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0], epilog="Runbook: docs/add-token.md")
    parser.add_argument("token", nargs="?", help="a JSON file with one FIBER_ASSETS entry")
    parser.add_argument("--apply", action="store_true", help="change files and restart services (default: dry run)")
    parser.add_argument("--replace", action="store_true", help="replace the entry with the same id instead of refusing")
    parser.add_argument("--regenerate", action="store_true", help="no token: regenerate the whitelists from hub.env")
    parser.add_argument("--demo-auto-accept", action="append", default=[], metavar="ID=AMOUNT", help="fnn-demo's auto-accept amount for an asset")
    parser.add_argument("--open-channel", action="append", default=[], metavar="PUBKEY[@MULTIADDR]=AMOUNT", help="a public channel from fnn-hub, base units; one at a time")
    parser.add_argument("--wait-minutes", type=int, default=DEFAULT_CHANNEL_WAIT_MINUTES, help="how long each channel may take to be ready")
    parser.add_argument("--kit-dir", default=os.path.dirname(os.path.abspath(__file__)), help="the kit folder (default: this script's)")
    parser.add_argument("--template-dir", help="generate from <dir>/fnn/*.yml (the repo's copies `testnet sync` uploads) instead of the kit's own")
    parser.add_argument("--allow-drop", action="store_true", help="let the new whitelist leave out a token fnn has now")
    args = parser.parse_args(argv)
    if bool(args.token) == bool(args.regenerate):
        parser.error("give a token file, or --regenerate (not both)")
    return args


def main(argv: list) -> int:
    try:
        return run(parse_args(argv))
    except Refused as error:
        print(f"add_token: {error}", file=sys.stderr)
        return 1
    except subprocess.TimeoutExpired as error:
        print(f"add_token: {error.cmd[:3]} did not finish in {error.timeout} s", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
