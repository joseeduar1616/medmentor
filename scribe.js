// MedMentor Scribe — transcrição de consulta → prontuário estruturado.
const STORAGE_KEY = 'medmentor_scribe_v1';
const THEME_KEY = 'medmentor_data_v1';
const SDK_URL = 'https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk@0.128.0/+esm';
const EMPTY = 'Não referido';

// ---------- Modelos prontos (baseados em SOAP / anamnese clássica) ----------
const f = (label, hint = '', type = 'long') => ({ label, hint, type });
const BUILTIN_TEMPLATES = [
  {
    id: 'soap', builtin: true, name: 'SOAP (evolução)',
    instructions: 'Formato SOAP clássico, conciso, em tópicos.',
    fields: [
      f('Subjetivo', 'Queixas, sintomas, evolução relatada pelo paciente, adesão ao tratamento'),
      f('Objetivo', 'Sinais vitais, exame físico, resultados de exames citados'),
      f('Avaliação', 'Impressão clínica, hipóteses diagnósticas, estado dos problemas'),
      f('Plano', 'Conduta, prescrições, exames solicitados, orientações, retorno', 'list'),
    ],
  },
  {
    id: 'anamnese', builtin: true, name: 'Anamnese completa (1ª consulta)',
    instructions: 'Anamnese médica completa em português, termos técnicos adequados.',
    fields: [
      f('Identificação', 'Idade, sexo, profissão, procedência (sem nome completo)', 'text'),
      f('Queixa principal', 'Queixa e duração, nas palavras do paciente', 'text'),
      f('HDA', 'História da doença atual: início, características, fatores de melhora/piora, sintomas associados, evolução'),
      f('Interrogatório sintomatológico', 'Revisão de sistemas: sintomas positivos e negativos relevantes'),
      f('Antecedentes pessoais', 'Comorbidades, cirurgias, internações, vacinação'),
      f('Medicações em uso', 'Nome, dose e posologia', 'list'),
      f('Alergias', '', 'text'),
      f('Antecedentes familiares', ''),
      f('Hábitos de vida', 'Tabagismo, etilismo, drogas, atividade física, alimentação, sono'),
      f('Exame físico', 'Estado geral, sinais vitais (PA, FC, FR, Tax, SatO2), exame segmentar'),
      f('Hipóteses diagnósticas', '', 'list'),
      f('Conduta', 'Exames, prescrições, orientações, encaminhamentos, retorno', 'list'),
    ],
  },
  {
    id: 'retorno', builtin: true, name: 'Retorno ambulatorial',
    instructions: 'Consulta de retorno: foque no que mudou desde a última consulta.',
    fields: [
      f('Motivo do retorno', '', 'text'),
      f('Evolução desde a última consulta', 'Sintomas, adesão, efeitos adversos, intercorrências'),
      f('Medicações em uso', '', 'list'),
      f('Exames trazidos', 'Resultados com data e valores', 'list'),
      f('Exame físico', ''),
      f('Avaliação', ''),
      f('Conduta', '', 'list'),
    ],
  },
  {
    id: 'prenatal', builtin: true, name: 'Pré-natal',
    instructions: 'Consulta de pré-natal de risco habitual.',
    fields: [
      f('Dados obstétricos', 'G_P_A_, DUM, IG pela DUM e/ou USG, DPP', 'text'),
      f('Queixas', 'Queixas atuais, movimentação fetal, perdas vaginais, contrações'),
      f('Exame físico', 'PA, peso, AU, BCF, edema, apresentação'),
      f('Exames', 'Laboratoriais e USG com datas', 'list'),
      f('Suplementação e vacinas', '', 'list'),
      f('Avaliação de risco', ''),
      f('Conduta e orientações', '', 'list'),
    ],
  },
  {
    id: 'puericultura', builtin: true, name: 'Puericultura',
    instructions: 'Consulta de puericultura pediátrica.',
    fields: [
      f('Identificação', 'Idade (dias/meses), acompanhante', 'text'),
      f('Queixas / intercorrências', ''),
      f('Alimentação', 'Aleitamento materno, fórmula, introdução alimentar'),
      f('Eliminações e sono', ''),
      f('Desenvolvimento neuropsicomotor', 'Marcos alcançados'),
      f('Vacinação', ''),
      f('Exame físico e antropometria', 'Peso, comprimento, PC e percentis; exame físico'),
      f('Avaliação', ''),
      f('Conduta e orientações', 'Suplementação (ferro, vit. D), orientações, retorno', 'list'),
    ],
  },
];

// ---------- Estado ----------
let db = load();
let lastResult = null;          // {templateId, values:{fid:text}, ...}
let editing = null;             // modelo em edição
const $ = (id) => document.getElementById(id);

