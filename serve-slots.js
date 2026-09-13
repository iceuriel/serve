/* Serve — bookable times, and the agenda that shows them
   =================================================================
   WHEN CAN SOMEBODY ACTUALLY COME? Two pages now ask that question: the
   booking form on the marketing site, and the customer portal at /h, where
   confirming a recurring plan means choosing a time for the next visit.

   THE HORIZON RULES LIVE HERE BECAUSE THERE ARE TWO ASKERS. A slot is
   bookable if the feed says somebody is open, the day has not already passed,
   and it falls inside the three-week horizon. Those three rules decide what a
   customer is allowed to pick, and two copies of them is how one page starts
   offering a date the other refuses — silently, because both would look fine
   in isolation. filterSlots() moved out of script.js for exactly the reason
   SERVE_SCOPE did: /h carries a signed token and loads nothing from the
   marketing bundle, so the data and the rules were unreachable from the page
   that needed them next.

   HORIZON_DAYS MUST NOT EXCEED DAYS_AHEAD IN availability.gs. The feed
   publishes 21 days; asking for more here would simply show nothing past the
   feed's own edge, which reads as "no availability" rather than as a
   misconfiguration.

   EVERY FAILURE IS AN EMPTY LIST, NEVER A THROW. That is load-bearing on both
   callers: the booking form answers an empty list by falling back to the
   earlier/later radios, and the portal answers it by saying it cannot show
   times right now and offering the phone number. A scheduler that throws
   would take the surrounding page down with it, which is how a degraded feed
   becomes a lost booking.
   ----------------------------------------------------------------- */
(function (root) {
    'use strict';

    /* Must not exceed DAYS_AHEAD in /apps-script/availability.gs. */
    var HORIZON_DAYS = 21;
    var TIMEOUT_MS   = 8000;

    /* "2026-07-25" -> a LOCAL Date. Never new Date(str): that parses as UTC
       midnight, which is the previous day in Boston, and a slot published for
       the 25th would be filtered out on the 25th. */
    function parseSlotDate(str) {
        var p = String(str).split('-');
        return new Date(+p[0], +p[1] - 1, +p[2]);
    }

    function formatSlotDate(str) {
        return parseSlotDate(str).toLocaleDateString('en-US', {
            weekday: 'long', month: 'short', day: 'numeric',
        });
    }

    /* Bookable = open > 0, today through the three-week horizon. */
    function filterSlots(slots) {
        if (!slots || !slots.length) return [];
        var today = new Date();
        today.setHours(0, 0, 0, 0);
        var horizon = new Date(today);
        horizon.setDate(horizon.getDate() + HORIZON_DAYS);
        return slots.filter(function (s) {
            if (!s || !s.date || !s.time || !(s.open > 0)) return false;
            var d = parseSlotDate(s.date);
            return isFinite(d.getTime()) && d >= today && d <= horizon;
        });
    }

    /**
     * Fetch the feed and return the bookable slots. Resolves to [] on every
     * failure mode there is — unreachable, slow, non-200, unparseable, ok:false,
     * or simply nothing open. The caller decides what an empty list means for
     * its page; it never has to decide what an exception means.
     *
     * The timeout is the one that matters. An endpoint that ERRORS is harmless;
     * an endpoint that HANGS would otherwise leave a customer looking at
     * "Loading times…" forever with no way forward.
     */
    function load(url, timeoutMs) {
        if (!url || typeof fetch !== 'function') return Promise.resolve([]);

        var ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
        var timer = setTimeout(function () { if (ctrl) ctrl.abort(); },
                               timeoutMs || TIMEOUT_MS);

        return fetch(url, { signal: ctrl ? ctrl.signal : undefined })
            .then(function (r) {
                if (!r.ok) throw new Error('HTTP ' + r.status);
                return r.json();
            })
            .then(function (data) {
                clearTimeout(timer);
                if (!data || data.ok !== true || !Array.isArray(data.slots)) return [];
                return filterSlots(data.slots);
            })
            .catch(function (err) {
                clearTimeout(timer);
                console.warn('availability unavailable', err);
                return [];
            });
    }

    /**
     * The agenda: one section per day, one chip per open time.
     *
     * Returns a wrapper element rather than writing into one, so a caller can
     * put it wherever it likes. The chips carry data-date / data-time and the
     * same class names the booking form's stylesheet already defines — the
     * markup is the contract between the two pages, and duplicating the look
     * would be the first step to two schedulers that behave differently.
     *
     * onPick is OPTIONAL. Given one, this owns selection: exactly one chip is
     * pressed at a time and the callback receives the chosen date and time.
     * Omitted, no listener is attached at all — which is what a caller with its
     * own delegated click handler needs, and attaching one anyway would mean
     * two handlers fighting over the same click.
     */
    function picker(slots, onPick) {
        var wrap = document.createElement('div');
        wrap.className = 'slotpick';

        var currentDate = null, rowEl = null;
        (slots || []).forEach(function (s) {
            if (s.date !== currentDate) {
                currentDate = s.date;
                var day = document.createElement('div');
                day.className = 'scheduler-day';
                var head = document.createElement('div');
                head.className = 'scheduler-day__head';
                head.textContent = formatSlotDate(s.date);
                rowEl = document.createElement('div');
                rowEl.className = 'scheduler-day__times';
                day.appendChild(head);
                day.appendChild(rowEl);
                wrap.appendChild(day);
            }
            var chip = document.createElement('button');
            chip.type = 'button';
            chip.className = 'slot-chip';
            chip.textContent = s.time;
            chip.setAttribute('data-date', s.date);
            chip.setAttribute('data-time', s.time);
            chip.setAttribute('aria-pressed', 'false');
            if (onPick) {
                chip.addEventListener('click', function () {
                    (wrap.querySelectorAll('.slot-chip') || []).forEach(function (c) {
                        c.className = 'slot-chip';
                        c.setAttribute('aria-pressed', 'false');
                    });
                    chip.className = 'slot-chip is-selected';
                    chip.setAttribute('aria-pressed', 'true');
                    onPick(s.date, s.time);
                });
            }
            rowEl.appendChild(chip);
        });

        return wrap;
    }

    root.ServeSlots = {
        HORIZON_DAYS:   HORIZON_DAYS,
        filterSlots:    filterSlots,
        parseSlotDate:  parseSlotDate,
        formatSlotDate: formatSlotDate,
        load:           load,
        picker:         picker,
    };
})(typeof window !== 'undefined' ? window : globalThis);
