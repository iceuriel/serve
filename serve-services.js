/**
 * Serve — the service catalogue.
 * ==================================================================
 * ONE PLACE THAT DECIDES WHAT SERVE SAYS IT DOES.
 *
 * The homepage service grid, the category chooser in the booking flow, and
 * anything added later all read this array. Turning a category on is editing
 * one `status` field here — not hunting for the same words in three files and
 * finding two of them.
 *
 * THE STATUS FIELD IS A PROMISE, NOT A LABEL.
 *
 *   'live'     Bookable right now, end to end, at a price the site quotes.
 *              Today this is cleaning and nothing else.
 *
 *   'request'  NOT bookable, but a real person will answer and there is
 *              someone to call. Only set this when that is true — it puts a
 *              form in front of a customer and commits somebody to replying.
 *
 *   'planned'  Named so the direction is legible. Explicitly not orderable,
 *              and it must never render as though it were.
 *
 * Nothing here may claim capability the business does not have. A category
 * moved to 'live' before it can actually be delivered turns the whole page
 * into a lie, and the page is the only thing a first customer has to go on.
 */
(function (global) {
    'use strict';

    const SERVICES = [
        {
            id: 'cleaning',
            name: 'Cleaning',
            status: 'live',
            /* Shown on the card. Kept to one line — the grid is scanned, not read. */
            blurb: 'Recurring upkeep, first deep cleans, and move-in / move-out.',
            /* Where the card sends someone. Only 'live' categories get a link. */
            href: '/services',
            /* Names the line drawing this category wears. NOT READ BY ANYTHING
               YET — the homepage grid carries its icons inline, because that
               markup has to exist before JavaScript runs. This is here so the
               day a chooser renders cards from data there is already one name
               per category rather than a second list invented to match. */
            icon: 'spray',
        },
        {
            id: 'handyman',
            name: 'Handyman',
            status: 'planned',
            blurb: 'Mounting, patching, doors, and the small jobs that pile up.',
            icon: 'wrench',
        },
        {
            id: 'plumbing',
            name: 'Plumbing',
            status: 'planned',
            blurb: 'Leaks, fixtures, drains, and water heaters.',
            icon: 'drop',
        },
        {
            id: 'hvac',
            name: 'Heating & Cooling',
            status: 'planned',
            blurb: 'Seasonal service, filters, and the call you make in July.',
            icon: 'thermo',
        },
        {
            id: 'electrical',
            name: 'Electrical',
            status: 'planned',
            blurb: 'Fixtures, switches, and panel work by a licensed pro.',
            icon: 'bolt',
        },
        {
            id: 'landscaping',
            name: 'Lawn & Snow',
            status: 'planned',
            blurb: 'Mowing through the summer, plowing through the winter.',
            icon: 'leaf',
        },
    ];

    const LABELS = {
        live:    'Available now',
        request: 'By request',
        planned: 'Coming to Serve',
    };

    /**
     * The categories a customer can actually book today.
     *
     * The booking flow asks this before deciding whether to show a category
     * chooser at all. With one live service a chooser is a screen with one
     * button on it — pure friction in front of the thing that earns money. The
     * day a second goes live the chooser appears on its own, with no markup
     * change anywhere.
     */
    function liveServices() {
        return SERVICES.filter(s => s.status === 'live');
    }

    /** True once there is a genuine choice to make. */
    function needsCategoryStep() {
        return liveServices().length > 1;
    }

    function byId(id) {
        return SERVICES.filter(s => s.id === id)[0] || null;
    }

    global.ServeServices = {
        all: () => SERVICES.slice(),
        live: liveServices,
        needsCategoryStep: needsCategoryStep,
        byId: byId,
        label: (status) => LABELS[status] || '',
    };
}(typeof window !== 'undefined' ? window : globalThis));

/* Node's require() for the test suite. Guarded, and deliberately NOT the
   pattern that took the site down on 2026-09-02 — that failure was a Worker
   bundling a classic script as ESM, where `module` is undefined at import
   time. This file is never bundled into the Worker; it is a browser script the
   tests happen to read. See gotcha_wrangler_classic_script_imports. */
if (typeof module !== 'undefined' && module.exports) {
    module.exports = (typeof window !== 'undefined' ? window : globalThis).ServeServices;
}