function load() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (raw) return { templates: [], history: [], settings: {}, ...raw };
  } catch { /* dados corrompidos → recomeça */ }
  return { templates: [], history: [], settings: { model: 'claude-opus-5' } };
}
function save() { localStorage.setItem(STORAGE_KEY, JSON.stringify(db)); }
const uid = (p) => p + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const allTemplates = () => [...BUILTIN_TEMPLATES, ...db.templates];
const getTemplate = (id) => allTemplates().find((t) => t.id === id);
const todayISO = () => { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 10); };
const fmtDate = (iso) => iso ? iso.split('-').reverse().join('/') : '';
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function toast(msg) {
  const t = document.createElement('div'); t.className = 'toast'; t.textContent = msg;
  document.body.appendChild(t); setTimeout(() => t.remove(), 2200);
}
// Garante ids estáveis nos campos (f1, f2...) para o JSON da IA.
function withIds(tpl) {
  return { ...tpl, fields: tpl.fields.map((fl, i) => ({ ...fl, id: fl.id || 'f' + (i + 1) })) };
}

// ---------- Tema / abas ----------
function applyTheme() {
  let theme = 'dark';
  try { theme = JSON.parse(localStorage.getItem(THEME_KEY))?.theme || theme; } catch {}
  document.body.classList.toggle('dark', theme === 'dark');
}
$('themeToggle').addEventListener('click', () => {
  let d = {}; try { d = JSON.parse(localStorage.getItem(THEME_KEY)) || {}; } catch {}
  d.theme = d.theme === 'light' ? 'dark' : 'light';
  localStorage.setItem(THEME_KEY, JSON.stringify(d)); applyTheme();
});
document.querySelectorAll('nav button[data-tab]').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));
function showTab(tab) {
  document.querySelectorAll('.tab').forEach((s) => s.classList.toggle('hidden', s.id !== tab));
  document.querySelectorAll('nav button[data-tab]').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  if (tab === 'historico') renderHistory();
  if (tab === 'modelos') renderTemplateList();
}

// ================= CONSULTA =================
function renderTemplateSelect() {
  const sel = $('templateSelect'); const cur = sel.value || db.settings.lastTemplate || 'soap';
  sel.innerHTML = `<optgroup label="Prontos">${BUILTIN_TEMPLATES.map((t) => `<option value="${t.id}">${esc(t.name)}</option>`).join('')}</optgroup>` +
    (db.templates.length ? `<optgroup label="Personalizados">${db.templates.map((t) => `<option value="${t.id}">${esc(t.name)}</option>`).join('')}</optgroup>` : '');
  sel.value = getTemplate(cur) ? cur : 'soap';
}
function renderPrevSelect() {
  const p = $('patient').value.trim().toLowerCase();
  const items = db.history.filter((h) => !p || h.patient.toLowerCase() === p).slice(0, 30);
  $('prevSelect').innerHTML = '<option value="">— colar texto abaixo —</option>' +
    items.map((h) => `<option value="${h.id}">${fmtDate(h.date)} · ${esc(h.patient || 's/ nome')} · ${esc(h.templateName)}</option>`).join('');
  $('patientList').innerHTML = [...new Set(db.history.map((h) => h.patient).filter(Boolean))].map((n) => `<option value="${esc(n)}">`).join('');
}
const mode = () => document.querySelector('input[name=mode]:checked').value;
document.querySelectorAll('input[name=mode]').forEach((r) => r.addEventListener('change', () => {
  $('prevBox').classList.toggle('hidden', mode() !== 'update'); renderPrevSelect();
}));
$('patient').addEventListener('change', renderPrevSelect);
$('templateSelect').addEventListener('change', () => { db.settings.lastTemplate = $('templateSelect').value; save(); });
$('prevSelect').addEventListener('change', () => {
  const h = db.history.find((x) => x.id === $('prevSelect').value);
  if (!h) return;
  $('prevText').value = noteToText(h);
  if (getTemplate(h.templateId)) $('templateSelect').value = h.templateId;
  if (!$('patient').value) $('patient').value = h.patient;
});

// ---------- Ditado ao vivo (Web Speech API) ----------
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let rec = null; let recording = false;
$('micBtn').addEventListener('click', () => {
  if (!SR) { $('micStatus').textContent = 'Ditado não suportado neste navegador (use Chrome/Edge).'; return; }
  if (recording) { recording = false; rec.stop(); return; }
  rec = new SR(); rec.lang = 'pt-BR'; rec.continuous = true; rec.interimResults = true;
  const base = $('transcript').value ? $('transcript').value.trimEnd() + '\n' : '';
  let finalText = '';
  rec.onresult = (e) => {
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      if (e.results[i].isFinal) finalText += e.results[i][0].transcript.trim() + '. ';
      else interim += e.results[i][0].transcript;
    }
    $('transcript').value = base + finalText + interim;
  };
  rec.onerror = (e) => { $('micStatus').textContent = 'Erro no microfone: ' + e.error; };
  // O Chrome encerra o reconhecimento após pausas longas; reinicia enquanto estiver gravando.
  rec.onend = () => { if (recording) rec.start(); else { $('micBtn').classList.remove('recording'); $('micBtn').textContent = '🎙️ Ditar ao vivo'; $('micStatus').textContent = ''; } };
  recording = true; rec.start();
  $('micBtn').classList.add('recording'); $('micBtn').textContent = '⏹️ Parar ditado';
  $('micStatus').textContent = 'Ouvindo… (pt-BR)';
});

