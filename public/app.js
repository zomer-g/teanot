import { marked } from '/vendor/marked.js';
import DOMPurify from '/vendor/purify.js';

marked.setOptions({ breaks: true, gfm: true });
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  }
});

// ---------- Helpers ----------

function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value == null || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'text') el.textContent = value;
    else if (key === 'svg') el.innerHTML = value; // trusted static icons only
    else if (key.startsWith('on')) el.addEventListener(key.slice(2).toLowerCase(), value);
    else el.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    el.append(child instanceof Node ? child : String(child));
  }
  return el;
}

const svg = (inner, extra = '') =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" ${extra}>${inner}</svg>`;
const ICONS = {
  attach: svg('<path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/>'),
  send: svg('<path d="m5 12 7-7 7 7"/><path d="M12 19V5"/>'),
  stop: svg('<rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor"/>'),
  file: svg('<path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/><path d="M14 2v6h6"/>'),
  trash: svg('<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>'),
  plus: svg('<path d="M12 5v14M5 12h14"/>'),
};

const markdown = (text) => DOMPurify.sanitize(marked.parse(text || ''));
const fmtDate = (value) => {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? String(value) : d.toLocaleDateString('he-IL');
};
const fmtNumber = (n) => (n == null ? null : Number(n).toLocaleString('he-IL', { maximumFractionDigits: 1 }));
const fmtTokens = (n) => {
  if (n == null) return '—';
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}K`;
  return String(Math.round(n));
};

const DOC_TYPES = {
  indictment: 'כתב אישום',
  amended_indictment: 'כתב אישום מתוקן',
  verdict: 'הכרעת דין',
  sentencing_decision: 'גזר דין',
  other: 'מסמך אחר',
};
const COUNT_STATUS = { charged: 'באישום', convicted: 'הורשע', acquitted: 'זוכה' };
const ACCEPTED_EXT = ['.pdf', '.docx', '.txt'];
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const PASTED_DOCUMENT_CHARS = 1500;

// following = id of a conversation whose turn is still running on the server after the stream was lost.
const state = { me: null, conversations: [], currentId: null, busy: false, controller: null, following: null, file: null };
const root = document.getElementById('root');
let ui = {};

// ---------- Boot ----------

async function boot() {
  let me;
  try {
    me = await (await fetch('/api/me')).json();
  } catch {
    return renderGate('השרת אינו זמין', 'לא ניתן היה להתחבר לשרת. נסו לרענן את הדף.');
  }
  if (!me.authenticated) {
    return renderGate('כניסה למערכת', 'המערכת זמינה למשתמשים מורשים בלבד. יש להתחבר עם חשבון Google.',
      h('a', { class: 'btn btn-accent', href: me.loginUrl }, 'התחברות'));
  }
  state.me = me;
  renderHeader();
  if (me.user.status === 'pending') {
    return renderGate('הבקשה ממתינה לאישור', `התחברת כ-${me.user.email}. מנהל המערכת יאשר את הגישה, ואז ניתן יהיה להתחיל.`,
      h('a', { class: 'btn btn-secondary', href: me.logoutUrl }, 'התנתקות'));
  }
  if (me.user.status !== 'active') {
    return renderGate('הגישה אינה פעילה', 'הגישה לחשבון זה הושבתה. לפרטים ניתן לפנות למנהל המערכת.',
      h('a', { class: 'btn btn-secondary', href: me.logoutUrl }, 'התנתקות'));
  }
  renderApp();
  renderQuota(me.quota);
  await loadConversations();
  const match = location.hash.match(/^#c=([0-9a-f-]{36})$/i);
  if (match) openConversation(match[1]);
}

function renderGate(title, body, action) {
  root.replaceChildren(h('div', { class: 'gate' },
    h('div', { class: 'gate-card' },
      h('img', { src: '/icon.svg', alt: '' }),
      h('h1', { text: title }),
      h('p', { text: body }),
      action)));
}

function renderHeader() {
  const { user, logoutUrl } = state.me;
  const actions = document.getElementById('headerActions');
  actions.replaceChildren(...[
    h('span', { class: 'user-chip', title: user.email, text: user.name || user.email }),
    user.role === 'admin' ? h('a', { class: 'btn btn-ghost btn-sm', href: '/admin' }, 'ניהול') : null,
    h('a', { class: 'btn btn-secondary btn-sm', href: logoutUrl }, 'התנתקות'),
  ].filter(Boolean));
}

// ---------- Layout ----------

function renderApp() {
  const conversationList = h('ul', { class: 'conv-list', 'aria-label': 'שיחות קודמות' });
  const quota = h('div', { class: 'quota' });
  const sidebar = h('aside', { class: 'sidebar' },
    h('div', { class: 'sidebar-top' },
      h('button', { class: 'btn btn-accent', type: 'button', onClick: newConversation, svg: '' },
        h('span', { svg: ICONS.plus, style: 'display:inline-flex;width:18px;height:18px' }), 'שיחה חדשה')),
    conversationList,
    quota);

  const threadInner = h('div', { class: 'thread-inner' });
  const thread = h('div', { class: 'thread' }, threadInner);

  const fileInput = h('input', { type: 'file', accept: ACCEPTED_EXT.join(','), hidden: true, onChange: (e) => attachFile(e.target.files[0]) });
  const attachment = h('div', { class: 'composer-attachment', hidden: true });
  const textarea = h('textarea', {
    rows: 1,
    placeholder: window.matchMedia('(max-width: 600px)').matches
      ? 'הדביקו מסמך או כתבו שאלה…'
      : 'הדביקו כתב אישום או הכרעת דין, צרפו קובץ, או כתבו שאלת המשך…',
    'aria-label': 'הודעה',
    onInput: autoGrow,
    onKeydown: (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
    },
    onPaste: (e) => {
      const file = [...(e.clipboardData?.files || [])][0];
      if (file) { e.preventDefault(); attachFile(file); }
    },
  });
  const sendBtn = h('button', { class: 'send-btn', type: 'button', 'aria-label': 'שליחה', svg: ICONS.send, onClick: () => (state.busy ? stopTurn() : send()) });
  const dropTarget = h('div', { class: 'drop-target' },
    attachment,
    h('div', { class: 'composer-row' },
      h('button', { class: 'attach-btn', type: 'button', 'aria-label': 'צירוף קובץ Word או PDF', title: 'צירוף קובץ Word או PDF', svg: ICONS.attach, onClick: () => fileInput.click() }),
      textarea,
      sendBtn),
    fileInput);
  const composer = h('div', { class: 'composer-wrap' },
    h('div', { class: 'composer' }, dropTarget,
      h('div', { class: 'composer-foot', text: 'התוצאות מבוססות על מאגר TAG-IT ומיועדות לסיוע במחקר משפטי. יש לבדוק כל תוצאה מול המקור.' })));

  const main = h('main', { class: 'main' }, thread, composer);
  root.replaceChildren(h('div', { class: 'app-shell' }, sidebar, main));

  ['dragenter', 'dragover'].forEach((type) => main.addEventListener(type, (e) => {
    if ([...e.dataTransfer.types].includes('Files')) { e.preventDefault(); dropTarget.classList.add('dragging'); }
  }));
  ['dragleave', 'drop'].forEach((type) => main.addEventListener(type, (e) => {
    if (type === 'dragleave' && main.contains(e.relatedTarget)) return;
    dropTarget.classList.remove('dragging');
  }));
  main.addEventListener('drop', (e) => {
    const file = e.dataTransfer.files?.[0];
    if (file) { e.preventDefault(); attachFile(file); }
  });

  const menuToggle = document.getElementById('menuToggle');
  menuToggle.hidden = false;
  menuToggle.onclick = () => sidebar.classList.toggle('open');

  ui = { sidebar, conversationList, quota, thread, threadInner, textarea, sendBtn, attachment, fileInput };
  showWelcome();
}

function autoGrow() {
  const t = ui.textarea;
  t.style.height = 'auto';
  t.style.height = `${Math.min(t.scrollHeight, 240)}px`;
  t.style.overflowY = t.scrollHeight > 240 ? 'auto' : 'hidden';
}

function scrollToBottom(force = false) {
  const t = ui.thread;
  const nearBottom = t.scrollHeight - t.scrollTop - t.clientHeight < 160;
  if (force || nearBottom) t.scrollTop = t.scrollHeight;
}

function showWelcome() {
  const step = (n, title, body) => h('div', { class: 'step' },
    h('span', { class: 'step-num', text: n }), h('h3', { text: title }), h('p', { text: body }));
  ui.threadInner.replaceChildren(h('section', { class: 'welcome' },
    h('div', { class: 'gold-bar' }),
    h('h1', { text: 'איתור גזרי דין והנחיות לפי כתב אישום או הכרעת דין' }),
    h('p', { text: 'צרפו קובץ Word או PDF, או הדביקו את נוסח המסמך. המערכת תזהה את סעיפי האישום או ההרשעה של כל נאשם ותאתר גזרי דין או הנחיות רלוונטיים ממאגר TAG-IT.' }),
    h('div', { class: 'steps' },
      step('1', 'צירוף המסמך', 'כתב אישום או הכרעת דין, כקובץ או כטקסט.'),
      step('2', 'זיהוי העבירות', 'סעיפים ונתונים מהותיים לכל נאשם, כמו סוג הסם וכמותו.'),
      step('3', 'גזרי דין והנחיות', 'ממוינים מהעונש החמור לקל, עם שאלות למיקוד החיפוש.'))));
}

function setBusy(busy) {
  state.busy = busy;
  ui.sendBtn.classList.toggle('stop', busy);
  ui.sendBtn.innerHTML = busy ? ICONS.stop : ICONS.send;
  ui.sendBtn.setAttribute('aria-label', busy ? 'עצירה' : 'שליחה');
}

// ---------- Sidebar ----------

async function loadConversations() {
  const res = await fetch('/api/conversations');
  if (!res.ok) return;
  state.conversations = (await res.json()).conversations;
  renderConversationList();
}

function renderConversationList() {
  const now = new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const groups = [['היום', startOfDay], ['אתמול', startOfDay - 864e5], ['7 הימים האחרונים', startOfDay - 7 * 864e5], ['קודם לכן', -Infinity]];
  const items = [];
  let currentGroup = null;
  for (const conv of state.conversations) {
    const t = new Date(conv.updated_at).getTime();
    const group = groups.find(([, from]) => t >= from)[0];
    if (group !== currentGroup) { items.push(h('li', { class: 'conv-group', text: group })); currentGroup = group; }
    items.push(h('li', { class: `conv-item${conv.id === state.currentId ? ' active' : ''}` },
      h('button', { class: 'conv-open', type: 'button', title: conv.title || '', text: conv.title || 'שיחה ללא כותרת', onClick: () => openConversation(conv.id) }),
      h('button', { class: 'icon-btn conv-del', type: 'button', 'aria-label': 'מחיקת השיחה', svg: ICONS.trash, onClick: () => deleteConversation(conv) })));
  }
  if (!items.length) items.push(h('li', { class: 'conv-group', text: 'אין עדיין שיחות' }));
  ui.conversationList.replaceChildren(...items);
}

function upsertConversation(id, title) {
  const existing = state.conversations.find((c) => c.id === id);
  if (existing) {
    if (title) existing.title = title;
    existing.updated_at = new Date().toISOString();
  } else {
    state.conversations.unshift({ id, title, updated_at: new Date().toISOString() });
  }
  state.conversations.sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));
  renderConversationList();
}

async function deleteConversation(conv) {
  if (!confirm(`למחוק את השיחה "${conv.title || ''}"?`)) return;
  const res = await fetch(`/api/conversations/${conv.id}`, { method: 'DELETE' });
  if (!res.ok) return;
  state.conversations = state.conversations.filter((c) => c.id !== conv.id);
  if (state.currentId === conv.id) newConversation();
  renderConversationList();
}

function renderQuota(quota) {
  if (!quota) return;
  const periodLabel = quota.period === 'monthly' ? 'החודש' : 'מצטבר';
  if (quota.limit == null) {
    ui.quota.replaceChildren(h('div', { text: `שימוש ${periodLabel}: ${fmtTokens(quota.used)} טוקנים (ללא מגבלה)` }));
    return;
  }
  const pct = Math.min(100, (quota.used / Math.max(quota.limit, 1)) * 100);
  const cls = pct >= 100 ? 'over' : pct >= 80 ? 'warn' : '';
  ui.quota.replaceChildren(...[
    h('div', { text: `שימוש ${periodLabel}: ${fmtTokens(quota.used)} מתוך ${fmtTokens(quota.limit)} טוקנים` }),
    h('div', { class: 'quota-bar', role: 'progressbar', 'aria-valuenow': Math.round(pct), 'aria-valuemin': 0, 'aria-valuemax': 100 },
      h('span', { class: cls, style: `width:${pct}%` })),
    pct >= 100 ? h('div', { style: 'color:var(--error)', text: 'הגעת למגבלת השימוש.' }) : null,
  ].filter(Boolean));
}

function newConversation() {
  if (state.controller) return;
  stopFollowing();
  state.currentId = null;
  history.replaceState(null, '', location.pathname);
  showWelcome();
  renderConversationList();
  ui.sidebar.classList.remove('open');
  ui.textarea.focus();
}

async function openConversation(id) {
  if (state.controller) return;
  stopFollowing();
  const res = await fetch(`/api/conversations/${id}`);
  if (!res.ok) { newConversation(); return; }
  renderConversation(await res.json());
}

function renderConversation({ conversation, turns, running, lastRequest }) {
  state.currentId = conversation.id;
  history.replaceState(null, '', `#c=${conversation.id}`);
  ui.threadInner.replaceChildren();
  ui.sidebar.classList.remove('open');
  renderConversationList();

  const lastQuestionsIndex = turns.length - 1;
  let assistant = null;
  turns.forEach((turn, index) => {
    if (turn.role === 'user') {
      assistant?.finish();
      assistant = null;
      renderUserMessage(turn.ui);
      return;
    }
    assistant ??= createAssistantBlock(conversation.id);
    for (const item of turn.ui.items || []) {
      const isLive = index === lastQuestionsIndex && item === turn.ui.items.at(-1);
      assistant.item(item, { live: isLive && !running });
    }
  });
  assistant?.finish();
  if (running) {
    followServerTurn(conversation.id, 'הבקשה האחרונה עדיין בעיבוד בשרת. התשובה תוצג כאן כשתסתיים.');
  } else if (lastRequest && ['interrupted', 'error'].includes(lastRequest.status)) {
    ui.threadInner.append(h('div', { class: 'notice-box' },
      lastRequest.status === 'interrupted' ? 'העיבוד של הבקשה האחרונה נקטע לפני שהסתיים. ' : 'הבקשה האחרונה נכשלה. ',
      h('button', { class: 'link-btn', type: 'button', onClick: () => send({ text: 'המשך מהמקום שבו נעצרת.' }) }, 'המשך')));
  }
  scrollToBottom(true);
}

