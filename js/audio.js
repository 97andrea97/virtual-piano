// Sound engine: a lightweight synthesized piano that works offline, plus an
// optional sampled grand piano (Salamander Grand Piano, CC-BY 3.0) streamed
// from the Tone.js sample host. Falls back to the synth if samples fail.

import { midiToFrequency } from './keyboard.js';

const SAMPLE_BASE_URL = 'https://tonejs.github.io/audio/salamander/';
// Salamander provides a sample every minor third: C, D#, F#, A.
const SAMPLE_PITCHES = { 0: 'C', 3: 'Ds', 6: 'Fs', 9: 'A' };
const MAX_VOICES = 32;

function makeImpulseResponse(ctx, seconds = 2.2, decay = 3) {
  const length = Math.floor(ctx.sampleRate * seconds);
  const buffer = ctx.createBuffer(2, length, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const data = buffer.getChannelData(ch);
    for (let i = 0; i < length; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, decay);
    }
  }
  return buffer;
}

function makeNoise(ctx, seconds = 0.1) {
  const buffer = ctx.createBuffer(1, Math.floor(ctx.sampleRate * seconds), ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  return buffer;
}

// Harmonic spectrum of a struck string: partials fall off with frequency and
// the hammer position (~1/8 of the string) attenuates every 8th partial.
function makePianoWave(ctx) {
  const n = 24;
  const real = new Float32Array(n);
  const imag = new Float32Array(n);
  for (let k = 1; k < n; k++) {
    imag[k] = Math.abs(Math.sin(Math.PI * k * 0.12)) / Math.pow(k, 1.1);
  }
  return ctx.createPeriodicWave(real, imag);
}

export class PianoAudio {
  constructor() {
    this.ctx = null;
    this.instrument = 'synth';
    this.samples = null; // Map midi -> AudioBuffer
    this.samplesLoading = null;
    this.sustain = false;
    this.voices = []; // { note, id, release(time), stop(), sustained }
    this.volume = 0.8;
  }

  /** Must be called from a user gesture (iOS/Safari autoplay policy). */
  async start() {
    if (!this.ctx) {
      // Let Web Audio play even when the iPhone ring/silent switch is on.
      try {
        if (navigator.audioSession) navigator.audioSession.type = 'playback';
      } catch { /* not supported */ }
      const Ctx = window.AudioContext || window.webkitAudioContext;
      this.ctx = new Ctx({ latencyHint: 'interactive' });
      const ctx = this.ctx;

      this.master = ctx.createGain();
      this.master.gain.value = this.volume;
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -14;
      comp.knee.value = 12;
      comp.ratio.value = 4;
      comp.attack.value = 0.003;
      comp.release.value = 0.25;

      this.dry = ctx.createGain();
      this.reverbSend = ctx.createGain();
      this.reverbSend.gain.value = 0.22;
      const reverb = ctx.createConvolver();
      reverb.buffer = makeImpulseResponse(ctx);

      this.dry.connect(this.master);
      this.reverbSend.connect(reverb).connect(this.master);
      this.master.connect(comp).connect(ctx.destination);

      this.wave = makePianoWave(ctx);
      this.noise = makeNoise(ctx);
    }
    if (this.ctx.state !== 'running') await this.ctx.resume();
  }

  setVolume(v) {
    this.volume = v;
    if (this.master) this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.02);
  }

  /** Switch between 'synth' and 'grand'. Resolves once the instrument is ready. */
  async setInstrument(name, { notes = [], onProgress } = {}) {
    this.instrument = name;
    if (name !== 'grand') return true;
    try {
      await this.loadSamples(notes, onProgress);
      return true;
    } catch (err) {
      console.warn('Could not load piano samples, using synth instead', err);
      this.instrument = 'synth';
      return false;
    }
  }

  /** Loads the samples needed to cover the given MIDI notes. */
  async loadSamples(notes, onProgress) {
    if (!this.ctx) throw new Error('Audio not started');
    this.samples ??= new Map();
    const needed = new Set();
    for (const note of notes) {
      const nearest = Math.round(note / 3) * 3; // samples every 3 semitones
      needed.add(Math.min(108, Math.max(21, nearest)));
    }
    const missing = [...needed].filter((n) => !this.samples.has(n));
    let done = 0;
    await Promise.all(missing.map(async (midi) => {
      const name = SAMPLE_PITCHES[midi % 12] + (Math.floor(midi / 12) - 1);
      const res = await fetch(`${SAMPLE_BASE_URL}${name}.mp3`);
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${name}`);
      const data = await res.arrayBuffer();
      const buffer = await new Promise((resolve, reject) => this.ctx.decodeAudioData(data, resolve, reject));
      this.samples.set(midi, buffer);
      onProgress?.(++done, missing.length);
    }));
  }

  setSustain(on) {
    this.sustain = on;
    if (!on && this.ctx) {
      const now = this.ctx.currentTime;
      for (const v of this.voices) if (v.sustained) v.release(now);
    }
  }

  noteOn(note, velocity = 0.7, id = note) {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    // Re-striking the same key from the same source damps the previous strike.
    for (const v of this.voices) if (v.id === id && v.note === note && !v.released) v.release(now, 0.05);
    const voice = this.instrument === 'grand' && this.samples?.size ? this.#sampleVoice(note, velocity, now) : this.#synthVoice(note, velocity, now);
    if (!voice) return;
    voice.id = id;
    voice.note = note;
    this.voices.push(voice);
    while (this.voices.length > MAX_VOICES) this.voices.shift().stop();
  }

  noteOff(note, id = note) {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    for (const v of this.voices) {
      if (v.id !== id || v.note !== note || v.released) continue;
      if (this.sustain) v.sustained = true;
      else v.release(now);
    }
  }

  allNotesOff() {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    for (const v of this.voices) v.release(now);
  }

  #track(voice, sources, end) {
    let ended = false;
    const finish = () => {
      if (ended) return;
      ended = true;
      const i = this.voices.indexOf(voice);
      if (i >= 0) this.voices.splice(i, 1);
    };
    sources[0].onended = finish;
    voice.stop = () => {
      for (const s of sources) try { s.stop(); } catch { /* already stopped */ }
      finish();
    };
    for (const s of sources) s.stop(end);
  }

  #synthVoice(note, velocity, now) {
    const ctx = this.ctx;
    const f0 = midiToFrequency(note);
    const vel = Math.max(0.05, Math.min(1, velocity));
    // Low notes ring longer than high notes.
    const decay = 2.6 * Math.pow(2, -(note - 60) / 22);
    const peak = 0.32 * Math.pow(vel, 1.4);

    const out = ctx.createGain(); // release envelope
    const env = ctx.createGain(); // strike/decay envelope
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.Q.value = 0.5;
    const bright = f0 * (3 + 14 * vel);
    filter.frequency.setValueAtTime(Math.min(bright, 16000), now);
    filter.frequency.setTargetAtTime(Math.min(f0 * 2.5, 16000), now + 0.01, 0.5 + decay * 0.2);

    env.gain.setValueAtTime(0, now);
    env.gain.linearRampToValueAtTime(peak, now + 0.004);
    env.gain.setTargetAtTime(peak * 0.35, now + 0.004, 0.12);
    env.gain.setTargetAtTime(0.0001, now + 0.2, decay);

    // Two slightly detuned strings give the characteristic piano "beating".
    const osc1 = ctx.createOscillator();
    const osc2 = ctx.createOscillator();
    osc1.setPeriodicWave(this.wave);
    osc2.setPeriodicWave(this.wave);
    osc1.frequency.value = f0;
    osc2.frequency.value = f0;
    osc2.detune.value = 1.5;
    const mix = ctx.createGain();
    mix.gain.value = 0.5;
    osc1.connect(mix);
    osc2.connect(mix);
    mix.connect(filter).connect(env).connect(out);

    // Hammer thump.
    const hammer = ctx.createBufferSource();
    hammer.buffer = this.noise;
    const hFilter = ctx.createBiquadFilter();
    hFilter.type = 'bandpass';
    hFilter.frequency.value = Math.min(f0 * 4, 6000);
    hFilter.Q.value = 1.2;
    const hGain = ctx.createGain();
    hGain.gain.setValueAtTime(0.25 * vel * vel, now);
    hGain.gain.setTargetAtTime(0.0001, now, 0.012);
    hammer.connect(hFilter).connect(hGain).connect(out);

    out.connect(this.dry);
    out.connect(this.reverbSend);

    const end = now + 0.2 + decay * 6;
    osc1.start(now);
    osc2.start(now);
    hammer.start(now);
    const voice = {
      released: false,
      sustained: false,
      release: (t, tau = 0.12) => {
        if (voice.released) return;
        voice.released = true;
        out.gain.setTargetAtTime(0, t, tau);
        for (const s of [osc1, osc2]) try { s.stop(t + tau * 8); } catch { /* already stopped */ }
      },
    };
    this.#track(voice, [osc1, osc2, hammer], end);
    return voice;
  }

  #sampleVoice(note, velocity, now) {
    const ctx = this.ctx;
    let best = null;
    for (const midi of this.samples.keys()) {
      if (best === null || Math.abs(midi - note) < Math.abs(best - note)) best = midi;
    }
    if (best === null) return null;
    const src = ctx.createBufferSource();
    src.buffer = this.samples.get(best);
    src.playbackRate.value = Math.pow(2, (note - best) / 12);
    const vel = Math.max(0.05, Math.min(1, velocity));
    const out = ctx.createGain();
    out.gain.value = 0.9 * Math.pow(vel, 1.5);
    // Softer strikes are also darker.
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 1500 + 14000 * vel * vel;
    src.connect(filter).connect(out);
    out.connect(this.dry);
    out.connect(this.reverbSend);
    src.start(now);
    const voice = {
      released: false,
      sustained: false,
      release: (t, tau = 0.15) => {
        if (voice.released) return;
        voice.released = true;
        out.gain.setTargetAtTime(0, t, tau);
        try { src.stop(t + tau * 8); } catch { /* already stopped */ }
      },
    };
    this.#track(voice, [src], now + src.buffer.duration / src.playbackRate.value);
    return voice;
  }
}
