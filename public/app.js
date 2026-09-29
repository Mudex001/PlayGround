const list = document.getElementById('task-list');
const form = document.getElementById('task-form');
const input = document.getElementById('task-input');
const empty = document.getElementById('empty');
const refreshBtn = document.getElementById('refresh');
let filter = 'all';
let tasks = [];

async function api(path, opts) {
  const res = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...opts });
  if (!res.ok) throw new Error(`API ${res.status}`);
  return res.json();
}

async function refresh() {
  const data = await api('/api/tasks');
  tasks = data.tasks || [];
  render();
  const stats = await api('/api/stats').catch(() => null);
  if (stats) {
    document.getElementById('stat-total').textContent = stats.total;
    document.getElementById('stat-open').textContent = stats.open;
    document.getElementById('stat-done').textContent = stats.completed;
  }
}

function render() {
  const visible = tasks.filter((t) =>
    filter === 'all' ? true : filter === 'open' ? !t.completed : t.completed
  );
  empty.hidden = visible.length !== 0;
  list.innerHTML = '';
  for (const t of visible) {
    const li = document.createElement('li');
    li.className = 'task' + (t.completed ? ' done' : '');
    const toggle = document.createElement('button');
    toggle.className = 'icon-btn';
    toggle.textContent = t.completed ? '↩' : '✓';
    toggle.title = t.completed ? 'Mark open' : 'Mark done';
    toggle.onclick = async () => {
      await api(`/api/tasks/${encodeURIComponent(t.id)}`, {
        method: 'PUT',
        body: JSON.stringify({ completed: !t.completed })
      });
      await refresh();
    };
    const span = document.createElement('span');
    span.className = 'title';
    span.textContent = t.title;
    const del = document.createElement('button');
    del.className = 'icon-btn';
    del.textContent = '✕';
    del.title = 'Delete';
    del.onclick = async () => {
      await api(`/api/tasks/${encodeURIComponent(t.id)}`, { method: 'DELETE' });
      await refresh();
    };
    li.append(toggle, span, del);
    list.append(li);
  }
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const title = input.value.trim();
  if (!title) return;
  input.value = '';
  await api('/api/tasks', { method: 'POST', body: JSON.stringify({ title }) });
  await refresh();
});

document.querySelectorAll('.chip').forEach((chip) => {
  chip.addEventListener('click', () => {
    document.querySelectorAll('.chip').forEach((c) => c.classList.remove('active'));
    chip.classList.add('active');
    filter = chip.dataset.filter;
    render();
  });
});

refreshBtn.addEventListener('click', refresh);

(async () => {
  try {
    const h = await api('/api/health');
    document.getElementById('api-status').textContent = `API online · ${h.time}`;
    const pill = document.getElementById('health-pill');
    pill.textContent = '● API online';
    pill.classList.add('ok');
  } catch {
    document.getElementById('api-status').textContent = 'API unreachable';
  }
  await refresh().catch(() => {
    document.getElementById('api-status').textContent = 'Failed to load tasks';
  });
  setInterval(refresh, 15000);
})();
