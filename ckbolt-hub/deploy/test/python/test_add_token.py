"""Tests of deploy/testnet/add_token.py: its pure parts, and one dry run on a temporary kit with a fake `docker`.

Run from the repo root (Python 3, stdlib only):  python3 -m unittest discover -s deploy/test/python -v
"""
from __future__ import annotations

import contextlib
import datetime
import io
import json
import os
import shutil
import stat
import sys
import tempfile
import textwrap
import unittest

# deploy/testnet is uploaded to the server as is: importing the script must not leave a __pycache__ folder there.
sys.dont_write_bytecode = True
KIT_SOURCE_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "testnet"))
sys.path.insert(0, KIT_SOURCE_DIR)
import add_token as at  # noqa: E402

Refused = at.Refused

NODE_ID = "02" + "ab" * 32
MULTIADDR = "/ip4/203.0.113.7/tcp/8228/p2p/QmdyQWjPtbK4NWWsvy8s69NGJaQULwgeQDT5ZpNDrTNaeV"
SECRET = "supersecretvalue-0123456789abcdef0123456789abcdef"
SCRIPT_RUSD = {"codeHash": "0x" + "11" * 32, "hashType": "type", "args": "0x" + "22" * 32}
SCRIPT_TKN = {"codeHash": "0x" + "33" * 32, "hashType": "type", "args": "0x" + "44" * 20}


def asset(asset_id: str, script: dict, **extra) -> dict:
    return {"id": asset_id, "symbol": asset_id, "name": f"{asset_id} token", "decimals": 8, "usdRule": "usd_peg",
            "typeScript": dict(script), "cellDeps": [{"outPoint": {"txHash": "0x" + "55" * 32, "index": "0x0"}, "depType": "code"}],
            **extra}


# ---------------------------------------------------------------------------------------------------- hub.env
class ReadEnvValueTest(unittest.TestCase):
    def test_single_quoted_value_is_taken_literally(self):
        self.assertEqual(at.read_env_value("A=1\nFIBER_ASSETS='[{\"id\":\"RUSD\"}]'\n", "FIBER_ASSETS"), '[{"id":"RUSD"}]')

    def test_double_quoted_value_unescapes_quotes_and_backslashes(self):
        self.assertEqual(at.read_env_value('K="say \\"hi\\" C:\\\\dir"\n', "K"), 'say "hi" C:\\dir')

    def test_unquoted_value(self):
        self.assertEqual(at.read_env_value("K=plain-value\n", "K"), "plain-value")

    def test_spaces_around_the_equals_sign_and_export_prefix(self):
        self.assertEqual(at.read_env_value("  K = v1 \n", "K"), "v1")
        self.assertEqual(at.read_env_value("export K=v2\n", "K"), "v2")

    def test_inline_comment_after_an_unquoted_value_is_dropped(self):
        self.assertEqual(at.read_env_value("K=value   # a comment\n", "K"), "value")

    def test_hash_without_a_space_before_it_is_part_of_the_value(self):
        self.assertEqual(at.read_env_value("K=val#ue\n", "K"), "val#ue")

    def test_inline_comment_after_a_quoted_value_is_dropped(self):
        # Compose (and Node's parseEnv) read both as `value`: the hub sees it so, the script must too.
        self.assertEqual(at.read_env_value("K='value' # a comment\n", "K"), "value")
        self.assertEqual(at.read_env_value('K="value" # a comment\n', "K"), "value")

    def test_quoted_value_keeps_a_hash_inside_its_quotes(self):
        self.assertEqual(at.read_env_value("K='a # b' # c\n", "K"), "a # b")
        self.assertEqual(at.read_env_value('K="a # b"\n', "K"), "a # b")

    def test_quoted_value_with_a_comment_and_no_space_before_it(self):
        self.assertEqual(at.read_env_value("K='value'# c\n", "K"), "value")

    def test_empty_quoted_value_with_a_comment(self):
        self.assertEqual(at.read_env_value("K='' # c\n", "K"), "")
        self.assertEqual(at.read_env_value('K="" # c\n', "K"), "")

    def test_double_quoted_value_with_an_escaped_quote_and_a_comment(self):
        self.assertEqual(at.read_env_value('K="say \\"hi\\"" # c\n', "K"), 'say "hi"')

    def test_quoted_json_with_a_comment_parses(self):
        text = "FIBER_ASSETS='[{\"id\":\"RUSD\",\"name\":\"R #1\"}]'   # added by add_token.py\r\n"
        self.assertEqual(at.parse_assets(at.read_env_value(text, "FIBER_ASSETS")), [{"id": "RUSD", "name": "R #1"}])

    def test_unicode_line_separators_do_not_split_a_line(self):
        for separator in ("\u2028", "\u2029", "\x85", "\x0b", "\x0c", "\x1c", "\x1d", "\x1e"):
            with self.subTest(separator=repr(separator)):
                text = f"A=1\nFIBER_ASSETS='[\"a{separator}b\"]'\nB=2\n"
                self.assertEqual(at.read_env_value(text, "FIBER_ASSETS"), f'["a{separator}b"]')
                self.assertEqual(at.read_env_value(text, "B"), "2")

    def test_a_separator_inside_a_value_does_not_make_a_second_line_for_the_key(self):
        self.assertEqual(at.read_env_value("NOTE='x\u2028K=2'\nK=1\n", "K"), "1")

    def test_crlf_line_end_is_not_part_of_the_value(self):
        self.assertEqual(at.read_env_value("A=1\r\nK='v'\r\nB=2\r\n", "K"), "v")
        self.assertEqual(at.read_env_value("K=v\r\n", "K"), "v")

    def test_last_line_without_line_end(self):
        self.assertEqual(at.read_env_value("A=1\nK='v'", "K"), "v")

    def test_empty_value(self):
        self.assertEqual(at.read_env_value("K=\n", "K"), "")

    def test_missing_key_is_none(self):
        self.assertIsNone(at.read_env_value("A=1\nB=2\n", "K"))
        self.assertIsNone(at.read_env_value("", "K"))

    def test_commented_out_line_and_longer_key_do_not_count(self):
        text = "# K=old\n#K=older\nK_EXTRA=x\nXK=y\nK=current\n"
        self.assertEqual(at.read_env_value(text, "K"), "current")
        self.assertIsNone(at.read_env_value("# K=old\nK_EXTRA=x\n", "K"))

    def test_key_set_twice_is_refused(self):
        with self.assertRaisesRegex(Refused, "sets K 2 times"):
            at.read_env_value("K=1\nA=2\nK=3\n", "K")

    def test_key_set_twice_with_export_is_refused(self):
        with self.assertRaises(Refused):
            at.read_env_value("K=1\nexport K=3\n", "K")