// ---------- Gerar ----------
$('generateBtn').addEventListener('click', async () => {
  const transcript = $('transcript').value.trim();
  if (!transcript) { toast('Cole ou dite a transcrição primeiro.'); return; }
  const tpl = withIds(getTemplate($('templateSelect').value));
  const isUpdate = mode() === 'update';
  const prevText = isUpdate ? $('prevText').value.trim() : '';
  if (isUpdate && !prevText) { toast('Cole ou escolha a consulta anterior.'); return; }
  const date = $('date').value || todayISO();
  const btn = $('generateBtn'); btn.disabled = true;
  $('genStatus').textContent = db.settings.apiKey ? 'Organizando com IA…' : 'Modo offline (sem chave de API)…';
  try {
    const prevNote = db.history.find((h) => h.id === $('prevSelect').value);
    const values = db.settings.apiKey
      ? await generateWithAI({ tpl, transcript, prevText, date, markChanges: $('markChanges').checked })
      : generateOffline({ tpl, transcript, prevNote, prevText, date });
    lastResult = { templateId: tpl.id, templateName: tpl.name, fields: tpl.fields, values, date, patient: $('patient').value.trim(), transcript, source: isUpdate ? 'update' : 'new' };
    renderOutput();
    $('genStatus').textContent = db.settings.apiKey ? 'Pronto ✔' : 'Pronto (offline — revise com atenção)';
  } catch (err) {
    console.error(err);
    $('genStatus').textContent = 'Erro: ' + (err.message || err);
  } finally { btn.disabled = false; }
});

function renderOutput() {
  const r = lastResult;
  $('outMeta').textContent = `· ${r.templateName} · ${fmtDate(r.date)}${r.patient ? ' · ' + r.patient : ''}`;
  $('output').innerHTML = r.fields.map((fl) => {
    const v = r.values[fl.id] ?? EMPTY;
    return `<div class="field ${v === EMPTY ? 'empty' : ''}">
      <div class="field-head"><strong>${esc(fl.label)}</strong><button class="mini" data-copy="${fl.id}" type="button">copiar</button></div>
      <textarea data-fid="${fl.id}" rows="1">${esc(v)}</textarea></div>`;
  }).join('');
  $('output').querySelectorAll('textarea').forEach((ta) => {
    autosize(ta);
    ta.addEventListener('input', () => { r.values[ta.dataset.fid] = ta.value; autosize(ta); ta.parentElement.classList.toggle('empty', ta.value === EMPTY); });
  });
  $('output').querySelectorAll('[data-copy]').forEach((b) => b.addEventListener('click', () => copy(r.values[b.dataset.copy] || '')));
}
function autosize(ta) { ta.style.height = 'auto'; ta.style.height = ta.scrollHeight + 'px'; }
function noteToText(n) {
  const head = `Data: ${fmtDate(n.date)}${n.patient ? ' — Paciente: ' + n.patient : ''}\n\n`;
  return head + n.fields.map((fl) => `${fl.label.toUpperCase()}:\n${n.values[fl.id] ?? EMPTY}`).join('\n\n');
}
async function copy(text) {
  try { await navigator.clipboard.writeText(text); toast('Copiado!'); }
  catch { toast('Não foi possível copiar automaticamente.'); }
}
$('copyAllBtn').addEventListener('click', () => lastResult ? copy(noteToText(lastResult)) : toast('Gere um prontuário primeiro.'));
$('saveBtn').addEventListener('click', () => {
  if (!lastResult) { toast('Gere um prontuário primeiro.'); return; }
  const entry = { id: uid('h'), ...lastResult, savedAt: new Date().toISOString() };
  db.history.unshift(entry); save(); renderPrevSelect(); toast('Salvo no histórico.');
});

// ---------- IA (Claude) ----------
let sdkPromise = null;
async function client() {
  sdkPromise ||= import(SDK_URL);
  const { default: Anthropic } = await sdkPromise;
  return new Anthropic({ apiKey: db.settings.apiKey, dangerouslyAllowBrowser: true });
}
const SYSTEM_SCRIBE = `Você é um escriba médico (medical scribe) brasileiro. Recebe a transcrição de uma consulta (fala do médico, paciente e acompanhantes, possivelmente com erros de transcrição automática) e redige o registro de prontuário no modelo indicado.

Regras:
- Escreva em português do Brasil, linguagem técnica médica, objetiva e concisa, como um médico escreveria no prontuário.
- Use SOMENTE informações presentes na transcrição (e na consulta anterior, quando fornecida). Nunca invente sinais vitais, doses, resultados ou diagnósticos.
- Se um campo não tiver informação, escreva exatamente "${EMPTY}".
- Corrija erros óbvios de transcrição de termos médicos e nomes de medicamentos (ex.: "losartana 50 mili" → "Losartana 50 mg").
- Ignore conversa social que não tenha relevância clínica.
- Campos do tipo "list" devem ser escritos como itens, um por linha, iniciados por "- ".
- Não use markdown (sem **, sem #).`;

