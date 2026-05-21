/**
 * AudioWorklet Processor — Float32 → Int16 PCM converter
 * AudioContext is created at 16000 Hz, browser handles resampling.
 */

class MeetingAudioProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buffer    = [];
    this._chunkSize = 4096; // ~256 ms at 16 kHz
  }

  process(inputs) {
    const channel = inputs[0]?.[0];
    if (!channel) return true;

    for (let i = 0; i < channel.length; i++) {
      this._buffer.push(channel[i]);
    }

    if (this._buffer.length >= this._chunkSize) {
      const floatData = this._buffer.splice(0, this._chunkSize);
      const int16Data = new Int16Array(floatData.length);

      for (let i = 0; i < floatData.length; i++) {
        const s      = Math.max(-1, Math.min(1, floatData[i]));
        int16Data[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }

      this.port.postMessage(int16Data.buffer, [int16Data.buffer]);
    }

    return true;
  }
}

registerProcessor("meeting-audio-processor", MeetingAudioProcessor);