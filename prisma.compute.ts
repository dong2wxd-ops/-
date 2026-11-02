import { defineComputeConfig } from '@prisma/compute-sdk';

export default defineComputeConfig({
  app: {
    framework: 'bun',
    entry: './server.js',
    httpPort: 3000,
  },
});