async function generateWithAI({ tpl, transcript, prevText, date, markChanges }) {
  const fieldSpec = tpl.fields.map((fl) => `- ${fl.id} → "${fl.label}"${fl.hint ? ` (orientação: ${fl.hint})` : ''} [tipo: ${fl.type}]`).join('\n');
  let task = `Data da consulta atual: ${fmtDate(date)}.\nModelo: ${tpl.name}\n${tpl.instructions ? 'Instruções do modelo: ' + tpl.instructions + '\n' : ''}\nCampos (id → rótulo):\n${fieldSpec}\n\n`;
  if (prevText) {
    task += `MODO ATUALIZAÇÃO: abaixo está a consulta anterior do mesmo paciente. Gere o registro da consulta de HOJE (${fmtDate(date)}):
- Mantenha os dados que continuam válidos (antecedentes, alergias, medicações que não mudaram etc.).
- Substitua/atualize o que a nova transcrição modificar (novas queixas, novo exame físico, novos exames, mudanças de dose, nova conduta).
- Informações da consulta anterior que são do momento (sinais vitais, exame físico, queixas daquele dia) NÃO devem ser copiadas como se fossem de hoje; se relevante, cite como "Na consulta anterior: ...".
${markChanges ? '- Marque com "▲ " no início cada linha/trecho que é novo ou mudou em relação à consulta anterior.\n' : ''}
<consulta_anterior>
${prevText}
</consulta_anterior>

`;
  }
  task += `<transcricao>\n${transcript}\n</transcricao>\n\nPreencha todos os campos.`;

  const schema = {
    type: 'object',
    properties: Object.fromEntries(tpl.fields.map((fl) => [fl.id, { type: 'string', description: fl.label }])),
    required: tpl.fields.map((fl) => fl.id),
    additionalProperties: false,
  };
  return callJSON(SYSTEM_SCRIBE, task, schema);
}

async function callJSON(system, userText, schema) {
  const c = await client();
  const model = db.settings.model || 'claude-opus-5';
  const params = {
    model,
    max_tokens: 16000,
    system,
    messages: [{ role: 'user', content: userText }],
    output_config: { format: { type: 'json_schema', schema } },
  };
  // Haiku 4.5 não usa pensamento adaptativo; nos demais ele já é o padrão.
  if (model !== 'claude-haiku-4-5') {
    params.thinking = { type: 'adaptive' };
    // Se o modelo recusar por política, a API reencaminha para o modelo de fallback recomendado.
    params.betas = ['server-side-fallback-2026-07-01'];
    params.fallbacks = 'default';
  }
  let msg;
  try {
    msg = await (params.betas ? c.beta.messages : c.messages).stream(params).finalMessage();
  } catch (err) {
    if (err?.status === 401) throw new Error('Chave de API inválida. Verifique em Configurações.');
    if (err?.status === 429) throw new Error('Limite de uso da API atingido. Aguarde um pouco e tente de novo.');
    throw new Error(err?.error?.error?.message || err.message || 'Falha ao chamar a IA.');
  }
  if (msg.stop_reason === 'refusal') throw new Error('A IA recusou o pedido. Revise o texto e tente novamente.');
  if (msg.stop_reason === 'max_tokens') throw new Error('Resposta muito longa e foi cortada. Tente dividir a transcrição.');
  const text = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  return JSON.parse(text);
}

