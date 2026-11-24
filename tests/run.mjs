// One command for every test. Starts the local server itself, runs the e2e scripts in parallel, retries a failed script once.
//   node tests/run.mjs                 everything: logic tests + every e2e script (what GitHub runs after each push)
//   node tests/run.mjs quick v47 bank  fast lane: logic tests + only the e2e scripts whose name contains one of the words
//   options: --jobs N (parallel scripts, default 4), --shots DIR (screenshot folder, default /tmp/shots)
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile, readdir, mkdir } from 'node:fs/promises';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); if (i < 0) return d; const v = args[i + 1]; args.splice(i, 2); return v; };
const JOBS = +opt('--jobs', 4) || 4, SHOTS = opt('--shots', '/tmp/shots'), PORT = 8765, TIMEOUT = 300e3;
const quick = args[0] === 'quick', words = quick ? args.slice(1) : [];

// Static server for the repo root, only when nothing answers on the port already.
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.css': 'text/css' };
async function serve() {
  try { const r = await fetch(`http://localhost:${PORT}/sw.js`); if (r.ok) return null; } catch {}
  const srv = createServer(async (req, res) => {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname); if (p.endsWith('/')) p += 'index.html';
    const f = join(ROOT, p); if (!f.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
    try { const b = await readFile(f); res.writeHead(200, { 'content-type': MIME[extname(f)] || 'application/octet-stream', 'cache-control': 'no-store' }); res.end(b); }
    catch { res.writeHead(404); res.end('not found'); }
  });
  await new Promise(ok => srv.listen(PORT, ok));
  return srv;
}

function run(cmd, list) {
  return new Promise(ok => {
    const t0 = Date.now(), ch = spawn(cmd, list, { cwd: ROOT, env: { ...process.env, BT_SHOTS_DIR: SHOTS } });
    let out = ''; ch.stdout.on('data', d => out += d); ch.stderr.on('data', d => out += d);
    const kill = setTimeout(() => { out += '\nTIMEOUT after ' + TIMEOUT / 1000 + 's'; ch.kill('SIGKILL'); }, TIMEOUT);
    ch.on('close', code => { clearTimeout(kill); ok({ code, out, s: Math.round((Date.now() - t0) / 1000) }); });
  });
}

const t0 = Date.now();
await mkdir(SHOTS, { recursive: true });
const srv = await serve();
const all = (await readdir(join(ROOT, 'tests'))).filter(f => f.endsWith('.e2e.mjs')).sort();
const e2e = quick ? all.filter(f => words.some(w => f.includes(w))) : all;
if (quick && words.length && !e2e.length) console.log('No e2e script matches: ' + words.join(', '));

const unit = await run(process.execPath, ['--test', ...(await readdir(join(ROOT, 'tests'))).filter(f => f.endsWith('.test.mjs')).map(f => 'tests/' + f)]);
const um = unit.out.match(/# pass (\d+)[\s\S]*# fail (\d+)/);
console.log(`${unit.code ? 'FAIL' : 'ok  '} logic tests${um ? ` · ${um[1]} passed, ${um[2]} failed` : ''} · ${unit.s}s`);
if (unit.code) console.log(unit.out.split('\n').filter(l => /not ok|Error|expected|actual/.test(l)).slice(0, 30).join('\n'));

const results = {}, queue = [...e2e];
async function worker() {
  for (let f; (f = queue.shift());) {
    let r = await run(process.execPath, ['tests/' + f, SHOTS]);
    if (r.code) { const again = await run(process.execPath, ['tests/' + f, SHOTS]); again.retried = true; again.first = r; r = again; }
    results[f] = r;
    console.log(`${r.code ? 'FAIL' : 'ok  '} ${f} · ${r.s}s${r.retried ? (r.code ? ' · failed twice' : ' · passed on retry') : ''}`);
  }
}
await Promise.all(Array.from({ length: Math.min(JOBS, e2e.length) }, worker));

const bad = Object.entries(results).filter(([, r]) => r.code);
for (const [f, r] of bad) console.log(`\n--- ${f}\n` + r.out.split('\n').filter(l => /^FAIL|^ {3,}|Error|TIMEOUT|at file|SYNC WAIT/.test(l)).slice(0, 40).join('\n'));
const flaky = Object.entries(results).filter(([, r]) => r.retried && !r.code).map(([f]) => f);
for (const f of flaky) console.log(`\n--- ${f} first try\n` + results[f].first.out.split('\n').filter(l => /^FAIL|^ {3,}|Error|TIMEOUT|SYNC WAIT/.test(l)).slice(0, 12).join('\n'));
if (flaky.length) console.log('\nPassed on retry: ' + flaky.join(', '));
console.log(`\n${unit.code || bad.length ? 'FAILED' : 'ALL PASSED'} · ${e2e.length} e2e script(s) · ${Math.round((Date.now() - t0) / 1000)}s`);
if (srv) srv.close();
process.exit(unit.code || bad.length ? 1 : 0);