class SetEnvValueTest(unittest.TestCase):
    OTHER_LINES = "# hub.env\n\nHUB_PROXY_SECRET=abc  \n  SPACED = 1 # note\n"

    def test_replaces_the_line_and_keeps_every_other_line_byte_for_byte(self):
        text = self.OTHER_LINES + "FIBER_ASSETS='[1]'\nTAIL=\"x\"\n"
        self.assertEqual(at.set_env_value(text, "FIBER_ASSETS", "'[2]'"), self.OTHER_LINES + "FIBER_ASSETS='[2]'\nTAIL=\"x\"\n")

    def test_keeps_crlf(self):
        text = "A=1\r\nFIBER_ASSETS='[1]'\r\n# c\r\nB=2\r\n"
        self.assertEqual(at.set_env_value(text, "FIBER_ASSETS", "'[2]'"), "A=1\r\nFIBER_ASSETS='[2]'\r\n# c\r\nB=2\r\n")

    def test_keeps_lf_in_a_file_that_mixes_line_ends(self):
        text = "A=1\r\nFIBER_ASSETS='[1]'\nB=2\r\n"
        self.assertEqual(at.set_env_value(text, "FIBER_ASSETS", "'[2]'"), "A=1\r\nFIBER_ASSETS='[2]'\nB=2\r\n")

    def test_replaces_a_last_line_without_line_end_without_adding_one(self):
        self.assertEqual(at.set_env_value("A=1\nK=old", "K", "new"), "A=1\nK=new")

    def test_leaves_a_commented_out_line_alone(self):
        self.assertEqual(at.set_env_value("# K=old\nK=old\n", "K", "new"), "# K=old\nK=new\n")

    def test_appends_when_missing(self):
        self.assertEqual(at.set_env_value("A=1\n", "K", "'v'"), "A=1\nK='v'\n")

    def test_appends_with_crlf_in_a_crlf_file(self):
        self.assertEqual(at.set_env_value("A=1\r\nB=2\r\n", "K", "v"), "A=1\r\nB=2\r\nK=v\r\n")

    def test_appends_after_a_file_without_trailing_newline(self):
        self.assertEqual(at.set_env_value("A=1", "K", "v"), "A=1\nK=v\n")
        self.assertEqual(at.set_env_value("A=1\r\nB=2", "K", "v"), "A=1\r\nB=2\r\nK=v\r\n")

    def test_appends_to_an_empty_file(self):
        self.assertEqual(at.set_env_value("", "K", "v"), "K=v\n")

    def test_replaces_a_value_holding_a_unicode_line_separator_whole(self):
        text = "A=1\r\nFIBER_ASSETS='[\"a\u2028b\"]'\r\nB=2\r\n"
        self.assertEqual(at.set_env_value(text, "FIBER_ASSETS", "'[]'"), "A=1\r\nFIBER_ASSETS='[]'\r\nB=2\r\n")

    def test_keeps_other_lines_with_unicode_line_separators_byte_for_byte(self):
        others = "NOTE='a\u2028b\x85c\x0cd'\nX=\u2029\n"
        self.assertEqual(at.set_env_value(others + "K=old\n", "K", "new"), others + "K=new\n")
        self.assertEqual(at.set_env_value(others, "K", "new"), others + "K=new\n")

    def test_written_value_reads_back(self):
        text = at.set_env_value(self.OTHER_LINES, "FIBER_ASSETS", at.env_json_literal('[{"id":"X"}]'))
        self.assertEqual(at.read_env_value(text, "FIBER_ASSETS"), '[{"id":"X"}]')


