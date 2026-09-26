// Tips on the loading screen (docs/ui.md 3.1): one every TIP_INTERVAL_MS,
// for the way the player drives: keyboard, touch (a coarse pointer) or a
// gamepad (once one is connected). Plain hints, no jokes. The jump is gone
// (branch sim/airborne-no-jump), so no tip names it or the Q key.

export type InputKind = 'keyboard' | 'touch' | 'gamepad';

export const TIP_INTERVAL_MS = 7000;

export const LOADER_TIPS: Readonly<Record<InputKind, readonly string[]>> = {
    keyboard: [
        'Hold SPACE through a corner – drifting fills your boost.',
        'SHIFT burns boost for a burst of speed.',
        'Stuck? Hold R to reset onto the road.',
        'WASD or the arrow keys drive, S brakes and reverses.',
        'Party: E shoots.',
        'F honks.',
        'Race: pick the track and the bots in the lobby.'
    ],
    touch: [
        'AUTO gives gas for you – just steer with the stick.',
        'Pull the stick back to brake and reverse.',
        'Hold DRIFT through a corner – drifting fills your boost.',
        'BOOST burns the boost you drifted for.',
        'Stuck? Hold the reset button to get back on the road.',
        'Race: pick the track and the bots in the lobby.'
    ],
    gamepad: [
        'RT gives gas, LT brakes, the left stick steers.',
        'Hold A through a corner – drifting fills your boost.',
        'B burns boost for a burst of speed.',
        'Stuck? Hold View to reset onto the road.',
        'Party: X shoots, LB honks.'
    ]
};

/** A connected gamepad wins, then a coarse (touch) pointer, else the keyboard. */
export function inputKindFor(env: { coarsePointer: boolean; gamepad: boolean }): InputKind {
    if (env.gamepad) return 'gamepad';
    return env.coarsePointer ? 'touch' : 'keyboard';
}

/** The tip number `index` for this input (wraps around). */
export function tipFor(kind: InputKind, index: number): string {
    const tips = LOADER_TIPS[kind];
    return tips[((index % tips.length) + tips.length) % tips.length];
}
