"""Tests of deploy/testnet/add_token.py, security review D6: the drop guard's YAML reader (failing closed), the generator's
owner-only out folder and the `--user` it runs as, and the atomic writes that keep a file's mode.

Run from the repo root (Python 3, stdlib only):  python3 -m unittest discover -s deploy/test/python -v
"""
from __future__ import annotations

import os
import shutil
import stat
import subprocess
import sys
import tempfile
import textwrap
import unittest
from unittest import mock

# deploy/testnet is uploaded to the server as is: importing the script must not leave a __pycache__ folder there.
sys.dont_write_bytecode = True
KIT_SOURCE_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "testnet"))
sys.path.insert(0, KIT_SOURCE_DIR)
import add_token as at  # noqa: E402

RUSD_CODE_HASH = "0x1142755a044bf2ee358cba9f2da187ce928c91cd4dc8692ded0337efa677d21a"
RUSD_ARGS = "0x878fcc6f1f08d48e87bb1c3b3d5083f23f8a39c5d5c764f253b55b998526439b"
CWBTC_CODE_HASH = "0x25c29dc317811a6f6f3985a7a9ebc4838bd388d19d0feeecf0bcd60f6c0975bb"
CWBTC_ARGS = "0x9a1086531ed6dc69e0bd44cef5278e03faf3015b31aff60b08fb87663ce8507100000000"
POSIX = os.name == "posix"


def fnn_config(whitelist: str, before: str = "", after: str = "\nservices:\n  - fiber\n  - rpc\n  - ckb\n") -> str:
    """An fnn config whose top-level ckb block holds `whitelist` (the udt_whitelist lines, indented by two)."""
    return before + 'ckb:\n  rpc_url: "https://testnet.ckbapp.dev/"\n' + whitelist + after


RUSD_ENTRY = textwrap.dedent(f"""\
      - name: RUSD
        script:
          code_hash: {RUSD_CODE_HASH}
          hash_type: type
          args: "^{RUSD_ARGS}$"
        cell_deps:
          - type_id:
              code_hash: 0x00000000000000000000000000000000000000000000000000545950455f4944
              hash_type: type
              args: 0x97d30b723c0b2c66e9cb8d4d0df4ab5d7222cbb00d4a9a2055ce2e5d7f0d8b0f
    """)
CWBTC_ENTRY = textwrap.dedent(f"""\
      - name: cWBTC
        script:
          code_hash: {CWBTC_CODE_HASH}
          hash_type: type
          args: "^{CWBTC_ARGS}$"
        cell_deps:
          - cell_dep:
              out_point:
                tx_hash: 0xbf6fb538763efec2a70a6a3dcb7242787087e1030c4e7d86585bc63a9d337f5f # cWBTC code
                index: 0x0
              dep_type: code
    """)


def whitelist(*entries: str) -> str:
    return "  udt_whitelist:\n" + "".join(textwrap.indent(entry, "  ") for entry in entries)


# ------------------------------------------------------------------------------------------- the YAML reader
class ParseYamlBlockTest(unittest.TestCase):
    def test_mappings_sequences_and_scalars_as_dicts_lists_and_strings(self):
        text = textwrap.dedent("""\
            a: 1
            b:
              c: two
              d:
                - x
                - y: z
                  w: v
            e: "quoted # not a comment"
            f: 'single ''quoted'''
            """)
        self.assertEqual(at.parse_yaml_block(text), {
            "a": "1",
            "b": {"c": "two", "d": ["x", {"y": "z", "w": "v"}]},
            "e": "quoted # not a comment",
            "f": "single 'quoted'",
        })

    def test_comments_whole_line_and_after_a_value_are_dropped(self):
        text = "# head\na: 1 # one\n  # indented comment\nb: x#y\n"
        self.assertEqual(at.parse_yaml_block(text), {"a": "1", "b": "x#y"})

    def test_a_sequence_may_share_its_key_s_indentation(self):
        self.assertEqual(at.parse_yaml_block("list:\n- a\n- b\nnext: 1\n"), {"list": ["a", "b"], "next": "1"})

    def test_empty_flow_collections_and_a_key_with_nothing_under_it(self):
        self.assertEqual(at.parse_yaml_block("a: []\nb: {}\nc:\n"), {"a": [], "b": {}, "c": None})

    def test_an_empty_or_comment_only_text_is_none(self):
        self.assertIsNone(at.parse_yaml_block(""))
        self.assertIsNone(at.parse_yaml_block("# nothing\n\n"))

    def test_crlf_line_ends_read_like_lf(self):
        self.assertEqual(at.parse_yaml_block("a: 1\r\nb:\r\n  - c\r\n"), {"a": "1", "b": ["c"]})

    def test_quoted_keys(self):
        self.assertEqual(at.parse_yaml_block('"a key": 1\n\'b\': 2\n'), {"a key": "1", "b": "2"})

    def test_reads_the_kit_s_own_fnn_configs(self):
        for name in (at.HUB_YML, at.DEMO_YML):
            with open(os.path.join(KIT_SOURCE_DIR, at.FNN_DIR, name), encoding="utf-8") as handle:
                document = at.parse_yaml_block(handle.read())
            self.assertIsInstance(document, dict, name)
            self.assertIn("ckb", document, name)
            self.assertIsInstance(document["ckb"]["udt_whitelist"], list, name)


