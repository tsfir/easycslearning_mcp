import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('@google-cloud/firestore', () => ({ FieldValue: {} }));

const mockGet = vi.fn();
const mockAdd = vi.fn();
const mockOrderBy = vi.fn();
const mockLimit = vi.fn();
const mockWhere = vi.fn();
const mockDoc = vi.fn();

const mockCollection = vi.fn();

vi.mock('../firestore.js', () => ({
    getDb: () => ({ collection: mockCollection }),
}));

vi.mock('../resolvers.js', () => ({
    resolveCourse: vi.fn().mockResolvedValue({ courseId: 'course-1', courseName: 'Python' }),
    resolveLesson: vi.fn().mockResolvedValue({ lessonId: 'lesson-1', lessonName: 'Loops', topicId: 'topic-1' }),
}));

vi.mock('../session.js', () => ({
    getCurrentUserId: vi.fn().mockReturnValue('uid-teacher'),
}));

// ── Snapshot helpers ──────────────────────────────────────────────────────────

/** Simulates a Firestore DocumentSnapshot (from doc().get()). */
function makeDocSnap(data: Record<string, unknown>) {
    return { exists: true, data: () => data };
}

/** Simulates a Firestore QuerySnapshot (from collection().where()...get()). */
function makeQuerySnap(docs: Array<{ id: string; data: Record<string, unknown> }>) {
    return {
        empty: docs.length === 0,
        size: docs.length,
        docs: docs.map(d => ({ id: d.id, data: () => d.data })),
    };
}

// ── Server builder ────────────────────────────────────────────────────────────

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerContentTools } from '../tools/content.js';
import { resolveCourse, resolveLesson } from '../resolvers.js';
import { getCurrentUserId } from '../session.js';

function buildServer() {
    const handlers: Record<string, (args: unknown) => Promise<unknown>> = {};
    const server = {
        tool: (name: string, _desc: unknown, _schema: unknown, handler: (args: unknown) => Promise<unknown>) => {
            handlers[name] = handler;
        },
    } as unknown as McpServer;
    registerContentTools(server);
    return { call: (name: string, args: unknown) => handlers[name](args) };
}

// ── Shared beforeEach ─────────────────────────────────────────────────────────
// vi.resetAllMocks() clears both call records AND queued return values,
// preventing stale mockResolvedValueOnce entries from leaking between tests.

beforeEach(() => {
    // resetAllMocks clears both call records AND queued return values,
    // preventing stale mockResolvedValueOnce entries from leaking between tests.
    // Re-seed every mock after the reset.
    vi.resetAllMocks();

    // Firestore chain
    mockCollection.mockReturnValue({
        where: mockWhere, orderBy: mockOrderBy, limit: mockLimit, add: mockAdd, doc: mockDoc,
    });
    mockWhere.mockReturnValue({ where: mockWhere, orderBy: mockOrderBy, limit: mockLimit, get: mockGet });
    mockOrderBy.mockReturnValue({ orderBy: mockOrderBy, limit: mockLimit, get: mockGet });
    mockLimit.mockReturnValue({ get: mockGet });
    mockDoc.mockReturnValue({ get: mockGet });
    mockAdd.mockResolvedValue({ id: 'new-section-id' });

    // Resolver and session mocks — cleared by resetAllMocks, must be re-seeded
    vi.mocked(resolveCourse).mockResolvedValue({ courseId: 'course-1', courseName: 'Python' });
    vi.mocked(resolveLesson).mockResolvedValue({ lessonId: 'lesson-1', lessonName: 'Loops', topicId: 'topic-1' });
    vi.mocked(getCurrentUserId).mockReturnValue('uid-teacher');
});

// ── get_lesson_content ────────────────────────────────────────────────────────