class EnvJsonLiteralTest(unittest.TestCase):
    VALUE = [{"id": "BOB", "name": "Bob's token", "note": "a\\'b", "icon": "data:image/svg+xml,<svg/>", "x": "$HOME #1"}]

    def test_single_quotes_inside_json_become_unicode_escapes(self):
        literal = at.env_json_literal(json.dumps(self.VALUE))
        self.assertTrue(literal.startswith("'") and literal.endswith("'"))
        self.assertNotIn("'", literal[1:-1])
        self.assertIn("Bob\\u0027s token", literal)

    def test_result_without_the_quotes_loads_to_the_same_value(self):
        literal = at.env_json_literal(at.compact_json(self.VALUE))
        self.assertEqual(json.loads(literal[1:-1]), self.VALUE)

    def test_round_trip_through_hub_env(self):
        text = at.set_env_value("A=1\n", "FIBER_ASSETS", at.env_json_literal(at.compact_json(self.VALUE)))
        self.assertEqual(at.parse_assets(at.read_env_value(text, "FIBER_ASSETS")), self.VALUE)

    def test_compact_json_is_ascii_and_loads_back(self):
        value = [{"id": "U", "name": "Zürich \u2028 token \U0001F600", "displayName": "a\u2029b\x85"}]
        text = at.compact_json(value)
        self.assertTrue(text.isascii())
        self.assertNotIn('", "', text)
        self.assertNotIn('": "', text)
        self.assertEqual(json.loads(text), value)
        self.assertTrue(at.env_json_literal(text).isascii())

    def test_round_trip_keeps_a_name_with_a_unicode_line_separator(self):
        # FIBER_ASSETS names may hold any character but C0 controls; compact_json keeps U+2028 raw, which
        # str.splitlines() takes for a line end, so the script cannot read back the hub.env it wrote.
        value = [{"id": "SEP", "name": "a\u2028b"}]
        text = at.set_env_value("A=1\n", "FIBER_ASSETS", at.env_json_literal(at.compact_json(value)))
        try:
            read_back = at.parse_assets(at.read_env_value(text, "FIBER_ASSETS"))
        except Refused as error:
            self.fail(f"the hub.env the script wrote is refused when read back: {error}")
        self.assertEqual(read_back, value)


# ----------------------------------------------------------------------------------------------------- assets
class LoadTokenTest(unittest.TestCase):
    def test_returns_the_entry(self):
        entry = asset("TKN", SCRIPT_TKN)
        self.assertEqual(at.load_token(json.dumps(entry)), entry)

    def test_refusals(self):
        cases = {
            "not JSON": ("{", "not JSON"),
            "a list": (json.dumps([asset("TKN", SCRIPT_TKN)]), "not a list"),
            "a string": ('"TKN"', "JSON object"),
            "no id": (json.dumps({"symbol": "TKN"}), '"id"'),
            "a numeric id": (json.dumps({"id": 7}), '"id"'),
            "a lower-case id": (json.dumps({"id": "tkn"}), '"id"'),
            "a one-letter id": (json.dumps({"id": "T"}), '"id"'),
            "an id starting with a digit": (json.dumps({"id": "1TKN"}), '"id"'),
            "an id of 17 characters": (json.dumps({"id": "A" * 17}), '"id"'),
        }
        for case, (text, message) in cases.items():
            with self.subTest(case), self.assertRaisesRegex(Refused, message):
                at.load_token(text)


class ParseAssetsTest(unittest.TestCase):
    def test_returns_the_list(self):
        self.assertEqual(at.parse_assets('[{"id":"RUSD"}]'), [{"id": "RUSD"}])
        self.assertEqual(at.parse_assets("[]"), [])

    def test_refuses_a_missing_or_empty_value(self):
        for value in (None, "", "   "):
            with self.subTest(value=value), self.assertRaisesRegex(Refused, "has no FIBER_ASSETS"):
                at.parse_assets(value)

    def test_refuses_bad_json(self):
        with self.assertRaisesRegex(Refused, "is not JSON"):
            at.parse_assets("[{")

    def test_refuses_a_value_that_is_not_a_list(self):
        for value in ('{"id":"RUSD"}', '"x"', "1"):
            with self.subTest(value=value), self.assertRaisesRegex(Refused, "must be a JSON list"):
                at.parse_assets(value)


