/**
 * Group 7 — Content tools
 *
 * Tools:
 *   create_lesson        — create a new lesson inside a topic
 *   get_lesson_content   — read all sections of a lesson in order
 *   add_lesson_section   — append a new section to an existing lesson
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { FieldValue } from '@google-cloud/firestore';
import { getDb } from '../firestore.js';
import { resolveCourse, resolveTopic, resolveLesson } from '../resolvers.js';
import { getCurrentUserId } from '../session.js';

export function registerContentTools(server: McpServer): void {

    // ── create_lesson ────────────────────────────────────────────────────────
    server.tool(
        'create_lesson',
        [
            'Create a new lesson inside a topic. The lesson is appended after all existing lessons in that topic.',
            '',
            'Lesson types:',
            '  content  — a reading/explanation lesson (text sections only).',
            '  exercise — a hands-on coding lesson (code/interactive sections).',
            '  quiz     — a quiz-style assessment.',
            '',
            'The lesson is created as a draft (isPublished: false) by default.',
            'Use add_lesson_section after creation to populate it with content.',
        ].join('\n'),
        {
            courseName: z.string().describe('Course name or partial name'),
            topicName: z.string().describe('Topic (module) name or partial name'),
            lessonName: z.string().min(1).describe('Name of the new lesson'),
            lessonType: z.enum(['content', 'exercise', 'quiz'])
                .describe('Lesson type: content (reading), exercise (coding), or quiz'),
            isPublished: z.boolean().optional()
                .describe('Whether the lesson is visible to students — default false (draft)'),
            dueDate: z.string().optional()
                .describe('Due date in ISO format, e.g. "2025-06-30" — optional'),
        },
        async ({ courseName, topicName, lessonName, lessonType, isPublished = false, dueDate }) => {
            const db = getDb();
            const { courseId, courseName: resolvedCourse } = await resolveCourse(db, courseName);
            const { topicId, topicName: resolvedTopic } = await resolveTopic(db, courseId, topicName);

            // Generate a URL-friendly slug from the lesson name
            const lessonSlug = lessonName
                .toLowerCase()
                .trim()
                .replace(/[^\w\s-]/g, '')
                .replace(/\s+/g, '-')
                .replace(/-+/g, '-');

            // Determine next orderIndex within the topic
            const existingSnap = await db.collection('lessons')
                .where('topicId', '==', topicId)
                .orderBy('orderIndex', 'desc')
                .limit(1)
                .get();
            const nextIndex = existingSnap.empty
                ? 0
                : (existingSnap.docs[0].data().orderIndex as number) + 1;

            const now = new Date().toISOString();

            const newLesson: Record<string, unknown> = {
                courseId,
                topicId,
                lessonName,
                lessonSlug,
                lessonType,
                orderIndex: nextIndex,
                isPublished,
                createdAt: now,
                updatedAt: now,
            };
            if (dueDate) newLesson.dueDate = dueDate;

            const ref = await db.collection('lessons').add(newLesson);

            return {
                content: [{
                    type: 'text',
                    text: JSON.stringify({
                        success: true,
                        course: resolvedCourse,
                        topic: resolvedTopic,
                        lessonId: ref.id,
                        lessonName,
                        lessonSlug,
                        lessonType,
                        orderIndex: nextIndex,
                        isPublished,
                        ...(dueDate && { dueDate }),
                        hint: 'Use add_lesson_section to add content to this lesson.',
                    }, null, 2),
                }],
            };
        }
    );

    // ── get_lesson_content ───────────────────────────────────────────────────
    server.tool(
        'get_lesson_content',
        'Read all sections of a lesson in order. Returns title, type, content (HTML for text, starter code for code, question for interactive), points, language and difficulty for each section.',
        {
            courseName: z.string().describe('Course name or partial name'),
            lessonName: z.string().describe('Lesson name or partial name'),
            includeContent: z.boolean().optional()
                .describe('Include the full content field — default true. Set false for a lightweight section index (titles + types only).'),
        },
        async ({ courseName, lessonName, includeContent = true }) => {
            const db = getDb();
            const { courseId, courseName: resolvedCourse } = await resolveCourse(db, courseName);
            const { lessonId, lessonName: resolvedLesson, topicId } = await resolveLesson(db, courseId, lessonName);

            // Fetch lesson metadata
            const lessonDoc = await db.collection('lessons').doc(lessonId).get();
            const lessonData = lessonDoc.data()!;

            // Fetch sections ordered by position
            const sectionsSnap = await db.collection('sections')
                .where('lessonId', '==', lessonId)
                .orderBy('orderIndex')
                .get();

            const sections = sectionsSnap.docs.map(d => {
                const s = d.data();
                const section: Record<string, unknown> = {
                    sectionId: d.id,
                    orderIndex: s.orderIndex,
                    title: s.title,
                    type: s.type,
                    points: s.points ?? null,
                    language: s.language ?? null,
                    difficulty: s.difficulty ?? null,
                };
                if (includeContent) {
                    section.content = s.content ?? '';
                    if (s.starterValue) section.starterValue = s.starterValue;
                }
                return section;
            });

            const totalPoints = sections.reduce((sum, s) => sum + ((s.points as number) ?? 0), 0);

            return {
                content: [{
                    type: 'text',
                    text: JSON.stringify({
                        course: resolvedCourse,
                        lesson: resolvedLesson,
                        lessonId,
                        topicId,
                        lessonType: lessonData.lessonType,
                        isPublished: lessonData.isPublished,
                        dueDate: lessonData.dueDate ?? null,
                        sectionCount: sections.length,
                        totalPoints,
                        sections,
                    }, null, 2),
                }],
            };
        }
    );

    // ── add_lesson_section ───────────────────────────────────────────────────
    server.tool(
        'add_lesson_section',
        [
            'Append a new section to an existing lesson. The section is added after all existing sections.',
            '',
            'Section types:',
            '  text        — rich text explanation. content must be valid HTML (e.g. <p>, <strong>, <ul>, <code>).',
            '  code        — coding exercise. content is the starter code shown to the student. language and points are required.',
            '  interactive — open-ended question. content is the question text (HTML). points is required.',
            '',
            'The createdBy field is set automatically to the logged-in teacher\'s UID.',
        ].join('\n'),
        {
            courseName: z.string().describe('Course name or partial name'),
            lessonName: z.string().describe('Lesson name or partial name'),
            title: z.string().describe('Section heading — also used as the exercise title in the integrity panel'),
            type: z.enum(['text', 'code', 'interactive']).describe('Section type'),
            content: z.string().describe(
                'For text: HTML string (e.g. "<p>Explanation here</p>"). ' +
                'For code: starter code string shown in the editor. ' +
                'For interactive: question text as HTML.'
            ),
            language: z.enum(['csharp', 'python', 'java', 'javascript']).optional()
                .describe('Programming language — required for code sections'),
            points: z.number().int().min(1).optional()
                .describe('Points awarded for a correct answer — required for code and interactive sections'),
            difficulty: z.enum(['easy', 'medium', 'hard']).optional()
                .describe('Difficulty level — optional'),
        },
        async ({ courseName, lessonName, title, type, content, language, points, difficulty }) => {
            // Validate type-specific required fields
            if (type === 'code' && !language) {
                throw new Error('language is required for code sections.');
            }
            if ((type === 'code' || type === 'interactive') && points == null) {
                throw new Error('points is required for code and interactive sections.');
            }

            const db = getDb();
            const { courseId, courseName: resolvedCourse } = await resolveCourse(db, courseName);
            const { lessonId, lessonName: resolvedLesson } = await resolveLesson(db, courseId, lessonName);

            // Determine next orderIndex (max existing + 1, or 0 if lesson is empty)
            const existingSnap = await db.collection('sections')
                .where('lessonId', '==', lessonId)
                .orderBy('orderIndex', 'desc')
                .limit(1)
                .get();
            const nextIndex = existingSnap.empty
                ? 0
                : (existingSnap.docs[0].data().orderIndex as number) + 1;

            const now = new Date().toISOString();
            const createdBy = getCurrentUserId() ?? 'mcp';

            const newSection: Record<string, unknown> = {
                lessonId,
                title,
                type,
                content,
                orderIndex: nextIndex,
                createdBy,
                createdAt: now,
                updatedAt: now,
            };

            if (language) newSection.language = language;
            if (points != null) newSection.points = points;
            if (difficulty) newSection.difficulty = difficulty;

            const ref = await db.collection('sections').add(newSection);

            return {
                content: [{
                    type: 'text',
                    text: JSON.stringify({
                        success: true,
                        course: resolvedCourse,
                        lesson: resolvedLesson,
                        sectionId: ref.id,
                        orderIndex: nextIndex,
                        title,
                        type,
                        ...(points != null && { points }),
                        ...(language && { language }),
                        ...(difficulty && { difficulty }),
                        createdBy,
                    }, null, 2),
                }],
            };
        }
    );
}
