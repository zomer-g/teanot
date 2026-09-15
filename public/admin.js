import { marked } from '/vendor/marked.js';
import DOMPurify from '/vendor/purify.js';

function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value == null || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'text') el.textContent = value;
    else if (key === 'html') el.innerHTML = value;
    else if (key.startsWith('on')) el.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === 'value') el.value = value;
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
const truncate = (s, n) => (s && s.length > n ? `${s.slice(0, n)}…` : s);

const liveStatus = document.getElementById('liveStatus');
function announce(text) {
  liveStatus.textContent = '';
  setTimeout(() => { liveStatus.textContent = text; }, 80);
}

const fmtInt = (n) => (n == null ? '—' : Math.round(Number(n)).toLocaleString('he-IL'));
const fmtUsd = (n) => {
  const value = Number(n || 0);
  return `$${value.toFixed(value > 0 && value < 1 ? 3 : 2)}`;
};
const fmtDuration = (seconds) => {
  if (seconds == null) return '—';
  if (seconds < 60) return `${Math.round(seconds)} שנ׳`;
  return `${Math.floor(seconds / 60)}:${String(Math.round(seconds % 60)).padStart(2, '0')} דק׳`;
};
const fmtDateTime = (v) => (v ? new Date(v).toLocaleString('he-IL', { dateStyle: 'short', timeStyle: 'short' }) : '—');
const STATUS_LABELS = { active: 'פעיל', pending: 'ממתין לאישור', blocked: 'חסום' };
const ROLE_LABELS = { user: 'משתמש', admin: 'מנהל' };
const PERIOD_LABELS = { '': 'ברירת מחדל', monthly: 'חודשי', total: 'מצטבר' };

