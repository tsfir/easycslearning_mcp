/**
 * OAuth2 browser-based login for the EasyCS MCP server.
 *
 * On first run the server opens a browser tab, asks the user to sign in with
 * the Google account that owns the Firebase project, and stores the resulting
 * refresh token in ~/.easycs-mcp/credentials.json.
 *
 * On every subsequent run the stored token is loaded and refreshed silently —
 * no browser needed.
 *
 * Required Google Cloud OAuth2 scopes:
 *   - https://www.googleapis.com/auth/datastore  (Firestore read)
 *   - https://www.googleapis.com/auth/userinfo.email  (show who is logged in)
 *
 * SETUP (one-time, per machine):
 *   1. Go to Google Cloud Console → APIs & Services → Credentials
 *   2. Create an OAuth 2.0 Client ID → Desktop app
 *   3. Download the JSON and save it as  ~/.easycs-mcp/client_secret.json
 */

import path from 'path';
import os from 'os';
import fs from 'fs';
import { authenticate } from '@google-cloud/local-auth';
import { OAuth2Client } from 'google-auth-library';

const CREDENTIALS_DIR = path.join(os.homedir(), '.easycs-mcp');
const CLIENT_SECRET_PATH = path.join(CREDENTIALS_DIR, 'client_secret.json');
const TOKEN_PATH = path.join(CREDENTIALS_DIR, 'credentials.json');

const SCOPES = [
    'https://www.googleapis.com/auth/datastore',
    'https://www.googleapis.com/auth/userinfo.email',
];

function loadSavedToken(): OAuth2Client | null {
    if (!fs.existsSync(TOKEN_PATH)) return null;
    try {
        const raw = fs.readFileSync(TOKEN_PATH, 'utf-8');
        const credentials = JSON.parse(raw);
        // Re-hydrate using the client secret
        const secret = JSON.parse(fs.readFileSync(CLIENT_SECRET_PATH, 'utf-8'));
        const { client_id, client_secret } = secret.installed ?? secret.web;
        const client = new OAuth2Client(client_id, client_secret);
        client.setCredentials(credentials);
        return client;
    } catch {
        return null;
    }
}

function saveToken(client: OAuth2Client): void {
    fs.mkdirSync(CREDENTIALS_DIR, { recursive: true });
    const credentials = client.credentials;
    fs.writeFileSync(TOKEN_PATH, JSON.stringify(credentials, null, 2), 'utf-8');
}

export async function getAuthClient(): Promise<OAuth2Client> {
    if (!fs.existsSync(CLIENT_SECRET_PATH)) {
        throw new Error(
            `\n[EasyCS MCP] Client secret not found at:\n  ${CLIENT_SECRET_PATH}\n\n` +
            `Please follow these one-time setup steps:\n` +
            `  1. Open Google Cloud Console → APIs & Services → Credentials\n` +
            `  2. Create an OAuth 2.0 Client ID (Application type: Desktop app)\n` +
            `  3. Download the JSON file\n` +
            `  4. Save it as: ${CLIENT_SECRET_PATH}\n` +
            `  5. Run the server again.\n`
        );
    }

    // Try cached token first
    const saved = loadSavedToken();
    if (saved) {
        // Refresh silently if expired
        try {
            const info = await saved.getAccessToken();
            if (info.token) {
                saveToken(saved); // persist any refreshed token
                return saved;
            }
        } catch {
            // Token refresh failed — fall through to browser login
        }
    }

    // Browser login flow
    process.stderr.write('[EasyCS MCP] Opening browser for Google login...\n');
    const client = await authenticate({ scopes: SCOPES, keyfilePath: CLIENT_SECRET_PATH });
    saveToken(client);
    return client;
}

export async function getLoggedInEmail(client: OAuth2Client): Promise<string> {
    try {
        const res = await client.request<{ email: string }>({
            url: 'https://www.googleapis.com/oauth2/v2/userinfo',
        });
        return res.data.email ?? 'unknown';
    } catch {
        return 'unknown';
    }
}
