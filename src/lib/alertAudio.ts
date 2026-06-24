import type { RingtoneId } from '../types';

let audioContextRef: AudioContext | null = null;
let alertAudioPrimed = false;

function getAudioContext(): AudioContext | null {
  if (typeof window === 'undefined') {
    return null;
  }

  const AudioContextCtor = window.AudioContext;
  if (!AudioContextCtor) {
    return null;
  }

  if (!audioContextRef) {
    audioContextRef = new AudioContextCtor();
  }

  return audioContextRef;
}

async function resumeAlertAudio(): Promise<void> {
  const audioContext = getAudioContext();
  if (!audioContext) {
    return;
  }

  if (audioContext.state === 'suspended') {
    await audioContext.resume();
  }
}

export function primeAlertAudio(): void {
  if (alertAudioPrimed || typeof window === 'undefined') {
    return;
  }

  alertAudioPrimed = true;

  const unlock = () => {
    void resumeAlertAudio();
    window.removeEventListener('pointerdown', unlock);
    window.removeEventListener('keydown', unlock);
  };

  window.addEventListener('pointerdown', unlock, { once: true });
  window.addEventListener('keydown', unlock, { once: true });
}

interface Note {
  /** Seconds offset from the start of the ringtone. */
  at: number;
  freq: number;
  duration: number;
  type?: OscillatorType;
  peak?: number;
}

// Each ringtone is a short sequence of synthesized notes — no audio assets to bundle.
const RINGTONE_NOTES: Record<RingtoneId, Note[]> = {
  chime: [
    { at: 0, freq: 880, duration: 0.28, type: 'triangle' },
    { at: 0.0, freq: 988, duration: 0.28, type: 'triangle', peak: 0.0001 },
  ],
  ping: [{ at: 0, freq: 1320, duration: 0.22, type: 'sine' }],
  coin: [
    { at: 0, freq: 988, duration: 0.09, type: 'square', peak: 0.04 },
    { at: 0.09, freq: 1319, duration: 0.22, type: 'square', peak: 0.04 },
  ],
  arpeggio: [
    { at: 0, freq: 659, duration: 0.14, type: 'triangle' },
    { at: 0.12, freq: 880, duration: 0.14, type: 'triangle' },
    { at: 0.24, freq: 1109, duration: 0.22, type: 'triangle' },
  ],
  alert: [
    { at: 0, freq: 740, duration: 0.12, type: 'square', peak: 0.045 },
    { at: 0.18, freq: 740, duration: 0.12, type: 'square', peak: 0.045 },
  ],
  bell: [{ at: 0, freq: 1568, duration: 0.7, type: 'sine', peak: 0.05 }],
};

export const RINGTONES: { id: RingtoneId; label: string }[] = [
  { id: 'chime', label: 'Chime' },
  { id: 'ping', label: 'Ping' },
  { id: 'coin', label: 'Coin' },
  { id: 'arpeggio', label: 'Arpeggio' },
  { id: 'alert', label: 'Alert' },
  { id: 'bell', label: 'Bell' },
];

function scheduleNote(audioContext: AudioContext, start: number, note: Note): void {
  const oscillator = audioContext.createOscillator();
  const gainNode = audioContext.createGain();
  const noteStart = start + note.at;
  const peak = note.peak ?? 0.05;

  oscillator.type = note.type ?? 'triangle';
  oscillator.frequency.setValueAtTime(note.freq, noteStart);

  gainNode.gain.setValueAtTime(0.0001, noteStart);
  gainNode.gain.exponentialRampToValueAtTime(peak, noteStart + 0.01);
  gainNode.gain.exponentialRampToValueAtTime(0.0001, noteStart + note.duration);

  oscillator.connect(gainNode);
  gainNode.connect(audioContext.destination);

  oscillator.start(noteStart);
  oscillator.stop(noteStart + note.duration + 0.02);
}

export async function playAlertSound(ringtone: RingtoneId = 'chime'): Promise<void> {
  const audioContext = getAudioContext();
  if (!audioContext) {
    return;
  }

  await resumeAlertAudio();

  const notes = RINGTONE_NOTES[ringtone] ?? RINGTONE_NOTES.chime;
  const now = audioContext.currentTime;
  for (const note of notes) {
    scheduleNote(audioContext, now, note);
  }
}
