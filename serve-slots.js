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
    var pickerSerial = 0;

    /* How many DAYS WITH OPEN TIMES the agenda shows before it asks. Days, not
       slots: a day with six times and a day with one cost the same heading and
       the same line of chips, and it is the stack of days that runs the page
       long. Not calendar days either — the agenda only ever draws days that
       have something open, so this counts what is actually on screen.

       SEVEN IS A WEEK, which is the window a customer is usually choosing
       inside anyway. It is a display rule and nothing more: every slot the feed
       published is already in the DOM, filtered by the horizon rules above and
       reachable in one click. Nothing here narrows what is bookable. */
    var VISIBLE_DAYS = 7;

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

    function slotDateParts(str) {
        var d = parseSlotDate(str);
        return {
            weekday: d.toLocaleDateString('en-US', { weekday: 'short' }),
            month: d.toLocaleDateString('en-US', { month: 'short' }).toUpperCase(),
            day: String(d.getDate()),
        };
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
     *
     * In the default portal layout, the agenda folds past the seventh day. The
     * extra days are BUILT AND HIDDEN, never withheld: their chips carry the
     * same listeners and answer the same queries as the visible ones. The
     * booking form's carousel instead keeps every date in its horizontal rail
     * and opens one day's times at a time. Both variants build every real slot
     * up front, so neither can reveal an unwired placeholder later.
     */
    function picker(slots, onPick, options) {
        options = options || {};
        var carousel = options.layout === 'carousel';
        var wrap = document.createElement('div');
        wrap.className = 'slotpick' + (carousel ? ' slotpick--carousel' : '');

        /* The public booking form needs to fit inside a 600px card, where the
           portal's full day cards turn into a tall wall of repeated boxes.
           Its carousel is an alternate VIEW of the same slots: every date is
           in one horizontally scrollable rail and only the active date's
           times are open below it. The default remains the portal layout. */
        var dateTrack = null, panels = null, railViewport = null;
        if (carousel) {
            pickerSerial += 1;
            var rail = document.createElement('div');
            rail.className = 'slotpick__rail';

            var previous = document.createElement('button');
            previous.type = 'button';
            previous.className = 'slotpick__arrow slotpick__arrow--previous';
            previous.textContent = '\u2039';
            previous.setAttribute('aria-label', 'See earlier available days');

            railViewport = document.createElement('div');
            railViewport.className = 'slotpick__viewport';
            railViewport.setAttribute('aria-label', 'Available days');

            dateTrack = document.createElement('div');
            dateTrack.className = 'slotpick__track';
            dateTrack.setAttribute('role', 'tablist');
            railViewport.appendChild(dateTrack);

            var next = document.createElement('button');
            next.type = 'button';
            next.className = 'slotpick__arrow slotpick__arrow--next';
            next.textContent = '\u203a';
            next.setAttribute('aria-label', 'See later available days');

            function moveRail(direction) {
                var distance = Math.max(220, (railViewport.clientWidth || 320) * 0.78);
                if (typeof railViewport.scrollBy === 'function') {
                    railViewport.scrollBy({ left: direction * distance, behavior: 'smooth' });
                } else {
                    railViewport.scrollLeft = (railViewport.scrollLeft || 0) + direction * distance;
                }
            }
            previous.addEventListener('click', function () { moveRail(-1); });
            next.addEventListener('click', function () { moveRail(1); });

            rail.appendChild(previous);
            rail.appendChild(railViewport);
            rail.appendChild(next);
            wrap.appendChild(rail);

            panels = document.createElement('div');
            panels.className = 'slotpick__panels';
            wrap.appendChild(panels);
        }

        var currentDate = null, rowEl = null;
        var days = [], dayButtons = [];
        (slots || []).forEach(function (s) {
            if (s.date !== currentDate) {
                currentDate = s.date;
                var day = document.createElement('div');
                day.className = 'scheduler-day' + (carousel ? ' scheduler-day--panel' : '');
                days.push(day);
                var head = document.createElement(carousel ? 'button' : 'div');
                head.className = 'scheduler-day__head' + (carousel ? ' slotpick__day-button' : '');
                head.setAttribute('aria-label', formatSlotDate(s.date));
                var parts = slotDateParts(s.date);
                var weekday = document.createElement('span');
                weekday.className = 'scheduler-day__weekday';
                weekday.textContent = parts.weekday;
                var date = document.createElement('span');
                date.className = 'scheduler-day__date';
                var month = document.createElement('span');
                month.className = 'scheduler-day__month';
                month.textContent = parts.month;
                var number = document.createElement('span');
                number.className = 'scheduler-day__number';
                number.textContent = parts.day;
                date.appendChild(month);
                date.appendChild(number);
                head.appendChild(weekday);
                head.appendChild(date);
                rowEl = document.createElement('div');
                rowEl.className = 'scheduler-day__times';
                if (carousel) {
                    var dayNumber = days.length;
                    var tabId = 'serve-slot-day-' + pickerSerial + '-' + dayNumber;
                    var panelId = 'serve-slot-times-' + pickerSerial + '-' + dayNumber;
                    head.type = 'button';
                    head.setAttribute('id', tabId);
                    head.setAttribute('role', 'tab');
                    head.setAttribute('aria-controls', panelId);
                    head.setAttribute('aria-selected', 'false');
                    head.setAttribute('data-date', s.date);
                    day.setAttribute('id', panelId);
                    day.setAttribute('role', 'tabpanel');
                    day.setAttribute('aria-labelledby', tabId);

                    var timeLabel = document.createElement('p');
                    timeLabel.className = 'slotpick__times-label';
                    timeLabel.textContent = 'Available times for ' + formatSlotDate(s.date);
                    day.appendChild(timeLabel);
                    day.appendChild(rowEl);
                    day.hidden = true;
                    dateTrack.appendChild(head);
                    panels.appendChild(day);
                    dayButtons.push(head);
                } else {
                    day.appendChild(head);
                    day.appendChild(rowEl);
                    wrap.appendChild(day);
                }
            }
            var chip = document.createElement('button');
            chip.type = 'button';
            chip.className = 'slot-chip';
            chip.textContent = s.time;
            chip.setAttribute('data-date', s.date);
            chip.setAttribute('data-time', s.time);
            chip.setAttribute('aria-pressed', 'false');
            /* THE DATE HAS TO BE IN THE NAME, not only in the layout.
               The visible chip says "9:00 AM" and the date it belongs to is
               two elements away in .scheduler-day__head — fine for an eye
               scanning a column, useless to anything reading names. Three
               weeks of slots collapsed to exactly TWO distinct accessible
               names, "9:00 AM" and "1:30 PM", repeated seven times each.

               Found 2026-09-24 by driving the booking flow as an agent would.
               Somebody told to book Saturday at nine sees seven identical
               buttons and has to infer the day from pixel position; pick the
               wrong one and the booking is for the wrong date, silently,
               because the confirmation looks correct either way. A screen
               reader user has had exactly this problem all along.

               formatSlotDate is reused rather than a second format invented
               here — the day heading above already labels itself with it, so
               the two cannot drift apart. */
            chip.setAttribute('aria-label', formatSlotDate(s.date) + ' at ' + s.time);
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

        if (carousel && days.length) {
            function activateDay(index) {
                days.forEach(function (d, i) { d.hidden = i !== index; });
                dayButtons.forEach(function (b, i) {
                    var active = i === index;
                    b.className = 'scheduler-day__head slotpick__day-button' +
                        (active ? ' is-active' : '');
                    b.setAttribute('aria-selected', active ? 'true' : 'false');
                });
            }
            dayButtons.forEach(function (button, index) {
                button.addEventListener('click', function () { activateDay(index); });
            });
            activateDay(0);
        }

        /* Only fold the portal/card layout when there is something to fold.
           The booking carousel contains every day in its horizontal rail, so
           it never needs a second "show more" interaction. Exactly
           VISIBLE_DAYS days leaves `rest` empty and the agenda is drawn whole. */
        var rest = carousel ? [] : days.slice(VISIBLE_DAYS);
        if (rest.length) {
            rest.forEach(function (d) { d.hidden = true; });

            var more = document.createElement('button');
            /* TYPE="BUTTON" IS LOAD-BEARING. On the booking page this agenda
               lives inside <form id="reserve-form">, where a button with no
               type is a SUBMIT button — "show more days" would try to reserve
               the visit. The chips above declare it for the same reason. */
            more.type = 'button';
            more.className = 'slotpick__more';
            /* Say the number. "Show more" leaves a customer guessing whether
               it is worth a click; "Show 9 more days" is the reason to click,
               and it is also how somebody scanning for a date three weeks out
               knows the page has one. */
            more.textContent = 'Show ' + rest.length + ' more ' +
                (rest.length === 1 ? 'day' : 'days');
            more.setAttribute('aria-expanded', 'false');

            /* ONE WAY ON PURPOSE. A collapse would have to decide what happens
               to a time the customer already picked down there — hide their
               own selection, or silently drop it — and neither is worth the
               few hundred pixels back. */
            more.addEventListener('click', function () {
                rest.forEach(function (d) { d.hidden = false; });
                more.setAttribute('aria-expanded', 'true');
                more.hidden = true;
            });
            wrap.appendChild(more);
        }

        return wrap;
    }

    root.ServeSlots = {
        HORIZON_DAYS:   HORIZON_DAYS,
        VISIBLE_DAYS:   VISIBLE_DAYS,
        filterSlots:    filterSlots,
        parseSlotDate:  parseSlotDate,
        formatSlotDate: formatSlotDate,
        load:           load,
        picker:         picker,
    };
})(typeof window !== 'undefined' ? window : globalThis);
