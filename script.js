/* ============================================================
   SERVE CLEANING — Main Script
   Vanilla JS only. No frameworks or dependencies.
   ============================================================ */


/* --- Mobile Nav Toggle --- */
(function () {
    const hamburger = document.querySelector('.nav__hamburger');
    const mobileMenu = document.getElementById('mobile-menu');

    if (!hamburger || !mobileMenu) return;

    hamburger.addEventListener('click', function () {
        const isOpen = mobileMenu.classList.toggle('open');
        hamburger.setAttribute('aria-expanded', String(isOpen));
    });

    // Close menu when a link inside it is clicked
    mobileMenu.querySelectorAll('a').forEach(function (link) {
        link.addEventListener('click', function () {
            mobileMenu.classList.remove('open');
            hamburger.setAttribute('aria-expanded', 'false');
        });
    });
})();


/* --- Quote Form --- */
(function () {
    const form       = document.getElementById('quote-form');
    const successEl  = document.getElementById('form-success');
    const errorEl    = document.getElementById('form-error');
    const submitBtn  = document.getElementById('submit-btn');

    if (!form) return;

    // Fields that must not be empty before submission
    const REQUIRED = ['cleaning_type', 'frequency', 'bedrooms', 'bathrooms', 'name', 'phone', 'email'];

    function getField(name) {
        return form.querySelector('[name="' + name + '"]');
    }

    function validate() {
        // Clear previous error states
        form.querySelectorAll('.error').forEach(function (el) {
            el.classList.remove('error');
        });
        errorEl.textContent = '';

        let valid = true;
        let firstBad = null;

        REQUIRED.forEach(function (name) {
            const el = getField(name);
            if (!el || !el.value.trim()) {
                if (el) el.classList.add('error');
                valid = false;
                if (!firstBad && el) firstBad = el;
            }
        });

        // Basic email format check (only if field has a value)
        const emailEl = getField('email');
        if (emailEl && emailEl.value.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailEl.value.trim())) {
            emailEl.classList.add('error');
            valid = false;
            if (!firstBad) firstBad = emailEl;
        }

        if (!valid) {
            errorEl.textContent = 'Please fill out all required fields.';
            if (firstBad) firstBad.focus();
        }

        return valid;
    }

    function buildPayload() {
        const data = {};
        new FormData(form).forEach(function (value, key) {
            data[key] = value;
        });
        data.submitted_at = new Date().toISOString();
        return data;
    }

    async function submitToGoogleSheets(payload) {
        // ----------------------------------------------------------------
        // TODO: Wire this to your Google Apps Script web app.
        //
        // Setup steps:
        //   1. Create a Google Sheet to store leads.
        //   2. In the sheet: Extensions > Apps Script.
        //   3. Paste a doPost(e) function that parses the JSON body
        //      and appends a row to the sheet.
        //   4. Deploy as a Web App (Execute as: Me, Access: Anyone).
        //   5. Copy the deployment URL and paste it below.
        //
        // The payload object sent here matches the form field names exactly,
        // so your Apps Script can map columns directly from the keys.
        // ----------------------------------------------------------------
        const GOOGLE_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbwYbRsTSiZKPyfGtlFkGIXkT5Qfkfu4yefgBOBkF21uOrDz9XFEjz8lNjwAXYkLir7z/exec';

        await fetch(GOOGLE_SCRIPT_URL, {
            method: 'POST',
            mode: 'no-cors', // Required for Google Apps Script — response will be opaque
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });

        // no-cors means we cannot read the response status.
        // Treat reaching this line as success; the Apps Script handles errors on its end.
        return true;
    }

    form.addEventListener('submit', async function (e) {
        e.preventDefault();

        if (!validate()) return;

        submitBtn.disabled = true;
        submitBtn.textContent = 'Submitting…';

        try {
            const payload = buildPayload();
            await submitToGoogleSheets(payload);

            form.hidden = true;
            successEl.hidden = false;
            successEl.scrollIntoView({ behavior: 'smooth', block: 'center' });

        } catch (err) {
            console.error('Form submission error:', err);
            errorEl.textContent = 'Something went wrong. Please try again or email us directly.';
            submitBtn.disabled = false;
            submitBtn.textContent = 'Request My Free Quote';
        }
    });

    // Clear individual field error state as the user fixes it
    form.querySelectorAll('input, select, textarea').forEach(function (el) {
        el.addEventListener('input', function () {
            el.classList.remove('error');
            // Clear the global error message once all errors are gone
            if (!form.querySelector('.error')) {
                errorEl.textContent = '';
            }
        });
    });
})();
