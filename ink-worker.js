importScripts('ink.js');

self.onmessage = (event) => {
  try {
    const result = self.InkEngine.segment(event.data);
    self.postMessage({ ok: true, result });
  } catch (error) {
    self.postMessage({ ok: false, message: String(error && error.message || error) });
  }
};