// ---------- Modo offline (heurística por palavras-chave) ----------
const KEYWORDS = {
  queixa: ['queixa', 'dor', 'sente', 'sentindo', 'incomoda', 'veio', 'motivo', 'reclama', 'sintoma'],
  hda: ['começou', 'comecou', 'há ', 'ha ', 'dias', 'semanas', 'meses', 'piora', 'melhora', 'desde', 'iniciou', 'evolui', 'febre', 'tosse', 'náusea', 'vômito', 'diarreia'],
  medic: ['mg', 'toma', 'tomando', 'comprimido', 'remédio', 'remedio', 'medicação', 'medicacao', 'uso de', 'insulina', 'losartana', 'metformina', 'dose', 'posologia'],
  alergia: ['alergia', 'alérgic', 'alergic'],
  antecedente: ['hipertens', 'diabet', 'cirurgia', 'operou', 'internação', 'internado', 'comorbidade', 'antecedente', 'has', 'dm'],
  familia: ['pai', 'mãe', 'mae', 'irmão', 'irma', 'avó', 'avô', 'família', 'familia', 'familiar'],
  habito: ['fuma', 'cigarro', 'tabag', 'bebe', 'álcool', 'alcool', 'etilis', 'exercício', 'academia', 'caminhada', 'dorme', 'sono', 'dieta', 'alimenta'],
  exame: ['pa ', 'pressão', 'pressao', 'fc ', 'frequência', 'saturação', 'satur', 'ausculta', 'murmúrio', 'bulhas', 'abdome', 'palpação', 'temperatura', 'peso', 'altura', 'imc', 'bcf', 'altura uterina', 'exame físico', 'ao exame'],
  lab: ['hemograma', 'glicemia', 'hba1c', 'creatinina', 'colesterol', 'resultado', 'ultrassom', 'usg', 'raio', 'tomografia', 'exame de sangue', 'urina'],
  hipotese: ['hipótese', 'hipotese', 'diagnóstico', 'diagnostico', 'provável', 'provavel', 'suspeita', 'acho que é', 'parece'],
  conduta: ['vou passar', 'vou pedir', 'prescrev', 'receita', 'solicito', 'pedir', 'retorno', 'voltar', 'orient', 'encaminh', 'manter', 'aumentar', 'suspender', 'iniciar', 'conduta'],
};
const LABEL_TO_GROUPS = [
  [/queixa|motivo|subjetiv/i, ['queixa', 'hda']],
  [/hda|hist[oó]ria|evolu[cç]/i, ['hda', 'queixa']],
  [/medica|prescri[cç][aã]o em uso|em uso/i, ['medic']],
  [/alergi/i, ['alergia']],
  [/antecedentes? pessoa|comorbid|patol[oó]gic/i, ['antecedente']],
  [/famil/i, ['familia']],
  [/h[aá]bito|estilo de vida|social/i, ['habito']],
  [/exame f[ií]sico|objetiv|antropometr|sinais vitais/i, ['exame']],
  [/exames|laborat|complementar/i, ['lab']],
  [/hip[oó]tese|diagn[oó]stic|avalia[cç]|impress/i, ['hipotese']],
  [/conduta|plano|orienta|prescri/i, ['conduta']],
];
function fieldGroups(fl) {
  for (const [re, g] of LABEL_TO_GROUPS) if (re.test(fl.label)) return g;
  return [];
}
function generateOffline({ tpl, transcript, prevNote, prevText, date }) {
  const sentences = transcript.replace(/\s+/g, ' ').split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter((s) => s.length > 3);
  const buckets = Object.fromEntries(tpl.fields.map((fl) => [fl.id, []]));
  const extraWords = Object.fromEntries(tpl.fields.map((fl) => [fl.id, (fl.label + ' ' + fl.hint).toLowerCase().split(/[^a-zà-ú0-9]+/).filter((w) => w.length > 3)]));
  const fallbackField = tpl.fields.find((fl) => /hda|subjetiv|evolu|queixa/i.test(fl.label)) || tpl.fields[0];
  for (const s of sentences) {
    const low = ' ' + s.toLowerCase() + ' ';
    let best = null; let bestScore = 0;
    for (const fl of tpl.fields) {
      let score = 0;
      for (const g of fieldGroups(fl)) for (const kw of KEYWORDS[g]) if (low.includes(kw)) score += g === 'familia' ? 3 : 2;
      for (const w of extraWords[fl.id]) if (low.includes(w)) score += 1;
      if (score > bestScore) { bestScore = score; best = fl; }
    }
    buckets[(best || fallbackField).id].push(s);
  }
  // Em atualização offline: parte da consulta anterior do histórico (mesmo modelo) e acrescenta o novo.
  const prevValues = prevNote && prevNote.templateId === tpl.id ? prevNote.values : null;
  const values = {};
  for (const fl of tpl.fields) {
    const now = buckets[fl.id];
    const nowText = fl.type === 'list' ? now.map((s) => '- ' + s).join('\n') : now.join(' ');
    const prev = prevValues?.[fl.id];
    // Dados "do dia" (queixa, exame físico) não são herdados da consulta anterior.
    const ofTheDay = /queixa|subjetiv|objetiv|exame f[ií]sico|sinais vitais|motivo/i.test(fl.label);
    if (prev && prev !== EMPTY && !ofTheDay) values[fl.id] = now.length ? `${prev}\n▲ Atualização ${fmtDate(date)}: ${nowText}` : prev;
    else values[fl.id] = nowText || EMPTY;
  }
  if (prevText && !prevValues) {
    values[fallbackField.id] = `Consulta anterior (resumo colado):\n${prevText.slice(0, 1500)}\n\n▲ ${fmtDate(date)}: ${values[fallbackField.id]}`;
  }
  return values;
}