// ---------- Recovering a turn that outlived its stream ----------

function stopFollowing() {
  if (!state.following) return;
  state.following = null;
  setBusy(false);
}

function stopTurn() {
  if (state.currentId) fetch(`/api/conversations/${state.currentId}/stop`, { method: 'POST' }).catch(() => {});
  if (state.controller) state.controller.abort();
  else stopFollowing();
}

// The server keeps working when the connection drops; poll until the turn ends, then show the saved result.
async function followServerTurn(conversationId, message) {
  const line = h('div', { class: 'activity' }, h('span', { class: 'spinner' }), h('span', { text: message }));
  ui.threadInner.append(line);
  scrollToBottom(true);
  state.following = conversationId;
  setBusy(true);
  for (let attempt = 0; attempt < 225 && state.following === conversationId; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 4000));
    if (state.following !== conversationId) break;
    let data;
    try {
      const res = await fetch(`/api/conversations/${conversationId}`);
      if (!res.ok) continue;
      data = await res.json();
    } catch {
      continue; // still offline
    }
    if (!data.running) {
      state.following = null;
      setBusy(false);
      if (state.currentId === conversationId) renderConversation(data);
      loadConversations();
      return;
    }
  }
  line.remove();
  if (state.following === conversationId) stopFollowing();
}

