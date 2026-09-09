/* ============================================================
   SERVE — JOB TICKET
   Vanilla JS, no dependencies, same as the rest of the site.

   Reads the id and token from the URL, asks /api/job for that row, renders it.
   The server has already decided which fields this view may have, so there is
   no filtering here — only rendering whatever arrived. A field this page never
   receives is a field it cannot leak.

   EVERY VALUE IS INSERTED AS TEXT, never as HTML. The fields come from a
   spreadsheet a person types into and from a customer's own free text, so an
   apostrophe in a street name or an angle bracket in a note has to be inert.
   There is no innerHTML in this file and there should not be one.

   THE TOKEN GOES IN THE BODY ON WRITES, never the query string — a query
   string lands in proxy logs, browser history and referrer headers, and this
   token is the only thing between a URL and someone's home.
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

    function section(title) {
        var s = el('section', 'tk-sec');
        s.appendChild(el('h2', 'tk-sec__h', title));
        return s;
    }

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

    /* ========================================================
       SAVING AN INSTRUCTION
       ========================================================
       One endpoint, one shape, for rooms, general notes and access answers
       alike. The server validates the scope against the rooms this booking
       actually has, so a key this page invents is refused rather than stored
       somewhere nothing will read it.

       Optimistic UI is deliberately NOT used. A note the customer believes was
       saved and was not is worse than a half-second wait — the cleaner arrives
       without it and nobody finds out until the day. ======================= */
    function saveInstruction(scopeType, scopeKey, text, statusEl, btn) {
        statusEl.textContent = 'Saving…';
        statusEl.className = 'tk-save';
        if (btn) btn.disabled = true;

        return fetch(API, {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain;charset=utf-8' },
            body: JSON.stringify({
                event_type:  'booking_instruction',
                job_id:      id,
                t:           token,
                scope_type:  scopeType,
                scope_key:   scopeKey,
                instruction: text,
            }),
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
                ? 'This job is finished, so it can no longer be edited.'
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

    /**
     * A labelled box the customer can type into and save.
     * `readOnly` renders the same content without the controls — used once the
     * job is complete, when the ticket becomes a record rather than a form.
     */
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
        ta.id = 'ins-' + opts.scopeType + '-' + opts.scopeKey;
        if (opts.label) wrap.firstChild.setAttribute('for', ta.id);
        wrap.appendChild(ta);

        var row = el('div', 'tk-edit__row');
        var btn = el('button', 'tk-edit__save', 'Save');
        btn.type = 'button';
        var status = el('span', 'tk-save');
        row.appendChild(btn);
        row.appendChild(status);
        wrap.appendChild(row);

        btn.addEventListener('click', function () {
            saveInstruction(opts.scopeType, opts.scopeKey, ta.value.trim(), status, btn);
        });
        /* A note typed and then abandoned is the common failure. Say so rather
           than silently keeping the old value. */
        ta.addEventListener('input', function () {
            status.textContent = 'Not saved yet';
            status.className = 'tk-save is-dirty';
        });

        return wrap;
    }

    function render(d) {
        stateEl.hidden = true;
        bodyEl.hidden  = false;
        footEl.hidden  = false;
        if (d.view === 'partner') renderPartner(d); else renderClient(d);
    }

    /**
     * The date/time header, de-duplicated. ONE function for both views, so the
     * two cannot drift into disagreeing about how a booking is described.
     *
     * A booking with a confirmed slot has a date and a window. A booking made
     * on a time PREFERENCE has no date at all, and `start_time` and the
     * schedule summary then hold the SAME SENTENCE — both come out as
     * "Later in the day (typically 12:00 PM - 5:00 PM)". Rendering each in turn
     * printed it twice, at the top of both tickets.
     *
     * Comparison is on letters and digits only, and by containment rather than
     * equality: "9-11 AM" against "Wed 10 Sep, 9-11 AM" is the same fact told
     * twice, and only the shorter one belongs under a date that already says
     * the day. Two lines that genuinely differ are both kept.
     */
    function scheduleHead(b, subParts) {
        var head = el('div', 'tk-when');
        var day = prettyDate(b.date);
        if (day) head.appendChild(el('div', 'tk-day', day));

        var norm = function (s) {
            return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
        };
        var seen = [];
        [b.time, b.when].forEach(function (v) {
            var text = String(v || '').trim();
            var n = norm(text);
            if (!n) return;
            for (var i = 0; i < seen.length; i++) {
                if (seen[i].indexOf(n) !== -1 || n.indexOf(seen[i]) !== -1) return;
            }
            seen.push(n);
            head.appendChild(el('div', 'tk-time', text));
        });

        var sub = (subParts || []).filter(Boolean).join(' · ');
        if (sub) head.appendChild(el('div', 'tk-sub', sub));
        return head;
    }

    /* ========================================================
       CLIENT — five sections
       ======================================================== */
    function renderClient(d) {
        var b = d.booking || {};
        var done = !!b.completed;

        /* 1. BOOKING */
        bodyEl.appendChild(scheduleHead(b, [b.serviceLabel, homeLine(d.home)]));

        var price = money(b.price);
        if (price) {
            var p = el('div', 'tk-blk');
            p.appendChild(el('div', 'tk-lbl', 'Your price'));
            p.appendChild(el('div', 'tk-money', price));
            /* There is no Stripe integration, so there is no payment link and
               this must not imply one. `paid` is a column an operator sets. */
            p.appendChild(el('div', 'tk-note',
                b.paid ? 'Paid — thank you.'
                       : 'All in. Due at service, and it does not change on the day.'));
            bodyEl.appendChild(p);
        }
        add(bodyEl, block('Add-ons', b.addOns));

        /* 2. YOUR HOME — rooms, each with its own instruction */
        var rooms = (d.home && d.home.rooms) || [];
        if (rooms.length) {
            var sec = section('Your home');
            sec.appendChild(el('p', 'tk-sec__sub', done
                ? 'What you asked for, room by room.'
                : 'Anything we should know about a particular room? Add it here and your cleaner sees it.'));
            rooms.forEach(function (r) {
                var det = document.createElement('details');
                det.className = 'tk-room';
                var sum = document.createElement('summary');
                sum.className = 'tk-room__sum';
                sum.appendChild(el('span', 'tk-room__name', r.label));
                sum.appendChild(el('span', 'tk-room__flag',
                    r.instruction ? 'Has instructions' : (done ? '' : 'Add instructions')));
                det.appendChild(sum);
                det.appendChild(editor({
                    scopeType: 'ROOM', scopeKey: r.key, value: r.instruction,
                    readOnly: done, rows: 2,
                    placeholder: 'e.g. Fresh sheets are in the closet.',
                }));
                sec.appendChild(det);
            });
            bodyEl.appendChild(sec);
        }

        /* 3. INSTRUCTIONS */
        var ins = d.instructions || {};
        var isec = section('Anything else');
        isec.appendChild(editor({
            scopeType: 'BOOKING', scopeKey: 'GENERAL', value: ins.general,
            readOnly: done, rows: 3,
            placeholder: 'Anything that applies to the whole visit.',
        }));
        add(isec, block('What you told us when you booked', ins.atBooking));
        bodyEl.appendChild(isec);

        /* 4. ARRIVAL & ACCESS — kept apart from ordinary instructions, because
           "how do we get in" is not "please do the oven". */
        var acc = (d.access && d.access.fields) || [];
        if (acc.length) {
            var asec = section('Arrival & access');
            asec.appendChild(el('p', 'tk-sec__sub',
                'How we get in and what to expect on the day.'));
            acc.forEach(function (fld) {
                asec.appendChild(editor({
                    label: fld.label, scopeType: 'ACCESS', scopeKey: fld.key,
                    value: fld.value, readOnly: done, rows: 2,
                }));
            });
            asec.appendChild(el('p', 'tk-note',
                'Please don’t put door or alarm codes here — text them to us instead ' +
                'and we’ll pass them on at dispatch.'));
            bodyEl.appendChild(asec);
        }

        /* 5. SERVICE PARTNER */
        var psec = section('Your service partner');
        if (d.partner) {
            var v = d.partner;
            var card = el('div', 'tk-partner');
            card.appendChild(el('div', 'tk-partner__name', v.displayName));
            if (v.publicDescription) card.appendChild(el('p', 'tk-partner__desc', v.publicDescription));
            var facts = [];
            if (v.partnerSince) facts.push('With Serve since ' + v.partnerSince);
            if (v.insuranceVerified) facts.push('Bonded & insured');
            if (v.rating) {
                facts.push(v.rating + '★' + (v.reviewCount ? ' (' + v.reviewCount + ')' : ''));
            }
            if (facts.length) card.appendChild(el('div', 'tk-partner__facts', facts.join(' · ')));
            psec.appendChild(card);
        } else {
            psec.appendChild(el('p', 'tk-val',
                'Your service professional will be confirmed before your appointment.'));
        }
        bodyEl.appendChild(psec);

        /* The guarantee, unchanged. */
        var g = el('div', 'tk-blk');
        g.appendChild(el('div', 'tk-lbl', 'If anything isn’t right'));
        g.appendChild(el('div', 'tk-val',
            'Tell us within 7 days. You choose — we re-clean it or we refund it.'));
        bodyEl.appendChild(g);
    }

    function homeLine(home) {
        if (!home) return '';
        var parts = [];
        if (home.beds === 0) parts.push('Studio');
        else if (home.beds) parts.push(home.beds + ' BR');
        if (home.baths) parts.push(home.baths + ' BA');
        if (home.levels > 1) parts.push(home.levels + ' floors');
        return parts.join(' / ');
    }

    /* ========================================================
       PARTNER — everything needed to do the job, nothing else
       ======================================================== */
    function renderPartner(d) {
        var b = d.booking || {};
        var prop = d.property || {};

        bodyEl.appendChild(scheduleHead(b, [b.serviceLabel, b.condition, homeLine(prop)]));

        /* THE PAYOUT. What this crew is paid, which is not what the customer
           paid — that number is in the client view and reaches no partner.
           Blank reads as "confirmed at dispatch" rather than $0, because a
           zero looks like a job that pays nothing. */
        var pay = el('div', 'tk-blk');
        pay.appendChild(el('div', 'tk-lbl', 'Your payout'));
        var payAmount = money(b.payout);
        if (payAmount) {
            pay.appendChild(el('div', 'tk-money', payAmount));
        } else {
            pay.appendChild(el('div', 'tk-val', 'Confirmed at dispatch'));
        }
        bodyEl.appendChild(pay);

        var where = [prop.address, prop.unit].filter(Boolean).join(', ');
        if (where) {
            var w = el('div', 'tk-blk');
            w.appendChild(el('div', 'tk-lbl', 'Where'));
            w.appendChild(el('div', 'tk-val', where + (prop.zip ? '\n' + prop.zip : '')));
            var a = el('a', 'tk-tap', 'Open in Maps');
            a.href = 'https://maps.google.com/?q=' +
                     encodeURIComponent(where + ' ' + (prop.zip || ''));
            a.rel = 'noopener';
            a.target = '_blank';
            w.appendChild(a);
            bodyEl.appendChild(w);
        }
        add(bodyEl, block('Add-ons', b.addOns));

        /* Scope: every room, and what was asked for in it. */
        var scope = d.scope || [];
        if (scope.length) {
            var ssec = section('Scope');
            scope.forEach(function (r) {
                var line = el('div', 'tk-scope');
                line.appendChild(el('span', 'tk-scope__name', r.label));
                if (r.instruction) line.appendChild(el('span', 'tk-scope__ins', r.instruction));
                ssec.appendChild(line);
            });
            bodyEl.appendChild(ssec);
        }

        var ins = d.instructions || {};
        if (ins.general || ins.atBooking) {
            var isec = section('From the customer');
            add(isec, block('For this visit', ins.general));
            add(isec, block('When they booked', ins.atBooking));
            bodyEl.appendChild(isec);
        }

        /* ACCESS — two sources, kept apart. `standing` is what is true of this
           home every visit; `fromCustomer` is what they said this time. */
        var acc = d.access || {};
        var st = acc.standing || {};
        var asec = section('Getting in');
        add(asec, block('Method', st.method));
        add(asec, block('Access notes', st.notes));
        add(asec, block('Parking', st.parking));
        if (st.pets || acc.petsFlagged) {
            var pets = el('div', 'tk-blk tk-blk--flag');
            pets.appendChild(el('div', 'tk-lbl', 'Pets'));
            pets.appendChild(el('div', 'tk-val', st.pets || 'Yes — plan around them'));
            asec.appendChild(pets);
        }
        (acc.fromCustomer || []).forEach(function (f) {
            add(asec, block(f.label + ' (this visit)', f.value));
        });
        add(asec, block('Focus on', st.priorityRooms));
        add(asec, block('Skip', st.skipAreas));
        add(asec, block('Products', st.productNotes));
        add(asec, block('Timing', st.timingNotes));
        asec.appendChild(el('div', 'tk-note',
            'Entry codes are never on this page. If you need one, message Uriel.'));
        bodyEl.appendChild(asec);
    }
})();
