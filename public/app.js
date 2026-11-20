'use strict';

// All rendering goes through h() / textContent — never innerHTML — so user
// content cannot inject markup.

const state = {
  meetings: [],
  draft: null, // the meeting being edited (a copy; id is null for a new one)
  dirty: false,
  query: '',
  view: 'meetings',
};

const $ = (selector) => document.querySelector(selector);

function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
    else if (key === 'value') el.value = value;
    else if (key === 'checked') el.checked = value;
    else el.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) {
    if (child !== null && child !== undefined && child !== false) el.append(child);
  }
  return el;
}

// --- helpers ---------------------------------------------------------------

const today = () => new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD, local time

function formatDate(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function dueStatus(item) {
  if (item.done) return 'done';
  if (!item.dueDate) return 'none';
  if (item.dueDate < today()) return 'overdue';
  if (item.dueDate === today()) return 'today';
  return 'upcoming';
}

function dueLabel(item) {
  const status = dueStatus(item);
  if (!item.dueDate) return 'No due date';
  if (status === 'overdue') return `Overdue · ${formatDate(item.dueDate)}`;
  if (status === 'today') return 'Due today';
  return `Due ${formatDate(item.dueDate)}`;
}

let toastTimer;
function toast(message, isError) {
  const el = $('#toast');
  el.textContent = message;
  el.className = isError ? 'toast error' : 'toast';
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3000);
}

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function blankMeeting() {
  return { id: null, title: '', date: today(), attendees: [], notes: '', actionItems: [] };
}

function replaceMeeting(updated) {
  const index = state.meetings.findIndex((m) => m.id === updated.id);
  if (index === -1) state.meetings.unshift(updated);
  else state.meetings[index] = updated;
  state.meetings.sort((a, b) => b.date.localeCompare(a.date) || b.updatedAt.localeCompare(a.updatedAt));
}

function confirmDiscard() {
  return !state.dirty || window.confirm('Discard unsaved changes?');
}

function markDirty() {
  state.dirty = true;
  const hint = $('#save-hint');
  if (hint) hint.textContent = 'Unsaved changes';
}

// --- sidebar ---------------------------------------------------------------

function matchesQuery(meeting) {
  const q = state.query.trim().toLowerCase();
  if (!q) return true;
  return [meeting.title, meeting.notes, ...meeting.attendees, ...meeting.actionItems.map((a) => `${a.text} ${a.owner}`)]
    .join('\n')
    .toLowerCase()
    .includes(q);
}

function renderList() {
  const list = $('#meeting-list');
  const visible = state.meetings.filter(matchesQuery);
  const rows = visible.map((meeting) => {
    const open = meeting.actionItems.filter((a) => !a.done).length;
    const meta = [formatDate(meeting.date)];
    if (meeting.attendees.length) meta.push(`${meeting.attendees.length} attendee${meeting.attendees.length === 1 ? '' : 's'}`);
    if (open) meta.push(`${open} open`);
    return h('li', {},
      h('button', {
        type: 'button',
        class: state.draft && state.draft.id === meeting.id ? 'meeting-row active' : 'meeting-row',
        onclick: () => openMeeting(meeting.id),
      },
      h('span', { class: 'row-title' }, meeting.title),
      h('span', { class: 'row-meta' }, meta.join(' · '))));
  });
  if (!rows.length) {
    rows.push(h('li', { class: 'empty' }, state.meetings.length ? 'No meetings match your search.' : 'No meetings yet.'));
  }
  list.replaceChildren(...rows);

  const openCount = state.meetings.reduce((n, m) => n + m.actionItems.filter((a) => !a.done).length, 0);
  const badge = $('#open-count');
  badge.textContent = String(openCount);
  badge.hidden = openCount === 0;
}

// --- editor ----------------------------------------------------------------

function openMeeting(id) {
  if (!confirmDiscard()) return;
  const source = id ? state.meetings.find((m) => m.id === id) : null;
  state.draft = source ? JSON.parse(JSON.stringify(source)) : blankMeeting();
  state.dirty = false;
  renderList();
  renderEditor();
  if (!source) $('#f-title').focus();
}

function addAttendee(input) {
  const names = input.value.split(',').map((s) => s.trim()).filter(Boolean);
  if (!names.length) return;
  for (const name of names) {
    if (!state.draft.attendees.some((a) => a.toLowerCase() === name.toLowerCase())) state.draft.attendees.push(name);
  }
  markDirty();
  renderEditor();
  $('#f-attendee').focus();
}