class MergeAssetTest(unittest.TestCase):
    def setUp(self):
        self.rusd = asset("RUSD", SCRIPT_RUSD)
        self.tkn = asset("TKN", SCRIPT_TKN)
        self.other = asset("OTHER", {"codeHash": "0x" + "66" * 32, "hashType": "data1", "args": "0x"})

    def test_appends_a_new_id_without_touching_the_input(self):
        before = [self.rusd]
        merged, outcome = at.merge_asset(before, self.tkn, replace=False)
        self.assertEqual((merged, outcome), ([self.rusd, self.tkn], "added"))
        self.assertEqual(before, [self.rusd])

    def test_refuses_an_id_already_listed_without_replace(self):
        with self.assertRaisesRegex(Refused, "already lists TKN: pass --replace"):
            at.merge_asset([self.rusd, self.tkn], asset("TKN", SCRIPT_TKN, inboundAmount="5"), replace=False)

    def test_replaces_in_place_with_replace(self):
        changed = asset("TKN", SCRIPT_TKN, inboundAmount="5")
        merged, outcome = at.merge_asset([self.rusd, self.tkn, self.other], changed, replace=True)
        self.assertEqual((merged, outcome), ([self.rusd, changed, self.other], "replaced"))

    def test_replace_of_a_new_id_still_appends(self):
        self.assertEqual(at.merge_asset([self.rusd], self.tkn, replace=True), ([self.rusd, self.tkn], "added"))

    def test_refuses_the_same_type_script_under_another_id(self):
        with self.assertRaisesRegex(Refused, "RUSD already has this type script"):
            at.merge_asset([self.rusd, self.other], asset("COPY", SCRIPT_RUSD), replace=False)
        with self.assertRaisesRegex(Refused, "RUSD already has this type script"):
            at.merge_asset([self.rusd], asset("COPY", SCRIPT_RUSD), replace=True)

    def test_compares_scripts_ignoring_hex_case(self):
        shouting = {"codeHash": SCRIPT_RUSD["codeHash"].upper().replace("0X", "0x"), "hashType": "type", "args": SCRIPT_RUSD["args"].upper()}
        with self.assertRaisesRegex(Refused, "RUSD already has this type script"):
            at.merge_asset([self.rusd], asset("COPY", shouting), replace=False)

    def test_another_hash_type_is_another_script(self):
        data_script = dict(SCRIPT_RUSD, hashType="data1")
        merged, _ = at.merge_asset([self.rusd], asset("DATA", data_script), replace=False)
        self.assertEqual([a["id"] for a in merged], ["RUSD", "DATA"])

    def test_skips_entries_that_are_not_objects(self):
        merged, outcome = at.merge_asset(["junk", self.rusd], self.tkn, replace=False)
        self.assertEqual((merged, outcome), (["junk", self.rusd, self.tkn], "added"))


# ----------------------------------------------------------------------------------------------- command line
class ParseChannelSpecTest(unittest.TestCase):
    def test_with_multiaddr(self):
        self.assertEqual(at.parse_channel_spec(f"{NODE_ID}@{MULTIADDR}=1000000000"),
                         {"pubkey": NODE_ID, "address": MULTIADDR, "amount": 1000000000})

    def test_without_multiaddr(self):
        self.assertEqual(at.parse_channel_spec(f"{NODE_ID}=5"), {"pubkey": NODE_ID, "address": None, "amount": 5})

    def test_strips_a_0x_prefix_and_lower_cases(self):
        self.assertEqual(at.parse_channel_spec(f"0x{NODE_ID}=5")["pubkey"], NODE_ID)
        self.assertEqual(at.parse_channel_spec(f"0X{NODE_ID.upper()}=5")["pubkey"], NODE_ID)

    def test_empty_address_after_at_is_none(self):
        self.assertIsNone(at.parse_channel_spec(f"{NODE_ID}@=5")["address"])

    def test_refuses_a_bad_pubkey(self):
        for pubkey in ("04" + "ab" * 32, "02" + "ab" * 31, "02" + "ab" * 33, "02" + "zz" * 32, "", "0x"):
            with self.subTest(pubkey=pubkey), self.assertRaisesRegex(Refused, "node id"):
                at.parse_channel_spec(f"{pubkey}@{MULTIADDR}=5")

    def test_refuses_a_bad_amount(self):
        for spec in (f"{NODE_ID}", f"{NODE_ID}=", f"{NODE_ID}=0", f"{NODE_ID}=01", f"{NODE_ID}=-5", f"{NODE_ID}=1.5",
                     f"{NODE_ID}=1e9", f"{NODE_ID}=0x10", f"{NODE_ID}@{MULTIADDR}"):
            with self.subTest(spec=spec), self.assertRaisesRegex(Refused, "--open-channel takes"):
                at.parse_channel_spec(spec)


