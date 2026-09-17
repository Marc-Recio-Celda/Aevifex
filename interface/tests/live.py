"""Run from the repository root: python3 interface/tests/live.py."""
import copy
import importlib.util
import json
from pathlib import Path
import tempfile
import threading
import unittest
from urllib.request import urlopen
from http.server import HTTPServer

spec = importlib.util.spec_from_file_location('office_server', Path(__file__).resolve().parents[1] / 'server.py')
server = importlib.util.module_from_spec(spec)
spec.loader.exec_module(server)


class LiveUpdates(unittest.TestCase):
    def test_bounded_deltas_and_reset(self):
        store = server.Revisions(keep=2)
        original = {'entities': [{'id': f'e{i}', 'kind': 'doc', 'body': 'source ' * 500} for i in range(200)], 'problems': []}
        store.publish(original, 'a')
        full = store.response()
        updated = copy.deepcopy(original)
        updated['entities'][80]['body'] = 'Changed one document'
        store.publish(updated, 'b')
        delta = store.response(full['revision'])
        self.assert_delta(delta)
        self.assertLess(len(json.dumps(delta)), len(json.dumps(full)) / 100)
        # The original full-refresh behavior fails the exact same check by assertion.
        with self.assertRaises(AssertionError):
            self.assert_delta(store.response())
        updated = {'entities': [updated['entities'][80], {'id': 'new', 'kind': 'doc'}], 'problems': [{'why': 'declared'}]}
        store.publish(updated, 'c')
        result = store.response(delta['revision'])
        self.assertEqual(result['order'], ['e80', 'new'])
        self.assertEqual(len(result['remove']), 199)
        self.assertEqual(result['upsert'], [{'id': 'new', 'kind': 'doc'}])
        self.assertEqual(result['metadata']['problems'], [{'why': 'declared'}])
        self.assertEqual(store.response(full['revision'])['mode'], 'snapshot', 'Eviction/restart can always recover')
        self.assertEqual(store.response(store.current)['upsert'], [])
        self.assertNotIn('order', store.response(store.current))
        self.assertEqual(len(store.snapshots), 2)

    def assert_delta(self, response):
        self.assertEqual(response['mode'], 'delta')
        self.assertNotIn('entities', response)
        self.assertEqual([e['id'] for e in response['upsert']], ['e80'])
        self.assertEqual(response['remove'], [])
        self.assertNotIn('order', response)

    def test_record_ids_are_scoped_by_uid(self):
        store = server.Revisions()
        store.publish({'entities': [{'id': 'D1', 'uid': 'decision-one-d1', 'body': 'One'}, {'id': 'D1', 'uid': 'decision-two-d1', 'body': 'Two'}]}, 'a')
        before = store.current
        store.publish({'entities': [{'id': 'D1', 'uid': 'decision-one-d1', 'body': 'Changed'}, {'id': 'D1', 'uid': 'decision-two-d1', 'body': 'Two'}]}, 'b')
        delta = store.response(before)
        self.assertEqual(len(delta['upsert']), 1)
        self.assertEqual(delta['upsert'][0]['uid'], 'decision-one-d1')
        self.assertEqual(delta['remove'], [])

    def test_duplicate_identity_does_not_publish(self):
        store = server.Revisions()
        with self.assertRaises(ValueError):
            store.publish({'entities': [{'id': 'same'}, {'id': 'same'}]}, 'a')
        self.assertIsNone(store.current)

    def test_http_source_edit_delete_and_restart(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            wall = root / 'wall.md'
            first = '# Wall\n## The wall\n### ▶ `sample` · First task\nReading the first source.\n'
            second = '### ▶ `sample` · Second task\nReading the second source.\n'
            wall.write_text(first + second)
            adapter = root / 'adapter.json'
            adapter.write_text(json.dumps({'root': '.', 'browse': ['.'], 'sources': [{'kind': 'compass', 'label': 'Wall', 'path': 'wall.md'}]}))
            httpd = HTTPServer(('127.0.0.1', 0), server.make_handler(server.load_adapter(adapter)))
            thread = threading.Thread(target=httpd.serve_forever, daemon=True); thread.start()
            try:
                base = f'http://127.0.0.1:{httpd.server_port}'
                read = lambda path: json.load(urlopen(base + path))
                initial = read('/api/model')
                self.assertEqual(len(initial['entities']), 2)
                wall.write_text(first.replace('first source', 'updated source') + second)
                delta = read('/api/model?since=' + initial['revision'])
                self.assertEqual(delta['mode'], 'delta')
                self.assertEqual(len(delta['upsert']), 1)
                self.assertIn('updated source', delta['upsert'][0]['description'])
                self.assertNotEqual(initial['stamp'], delta['stamp'])
                wall.write_text(first)
                removed = read('/api/model?since=' + delta['revision'])
                self.assertEqual(len(removed['remove']), 1)
                self.assertEqual(read('/api/model?since=prior-server-revision')['mode'], 'snapshot')
                (root / 'note.md').write_text('# A source outside the model\n')
                note_only = read('/api/model?since=' + removed['revision'])
                self.assertEqual(note_only['upsert'], [])
                self.assertNotEqual(note_only['stamp'], removed['stamp'], 'Lazy readers also observe changes')
            finally:
                httpd.shutdown(); thread.join(); httpd.server_close()


if __name__ == '__main__':
    unittest.main()
