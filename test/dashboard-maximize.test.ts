// Maximize / Normal view on the analyzer cards.
//
// There is no DOM library in this project, so rather than add one the page's
// own <script> is lifted out of the rendered HTML and run against a stub that
// records what was written. That is enough to assert the markup and the
// toggle logic, which is where the bugs would be.
//   npx tsx test/dashboard-maximize.test.ts
import { runInNewContext } from 'node:vm';
import { renderDashboard } from '../src/admin/dashboard.js';

const html = renderDashboard({ username: 'Adminx' } as never);
const script = html.slice(html.indexOf('<script>') + 8, html.lastIndexOf('</script>'));

/** Minimal element: enough for classList toggling and innerHTML capture. */
const el = (id: string) => {
  const classes = new Set<string>();
  return {
    id,
    innerHTML: '',
    textContent: '',
    classList: {
      toggle: (c: string, on?: boolean) => (on ?? !classes.has(c)) ? classes.add(c) : classes.delete(c),
      contains: (c: string) => classes.has(c),
      has: () => classes,
    },
    _classes: classes,
  };
};

const nodes: Record<string, ReturnType<typeof el>> = {};
const sandbox = {
  document: {
    getElementById: (id: string) => (nodes[id] ??= el(id)),
    querySelectorAll: () => [] as unknown[],
    addEventListener: () => {},
  },
  window: { scrollTo: () => {} },
  fetch: async () => ({ status: 200, json: async () => ({}) }),
  setInterval: () => 0,
  location: { href: '' },
  console,
};

const ctx = runInNewContext(script + '\n;({ renderCards, setMax, state });', sandbox);

const analyzers = [
  { id: 'meglumi', equipmentCode: 'MGAPI1000', protocol: 'astm', endpoint: 'tcp 0.0.0.0:2807', connected: true, lastMessageAt: null, spool: { pending: 0, failed: 0 } },
  { id: 'vitros', equipmentCode: 'EC016', protocol: 'astm', endpoint: 'tcp 0.0.0.0:2808', connected: false, lastMessageAt: null, spool: { pending: 2, failed: 1 } },
];

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  ok ? pass++ : fail++;
};
const grid = () => nodes['cards'];
const count = (h: string, needle: string) => h.split(needle).length - 1;

// --- normal grid --------------------------------------------------------------
ctx.renderCards(analyzers);
check('a Maximize button per machine', count(grid().innerHTML, 'data-max=') === 2);
check('both cards labelled Maximize', count(grid().innerHTML, 'Maximize') === 2);
check('no Normal view button yet', !grid().innerHTML.includes('Normal view'));
check('grid is not in maximized mode', !grid()._classes.has('has-max'));
check('no card carries is-max', !grid().innerHTML.includes('is-max'));

// --- maximize one -------------------------------------------------------------
ctx.setMax('meglumi');
const max = grid().innerHTML;
check('grid switches to has-max', grid()._classes.has('has-max'));
check('the chosen card is is-max', count(max, 'class="card is-max"') === 1);
check('the other card is not', count(max, 'class="card "') === 1);
check('its button becomes Normal view', count(max, 'Normal view') === 1);
check('the hidden card keeps Maximize', count(max, 'Maximize') === 1);
check('maximizing opens that panel', ctx.state.open === 'meglumi', 'state.open=' + ctx.state.open);

// --- restore ------------------------------------------------------------------
ctx.setMax(null);
check('grid returns to normal', !grid()._classes.has('has-max'));
check('both buttons say Maximize again', count(grid().innerHTML, 'Maximize') === 2);

// --- a repaint (the 5s poll) must not lose the maximized state ----------------
ctx.setMax('vitros');
ctx.renderCards(analyzers);
check('poll repaint keeps it maximized', grid()._classes.has('has-max') && ctx.state.max === 'vitros');

// --- the machine disappears from config --------------------------------------
ctx.renderCards([analyzers[0]]);
check('dropped analyzer clears maximize', ctx.state.max === null && !grid()._classes.has('has-max'));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
