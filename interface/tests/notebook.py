"""Run from the repository root: python3 interface/tests/notebook.py."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('notebook_server', Path(__file__).resolve().parents[1] / 'server.py')
server = importlib.util.module_from_spec(spec)
spec.loader.exec_module(server)

class Notebook(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        for directory in ('capture/team/alpha', 'capture/team/beta', 'other'):
            (self.root/directory).mkdir(parents=True)
        (self.root/'capture/team/alpha/notes.md').write_text('# Alpha\n'+'needle\n'*250)
        (self.root/'capture/team/beta/notes.md').write_text('# Beta\nN-900 needle\nConfiguración propia\n')
        (self.root/'other/notes.md').write_text('PRIVATE needle')
        (self.root/'capture/leak.md').symlink_to(self.root/'other/notes.md')
        self.adapter_file = self.root/'adapter.json'
        self.config = {'root':'.', 'browse':['capture','other'], 'sources':[], 'notebook':{'root':'capture','guide':'README.md','groups':[{'path':'team/alpha','label':'Alpha'}]}}
        self.save()
    def save(self):
        self.adapter_file.write_text(json.dumps(self.config))
        self.adapter=server.load_adapter(self.adapter_file)
    def test_metadata_is_explicit_and_contained(self):
        self.config['references']={'links':{'office':[{'label':'Guide','href':'#/skill/open-session'}]}}
        self.save()
        catalog=server.tree(self.adapter)
        self.assertEqual(catalog['references'],self.config['references'])
        self.assertEqual(catalog['notebook']['root'],'capture')
        self.assertTrue(catalog['notebook']['available'])
        self.assertEqual(len([f for f in catalog['files'] if f['root']=='capture']),2)
        self.config['notebook']['root']='undeclared';self.save()
        self.assertFalse(server.tree(self.adapter)['notebook']['available'])
    def test_document_search_cannot_be_exhausted_by_one_long_sheet(self):
        hits=server.search(self.adapter,'needle',root='capture',documents=True)['hits']
        self.assertEqual([h['path'] for h in hits],['team/alpha/notes.md','team/beta/notes.md'])
        self.assertEqual(server.search(self.adapter,'N-900',root='capture',documents=True)['hits'][0]['line'],2)
        self.assertEqual(server.search(self.adapter,'PRIVATE',root='capture',documents=True)['hits'],[])
        self.assertEqual(server.search(self.adapter,'N-90',root='capture',documents=True)['hits'],[])
        self.assertEqual(len(server.search(self.adapter,'configuracion',root='capture',documents=True)['hits']),1)
    def test_sheet_identity_and_escape_attempts(self):
        self.assertIn('Beta',server.read_file(self.adapter,'team/beta/notes.md','capture')['body'])
        for path in ('../other/notes.md','leak.md'):
            self.assertFalse(server.read_file(self.adapter,path,'capture')['available'])

    def test_long_sheet_check_rejects_line_limited_search(self):
        real_search=server.search
        def broken_search(*args,**kwargs):
            kwargs['documents']=False
            return real_search(*args,**kwargs)
        with patch.object(server,'search',broken_search):
            with self.assertRaises(AssertionError):
                self.test_document_search_cannot_be_exhausted_by_one_long_sheet()

if __name__=='__main__': unittest.main()
