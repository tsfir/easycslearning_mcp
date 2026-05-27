import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OAuth2Client, GoogleAuth } from 'google-auth-library';

// Mock @google-cloud/firestore so we can inspect how it's called without
// opening a real gRPC connection.
vi.mock('@google-cloud/firestore', () => {
    const Firestore = vi.fn();
    return { Firestore };
});

import { Firestore } from '@google-cloud/firestore';
import { initFirestore, getDb } from '../firestore.js';

const MockFirestore = Firestore as unknown as ReturnType<typeof vi.fn>;

describe('initFirestore', () => {
    beforeEach(() => {
        MockFirestore.mockClear();
    });

    // Must run first — before any initFirestore call sets _db.
    it('getDb() throws before initFirestore is called', () => {
        expect(() => getDb()).toThrow('[EasyCS MCP] Firestore not initialised');
    });

    it('passes a GoogleAuth instance (not OAuth2Client) to Firestore', () => {
        const oauth2Client = new OAuth2Client('id', 'secret');
        oauth2Client.setCredentials({ access_token: 'tok', refresh_token: 'rtok' });

        initFirestore(oauth2Client);

        const [opts] = MockFirestore.mock.calls[0];
        expect(opts.auth).toBeInstanceOf(GoogleAuth);
    });

    it('GoogleAuth wrapper has getUniverseDomain()', async () => {
        const oauth2Client = new OAuth2Client('id', 'secret');
        oauth2Client.setCredentials({ access_token: 'tok', refresh_token: 'rtok' });

        initFirestore(oauth2Client);

        const [opts] = MockFirestore.mock.calls[0];
        const auth = opts.auth as GoogleAuth;

        await expect(auth.getUniverseDomain()).resolves.toBe('googleapis.com');
    });

    it('GoogleAuth wrapper returns the original OAuth2Client from getClient()', async () => {
        const oauth2Client = new OAuth2Client('id', 'secret');
        oauth2Client.setCredentials({ access_token: 'tok', refresh_token: 'rtok' });

        initFirestore(oauth2Client);

        const [opts] = MockFirestore.mock.calls[0];
        const auth = opts.auth as GoogleAuth;
        const client = await auth.getClient();

        expect(client).toBe(oauth2Client);
    });
});
