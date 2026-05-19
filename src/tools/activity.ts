/**
 * Group 5 — Activity & Attendance tools
 *
 * "Attendance" is proxied from two data sources:
 *   - studentCourseStats.daysInactive / lastActivityDate  (was the student active recently?)
 *   - studentAnswers  (did the student submit work for a specific lesson?)
 *
 * Tools:
 *   get_inactive_students   — students who haven't been active in N days
 *   get_daily_activity      — daily chart: active students, answers, avg grade
 *   get_lesson_attendance   — per-lesson submission status (proxy attendance)
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getDb } from '../firestore.js';
import {
    resolveCourse,
    resolveLesson,
    resolveClass,
    getStudentsInClass,
    getAllStudentsInCourse,
} from '../resolvers.js';

export function registerActivityTools(server: McpServer): void {

    // ── get_inactive_students ────────────────────────────────────────────────
    server.tool(
        'get_inactive_students',
        'Get students who have not submitted any work in the last N days (default: 7). Useful for identifying disengaged students.',
        {
            courseName: z.string().describe('Course name or partial name'),
            className: z.string().optional().describe('Class name to filter — optional'),
            daysSince: z.number().min(1).max(365).optional().describe('Number of days of inactivity threshold — default 7'),
        },
        async ({ courseName, className, daysSince = 7 }) => {
            const db = getDb();
            const { courseId, courseName: resolvedCourse } = await resolveCourse(db, courseName);

            const statsSnap = await db.collection('studentCourseStats')
                .where('courseId', '==', courseId)
                .where('daysInactive', '>=', daysSince)
                .get();

            let inactive = statsSnap.docs.map(d => {
                const data = d.data();
                return {
                    fullName: data.fullName,
                    daysInactive: data.daysInactive,
                    lastActivityDate: data.lastActivityDate ?? 'never',
                    percentComplete: data.percentComplete ?? 0,
                    riskLevel: data.riskLevel ?? 'unknown',
                    userId: data.userId as string,
                };
            });

            if (className) {
                const cls = await resolveClass(db, courseId, className);
                const classStudents = await getStudentsInClass(db, courseId, cls.classId);
                const ids = new Set(classStudents.map(s => s.userId));
                inactive = inactive.filter(s => ids.has(s.userId));
            }

            inactive.sort((a, b) => b.daysInactive - a.daysInactive);
            const output = inactive.map(({ userId: _uid, ...rest }) => rest);

            return {
                content: [{
                    type: 'text',
                    text: JSON.stringify({
                        course: resolvedCourse,
                        class: className ?? 'All Students',
                        inactivityThreshold: `${daysSince} days`,
                        inactiveCount: output.length,
                        students: output,
                    }, null, 2),
                }],
            };
        }
    );

    // ── get_daily_activity ───────────────────────────────────────────────────
    server.tool(
        'get_daily_activity',
        'Get daily activity stats for a course: active students, answers submitted, average grade. Last 14 days by default.',
        {
            courseName: z.string().describe('Course name or partial name'),
            days: z.number().min(1).max(30).optional().describe('Number of days to look back — default 14, max 30'),
        },
        async ({ courseName, days = 14 }) => {
            const db = getDb();
            const { courseId, courseName: resolvedCourse } = await resolveCourse(db, courseName);

            const analyticsDoc = await db.collection('courseAnalytics').doc(courseId).get();
            if (!analyticsDoc.exists) {
                return { content: [{ type: 'text', text: `No analytics data found for course "${resolvedCourse}" yet.` }] };
            }

            const allDailyStats = (analyticsDoc.data()!.dailyStats ?? []) as Array<{
                date: string;
                totalPointsEarned: number;
                totalAnswersSubmitted: number;
                averageGrade: number;
                activeStudents: number;
            }>;

            // The stored array covers up to 30 days; slice to requested window
            const recent = allDailyStats
                .sort((a, b) => a.date.localeCompare(b.date))
                .slice(-days);

            const totalAnswers = recent.reduce((s, d) => s + (d.totalAnswersSubmitted ?? 0), 0);
            const totalPoints = recent.reduce((s, d) => s + (d.totalPointsEarned ?? 0), 0);
            const peakDay = recent.reduce((max, d) =>
                (d.activeStudents ?? 0) > (max.activeStudents ?? 0) ? d : max,
                recent[0] ?? { date: '—', activeStudents: 0 }
            );

            return {
                content: [{
                    type: 'text',
                    text: JSON.stringify({
                        course: resolvedCourse,
                        period: `Last ${days} days`,
                        summary: {
                            totalAnswersSubmitted: totalAnswers,
                            totalPointsEarned: totalPoints,
                            peakActiveDay: peakDay?.date ?? '—',
                            peakActiveStudents: peakDay?.activeStudents ?? 0,
                        },
                        dailyStats: recent,
                    }, null, 2),
                }],
            };
        }
    );

    // ── get_lesson_attendance ────────────────────────────────────────────────
    server.tool(
        'get_lesson_attendance',
        'Check which students submitted work for a specific lesson (proxy for attendance). Returns submitted vs not-submitted lists.',
        {
            courseName: z.string().describe('Course name or partial name'),
            lessonName: z.string().describe('Lesson name or partial name'),
            className: z.string().optional().describe('Class name to filter — optional'),
        },
        async ({ courseName, lessonName, className }) => {
            const db = getDb();
            const { courseId, courseName: resolvedCourse } = await resolveCourse(db, courseName);
            const { lessonId, lessonName: resolvedLesson } = await resolveLesson(db, courseId, lessonName);

            let students;
            let resolvedClass = 'All Students';
            if (className) {
                const cls = await resolveClass(db, courseId, className);
                resolvedClass = cls.className;
                students = await getStudentsInClass(db, courseId, cls.classId);
            } else {
                students = await getAllStudentsInCourse(db, courseId);
            }

            // Students who submitted at least one answer for this lesson
            const answersSnap = await db.collection('studentAnswers')
                .where('lessonId', '==', lessonId)
                .get();

            const submittedUserIds = new Set(answersSnap.docs.map(d => d.data().userId as string));

            const submitted = students.filter(s => submittedUserIds.has(s.userId)).map(s => ({
                fullName: s.fullName,
                email: s.email ?? '',
            }));
            const notSubmitted = students.filter(s => !submittedUserIds.has(s.userId)).map(s => ({
                fullName: s.fullName,
                email: s.email ?? '',
            }));

            const total = students.length;
            const attendanceRate = total > 0
                ? `${Math.round((submitted.length / total) * 100)}%`
                : '—';

            return {
                content: [{
                    type: 'text',
                    text: JSON.stringify({
                        course: resolvedCourse,
                        lesson: resolvedLesson,
                        class: resolvedClass,
                        totalStudents: total,
                        submitted: submitted.length,
                        notSubmitted: notSubmitted.length,
                        attendanceRate,
                        submittedStudents: submitted,
                        absentStudents: notSubmitted,
                    }, null, 2),
                }],
            };
        }
    );
}
