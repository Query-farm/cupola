import unittest
import json
import tempfile
from pathlib import Path
from datetime import datetime, timezone
from unittest.mock import patch
import releases

class ReleaseTests(unittest.TestCase):
    def test_retention_protects_current_recent_and_two_rollback_releases(self):
        items = []
        for version, date in [('1.0.0', '2020-01-01'), ('1.0.1', '2020-01-02'), ('1.0.2', '2020-01-03'), ('1.0.3', '2020-01-04'), ('1.0.4', '2026-10-01')]:
            items.append({'Key': f'v{version}/index.html', 'LastModified': date + 'T00:00:00Z'})
        items.extend([{'Key': '_latest', 'LastModified': '2020-01-01T00:00:00Z'},
                      {'Key': 'other/keep', 'LastModified': '2020-01-01T00:00:00Z'}])
        plan = releases.cleanup_plan(items, '1.0.0', datetime(2026, 10, 5, tzinfo=timezone.utc))
        self.assertEqual(set(plan), {'1.0.1', '1.0.2'})
    def test_activation_lease_protects_old_rollback(self):
        items = [{'Key': 'v1.0.0/index.html', 'LastModified': '2020-01-01T00:00:00Z'},
                 {'Key': 'v1.0.0/_retained.json', 'LastModified': '2026-10-04T00:00:00Z'}]
        self.assertEqual(releases.cleanup_plan(items, '2.0.0', datetime(2026, 10, 5, tzinfo=timezone.utc)), {})
    def test_aws_failure_does_not_look_like_empty_bucket(self):
        with patch('subprocess.run') as run:
            run.return_value.returncode = 1
            run.return_value.stderr = 'access denied'
            with self.assertRaisesRegex(RuntimeError, 'access denied'):
                releases.objects()

class PromotionTests(unittest.TestCase):
    def test_competing_promotion_is_rejected_without_writing(self):
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory) / 'state.json'
            state.write_text(json.dumps({'version': '2.0.0', 'etag': 'previous'}))
            with patch('sys.argv', ['releases.py', 'promote', '2.0.0']), patch.object(releases, 'Path', return_value=state), patch.object(releases, 'read', return_value=('1.5.0', 'changed')), patch.object(releases, 'put') as put:
                with self.assertRaisesRegex(RuntimeError, 'changed during publishing'):
                    releases.main()
                put.assert_not_called()

    def test_worker_independent_rollback_checks_target_before_pointer_write(self):
        with patch('sys.argv', ['releases.py', 'rollback', '1.0.0']), patch.object(releases, 'read', return_value=('2.0.0', 'etag')), patch.object(releases, 'aws', side_effect=RuntimeError('missing target')), patch.object(releases, 'put') as put:
            with self.assertRaisesRegex(RuntimeError, 'missing target'):
                releases.main()
            put.assert_not_called()

    def test_existing_release_is_never_overwritten(self):
        with patch('sys.argv', ['releases.py', 'prepare', '1.0.0']), patch.object(releases, 'read', return_value=('2.0.0', 'etag')), patch.object(releases, 'objects', return_value=[{'Key': 'v1.0.0/index.html'}]), patch.object(releases, 'put') as put:
            with self.assertRaisesRegex(RuntimeError, 'Refusing to overwrite'):
                releases.main()
            put.assert_not_called()

if __name__ == '__main__':
    unittest.main()
