import importlib.util,unittest,tempfile,pathlib,subprocess,json
from unittest.mock import patch
s=importlib.util.spec_from_file_location('g',str(pathlib.Path(__file__).resolve().parents[1]/'mods/changes-graph/generate.py'));g=importlib.util.module_from_spec(s);s.loader.exec_module(g)

class GenerateTests(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory(); self.root=pathlib.Path(self.tmp.name)
  self.git('init','-q');self.git('config','user.name','Test');self.git('config','user.email','test@example.invalid')
  for name in ['a.txt','b.txt','delete.txt']: (self.root/name).write_text('original\n')
  self.git('add','.');self.git('commit','-qm','Initial')
  self.request={'root':str(self.root),'head':self.git('rev-parse','HEAD').strip(),'branch':self.git('branch','--show-current').strip(),'selected':[],'connection':'opencode:go','model':'test'}
  (self.root/'a.txt').write_text('changed alpha\n');(self.root/'b.txt').write_text('changed beta\n');(self.root/'new.txt').write_text('new gamma\n');(self.root/'delete.txt').unlink()
 def tearDown(self): self.tmp.cleanup()
 def git(self,*args):return subprocess.check_output(['git','-c','core.fsmonitor=false','-c','core.hooksPath=/dev/null','-c','commit.gpgsign=false',*args],cwd=self.root,text=True,stderr=subprocess.DEVNULL)
 def snap(self):return g.snapshot(self.request)
 def test_none_means_all_including_new_deleted(self):
  p=self.snap();self.assertEqual(set(p['paths']),{'a.txt','b.txt','new.txt','delete.txt'});self.assertIn('new gamma',p['payload']);self.assertIn('deleted file',p['payload'])
 def test_subset_only_index_content(self):
  self.git('add','a.txt');self.request['selected']=['a.txt'];(self.root/'a.txt').write_text('unstaged alpha\n')
  p=self.snap();self.assertEqual(p['paths'],['a.txt']);self.assertIn('changed alpha',p['payload']);self.assertNotIn('unstaged alpha',p['payload']);self.assertNotIn('changed beta',p['payload']);self.assertNotIn('new gamma',p['payload'])
 def test_all_selected(self):
  self.git('add','-A');self.request['selected']=sorted(['a.txt','b.txt','new.txt','delete.txt']);p=self.snap();self.assertEqual(p['paths'],self.request['selected']);self.assertIn('new gamma',p['payload'])
 def test_no_index_mutation(self):
  before=(self.root/'.git/index').read_bytes();self.snap();self.assertEqual(before,(self.root/'.git/index').read_bytes())
 def test_stale_selection(self):
  self.git('add','b.txt')
  with self.assertRaisesRegex(ValueError,'selection changed'):self.snap()
 def test_stale_head(self):
  self.request['head']='0'*40
  with self.assertRaisesRegex(ValueError,'Branch changed'):self.snap()
 def test_tricky_filename_literal(self):
  (self.root/':(exclude)a').write_text('literal\n');self.git('add','--',':(literal):(exclude)a');self.request['selected']=[':(exclude)a'];self.assertIn('literal',self.snap()['payload'])
 def test_binary_and_symlink(self):
  (self.root/'new.txt').write_bytes(b'\x00abc');(self.root/'outside').symlink_to('/etc/passwd');p=self.snap();self.assertIn('[Binary file]',p['payload']);self.assertIn('Symlink to /etc/passwd',p['payload']);self.assertNotIn('root:',p['payload'])
 def test_too_large_refused(self):
  (self.root/'new.txt').write_text('x'*(g.LIMIT+1))
  with self.assertRaisesRegex(ValueError,'too large'):self.snap()
 def test_single_line_edit_above_old_limit_generates_without_truncation(self):
  (self.root/'a.txt').write_text('a'*40000+'\n');self.git('add','a.txt');self.git('commit','-qm','Long-line baseline')
  self.request['head']=self.git('rev-parse','HEAD').strip()
  (self.root/'a.txt').write_text('a'*39999+'b\n');self.git('add','a.txt');self.request['selected']=['a.txt']
  before=(self.root/'.git/index').read_bytes();snapshot=self.snap()
  self.assertGreater(len(snapshot['payload'].encode()),60000)
  self.assertIn('a'*39999+'b',snapshot['payload']);self.assertEqual(snapshot['paths'],['a.txt'])
  with patch.object(g,'catalog',return_value={'connections':[{'id':'opencode:go','models':[{'id':'test'}]}]}),patch.object(g,'command',return_value='{"data":{"text":"Update the long-line fixture"}}') as command:
   self.assertEqual(g.generate(self.request)['subject'],'Update the long-line fixture')
   command.assert_called_once()
  self.assertEqual(before,(self.root/'.git/index').read_bytes())
 def test_oversize_diff_reports_actual_size_and_limit(self):
  (self.root/'a.txt').write_text('a'*(g.LIMIT+1))
  with self.assertRaisesRegex(ValueError,r'too large \([\d,]+ bytes; limit 120,000\)'):self.snap()
 def test_encoded_opencode_body_is_checked_before_provider_request(self):
  (self.root/'new.txt').write_text('"'*61000)
  self.assertLess(len(self.snap()['payload'].encode()),g.LIMIT)
  with patch.object(g,'catalog',return_value={'connections':[{'id':'opencode:go','models':[{'id':'test'}]}]}),patch.object(g,'command') as command:
   with self.assertRaisesRegex(ValueError,'encoded OpenCode request is too large'):g.generate(self.request)
   command.assert_not_called()
 def test_ignored_not_sent(self):
  (self.root/'.gitignore').write_text('secret\n');(self.root/'secret').write_text('hidden credential');self.assertNotIn('hidden credential',self.snap()['payload'])
 def test_unborn_repo(self):
  with tempfile.TemporaryDirectory() as d:
   subprocess.check_call(['git','init','-q',d]);(pathlib.Path(d)/'first').write_text('first\n');branch=subprocess.check_output(['git','symbolic-ref','--short','HEAD'],cwd=d,text=True).strip();p=g.snapshot(dict(root=d,head='',branch=branch,selected=[]));self.assertIn('first',p['payload'])
 def test_output_validation(self):
  self.assertEqual(g.clean_subject('{"subject":"Fix generation"}'),'Fix generation')
  for value in ['','```text\nhello\n```','Subject\nBody','x'*201]:
   with self.assertRaises(ValueError):g.clean_subject(value)
 def test_changes_during_generation(self):
  def provider(*args,**kwargs):
   (self.root/'a.txt').write_text('changed during request\n');return '{"data":{"text":"Update files"}}'
  with patch.object(g,'catalog',return_value={'connections':[{'id':'opencode:go','models':[{'id':'test'}]}]}),patch.object(g,'command',side_effect=provider):
   with self.assertRaisesRegex(ValueError,'changed during generation'):g.generate(self.request)
 def test_model_disappeared_no_request(self):
  with patch.object(g,'catalog',return_value={'connections':[]}),patch.object(g,'command') as command:
   with self.assertRaisesRegex(ValueError,'no longer available'):g.generate(self.request)
   command.assert_not_called()

if __name__=='__main__':unittest.main()
