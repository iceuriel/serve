/* ============================================================
   SERVE — CLIENT PORTAL
   Vanilla JS, no dependencies, same as the rest of the site.

   Reads the contact id and token from the URL, asks /api/portal, renders two
   sections: their bookings, and how to get into each of their homes.

   EVERY VALUE IS INSERTED AS TEXT, never as HTML. Addresses come from a
   spreadsheet a person types into and instructions are the customer's own free
   text, so an apostrophe in a street name or an angle bracket in a note has to
   be inert. There is no innerHTML in this file and there should not be one.

   THE DOOR CODE IS NEVER IN THIS PAGE'S DATA. The server sends whether one is
   saved and the date, never the value — so there is nothing here to leak, and
   nothing to be careful with.

   THE TOKEN GOES IN THE BODY ON WRITES, never the query string: a query string
   lands in proxy logs, browser history and referrer headers.
   ============================================================ */
(function () {
    'use strict';

    var API = '/api/portal';

    var stateEl = document.getElementById('p-state');
    var navEl   = document.getElementById('p-nav');
    var bodyEl  = document.getElementById('p-body');
    var forEl   = document.getElementById('p-for');
    var footEl  = document.getElementById('p-foot');

    var params = new URLSearchParams(location.search);
    var id     = params.get('id') || '';
    var token  = params.get('t')  || '';

    var model = null;
    var tab   = 'bookings';

    if (!id || !token) { fail('This link is incomplete.'); return; }

    fetch(API + '?id=' + encodeURIComponent(id) + '&t=' + encodeURIComponent(token))
        .then(function (r) { return r.json(); })
        .then(function (d) {
            /* view === portal, not merely ok. An older deployment has no
               portal route, so doGet falls through to the HEALTH CHECK, which
               answers ok:true — and this page would render that as an empty
               account rather than saying anything was wrong. The ticket hit
               the same ordering problem on 2026-09-08. */
            if (!d || d.ok !== true || d.view !== 'portal') {
                fail('We could not open that link. It may be mistyped, or it ' +
                     'may have been replaced.');
                return;
            }
            model = d;
            start();
        })
        .catch(function (err) {
            console.warn('portal load failed', err);
            fail('We could not load your account just now. Please try again, ' +
                 'or call us on the number below.');
        });

    function fail(msg) {
        stateEl.textContent = msg;
        footEl.hidden = false;
    }

    /* --- tiny DOM helpers: text only, by construction --- */
    function el(tag, cls, text) {
        var n = document.createElement(tag);
        if (cls) n.className = cls;
        if (text !== undefined && text !== null && text !== '') n.textContent = String(text);
        return n;
    }
    function add(parent, node) { if (node) parent.appendChild(node); }

    function money(v) {
        var n = Number(v);
        return isFinite(n) && n > 0 ? '$' + n.toFixed(2) : '';
    }

    /* "2026-09-10" -> "Thu, Sep 10". Split rather than parsed: a booked date
       has no timezone, and new Date('2026-09-10') is UTC midnight, which
       renders as the day before in Boston. */
    function prettyDate(iso) {
        var p = String(iso || '').split('-');
        if (p.length !== 3) return '';
        var d = new Date(+p[0], +p[1] - 1, +p[2]);
        if (!isFinite(d.getTime())) return '';
        var days = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
        var mons = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
        return days[d.getDay()] + ', ' + mons[d.getMonth()] + ' ' + d.getDate();
    }

    /* One line per fact, never the same fact twice. A booking made on a time
       PREFERENCE has no date, and `time` and `when` then hold the same
       sentence — see the same rule in ticket.js. */
    function whenLine(b) {
        var day = prettyDate(b.date);
        var norm = function (s) {
            return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
        };
        var parts = [];
        [b.time, b.when].forEach(function (v) {
            var text = String(v || '').trim();
            var n = norm(text);
            if (!n) return;
            for (var i = 0; i < parts.length; i++) {
                if (norm(parts[i]).indexOf(n) !== -1 || n.indexOf(norm(parts[i])) !== -1) return;
            }
            parts.push(text);
        });
        return [day].concat(parts).filter(Boolean).join(' · ');
    }

    /* ========================================================
       SAVING
       ========================================================
       One endpoint for both kinds of write. The server proves the target
       belongs to this contact before touching it, so this layer only has to
       report what happened.

       No optimistic UI. A note the customer believes was saved and was not is
       worse than a half-second wait — the cleaner arrives without it and
       nobody finds out until the day. ======================================= */
    function save(payload, statusEl, btn) {
        statusEl.textContent = 'Saving…';
        statusEl.className = 'tk-save';
        if (btn) btn.disabled = true;

        var body = { event_type: 'portal_write', contact_id: id, t: token };
        Object.keys(payload).forEach(function (k) { body[k] = payload[k]; });

        return fetch(API, {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain;charset=utf-8' },
            body: JSON.stringify(body),
        })
        .then(function (r) { return r.json(); })
        .then(function (d) {
            if (btn) btn.disabled = false;
            if (d && d.ok) {
                statusEl.textContent = 'Saved';
                statusEl.className = 'tk-save is-ok';
                return true;
            }
            statusEl.textContent = d && d.error === 'closed'
                ? 'That booking is finished, so it can no longer be edited.'
                : 'That did not save. Please try again.';
            statusEl.className = 'tk-save is-bad';
            return false;
        })
        .catch(function () {
            if (btn) btn.disabled = false;
            statusEl.textContent = 'That did not save. Please try again.';
            statusEl.className = 'tk-save is-bad';
            return false;
        });
    }

    /** A textarea with a save button. Returns the wrapper. */
    function editor(opts) {
        var wrap = el('div', 'tk-edit');
        if (opts.label) wrap.appendChild(el('label', 'tk-edit__lbl', opts.label));

        if (opts.readOnly) {
            wrap.appendChild(el('p', 'tk-val', opts.value || '—'));
            return wrap;
        }

        var ta = document.createElement('textarea');
        ta.className = 'tk-edit__box';
        ta.rows = opts.rows || 2;
        ta.value = opts.value || '';
        if (opts.placeholder) ta.placeholder = opts.placeholder;
        wrap.appendChild(ta);

        var row = el('div', 'tk-edit__row');
        var btn = el('button', 'tk-edit__save', 'Save');
        btn.type = 'button';
        var status = el('span', 'tk-save');
        row.appendChild(btn);
        row.appendChild(status);
        wrap.appendChild(row);

        btn.addEventListener('click', function () {
            save(opts.payload(ta.value.trim()), status, btn);
        });
        /* A note typed and then abandoned is the common failure. Say so rather
           than silently keeping the old value. */
        ta.addEventListener('input', function () {
            status.textContent = 'Not saved yet';
            status.className = 'tk-save is-dirty';
        });

        return wrap;
    }

    /* ======================================================== */
    function start() {
        stateEl.hidden = true;
        navEl.hidden   = false;
        bodyEl.hidden  = false;
        footEl.hidden  = false;

        forEl.textContent = model.firstName ? 'for ' + model.firstName : '';

        [['bookings', 'Bookings'], ['access', 'Arrival & access']].forEach(function (pair) {
            var b = el('button', 'portal__tab', pair[1]);
            b.type = 'button';
            b.setAttribute('data-tab', pair[0]);
            b.addEventListener('click', function () { tab = pair[0]; paint(); });
            navEl.appendChild(b);
        });

        paint();
    }

    function paint() {
        navEl.querySelectorAll('.portal__tab').forEach(function (b) {
            var on = b.getAttribute('data-tab') === tab;
            b.classList.toggle('is-on', on);
            b.setAttribute('aria-current', on ? 'true' : 'false');
        });
        bodyEl.textContent = '';
        if (tab === 'bookings') renderBookings(); else renderAccess();
    }

    /* ========================================================
       BOOKINGS
       ======================================================== */
    function renderBookings() {
        var list = model.bookings || [];
        if (!list.length) {
            bodyEl.appendChild(el('p', 'tk-val', 'No bookings yet.'));
            return;
        }

        var upcoming = list.filter(function (b) { return !b.completed; });
        var past     = list.filter(function (b) { return b.completed; });

        if (upcoming.length) {
            bodyEl.appendChild(el('h2', 'portal__h', 'Upcoming'));
            upcoming.forEach(function (b) { bodyEl.appendChild(bookingRow(b)); });
        }
        if (past.length) {
            bodyEl.appendChild(el('h2', 'portal__h', 'Past'));
            past.forEach(function (b) { bodyEl.appendChild(bookingRow(b)); });
        }
    }

    /** The title line is service + date, as asked; the detail opens on click. */
    function bookingRow(b) {
        var det = document.createElement('details');
        det.className = 'pb' + (b.completed ? ' pb--done' : '');

        var sum = document.createElement('summary');
        sum.className = 'pb__sum';
        sum.appendChild(el('span', 'pb__title', b.serviceLabel));
        sum.appendChild(el('span', 'pb__when', whenLine(b) || 'Date to be confirmed'));
        var price = money(b.price);
        if (price) sum.appendChild(el('span', 'pb__price', price + (b.paid ? ' · paid' : '')));
        det.appendChild(sum);

        var inner = el('div', 'pb__body');
        if (b.propertyLabel) add(inner, line('Home', b.propertyLabel));
        if (b.addOns) add(inner, line('Add-ons', b.addOns));
        if (b.completed) {
            add(inner, line('Completed', prettyDate(b.completed) || b.completed));
            add(inner, line('Payment', b.paid ? 'Paid' : 'Due'));
            inner.appendChild(el('p', 'tk-note',
                'Finished bookings are a record — they can no longer be edited.'));
            det.appendChild(inner);
            return det;
        }

        add(inner, line('Payment', b.paid ? 'Paid' : 'Due at service'));

        /* Rooms, each with a note the customer can add. */
        (b.rooms || []).forEach(function (r) {
            var rd = document.createElement('details');
            rd.className = 'tk-room';
            var rs = document.createElement('summary');
            rs.className = 'tk-room__sum';
            rs.appendChild(el('span', 'tk-room__name', r.label));
            rs.appendChild(el('span', 'tk-room__flag',
                r.instruction ? 'Has instructions' : 'Add instructions'));
            rd.appendChild(rs);
            rd.appendChild(editor({
                value: r.instruction, rows: 2,
                placeholder: 'e.g. Fresh sheets are in the closet.',
                payload: function (text) {
                    return { kind: 'instruction', job_id: b.bookingId,
                             scope_type: 'ROOM', scope_key: r.key, instruction: text };
                },
            }));
            inner.appendChild(rd);
        });

        inner.appendChild(editor({
            label: 'Anything else for this visit', value: b.generalInstruction, rows: 3,
            placeholder: 'Anything that applies to the whole visit.',
            payload: function (text) {
                return { kind: 'instruction', job_id: b.bookingId,
                         scope_type: 'BOOKING', scope_key: 'GENERAL', instruction: text };
            },
        }));
        if (b.atBooking) add(inner, line('What you told us when you booked', b.atBooking));

        det.appendChild(inner);
        return det;
    }

    function line(label, value) {
        if (value === undefined || value === null || String(value).trim() === '') return null;
        var b = el('div', 'tk-blk');
        b.appendChild(el('div', 'tk-lbl', label));
        b.appendChild(el('div', 'tk-val', value));
        return b;
    }

    /* ========================================================
       ARRIVAL & ACCESS
       ========================================================
       Set once per home, and it applies to every visit — which is the reason
       the portal exists rather than a per-booking form. */
    function renderAccess() {
        var homes = model.homes || [];
        if (!homes.length) {
            bodyEl.appendChild(el('p', 'tk-val',
                'Once you have a booking, this is where you tell us how to get in.'));
            return;
        }

        homes.forEach(function (home) {
            if (homes.length > 1 || home.label) {
                bodyEl.appendChild(el('h2', 'portal__h', home.label || 'Your home'));
            }
            /* No property_id means we cannot key the answers to a home, which
               happens on bookings that predate the id. Say so rather than
               offering a form whose Save button cannot work. */
            if (!home.propertyId) {
                bodyEl.appendChild(el('p', 'tk-note',
                    'We are still linking this address to your account — access ' +
                    'details for it are coming shortly.'));
                return;
            }
            home.questions.forEach(function (q) {
                bodyEl.appendChild(question(home, q));
            });
            bodyEl.appendChild(editor({
                label: 'Pets (optional)', value: home.petNotes, rows: 2,
                placeholder: home.petPlaceholder,
                payload: function (text) {
                    return { kind: 'access', property_id: home.propertyId,
                             field: 'pets', detail: text };
                },
            }));
        });
    }

    /**
     * One question: bullets, and a detail box that appears only for the choice
     * that has one. Selecting a choice saves it immediately — a radio that
     * needs a separate Save is a radio people forget to save.
     */
    function question(home, q) {
        var wrap = el('fieldset', 'pq');
        wrap.appendChild(el('legend', 'pq__legend', q.label));

        var status = el('span', 'tk-save');
        var detailHost = el('div', 'pq__detail');
        var chosen = q.choice;

        q.choices.forEach(function (c) {
            var row = el('label', 'pq__opt');
            var input = document.createElement('input');
            input.type = 'radio';
            input.name = 'q-' + home.propertyId + '-' + q.field;
            input.value = c.key;
            input.checked = chosen === c.key;
            row.appendChild(input);
            row.appendChild(el('span', 'pq__opt-label', c.label));
            wrap.appendChild(row);

            input.addEventListener('change', function () {
                if (!input.checked) return;
                chosen = c.key;
                paintDetail();
                /* Save the choice straight away. The detail, if there is one,
                   saves with its own button once they have typed it. */
                save({ kind: 'access', property_id: home.propertyId,
                       field: q.field, choice: c.key, detail: '' }, status, null);
            });
        });

        function paintDetail() {
            detailHost.textContent = '';
            var c = null;
            q.choices.forEach(function (x) { if (x.key === chosen) c = x; });
            if (!c || !c.detail) return;

            if (c.secret) {
                /* THE CODE IS NEVER SENT TO THIS PAGE. All we know is whether
                   one is saved and when, so that is all we show. */
                if (q.secretSet) {
                    var saved = el('p', 'pq__saved',
                        'Code saved' + (q.secretSetAt ? ' · ' + prettyDate(q.secretSetAt) : ''));
                    detailHost.appendChild(saved);
                }
                detailHost.appendChild(editor({
                    value: '', rows: 1,
                    placeholder: q.secretSet ? 'Enter a new code to replace it' : c.detail,
                    payload: function (text) {
                        return { kind: 'access', property_id: home.propertyId,
                                 field: q.field, choice: c.key, detail: text };
                    },
                }));
                detailHost.appendChild(el('p', 'tk-note',
                    'We never show this back to you, and it is not on your cleaner’s ' +
                    'page. We pass it on directly when we assign your visit.'));
                return;
            }

            detailHost.appendChild(editor({
                value: q.detail, rows: 2, placeholder: c.detail,
                payload: function (text) {
                    return { kind: 'access', property_id: home.propertyId,
                             field: q.field, choice: c.key, detail: text };
                },
            }));
        }

        paintDetail();
        wrap.appendChild(detailHost);
        wrap.appendChild(status);
        return wrap;
    }
})();
