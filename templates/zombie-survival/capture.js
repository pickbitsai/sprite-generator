#!/usr/bin/env node
import { fileURLToPath } from 'url';
import path from 'path';
import { captureDemo } from '../../lib/capture-demo.js';
captureDemo({
  templateDir: path.dirname(fileURLToPath(import.meta.url)),
  viewport: { width: 640, height: 640 },
});
