// Camera + MediaPipe hand landmark detection.

const MEDIAPIPE_VERSION = '0.10.35';
export const MEDIAPIPE_URL = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MEDIAPIPE_VERSION}`;
export const HAND_MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';

export class Camera {
  constructor(video) {
    this.video = video;
    this.stream = null;
    this.facingMode = 'user';
  }

  get mirrored() {
    return this.facingMode === 'user';
  }

  async start(facingMode = this.facingMode) {
    this.stop();
    this.facingMode = facingMode;
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('Camera access is not available. Open the app over HTTPS (or localhost) in a modern browser.');
    }
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: { ideal: facingMode },
        width: { ideal: 1280 },
        height: { ideal: 720 },
        frameRate: { ideal: 60 },
      },
    });
    this.video.srcObject = this.stream;
    await this.video.play();
    if (!this.video.videoWidth) {
      await new Promise((resolve) => this.video.addEventListener('loadedmetadata', resolve, { once: true }));
    }
  }

  stop() {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
  }
}

export class HandDetector {
  async init({ onStatus } = {}) {
    onStatus?.('Loading hand tracking…');
    const { FilesetResolver, HandLandmarker } = await import(`${MEDIAPIPE_URL}/vision_bundle.mjs`);
    const fileset = await FilesetResolver.forVisionTasks(`${MEDIAPIPE_URL}/wasm`);
    const options = (delegate) => ({
      baseOptions: { modelAssetPath: HAND_MODEL_URL, delegate },
      runningMode: 'VIDEO',
      numHands: 2,
      minHandDetectionConfidence: 0.5,
      minHandPresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
    });
    try {
      this.landmarker = await HandLandmarker.createFromOptions(fileset, options('GPU'));
    } catch (err) {
      console.warn('GPU delegate unavailable, falling back to CPU', err);
      this.landmarker = await HandLandmarker.createFromOptions(fileset, options('CPU'));
    }
    this.lastTimestamp = -1;
  }

  /**
   * @returns {{points:{x:number,y:number}[], handedness:string}[]} landmarks normalized to [0,1] of the video frame
   */
  detect(video, timestampMs) {
    if (!this.landmarker) return [];
    // MediaPipe requires strictly increasing timestamps.
    const ts = Math.max(timestampMs, this.lastTimestamp + 1);
    this.lastTimestamp = ts;
    const result = this.landmarker.detectForVideo(video, ts);
    return (result.landmarks ?? []).map((lm, i) => ({
      points: lm.map((p) => ({ x: p.x, y: p.y })),
      handedness: result.handedness?.[i]?.[0]?.categoryName ?? result.handednesses?.[i]?.[0]?.categoryName,
    }));
  }
}
