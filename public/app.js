import { marked } from '/vendor/marked.js';
import DOMPurify from '/vendor/purify.js';
import { describeAlert } from '/llm-alerts.js';

const APP_TITLE = 'זומר · מחקר ענישה';
const NEW_TAB = ' (נפתח בלשונית חדשה)';

marked.setOptions({ breaks: true, gfm: true });
// Model output can be steered by uploaded documents (prompt injection): allow Markdown structure only.
// No images, media, <style>, forms, SVG or style attributes, so nothing can fetch remote URLs or overlay the UI.
const PURIFY_CONFIG = {
  ALLOWED_TAGS: ['p', 'br', 'strong', 'em', 'b', 'i', 'u', 'del', 's', 'ul', 'ol', 'li', 'a', 'code', 'pre', 'blockquote',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'hr'],
  ALLOWED_ATTR: ['href', 'title', 'start'],
  ALLOWED_URI_REGEXP: /^(?:https?:|\/(?!\/)|#)/i,
};
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.nodeName.toLowerCase() === 'a') {
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
    else if (key === 'svg') el.innerHTML = value; // trusted static icons / sanitized markdown only
    else if (key === 'style') el.style.cssText = value; // CSSOM, so a strict CSP needs no 'unsafe-inline'
    else if (key.startsWith('on')) el.addEventListener(key.slice(2).toLowerCase(), value);
    else el.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    el.append(child instanceof Node ? child : String(child));
  }
  return el;
}

let uid = 0;
const nextId = (prefix) => `${prefix}-${++uid}`;
const srOnly = (text) => h('span', { class: 'sr-only', text });
// Only http(s) or same-origin paths may become links (upstream data is not trusted).
const safeUrl = (url) => (typeof url === 'string' && /^(?:https?:\/\/|\/(?!\/))/i.test(url) ? url : null);
const externalLink = (href, text, context = '') =>
  (safeUrl(href) ? h('a', { href, target: '_blank', rel: 'noopener noreferrer' }, text, srOnly(`${context}${NEW_TAB}`)) : h('span', {}, text));

// Links written by the model open in a new tab; say so to screen reader users.
function decorateLinks(container) {
  container.querySelectorAll('a[target="_blank"]').forEach((a) => {
    if (!a.querySelector('.sr-only')) a.append(srOnly(NEW_TAB));
  });
}

// Tables stay tables on wide screens and become one card per row on phones (see .stack-table).
// Explicit roles keep the table semantics that display:block would otherwise drop for screen readers.
function stackableTable(table, label) {
  table.classList.add('stack-table');
  table.setAttribute('role', 'table');
  const headers = [...(table.tHead?.rows[0]?.cells ?? [])].map((cell) => cell.textContent.trim());
  for (const section of [table.tHead, ...table.tBodies]) section?.setAttribute('role', 'rowgroup');
  for (const row of table.rows) {
    row.setAttribute('role', 'row');
    [...row.cells].forEach((cell, i) => {
      if (cell.tagName === 'TH') cell.setAttribute('role', 'columnheader');
      else {
        cell.setAttribute('role', 'cell');
        if (headers[i]) cell.dataset.label = headers[i];
      }
    });
  }
  const wrap = h('div', { class: 'table-scroll', role: 'region', 'aria-label': label, tabindex: '0' });
  table.replaceWith(wrap);
  wrap.append(table);
  return wrap;
}

function enhanceTables(container) {
  container.querySelectorAll('table:not(.stack-table)').forEach((table) => {
    table.classList.add('md-table');
    stackableTable(table, 'טבלה');
  });
}

