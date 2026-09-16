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
    var payResult = params.get('pay') || '';

    /* COMING BACK FROM STRIPE.
       The checkout return URL carries no token on purpose: a ticket link is a
       credential, and it has no business sitting in a payment processor's
       dashboard just to return somebody to the page they were already on. So
       this page keeps its own before leaving and picks it up here. Same tab,
       same origin, gone when the tab closes. Storage being unavailable costs
       the return trip, never the link. */
    var KEEP = 'serve.ticket';
    if (!id || !token) {
        try {
            var kept = JSON.parse(sessionStorage.getItem(KEEP) || 'null');
            if (kept) {
                id = id || kept.id || '';
                token = token || kept.t || '';
                if (kept.view) view = kept.view;
            }
        } catch (_) { /* private mode — fall through to fail() */ }
    }

    if (!id || !token) { fail('This link is incomplete.'); return; }

    roleEl.textContent = view === 'partner' ? 'Job ticket' : 'Your clean';

    /* r44. THE FIRST ANSWER MAY ALREADY BE ON ITS WAY. j.html starts this
       request from its <head>, before the stylesheet and the scripts have
       downloaded. Adopted only for exactly the address this file would have
       asked for; anything else — no early start, a different address — asks
       here, exactly as before. Taken once, so a later load asks fresh. */
    function firstLoad(url) {
        var early = window.ServeFirstLoad;
        window.ServeFirstLoad = null;
        if (early && early.url === url && early.answer) return early.answer;
        return fetch(url).then(function (r) { return r.json(); });
    }

    var LOAD = API + '?id=' + encodeURIComponent(id) +
                     '&t=' + encodeURIComponent(token) +
                     '&view=' + view;

    /* ONE RETRY, AND ONLY THE TRUTH ABOUT WHAT FAILED.  r50
       The reasoning is written out once, in portal.js. It matters most on a
       cleaner's ticket: they are standing outside a house, on a phone, and
       "we could not find that ticket" sends them to call rather than to
       tap again. */
    var RETRY_MS = 800;

    /* A KNOWN VIEW, not merely ok. An older deployment with no ticket route
       falls through to the HEALTH CHECK, which answers ok:true — and this
       page would render that as an empty ticket rather than saying anything
       was wrong. That is the 2026-09-08 ordering bug; portal.js has guarded
       it since, and this is the same guard on the ticket. */
    function answered(d) {
        if (!d) return false;
        if (d.ok === true) return d.view === 'client' || d.view === 'partner';
        return d.error === 'not_found' || d.error === 'expired';
    }

    function load(url, retried) {
        var attempt = retried
            ? fetch(url).then(function (r) { return r.json(); })
            : firstLoad(url);
        return attempt
            .catch(function (err) { console.warn('ticket load failed', err); return null; })
            .then(function (d) {
                if (answered(d) || retried) return d;
                return new Promise(function (go) { setTimeout(go, RETRY_MS); })
                    .then(function () { return load(url, true); });
            });
    }

    load(LOAD).then(function (d) {
        if (!answered(d)) {
            fail(d
                ? 'We could not load this ticket just now. Please try again, ' +
                  'or call us on the number below.'
                : 'We could not reach Serve just now. Please check your ' +
                  'connection and try again, or call us on the number below.',
                true);
            return;
        }
        if (d.ok !== true) {
            /* Deliberately the same message for a bad token and a missing
               job. Telling them apart would let someone confirm a job
               exists by guessing its id. */
            if (d.error === 'expired') {
                fail('This job is finished, so this link has closed. ' +
                     'Anything you need is with Uriel.');
            } else {
                fail('We could not find that ticket. The link may be ' +
                     'mistyped, or it may have been replaced.');
            }
            return;
        }
        render(d);
        if (typeof ServeLive !== 'undefined') ServeLive.watch({
            url: LOAD,
            view: view, root: bodyEl, initial: d, onData: render
        });
    });

    function fail(msg, retry) {
        stateEl.textContent = msg;
        if (retry) add(stateEl, retryButton());
        footEl.hidden = false;
    }

    /* A plain reload: the link in the address bar is the credential. */
    function retryButton() {
        var b = el('button', 'btn btn--ghost tk-retry', 'Try again');
        b.type = 'button';
        b.addEventListener('click', function () { location.reload(); });
        return b;
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
       without it and nobody finds out until the day.

       `payload` is the rest of the body: an instruction from the customer's
       view, or a cleaner's room note (partner_note) from the partner view.
       Apps Script checks which token may send which. ======================= */
    function saveInstruction(payload, statusEl, btn) {
        statusEl.textContent = 'Saving…';
        statusEl.className = 'tk-save';
        if (btn) btn.disabled = true;

        return fetch(API, {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain;charset=utf-8' },
            body: JSON.stringify(Object.assign({ job_id: id, t: token }, payload)),
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
            var text = ta.value.trim();
            var payload = opts.payload ? opts.payload(text) : {
                event_type: 'booking_instruction', scope_type: opts.scopeType,
                scope_key: opts.scopeKey, instruction: text };
            saveInstruction(payload, status, btn).then(function (ok) {
                if (ok && ta.value.trim() !== text) {
                    status.textContent = 'Not saved yet'; status.className = 'tk-save is-dirty';
                }
            });
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
        if (typeof ServePhotos !== 'undefined') ServePhotos.release(bodyEl);
        bodyEl.textContent = '';
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
    /**
     * ONE DATE, AND ONE LINE UNDER IT.
     *
     * This used to print the day, then the time, then the schedule summary,
     * deduping only when one string contained another. Those never overlap, so
     * a slot booking showed its date twice — "Fri, Sep 18" above "Friday,
     * Sep 18 at 3:30 PM" — and while the timezone bug was live it showed two
     * DIFFERENT dates, one of them wrong.
     *
     * The summary is prose the script wrote for bookings that have no date:
     * "Earlier in the day (typically 8:00 AM - 12:00 PM)". So it is the
     * fallback, never a second opinion beside a real date.
     */
    function scheduleHead(b, subParts) {
        var head = el('div', 'tk-when');
        var day = prettyDate(b.date);
        if (day) head.appendChild(el('div', 'tk-day', day));
        var line = String(b.time || b.when || '').trim();
        if (line) head.appendChild(el('div', 'tk-time', line));

        var sub = (subParts || []).filter(Boolean).join(' · ');
        if (sub) head.appendChild(el('div', 'tk-sub', sub));
        return head;
    }

    /* ========================================================
       CLIENT — five sections
       ======================================================== */
    /* ========================================================
       PAYMENT
       ========================================================
       Sends the JOB and this page's own credential — never an amount. The
       server reads what to charge out of the booking row, which is the whole
       reason a quote is signed; a price that travelled through here could be
       edited before it arrived.

       AUTHORIZE, NOT CHARGE. Stripe places a hold and the money is collected
       only once the partner has accepted the job.

       CLIENT VIEW ONLY. renderPartner never calls this, and the server refuses
       a partner token besides — a cleaner must not be able to raise a charge
       on a customer. */

    var PAY_ERRORS = {
        not_configured:    'Card payment is not available yet. We will send an invoice instead.',
        already_paid:      'This booking is already paid.',
        already_completed: 'This booking is finished — there is nothing left to pay here.',
        no_price_on_file:  'We need to confirm the price on this booking first. We will be in touch.',
        price_out_of_range:'We need to check the price on this booking first. We will be in touch.',
        not_found:         'We could not find that booking.',
    };

    function payBlock(b) {
        var wrap = el('div', 'pay__wrap');
        var btn  = el('button', 'pay__btn', 'Authorize payment');
        btn.type = 'button';
        var err  = el('p', 'pay__err', '');

        btn.addEventListener('click', function () {
            btn.disabled = true;
            btn.textContent = 'Opening secure checkout…';
            err.textContent = '';

            /* Stash before leaving — see the note where id and token are read. */
            try {
                sessionStorage.setItem(KEEP, JSON.stringify({ id: id, t: token, view: view }));
            } catch (_) { /* the return trip degrades; the payment still works */ }

            fetch('/api/checkout', {
                method:  'POST',
                headers: { 'Content-Type': 'application/json' },
                body:    JSON.stringify({ job_id: id, t: token }),
            })
                .then(function (r) { return r.json(); })
                .then(function (d) {
                    if (d && d.ok && d.url) { location.href = d.url; return; }
                    throw new Error((d && d.error) || 'unavailable');
                })
                .catch(function (e) {
                    var code = String((e && e.message) || 'unavailable');
                    console.warn('checkout failed', code);
                    btn.disabled = false;
                    btn.textContent = 'Authorize payment';
                    err.textContent = PAY_ERRORS[code] ||
                        'We could not open checkout just now. Please try again, ' +
                        'or call us on the number below.';
                });
        });

        wrap.appendChild(btn);
        wrap.appendChild(el('p', 'tk-note',
            'We place a hold on your card for ' + money(b.price) +
            ' now, and only charge it once your cleaner has confirmed the job.'));
        wrap.appendChild(err);
        return wrap;
    }

    /* Stripe returns everyone to the same two addresses, so say what happened.
       `cancelled` is not an error and must not read like one. */
    function payBanner() {
        if (payResult !== 'done' && payResult !== 'cancelled') return null;
        var ok = payResult === 'done';
        return el('p', ok ? 'portal__note portal__note--ok' : 'portal__note',
            ok ? 'Thank you — your card is authorized. We will charge it once ' +
                 'your cleaner confirms.'
               : 'No payment was taken. Your booking is unchanged and you can ' +
                 'authorize whenever you are ready.');
    }

    function renderClient(d) {
        var b = d.booking || {};
        var done = !!b.completed;
        add(bodyEl, payBanner());

        /* 1. BOOKING */
        bodyEl.appendChild(scheduleHead(b, [b.serviceLabel, homeLine(d.home)]));

        var price = money(b.price);
        if (price) {
            var p = el('div', 'tk-blk');
            p.appendChild(el('div', 'tk-lbl', 'Your price'));
            p.appendChild(el('div', 'tk-money', price));
            /* AUTHORIZE, NOT CHARGE. Stripe places a hold now; the money is
               collected only once the partner has accepted the job, because
               Serve should not be holding somebody's money for work nobody has
               agreed to do yet. The old copy said "due at service", which
               stopped being true the moment a card is authorized at booking.

               r50. THE MIDDLE STATE EXISTS NOW. Until payment state was
               written back, an authorized customer saw the unpaid copy and the
               button, and could place a second hold on their own card. */
            p.appendChild(el('div', 'tk-note',
                b.paid       ? 'Paid — thank you.'
                : b.authorized
                    ? 'Your card is authorized for ' + price + '. Nothing has ' +
                      'been charged yet — we take payment once your cleaner ' +
                      'confirms the job.'
                    : 'All in, and it does not change on the day.'));
            if (!b.paid && !b.authorized && !done) p.appendChild(payBlock(b));
            bodyEl.appendChild(p);
        }
        add(bodyEl, block('Add-ons', b.addOns));
        /* One definition, in serve-scope.js beside the data it renders. */
        if (typeof ServeScope !== 'undefined') {
            add(bodyEl, ServeScope.block(b.serviceCode, b.serviceLabel));
        }

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
                det.setAttribute('data-live-key', r.key);
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
                if (typeof ServePhotos !== 'undefined' && (d.photoSupport || (d.photos || []).length)) {
                    det.appendChild(ServePhotos.mount({ jobId: id, roomKey: r.key, roomLabel: r.label,
                        photos: d.photos, editable: !done && d.photoSupport,
                        auth: { auth_kind: 'client', t: token } }));
                }
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
        psec.appendChild(ServePartner.block(d.partner));
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
           zero looks like a job that pays nothing.

           TWO DIFFERENT MOMENTS, AND THE COPY HAS TO KEEP THEM APART. The
           AMOUNT is agreed at dispatch — a partner cannot be asked to accept a
           job without knowing what it pays. The MONEY arrives after the work is
           done and checked. The old wording said only "at dispatch", which read
           as though that were also when they were paid.

           NOTHING HERE IS MECHANICAL. No code watches completed_date or
           photos_passed to release anything; the founder verifies both by hand
           and pays by hand. This is a description of how Serve operates, not a
           trigger, and it must not quietly become one. */
        var pay = el('div', 'tk-blk');
        pay.appendChild(el('div', 'tk-lbl', 'Your payout'));
        var payAmount = money(b.payout);
        if (payAmount) {
            pay.appendChild(el('div', 'tk-money', payAmount));
        } else {
            pay.appendChild(el('div', 'tk-val', 'Amount confirmed at dispatch'));
        }
        pay.appendChild(el('div', 'tk-note',
            'Agreed at dispatch. Paid after the job is completed and the ' +
            'photo check passes.'));
        bodyEl.appendChild(pay);

        /* WHO. First name only — see buildVendorTicketModel for why that is the
           whole of it. Sits directly above the address because the two answer
           the same question: which door, and who opens it. Absent on an older
           deployment, and absent is silence rather than a blank row. */
        if (d.customerFirstName) {
            var who = el('div', 'tk-blk');
            who.appendChild(el('div', 'tk-lbl', 'Customer'));
            who.appendChild(el('div', 'tk-val', d.customerFirstName));
            bodyEl.appendChild(who);
        }

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

        /* Scope: every room, closed until tapped, the way the customer's rooms
           are. Inside: what the customer asked for, then the cleaner's photos
           and an optional note. */
        var scope = d.scope || [];
        if (scope.length) {
            var ssec = section('Scope');
            scope.forEach(function (r) { ssec.appendChild(scopeRoom(d, r)); });
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
        (acc.fromPortal || []).forEach(function (f) {
            add(asec, block(f.label + ' (customer portal)', f.value));
        });
        add(asec, block('Focus on', st.priorityRooms));
        add(asec, block('Skip', st.skipAreas));
        add(asec, block('Products', st.productNotes));
        add(asec, block('Timing', st.timingNotes));
        asec.appendChild(el('div', 'tk-note',
            'Entry codes are never on this page. If you need one, message Uriel.'));
        bodyEl.appendChild(asec);
    }

    function scopeRoom(d, r) {
        var det = document.createElement('details');
        det.className = 'tk-room';
        det.setAttribute('data-live-key', r.key);
        var sum = document.createElement('summary');
        sum.className = 'tk-room__sum';
        sum.appendChild(el('span', 'tk-room__name', r.label));
        var flag = el('span', 'tk-room__flag');
        sum.appendChild(flag);
        det.appendChild(sum);

        /* A called-off visit keeps what was said, and offers nothing to add. */
        var open = !(d.booking && d.booking.cancelled);
        var mine = (d.completionPhotos || []).filter(function (p) { return p.roomKey === r.key; });
        var theirs = (d.photos || []).some(function (p) { return p.roomKey === r.key; });
        function showFlag(count) {
            flag.textContent = [r.instruction || theirs ? 'Has instructions' : '',
                count ? count + (count === 1 ? ' photo' : ' photos') : ''].filter(Boolean).join(' · ') || 'Add photos';
        }
        showFlag(mine.length);

        if (r.instruction || theirs) {
            var from = el('div', 'tk-room__from');
            from.appendChild(el('div', 'tk-lbl', 'From the customer'));
            if (r.instruction) from.appendChild(el('div', 'tk-val', r.instruction));
            if (theirs && typeof ServePhotos !== 'undefined') {
                from.appendChild(ServePhotos.mount({ jobId: id, roomKey: r.key, roomLabel: r.label,
                    photos: d.photos, editable: false, auth: { auth_kind: 'partner', t: token } }));
            }
            det.appendChild(from);
        }
        if (d.completionPhotoSupport && typeof ServePhotos !== 'undefined') {
            det.appendChild(ServePhotos.mount({ jobId: id, roomKey: r.key, roomLabel: r.label,
                purpose: 'completion', photos: mine, editable: open,
                auth: { auth_kind: 'partner', t: token },
                onChange: function (photos) { showFlag(photos.length); } }));
        }
        det.appendChild(editor({
            label: 'Notes (optional)', scopeType: 'NOTE', scopeKey: r.key,
            value: r.note, rows: 2, readOnly: !open,
            placeholder: 'Anything the customer, your company or Serve should know.',
            payload: function (text) {
                return { event_type: 'partner_note', room_key: r.key, note: text };
            },
        }));
        return det;
    }
})();
