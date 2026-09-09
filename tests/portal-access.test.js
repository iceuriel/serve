/* Arrival & access completion uses saved answers and the server's taxonomy.
   No browser or live customer data is needed for these decision cases. */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert/strict');
const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'portal.js'), 'utf8');
const backend = fs.readFileSync(path.join(root, 'apps-script/webhook.gs'), 'utf8');

const taxonomy = backend.match(/var ACCESS_QUESTIONS = (\[[\s\S]*?\n\]);/);
assert.ok(taxonomy, 'load the real question definitions');
const questions = vm.runInNewContext(taxonomy[1]);
const start = source.indexOf('    function accessComplete(');
const end = source.indexOf('    function updateAccessStatus(', start);
assert.ok(start >= 0 && end > start, 'load the real completion function');
const complete = vm.runInNewContext(source.slice(start, end) + '\naccessComplete;');

function home(overrides = {}) {
    const answers = { occupancy: 'NO', entry: 'LET_IN', parking: 'NONE' };
    return Object.assign({ propertyId: 'PROP-TEST', petNotes: '',
        questions: Array.from(questions, q => ({ ...q, choice: answers[q.field],
            detail: '', secretSet: false })) }, overrides);
}
function answer(h, field, changes) {
    Object.assign(h.questions.find(q => q.field === field), changes);
    return h;
}

assert.equal(complete([home()]), true, 'No and No parking are valid answers; pets optional');
for (const field of ['occupancy', 'entry', 'parking']) {
    assert.equal(complete([answer(home(), field, { choice: '' })]), false,
        field + ' must be answered');
    assert.equal(complete([answer(home(), field, { choice: 'UNKNOWN' })]), false,
        field + ' must contain a recognized choice');
}
for (const q of questions) {
    for (const c of q.choices) {
        const h = answer(home(), q.field, { choice: c.key });
        assert.equal(complete([h]), !c.detail && !c.secret,
            q.field + '/' + c.key + ': choice alone');
        if (!c.detail) continue;
        answer(h, q.field, { detail: '   ' });
        assert.equal(complete([h]), false, 'whitespace is not a saved detail');
        if (c.secret) {
            answer(h, q.field, { detail: '', secretSet: true });
            assert.equal(complete([h]), true, 'saved-code boolean is sufficient; no code returned');
        } else {
            answer(h, q.field, { detail: 'Saved instructions' });
            assert.equal(complete([h]), true, 'matching saved detail completes the question');
            answer(h, q.field, { detail: '' });
            assert.equal(complete([h]), false, 'clearing a required detail restores Incomplete');
        }
    }
}
assert.equal(complete([home(), answer(home({ propertyId: 'PROP-SECOND' }), 'entry',
    { choice: 'KEY' })]), false, 'every home must be complete');
assert.equal(complete([home(), home({ propertyId: 'PROP-SECOND' })]), true);
for (const homes of [undefined, [], [home({ propertyId: '' })],
    [home({ questions: [] })], [home({ questions: undefined })]]) {
    assert.equal(complete(homes), false, 'missing home/question data is incomplete');
}
const optional = home();
optional.questions.push({ field: 'future_optional', required: false, choices: [] });
assert.equal(complete([optional]), true, 'an explicitly optional question is excluded');

console.log('All arrival/access completion cases passed.');
