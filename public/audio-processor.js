// Audio thread for the browser test phone: captures the microphone in 20 ms
// frames and plays the agent's voice from a queue, reporting playback "marks"
// the same way Twilio does.

class PhoneAudioProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.capacity = Math.round(sampleRate * 120);
    this.ring = new Float32Array(this.capacity);
    this.readPos = 0;
    this.writePos = 0;
    this.size = 0;
    this.played = 0;
    this.written = 0;
    this.marks = [];
    this.micFrame = new Float32Array(Math.round(sampleRate * 0.02));
    this.micFill = 0;
    this.micPeak = 0;
    this.outPeak = 0;
    this.sinceLevel = 0;
    this.port.onmessage = (event) => this.onMessage(event.data);
  }

  onMessage(msg) {
    if (msg.type === 'play') {
      const samples = msg.samples;
      for (let i = 0; i < samples.length && this.size < this.capacity; i++) {
        this.ring[this.writePos] = samples[i];
        this.writePos = (this.writePos + 1) % this.capacity;
        this.size++;
        this.written++;
      }
    } else if (msg.type === 'mark') {
      this.marks.push({ name: msg.name, at: this.written });
    } else if (msg.type === 'clear') {
      // Drop queued audio and return every pending mark, as Twilio does.
      this.readPos = 0;
      this.writePos = 0;
      this.size = 0;
      this.written = this.played;
      for (const mark of this.marks) this.port.postMessage({ type: 'mark', name: mark.name });
      this.marks = [];
    }
  }

  process(inputs, outputs) {
    const input = inputs[0] && inputs[0][0];
    if (input) {
      for (let i = 0; i < input.length; i++) {
        const s = input[i];
        this.micFrame[this.micFill++] = s;
        const a = s < 0 ? -s : s;
        if (a > this.micPeak) this.micPeak = a;
        if (this.micFill === this.micFrame.length) {
          this.port.postMessage({ type: 'mic', samples: this.micFrame.slice(0) });
          this.micFill = 0;
        }
      }
    }

    const output = outputs[0];
    const frames = output[0].length;
    for (let i = 0; i < frames; i++) {
      let s = 0;
      if (this.size > 0) {
        s = this.ring[this.readPos];
        this.readPos = (this.readPos + 1) % this.capacity;
        this.size--;
        this.played++;
        const a = s < 0 ? -s : s;
        if (a > this.outPeak) this.outPeak = a;
      }
      for (let c = 0; c < output.length; c++) output[c][i] = s;
    }
    while (this.marks.length > 0 && this.marks[0].at <= this.played) {
      this.port.postMessage({ type: 'mark', name: this.marks.shift().name });
    }

    this.sinceLevel += frames;
    if (this.sinceLevel >= sampleRate / 10) {
      this.port.postMessage({ type: 'level', mic: this.micPeak, out: this.outPeak });
      this.sinceLevel = 0;
      this.micPeak = 0;
      this.outPeak = 0;
    }
    return true;
  }
}

registerProcessor('phone-audio', PhoneAudioProcessor);
