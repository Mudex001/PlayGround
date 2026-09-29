import { createServer } from 'node:http';
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = resolve(fileURLToPath(new URL('.', import.meta.url)));
const PUBLIC_DIR = join(__dir, 'public');
const DATA_FILE = join(__dir, 'data', 'tasks.json');
const PORT = Number(process.env.PORT || 3000);

mkdirSync(join(__dir, 'data'), { recursive: true });
if (!existsSync(DATA_FILE)) {
  writeFileSync(DATA_FILE, JSON.stringify([
    { id: 'seed-1', title: 'Explore the TaskBoard API', completed: false, createdAt: new Date().toISOString() },
    { id: 'seed-2', title: 'Add your first task below', completed: false, createdAt: new Date().toISOString() },
    { id: 'seed-3', title: 'Toggle a task complete', completed: true, createdAt: new Date().toISOString() }
  ], null, 2));
}

function loadTasks() {
  try {
    return JSON.parse(readFileSync(DATA_FILE, 'utf8'));
  } catch {
    return [];
  }
}
function saveTasks(tasks) {
  writeFileSync(DATA_FILE, JSON.stringify(tasks, null, 2));
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json'
};

function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolveBody, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 1_000_000) reject(new Error('Body too large'));
    });
    req.on('end', () => resolveBody(data));
    req.on('error', reject);
  });
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', 'http://localhost');
    const pathname = url.pathname;

    // --- API ---
    if (pathname === '/api/health') {
      return sendJson(res, 200, { ok: true, time: new Date().toISOString() });
    }
    if (pathname === '/api/tasks' && req.method === 'GET') {
      return sendJson(res, 200, { tasks: loadTasks() });
    }
    if (pathname === '/api/stats' && req.method === 'GET') {
      const tasks = loadTasks();
      const completed = tasks.filter((t) => t.completed).length;
      return sendJson(res, 200, { total: tasks.length, completed, open: tasks.length - completed });
    }
    if (pathname === '/api/tasks' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const title = String(body.title || '').trim().slice(0, 200);
      if (!title) return sendJson(res, 400, { error: 'Title is required' });
      const tasks = loadTasks();
      const task = { id: `t-${Date.now()}-${Math.floor(Math.random() * 1e6)}`, title, completed: false, createdAt: new Date().toISOString() };
      tasks.unshift(task);
      saveTasks(tasks);
      return sendJson(res, 201, { task });
    }
    const match = pathname.match(/^\/api\/tasks\/([^/]+)$/);
    if (match) {
      const id = decodeURIComponent(match[1]);
      const tasks = loadTasks();
      const idx = tasks.findIndex((t) => t.id === id);
      if (req.method === 'PUT') {
        if (idx === -1) return sendJson(res, 404, { error: 'Not found' });
        const body = JSON.parse((await readBody(req)) || '{}');
        if (typeof body.title === 'string') tasks[idx].title = body.title.trim().slice(0, 200) || tasks[idx].title;
        if (typeof body.completed === 'boolean') tasks[idx].completed = body.completed;
        saveTasks(tasks);
        return sendJson(res, 200, { task: tasks[idx] });
      }
      if (req.method === 'DELETE') {
        if (idx === -1) return sendJson(res, 404, { error: 'Not found' });
        const [removed] = tasks.splice(idx, 1);
        saveTasks(tasks);
        return sendJson(res, 200, { task: removed });
      }
      return sendJson(res, 405, { error: 'Method not allowed' });
    }

    // --- Static ---
    let rel = decodeURIComponent(pathname);
    if (rel === '/') rel = '/index.html';
    const safe = normalize(rel).replace(/^(\.\.[/\\])+/, '');
    const file = join(PUBLIC_DIR, safe);
    if (file !== PUBLIC_DIR && !file.startsWith(PUBLIC_DIR + '/')) {
      res.writeHead(404); res.end('Not found'); return;
    }
    let target = file;
    try {
      const st = await import('node:fs/promises').then((m) => m.stat(target));
      if (st.isDirectory()) target = join(target, 'index.html');
    } catch {
      // fall through to read attempt which 404s
    }
    const content = readFileSync(target);
    res.writeHead(200, {
      'Content-Type': MIME[extname(target)] || 'application/octet-stream',
      'Cache-Control': 'no-cache'
    });
    res.end(content);
  } catch (err) {
    if (req.url?.startsWith('/api/')) return sendJson(res, 500, { error: 'Internal error' });
    try {
      const fallback = readFileSync(join(PUBLIC_DIR, 'index.html'));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.end(fallback);
    } catch {
      res.writeHead(500); res.end('Server error');
    }
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`TaskBoard fullstack server listening on :${PORT}, serving ${PUBLIC_DIR}`);
});
