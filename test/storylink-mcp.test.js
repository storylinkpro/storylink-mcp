import { test, describe, before, after } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { webcrypto, randomUUID } from 'node:crypto';
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
// The real format: sl_live_ and 32 base64url characters.
const KEY = 'sl_live_Test-Key_0123456789abcdefghijklm';
const KEY_BODY = KEY.slice('sl_live_'.length);
assert.equal(KEY_BODY.length, 32);

function makeMcpServer() {
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
  return server;
}

// A fake Storylink server with one tool, over Streamable HTTP. It answers 401
// unless the request has the expected key, and records what it receives. It
// keeps the GET stream for server messages open, as a real server can, so an
// open connection cannot hide a launcher that does not exit.
//
// Options:
//   stateful   use session ids (mcp-session-id), as the SDK's session mode does
//   errorBody  answer every POST with 500 and this body, given the Authorization header
function startFakeServer({ stateful = false, errorBody } = {}) {
  const received = { authorization: [], methods: [], sessionIds: [], deleted: [] };
  const sessions = new Map();
  let markStreamOpen;
  const streamOpen = new Promise((resolve) => (markStreamOpen = resolve));

  const httpServer = createServer(async (req, res) => {
    received.authorization.push(req.headers.authorization);
    if (req.headers.authorization !== `Bearer ${KEY}`) {
      res.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'invalid_api_key' }));
      return;
    }
    const sessionId = req.headers['mcp-session-id'];
    if (req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      res.flushHeaders();
      markStreamOpen();
      return;
    }
    if (req.method === 'DELETE') {
      received.deleted.push(sessionId);
      const transport = sessions.get(sessionId);
      if (!transport) return void res.writeHead(404).end();
      await transport.handleRequest(req, res);
      return;
    }

    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    for (const message of [body].flat()) if (message.method) received.methods.push(message.method);
    received.sessionIds.push(sessionId);

    if (errorBody) {
      res.writeHead(500, { 'content-type': 'text/plain' }).end(errorBody(req.headers.authorization));
      return;
    }

    if (!stateful) {
      const server = makeMcpServer();
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on('close', () => {
        transport.close();
        server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
      return;
    }

    let transport = sessions.get(sessionId);
    if (!transport) {
      if (sessionId) return void res.writeHead(404).end();
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => sessions.set(id, transport),
      });
      await makeMcpServer().connect(transport);
    }
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

