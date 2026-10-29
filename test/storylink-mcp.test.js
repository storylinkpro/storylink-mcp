import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { webcrypto } from 'node:crypto';
import * as z from 'zod/v4';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { LoggingMessageNotificationSchema, EmptyResultSchema } from '@modelcontextprotocol/sdk/types.js';

// The SDK's HTTP server transport (used only by the fake server) needs the
// global crypto, which Node 18 does not have without a flag.
globalThis.crypto ??= webcrypto;

const LAUNCHER = fileURLToPath(new URL('../bin/storylink-mcp.js', import.meta.url));
const KEY = 'sl_live_test_0123456789abcdef';

// A fake Storylink server: Streamable HTTP, stateless, one tool. It answers
// 401 unless the request has the expected key, and records what it receives.
// It keeps the GET stream for server messages open, as a real server can, so
// an open connection cannot hide a launcher that does not exit.
function startFakeServer() {
  const received = { authorization: [], methods: [] };
  let markStreamOpen;
  const streamOpen = new Promise((resolve) => (markStreamOpen = resolve));

  const httpServer = createServer(async (req, res) => {
    received.authorization.push(req.headers.authorization);
    if (req.headers.authorization !== `Bearer ${KEY}`) {
      res.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'invalid_api_key' }));
      return;
    }
    if (req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      res.flushHeaders();
      markStreamOpen();
      return;
    }
    let body;
    if (req.method === 'POST') {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      for (const message of [body].flat()) if (message.method) received.methods.push(message.method);
    }

    const server = new McpServer({ name: 'fake-storylink', version: '0.0.0' }, { capabilities: { logging: {} } });
    server.registerTool(
      'echo_views',
      { description: 'Returns the views of a story', inputSchema: { story_id: z.string() } },
      async ({ story_id }, extra) => {
        await extra.sendNotification({
          method: 'notifications/message',
          params: { level: 'info', data: `reading ${story_id}` },
        });
        return { content: [{ type: 'text', text: `story ${story_id}: 42 views` }] };
      },
    );
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  });

  return new Promise((resolve) => {
    httpServer.listen(0, '127.0.0.1', () => {
      const { port } = httpServer.address();
      resolve({
        url: `http://127.0.0.1:${port}/mcp`,
        received,
        streamOpen,
        close: () => {
          httpServer.closeAllConnections();
          httpServer.close();
        },
      });
    });
  });
}

function launcherEnv(extra) {
  const env = { ...process.env, ...extra };
  for (const [name, value] of Object.entries(env)) if (value === undefined) delete env[name];
  return env;
}

function collect(stream) {
  const chunks = [];
  stream?.on('data', (chunk) => chunks.push(chunk));
  return () => Buffer.concat(chunks).toString('utf8');
}

async function connect(fake, key = KEY) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [LAUNCHER],
    env: launcherEnv({ STORYLINK_API_KEY: key, STORYLINK_MCP_URL: fake.url }),
    stderr: 'pipe',
  });
  const stderr = collect(transport.stderr);
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  return { client, transport, stderr };
}

describe('proxy', () => {
  let fake;
  let client;
  let transport;
  let stderr;
  const logs = [];

  before(async () => {
    fake = await startFakeServer();
    ({ client, transport, stderr } = await connect(fake));
    client.setNotificationHandler(LoggingMessageNotificationSchema, (n) => logs.push(n.params.data));
    await client.connect(transport);
  });

  after(async () => {
    await client?.close();
    await transport?.close(); // stops the launcher even when connect failed
    fake?.close();
  });

  test('initialize works through the launcher', () => {
    assert.equal(client.getServerVersion()?.name, 'fake-storylink');
    assert.ok(client.getServerCapabilities()?.tools);
  });

  test('tools/list returns the server tools', async () => {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name), ['echo_views']);
  });

  test('tools/call round-trips, with the server notification', async () => {
    const result = await client.callTool({ name: 'echo_views', arguments: { story_id: 's_1' } });
    assert.deepEqual(result.content, [{ type: 'text', text: 'story s_1: 42 views' }]);
    assert.deepEqual(logs, ['reading s_1']);
  });

  test('JSON-RPC errors from the server reach the client', async () => {
    await assert.rejects(client.request({ method: 'storylink/unknown', params: {} }, EmptyResultSchema), (error) => {
      assert.equal(error.code, -32601);
      return true;
    });
  });

  test('client notifications reach the server', () => {
    assert.ok(fake.received.methods.includes('notifications/initialized'));
  });

  test('the server gets the key as a Bearer token on every request', () => {
    assert.ok(fake.received.authorization.length > 0);
    for (const value of fake.received.authorization) assert.equal(value, `Bearer ${KEY}`);
  });

  test('the key never appears in the launcher output', () => {
    assert.ok(!stderr().includes(KEY));
  });
});

describe('server refuses the key', () => {
  test('the client gets an error instead of waiting forever', async () => {
    const fake = await startFakeServer();
    const wrongKey = 'sl_live_wrong_key_value';
    const { client, transport, stderr } = await connect(fake, wrongKey);
    try {
      await assert.rejects(client.connect(transport), /401/);
      assert.ok(!stderr().includes(wrongKey));
    } finally {
      await client.close();
      fake.close();
    }
  });
});

function run(env) {
  const child = spawn(process.execPath, [LAUNCHER], { env: launcherEnv(env), stdio: ['pipe', 'pipe', 'pipe'] });
  const stdout = collect(child.stdout);
  const stderr = collect(child.stderr);
  const exited = new Promise((resolve) => {
    child.on('close', (code) => resolve({ code, stdout: stdout(), stderr: stderr() }));
  });
  return { child, exited };
}

describe('shutdown', () => {
  test('the launcher exits 0 when the client closes stdin, with the server stream open', async () => {
    const fake = await startFakeServer();
    const { child, exited } = run({ STORYLINK_API_KEY: KEY, STORYLINK_MCP_URL: fake.url });
    try {
      const write = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
      write({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'raw', version: '0' } },
      });
      // Send initialized only after the answer, as a client does.
      await new Promise((resolve) => child.stdout.once('data', resolve));
      write({ jsonrpc: '2.0', method: 'notifications/initialized' });
      await fake.streamOpen;
      child.stdin.end();
      const result = await Promise.race([
        exited,
        new Promise((resolve) => setTimeout(() => resolve({ code: 'still running after 5s' }), 5000)),
      ]);
      assert.equal(result.code, 0);
    } finally {
      child.kill();
      fake.close();
    }
  });
});

describe('key check', () => {
  for (const [label, key] of [
    ['missing', undefined],
    ['empty', ''],
    ['without the sl_live_ prefix', 'sk_test_abc123'],
  ]) {
    test(`a ${label} key exits 1 with a message and never contacts the server`, async () => {
      const fake = await startFakeServer();
      try {
        const result = await run({ STORYLINK_API_KEY: key, STORYLINK_MCP_URL: fake.url }).exited;
        assert.equal(result.code, 1);
        assert.match(result.stderr, /^storylink-mcp: STORYLINK_API_KEY .+\n$/);
        assert.equal(result.stdout, '');
        assert.equal(fake.received.authorization.length, 0);
        if (key) assert.ok(!result.stderr.includes(key));
      } finally {
        fake.close();
      }
    });
  }
});