const svg = (inner) =>
  `<svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;
const ICONS = {
  attach: svg('<path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/>'),
  send: svg('<path d="m5 12 7-7 7 7"/><path d="M12 19V5"/>'),
  stop: svg('<rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor"/>'),
  file: svg('<path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/><path d="M14 2v6h6"/>'),
  trash: svg('<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>'),
  plus: svg('<path d="M12 5v14M5 12h14"/>'),
};

const markdown = (text) => DOMPurify.sanitize(marked.parse(String(text || '')), PURIFY_CONFIG);
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

// Screen reader announcements (WCAG 4.1.3): milestones only, never every streamed token.
const liveStatus = document.getElementById('liveStatus');
const liveAlert = document.getElementById('liveAlert');
function announce(text, { assertive = false } = {}) {
  const region = assertive ? liveAlert : liveStatus;
  region.textContent = '';
  setTimeout(() => { region.textContent = text; }, 80);
}

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
const state = { me: null, conversations: [], currentId: null, busy: false, controller: null, following: null, file: null, searchSetup: null, analysis: null, includeSource: false, includeRaw: false };
const root = document.getElementById('root');
let ui = {};

const policyLinks = (className) => h('p', { class: className },
  h('a', { href: '/accessibility', text: 'הצהרת נגישות' }), ' · ', h('a', { href: '/privacy', text: 'מדיניות פרטיות' }));

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
      h('a', { class: 'btn btn-accent', href: me.loginUrl }, 'התחברות'), demoVideo());
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
  renderAlerts(me.alerts);
  await loadConversations();
  const match = location.hash.match(/^#c=([0-9a-f-]{36})$/i);
  if (match) openConversation(match[1]);
}

// Admins only: the model is out of credit (or about to be), or the provider rejects the key or model.
function renderAlerts(alerts) {
  const box = ui.alertsBox;
  if (!box) return;
  box.replaceChildren(...(alerts ?? []).map((alert) => {
    const text = describeAlert(alert);
    return h('div', { class: text.level === 'error' ? 'error-box llm-alert' : 'notice-box llm-alert', role: text.level === 'error' ? 'alert' : 'status' },
      h('strong', { text: text.title }),
      h('p', { text: text.body }),
      ...[
        text.detail ? h('p', { class: 'small', text: text.detail }) : null,
        h('p', { class: 'small' },
          text.billingUrl ? h('a', { href: text.billingUrl, target: '_blank', rel: 'noopener noreferrer', text: 'למסך החיוב אצל הספק' }) : null,
          text.billingUrl ? ' · ' : null,
          h('a', { href: '/admin', text: 'לניהול המערכת' })),
      ].filter(Boolean));
  }));
  box.hidden = !box.childElementCount;
}

async function refreshAlerts() {
  if (state.me?.user.role !== 'admin') return;
  try {
    const me = await (await fetch('/api/me')).json();
    renderAlerts(me.alerts);
  } catch { /* the next turn tries again */ }
}

function renderGate(title, body, action, extra = null) {
  document.title = `${title} · ${APP_TITLE}`;
  root.replaceChildren(h('main', { class: `gate${extra ? ' gate-with-demo' : ''}`, id: 'content', tabindex: '-1' },
    h('div', { class: 'gate-card' },
      h('img', { src: '/icon.svg', alt: '', width: 56, height: 56 }),
      h('h1', { text: title }),
      h('p', { text: body }),
      action,
      policyLinks('gate-links')),
    extra));
}

// A recorded run of the real system on a fictional indictment, shown before sign-in. It has no sound, so the
// steps are also written out (WCAG 1.2.1); it plays only when the visitor starts it.
const DEMO_STEPS = [
  'מצרפים כתב אישום (קובץ Word) ושולחים.',
  'המערכת מזהה שמדובר בכתב אישום, ומפרטת את הנאשם, שלושת סעיפי האישום והנתונים המהותיים: סוג הנשק, מספר היריות, הפגיעה ומקום האירוע.',
  'בטופס החיפוש מסמנים גזרי דין וגם הנחיות. סדר התוצאות נשאר מהעונש הקל לחמור, בנתוני גזירת העונש נבחר "הוטל מאסר בפועל: כן", וממקורות ההנחיות נבחרו היועצת המשפטית לממשלה ופרקליט המדינה.',
  'המערכת מחפשת במאגר TAG\u2011IT לפי סעיף 329 ומציגה 63 גזרי דין תואמים, ממוינים מהעונש הקל לחמור, לצד הנחיית פרקליט המדינה 9.16 בעניין מדיניות ענישה בעבירות נשק.',
  'בסיום מוצג סיכום בכתב: חציון המאסר וטווחו, תיקים דומים שבהם הירי פגע ברגל המתלונן, והמקרים החמורים. כל תיק שמוזכר מקושר לגזר הדין, ומספר התיק נלקח מהמאגר ולא נכתב על ידי המודל.',
];

function demoVideo() {
  const titleId = nextId('demo-title');
  const stepsId = nextId('demo-steps');
  return h('section', { class: 'gate-demo', 'aria-labelledby': titleId },
    h('h2', { id: titleId, text: 'הדגמה: מכתב אישום לגזרי דין והנחיות' }),
    h('p', { class: 'gate-demo-note', text: 'כתב אישום בדוי בעבירות ירי ונשק. גזרי הדין וההנחיות הם אלה שהמערכת החזירה בפועל מהמאגר. ללא קול, כ-75 שניות.' }),
    h('video', {
      class: 'gate-demo-video',
      src: '/demo/teanot-demo.mp4',
      poster: '/demo/teanot-demo-poster.webp',
      controls: true,
      preload: 'none',
      playsinline: true,
      muted: true,
      width: 1280,
      height: 800,
      'aria-label': 'סרטון הדגמה של המערכת',
      'aria-describedby': stepsId,
    }),
    h('details', { class: 'gate-demo-details' },
      h('summary', { text: 'מה רואים בסרטון' }),
      h('ol', { id: stepsId }, DEMO_STEPS.map((step) => h('li', { text: step })))));
}

function renderHeader() {
  const { user, logoutUrl } = state.me;
  const actions = document.getElementById('headerActions');
  actions.replaceChildren(...[
    h('span', { class: 'user-chip', dir: 'auto', title: user.email, text: user.name || user.email }),
    user.role === 'admin' ? h('a', { class: 'btn btn-ghost btn-sm', href: '/admin' }, 'ניהול') : null,
    h('a', { class: 'btn btn-secondary btn-sm', href: logoutUrl }, 'התנתקות'),
  ].filter(Boolean));
}

// ---------- Layout ----------

function renderApp() {
  const conversationList = h('ul', { class: 'conv-list', role: 'list' });
  const quota = h('div', { class: 'quota' });
  const newButton = h('button', { class: 'btn btn-accent', type: 'button', onClick: () => newConversation() },
    h('span', { class: 'btn-icon', svg: ICONS.plus }), 'שיחה חדשה');
  const sidebar = h('aside', { class: 'sidebar', id: 'sidebar', 'aria-label': 'שיחות ושימוש' },
    h('div', { class: 'sidebar-top' }, newButton),
    h('nav', { class: 'conv-nav', 'aria-label': 'שיחות קודמות' }, conversationList),
    quota);

  const threadInner = h('div', { class: 'thread-inner' });
  // Focusable so keyboard users can scroll the conversation (WCAG 2.1.1).
  const thread = h('section', { class: 'thread', 'aria-label': 'שיחה', tabindex: '0' }, threadInner);

  const fileInput = h('input', {
    type: 'file', accept: ACCEPTED_EXT.join(','), hidden: true, tabindex: '-1', 'aria-hidden': 'true',
    onChange: (e) => attachFile(e.target.files[0]),
  });
  const attachment = h('div', { class: 'composer-attachment', hidden: true });
  const composerError = h('div', { class: 'error-box composer-error', role: 'alert', hidden: true });
  const hintId = nextId('composer-hint');
  const textarea = h('textarea', {
    rows: 1,
    placeholder: window.matchMedia('(max-width: 360px)').matches
      ? 'כתבו או הדביקו…'
      : window.matchMedia('(max-width: 600px)').matches
        ? 'הדביקו מסמך או כתבו שאלה…'
        : 'הדביקו כתב אישום או הכרעת דין, צרפו קובץ, או כתבו שאלת המשך…',
    'aria-label': 'הודעה או נוסח מסמך',
    'aria-describedby': hintId,
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
  const attachBtn = h('button', { class: 'attach-btn', type: 'button', 'aria-label': 'צירוף קובץ Word, PDF או טקסט', title: 'צירוף קובץ Word, PDF או טקסט', svg: ICONS.attach, onClick: () => fileInput.click() });
  // Opens the search-setup form again in a follow-up, for what is easier to set in the form than to describe.
  const setupBtn = h('button', { class: 'btn btn-secondary btn-sm setup-reopen', type: 'button', hidden: true, onClick: () => openSearchForm() },
    'פתיחת טופס החיפוש מחדש');
  const dropTarget = h('div', { class: 'drop-target' },
    attachment,
    h('div', { class: 'composer-row' }, attachBtn, textarea, sendBtn),
    fileInput);
  const composer = h('div', { class: 'composer-wrap' },
    h('div', { class: 'composer' },
      h('p', { id: hintId, class: 'sr-only', text: 'Enter שולח, Shift+Enter מוסיף שורה חדשה. קובץ מצרפים בכפתור הצירוף או בגרירה.' }),
      composerError,
      h('div', { class: 'composer-tools' }, setupBtn),
      dropTarget));
  // The footer stays at the bottom of the page when the composer moves to the middle of the welcome screen.
  const siteFoot = h('footer', { class: 'composer-foot' },
    h('span', { class: 'foot-long', text: 'התוצאות מבוססות על מאגר TAG-IT ומיועדות לסיוע במחקר משפטי. יש לבדוק כל תוצאה מול המקור. ' }),
    h('span', { class: 'foot-short', text: 'לסיוע במחקר בלבד; יש לבדוק מול המקור. ' }),
    h('a', { href: '/accessibility', text: 'הצהרת נגישות' }), ' · ', h('a', { href: '/privacy', text: 'מדיניות פרטיות' }),
    ' · ', h('span', { class: 'foot-contact' }, 'גיא זומר, ', h('a', { href: 'mailto:guy@z-g.co.il', dir: 'ltr', text: 'guy@z-g.co.il' })));

  const alertsBox = h('div', { class: 'llm-alerts', hidden: true });
  const exportBar = renderExportBar();
  const main = h('main', { class: 'main', id: 'content', tabindex: '-1' },
    h('h1', { class: 'sr-only', text: 'מחקר ענישה: איתור גזרי דין והנחיות' }),
    alertsBox,
    exportBar.el,
    thread,
    composer,
    siteFoot);
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

  // Mobile: the sidebar is an off-canvas panel; when closed it is inert (not reachable by keyboard).
  const menuToggle = document.getElementById('menuToggle');
  menuToggle.hidden = false;
  const mobile = window.matchMedia('(max-width: 900px)');
  const syncSidebar = () => {
    const open = sidebar.classList.contains('open');
    sidebar.inert = mobile.matches && !open;
    menuToggle.setAttribute('aria-expanded', String(open));
  };
  const setSidebar = (open, { focus = false } = {}) => {
    sidebar.classList.toggle('open', open);
    syncSidebar();
    if (focus) (open ? newButton : menuToggle).focus();
  };
  menuToggle.onclick = () => setSidebar(!sidebar.classList.contains('open'), { focus: true });
  mobile.addEventListener('change', syncSidebar);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && mobile.matches && sidebar.classList.contains('open')) setSidebar(false, { focus: true });
  });
  syncSidebar();

  ui = {
    sidebar, main, composer, siteFoot, alertsBox, exportBar, setupBtn, newButton, conversationList, quota, thread, threadInner, textarea, sendBtn, attachBtn, attachment, fileInput, composerError,
    closeSidebar: () => setSidebar(false),
  };
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

function showComposerError(message) {
  ui.composerError.textContent = message;
  ui.composerError.hidden = false;
}

function clearComposerError() {
  ui.composerError.hidden = true;
  ui.composerError.textContent = '';
}

// The new-conversation screen: the composer sits in the middle, large, with a short account of how the system works.
function showWelcome() {
  const slot = h('div', { class: 'welcome-composer' });
  ui.threadInner.replaceChildren(h('div', { class: 'welcome' },
    h('div', { class: 'gold-bar' }),
    h('h2', { text: 'איתור גזרי דין והנחיות לפי כתב אישום או הכרעת דין' }),
    h('p', { class: 'welcome-lead', text: 'הדביקו כאן את נוסח כתב האישום או הכרעת הדין, או צרפו קובץ Word או PDF.' }),
    slot,
    h('div', { class: 'welcome-about' },
      h('h3', { text: 'איך זה עובד' }),
      h('p', { text: 'המערכת קוראת את המסמך ומזהה לכל נאשם את העבירות, הסעיפים והנתונים המהותיים לענישה, כמו סוג הסם וכמותו, הנשק או הנזק. לפיהם היא מחפשת תיקים דומים במאגר הענישה של TAG‑IT: גזרי דין בהליכים פליליים בערכאה הדיונית בלבד, ללא פסקי דין בערעור. לצדם אפשר לחפש גם הסדרים מותנים והנחיות של הפרקליטות, המשטרה והיועצת המשפטית לממשלה.' }),
      h('p', { text: 'כל תוצאה עוברת מודל נוסף שמעריך עד כמה התיק דומה לתיק שלכם. כך מוצגות התוצאות הרלוונטיות ביותר, ואפשר להרחיב או לצמצם את הרשימה בלחיצה. גזרי הדין ממוינים לפי חומרת העונש, ובסוף מוצג סיכום עם טווח הענישה. זהו כלי עזר למחקר: יש לבדוק כל תוצאה מול המקור.' }))));
  setWelcomeMode(true, slot);
}

// Moves the composer into the middle of the welcome screen, or back to the bottom of the page.
function setWelcomeMode(on, slot = null) {
  const focused = document.activeElement === ui.textarea;
  ui.main.classList.toggle('welcome-mode', on);
  if (on && slot) slot.append(ui.composer);
  else if (!on && ui.composer.parentElement !== ui.main) ui.main.insertBefore(ui.composer, ui.siteFoot);
  if (focused) ui.textarea.focus();
}

function setBusy(busy) {
  state.busy = busy;
  ui.sendBtn.classList.toggle('stop', busy);
  ui.sendBtn.innerHTML = busy ? ICONS.stop : ICONS.send;
  ui.sendBtn.setAttribute('aria-label', busy ? 'עצירת העיבוד' : 'שליחה');
  ui.thread.setAttribute('aria-busy', String(busy));
  syncSetupButton();
}

function syncSetupButton() {
  if (!ui.setupBtn) return;
  ui.setupBtn.hidden = !state.currentId;
  ui.setupBtn.disabled = state.busy;
}

// The search-setup form, opened by the user in a follow-up. Its answer is sent as a message saying the setup
// changed, together with the new setup, which the server stores and applies to every later search.
function openSearchForm() {
  if (!state.currentId || state.busy) return;
  ui.threadInner.querySelectorAll('.setup-follow-up').forEach((el) => {
    if (!el.querySelector('.questions.answered')) el.remove();
  });
  const section = renderQuestions({
    intro: 'עדכון הגדרות החיפוש',
    followUp: true,
    questions: [{ id: 'mode', text: 'מה לחפש, ולפי אילו נתונים?', style: 'cards', multiple: false, allow_free_text: false, options: [] }],
  }, true);
  const wrap = h('div', { class: 'msg msg-assistant setup-follow-up' },
    h('img', { class: 'msg-avatar', src: '/icon.svg', alt: '' }), h('div', { class: 'msg-body' }, section));
  ui.threadInner.append(wrap);
  // Scroll the thread only: scrolling the element into view would also move the page around the fixed layout.
  ui.thread.scrollTop += wrap.getBoundingClientRect().top - ui.thread.getBoundingClientRect().top - 12;
  section.querySelector('input, select')?.focus({ preventScroll: true });
  announce('טופס החיפוש נפתח בסוף השיחה.');
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
    const isCurrent = conv.id === state.currentId;
    const title = conv.title || 'שיחה ללא כותרת';
    items.push(h('li', { class: `conv-item${isCurrent ? ' active' : ''}` },
      h('button', { class: 'conv-open', type: 'button', 'aria-current': isCurrent ? 'true' : null, title, text: title, onClick: () => openConversation(conv.id, { focusThread: true }) }),
      h('button', { class: 'icon-btn conv-del', type: 'button', 'aria-label': `מחיקת השיחה ${title}`, svg: ICONS.trash, onClick: () => deleteConversation(conv) })));
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
  if (id === state.currentId && title) {
    document.title = `${title} · ${APP_TITLE}`;
    const heading = ui.threadInner.querySelector(':scope > h2.sr-only');
    if (heading) heading.textContent = `שיחה: ${title}`;
  }
  renderConversationList();
}

async function deleteConversation(conv) {
  if (!confirm(`למחוק את השיחה "${conv.title || ''}"?`)) return;
  const res = await fetch(`/api/conversations/${conv.id}`, { method: 'DELETE' });
  if (!res.ok) { announce('מחיקת השיחה נכשלה.', { assertive: true }); return; }
  state.conversations = state.conversations.filter((c) => c.id !== conv.id);
  if (state.currentId === conv.id) newConversation({ focusComposer: false });
  renderConversationList();
  announce('השיחה נמחקה.');
  ui.newButton.focus();
}

function renderQuota(quota) {
  if (!quota) return;
  const periodLabel = quota.period === 'monthly' ? 'החודש' : 'מצטבר';
  if (quota.limit == null) {
    ui.quota.replaceChildren(h('p', { style: 'margin:0', text: `שימוש ${periodLabel}: ${fmtTokens(quota.used)} טוקנים (ללא מגבלה)` }));
    return;
  }
  const pct = Math.min(100, (quota.used / Math.max(quota.limit, 1)) * 100);
  const cls = pct >= 100 ? 'over' : pct >= 80 ? 'warn' : '';
  const text = `שימוש ${periodLabel}: ${fmtTokens(quota.used)} מתוך ${fmtTokens(quota.limit)} טוקנים`;
  ui.quota.replaceChildren(...[
    h('p', { style: 'margin:0', text }),
    h('div', {
      class: 'quota-bar', role: 'progressbar', 'aria-label': 'שימוש בטוקנים',
      'aria-valuenow': Math.round(pct), 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuetext': `${Math.round(pct)} אחוזים. ${text}`,
    }, h('span', { class: cls, style: `width:${pct}%` })),
    pct >= 100 ? h('p', { style: 'margin:0;color:var(--error)', text: 'הגעת למגבלת השימוש.' }) : null,
  ].filter(Boolean));
}

function newConversation({ focusComposer = true } = {}) {
  if (state.controller) return;
  stopFollowing();
  state.currentId = null;
  syncSetupButton();
  state.searchSetup = null;
  state.analysis = null;
  resetCitations();
  document.title = APP_TITLE;
  history.replaceState(null, '', location.pathname);
  showWelcome();
  renderConversationList();
  ui.closeSidebar();
  if (focusComposer) ui.textarea.focus();
}

async function openConversation(id, { focusThread = false } = {}) {
  if (state.controller) return;
  stopFollowing();
  const res = await fetch(`/api/conversations/${id}`);
  if (!res.ok) { newConversation(); return; }
  renderConversation(await res.json(), { focusThread });
}

function renderConversation({ conversation, turns, running, lastRequest }, { focusThread = false } = {}) {
  state.currentId = conversation.id;
  syncSetupButton();
  state.searchSetup = conversation.search_setup ?? null;
  state.analysis = conversation.analysis ?? null;
  resetCitations();
  for (const turn of turns) {
    for (const item of turn.ui?.items ?? []) {
      if (item.type === 'results') registerRulings(item.data?.items);
      if (item.type === 'arrangements') registerArrangements(item.data?.items);
      if (item.type === 'guidelines') registerGuidelines(item.data?.items);
    }
  }
  const title = conversation.title || 'שיחה ללא כותרת';
  document.title = `${title} · ${APP_TITLE}`;
  history.replaceState(null, '', `#c=${conversation.id}`);
  const heading = h('h2', { class: 'sr-only', tabindex: '-1', text: `שיחה: ${title}` });
  setWelcomeMode(false);
  ui.threadInner.replaceChildren(heading);
  ui.closeSidebar();
  renderConversationList();

  const lastIndex = turns.length - 1;
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
      const isLive = index === lastIndex && item === turn.ui.items.at(-1);
      assistant.item(item, { live: isLive && !running, quiet: true });
    }
  });
  assistant?.finish();
  if (running) {
    followServerTurn(conversation.id, 'הבקשה האחרונה עדיין בעיבוד בשרת. התשובה תוצג כאן כשתסתיים.');
  } else if (lastRequest && ['interrupted', 'error'].includes(lastRequest.status)) {
    ui.threadInner.append(h('div', { class: 'notice-box', role: 'status' },
      lastRequest.status === 'interrupted' ? 'העיבוד של הבקשה האחרונה נקטע לפני שהסתיים. ' : 'הבקשה האחרונה נכשלה. ',
      h('button', { class: 'link-btn', type: 'button', onClick: () => send({ text: 'המשך מהמקום שבו נעצרת.' }) }, 'המשך')));
  }
  scrollToBottom(true);
  if (focusThread) {
    heading.focus();
    announce(`נפתחה השיחה ${title}.`);
  }
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
  const line = h('div', { class: 'activity', role: 'status' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), h('span', { text: message }));
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
      if (state.currentId === conversationId) {
        renderConversation(data);
        announce('התשובה הושלמה והוצגה.');
      }
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
  clearComposerError();
  const ext = file.name.slice(file.name.lastIndexOf('.')).toLowerCase();
  if (!ACCEPTED_EXT.includes(ext)) {
    showComposerError(ext === '.doc'
      ? 'קובץ Word בפורמט הישן (.doc) אינו נתמך. יש לשמור אותו כ-docx או כ-PDF.'
      : 'ניתן לצרף קובצי Word (docx), PDF או טקסט בלבד.');
    return;
  }
  if (file.size > MAX_FILE_BYTES) { showComposerError('הקובץ גדול מדי. הגודל המרבי הוא 20MB.'); return; }
  state.file = file;
  ui.attachment.hidden = false;
  ui.attachment.replaceChildren(h('span', { class: 'attach-pill' },
    h('span', { svg: ICONS.file, style: 'display:inline-flex;width:16px;height:16px;color:var(--primary)' }),
    h('span', { text: file.name }),
    h('button', { type: 'button', 'aria-label': `הסרת הקובץ ${file.name}`, onClick: () => { clearFile(); announce('הקובץ הוסר.'); ui.attachBtn.focus(); } },
      h('span', { 'aria-hidden': 'true', text: '×' }))));
  ui.fileInput.value = '';
  announce(`הקובץ ${file.name} צורף.`);
  ui.textarea.focus();
}

