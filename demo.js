// Runs the app with offline example data (no API key, no internet needed).
process.env.PROVIDER = "fixtures";
await import("./server.js");
