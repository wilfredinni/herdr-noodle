"""OpenCode transport against a local fake service, never a real provider."""
import base64
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch

spec=importlib.util.spec_from_file_location('generate',Path(__file__).resolve().parents[1]/'mods/changes-graph/generate.py')
g=importlib.util.module_from_spec(spec);spec.loader.exec_module(g)


class TransportTests(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
  state=Path(self.tmp.name)/'opencode';state.mkdir()
  self.state=state/'service.json';self.calls=[];self.status=200
  owner=self
  class Handler(BaseHTTPRequestHandler):
   def log_message(self,*args):pass
   def do_POST(self):
    body=self.rfile.read(int(self.headers['Content-Length']))
    owner.calls.append((self.path,self.headers,body))
    self.send_response(owner.status)
    if owner.status==307:self.send_header('Location',owner.url+'/redirect-target')
    self.end_headers();self.wfile.write(b'{"data":{"text":"Update fixture"}}')
  server=ThreadingHTTPServer(('127.0.0.1',0),Handler)
  self.url='http://127.0.0.1:'+str(server.server_port)
  thread=threading.Thread(target=server.serve_forever,kwargs={'poll_interval':.01},daemon=True);thread.start()
  self.addCleanup(server.server_close);self.addCleanup(server.shutdown)
  self.state.write_text(json.dumps({'url':self.url,'password':'fixture-only-password'}))
  env=patch.dict(os.environ,{'XDG_STATE_HOME':self.tmp.name,'HTTP_PROXY':'http://127.0.0.1:1'});env.start();self.addCleanup(env.stop)
  command=patch.object(g,'command',return_value=self.url+'\n');self.command=command.start();self.addCleanup(command.stop)
 def test_body_larger_than_os_argument_limit_arrives_complete_with_local_auth(self):
  data=json.dumps({'prompt':'x'*1_100_000+'ñ🙂END'},ensure_ascii=False)
  self.assertEqual(json.loads(g.opencode_request(data,self.tmp.name))['data']['text'],'Update fixture')
  path,headers,body=self.calls[0]
  self.assertEqual(path,'/api/experimental/generate/text');self.assertEqual(body,data.encode())
  self.assertEqual(headers['Authorization'],'Basic '+base64.b64encode(b'opencode:fixture-only-password').decode())
  self.command.assert_called_once_with(['opencode','service','status'],self.tmp.name)
 def test_redirects_cannot_receive_body_or_password(self):
  self.status=307
  with self.assertRaises(ValueError):g.opencode_request('{"prompt":"fixture"}',self.tmp.name)
  self.assertEqual(len(self.calls),1)
 def test_remote_and_ambiguous_urls_are_rejected_before_transmission(self):
  for url in ['https://example.invalid','http://127.0.0.1:1234/elsewhere','http://user:secret@127.0.0.1:1234','http://127.0.0.1:1234?token=x']:
   self.command.return_value=url
   with self.assertRaisesRegex(ValueError,'local background service'):g.opencode_request('{}',self.tmp.name)
  self.assertEqual(self.calls,[])
 def test_changed_service_is_rejected_before_transmission(self):
  self.state.write_text(json.dumps({'url':'http://127.0.0.1:1','password':'fixture-only-password'}))
  with self.assertRaisesRegex(ValueError,'service changed'):g.opencode_request('{}',self.tmp.name)
  self.assertEqual(self.calls,[])
 def test_http_errors_do_not_expose_source_or_password(self):
  self.status=401
  with self.assertRaises(ValueError) as error:g.opencode_request('{"prompt":"private fixture"}',self.tmp.name)
  self.assertNotIn('private fixture',str(error.exception));self.assertNotIn('fixture-only-password',str(error.exception))

if __name__=='__main__':unittest.main()