function clearFile() {
  state.file = null;
  ui.attachment.hidden = true;
  ui.attachment.replaceChildren();
}

function renderUserMessage({ text, fileName, pasted, answers }) {
  const bubble = h('div', { class: 'bubble-user' }, srOnly('ההודעה שלך: '));
  if (fileName) bubble.append(h('div', { class: 'file-chip' }, h('span', { svg: ICONS.file, style: 'display:inline-flex' }), fileName), h('br'));
  if (Array.isArray(answers)) {
    bubble.append(...answers.filter((a) => a && typeof a === 'object').map((a) => {
      const selected = Array.isArray(a.selected) ? a.selected.map((s) => s?.label) : [];
      const value = [...selected, a.free_text].filter((x) => typeof x === 'string' && x).join(', ') || 'ללא העדפה';
      return h('div', {}, h('strong', { text: `${String(a.question ?? '')}: ` }), value);
    }));
  }
  if (text) bubble.append(h('div', { text: pasted && !text.endsWith('…') ? `${text}…` : text }));
  ui.threadInner.append(h('div', { class: 'msg msg-user' }, h('div', { class: 'msg-body' }, bubble)));
  scrollToBottom(true);
}

async function send({ answers = null, text: presetText = null } = {}) {
  if (state.busy) return;
  const text = answers ? (presetText ?? '') : (presetText ?? ui.textarea.value.trim());
  const file = answers ? null : state.file;
  if (!text && !file && !answers) return;
  clearComposerError();

  const form = new FormData();
  if (state.currentId) form.append('conversationId', state.currentId);
  form.append('text', text);
  if (file) form.append('file', file);
  if (answers) form.append('answers', JSON.stringify(answers));

  if (!state.currentId) ui.threadInner.replaceChildren(h('h2', { class: 'sr-only', text: 'שיחה חדשה' }));
  setWelcomeMode(false);
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
  announce('הבקשה נשלחה ומעובדת. אפשר לעצור בכפתור העצירה.');
  setBusy(true);
  const controller = new AbortController();
  state.controller = controller;
  let lastSeq = 0;
  const onEvent = (event) => {
    if (event.seq) lastSeq = event.seq;
    handleEvent(event, assistant);
  };
  let outcome; // done | ended | aborted | failed | lost
  try {
    const res = await fetch('/api/chat', { method: 'POST', body: form, signal: controller.signal });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      if (res.status === 429 && err.quota) { renderQuota(err.quota); assistant.error('הגעת למגבלת הטוקנים שהוגדרה לחשבונך. ניתן לפנות למנהל המערכת.'); }
      else if (res.status === 409) assistant.error('בקשה קודמת בשיחה זו עדיין בעיבוד.');
      else assistant.error(err.message || 'הבקשה נכשלה. נסו שוב.');
      outcome = 'failed';
    } else {
      await readEvents(res, onEvent).catch((err) => { if (controller.signal.aborted) throw err; });
      outcome = assistant.sawDone ? 'done' : await resumeStream(() => lastSeq, onEvent, assistant, controller.signal);
    }
  } catch {
    outcome = controller.signal.aborted ? 'aborted' : 'lost';
  }
  if (outcome === 'aborted') assistant.notice('העיבוד הופסק.');
  assistant.finish();
  state.controller = null;
  setBusy(false);
  loadConversations();
  refreshAlerts();

  if (outcome === 'done') {
    announce(assistant.askedQuestions ? 'התשובה הושלמה, והמערכת שואלת שאלות המשך בסופה.' : 'התשובה הושלמה.');
  } else if (outcome === 'ended' && state.currentId) {
    // The turn finished while no stream was attached: show the saved result.
    const res = await fetch(`/api/conversations/${state.currentId}`).catch(() => null);
    if (res?.ok) {
      renderConversation(await res.json());
      announce('התשובה הושלמה.');
    }
  } else if (outcome === 'lost') {
    if (state.currentId) followServerTurn(state.currentId, 'החיבור לשרת נותק, אבל העיבוד ממשיך בשרת. התשובה המלאה תוצג כאן כשתסתיים.');
    else ui.threadInner.append(h('div', { class: 'error-box', role: 'alert', text: 'החיבור לשרת נותק. נסו שוב.' }));
  }
}

// xhostd's proxy ends a response after about a minute, and a turn can run longer. Rejoin the turn's
// event stream from the last event received, so the answer keeps streaming without a visible break.
async function resumeStream(getSeq, onEvent, assistant, signal) {
  const conversationId = state.currentId;
  if (!conversationId) return 'lost';
  let failures = 0;
  while (!signal.aborted) {
    const seqBefore = getSeq();
    let connected = false;
    try {
      const res = await fetch(`/api/conversations/${conversationId}/stream?after=${seqBefore}`, { signal });
      if (res.status === 204) return 'ended';
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      connected = true;
      failures = 0;
      await readEvents(res, onEvent);
    } catch {
      if (signal.aborted) return 'aborted';
      if (!connected) failures++;
    }
    if (assistant.sawDone) return 'done';
    if (failures > 6) return 'lost';
    const idle = connected && getSeq() === seqBefore;
    if (failures || idle) await new Promise((resolve) => setTimeout(resolve, failures ? Math.min(8000, 500 * 2 ** failures) : 1000));
  }
  return 'aborted';
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
    case 'arrangements':
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
  const body = h('div', { class: 'msg-body' }, srOnly('תשובת המערכת:'));
  ui.threadInner.append(h('div', { class: 'msg msg-assistant' }, h('img', { class: 'msg-avatar', src: '/icon.svg', alt: '' }), body));
  let statusEl = null;
  let textEl = null;
  let textBuffer = '';
  let renderPending = false;
  let contentCount = 0;
  const activities = new Map();
  // Parallel tool calls: activity lines on top, then one slot per call so results keep call order
  // even when a later search finishes first.
  let toolArea = null;

  const append = (el) => {
    body.append(el);
    contentCount++;
    if (statusEl) body.append(statusEl); // keep the status line last
    scrollToBottom();
  };

  const block = {
    conversationId,
    askedQuestions: false,
    status(text) {
      if (!statusEl) statusEl = h('div', { class: 'activity' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), h('span'));
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
          if (textEl) { textEl.innerHTML = markdown(textBuffer); linkCitations(textEl); enhanceTables(textEl); scrollToBottom(); }
        });
      }
    },
    endSegment() {
      if (textEl) {
        textEl.innerHTML = markdown(textBuffer);
        linkCitations(textEl);
        enhanceTables(textEl);
        decorateLinks(textEl);
        textEl.classList.remove('cursor');
      }
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
        el = h('div', { class: 'activity' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), h('span'));
        activities.set(event.id, el);
        toolArea.list.append(el);
        const slot = h('div');
        toolArea.byId.set(event.id, slot);
        toolArea.slots.append(slot);
      }
      const label = event.summary ? `${event.label} · ${event.summary}` : event.label;
      el.lastChild.textContent = label;
      el.classList.toggle('done', event.state === 'done');
      if (event.state === 'done') announce(label);
      if (event.state === 'error') {
        el.classList.add('done', 'failed');
        el.lastChild.textContent = `${event.label} · נכשל`;
        announce(`${event.label} נכשל.`, { assertive: true });
      }
    },
    item(item, { live = false, toolUseId = null, quiet = false } = {}) {
      block.endSegment();
      let el = null;
      if (item.type === 'text') {
        el = h('div', { class: 'assistant-text', svg: markdown(item.text) });
        linkCitations(el);
        enhanceTables(el);
        decorateLinks(el);
      } else if (item.type === 'analysis') {
        state.analysis = item.data;
        el = renderAnalysis(item.data);
        if (!quiet) announce(item.data.is_supported ? 'הוצג ניתוח המסמך.' : 'המסמך אינו כתב אישום או הכרעת דין.');
      } else if (item.type === 'results') {
        el = renderResults(item.data, block);
        if (!quiet) announce(item.data.total != null ? `נמצאו ${item.data.total} גזרי דין.` : `הוצגו ${item.data.items.length} גזרי דין.`);
      } else if (item.type === 'arrangements') {
        el = renderResults(item.data, block, ARRANGEMENTS);
        if (!quiet) announce(item.data.total != null ? `נמצאו ${item.data.total} הסדרים מותנים.` : `הוצגו ${item.data.items.length} הסדרים מותנים.`);
      } else if (item.type === 'guidelines') {
        el = renderGuidelines(item.data);
        if (!quiet) announce(`נמצאו ${item.data.items.length} הנחיות.`);
      } else if (item.type === 'questions') {
        el = renderQuestions(item.data, live);
        if (live) block.askedQuestions = true;
      }
      if (!el) return;
      const slot = toolUseId && toolArea?.byId.get(toolUseId);
      if (slot) {
        slot.append(el);
        contentCount++;
        scrollToBottom();
      } else {
        toolArea = null;
        append(el);
      }
    },
    notice(text) { block.endSegment(); append(h('div', { class: 'notice-box', role: 'status', text })); },
    error(text) { block.endSegment(); append(h('div', { class: 'error-box', role: 'alert', text })); },
    finish() {
      block.endSegment();
      block.clearStatus();
      for (const el of activities.values()) el.classList.add('done');
      if (!contentCount) body.closest('.msg')?.remove();
    },
  };
  return block;
}

// ---------- Cards ----------

