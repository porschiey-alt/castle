const { spawn } = require('child_process');
const child = spawn('node', ['C:\\source\\castle\\dist\\main\\mcp\\castle-tasks-server.js'], {
  env: Object.assign({}, process.env, { CASTLE_DB_PATH: 'C:\\test-nonexistent.db' }),
  stdio: ['pipe', 'pipe', 'pipe']
});

child.stderr.on('data', d => console.error('STDERR:', d.toString()));

let buf = '';
child.stdout.on('data', d => {
  buf += d.toString();
  console.log('STDOUT chunk:', JSON.stringify(d.toString()));
});

const initMsg = JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'test',version:'1.0'}}});
child.stdin.write('Content-Length: ' + Buffer.byteLength(initMsg) + '\r\n\r\n' + initMsg);

setTimeout(() => {
  const listMsg = JSON.stringify({jsonrpc:'2.0',id:2,method:'tools/list',params:{}});
  child.stdin.write('Content-Length: ' + Buffer.byteLength(listMsg) + '\r\n\r\n' + listMsg);
}, 500);

setTimeout(() => {
  console.log('Done. Buffer:', buf);
  child.kill();
  process.exit(0);
}, 3000);
