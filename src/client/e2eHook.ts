import { state } from './state.js';

// Read-only hook for the Playwright smoke tests (tests/e2e). It is only
// installed when the page is opened with ?e2e=1, so regular players never get
// it and the game behaves exactly the same without the flag.

interface CarSnapshot {
    x: number;
    z: number;
    angle: number;
    speed: number;
}

export interface BulliDebugSnapshot {
    myId: string | null;
    connected: boolean;
    local: CarSnapshot | null;
    remotes: Record<string, CarSnapshot & { name: string }>;
    // Combined keyboard/touch drive axes
    inputs: { throttle: number; steer: number };
    // three.js counters of the last rendered frame
    render: { frame: number; calls: number; triangles: number };
}

function carSnapshot(car: any): CarSnapshot {
    return {
        x: car.group.position.x,
        z: car.group.position.z,
        angle: car.group.rotation.y,
        speed: car.speed ?? 0
    };
}

export function installE2EHook(): void {
    if (new URLSearchParams(window.location.search).get('e2e') !== '1') return;

    (window as unknown as { __bulliDebug: unknown }).__bulliDebug = {
        snapshot(): BulliDebugSnapshot {
            const remotes: BulliDebugSnapshot['remotes'] = {};
            for (const id in state.remotePlayers) {
                const remote = state.remotePlayers[id] as any;
                remotes[id] = { ...carSnapshot(remote), name: remote.name };
            }
            return {
                myId: state.myId,
                connected: state.ws?.readyState === WebSocket.OPEN,
                local: state.bulli ? carSnapshot(state.bulli) : null,
                remotes,
                inputs: { throttle: state.inputs.throttle, steer: state.inputs.steer },
                render: {
                    frame: state.renderer?.info.render.frame ?? 0,
                    calls: state.renderer?.info.render.calls ?? 0,
                    triangles: state.renderer?.info.render.triangles ?? 0
                }
            };
        }
    };
}
