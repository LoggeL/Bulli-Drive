// Provided by basisTranscoderPlugin in vite.config.ts: URL of the directory that
// holds basis_transcoder.js/.wasm of the installed three.js (with trailing slash).
declare module 'virtual:basis-transcoder' {
    const transcoderPath: string;
    export default transcoderPath;
}