async function api(path, options = {}) {
  const res = await fetch(`/api/admin${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { data });
  return data;
}

// Toasts stay long enough to read; errors use role=alert so they are announced immediately.
function toast(text, { error = false } = {}) {
  const el = h('div', { class: `toast${error ? ' toast-error' : ''}`, role: error ? 'alert' : 'status', text });
  document.body.append(el);
  setTimeout(() => el.remove(), 6000);
}

const state = { users: [], settings: {}, usage: { offset: 0, limit: 100, filters: {} }, queries: { offset: 0, limit: 50, filters: {} } };
const select = (options, value, props = {}) =>
  h('select', { class: 'select', ...props }, Object.entries(options).map(([v, label]) => h('option', { value: v, selected: v === (value ?? '') }, label)));

// A scrollable, labelled data table (keyboard users can focus the region to scroll it).
function dataTable(caption, headers, rows, emptyText) {
  return h('div', { class: 'card table-scroll', role: 'region', 'aria-label': caption, tabindex: '0' },
    h('table', { class: 'data-table' },
      h('caption', { class: 'sr-only', text: caption }),
      h('thead', {}, h('tr', {}, headers.map((label) => h('th', { scope: 'col' }, label || srOnly('פעולות'))))),
      h('tbody', {}, rows.length ? rows : h('tr', {}, h('td', { colspan: headers.length, class: 'muted', text: emptyText })))));
}

function pager(offset, limit, count, total, onPage) {
  return h('nav', { class: 'toolbar', style: 'margin-top:12px;justify-content:center', 'aria-label': 'דפדוף' },
    h('button', { class: 'btn btn-secondary btn-sm', type: 'button', disabled: offset === 0, onClick: () => onPage(Math.max(0, offset - limit)) }, 'הקודם'),
    h('span', { class: 'small muted', text: count ? `${offset + 1}–${offset + count} מתוך ${fmtInt(total)}` : '' }),
    h('button', { class: 'btn btn-secondary btn-sm', type: 'button', disabled: offset + limit >= total, onClick: () => onPage(offset + limit) }, 'הבא'));
}

// ---------- Overview ----------

async function loadOverview() {
  const { overview } = await api('/overview');
  const stat = (label, value) => h('div', { class: 'card stat' }, h('dt', { text: label }), h('dd', { text: value }));
  document.getElementById('stats').replaceChildren(
    stat('משתמשים פעילים', fmtInt(overview.active_users)),
    stat('ממתינים לאישור', fmtInt(overview.pending_users)),
    stat('שאילתות החודש', fmtInt(overview.turns_month)),
    stat('שיחות החודש', fmtInt(overview.conversations_month)),
    stat('טוקנים החודש', fmtInt(overview.tokens_month)),
    stat('עלות משוערת החודש', fmtUsd(overview.cost_month)),
    stat('פעולות TAG-IT החודש', fmtInt(overview.tagit_calls_month)));
}

// ---------- Users ----------

async function loadUsers() {
  const data = await api('/users');
  state.users = data.users;
  state.settings = data.settings;
  renderUsers();
}

function renderUsers() {
  const section = document.getElementById('tab-users');
  const email = h('input', { class: 'input', type: 'email', required: true, autocomplete: 'off', placeholder: 'name@example.com', dir: 'ltr' });
  const name = h('input', { class: 'input', type: 'text', placeholder: 'לא חובה' });
  const role = select(ROLE_LABELS, 'user');
  const limit = h('input', { class: 'input', type: 'number', min: 0, step: 1000, placeholder: 'ברירת מחדל', inputmode: 'numeric' });
  const period = select(PERIOD_LABELS, '');
  const formTitleId = nextId('add-user');
  const addForm = h('form', { class: 'card card-body', style: 'margin-bottom:16px', 'aria-labelledby': formTitleId, onSubmit: async (e) => {
    e.preventDefault();
    try {
      await api('/users', { method: 'POST', body: {
        email: email.value, name: name.value || null, role: role.value, status: 'active',
        token_limit: limit.value === '' ? null : Number(limit.value), limit_period: period.value || null,
      } });
      toast('המשתמש נוסף וקיבל הרשאה');
      await Promise.all([loadUsers(), loadOverview()]);
    } catch (err) {
      toast(`שגיאה: ${err.message}`, { error: true });
    }
  } },
  h('h2', { class: 'card-title', id: formTitleId, style: 'margin-bottom:10px', text: 'הוספת משתמש מורשה' }),
  h('div', { class: 'form-grid' },
    h('label', {}, h('span', { class: 'label', text: 'אימייל (חשבון Google)' }), email),
    h('label', {}, h('span', { class: 'label', text: 'שם' }), name),
    h('label', {}, h('span', { class: 'label', text: 'תפקיד' }), role),
    h('label', {}, h('span', { class: 'label', text: 'מגבלת טוקנים' }), limit),
    h('label', {}, h('span', { class: 'label', text: 'תקופת מגבלה' }), period),
    h('button', { class: 'btn btn-accent', type: 'submit' }, 'הוספה')));

  const defaultLimit = state.settings.default_token_limit;
  const defaultPeriod = state.settings.default_limit_period;
  const rows = state.users.map((u) => {
    const who = u.email;
    const statusSel = select(STATUS_LABELS, u.status, { 'aria-label': `סטטוס עבור ${who}` });
    const roleSel = select(ROLE_LABELS, u.role, { 'aria-label': `תפקיד עבור ${who}` });
    const limitInput = h('input', {
      class: 'input', type: 'number', min: 0, step: 1000, inputmode: 'numeric', value: u.token_limit ?? '',
      placeholder: defaultLimit == null ? 'ללא' : fmtInt(defaultLimit), 'aria-label': `מגבלת טוקנים עבור ${who} (ריק = ברירת המחדל)`,
    });
    const periodSel = select(PERIOD_LABELS, u.limit_period ?? '', { 'aria-label': `תקופת מגבלה עבור ${who}` });
    const noteInput = h('input', { class: 'input', type: 'text', value: u.note ?? '', placeholder: 'הערה', 'aria-label': `הערה עבור ${who}` });
    const save = h('button', { class: 'btn btn-primary btn-sm', type: 'button', disabled: true, 'aria-label': `שמירת השינויים עבור ${who}`, onClick: async () => {
      try {
        await api(`/users/${u.id}`, { method: 'PATCH', body: {
          status: statusSel.value, role: roleSel.value,
          token_limit: limitInput.value === '' ? null : Number(limitInput.value),
          limit_period: periodSel.value || null, note: noteInput.value || null,
        } });
        toast(`השינויים עבור ${who} נשמרו`);
        await Promise.all([loadUsers(), loadOverview()]);
      } catch (err) {
        toast(err.message === 'cannot_demote_self' ? 'לא ניתן להסיר הרשאת מנהל מעצמך' : `שגיאה: ${err.message}`, { error: true });
      }
    } }, 'שמירה');
    [statusSel, roleSel, limitInput, periodSel, noteInput].forEach((el) => el.addEventListener('input', () => { save.disabled = false; }));

    const effectiveLimit = u.token_limit ?? defaultLimit;
    const effectivePeriod = u.limit_period ?? defaultPeriod;
    const used = effectivePeriod === 'total' ? u.tokens_total : u.tokens_month;
    const pct = effectiveLimit ? Math.min(100, (used / effectiveLimit) * 100) : 0;
    const approve = u.status === 'pending'
      ? h('button', { class: 'btn btn-accent btn-sm', type: 'button', 'aria-label': `אישור הגישה עבור ${who}`, onClick: async () => {
        try {
          await api(`/users/${u.id}`, { method: 'PATCH', body: { status: 'active' } });
          toast(`הגישה עבור ${who} אושרה`);
          await Promise.all([loadUsers(), loadOverview()]);
        } catch (err) {
          toast(`שגיאה: ${err.message}`, { error: true });
        }
      } }, 'אישור')
      : null;

    return h('tr', {},
      h('td', {}, h('div', { style: 'font-weight:600', text: u.name || '—' }), h('div', { class: 'small muted', dir: 'ltr', style: 'text-align:right', text: u.email })),
      h('td', {}, statusSel),
      h('td', {}, roleSel),
      h('td', {}, limitInput),
      h('td', {}, periodSel),
      h('td', { class: 'num' },
        fmtInt(used),
        effectiveLimit
          ? h('span', {
            class: 'mini-bar', role: 'progressbar', 'aria-label': `שימוש מתוך המגבלה עבור ${who}`,
            'aria-valuenow': Math.round(pct), 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuetext': `${Math.round(pct)} אחוזים`,
          }, h('span', { style: `width:${pct}%;${pct >= 100 ? 'background:var(--error)' : ''}` }))
          : h('span', { class: 'small muted', text: ' (ללא מגבלה)' })),
      h('td', { class: 'num', text: fmtInt(u.tokens_total) }),
      h('td', { class: 'num', text: fmtUsd(u.cost_total) }),
      h('td', { class: 'num', text: fmtInt(u.conversations) }),
      h('td', { class: 'num small', text: fmtDateTime(u.last_used_at || u.last_seen_at) }),
      h('td', {}, noteInput),
      h('td', {}, h('div', { class: 'row-actions' }, approve, save,
        h('button', { class: 'btn btn-ghost btn-sm', type: 'button', 'aria-label': `שאילתות של ${who}`, onClick: () => { state.queries.filters = { user_id: u.id }; state.queries.offset = 0; switchTab('queries', { focus: true }); } }, 'שאילתות'))));
  });

  section.replaceChildren(
    addForm,
    h('h2', { class: 'sr-only', text: 'רשימת המשתמשים' }),
    h('p', { class: 'small muted', text: `מגבלת ברירת המחדל: ${defaultLimit == null ? 'ללא מגבלה' : `${fmtInt(defaultLimit)} טוקנים`} (${PERIOD_LABELS[defaultPeriod] || defaultPeriod}). שדה מגבלה ריק = ברירת המחדל. משתמש שמתחבר לראשונה נרשם כ"ממתין לאישור".` }),
    dataTable('משתמשים', ['משתמש', 'סטטוס', 'תפקיד', 'מגבלת טוקנים', 'תקופה', 'שימוש בתקופה', 'טוקנים מצטבר', 'עלות מצטברת', 'שיחות', 'שימוש אחרון', 'הערה', ''], rows, 'אין משתמשים'));
}

// ---------- Query log ----------

const TURN_STATUS = {
  completed: ['הושלם', 'badge-success'],
  awaiting_input: ['ממתין לתשובת המשתמש', 'badge-muted'],
  running: ['בעיבוד', 'badge-gold'],
  aborted: ['הופסק על ידי המשתמש', 'badge-muted'],
  interrupted: ['נקטע', 'badge-error'],
  error: ['שגיאה', 'badge-error'],
  quota_exceeded: ['מגבלת טוקנים', 'badge-error'],
  refused: ['סירוב המודל', 'badge-error'],
  truncated: ['נקטע (אורך)', 'badge-muted'],
  iteration_limit: ['נעצר (מספר צעדים)', 'badge-muted'],
};
const REQUEST_KINDS = { document: 'מסמך', text: 'הודעה', answers: 'תשובה לשאלות', more: 'תוצאות נוספות' };
const SEARCH_ACTIONS = { search_sentencing: 'גזרי דין', search_guidelines: 'הנחיות', more_sentencing: 'עוד גזרי דין', read_document: 'קריאת מסמך' };

function queryFilterParams() {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(state.queries.filters)) if (v) params.set(k, v);
  return params;
}

async function loadQueries() {
  const params = queryFilterParams();
  params.set('offset', state.queries.offset);
  params.set('limit', state.queries.limit);
  const data = await api(`/turns?${params}`);
  if (!state.users.length) await loadUsers();
  renderQueries(data);
}

function requestSummary(t) {
  if (Array.isArray(t.answers) && t.answers.length) {
    const answers = t.answers
      .map((a) => `${a.question}: ${[...(a.selected || []).map((s) => s.label), a.free_text].filter(Boolean).join(', ') || 'ללא העדפה'}`)
      .join(' | ');
    return [answers, t.request_text].filter(Boolean).join(' · ');
  }
  return [t.file_name, t.request_text].filter(Boolean).join(' · ') || '—';
}

function searchLines(t) {
  return (t.searches || []).filter((s) => s && s.action !== 'open_file').map((s) => h('div', { class: 'small' },
    h('strong', { text: `${SEARCH_ACTIONS[s.action] || s.action}: ` }),
    [s.label, s.action === 'read_document' ? `${s.kind === 'ruling' ? 'גזר דין' : 'הנחיה'} ${s.id}` : null].filter(Boolean).join(' '),
    s.total != null ? ` (${fmtInt(s.total)})` : s.returned != null ? ` (${fmtInt(s.returned)})` : '',
    s.error ? h('div', { class: 'cell-error', text: `שגיאה: ${truncate(s.error, 100)}` }) : null));
}

function renderQueries(data) {
  const section = document.getElementById('tab-queries');
  const { filters, offset, limit } = state.queries;
  const userSel = h('select', { class: 'select' }, h('option', { value: '' }, 'כל המשתמשים'),
    state.users.map((u) => h('option', { value: u.id, selected: String(u.id) === String(filters.user_id ?? '') }, u.email)));
  const statusSel = select({ '': 'כל הסטטוסים', ...Object.fromEntries(Object.entries(TURN_STATUS).map(([k, [label]]) => [k, label])) }, filters.status ?? '');
  const search = h('input', { class: 'input', type: 'search', placeholder: 'טקסט או שם קובץ', value: filters.q ?? '' });
  const from = h('input', { class: 'input', type: 'date', value: filters.from ?? '' });
  const to = h('input', { class: 'input', type: 'date', value: filters.to ?? '' });
  const apply = () => {
    state.queries.filters = { user_id: userSel.value, status: statusSel.value, q: search.value.trim(), from: from.value, to: to.value };
    state.queries.offset = 0;
    loadQueries().then(() => announce('הסינון הוחל.'));
  };
  search.addEventListener('keydown', (e) => { if (e.key === 'Enter') apply(); });

  const rows = data.turns.map((t) => {
    const [statusLabel, statusClass] = TURN_STATUS[t.status] || [t.status, 'badge-muted'];
    const summary = requestSummary(t);
    const searches = searchLines(t);
    return h('tr', {},
      h('td', { class: 'num small', text: fmtDateTime(t.started_at) }),
      h('td', { class: 'small', dir: 'ltr', style: 'white-space:nowrap;text-align:right', text: t.user_email }),
      h('td', { style: 'min-width:220px;max-width:360px' },
        h('span', { class: 'badge badge-muted', text: REQUEST_KINDS[t.request_kind] || t.request_kind }),
        h('div', { class: 'small clamp-2', title: summary, text: summary })),
      h('td', { style: 'min-width:180px;max-width:300px' }, searches.length ? searches : h('span', { class: 'small muted', text: '—' })),
      h('td', { class: 'num', text: fmtInt(t.claude_calls) }),
      h('td', { class: 'num' },
        h('div', { text: fmtInt(t.total_tokens) }),
        t.total_tokens ? h('div', { class: 'cell-note', text: `קלט ${fmtInt(t.input_tokens)} · פלט ${fmtInt(t.output_tokens)}` }) : null,
        t.total_tokens ? h('div', { class: 'cell-note', text: `מטמון ${fmtInt(t.cache_creation_tokens)} / ${fmtInt(t.cache_read_tokens)}` }) : null),
      h('td', { class: 'num', style: 'font-weight:600', text: fmtUsd(t.cost_usd) }),
      h('td', { class: 'num small', text: fmtDuration(t.duration_seconds) }),
      h('td', {},
        h('span', { class: `badge ${statusClass}`, text: statusLabel }),
        t.error ? h('div', { class: 'cell-error', text: truncate(t.error, 120) }) : null),
      h('td', {}, t.conversation_id
        ? h('button', {
          class: 'btn btn-ghost btn-sm', type: 'button',
          'aria-label': `פתיחת השיחה ${t.conversation_title || ''} של ${t.user_email}`,
          onClick: () => openTranscript(t.conversation_id),
        }, 'שיחה')
        : null));
  });

  section.replaceChildren(
    h('h2', { class: 'sr-only', text: 'יומן שאילתות' }),
    h('div', { class: 'toolbar', role: 'search', 'aria-label': 'סינון שאילתות' },
      h('label', { class: 'field' }, h('span', { class: 'label', text: 'משתמש' }), userSel),
      h('label', { class: 'field' }, h('span', { class: 'label', text: 'סטטוס' }), statusSel),
      h('label', { class: 'field' }, h('span', { class: 'label', text: 'חיפוש בבקשה' }), search),
      h('label', { class: 'field' }, h('span', { class: 'label', text: 'מתאריך' }), from),
      h('label', { class: 'field' }, h('span', { class: 'label', text: 'עד תאריך' }), to),
      h('button', { class: 'btn btn-primary', type: 'button', onClick: apply }, 'סינון'),
      h('a', { class: 'btn btn-secondary', href: `/api/admin/turns.csv?${queryFilterParams()}` }, 'ייצוא ל-CSV')),
    h('p', { class: 'small' },
      `${fmtInt(data.totals.turns)} שאילתות · ${fmtInt(data.totals.tokens)} טוקנים · עלות משוערת ${fmtUsd(data.totals.cost)} · ${fmtInt(data.totals.tagit_calls)} פעולות TAG-IT`,
      h('span', { class: 'muted', text: ' · העלות מחושבת לפי מחירון Anthropic.' })),
    dataTable('יומן שאילתות', ['זמן', 'משתמש', 'בקשה', 'חיפושים ב-TAG-IT', 'קריאות Claude', 'טוקנים', 'עלות', 'משך', 'סטטוס', ''], rows, 'אין שאילתות'),
    pager(offset, limit, data.turns.length, data.totals.turns, (next) => { state.queries.offset = next; loadQueries(); }));
}

// ---------- Usage log ----------

async function loadUsage() {
  const { filters, offset, limit } = state.usage;
  const params = new URLSearchParams({ offset, limit });
  for (const [k, v] of Object.entries(filters)) if (v) params.set(k, v);
  const data = await api(`/usage?${params}`);
  if (!state.users.length) await loadUsers();
  renderUsage(data);
}

function describeEvent(e) {
  const d = e.detail || {};
  if (e.kind === 'claude') return d.tools?.length ? `כלים: ${d.tools.join(', ')}` : `סיום: ${d.stop_reason || '—'}`;
  const actions = { search_sentencing: 'חיפוש גזרי דין', search_guidelines: 'חיפוש הנחיות', more_sentencing: 'תוצאות נוספות', read_document: 'קריאת מסמך', open_file: 'פתיחת קובץ' };
  const parts = [actions[d.action] || d.action, d.label, d.total != null ? `${d.total} תוצאות` : null, d.returned != null && d.total == null ? `${d.returned} הוחזרו` : null, d.error ? `שגיאה: ${d.error}` : null];
  return parts.filter(Boolean).join(' · ');
}

function renderUsage(data) {
  const section = document.getElementById('tab-usage');
  const { filters, offset, limit } = state.usage;
  const userSel = h('select', { class: 'select' }, h('option', { value: '' }, 'כל המשתמשים'),
    state.users.map((u) => h('option', { value: u.id, selected: String(u.id) === String(filters.user_id ?? '') }, u.email)));
  const kindSel = select({ '': 'הכול', claude: 'Claude', tagit: 'TAG-IT' }, filters.kind ?? '');
  const from = h('input', { class: 'input', type: 'date', value: filters.from ?? '' });
  const to = h('input', { class: 'input', type: 'date', value: filters.to ?? '' });
  const apply = () => {
    state.usage.filters = { user_id: userSel.value, kind: kindSel.value, from: from.value, to: to.value };
    state.usage.offset = 0;
    loadUsage().then(() => announce('הסינון הוחל.'));
  };

  const rows = data.events.map((e) => h('tr', {},
    h('td', { class: 'num small', text: fmtDateTime(e.created_at) }),
    h('td', { class: 'small', dir: 'ltr', style: 'text-align:right', text: e.user_email }),
    h('td', {}, h('span', { class: `badge ${e.kind === 'claude' ? 'badge-navy' : 'badge-gold'}`, text: e.kind === 'claude' ? 'Claude' : 'TAG-IT' })),
    h('td', { class: 'small' }, e.conversation_id
      ? h('button', { class: 'link-btn', type: 'button', text: e.conversation_title || 'שיחה', onClick: () => openTranscript(e.conversation_id) })
      : '—'),
    h('td', { class: 'small', text: describeEvent(e) }),
    h('td', { class: 'num', text: e.kind === 'claude' ? fmtInt(e.input_tokens) : '' }),
    h('td', { class: 'num', text: e.kind === 'claude' ? fmtInt(e.output_tokens) : '' }),
    h('td', { class: 'num', text: e.kind === 'claude' ? `${fmtInt(e.cache_creation_tokens)} / ${fmtInt(e.cache_read_tokens)}` : '' }),
    h('td', { class: 'num', style: 'font-weight:600', text: e.kind === 'claude' ? fmtInt(e.total_tokens) : '' }),
    h('td', { class: 'num', text: e.kind === 'claude' ? fmtUsd(e.cost_usd) : '' })));

  section.replaceChildren(
    h('h2', { class: 'sr-only', text: 'יומן קריאות API' }),
    h('div', { class: 'toolbar', role: 'search', 'aria-label': 'סינון היומן' },
      h('label', { class: 'field' }, h('span', { class: 'label', text: 'משתמש' }), userSel),
      h('label', { class: 'field' }, h('span', { class: 'label', text: 'סוג' }), kindSel),
      h('label', { class: 'field' }, h('span', { class: 'label', text: 'מתאריך' }), from),
      h('label', { class: 'field' }, h('span', { class: 'label', text: 'עד תאריך' }), to),
      h('button', { class: 'btn btn-primary', type: 'button', onClick: apply }, 'סינון')),
    h('p', { class: 'small' },
      `${fmtInt(data.totals.events)} רשומות · ${fmtInt(data.totals.tokens)} טוקנים · ${fmtUsd(data.totals.cost)} · ${fmtInt(data.totals.tagit_calls)} פעולות TAG-IT`),
    dataTable('יומן קריאות API', ['זמן', 'משתמש', 'סוג', 'שיחה', 'פעולה', 'קלט', 'פלט', 'מטמון כתיבה / קריאה', 'סה"כ טוקנים', 'עלות'], rows, 'אין רשומות'),
    pager(offset, limit, data.events.length, data.totals.events, (next) => { state.usage.offset = next; loadUsage(); }));
}

// ---------- Dialog ----------

// Modal dialog: focus moves in, Tab is trapped, Escape closes, the page behind is inert,
// and focus returns to the control that opened it.
function openModal({ title, subtitle, body }) {
  const opener = document.activeElement;
  const titleId = nextId('dialog-title');
  const background = [...document.body.children];
  const closeBtn = h('button', { class: 'btn btn-ghost btn-sm', type: 'button' }, 'סגירה');
  const dialog = h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId, tabindex: '-1' },
    h('div', { class: 'card-head' },
      h('div', {},
        h('h2', { class: 'card-title', id: titleId, text: title }),
        subtitle ? h('p', { class: 'small muted', style: 'margin:0', text: subtitle }) : null),
      closeBtn),
    h('div', { class: 'card-body', role: 'document', tabindex: '0' }, body));
  const backdrop = h('div', { class: 'modal-backdrop' }, dialog);

  const onKey = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); close(); return; }
    if (e.key !== 'Tab') return;
    const focusables = [...dialog.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]), select, textarea, [tabindex="0"]')];
    const first = focusables[0];
    const last = focusables.at(-1);
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };
  function close() {
    backdrop.remove();
    background.forEach((el) => { el.inert = false; });
    document.removeEventListener('keydown', onKey);
    opener?.focus?.();
  }
  closeBtn.addEventListener('click', close);
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });

  background.forEach((el) => { el.inert = true; });
  document.body.append(backdrop);
  document.addEventListener('keydown', onKey);
  closeBtn.focus();
}

async function openTranscript(id) {
  let data;
  try {
    data = await api(`/conversations/${id}`);
  } catch (err) {
    toast(`לא ניתן לטעון את השיחה: ${err.message}`, { error: true });
    return;
  }
  const { conversation, messages } = data;
  const turns = messages.map((m) => {
    const u = m.ui || {};
    if (m.role === 'user') {
      const answers = (u.answers || []).map((a) => `${a.question}: ${[...(a.selected || []).map((s) => s.label), a.free_text].filter(Boolean).join(', ')}`).join('\n');
      return h('div', { class: 'transcript-turn' },
        h('h3', { class: 'small', style: 'margin:0', text: `משתמש · ${fmtDateTime(m.created_at)}` }),
        u.fileName ? h('p', { class: 'small muted', style: 'margin:0', text: `קובץ: ${u.fileName}` }) : null,
        h('pre', { text: [u.text, answers].filter(Boolean).join('\n') }));
    }
    return h('div', { class: 'transcript-turn' },
      h('h3', { class: 'small', style: 'margin:0', text: `מערכת · ${fmtDateTime(m.created_at)}` }),
      (u.items || []).map((item) => {
        if (item.type === 'text') return h('div', { class: 'assistant-text', html: DOMPurify.sanitize(marked.parse(item.text)) });
        if (item.type === 'analysis') {
          return h('div', { class: 'notice-box' }, `ניתוח: ${item.data.title} · `,
            item.data.defendants.map((d) => `${d.label}: ${d.counts.map((c) => c.section || c.offense).join(', ')}`).join(' | '));
        }
        if (item.type === 'results') return h('p', { class: 'small' }, h('strong', { text: `גזרי דין · ${item.data.label}` }), ` (${item.data.total ?? item.data.items.length}): `, item.data.items.slice(0, 10).map((r) => r.title).join(' · '));
        if (item.type === 'guidelines') return h('p', { class: 'small' }, h('strong', { text: `הנחיות · ${item.data.label}` }), ': ', item.data.items.map((g) => g.title).join(' · '));
        if (item.type === 'questions') return h('p', { class: 'small muted', text: `שאלות: ${item.data.questions.map((q) => q.text).join(' | ')}` });
        return null;
      }));
  });
  openModal({ title: conversation.title || 'שיחה', subtitle: `${conversation.email} · ${fmtDateTime(conversation.created_at)}`, body: turns });
}

// ---------- Settings ----------

function renderSettings() {
  const section = document.getElementById('tab-settings');
  const limit = h('input', { class: 'input', type: 'number', min: 0, step: 1000, inputmode: 'numeric', value: state.settings.default_token_limit ?? '', placeholder: 'ללא מגבלה' });
  const period = select({ monthly: 'חודשי (מתאפס בתחילת כל חודש)', total: 'מצטבר (ללא איפוס)' }, state.settings.default_limit_period);
  const applyAll = h('input', { type: 'checkbox' });
  const titleId = nextId('settings-title');
  section.replaceChildren(h('form', { class: 'card card-body', style: 'max-width:640px', 'aria-labelledby': titleId, onSubmit: async (e) => {
    e.preventDefault();
    if (applyAll.checked && !confirm('להחיל את המגבלה על כל המשתמשים ולמחוק מגבלות אישיות?')) return;
    try {
      const { settings } = await api('/settings', { method: 'PUT', body: {
        default_token_limit: limit.value === '' ? null : Number(limit.value),
        default_limit_period: period.value,
        apply_to_all: applyAll.checked,
      } });
      state.settings = settings;
      toast('ההגדרות נשמרו');
      await loadUsers();
    } catch (err) {
      toast(`שגיאה: ${err.message}`, { error: true });
    }
  } },
  h('h2', { class: 'card-title', id: titleId, style: 'margin-bottom:6px', text: 'מגבלת ברירת מחדל לכל משתמש' }),
  h('p', { class: 'small muted', style: 'margin-top:0', text: 'חלה על כל משתמש שלא הוגדרה לו מגבלה אישית. טוקנים נספרים כסך כל הטוקנים שעובדו: קלט, פלט וקריאה וכתיבה למטמון.' }),
  h('div', { class: 'form-grid' },
    h('label', {}, h('span', { class: 'label', text: 'מגבלת טוקנים (ריק = ללא מגבלה)' }), limit),
    h('label', {}, h('span', { class: 'label', text: 'תקופה' }), period)),
  h('label', { style: 'display:flex;gap:8px;align-items:center;margin:14px 0' }, applyAll, h('span', { class: 'small', text: 'להחיל על כל המשתמשים (מחיקת מגבלות אישיות)' })),
  h('button', { class: 'btn btn-accent', type: 'submit' }, 'שמירה')));
}

// ---------- Tabs & boot ----------

const TAB_NAMES = ['queries', 'users', 'usage', 'settings'];
const tabButtons = [...document.querySelectorAll('[role="tab"]')];

function switchTab(name, { focus = false } = {}) {
  for (const tab of tabButtons) {
    const selected = tab.dataset.tab === name;
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
    tab.classList.toggle('active', selected);
    if (selected && focus) tab.focus();
  }
  TAB_NAMES.forEach((tab) => { document.getElementById(`tab-${tab}`).hidden = tab !== name; });
  if (name === 'queries') loadQueries();
  if (name === 'usage') loadUsage();
  if (name === 'settings') renderSettings();
  if (name === 'users') loadUsers();
}

function activateTab(tab, { focus = false } = {}) {
  if (tab.dataset.tab === 'usage') { state.usage.filters = {}; state.usage.offset = 0; }
  if (tab.dataset.tab === 'queries') { state.queries.filters = {}; state.queries.offset = 0; }
  switchTab(tab.dataset.tab, { focus });
}

tabButtons.forEach((tab, index) => {
  tab.addEventListener('click', () => activateTab(tab));
  tab.addEventListener('keydown', (e) => {
    // RTL tab list: the next tab sits to the left.
    let target = null;
    if (e.key === 'ArrowLeft') target = tabButtons[(index + 1) % tabButtons.length];
    else if (e.key === 'ArrowRight') target = tabButtons[(index - 1 + tabButtons.length) % tabButtons.length];
    else if (e.key === 'Home') target = tabButtons[0];
    else if (e.key === 'End') target = tabButtons.at(-1);
    if (!target) return;
    e.preventDefault();
    activateTab(target, { focus: true });
  });
});

const me = await (await fetch('/api/me')).json();
if (!me.authenticated || me.user.role !== 'admin') location.href = '/';
else {
  await Promise.all([loadOverview(), loadUsers()]);
  await loadQueries();
}
