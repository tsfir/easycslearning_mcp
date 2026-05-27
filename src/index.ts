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
import { initFirestore, getDb } from './firestore.js';
import { setSession } from './session.js';
import { registerDiscoveryTools } from './tools/discovery.js';
import { registerRosterTools } from './tools/roster.js';
import { registerGradesTools } from './tools/grades.js';
import { registerProgressTools } from './tools/progress.js';
import { registerActivityTools } from './tools/activity.js';
import { registerIntegrityTools } from './tools/integrity.js';
import { registerContentTools } from './tools/content.js';
import { registerGradingTools } from './tools/grading.js';

async function main(): Promise<void> {
    // ── Authentication ────────────────────────────────────────────────────────
    process.stderr.write('[EasyCS MCP] Starting up...\n');

    const authClient = await getAuthClient();
    const email = await getLoggedInEmail(authClient);
    process.stderr.write(`[EasyCS MCP] Authenticated as ${email}\n`);

    // ── Firestore ─────────────────────────────────────────────────────────────
    initFirestore(authClient);
    process.stderr.write('[EasyCS MCP] Firestore connected.\n');

    // ── Startup smoke test + UID resolution ──────────────────────────────────
    try {
        const db = getDb();

        // Resolve the logged-in user's Firestore UID from their email
        const userSnap = await db.collection('users').where('email', '==', email).limit(1).get();
        const userId = userSnap.docs[0]?.id ?? null;
        setSession(email, userId);
        process.stderr.write(`[EasyCS MCP] Current user UID: ${userId ?? 'not found in users collection'}\n`);

        // Confirm Firestore read access with a live courses query
        const coursesSnap = await db
            .collection('courses')
            .where('isActive', '==', true)
            .orderBy('orderIndex')
            .limit(1)
            .get();
        if (coursesSnap.empty) {
            process.stderr.write('[EasyCS MCP] Smoke test OK — no active courses found (empty DB?).\n');
        } else {
            const name = coursesSnap.docs[0].data().courseName ?? coursesSnap.docs[0].id;
            process.stderr.write(`[EasyCS MCP] Smoke test OK — first course: "${name}".\n`);
        }
    } catch (err) {
        process.stderr.write(`[EasyCS MCP] Smoke test FAILED: ${(err as Error).message}\n`);
        process.exit(1);
    }

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
    registerContentTools(server);
    registerGradingTools(server);

    process.stderr.write('[EasyCS MCP] 21 tools registered. Listening on stdio.\n');

    // ── Transport ─────────────────────────────────────────────────────────────
    const transport = new StdioServerTransport();
    await server.connect(transport);
}

main().catch(err => {
    process.stderr.write(`[EasyCS MCP] Fatal error: ${err.message}\n`);
    process.exit(1);
});
