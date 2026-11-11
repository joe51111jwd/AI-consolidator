// Runs the relay locally on http://127.0.0.1:8787 (PORT to change) with in-memory storage unless
// Upstash variables are set. BOT_TOKEN and APP_TOKEN default to "dev-bot" and "dev-app".
import http from 'node:http';
import { handler } from './lib/app.js';

process.env.BOT_TOKEN ||= 'dev-bot';
process.env.APP_TOKEN ||= 'dev-app';
const port = Number(process.env.PORT || 8787);
http.createServer(handler).listen(port, '127.0.0.1', () => console.log(`Switchboard Relay on http://127.0.0.1:${port} (MCP at /mcp)`));
