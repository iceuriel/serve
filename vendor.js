/* ============================================================
   SERVE — VENDOR PORTAL
   Vanilla JS, no dependencies, same as the rest of the site.

   Two tabs: the jobs assigned to this company, and the company profile that
   Serve shows customers.

   EVERY VALUE IS INSERTED AS TEXT, never as HTML. Company descriptions and
   team details are free text a partner types, and they end up on a customer's
   ticket — so they have to be inert at every hop. There is no innerHTML in
   this file and there should not be one.

   WHAT IS EDITABLE IS DECIDED ON THE SERVER. `editableFields` shapes the
   layout; it is not the guard. The write path has its own whitelist, and a
   field that is not on it is dropped rather than written — a partner may
   describe themselves, not promote themselves.
   ============================================================ */
(function () {
    'use strict';

    var API = '/api/vendor';

    var stateEl = document.getElementById('v-state');
    var navEl   = document.getElementById('v-nav');
    var bodyEl  = document.getElementById('v-body');
    var forEl   = document.getElementById('v-for');
    var footEl  = document.getElementById('v-foot');

    var params = new URLSearchParams(location.search);
    var id     = params.get('id') || '';
    var token  = params.get('t')  || '';

    var model = null;
    var tab   = 'bookings';

    if (!id || !token) { fail('This link is incomplete.'); return; }

    fetch(API + '?id=' + encodeURIComponent(id) + '&t=' + encodeURIComponent(token))
        .then(function (r) { return r.json(); })
        .then(function (d) {
            /* view === vendor, not merely ok. An older deployment has no
               vendor route, so doGet falls through to the health check, which
               answers ok:true — and this page would render that as an empty
               company rather than saying anything was wrong. */
            if (!d || d.ok !== true || d.view !== 'vendor') {
                fail('We could not open that link. It may be mistyped, or it ' +
                     'may have been replaced.');
                return;
            }
            model = d;
            start();
            if (typeof ServeLive !== 'undefined') ServeLive.watch({
                url: API + '?id=' + encodeURIComponent(id) + '&t=' + encodeURIComponent(token),
                view: 'vendor', root: bodyEl, initial: d,
                onData: function (next) { model = next; paint(); }
            });
        })
        .catch(function (err) {
            console.warn('vendor portal load failed', err);
            fail('We could not load your account just now. Please try again, ' +
                 'or call us on the number below.');
        });

    function fail(msg) {
        stateEl.textContent = msg;
        footEl.hidden = false;
    }

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

    function prettyDate(iso) {
        var p = String(iso || '').split('-');
        if (p.length !== 3) return '';
        var d = new Date(+p[0], +p[1] - 1, +p[2]);
        if (!isFinite(d.getTime())) return '';
        var days = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
        var mons = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
        return days[d.getDay()] + ', ' + mons[d.getMonth()] + ' ' + d.getDate();
    }

    /* One line per fact, never the same fact twice — a preference booking has
       no date and `time` and `when` then hold the same sentence. */
    /* One date, then the time — or the schedule summary when there is no date.
       See scheduleHead in ticket.js. */
    function whenLine(b) {
        return [prettyDate(b.date), String(b.time || b.when || '').trim()]
            .filter(Boolean).join(' · ');
    }

    function save(payload, statusEl, btn) {
        statusEl.textContent = 'Saving…';
        statusEl.className = 'tk-save';
        if (btn) btn.disabled = true;

        var body = { event_type: 'vendor_write', vendor_id: id, t: token };
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
            statusEl.textContent = d && d.error === 'not_editable'
                ? 'Serve manages that one — email us to change it.'
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

    function editor(opts) {
        var wrap = el('div', 'tk-edit');
        if (opts.label) wrap.appendChild(el('label', 'tk-edit__lbl', opts.label));

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
            var text = ta.value.trim();
            save(opts.payload(text), status, btn).then(function (ok) {
                if (ok && ta.value.trim() !== text) {
                    status.textContent = 'Not saved yet'; status.className = 'tk-save is-dirty';
                }
            });
        });
        ta.addEventListener('input', function () {
            status.textContent = 'Not saved yet';
            status.className = 'tk-save is-dirty';
        });
        return wrap;
    }

    /** A Serve-controlled fact. Shown, never an input. */
    function fact(label, value) {
        if (value === undefined || value === null || String(value).trim() === '') return null;
        var b = el('div', 'tk-blk');
        b.appendChild(el('div', 'tk-lbl', label));
        b.appendChild(el('div', 'tk-val', value));
        return b;
    }

    function start() {
        stateEl.hidden = true;
        navEl.hidden   = false;
        bodyEl.hidden  = false;
        footEl.hidden  = false;

        forEl.textContent = model.company && model.company.displayName
            ? 'partners · ' + model.company.displayName : 'partners';

        [['bookings', 'Jobs'], ['company', 'Company']].forEach(function (pair) {
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
        if (tab === 'bookings') renderJobs(); else renderCompany();
    }

    /* ========================================================
       JOBS
       ======================================================== */
    function renderJobs() {
        var list = model.bookings || [];
        if (!list.length) {
            bodyEl.appendChild(el('p', 'tk-val',
                'No jobs assigned yet. They appear here as soon as Serve books one to you.'));
            return;
        }
        var upcoming = list.filter(function (b) { return !b.completed; });
        var past     = list.filter(function (b) { return b.completed; });

        if (upcoming.length) {
            bodyEl.appendChild(el('h2', 'portal__h', 'Upcoming'));
            upcoming.forEach(function (b) { bodyEl.appendChild(jobRow(b)); });
        }
        if (past.length) {
            bodyEl.appendChild(el('h2', 'portal__h', 'Completed'));
            past.forEach(function (b) { bodyEl.appendChild(jobRow(b)); });
        }
    }

    function jobRow(b) {
        var det = document.createElement('details');
        det.className = 'pb' + (b.completed ? ' pb--done' : '');
        det.setAttribute('data-live-key', b.bookingId);

        var sum = document.createElement('summary');
        sum.className = 'pb__sum';
        sum.appendChild(el('span', 'pb__title', b.serviceLabel));
        sum.appendChild(el('span', 'pb__when', whenLine(b) || 'Date to be confirmed'));
        /* Their payout, not the customer's price.
           "Payout at dispatch" read as though dispatch were when the money
           arrived. It is when the AMOUNT is agreed; payment follows completion
           and the photo check. The detail below says so — this line only has
           room to say which number it is. */
        var pay = money(b.payout);
        sum.appendChild(el('span', 'pb__price', pay || 'Amount at dispatch'));
        det.appendChild(sum);

        var inner = el('div', 'pb__body');
        /* Said once per job rather than once per page: a partner scanning a
           list of six jobs should not have to remember which one the payment
           terms applied to. Nothing mechanical stands behind it — completion
           and photos are verified by hand and payment is made by hand. */
        add(inner, fact('Payment', 'Agreed at dispatch. Paid after the job is ' +
                                   'completed and the photo check passes.'));
        add(inner, fact('Where', [b.address, b.zip].filter(Boolean).join('\n')));
        add(inner, fact('Home', b.home));
        add(inner, fact('Condition', b.condition));
        add(inner, fact('Status', b.status));

        /* The job ticket is where the scope, the instructions and the access
           notes live. One place for those, not two that can disagree. */
        if (b.ticketUrl && !b.completed) {
            var a = el('a', 'tk-tap', 'Open the job ticket');
            a.href = b.ticketUrl;
            a.rel = 'noopener';
            inner.appendChild(a);
        }
        det.appendChild(inner);
        return det;
    }

    /* ========================================================
       COMPANY
       ========================================================
       What Serve shows customers about this business. Split deliberately:
       what they control, and what Serve does. */
    function renderCompany() {
        var c = model.company || {};

        bodyEl.appendChild(el('h2', 'portal__h', 'How customers see you'));

        if (c.logoUrl) {
            var logo = document.createElement('img');
            logo.className = 'vp__logo';
            logo.src = c.logoUrl;
            logo.alt = c.displayName || 'Company logo';
            bodyEl.appendChild(logo);
        }
        bodyEl.appendChild(el('p', 'tk-note',
            c.logoUrl
                ? 'To change your logo, email it to us and we will update it the same day.'
                : 'No logo yet — email one to us and we will add it.'));

        bodyEl.appendChild(editor({
            label: 'Display name', value: c.displayName, rows: 1,
            placeholder: 'The name customers see',
            payload: function (v) { return { kind: 'profile', field: 'display_name', value: v }; },
        }));
        bodyEl.appendChild(editor({
            label: 'About your company', value: c.publicDescription, rows: 4,
            placeholder: 'A sentence or two customers will read on their booking.',
            payload: function (v) { return { kind: 'profile', field: 'public_description', value: v }; },
        }));
        bodyEl.appendChild(editor({
            label: 'Areas you cover', value: c.serviceArea, rows: 2,
            placeholder: 'e.g. Back Bay, South End, Cambridge',
            payload: function (v) { return { kind: 'profile', field: 'service_area', value: v }; },
        }));
        bodyEl.appendChild(editor({
            label: 'What you specialise in', value: c.capabilities, rows: 2,
            placeholder: 'e.g. luxury homes, pet-safe products, post-construction',
            payload: function (v) { return { kind: 'profile', field: 'capabilities', value: v }; },
        }));

        /* SERVICES — Serve's three codes, not free text. A vendor cannot offer
           something the calculator has no price for. */
        bodyEl.appendChild(el('h2', 'portal__h', 'Services you offer'));
        (model.services || []).forEach(function (s) { bodyEl.appendChild(serviceRow(s)); });

        /* TEAM */
        bodyEl.appendChild(el('h2', 'portal__h', 'Your team'));
        bodyEl.appendChild(el('p', 'tk-sec__sub', model.teamNote || ''));
        (model.team || []).forEach(function (o) { bodyEl.appendChild(teamRow(o)); });
        if (!(model.team || []).length) {
            bodyEl.appendChild(el('p', 'tk-val',
                'No team members yet. Email us who is on your crew and we will add them.'));
        }

        /* SERVE-CONTROLLED. Shown as facts so it is obvious they are not
           inputs — a greyed-out box invites someone to try. */
        bodyEl.appendChild(el('h2', 'portal__h', 'Managed by Serve'));
        bodyEl.appendChild(el('p', 'tk-sec__sub',
            'These are ours to set. Email us if any of them looks wrong.'));
        add(bodyEl, fact('Legal name', c.legalName));
        add(bodyEl, fact('Status', c.status));
        add(bodyEl, fact('Partner since', c.partnerSince));
        add(bodyEl, fact('Insurance verified', c.insuranceVerified ? 'Yes' : 'Not yet'));
        add(bodyEl, fact('Rating', c.publicRating
            ? c.publicRating + (c.publicReviewCount ? ' · ' + c.publicReviewCount + ' reviews' : '')
            : 'Not enough completed jobs yet'));
        add(bodyEl, fact('Shown to customers', c.clientVisible ? 'Yes' : 'Not yet'));
    }

    function serviceRow(s) {
        var wrap = el('div', 'vp__svc');
        var head = el('label', 'vp__svc-head');
        var box = document.createElement('input');
        box.type = 'checkbox';
        box.checked = !!s.offers;
        head.appendChild(box);
        head.appendChild(el('span', 'vp__svc-name', s.serviceLabel));
        wrap.appendChild(head);

        var status = el('span', 'tk-save');
        var sel = document.createElement('select');
        sel.className = 'vp__pref';
        [['preferred', 'Preferred'], ['neutral', 'Happy to take'], ['avoid', 'Rather not']]
            .forEach(function (p) {
                var o = document.createElement('option');
                o.value = p[0];
                o.textContent = p[1];
                o.selected = s.preference === p[0];
                sel.appendChild(o);
            });
        wrap.appendChild(sel);
        wrap.appendChild(status);

        var send = function () {
            save({ kind: 'service', service_code: s.serviceCode,
                   offers: box.checked, preference: sel.value }, status, null);
        };
        box.addEventListener('change', send);
        sel.addEventListener('change', send);
        return wrap;
    }

    function teamRow(o) {
        var det = document.createElement('details');
        det.className = 'pb';
        var sum = document.createElement('summary');
        sum.className = 'pb__sum';
        sum.appendChild(el('span', 'pb__title', o.publicName || o.firstName || 'Team member'));
        sum.appendChild(el('span', 'pb__when', o.role || ''));
        sum.appendChild(el('span', 'pb__price', o.active ? 'Active' : 'Inactive'));
        det.appendChild(sum);

        var inner = el('div', 'pb__body');
        [['public_display_name', 'Display name', o.publicName],
         ['role', 'Role', o.role],
         ['years_experience', 'Years of experience', o.yearsExperience],
         ['specialties', 'Specialties', o.specialties]].forEach(function (f) {
            inner.appendChild(editor({
                label: f[1], value: f[2], rows: 1,
                payload: function (v) {
                    var p = { kind: 'operator', operator_id: o.operatorId };
                    p[f[0]] = v;
                    return p;
                },
            }));
        });

        /* Serve's numbers about this person. Read-only. */
        add(inner, fact('Serve rating', o.serveRating || 'Not enough jobs yet'));
        add(inner, fact('Jobs completed with Serve', o.serveJobs === null ? '0' : o.serveJobs));
        det.appendChild(inner);
        return det;
    }
})();