// ================= MODELOS =================
function renderTemplateList() {
  $('templateList').innerHTML = allTemplates().map((t) => `
    <div class="list-item ${editing?.id === t.id ? 'selected' : ''}">
      <div><strong>${esc(t.name)}</strong><div class="meta">${t.fields.length} campos${t.builtin ? ' · pronto' : ' · personalizado'}</div></div>
      <div class="actions">
        <button class="mini" data-edit="${t.id}" type="button">${t.builtin ? 'Duplicar' : 'Editar'}</button>
        <button class="mini" data-use="${t.id}" type="button">Usar</button>
        ${t.builtin ? '' : `<button class="mini danger" data-del="${t.id}" type="button">Excluir</button>`}
      </div>
    </div>`).join('');
  $('templateList').querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => {
    const t = structuredClone(getTemplate(b.dataset.edit));
    if (t.builtin) { t.id = null; t.builtin = false; t.name += ' (minha versão)'; }
    openEditor(t);
  }));
  $('templateList').querySelectorAll('[data-use]').forEach((b) => b.addEventListener('click', () => {
    renderTemplateSelect(); $('templateSelect').value = b.dataset.use; showTab('consulta');
  }));
  $('templateList').querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', () => {
    if (!confirm('Excluir este modelo?')) return;
    db.templates = db.templates.filter((t) => t.id !== b.dataset.del); save();
    if (editing?.id === b.dataset.del) { editing = null; renderEditor(); }
    renderTemplateList(); renderTemplateSelect();
  }));
}
function openEditor(tpl) {
  editing = { id: null, name: '', instructions: '', fields: [], ...tpl };
  editing.fields = editing.fields.map((fl) => ({ ...fl }));
  renderEditor(); renderTemplateList();
  $('editorCard').scrollIntoView({ behavior: 'smooth' });
}
function renderEditor() {
  const box = $('fieldEditor');
  if (!editing) { box.innerHTML = '<p class="meta">Selecione um modelo à esquerda, crie um novo, ou detecte a partir de um texto.</p>'; $('tplName').value = ''; $('tplInstructions').value = ''; return; }
  $('tplName').value = editing.name; $('tplInstructions').value = editing.instructions || '';
  box.innerHTML = editing.fields.map((fl, i) => `
    <div class="fe-row" data-i="${i}">
      <div class="fe-move"><button type="button" data-up="${i}" title="Subir">▲</button><button type="button" data-down="${i}" title="Descer">▼</button></div>
      <input data-k="label" value="${esc(fl.label)}" placeholder="Nome do campo (ex.: HDA)" />
      <textarea data-k="hint" rows="1" placeholder="Orientação p/ a IA (opcional)">${esc(fl.hint)}</textarea>
      <select data-k="type">
        <option value="text" ${fl.type === 'text' ? 'selected' : ''}>Linha curta</option>
        <option value="long" ${fl.type === 'long' ? 'selected' : ''}>Texto</option>
        <option value="list" ${fl.type === 'list' ? 'selected' : ''}>Lista (tópicos)</option>
      </select>
      <button type="button" class="danger" data-rm="${i}" title="Remover campo">✕</button>
    </div>`).join('') || '<p class="meta">Nenhum campo. Clique em “+ Campo”.</p>';
  box.querySelectorAll('.fe-row').forEach((row) => {
    const fl = editing.fields[row.dataset.i];
    row.querySelectorAll('[data-k]').forEach((inp) => inp.addEventListener('input', () => { fl[inp.dataset.k] = inp.value; }));
  });
  const move = (i, d) => { const j = i + d; if (j < 0 || j >= editing.fields.length) return; [editing.fields[i], editing.fields[j]] = [editing.fields[j], editing.fields[i]]; renderEditor(); };
  box.querySelectorAll('[data-up]').forEach((b) => b.addEventListener('click', () => move(+b.dataset.up, -1)));
  box.querySelectorAll('[data-down]').forEach((b) => b.addEventListener('click', () => move(+b.dataset.down, 1)));
  box.querySelectorAll('[data-rm]').forEach((b) => b.addEventListener('click', () => { editing.fields.splice(+b.dataset.rm, 1); renderEditor(); }));
}
$('tplName').addEventListener('input', () => { if (editing) editing.name = $('tplName').value; });
$('tplInstructions').addEventListener('input', () => { if (editing) editing.instructions = $('tplInstructions').value; });
$('newTemplateBtn').addEventListener('click', () => openEditor({ name: 'Novo modelo', fields: [f('Queixa principal', '', 'text'), f('HDA'), f('Conduta', '', 'list')] }));
$('addFieldBtn').addEventListener('click', () => {
  if (!editing) openEditor({ name: 'Novo modelo', fields: [] });
  editing.fields.push(f('', '', 'long')); renderEditor();
  const inputs = $('fieldEditor').querySelectorAll('input[data-k=label]'); inputs[inputs.length - 1]?.focus();
});
$('saveTemplateBtn').addEventListener('click', () => {
  if (!editing) return;
  editing.fields = editing.fields.filter((fl) => fl.label.trim());
  if (!editing.name.trim()) { toast('Dê um nome ao modelo.'); return; }
  if (!editing.fields.length) { toast('Adicione pelo menos um campo.'); return; }
  // Ids recalculados para refletir a ordem atual; notas antigas guardam sua própria cópia dos campos.
  const tpl = { id: editing.id || uid('tpl'), name: editing.name.trim(), instructions: editing.instructions || '', fields: editing.fields.map(({ label, hint, type }, i) => ({ id: 'f' + (i + 1), label: label.trim(), hint: hint || '', type: type || 'long' })) };
  const idx = db.templates.findIndex((t) => t.id === tpl.id);
  if (idx >= 0) db.templates[idx] = tpl; else db.templates.push(tpl);
  editing = structuredClone(tpl); save();
  renderTemplateList(); renderTemplateSelect(); renderEditor(); toast('Modelo salvo!');
});