function renderAnalysis(a) {
  const counts = a.defendants.reduce((sum, d) => sum + d.counts.length, 0);
  const headingId = nextId('analysis');
  const meta = [['בית משפט', a.court], ['תיק', a.case_number], ['תאריך', fmtDate(a.document_date)]]
    .filter(([, v]) => v)
    .map(([k, v]) => h('span', {}, `${k}: `, h('b', { text: v })));

  const defendants = a.defendants.map((d) => {
    const label = [d.label, d.name].filter(Boolean).join(' · ');
    return h('div', { class: 'defendant' },
      h('div', { class: 'defendant-head' },
        h('h4', { style: 'margin:0;font-size:inherit', text: label }),
        h('span', { class: 'badge badge-muted', text: d.counts.length === 1 ? 'סעיף אחד' : `${d.counts.length} סעיפים` })),
      stackableTable(h('table', { class: 'charges' },
        h('caption', { class: 'sr-only', text: `סעיפים של ${label}` }),
        h('thead', {}, h('tr', {}, ['עבירה', 'חוק וסעיף', 'סטטוס', 'נתונים'].map((t) => h('th', { scope: 'col', text: t })))),
        h('tbody', {}, d.counts.map((c) => h('tr', {},
          h('td', { class: 'cell-offense', text: c.offense + (c.occurrences > 1 ? ` (${c.occurrences} עבירות)` : '') }),
          h('td', { class: 'cell-law' }, h('div', { class: 'charge-section', text: c.section || '—' }), c.law ? h('div', { class: 'small muted', text: c.law }) : null),
          h('td', { class: 'cell-status' }, h('span', { class: `badge ${c.status === 'acquitted' ? 'badge-muted' : c.status === 'convicted' ? 'badge-navy' : ''}`, text: COUNT_STATUS[c.status] || c.status })),
          h('td', { class: 'cell-facts' },
            c.drugs?.length ? h('div', { class: 'facts' }, c.drugs.map((drug) => h('span', { class: 'badge badge-gold', text: [drug.name, drug.amount != null ? fmtNumber(drug.amount) : null, drug.unit === 'grams' ? 'גרם' : drug.unit_label].filter(Boolean).join(' ') }))) : null,
            c.facts?.length ? h('ul', { class: 'fact-list' }, c.facts.map((f) => h('li', {}, h('span', { class: 'fact-label', text: `${f.label}: ` }), f.value))) : null,
            !c.drugs?.length && !c.facts?.length ? h('span', { class: 'muted', text: '—' }) : null))))), `סעיפים של ${label}`));
  });

  return h('section', { class: 'card analysis', 'aria-labelledby': headingId },
    h('div', { class: 'card-head' },
      h('h3', { class: 'card-title', id: headingId, text: 'ניתוח המסמך' }),
      h('span', { class: 'badge', text: DOC_TYPES[a.document_type] || a.document_type })),
    h('div', { class: 'card-body' },
      a.is_supported ? null : h('div', { class: 'notice-box', text: 'המערכת מיועדת לכתבי אישום ולהכרעות דין. המסמך שצורף אינו מאחד מסוגים אלה.' }),
      meta.length ? h('p', { class: 'analysis-meta' }, meta) : null,
      h('p', { class: 'small muted', style: 'margin:0', text: a.classification_reason }),
      a.defendants.length ? h('p', { class: 'small', style: 'margin:8px 0 0', text: `זוהו ${a.defendants.length === 1 ? 'נאשם אחד' : `${a.defendants.length} נאשמים`} ו${counts === 1 ? 'סעיף אחד' : `-${counts} סעיפים`}.` }) : null,
      defendants));
}

function sentenceBadges(r) {
  const badges = [];
  if (r.prisonMonths != null && r.prisonMonths > 0) badges.push(h('span', { class: 'badge badge-navy', text: `${fmtNumber(r.prisonMonths)} חודשי מאסר בפועל` }));
  else if (r.primaryPunishment) badges.push(h('span', { class: 'badge badge-navy', text: r.primaryPunishment }));
  if (r.serviceWorkMonths) badges.push(h('span', { class: 'badge', text: `${fmtNumber(r.serviceWorkMonths)} חודשי עבודות שירות` }));
  if (r.suspendedMonths) badges.push(h('span', { class: 'badge', text: `${fmtNumber(r.suspendedMonths)} חודשי מאסר על תנאי` }));
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

function clampedText(text, context) {
  if (!text) return null;
  const long = text.length > 220;
  const id = nextId('summary');
  const p = h('p', { class: `result-summary${long ? ' clamped' : ''}`, id, text });
  if (!long) return p;
  const toggle = h('button', {
    class: 'link-btn', type: 'button', 'aria-expanded': 'false', 'aria-controls': id,
    onClick: () => {
      const clamped = p.classList.toggle('clamped');
      toggle.setAttribute('aria-expanded', String(!clamped));
      toggle.firstChild.textContent = clamped ? 'הצגת התקציר המלא' : 'הסתרת התקציר';
    },
  }, 'הצגת התקציר המלא', srOnly(`: ${context}`));
  return [p, toggle];
}

function renderRuling(r, rank, corpus = SENTENCING, relevanceMode = null) {
  const severityClass = r.prisonMonths >= 36 ? 'severity-high' : r.prisonMonths > 0 ? 'severity-mid' : '';
  const titleId = nextId('ruling');
  const detailsId = nextId('details');
  const details = h('div', { class: 'small', id: detailsId, hidden: true, style: 'margin-top:8px' },
    (r.defendants || []).map((d, i) => h('p', { style: 'margin:0 0 6px' },
      h('strong', { text: d.name || `נאשם ${i + 1}` }), ': ',
      (d.punishments || []).map((p) => [p.type, p.value, p.unit].filter((x) => x != null && x !== '').join(' ')).join(' · ') || '—')),
    (r.ranges || []).filter((x) => x.min || x.max).map((x) => h('p', { style: 'margin:0' },
      h('strong', { text: `מתחם${x.group ? ` (${x.group})` : ''}: ` }), `${x.min || '?'} – ${x.max || '?'}`)),
    r.judges?.length ? h('p', { class: 'muted', style: 'margin:0', text: `שופטים: ${r.judges.join(', ')}` }) : null);
  let detailsBtn = null;
  if (details.childElementCount > 0) {
    detailsBtn = h('button', {
      class: 'link-btn', type: 'button', 'aria-expanded': 'false', 'aria-controls': detailsId,
      onClick: () => { details.hidden = !details.hidden; detailsBtn.setAttribute('aria-expanded', String(!details.hidden)); },
    }, 'פירוט נאשמים ומתחמים', srOnly(`: ${r.title}`));
  }

  return h('li', {},
    h('article', { class: `result ${severityClass}`, 'aria-labelledby': titleId },
      h('div', { class: 'result-rank', 'aria-hidden': 'true', title: 'דירוג לפי חומרת העונש', text: rank }),
      h('div', {},
        h('h4', { class: 'result-title', id: titleId }, externalLink(r.fileUrl, r.title)),
        h('p', { class: 'result-meta', text: [r.court, fmtDate(r.date), r.caseNumber && !r.title.includes(r.caseNumber) ? r.caseNumber : null].filter(Boolean).join(' · ') }),
        h('div', { class: 'result-sentence' }, sentenceBadges(r), relevanceBadge(r, relevanceMode)),
        r.snippet ? h('p', { class: 'result-summary small muted', text: r.snippet }) : null,
        clampedText(r.summary, r.title),
        h('div', { class: 'result-actions' },
          externalLink(r.fileUrl, corpus.open, `: ${r.title}`),
          r.sourceUrl ? externalLink(r.sourceUrl, 'מקור', `: ${r.title}`) : null,
          detailsBtn,
          itemExportButtons(corpus.kind, r)),
        details)));
}

// ---------- Relevance of results to the case ----------
// Each result carries a relevance score (0–3) when the admin turned scoring on. Users see a term, not the number,
// and step between levels with "expand" / "narrow"; the most relevant results are always shown.
const isAdmin = () => state.me?.user?.role === 'admin';
const RELEVANCE_LEVELS = [
  { min: 2.5, label: 'רלוונטיים מאוד', term: 'רלוונטי מאוד', tone: 'high' },
  { min: 1.5, label: 'רלוונטיים', term: 'רלוונטי', tone: 'mid' },
  { min: 0.5, label: 'רלוונטיים חלקית', term: 'רלוונטי חלקית', tone: 'low' },
  { min: -Infinity, label: 'כל התוצאות', term: 'רלוונטיות נמוכה', tone: 'none' },
];
const levelOfScore = (score) => RELEVANCE_LEVELS.find((level) => score >= level.min);
// The level the list opens at: the highest one within the admin's threshold.
const startLevel = (threshold) => Math.max(0, RELEVANCE_LEVELS.findIndex((level) => level.min <= (threshold ?? 1.5)));

function relevanceBadge(r, mode) {
  if (!r.relevance || !mode || mode === 'off' || (mode === 'admin' && !isAdmin())) return null;
  const { score } = r.relevance;
  const level = levelOfScore(score);
  // Admins also see the number, to calibrate the threshold.
  const text = isAdmin() ? `${level.term} (${score.toFixed(1)})` : level.term;
  return h('span', { class: `badge badge-relevance relevance-${level.tone}`, title: 'מידת הדמיון לתיק שבשיחה, כפי שהעריך מודל נוסף', text });
}

// Which results a level shows: every result at or above it, and always the `minShown` most relevant ones.
// A result without a score is always shown.
function visibleByRelevance(items, min, minShown) {
  const top = new Set([...items].filter((r) => r.relevance).sort((a, b) => b.relevance.score - a.relevance.score)
    .slice(0, minShown).map((r) => String(r.id)));
  return items.filter((r) => !r.relevance || r.relevance.score >= min || top.has(String(r.id)));
}

// Results left out by the current relevance level, per kind ("ruling:123"): kept out of exports.
const hiddenByRelevance = new Set();

// The relevance bar above one list: which level it shows, and "narrow" / "expand" to change it. In the users' mode
// everyone gets it; in the admins-only mode only admins do. `onChange` redraws the list.
function relevanceControl(data, items, { kind, many, onChange }) {
  const mode = data.relevance?.mode ?? 'off';
  const enabled = (mode === 'filter' || (mode === 'admin' && isAdmin())) && items.some((r) => r.relevance);
  const minShown = data.relevance?.minShown ?? 5;
  let level = startLevel(data.relevance?.threshold);
  const status = h('p', { class: 'relevance-status small', role: 'status' });
  const set = (next) => {
    level = Math.max(0, Math.min(RELEVANCE_LEVELS.length - 1, next));
    onChange();
    announce(status.textContent);
  };
  const narrowBtn = h('button', { class: 'btn btn-secondary btn-sm', type: 'button', onClick: () => set(level - 1) }, 'צמצום התוצאות');
  const widenBtn = h('button', { class: 'btn btn-secondary btn-sm', type: 'button', onClick: () => set(level + 1) }, 'הרחבת התוצאות');
  const bar = enabled
    ? h('div', { class: 'relevance-bar', role: 'group', 'aria-label': `רלוונטיות ${many}` }, status, h('div', { class: 'relevance-actions' }, narrowBtn, widenBtn))
    : null;
  const visible = () => (enabled ? visibleByRelevance(items, RELEVANCE_LEVELS[level].min, minShown) : items);
  // Called after each redraw: the status line, the buttons, and which results exports leave out.
  const sync = () => {
    const shown = visible();
    const shownIds = new Set(shown.map((r) => String(r.id)));
    for (const r of items) {
      const key = `${kind}:${r.id}`;
      if (shownIds.has(String(r.id))) hiddenByRelevance.delete(key);
      else hiddenByRelevance.add(key);
    }
    if (enabled) {
      const atLevel = items.filter((r) => !r.relevance || r.relevance.score >= RELEVANCE_LEVELS[level].min).length;
      status.textContent = `מוצגים ${fmtNumber(shown.length)} מתוך ${fmtNumber(items.length)} ${many} · ${RELEVANCE_LEVELS[level].label}${shown.length > atLevel ? ` (ולפחות ${minShown} הרלוונטיים ביותר)` : ''}`;
      narrowBtn.disabled = level === 0;
      widenBtn.disabled = level === RELEVANCE_LEVELS.length - 1;
    }
    ui.exportBar?.sync();
  };
  return { bar, mode, visible, sync };
}

// What tells the two document corpora apart on screen.
const SENTENCING = { kind: 'ruling', corpus: 'sentencing', heading: 'גזרי דין', many: 'גזרי דין', order: 'מהעונש', open: 'פתיחת גזר הדין', empty: 'לא נמצאו גזרי דין התואמים את החיפוש.', register: (items) => registerRulings(items) };
const ARRANGEMENTS = { kind: 'arrangement', corpus: 'arrangements', heading: 'הסדרים מותנים', many: 'הסדרים מותנים', order: 'מההסדר', open: 'פתיחת ההסדר', empty: 'לא נמצאו הסדרים מותנים התואמים את החיפוש.', register: (items) => registerArrangements(items) };

function renderResults(data, block, corpus = SENTENCING) {
  // Results saved before the level buttons existed kept the ones under the threshold apart, in hiddenItems.
  const items = [...data.items, ...(data.hiddenItems ?? [])];
  corpus.register(items);
  const PAGE = 10;
  let shown = PAGE;
  let page = data.page || 1;
  const headingId = nextId('results');
  const list = h('ol', { class: 'result-list' });
  const more = h('div', { class: 'results-more' });

  const relevance = relevanceControl(data, items, { kind: corpus.kind, many: corpus.many, onChange: () => { shown = Math.max(shown, PAGE); render(); } });
  const { mode } = relevance;
  const visible = relevance.visible;

  const render = ({ focusIndex = null } = {}) => {
    const all = visible();
    const slice = all.slice(0, shown);
    list.replaceChildren(...slice.map((r, i) => renderRuling(r, i + 1, corpus, mode)));
    if (focusIndex != null) list.children[focusIndex]?.querySelector('.result-title a')?.focus();
    relevance.sync();
    const canFetch = data.total != null && items.length < data.total && data.params;
    more.replaceChildren();
    if (slice.length < all.length || canFetch) {
      more.append(h('button', { class: 'btn btn-secondary btn-sm', type: 'button', onClick: async (e) => {
        const button = e.currentTarget;
        const before = slice.length;
        if (slice.length < all.length) {
          shown += PAGE;
          render({ focusIndex: before });
          announce(`מוצגים ${Math.min(shown, all.length)} ${corpus.many}.`);
          return;
        }
        button.disabled = true;
        button.textContent = 'טוען…';
        announce('טוען תוצאות נוספות…');
        try {
          const res = await fetch('/api/tagit/sentencing/more', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ conversationId: block.conversationId, params: data.params, page: page + 1, corpus: corpus.corpus }),
          });
          if (!res.ok) throw new Error();
          const nextPage = await res.json();
          page = nextPage.page;
          if (!nextPage.items.length) { data.total = items.length; }
          corpus.register(nextPage.items);
          items.push(...nextPage.items);
          shown += PAGE;
          render({ focusIndex: before });
          announce(`נטענו ${nextPage.items.length} ${corpus.many} נוספים.`);
        } catch {
          button.disabled = false;
          button.textContent = 'הטעינה נכשלה · נסו שוב';
          announce('טעינת התוצאות הנוספות נכשלה.', { assertive: true });
        }
      } }, 'הצגת תוצאות נוספות'));
    }
  };
  render();

  const count = data.total != null ? `נמצאו ${fmtNumber(data.total)} ${corpus.many}` : `${items.length} ${corpus.many}`;
  return h('section', { class: 'results', 'aria-labelledby': headingId },
    h('div', { class: 'results-head' },
      h('h3', { id: headingId, text: `${corpus.heading} · ${data.label}` }),
      h('p', { class: 'results-query', text: `${count} · ${data.params?.sort === 'date' ? 'מהחדש לישן' : `ממוינים ${corpus.order} ${data.params?.sort_direction === 'desc' ? 'החמור לקל' : 'הקל לחמור'}`}` })),
    data.textQueryDropped ? h('p', { class: 'notice-box small', text: 'מאגר TAG-IT לא איפשר לשלב את חיפוש הטקסט עם המסננים, ולכן החיפוש רץ לפי המסננים בלבד. ייתכן שחלק מהתוצאות אינן קשורות לעבירה.' }) : null,
    data.caseFieldsDropped ? h('p', { class: 'notice-box small', text: 'לא נמצאו הסדרים מותנים לפי נתוני התיק שנבחרו בטופס (סוג הסם, הכמות או הסעיפים), ולכן החיפוש רץ בלעדיהם.' }) : null,
    relevance.bar,
    items.length ? list : h('div', { class: 'notice-box', text: corpus.empty }),
    more);
}