class ParseDemoAutoAcceptTest(unittest.TestCase):
    def test_none_without_values(self):
        self.assertIsNone(at.parse_demo_auto_accept([]))
        self.assertIsNone(at.parse_demo_auto_accept([" , "]))

    def test_joins_every_pair_trimmed(self):
        self.assertEqual(at.parse_demo_auto_accept(["RUSD=1000000000", " CWBTC=5 , X2=7,"]), "RUSD=1000000000,CWBTC=5,X2=7")

    def test_refuses_a_malformed_pair(self):
        for value in ("rusd=1", "RUSD=0", "RUSD=01", "RUSD", "RUSD=", "=1", "RUSD=1.5", "R=1", "RUSD=x"):
            with self.subTest(value=value), self.assertRaisesRegex(Refused, "--demo-auto-accept takes ID=AMOUNT"):
                at.parse_demo_auto_accept([value])


class BackupNameTest(unittest.TestCase):
    def test_utc_timestamp(self):
        now = datetime.datetime(2026, 11, 7, 1, 2, 3, tzinfo=datetime.timezone.utc)
        self.assertEqual(at.backup_name(now), "add-token-20261107T010203Z")


class GeneratorCommandTest(unittest.TestCase):
    ASSETS = '[{"id":"RUSD","name":"Bob\\u0027s \\"best\\" $HOME"}]'

    def test_generator_validates_from_the_environment_and_writes_both_files_into_the_out_folder(self):
        command = at.generator_command(None)
        self.assertEqual(command[:2], ["node", "dist/interfaces/cli/fnn-whitelist/main.js"])
        self.assertIn("--from-env", command)
        self.assertIn("--check-config", command)
        self.assertEqual(command[command.index("--hub-yml") + 1], "/kit-fnn/hub.yml")
        self.assertEqual(command[command.index("--demo-yml") + 1], "/kit-fnn/demo.yml")
        self.assertEqual(command[command.index("--out-dir") + 1], "/kit-out")
        self.assertNotIn("--write", command)
        self.assertNotIn("--demo-auto-accept", command)

    def test_demo_flag_only_when_given(self):
        self.assertNotIn("--demo-auto-accept", at.generator_command(""))
        self.assertEqual(at.generator_command("RUSD=1,CWBTC=2")[-2:], ["--demo-auto-accept", "RUSD=1,CWBTC=2"])

    def test_compose_run_shape(self):
        command = at.compose_run_command(self.ASSETS, "/opt/kit/fnn", "/tmp/out-1", None)
        self.assertEqual(command[:6], ["docker", "compose", "run", "--rm", "--no-deps", "-T"])
        self.assertEqual(command[command.index("-e") + 1], "FIBER_ASSETS=" + self.ASSETS)
        mounts = [command[i + 1] for i, part in enumerate(command) if part == "-v"]
        self.assertEqual(mounts, ["/opt/kit/fnn:/kit-fnn:ro", "/tmp/out-1:/kit-out"])
        hub = command.index("hub")
        self.assertGreater(hub, command.index("-e"))
        self.assertEqual(command[hub + 1:], at.generator_command(None))
        self.assertEqual(command.count("-e"), 1)

    def test_compose_run_passes_the_demo_flag_through(self):
        command = at.compose_run_command("[]", "/k/fnn", "/o", "RUSD=9")
        self.assertEqual(command[-2:], ["--demo-auto-accept", "RUSD=9"])


# ---------------------------------------------------------------------------------------------- node answers
class UdtEntryMatchesTest(unittest.TestCase):
    def info(self, **script) -> dict:
        found = {"code_hash": SCRIPT_TKN["codeHash"], "hash_type": "type", "args": SCRIPT_TKN["args"]}
        found.update(script)
        return {"name": "TKN", "script": found, "auto_accept_amount": None}

    def test_exact_and_anchored_args_match(self):
        self.assertTrue(at.udt_entry_matches(self.info(), SCRIPT_TKN))
        self.assertTrue(at.udt_entry_matches(self.info(args=f"^{SCRIPT_TKN['args']}$"), SCRIPT_TKN))

    def test_hex_case_does_not_matter(self):
        self.assertTrue(at.udt_entry_matches(self.info(code_hash=SCRIPT_TKN["codeHash"].upper(), args=SCRIPT_TKN["args"].upper()), SCRIPT_TKN))

    def test_other_scripts_do_not_match(self):
        for case, info in {
            "other args": self.info(args="0x" + "45" * 20),
            "a prefix regex": self.info(args=f"^{SCRIPT_TKN['args'][:-2]}"),
            "only one anchor": self.info(args=f"^{SCRIPT_TKN['args']}"),
            "other code hash": self.info(code_hash="0x" + "34" * 32),
            "other hash type": self.info(hash_type="data1"),
            "no script": {"name": "TKN"},
        }.items():
            with self.subTest(case):
                self.assertFalse(at.udt_entry_matches(info, SCRIPT_TKN))