// ---------- Composer ----------

function attachFile(file) {
  if (!file) return;
  const ext = file.name.slice(file.name.lastIndexOf('.')).toLowerCase();
  if (!ACCEPTED_EXT.includes(ext)) {
    alert(ext === '.doc' ? 'קובץ Word בפורמט הישן (.doc) אינו נתמך. יש לשמור אותו כ-docx או כ-PDF.' : 'ניתן לצרף קובצי Word (docx), PDF או טקסט.');
    return;
  }
  if (file.size > MAX_FILE_BYTES) { alert('הקובץ גדול מדי (עד 20MB).'); return; }
  state.file = file;
  ui.attachment.hidden = false;
  ui.attachment.replaceChildren(h('span', { class: 'attach-pill' },
    h('span', { svg: ICONS.file, style: 'display:inline-flex;width:16px;height:16px;color:var(--primary)' }),
    h('span', { text: file.name }),
    h('button', { type: 'button', 'aria-label': 'הסרת הקובץ', text: '×', onClick: clearFile })));
  ui.fileInput.value = '';
  ui.textarea.focus();
}

function clearFile() {
  state.file = null;
  ui.attachment.hidden = true;
  ui.attachment.replaceChildren();
}

function renderUserMessage({ text, fileName, pasted, answers }) {
  const bubble = h('div', { class: 'bubble-user' });
  if (fileName) bubble.append(h('div', { class: 'file-chip' }, h('span', { svg: ICONS.file, style: 'display:inline-flex' }), fileName), h('br'));
  if (answers?.length) {
    bubble.append(...answers.flatMap((a) => {
      const value = [...(a.selected || []).map((s) => s.label), a.free_text].filter(Boolean).join(', ') || 'ללא העדפה';
      return [h('div', {}, h('strong', { text: `${a.question}: ` }), value)];
    }));
  }
  if (text) bubble.append(h('div', { text: pasted && !text.endsWith('…') ? `${text}…` : text }));
  ui.threadInner.append(h('div', { class: 'msg msg-user' }, h('div', { class: 'msg-body' }, bubble)));
  scrollToBottom(true);
}

