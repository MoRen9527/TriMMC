import { createTriMMCApp } from './server/app.js';
import { readEnv } from './config/env.js';

async function main(): Promise<void> {
  const env = readEnv();
  const app = createTriMMCApp(env);
  await app.start();
}

try {
  await main();
} catch (error) {
  console.error('[trimc] failed to start', error);
  throw error;
}