import type { ServerMessage } from '../../shared/protocol.js';

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