function renderGuidelines(data) {
  const items = [...(data.items ?? [])];
  registerGuidelines(items);
  const headingId = nextId('guidelines');
  const list = h('ol', { class: 'result-list' });
  const relevance = relevanceControl(data, items, { kind: 'guideline', many: 'הנחיות', onChange: () => render() });
  const render = () => {
    list.replaceChildren(...relevance.visible().map((g, i) => {
      const titleId = nextId('guideline');
      return h('li', {},
        h('article', { class: 'result', 'aria-labelledby': titleId },
          h('div', { class: 'result-rank', 'aria-hidden': 'true', text: i + 1 }),
          h('div', {},
            h('h4', { class: 'result-title', id: titleId }, externalLink(g.fileUrl, g.title)),
            h('p', { class: 'result-meta', text: [g.number ? `הנחיה ${g.number}` : null, g.source, fmtDate(g.date)].filter(Boolean).join(' · ') }),
            h('div', { class: 'result-sentence' },
              g.topic ? h('span', { class: 'badge', text: g.topic }) : null,
              g.effectiveDate ? h('span', { class: 'badge badge-muted', text: `בתוקף מ-${fmtDate(g.effectiveDate)}` }) : null,
              g.supersedes ? h('span', { class: 'badge badge-muted', text: `מחליפה: ${g.supersedes}` }) : null,
              relevanceBadge(g, relevance.mode)),
            clampedText(g.summary, g.title),
            h('div', { class: 'result-actions' }, externalLink(g.fileUrl, 'פתיחת ההנחיה', `: ${g.title}`), itemExportButtons('guideline', g)))));
    }));
    relevance.sync();
  };
  render();
  return h('section', { class: 'results', 'aria-labelledby': headingId },
    h('div', { class: 'results-head' },
      h('h3', { id: headingId, text: `הנחיות · ${data.label}` }),
      h('p', { class: 'results-query', text: `${items.length} הנחיות` })),
    relevance.bar,
    items.length ? list : h('div', { class: 'notice-box', text: 'לא נמצאו הנחיות התואמות את החיפוש.' }));
}

function disableQuestions(section) {
  section.classList.add('answered');
  section.querySelectorAll('button, input, select').forEach((el) => { el.disabled = true; });
}

// ---------- Exports (PDF / DOCX) ----------
// The server builds the file in the background (full texts come from TAG-IT); the browser polls until it is ready.

// At most this many sentencing decisions (and as many arrangements) go into one export: the first ones shown.
const MAX_RULINGS = 30;

const EXPORT_SCOPES = {
  rulings: { label: 'כל גזרי הדין', done: 'גזרי הדין' },
  arrangements: { label: 'כל ההסדרים המותנים', done: 'ההסדרים המותנים' },
  guidelines: { label: 'כל ההנחיות', done: 'ההנחיות' },
  all: { label: 'הכל יחד', done: 'התוצאות' },
};

const inScope = (scope, kind) => scope === 'all' || scope === `${kind}s`;
// The results of one kind that the relevance level currently shows.
const shownKnown = (map, kind) => [...map.values()].filter((data) => !hiddenByRelevance.has(`${kind}:${data.id}`));
const exportItems = (scope) => [
  ...(inScope(scope, 'ruling') ? shownKnown(knownRulings, 'ruling').slice(0, MAX_RULINGS).map((data) => ({ kind: 'ruling', id: String(data.id), data })) : []),
  ...(inScope(scope, 'arrangement') ? shownKnown(knownArrangements, 'arrangement').slice(0, MAX_RULINGS).map((data) => ({ kind: 'arrangement', id: String(data.id), data })) : []),
  ...(inScope(scope, 'guideline') ? shownKnown(knownGuidelines, 'guideline').map((data) => ({ kind: 'guideline', id: String(data.id), data })) : []),
];

function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: name, hidden: true });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function fileNameFrom(res, fallback) {
  const header = res.headers.get('content-disposition') ?? '';
  const encoded = header.match(/filename\*=UTF-8''([^;]+)/i);
  if (encoded) { try { return decodeURIComponent(encoded[1]); } catch { /* fall through */ } }
  return fallback;
}

// Runs one export and reports progress through onProgress(text). Resolves when the file was handed to the browser.
async function runExport({ scope, format, items }, onProgress) {
  const res = await fetch('/api/export', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      conversationId: state.currentId, scope, format, items,
      includeSource: format === 'pdf' && state.includeSource,
      includeRaw: format === 'pdf' && state.includeRaw, // Word: the site's content only
    }),
  });
  const started = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(started.message || 'הייצוא נכשל.');
  for (let attempt = 0; attempt < 400; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, attempt < 3 ? 700 : 1500));
    const poll = await fetch(`/api/export/${started.jobId}`);
    if (poll.status === 202) {
      const p = await poll.json().catch(() => ({}));
      if (p.total > 1) onProgress?.(`מכין את הקובץ… ${p.done} מתוך ${p.total} מסמכים`);
      continue;
    }
    if (!poll.ok) throw new Error((await poll.json().catch(() => ({}))).message || 'הייצוא נכשל.');
    downloadBlob(await poll.blob(), fileNameFrom(poll, `export.${format}`));
    return;
  }
  throw new Error('הייצוא נמשך זמן רב מדי.');
}

// A PDF and a DOCX button for one decision or guideline.
function itemExportButtons(kind, data) {
  if (data?.id == null) return null;
  const noun = kind === 'ruling' ? 'גזר הדין' : kind === 'arrangement' ? 'ההסדר המותנה' : 'ההנחיה';
  const button = (format, label) => {
    const btn = h('button', { class: 'btn btn-secondary btn-sm', type: 'button', onClick: async () => {
      if (!state.currentId) return;
      btn.disabled = true;
      const original = btn.textContent;
      btn.textContent = 'מכין…';
      announce(`מכין את ${noun} לייצוא.`);
      try {
        await runExport({ scope: kind, format, items: [{ kind, id: String(data.id), data }] });
        announce(`קובץ ${label} של ${noun} הורד.`);
      } catch (err) {
        announce(err.message, { assertive: true });
        btn.title = err.message;
      } finally {
        btn.disabled = false;
        btn.textContent = original;
      }
    } }, label, srOnly(` – ייצוא ${noun}: ${data.title ?? ''}`));
    return btn;
  };
  return h('span', { class: 'item-export', role: 'group', 'aria-label': `ייצוא ${noun}` }, button('pdf', 'PDF'), button('docx', 'Word'));
}