class AutoAcceptTest(unittest.TestCase):
    def test_auto_accept_of(self):
        self.assertEqual(at.auto_accept_of({"auto_accept_amount": "0x3b9aca00"}), 1000000000)
        self.assertEqual(at.auto_accept_of({"auto_accept_amount": "0x0"}), 0)
        self.assertEqual(at.auto_accept_of({"auto_accept_amount": 77}), 77)
        self.assertIsNone(at.auto_accept_of({"auto_accept_amount": None}))
        self.assertIsNone(at.auto_accept_of({}))

    def test_expected_hub_auto_accept_is_peer_channels_min_amount_or_nothing(self):
        self.assertEqual(at.expected_hub_auto_accept({"peerChannels": {"minAmount": "10000000"}}), 10000000)
        self.assertEqual(at.expected_hub_auto_accept({"peerChannels": {"minAmount": 5}}), 5)
        self.assertIsNone(at.expected_hub_auto_accept({"autoAcceptAmount": "1000000000", "inboundAmount": "1000000000"}))
        self.assertIsNone(at.expected_hub_auto_accept({"peerChannels": {}}))
        self.assertIsNone(at.expected_hub_auto_accept({"peerChannels": None}))


class IsLiveChannelInTest(unittest.TestCase):
    FNN_SCRIPT = {"code_hash": SCRIPT_TKN["codeHash"], "hash_type": "type", "args": SCRIPT_TKN["args"]}

    def channel(self, state: str | None, funding: dict | None) -> dict:
        return {"channel_id": "0x01", "state": {"state_name": state} if state else None, "funding_udt_type_script": funding}

    def test_open_or_opening_channels_in_the_token_are_live(self):
        for state in ("ChannelReady", "NegotiatingFunding", "AwaitingChannelReady", None):
            with self.subTest(state=state):
                self.assertTrue(at.is_live_channel_in(self.channel(state, self.FNN_SCRIPT), SCRIPT_TKN))

    def test_ending_channels_ckb_channels_and_other_tokens_are_not(self):
        self.assertFalse(at.is_live_channel_in(self.channel("Closed", self.FNN_SCRIPT), SCRIPT_TKN))
        self.assertFalse(at.is_live_channel_in(self.channel("ShuttingDown", self.FNN_SCRIPT), SCRIPT_TKN))
        self.assertFalse(at.is_live_channel_in(self.channel("ChannelReady", None), SCRIPT_TKN))
        other = dict(self.FNN_SCRIPT, args="0x" + "99" * 20)
        self.assertFalse(at.is_live_channel_in(self.channel("ChannelReady", other), SCRIPT_TKN))


class ParseArgsTest(unittest.TestCase):
    def parse_error(self, argv: list) -> str:
        stderr = io.StringIO()
        with contextlib.redirect_stderr(stderr), self.assertRaises(SystemExit) as raised:
            at.parse_args(argv)
        self.assertEqual(raised.exception.code, 2)
        return stderr.getvalue()

    def test_token_alone_is_a_dry_run(self):
        args = at.parse_args(["tkn.json"])
        self.assertEqual((args.token, args.regenerate, args.apply, args.replace), ("tkn.json", False, False, False))
        self.assertEqual(args.kit_dir, KIT_SOURCE_DIR)
        self.assertEqual((args.demo_auto_accept, args.open_channel, args.wait_minutes), ([], [], 60))

    def test_regenerate_alone(self):
        args = at.parse_args(["--regenerate", "--apply", "--kit-dir", "/opt/ckbolt/testnet"])
        self.assertEqual((args.token, args.regenerate, args.apply, args.kit_dir), (None, True, True, "/opt/ckbolt/testnet"))

    def test_repeated_options_collect(self):
        args = at.parse_args(["t.json", "--demo-auto-accept", "RUSD=1", "--demo-auto-accept", "TKN=2",
                              "--open-channel", f"{NODE_ID}=1", "--open-channel", f"{NODE_ID}@{MULTIADDR}=2", "--wait-minutes", "5"])
        self.assertEqual(args.demo_auto_accept, ["RUSD=1", "TKN=2"])
        self.assertEqual(len(args.open_channel), 2)
        self.assertEqual(args.wait_minutes, 5)

    def test_token_and_regenerate_together_are_refused(self):
        self.assertIn("give a token file, or --regenerate", self.parse_error(["t.json", "--regenerate"]))

    def test_neither_is_refused(self):
        self.assertIn("give a token file, or --regenerate", self.parse_error(["--apply"]))

    def test_unknown_option_is_refused(self):
        self.assertIn("unrecognized arguments", self.parse_error(["t.json", "--force"]))