describe('get_lesson_content', () => {
    it('returns lesson metadata and ordered sections with content', async () => {
        const { call } = buildServer();

        // Call 1: lessons.doc(lessonId).get() → document snapshot
        mockGet
            .mockResolvedValueOnce(makeDocSnap({
                lessonType: 'content', isPublished: true, dueDate: null,
            }))
            // Call 2: sections.where().orderBy().get() → query snapshot
            .mockResolvedValueOnce(makeQuerySnap([
                { id: 's1', data: { orderIndex: 0, title: 'Intro', type: 'text', content: '<p>Hello</p>', points: null, language: null, difficulty: null } },
                { id: 's2', data: { orderIndex: 1, title: 'Exercise', type: 'code', content: 'print()', points: 10, language: 'python', difficulty: 'easy' } },
            ]));

        const result = await call('get_lesson_content', { courseName: 'Python', lessonName: 'Loops' }) as { content: Array<{ text: string }> };
        const json = JSON.parse(result.content[0].text);

        expect(json.lesson).toBe('Loops');
        expect(json.lessonType).toBe('content');
        expect(json.isPublished).toBe(true);
        expect(json.sectionCount).toBe(2);
        expect(json.totalPoints).toBe(10);
        expect(json.sections[0].title).toBe('Intro');
        expect(json.sections[0].content).toBe('<p>Hello</p>');
        expect(json.sections[1].language).toBe('python');
        expect(json.sections[1].difficulty).toBe('easy');
    });

    it('omits content field when includeContent is false', async () => {
        const { call } = buildServer();

        mockGet
            .mockResolvedValueOnce(makeDocSnap({ lessonType: 'content', isPublished: false }))
            .mockResolvedValueOnce(makeQuerySnap([
                { id: 's1', data: { orderIndex: 0, title: 'Intro', type: 'text', content: '<p>Long HTML</p>', points: null, language: null, difficulty: null } },
            ]));

        const result = await call('get_lesson_content', { courseName: 'Python', lessonName: 'Loops', includeContent: false }) as { content: Array<{ text: string }> };
        const json = JSON.parse(result.content[0].text);

        expect(json.sections[0]).not.toHaveProperty('content');
        expect(json.sections[0].title).toBe('Intro');
    });

    it('returns zero totalPoints and empty sections for a lesson with no sections', async () => {
        const { call } = buildServer();

        mockGet
            .mockResolvedValueOnce(makeDocSnap({ lessonType: 'exercise', isPublished: false }))
            .mockResolvedValueOnce(makeQuerySnap([]));

        const result = await call('get_lesson_content', { courseName: 'Python', lessonName: 'Loops' }) as { content: Array<{ text: string }> };
        const json = JSON.parse(result.content[0].text);

        expect(json.sectionCount).toBe(0);
        expect(json.totalPoints).toBe(0);
        expect(json.sections).toHaveLength(0);
    });
});

// ── add_lesson_section ────────────────────────────────────────────────────────

describe('add_lesson_section', () => {
    it('appends a text section with orderIndex = max + 1', async () => {
        const { call } = buildServer();

        // sections.where().orderBy('orderIndex','desc').limit(1).get() → existing max is 2
        mockGet.mockResolvedValueOnce(makeQuerySnap([
            { id: 's3', data: { orderIndex: 2 } },
        ]));

        const result = await call('add_lesson_section', {
            courseName: 'Python',
            lessonName: 'Loops',
            title: 'Summary',
            type: 'text',
            content: '<p>Great job!</p>',
        }) as { content: Array<{ text: string }> };

        const json = JSON.parse(result.content[0].text);
        expect(json.success).toBe(true);
        expect(json.sectionId).toBe('new-section-id');
        expect(json.orderIndex).toBe(3);
        expect(json.type).toBe('text');
        expect(json.createdBy).toBe('uid-teacher');
    });

    it('assigns orderIndex 0 when the lesson has no existing sections', async () => {
        const { call } = buildServer();

        mockGet.mockResolvedValueOnce(makeQuerySnap([]));

        const result = await call('add_lesson_section', {
            courseName: 'Python',
            lessonName: 'Loops',
            title: 'First section',
            type: 'text',
            content: '<p>Hello</p>',
        }) as { content: Array<{ text: string }> };

        const json = JSON.parse(result.content[0].text);
        expect(json.orderIndex).toBe(0);
    });

    it('saves a code section and passes language + points to Firestore', async () => {
        const { call } = buildServer();

        mockGet.mockResolvedValueOnce(makeQuerySnap([]));

        await call('add_lesson_section', {
            courseName: 'Python',
            lessonName: 'Loops',
            title: 'Write a loop',
            type: 'code',
            content: '# write your loop here\n',
            language: 'python',
            points: 20,
        });

        const saved = mockAdd.mock.calls[0][0] as Record<string, unknown>;
        expect(saved.language).toBe('python');
        expect(saved.points).toBe(20);
        expect(saved.createdBy).toBe('uid-teacher');
        expect(saved.type).toBe('code');
    });

    it('throws when language is missing for a code section', async () => {
        const { call } = buildServer();
        mockGet.mockResolvedValueOnce(makeQuerySnap([]));

        await expect(
            call('add_lesson_section', {
                courseName: 'Python', lessonName: 'Loops',
                title: 'Exercise', type: 'code', content: 'print()', points: 10,
            })
        ).rejects.toThrow('language is required for code sections');
    });

    it('throws when points is missing for an interactive section', async () => {
        const { call } = buildServer();
        mockGet.mockResolvedValueOnce(makeQuerySnap([]));

        await expect(
            call('add_lesson_section', {
                courseName: 'Python', lessonName: 'Loops',
                title: 'Question', type: 'interactive',
                content: '<p>What does a for loop do?</p>',
            })
        ).rejects.toThrow('points is required');
    });

    it('includes difficulty in the Firestore document when provided', async () => {
        const { call } = buildServer();
        mockGet.mockResolvedValueOnce(makeQuerySnap([]));

        await call('add_lesson_section', {
            courseName: 'Python', lessonName: 'Loops',
            title: 'Hard exercise', type: 'code',
            content: 'def solve():\n    pass', language: 'python', points: 30,
            difficulty: 'hard',
        });

        const saved = mockAdd.mock.calls[0][0] as Record<string, unknown>;
        expect(saved.difficulty).toBe('hard');
    });
});
