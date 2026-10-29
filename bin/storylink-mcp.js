#!/usr/bin/env node
// Runs the hosted Storylink MCP server for MCP clients that can start only a
// local (stdio) server, such as Claude Desktop.
//
// It reads JSON-RPC messages from stdin, sends them to https://storylink.pro/mcp
// over Streamable HTTP with the API key in the Authorization header, and writes
// the server's messages to stdout. It does not change the messages.
//
// Environment:
//   STORYLINK_API_KEY  required, a Storylink API key (sl_live_…)
//   STORYLINK_MCP_URL  optional, another server URL (for testing)

import process from 'node:process';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const DEFAULT_URL = 'https://storylink.pro/mcp';
// A Storylink key is sl_live_ and 32 base64url characters (24 random bytes).
const KEY_PATTERN = /^sl_live_[A-Za-z0-9_-]{32}$/;
// Any key-like text, for redaction.
const KEY_LIKE = /sl_live_[A-Za-z0-9_-]+/g;
const REDACTED = 'sl_live_…[redacted]';
const MAX_ERROR_LENGTH = 500;
const TERMINATE_TIMEOUT_MS = 2000;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

let apiKey = '';

// Removes the key, and any other key-like text, from text that leaves the
// process (stderr or a JSON-RPC error).
function redact(text) {
  let out = String(text);
  if (apiKey) out = out.split(apiKey).join(REDACTED);
  return out.replace(KEY_LIKE, REDACTED);
}

function fail(message) {
  process.stderr.write(`storylink-mcp: ${redact(message)}\n`);
  process.exit(1);
}

function log(message) {
  // stdout carries the MCP messages, so all logs go to stderr.
  process.stderr.write(`storylink-mcp: ${redact(message)}\n`);
}

const rawKey = process.env.STORYLINK_API_KEY ?? '';
if (!rawKey.trim()) {
  fail('STORYLINK_API_KEY is not set. Create an API key on the Developers page in Storylink and set STORYLINK_API_KEY to it.');
}
if (!KEY_PATTERN.test(rawKey.trim())) {
  // Never echo the value: it may be a real key with a typo.
  fail('STORYLINK_API_KEY is not a valid Storylink API key. A key is "sl_live_" and 32 more letters, digits, "-" or "_". Copy it again from the Developers page in Storylink.');
}
apiKey = rawKey.trim();

let url;
try {
  url = new URL(process.env.STORYLINK_MCP_URL || DEFAULT_URL);
} catch {
  fail('STORYLINK_MCP_URL is not a valid URL.');
}
if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname))) {
  // The key must not travel in plain text. http is only for a local test server.
  fail('STORYLINK_MCP_URL must use https (http is allowed only for localhost).');
}

const local = new StdioServerTransport();
const remote = new StreamableHTTPClientTransport(url, {
  requestInit: { headers: { Authorization: `Bearer ${apiKey}` } },
});

// Ids of initialize requests that wait for an answer. The answer gives the
// protocol version, which the HTTP transport sends on each later request
// (the SDK's Client does the same after it connects).
const pendingInitialize = new Set();

let closing = false;
async function shutdown(code = 0) {
  if (closing) return;
  closing = true;
  // Best effort: end the server session (HTTP DELETE), but do not wait long.
  await Promise.race([
    remote.terminateSession().catch(() => {}),
    new Promise((resolve) => setTimeout(resolve, TERMINATE_TIMEOUT_MS).unref()),
  ]);
  await Promise.allSettled([remote.close(), local.close()]);
  process.exit(code);
}

function errorText(error) {
  let text = error instanceof Error ? error.message : String(error);
  if (error instanceof StreamableHTTPError && error.code > 0) {
    // The SDK message has the response body but not the status (401, 402, 429, …).
    text = `HTTP ${error.code}: ${text}`;
  }
  text = redact(text);
  // An error page (for example an HTML challenge) can be long.
  if (text.length > MAX_ERROR_LENGTH) text = `${text.slice(0, MAX_ERROR_LENGTH)}…`;
  return text;
}

local.onmessage = (message) => {
  if (message.method === 'initialize' && message.id !== undefined) {
    pendingInitialize.add(message.id);
  }
  remote.send(message).catch((error) => {
    // The send failed (network error, 401, 402, 429, …). A request would
    // otherwise wait forever, so answer it with a JSON-RPC error.
    if (message.id !== undefined && 'method' in message) {
      pendingInitialize.delete(message.id);
      local
        .send({
          jsonrpc: '2.0',
          id: message.id,
          error: { code: -32603, message: `Storylink MCP server: ${errorText(error)}` },
        })
        .catch(() => {});
    }
  });
};

remote.onmessage = (message) => {
  if ('id' in message && pendingInitialize.delete(message.id)) {
    const version = message.result?.protocolVersion;
    if (typeof version === 'string') remote.setProtocolVersion(version);
  }
  local.send(message).catch((error) => log(`could not write to stdout: ${errorText(error)}`));
};

remote.onerror = (error) => log(errorText(error));
local.onerror = (error) => log(errorText(error));

remote.onclose = () => void shutdown(0);
local.onclose = () => void shutdown(0);

// StdioServerTransport does not watch for the end of stdin, so watch here:
// when the client closes stdin, the proxy stops.
process.stdin.on('end', () => void shutdown(0));
process.on('SIGINT', () => void shutdown(0));
process.on('SIGTERM', () => void shutdown(0));

await remote.start();
await local.start();