// Detecta campos num modelo colado em texto livre.
function parseTemplateText(raw) {
  const fields = []; let current = null;
  const push = (label, hint = '') => {
    label = label.replace(/^[#*\-•\d.)\s]+/, '').replace(/[*_:]+$/g, '').trim();
    if (!label || label.length > 70) return;
    label = (label.charAt(0).toUpperCase() + label.slice(1).toLowerCase()).replace(/\b(hda|hma|pa|fc|fr|imc|sus|dum|dpp|ig|usg|bcf|au|hd|isda)\b/gi, (m) => m.toUpperCase());
    current = { label, hint: hint.trim(), type: 'long' };
    if (/medica|conduta|plano|hip[oó]tese|exames|prescri|orienta/i.test(label)) current.type = 'list';
    if (/identifica|queixa principal|alergi|dados/i.test(label) && !hint) current.type = 'text';
    fields.push(current);
  };
  for (const line of raw.split('\n')) {
    const t = line.trim(); if (!t) continue;
    let m;
    if ((m = t.match(/^#{1,6}\s+(.+)$/))) push(m[1]);
    else if ((m = t.match(/^(?:[-*•]\s*)?\**([A-Za-zÀ-ú][^:]{0,60}?)\**\s*:\s*(.*)$/))) push(m[1], m[2].replace(/\[\s*\]|_{2,}/g, '').trim());
    else if (t.length <= 60 && /[A-ZÀ-Ú]{3}/.test(t) && t === t.toUpperCase()) push(t);
    else if ((m = t.match(/^\[([^\]]+)\]$|^\{\{([^}]+)\}\}$/))) push(m[1] || m[2]);
    else if (current) current.hint = (current.hint ? current.hint + '; ' : '') + t;  // linha de conteúdo → orientação do campo acima
    else push('Texto livre', t);
  }
  // Placeholders inline [campo] / {{campo}} quando não há estrutura de títulos.
  if (fields.length <= 1) for (const m of raw.matchAll(/\[([^\]\n]{2,40})\]|\{\{([^}\n]{2,40})\}\}/g)) push(m[1] || m[2]);
  return fields.map((fl) => ({ ...fl, hint: fl.hint.slice(0, 300) }));
}
$('parseLocalBtn').addEventListener('click', () => {
  const raw = $('rawTemplate').value.trim();
  if (!raw) { toast('Cole o texto do modelo primeiro.'); return; }
  const fields = parseTemplateText(raw);
  $('parseStatus').textContent = `${fields.length} campos detectados — ajuste abaixo.`;
  openEditor({ name: editing?.name && !editing.id ? editing.name : 'Meu modelo', instructions: '', fields });
});
$('parseAiBtn').addEventListener('click', async () => {
  const raw = $('rawTemplate').value.trim();
  if (!raw) { toast('Cole o texto do modelo primeiro.'); return; }
  if (!db.settings.apiKey) { toast('Configure a chave da API (ou use “Detectar campos”).'); showTab('config'); return; }
  const btn = $('parseAiBtn'); btn.disabled = true; $('parseStatus').textContent = 'Analisando o modelo com IA…';
  try {
    const schema = {
      type: 'object', additionalProperties: false, required: ['name', 'instructions', 'fields'],
      properties: {
        name: { type: 'string' },
        instructions: { type: 'string' },
        fields: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['label', 'hint', 'type'],
          properties: { label: { type: 'string' }, hint: { type: 'string' }, type: { type: 'string', enum: ['text', 'long', 'list'] } } } },
      },
    };
    const out = await callJSON(
      'Você ajuda médicos brasileiros a transformar um roteiro/modelo de consulta em campos estruturados de prontuário. Preserve a ordem e os nomes das seções do modelo. Para cada seção crie um campo com: label (nome curto da seção como no modelo), hint (o que deve ser registrado ali, incluindo subitens, exemplos e formato esperado que aparecem no modelo), type ("text" para linha curta, "long" para texto corrido, "list" para itens). Em instructions, resuma regras gerais de estilo que o modelo sugere (ou string vazia). Em name, sugira um nome curto para o modelo.',
      `<modelo>\n${raw}\n</modelo>`, schema);
    openEditor({ name: out.name, instructions: out.instructions, fields: out.fields });
    $('parseStatus').textContent = `${out.fields.length} campos criados pela IA — ajuste abaixo.`;
  } catch (err) { $('parseStatus').textContent = 'Erro: ' + err.message; }
  finally { btn.disabled = false; }
});