async function send({ answers = null, text: presetText = null } = {}) {
  if (state.busy) return;
  const text = answers ? '' : (presetText ?? ui.textarea.value.trim());
  const file = answers ? null : state.file;
  if (!text && !file && !answers) return;

  const form = new FormData();
  if (state.currentId) form.append('conversationId', state.currentId);
  form.append('text', text);
  if (file) form.append('file', file);
  if (answers) form.append('answers', JSON.stringify(answers));

  if (!state.currentId) ui.threadInner.replaceChildren();
  ui.threadInner.querySelectorAll('.questions:not(.answered)').forEach(disableQuestions);
  const isPasted = !file && !answers && text.length > PASTED_DOCUMENT_CHARS;
  renderUserMessage({
    text: isPasted ? text.slice(0, 400) : text,
    pasted: isPasted,
    fileName: file?.name ?? (isPasted ? 'טקסט שהודבק' : null),
    answers,
  });
  if (!answers && presetText == null) {
    ui.textarea.value = '';
    autoGrow();
    clearFile();
  }

  const assistant = createAssistantBlock(state.currentId);
  assistant.status('שולח…');
  setBusy(true);
  state.controller = new AbortController();
  let connectionLost = false;
  try {
    const res = await fetch('/api/chat', { method: 'POST', body: form, signal: state.controller.signal });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      if (res.status === 429 && err.quota) { renderQuota(err.quota); assistant.error('הגעת למגבלת הטוקנים שהוגדרה לחשבונך. ניתן לפנות למנהל המערכת.'); }
      else if (res.status === 409) assistant.error('בקשה קודמת בשיחה זו עדיין בעיבוד.');
      else assistant.error(err.message || 'הבקשה נכשלה. נסו שוב.');
      return;
    }
    await readEvents(res, (event) => handleEvent(event, assistant));
    if (!assistant.sawDone) connectionLost = true; // the stream ended without the server's "done"
  } catch (err) {
    if (err.name === 'AbortError') assistant.notice('העיבוד הופסק.');
    else connectionLost = true;
  } finally {
    assistant.finish();
    setBusy(false);
    state.controller = null;
    loadConversations();
  }
  if (connectionLost) {
    if (state.currentId) followServerTurn(state.currentId, 'החיבור לשרת נותק, אבל העיבוד ממשיך בשרת. התשובה המלאה תוצג כאן כשתסתיים.');
    else ui.threadInner.append(h('div', { class: 'error-box', text: 'החיבור לשרת נותק. נסו שוב.' }));
  }
}

