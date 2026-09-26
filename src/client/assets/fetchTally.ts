// The bytes and files of a set of downloads, for the loading screen
// (docs/ui.md 3.2): a file counts as fetched once its bytes are in, not
// once it is decoded or on the GPU, so the bar and the status line's
// counter move while the files come in rather than all at once at the end
// (the KTX2 transcoder and the GLB parser finish them in a burst). The
// expected sizes come from the asset manifests. Pure: the loaders feed it
// their ProgressEvents.

interface TallyFile {
    bytes: number;
    loaded: number;
    fetched: boolean;
}

export class FetchTally {
    private readonly files = new Map<string, TallyFile>();

    /** A file that will be fetched, with its size from the manifest (bytes). */
    expect(key: string, bytes: number): void {
        if (this.files.has(key)) return;
        this.files.set(key, { bytes: Math.max(1, Number.isFinite(bytes) ? bytes : 1), loaded: 0, fetched: false });
    }

    /** loaded bytes of the file are in (never goes back). */
    progress(key: string, loaded: number): void {
        const file = this.files.get(key);
        if (!file || file.fetched || !Number.isFinite(loaded)) return;
        file.loaded = Math.min(file.bytes, Math.max(file.loaded, loaded));
    }

    /** The file is in (or failed: nothing more comes of it). */
    fetched(key: string): void {
        const file = this.files.get(key);
        if (!file) return;
        file.fetched = true;
        file.loaded = file.bytes;
    }

    /** A loader's onProgress for the file: its bytes, and fetched with the last of them. */
    listener(key: string): (event: ProgressEvent) => void {
        return event => {
            this.progress(key, event.loaded);
            if (event.lengthComputable && event.total > 0 && event.loaded >= event.total) this.fetched(key);
        };
    }

    /** Share of the expected bytes that are in, 0..1 (0 before any file is expected). */
    fraction(): number {
        let loaded = 0, bytes = 0;
        for (const file of this.files.values()) {
            loaded += file.loaded;
            bytes += file.bytes;
        }
        return bytes > 0 ? loaded / bytes : 0;
    }

    /** Files fetched, of the files expected. */
    count(): [fetched: number, expected: number] {
        let fetched = 0;
        for (const file of this.files.values()) if (file.fetched) fetched++;
        return [fetched, this.files.size];
    }
}