function actionItemRow(item, index) {
  return h('li', { class: `action-row ${dueStatus(item)}` },
    h('input', {
      type: 'checkbox',
      checked: item.done,
      'aria-label': 'Done',
      onchange: (e) => { item.done = e.target.checked; markDirty(); renderEditor(); },
    }),
    h('input', {
      type: 'text', class: 'grow', placeholder: 'What needs to happen?', maxlength: 500,
      value: item.text, 'aria-label': 'Action item',
      oninput: (e) => { item.text = e.target.value; markDirty(); },
    }),
    h('input', {
      type: 'text', class: 'owner', placeholder: 'Owner', maxlength: 100, list: 'attendee-options',
      value: item.owner, 'aria-label': 'Owner',
      oninput: (e) => { item.owner = e.target.value; markDirty(); },
    }),
    h('input', {
      type: 'date', value: item.dueDate || '', 'aria-label': 'Due date',
      onchange: (e) => { item.dueDate = e.target.value || null; markDirty(); renderEditor(); },
    }),
    h('button', {
      type: 'button', class: 'icon-btn', title: 'Remove action item', 'aria-label': 'Remove action item',
      onclick: () => { state.draft.actionItems.splice(index, 1); markDirty(); renderEditor(); },
    }, '×'));
}

function renderEditor() {
  const editor = $('#editor');
  const draft = state.draft;
  if (!draft) {
    editor.replaceChildren(h('div', { class: 'placeholder' },
      h('h2', {}, 'No meeting selected'),
      h('p', {}, 'Pick a meeting on the left, or start a new one.')));
    return;
  }

  const attendeeInput = h('input', {
    type: 'text', id: 'f-attendee', placeholder: 'Add a name and press Enter', maxlength: 100,
    onkeydown: (e) => {
      if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addAttendee(e.target); }
    },
    onblur: (e) => { if (e.target.value.trim()) addAttendee(e.target); },
  });

  const form = h('form', { class: 'editor-form', onsubmit: saveMeeting },
    h('div', { class: 'field-row' },
      h('label', { class: 'field grow' }, h('span', {}, 'Title'),
        h('input', {
          type: 'text', id: 'f-title', required: true, maxlength: 200, placeholder: 'e.g. Weekly platform sync',
          value: draft.title, oninput: (e) => { draft.title = e.target.value; markDirty(); },
        })),
      h('label', { class: 'field' }, h('span', {}, 'Date'),
        h('input', {
          type: 'date', required: true, value: draft.date,
          onchange: (e) => { draft.date = e.target.value; markDirty(); },
        }))),

    h('div', { class: 'field' }, h('span', {}, 'Attendees'),
      h('div', { class: 'chips' },
        draft.attendees.map((name, index) => h('span', { class: 'chip' }, name,
          h('button', {
            type: 'button', 'aria-label': `Remove ${name}`,
            onclick: () => { draft.attendees.splice(index, 1); markDirty(); renderEditor(); },
          }, '×'))),
        attendeeInput)),

    h('label', { class: 'field' }, h('span', {}, 'Notes'),
      h('textarea', {
        rows: 10, maxlength: 20000, placeholder: 'Discussion, decisions, context…',
        value: draft.notes, oninput: (e) => { draft.notes = e.target.value; markDirty(); },
      })),

    h('div', { class: 'field' }, h('span', {}, 'Action items'),
      h('datalist', { id: 'attendee-options' }, draft.attendees.map((name) => h('option', { value: name }))),
      h('ul', { class: 'action-list' }, draft.actionItems.map(actionItemRow)),
      h('button', {
        type: 'button', class: 'btn subtle',
        onclick: () => {
          draft.actionItems.push({ text: '', owner: '', dueDate: null, done: false });
          markDirty();
          renderEditor();
          const inputs = document.querySelectorAll('.action-row input[type="text"].grow');
          inputs[inputs.length - 1].focus();
        },
      }, '+ Add action item')),

    h('div', { class: 'form-footer' },
      h('button', { type: 'submit', class: 'btn primary' }, draft.id ? 'Save changes' : 'Create meeting'),
      h('span', { id: 'save-hint', class: 'hint' }, state.dirty ? 'Unsaved changes' : ''),
      draft.id ? h('button', { type: 'button', class: 'btn danger push-right', onclick: deleteMeeting }, 'Delete') : null));

  editor.replaceChildren(form);
}

