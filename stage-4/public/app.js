/* Tablekeeper browser app. Vanilla JS, no dependencies, talks to the real API with relative URLs.
 *
 * Correctness notes
 * - Out-of-order responses: every search/refresh takes a sequence number; a response is applied only if
 *   it still belongs to the latest search (state.searchSeq). The same guard protects lookups.
 * - Booking attempts: an attempt = {key, canonical body}. Submitting an unchanged form re-sends the same
 *   Idempotency-Key and body (a replay, §7); changing any field mints a new key. The attempt lives in memory
 *   with the form, so it survives anything that does not reload the page (including a server upgrade).
 * - Outcome classification: 2xx -> confirmation; 4xx -> confirmed refusal (booking-error);
 *   network failure/timeout/5xx -> outcome unknown (booking-uncertain), attempt kept for retry.
 * - The browser never invents a result: confirmations come only from a server response body.
 */
(function () {
  'use strict';

  var SESSION_KEY = 'tk.session';
  var app = document.getElementById('app');
  var state = {
    session: loadSession(),
    restaurants: null, // list
    details: {}, // id -> restaurant detail
    searchSeq: 0,
    search: { status: 'idle' },
    booking: null,
    lookupSeq: 0,
  };

  // ---------- utilities ----------
  function h(tag, attrs) {
    var el = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        var v = attrs[k];
        if (v === null || v === undefined || v === false) return;
        if (k === 'class') el.className = v;
        else if (k === 'text') el.textContent = v;
        else if (k.slice(0, 2) === 'on') el.addEventListener(k.slice(2), v);
        else if (k === 'tid') el.setAttribute('data-testid', v);
        else el.setAttribute(k, v === true ? '' : v);
      });
    }
    for (var i = 2; i < arguments.length; i++) append(el, arguments[i]);
    return el;
  }
  function append(el, c) {
    if (c === null || c === undefined || c === false) return;
    if (Array.isArray(c)) c.forEach(function (x) { append(el, x); });
    else el.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
  }
  function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); }
  function loadSession() {
    try { var s = JSON.parse(localStorage.getItem(SESSION_KEY)); return s && s.token ? s : null; } catch (e) { return null; }
  }
  function saveSession(s) {
    state.session = s;
    try { if (s) localStorage.setItem(SESSION_KEY, JSON.stringify(s)); else localStorage.removeItem(SESSION_KEY); } catch (e) { /* storage unavailable: session lives in memory */ }
  }
  function newKey() {
    var c = window.crypto;
    if (c && c.randomUUID) return c.randomUUID();
    var b = new Uint8Array(16);
    if (c && c.getRandomValues) c.getRandomValues(b); else for (var i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
    return Array.prototype.map.call(b, function (x) { return ('0' + x.toString(16)).slice(-2); }).join('');
  }
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var WDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  function fmtDate(ymd) {
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(ymd || '');
    if (!m) return ymd || '';
    var d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    return WDAYS[d.getUTCDay()] + ' ' + (+m[3]) + ' ' + MONTHS[+m[2] - 1] + ' ' + m[1];
  }
  function fmtWhen(local) { return fmtDate(local) + ' at ' + String(local).slice(11, 16); }
  function tableName(label) { return /^\d+$/.test(String(label)) ? 'Table ' + label : String(label); }
  function tablesText(labels) {
    if (labels.length === 1) return tableName(labels[0]);
    return labels.every(function (l) { return /^\d+$/.test(String(l)); }) ? 'Tables ' + labels.join(' + ') : labels.join(' + ');
  }
  function labelsFor(detail, ids) {
    return ids.map(function (id) {
      var t = detail && (detail.tables || []).filter(function (x) { return x.id === id; })[0];
      return t && t.label !== undefined ? t.label : id;
    });
  }
  function todayLocal() {
    var d = new Date();
    return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2);
  }
  var MESSAGES = {
    table_unavailable: 'That table was just taken by someone else. Availability has been refreshed — pick another table or time.',
    not_on_slot_grid: 'That start time is not one of the restaurant’s booking times.',
    outside_opening_hours: 'The restaurant is not open for a full sitting at that time.',
    party_exceeds_capacity: 'That party is too large for the selected table(s).',
    invalid_local_time: 'That local time does not exist on this date (clocks change).',
    combination_not_allowed: 'Those tables cannot be combined.',
    validation_failed: 'Please check the details and try again.',
    unauthenticated: 'Please sign in to continue.',
    not_found: 'We could not find that.',
    cutoff_passed: 'It is too close to the start time to change this booking.',
    reservation_cancelled: 'This booking has already been cancelled.',
  };
  function errText(res) {
    var e = res && res.data && res.data.error;
    var base = e && MESSAGES[e.code];
    if (e && e.code === 'validation_failed' && e.message) return 'Please check the details: ' + e.message + '.';
    return base || (e && e.message) || 'Something went wrong.';
  }

  // ---------- API ----------
  // Resolves {status, data}; rejects with {network:true} when no response arrives.
  function api(method, path, opts) {
    opts = opts || {};
    var headers = { Accept: 'application/json' };
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
    if (opts.auth !== false && state.session) headers.Authorization = 'Bearer ' + state.session.token;
    if (opts.key) headers['Idempotency-Key'] = opts.key;
    var ctl = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctl) ctl.abort(); }, 15000);
    return fetch(path, {
      method: method, headers: headers, signal: ctl ? ctl.signal : undefined,
      body: opts.body !== undefined ? (typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body)) : undefined,
    }).then(function (r) {
      return r.text().then(function (t) {
        clearTimeout(timer);
        var data = null;
        try { data = t ? JSON.parse(t) : null; } catch (e) { data = null; }
        return { status: r.status, data: data };
      });
    }).catch(function () { clearTimeout(timer); return Promise.reject({ network: true }); });
  }
  function getRestaurants() {
    if (state.restaurants) return Promise.resolve(state.restaurants);
    return api('GET', '/restaurants', { auth: false }).then(function (r) {
      if (r.status !== 200 || !r.data || !Array.isArray(r.data.restaurants)) return Promise.reject({ network: true });
      state.restaurants = r.data.restaurants;
      return state.restaurants;
    });
  }
  function getDetail(id) {
    if (state.details[id]) return Promise.resolve(state.details[id]);
    return api('GET', '/restaurants/' + encodeURIComponent(id), { auth: false }).then(function (r) {
      if (r.status !== 200 || !r.data) return Promise.reject({ network: true });
      state.details[id] = r.data;
      return r.data;
    });
  }

  // ---------- router + shell ----------
  var ROUTES = { '/': home, '/signup': signup, '/login': login, '/lookup': lookup };
  var headerEl = h('header', { class: 'topbar' });
  var mainEl = h('main', { id: 'main', tabindex: '-1' });

  function navigate(path, replace) {
    if (location.pathname !== path) history[replace ? 'replaceState' : 'pushState']({}, '', path);
    renderRoute();
  }
  function renderRoute() {
    var path = location.pathname.replace(/\/+$/, '') || '/';
    var view = ROUTES[path] || home;
    renderHeader(path);
    clear(mainEl);
    view(mainEl);
    document.title = (path === '/' ? 'Book a table' : path === '/lookup' ? 'Find a booking' : path === '/login' ? 'Sign in' : 'Create account') + ' — Tablekeeper';
  }
  function link(href, text, path) {
    return h('a', {
      href: href, 'aria-current': path === href ? 'page' : null,
      onclick: function (e) {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button) return;
        e.preventDefault(); navigate(href);
      },
    }, text);
  }
  function renderHeader(path) {
    clear(headerEl);
    var nav = h('nav', { class: 'nav', 'aria-label': 'Main' },
      link('/', 'Book a table', path), link('/lookup', 'Find a booking', path));
    if (state.session) {
      var name = state.session.display_name || 'You';
      nav.appendChild(h('span', { class: 'who' },
        h('span', { class: 'avatar', 'aria-hidden': 'true', text: name.trim().charAt(0).toUpperCase() || '?' }),
        h('span', { tid: 'current-user', text: name })));
      nav.appendChild(h('button', { class: 'link', type: 'button', tid: 'logout-button', onclick: function () { saveSession(null); renderRoute(); } }, 'Sign out'));
    } else {
      nav.appendChild(link('/login', 'Sign in', path));
      nav.appendChild(link('/signup', 'Create account', path));
    }
    headerEl.appendChild(h('div', { class: 'topbar-inner' },
      h('a', { class: 'brand', href: '/', onclick: function (e) { e.preventDefault(); navigate('/'); } },
        h('span', { class: 'brand-mark', 'aria-hidden': 'true', text: '✦' }), 'Tablekeeper'),
      nav));
  }
  window.addEventListener('popstate', renderRoute);

  // ---------- auth screens ----------
  function authScreen(root, cfg) {
    var errBox = h('div', { 'aria-live': 'polite' });
    var btn = h('button', { class: 'btn', type: 'submit', tid: cfg.submitId }, cfg.cta);
    var inputs = {};
    var fields = cfg.fields.map(function (f) {
      var id = cfg.prefix + '-' + f.name;
      inputs[f.name] = h('input', { id: id, type: f.type, autocomplete: f.auto, required: true, tid: f.tid, name: f.name, minlength: f.min || null });
      return h('div', { class: 'field' }, h('label', { for: id }, f.label), inputs[f.name], f.hint ? h('span', { class: 'hint', text: f.hint }) : null);
    });
    var form = h('form', { class: 'stack', novalidate: 'novalidate', onsubmit: function (e) {
      e.preventDefault();
      if (btn.getAttribute('aria-busy') === 'true') return;
      clear(errBox);
      var body = {};
      Object.keys(inputs).forEach(function (k) { body[k] = inputs[k].value; });
      busy(btn, true, cfg.cta);
      api('POST', cfg.path, { body: body, auth: false }).then(function (res) {
        busy(btn, false, cfg.cta);
        if (res.status === 200 || res.status === 201) {
          saveSession({ token: res.data.token, user_id: res.data.user_id, display_name: res.data.display_name });
          navigate('/');
        } else showMsg(errBox, 'error', errText(res), 'auth-error', cfg.errorOverride && cfg.errorOverride(res));
      }, function () {
        busy(btn, false, cfg.cta);
        showMsg(errBox, 'error', 'We could not reach the restaurant service. Check your connection and try again.', 'auth-error');
      });
    } }, fields, btn);
    root.appendChild(h('div', { class: 'card narrow' }, h('h1', { text: cfg.title }), h('p', { class: 'hint', text: cfg.lead }), form, errBox,
      h('p', { class: 'auth-links' }, cfg.alt)));
    inputs[cfg.fields[0].name].focus();
  }
  function login(root) {
    authScreen(root, {
      title: 'Welcome back', lead: 'Sign in to book and manage your tables.', prefix: 'login', path: '/auth/login', cta: 'Sign in', submitId: 'login-submit',
      fields: [
        { name: 'email', label: 'Email', type: 'email', auto: 'email', tid: 'login-email' },
        { name: 'password', label: 'Password', type: 'password', auto: 'current-password', tid: 'login-password' },
      ],
      errorOverride: function (res) { return res.status === 401 ? 'That email and password do not match. Please try again.' : null; },
      alt: ['New here? ', link('/signup', 'Create an account', '')],
    });
  }
  function signup(root) {
    authScreen(root, {
      title: 'Create your account', lead: 'It takes a few seconds. You can browse tables without one.', prefix: 'signup', path: '/auth/signup', cta: 'Create account', submitId: 'signup-submit',
      fields: [
        { name: 'display_name', label: 'Your name', type: 'text', auto: 'name', tid: 'signup-display-name' },
        { name: 'email', label: 'Email', type: 'email', auto: 'email', tid: 'signup-email' },
        { name: 'password', label: 'Password', type: 'password', auto: 'new-password', tid: 'signup-password', hint: 'At least 8 characters.' },
      ],
      errorOverride: function (res) {
        var c = res.data && res.data.error && res.data.error.code;
        return c === 'email_taken' ? 'That email already has an account. Try signing in instead.' : null;
      },
      alt: ['Already have an account? ', link('/login', 'Sign in', '')],
    });
  }
  function busy(btn, on, label) {
    btn.setAttribute('aria-busy', on ? 'true' : 'false');
    clear(btn);
    if (on) { btn.appendChild(h('span', { class: 'spinner', 'aria-hidden': 'true' })); btn.appendChild(document.createTextNode(' Working…')); }
    else btn.appendChild(document.createTextNode(label));
  }
  // Renders a message box into `box`; testid only present while there is a message.
  function showMsg(box, kind, text, tid, override, extra) {
    clear(box);
    if (!text && !override) return;
    var icon = { error: '!', uncertain: '?', info: 'i', ok: '✓' }[kind];
    box.appendChild(h('div', { class: 'msg ' + kind, role: kind === 'error' ? 'alert' : 'status', tid: tid },
      h('span', { class: 'icon', 'aria-hidden': 'true', text: icon }), h('div', null, h('p', { text: override || text }), extra || null)));
  }

  // ---------- home: search + availability + booking ----------
  function home(root) {
    var st = state;
    var restSel = h('select', { id: 'f-restaurant', tid: 'restaurant-select', name: 'restaurant' }, h('option', { value: '', text: 'Loading restaurants…' }));
    restSel.disabled = true;
    var dateIn = h('input', { id: 'f-date', type: 'date', tid: 'date-input', name: 'date', value: st.lastForm ? st.lastForm.date : todayLocal(), required: true });
    var partyIn = h('input', { id: 'f-party', type: 'number', tid: 'party-size-input', name: 'party', min: '1', step: '1', inputmode: 'numeric', value: st.lastForm ? st.lastForm.party : '2', required: true });
    var searchBtn = h('button', { class: 'btn', type: 'submit', tid: 'search-button' }, 'Find tables');
    var restNote = h('div', { 'aria-live': 'polite' });
    var resultsEl = h('div', { id: 'results', 'aria-live': 'polite' });
    var bookingCol = h('div', { class: 'booking-col' });
    var layout = h('div', { class: 'layout' }, h('div', { class: 'results-col' }, resultsEl), bookingCol);
    var ctx = { restSel: restSel, dateIn: dateIn, partyIn: partyIn, resultsEl: resultsEl, bookingCol: bookingCol, layout: layout, searchBtn: searchBtn };
    st.ui = ctx;

    var form = h('form', { class: 'search-form', novalidate: 'novalidate', onsubmit: function (e) { e.preventDefault(); startSearch(true); } },
      h('div', { class: 'field' }, h('label', { for: 'f-restaurant' }, 'Restaurant'), restSel),
      h('div', { class: 'field' }, h('label', { for: 'f-date' }, 'Date'), dateIn),
      h('div', { class: 'field' }, h('label', { for: 'f-party' }, 'Party size'), partyIn),
      searchBtn);
    root.appendChild(h('section', { class: 'hero' }, h('h1', { text: 'Find your table' }),
      h('p', { text: 'Pick a restaurant, a date and how many of you are dining. We show every table and time, and hold nothing until you confirm.' })));
    root.appendChild(h('div', { class: 'card' }, form, restNote));
    root.appendChild(h('div', { style: 'height:1.25rem' }));
    root.appendChild(layout);

    function loadRestaurants() {
      clear(restNote);
      getRestaurants().then(function (list) {
        if (state.ui !== ctx) return;
        clear(restSel);
        list.forEach(function (r) { restSel.appendChild(h('option', { value: r.id, text: r.name })); });
        if (!list.length) restSel.appendChild(h('option', { value: '', text: 'No restaurants yet' }));
        restSel.disabled = !list.length;
        if (st.lastForm && list.some(function (r) { return r.id === st.lastForm.restaurant; })) restSel.value = st.lastForm.restaurant;
      }, function () {
        if (state.ui !== ctx) return;
        clear(restSel); restSel.appendChild(h('option', { value: '', text: 'Unavailable' }));
        showMsg(restNote, 'error', 'We could not load the restaurants.', null, null,
          h('div', { class: 'actions' }, h('button', { class: 'btn secondary', type: 'button', onclick: loadRestaurants }, 'Try again')));
      });
    }
    loadRestaurants();
    renderResults();
    renderBookingPanel();
  }

  function formValues() {
    var c = state.ui;
    return { restaurant: c.restSel.value, date: c.dateIn.value, party: c.partyIn.value.trim() };
  }

  // userInitiated: a new search by the diner closes the booking form (it described the old results).
  // refresh: re-query the same restaurant/date/party as the displayed results (after a 409).
  function startSearch(userInitiated, refreshOf) {
    var ctx = state.ui;
    if (!ctx) return Promise.resolve();
    var q = refreshOf || formValues();
    if (!q.restaurant) { state.search = { status: 'error', message: 'Choose a restaurant first.', local: true }; renderResults(); return Promise.resolve(); }
    if (!q.date || !/^\d{4}-\d{2}-\d{2}$/.test(q.date)) { state.search = { status: 'error', message: 'Choose a date.', local: true }; renderResults(); return Promise.resolve(); }
    if (!/^[0-9]+$/.test(q.party) || +q.party < 1) { state.search = { status: 'error', message: 'Enter a party size of 1 or more.', local: true }; renderResults(); return Promise.resolve(); }
    state.lastForm = { restaurant: q.restaurant, date: q.date, party: q.party };
    var seq = ++state.searchSeq;
    if (userInitiated) {
      state.booking = null;
      state.search = { status: 'loading', q: q };
      renderResults(); renderBookingPanel();
    }
    var url = '/availability?restaurant_id=' + encodeURIComponent(q.restaurant) + '&date=' + encodeURIComponent(q.date) + '&party_size=' + encodeURIComponent(q.party);
    return Promise.all([getDetail(q.restaurant), api('GET', url, { auth: false })]).then(function (out) {
      if (seq !== state.searchSeq) return; // a newer search owns the screen: drop this response
      var res = out[1];
      if (!userInitiated && !(res.status === 200 && res.data && Array.isArray(res.data.slots))) return; // keep the grid we have
      if (res.status === 200 && res.data && Array.isArray(res.data.slots)) {
        state.search = { status: 'ready', q: q, detail: out[0], data: res.data };
      } else {
        state.search = { status: 'error', q: q, message: res.status === 422 ? errText(res) : 'We could not load availability right now.' };
      }
      renderResults(); syncSelection();
    }, function () {
      if (seq !== state.searchSeq || !userInitiated) return;
      state.search = { status: 'error', q: q, message: 'We could not reach the restaurant service. Check your connection and try again.' };
      renderResults();
    });
  }

  function chipFor(tableIds, slotLocal, available, name, meta, combo) {
    var time = slotLocal.slice(11, 16);
    var sel = state.booking && state.booking.sel;
    var selected = !!sel && sel.local === slotLocal && sel.tableIds.join('+') === tableIds.join('+');
    var mine = selected && state.booking.result;
    var stateText = selected ? (mine ? 'Booked by you' : 'Selected') : available ? 'Available' : 'Unavailable';
    var chip = h('button', {
      type: 'button', class: 'chip' + (combo ? ' combo' : '') + (selected ? ' is-selected' : ''),
      tid: 'slot-' + tableIds.join('+') + '-' + time, 'data-available': available ? 'true' : 'false',
      'aria-pressed': selected ? 'true' : 'false', 'aria-disabled': available ? null : 'true',
      'aria-label': name + ' at ' + time + ', seats ' + meta + ', ' + stateText,
      onclick: function () { if (available) openBooking(tableIds, slotLocal); },
    }, h('span', { class: 'chip-name', text: name }), h('span', { class: 'chip-meta', text: meta ? 'seats ' + meta : '' }), h('span', { class: 'chip-state', text: stateText }));
    return chip;
  }

  function renderResults() {
    var ctx = state.ui; if (!ctx) return;
    var el = ctx.resultsEl; clear(el);
    var s = state.search;
    if (s.status === 'idle') {
      el.appendChild(h('div', { class: 'card empty' }, h('div', { class: 'plate', 'aria-hidden': 'true', text: '🍽' }), h('div', { class: 'big', text: 'Where shall we seat you?' }),
        h('div', { text: 'Choose a restaurant, date and party size, then press “Find tables”.' })));
    } else if (s.status === 'loading') {
      el.appendChild(h('div', { class: 'card', 'aria-busy': 'true' }, h('p', { role: 'status', class: 'hint' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), ' Looking for tables…'),
        h('div', { class: 'skeleton' }), h('div', { class: 'skeleton' }), h('div', { class: 'skeleton' })));
    } else if (s.status === 'error') {
      var box = h('div');
      showMsg(box, 'error', s.message, 'search-error', null, s.local ? null : h('div', { class: 'actions' },
        h('button', { class: 'btn secondary', type: 'button', onclick: function () { startSearch(true, s.q); } }, 'Try again')));
      el.appendChild(h('div', { class: 'card' }, box));
    } else {
      var d = s.data, detail = s.detail, party = +s.q.party;
      var head = h('div', { class: 'results-head' }, h('h2', { text: detail.name }),
        h('p', { text: fmtDate(d.date) + ' · party of ' + party }));
      if (!d.slots.length) {
        el.appendChild(h('div', { class: 'card empty', tid: 'no-slots' }, h('div', { class: 'plate', 'aria-hidden': 'true', text: '🕯' }),
          h('div', { class: 'big', text: 'Closed on ' + fmtDate(d.date) }), h('div', { text: detail.name + ' has no tables to book that day. Try another date.' })));
        return;
      }
      var legend = h('ul', { class: 'legend', 'aria-label': 'Legend' },
        h('li', null, h('span', { class: 'swatch available' }), 'Available'),
        h('li', null, h('span', { class: 'swatch unavailable' }), 'Unavailable'),
        h('li', null, h('span', { class: 'swatch selected' }), 'Your selection'));
      var grid = h('div', { tid: 'availability-grid', role: 'group', 'aria-label': 'Tables and times' });
      // Policies can change capacities, so also show any pair the server offers somewhere on this day.
      var offered = {};
      d.slots.forEach(function (sl) { (sl.available_options || []).forEach(function (o) { if (o.table_ids.length === 2) offered[o.table_ids.join('+')] = true; }); });
      var combos = (detail.combinable || []).filter(function (c) {
        if (offered[c.join('+')]) return true;
        var cap = 0; c.forEach(function (id) { var t = (detail.tables || []).filter(function (x) { return x.id === id; })[0]; cap += t ? t.capacity : 0; });
        return cap >= party;
      });
      d.slots.forEach(function (slot) {
        var avail = slot.available_table_ids || [];
        var opts = Array.isArray(slot.available_options) ? slot.available_options : null;
        var row = h('div', { class: 'slot-row' }, h('div', { class: 'slot-time', text: slot.starts_at_local.slice(11, 16) }));
        var chips = h('div', { class: 'slot-options' });
        (detail.tables || []).forEach(function (t) {
          chips.appendChild(chipFor([t.id], slot.starts_at_local, avail.indexOf(t.id) !== -1, tableName(t.label), String(t.capacity), false));
        });
        if (opts) combos.forEach(function (c) {
          var ok = opts.some(function (o) { return o.table_ids.join('+') === c.join('+'); });
          var cap = 0; c.forEach(function (id) { cap += (detail.tables.filter(function (x) { return x.id === id; })[0] || { capacity: 0 }).capacity; });
          chips.appendChild(chipFor(c, slot.starts_at_local, ok, tablesText(labelsFor(detail, c)), cap + ' together', true));
        });
        row.appendChild(chips); grid.appendChild(row);
      });
      el.appendChild(h('div', { class: 'card' }, head, legend, grid));
    }
  }

  // Re-draw chip selection marks without touching the booking form.
  function syncSelection() { renderResults(); }

  function openBooking(tableIds, local) {
    if (!state.session) {
      var box = state.ui.resultsEl.querySelector('.auth-prompt');
      if (!box) { box = h('div', { class: 'auth-prompt' }); state.ui.resultsEl.insertBefore(box, state.ui.resultsEl.firstChild); }
      showMsg(box, 'info', 'Please sign in to book a table.', 'auth-error', null,
        h('div', { class: 'actions' }, link('/login', 'Sign in', ''), ' · ', link('/signup', 'Create an account', '')));
      return;
    }
    var q = state.search.q, detail = state.search.detail;
    var prev = state.booking;
    var b = prev || { partyValue: q.party, attempt: null, phase: 'idle', result: null, error: null, uncertain: false };
    b.sel = { restaurantId: q.restaurant, restaurantName: detail.name, tableIds: tableIds.slice(), labels: labelsFor(detail, tableIds), local: local };
    b.result = null; b.error = null; b.uncertain = false; // a different selection is a different booking
    state.booking = b;
    renderResults(); renderBookingPanel(true);
  }

  function renderBookingPanel(focus) {
    var ctx = state.ui; if (!ctx) return;
    var col = ctx.bookingCol; clear(col);
    var b = state.booking;
    ctx.layout.classList.toggle('has-booking', !!b);
    if (!b) return;
    var s = b.sel;
    var summary = h('div', { class: 'summary', tid: 'booking-summary' },
      s.restaurantName + ' · ' + tablesText(s.labels) + ' ', h('span', { class: 'sub', text: fmtWhen(s.local) }));
    var partyIn = h('input', { id: 'b-party', type: 'number', min: '1', step: '1', inputmode: 'numeric', tid: 'booking-party-size', value: b.partyValue, required: true,
      oninput: function () { b.partyValue = partyIn.value; b.result = null; renderConfirmation(); } });
    var submit = h('button', { class: 'btn', type: 'submit', tid: 'booking-submit' }, 'Confirm booking');
    b.dom = { status: h('div', { 'aria-live': 'polite' }), confirm: h('div'), submit: submit, partyIn: partyIn };
    var form = h('form', { novalidate: 'novalidate', class: 'stack', onsubmit: function (e) { e.preventDefault(); submitBooking(); } },
      summary, h('div', { class: 'field' }, h('label', { for: 'b-party' }, 'Party size'), partyIn), submit, b.dom.status);
    col.appendChild(h('div', { class: 'card', tid: 'booking-form', role: 'region', 'aria-label': 'Booking' }, h('h2', { text: 'Your booking' }), form, b.dom.confirm));
    renderBookingStatus(); renderConfirmation();
    if (focus) { partyIn.focus({ preventScroll: true }); col.scrollIntoView({ block: 'nearest', behavior: window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' }); }
  }

  function renderBookingStatus() {
    var b = state.booking; if (!b || !b.dom) return;
    var box = b.dom.status; clear(box);
    if (b.error) showMsg(box, 'error', b.error, 'booking-error');
    else if (b.uncertain) showMsg(box, 'uncertain', 'We lost the connection before we could confirm this booking, so we don’t know whether it went through. Retrying is safe: it will not create a second booking. Press “Retry booking” to find out.', 'booking-uncertain');
    var btn = b.dom.submit; clear(btn);
    if (b.phase === 'submitting') { btn.setAttribute('aria-busy', 'true'); btn.appendChild(h('span', { class: 'spinner', 'aria-hidden': 'true' })); btn.appendChild(document.createTextNode(' Booking…')); }
    else { btn.setAttribute('aria-busy', 'false'); btn.appendChild(document.createTextNode(b.uncertain ? 'Retry booking' : 'Confirm booking')); }
  }

  function renderConfirmation() {
    var b = state.booking; if (!b || !b.dom) return;
    var box = b.dom.confirm; clear(box);
    if (!b.result) return;
    var r = b.result, s = b.sel;
    var ids = r.table_ids || (r.table_id ? [r.table_id] : s.tableIds);
    var labels = labelsFor(state.details[r.restaurant_id], ids);
    var tablesStr = tablesText(labels);
    box.appendChild(h('div', { class: 'confirm', tid: 'confirmation', role: 'status' },
      h('h3', null, h('span', { 'aria-hidden': 'true', text: '✓' }), 'You’re booked'),
      h('span', { class: 'hint', text: 'Your confirmation reference' }),
      h('span', { class: 'ref', tid: 'confirmation-reference', text: r.reference }),
      h('p', { tid: 'confirmation-details', text: (state.details[r.restaurant_id] ? state.details[r.restaurant_id].name : s.restaurantName) + ' · ' + tablesStr + ' · ' + fmtWhen(r.starts_at_local) + ' · party of ' + r.party_size }),
      h('dl', { class: 'facts' }, h('dt', { text: 'Tables' }), h('dd', { tid: 'confirmation-tables', text: tablesStr }),
        h('dt', { text: 'Status' }), h('dd', { text: r.status })),
      h('p', { class: 'hint', text: 'Keep this reference — use “Find a booking” to look it up or cancel.' })));
  }

  function bookingBody(b) {
    var party = b.partyValue.trim();
    var body = { restaurant_id: b.sel.restaurantId };
    // Single tables use the original table_id form so existing (stage-1) servers accept them too.
    if (b.sel.tableIds.length === 1) body.table_id = b.sel.tableIds[0]; else body.table_ids = b.sel.tableIds.slice();
    body.starts_at_local = b.sel.local;
    body.party_size = /^[0-9]+$/.test(party) ? parseInt(party, 10) : party;
    return body;
  }

  function submitBooking() {
    var b = state.booking;
    if (!b || b.phase === 'submitting') return;
    if (!state.session) {
      b.error = 'Please sign in to book a table.'; renderBookingStatus(); return;
    }
    var body = bookingBody(b), canon = JSON.stringify(body);
    // Unchanged form -> same key + body (replay). Any change -> new booking request with a new key.
    if (!b.attempt || b.attempt.canon !== canon) { b.attempt = { key: newKey(), canon: canon, body: body }; b.result = null; renderConfirmation(); }
    var attempt = b.attempt;
    b.phase = 'submitting'; renderBookingStatus();
    api('POST', '/reservations', { body: attempt.canon, key: attempt.key }).then(function (res) {
      if (state.booking !== b) return;
      b.phase = 'idle';
      if (res.status === 201 || res.status === 200) {
        if (!res.data || !res.data.reference) { return unknownOutcome(b); }
        b.error = null; b.uncertain = false; b.result = res.data;
        renderBookingStatus(); renderConfirmation(); renderResults();
        if (res.status === 201) refreshAvailability();
      } else if (res.status >= 500 || !res.data || !res.data.error) {
        unknownOutcome(b);
      } else {
        b.uncertain = false; b.result = null;
        if (res.status === 401) { saveSession(null); renderHeader(location.pathname); b.error = 'Your session has ended. Please sign in again.'; }
        else b.error = errText(res);
        if (res.status === 409 && res.data.error.code === 'table_unavailable') {
          // Refresh availability first so error and grid appear together; the form and its inputs stay.
          var done = false;
          var show = function () { if (done) return; done = true; if (state.booking === b) { renderBookingStatus(); renderConfirmation(); } };
          refreshAvailability().then(show, show); setTimeout(show, 3000);
        } else { renderBookingStatus(); renderConfirmation(); }
      }
    }, function () { if (state.booking === b) { b.phase = 'idle'; unknownOutcome(b); } });
  }
  function unknownOutcome(b) {
    b.phase = 'idle'; b.error = null; b.result = null; b.uncertain = true;
    renderBookingStatus(); renderConfirmation();
  }
  function refreshAvailability() {
    var s = state.search;
    if (!s || !s.q) return Promise.resolve();
    return startSearch(false, s.q);
  }

  // ---------- lookup ----------
  function lookup(root) {
    var refIn = h('input', { id: 'l-ref', tid: 'lookup-reference-input', name: 'reference', autocomplete: 'off', autocapitalize: 'characters', spellcheck: 'false', required: true });
    var btn = h('button', { class: 'btn', type: 'submit', tid: 'lookup-submit' }, 'Find booking');
    var out = h('div', { 'aria-live': 'polite' });
    var current = null;
    function showErr(text) { clear(out); out.appendChild(h('div', { class: 'msg error', role: 'alert', tid: 'reservation-error' }, h('span', { class: 'icon', 'aria-hidden': 'true', text: '!' }), h('p', { text: text }))); }
    function render(r, restDetail, errText2) {
      clear(out);
      var ids = r.table_ids || (r.table_id ? [r.table_id] : []);
      var tablesStr = tablesText(labelsFor(restDetail, ids));
      var cancelBtn = r.status === 'confirmed' ? h('button', { class: 'btn danger', type: 'button', tid: 'reservation-cancel-button', onclick: function () { cancel(r, restDetail, cancelBtn); } }, 'Cancel booking') : null;
      out.appendChild(h('div', { class: 'card', tid: 'reservation-detail', style: 'margin-top:1rem' },
        h('h2', { text: restDetail && restDetail.name ? restDetail.name : 'Your booking' }),
        h('p', null, h('span', { class: 'badge ' + r.status, tid: 'reservation-status', text: r.status })),
        h('dl', { class: 'facts' },
          h('dt', { text: 'Reference' }), h('dd', { text: r.reference }),
          h('dt', { text: 'When' }), h('dd', { text: fmtWhen(r.starts_at_local) }),
          h('dt', { text: 'Tables' }), h('dd', { tid: 'reservation-tables', text: tablesStr }),
          h('dt', { text: 'Party' }), h('dd', { text: String(r.party_size) })),
        cancelBtn ? h('div', { class: 'row-actions' }, cancelBtn) : null));
      if (errText2) {
        out.firstChild.appendChild(h('div', { class: 'msg error', role: 'alert', tid: 'reservation-error' }, h('span', { class: 'icon', 'aria-hidden': 'true', text: '!' }), h('p', { text: errText2 })));
      }
    }
    function cancel(r, restDetail, cbtn) {
      if (cbtn.getAttribute('aria-busy') === 'true') return;
      busy(cbtn, true, 'Cancel booking');
      api('POST', '/reservations/' + encodeURIComponent(r.reference) + '/cancel', { body: {} }).then(function (res) {
        if (current !== r) return;
        if (res.status === 200 && res.data) { current = res.data; render(res.data, restDetail); }
        else { busy(cbtn, false, 'Cancel booking'); render(r, restDetail, res.data && res.data.error ? errText(res) : 'We could not cancel this booking.'); }
      }, function () {
        if (current !== r) return;
        render(r, restDetail, 'We could not reach the restaurant service. Check your connection and try again.');
      });
    }
    var form = h('form', { class: 'stack', novalidate: 'novalidate', onsubmit: function (e) {
      e.preventDefault();
      var ref = refIn.value.trim().toUpperCase();
      var seq = ++state.lookupSeq;
      clear(out); current = null;
      if (!ref) { showErr('Enter the booking reference from your confirmation.'); return; }
      if (!state.session) { showErr('Please sign in to look up a booking.'); return; }
      busy(btn, true, 'Find booking');
      api('GET', '/reservations/' + encodeURIComponent(ref)).then(function (res) {
        if (seq !== state.lookupSeq) return;
        if (res.status === 200 && res.data) {
          return getDetail(res.data.restaurant_id).catch(function () { return null; }).then(function (d) {
            if (seq !== state.lookupSeq) return;
            busy(btn, false, 'Find booking'); current = res.data; render(res.data, d);
          });
        }
        busy(btn, false, 'Find booking');
        if (res.status === 401) { saveSession(null); renderHeader('/lookup'); showErr('Please sign in to look up a booking.'); }
        else showErr(res.status === 404 ? 'We couldn’t find a booking with that reference on your account.' : errText(res));
      }, function () {
        if (seq !== state.lookupSeq) return;
        busy(btn, false, 'Find booking');
        showErr('We could not reach the restaurant service. Check your connection and try again.');
      });
    } }, h('div', { class: 'field' }, h('label', { for: 'l-ref' }, 'Booking reference'), refIn, h('span', { class: 'hint', text: 'The 6–12 character code on your confirmation.' })), btn);
    root.appendChild(h('div', { class: 'card narrow' }, h('h1', { text: 'Find a booking' }), form, out,
      state.session ? null : h('p', { class: 'auth-links' }, link('/login', 'Sign in', ''), ' to see your bookings.')));
    refIn.focus();
  }

  document.body.insertBefore(headerEl, document.body.firstChild);
  clear(app); app.appendChild(mainEl);
  renderRoute();
})();
