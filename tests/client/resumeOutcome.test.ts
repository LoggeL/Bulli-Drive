import { describe, expect, it } from 'vitest';
import { resumeOutcome } from '../../src/client/network/resumeOutcome.js';
import type { MemberInfo, ResumeState, RoomKind } from '../../src/shared/protocol.js';

// What the page does with its own car when a room state arrives
// (src/client/network/resumeOutcome.ts, docs/phase-1b-design.md 11.1). The
// case that motivated it: shot down, and the connection dropped before the
// respawn event came. Back within the grace time the server has respawned
// the car meanwhile (resume.alive), so the page must undo the death on
// screen instead of waiting for an event that is lost.

const ME = 'p-me';

function member(id: string, ready: boolean): MemberInfo {
    return { id, slot: 0, name: id, color: 0, carType: 'bulli', profile: 'standard', ready };
}

function roomState(kind: RoomKind, resume: ResumeState | undefined, members: MemberInfo[]) {
    return { room: { id: `${kind}-1`, kind, index: 1 }, resume, members };
}

const ALIVE: ResumeState = { alive: true, spawnTick: 100, powerups: [] };
const DEAD: ResumeState = { alive: false, spawnTick: 100, powerups: [] };

describe('the own car after a room state', () => {
    it('undoes a death on screen when the car lives on the server', () => {
        // Killed, then back before the respawn event: the server says alive
        const ready = { playerReady: true, myId: ME };
        expect(resumeOutcome(roomState('party', ALIVE, [member(ME, true)]), ready)).toBe('resumedCar');
        // Also in Free Roam, and whatever the member list says
        expect(resumeOutcome(roomState('freeroam', ALIVE, []), ready)).toBe('resumedCar');
    });

    it('shows the respawn overlay when the Party player comes back without a car', () => {
        const ready = { playerReady: true, myId: ME };
        expect(resumeOutcome(roomState('party', DEAD, [member('other', true), member(ME, true)]), ready)).toBe('deadInParty');
        // Not in Free Roam (nobody dies there): drive again
        expect(resumeOutcome(roomState('freeroam', DEAD, [member(ME, true)]), ready)).toBe('sendReady');
        // Not ready on the server (it never got 'ready'): send it
        expect(resumeOutcome(roomState('party', DEAD, [member(ME, false)]), ready)).toBe('sendReady');
        // Another player's entry does not count
        expect(resumeOutcome(roomState('party', DEAD, [member('other', true)]), ready)).toBe('sendReady');
    });

    it('drives again as a new session, and waits on the splash screen', () => {
        // After the grace time or a restart: no resume, the page was driving
        expect(resumeOutcome(roomState('party', undefined, [member(ME, false)]), { playerReady: true, myId: ME })).toBe('sendReady');
        // Still on the splash screen: START sends 'ready' later
        expect(resumeOutcome(roomState('party', undefined, []), { playerReady: false, myId: ME })).toBe('wait');
        expect(resumeOutcome(roomState('party', DEAD, [member(ME, true)]), { playerReady: false, myId: ME })).toBe('wait');
    });
});