async function readEvents(res, onEvent) {
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;
    let boundary;
    while ((boundary = buffer.indexOf('\n\n')) !== -1) {
      const chunk = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      for (const line of chunk.split('\n')) {
        if (line.startsWith('data: ')) onEvent(JSON.parse(line.slice(6)));
      }
    }
  }
}

function handleEvent(event, assistant) {
  switch (event.type) {
    case 'conversation':
      state.currentId = event.id;
      assistant.conversationId = event.id;
      history.replaceState(null, '', `#c=${event.id}`);
      upsertConversation(event.id, event.title);
      break;
    case 'status': assistant.status(event.text); break;
    case 'text': assistant.text(event.delta); break;
    case 'segment_end': assistant.endSegment(); break;
    case 'activity': assistant.activity(event); break;
    case 'analysis':
    case 'results':
    case 'guidelines':
      assistant.item({ type: event.type, data: event.data }, { toolUseId: event.toolUseId });
      break;
    case 'questions': assistant.item({ type: 'questions', data: event.data, toolUseId: event.toolUseId }, { live: true }); break;
    case 'notice': assistant.notice(event.text); break;
    case 'error': assistant.error(event.message); break;
    case 'quota': renderQuota(event.quota); break;
    case 'done': assistant.sawDone = true; break;
    default: break;
  }
}

// ---------- Assistant message ----------

function createAssistantBlock(conversationId) {
  const body = h('div', { class: 'msg-body' });
  ui.threadInner.append(h('div', { class: 'msg msg-assistant' }, h('img', { class: 'msg-avatar', src: '/icon.svg', alt: '' }), body));
  let statusEl = null;
  let textEl = null;
  let textBuffer = '';
  let renderPending = false;
  const activities = new Map();
  // Parallel tool calls: activity lines on top, then one slot per call so results keep call order
  // even when a later search finishes first.
  let toolArea = null;

  const append = (el) => {
    body.append(el);
    if (statusEl) body.append(statusEl); // keep the status line last
    scrollToBottom();
  };

  const block = {
    conversationId,
    status(text) {
      if (!statusEl) statusEl = h('div', { class: 'activity' }, h('span', { class: 'spinner' }), h('span'));
      statusEl.lastChild.textContent = text;
      body.append(statusEl);
      scrollToBottom();
    },
    clearStatus() { statusEl?.remove(); statusEl = null; },
    text(delta) {
      block.clearStatus();
      if (!textEl) { toolArea = null; textEl = h('div', { class: 'assistant-text cursor' }); textBuffer = ''; append(textEl); }
      textBuffer += delta;
      if (!renderPending) {
        renderPending = true;
        requestAnimationFrame(() => {
          renderPending = false;
          if (textEl) { textEl.innerHTML = markdown(textBuffer); scrollToBottom(); }
        });
      }
    },
    endSegment() {
      if (textEl) { textEl.innerHTML = markdown(textBuffer); textEl.classList.remove('cursor'); }
      textEl = null;
    },
    activity(event) {
      let el = activities.get(event.id);
      if (!el) {
        block.endSegment();
        if (!toolArea) {
          toolArea = { list: h('div'), slots: h('div'), byId: new Map() };
          append(toolArea.list);
          append(toolArea.slots);
        }
        el = h('div', { class: 'activity' }, h('span', { class: 'spinner' }), h('span'));
        activities.set(event.id, el);
        toolArea.list.append(el);
        const slot = h('div');
        toolArea.byId.set(event.id, slot);
        toolArea.slots.append(slot);
      }
      el.lastChild.textContent = event.summary ? `${event.label} · ${event.summary}` : event.label;
      el.classList.toggle('done', event.state === 'done');
      if (event.state === 'error') { el.classList.add('done'); el.style.color = 'var(--error)'; el.lastChild.textContent = `${event.label} · נכשל`; }
    },
    item(item, { live = false, toolUseId = null } = {}) {
      block.endSegment();
      let el = null;
      if (item.type === 'text') el = h('div', { class: 'assistant-text', svg: markdown(item.text) });
      else if (item.type === 'analysis') el = renderAnalysis(item.data);
      else if (item.type === 'results') el = renderResults(item.data, block);
      else if (item.type === 'guidelines') el = renderGuidelines(item.data);
      else if (item.type === 'questions') el = renderQuestions(item.data, live);
      if (!el) return;
      const slot = toolUseId && toolArea?.byId.get(toolUseId);
      if (slot) {
        slot.append(el);
        scrollToBottom();
      } else {
        toolArea = null;
        append(el);
      }
    },
    notice(text) { block.endSegment(); append(h('div', { class: 'notice-box', text })); },
    error(text) { block.endSegment(); append(h('div', { class: 'error-box', text })); },
    finish() {
      block.endSegment();
      block.clearStatus();
      for (const el of activities.values()) el.classList.add('done');
      if (!body.childElementCount) body.closest('.msg')?.remove();
    },
  };
  return block;
}

