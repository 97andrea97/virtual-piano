// Gives detected hands stable ids across frames and smooths their landmarks.
// MediaPipe returns hands in arbitrary order (and "handedness" flips when the
// image is mirrored), so we match hands frame to frame by palm position.

import { PointSetFilter } from './filters.js';

export const LANDMARK_COUNT = 21;
export const WRIST = 0;
export const MIDDLE_MCP = 9;

function palmCenter(points) {
  const a = points[WRIST];
  const b = points[MIDDLE_MCP];
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

export class HandTracker {
  /**
   * @param {object} opts
   * @param {number} opts.maxJump max palm movement (same units as points) between frames to keep an id
   * @param {number} opts.timeout seconds a hand may be missing before its track is dropped
   * @param {object} opts.filter One Euro filter options
   */
  constructor({ maxJump = 200, timeout = 0.3, filter = {} } = {}) {
    this.maxJump = maxJump;
    this.timeout = timeout;
    this.filterOpts = filter;
    this.tracks = [];
    this.nextId = 1;
  }

  /**
   * @param {{points: {x:number,y:number}[], handedness?: string}[]} detections
   * @param {number} t time in seconds
   * @returns {{id:number, points:{x:number,y:number}[], raw:{x:number,y:number}[], handedness?:string}[]}
   */
  update(detections, t) {
    const candidates = [];
    detections.forEach((det, di) => {
      const c = palmCenter(det.points);
      this.tracks.forEach((tr, ti) => {
        const d = Math.hypot(c.x - tr.center.x, c.y - tr.center.y);
        if (d <= this.maxJump) candidates.push({ d, di, ti });
      });
    });
    candidates.sort((a, b) => a.d - b.d);

    const detTrack = new Array(detections.length).fill(-1);
    const usedTracks = new Set();
    for (const { di, ti } of candidates) {
      if (detTrack[di] !== -1 || usedTracks.has(ti)) continue;
      detTrack[di] = ti;
      usedTracks.add(ti);
    }

    const hands = detections.map((det, di) => {
      let tr = this.tracks[detTrack[di]];
      if (!tr) {
        tr = { id: this.nextId++, filter: new PointSetFilter(LANDMARK_COUNT, this.filterOpts) };
        this.tracks.push(tr);
      }
      tr.lastSeen = t;
      tr.center = palmCenter(det.points);
      return { id: tr.id, points: tr.filter.filter(det.points, t), raw: det.points, handedness: det.handedness };
    });

    this.tracks = this.tracks.filter((tr) => t - tr.lastSeen <= this.timeout);
    return hands;
  }

  reset() {
    this.tracks = [];
  }
}