// ================= HISTÓRICO =================
function renderHistory() {
  const q = $('histSearch').value.trim().toLowerCase();
  const items = db.history.filter((h) => !q || (h.patient || '').toLowerCase().includes(q));
  $('histList').innerHTML = items.map((h) => `
    <div class="list-item">
      <div><strong>${esc(h.patient || 'Sem identificação')}</strong>
        <div class="meta">${fmtDate(h.date)} · ${esc(h.templateName)}${h.source === 'update' ? ' · atualização' : ''}</div></div>
      <div class="actions">
        <button class="mini" data-open="${h.id}" type="button">Abrir</button>
        <button class="mini primary" data-upd="${h.id}" type="button">Nova consulta a partir desta</button>
        <button class="mini" data-cp="${h.id}" type="button">Copiar</button>
        <button class="mini danger" data-rmh="${h.id}" type="button">Excluir</button>
      </div>
    </div>`).join('') || '<p class="meta">Nenhuma consulta salva.</p>';
  const byId = (id) => db.history.find((h) => h.id === id);
  $('histList').querySelectorAll('[data-open]').forEach((b) => b.addEventListener('click', () => {
    const h = byId(b.dataset.open);
    lastResult = structuredClone(h); delete lastResult.id; delete lastResult.savedAt;
    $('patient').value = h.patient || ''; renderOutput(); showTab('consulta');
    $('outputCard').scrollIntoView({ behavior: 'smooth' });
  }));
  $('histList').querySelectorAll('[data-upd]').forEach((b) => b.addEventListener('click', () => {
    const h = byId(b.dataset.upd);
    $('patient').value = h.patient || ''; $('date').value = todayISO();
    document.querySelector('input[name=mode][value=update]').checked = true;
    $('prevBox').classList.remove('hidden'); renderPrevSelect();
    $('prevSelect').value = h.id; $('prevSelect').dispatchEvent(new Event('change'));
    $('transcript').value = ''; showTab('consulta'); $('transcript').focus();
    toast('Cole a transcrição de hoje e clique em Gerar.');
  }));
  $('histList').querySelectorAll('[data-cp]').forEach((b) => b.addEventListener('click', () => copy(noteToText(byId(b.dataset.cp)))));
  $('histList').querySelectorAll('[data-rmh]').forEach((b) => b.addEventListener('click', () => {
    if (!confirm('Excluir esta consulta do histórico?')) return;
    db.history = db.history.filter((h) => h.id !== b.dataset.rmh); save(); renderHistory(); renderPrevSelect();
  }));
}
$('histSearch').addEventListener('input', renderHistory);

// ================= CONFIG =================
function renderConfig() {
  $('apiKey').value = db.settings.apiKey || '';
  $('aiModel').value = db.settings.model || 'claude-opus-5';
}
$('saveConfigBtn').addEventListener('click', () => {
  db.settings.apiKey = $('apiKey').value.trim(); db.settings.model = $('aiModel').value; save();
  $('configStatus').textContent = db.settings.apiKey ? 'Salvo — IA ativada.' : 'Salvo — modo offline.';
});
$('exportBtn').addEventListener('click', () => {
  const { settings, ...rest } = db;   // não exporta a chave da API
  const blob = new Blob([JSON.stringify({ ...rest, settings: { model: settings.model } }, null, 2)], { type: 'application/json' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `medmentor-scribe-${todayISO()}.json`; a.click();
  URL.revokeObjectURL(a.href);
});
$('importInput').addEventListener('change', async (e) => {
  const file = e.target.files[0]; if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    db.templates = [...db.templates, ...(data.templates || []).filter((t) => !db.templates.some((x) => x.id === t.id))];
    db.history = [...(data.history || []).filter((h) => !db.history.some((x) => x.id === h.id)), ...db.history].sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    save(); renderTemplateSelect(); renderPrevSelect(); toast('Backup importado.');
  } catch { toast('Arquivo inválido.'); }
  e.target.value = '';
});
$('wipeBtn').addEventListener('click', () => {
  if (!confirm('Apagar TODOS os modelos, histórico e a chave da API deste navegador?')) return;
  localStorage.removeItem(STORAGE_KEY); db = load(); lastResult = null; editing = null;
  renderAll(); $('output').innerHTML = '<p class="meta">Nenhum prontuário gerado ainda.</p>'; toast('Dados apagados.');
});

// ================= INIT =================
function renderAll() { renderTemplateSelect(); renderPrevSelect(); renderConfig(); renderTemplateList(); renderEditor(); }
applyTheme();
$('date').value = todayISO();
renderAll();
