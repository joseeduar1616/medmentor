const STORAGE_KEY = 'medmentor_data_v1';

async function loadData() {
  const cached = localStorage.getItem(STORAGE_KEY);
  if (cached) return JSON.parse(cached);
  const res = await fetch('./medmentor_data.json');
  const data = await res.json();
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  return data;
}

function saveData() { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }

let state;
const views = ['dashboard', 'planner', 'tasks', 'subjects'];

function switchView(view) {
  views.forEach(v => document.getElementById(v).classList.toggle('hidden', v !== view));
  state.current = view;
  saveData();
}

function applyTheme() {
  document.body.classList.toggle('dark', state.theme === 'dark');
}

function renderDashboard() {
  const done = state.tasks.filter(t => t.status === 'done').length;
  const totalPlanner = state.planner.length;
  const weeklyHours = state.subjects.reduce((a,s)=>a+s.goal,0);
  document.getElementById('dashboard').innerHTML = `
    <h2>Olá, ${state.profile.name}</h2>
    <div class="grid">
      <div class="card"><h3>Meta semanal</h3><div class="kpi">${state.profile.weeklyGoal}h</div></div>
      <div class="card"><h3>Acurácia alvo</h3><div class="kpi">${state.profile.accuracyGoal}%</div></div>
      <div class="card"><h3>Tarefas concluídas</h3><div class="kpi">${done}/${state.tasks.length}</div></div>
      <div class="card"><h3>Blocos no planner</h3><div class="kpi">${totalPlanner}</div></div>
      <div class="card"><h3>Carga planejada</h3><div class="kpi">${weeklyHours}h</div></div>
    </div>`;
}

function renderPlanner() {
  const byDay = [...state.planner].sort((a,b)=>a.start.localeCompare(b.start));
  document.getElementById('planner').innerHTML = '<h2>Planner</h2><div class="grid">' + byDay.map(p=>`
    <div class="card">
      <h4>${p.subject}</h4>
      <div>${p.topic}</div>
      <div class="meta">${new Date(p.start).toLocaleString('pt-BR')} - ${new Date(p.end).toLocaleTimeString('pt-BR')}</div>
      <label><input type="checkbox" data-plan="${p.id}" ${p.done?'checked':''}/> Concluído</label>
    </div>
  `).join('') + '</div>';

  document.querySelectorAll('[data-plan]').forEach(el=>el.addEventListener('change', (e)=>{
    const item = state.planner.find(p=>p.id===e.target.dataset.plan);
    item.done = e.target.checked;
    saveData();
    renderDashboard();
  }));
}

function renderTasks() {
  const root = document.getElementById('tasks');
  root.innerHTML = '<h2>Tarefas</h2><div id="taskList" class="grid"></div>';
  const list = document.getElementById('taskList');
  state.tasks.forEach(t=>{
    const tpl = document.getElementById('taskTpl').content.cloneNode(true);
    tpl.querySelector('.task-title').textContent = t.title;
    tpl.querySelector('.meta').textContent = `${t.type} • prazo ${t.due}`;
    const sel = tpl.querySelector('.task-status');
    sel.value = t.status;
    sel.addEventListener('change', ()=>{t.status = sel.value; saveData(); renderDashboard();});
    list.appendChild(tpl);
  });
}

function renderSubjects() {
  document.getElementById('subjects').innerHTML = '<h2>Matérias</h2><div class="grid">' + state.subjects.map(s=>`
  <div class="card">
    <h3>${s.name}</h3>
    <div class="meta">Meta: ${s.goal}h • Prioridade: ${s.priority} • Peso: ${s.weight}</div>
    <ul>${s.topics.map(t=>`<li>${t}</li>`).join('')}</ul>
  </div>`).join('') + '</div>';
}

function bindEvents() {
  document.querySelectorAll('button[data-view]').forEach(btn=>btn.addEventListener('click', ()=>{
    switchView(btn.dataset.view);
  }));
  document.getElementById('themeToggle').addEventListener('click', ()=>{
    state.theme = state.theme === 'dark' ? 'light' : 'dark';
    applyTheme();
    saveData();
  });
}

(async function init(){
  state = await loadData();
  applyTheme();
  bindEvents();
  renderDashboard(); renderPlanner(); renderTasks(); renderSubjects();
  switchView(state.current || 'dashboard');
})();