class YamlFailsClosedTest(unittest.TestCase):
    """Anything outside the block-style subset raises YamlSubsetError: the reader never guesses."""

    def assertRefused(self, text: str, pattern: str) -> None:
        with self.assertRaisesRegex(at.YamlSubsetError, pattern):
            at.parse_yaml_block(text)

    def test_flow_collections(self):
        self.assertRefused("a: [x, y]\n", "flow collections")
        self.assertRefused("a: {b: 1}\n", "flow collections")
        self.assertRefused("- [x]\n", "flow collections")

    def test_block_scalars_anchors_aliases_and_tags(self):
        for value in ("|", ">-", "&anchor x", "*anchor", "!!str 1", "%x", "@x", "`x`"):
            self.assertRefused(f"a: {value}\n", "flow collections, block scalars, anchors and tags", )

    def test_a_tab_in_the_indentation(self):
        self.assertRefused("a:\n\tb: 1\n", "a tab in the indentation")

    def test_a_key_given_twice(self):
        self.assertRefused("a: 1\na: 2\n", "a appears twice")
        self.assertRefused("ckb:\n  udt_whitelist: []\n  udt_whitelist: []\n", "udt_whitelist appears twice")

    def test_unexpected_indentation(self):
        self.assertRefused("a: 1\n    b: 2\n", "unexpected indentation")
        self.assertRefused("a:\n    b: 1\n  c: 2\n", "unexpected indentation")

    def test_a_line_that_is_not_key_value_inside_a_mapping(self):
        self.assertRefused("a: 1\njust text\n", "expected `key: value`|unexpected indentation")

    def test_unreadable_quoted_scalars(self):
        self.assertRefused("a: 'open\n", "unterminated single-quoted")
        self.assertRefused('a: "bad \\q escape"\n', "unreadable double-quoted")


