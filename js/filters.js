// One Euro filter (Casiez et al. 2012): removes landmark jitter when the hand
// is still while keeping latency low when it moves fast.

function smoothingFactor(dt, cutoff) {
  const r = 2 * Math.PI * cutoff * dt;
  return r / (r + 1);
}

export class OneEuroFilter {
  constructor({ minCutoff = 1.5, beta = 0.02, dCutoff = 1.0 } = {}) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;
    this.reset();
  }

  reset() {
    this.x = null;
    this.dx = 0;
    this.t = null;
  }

  /** @param {number} value @param {number} t time in seconds */
  filter(value, t) {
    if (this.x === null || this.t === null || t <= this.t) {
      if (this.x === null) this.x = value;
      this.t = t;
      return this.x;
    }
    const dt = t - this.t;
    this.t = t;
    const dx = (value - this.x) / dt;
    this.dx += smoothingFactor(dt, this.dCutoff) * (dx - this.dx);
    const cutoff = this.minCutoff + this.beta * Math.abs(this.dx);
    this.x += smoothingFactor(dt, cutoff) * (value - this.x);
    return this.x;
  }
}

/** Filters a whole set of 2D points (e.g. the 21 hand landmarks). */
export class PointSetFilter {
  constructor(count, opts) {
    this.fx = Array.from({ length: count }, () => new OneEuroFilter(opts));
    this.fy = Array.from({ length: count }, () => new OneEuroFilter(opts));
  }

  filter(points, t) {
    return points.map((p, i) => ({
      x: this.fx[i].filter(p.x, t),
      y: this.fy[i].filter(p.y, t),
    }));
  }
}