// "Export" panel above the thread: every decision / every guideline / both, in PDF or DOCX.
function renderExportBar() {
  const status = h('p', { class: 'export-status small', role: 'status' });
  const counts = h('span', { class: 'muted' });
  const buttons = [];
  const row = (scope) => {
    const make = (format, label) => {
      const btn = h('button', { class: 'btn btn-secondary btn-sm', type: 'button', onClick: async () => {
        const items = exportItems(scope);
        if (!items.length || !state.currentId) return;
        buttons.forEach((b) => { b.disabled = true; });
        status.textContent = 'מכין את הקובץ…';
        try {
          await runExport({ scope, format, items }, (text) => { status.textContent = text; });
          status.textContent = `קובץ ${label} של ${EXPORT_SCOPES[scope].done} הורד.`;
        } catch (err) {
          status.textContent = err.message;
        } finally {
          sync();
        }
      } }, label, srOnly(` – ${EXPORT_SCOPES[scope].label}`));
      btn.dataset.scope = scope;
      buttons.push(btn);
      return btn;
    };
    return h('div', { class: 'export-row' },
      h('span', { class: 'export-row-label', text: EXPORT_SCOPES[scope].label }), make('pdf', 'PDF'), make('docx', 'Word'));
  };
  // What a PDF holds: the content shown in the site, or that and each document's original from the database.
  const rawName = nextId('export-raw');
  const rawOption = (value, label) => {
    const id = `${rawName}-${value}`;
    return h('label', { class: 'export-option', for: id },
      h('input', { type: 'radio', name: rawName, id, value, checked: String(state.includeRaw) === value,
        onChange: () => { state.includeRaw = value === 'true'; } }),
      h('span', { text: label }));
  };
  const rawChoice = h('fieldset', { class: 'export-choice' },
    h('legend', { text: 'תוכן קובץ ה-PDF' }),
    rawOption('false', 'תוכן האתר בלבד (הפרטים, התקציר, הנאשמים והמתחמים)'),
    rawOption('true', 'תוכן האתר וגם חומר הגלם: אחרי כל מסמך, הקובץ המקורי מהמאגר כפי שנשמר (כשהוא קיים)'));
  const sourceId = nextId('export-source');
  const sourceBox = h('input', { type: 'checkbox', id: sourceId, onChange: (e) => { state.includeSource = e.target.checked; } });
  const el = h('details', { class: 'export-bar', hidden: true },
    h('summary', {}, 'ייצוא התוצאות ל-PDF או Word ', counts),
    h('div', { class: 'export-body' },
      row('rulings'), row('arrangements'), row('guidelines'), row('all'),
      rawChoice,
      h('label', { class: 'export-option', for: sourceId }, sourceBox,
        h('span', { text: 'בייצוא ל-PDF: לצרף בתחילת הקובץ את מסמך המקור (הקובץ שהועלה או הטקסט שהודבק). חל גם על ייצוא של מסמך בודד.' })),
      h('p', { class: 'small muted', style: 'margin:0', text: `קובץ Word כולל את תוכן האתר בלבד. הטקסט בגופן Arial בגודל 13, ממורכז, ברווח שורות 1.5. מיוצאים עד ${MAX_RULINGS} גזרי דין ועד ${MAX_RULINGS} הסדרים מותנים: הראשונים שהוצגו בשיחה.` }),
      status));
  const sync = () => {
    const r = Math.min(shownKnown(knownRulings, 'ruling').length, MAX_RULINGS);
    const a = Math.min(shownKnown(knownArrangements, 'arrangement').length, MAX_RULINGS);
    const g = shownKnown(knownGuidelines, 'guideline').length;
    el.hidden = !r && !a && !g;
    counts.textContent = `(${[r ? `${r} גזרי דין` : null, a ? `${a} הסדרים מותנים` : null, g ? `${g} הנחיות` : null].filter(Boolean).join(', ')})`;
    for (const btn of buttons) btn.disabled = !exportItems(btn.dataset.scope).length;
  };
  sync();
  return { el, sync, reset: () => { status.textContent = ''; sync(); } };
}

// ---------- Citations in the model's text ----------
// The model never types case numbers: it writes [[ruling:ID]] / [[guideline:ID]] and the app renders a link
// labelled from TAG-IT's data. Any case number it still types is kept only if it matches a ruling returned in
// this conversation; otherwise the number is dropped, since a missing number is better than a wrong one.

const knownRulings = new Map();
const knownArrangements = new Map();
const knownGuidelines = new Map();