class WhitelistedScriptsTest(unittest.TestCase):
    def test_reads_each_entry_s_script_lower_cased_with_or_without_anchors(self):
        upper = CWBTC_ENTRY.replace(CWBTC_CODE_HASH, CWBTC_CODE_HASH.upper().replace("0X", "0x")).replace(f'"^{CWBTC_ARGS}$"', CWBTC_ARGS.upper().replace("0X", "0x"))
        found = at.whitelisted_scripts(fnn_config(whitelist(RUSD_ENTRY, upper)))
        self.assertEqual(found, {(RUSD_CODE_HASH, RUSD_ARGS): "RUSD", (CWBTC_CODE_HASH, CWBTC_ARGS): "cWBTC"})

    def test_reads_the_kit_s_hub_yml(self):
        with open(os.path.join(KIT_SOURCE_DIR, at.FNN_DIR, at.HUB_YML), encoding="utf-8") as handle:
            found = at.whitelisted_scripts(handle.read())
        self.assertEqual(found.get((RUSD_CODE_HASH, RUSD_ARGS)), "RUSD")
        self.assertEqual(found.get((CWBTC_CODE_HASH, CWBTC_ARGS)), "cWBTC")

    def test_nothing_for_no_file_an_empty_list_or_no_ckb_block(self):
        self.assertEqual(at.whitelisted_scripts(None), {})
        self.assertEqual(at.whitelisted_scripts(fnn_config("  udt_whitelist: []\n")), {})
        self.assertEqual(at.whitelisted_scripts("fiber:\n  chain: testnet\n"), {})

    def test_reads_only_the_top_level_ckb_block(self):
        elsewhere = "other:\n" + textwrap.indent(whitelist(RUSD_ENTRY), "  ")
        self.assertEqual(at.whitelisted_scripts(elsewhere + fnn_config("  udt_whitelist: []\n")), {})

    def test_yaml_the_reader_refuses_outside_the_ckb_block_does_not_trip_it(self):
        before = "fiber:\n  bootnode_addrs: [\"/ip4/1.2.3.4/tcp/8228\"]\n  anchor: &a 1\nrpc:\n  enabled_modules: |\n    channel\n"
        found = at.whitelisted_scripts(fnn_config(whitelist(RUSD_ENTRY), before=before))
        self.assertEqual(found, {(RUSD_CODE_HASH, RUSD_ARGS): "RUSD"})

    def test_skips_an_entry_without_a_readable_script(self):
        broken = "    - name: NoScript\n      cell_deps: []\n    - name: HalfScript\n      script:\n        code_hash: 0x01\n"
        self.assertEqual(at.whitelisted_scripts(fnn_config("  udt_whitelist:\n" + broken)), {})

    def test_raises_for_a_ckb_block_outside_the_subset(self):
        with self.assertRaises(at.YamlSubsetError):
            at.whitelisted_scripts(fnn_config('  udt_whitelist: [{name: RUSD, script: {code_hash: "0x11"}}]\n'))
        with self.assertRaises(at.YamlSubsetError):
            at.whitelisted_scripts(fnn_config(whitelist(RUSD_ENTRY).replace("script:\n", "script: &rusd\n", 1)))


class DroppedTokensFailsClosedTest(unittest.TestCase):
    OLD = fnn_config(whitelist(RUSD_ENTRY, CWBTC_ENTRY))

    def test_nothing_dropped_when_the_new_whitelist_keeps_every_token(self):
        self.assertEqual(at.dropped_tokens({at.HUB_YML: (self.OLD, self.OLD)}), [])

    def test_names_a_token_the_new_whitelist_leaves_out(self):
        new = fnn_config(whitelist(RUSD_ENTRY))
        self.assertEqual(at.dropped_tokens({at.HUB_YML: (self.OLD, new)}), [f"{at.FNN_DIR}/{at.HUB_YML}: cWBTC"])

    def test_a_running_whitelist_it_cannot_read_counts_as_a_drop(self):
        unreadable = fnn_config('  udt_whitelist: [{name: RUSD}]\n')
        dropped = at.dropped_tokens({at.HUB_YML: (unreadable, self.OLD)})
        self.assertEqual(len(dropped), 1)
        self.assertRegex(dropped[0], rf"^{at.FNN_DIR}/{at.HUB_YML}: its udt_whitelist cannot be read \(.+\)$")

    def test_a_new_whitelist_it_cannot_read_counts_as_a_drop_too(self):
        unreadable = fnn_config("  udt_whitelist:\n\t- name: RUSD\n")
        dropped = at.dropped_tokens({at.DEMO_YML: (self.OLD, unreadable)})
        self.assertEqual(len(dropped), 1)
        self.assertIn("cannot be read", dropped[0])
        self.assertIn("a tab in the indentation", dropped[0])

    def test_each_file_is_judged_on_its_own(self):
        unreadable = fnn_config("  udt_whitelist: [x]\n")
        dropped = at.dropped_tokens({at.HUB_YML: (self.OLD, self.OLD), at.DEMO_YML: (unreadable, self.OLD)})
        self.assertEqual(len(dropped), 1)
        self.assertTrue(dropped[0].startswith(f"{at.FNN_DIR}/{at.DEMO_YML}: "))

    def test_a_file_the_server_does_not_have_yet_drops_nothing(self):
        self.assertEqual(at.dropped_tokens({at.HUB_YML: (None, self.OLD)}), [])


# ---------------------------------------------------------------------------------- the generator's out folder
def completed(command: list, code: int = 0, stderr: str = "") -> subprocess.CompletedProcess:
    return subprocess.CompletedProcess(command, code, stdout="generated\n", stderr=stderr)


