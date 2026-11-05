"""deploy/auto-update.sh: a new commit reaches the server only after its tests pass, and never over local changes."""
from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

from tests.helpers import TraderTestCase

DEPLOY = Path(__file__).resolve().parent.parent / "deploy"


class AutoUpdate(TraderTestCase):
    def text(self, name):
        return (DEPLOY / name).read_text(encoding="utf-8")

    def test_tests_pass_before_anything_is_installed(self):
        sh = self.text("auto-update.sh")
        tests, merge, install = (sh.index("python3 -m unittest discover"), sh.index("merge -q --ff-only"),
                                 sh.rindex('bash "$REPO/trader-skill/deploy/install-vps.sh"'))
        self.assertLess(tests, merge)
        self.assertLess(merge, install)
        self.assertIn('echo "$NEW" > "$STATE/failed"', sh)  # a failing commit is not retried every 15 minutes
        self.assertIn('echo "$NEW" > "$STATE/installed"', sh)

    def test_it_never_overwrites_or_rewrites(self):
        sh = self.text("auto-update.sh")
        self.assertIn("status --porcelain --untracked-files=no", sh)  # local changes: left alone
        self.assertIn("merge-base --is-ancestor", sh)  # a rewritten branch: left alone
        self.assertNotIn("reset --hard", sh)
        self.assertIn("GIT_TERMINAL_PROMPT=0", sh)  # a timer has nobody to type a password
        self.assertIn("flock -n 9", sh)

    def test_tests_run_as_the_bot_user_on_a_copy_without_the_keys(self):
        sh = self.text("auto-update.sh")
        self.assertIn('git -C "$REPO" archive "$NEW" trader-skill', sh)
        self.assertIn("runuser -u trader -- env -i", sh)
        self.assertNotIn("trader.env", sh)

    def test_traderctl_and_the_scripts(self):
        ctl = self.text("traderctl")
        self.assertIn("systemctl start trader-update.service || true", ctl)
        self.assertIn("update-log) exec tail -n 40 /var/log/trader-update.log", ctl)
        bash = shutil.which("bash")
        if not bash:
            self.skipTest("bash not available")
        r = subprocess.run([bash, "-n", str(DEPLOY / "auto-update.sh")], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.assertEqual(r.returncode, 0, r.stderr)
