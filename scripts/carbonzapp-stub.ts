/**
 * Stand-in for the CarbonZapp cloud API used only by the browser tests (fictional fixture data).
 * POST /userapi/v1/client/getReports answers like the real endpoint: Bearer key, inclusive
 * date_from, oldest first. GET /health tells Playwright the stub is up.
 */
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';

const port = Number(process.env.CARBONZAPP_STUB_PORT ?? 3199);
const key = process.env.CARBONZAPP_API_KEY ?? 'e2e-only-carbonzapp-key';
const reports = JSON.parse(readFileSync(path.resolve(import.meta.dirname, '../tests/fixtures/carbonzapp-sample.json'), 'utf8')) as Array<{ datetime: string }>;

createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
    return;
  }
  if (req.method !== 'POST' || req.url !== '/userapi/v1/client/getReports') {
    res.writeHead(404).end();
    return;
  }
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    let parsed: { api_key?: string; date_from?: string } = {};
    try {
      parsed = JSON.parse(body || '{}');
    } catch {
      res.writeHead(400).end('bad json');
      return;
    }
    if (req.headers.authorization !== `Bearer ${key}` || parsed.api_key !== key) {
      res.writeHead(401, { 'content-type': 'text/html' }).end('<!doctype html><title>Login</title>');
      return;
    }
    const from = parsed.date_from ? new Date(parsed.date_from).getTime() : -Infinity;
    const page = reports.filter((r) => new Date(r.datetime).getTime() >= from).sort((a, b) => a.datetime.localeCompare(b.datetime));
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(page));
  });
}).listen(port, '127.0.0.1', () => console.log(`CarbonZapp stub on ${port}`));
