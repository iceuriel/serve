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
    var payResult = params.get('pay') || '';

    /* COMING BACK FROM STRIPE.
       The checkout return URL deliberately carries no token: a portal link is a
       PERMANENT customer credential, and it has no business sitting in a
       payment processor's dashboard merely to return somebody to the page they
       were already on. So this page keeps its own credential before it leaves
       and picks it up here — same tab, same origin, gone when the tab closes.
       Storage being unavailable costs the return trip, never the link itself. */
    var KEEP = 'serve.portal';
    if (!id || !token) {
        try {
            var kept = JSON.parse(sessionStorage.getItem(KEEP) || 'null');
            if (kept) { id = id || kept.id || ''; token = token || kept.t || ''; }
        } catch (_) { /* private mode, storage disabled — fall through to fail() */ }
    }

    var model = null;
    var tab   = 'bookings';
    var accessFlag = null;
    var pendingAccessSaves = new Map();

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
            if (typeof ServeLive !== 'undefined') ServeLive.watch({
                url: API + '?id=' + encodeURIComponent(id) + '&t=' + encodeURIComponent(token),
                view: 'portal', root: bodyEl, initial: d,
                onData: function (next) { model = next; paint(); }
            });
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
    /* One date, then the time — or the schedule summary when there is no date.
       See scheduleHead in ticket.js: the summary is the fallback for bookings
       with no date, never a second opinion beside a real one. */
    function whenLine(b) {
        return [prettyDate(b.date), String(b.time || b.when || '').trim()]
            .filter(Boolean).join(' · ');
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
            var text = ta.value.trim();
            var pending = opts.save
                ? opts.save(text, status, btn)
                : save(opts.payload(text), status, btn);
            pending.then(function (ok) {
                if (ok && opts.onSaved) opts.onSaved(text);
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
            if (pair[0] === 'access') {
                accessFlag = el('span', 'portal__access-flag');
                accessFlag.setAttribute('role', 'status');
                accessFlag.setAttribute('aria-live', 'polite');
                accessFlag.setAttribute('aria-atomic', 'true');
                b.appendChild(accessFlag);
            }
            b.addEventListener('click', function () { tab = pair[0]; paint(); });
            navEl.appendChild(b);
        });

        paint();
    }

    function paint() {
        if (typeof ServePhotos !== 'undefined') ServePhotos.release(bodyEl);
        updateAccessStatus();
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
        /* Before the empty check: somebody returning from Stripe must be told
           what happened even in the odd case that the list will not render. */
        add(bodyEl, payBanner());
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
        /* r38. After the real bookings, because it is not one of them. */
        add(bodyEl, planCard(d.plan));
        if (past.length) {
            bodyEl.appendChild(el('h2', 'portal__h', 'Past'));
            past.forEach(function (b) { bodyEl.appendChild(bookingRow(b)); });
        }
    }

    /**
     * The recurring plan they were offered, which is NOT a booking.
     *
     * It reads as an offer with a deadline rather than as an appointment: no
     * date, because nobody has chosen one, and the price they were quoted
     * rather than a number recomputed today. Confirming it is the next
     * release; until then this says plainly that it is waiting on them instead
     * of showing a button that does nothing.
     */
    function planCard(plan) {
        if (!plan || !plan.frequency) return null;
        var wrap = el('div', 'plan');
        wrap.appendChild(el('div', 'plan__tag', 'Not booked yet'));
        wrap.appendChild(el('div', 'plan__title', 'Your ' + plan.frequency + ' plan'));

        var price = money(plan.price);
        if (price) wrap.appendChild(el('div', 'plan__price', price + ' per visit'));

        wrap.appendChild(el('p', 'plan__body',
            'You asked for ' + plan.frequency + ' cleans after your first visit. ' +
            'Nothing is scheduled and nothing is charged until you confirm a time.'));
        if (plan.expiresAt) {
            wrap.appendChild(el('div', 'plan__when',
                'This price is held until ' + (prettyDate(plan.expiresAt) || plan.expiresAt) + '.'));
        }
        return wrap;
    }

    /** The title line is service + date, as asked; the detail opens on click. */
    function bookingRow(b) {
        var det = document.createElement('details');
        det.className = 'pb' + (b.completed ? ' pb--done' : '');
        det.setAttribute('data-live-key', b.bookingId);

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
        /* One definition, in serve-scope.js beside the data it renders. */
        if (typeof ServeScope !== 'undefined') {
            add(inner, ServeScope.block(b.serviceCode, b.serviceLabel));
        }
        if (b.completed) {
            if (typeof ServePhotos !== 'undefined') {
                var pastRooms = [];
                (b.photos || []).forEach(function (p) { if (pastRooms.indexOf(p.roomKey) < 0) pastRooms.push(p.roomKey); });
                pastRooms.forEach(function (key) {
                    inner.appendChild(el('h3', 'pb__h', key.replace(/_/g, ' ').toLowerCase()));
                    inner.appendChild(ServePhotos.mount({ jobId: b.bookingId, roomKey: key, roomLabel: key.replace(/_/g, ' '),
                        photos: b.photos, editable: false, auth: { auth_kind: 'portal', contact_id: id, t: token } }));
                });
            }
            add(inner, line('Completed', prettyDate(b.completed) || b.completed));
            add(inner, line('Payment', b.paid ? 'Paid' : 'Due'));
            inner.appendChild(el('p', 'tk-note',
                'Finished bookings are a record — they can no longer be edited.'));
            det.appendChild(inner);
            return det;
        }

        add(inner, line('Payment', b.paid ? 'Paid' : 'Not yet authorized'));
        if (!b.paid && Number(b.price) > 0) inner.appendChild(payBlock(b));

        /* Who is coming. The portal is the link the confirmation email
           actually sends, so this is the surface that has to answer it —
           and when nobody is assigned yet it says so, rather than leaving
           the question unanswered. */
        inner.appendChild(el('h3', 'pb__h', 'Your service partner'));
        inner.appendChild(ServePartner.block(b.partner));

        /* Rooms, each with a note the customer can add. */
        (b.rooms || []).forEach(function (r) {
            var rd = document.createElement('details');
            rd.className = 'tk-room';
            rd.setAttribute('data-live-key', b.bookingId + '/' + r.key);
            var rs = document.createElement('summary');
            rs.className = 'tk-room__sum';
            rs.appendChild(el('span', 'tk-room__name', r.label));
            rs.appendChild(el('span', 'tk-room__flag',
                r.instruction ? 'Has instructions' : 'Add instructions'));
            rd.appendChild(rs);
            rd.appendChild(editor({
                value: r.instruction, rows: 2,
                placeholder: 'e.g. Fresh sheets are in the closet.',
                onSaved: function (text) { r.instruction = text;
                    rs.querySelector('.tk-room__flag').textContent = text ? 'Has instructions' : 'Add instructions'; },
                payload: function (text) {
                    return { kind: 'instruction', job_id: b.bookingId,
                             scope_type: 'ROOM', scope_key: r.key, instruction: text };
                },
            }));
            if (model.photoSupport && typeof ServePhotos !== 'undefined') rd.appendChild(ServePhotos.mount({
                jobId: b.bookingId, roomKey: r.key, roomLabel: r.label, photos: b.photos, editable: true,
                auth: { auth_kind: 'portal', contact_id: id, t: token },
                onChange: function (photos) { b.photos = (b.photos || []).filter(function (p) { return p.roomKey !== r.key; }).concat(photos); }
            }));
            inner.appendChild(rd);
        });

        inner.appendChild(editor({
            label: 'Anything else for this visit', value: b.generalInstruction, rows: 3,
            onSaved: function (text) { b.generalInstruction = text; },
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

    /* ========================================================
       PAYMENT
       ========================================================

       The button asks the Worker for a Stripe Checkout URL and goes there. It
       sends the JOB and this page's own credential — never an amount. The
       server reads what to charge out of the booking row, which is the whole
       reason the quote is signed in the first place; a price that travelled
       through here could be edited before it arrived.

       AUTHORIZE, NOT CHARGE. Stripe places a hold; the money is collected only
       when the partner has accepted the job. Serve should not be holding
       somebody's money for work nobody has yet agreed to do.

       Every failure leaves the customer where they were with a sentence they
       can act on. A payment button that silently does nothing is worse than no
       button, because the booking still stands and they cannot tell. */

    var PAY_ERRORS = {
        not_configured:    'Card payment is not available yet. We will send an invoice instead.',
        already_paid:      'This booking is already paid.',
        already_completed: 'This booking is finished — there is nothing left to pay here.',
        no_price_on_file:  'We need to confirm the price on this booking first. We will be in touch.',
        price_out_of_range:'We need to check the price on this booking first. We will be in touch.',
        not_found:         'We could not find that booking on your account.',
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
            try { sessionStorage.setItem(KEEP, JSON.stringify({ id: id, t: token })); }
            catch (_) { /* the return trip degrades; the payment still works */ }

            fetch('/api/checkout', {
                method:  'POST',
                headers: { 'Content-Type': 'application/json' },
                body:    JSON.stringify({ job_id: b.bookingId, contact_id: id, t: token }),
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

    /* Stripe sends everyone back to the same two addresses, so the page says
       what happened rather than leaving them guessing. `cancelled` is not an
       error and must not read like one — people change their minds. */
    function payBanner() {
        if (payResult !== 'done' && payResult !== 'cancelled') return null;
        var ok = payResult === 'done';
        return el('p', ok ? 'portal__note portal__note--ok' : 'portal__note',
            ok ? 'Thank you — your card is authorized. We will charge it once ' +
                 'your cleaner confirms, and your booking below will update shortly.'
               : 'No payment was taken. Your booking is unchanged and you can ' +
                 'authorize whenever you are ready.');
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
    function accessComplete(homes) {
        /* No linked home or missing question data must not look complete.
           The server's question/choice list supplies the requirements; pets
           are a separate optional editor. Never read or retain a door code. */
        return !!homes && homes.length > 0 && homes.every(function (home) {
            return !!home.propertyId && Array.isArray(home.questions) &&
                home.questions.length > 0 && home.questions.every(function (q) {
                    if (q.required === false) return true;
                    var choice = (q.choices || []).filter(function (c) {
                        return c.key === q.choice;
                    })[0];
                    if (!choice) return false;
                    if (choice.secret) return q.secretSet === true;
                    return !choice.detail || String(q.detail || '').trim().length > 0;
                });
        });
    }

    function updateAccessStatus() {
        if (!accessFlag) return;
        var complete = accessComplete(model.homes);
        accessFlag.textContent = complete ? 'Complete' : 'Incomplete';
        accessFlag.className = 'portal__access-flag ' +
            (complete ? 'is-complete' : 'is-incomplete');
    }

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
                onSaved: function (text) { home.petNotes = text; },
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

        function saveAnswer(choice, detail, saveStatus, btn) {
            /* Serialize this question's writes. Otherwise a delayed choice
               save can erase a newer detail or restore an old entry method. */
            wrap.disabled = true;
            var pending = save({ kind: 'access', property_id: home.propertyId,
                          field: q.field, choice: choice.key, detail: detail },
                        saveStatus, btn).then(function (ok) {
                wrap.disabled = false;
                pendingAccessSaves.delete(q);
                if (!ok) return false;
                q.choice = choice.key;
                q.detail = !choice.secret && choice.detail ? detail.slice(0, 500) : '';
                if (q.field === 'entry') {
                    q.secretSet = !!choice.secret && (!!detail || q.secretSet === true);
                    if (detail || !q.secretSet) q.secretSetAt = '';
                }
                updateAccessStatus();
                return true;
            });
            pendingAccessSaves.set(q, pending);
            return pending;
        }

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
                saveAnswer(c, '', status, null).then(function (ok) {
                    if (!ok) {
                        chosen = q.choice;
                        wrap.querySelectorAll('input[type="radio"]').forEach(function (radio) {
                            radio.checked = radio.value === chosen;
                        });
                    }
                    paintDetail();
                });
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
                if (chosen === q.choice && q.secretSet) {
                    var saved = el('p', 'pq__saved',
                        'Code saved' + (q.secretSetAt ? ' · ' + prettyDate(q.secretSetAt) : ''));
                    detailHost.appendChild(saved);
                }
                detailHost.appendChild(editor({
                    value: '', rows: 1,
                    placeholder: chosen === q.choice && q.secretSet
                        ? 'Enter a new code to replace it' : c.detail,
                    save: function (text, saveStatus, btn) {
                        return saveAnswer(c, text, saveStatus, btn);
                    },
                    onSaved: paintDetail,
                }));
                detailHost.appendChild(el('p', 'tk-note',
                    'We never show this back to you, and it is not on your cleaner’s ' +
                    'page. We pass it on directly when we assign your visit.'));
                return;
            }

            detailHost.appendChild(editor({
                value: chosen === q.choice ? q.detail : '', rows: 2, placeholder: c.detail,
                save: function (text, saveStatus, btn) {
                    return saveAnswer(c, text, saveStatus, btn);
                },
            }));
        }

        paintDetail();
        wrap.appendChild(detailHost);
        wrap.appendChild(status);
        /* Switching tabs while a save is in flight creates a new fieldset
           for the same answer. Keep it locked and sync it when that write
           finishes, so returning early cannot race the previous save. */
        if (pendingAccessSaves.has(q)) {
            wrap.disabled = true;
            status.textContent = 'Saving…';
            pendingAccessSaves.get(q).then(function (ok) {
                wrap.disabled = false;
                chosen = q.choice;
                wrap.querySelectorAll('input[type="radio"]').forEach(function (radio) {
                    radio.checked = radio.value === chosen;
                });
                paintDetail();
                status.textContent = ok ? 'Saved' : 'That did not save. Please try again.';
                status.className = 'tk-save ' + (ok ? 'is-ok' : 'is-bad');
            });
        }
        return wrap;
    }
})();
