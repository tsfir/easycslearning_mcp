/**
 * Group 1 — Discovery tools
 *
 * These tools let Claude translate human-readable names into IDs
 * and explore the course structure before calling other tools.
 *
 * Tools:
 *   list_courses      — all active courses
 *   list_topics       — topics in a course
 *   list_lessons      — lessons in a course (optionally filtered by topic)
 *   list_classes      — classes for a course
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getDb } from '../firestore.js';

export function registerDiscoveryTools(server: McpServer): void {

    // ── list_courses ─────────────────────────────────────────────────────────
    server.tool(
        'list_courses',
        'List all active courses. Returns name, level, language, student count and ID for each course.',
        {},
        async () => {
            const db = getDb();
            const snap = await db.collection('courses').where('isActive', '==', true).orderBy('orderIndex').get();
            const courses = snap.docs.map(d => {
                const data = d.data();
                return {
                    courseId: d.id,
                    courseName: data.courseName,
                    level: data.level,
                    language: data.defaultLanguage ?? 'not specified',
                    studentCount: data.studentCount ?? 0,
                    description: data.description ?? '',
                };
            });
            return {
                content: [{
                    type: 'text',
                    text: JSON.stringify(courses, null, 2),
                }],
            };
        }
    );

    // ── list_topics ──────────────────────────────────────────────────────────
    server.tool(
        'list_topics',
        'List all topics (modules) in a course, in order.',
        { courseName: z.string().describe('Course name or partial name, e.g. "C# for Beginners"') },
        async ({ courseName }) => {
            const db = getDb();
            const coursesSnap = await db.collection('courses').get();
            const courseDoc = coursesSnap.docs.find(d =>
                (d.data().courseName ?? '').toLowerCase().includes(courseName.toLowerCase().trim())
            );
            if (!courseDoc) throw new Error(`Course not found: "${courseName}". Use list_courses to see available courses.`);

            const snap = await db.collection('topics')
                .where('courseId', '==', courseDoc.id)
                .orderBy('orderIndex')
                .get();

            const topics = snap.docs.map(d => ({
                topicId: d.id,
                topicName: d.data().topicName,
                level: d.data().level ?? '',
                orderIndex: d.data().orderIndex,
            }));

            return {
                content: [{
                    type: 'text',
                    text: JSON.stringify({ course: courseDoc.data().courseName, topics }, null, 2),
                }],
            };
        }
    );

    // ── list_lessons ─────────────────────────────────────────────────────────
    server.tool(
        'list_lessons',
        'List lessons in a course. Optionally filter by topic name. Returns lesson name, type, due date, and IDs.',
        {
            courseName: z.string().describe('Course name or partial name'),
            topicName: z.string().optional().describe('Topic (module) name to filter by — optional'),
        },
        async ({ courseName, topicName }) => {
            const db = getDb();
            const coursesSnap = await db.collection('courses').get();
            const courseDoc = coursesSnap.docs.find(d =>
                (d.data().courseName ?? '').toLowerCase().includes(courseName.toLowerCase().trim())
            );
            if (!courseDoc) throw new Error(`Course not found: "${courseName}". Use list_courses to see available courses.`);

            let lessonsQuery = db.collection('lessons')
                .where('courseId', '==', courseDoc.id)
                .orderBy('orderIndex');

            if (topicName) {
                const topicsSnap = await db.collection('topics').where('courseId', '==', courseDoc.id).get();
                const topicDoc = topicsSnap.docs.find(d =>
                    (d.data().topicName ?? '').toLowerCase().includes(topicName.toLowerCase().trim())
                );
                if (!topicDoc) throw new Error(`Topic not found: "${topicName}" in course "${courseDoc.data().courseName}".`);
                lessonsQuery = db.collection('lessons')
                    .where('courseId', '==', courseDoc.id)
                    .where('topicId', '==', topicDoc.id)
                    .orderBy('orderIndex');
            }

            const snap = await lessonsQuery.get();
            const lessons = snap.docs.map(d => ({
                lessonId: d.id,
                lessonName: d.data().lessonName,
                lessonType: d.data().lessonType,
                isPublished: d.data().isPublished,
                dueDate: d.data().dueDate ?? null,
                topicId: d.data().topicId,
                orderIndex: d.data().orderIndex,
            }));

            return {
                content: [{
                    type: 'text',
                    text: JSON.stringify({ course: courseDoc.data().courseName, lessons }, null, 2),
                }],
            };
        }
    );

    // ── list_classes ─────────────────────────────────────────────────────────
    server.tool(
        'list_classes',
        'List classes (groups) for a course with student count and join code.',
        { courseName: z.string().describe('Course name or partial name') },
        async ({ courseName }) => {
            const db = getDb();
            const coursesSnap = await db.collection('courses').get();
            const courseDoc = coursesSnap.docs.find(d =>
                (d.data().courseName ?? '').toLowerCase().includes(courseName.toLowerCase().trim())
            );
            if (!courseDoc) throw new Error(`Course not found: "${courseName}". Use list_courses to see available courses.`);

            const classesSnap = await db.collection('courseClasses')
                .where('courseId', '==', courseDoc.id)
                .orderBy('createdAt')
                .get();

            // Get student counts from userProgress
            const classes = await Promise.all(classesSnap.docs.map(async d => {
                const data = d.data();
                const progressSnap = await db.collection('userProgress')
                    .where('courseId', '==', courseDoc.id)
                    .where('classId', '==', d.id)
                    .get();
                return {
                    classId: d.id,
                    className: data.name,
                    joinCode: data.code,
                    studentCount: progressSnap.size,
                    createdAt: data.createdAt,
                };
            }));

            return {
                content: [{
                    type: 'text',
                    text: JSON.stringify({ course: courseDoc.data().courseName, classes }, null, 2),
                }],
            };
        }
    );
}
