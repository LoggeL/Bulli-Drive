export const CONFIG = {
    carSpeed: 0.5,
    carTurnSpeed: 0.05,
    cameraHeight: 23,
    cameraDistance: 34,
    cameraLookAtY: 2.5,
    cameraLookAhead: 6,
    cameraSpeedLookAhead: 5,
    cameraBaseFov: 58,
    cameraMobileFov: 62,
    cameraSpeedFov: 8,
    cameraBoostFov: 4,
    cameraMaxFov: 72,
    cameraMobileDistanceScale: 0.9,
    cameraMobileHeightScale: 0.9,
    cameraYawDamping: 6,
    cameraPositionDamping: 6.5,
    cameraLookDamping: 8,
    cameraFovDamping: 5,
    cameraTeleportDistance: 20,
    shadowMapSize: 1024,
    // Dynamic WS URL: Use current hostname/port
    serverUrl: window.location.origin.replace(/^http/, 'ws')
};