# ------------------------------------------------------------------------------- a dry run with a fake docker
FAKE_DOCKER = textwrap.dedent('''\
    """A stand-in for `docker`: only `compose run ... hub node <generator> <args>` succeeds, as the hub image would."""
    import json, os, sys

    args = sys.argv[1:]
    with open(os.environ["FAKE_DOCKER_LOG"], "a", encoding="utf-8") as log:
        log.write(json.dumps({"argv": args, "cwd": os.getcwd()}) + "\\n")
    GENERATOR = "dist/interfaces/cli/fnn-whitelist/main.js"
    if args[:2] != ["compose", "run"] or "hub" not in args or args[args.index("hub") + 1:args.index("hub") + 3] != ["node", GENERATOR]:
        sys.stderr.write("fake docker: unexpected call\\n")
        sys.exit(1)
    if os.environ.get("FAKE_DOCKER_REFUSE"):
        sys.stderr.write("fnn-whitelist: FIBER_ASSETS is refused: FIBER_ASSETS.1.typeScript.codeHash: must be 0x and 32 bytes of hex\\n")
        sys.exit(1)
    head, generator = args[:args.index("hub")], args[args.index("hub") + 3:]
    mounts, env = {}, {}
    for flag, value in zip(head, head[1:]):
        if flag == "-v":
            host, container = value.split(":")[:2]
            mounts[container] = host
        elif flag == "-e":
            key, _, val = value.partition("=")
            env[key] = val
    def host_path(container_path):
        folder, name = container_path.rsplit("/", 1)
        return os.path.join(mounts[folder], name)
    options = dict(zip(generator, generator[1:]))
    assets = json.loads(env["FIBER_ASSETS"])
    assert "--check-config" in generator and "--from-env" in generator
    print("hub configuration ok: assets CKB, " + ", ".join(a["id"] for a in assets) + "; peer channels: none")
    for flag in ("--hub-yml", "--demo-yml"):
        source = host_path(options[flag])
        with open(source, encoding="utf-8", newline="") as handle:
            text = handle.read()
        listed = "".join(f"    - name: {a['symbol']}\\n" for a in assets)
        text = text.replace("  udt_whitelist: []\\n", "  udt_whitelist:\\n" + listed)
        with open(os.path.join(mounts[options["--out-dir"]], os.path.basename(source)), "w", encoding="utf-8", newline="") as out:
            out.write(text)
        print(f"{options[flag]}: changed, written to {options['--out-dir']}")
    ''')

KIT_COMPOSE = "services:\n  hub:\n    image: ckbolt/hub:local\n    env_file: [hub.env]\n"
KIT_FNN = "ckb:\n  rpc_url: \"https://testnet.ckbapp.dev/\"\n  udt_whitelist: []\n\nservices:\n  - ckb\n"


