import { Firestore } from '@google-cloud/firestore';
import { GoogleAuth, OAuth2Client } from 'google-auth-library';

export const PROJECT_ID = 'easycslearning-web-app';

let _db: Firestore | null = null;

export function initFirestore(authClient: OAuth2Client): Firestore {
    // google-gax (used by @google-cloud/firestore v7) requires a GoogleAuth instance,
    // not a raw OAuth2Client — GoogleAuth has getUniverseDomain() and getClient() which
    // OAuth2Client is missing. Pre-seeding cachedCredential skips GoogleAuth's own
    // credential-detection flow and reuses the token we already obtained.
    const gauth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/datastore'] });
    (gauth as unknown as { cachedCredential: OAuth2Client }).cachedCredential = authClient;

    _db = new Firestore({
        projectId: PROJECT_ID,
        auth: gauth,
    });
    return _db;
}

export function getDb(): Firestore {
    if (!_db) throw new Error('[EasyCS MCP] Firestore not initialised. Call initFirestore() first.');
    return _db;
}
