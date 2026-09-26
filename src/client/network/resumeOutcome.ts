import type { ServerMessage } from '../../shared/protocol.js';
import { hideRespawnOverlay, showRespawnOverlay } from '../ui/respawnOverlay.js';

type RoomState = Extract<ServerMessage, { type: 'roomState' }>;

/**
 * What the page does with its own car when a room state arrives
 * (docs/phase-1b-design.md, 11.1), once the room is set up:
 * - 'resumedCar': back within the grace time and the car lives on the
 *   server; if it died and respawned meanwhile the respawn event is lost,
 *   so the death is undone on screen
 * - 'deadInParty': back in the Party, past the splash screen, and the
 *   server has the player without a car (killed while the connection was
 *   gone): the respawn event will bring it back
 * - 'sendReady': past the splash screen but not driving in this room (a new
 *   session after the grace time or a restart, a room switch, a lost
 *   'ready'): drive again
 * - 'wait': still on the splash screen, START sends 'ready'
 */
export type ResumeOutcome = 'resumedCar' | 'deadInParty' | 'sendReady' | 'wait';

export function resumeOutcome(
    room: Pick<RoomState, 'resume' | 'members' | 'room'>,
    page: { playerReady: boolean; myId: string | null }
): ResumeOutcome {
    if (room.resume?.alive) return 'resumedCar';
    const party = room.room.kind === 'party';
    if (room.resume && page.playerReady && party && room.members.some(m => m.id === page.myId && m.ready)) return 'deadInParty';
    return page.playerReady ? 'sendReady' : 'wait';
}

/** The page state applyResumeOutcome changes (the client's `state`). */
export interface ResumePage {
    bulli: { bodyGroup: { visible: boolean }; health: number } | null;
    health: number;
    dead: boolean;
}

/** Carries out a ResumeOutcome on the page; sendReady asks for the car. */
export function applyResumeOutcome(outcome: ResumeOutcome, page: ResumePage, sendReady: () => void): void {
    if (outcome === 'resumedCar') {
        // The car lives on the server. If it died and respawned while the
        // connection was gone, the respawn event is lost: undo the death
        // on screen here
        if (page.bulli) {
            page.bulli.bodyGroup.visible = true;
            page.bulli.health = page.health;
        }
        hideRespawnOverlay();
    } else if (outcome === 'deadInParty') {
        // Dead in the Party (maybe killed while the connection was gone):
        // the respawn event brings the car back
        page.dead = true;
        if (page.bulli) page.bulli.bodyGroup.visible = false;
        showRespawnOverlay();
    } else if (outcome === 'sendReady') {
        // Past the splash screen but not driving in this room (a new session
        // after the grace time or a restart, or 'ready' got lost): drive again
        sendReady();
    }
}
