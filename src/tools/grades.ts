/**
 * Group 3 — Grades tools
 *
 * Tools:
 *   get_lesson_grades      — per-student grades for a lesson
 *   get_failing_students   — students below a score threshold
 *   get_student_grades     — all lesson grades for one student
 *   get_grade_matrix       — full student × lesson grid
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

function pct(grade: number | null | undefined, maxPoints: number): string {
    if (grade == null || maxPoints === 0) return '—';
    return `${Math.round((grade / maxPoints) * 100)}%`;
}

export function registerGradesTools(server: McpServer): void {

    // ── get_lesson_grades ────────────────────────────────────────────────────
    server.tool(
        'get_lesson_grades',
        'Get grades for every student in a lesson. Optionally filter by class. Results sorted highest to lowest.',
        {
            courseName: z.string().describe('Course name or partial name'),
            lessonName: z.string().describe('Lesson name or partial name'),
            className: z.string().optional().describe('Class name to filter — optional; omit for all students'),
        },
        async ({ courseName, lessonName, className }) => {
            const db = getDb();
            const { courseId, courseName: resolvedCourse } = await resolveCourse(db, courseName);
            const { lessonId, lessonName: resolvedLesson } = await resolveLesson(db, courseId, lessonName);

            // Get max points for the lesson (sum of section points)
            const sectionsSnap = await db.collection('sections').where('lessonId', '==', lessonId).get();
            const maxPoints = sectionsSnap.docs.reduce((sum, d) => sum + (d.data().points ?? 0), 0);

            // Determine student set
            let students;
            let resolvedClass = 'All Students';
            if (className) {
                const cls = await resolveClass(db, courseId, className);
                resolvedClass = cls.className;
                students = await getStudentsInClass(db, courseId, cls.classId);
            } else {
                students = await getAllStudentsInCourse(db, courseId);
            }

            // Fetch answers for the lesson
            const answersSnap = await db.collection('studentAnswers')
                .where('lessonId', '==', lessonId)
                .get();

            // Aggregate grade per student (sum of section grades)
            const gradeByUser = new Map<string, number>();
            answersSnap.docs.forEach(d => {
                const data = d.data();
                if (data.grade == null) return;
                const current = gradeByUser.get(data.userId) ?? 0;
                gradeByUser.set(data.userId, current + (data.grade as number));
            });

            const grades = students.map(s => ({
                fullName: s.fullName,
                email: s.email ?? '',
                pointsEarned: gradeByUser.has(s.userId) ? gradeByUser.get(s.userId)! : null,
                maxPoints,
                percentage: pct(gradeByUser.get(s.userId), maxPoints),
                submitted: gradeByUser.has(s.userId),
            })).sort((a, b) => (b.pointsEarned ?? -1) - (a.pointsEarned ?? -1));

            const submittedCount = grades.filter(g => g.submitted).length;
            const avg = submittedCount > 0
                ? Math.round(grades.filter(g => g.submitted).reduce((s, g) => s + (g.pointsEarned! / maxPoints) * 100, 0) / submittedCount)
                : null;

            return {
                content: [{
                    type: 'text',
                    text: JSON.stringify({
                        course: resolvedCourse,
                        lesson: resolvedLesson,
                        class: resolvedClass,
                        maxPoints,
                        submittedCount,
                        classAverage: avg != null ? `${avg}%` : '—',
                        grades,
                    }, null, 2),
                }],
            };
        }
    );

    // ── get_failing_students ─────────────────────────────────────────────────
    server.tool(
        'get_failing_students',
        'Get students who scored below a threshold in a lesson. Default threshold is 60%. Perfect for sending follow-up messages.',
        {
            courseName: z.string().describe('Course name or partial name'),
            lessonName: z.string().describe('Lesson name or partial name'),
            className: z.string().optional().describe('Class name to filter — optional'),
            threshold: z.number().min(0).max(100).optional().describe('Percentage threshold, default 60'),
        },
        async ({ courseName, lessonName, className, threshold = 60 }) => {
            const db = getDb();
            const { courseId, courseName: resolvedCourse } = await resolveCourse(db, courseName);
            const { lessonId, lessonName: resolvedLesson } = await resolveLesson(db, courseId, lessonName);

            const sectionsSnap = await db.collection('sections').where('lessonId', '==', lessonId).get();
            const maxPoints = sectionsSnap.docs.reduce((sum, d) => sum + (d.data().points ?? 0), 0);

            let students;
            let resolvedClass = 'All Students';
            if (className) {
                const cls = await resolveClass(db, courseId, className);
                resolvedClass = cls.className;
                students = await getStudentsInClass(db, courseId, cls.classId);
            } else {
                students = await getAllStudentsInCourse(db, courseId);
            }

            const answersSnap = await db.collection('studentAnswers').where('lessonId', '==', lessonId).get();
            const gradeByUser = new Map<string, number>();
            answersSnap.docs.forEach(d => {
                const data = d.data();
                if (data.grade == null) return;
                gradeByUser.set(data.userId, (gradeByUser.get(data.userId) ?? 0) + (data.grade as number));
            });

            const failing = students
                .map(s => {
                    const earned = gradeByUser.get(s.userId) ?? null;
                    const percentage = earned != null && maxPoints > 0
                        ? Math.round((earned / maxPoints) * 100)
                        : null;
                    return { fullName: s.fullName, email: s.email ?? '', pointsEarned: earned, maxPoints, percentage };
                })
                .filter(s => s.percentage == null || s.percentage < threshold)
                .sort((a, b) => (a.percentage ?? -1) - (b.percentage ?? -1));

            return {
                content: [{
                    type: 'text',
                    text: JSON.stringify({
                        course: resolvedCourse,
                        lesson: resolvedLesson,
                        class: resolvedClass,
                        threshold: `${threshold}%`,
                        failingCount: failing.length,
                        students: failing,
                    }, null, 2),
                }],
            };
        }
    );

    // ── get_student_grades ───────────────────────────────────────────────────
    server.tool(
        'get_student_grades',
        'Get all lesson grades for a single student across an entire course.',
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

            const progressDocId = `${userDoc.id}_${courseId}`;
            const progressDoc = await db.collection('userProgress').doc(progressDocId).get();
            if (!progressDoc.exists) {
                return { content: [{ type: 'text', text: `Student "${userDoc.data().fullName}" is not enrolled in "${resolvedCourse}".` }] };
            }

            const lessonScores = (progressDoc.data()!.lessonScores ?? {}) as Record<string, number>;

            // Enrich with lesson names
            const lessonsSnap = await db.collection('lessons').where('courseId', '==', courseId).orderBy('orderIndex').get();
            const lessonGrades = lessonsSnap.docs.map(d => ({
                lessonName: d.data().lessonName,
                topicId: d.data().topicId,
                score: lessonScores[d.id] ?? null,
                scoreLabel: lessonScores[d.id] != null ? `${lessonScores[d.id]}%` : 'Not submitted',
            }));

            const completedCount = lessonGrades.filter(l => l.score != null).length;
            const avg = completedCount > 0
                ? Math.round(lessonGrades.filter(l => l.score != null).reduce((s, l) => s + l.score!, 0) / completedCount)
                : null;

            return {
                content: [{
                    type: 'text',
                    text: JSON.stringify({
                        student: userDoc.data().fullName,
                        course: resolvedCourse,
                        lessonsCompleted: `${completedCount}/${lessonGrades.length}`,
                        averageScore: avg != null ? `${avg}%` : '—',
                        lessonGrades,
                    }, null, 2),
                }],
            };
        }
    );

    // ── get_grade_matrix ─────────────────────────────────────────────────────
    server.tool(
        'get_grade_matrix',
        'Get the full grade grid — every student vs every lesson — for a course. Optionally filter by class.',
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

            const lessonsSnap = await db.collection('lessons')
                .where('courseId', '==', courseId)
                .orderBy('orderIndex')
                .get();

            // Fetch all lesson scores from userProgress (fast — one doc per student)
            const matrix = await Promise.all(students.map(async s => {
                const progressDoc = await db.collection('userProgress').doc(`${s.userId}_${courseId}`).get();
                const scores = progressDoc.exists ? (progressDoc.data()!.lessonScores ?? {}) as Record<string, number> : {};
                const lessonScores = lessonsSnap.docs.map(d => ({
                    lessonName: d.data().lessonName,
                    score: scores[d.id] ?? null,
                }));
                const completed = lessonScores.filter(l => l.score != null).length;
                const avg = completed > 0
                    ? Math.round(lessonScores.filter(l => l.score != null).reduce((s, l) => s + l.score!, 0) / completed)
                    : null;
                return {
                    student: s.fullName,
                    averageScore: avg != null ? `${avg}%` : '—',
                    lessonsCompleted: `${completed}/${lessonsSnap.size}`,
                    lessonScores,
                };
            }));

            return {
                content: [{
                    type: 'text',
                    text: JSON.stringify({
                        course: resolvedCourse,
                        class: resolvedClass,
                        studentCount: matrix.length,
                        lessonCount: lessonsSnap.size,
                        matrix,
                    }, null, 2),
                }],
            };
        }
    );
}
