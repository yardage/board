// Hands the microphone's samples to the page, which holds them only until they are transcribed.
class VoiceCapture extends AudioWorkletProcessor {
  constructor() {
    super()
    this.buffer = new Float32Array(1600)
    this.filled = 0
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0]
    if (!channel) return true
    for (let i = 0; i < channel.length; i++) {
      this.buffer[this.filled++] = channel[i]
      if (this.filled === this.buffer.length) {
        this.port.postMessage(this.buffer, [this.buffer.buffer])
        this.buffer = new Float32Array(1600)
        this.filled = 0
      }
    }
    return true
  }
}

registerProcessor('voice-capture', VoiceCapture)