class ComposeRunUserTest(unittest.TestCase):
    def test_user_goes_to_compose_run_before_the_service_not_to_the_generator(self):
        command = at.compose_run_command("[]", "/k/fnn", "/o", None, "1001:1002")
        self.assertEqual(command[:7], ["docker", "compose", "run", "--rm", "--no-deps", "-T", "--user"])
        self.assertEqual(command[command.index("--user") + 1], "1001:1002")
        self.assertLess(command.index("--user"), command.index(at.SERVICE_HUB))
        self.assertEqual(command[command.index(at.SERVICE_HUB) + 1:], at.generator_command(None))
        self.assertEqual(command.count("--user"), 1)

    def test_no_user_flag_without_a_user(self):
        self.assertNotIn("--user", at.compose_run_command("[]", "/k/fnn", "/o", None))
        self.assertNotIn("--user", at.compose_run_command("[]", "/k/fnn", "/o", None, None))
        self.assertNotIn("--user", at.compose_run_command("[]", "/k/fnn", "/o", None, ""))

    @unittest.skipUnless(POSIX, "uid and gid are POSIX")
    def test_current_user_is_this_process_s_uid_and_gid(self):
        self.assertEqual(at.current_user(), f"{os.getuid()}:{os.getgid()}")

    def test_current_user_is_none_where_the_os_has_no_ids(self):
        saved = {name: getattr(at.os, name) for name in ("getuid", "getgid") if hasattr(at.os, name)}
        try:
            for name in saved:
                delattr(at.os, name)
            self.assertIsNone(at.current_user())
        finally:
            for name, value in saved.items():
                setattr(at.os, name, value)


class RenderWhitelistsOutFolderTest(unittest.TestCase):
    """render_whitelists with `docker compose run` replaced: what the container would find, and what it is run with."""

    def setUp(self):
        self.root = tempfile.mkdtemp(prefix="add-token-safety-")
        self.kit = at.Kit(self.root)
        os.makedirs(self.kit.fnn_dir)
        for name in (at.HUB_YML, at.DEMO_YML):
            with open(os.path.join(self.kit.fnn_dir, name), "w", encoding="utf-8") as handle:
                handle.write(fnn_config(whitelist(RUSD_ENTRY)))
        self.seen = []

    def tearDown(self):
        shutil.rmtree(self.root, ignore_errors=True)

    def fake_run(self, code: int = 0):
        def run(command, **kwargs):
            out_dir = next(value.split(":")[0] for flag, value in zip(command, command[1:]) if flag == "-v" and value.endswith(":" + at.CONTAINER_OUT_DIR))
            info = os.stat(out_dir)
            self.seen.append({"command": command, "out_dir": out_dir, "mode": stat.S_IMODE(info.st_mode), "uid": info.st_uid, "cwd": kwargs.get("cwd")})
            if code == 0:
                for name in (at.HUB_YML, at.DEMO_YML):
                    with open(os.path.join(out_dir, name), "w", encoding="utf-8") as handle:
                        handle.write(fnn_config(whitelist(RUSD_ENTRY, CWBTC_ENTRY)))
            return completed(command, code, "" if code == 0 else "fnn-whitelist: FIBER_ASSETS is refused")
        return run

    def render(self, code: int = 0) -> dict:
        with mock.patch.object(at.subprocess, "run", side_effect=self.fake_run(code)), mock.patch.object(at, "say"):
            return at.render_whitelists(self.kit, "[]", None)

    @unittest.skipUnless(POSIX, "POSIX modes and ids")
    def test_the_out_folder_is_owner_only_and_this_user_s(self):
        self.render()
        self.assertEqual(len(self.seen), 1)
        self.assertEqual(self.seen[0]["mode"], 0o700)
        self.assertEqual(self.seen[0]["uid"], os.getuid())

    @unittest.skipUnless(POSIX, "uid and gid are POSIX")
    def test_the_generator_runs_as_this_user_so_it_can_write_there(self):
        self.render()
        command = self.seen[0]["command"]
        self.assertEqual(command[command.index("--user") + 1], f"{os.getuid()}:{os.getgid()}")
        self.assertLess(command.index("--user"), command.index(at.SERVICE_HUB))
        self.assertEqual(self.seen[0]["cwd"], self.kit.dir)

    def test_never_opens_the_out_folder_to_everyone(self):
        with mock.patch.object(at.os, "chmod", wraps=os.chmod) as chmod:
            self.render()
        widened = [call for call in chmod.call_args_list if call.args and call.args[0] == self.seen[0]["out_dir"]]
        self.assertEqual(widened, [])
        self.assertNotIn("OUT_DIR_MODE", vars(at))

    def test_returns_old_and_new_files_and_removes_the_out_folder(self):
        files = self.render()
        self.assertEqual(sorted(files), [at.DEMO_YML, at.HUB_YML])
        old, new = files[at.HUB_YML]
        self.assertIn("RUSD", old)
        self.assertIn("cWBTC", new)
        self.assertFalse(os.path.exists(self.seen[0]["out_dir"]))

    def test_a_refusal_removes_the_out_folder_too(self):
        with self.assertRaisesRegex(at.Refused, "the hub image refused"):
            self.render(code=1)
        self.assertFalse(os.path.exists(self.seen[0]["out_dir"]))


