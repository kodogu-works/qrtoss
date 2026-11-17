import QrScanner from 'qr-scanner';

/** Adapter keeps camera/decoder choice separate from transfer/session state. */
export class Scanner {
  private scanner?: QrScanner;
  private generation = 0;
  constructor(
    private video: HTMLVideoElement,
    private scanned: (text: string) => void,
  ) {}
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
        { preferredCamera: 'environment', returnDetailedScanResult: true, maxScansPerSecond: 8 },
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