const CITATION_TOKEN = /\[\[(ruling|arrangement|guideline):(\d{1,12})\]\]/g;
// A court case number with its prefix, e.g. ת"פ 20328-06-25, תפ"ח 1234-05-20, ע"פ 3261/15.
const TYPED_CASE_NUMBER = /[א-ת]{1,4}["״'׳][א-ת]{1,2}\s*\d{1,6}(?:[-–]\d{1,2}[-–]\d{2,5}|\/\d{2,4})/g;
const numberSignature = (text) => (String(text).match(/\d+/g) ?? []).map((n) => String(Number(n))).sort().join('|');
const caseNumbersIn = (text) => String(text ?? '').match(TYPED_CASE_NUMBER) ?? [];

function registerRulings(items) {
  for (const r of items ?? []) if (r?.id != null) knownRulings.set(String(r.id), r);
  ui.exportBar?.sync();
}
function registerArrangements(items) {
  for (const a of items ?? []) if (a?.id != null) knownArrangements.set(String(a.id), a);
  ui.exportBar?.sync();
}
function registerGuidelines(items) {
  for (const g of items ?? []) if (g?.id != null) knownGuidelines.set(String(g.id), g);
  ui.exportBar?.sync();
}
function resetCitations() {
  hiddenByRelevance.clear();
  knownRulings.clear();
  knownArrangements.clear();
  knownGuidelines.clear();
  ui.exportBar?.reset();
}

// The number shown for a ruling comes from its title (what its card shows), and only when TAG-IT's separate
// case-number field does not contradict it.
function verifiedCaseNumber(r) {
  const inTitle = caseNumbersIn(r.title);
  if (!inTitle.length) return null;
  if (r.caseNumber && !inTitle.some((n) => numberSignature(n) === numberSignature(r.caseNumber))) return null;
  return inTitle[0];
}

function knownCaseSignatures() {
  const signatures = new Set();
  for (const r of [...knownRulings.values(), ...knownArrangements.values()]) {
    const number = verifiedCaseNumber(r);
    if (number) signatures.add(numberSignature(number));
  }
  return signatures;
}

function citationNode(kind, id) {
  if (kind === 'ruling' || kind === 'arrangement') {
    const noun = kind === 'ruling' ? 'גזר דין' : 'הסדר מותנה';
    const r = (kind === 'ruling' ? knownRulings : knownArrangements).get(id);
    if (!r) return document.createTextNode(noun);
    const label = verifiedCaseNumber(r) ?? (kind === 'ruling' ? 'גזר הדין' : 'ההסדר המותנה');
    return externalLink(r.fileUrl, label, `: ${r.title}`);
  }
  const g = knownGuidelines.get(id);
  if (!g) return document.createTextNode('הנחיה');
  return externalLink(g.fileUrl, g.title.length > 70 ? `${g.title.slice(0, 69)}…` : g.title, '');
}

function linkCitations(container) {
  const signatures = knownCaseSignatures();
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => (node.parentElement.closest('a, code, pre') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const node of nodes) {
    // While streaming, hide a token that has not finished arriving.
    const text = node.nodeValue.replace(/\[\[[a-z]*:?\d*\]?$/, '');
    if (!/\[\[|\d/.test(text)) { if (text !== node.nodeValue) node.nodeValue = text; continue; }
    const pattern = new RegExp(`${CITATION_TOKEN.source}|${TYPED_CASE_NUMBER.source}`, 'g');
    const parts = [];
    let last = 0;
    let changed = text !== node.nodeValue;
    for (const match of text.matchAll(pattern)) {
      let replacement = null;
      if (match[1]) replacement = citationNode(match[1], match[2]);
      else if (!signatures.has(numberSignature(match[0]))) replacement = document.createTextNode('גזר דין');
      if (!replacement) continue;
      parts.push(document.createTextNode(text.slice(last, match.index)), replacement);
      last = match.index + match[0].length;
      changed = true;
    }
    if (!changed) continue;
    parts.push(document.createTextNode(text.slice(last)));
    node.replaceWith(...parts);
  }
}

// ---------- Search setup: the form shown for the "mode" question ----------

let searchOptionsPromise = null;
function loadSearchOptions() {
  searchOptionsPromise ??= fetch('/api/search-options')
    .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
    .catch((err) => { searchOptionsPromise = null; throw err; });
  return searchOptionsPromise;
}

const FLAG_CHOICES = [['', 'הכל'], ['true', 'כן'], ['false', 'לא']];
const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

// Returns { el, answer() }. answer() gives { answer } for the chat API or { error, focus } when nothing is ticked.
// ---------- Drug-case fields in the search-setup form ----------
// The fields of the drug-sentencing search on z-g.co.il (served by /api/search-options from the shared config).

const DRUG_NAMES_BY_SLUG = {
  cannabis: 'קנאביס', cocaine: 'קוקאין', hashish: 'חשיש', heroin: 'הרואין', mdma: 'MDMA',
  ketamine: 'קטמין', lsd: 'LSD', meth: 'מתאמפטמין', buprenorphine: 'בופרנורפין', psilocybin: 'פסילוצין',
};
const DRUG_TYPES_KEY = 'meta.drug_types';
const QUANTITY_KEY = 'meta.drug_max_grams';
const DRUG_ORDINANCE_KEY = 'meta.drug_ordinance_sections';
const FIELD_GROUP_ORDER = ['סמים', 'עבירה', 'ענישה', ''];

const allCounts = (analysis) => (analysis?.defendants ?? []).flatMap((d) => d.counts ?? []);
const isDrugOrdinance = (count) => /סמים/.test(count?.law ?? '') || /סמים|סם /.test(count?.offense ?? '');

function isDrugCase(analysis) {
  return allCounts(analysis).some((count) => (count.drugs ?? []).length > 0 || isDrugOrdinance(count));
}

// A number around the document's quantity, rounded so the form shows a plain figure.
const roundQuantity = (n) => (n >= 10 ? Math.round(n) : Math.round(n * 10) / 10);

// What the document already says: the drugs, the Dangerous Drugs Ordinance sections, and for a single drug a
// quantity range of about ±33% (the same default the assistant uses).
function filtersFromAnalysis(analysis, fields) {
  const byKey = new Map(fields.map((f) => [f.key, f]));
  const initial = {};
  const typesField = byKey.get(DRUG_TYPES_KEY);
  const drugsByDefendant = (analysis?.defendants ?? []).map((d) => (d.counts ?? []).flatMap((c) => c.drugs ?? []));
  const drugName = (drug) => (typesField?.options.includes(drug.name) ? drug.name : DRUG_NAMES_BY_SLUG[drug.slug] ?? null);
  const names = [...new Set(drugsByDefendant.flat().map(drugName).filter(Boolean))].filter((n) => typesField?.options.includes(n));
  if (typesField && names.length) initial[DRUG_TYPES_KEY] = names;
  const quantityField = byKey.get(QUANTITY_KEY);
  if (quantityField && names.length === 1) {
    // The largest quantity any one defendant holds of that drug, all in one unit.
    const totals = drugsByDefendant.map((drugs) => drugs.filter((d) => drugName(d) === names[0] && d.amount > 0));
    const units = new Set(totals.flat().map((d) => d.unit ?? 'grams'));
    const amount = Math.max(0, ...totals.map((drugs) => drugs.reduce((sum, d) => sum + d.amount, 0)));
    if (amount > 0 && units.size === 1) {
      const unit = units.has('units') ? 'n' : 'g';
      if (unit === 'g' || quantityField.units?.some((u) => u.value === 'n')) {
        initial[QUANTITY_KEY] = { min: roundQuantity(amount * 0.67), max: roundQuantity(amount * 1.33), unit };
      }
    }
  }
  const sectionsField = byKey.get(DRUG_ORDINANCE_KEY);
  if (sectionsField) {
    const tokens = allCounts(analysis).filter(isDrugOrdinance).flatMap((c) => c.section_tokens ?? []).map((t) => String(t).trim());
    const sections = [...new Set(tokens)].filter((t) => sectionsField.options.includes(t));
    if (sections.length) initial[DRUG_ORDINANCE_KEY] = sections;
  }
  return initial;
}

function renderCaseFilters(fields, { initial, live }) {
  const readers = [];
  const control = (field) => {
    const value = initial?.[field.key];
    const labelId = nextId('case-field');
    if (field.control === 'multiselect') {
      const boxes = field.options.map((option) => {
        const boxId = nextId('case-option');
        const box = h('input', { type: 'checkbox', id: boxId, checked: Array.isArray(value) && value.includes(option), disabled: !live });
        return { option, box, el: h('label', { class: 'setup-source', for: boxId }, box, h('span', { text: field.optionLabels?.[option] ?? option })) };
      });
      readers.push({ field, read: () => {
        const chosen = boxes.filter((b) => b.box.checked).map((b) => b.option);
        return chosen.length ? chosen : null;
      }, show: (v) => v.join(', ') });
      return h('fieldset', { class: 'case-field case-field-wide' },
        h('legend', { class: 'label', text: field.label }),
        h('div', { class: 'setup-sources' }, boxes.map((b) => b.el)));
    }
    if (field.control === 'number' || field.control === 'yearrange') {
      const years = field.control === 'yearrange';
      const input = (bound, label) => {
        const inputId = nextId('case-num');
        const current = value?.[years ? (bound === 'min' ? 'from' : 'to') : bound];
        const el = h('input', {
          class: 'input', id: inputId, type: 'number', inputmode: years ? 'numeric' : 'decimal', min: years ? 1948 : 0,
          max: years ? 2100 : null, step: years ? 1 : 'any', value: current ?? '', disabled: !live,
          'aria-label': `${field.label}: ${label}`,
        });
        return { el, wrap: h('label', { class: 'case-range-part' }, h('span', { class: 'small', text: label }), el) };
      };
      const from = input('min', years ? 'משנה' : 'מ-');
      const to = input('max', years ? 'עד שנה' : 'עד');
      let unitSelect = null;
      if (field.units?.length) {
        unitSelect = h('select', { class: 'select', disabled: !live, 'aria-label': `${field.label}: יחידה` },
          field.units.map((u) => h('option', { value: u.value, selected: (value?.unit ?? 'g') === u.value }, u.label)));
      }
      readers.push({ field, read: () => {
        const a = from.el.value.trim();
        const b = to.el.value.trim();
        if (!a && !b) return null;
        if (years) return { ...(a ? { from: a } : {}), ...(b ? { to: b } : {}) };
        return { ...(a ? { min: Number(a) } : {}), ...(b ? { max: Number(b) } : {}), ...(unitSelect ? { unit: unitSelect.value } : {}) };
      }, check: () => {
        for (const part of [from.el, to.el]) {
          const text = part.value.trim();
          if (!text) continue;
          const n = Number(text);
          if (!Number.isFinite(n) || n < 0 || (years && !/^\d{4}$/.test(text))) {
            return { error: `${field.label}: ${years ? 'יש להזין שנה בת ארבע ספרות.' : 'יש להזין מספר חיובי.'}`, focus: part };
          }
        }
        const a = from.el.value.trim();
        const b = to.el.value.trim();
        if (a && b && Number(a) > Number(b)) return { error: `${field.label}: הערך הראשון גדול מהשני.`, focus: from.el };
        return null;
      }, show: (v) => {
        const unit = v.unit ? ` ${field.units.find((u) => u.value === v.unit)?.label ?? ''}` : '';
        const a = v.min ?? v.from;
        const b = v.max ?? v.to;
        return `${a != null && b != null ? `${a}–${b}` : a != null ? `מ-${a}` : `עד ${b}`}${unit}`;
      } });
      return h('div', { class: 'case-field', role: 'group', 'aria-labelledby': labelId },
        h('span', { class: 'label', id: labelId, text: field.label }),
        h('div', { class: 'case-range' }, from.wrap, to.wrap, unitSelect));
    }
    const inputId = nextId('case-input');
    const el = field.control === 'select'
      ? h('select', { class: 'select', id: inputId, disabled: !live },
        h('option', { value: '' }, 'הכל'),
        field.options.map((option) => h('option', { value: option, selected: value === option }, field.optionLabels?.[option] ?? option)))
      : h('input', { class: 'input', id: inputId, type: 'text', maxlength: 100, value: value ?? '', disabled: !live });
    readers.push({ field, read: () => el.value.trim() || null, show: (v) => v });
    return h('div', { class: 'case-field' }, h('label', { class: 'label', for: inputId, text: field.label }), el);
  };

  const groups = new Map();
  for (const field of fields) {
    const group = FIELD_GROUP_ORDER.includes(field.group ?? '') ? field.group ?? '' : '';
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(field);
  }
  const GROUP_TITLES = { 'סמים': 'הסם והכמות', 'עבירה': 'סעיפי העבירה', 'ענישה': 'העונש שהוטל', '': 'בית המשפט והמועד' };
  const el = h('div', { class: 'case-filters' },
    FIELD_GROUP_ORDER.filter((g) => groups.has(g)).map((group) => {
      const grid = h('div', { class: 'case-grid' }, groups.get(group).map(control));
      if (group === 'סמים') return h('div', { class: 'case-group' }, h('p', { class: 'case-group-title', text: GROUP_TITLES[group] }), grid);
      const filled = groups.get(group).some((f) => initial?.[f.key] != null);
      return setupFold(GROUP_TITLES[group] ?? group, filled, grid);
    }));
  return {
    el,
    values: () => Object.fromEntries(readers.map((r) => [r.field.key, r.read()]).filter(([, v]) => v != null)),
    invalid: () => readers.map((r) => r.check?.()).find(Boolean) ?? null,
    summary: () => readers.map((r) => {
      const v = r.read();
      return v == null ? null : `${r.field.label}: ${r.show(v)}`;
    }).filter(Boolean),
  };
}

// A folding section of the search form: closed unless it already holds a choice.
function setupFold(title, open, ...children) {
  return h('details', { class: 'setup-fold', open: open || null }, h('summary', { text: title }), h('div', { class: 'setup-fold-body' }, ...children));
}

// The fields of the drug-sentencing search that describe the offence, and so also fit conditional arrangements.
const ARRANGEMENT_CASE_KEYS = new Set(['meta.drug_types', 'meta.drug_max_grams', 'meta.drug_ordinance_sections']);

function renderSearchSetup(q, { live, prior }) {
  const id = nextId('setup');
  const textId = `${id}-text`;
  // Default: sentencing decisions (a choice already made in this conversation wins).
  const chosenKinds = new Set(prior?.kinds ?? ['sentencing']);
  const kindBox = (name) => h('input', { type: 'checkbox', id: `${id}-${name}`, checked: chosenKinds.has(name) });
  const sentencing = kindBox('sentencing');
  const arrangements = kindBox('arrangements');
  const guidelines = kindBox('guidelines');
  const kind = (input, title, description) => h('label', { class: 'setup-kind', for: input.id },
    input, h('span', { class: 'setup-kind-text' }, h('strong', { text: title }), h('span', { text: description })));

  const sortFieldset = (name, [light, heavy]) => {
    const sortName = `${id}-${name}-sort`;
    const chosenSort = prior?.[name]?.sort_direction ?? 'asc';
    const sortOption = (value, label) => {
      const radioId = `${sortName}-${value}`;
      return h('label', { class: 'setup-radio', for: radioId },
        h('input', { type: 'radio', name: sortName, id: radioId, value, checked: chosenSort === value }), h('span', { text: label }));
    };
    return { sortName, el: h('fieldset', { class: 'setup-fieldset' },
      h('legend', { text: 'סדר התוצאות' }),
      h('div', { class: 'setup-radios' }, sortOption('asc', light), sortOption('desc', heavy))) };
  };

  // Each corpus has its own panel with its own fields. A drug case adds the fields of the drug-sentencing search on
  // z-g.co.il, filled in from the document: all of them for sentencing decisions, and the drug, quantity and
  // sections for conditional arrangements.
  const drugCase = isDrugCase(state.analysis)
    || Boolean(Object.keys(prior?.sentencing?.filters ?? {}).length || Object.keys(prior?.arrangements?.filters ?? {}).length);
  const panel = (title, subtitle, ...children) => h('section', { class: 'setup-panel setup-card' },
    h('div', { class: 'setup-card-head' }, h('h4', { text: title }), h('p', { class: 'small muted', text: subtitle })),
    ...children);
  const caseBox = (label) => h('div', { class: 'setup-case' }, h('p', { class: 'small muted', text: `טוען את ${label}…` }));

  // Sentencing decisions.
  const sentencingSort = sortFieldset('sentencing', ['מהעונש הקל לחמור', 'מהעונש החמור לקל']);
  const sentencingCaseBox = drugCase ? caseBox('נתוני התיק') : null;
  let sentencingCase = null;
  const flagSelects = new Map();
  const flagsGrid = h('div', { class: 'setup-flags' }, h('p', { class: 'small muted', text: 'טוען את נתוני גזירת העונש…' }));
  const priorFlags = Object.keys(prior?.sentencing?.flags ?? {}).length > 0;
  const sentencingPanel = panel('גזרי דין', 'גזרי דין בעבירות דומות, בערכאה הדיונית',
    sentencingSort.el,
    sentencingCaseBox ? h('div', { class: 'setup-block' }, h('p', { class: 'setup-block-title', text: 'נתוני התיק' }),
      h('p', { class: 'question-help', text: 'מולאו מתוך המסמך; אפשר לשנות או לנקות. שדה ריק אינו מסנן.' }), sentencingCaseBox) : null,
    setupFold('גזירת העונש (הודה, עונש מוסכם, עבר פלילי ועוד)', priorFlags,
      h('p', { class: 'question-help', text: '"הכל" משאיר את הנתון פתוח; "כן" או "לא" מצמצמים את התוצאות.' }),
      flagsGrid));

  // Conditional arrangements: closed by consent, without an indictment; filtered by the offence and by what the
  // suspect undertook.
  const arrangementsSort = sortFieldset('arrangements', ['מההסדר הקל לחמור', 'מההסדר החמור לקל']);
  const arrangementsCaseBox = drugCase ? caseBox('נתוני התיק') : null;
  let arrangementsCase = null;
  const punishmentBoxes = new Map();
  const punishmentsList = h('div', { class: 'setup-sources' }, h('p', { class: 'small muted', text: 'טוען את סוגי הענישה…' }));
  const arrangementsPanel = panel('הסדרים מותנים', 'תיקים שנסגרו בהסדר מותנה, ללא כתב אישום',
    arrangementsSort.el,
    arrangementsCaseBox ? h('div', { class: 'setup-block' }, h('p', { class: 'setup-block-title', text: 'נתוני התיק' }),
      h('p', { class: 'question-help', text: 'אם לא יימצאו הסדרים לפי נתונים אלה, החיפוש ירוץ בלעדיהם.' }), arrangementsCaseBox) : null,
    setupFold('הענישה בהסדר', Boolean(prior?.arrangements?.punishment_types?.length),
      h('p', { class: 'question-help', text: 'אם לא נבחר סוג, יוחזרו הסדרים מכל הסוגים.' }),
      punishmentsList));

  // Guidelines.
  const sourceBoxes = new Map();
  const sourcesList = h('div', { class: 'setup-sources' }, h('p', { class: 'small muted', text: 'טוען את רשימת המקורות…' }));
  const allSources = h('button', { class: 'link-btn', type: 'button', onClick: () => {
    const anyUnchecked = [...sourceBoxes.values()].some((box) => !box.checked);
    sourceBoxes.forEach((box) => { box.checked = anyUnchecked; });
    announce(anyUnchecked ? 'כל המקורות סומנו.' : 'הסימון הוסר מכל המקורות.');
  } }, 'סימון או ניקוי של כל המקורות');
  const guidelinesPanel = panel('הנחיות', 'הנחיות הפרקליטות, המשטרה והיועמ"ש',
    setupFold('מקורות ההנחיות', Boolean(prior?.guidelines?.sources?.length),
      h('p', { class: 'question-help', text: 'אם לא נבחר מקור, יוחזרו הנחיות מכל המקורות.' }),
      sourcesList,
      h('div', { style: 'margin-top:6px' }, allSources)));

  loadSearchOptions().then((options) => {
    const fields = options.sentencingFields ?? [];
    const fromDocument = live ? filtersFromAnalysis(state.analysis, fields) : {};
    const caseFilters = (box, keys, priorFilters) => {
      if (!box) return null;
      const own = keys ? fields.filter((f) => keys.has(f.key)) : fields;
      if (!own.length) {
        box.replaceChildren(h('p', { class: 'small', text: 'שדות החיפוש בעבירות סמים אינם זמינים כרגע. אפשר לחפש גם בלעדיהם.' }));
        return null;
      }
      const initial = priorFilters ?? Object.fromEntries(Object.entries(fromDocument).filter(([key]) => own.some((f) => f.key === key)));
      const filters = renderCaseFilters(own, { initial, live });
      box.replaceChildren(filters.el);
      return filters;
    };
    sentencingCase = caseFilters(sentencingCaseBox, null, prior?.sentencing?.filters ?? null);
    arrangementsCase = caseFilters(arrangementsCaseBox, ARRANGEMENT_CASE_KEYS, prior?.arrangements?.filters ?? null);
    flagsGrid.replaceChildren(...options.sentencingFlags.map((flag) => {
      const selectId = nextId('flag');
      const current = prior?.sentencing?.flags?.[flag.key];
      const select = h('select', { class: 'select', id: selectId, disabled: !live },
        FLAG_CHOICES.map(([value, label]) => h('option', { value, selected: String(current ?? '') === value }, label)));
      flagSelects.set(flag.key, { select, label: flag.label });
      return h('div', { class: 'setup-flag' }, h('label', { class: 'label', for: selectId, text: flag.label }), select);
    }));
    const priorPunishments = prior?.arrangements?.punishment_types ?? [];
    punishmentsList.replaceChildren(...((options.arrangementPunishments ?? []).length
      ? options.arrangementPunishments.map((value) => {
        const boxId = nextId('punishment');
        const box = h('input', { type: 'checkbox', id: boxId, checked: priorPunishments.includes(value), disabled: !live });
        punishmentBoxes.set(value, box);
        return h('label', { class: 'setup-source', for: boxId }, box, h('span', { text: value }));
      })
      : [h('p', { class: 'small', text: 'רשימת סוגי הענישה אינה זמינה כרגע; החיפוש יכלול את כל ההסדרים.' })]));
    const chosen = new Set(prior?.guidelines?.sources ?? []);
    sourcesList.replaceChildren(...(options.guidelineSources.length
      ? options.guidelineSources.map((source) => {
        const boxId = nextId('source');
        const box = h('input', { type: 'checkbox', id: boxId, checked: chosen.has(source.value), disabled: !live });
        sourceBoxes.set(source.value, box);
        return h('label', { class: 'setup-source', for: boxId }, box,
          h('span', { text: source.value }), source.count != null ? h('span', { class: 'muted', text: ` (${fmtNumber(source.count)})` }) : null);
      })
      : [h('p', { class: 'small', text: 'רשימת המקורות אינה זמינה כרגע; החיפוש יכלול את כל המקורות.' })]));
    allSources.hidden = !options.guidelineSources.length;
  }).catch(() => {
    for (const box of [sentencingCaseBox, arrangementsCaseBox]) box?.replaceChildren(h('p', { class: 'small', text: 'שדות החיפוש בעבירות סמים אינם זמינים כרגע. אפשר לחפש גם בלעדיהם.' }));
    flagsGrid.replaceChildren(h('p', { class: 'small', text: 'נתוני גזירת העונש אינם זמינים כרגע. אפשר לחפש גם בלעדיהם.' }));
    punishmentsList.replaceChildren(h('p', { class: 'small', text: 'רשימת סוגי הענישה אינה זמינה כרגע; החיפוש יכלול את כל ההסדרים.' }));
    sourcesList.replaceChildren(h('p', { class: 'small', text: 'רשימת המקורות אינה זמינה כרגע; החיפוש יכלול את כל המקורות.' }));
    allSources.hidden = true;
  });

  const kindBoxes = [sentencing, arrangements, guidelines];
  const sync = () => {
    sentencingPanel.hidden = !sentencing.checked;
    arrangementsPanel.hidden = !arrangements.checked;
    guidelinesPanel.hidden = !guidelines.checked;
  };
  kindBoxes.forEach((box) => box.addEventListener('change', sync));
  sync();
  if (!live) kindBoxes.forEach((box) => { box.disabled = true; });

  const el = h('div', { class: 'question search-setup', role: 'group', 'aria-labelledby': textId },
    h('p', { class: 'question-text', id: textId, text: q.text || 'מה לחפש?' }),
    h('div', { class: 'setup-kinds' },
      kind(sentencing, 'גזרי דין', 'גזרי דין בעבירות דומות'),
      kind(arrangements, 'הסדרים מותנים', 'תיקים שנסגרו ללא כתב אישום'),
      kind(guidelines, 'הנחיות', 'הנחיות לפי הגוף שפרסם אותן')),
    h('div', { class: 'setup-panels' }, sentencingPanel, arrangementsPanel, guidelinesPanel));

  const sortOf = (sortName) => (el.querySelector(`input[name="${sortName}"]:checked`)?.value === 'desc' ? 'desc' : 'asc');

  const answer = () => {
    const kinds = [['sentencing', sentencing], ['arrangements', arrangements], ['guidelines', guidelines]]
      .filter(([, box]) => box.checked).map(([name]) => name);
    if (!kinds.length) return { error: 'יש לסמן לפחות סוג אחד של תוצאות: גזרי דין, הסדרים מותנים או הנחיות.', focus: sentencing };
    const summary = [];
    const setup = { kinds };
    for (const [box, filters] of [[sentencing, sentencingCase], [arrangements, arrangementsCase]]) {
      const invalid = box.checked ? filters?.invalid() : null;
      if (invalid) return invalid;
    }
    const caseValues = (filters) => {
      const values = filters?.values() ?? {};
      return Object.keys(values).length ? { filters: values } : {};
    };
    const sources = [...sourceBoxes].filter(([, box]) => box.checked).map(([value]) => value);
    // Everything ticked is the same as no filter, and cheaper to search.
    const sourceFilter = sources.length === sourceBoxes.size ? [] : sources;
    const order = (direction) => (direction === 'asc' ? 'מהקל לחמור' : 'מהחמור לקל');
    if (sentencing.checked) {
      const flags = {};
      const flagText = [];
      for (const [key, { select, label }] of flagSelects) {
        if (!select.value) continue;
        flags[key] = select.value === 'true';
        flagText.push(`${label}: ${flags[key] ? 'כן' : 'לא'}`);
      }
      const sortDirection = sortOf(sentencingSort.sortName);
      setup.sentencing = { flags, sort_direction: sortDirection, ...caseValues(sentencingCase) };
      summary.push(`גזרי דין (${order(sortDirection)})`, ...(sentencingCase?.summary() ?? []), ...flagText);
    }
    if (arrangements.checked) {
      const punishments = [...punishmentBoxes].filter(([, box]) => box.checked).map(([value]) => value);
      // Everything ticked is the same as no filter, and cheaper to search.
      const punishmentFilter = punishments.length === punishmentBoxes.size ? [] : punishments;
      const sortDirection = sortOf(arrangementsSort.sortName);
      setup.arrangements = { punishment_types: punishmentFilter, sort_direction: sortDirection, ...caseValues(arrangementsCase) };
      summary.push(`הסדרים מותנים (${order(sortDirection)})`, ...(arrangementsCase?.summary() ?? []),
        `ענישה: ${punishmentFilter.length ? punishmentFilter.join(', ') : 'כל הסוגים'}`);
    }
    if (guidelines.checked) {
      setup.guidelines = { sources: sourceFilter };
      summary.push(`הנחיות: ${sourceFilter.length ? sourceFilter.join(', ') : 'כל המקורות'}`);
    }
    return {
      answer: {
        id: q.id,
        question: clip(q.text || 'מה לחפש?', 500),
        selected: [{ value: kinds.join('+'), label: clip(summary.join(' · '), 300) }],
        free_text: null,
        setup,
      },
    };
  };
  return { el, answer };
}

function renderQuestions(data, live) {
  const selections = new Map(data.questions.map((q) => [q.id, new Set(q.options.filter((o) => o.recommended && !q.multiple).map((o) => o.value))]));
  const freeInputs = new Map();
  const headingId = nextId('questions');
  const section = h('section', { class: 'card questions', 'aria-labelledby': headingId });
  const setups = new Map(); // question id → search-setup form
  const formError = h('p', { class: 'error-box', role: 'alert', hidden: true });

  const submit = () => {
    const answers = [];
    for (const q of data.questions) {
      const setup = setups.get(q.id);
      if (setup) {
        const result = setup.answer();
        if (result.error) {
          formError.textContent = result.error;
          formError.hidden = false;
          result.focus?.focus();
          return;
        }
        answers.push(result.answer);
        state.searchSetup = result.answer.setup;
        continue;
      }
      answers.push({
        id: q.id,
        question: q.text,
        selected: q.options.filter((o) => selections.get(q.id).has(o.value)).map((o) => ({ value: o.value, label: o.label })),
        free_text: freeInputs.get(q.id)?.value.trim() || null,
      });
    }
    formError.hidden = true;
    ui.textarea.focus(); // the focused option is about to be disabled
    disableQuestions(section);
    if (data.followUp) {
      // The new setup is shown with the answer and applied by the server; the text asks for the searches again.
      send({ answers, text: 'עדכנתי את הגדרות החיפוש בטופס. הרץ מחדש את החיפושים לפי ההגדרות החדשות.' });
    } else {
      send({ answers });
    }
  };

  const questionEls = data.questions.map((q) => {
    if (q.id === 'mode') {
      const setup = renderSearchSetup(q, { live, prior: state.searchSetup });
      setups.set(q.id, setup);
      return setup.el;
    }
    const selected = selections.get(q.id);
    const textId = nextId('question');
    const helpId = q.help ? nextId('question-help') : null;
    const immediate = q.style === 'cards' && !q.multiple && data.questions.length === 1 && !data.questions.some((x) => x.id === 'mode');
    const hintId = immediate && live ? nextId('question-hint') : null;
    const optionButtons = [];
    const refresh = () => optionButtons.forEach(([btn, value]) => btn.setAttribute('aria-pressed', String(selected.has(value))));
    const choose = (value) => {
      if (q.multiple) { selected.has(value) ? selected.delete(value) : selected.add(value); }
      else { selected.clear(); selected.add(value); }
      refresh();
      if (immediate) submit();
    };
    const options = q.options.map((o) => {
      const btn = q.style === 'cards'
        ? h('button', { class: 'mode-btn', type: 'button', onClick: () => choose(o.value) },
          h('strong', { text: o.label }), o.description ? h('span', { text: o.description }) : null)
        : h('button', { class: 'chip', type: 'button', title: o.description || null, onClick: () => choose(o.value) },
          o.label,
          o.recommended ? h('span', { 'aria-hidden': 'true', text: ' ★' }) : null,
          o.recommended ? srOnly(' (מומלץ)') : null,
          o.description ? srOnly(` – ${o.description}`) : null);
      optionButtons.push([btn, o.value]);
      return btn;
    });
    refresh();
    let free = null;
    if (q.allow_free_text) {
      const placeholder = q.options.length ? 'תשובה אחרת (לא חובה)' : 'התשובה שלך';
      free = h('input', { class: 'input', type: 'text', placeholder, 'aria-label': `${q.text}: ${placeholder}` });
      freeInputs.set(q.id, free);
    }
    return h('div', { class: 'question', role: 'group', 'aria-labelledby': textId, 'aria-describedby': [helpId, hintId].filter(Boolean).join(' ') || null },
      h('p', { class: 'question-text', id: textId, text: q.text }),
      q.help ? h('p', { class: 'question-help', id: helpId, text: q.help }) : null,
      hintId ? h('p', { class: 'question-help', id: hintId, text: 'הבחירה תישלח מיד.' }) : null,
      options.length ? h('div', { class: q.style === 'cards' ? 'mode-picker' : 'chips' }, options) : null,
      free);
  });

  const onlyCards = data.questions.length === 1 && data.questions[0].style === 'cards' && !data.questions[0].multiple && !setups.size;
  section.append(
    h('h3', { id: headingId, text: data.intro || 'כדי למקד את החיפוש' }),
    ...questionEls,
    formError,
    h('div', { class: 'questions-actions' },
      onlyCards ? null : h('button', { class: 'btn btn-primary', type: 'button', onClick: submit }, setups.size ? 'חיפוש' : 'שליחת תשובות')));
  if (!live) disableQuestions(section);
  return section;
}

boot();