// ---------- Cards ----------

function renderAnalysis(a) {
  const counts = a.defendants.reduce((sum, d) => sum + d.counts.length, 0);
  const meta = [['בית משפט', a.court], ['תיק', a.case_number], ['תאריך', fmtDate(a.document_date)]]
    .filter(([, v]) => v)
    .map(([k, v]) => h('span', {}, `${k}: `, h('b', { text: v })));

  const defendants = a.defendants.map((d) => h('div', { class: 'defendant' },
    h('div', { class: 'defendant-head' },
      h('span', { text: [d.label, d.name].filter(Boolean).join(' · ') }),
      h('span', { class: 'badge badge-muted', text: d.counts.length === 1 ? 'סעיף אחד' : `${d.counts.length} סעיפים` })),
    h('div', { class: 'table-scroll' },
      h('table', { class: 'charges' },
        h('thead', {}, h('tr', {}, h('th', { text: 'עבירה' }), h('th', { text: 'חוק וסעיף' }), h('th', { text: 'סטטוס' }), h('th', { text: 'נתונים' }))),
        h('tbody', {}, d.counts.map((c) => h('tr', {},
          h('td', { text: c.offense + (c.occurrences > 1 ? ` (${c.occurrences} עבירות)` : '') }),
          h('td', {}, h('div', { class: 'charge-section', text: c.section || '—' }), c.law ? h('div', { class: 'small muted', text: c.law }) : null),
          h('td', {}, h('span', { class: `badge ${c.status === 'acquitted' ? 'badge-muted' : c.status === 'convicted' ? 'badge-navy' : ''}`, text: COUNT_STATUS[c.status] || c.status })),
          h('td', {}, h('div', { class: 'facts' },
            (c.drugs || []).map((drug) => h('span', { class: 'badge badge-gold', text: [drug.name, drug.amount != null ? fmtNumber(drug.amount) : null, drug.unit === 'grams' ? 'גרם' : drug.unit_label].filter(Boolean).join(' ') })),
            (c.facts || []).map((f) => h('span', { class: 'badge', text: `${f.label}: ${f.value}` })))))))))));

  return h('section', { class: 'card analysis' },
    h('div', { class: 'card-head' },
      h('h3', { class: 'card-title', text: 'ניתוח המסמך' }),
      h('span', { class: 'badge', text: DOC_TYPES[a.document_type] || a.document_type })),
    h('div', { class: 'card-body' },
      a.is_supported ? null : h('div', { class: 'notice-box', text: 'המערכת מיועדת לכתבי אישום ולהכרעות דין. המסמך שצורף אינו מאחד מסוגים אלה.' }),
      meta.length ? h('div', { class: 'analysis-meta' }, meta) : null,
      h('p', { class: 'small muted', style: 'margin:0', text: a.classification_reason }),
      a.defendants.length ? h('p', { class: 'small', style: 'margin:8px 0 0', text: `זוהו ${a.defendants.length === 1 ? 'נאשם אחד' : `${a.defendants.length} נאשמים`} ו${counts === 1 ? 'סעיף אחד' : `-${counts} סעיפים`}.` }) : null,
      defendants));
}

