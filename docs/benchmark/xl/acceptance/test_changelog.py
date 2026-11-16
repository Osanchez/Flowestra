import os
import re
import unittest

import helpers


class Changelogs(unittest.TestCase):
    def test_each_repository_has_a_2_0_0_entry(self):
        for repo in (helpers.CONTRACT_DIR, helpers.SERVICE_DIR, helpers.CLIENT_DIR):
            path = os.path.join(repo, "CHANGELOG.md")
            self.assertTrue(os.path.isfile(path), "%s missing" % path)
            with open(path, encoding="utf-8") as fh:
                text = fh.read()
            self.assertRegex(text, re.compile(r"^#+\s*\[?2\.0\.0", re.M), path)


if __name__ == "__main__":
    unittest.main()
