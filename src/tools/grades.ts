/**
 * Group 3 — Grades tools
 *
 * Tools:
 *   get_lesson_grades        — per-student grades for a lesson
 *   get_failing_students     — students below a score threshold
 *   get_student_grades       — all lesson grades for one student
 *   get_grade_matrix         — full student × lesson grid
 *   get_difficulty_analysis  — rank groups by avg grade, with AI feedback samples
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getDb } from '../firestore.js';
import {
    resolveCourse,
    resolveLesson,
    resolveTopic,
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
        'Get grades for every student in a lesson. Optionally filter by class and/or date range. Results sorted highest to lowest.',
        {
            courseName: z.string().describe('Course name or partial name'),
            lessonName: z.string().describe('Lesson name or partial name'),
            className: z.string().optional().describe('Class name to filter — optional; omit for all students'),
            fromDate: z.string().optional().describe('Include only answers submitted on or after this date (ISO format, e.g. 2025-01-01)'),
            toDate: z.string().optional().describe('Include only answers submitted on or before this date (ISO format, e.g. 2025-06-30)'),
        },
        async ({ courseName, lessonName, className, fromDate, toDate }) => {
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

            // Aggregate grade per student (sum of section grades), with optional date filter
            const gradeByUser = new Map<string, number>();
            answersSnap.docs.forEach(d => {
                const data = d.data();
                if (data.grade == null) return;
                const ts: string = data.updatedAt ?? data.createdAt ?? '';
                if (fromDate && ts < fromDate) return;
                if (toDate   && ts > toDate + 'T23:59:59') return;
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
                        ...(fromDate || toDate ? { dateRange: { from: fromDate ?? 'any', to: toDate ?? 'any' } } : {}),
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
            fromDate: z.string().optional().describe('Include only answers submitted on or after this date (ISO format, e.g. 2025-01-01)'),
            toDate: z.string().optional().describe('Include only answers submitted on or before this date (ISO format, e.g. 2025-06-30)'),
        },
        async ({ courseName, lessonName, className, threshold = 60, fromDate, toDate }) => {
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
                const ts: string = data.updatedAt ?? data.createdAt ?? '';
                if (fromDate && ts < fromDate) return;
                if (toDate   && ts > toDate + 'T23:59:59') return;
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
                        ...(fromDate || toDate ? { dateRange: { from: fromDate ?? 'any', to: toDate ?? 'any' } } : {}),
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

    // ── get_difficulty_analysis ──────────────────────────────────────────────
    server.tool(
        'get_difficulty_analysis',
        "Rank groups by average grade (lowest first) and surface sample AI feedback texts to identify where students struggle most. groupBy: 'class' | 'lesson' | 'topic' | 'student'. Optional filters narrow the scope.",
        {
            courseName: z.string().describe('Course name or partial name'),
            groupBy: z.enum(['class', 'lesson', 'topic', 'student']).describe("Grouping dimension"),
            topicName: z.string().optional().describe('Limit to a specific topic (partial match)'),
            lessonName: z.string().optional().describe('Limit to a specific lesson (partial match)'),
            className: z.string().optional().describe('Limit to a specific class (partial match)'),
            studentName: z.string().optional().describe('Limit to a specific student (partial match)'),
            fromDate: z.string().optional().describe('Include only answers submitted on or after this date (ISO format, e.g. 2025-01-01)'),
            toDate: z.string().optional().describe('Include only answers submitted on or before this date (ISO format, e.g. 2025-06-30)'),
        },
        async ({ courseName, groupBy, topicName, lessonName, className, studentName, fromDate, toDate }) => {
            const db = getDb();
            const { courseId, courseName: resolvedCourse } = await resolveCourse(db, courseName);

            // ── 1. Load all lessons for this course ──────────────────────────
            const lessonsSnap = await db.collection('lessons').where('courseId', '==', courseId).get();
            const lessonMeta = new Map<string, { lessonName: string; topicId: string }>();
            lessonsSnap.docs.forEach(d => lessonMeta.set(d.id, { lessonName: d.data().lessonName, topicId: d.data().topicId }));

            // ── 2. Resolve lesson/topic scope filter ─────────────────────────
            let scopeLessonIds: Set<string> | null = null;
            if (lessonName) {
                const { lessonId } = await resolveLesson(db, courseId, lessonName);
                scopeLessonIds = new Set([lessonId]);
            } else if (topicName) {
                const { topicId } = await resolveTopic(db, courseId, topicName);
                scopeLessonIds = new Set(lessonsSnap.docs.filter(d => d.data().topicId === topicId).map(d => d.id));
            }
            const activeLessonIds = scopeLessonIds ?? new Set(lessonMeta.keys());

            // ── 3. Build sectionId → points map (batch by lessonId) ──────────
            const sectionPointsMap = new Map<string, number>();
            const lessonIdBatches = [...activeLessonIds];
            for (let i = 0; i < lessonIdBatches.length; i += 30) {
                const batch = lessonIdBatches.slice(i, i + 30);
                const secSnap = await db.collection('sections').where('lessonId', 'in', batch).get();
                secSnap.docs.forEach(d => {
                    const pts = d.data().points ?? 0;
                    if (pts > 0) sectionPointsMap.set(d.id, pts);
                });
            }

            // ── 4. Resolve student filter ────────────────────────────────────
            let filteredUserIds: Set<string> | null = null;
            if (studentName) {
                const usersSnap = await db.collection('users').get();
                const userDoc = usersSnap.docs.find(d =>
                    (d.data().fullName ?? '').toLowerCase().includes(studentName.toLowerCase().trim())
                );
                if (!userDoc) throw new Error(`Student not found: "${studentName}".`);
                filteredUserIds = new Set([userDoc.id]);
            } else if (className && groupBy !== 'class') {
                const cls = await resolveClass(db, courseId, className);
                const clsStudents = await getStudentsInClass(db, courseId, cls.classId);
                filteredUserIds = new Set(clsStudents.map(s => s.userId));
            }

            // ── 5. Fetch all graded answers for the course ───────────────────
            const answersSnap = await db.collection('studentAnswers').where('courseId', '==', courseId).get();

            interface AnswerRow {
                userId: string;
                lessonId: string;
                sectionId: string;
                grade: number;
                aiFeedback?: string;
            }

            const answers: AnswerRow[] = answersSnap.docs
                .map(d => ({
                    userId: d.data().userId as string,
                    lessonId: d.data().lessonId as string,
                    sectionId: d.data().sectionId as string,
                    grade: d.data().grade as number,
                    aiFeedback: d.data().aiFeedback as string | undefined,
                    updatedAt: (d.data().updatedAt ?? d.data().createdAt ?? '') as string,
                }))
                .filter(a => {
                    if (a.grade == null) return false;
                    if (!activeLessonIds.has(a.lessonId)) return false;
                    if (!sectionPointsMap.has(a.sectionId)) return false;
                    if (filteredUserIds != null && !filteredUserIds.has(a.userId)) return false;
                    if (fromDate && a.updatedAt < fromDate) return false;
                    if (toDate   && a.updatedAt > toDate + 'T23:59:59') return false;
                    return true;
                });

            // ── 6. Group by chosen dimension ─────────────────────────────────
            type GroupEntry = { name: string; grades: number[]; feedbacks: string[] };
            const groups = new Map<string, GroupEntry>();
            const getOrCreate = (key: string, name: string): GroupEntry => {
                if (!groups.has(key)) groups.set(key, { name, grades: [], feedbacks: [] });
                return groups.get(key)!;
            };
            const addToGroup = (key: string, name: string, grade: number, pts: number, fb?: string) => {
                const entry = getOrCreate(key, name);
                entry.grades.push(Math.round((grade / pts) * 100));
                if (fb) entry.feedbacks.push(fb);
            };

            if (groupBy === 'lesson') {
                for (const a of answers) {
                    const meta = lessonMeta.get(a.lessonId);
                    if (!meta) continue;
                    addToGroup(a.lessonId, meta.lessonName, a.grade, sectionPointsMap.get(a.sectionId)!, a.aiFeedback);
                }

            } else if (groupBy === 'topic') {
                const topicsSnap = await db.collection('topics').where('courseId', '==', courseId).get();
                const topicNameMap = new Map<string, string>();
                topicsSnap.docs.forEach(d => topicNameMap.set(d.id, d.data().topicName as string));

                for (const a of answers) {
                    const meta = lessonMeta.get(a.lessonId);
                    if (!meta) continue;
                    const tName = topicNameMap.get(meta.topicId) ?? meta.topicId;
                    addToGroup(meta.topicId, tName, a.grade, sectionPointsMap.get(a.sectionId)!, a.aiFeedback);
                }

            } else if (groupBy === 'class') {
                const classesSnap = await db.collection('courseClasses').where('courseId', '==', courseId).get();
                const classNameMap = new Map<string, string>();
                classesSnap.docs.forEach(d => classNameMap.set(d.id, d.data().name as string));

                const progressSnap = await db.collection('userProgress').where('courseId', '==', courseId).get();
                const userClassMap = new Map<string, string>();
                progressSnap.docs.forEach(d => {
                    const data = d.data();
                    if (data.classId) userClassMap.set(data.userId as string, data.classId as string);
                });

                let classFilter: string | null = null;
                if (className) {
                    const cls = await resolveClass(db, courseId, className);
                    classFilter = cls.classId;
                }

                for (const a of answers) {
                    const classId = userClassMap.get(a.userId);
                    if (!classId) continue;
                    if (classFilter && classId !== classFilter) continue;
                    const cName = classNameMap.get(classId) ?? classId;
                    addToGroup(classId, cName, a.grade, sectionPointsMap.get(a.sectionId)!, a.aiFeedback);
                }

            } else { // groupBy === 'student'
                const usersSnap = await db.collection('users').get();
                const userNameMap = new Map<string, string>();
                usersSnap.docs.forEach(d => userNameMap.set(d.id, (d.data().fullName ?? 'Unknown') as string));

                for (const a of answers) {
                    const uName = userNameMap.get(a.userId) ?? a.userId;
                    addToGroup(a.userId, uName, a.grade, sectionPointsMap.get(a.sectionId)!, a.aiFeedback);
                }
            }

            // ── 7. Rank groups by average grade ascending ────────────────────
            const rows = [...groups.values()]
                .map(g => {
                    const avg = g.grades.length > 0
                        ? Math.round(g.grades.reduce((s, n) => s + n, 0) / g.grades.length)
                        : null;
                    return {
                        name: g.name,
                        averageGrade: avg != null ? `${avg}%` : '—',
                        answerCount: g.grades.length,
                        sampleFeedback: g.feedbacks.slice(0, 3),
                    };
                })
                .sort((a, b) => {
                    const av = a.averageGrade === '—' ? -1 : parseInt(a.averageGrade);
                    const bv = b.averageGrade === '—' ? -1 : parseInt(b.averageGrade);
                    return av - bv;
                });

            return {
                content: [{
                    type: 'text',
                    text: JSON.stringify({
                        course: resolvedCourse,
                        groupBy,
                        filters: {
                            ...(topicName ? { topic: topicName } : {}),
                            ...(lessonName ? { lesson: lessonName } : {}),
                            ...(className ? { class: className } : {}),
                            ...(studentName ? { student: studentName } : {}),
                            ...(fromDate || toDate ? { dateRange: { from: fromDate ?? 'any', to: toDate ?? 'any' } } : {}),
                        },
                        groupCount: rows.length,
                        groups: rows,
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
