import { Firestore } from '@google-cloud/firestore';
import { OAuth2Client } from 'google-auth-library';

export const PROJECT_ID = 'easycslearning-web-app';

let _db: Firestore | null = null;

export function initFirestore(authClient: OAuth2Client): Firestore {
    _db = new Firestore({
        projectId: PROJECT_ID,
        auth: authClient,
    });
    return _db;
}

export function getDb(): Firestore {
    if (!_db) throw new Error('[EasyCS MCP] Firestore not initialised. Call initFirestore() first.');
    return _db;
}
