/* Serve — the scope of work, and the block that shows it
   =================================================================
   WHAT EACH SERVICE INCLUDES. One array, three services, one mark per pair.

     1 = included     0 = not included     2 = paid add-on

   IT LIVES IN ITS OWN FILE BECAUSE IT HAS FOUR READERS AND ONLY ONE OF THEM
   LOADS script.js. The room-by-room matrix on /services renders from it, and so
   now do the customer portal (/h) and the per-job ticket (/j) — pages that
   carry a signed token and deliberately load nothing from the marketing
   bundle. Leaving the data in script.js meant those two could not answer "what
   am I actually getting?" without a second copy of the list, and a second copy
   is a second thing to forget to update.

   THE RENDERER LIVES HERE TOO, for the same reason scheduleHead lives in one
   file: two pages building their own version of the same block is how they
   drift into describing one booking differently. /h and /j both call
   ServeScope.block().

   Fridge and oven interiors are coded 2 on First Clean because the calculator
   sells them there as $45 / $40 toggles (PRICING.ADDONS), and 1 on move-in/out
   because that service bundles them into its multiplier. Linen change is 1 on
   recurring (free, per the plan), 0 on First Clean, and 0 on move-in/out, where
   there are no beds to make.

   A task added here appears everywhere it should. A task removed disappears
   from a customer's ticket the moment it stops being true.
   ----------------------------------------------------------------- */
const SERVE_SCOPE = [
    { group: 'Kitchen', tasks: [
        { task: 'Counters, backsplash, and sink degreased', deep: 1, recurring: 1, moveinout: 1 },
        { task: 'Exterior of all appliances',               deep: 1, recurring: 1, moveinout: 1 },
        { task: 'Stovetop and range hood',                  deep: 1, recurring: 1, moveinout: 1 },
        { task: 'Inside the fridge',                        deep: 2, recurring: 0, moveinout: 1 },
        { task: 'Inside the oven',                          deep: 2, recurring: 0, moveinout: 1 },
        { task: 'Inside cabinets and drawers',              deep: 0, recurring: 0, moveinout: 1 },
    ]},
    { group: 'Bathrooms', tasks: [
        { task: 'Toilet, tub, and sink disinfected',        deep: 1, recurring: 1, moveinout: 1 },
        { task: 'Mirrors and fixtures polished',            deep: 1, recurring: 1, moveinout: 1 },
        { task: 'Shower glass and tile detailed',           deep: 1, recurring: 0, moveinout: 1 },
        { task: 'Grout scrubbed and brightened',            deep: 1, recurring: 0, moveinout: 1 },
    ]},
    { group: 'Bedrooms &amp; living', tasks: [
        { task: 'Surfaces dusted, floors vacuumed',         deep: 1, recurring: 1, moveinout: 1 },
        { task: 'Under and behind movable furniture',       deep: 1, recurring: 0, moveinout: 1 },
        { task: 'Closets and shelving',                     deep: 0, recurring: 0, moveinout: 1 },
        { task: 'Linen change',                             deep: 0, recurring: 1, moveinout: 0 },
    ]},
    { group: 'Throughout', tasks: [
        { task: 'Floors vacuumed and mopped',               deep: 1, recurring: 1, moveinout: 1 },
        { task: 'Baseboards and door frames',               deep: 1, recurring: 0, moveinout: 1 },
        { task: 'Switch plates and handles',                deep: 1, recurring: 0, moveinout: 1 },
        { task: 'Interior windows, sills, and tracks',      deep: 0, recurring: 0, moveinout: 1 },
    ]},
];

(function (root) {
    'use strict';

    /* The service codes the webhook speaks, against the columns above. Written
       out rather than derived: a code the matrix has no column for must render
       NOTHING, not a wrong list, and an explicit map is what makes that the
       default rather than an accident. */
    var COLUMN = {
        CLEAN_DEEP:     'deep',
        CLEAN_STANDARD: 'recurring',
        CLEAN_MOVEOUT:  'moveinout',
    };

    /**
     * What one service includes, as two flat lists.
     *
     * Flat rather than grouped on purpose: the group labels carry HTML entities
     * that are correct for the matrix's innerHTML and would render literally
     * through textContent, which is how the token-bearing pages build every
     * node they own.
     *
     * Returns null for a service this file has no column for, so a caller
     * renders nothing rather than another service's promises.
     */
    function forService(code) {
        var key = COLUMN[String(code || '').toUpperCase()];
        if (!key) return null;
        var included = [], addOns = [];
        SERVE_SCOPE.forEach(function (group) {
            group.tasks.forEach(function (t) {
                if (t[key] === 1)      included.push(t.task);
                else if (t[key] === 2) addOns.push(t.task);
            });
        });
        return { included: included, addOns: addOns };
    }

    function el(tag, cls, text) {
        var n = document.createElement(tag);
        if (cls) n.className = cls;
        if (text !== undefined && text !== null && text !== '') n.textContent = String(text);
        return n;
    }

    /**
     * "What's included", for one booking's own service.
     *
     * NOT CALLED "SCOPE": the partner ticket already has a section by that name
     * and it means the rooms and their instructions. Two sections called Scope
     * meaning different things is worse than a longer word.
     *
     * Closed by default. Someone opening their portal wants the date and the
     * price; what a deep clean covers is the second question and it is a long
     * answer. Returns null when the service has no column, so the caller adds
     * nothing rather than an empty box.
     */
    function block(serviceCode, serviceLabel) {
        var scope = forService(serviceCode);
        if (!scope || !scope.included.length) return null;

        var det = document.createElement('details');
        det.className = 'sc';
        var sum = document.createElement('summary');
        sum.className = 'sc__sum';
        sum.textContent = "What's included" +
            (serviceLabel ? ' in your ' + String(serviceLabel).toLowerCase() : '');
        det.appendChild(sum);

        var body = el('div', 'sc__body');
        var ul = el('ul', 'sc__list');
        scope.included.forEach(function (task) { ul.appendChild(el('li', null, task)); });
        body.appendChild(ul);

        /* Add-ons are named as what they are. A customer reading "inside the
           fridge" under a heading that says "included" would be owed a fridge. */
        if (scope.addOns.length) {
            body.appendChild(el('div', 'sc__h', 'Available as paid add-ons'));
            var extra = el('ul', 'sc__list sc__list--addon');
            scope.addOns.forEach(function (task) { extra.appendChild(el('li', null, task)); });
            body.appendChild(extra);
        }
        det.appendChild(body);
        return det;
    }

    root.ServeScope = { forService: forService, block: block, ALL: SERVE_SCOPE };
})(typeof window !== 'undefined' ? window : globalThis);
