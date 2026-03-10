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

export async function playAlertSound(): Promise<void> {
  const audioContext = getAudioContext();
  if (!audioContext) {
    return;
  }

  await resumeAlertAudio();

  const now = audioContext.currentTime;
  const oscillator = audioContext.createOscillator();
  const gainNode = audioContext.createGain();

  oscillator.type = 'triangle';
  oscillator.frequency.setValueAtTime(880, now);
  oscillator.frequency.linearRampToValueAtTime(988, now + 0.12);

  gainNode.gain.setValueAtTime(0.0001, now);
  gainNode.gain.exponentialRampToValueAtTime(0.05, now + 0.01);
  gainNode.gain.exponentialRampToValueAtTime(0.0001, now + 0.28);

  oscillator.connect(gainNode);
  gainNode.connect(audioContext.destination);

  oscillator.start(now);
  oscillator.stop(now + 0.3);
}