function sentenceBadges(r) {
  const badges = [];
  if (r.prisonMonths != null && r.prisonMonths > 0) badges.push(h('span', { class: 'badge badge-navy', text: `${fmtNumber(r.prisonMonths)} חודשי מאסר בפועל` }));
  else if (r.primaryPunishment) badges.push(h('span', { class: 'badge badge-navy', text: r.primaryPunishment }));
  if (r.serviceWorkMonths) badges.push(h('span', { class: 'badge', text: `${fmtNumber(r.serviceWorkMonths)} ח׳ עבודות שירות` }));
  if (r.suspendedMonths) badges.push(h('span', { class: 'badge', text: `${fmtNumber(r.suspendedMonths)} ח׳ מאסר על תנאי` }));
  if (r.communityServiceHours) badges.push(h('span', { class: 'badge', text: `${fmtNumber(r.communityServiceHours)} שעות של״צ` }));
  if (r.fine) badges.push(h('span', { class: 'badge', text: `קנס ₪${fmtNumber(r.fine)}` }));
  if (r.compensation) badges.push(h('span', { class: 'badge', text: `פיצוי ₪${fmtNumber(r.compensation)}` }));
  for (const d of r.drugTotals || []) {
    if (d.drug && d.amount != null) badges.push(h('span', { class: 'badge badge-gold', text: `${d.drug} ${fmtNumber(d.amount)} ${d.unit || ''}`.trim() }));
  }
  if (r.confessed) badges.push(h('span', { class: 'badge badge-muted', text: 'הודה' }));
  if (r.agreedSentence) badges.push(h('span', { class: 'badge badge-muted', text: 'עונש מוסכם' }));
  return badges;
}

function clampedText(text) {
  if (!text) return null;
  const p = h('p', { class: 'result-summary clamped', text });
  const toggle = h('button', { class: 'link-btn', type: 'button', text: 'הצגת התקציר המלא', onClick: () => {
    const clamped = p.classList.toggle('clamped');
    toggle.textContent = clamped ? 'הצגת התקציר המלא' : 'הסתרה';
  } });
  return [p, text.length > 220 ? toggle : null];
}

function renderRuling(r, rank) {
  const severityClass = r.prisonMonths >= 36 ? 'severity-high' : r.prisonMonths > 0 ? 'severity-mid' : '';
  const details = h('div', { class: 'small', hidden: true, style: 'margin-top:8px' },
    (r.defendants || []).map((d, i) => h('div', { style: 'margin-bottom:6px' },
      h('strong', { text: d.name || `נאשם ${i + 1}` }), ': ',
      (d.punishments || []).map((p) => [p.type, p.value, p.unit].filter((x) => x != null && x !== '').join(' ')).join(' · ') || '—')),
    (r.ranges || []).filter((x) => x.min || x.max).map((x) => h('div', {},
      h('strong', { text: `מתחם${x.group ? ` (${x.group})` : ''}: ` }), `${x.min || '?'} – ${x.max || '?'}`)),
    r.judges?.length ? h('div', { class: 'muted', text: `שופטים: ${r.judges.join(', ')}` }) : null);
  const hasDetails = details.childElementCount > 0;

  return h('article', { class: `result ${severityClass}` },
    h('div', { class: 'result-rank', title: 'דירוג לפי חומרת העונש', text: rank }),
    h('div', {},
      h('h5', { class: 'result-title' }, h('a', { href: r.fileUrl, target: '_blank', rel: 'noopener', text: r.title })),
      h('div', { class: 'result-meta', text: [r.court, fmtDate(r.date), r.caseNumber && !r.title.includes(r.caseNumber) ? r.caseNumber : null].filter(Boolean).join(' · ') }),
      h('div', { class: 'result-sentence' }, sentenceBadges(r)),
      r.snippet ? h('p', { class: 'result-summary small muted', text: r.snippet }) : null,
      clampedText(r.summary),
      h('div', { class: 'result-actions' },
        h('a', { href: r.fileUrl, target: '_blank', rel: 'noopener', text: 'פתיחת גזר הדין' }),
        r.sourceUrl ? h('a', { href: r.sourceUrl, target: '_blank', rel: 'noopener noreferrer', text: 'מקור' }) : null,
        hasDetails ? h('button', { class: 'link-btn', type: 'button', text: 'פירוט נאשמים ומתחמים', onClick: () => { details.hidden = !details.hidden; } }) : null),
      details));
}

function renderResults(data, block) {
  const PAGE = 10;
  const items = [...data.items];
  let shown = 0;
  let page = data.page || 1;
  const list = h('div');
  const more = h('div', { class: 'results-more' });

  const renderMore = () => {
    const next = items.slice(shown, shown + PAGE);
    next.forEach((r, i) => list.append(renderRuling(r, shown + i + 1)));
    shown += next.length;
    const canFetch = data.total != null && items.length < data.total && data.params;
    more.replaceChildren();
    if (shown < items.length || canFetch) {
      more.append(h('button', { class: 'btn btn-secondary btn-sm', type: 'button', onClick: async (e) => {
        if (shown < items.length) return renderMore();
        e.target.disabled = true;
        e.target.textContent = 'טוען…';
        try {
          const res = await fetch('/api/tagit/sentencing/more', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ conversationId: block.conversationId, params: data.params, page: page + 1 }),
          });
          if (!res.ok) throw new Error();
          const next = await res.json();
          page = next.page;
          if (!next.items.length) { data.total = items.length; }
          items.push(...next.items);
          renderMore();
        } catch {
          e.target.disabled = false;
          e.target.textContent = 'הטעינה נכשלה · נסו שוב';
        }
      } }, 'הצגת תוצאות נוספות'));
    }
  };
  renderMore();

  const count = data.total != null ? `נמצאו ${fmtNumber(data.total)} גזרי דין` : `${items.length} גזרי דין`;
  return h('section', { class: 'results' },
    h('div', { class: 'results-head' },
      h('h4', { text: `גזרי דין · ${data.label}` }),
      h('span', { class: 'results-query', text: `${count} · ממוינים מהעונש החמור לקל` })),
    items.length ? list : h('div', { class: 'notice-box', text: 'לא נמצאו גזרי דין התואמים את החיפוש.' }),
    more);
}

