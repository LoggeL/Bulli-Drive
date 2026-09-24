import { describe, expect, it } from 'vitest';
import { e2eDrawIntervalMs, isE2EEnabled, isSandbox, isTunePanelEnabled, isTuneRequested } from '../../src/client/flags.js';
import { isPerfDebugEnabled } from '../../src/client/debug/perfStats.js';

// The URL gates of the client (src/client/flags.ts): a regular player's page
// never gets the test hook, the perf overlay or the tuning panel; online
// ?tune=1 only shows a hint (docs/phase-1b-design.md, 7).

describe('the test hook gate', () => {
    it('opens only for ?e2e=1', () => {
        expect(isE2EEnabled('')).toBe(false);
        expect(isE2EEnabled('?sandbox=1')).toBe(false);
        expect(isE2EEnabled('?e2e=0')).toBe(false);
        expect(isE2EEnabled('?e2e=true')).toBe(false);
        expect(isE2EEnabled('?e2e=1')).toBe(true);
        expect(isE2EEnabled('?name=x&e2e=1&debug=perf')).toBe(true);
    });

    it('limits the drawn frames only together with ?e2e=1', () => {
        expect(e2eDrawIntervalMs('?drawfps=2')).toBe(0);
        expect(e2eDrawIntervalMs('?e2e=1')).toBe(0);
        expect(e2eDrawIntervalMs('?e2e=1&drawfps=2')).toBe(500);
        expect(e2eDrawIntervalMs('?e2e=1&drawfps=0')).toBe(0);
        expect(e2eDrawIntervalMs('?e2e=1&drawfps=-5')).toBe(0);
        expect(e2eDrawIntervalMs('?e2e=1&drawfps=fast')).toBe(0);
    });
});

describe('the tuning panel gate', () => {
    it('loads the panel only for ?tune=1 in the offline sandbox', () => {
        expect(isTunePanelEnabled('')).toBe(false);
        expect(isTunePanelEnabled('?sandbox=1')).toBe(false);
        // Online: the request is seen (the page shows a hint), no panel
        expect(isTuneRequested('?tune=1')).toBe(true);
        expect(isTunePanelEnabled('?tune=1')).toBe(false);
        expect(isTunePanelEnabled('?tune=1&sandbox=1')).toBe(true);
        expect(isTunePanelEnabled('?sandbox=1&tune=0')).toBe(false);
        expect(isSandbox('?sandbox=1')).toBe(true);
        expect(isSandbox('?sandbox=yes')).toBe(false);
    });
});

describe('the perf overlay gate', () => {
    it('opens for debug=perf or debug=net, also in a comma list or repeated', () => {
        expect(isPerfDebugEnabled('')).toBe(false);
        expect(isPerfDebugEnabled('?e2e=1')).toBe(false);
        expect(isPerfDebugEnabled('?debug=physics')).toBe(false);
        expect(isPerfDebugEnabled('?debug=perfx')).toBe(false);
        expect(isPerfDebugEnabled('?debug=perf')).toBe(true);
        expect(isPerfDebugEnabled('?debug=net')).toBe(true);
        expect(isPerfDebugEnabled('?debug=physics,net')).toBe(true);
        expect(isPerfDebugEnabled('?debug=physics&debug=perf')).toBe(true);
    });
});
