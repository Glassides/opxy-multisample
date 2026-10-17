// Runs on the audio thread: forwards every input block to the main thread.
// Keeps nothing itself, so memory stays with the Recorder.

class CaptureProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0];
    if (input && input.length) {
      // Copy, since the input buffers are reused by the engine.
      this.port.postMessage(input.map((ch) => ch.slice()));
    }
    return true;
  }
}

registerProcessor('capture', CaptureProcessor);
