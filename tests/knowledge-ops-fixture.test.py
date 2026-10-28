import importlib.util
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location('opsfixture', Path(__file__).resolve().parents[1] / 'scripts' / 'knowledge-ops-fixture.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class FixtureGuardTests(unittest.TestCase):
    def test_exact_commands_only(self):
        self.assertTrue(module.allowed_command('git rev-parse HEAD'))
        self.assertTrue(module.allowed_command("cd -- '" + module.CHECKOUT + "' && git checkout 'main'"))
        for command in ['pm2 restart all', 'git reset --hard HEAD', 'echo ok; rm -rf /tmp', 'git rev-parse HEAD; id', 'cd /home/ftd/MCP && git pull']:
            self.assertFalse(module.allowed_command(command), command)
    def test_fixture_control_is_bounded(self):
        self.assertTrue(module.allowed_command('relay-fixture verify'))
        self.assertTrue(module.allowed_command('relay-fixture fail'))
        self.assertFalse(module.allowed_command('relay-fixture verify; id'))
        self.assertFalse(module.allowed_command('relay-fixture destroy'))
    def test_rollback_only_pinned_fixture_commit(self):
        commit = 'a' * 40
        command = "cd -- '" + module.CHECKOUT + "' && git reset --hard '" + commit + "'"
        self.assertFalse(module.allowed_command(command))
        self.assertTrue(module.allowed_command(command, [commit]))
        self.assertFalse(module.allowed_command(command, ['b' * 40]))

if __name__ == '__main__': unittest.main()
