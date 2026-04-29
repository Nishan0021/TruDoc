import { puter } from '@heyputer/puter.js';

async function test() {
  try {
    const res = await puter.ai.chat("Say hello", { model: "google/gemini-3.1-pro" });
    console.log("Success:", res);
  } catch (e) {
    console.error("Error:", e);
  }
}
test();
