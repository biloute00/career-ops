#!/usr/bin/env node
// ui/server.mjs — serves the career-ops Launchpad page (ui/index.html) on
// localhost, and nothing else. Spec: docs/specs/html-ui-auto-pipeline.md §5.5, §6.
//
// The page is a form that builds a prompt for the user to paste into Claude
// Code; it never runs anything itself, so this server has exactly one job:
// hand out that one file. Rules it enforces:
//
//   MR5  bind 127.0.0.1 only — never reachable from the network.
//   MR6  answer GET / and GET /index.html; every other path or method is 404.
//        No directory listing, no route to cv.md, data/, reports/, output/.
//   MR7  port 4873 (or PORT); on EADDRINUSE try the next 9, then exit 1.
//   MR8  print `READY http://localhost:{port}` once listening. If a port in the
//        range is already held by another Launchpad (X-Launchpad: 1), print its
//        READY line and exit 0 instead of starting a second one.
//
// The footer version comes from VERSION, substituted into the page at serve
// time; opened straight from disk, the page shows "unknown" instead (§9 Q3).
//
// Node built-ins only (AC9): the backend's `npm install` may not have run yet
// when this starts.
//
// Run:  node ui/server.mjs          (PORT=5000 node ui/server.mjs)

import http from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const HOST = '127.0.0.1';
const DEFAULT_PORT = 4873;
const PORT_SPAN = 10; // the base port plus the next 9 (MR7)
const PROBE_TIMEOUT_MS = 800;
const VERSION_PLACEHOLDER = '__LAUNCHPAD_VERSION__';

function fail(message) {
  console.error(`Launchpad error: ${message}`);
  process.exit(1);
}

function readVersion() {
  try {
    // VERSION reads "1.33.0 # x-release-please-version"; keep the number only.
    const token = readFileSync(join(HERE, '..', 'VERSION'), 'utf8').trim().split(/\s+/)[0];
    return /^[0-9A-Za-z.+-]{1,40}$/.test(token) ? token : 'unknown';
  } catch {
    return 'unknown';
  }
}

function loadPage() {
  let html;
  try {
    html = readFileSync(join(HERE, 'index.html'), 'utf8');
  } catch {
    fail('ui/index.html is missing. Re-extract the career-ops folder and try again.');
  }
  return Buffer.from(html.replace(VERSION_PLACEHOLDER, readVersion()), 'utf8');
}

function basePort() {
  const raw = process.env.PORT;
  if (raw === undefined || raw === '') return DEFAULT_PORT;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535 - (PORT_SPAN - 1)) {
    fail(`PORT must be a whole number between 1 and ${65535 - (PORT_SPAN - 1)} (got "${raw}").`);
  }
  return port;
}

const PAGE = loadPage();

const COMMON_HEADERS = {
  'X-Launchpad': '1',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};

const PAGE_HEADERS = {
  ...COMMON_HEADERS,
  'Content-Type': 'text/html; charset=utf-8',
  // The page is self-contained: inline CSS and JS, no outbound requests.
  'Content-Security-Policy':
    "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; " +
    "img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};

function handle(req, res) {
  const path = (req.url || '').split('?')[0];
  if (req.method === 'GET' && (path === '/' || path === '/index.html')) {
    res.writeHead(200, { ...PAGE_HEADERS, 'Content-Length': PAGE.length });
    res.end(PAGE);
    return;
  }
  res.writeHead(404, { ...COMMON_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not found\n');
}

/** Resolve true when the port is held by another Launchpad (MR8). */
function isLaunchpad(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: HOST, port, path: '/', timeout: PROBE_TIMEOUT_MS }, (res) => {
      res.resume();
      resolve(res.headers['x-launchpad'] === '1');
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(false));
  });
}

/** Resolve the server once listening, or null when the port is taken. */
function listen(port) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handle);
    server.once('error', (err) => {
      if (err.code === 'EADDRINUSE' || err.code === 'EACCES') resolve(null);
      else reject(err);
    });
    server.listen(port, HOST, () => resolve(server));
  });
}

async function main() {
  const first = basePort();
  const last = first + PORT_SPAN - 1;
  for (let port = first; port <= last; port += 1) {
    const server = await listen(port);
    if (server) {
      console.log(`READY http://localhost:${port}`);
      const stop = () => server.close(() => process.exit(0));
      process.on('SIGINT', stop);
      process.on('SIGTERM', stop);
      return;
    }
    if (await isLaunchpad(port)) {
      console.log(`READY http://localhost:${port}`);
      console.log('(A Launchpad was already running on this port; reusing it.)');
      process.exit(0);
    }
  }
  fail(`ports ${first}-${last} are all busy. Close some apps, or set PORT to another number.`);
}

main().catch((err) => fail(err.message));
