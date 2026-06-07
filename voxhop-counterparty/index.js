// VoxHop Counterparty — Phase 1 stub
//
// M-05: GET /health → {"status":"stub"}, 404 on every other path.
// M-05: Zero production node_modules. Single file using node:http built-in.
// MN-08: No avr-vad, Whisper, Ollama, or Piper client code.
//
// Phase 2 replaces this stub entirely with the full Counterparty pipeline.

const http = require('node:http');

const PORT = parseInt(process.env.PORT || '3001', 10);

const server = http.createServer((req, res) => {
  // M-05: Only GET /health returns 200. Everything else → 404.
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'stub' }));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found' }));
});

server.listen(PORT, () => {
  console.log(`[voxhop-counterparty] Phase 1 stub running on port ${PORT}`);
  console.log(`[voxhop-counterparty] GET /health → {"status":"stub"}`);
  console.log(`[voxhop-counterparty] All other paths → 404`);
});
