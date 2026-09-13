/* Serve — "who is coming" block
   =================================================================
   Shared by the per-job ticket (/j) and the customer portal (/h).

   IT IS ITS OWN FILE BECAUSE IT SHIPPED IN ONLY ONE OF THEM. The block was
   written into ticket.js — but since r14 the booking confirmation sends the
   PORTAL link, not the per-job link, whenever the customer has a contact_id.
   So the page every customer actually opens never had it, and the one that did
   was a page they no longer receive. One definition loaded by both pages
   removes the way that happened.

   COMPANY ONLY. No individual is ever named here — see the joint-employer note
   in webhook.gs. The view model does not carry an operator name, and this file
   would have nothing to render even if somebody asked it to. */
(function (root) {
    'use strict';

    function el(tag, cls, text) {
        var n = document.createElement(tag);
        if (cls) n.className = cls;
        if (text !== undefined && text !== null && text !== '') n.textContent = String(text);
        return n;
    }

    var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
                  'July', 'August', 'September', 'October', 'November', 'December'];

    /**
     * "2026-07-01" -> "July 2026".
     *
     * A customer wants to know roughly how long this company has worked with
     * Serve, and a day number answers a question nobody asked. Anything that is
     * not a full date is passed through untouched — partner_since is often just
     * a year ("2024"), and a bare year is already the shortest true thing to
     * say about a relationship.
     */
    function sinceLabel(v) {
        var s = String(v || '').trim();
        var m = /^(\d{4})-(\d{2})(?:-\d{2})?$/.exec(s);
        if (!m) return s;
        var name = MONTHS[Number(m[2]) - 1];
        return name ? name + ' ' + m[1] : s;
    }

    /** The assigned partner: logo, name, blurb, and the facts Serve stands behind. */
    function card(v) {
        var wrap = el('div', 'tk-partner');

        /* The logo is a file an operator placed in images/ — a vendor cannot
           write to the repo, and logo_url is not in VENDOR_EDITABLE, so this
           URL is one of ours. alt is the company name, so a broken image still
           says who is coming. */
        if (v.logoUrl) {
            var lg = el('img', 'tk-partner__logo');
            lg.src = v.logoUrl;
            lg.alt = v.displayName;
            lg.loading = 'lazy';
            wrap.appendChild(lg);
        }

        wrap.appendChild(el('div', 'tk-partner__name', v.displayName));
        if (v.publicDescription) wrap.appendChild(el('p', 'tk-partner__desc', v.publicDescription));

        var facts = [];
        if (v.partnerSince) facts.push('With Serve since ' + sinceLabel(v.partnerSince));
        if (v.insuranceVerified) facts.push('Bonded & insured');
        /* A rating of 0 is "no rating", not zero stars. WHERE IT CAME FROM IS
           PART OF THE CLAIM: a bare number beside Serve's own name reads as
           Serve's own score, so a rating carried over from Google says so. */
        if (v.rating) {
            facts.push(v.rating + '★' +
                       (v.reviewCount ? ' (' + v.reviewCount + ')' : '') +
                       (v.ratingSource ? ' on ' + v.ratingSource : ''));
        }
        if (facts.length) wrap.appendChild(el('div', 'tk-partner__facts', facts.join(' · ')));

        return wrap;
    }

    /** No partner assigned yet.

        THIS IS EVERY PREFERENCE BOOKING, not an edge case: a booking with no
        specific time has no availability row to consume, so there is nobody to
        consume it and dispatch stays manual. The copy it replaced — "will be
        confirmed before your appointment" — reads as nothing happening, when
        what is happening is the product.

        Everything that moves is decorative and aria-hidden, and all of it stops
        under prefers-reduced-motion. The animation is CSS: a render that owned
        a timer would keep running on a backgrounded phone tab. */
    function seeking() {
        var wrap  = el('div', 'tk-seek');
        var stage = el('div', 'tk-seek__stage');

        var phone  = el('div', 'tk-seek__phone');
        var screen = el('div', 'tk-seek__screen');
        var mark   = el('img', 'tk-seek__mark');
        mark.src = '/images/favicon.svg';
        mark.alt = '';                       /* decorative — the copy carries it */
        screen.appendChild(mark);
        phone.appendChild(screen);
        stage.appendChild(phone);

        /* Two arcs a side, staggered. One ring reads as a pulse rather than as
           sound leaving the handset. */
        ['l', 'r'].forEach(function (side) {
            for (var i = 1; i <= 2; i++) {
                var w = el('span', 'tk-seek__wave tk-seek__wave--' + side + ' is-' + i);
                w.setAttribute('aria-hidden', 'true');
                stage.appendChild(w);
            }
        });

        for (var c = 1; c <= 3; c++) {
            var coin = el('span', 'tk-seek__coin is-' + c, '$');
            coin.setAttribute('aria-hidden', 'true');
            stage.appendChild(coin);
        }

        wrap.appendChild(stage);
        wrap.appendChild(el('div', 'tk-seek__title', 'Coordinating with our vendor network'));
        wrap.appendChild(el('p', 'tk-seek__msg',
            'We’re negotiating with trusted local partners to find the best fit ' +
            'for your home. Their details will appear here before your visit.'));
        return wrap;
    }

    /** What both callers want: whichever of the two is true right now. */
    function block(partner) {
        return partner ? card(partner) : seeking();
    }

    root.ServePartner = { card: card, seeking: seeking, block: block };
})(window);