# ------------------------------------------------------------------------------------------- atomic writes
class WriteKeepingModeTest(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp(prefix="add-token-write-")
        self.path = os.path.join(self.root, "hub.env")

    def tearDown(self):
        shutil.rmtree(self.root, ignore_errors=True)

    def existing(self, text: str, mode: int) -> None:
        with open(self.path, "w", encoding="utf-8", newline="") as handle:
            handle.write(text)
        os.chmod(self.path, mode)

    def read(self) -> str:
        with open(self.path, encoding="utf-8", newline="") as handle:
            return handle.read()

    def leftovers(self) -> list:
        return sorted(name for name in os.listdir(self.root) if name != "hub.env")

    @unittest.skipUnless(POSIX, "POSIX modes")
    def test_keeps_an_owner_only_mode(self):
        self.existing("HUB_PROXY_SECRET=s3cret\nFIBER_ASSETS=[]\n", 0o600)
        at.write_keeping_mode(self.path, "HUB_PROXY_SECRET=s3cret\nFIBER_ASSETS=[1]\n")
        self.assertEqual(stat.S_IMODE(os.stat(self.path).st_mode), 0o600)
        self.assertEqual(self.read(), "HUB_PROXY_SECRET=s3cret\nFIBER_ASSETS=[1]\n")

    @unittest.skipUnless(POSIX, "POSIX modes")
    def test_keeps_other_modes_too(self):
        for mode in (0o640, 0o644, 0o664):
            self.existing("a\n", mode)
            at.write_keeping_mode(self.path, "b\n")
            self.assertEqual(stat.S_IMODE(os.stat(self.path).st_mode), mode, oct(mode))

    @unittest.skipUnless(POSIX, "POSIX modes")
    def test_a_new_file_gets_the_mode_of_fnn_s_configs(self):
        at.write_keeping_mode(self.path, "new\n")
        self.assertEqual(stat.S_IMODE(os.stat(self.path).st_mode), at.NEW_FILE_MODE)
        self.assertEqual(at.NEW_FILE_MODE, 0o644)
        self.assertEqual(self.read(), "new\n")

    @unittest.skipUnless(POSIX, "POSIX ids")
    def test_keeps_the_owner_and_group(self):
        self.existing("a\n", 0o600)
        before = os.stat(self.path)
        at.write_keeping_mode(self.path, "b\n")
        after = os.stat(self.path)
        self.assertEqual((after.st_uid, after.st_gid), (before.st_uid, before.st_gid))

    @unittest.skipUnless(POSIX, "inodes")
    def test_replaces_the_file_by_rename_rather_than_writing_into_it(self):
        self.existing("old\n", 0o600)
        old_inode = os.stat(self.path).st_ino
        with open(self.path, encoding="utf-8") as reader:
            at.write_keeping_mode(self.path, "new\n")
            # A reader that had the old file open still sees the whole old file, never half of the new one.
            self.assertEqual(reader.read(), "old\n")
        self.assertNotEqual(os.stat(self.path).st_ino, old_inode)
        self.assertEqual(self.read(), "new\n")

    def test_writes_through_a_pending_file_beside_it_and_leaves_none(self):
        self.existing("a\n", 0o600)
        with mock.patch.object(at.os, "replace", wraps=os.replace) as replace:
            at.write_keeping_mode(self.path, "b\n")
        source, target = replace.call_args.args
        self.assertEqual(os.path.dirname(source), self.root)
        self.assertTrue(os.path.basename(source).endswith(at.PENDING_SUFFIX))
        self.assertEqual(target, self.path)
        self.assertEqual(self.leftovers(), [])

    def test_flushes_the_data_to_disk_before_the_rename(self):
        self.existing("a\n", 0o600)
        order = []
        real_replace = os.replace
        with mock.patch.object(at.os, "fsync", side_effect=lambda fd: order.append("fsync")), \
                mock.patch.object(at.os, "replace", side_effect=lambda a, b: (order.append("replace"), real_replace(a, b))):
            at.write_keeping_mode(self.path, "b\n")
        self.assertEqual(order[:2], ["fsync", "replace"])
        if hasattr(os, "O_DIRECTORY"):
            self.assertEqual(order, ["fsync", "replace", "fsync"], "and the folder after the rename")

    def test_a_failed_rename_leaves_the_old_file_whole_and_no_pending_file(self):
        self.existing("HUB_PROXY_SECRET=s3cret\n", 0o600)
        with mock.patch.object(at.os, "replace", side_effect=OSError(28, "No space left on device")):
            with self.assertRaises(OSError):
                at.write_keeping_mode(self.path, "half\n")
        self.assertEqual(self.read(), "HUB_PROXY_SECRET=s3cret\n")
        self.assertEqual(self.leftovers(), [])

    def test_a_failed_write_leaves_the_old_file_whole_and_no_pending_file(self):
        self.existing("old\n", 0o600)
        with mock.patch.object(at.os, "fsync", side_effect=OSError(5, "Input/output error")):
            with self.assertRaises(OSError):
                at.write_keeping_mode(self.path, "new\n")
        self.assertEqual(self.read(), "old\n")
        self.assertEqual(self.leftovers(), [])

    def test_keeps_line_ends_and_non_ascii_text_byte_for_byte(self):
        text = "A=1\r\nNAME='Bob\u2019s token'\r\n"
        at.write_keeping_mode(self.path, text)
        with open(self.path, "rb") as handle:
            self.assertEqual(handle.read(), text.encode("utf-8"))

    @unittest.skipUnless(POSIX, "POSIX ids")
    def test_gives_the_new_file_the_old_owner_when_it_differs(self):
        self.existing("a\n", 0o600)
        other = os.stat_result((0o100600, 0, 0, 1, os.getuid() + 1, os.getgid() + 1, 2, 0, 0, 0))
        with mock.patch.object(at.os, "chown") as chown:
            at._keep_owner(self.path, other)
        chown.assert_called_once_with(self.path, os.getuid() + 1, os.getgid() + 1)

    @unittest.skipUnless(POSIX, "POSIX ids")
    def test_refuses_when_it_may_not_keep_the_owner(self):
        self.existing("a\n", 0o600)
        other = os.stat_result((0o100600, 0, 0, 1, os.getuid() + 1, os.getgid(), 2, 0, 0, 0))
        with mock.patch.object(at.os, "chown", side_effect=PermissionError(1, "Operation not permitted")):
            with self.assertRaisesRegex(at.Refused, "cannot keep the owner of hub.env: run add_token.py as root or as its owner"):
                at._keep_owner(self.path, other)

    @unittest.skipUnless(POSIX, "POSIX ids")
    def test_a_refused_owner_leaves_the_old_file_and_no_pending_file(self):
        self.existing("old\n", 0o600)
        real_stat = os.stat

        def stat_as_someone_else(path, *args, **kwargs):
            result = real_stat(path, *args, **kwargs)
            if path == self.path:
                values = list(result)
                values[4] = os.getuid() + 1
                return os.stat_result(values)
            return result

        with mock.patch.object(at.os, "stat", side_effect=stat_as_someone_else), \
                mock.patch.object(at.os, "chown", side_effect=PermissionError(1, "Operation not permitted")):
            with self.assertRaises(at.Refused):
                at.write_keeping_mode(self.path, "new\n")
        self.assertEqual(self.read(), "old\n")
        self.assertEqual(self.leftovers(), [])


if __name__ == "__main__":
    unittest.main()
