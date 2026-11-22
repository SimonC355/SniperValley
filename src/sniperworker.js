// Builds the sculpted sniper's pieces (sculptedsniper.js) off the main thread, while the map
// is being built, and hands back the arrays without copying them.
import { sniperReady, buildSniperPieces, transferables } from './sculptedsniper.js';

self.onmessage = async (e) => {
  try {
    await sniperReady;
    const pieces = buildSniperPieces(e.data.bones, e.data.look);
    self.postMessage({ pieces }, transferables(pieces));
  } catch (err) {
    self.postMessage({ error: String((err && err.stack) || err) });
  }
};