function connect(fake, key = KEY) {
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

function run(env) {
  const child = spawn(process.execPath, [LAUNCHER], { env: launcherEnv(env), stdio: ['pipe', 'pipe', 'pipe'] });
  const stdout = collect(child.stdout);
  const stderr = collect(child.stderr);
  const exited = new Promise((resolve) => {
    child.on('close', (code) => resolve({ code, stdout: stdout(), stderr: stderr() }));
  });
  return { child, exited };
}

// Resolves with the result, or with `fallback` after `ms`, without keeping the
// test process alive.
function within(promise, ms, fallback) {
  const ac = new AbortController();
  return Promise.race([
    promise.finally(() => ac.abort()),
    delay(ms, fallback, { signal: ac.signal, ref: false }).catch(() => fallback),
  ]);
}

for (const stateful of [false, true]) {
  describe(`proxy (${stateful ? 'stateful' : 'stateless'} server)`, () => {
    let fake;
    let client;
    let transport;
    let stderr;
    const logs = [];

    before(async () => {
      fake = await startFakeServer({ stateful });
      ({ client, transport, stderr } = connect(fake));
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

    if (stateful) {
      test('every request after initialize carries the session id', () => {
        const [first, ...rest] = fake.received.sessionIds;
        assert.equal(first, undefined);
        assert.ok(rest.length > 0);
        assert.equal(new Set(rest).size, 1);
        assert.ok(rest[0]);
      });
    }

    test('the key never appears in the launcher output', () => {
      assert.ok(!stderr().includes(KEY_BODY));
    });
  });
}

describe('server errors', () => {
  test('a refused key gives the client an error instead of waiting forever', async () => {
    const fake = await startFakeServer();
    const wrongKey = `sl_live_${'w'.repeat(32)}`;
    const { client, transport, stderr } = connect(fake, wrongKey);
    try {
      await assert.rejects(client.connect(transport), /HTTP 401/);
    } finally {
      await client.close();
      await transport.close();
      fake.close();
    }
    assert.ok(!stderr().includes('w'.repeat(32)));
  });

  test('an upstream error that quotes the key comes out redacted', async () => {
    const fake = await startFakeServer({ errorBody: (auth) => `rejected header: ${auth}` });
    const { client, transport, stderr } = connect(fake);
    let message = '';
    try {
      await assert.rejects(client.connect(transport), (error) => {
        message = error.message;
        return true;
      });
    } finally {
      await client.close();
      await transport.close();
      fake.close();
    }
    assert.match(message, /rejected header: Bearer sl_live_…\[redacted\]/);
    assert.ok(!message.includes(KEY_BODY));
    assert.match(stderr(), /\[redacted\]/);
    assert.ok(!stderr().includes(KEY_BODY));
  });

  test('a long upstream error body is shortened', async () => {
    const fake = await startFakeServer({ errorBody: () => `<html>${'x'.repeat(5000)}</html>` });
    const { client, transport } = connect(fake);
    let message = '';
    try {
      await assert.rejects(client.connect(transport), (error) => {
        message = error.message;
        return true;
      });
    } finally {
      await client.close();
      await transport.close();
      fake.close();
    }
    assert.match(message, /HTTP 500/);
    assert.ok(message.length < 700, `message has ${message.length} characters`);
  });
});

describe('shutdown', () => {
  for (const stateful of [false, true]) {
    test(`exits 0 when the client closes stdin, with the server stream open (${stateful ? 'stateful, ends the session' : 'stateless'})`, async () => {
      const fake = await startFakeServer({ stateful });
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
        const result = await within(exited, 5000, { code: 'still running after 5s' });
        assert.equal(result.code, 0);
        if (stateful) {
          assert.equal(fake.received.deleted.length, 1);
          assert.ok(fake.received.deleted[0]);
        }
      } finally {
        child.kill();
        fake.close();
      }
    });
  }
});

describe('configuration check', () => {
  const body = KEY_BODY;
  const badKeys = [
    ['a missing key', undefined, /STORYLINK_API_KEY is not set/],
    ['an empty key', '', /STORYLINK_API_KEY is not set/],
    ['a key without the sl_live_ prefix', `sk_test_${body}`],
    ['a key with a line feed', `sl_live_${body.slice(0, 16)}\n${body.slice(16)}`],
    ['a key with a carriage return', `sl_live_${body.slice(0, 16)}\r${body.slice(16)}`],
    ['two keys on two lines', `${KEY}\n${KEY}`],
    ['a key with a tab', `sl_live_${body.slice(0, 16)}\t${body.slice(16)}`],
    ['a 31-character key body', `sl_live_${body.slice(1)}`],
    ['a 33-character key body', `sl_live_${body}x`],
    ['a key with "+" and "="', `sl_live_${body.slice(0, 30)}+=`],
    ['the README placeholder', 'sl_live_…'],
  ];

  for (const [label, key, message = /STORYLINK_API_KEY is not a valid Storylink API key/] of badKeys) {
    test(`${label} exits 1 with a message, never contacts the server and never echoes the key`, async () => {
      const fake = await startFakeServer();
      const { child, exited } = run({ STORYLINK_API_KEY: key, STORYLINK_MCP_URL: fake.url });
      try {
        // If the launcher wrongly accepted the key, this request would reach
        // the server (and a bad header could quote the key in an error).
        child.stdin.on('error', () => {});
        child.stdin.end(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' })}\n`);
        const result = await within(exited, 5000, { code: 'still running after 5s', stdout: '', stderr: '' });
        assert.equal(result.code, 1);
        assert.match(result.stderr, /^storylink-mcp: STORYLINK_API_KEY [^\n]+\n$/);
        assert.match(result.stderr, message);
        assert.equal(result.stdout, '');
        assert.equal(fake.received.authorization.length, 0);
        for (const part of [body.slice(0, 16), body.slice(16)]) {
          if (key?.includes(part)) assert.ok(!result.stderr.includes(part));
        }
      } finally {
        child.kill();
        fake.close();
      }
    });
  }

  test('a key with a NUL cannot even reach the launcher (Node refuses the env)', () => {
    assert.throws(() => run({ STORYLINK_API_KEY: `sl_live_${body.slice(0, 16)}\0${body.slice(16)}` }), {
      code: 'ERR_INVALID_ARG_VALUE',
    });
  });

  test('a plain-http URL that is not localhost exits 1 before sending the key', async () => {
    const result = await run({ STORYLINK_API_KEY: KEY, STORYLINK_MCP_URL: 'http://example.com/mcp' }).exited;
    assert.equal(result.code, 1);
    assert.equal(result.stderr, 'storylink-mcp: STORYLINK_MCP_URL must use https (http is allowed only for localhost).\n');
    assert.equal(result.stdout, '');
  });

  // Each URL looks like localhost, but its real host is evil.com.
  for (const lookalike of ['http://localhost.evil.com/mcp', 'http://127.0.0.1@evil.com/mcp', 'http://evil.com#@127.0.0.1']) {
    test(`a plain-http lookalike URL (${lookalike}) exits 1 before sending the key`, async () => {
      const result = await run({ STORYLINK_API_KEY: KEY, STORYLINK_MCP_URL: lookalike }).exited;
      assert.equal(result.code, 1);
      assert.equal(result.stderr, 'storylink-mcp: STORYLINK_MCP_URL must use https (http is allowed only for localhost).\n');
      assert.equal(result.stdout, '');
    });
  }

  test('a short loopback form (http://127.1) is allowed', async () => {
    const fake = await startFakeServer();
    const port = new URL(fake.url).port;
    const { client, transport } = connect({ url: `http://127.1:${port}/mcp` });
    try {
      await client.connect(transport);
      assert.equal(client.getServerVersion()?.name, 'fake-storylink');
    } finally {
      await client.close();
      await transport.close();
      fake.close();
    }
  });
});
