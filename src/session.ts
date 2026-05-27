/**
 * Runtime session — holds the identity of the authenticated MCP user.
 * Populated once at startup by index.ts after Firestore is ready.
 */

let _email: string | null = null;
let _userId: string | null = null;

export function setSession(email: string, userId: string | null): void {
    _email = email;
    _userId = userId;
}

export function getCurrentUserId(): string | null {
    return _userId;
}

export function getCurrentEmail(): string {
    return _email ?? 'unknown';
}