@unittest.skipIf(os.name == "nt", "the fake docker is a POSIX executable script")
class DryRunTest(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp(prefix="add-token-test-")
        self.kit = os.path.join(self.root, "kit")
        self.bin = os.path.join(self.root, "bin")
        self.log = os.path.join(self.root, "docker.log")
        os.makedirs(os.path.join(self.kit, "fnn"))
        os.makedirs(self.bin)
        docker = os.path.join(self.bin, "docker")
        with open(docker, "w", encoding="utf-8") as handle:
            handle.write(f"#!{sys.executable}\n" + FAKE_DOCKER)
        os.chmod(docker, os.stat(docker).st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
        self.hub_env = ("# hub.env of the test kit\n"
                        f"HUB_PROXY_SECRET={SECRET}\n"
                        "CKB_NETWORK=testnet\n"
                        f"FIBER_ASSETS={at.env_json_literal(at.compact_json([asset('RUSD', SCRIPT_RUSD)]))}\n"
                        "QUOTE_SIGNING_KEY=" + "ab" * 32 + "\n")
        self.write("docker-compose.yml", KIT_COMPOSE)
        self.write("hub.env", self.hub_env)
        self.write(os.path.join("fnn", "hub.yml"), KIT_FNN)
        self.write(os.path.join("fnn", "demo.yml"), KIT_FNN.replace("ckb:\n", "# demo\nckb:\n"))
        self.token = os.path.join(self.root, "tkn.json")
        with open(self.token, "w", encoding="utf-8") as handle:
            json.dump(asset("TKN", SCRIPT_TKN, peerChannels={"minAmount": "10000000"}), handle)
        self.saved_env = {key: os.environ.get(key) for key in ("PATH", "FAKE_DOCKER_LOG", "FAKE_DOCKER_REFUSE")}
        os.environ["PATH"] = self.bin + os.pathsep + os.environ.get("PATH", "")
        os.environ["FAKE_DOCKER_LOG"] = self.log
        os.environ.pop("FAKE_DOCKER_REFUSE", None)

    def tearDown(self):
        for key, value in self.saved_env.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
        shutil.rmtree(self.root, ignore_errors=True)

    def write(self, relative: str, text: str) -> None:
        with open(os.path.join(self.kit, relative), "w", encoding="utf-8", newline="") as handle:
            handle.write(text)

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

    def docker_calls(self) -> list:
        if not os.path.exists(self.log):
            return []
        with open(self.log, encoding="utf-8") as handle:
            return [json.loads(line) for line in handle if line.strip()]

    def test_dry_run_changes_nothing_says_what_it_would_do_and_never_prints_the_secret(self):
        before = self.snapshot()
        code, out, err = self.run_main([self.token, "--kit-dir", self.kit])

        self.assertEqual(code, 0, err)
        self.assertEqual(self.snapshot(), before)
        self.assertFalse(os.path.exists(os.path.join(self.kit, "backups")))
        self.assertNotIn(SECRET, out + err)
        self.assertIn("FIBER_ASSETS: RUSD  ->  RUSD, TKN", out)
        self.assertIn("hub configuration ok: assets CKB, RUSD, TKN", out)
        self.assertIn("Dry run: nothing was changed", out)
        self.assertIn("write FIBER_ASSETS in hub.env", out)
        self.assertIn("write fnn/hub.yml and restart fnn-hub", out)
        self.assertIn("write fnn/demo.yml and restart fnn-demo", out)

    def test_dry_run_asks_the_hub_image_once_with_the_merged_list_and_cleans_up(self):
        self.run_main([self.token, "--kit-dir", self.kit, "--demo-auto-accept", "TKN=5"])
        calls = self.docker_calls()
        self.assertEqual(len(calls), 1)
        argv = calls[0]["argv"]
        self.assertEqual(os.path.realpath(calls[0]["cwd"]), os.path.realpath(self.kit))
        assets = json.loads(argv[argv.index("-e") + 1].partition("=")[2])
        self.assertEqual([a["id"] for a in assets], ["RUSD", "TKN"])
        mounts = [argv[i + 1] for i, part in enumerate(argv) if part == "-v"]
        self.assertEqual(mounts[0], os.path.join(os.path.abspath(self.kit), "fnn") + ":/kit-fnn:ro")
        out_dir = mounts[1].rsplit(":", 1)[0]
        self.assertFalse(os.path.exists(out_dir), "the temporary out folder is removed")
        self.assertEqual(argv[-2:], ["--demo-auto-accept", "TKN=5"])
        self.assertNotIn(SECRET, json.dumps(calls))

    def test_regenerate_dry_run_leaves_hub_env_out(self):
        before = self.snapshot()
        code, out, err = self.run_main(["--regenerate", "--kit-dir", self.kit])
        self.assertEqual(code, 0, err)
        self.assertEqual(self.snapshot(), before)
        self.assertIn("FIBER_ASSETS: RUSD  ->  RUSD", out)
        self.assertNotIn("write FIBER_ASSETS in hub.env", out)
        self.assertNotIn(SECRET, out + err)

    def test_a_refusal_of_the_hub_image_changes_nothing(self):
        os.environ["FAKE_DOCKER_REFUSE"] = "1"
        before = self.snapshot()
        code, out, err = self.run_main([self.token, "--kit-dir", self.kit])
        self.assertEqual(code, 1)
        self.assertEqual(self.snapshot(), before)
        self.assertIn("the hub image refused the new configuration (nothing was changed)", err)
        self.assertIn("FIBER_ASSETS.1.typeScript.codeHash", err)
        self.assertNotIn(SECRET, out + err)

    def test_an_id_already_listed_is_refused_before_docker_runs(self):
        with open(self.token, "w", encoding="utf-8") as handle:
            json.dump(asset("RUSD", SCRIPT_RUSD), handle)
        code, out, err = self.run_main([self.token, "--kit-dir", self.kit])
        self.assertEqual(code, 1)
        self.assertIn("already lists RUSD: pass --replace", err)
        self.assertEqual(self.docker_calls(), [])

    def test_a_hub_env_without_fiber_assets_is_refused(self):
        self.write("hub.env", f"HUB_PROXY_SECRET={SECRET}\n")
        code, out, err = self.run_main([self.token, "--kit-dir", self.kit])
        self.assertEqual(code, 1)
        self.assertIn("hub.env has no FIBER_ASSETS", err)
        self.assertNotIn(SECRET, out + err)
        self.assertEqual(self.docker_calls(), [])

    def test_a_kit_without_its_files_is_refused(self):
        os.remove(os.path.join(self.kit, "fnn", "demo.yml"))
        code, _, err = self.run_main([self.token, "--kit-dir", self.kit])
        self.assertEqual(code, 1)
        self.assertIn("demo.yml is missing", err)

    def test_open_channel_without_a_token_is_refused(self):
        code, _, err = self.run_main(["--regenerate", "--kit-dir", self.kit, "--open-channel", f"{NODE_ID}=5"])
        self.assertEqual(code, 1)
        self.assertIn("--open-channel needs a token file", err)


if __name__ == "__main__":
    unittest.main()