function renderGuidelines(data) {
  return h('section', { class: 'results' },
    h('div', { class: 'results-head' },
      h('h4', { text: `הנחיות · ${data.label}` }),
      h('span', { class: 'results-query', text: `${data.items.length} הנחיות` })),
    data.items.length
      ? data.items.map((g, i) => h('article', { class: 'result' },
        h('div', { class: 'result-rank', text: i + 1 }),
        h('div', {},
          h('h5', { class: 'result-title' }, h('a', { href: g.fileUrl, target: '_blank', rel: 'noopener', text: g.title })),
          h('div', { class: 'result-meta', text: [g.number ? `הנחיה ${g.number}` : null, g.source, fmtDate(g.date)].filter(Boolean).join(' · ') }),
          h('div', { class: 'result-sentence' },
            g.topic ? h('span', { class: 'badge', text: g.topic }) : null,
            g.effectiveDate ? h('span', { class: 'badge badge-muted', text: `בתוקף מ-${fmtDate(g.effectiveDate)}` }) : null,
            g.supersedes ? h('span', { class: 'badge badge-muted', text: `מחליפה: ${g.supersedes}` }) : null),
          clampedText(g.summary),
          h('div', { class: 'result-actions' }, h('a', { href: g.fileUrl, target: '_blank', rel: 'noopener', text: 'פתיחת ההנחיה' })))))
      : h('div', { class: 'notice-box', text: 'לא נמצאו הנחיות התואמות את החיפוש.' }));
}

function disableQuestions(section) {
  section.classList.add('answered');
  section.querySelectorAll('button, input').forEach((el) => { el.disabled = true; });
}

function renderQuestions(data, live) {
  const selections = new Map(data.questions.map((q) => [q.id, new Set(q.options.filter((o) => o.recommended && !q.multiple).map((o) => o.value))]));
  const freeInputs = new Map();
  const section = h('section', { class: 'card questions' });

  const submit = () => {
    const answers = data.questions.map((q) => ({
      id: q.id,
      question: q.text,
      selected: q.options.filter((o) => selections.get(q.id).has(o.value)).map((o) => ({ value: o.value, label: o.label })),
      free_text: freeInputs.get(q.id)?.value.trim() || null,
    }));
    disableQuestions(section);
    send({ answers });
  };

  const questionEls = data.questions.map((q) => {
    const selected = selections.get(q.id);
    const optionButtons = [];
    const refresh = () => optionButtons.forEach(([btn, value]) => {
      btn.classList.toggle(q.style === 'cards' ? 'chosen' : 'selected', selected.has(value));
      btn.setAttribute('aria-pressed', selected.has(value));
    });
    const choose = (value) => {
      if (q.multiple) { selected.has(value) ? selected.delete(value) : selected.add(value); }
      else { selected.clear(); selected.add(value); }
      refresh();
      // A single card question submits on click.
      if (q.style === 'cards' && !q.multiple && data.questions.length === 1) submit();
    };
    const options = q.options.map((o) => {
      const btn = q.style === 'cards'
        ? h('button', { class: 'mode-btn', type: 'button', onClick: () => choose(o.value) }, h('strong', { text: o.label }), o.description ? h('span', { text: o.description }) : null)
        : h('button', { class: 'chip', type: 'button', title: o.description || '', onClick: () => choose(o.value) }, o.label, o.recommended ? ' ★' : '');
      optionButtons.push([btn, o.value]);
      return btn;
    });
    refresh();
    let free = null;
    if (q.allow_free_text) {
      free = h('input', { class: 'input', type: 'text', placeholder: q.options.length ? 'תשובה אחרת (לא חובה)' : 'התשובה שלך' });
      freeInputs.set(q.id, free);
    }
    return h('div', { class: 'question' },
      h('div', { class: 'question-text', text: q.text }),
      q.help ? h('div', { class: 'question-help', text: q.help }) : null,
      options.length ? h('div', { class: q.style === 'cards' ? 'mode-picker' : 'chips' }, options) : null,
      free);
  });

  const needsButton = !(data.questions.length === 1 && data.questions[0].style === 'cards' && !data.questions[0].multiple);
  section.append(
    h('h4', { text: data.intro || 'כדי למקד את החיפוש' }),
    ...questionEls,
    h('div', { class: 'questions-actions' },
      needsButton ? h('button', { class: 'btn btn-primary btn-sm', type: 'button', onClick: submit }, 'שליחת תשובות') : null));
  if (!live) disableQuestions(section);
  return section;
}

boot();