async function saveMeeting(event) {
  event.preventDefault();
  const draft = state.draft;
  const payload = {
    title: draft.title,
    date: draft.date,
    attendees: draft.attendees,
    notes: draft.notes,
    actionItems: draft.actionItems,
  };
  try {
    const saved = draft.id
      ? await api('PUT', `/api/meetings/${encodeURIComponent(draft.id)}`, payload)
      : await api('POST', '/api/meetings', payload);
    replaceMeeting(saved);
    state.draft = JSON.parse(JSON.stringify(saved));
    state.dirty = false;
    renderList();
    renderEditor();
    toast('Saved');
  } catch (err) {
    toast(err.message, true);
  }
}

async function deleteMeeting() {
  const draft = state.draft;
  if (!window.confirm(`Delete "${draft.title || 'this meeting'}" and its action items?`)) return;
  try {
    await api('DELETE', `/api/meetings/${encodeURIComponent(draft.id)}`);
    state.meetings = state.meetings.filter((m) => m.id !== draft.id);
    state.draft = null;
    state.dirty = false;
    renderList();
    renderEditor();
    toast('Meeting deleted');
  } catch (err) {
    toast(err.message, true);
  }
}

// --- action items view -----------------------------------------------------

async function toggleItem(meeting, item, done) {
  try {
    const updated = await api(
      'PATCH',
      `/api/meetings/${encodeURIComponent(meeting.id)}/action-items/${encodeURIComponent(item.id)}`,
      { done }
    );
    replaceMeeting(updated);
    if (state.draft && state.draft.id === updated.id && !state.dirty) {
      state.draft = JSON.parse(JSON.stringify(updated));
      renderEditor();
    }
  } catch (err) {
    toast(err.message, true);
  }
  renderList();
  renderActions();
}

function renderActions() {
  const view = $('#view-actions');
  const all = [];
  for (const meeting of state.meetings) {
    for (const item of meeting.actionItems) all.push({ meeting, item });
  }
  const byDue = (a, b) => (a.item.dueDate || '9999-99-99').localeCompare(b.item.dueDate || '9999-99-99');
  const groups = [
    ['Overdue', all.filter((x) => dueStatus(x.item) === 'overdue').sort(byDue)],
    ['Open', all.filter((x) => ['today', 'upcoming', 'none'].includes(dueStatus(x.item))).sort(byDue)],
    ['Done', all.filter((x) => x.item.done).sort(byDue)],
  ];

  const sections = groups.filter(([, rows]) => rows.length).map(([label, rows]) =>
    h('section', {},
      h('h2', {}, `${label} (${rows.length})`),
      h('ul', { class: 'action-summary' }, rows.map(({ meeting, item }) =>
        h('li', { class: `summary-row ${dueStatus(item)}` },
          h('input', {
            type: 'checkbox', checked: item.done, 'aria-label': `Mark "${item.text}" done`,
            onchange: (e) => toggleItem(meeting, item, e.target.checked),
          }),
          h('div', { class: 'grow' },
            h('div', { class: 'summary-text' }, item.text),
            h('div', { class: 'row-meta' },
              [item.owner || 'Unassigned', dueLabel(item)].join(' · '), ' · ',
              h('button', {
                type: 'button', class: 'link',
                onclick: () => { if (showView('meetings')) openMeeting(meeting.id); },
              }, meeting.title))))))));

  if (!sections.length) {
    sections.push(h('div', { class: 'placeholder' },
      h('h2', {}, 'No action items yet'),
      h('p', {}, 'Add action items to a meeting and they will show up here, sorted by due date.')));
  }
  view.replaceChildren(...sections);
}

// --- navigation ------------------------------------------------------------

function showView(view) {
  state.view = view;
  $('#view-meetings').hidden = view !== 'meetings';
  $('#view-actions').hidden = view !== 'actions';
  $('#tab-meetings').classList.toggle('active', view === 'meetings');
  $('#tab-actions').classList.toggle('active', view === 'actions');
  if (view === 'actions') renderActions();
  return true;
}

$('#tab-meetings').addEventListener('click', () => showView('meetings'));
$('#tab-actions').addEventListener('click', () => showView('actions'));
$('#new-meeting').addEventListener('click', () => openMeeting(null));
$('#search').addEventListener('input', (e) => { state.query = e.target.value; renderList(); });
window.addEventListener('beforeunload', (e) => { if (state.dirty) e.preventDefault(); });

(async function init() {
  renderEditor();
  try {
    state.meetings = await api('GET', '/api/meetings');
  } catch (err) {
    toast(err.message, true);
  }
  renderList();
})();
