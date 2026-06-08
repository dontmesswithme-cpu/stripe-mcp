import { Worker } from "node:worker_threads";
const w = new Worker(`
  const { parentPort } = require('node:worker_threads');
  parentPort.on('message', () => { while(true){} });
`, { eval: true });
w.on('exit', (code) => {
  console.log('Worker exited with code:', code);
});
w.postMessage('hang');
setTimeout(() => {
  w.terminate();
}, 100);
