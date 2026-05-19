/**
 * Group 2 — Roster & Student tools
 *
 * Tools:
 *   get_class_roster   — students enrolled in a specific class
 *   get_student_info   — profile + overall stats for one student
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getDb } from '../firestore.js';
import { resolveCourse, resolveClass, getStudentsInClass } from '../resolvers.js';

export function registerRosterTools(server: McpServer): void {

    // ── get_class_roster ─────────────────────────────────────────────────────
    server.tool(
        'get_class_roster',
        'Get the list of students enrolled in a specific class. Returns name, email, join date, current streak and total points.',
        {
            courseName: z.string().describe('Course name or partial name'),
            className: z.string().describe('Class name or partial name, e.g. "Yod 4"'),
        },
        async ({ courseName, className }) => {
            const db = getDb();
            const { courseId, courseName: resolvedCourse } = await resolveCourse(db, courseName);
            const { classId, className: resolvedClass } = await resolveClass(db, courseId, className);

            const students = await getStudentsInClass(db, courseId, classId);
            if (students.length === 0) {
                return { content: [{ type: 'text', text: `No students found in class "${resolvedClass}".` }] };
            }

            // Enrich with progress data
            const progressSnap = await db.collection('userProgress')
                .where('courseId', '==', courseId)
                .where('classId', '==', classId)
                .get();
            const progressByUser = new Map(progressSnap.docs.map(d => [d.data().userId as string, d.data()]));

            // Enrich with user streaks
            const userIds = students.map(s => s.userId);
            const usersData = new Map<string, Record<string, unknown>>();
            for (let i = 0; i < userIds.length; i += 30) {
                const chunk = userIds.slice(i, i + 30);
                const snap = await db.collection('users').where('__name__', 'in', chunk).get();
                snap.docs.forEach(d => usersData.set(d.id, d.data() as Record<string, unknown>));
            }

            const roster = students.map(s => {
                const prog = progressByUser.get(s.userId);
                const user = usersData.get(s.userId);
                return {
                    fullName: s.fullName,
                    email: s.email ?? '',
                    currentStreak: (user?.currentStreak as number) ?? 0,
                    totalPoints: prog?.totalPoints ?? 0,
                    percentComplete: prog?.percentComplete ?? 0,
                    lastActivity: prog?.lastActivity ?? null,
                };
            });

            return {
                content: [{
                    type: 'text',
                    text: JSON.stringify({
                        course: resolvedCourse,
                        class: resolvedClass,
                        studentCount: roster.length,
                        students: roster,
                    }, null, 2),
                }],
            };
        }
    );

    // ── get_student_info ─────────────────────────────────────────────────────
    server.tool(
        'get_student_info',
        'Get full profile and course stats for a single student. Returns points, streak, risk level, completion and weakest topic.',
        {
            studentName: z.string().describe('Student full name or partial name'),
            courseName: z.string().describe('Course name or partial name'),
        },
        async ({ studentName, courseName }) => {
            const db = getDb();
            const { courseId, courseName: resolvedCourse } = await resolveCourse(db, courseName);

            // Find user by name
            const usersSnap = await db.collection('users').get();
            const userDoc = usersSnap.docs.find(d =>
                (d.data().fullName ?? '').toLowerCase().includes(studentName.toLowerCase().trim())
            );
            if (!userDoc) throw new Error(`Student not found: "${studentName}".`);

            const user = userDoc.data();
            const statsDocId = `${courseId}_${userDoc.id}`;
            const statsDoc = await db.collection('studentCourseStats').doc(statsDocId).get();
            const stats = statsDoc.exists ? statsDoc.data()! : null;

            const progressDocId = `${userDoc.id}_${courseId}`;
            const progressDoc = await db.collection('userProgress').doc(progressDocId).get();
            const progress = progressDoc.exists ? progressDoc.data()! : null;

            return {
                content: [{
                    type: 'text',
                    text: JSON.stringify({
                        fullName: user.fullName,
                        email: user.email,
                        course: resolvedCourse,
                        currentStreak: user.currentStreak ?? 0,
                        totalPoints: stats?.totalPoints ?? progress?.totalPoints ?? 0,
                        averageGrade: stats?.averageGrade ?? null,
                        successRate: stats?.successRate ?? null,
                        percentComplete: stats?.percentComplete ?? progress?.percentComplete ?? 0,
                        completedSections: stats?.completedSections ?? 0,
                        totalSections: stats?.totalSections ?? 0,
                        daysInactive: stats?.daysInactive ?? null,
                        lastActivityDate: stats?.lastActivityDate ?? progress?.lastActivity ?? null,
                        riskLevel: stats?.riskLevel ?? 'unknown',
                        lowestTopic: stats?.lowestTopicName ?? null,
                        lowestTopicGrade: stats?.lowestTopicGrade ?? null,
                    }, null, 2),
                }],
            };
        }
    );
}
