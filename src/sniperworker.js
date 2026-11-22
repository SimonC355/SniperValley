// Builds the stylized sniper's pieces (stylizedsniper.js) off the main thread, while the map
// is being built, and hands back the arrays without copying them.
import { sniperReady, buildStylizedPieces, transferables } from './stylizedsniper.js';

self.onmessage = async (e) => {
  try {
    await sniperReady;
    const pieces = buildStylizedPieces(e.data.bones);
    self.postMessage({ pieces }, transferables(pieces));
  } catch (err) {
    self.postMessage({ error: String((err && err.stack) || err) });
  }
};
