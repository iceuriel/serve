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

    var API   = '/api/portal';
    /* The same feed the booking form reads, through the same Worker route. */
    var SLOTS = '/api/slots';

    /* THE EARLIER / LATER FALLBACK, NAMED ONCE. Three cards on this page offer
       it when the feed comes back empty, and the words are a promise about when
       somebody turns up — two copies is how one card starts promising a window
       the others do not. Same reason the horizon rules live in serve-slots.js. */
    var PREF_NAMES = {
        earlier: ['Earlier in the day', 'Typically 8:00 AM – 12:00 PM'],
        later:   ['Later in the day', 'Typically 12:00 PM – 5:00 PM'],
    };

    /* Deselect every slot chip under `root`. A preference and a slot answer the
       same question, so choosing one must visibly clear the other. */
    function clearChips(root) {
        (root.querySelectorAll('.slot-chip') || []).forEach(function (c) {
            c.className = 'slot-chip';
            c.setAttribute('aria-pressed', 'false');
        });
    }

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

    /* One address for this account, built once. The first load, the live
       refresh and the reload after a plan confirmation all ask the same
       question, and three hand-built copies of a signed URL is three chances
       to drop the token. */
    var LOAD = API + '?id=' + encodeURIComponent(id) + '&t=' + encodeURIComponent(token);

    /* r44. THE FIRST ANSWER MAY ALREADY BE ON ITS WAY. h.html starts this
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

    /* ========================================================
       ONE RETRY, AND ONLY THE TRUTH ABOUT WHAT FAILED  —  r50
       ========================================================
       The founder reported opening a portal from a text, closing it, and
       being told the link "may have been replaced" — intermittently, on a
       link that was fine. It was never the link. Every one of these ended
       here, because this page used to print that one sentence for FOUR
       different outcomes: the link really is unknown; the Worker gave up on a
       slow Apps Script (an 8s budget against a cold start that routinely
       takes longer — see UPSTREAM_TIMEOUT_MS.page); the sheet read threw
       upstream; and an answer that is not this view. Three of those are the
       round trip failing, and a customer told their credential is dead has no
       reason to try it again.

       ServeLive already got this right for the REFRESH — 20s, backoff, and it
       declares a link closed only on an explicit not_found. This is the same
       judgement applied to the first load, which is the one that matters most
       because nothing is on screen behind it.

       ONE RETRY, NOT THREE. Each attempt can cost the Worker's full 15s, and
       a third try would leave somebody staring at a skeleton for 45s before
       any bad news. One covers the cold start and the blip, which is what
       these actually are. */
    var RETRY_MS = 800;

    /* Did the server ANSWER, or did the trip fail? "not_found" is an answer:
       this id and this token open nothing, and asking again says the same.
       Anything else — a fetch that threw, the Worker's 502 after a timeout,
       an upstream lookup_failed, a view this page does not know — is a broken
       round trip, and the second attempt usually works. */
    function answered(d) {
        if (!d) return false;
        if (d.ok === true && d.view === 'portal') return true;
        return d.error === 'not_found' || d.error === 'expired';
    }

    function load(url, retried) {
        var attempt = retried
            ? fetch(url).then(function (r) { return r.json(); })
            : firstLoad(url);
        return attempt
            .catch(function (err) { console.warn('portal load failed', err); return null; })
            .then(function (d) {
                if (answered(d) || retried) return d;
                return new Promise(function (go) { setTimeout(go, RETRY_MS); })
                    .then(function () { return load(url, true); });
            });
    }

    load(LOAD).then(function (d) {
        /* Twice, and still no answer. Say what is true — the link is fine, we
           could not reach the account — and offer the retry here rather than
           sending them back to find the text message again. */
        if (!answered(d)) {
            fail(d
                ? 'We could not load your account just now. Please try again, ' +
                  'or call us on the number below.'
                : 'We could not reach Serve just now. Please check your ' +
                  'connection and try again, or call us on the number below.',
                true);
            return;
        }
        /* view === portal, not merely ok. An older deployment has no portal
           route, so doGet falls through to the HEALTH CHECK, which answers
           ok:true — and this page would render that as an empty account
           rather than saying anything was wrong. The ticket hit the same
           ordering problem on 2026-09-08. */
        if (d.ok !== true || d.view !== 'portal') {
            fail('We could not open that link. It may be mistyped, or it ' +
                 'may have been replaced.');
            return;
        }
        model = d;
        start();
        warmSlots(d);
        if (typeof ServeLive !== 'undefined') ServeLive.watch({
            url: LOAD,
            view: 'portal', root: bodyEl, initial: d, statusInto: footEl,
            onData: function (next) { model = next; paint(); }
        });
    });

    function fail(msg, retry) {
        stateEl.textContent = msg;
        if (retry) add(stateEl, retryButton());
        footEl.hidden = false;
    }

    /* A plain reload: the link in the address bar is the credential, and it is
       already correct. Nothing to rebuild, nothing to remember. */
    function retryButton() {
        var b = el('button', 'btn btn--ghost tk-retry', 'Try again');
        b.type = 'button';
        b.addEventListener('click', function () { location.reload(); });
        return b;
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

    /* The compact calendar tile used on booking cards. It repeats only the
       date, not the time: the full readable schedule stays beside it. */
    function dateTile(iso) {
        var p = String(iso || '').split('-');
        if (p.length !== 3) return { month: 'DATE', day: 'TBD' };
        var d = new Date(+p[0], +p[1] - 1, +p[2]);
        if (!isFinite(d.getTime())) return { month: 'DATE', day: 'TBD' };
        var mons = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
        return { month: mons[d.getMonth()], day: String(d.getDate()) };
    }

    function greeting() {
        var hour = new Date().getHours();
        if (hour < 12) return 'Good morning';
        if (hour < 18) return 'Good afternoon';
        return 'Good evening';
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
       THE SCHEDULE, ASKED FOR BEFORE THE CLICK  —  r44
       ========================================================
       "Choose a time" and "Move this visit" used to start the availability
       request on click, and the customer watched "Loading times…" for as long
       as the feed took. Now, when the page has something that could use it —
       an open plan, or a visit that can still be moved — it asks once in the
       background as soon as the page has painted.

       NEVER OLDER THAN A MINUTE, which is how long the feed's own response
       may already sit in the browser's cache. A click inside that window
       uses the answer in hand; a later click asks again. An EMPTY answer is
       not kept — it is as likely to be a slow server as a full calendar, and
       the click deserves its own attempt. Anything that changes what is open
       (a booking made, moved or cancelled) forgets it: see postWrite.
       ======================================================== */
    var SLOTS_FRESH_MS = 60000;
    var CAPACITY_KINDS = { plan_confirm: true, reschedule: true, cancel: true,
                           plan_start: true, plan_change: true };
    var slotsWarm = null;   // { at: ms, promise }

    function loadSlots() {
        if (slotsWarm && Date.now() - slotsWarm.at < SLOTS_FRESH_MS) return slotsWarm.promise;
        var entry = { at: Date.now(), promise: ServeSlots.load(SLOTS) };
        slotsWarm = entry;
        entry.promise.then(function (slots) {
            if (!slots.length && slotsWarm === entry) slotsWarm = null;
        });
        return entry.promise;
    }

    /* The same two tests the page uses to draw those controls: planCard
       needs a frequency, and every visit neither finished nor called off gets
       scheduleControls. Asking on anything looser would warm a feed nothing
       on screen can use. */
    function warmSlots(d) {
        if (typeof ServeSlots === 'undefined' || !d) return;
        var movable = (d.bookings || []).some(function (b) {
            return b && !b.completed && !b.cancelled;
        });
        var movePlan = d.movePlan && (d.movePlan.state === 'choose' || d.movePlan.state === 'saved');
        if ((d.plan && d.plan.frequency) || movable || movePlan) loadSlots();
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
    /* THE ONE PLACE A PORTAL WRITE IS ADDRESSED AND SENT. Both callers below
       decide for themselves what a failure should say — saving a note and
       booking a visit do not fail in the same words — but neither rebuilds the
       envelope or re-reads the token. */
    function postWrite(payload) {
        var body = { event_type: 'portal_write', contact_id: id, t: token };
        Object.keys(payload).forEach(function (k) { body[k] = payload[k]; });

        return fetch(API, {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain;charset=utf-8' },
            body: JSON.stringify(body),
        })
        .then(function (r) { return r.json(); })
        .then(function (d) {
            /* What is open has just changed, whatever the answer says — a
               refused move can still mean somebody else took the time. */
            if (CAPACITY_KINDS[payload.kind]) slotsWarm = null;
            return d;
        });
    }

    /* Ask the server what this account looks like now, and repaint.
       Used after a confirmation, where the page the customer is looking at has
       just stopped being true: the offer is a booking and belongs in the list
       above rather than in a card asking them to choose a time. */
    function reload() {
        return fetch(LOAD)
            .then(function (r) { return r.json(); })
            .then(function (d) {
                if (!d || d.ok !== true || d.view !== 'portal') return false;
                model = d;
                paint();
                return true;
            })
            .catch(function () { return false; });
    }

    /* ========================================================
       A SLOW WRITE IS NOT A FAILED WRITE  —  r58
       ========================================================
       The founder confirmed a plan in a test portal, watched it spin, and was
       told it did not go through — while the confirmation email was already on
       its way and the plan was already booked. Nothing was wrong with the
       booking. The Worker gives a portal write 12 seconds
       (UPSTREAM_TIMEOUT_MS.submit) and then answers 502; Apps Script never
       hears that it stopped listening and carries on writing. A plan confirm
       opens the second workbook, books the slot, writes JOBS, updates the plan
       and sends the mail — and a cold start alone can eat the whole budget
       before any of that begins.

       This is r56's lesson applied to the portal: no latency budget can be made
       generous enough to be right every time, so stop guessing from the round
       trip and ASK THE ACCOUNT. The question is already built — the same portal
       GET this page loads itself with — and doGet takes no script lock, so it
       answers WHILE the slow write is still running.

       THE PREDICATE IS THE SERVER'S OWN. clientRecurringPlan offers a plan only
       while it is PENDING, so a confirmed plan stops being offered. "The offer
       is gone" and "the write landed" cannot drift apart — the same reason r56
       shares alreadyWritten() with the dedupe rather than re-deciding.

       IMMEDIATELY, THEN BACKING OFF. Twelve seconds have already passed by the
       time the first question is asked, so it is often answered at once; the
       rest cover a write that is still finishing. ======================== */
    var SETTLE_MS = [0, 2000, 3000, 5000];

    /* THE ONE ERROR THAT IS NOT AN ANSWER. The Worker returns it when it gave
       up waiting, or could not reach the script at all; either way the write it
       was carrying may have completed perfectly. A reply with no error code at
       all is the same thing — this page could not read it. Every other code is
       the script's own considered reply, and is the truth. */
    function unheard(d) {
        return !d || (!d.ok && (!d.error || d.error === 'upstream_unreachable'));
    }

    /* The account as it stands now, WITHOUT painting it. reload() repaints,
       which is right after a confirmation and wrong while one is still in
       doubt: repainting mid-question throws away the time the customer picked
       and the question they are waiting on. */
    function fetchModel() {
        return fetch(LOAD)
            .then(function (r) { return r.json(); })
            .then(function (d) {
                return (d && d.ok === true && d.view === 'portal') ? d : null;
            })
            .catch(function () { return null; });
    }

    /* Ask, up to SETTLE_MS.length times, whether `landed` is yet true of the
       account. Resolves true once it is — with `model` replaced and ready to
       paint — and false when the attempts run out. A read that fails is not an
       answer either; it simply costs one attempt. */
    function settle(landed, i) {
        var at = i || 0;
        return new Promise(function (go) { setTimeout(go, SETTLE_MS[at]); })
            .then(fetchModel)
            .then(function (d) {
                if (d && landed(d)) { model = d; return true; }
                if (at + 1 >= SETTLE_MS.length) return false;
                return settle(landed, at + 1);
            });
    }

    /* THE AMBIGUOUS BRANCH, NAMED ONCE. Ask the account whether `landed` has
       become true, then say so — or report the honest failure the caller hands
       in. Every caller keeps its OWN words: moving a visit, cancelling one and
       booking a plan do not succeed in the same sentence, and a shared message
       here is how one of them starts telling a customer the wrong thing. */
    function askTheAccount(landed, statusEl, okText, lost) {
        statusEl.textContent = 'Still working on it…';
        statusEl.className = 'tk-save';
        return settle(landed).then(function (yes) {
            if (!yes) return lost();
            statusEl.textContent = okText;
            statusEl.className = 'tk-save is-ok';
            paint();
        });
    }

    /* This booking as the account now reports it, or null. */
    function bookingIn(d, jobId) {
        var list = (d && d.bookings) || [];
        for (var i = 0; i < list.length; i++) {
            if (list[i] && list[i].bookingId === jobId) return list[i];
        }
        return null;
    }

    /* "9:00 AM ET" AND "9:00 AM" ARE THE SAME TIME. The account returns a
       DISPLAY string — timeCellText appends ET so that a cleaner reading a
       phone in another timezone cannot misread it — while the feed returns the
       raw one. Comparing the two as they arrive is false FOREVER, which is how
       a guard that reads perfectly never fires once; that exact bug has already
       been shipped here, in the r53 slot check. Normalised on both sides.

       THE BLANK CHECK IS UNREACHABLE TODAY AND KEPT ANYWAY. Its only caller
       refuses to send without a time, so the second argument is never blank and
       a mutation deleting `!!norm(a)` kills no test — that is recorded rather
       than papered over. It stays because two blanks answering "the same time?"
       with yes is the kind of wrong this helper must never be, and the next
       caller does not inherit that guarantee from this one. */
    function sameTime(a, b) {
        var norm = function (s) {
            return String(s || '').replace(/\s*\bET\b\.?\s*$/i, '')
                                  .replace(/\s+/g, ' ').trim().toUpperCase();
        };
        return !!norm(a) && norm(a) === norm(b);
    }

    function save(payload, statusEl, btn) {
        statusEl.textContent = 'Saving…';
        statusEl.className = 'tk-save';
        if (btn) btn.disabled = true;

        return postWrite(payload)
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
        var intro = el('div', 'portal__intro');
        intro.appendChild(el('h1', 'portal__greeting',
            greeting() + (model.firstName ? ', ' + model.firstName : '')));
        intro.appendChild(el('p', 'portal__lede',
            'Here’s what’s happening with your cleaning services.'));
        bodyEl.appendChild(intro);
        /* Before the empty check: somebody returning from Stripe must be told
           what happened even in the odd case that the list will not render. */
        add(bodyEl, payBanner());
        if (!list.length) {
            bodyEl.appendChild(el('p', 'tk-val', 'No bookings yet.'));
            return;
        }

        /* r43. A cancelled visit is neither upcoming nor past — it is not
           going to happen, and it did not happen. Leaving it in Upcoming with
           a label would put a visit nobody is coming to at the top of the
           page, which is the one place it must never be. */
        var upcoming  = list.filter(function (b) { return !b.completed && !b.cancelled; });
        var past      = list.filter(function (b) { return b.completed; });
        var cancelled = list.filter(function (b) { return b.cancelled && !b.completed; });

        if (upcoming.length) {
            bodyEl.appendChild(el('h2', 'portal__h', 'Upcoming'));
            upcoming.forEach(function (b) { bodyEl.appendChild(bookingRow(b)); });
        }
        /* r38. After the real bookings, because it is not one of them.

           r41: the model is `model` here. `d` is the fetch callback parameter
           at the top of this file and does not exist in this scope — this line
           threw, AFTER the upcoming rows were already on the page, so the
           portal rendered up to here and stopped. No plan card, and no Past
           section either. */
        add(bodyEl, planCard(model.plan));
        /* r45. The plan box for somebody who booked a move — beside r38's
           offer card, because it answers the same question for them. */
        add(bodyEl, movePlanBox(model.movePlan));
        if (past.length) {
            bodyEl.appendChild(el('h2', 'portal__h', 'Past'));
            past.forEach(function (b) { bodyEl.appendChild(bookingRow(b)); });
        }
        /* Last, because it is the least actionable thing on the page. */
        if (cancelled.length) {
            bodyEl.appendChild(el('h2', 'portal__h', 'Cancelled'));
            cancelled.forEach(function (b) { bodyEl.appendChild(bookingRow(b)); });
        }
    }

    /**
     * The recurring plan they were offered, which is NOT a booking.
     *
     * It reads as an offer with a deadline rather than as an appointment: no
     * date, because nobody has chosen one until they choose one here, and the
     * price they were quoted rather than a number recomputed today.
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
        add(wrap, planConfirm(plan));
        return wrap;
    }

    /**
     * CONFIRM & SCHEDULE (r42) — where the offer becomes a booking.
     *
     * The times come from the same feed and the same horizon rules the booking
     * form uses, through serve-slots.js. Two implementations of "what may a
     * customer pick?" is how this page would start offering a date the site
     * itself refuses.
     *
     * NOTHING IS REDRAWN OPTIMISTICALLY. On success the whole account is
     * re-read and repainted, so what the customer ends up looking at is what
     * was actually recorded — a visit somebody believes is booked and is not
     * is the worst failure this page has.
     *
     * Without serve-slots.js this returns null and the card stays exactly what
     * it was before this release: a legible offer with no button. A control
     * that throws on click would be worse than no control.
     */
    function planConfirm(plan) {
        if (typeof ServeSlots === 'undefined') return null;

        var box    = el('div', 'plan__confirm');
        var picked = { date: '', time: '', pref: '' };

        var cta = el('button', 'plan__cta', 'Choose a time');
        cta.type = 'button';
        box.appendChild(cta);

        var pickWrap = el('div', 'plan__pick');
        pickWrap.hidden = true;
        box.appendChild(pickWrap);

        var chosen = el('div', 'plan__chosen');
        chosen.hidden = true;
        box.appendChild(chosen);

        /* Offered ONLY when there is a previous company to ask for. A checkbox
           asking for "the same cleaner" on a first booking would be asking
           about somebody who does not exist yet. */
        var sameWrap = null, sameBox = null;
        if (plan.samePartner) {
            sameWrap = el('div', 'plan__samewrap');
            var lbl = el('label', 'plan__same');
            sameBox = document.createElement('input');
            sameBox.type = 'checkbox';
            lbl.appendChild(sameBox);
            lbl.appendChild(el('span', null,
                'Ask for the same cleaning company as your first visit'));
            sameWrap.appendChild(lbl);
            /* Not decoration. Serve assigns the visit, and a promise about
               which company turns up is one this page cannot keep. */
            sameWrap.appendChild(el('div', 'plan__samenote',
                'We pass this on when we assign the visit. It is a request, not a guarantee.'));
            sameWrap.hidden = true;
            box.appendChild(sameWrap);
        }

        /* EARLIER / LATER — the same fallback the booking form and the move
           plan card already offer, and for the same reason. An empty feed is
           ordinary: the founder refills AVAILABILITY weekly, so there are days
           with nothing open on screen and a customer who still wants to book.
           Sending them to the phone loses the ones who will not call, and the
           server has always been able to take a preference — bookPlanVisit
           writes `time_preference` whenever the schedule has no clock time.
           This card was simply the one surface that never asked. */
        var prefWrap = el('div', 'plan__prefs');
        prefWrap.hidden = true;
        box.appendChild(prefWrap);

        function drawPrefs() {
            prefWrap.textContent = '';
            ['earlier', 'later'].forEach(function (k) {
                var b = el('button', 'plan__pref' + (picked.pref === k ? ' is-selected' : ''));
                b.type = 'button';
                b.setAttribute('aria-pressed', picked.pref === k ? 'true' : 'false');
                b.setAttribute('data-pref', k);
                b.appendChild(el('span', 'plan__optname', PREF_NAMES[k][0]));
                b.appendChild(el('span', 'plan__optprice', PREF_NAMES[k][1]));
                b.addEventListener('click', function () {
                    /* A preference and a slot are two answers to one question,
                       so choosing either clears the other. Sending both would
                       leave the server deciding which the customer meant. */
                    picked.pref = k; picked.date = ''; picked.time = '';
                    clearChips(pickWrap);
                    chosen.hidden = false;
                    chosen.textContent = 'Your first ' + plan.frequency + ' visit: ' +
                        PREF_NAMES[k][0].toLowerCase() +
                        ' — we will call to set the day.';
                    if (sameWrap) sameWrap.hidden = false;
                    row.hidden = false;
                    status.textContent = '';
                    status.className = 'tk-save';
                    drawPrefs();
                });
                prefWrap.appendChild(b);
            });
        }

        var row = el('div', 'plan__row');
        /* Two buttons, two weights. Choosing a time is exploratory and can be
           undone by choosing another; this one books a visit. */
        var go  = el('button', 'plan__cta plan__go', 'Confirm ' + plan.frequency + ' plan');
        go.type = 'button';
        var status = el('span', 'tk-save');
        row.appendChild(go);
        row.appendChild(status);
        row.hidden = true;
        box.appendChild(row);

        /* Built now, revealed later. drawPrefs closes over `row` and `status`,
           so it cannot run before they exist — and a prefWrap left empty until
           first click is a hidden box with nothing in it to reveal. */
        drawPrefs();

        cta.addEventListener('click', function () {
            cta.disabled = true;
            pickWrap.hidden = false;
            pickWrap.textContent = 'Loading times…';

            loadSlots().then(function (slots) {
                pickWrap.textContent = '';
                cta.hidden = true;
                /* An empty feed is an ordinary outcome, not an error screen:
                   unreachable, slow, or genuinely nothing open all land here,
                   and all of them mean the same thing to the customer.

                   IT IS NO LONGER A DEAD END. The customer still wants this
                   plan; the only thing missing is a clock time, and earlier /
                   later is an answer Serve can act on. Asking them to phone us
                   loses every customer who will not phone — and the ones who
                   do arrive as a voicemail instead of a row in JOBS. */
                if (!slots.length) {
                    pickWrap.appendChild(el('p', 'plan__body',
                        'We have no open times on screen right now. Choose earlier ' +
                        'or later in the day and we will call to set the day.'));
                    prefWrap.hidden = false;
                    return;
                }
                pickWrap.appendChild(ServeSlots.picker(slots, function (date, time) {
                    picked.date = date;
                    picked.time = time;
                    picked.pref = '';
                    drawPrefs();
                    chosen.hidden = false;
                    chosen.textContent = 'Your first ' + plan.frequency + ' visit: ' +
                        (prettyDate(date) || date) + ' at ' + time;
                    if (sameWrap) sameWrap.hidden = false;
                    row.hidden = false;
                    status.textContent = '';
                    status.className = 'tk-save';
                }));
                /* A full feed still may not contain a time that works. The
                   same escape hatch the booking form gives, one click away
                   rather than on screen competing with the real times. */
                var other = el('button', 'plan__other',
                    'None of these work? Choose earlier or later in the day');
                other.type = 'button';
                other.addEventListener('click', function () {
                    prefWrap.hidden = false;
                    other.hidden = true;
                });
                pickWrap.appendChild(other);
            });
        });

        go.addEventListener('click', function () {
            /* A slot OR a preference — never neither, and the branch below
               never sends both. */
            if (!(picked.date && picked.time) && !picked.pref) return;
            go.disabled = true;
            status.textContent = 'Booking…';
            status.className = 'tk-save';

            var payload = { kind: 'plan_confirm', plan_id: plan.planId };
            if (picked.date && picked.time) {
                payload.slot_date = picked.date;
                payload.slot_time = picked.time;
            } else {
                payload.time_preference = picked.pref;
            }
            payload.same_provider = !!(sameBox && sameBox.checked);

            /* Booked — however this browser came to hear it. */
            function booked() {
                status.textContent = 'Booked';
                status.className = 'tk-save is-ok';
                return reload();
            }
            function refused(code) {
                go.disabled = false;
                status.textContent = planError(code);
                status.className = 'tk-save is-bad';
            }
            /* No answer is not a no. See A SLOW WRITE IS NOT A FAILED WRITE.
               A plan is offered only while it is PENDING, so the offer going
               away IS the confirmation. */
            function ask() {
                return askTheAccount(function (d) {
                    return !(d.plan && d.plan.planId === plan.planId);
                }, status, 'Booked', function () { refused(''); });
            }

            postWrite(payload)
            .then(function (d) {
                /* `already_confirmed` is a SUCCESS this browser did not hear
                   the first time — the plan IS booked. Showing it in red over a
                   plan that exists is how a customer who pressed Confirm twice
                   ends up phoning to ask which screen to believe. */
                if (d && (d.ok || d.error === 'already_confirmed')) return booked();
                if (unheard(d)) return ask();
                return refused(d.error);
            })
            .catch(ask);
        });

        return box;
    }

    /* Each of these is a real state rather than a generic failure: the window
       closed, it is already booked, or the time went stale between loading the
       list and choosing from it. */
    function planError(code) {
        if (code === 'expired') {
            return 'That price is no longer being held. Please call us and we will sort it out.';
        }
        if (code === 'already_confirmed') return 'That plan is already booked.';
        if (code === 'bad_slot')          return 'That time is no longer available. Please pick another.';
        return 'That did not go through. Please try again.';
    }

    /* ========================================================
       A PLAN AFTER A MOVE  —  r45
       ========================================================
       Somebody who booked a move-in / move-out clean is shown the three
       cadences, priced for their home, and books one with a time. After that
       the box is the plan they chose — static — until they press Change.

       THE PRICES COME FROM /api/quote, the Worker's copy of the pricing
       engine, asked about the home the server put in the model. They are not
       computed here and not trusted by the server: it asks the engine again
       and refuses if the answer differs from what this page showed.

       The earlier / later choice is the booking form's own fallback, for
       somebody who does not like any of the open times.
       ======================================================== */
    var QUOTE = '/api/quote';
    var PLAN_NAMES = { weekly: 'Every week', biweekly: 'Every 2 weeks', monthly: 'Every month' };

    /* r59. The box asks two kinds of customer now — somebody who booked a move,
       and somebody who booked a one-time deep clean — and only the WORDS
       differ. The server sends `kind`; every rule about what may be booked
       stays on that side.

       DEFAULTS TO THE MOVE WORDING when `kind` is missing, which is what a
       script older than r59 sends. That is the harmless direction: the box
       still works and only reads slightly wrong, instead of going blank. */
    function planWords(mp) {
        return (mp && mp.kind === 'deep')
            ? { basis: 'deep clean', tag: 'After your deep clean' }
            : { basis: 'move clean', tag: 'After your move' };
    }
    var PLAN_ORDER = ['weekly', 'biweekly', 'monthly'];
    /* PREF_NAMES and clearChips are shared with the plan card — see the top. */

    /* Page state that must survive a live repaint: whether the saved plan is
       being changed, and the prices already fetched for this home. */
    var movePlanEditing = false;
    var movePrices = null;          // { key, promise }

    function loadMovePrices(home) {
        var key = JSON.stringify(home);
        if (movePrices && movePrices.key === key) return movePrices.promise;
        var entry = { key: key, promise: fetch(QUOTE, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ zip: home.zip, bedrooms: home.bedrooms,
                bathrooms: home.bathrooms, levels: home.levels,
                service: 'first_clean', condition: 'standard', frequency_selected: 'once' }),
        })
        .then(function (r) { return r.json(); })
        .then(function (d) {
            var rec = d && d.ok === true && d.recurring;
            var ok = rec && PLAN_ORDER.every(function (f) { return Number(rec[f]) > 0; });
            return ok ? rec : null;
        })
        .catch(function () { return null; }) };
        movePrices = entry;
        /* A failure is not kept: the retry button deserves its own attempt. */
        entry.promise.then(function (p) { if (!p && movePrices === entry) movePrices = null; });
        return entry.promise;
    }

    /** The plan box, or null for anybody who did not book a move. */
    function movePlanBox(mp) {
        if (!mp || (mp.state !== 'choose' && mp.state !== 'saved') || !mp.home) return null;
        var wrap = el('section', 'mplan');
        drawMovePlan(wrap, mp);
        return wrap;
    }

    function drawMovePlan(wrap, mp) {
        wrap.textContent = '';
        var editing = mp.state === 'choose' || movePlanEditing;
        wrap.className = 'mplan' + (mp.state === 'saved' && !editing ? ' mplan--saved' : '') +
                         (mp.state === 'saved' && editing ? ' is-dirty' : '');
        if (editing) movePlanChooser(wrap, mp); else movePlanSaved(wrap, mp);
    }

    /** The visit the plan points at, if it is still coming. */
    function movePlanVisit(mp) {
        var list = (model && model.bookings) || [];
        for (var i = 0; i < list.length; i++) {
            var b = list[i];
            if (b.bookingId === mp.visitId && !b.completed && !b.cancelled) return b;
        }
        return null;
    }

    /* ---- the plan they chose, as it stands ---- */
    function movePlanSaved(wrap, mp) {
        wrap.appendChild(el('div', 'mplan__tag', 'Your recurring plan'));
        wrap.appendChild(el('div', 'mplan__title', PLAN_NAMES[mp.frequency] || mp.frequency));
        var price = money(mp.price);
        if (price) wrap.appendChild(el('div', 'mplan__price', price + ' per visit'));
        if (mp.propertyLabel) wrap.appendChild(el('div', 'mplan__home', 'At ' + mp.propertyLabel));

        var visit = movePlanVisit(mp);
        wrap.appendChild(el('div', 'mplan__next', visit
            ? 'Next visit: ' + (whenLine(visit) || 'time to be confirmed')
            : 'No visit on the calendar right now.'));
        if (mp.sameAsked) {
            wrap.appendChild(el('div', 'mplan__note',
                'You asked for the same cleaning company as your ' +
                planWords(mp).basis + '.'));
        }

        var edit = el('button', 'mplan__edit', visit ? 'Change plan or time' : 'Book your next visit');
        edit.type = 'button';
        edit.addEventListener('click', function () {
            movePlanEditing = true;
            drawMovePlan(wrap, mp);
        });
        wrap.appendChild(edit);
    }

    /* ---- choosing a plan and a time ---- */
    function movePlanChooser(wrap, mp) {
        var saved = mp.state === 'saved';
        var visit = saved ? movePlanVisit(mp) : null;
        var pick = { frequency: saved ? mp.frequency : '', price: saved ? mp.price : null,
                     date: '', time: '', pref: '', keep: !!visit };
        var prices = null;

        wrap.appendChild(el('div', 'mplan__tag', saved ? 'Change your plan' : planWords(mp).tag));
        wrap.appendChild(el('div', 'mplan__title', 'Keep your home clean with a recurring plan'));
        if (mp.propertyLabel) wrap.appendChild(el('div', 'mplan__home', 'For ' + mp.propertyLabel));
        wrap.appendChild(el('p', 'mplan__body',
            'Choose how often. Prices are per visit for this home, and nothing is ' +
            'booked until you pick a time and confirm.'));

        var opts = el('div', 'mplan__plans');
        wrap.appendChild(opts);

        var timeBox = el('div', 'mplan__time');
        timeBox.hidden = !pick.frequency;
        wrap.appendChild(timeBox);

        var sameBox = null;
        if (!saved && mp.samePartner) {
            var sameWrap = el('div', 'plan__samewrap');
            var lbl = el('label', 'plan__same');
            sameBox = document.createElement('input');
            sameBox.type = 'checkbox';
            lbl.appendChild(sameBox);
            lbl.appendChild(el('span', null,
                'Ask for the same cleaning company as your ' + planWords(mp).basis));
            sameWrap.appendChild(lbl);
            sameWrap.appendChild(el('div', 'plan__samenote',
                'We pass this on when we assign the visit. It is a request, not a guarantee.'));
            wrap.appendChild(sameWrap);
        }

        var chosen = el('div', 'mplan__chosen');
        wrap.appendChild(chosen);

        var row = el('div', 'mplan__row');
        var go = el('button', 'mplan__go', saved ? 'Save changes' : 'Start my plan');
        go.type = 'button';
        row.appendChild(go);
        if (saved) {
            var keep = el('button', 'mplan__cancel', 'Keep my plan as it is');
            keep.type = 'button';
            keep.addEventListener('click', function () {
                movePlanEditing = false;
                drawMovePlan(wrap, mp);
            });
            row.appendChild(keep);
        }
        var status = el('span', 'tk-save');
        row.appendChild(status);
        wrap.appendChild(row);

        /* Anything chosen protects the box from the live refresh. */
        function touched() {
            if (String(wrap.className).indexOf('is-dirty') === -1) wrap.className += ' is-dirty';
        }

        function hasTime() { return pick.keep || pick.pref || (pick.date && pick.time); }

        function sayChosen() {
            var parts = [];
            if (pick.frequency) {
                parts.push((PLAN_NAMES[pick.frequency] || pick.frequency) +
                           (money(pick.price) ? ' at ' + money(pick.price) + ' per visit' : ''));
            }
            if (pick.date && pick.time) {
                parts.push((saved ? 'visit on ' : 'first visit on ') +
                           (prettyDate(pick.date) || pick.date) + ' at ' + pick.time);
            } else if (pick.pref) {
                parts.push((saved ? 'visit ' : 'first visit ') +
                           PREF_NAMES[pick.pref][0].toLowerCase() + ' — we will call to set the day');
            } else if (pick.keep && visit) {
                parts.push('visit stays ' + (whenLine(visit) || 'as booked'));
            }
            chosen.textContent = parts.join(' · ');
            var ready = !!pick.frequency && pick.price > 0 && !!hasTime();
            if (saved && pick.keep && pick.frequency === mp.frequency) ready = false;
            /* HIDDEN, NOT DISABLED, until there is something to confirm. The
               live refresh reads any disabled button as "a save is in flight"
               and stops repainting — a disabled button sitting in every move
               customer's portal would freeze their page. */
            go.hidden = !ready;
        }

        function drawOptions() {
            opts.textContent = '';
            PLAN_ORDER.forEach(function (f) {
                var b = el('button', 'mplan__opt' + (pick.frequency === f ? ' is-selected' : ''));
                b.type = 'button';
                b.setAttribute('aria-pressed', pick.frequency === f ? 'true' : 'false');
                b.setAttribute('data-frequency', f);
                b.appendChild(el('span', 'mplan__optname', PLAN_NAMES[f]));
                /* The saved plan keeps the price it was booked at. Only a
                   different cadence shows the engine's price for it. */
                var shown = (saved && f === mp.frequency) ? mp.price : prices[f];
                b.appendChild(el('span', 'mplan__optprice', money(shown) + ' per visit'));
                b.addEventListener('click', function () {
                    pick.frequency = f;
                    pick.price = shown;
                    touched();
                    drawOptions();
                    timeBox.hidden = false;
                    status.textContent = '';
                    status.className = 'tk-save';
                    sayChosen();
                });
                opts.appendChild(b);
            });
        }

        function showPrices() {
            opts.textContent = 'Loading prices…';
            loadMovePrices(mp.home).then(function (p) {
                opts.textContent = '';
                if (!p) {
                    opts.appendChild(el('p', 'tk-note',
                        'We could not load prices just now.'));
                    var retry = el('button', 'mplan__retry', 'Try again');
                    retry.type = 'button';
                    retry.addEventListener('click', showPrices);
                    opts.appendChild(retry);
                    return;
                }
                prices = p;
                drawOptions();
                sayChosen();
            });
        }

        /* ---- the time: keep it, a slot, or earlier / later ---- */
        var slotWrap = el('div', 'mplan__slots');
        var prefWrap = el('div', 'mplan__prefs');
        prefWrap.hidden = true;

        function drawPrefs() {
            prefWrap.textContent = '';
            ['earlier', 'later'].forEach(function (k) {
                var b = el('button', 'mplan__pref' + (pick.pref === k ? ' is-selected' : ''));
                b.type = 'button';
                b.setAttribute('aria-pressed', pick.pref === k ? 'true' : 'false');
                b.setAttribute('data-pref', k);
                b.appendChild(el('span', 'mplan__optname', PREF_NAMES[k][0]));
                b.appendChild(el('span', 'mplan__optprice', PREF_NAMES[k][1]));
                b.addEventListener('click', function () {
                    pick.pref = k; pick.date = ''; pick.time = ''; pick.keep = false;
                    clearChips(slotWrap);
                    touched();
                    drawPrefs();
                    drawKeep();
                    sayChosen();
                });
                prefWrap.appendChild(b);
            });
        }

        var keepBtn = null;
        function drawKeep() {
            if (!keepBtn) return;
            keepBtn.className = 'mplan__keep' + (pick.keep ? ' is-selected' : '');
            keepBtn.setAttribute('aria-pressed', pick.keep ? 'true' : 'false');
        }
        if (visit) {
            keepBtn = el('button', 'mplan__keep', 'Keep my visit on ' + (whenLine(visit) || 'its current time'));
            keepBtn.type = 'button';
            keepBtn.addEventListener('click', function () {
                pick.keep = true; pick.pref = ''; pick.date = ''; pick.time = '';
                clearChips(slotWrap);
                drawPrefs();
                drawKeep();
                sayChosen();
            });
            timeBox.appendChild(keepBtn);
            drawKeep();
        }

        timeBox.appendChild(el('div', 'mplan__label',
            saved ? 'Or pick a new time' : 'Pick a time for your first visit'));
        timeBox.appendChild(slotWrap);
        var other = el('button', 'mplan__other', 'None of these work? Choose earlier or later in the day');
        other.type = 'button';
        other.addEventListener('click', function () {
            prefWrap.hidden = false;
            other.hidden = true;
        });
        timeBox.appendChild(other);
        timeBox.appendChild(prefWrap);
        drawPrefs();

        if (typeof ServeSlots === 'undefined') {
            prefWrap.hidden = false;
            other.hidden = true;
        } else {
            slotWrap.textContent = 'Loading times…';
            loadSlots().then(function (slots) {
                slotWrap.textContent = '';
                /* The upkeep starts AFTER the clean the plan follows — the move
                   clean, or the one-time deep clean — and the server refuses
                   anything else, so nothing else is offered. */
                var after = String(mp.after || '');
                var usable = (slots || []).filter(function (s) { return !after || s.date > after; });
                if (!usable.length) {
                    slotWrap.appendChild(el('p', 'tk-note',
                        'We have no open times on screen right now. Choose earlier or ' +
                        'later in the day and we will call to set the day.'));
                    prefWrap.hidden = false;
                    other.hidden = true;
                    return;
                }
                slotWrap.appendChild(ServeSlots.picker(usable, function (date, time) {
                    pick.date = date; pick.time = time; pick.pref = ''; pick.keep = false;
                    touched();
                    drawPrefs();
                    drawKeep();
                    sayChosen();
                }));
            });
        }

        go.addEventListener('click', function () {
            if (go.hidden || go.disabled) return;
            go.disabled = true;
            status.textContent = saved ? 'Saving…' : 'Booking…';
            status.className = 'tk-save';

            var payload = saved
                ? { kind: 'plan_change', plan_id: mp.planId }
                : { kind: 'plan_start', job_id: mp.jobId,
                    same_provider: !!(sameBox && sameBox.checked) };
            payload.frequency = pick.frequency;
            payload.shown_price = pick.price;
            if (pick.date && pick.time) { payload.slot_date = pick.date; payload.slot_time = pick.time; }
            else if (pick.pref)         { payload.time_preference = pick.pref; }

            function lost(code) {
                go.disabled = false;
                status.textContent = movePlanError(code, mp);
                status.className = 'tk-save is-bad';
            }

            /* r58, FOR plan_start ONLY. Starting a plan flips this box from
               `choose` to `saved`, which is an unambiguous reading — and
               movePlanEditing is already false on that path, so the repaint
               shows the plan rather than the chooser.

               A plan_change is deliberately NOT asked about. Changing the TIME
               leaves the frequency alone, so "the plan says what I asked for"
               is already true BEFORE the write and would report success
               without having checked anything — the one failure worse than the
               one r58 fixes. The model carries no plan time to test instead,
               so there is nothing honest to ask, and it keeps the old
               behaviour until there is. */
            function ask() {
                if (saved) return lost('');
                return askTheAccount(function (d) {
                    return !!(d.movePlan && d.movePlan.state === 'saved');
                }, status, 'Booked', function () { lost(''); });
            }

            postWrite(payload)
            .then(function (d) {
                if (d && d.ok) {
                    status.textContent = saved ? 'Saved' : 'Booked';
                    status.className = 'tk-save is-ok';
                    movePlanEditing = false;
                    return reload();
                }
                /* The engine's price moved between looking and choosing. Show
                   the new numbers and let them confirm again — never book a
                   price they did not see. */
                if (d && d.error === 'price_changed' && d.prices) {
                    movePrices = { key: JSON.stringify(mp.home), promise: Promise.resolve(d.prices) };
                    prices = d.prices;
                    /* Re-armed, or the customer could never confirm the new
                       price — and a disabled button freezes the live refresh. */
                    go.disabled = false;
                    if (!(saved && pick.frequency === mp.frequency)) pick.price = d.prices[pick.frequency];
                    drawOptions();
                    sayChosen();
                    status.textContent = 'Prices were just updated. Please check the price and confirm again.';
                    status.className = 'tk-save is-bad';
                    return;
                }
                if (unheard(d)) return ask();
                lost(d.error);
            })
            .catch(function () { ask(); });
        });

        go.hidden = true;
        showPrices();
    }

    /* `mp` so "after your move clean" is not said to a deep-clean customer —
       this is the one error message that names the clean the plan follows. */
    function movePlanError(code, mp) {
        if (code === 'too_early')         return 'Please pick a day after your ' +
                                                 planWords(mp).basis + '.';
        if (code === 'bad_slot')          return 'That time is no longer available. Please pick another.';
        if (code === 'already_confirmed') return 'You already have a plan for this home. Refresh to see it.';
        if (code === 'price_unavailable') return 'We could not confirm the price just now. Please try again.';
        if (code === 'paid')              return 'That visit is already paid, so please call us to change your plan.';
        if (code === 'too_late')          return 'Your next visit is too soon to change online. Please call us.';
        return 'That did not go through. Please try again.';
    }

    /**
     * CHANGE OR CANCEL ONE VISIT (r43).
     *
     * Two actions with deliberately different weights. Moving a visit is
     * ordinary and undoable — pick another time, and another. Cancelling gives
     * the slot back to somebody else, so it asks twice, and the confirming
     * button says what it does rather than "Yes".
     *
     * NO window.confirm. A browser modal cannot be styled, blocks the page
     * while it is open, and on a phone arrives detached from the booking it
     * refers to — the customer is asked "are you sure?" about something they
     * can no longer see. An inline step keeps the visit on screen.
     *
     * THE TWO HALVES DEGRADE SEPARATELY. Moving needs serve-slots.js; calling
     * off does not. A missing module must not take away a customer's ability to
     * cancel a visit nobody is coming to — that failure would put them on the
     * phone to stop a cleaner arriving.
     *
     * NOTHING IS REDRAWN OPTIMISTICALLY. Both paths re-read the whole account
     * on success, exactly as confirming a plan does: a visit somebody believes
     * is moved and is not is the worst failure this page has.
     */
    function scheduleControls(b) {
        var wrap   = el('div', 'sched');
        var picked = { date: '', time: '' };

        var row = el('div', 'sched__row');
        var moveBtn = null;
        if (typeof ServeSlots !== 'undefined') {
            moveBtn = el('button', 'sched__btn', 'Change time');
            moveBtn.type = 'button';
            row.appendChild(moveBtn);
        }
        var cancelBtn = el('button', 'sched__btn sched__btn--quiet', 'Cancel visit');
        cancelBtn.type = 'button';
        row.appendChild(cancelBtn);
        var status = el('span', 'tk-save');
        row.appendChild(status);
        wrap.appendChild(row);

        /* THE MOVE HALF IS BUILT ONLY WHERE IT CAN WORK. Without the scheduler
           there is no agenda to populate, so a "Move this visit" button could
           never be revealed — building one anyway leaves a control in the page
           that no sequence of clicks can reach. The cancel half below is built
           unconditionally, because it needs nothing. */
        var pickWrap = null, goRow = null, go = null;
        if (moveBtn) {
            pickWrap = el('div', 'sched__pick');
            pickWrap.hidden = true;
            wrap.appendChild(pickWrap);

            /* Revealed only once a time is chosen, so there is never a button
               that would post an empty slot. */
            goRow = el('div', 'sched__go');
            goRow.hidden = true;
            /* ITS OWN CLASS, NOT THE PLAN CARD'S. Borrowing `plan__cta` here
               put a second element answering to the plan card's name into every
               open booking — and because bookings render ABOVE the card,
               anything looking for "the plan's button" found this one instead.
               It cost ten assertions the first time it ran. A class name is an
               identity. */
            go = el('button', 'sched__move', 'Move this visit');
            go.type = 'button';
            goRow.appendChild(go);
            wrap.appendChild(goRow);
        }

        var confirmRow = el('div', 'sched__confirm');
        confirmRow.hidden = true;
        confirmRow.appendChild(el('p', 'sched__warn',
            'Cancelling gives this time back to another customer. We cannot ' +
            'promise the same slot if you change your mind.'));
        var yes = el('button', 'sched__yes', 'Yes, cancel this visit');
        yes.type = 'button';
        var no  = el('button', 'sched__btn', 'Keep it');
        no.type = 'button';
        confirmRow.appendChild(yes);
        confirmRow.appendChild(no);
        wrap.appendChild(confirmRow);

        /* One place both paths report from, so a failed move and a failed
           cancellation cannot drift into saying different things. */
        function failed(btn, code) {
            btn.disabled = false;
            status.textContent = changeError(code);
            status.className = 'tk-save is-bad';
        }

        function openMove() {
            if (!moveBtn || moveBtn.disabled) return;
            moveBtn.disabled = true;
            confirmRow.hidden = true;
            pickWrap.hidden = false;
            pickWrap.textContent = 'Loading times…';

            loadSlots().then(function (slots) {
                pickWrap.textContent = '';
                /* Unreachable, slow, or genuinely nothing open all arrive here
                   as the same empty list, and mean the same thing to a
                   customer who needs this visit moved. */
                if (!slots.length) {
                    pickWrap.appendChild(el('p', 'tk-note',
                        'We have no open times on screen right now. Call or email ' +
                        'us below and we will move it with you.'));
                    return;
                }
                pickWrap.appendChild(ServeSlots.picker(slots, function (date, time) {
                    picked.date = date;
                    picked.time = time;
                    goRow.hidden = false;
                    status.textContent = '';
                    status.className = 'tk-save';
                }));
            });
        }

        if (moveBtn) moveBtn.addEventListener('click', openMove);

        if (go) go.addEventListener('click', function () {
            if (!picked.date || !picked.time) return;
            go.disabled = true;
            status.textContent = 'Moving…';
            status.className = 'tk-save';

            /* r58. The visit has moved when the account says it sits on the
               date and time that were asked for — read through sameTime,
               because the account's copy carries ET and the feed's does not. */
            function ask() {
                return askTheAccount(function (d) {
                    var row = bookingIn(d, b.bookingId);
                    return !!row && row.date === picked.date &&
                           sameTime(row.time, picked.time);
                }, status, 'Moved', function () { failed(go); });
            }

            postWrite({ kind: 'reschedule', job_id: b.bookingId,
                        slot_date: picked.date, slot_time: picked.time })
            .then(function (d) {
                if (d && d.ok) {
                    status.textContent = 'Moved';
                    status.className = 'tk-save is-ok';
                    return reload();
                }
                if (unheard(d)) return ask();
                failed(go, d.error);
            })
            .catch(ask);
        });

        /* Asking is not doing. Opening the confirm step sends nothing. */
        cancelBtn.addEventListener('click', function () {
            /* BOTH ARE NULL WHEN THE SCHEDULER IS ABSENT, and reaching through
               them unguarded threw exactly there — taking the cancel button
               down with it on the one page state where cancelling matters most.
               Building the two halves separately is only worth anything if this
               half never assumes the other exists. */
            if (pickWrap) pickWrap.hidden = true;
            if (goRow)    goRow.hidden = true;
            confirmRow.hidden = false;
        });
        no.addEventListener('click', function () { confirmRow.hidden = true; });

        yes.addEventListener('click', function () {
            yes.disabled = true;
            status.textContent = 'Cancelling…';
            status.className = 'tk-save';

            /* r58. `cancelled` is a FIELD, not a spelling of job_status the
               browser has to interpret — which is exactly why it can be trusted
               as the answer here. A customer wrongly told the cancellation
               failed either phones us or, worse, assumes a cleaner is still
               coming and stays home for one who is not. */
            function ask() {
                return askTheAccount(function (d) {
                    var row = bookingIn(d, b.bookingId);
                    return !!row && row.cancelled === true;
                }, status, 'Cancelled', function () { failed(yes); });
            }

            postWrite({ kind: 'cancel', job_id: b.bookingId })
            .then(function (d) {
                if (d && d.ok) {
                    status.textContent = 'Cancelled';
                    status.className = 'tk-save is-ok';
                    return reload();
                }
                if (unheard(d)) return ask();
                failed(yes, d.error);
            })
            .catch(ask);
        });

        /* bookingRow exposes a clear Reschedule button on the collapsed card.
           It calls this same path rather than maintaining a second scheduler. */
        wrap.openReschedule = openMove;
        wrap.canReschedule = !!moveBtn;
        return wrap;
    }

    /* Each of these is a real state rather than a generic failure: the time
       went stale between loading the list and choosing from it, the visit is
       too close to change without a person, or it is already gone. */
    function changeError(code) {
        if (code === 'bad_slot')  return 'That time is no longer available. Please pick another.';
        if (code === 'too_late')  return 'That visit is too soon to change online. Please call us.';
        if (code === 'cancelled') return 'That visit is already cancelled.';
        if (code === 'closed')    return 'That booking is finished, so it can no longer be changed.';
        return 'That did not go through. Please try again.';
    }

    /** The title line is service + date, as asked; the detail opens on click. */
    function bookingRow(b) {
        var card = el('article', 'booking-card' +
            (b.completed ? ' booking-card--done' : '') +
            (b.cancelled ? ' booking-card--cancelled' : ''));
        var det = document.createElement('details');
        det.className = 'pb' + (b.completed ? ' pb--done' : '') +
                               (b.cancelled ? ' pb--cancelled' : '');
        det.setAttribute('data-live-key', b.bookingId);

        var sum = document.createElement('summary');
        sum.className = 'pb__sum';
        var calendar = dateTile(b.date);
        var dateBox = el('span', 'pb__date');
        dateBox.appendChild(el('span', 'pb__month', calendar.month));
        dateBox.appendChild(el('span', 'pb__day', calendar.day));
        sum.appendChild(dateBox);

        var main = el('span', 'pb__main');
        main.appendChild(el('span', 'pb__title', b.serviceLabel));
        main.appendChild(el('span', 'pb__when', whenLine(b) || 'Date to be confirmed'));
        sum.appendChild(main);

        var statusText = b.cancelled ? 'Cancelled' : b.completed ? 'Complete' : 'Upcoming';
        var statusClass = 'pb__status pb__status--' +
            (b.cancelled ? 'cancelled pb__tag' : b.completed ? 'complete' : 'upcoming');
        sum.appendChild(el('span', statusClass, statusText));
        var price = money(b.price);
        /* The summary is the line a customer scans without opening anything,
           so it has to distinguish money TAKEN from money merely held — those
           mean different things to somebody checking their balance. */
        if (price) sum.appendChild(el('span', 'pb__price',
            price + (b.paid ? ' · paid'
                   : b.authorized ? ' · authorized'
                   : b.refunded ? ' · refunded' : '')));
        det.appendChild(sum);
        card.appendChild(det);

        var inner = el('div', 'pb__body');
        if (b.propertyLabel) add(inner, line('Home', b.propertyLabel));
        if (b.addOns) add(inner, line('Add-ons', b.addOns));
        /* One definition, in serve-scope.js beside the data it renders. */
        if (typeof ServeScope !== 'undefined') {
            add(inner, ServeScope.block(b.serviceCode, b.serviceLabel));
        }
        /* r43. Called off. It keeps its summary line, so the customer can see
           what it was they cancelled, and carries nothing that could be acted
           on: no payment button, no partner card, no instructions, no controls.
           Checked BEFORE `completed` because a cancelled visit that an operator
           later stamps as completed is a data problem to look at, not a receipt
           to show the customer. */
        if (b.cancelled) {
            inner.appendChild(el('p', 'tk-note',
                'This visit was cancelled and nobody is coming. ' +
                'Book again whenever you need us.'));
            det.appendChild(inner);
            return card;
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
            add(inner, partnerNotes(b));
            add(inner, line('Completed', prettyDate(b.completed) || b.completed));
            add(inner, line('Payment', b.paid ? 'Paid'
                                     : b.authorized ? 'Card authorized'
                                     : b.refunded ? 'Refunded' : 'Due'));
            inner.appendChild(el('p', 'tk-note',
                'Finished bookings are a record — they can no longer be edited.'));
            det.appendChild(inner);
            return card;
        }

        /* FOUR STATES, AND THE TWO MIDDLE ONES ARE THE WHOLE POINT.
           Before payment state was written back (r50), this page could only
           say "Paid" or "Not yet authorized" — so a customer who had
           authorized two minutes earlier was told they had not, with the
           button still there inviting a second hold on the same card. The
           button disappears the moment Stripe confirms the hold, which is the
           only version of this a real customer can trust.

           REFUNDED IS THE SAME BUG WEARING A DIFFERENT HAT, found 2026-09-24
           by running a real card all the way through. The sheet has recorded
           `refunded` since r50, but it reached no view model, so a customer
           who had paid and been refunded was shown "Not yet authorized" and a
           live Authorize button — an invitation to put a fresh hold on a
           booking somebody had deliberately refunded.

           A REFUND IS NOT A RELEASED HOLD, and that is why it gets its own
           line rather than reusing the blank one. A released hold means no
           money ever moved; a refund means money moved and a person decided
           to hand it back. Only one of those should be quietly re-payable. */
        add(inner, line('Payment', b.paid ? 'Paid'
                                 : b.authorized ? 'Card authorized'
                                 : b.refunded ? 'Refunded'
                                 : 'Not yet authorized'));
        if (b.authorized) add(inner, authorizedNote(b));
        if (b.refunded) inner.appendChild(el('p', 'tk-note',
            'This visit was paid for and the payment has been refunded. ' +
            'Nothing further is owed. Get in touch if you would like to book it again.'));
        /* NOT offered after a refund. Re-charging a booking a human chose to
           refund is a decision for a person, not a button a customer can press
           by accident on the page that just told them they got their money
           back. */
        if (!b.paid && !b.authorized && !b.refunded && Number(b.price) > 0) {
            inner.appendChild(payBlock(b));
        }

        /* Who is coming. The portal is the link the confirmation email
           actually sends, so this is the surface that has to answer it —
           and when nobody is assigned yet it says so, rather than leaving
           the question unanswered. */
        inner.appendChild(el('h3', 'pb__h', 'Your service partner'));
        inner.appendChild(ServePartner.block(b.partner));
        add(inner, partnerNotes(b));

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

        /* Last in the panel, deliberately. Everything above is something the
           customer is adding to the visit; this is the pair of actions that
           change whether it happens at all. */
        var schedule = scheduleControls(b);
        add(inner, schedule);

        det.appendChild(inner);

        var actions = el('div', 'pb__actions');
        var view = el('button', 'pb__action pb__action--primary', 'View details');
        view.type = 'button';
        function updateViewLabel() {
            view.textContent = det.open ? 'Hide details' : 'View details';
        }
        view.addEventListener('click', function () {
            det.open = !det.open;
            updateViewLabel();
        });
        det.addEventListener('toggle', updateViewLabel);
        actions.appendChild(view);

        if (schedule.canReschedule) {
            var reschedule = el('button', 'pb__action pb__action--secondary', 'Reschedule');
            reschedule.type = 'button';
            reschedule.addEventListener('click', function () {
                det.open = true;
                updateViewLabel();
                schedule.openReschedule();
            });
            actions.appendChild(reschedule);
            card.className += ' booking-card--actionable';
        }
        card.appendChild(actions);
        return card;
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

    /* What somebody sees INSTEAD of the button, once the hold is on. It has to
       answer the two questions a person actually has at that moment — has my
       money gone, and when will it — because "Card authorized" alone reads
       like a charge to most people. FOUNDER COPY: this is a promise about when
       a real card is charged, and the wording is open to change. */
    function authorizedNote(b) {
        return el('p', 'tk-note',
            'Your card is authorized for ' + money(b.price) + '. Nothing has ' +
            'been charged yet — we take payment once your cleaner confirms ' +
            'the job. Cancel and the hold is released.');
    }

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

    /* What the cleaner noted on the job ticket, room by room. From the
       company, never a named person — the model carries no author. */
    function partnerNotes(b) {
        var notes = b.partnerNotes || [];
        if (!notes.length) return null;
        var blk = el('div', 'tk-blk');
        blk.appendChild(el('div', 'tk-lbl', 'Notes from your service partner'));
        notes.forEach(function (n) { blk.appendChild(el('div', 'tk-val', n.roomLabel + ': ' + n.note)); });
        return blk;
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
