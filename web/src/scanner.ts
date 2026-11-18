import QrScanner from 'qr-scanner';

/** Adapter keeps camera/decoder choice separate from transfer/session state. */
export class Scanner {
  private scanner?: QrScanner;
  private generation = 0;
  private zoomTask: Promise<void> = Promise.resolve();
  constructor(
    private video: HTMLVideoElement,
    private scanned: (text: string) => void,
  ) {}
  zoom(): { min: number; max: number; step: number; value: number } | undefined {
    const track = (this.video.srcObject as MediaStream | null)?.getVideoTracks()[0];
    const capabilities = track?.getCapabilities?.() as
      | (MediaTrackCapabilities & {
          zoom?: { min: number; max: number; step?: number };
        })
      | undefined;
    const range = capabilities?.zoom;
    if (!range || range.max <= range.min) return;
    const settings = track?.getSettings() as MediaTrackSettings & { zoom?: number };
    return { ...range, step: range.step || 0.1, value: settings.zoom ?? range.min };
  }
  async setZoom(value: number): Promise<void> {
    const range = this.zoom();
    const track = (this.video.srcObject as MediaStream | null)?.getVideoTracks()[0];
    if (!range || !track || !Number.isFinite(value)) return;
    const generation = this.generation;
    const task = this.zoomTask
      .catch(() => {})
      .then(async () => {
        if (generation !== this.generation || track.readyState === 'ended') return;
        await track.applyConstraints({
          advanced: [
            { zoom: Math.min(range.max, Math.max(range.min, value)) } as MediaTrackConstraintSet,
          ],
        });
      });
    this.zoomTask = task;
    await task;
  }
  async image(file: File): Promise<void> {
    this.stop();
    const generation = this.generation;
    const result = await QrScanner.scanImage(file, { returnDetailedScanResult: true });
    if (generation === this.generation) this.scanned(result.data);
  }
  async start(): Promise<void> {
    this.stop();
    const g = this.generation;
    if (!isSecureContext || !navigator.mediaDevices?.getUserMedia)
      throw new Error('CAMERA_INSECURE');
    try {
      // Acquire here so the decoder's fallback loop cannot swallow permission errors.
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: 'environment' } },
      });
      if (g !== this.generation) {
        for (const track of stream.getTracks()) track.stop();
        return;
      }
      this.video.srcObject = stream;
      const scanner = new QrScanner(
        this.video,
        (result) => {
          if (g !== this.generation) return;
          const text = result.data;
          this.stop();
          this.scanned(text);
        },
        {
          preferredCamera: 'environment',
          returnDetailedScanResult: true,
          maxScansPerSecond: 8,
          calculateScanRegion: (video) => ({
            x: 0,
            y: 0,
            width: video.videoWidth,
            height: video.videoHeight,
            downScaledWidth: Math.min(video.videoWidth, 1024),
            downScaledHeight: Math.round(video.videoHeight * Math.min(1, 1024 / video.videoWidth)),
          }),
        },
      );
      this.scanner = scanner;
      await scanner.start();
      if (g !== this.generation) scanner.destroy();
    } catch (error) {
      if (g !== this.generation) return;
      this.stop();
      const name = error instanceof Error ? error.name : '';
      throw new Error(
        name === 'NotAllowedError'
          ? 'CAMERA_DENIED'
          : name === 'NotFoundError'
            ? 'CAMERA_NOT_FOUND'
            : name === 'NotReadableError'
              ? 'CAMERA_BUSY'
              : 'CAMERA_ERROR',
      );
    }
  }
  stop(): void {
    this.generation++;
    const stream = this.video.srcObject;
    this.scanner?.stop();
    this.scanner?.destroy();
    this.scanner = undefined;
    // qr-scanner's pause is delayed; stop immediately before releasing srcObject.
    if (stream instanceof MediaStream) for (const track of stream.getTracks()) track.stop();
    this.video.srcObject = null;
  }
}
