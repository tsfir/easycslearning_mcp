/**
 * Group 4 — Progress & At-Risk tools
 *
 * Tools:
 *   get_course_progress   — completion % + points per student
 *   get_at_risk_students  — students flagged as medium or high risk
 *   get_student_summary   — full summary for one student
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getDb } from '../firestore.js';
import { resolveCourse, resolveClass, getStudentsInClass, getAllStudentsInCourse } from '../resolvers.js';

export function registerProgressTools(server: McpServer): void {

    // ── get_course_progress ──────────────────────────────────────────────────
    server.tool(
        'get_course_progress',
        'Get completion percentage and points for every student in a course. Sorted by completion descending.',
        {
            courseName: z.string().describe('Course name or partial name'),
            className: z.string().optional().describe('Class name to filter — optional'),
        },
        async ({ courseName, className }) => {
            const db = getDb();
            const { courseId, courseName: resolvedCourse } = await resolveCourse(db, courseName);

            let students;
            let resolvedClass = 'All Students';
            if (className) {
                const cls = await resolveClass(db, courseId, className);
                resolvedClass = cls.className;
                students = await getStudentsInClass(db, courseId, cls.classId);
            } else {
                students = await getAllStudentsInCourse(db, courseId);
            }

            const progress = await Promise.all(students.map(async s => {
                const docId = `${courseId}_${s.userId}`;
                const statsDoc = await db.collection('studentCourseStats').doc(docId).get();
                const stats = statsDoc.exists ? statsDoc.data()! : null;
                return {
                    fullName: s.fullName,
                    percentComplete: stats?.percentComplete ?? 0,
                    completedSections: stats?.completedSections ?? 0,
                    totalSections: stats?.totalSections ?? 0,
                    totalPoints: stats?.totalPoints ?? 0,
                    averageGrade: stats?.averageGrade ?? null,
                    riskLevel: stats?.riskLevel ?? 'unknown',
                    daysInactive: stats?.daysInactive ?? null,
                };
            }));

            progress.sort((a, b) => b.percentComplete - a.percentComplete);

            const enrolled = progress.length;
            const avgCompletion = enrolled > 0
                ? Math.round(progress.reduce((s, p) => s + p.percentComplete, 0) / enrolled)
                : 0;

            return {
                content: [{
                    type: 'text',
                    text: JSON.stringify({
                        course: resolvedCourse,
                        class: resolvedClass,
                        enrolledStudents: enrolled,
                        classAverageCompletion: `${avgCompletion}%`,
                        students: progress,
                    }, null, 2),
                }],
            };
        }
    );

    // ── get_at_risk_students ─────────────────────────────────────────────────
    server.tool(
        'get_at_risk_students',
        'Get students flagged as medium or high risk in a course. Shows risk level, days inactive, lowest topic and average grade.',
        {
            courseName: z.string().describe('Course name or partial name'),
            className: z.string().optional().describe('Class name to filter — optional'),
            riskLevel: z.enum(['high', 'medium', 'all']).optional().describe('Filter by risk level: "high", "medium", or "all" (default "all")'),
        },
        async ({ courseName, className, riskLevel = 'all' }) => {
            const db = getDb();
            const { courseId, courseName: resolvedCourse } = await resolveCourse(db, courseName);

            let query = db.collection('studentCourseStats').where('courseId', '==', courseId);
            if (riskLevel !== 'all') {
                query = query.where('riskLevel', '==', riskLevel);
            } else {
                // 'all' means medium + high only
                query = query.where('riskLevel', 'in', ['medium', 'high']);
            }

            const statsSnap = await query.get();
            let atRisk = statsSnap.docs.map(d => {
                const data = d.data();
                return {
                    fullName: data.fullName,
                    riskLevel: data.riskLevel,
                    daysInactive: data.daysInactive ?? null,
                    averageGrade: data.averageGrade ?? null,
                    successRate: data.successRate ?? null,
                    lowestTopic: data.lowestTopicName ?? null,
                    lowestTopicGrade: data.lowestTopicGrade ?? null,
                    percentComplete: data.percentComplete ?? 0,
                    lastActivityDate: data.lastActivityDate ?? null,
                    userId: data.userId,
                };
            });

            // Filter by class if requested
            if (className) {
                const cls = await resolveClass(db, courseId, className);
                const classStudents = await getStudentsInClass(db, courseId, cls.classId);
                const classUserIds = new Set(classStudents.map(s => s.userId));
                atRisk = atRisk.filter(s => classUserIds.has(s.userId));
            }

            // Sort: high first, then by days inactive descending
            const severityOrder: Record<string, number> = { high: 2, medium: 1, low: 0 };
            atRisk.sort((a, b) => {
                const sev = (severityOrder[b.riskLevel] ?? 0) - (severityOrder[a.riskLevel] ?? 0);
                if (sev !== 0) return sev;
                return (b.daysInactive ?? 0) - (a.daysInactive ?? 0);
            });

            // Remove internal userId from output
            const output = atRisk.map(({ userId: _uid, ...rest }) => rest);

            return {
                content: [{
                    type: 'text',
                    text: JSON.stringify({
                        course: resolvedCourse,
                        class: className ?? 'All Students',
                        atRiskCount: output.length,
                        students: output,
                    }, null, 2),
                }],
            };
        }
    );

    // ── get_student_summary ──────────────────────────────────────────────────
    server.tool(
        'get_student_summary',
        'Get a comprehensive summary for one student: grades, progress, streak, risk level and weakest topic.',
        {
            studentName: z.string().describe('Student full name or partial name'),
            courseName: z.string().describe('Course name or partial name'),
        },
        async ({ studentName, courseName }) => {
            const db = getDb();
            const { courseId, courseName: resolvedCourse } = await resolveCourse(db, courseName);

            const usersSnap = await db.collection('users').get();
            const userDoc = usersSnap.docs.find(d =>
                (d.data().fullName ?? '').toLowerCase().includes(studentName.toLowerCase().trim())
            );
            if (!userDoc) throw new Error(`Student not found: "${studentName}".`);

            const user = userDoc.data();
            const statsDoc = await db.collection('studentCourseStats').doc(`${courseId}_${userDoc.id}`).get();
            const stats = statsDoc.exists ? statsDoc.data()! : null;
            const progressDoc = await db.collection('userProgress').doc(`${userDoc.id}_${courseId}`).get();
            const progress = progressDoc.exists ? progressDoc.data()! : null;

            // Get lesson scores for breakdown
            const lessonScores = (progress?.lessonScores ?? {}) as Record<string, number>;
            const lessonsSnap = await db.collection('lessons').where('courseId', '==', courseId).orderBy('orderIndex').get();
            const lessonBreakdown = lessonsSnap.docs
                .filter(d => lessonScores[d.id] != null)
                .map(d => ({ lessonName: d.data().lessonName, score: `${lessonScores[d.id]}%` }));

            return {
                content: [{
                    type: 'text',
                    text: JSON.stringify({
                        student: user.fullName,
                        email: user.email,
                        course: resolvedCourse,
                        currentStreak: user.currentStreak ?? 0,
                        totalPoints: stats?.totalPoints ?? progress?.totalPoints ?? 0,
                        averageGrade: stats?.averageGrade != null ? `${Math.round(stats.averageGrade)}%` : '—',
                        successRate: stats?.successRate != null ? `${Math.round(stats.successRate)}%` : '—',
                        percentComplete: `${stats?.percentComplete ?? progress?.percentComplete ?? 0}%`,
                        sectionsCompleted: `${stats?.completedSections ?? 0} / ${stats?.totalSections ?? 0}`,
                        daysInactive: stats?.daysInactive ?? null,
                        lastActivity: stats?.lastActivityDate ?? progress?.lastActivity ?? null,
                        riskLevel: stats?.riskLevel ?? 'unknown',
                        lowestTopic: stats?.lowestTopicName ?? null,
                        lowestTopicGrade: stats?.lowestTopicGrade != null ? `${Math.round(stats.lowestTopicGrade)}%` : null,
                        recentLessonGrades: lessonBreakdown.slice(-10),
                    }, null, 2),
                }],
            };
        }
    );
}
