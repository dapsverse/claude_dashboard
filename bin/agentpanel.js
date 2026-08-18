#!/usr/bin/env node
import { main } from '../src/cli/index.js';

const code = await main();
if (code !== null) process.exit(code);
