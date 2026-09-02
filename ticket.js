/* ============================================================
   SERVE — JOB TICKET
   Vanilla JS, no dependencies, same as the rest of the site.

   Reads the id and token from the URL, asks /api/job for that row, renders it.
   The server has already decided which fields this view may have, so there is
   no filtering here — only rendering whatever arrived.

   EVERY VALUE IS INSERTED AS TEXT, never as HTML. The fields come from a
   spreadsheet that a person types into by hand, so an apostrophe in a street
   name or an angle bracket in a note has to be inert. There is no innerHTML in
   this file and there should not be one.
   ============================================================ */
(function () {
    'use strict';

    var API = '/api/job';

    var stateEl = document.getElementById('t-state');
    var bodyEl  = document.getElementById('t-body');
    var roleEl  = document.getElementById('t-role');
    var footEl  = document.getElementById('t-foot');

    var params = new URLSearchParams(location.search);
    var id     = params.get('id')  || '';
    var token  = params.get('t')   || '';
    var view   = params.get('view') === 'partner' ? 'partner' : 'client';

    if (!id || !token) { fail('This link is incomplete.'); return; }

    roleEl.textContent = view === 'partner' ? 'Job ticket' : 'Your clean';

    fetch(API + '?id=' + encodeURIComponent(id) +
                '&t=' + encodeURIComponent(token) +
                '&view=' + view)
        .then(function (r) { return r.json(); })
        .then(function (d) {
            if (!d || d.ok !== true) {
                /* Deliberately the same message for a bad token and a missing
                   job. Telling them apart would let someone confirm a job
                   exists by guessing its id. */
                if (d && d.error === 'expired') {
                    fail('This job is finished, so this link has closed. ' +
                         'Anything you need is with Uriel.');
                } else {
                    fail('We could not find that ticket. The link may be ' +
                         'mistyped, or it may have been replaced.');
                }
                return;
            }
            render(d);
        })
        .catch(function (err) {
            console.warn('ticket load failed', err);
            fail('We could not load this ticket just now. Please try again, ' +
                 'or call us on the number below.');
        });

    function fail(msg) {
        stateEl.textContent = msg;
        footEl.hidden = false;
    }

    /* --- tiny DOM helpers: text only, by construction --- */
    function el(tag, cls, text) {
        var n = document.createElement(tag);
        if (cls)  n.className = cls;
        if (text !== undefined && text !== null && text !== '') n.textContent = String(text);
        return n;
    }
    function block(label, value) {
        if (value === undefined || value === null || String(value).trim() === '') return null;
        var b = el('div', 'tk-blk');
        b.appendChild(el('div', 'tk-lbl', label));
        b.appendChild(el('div', 'tk-val', value));
        return b;
    }
    function add(parent, node) { if (node) parent.appendChild(node); }

    function money(v) {
        var n = Number(v);
        return isFinite(n) && n > 0 ? '$' + n.toFixed(2) : '';
    }

    /* "2026-09-10" -> "Thursday, Sep 10". Split rather than parsed: a booked
       date has no timezone, and new Date('2026-09-10') is UTC midnight, which
       renders as the day before in Boston. */
    function prettyDate(iso) {
        var p = String(iso || '').split('-');
        if (p.length !== 3) return '';
        var d = new Date(+p[0], +p[1] - 1, +p[2]);
        if (!isFinite(d.getTime())) return '';
        var days = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
        var mons = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
        return days[d.getDay()] + ', ' + mons[d.getMonth()] + ' ' + d.getDate();
    }

    function render(d) {
        stateEl.hidden = true;
        bodyEl.hidden  = false;
        footEl.hidden  = false;

        var when = prettyDate(d.date);

        var head = el('div', 'tk-when');
        if (when) head.appendChild(el('div', 'tk-day', when));
        if (d.time) head.appendChild(el('div', 'tk-time', d.time));
        if (!when && d.when) head.appendChild(el('div', 'tk-time', d.when));
        var sub = [d.service, d.condition, d.home].filter(Boolean).join(' · ');
        if (sub) head.appendChild(el('div', 'tk-sub', sub));
        bodyEl.appendChild(head);

        if (d.view === 'partner') renderPartner(d); else renderClient(d);
    }

    function renderClient(d) {
        if (d.cleaner) {
            add(bodyEl, block('Who’s coming', d.cleaner));
        }

        var price = money(d.price);
        if (price) {
            var p = el('div', 'tk-blk');
            p.appendChild(el('div', 'tk-lbl', 'Your price'));
            p.appendChild(el('div', 'tk-money', price));
            p.appendChild(el('div', 'tk-note',
                d.paid ? 'Paid — thank you.'
                       : 'All in. This is the price, and it does not change on the day.'));
            bodyEl.appendChild(p);
        }

        add(bodyEl, block('Add-ons', d.add_ons));
        add(bodyEl, block('What you told us', d.notes));

        var g = el('div', 'tk-blk');
        g.appendChild(el('div', 'tk-lbl', 'If anything isn’t right'));
        g.appendChild(el('div', 'tk-val',
            'Tell us within 7 days. You choose — we re-clean it or we refund it.'));
        g.appendChild(el('div', 'tk-note',
            'No photos needed from you; we take our own. And never the same ' +
            'cleaner sent back unless you ask for them.'));
        bodyEl.appendChild(g);
    }

    function renderPartner(d) {
        var where = [d.address, d.unit].filter(Boolean).join(', ');
        if (where) {
            var w = el('div', 'tk-blk');
            w.appendChild(el('div', 'tk-lbl', 'Where'));
            w.appendChild(el('div', 'tk-val', where + (d.zip ? '\n' + d.zip : '')));
            var a = el('a', 'tk-tap', 'Open in Maps');
            a.href = 'https://maps.google.com/?q=' +
                     encodeURIComponent(where + ' ' + (d.zip || ''));
            a.rel = 'noopener';
            a.target = '_blank';
            w.appendChild(a);
            bodyEl.appendChild(w);
        }

        add(bodyEl, block('Getting in', d.access_method));
        add(bodyEl, block('Access notes', d.access_notes));
        add(bodyEl, block('Parking', d.parking_notes));

        if (d.pets || d.memory_pets) {
            var pets = el('div', 'tk-blk tk-blk--flag');
            pets.appendChild(el('div', 'tk-lbl', 'Pets'));
            pets.appendChild(el('div', 'tk-val', d.memory_pets || 'Yes — plan around them'));
            bodyEl.appendChild(pets);
        }

        add(bodyEl, block('Focus on', d.priority_rooms));
        add(bodyEl, block('Skip', d.skip_areas));
        add(bodyEl, block('Products', d.product_notes));
        add(bodyEl, block('Timing', d.timing_notes));
        add(bodyEl, block('What the customer said', d.customer_notes));

        var note = el('div', 'tk-blk');
        note.appendChild(el('div', 'tk-note',
            'Entry codes are never on this page. If you need one, message Uriel.'));
        bodyEl.appendChild(note);
    }
})();
