#!/usr/bin/env node
/**
 * EasyCS Learning — MCP Server
 *
 * Gives Claude read access to your EasyCS Learning Firebase data:
 * courses, topics, lessons, classes, grades, activity and integrity flags.
 *
 * First run: opens a browser for Google login (OAuth2).
 * Subsequent runs: uses the cached token silently.
 *
 * See README.md for setup instructions.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { getAuthClient, getLoggedInEmail } from './auth.js';
import { initFirestore } from './firestore.js';
import { registerDiscoveryTools } from './tools/discovery.js';
import { registerRosterTools } from './tools/roster.js';
import { registerGradesTools } from './tools/grades.js';
import { registerProgressTools } from './tools/progress.js';
import { registerActivityTools } from './tools/activity.js';
import { registerIntegrityTools } from './tools/integrity.js';

async function main(): Promise<void> {
    // ── Authentication ────────────────────────────────────────────────────────
    process.stderr.write('[EasyCS MCP] Starting up...\n');

    const authClient = await getAuthClient();
    const email = await getLoggedInEmail(authClient);
    process.stderr.write(`[EasyCS MCP] Authenticated as ${email}\n`);

    // ── Firestore ─────────────────────────────────────────────────────────────
    initFirestore(authClient);
    process.stderr.write('[EasyCS MCP] Firestore connected.\n');

    // ── MCP Server ────────────────────────────────────────────────────────────
    const server = new McpServer({
        name: 'easycslearning',
        version: '1.0.0',
    });

    registerDiscoveryTools(server);
    registerRosterTools(server);
    registerGradesTools(server);
    registerProgressTools(server);
    registerActivityTools(server);
    registerIntegrityTools(server);

    process.stderr.write('[EasyCS MCP] 17 tools registered. Listening on stdio.\n');

    // ── Transport ─────────────────────────────────────────────────────────────
    const transport = new StdioServerTransport();
    await server.connect(transport);
}

main().catch(err => {
    process.stderr.write(`[EasyCS MCP] Fatal error: ${err.message}\n`);
    process.exit(1);
});
